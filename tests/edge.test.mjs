import { test } from 'node:test';
import assert from 'node:assert/strict';
import edge from '../deploy/consent-worker.js';

test('privacy edge forwards only the essential cookie for the requested room', async () => {
  const original = globalThis.fetch; let received;
  globalThis.fetch = async request => { received = request; return new Response('ok', { headers: { 'Set-Cookie': 'br_test=session; HttpOnly', 'Content-Type': 'application/json' } }); };
  try {
    const response = await edge.fetch(new Request('https://beat-battle-royale.com/api/rooms/test/join', { method: 'POST', headers: { Cookie: 'tracking=no; br_other=other; br_test=session' } }));
    assert.equal(received.headers.get('cookie'), 'br_test=session');
    assert.match(response.headers.get('set-cookie'), /^br_test=/);
  } finally { globalThis.fetch = original; }
});
test('privacy edge still strips cookies outside the room API', async () => {
  const original = globalThis.fetch; let received;
  globalThis.fetch = async request => { received = request; return new Response('asset', { headers: { 'Set-Cookie': 'tracking=no', 'Content-Type': 'text/plain' } }); };
  try {
    const response = await edge.fetch(new Request('https://beat-battle-royale.com/asset.txt', { headers: { Cookie: 'tracking=no; br_test=session' } }));
    assert.equal(received.headers.get('cookie'), null);
    assert.equal(response.headers.get('set-cookie'), null);
  } finally { globalThis.fetch = original; }
});

test('ranked API forwards only its essential cookie, including OAuth callback', async () => {
  const original=globalThis.fetch;let received;
  globalThis.fetch=async request=>{received=request;return new Response('ok',{headers:{'Set-Cookie':'br_ranked=session; HttpOnly'}})};
  try{
    for(const path of ['profile','state','auth/start','auth/callback?code=test']){
      const response=await edge.fetch(new Request(`https://beat-battle-royale.com/api/ranked/${path}`,{headers:{Cookie:'tracker=no; br_test=room; br_ranked=session'}}));
      assert.equal(received.headers.get('cookie'),'br_ranked=session');assert.match(response.headers.get('set-cookie'),/^br_ranked=/);
    }
    await edge.fetch(new Request('https://beat-battle-royale.com/api/ranked/unknown',{headers:{Cookie:'br_ranked=session'}}));assert.equal(received.headers.get('cookie'),null);
  }finally{globalThis.fetch=original;}
});
