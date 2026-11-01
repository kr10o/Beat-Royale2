import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
const room = `qa-${Date.now().toString(36)}`;
const origin = new URL(base).origin;
const sessions = [];
const clients = [];
async function join(role, name = role) {
  const response = await fetch(`${base}/api/rooms/${room}/join`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ role, name }) });
  if (!response.ok) return { status: response.status };
  const result = await response.json();
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'session cookie must survive the edge');
  const session = { ...result, cookie, status: response.status }; sessions.push(session); return session;
}
function connect(session) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/rooms/${room}/socket`, { headers: { Cookie: session.cookie, Origin: origin } });
  const inbox = [], waiters = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString()); const index = waiters.findIndex(w => w.predicate(msg));
    if (index >= 0) { const [w] = waiters.splice(index, 1); clearTimeout(w.timer); w.resolve(msg); }
    else inbox.push(msg);
  });
  ws.on('error', () => {});
  const client = { ws, send: value => ws.send(JSON.stringify(value)), next(predicate) {
    const index = inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { predicate, resolve, timer: setTimeout(() => reject(new Error('Timed out waiting for message')), 10000) };
      waiters.push(item);
    });
  } };
  clients.push(client); return client;
}
try {
  const badOrigin = await fetch(`${base}/api/rooms/${room}/join`, { method: 'POST', headers: { Origin: 'https://example.org' } });
  assert.equal(badOrigin.status, 403);
  const [a, b, viewer] = await Promise.all([join('producer', 'Producer A'), join('producer', 'Producer B'), join('spectator', 'Listener')]);
  const producer = connect(a), other = connect(b), spectator = connect(viewer);
  await Promise.all([producer.next(m => m.type === 'welcome'), other.next(m => m.type === 'welcome'), spectator.next(m => m.type === 'welcome')]);
  await producer.next(m => m.type === 'project'); await other.next(m => m.type === 'project');
  spectator.send({ type: 'follow', id: a.id });
  const snapshot = await spectator.next(m => m.type === 'project'); assert.equal(snapshot.project.revision, 0);
  producer.send({ type: 'edit', requestId: 'one', revision: 0, edit: { kind: 'step', track: 0, step: 0, value: true } });
  const accepted = await producer.next(m => m.ack === 'one');
  const mirrored = await spectator.next(m => m.type === 'project' && m.project.revision === 1);
  assert.deepEqual(accepted.project, mirrored.project);
  producer.send({ type: 'edit', requestId: 'one', revision: 0, edit: { kind: 'step', track: 0, step: 0, value: false } });
  assert.equal((await producer.next(m => m.ack === 'one')).project.revision, 1);
  producer.send({ type: 'edit', requestId: 'stale', revision: 0, edit: { kind: 'clear' } });
  assert.equal((await producer.next(m => m.type === 'error')).requestId, 'stale');
  spectator.send({ type: 'edit', requestId: 'forbidden', revision: 1, edit: { kind: 'clear' } });
  assert.match((await spectator.next(m => m.type === 'error')).message, /cannot edit/);
  other.send({ type: 'snapshot' });
  assert.equal((await other.next(m => m.type === 'project')).project.revision, 0);
  producer.ws.close();
  const resumed = connect(a); await resumed.next(m => m.type === 'welcome');
  assert.equal((await resumed.next(m => m.type === 'project')).project.tracks[0].steps[0], true);
  console.log('PASS: two producers, spectator sync, ownership, duplicate edits, stale revisions, reconnect, origin protection.');
  if (!process.env.SKIP_CAPACITY) {
    const entrants = await Promise.all(Array.from({ length: 49 }, (_, i) => join('producer', `Capacity ${i}`)));
    assert.equal(entrants.filter(s => s.status === 200).length, 48);
    assert.equal(entrants.filter(s => s.status === 409).length, 1);
    console.log('PASS: concurrent admission accepts exactly 50 producers; rejects the 51st.');
  }
} finally {
  for (const client of clients) client.ws.close();
  for (const session of sessions) await fetch(`${base}/api/rooms/${room}/leave`, { method: 'POST', headers: { Origin: origin, Cookie: session.cookie } });
}
