import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, newProject, validEdit } from '../shared/protocol.ts';
test('rejects invalid and out-of-range edits', () => {
  for (const value of [null, {}, { kind: 'step', track: 6, step: 0, value: true }, { kind: 'step', track: 0, step: 16, value: true }, { kind: 'mix', track: 0, key: 'volume', value: Infinity }, { kind: 'bpm', value: 59 }, { kind: 'transport', value: 'true' }]) assert.equal(validEdit(value), false);
});
test('editing one project does not mutate another or the original', () => {
  const first = newProject(), second = newProject();
  const changed = applyEdit(first, { kind: 'step', track: 0, step: 0, value: true }, 1000);
  assert.equal(changed.tracks[0].steps[0], true); assert.equal(first.tracks[0].steps[0], false);
  assert.deepEqual(first, second); assert.equal(changed.revision, 1);
});
test('transport starts in the future and tempo changes reset the shared epoch', () => {
  const playing = applyEdit(newProject(), { kind: 'transport', value: true }, 1000);
  assert.equal(playing.startedAt, 1250);
  const faster = applyEdit(playing, { kind: 'bpm', value: 140 }, 2000);
  assert.equal(faster.startedAt, 2250); assert.equal(faster.bpm, 140);
  assert.equal(applyEdit(faster, { kind: 'transport', value: false }, 3000).playing, false);
});
