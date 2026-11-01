import { anonymousProject, assignPairs, settleRound, type BattleState, type BattleView, type DuelView } from '../shared/battle';
import type { Member, Project } from '../shared/protocol';

type DuelRow = { id: string; round: number; voter: string; a: string; b: string; vote: 'A' | 'B' | null; issued: number };
export interface BattleConfig { players: number; prepMs: number; roundMs: number; clipMs: number }
function random(): number { return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; }
export class Battle {
  constructor(private storage: DurableObjectStorage, readonly config: BattleConfig, private members: () => Member[], private project: (id: string) => Project | null) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS battle (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS duels (id TEXT PRIMARY KEY, round INTEGER NOT NULL, voter TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, vote TEXT, issued INTEGER NOT NULL DEFAULT 0, UNIQUE(round, voter))');
  }
  read(): BattleState | null {
    const row = this.storage.sql.exec<{ state: string }>('SELECT state FROM battle WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.state) as BattleState : null;
  }
  private write(state: BattleState): void { this.storage.sql.exec('INSERT OR REPLACE INTO battle (id, state) VALUES (1, ?)', JSON.stringify(state)); }
  view(now: number): BattleView {
    const state = this.read(), members = this.members();
    return { phase: state?.phase ?? 'waiting', round: state?.round ?? 0, deadline: state?.deadline ?? null, serverTime: now,
      requiredPlayers: this.config.players, readyCount: members.filter(p => p.role === 'producer' && p.ready && p.online).length,
      alive: state?.entrants.filter(p => p.active).length ?? members.filter(p => p.role === 'producer').length,
      standings: state?.entrants.map(({ tie: _tie, frozen: _frozen, ...standing }) => standing) ?? [],
      eliminated: state?.eliminated ?? null, winner: state?.winner ?? null };
  }
  maybeStart(now: number): boolean {
    if (this.read()) return false;
    const members = this.members(), producers = members.filter(m => m.role === 'producer');
    if (producers.length !== this.config.players || producers.some(p => !p.ready || !p.online)) return false;
    const shuffled = producers.map(p => ({ p, key: random() })).sort((a, b) => a.key - b.key);
    const entrants = shuffled.map(({ p }, tie) => ({ id: p.id, name: p.name, tie, frozen: anonymousProject(this.project(p.id)!), active: true, rank: null, wins: 0, comparisons: 0, lastScore: .5 }));
    this.write({ phase: 'preparing', round: 0, deadline: now + this.config.prepMs, entrants, electorate: members.map(m => m.id), eliminated: null, winner: null });
    return true;
  }
  preserveProject(id: string): void {
    const state = this.read(); if (!state) return;
    // The current round's frozen entry must never change on leave.
    if (state.phase === 'preparing') {
      const entrant = state.entrants.find(p => p.id === id), project = this.project(id);
      if (entrant && project) { entrant.frozen = anonymousProject(project); this.write(state); }
    }
  }
  advance(now: number): boolean {
    let changed = false;
    this.storage.transactionSync(() => {
      let state = this.read();
      while (state?.deadline !== null && state?.deadline !== undefined && state.deadline <= now && state.phase !== 'finished') {
        const boundary = state.deadline;
        if (state.phase === 'round') {
          const votes = this.storage.sql.exec<DuelRow>('SELECT * FROM duels WHERE round = ?', state.round).toArray();
          state = settleRound(state, votes);
        }
        if (state.phase !== 'finished') {
          state.phase = 'round'; state.round++; state.deadline = boundary + this.config.roundMs;
          for (const player of state.entrants.filter(p => p.active)) {
            const project = this.project(player.id); if (project) player.frozen = anonymousProject(project);
          }
          const voters = [...state.electorate].map(id => ({ id, key: random() })).sort((a, b) => a.key - b.key).map(p => p.id);
          const pairs = assignPairs(state.entrants.filter(p => p.active), voters, random);
          for (const pair of pairs) this.storage.sql.exec('INSERT INTO duels (id, round, voter, a, b) VALUES (?, ?, ?, ?, ?)', crypto.randomUUID(), state.round, pair.voter, pair.a, pair.b);
        }
        this.write(state); changed = true;
      }
    });
    return changed;
  }
  duel(voter: string, now: number): { duel: DuelView | null; reason?: string } {
    const state = this.read();
    if (state?.phase !== 'round') return { duel: null, reason: 'Duels open when the round begins.' };
    const row = this.storage.sql.exec<DuelRow>('SELECT * FROM duels WHERE round = ? AND voter = ?', state.round, voter).toArray()[0];
    if (!row) return { duel: null, reason: 'No eligible duel this round. Late arrivals can listen but cannot vote in this match.' };
    if (!row.issued) {
      if (now + this.config.clipMs * 2 >= state.deadline!) return { duel: null, reason: 'Not enough time to listen to both beats. The next round opens soon.' };
      row.issued = now;
      this.storage.sql.exec('UPDATE duels SET issued = ? WHERE id = ?', now, row.id);
    }
    const a = state.entrants.find(p => p.id === row.a)!, b = state.entrants.find(p => p.id === row.b)!;
    return { duel: { id: row.id, round: row.round, a: a.frozen, b: b.frozen, eligibleAt: row.issued + this.config.clipMs * 2, expiresAt: state.deadline!, clipMs: this.config.clipMs, voted: row.vote } };
  }
  vote(voter: string, id: unknown, choice: unknown, now: number): string | null {
    if (typeof id !== 'string' || (choice !== 'A' && choice !== 'B')) return 'Invalid vote.';
    const state = this.read();
    if (state?.phase !== 'round' || now >= state.deadline!) return 'This round is closed.';
    const row = this.storage.sql.exec<DuelRow>('SELECT * FROM duels WHERE id = ? AND voter = ? AND round = ?', id, voter, state.round).toArray()[0];
    if (!row || row.a === voter || row.b === voter) return 'This duel is not assigned to you.';
    if (!row.issued || now < row.issued + this.config.clipMs * 2) return 'Listen to both clips before voting.';
    if (row.vote && row.vote !== choice) return 'Your vote is already locked.';
    if (!row.vote) this.storage.sql.exec('UPDATE duels SET vote = ? WHERE id = ? AND vote IS NULL', choice, row.id);
    return null;
  }
  canEdit(id: string): boolean {
    const state = this.read(); if (!state) return true;
    return state.phase !== 'finished' && state.entrants.some(p => p.id === id && p.active);
  }
  get deadline(): number | null { return this.read()?.deadline ?? null; }
}
