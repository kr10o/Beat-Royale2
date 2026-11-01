import type { Project } from './protocol';
export const JUDGE_MODEL = 'gemini-3.8-flash';
export interface RankedPlayer { id: string; name: string; rating: number; wins: number; losses: number; draws: number; games: number; verified: boolean }
export interface ScoreCard { groove: number; musicality: number; creativity: number; mix: number; feedback: string }
export interface Verdict { a: ScoreCard; b: ScoreCard; summary: string }
export interface RankedResult { model: string; winner: string | null; scores: Record<string, ScoreCard>; summary: string; changes: Record<string, number> }
export interface RankedMatchView {
  id: string; phase: 'composing' | 'awaiting_judge' | 'judging' | 'finished' | 'cancelled';
  players: { id: string; name: string; locked: boolean }[]; deadline: number;
  result: RankedResult | null; error: string | null;
}
export interface RankedView {
  me: RankedPlayer | null; queued: boolean; match: RankedMatchView | null; leaderboard: RankedPlayer[];
  googleAvailable: boolean; sponsoredJudgeAvailable: boolean; model: string; serverTime: number;
}
export function validProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const p = value as Project;
  return p.pack === 'foundry-v1' && Number.isInteger(p.bpm) && p.bpm >= 60 && p.bpm <= 180
    && Array.isArray(p.tracks) && p.tracks.length === 6 && p.tracks.every(t => t && Array.isArray(t.steps)
      && t.steps.length === 16 && t.steps.every(s => typeof s === 'boolean')
      && typeof t.muted === 'boolean' && typeof t.solo === 'boolean'
      && typeof t.volume === 'number' && Number.isFinite(t.volume) && t.volume >= 0 && t.volume <= 1
      && typeof t.pan === 'number' && Number.isFinite(t.pan) && t.pan >= -1 && t.pan <= 1);
}
export function validVerdict(value: unknown): value is Verdict {
  if (!value || typeof value !== 'object') return false;
  const v = value as Verdict;
  return typeof v.summary === 'string' && v.summary.length <= 1500 && [v.a, v.b].every(card => card &&
    typeof card.feedback === 'string' && card.feedback.length <= 1200 && ['groove', 'musicality', 'creativity', 'mix'].every(k => {
      const n = card[k as keyof ScoreCard]; return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10;
    }));
}
export function totalScore(card: ScoreCard): number { return Math.round((card.groove * .3 + card.musicality * .25 + card.creativity * .2 + card.mix * .25) * 100) / 100; }
export function eloDelta(a: number, b: number, outcome: number): number {
  return Math.round(32 * (outcome - 1 / (1 + 10 ** ((b - a) / 400))));
}
