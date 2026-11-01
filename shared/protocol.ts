export const PACK = 'foundry-v1';
export const STEPS = 16;
export const TRACKS = ['Kick', 'Snare', 'Closed hat', 'Open hat', 'Clap', 'Sub'] as const;
export type Role = 'producer' | 'spectator';
export interface Track { steps: boolean[]; volume: number; pan: number; muted: boolean; solo: boolean }
export interface Project { revision: number; pack: string; bpm: number; playing: boolean; startedAt: number; tracks: Track[] }
export interface Member { id: string; name: string; role: Role; online: boolean; ready?: boolean }
export type Edit =
  | { kind: 'step'; track: number; step: number; value: boolean }
  | { kind: 'mix'; track: number; key: 'volume' | 'pan' | 'muted' | 'solo'; value: number | boolean }
  | { kind: 'bpm'; value: number }
  | { kind: 'transport'; value: boolean }
  | { kind: 'clear' };
export type ServerMessage =
  | { type: 'battle'; battle: BattleView }
  | { type: 'duel'; duel: DuelView | null; reason?: string }
  | { type: 'voteRecorded'; duelId: string; choice: 'A' | 'B' }
  | { type: 'welcome'; id: string; role: Role; members: Member[]; serverTime: number }
  | { type: 'roster'; members: Member[] }
  | { type: 'project'; id: string; project: Project; serverTime: number; ack?: string }
  | { type: 'following'; id: string | null }
  | { type: 'pong'; sentAt: number; serverTime: number }
  | { type: 'error'; message: string; requestId?: string };
export function newProject(): Project {
  return { revision: 0, pack: PACK, bpm: 120, playing: false, startedAt: 0,
    tracks: TRACKS.map(() => ({ steps: Array<boolean>(STEPS).fill(false), volume: .7, pan: 0, muted: false, solo: false })) };
}
function integer(value: unknown, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < max;
}
export function validEdit(value: unknown): value is Edit {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  switch (e.kind) {
    case 'step': return integer(e.track, TRACKS.length) && integer(e.step, STEPS) && typeof e.value === 'boolean';
    case 'mix': return integer(e.track, TRACKS.length) && (
      ((e.key === 'muted' || e.key === 'solo') && typeof e.value === 'boolean') ||
      (e.key === 'volume' && typeof e.value === 'number' && Number.isFinite(e.value) && e.value >= 0 && e.value <= 1) ||
      (e.key === 'pan' && typeof e.value === 'number' && Number.isFinite(e.value) && e.value >= -1 && e.value <= 1));
    case 'bpm': return Number.isInteger(e.value) && Number(e.value) >= 60 && Number(e.value) <= 180;
    case 'transport': return typeof e.value === 'boolean';
    case 'clear': return true;
    default: return false;
  }
}
export function applyEdit(project: Project, edit: Edit, now: number): Project {
  const p = structuredClone(project);
  if (edit.kind === 'step') p.tracks[edit.track].steps[edit.step] = edit.value;
  if (edit.kind === 'mix') {
    const t = p.tracks[edit.track];
    if (edit.key === 'volume' || edit.key === 'pan') t[edit.key] = edit.value as number;
    else t[edit.key] = edit.value as boolean;
  }
  if (edit.kind === 'bpm') { p.bpm = edit.value; if (p.playing) p.startedAt = now + 250; }
  if (edit.kind === 'transport') { p.playing = edit.value; p.startedAt = now + 250; }
  if (edit.kind === 'clear') for (const t of p.tracks) t.steps.fill(false);
  p.revision++;
  return p;
}
import type { BattleView, DuelView } from './battle';
