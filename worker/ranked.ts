import { DurableObject } from 'cloudflare:workers';
import { JUDGE_MODEL, eloDelta, totalScore, validProject, type RankedPlayer, type RankedMatchView, type RankedResult, type RankedView } from '../shared/ranked';
import type { Project } from '../shared/protocol';
import { judge } from './judge';

type Profile = { id: string; name: string; rating: number; wins: number; losses: number; draws: number; games: number; google: string | null };
type Session = { hash: string; profile: string; expires: number };
type Match = Omit<RankedMatchView, 'players'> & { players: { id: string; name: string; project: Project | null }[]; order: number; attempt: string | null; judgingAt: number; tries: number };
type MatchRow = { id: string; state: string; p1: string; p2: string; created: number };
async function hash(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join(''); }
function secret(): string { return crypto.randomUUID() + crypto.randomUUID(); }
function safeName(value: unknown): value is string { return typeof value === 'string' && /^[\p{L}\p{N} _-]{1,24}$/u.test(value.trim()); }
async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader(); if (!reader) return {};
  let length = 0; const parts: Uint8Array[] = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 16000) { await reader.cancel(); throw new Error('Request too large.'); } parts.push(value); }
  const bytes = new Uint8Array(length); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('Invalid JSON request.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string, unknown>;
}
function publicProfile(p: Profile): RankedPlayer { const { google, ...rest } = p; return { ...rest, verified: !!google }; }
function publicMatch(m: Match): RankedMatchView { return { id: m.id, phase: m.phase, players: m.players.map(p => ({ id: p.id, name: p.name, locked: !!p.project })), deadline: m.deadline, result: m.result, error: m.error }; }

