import type { Project } from './protocol';

export type BattlePhase = 'waiting' | 'preparing' | 'round' | 'finished';
export interface Standing {
  id: string; name: string; active: boolean; rank: number | null;
  wins: number; comparisons: number; lastScore: number;
}
export interface BattleView {
  phase: BattlePhase; round: number; deadline: number | null; serverTime: number;
  requiredPlayers: number; readyCount: number; alive: number;
  standings: Standing[]; eliminated: string | null; winner: string | null;
}
export interface DuelView {
  id: string; round: number; a: Project; b: Project;
  eligibleAt: number; expiresAt: number; clipMs: number; voted: 'A' | 'B' | null;
}
export interface Entrant extends Standing { tie: number; frozen: Project }
export interface BattleState {
  phase: Exclude<BattlePhase, 'waiting'>; round: number; deadline: number | null;
  entrants: Entrant[]; electorate: string[]; eliminated: string | null; winner: string | null;
}
export interface Ballot { a: string; b: string; vote: 'A' | 'B' | null }

// Both candidates use identical metadata. A ballot never includes producer IDs.
export function anonymousProject(project: Project): Project {
  return { ...structuredClone(project), revision: 0, startedAt: 0, playing: false };
}
export function settleRound(state: BattleState, votes: Ballot[]): BattleState {
  const next = structuredClone(state), alive = next.entrants.filter(p => p.active);
  if (state.phase !== 'round' || alive.length < 2) return next;
  const tally = new Map(alive.map(p => [p.id, { wins: 0, comparisons: 0 }]));
  for (const vote of votes) {
    if (!vote.vote || vote.a === vote.b || !tally.has(vote.a) || !tally.has(vote.b)) continue;
    tally.get(vote.a)!.comparisons++; tally.get(vote.b)!.comparisons++;
    tally.get(vote.vote === 'A' ? vote.a : vote.b)!.wins++;
  }
  // Laplace smoothing: no votes = neutral 50%, not an automatic loss.
  // Exact cross-products avoid floating-point tie ambiguity.
  alive.sort((a, b) => {
    const x = tally.get(a.id)!, y = tally.get(b.id)!;
    return (x.wins + 1) * (y.comparisons + 2) - (y.wins + 1) * (x.comparisons + 2)
      || (a.wins + 1) * (b.comparisons + 2) - (b.wins + 1) * (a.comparisons + 2)
      || a.tie - b.tie;
  });
  const loser = alive[0]; loser.active = false; loser.rank = alive.length;
  next.eliminated = loser.id;
  for (const entrant of alive) {
    const t = tally.get(entrant.id)!;
    entrant.lastScore = (t.wins + 1) / (t.comparisons + 2);
    entrant.wins += t.wins; entrant.comparisons += t.comparisons;
  }
  if (alive.length === 2) {
    const winner = alive[1]; winner.rank = 1;
    next.winner = winner.id; next.phase = 'finished'; next.deadline = null;
  }
  return next;
}

export function assignPairs(entrants: { id: string }[], voters: string[], random: () => number): { voter: string; a: string; b: string }[] {
  const exposure = new Map(entrants.map(p => [p.id, 0]));
  const pairs: { voter: string; a: string; b: string }[] = [];
  for (const voter of voters) {
    const eligible = entrants.filter(p => p.id !== voter).map(p => ({ id: p.id, tie: random() }));
    eligible.sort((a, b) => exposure.get(a.id)! - exposure.get(b.id)! || a.tie - b.tie);
    if (eligible.length < 2) continue;
    const a = eligible[0].id, b = eligible[1].id;
    exposure.set(a, exposure.get(a)! + 1); exposure.set(b, exposure.get(b)! + 1);
    pairs.push(random() < .5 ? { voter, a, b } : { voter, a: b, b: a });
  }
  return pairs;
}
