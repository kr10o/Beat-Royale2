import { DurableObject } from 'cloudflare:workers';
import { applyEdit, newProject, validEdit, type Member, type Project, type Role, type ServerMessage } from '../shared/protocol';
import { Battle } from './battle';
export { RankedArena } from './ranked';

type SessionRow = { id: string; token: string; name: string; role: Role; project: string | null; last_request: string | null; ready: number };
interface Attachment { id: string; following: string | null; window: number; count: number }
const ROOM = /^[a-z0-9-]{1,32}$/;
async function digest(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function cookie(request: Request, room: string): string {
  return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`br_${room}=`))?.slice(`br_${room}=`.length) ?? '';
}
async function smallJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 1024) { await reader.cancel(); throw new Error('Body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export class BeatRoyaleLobby extends DurableObject<Env> {
  private battle: Battle;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      role TEXT NOT NULL, project TEXT, last_request TEXT)`);
    const columns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(sessions)').toArray();
    if (!columns.some(column => column.name === 'expires')) {
      this.ctx.storage.sql.exec('ALTER TABLE sessions ADD COLUMN expires INTEGER NOT NULL DEFAULT 0');
      this.ctx.storage.sql.exec('UPDATE sessions SET expires = ?', Date.now() + 86400000);
    }
    if (!columns.some(column => column.name === 'ready')) this.ctx.storage.sql.exec('ALTER TABLE sessions ADD COLUMN ready INTEGER NOT NULL DEFAULT 0');
    this.battle = new Battle(this.ctx.storage, {
      players: Number(env.BATTLE_PLAYERS) || 50, prepMs: Number(env.BATTLE_PREP_MS) || 60000,
      roundMs: Number(env.BATTLE_ROUND_MS) || 60000, clipMs: Number(env.BATTLE_CLIP_MS) || 4000,
    }, () => this.roster(), id => { const row = this.session(id); return row?.project ? JSON.parse(row.project) as Project : null; });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private sessions(): SessionRow[] { return this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM sessions').toArray(); }
  private session(id: string): SessionRow | undefined {
    return this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM sessions WHERE id = ?', id).toArray()[0];
  }
  private roster(): Member[] {
    const online = new Set(this.ctx.getWebSockets().filter(ws => ws.readyState === 1).map(ws => (ws.deserializeAttachment() as Attachment).id));
    return this.sessions().map(s => ({ id: s.id, name: s.name, role: s.role, online: online.has(s.id), ready: !!s.ready }));
  }
  private send(ws: WebSocket, message: ServerMessage): void {
    try { ws.send(JSON.stringify(message)); } catch { /* A disconnect may race a broadcast. */ }
  }
  private broadcastRoster(): void {
    const message: ServerMessage = { type: 'roster', members: this.roster() };
    for (const ws of this.ctx.getWebSockets()) this.send(ws, message);
  }
  private sendBattle(ws: WebSocket): void {
    this.send(ws, { type: 'battle', battle: this.battle.view(Date.now()) });
    const { id } = ws.deserializeAttachment() as Attachment;
    this.send(ws, { type: 'duel', ...this.battle.duel(id, Date.now()) });
  }
  private broadcastBattle(): void { for (const ws of this.ctx.getWebSockets()) this.sendBattle(ws); }
  private async scheduleAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(this.battle.deadline ?? Date.now() + 3600000);
  }
  private async tick(): Promise<void> {
    if (this.battle.advance(Date.now())) { this.broadcastBattle(); await this.scheduleAlarm(); }
  }
  private sendProject(ws: WebSocket, id: string, ack?: string): void {
    const row = this.session(id);
    if (row?.project) this.send(ws, { type: 'project', id, project: JSON.parse(row.project) as Project, serverTime: Date.now(), ack });
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, , , room, action] = url.pathname.split('/');
    const token = cookie(request, room);
    const tokenHash = token ? await digest(token) : '';
    await this.tick();
    const existing = tokenHash ? this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM sessions WHERE token = ?', tokenHash).toArray()[0] : undefined;
    if (action === 'join' && request.method === 'POST') {
      if (existing) {
        this.ctx.storage.sql.exec('UPDATE sessions SET expires = ? WHERE id = ?', Date.now() + 86400000, existing.id);
        return Response.json({ id: existing.id, role: existing.role });
      }
      let body: unknown;
      try { body = await smallJson(request); } catch { return Response.json({ error: 'Invalid join request.' }, { status: 400 }); }
      if (!body || typeof body !== 'object') return new Response('Invalid body', { status: 400 });
      const { name, role } = body as Record<string, unknown>;
      if (typeof name !== 'string' || !/^[\p{L}\p{N} _-]{1,24}$/u.test(name.trim()) || (role !== 'producer' && role !== 'spectator')) {
        return Response.json({ error: 'Use a name of 1–24 letters, numbers, spaces, _ or -.' }, { status: 400 });
      }
      // No await between counting and insertion: capacity decisions are atomic in this object.
      const freshToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const hash = await digest(freshToken);
      const actualRole = this.battle.read() ? 'spectator' : role;
      const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE role = ?', actualRole).one().n;
      if (count >= (actualRole === 'producer' ? this.battle.config.players : 200)) return Response.json({ error: 'This room is full for that role.' }, { status: 409 });
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec('INSERT INTO sessions (id, token, name, role, project) VALUES (?, ?, ?, ?, ?)', id, hash, name.trim(), actualRole, actualRole === 'producer' ? JSON.stringify(newProject()) : null);
      this.ctx.storage.sql.exec('UPDATE sessions SET expires = ? WHERE id = ?', Date.now() + 86400000, id);
      await this.scheduleAlarm();
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      return Response.json({ id, role: actualRole }, { headers: { 'Set-Cookie': `br_${room}=${freshToken}; HttpOnly; SameSite=Strict; Path=/api/rooms/${room}/; Max-Age=86400${secure}`, 'Cache-Control': 'no-store' } });
    }
    if (!existing) return Response.json({ error: 'Join the room first.' }, { status: 401 });
    if (action === 'leave' && request.method === 'POST') {
      this.battle.preserveProject(existing.id);
      this.ctx.storage.sql.exec('DELETE FROM sessions WHERE id = ?', existing.id);
      for (const ws of this.ctx.getWebSockets()) {
        const state = ws.deserializeAttachment() as Attachment;
        if (state.id === existing.id) ws.close(1000, 'Left room');
        else if (state.following === existing.id) { state.following = null; ws.serializeAttachment(state); this.send(ws, { type: 'following', id: null }); }
      }
      this.broadcastRoster();
      this.broadcastBattle();
      return new Response(null, { status: 204, headers: { 'Set-Cookie': `br_${room}=; HttpOnly; SameSite=Strict; Path=/api/rooms/${room}/; Max-Age=0` } });
    }
    if (action !== 'socket' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });
    const active = this.ctx.getWebSockets().filter(ws => ws.readyState === 1 && (ws.deserializeAttachment() as Attachment).id === existing.id);
    if (active.length >= 3) return new Response('Too many connections', { status: 429 });
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: existing.id, following: existing.role === 'producer' ? existing.id : null, window: Date.now(), count: 0 } satisfies Attachment);
    this.send(server, { type: 'welcome', id: existing.id, role: existing.role, members: this.roster(), serverTime: Date.now() });
    if (existing.project) this.sendProject(server, existing.id);
    if (this.battle.maybeStart(Date.now())) await this.scheduleAlarm();
    this.broadcastRoster();
    this.broadcastBattle();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.tick();
    if (typeof raw !== 'string' || raw.length > 2048) { ws.close(1009, 'Message too large'); return; }
    const state = ws.deserializeAttachment() as Attachment;
    if (Date.now() - state.window > 1000) { state.window = Date.now(); state.count = 0; }
    state.count++; ws.serializeAttachment(state);
    if (state.count > 40) { this.send(ws, { type: 'error', message: 'Slow down; too many messages.' }); return; }
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); if (!msg || typeof msg !== 'object') throw new Error(); }
    catch { this.send(ws, { type: 'error', message: 'Invalid message.' }); return; }
    if (msg.type === 'ping' && typeof msg.sentAt === 'number' && Number.isFinite(msg.sentAt)) {
      this.send(ws, { type: 'pong', sentAt: msg.sentAt, serverTime: Date.now() }); return;
    }
    const session = this.session(state.id);
    if (!session) { ws.close(1008, 'Session expired'); return; }
    if (msg.type === 'ready' && typeof msg.value === 'boolean') {
      if (session.role !== 'producer' || this.battle.read()) { this.send(ws, { type: 'error', message: 'Readiness is locked for this match.' }); return; }
      this.ctx.storage.sql.exec('UPDATE sessions SET ready = ? WHERE id = ?', msg.value ? 1 : 0, session.id);
      if (this.battle.maybeStart(Date.now())) await this.scheduleAlarm();
      this.broadcastRoster(); this.broadcastBattle(); return;
    }
    if (msg.type === 'duel') { this.sendBattle(ws); return; }
    if (msg.type === 'vote') {
      const error = this.battle.vote(session.id, msg.duelId, msg.choice, Date.now());
      if (error) this.send(ws, { type: 'error', message: error });
      else this.send(ws, { type: 'voteRecorded', duelId: msg.duelId as string, choice: msg.choice as 'A' | 'B' });
      return;
    }
    if (msg.type === 'follow' && typeof msg.id === 'string') {
      if (!this.session(msg.id)?.project) { this.send(ws, { type: 'error', message: 'Producer unavailable.' }); return; }
      state.following = msg.id; ws.serializeAttachment(state);
      this.send(ws, { type: 'following', id: msg.id }); this.sendProject(ws, msg.id); return;
    }
    if (msg.type === 'snapshot') { if (state.following) this.sendProject(ws, state.following); return; }
    if (msg.type !== 'edit' || typeof msg.requestId !== 'string' || msg.requestId.length > 64 || !validEdit(msg.edit)) {
      this.send(ws, { type: 'error', message: 'Invalid edit.' }); return;
    }
    if (session.role !== 'producer' || !session.project) { this.send(ws, { type: 'error', message: 'Spectators cannot edit.', requestId: msg.requestId }); return; }
    if (!this.battle.canEdit(session.id)) { this.send(ws, { type: 'error', message: 'Your battle beat is locked. Join a new room to produce again.', requestId: msg.requestId }); return; }
    if (session.last_request === msg.requestId) { this.sendProject(ws, session.id, msg.requestId); return; }
    const current = JSON.parse(session.project) as Project;
    if (msg.revision !== current.revision) {
      this.send(ws, { type: 'error', message: 'Project changed in another tab. State refreshed.', requestId: msg.requestId });
      this.sendProject(ws, session.id); return;
    }
    const next = applyEdit(current, msg.edit, Date.now());
    this.ctx.storage.sql.exec('UPDATE sessions SET project = ?, last_request = ? WHERE id = ?', JSON.stringify(next), msg.requestId, session.id);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.following === session.id || socket === ws) this.sendProject(socket, session.id, socket === ws ? msg.requestId : undefined);
    }
  }
  webSocketClose(): void { this.broadcastRoster(); this.broadcastBattle(); }
  webSocketError(): void { this.broadcastRoster(); this.broadcastBattle(); }
  async alarm(): Promise<void> {
    this.battle.advance(Date.now()); this.broadcastBattle();
    const online = new Set(this.ctx.getWebSockets().filter(ws => ws.readyState === 1).map(ws => (ws.deserializeAttachment() as Attachment).id));
    for (const id of online) this.ctx.storage.sql.exec('UPDATE sessions SET expires = ? WHERE id = ?', Date.now() + 86400000, id);
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE expires < ?', Date.now());
    this.broadcastRoster();
    if (this.sessions().length || this.battle.deadline) await this.scheduleAlarm();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/ranked/')) {
      if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return new Response('Origin not allowed', { status: 403 });
      return env.RANKED.getByName('season-1').fetch(request);
    }
    if (url.pathname.startsWith('/api/')) {
      const match = /^\/api\/rooms\/([^/]+)\/(join|leave|socket)$/.exec(url.pathname);
      if (!match || !ROOM.test(match[1])) return new Response('Not found', { status: 404 });
      if (request.headers.get('Origin') !== url.origin) return new Response('Origin not allowed', { status: 403 });
      return env.LOBBIES.getByName(match[1]).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