export class RankedArena extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, rating INTEGER NOT NULL DEFAULT 1000, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, google TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS ranked_sessions (hash TEXT PRIMARY KEY, profile TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (profile TEXT PRIMARY KEY, since INTEGER NOT NULL, expires INTEGER NOT NULL, sponsor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, state TEXT NOT NULL, p1 TEXT NOT NULL, p2 TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS active (profile TEXT PRIMARY KEY, match_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth (state TEXT PRIMARY KEY, session TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (profile TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(profile, day));
      CREATE TABLE IF NOT EXISTS throttle (profile TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);`);
  }
  private profile(id: string): Profile | undefined { return this.ctx.storage.sql.exec<Profile>('SELECT * FROM profiles WHERE id = ?', id).toArray()[0]; }
  private match(id: string): Match | null { const r = this.ctx.storage.sql.exec<MatchRow>('SELECT * FROM matches WHERE id = ?', id).toArray()[0]; return r ? JSON.parse(r.state) as Match : null; }
  private current(id: string): Match | null { const row = this.ctx.storage.sql.exec<{ match_id: string }>('SELECT match_id FROM active WHERE profile = ?', id).toArray()[0]; return row ? this.match(row.match_id) : null; }
  private save(m: Match): void { this.ctx.storage.sql.exec('UPDATE matches SET state = ? WHERE id = ?', JSON.stringify(m), m.id); }
  private view(profile?: Profile): RankedView {
    const current = profile ? this.current(profile.id) : null;
    return { me: profile ? publicProfile(profile) : null, queued: !!profile && !!this.ctx.storage.sql.exec('SELECT profile FROM queue WHERE profile = ?', profile.id).toArray().length,
      match: current ? publicMatch(current) : null,
      leaderboard: this.ctx.storage.sql.exec<Profile>('SELECT * FROM profiles WHERE games > 0 ORDER BY rating DESC, wins DESC, id LIMIT 50').toArray().map(publicProfile),
      googleAvailable: !!this.env.GOOGLE_CLIENT_ID && !!this.env.GOOGLE_CLIENT_SECRET,
      sponsoredJudgeAvailable: !!this.env.GEMINI_API_KEY, model: JUDGE_MODEL, serverTime: Date.now() };
  }
  private sweep(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM queue WHERE expires < ?', now);
    this.ctx.storage.sql.exec('DELETE FROM ranked_sessions WHERE expires < ?', now);
    this.ctx.storage.sql.exec('DELETE FROM oauth WHERE expires < ?', now);
    // Only current matches can change; finished results are immutable.
    const rows = this.ctx.storage.sql.exec<MatchRow>('SELECT DISTINCT m.* FROM matches m JOIN active a ON a.match_id = m.id').toArray();
    for (const row of rows) {
      const m = JSON.parse(row.state) as Match;
      if (m.phase === 'judging' && now - m.judgingAt > 120000) { m.phase = 'awaiting_judge'; m.attempt = null; m.error = 'Judging was interrupted. Reconnect and retry with your key.'; this.save(m); }
      else if ((m.phase === 'composing' || m.phase === 'awaiting_judge') && now > m.deadline) { m.phase = 'cancelled'; m.error = 'Match expired without two locked beats and a completed judgment. Ratings unchanged.'; this.save(m); }
    }
  }
  private limited(profile: string): boolean {
    const now = Date.now(), row = this.ctx.storage.sql.exec<{ window: number; count: number }>('SELECT window, count FROM throttle WHERE profile = ?', profile).toArray()[0];
    const window = row && now - row.window < 10000 ? row.window : now, count = window === row?.window ? row.count + 1 : 1;
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO throttle VALUES (?, ?, ?)', profile, window, count);
    return count > 30;
  }
  private pair(): void {
    const queue = this.ctx.storage.sql.exec<{ profile: string; sponsor: number }>('SELECT profile, sponsor FROM queue ORDER BY since LIMIT 200').toArray();
    for (let i = 0; i < queue.length; i++) for (let j = i + 1; j < queue.length; j++) {
      if (!queue[i].sponsor && !queue[j].sponsor) continue;
      const a = this.profile(queue[i].profile)!, b = this.profile(queue[j].profile)!;
      const recent = this.ctx.storage.sql.exec('SELECT id FROM matches WHERE created > ? AND ((p1 = ? AND p2 = ?) OR (p1 = ? AND p2 = ?)) LIMIT 1', Date.now() - 86400000, a.id, b.id, b.id, a.id).toArray();
      if (recent.length) continue;
      const m: Match = { id: crypto.randomUUID(), phase: 'composing', deadline: Date.now() + 300000, players: [a, b].map(p => ({ id: p.id, name: p.name, project: null })), order: crypto.getRandomValues(new Uint8Array(1))[0] % 2, result: null, error: null, attempt: null, judgingAt: 0, tries: 0 };
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('INSERT INTO matches VALUES (?, ?, ?, ?, ?)', m.id, JSON.stringify(m), a.id, b.id, Date.now());
        for (const p of [a, b]) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO active VALUES (?, ?)', p.id, m.id); this.ctx.storage.sql.exec('DELETE FROM queue WHERE profile = ?', p.id); }
      });
      return; // Next request pairs the next waiting players without a long event.
    }
  }
  private async projectResults(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ id: string; payload: string }>('SELECT * FROM outbox LIMIT 10').toArray();
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { players: RankedPlayer[]; result: RankedResult; time: number };
      try {
        await this.env.RANKED_DB.batch([
          this.env.RANKED_DB.prepare('INSERT OR IGNORE INTO ranked_results VALUES (?, ?, ?)').bind(row.id, payload.time, JSON.stringify(payload.result)),
          ...payload.players.map(p => this.env.RANKED_DB.prepare('INSERT INTO ranked_profiles (id,name,rating,wins,losses,draws,games,verified) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,rating=excluded.rating,wins=excluded.wins,losses=excluded.losses,draws=excluded.draws,games=excluded.games,verified=excluded.verified WHERE excluded.games >= ranked_profiles.games').bind(p.id, p.name, p.rating, p.wins, p.losses, p.draws, p.games, p.verified ? 1 : 0)),
        ]);
        this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id = ?', row.id);
      } catch { /* Retry the durable outbox on the next alarm; keep the authoritative result. */ break; }
    }
  }
  private async evaluate(m: Match, key: string): Promise<void> {
    if (m.phase !== 'awaiting_judge' || m.tries >= 3) throw new Error('This match is not available for judging.');
    const attempt = crypto.randomUUID();
    m.phase = 'judging'; m.attempt = attempt; m.judgingAt = Date.now(); m.tries++; m.error = null; this.save(m);
    await this.ctx.storage.setAlarm(Date.now() + 30000);
    try {
      const ordered = m.order ? [m.players[1], m.players[0]] : m.players;
      const verdict = await judge(ordered[0].project!, ordered[1].project!, key);
      const fresh = this.match(m.id);
      if (fresh?.phase !== 'judging' || fresh.attempt !== attempt) return;
      const aScore = totalScore(verdict.a), bScore = totalScore(verdict.b);
      const winner = aScore === bScore ? null : ordered[aScore > bScore ? 0 : 1].id;
      this.ctx.storage.transactionSync(() => {
        const a = this.profile(m.players[0].id)!, b = this.profile(m.players[1].id)!;
        const outcome = winner === null ? .5 : winner === a.id ? 1 : 0;
        const delta = eloDelta(a.rating, b.rating, outcome);
        fresh.result = { model: JUDGE_MODEL, winner, scores: { [ordered[0].id]: verdict.a, [ordered[1].id]: verdict.b }, summary: verdict.summary, changes: { [a.id]: delta, [b.id]: -delta } };
        fresh.phase = 'finished'; fresh.attempt = null; fresh.error = null;
        for (const [p, change] of [[a, delta], [b, -delta]] as const) this.ctx.storage.sql.exec('UPDATE profiles SET rating = rating + ?, wins = wins + ?, losses = losses + ?, draws = draws + ?, games = games + 1 WHERE id = ?', change, winner === p.id ? 1 : 0, winner !== null && winner !== p.id ? 1 : 0, winner === null ? 1 : 0, p.id);
        this.save(fresh);
        const payload = { players: [a, b].map(p => publicProfile(this.profile(p.id)!)), result: fresh.result, time: Date.now() };
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO outbox VALUES (?, ?)', fresh.id, JSON.stringify(payload));
      });
      await this.projectResults();
    } catch (error) {
      const fresh = this.match(m.id);
      if (fresh?.phase === 'judging' && fresh.attempt === attempt) {
        fresh.phase = 'awaiting_judge'; fresh.attempt = null;
        fresh.error = error instanceof Error && /^(Google|The judge)/.test(error.message) ? error.message : 'Judging could not finish. No ratings changed. Retry with an authorized key.';
        this.save(fresh);
      }
    }
  }
  private async oauthStart(request: Request, session: Session, profile: Profile): Promise<Response> {
    if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET) throw new Error('Google sign-in is not configured yet. You can use your Gemini API key.');
    const m = this.current(profile.id);
    if (m && m.phase !== 'finished' && m.phase !== 'cancelled') throw new Error('Finish your current match before linking Google.');
    this.ctx.storage.sql.exec('DELETE FROM queue WHERE profile = ?', profile.id);
    const state = secret(), verifier = secret();
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    this.ctx.storage.sql.exec('INSERT INTO oauth VALUES (?, ?, ?, ?)', await hash(state), session.hash, verifier, Date.now() + 600000);
    const redirect = new URL('/api/ranked/auth/callback', request.url).href;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'openid', state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account' }).toString();
    return Response.redirect(url.href, 302);
  }
  private async oauthCallback(request: Request, session: Session): Promise<Response> {
    const url = new URL(request.url), state = url.searchParams.get('state'), code = url.searchParams.get('code');
    if (!state || !code) throw new Error('Google sign-in was cancelled.');
    const digest = await hash(state);
    const record = this.ctx.storage.sql.exec<{ verifier: string; expires: number }>('SELECT verifier, expires FROM oauth WHERE state = ? AND session = ?', digest, session.hash).toArray()[0];
    if (!record || record.expires < Date.now()) throw new Error('Sign-in expired. Please restart.');
    this.ctx.storage.sql.exec('DELETE FROM oauth WHERE state = ?', digest);
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.env.GOOGLE_CLIENT_ID, client_secret: this.env.GOOGLE_CLIENT_SECRET, code, code_verifier: record.verifier, redirect_uri: new URL('/api/ranked/auth/callback', url).href, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Google sign-in could not be verified.'); }
    const token = await response.json() as { access_token?: string };
    if (!token.access_token) throw new Error('Google sign-in could not be verified.');
    const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15000) });
    if (!info.ok) throw new Error('Google identity could not be verified.');
    const identity = await info.json() as { sub?: string };
    if (!identity.sub) throw new Error('Google identity could not be verified.');
    const subject = await hash(identity.sub);
    const existing = this.ctx.storage.sql.exec<Profile>('SELECT * FROM profiles WHERE google = ?', subject).toArray()[0];
    if (existing) this.ctx.storage.sql.exec('UPDATE ranked_sessions SET profile = ? WHERE hash = ?', existing.id, session.hash);
    else this.ctx.storage.sql.exec('UPDATE profiles SET google = ? WHERE id = ?', subject, session.profile);
    return Response.redirect(new URL('/?ranked=1', url).href, 302);
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url), action = url.pathname.slice('/api/ranked/'.length);
    this.sweep();
    const cookie = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('br_ranked='))?.slice(10);
    const token = cookie ? await hash(cookie) : '';
    const session = this.ctx.storage.sql.exec<Session>('SELECT * FROM ranked_sessions WHERE hash = ? AND expires > ?', token, Date.now()).toArray()[0];
    let profile = session ? this.profile(session.profile) : undefined;
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
    try {
      if (request.method === 'GET' && (action === 'leaderboard' || action === 'state')) {
        if (profile) this.ctx.storage.sql.exec('UPDATE queue SET expires = ? WHERE profile = ?', Date.now() + 60000, profile.id);
        return json(this.view(action === 'state' ? profile : undefined));
      }
      if (request.method === 'GET' && action === 'auth/start' && session && profile) return await this.oauthStart(request, session, profile);
      if (request.method === 'GET' && action === 'auth/callback' && session) return await this.oauthCallback(request, session);
      if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
      const input = await body(request);
      if (action === 'profile') {
        if (!safeName(input.name)) return json({ error: 'Use 1–24 letters, numbers, spaces, _ or -.' }, 400);
        if (profile) return json(this.view(profile));
        const id = crypto.randomUUID(), token = secret(), digest = await hash(token);
        this.ctx.storage.sql.exec('INSERT INTO profiles (id,name) VALUES (?,?)', id, input.name.trim());
        this.ctx.storage.sql.exec('INSERT INTO ranked_sessions VALUES (?,?,?)', digest, id, Date.now() + 2592000000);
        const secure = url.protocol === 'https:' ? '; Secure' : '';
        return json(this.view(this.profile(id)), 200, { 'Set-Cookie': `br_ranked=${token}; HttpOnly; SameSite=Lax; Path=/api/ranked/; Max-Age=2592000${secure}` });
      }
      if (!profile) return json({ error: 'Create a ranked profile first.' }, 401);
      if (this.limited(profile.id)) return json({ error: 'Too many requests. Please wait a moment.' }, 429);
      if (action === 'queue') {
        const m = this.current(profile.id);
        if (m && m.phase !== 'finished' && m.phase !== 'cancelled') return json(this.view(profile));
        this.ctx.storage.sql.exec('INSERT INTO queue VALUES (?,?,?,?) ON CONFLICT(profile) DO UPDATE SET expires=excluded.expires,sponsor=excluded.sponsor', profile.id, Date.now(), Date.now() + 60000, input.sponsor === true || (!!profile.google && !!this.env.GEMINI_API_KEY) ? 1 : 0);
        this.pair(); await this.ctx.storage.setAlarm(Date.now() + 30000);
      } else if (action === 'cancel-queue') this.ctx.storage.sql.exec('DELETE FROM queue WHERE profile = ?', profile.id);
      else if (action === 'submit') {
        const m = this.current(profile.id);
        if (!m || m.id !== input.matchId || m.phase !== 'composing' || Date.now() >= m.deadline) throw new Error('This match is not accepting beats.');
        const player = m.players.find(p => p.id === profile!.id)!;
        if (player.project) throw new Error('Your beat is already locked.');
        if (!validProject(input.project)) throw new Error('Invalid beat. Use the shared Foundry sample pack.');
        player.project = { pack: 'foundry-v1', revision: 0, bpm: input.project.bpm, playing: false, startedAt: 0, tracks: input.project.tracks.map(t => ({ steps: [...t.steps], volume: t.volume, pan: t.pan, muted: t.muted, solo: t.solo })) };
        if (m.players.every(p => p.project)) { m.phase = 'awaiting_judge'; m.deadline = Date.now() + 600000; }
        this.save(m);
      } else if (action === 'judge') {
        const m = this.current(profile.id);
        if (!m || m.id !== input.matchId || !m.players.some(p => p.id === profile!.id) || !m.players.every(p => p.project)) throw new Error('Both players must lock their beat first.');
        if (input.provider !== 'google') throw new Error('Ranked uses Google Gemini 3.8 Flash for all players.');
        if (m.phase !== 'awaiting_judge' || m.tries >= 3) throw new Error('This match is not available for judging.');
        let key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
        if (!key) {
          if (!profile.google || !this.env.GEMINI_API_KEY) throw new Error('A participant must provide a Gemini API key. Google-sponsored judging is not configured.');
          const day = new Date().toISOString().slice(0, 10);
          const calls = this.ctx.storage.sql.exec<{ calls: number }>('SELECT calls FROM usage WHERE profile=? AND day=?', profile.id, day).toArray()[0]?.calls ?? 0;
          if (calls >= 3) throw new Error('Daily sponsored judging limit reached. You can use your own key.');
          this.ctx.storage.sql.exec('INSERT INTO usage VALUES (?,?,1) ON CONFLICT(profile,day) DO UPDATE SET calls=calls+1', profile.id, day);
          key = this.env.GEMINI_API_KEY;
        }
        if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) throw new Error('Enter a valid Google Gemini API key.');
        await this.evaluate(m, key); key = '';
      } else return json({ error: 'Not found.' }, 404);
      profile = this.profile(profile.id);
      return json(this.view(profile));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'The ranked request could not be completed.' }, 400);
    }
  }
  async alarm(): Promise<void> {
    this.sweep(); this.pair(); await this.projectResults();
    const pending = this.ctx.storage.sql.exec('SELECT id FROM outbox LIMIT 1').toArray().length;
    const queue = this.ctx.storage.sql.exec('SELECT profile FROM queue LIMIT 1').toArray().length;
    const ongoing = this.ctx.storage.sql.exec<{ state: string }>('SELECT DISTINCT m.state FROM matches m JOIN active a ON a.match_id=m.id').toArray().some(row => !['finished', 'cancelled'].includes((JSON.parse(row.state) as Match).phase));
    if (pending || queue || ongoing) await this.ctx.storage.setAlarm(Date.now() + 30000);
  }
}
