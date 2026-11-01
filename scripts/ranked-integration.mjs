import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let judgeCalls=0, failJudge=false;
const card={groove:8,musicality:7,creativity:6,mix:9,feedback:'Test fixture only.'};
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:"test",modules:true,scriptPath:'.wrangler/deploy/index.js',compatibilityDate:'2026-10-30',compatibilityFlags:['nodejs_compat'],
 durableObjects:{LOBBIES:{className:'BeatRoyaleLobby',useSQLite:true},RANKED:{className:'RankedArena',useSQLite:true}},
 d1Databases:{RANKED_DB:'ranked-test'},bindings:{BATTLE_PLAYERS:'3',BATTLE_PREP_MS:'1000',BATTLE_ROUND_MS:'5000',BATTLE_CLIP_MS:'100',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',GEMINI_API_KEY:'test-sponsored-key-123456789'},
 outboundService:async request=>{
  const url=new URL(request.url);
  if(url.hostname==='generativelanguage.googleapis.com'){
   judgeCalls++;assert.ok(request.headers.get('x-goog-api-key'));assert.equal((await request.json()).contents[0].parts.length,4);
   if(failJudge)return new Response('upstream private detail',{status:503});
   await new Promise(r=>setTimeout(r,100));
   return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({a:card,b:{...card,groove:2},summary:'Test fixture comparison.'})}]}}]});
  }
  if(url.hostname==='oauth2.googleapis.com'){const body=await request.text();assert.match(body,/code_verifier=/);return Response.json({access_token:'test-oauth-token'});}
  if(url.hostname==='openidconnect.googleapis.com')return Response.json({sub:'test-google-user'});
  throw Error('Unexpected outbound '+url.hostname);
 }
}]}));
const base='https://ranked.test';
async function api(action,profile,body){const headers={Origin:base};if(profile)headers.Cookie=profile.cookie;if(body!==undefined)headers['Content-Type']='application/json';const r=await mf.dispatchFetch(base+'/api/ranked/'+action,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});const data=await r.json();return {status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function profile(name){const r=await api('profile',null,{name});assert.equal(r.status,200);return {cookie:r.cookie,id:r.data.me.id};}
const project={pack:'foundry-v1',bpm:120,revision:0,playing:false,startedAt:0,tracks:Array.from({length:6},()=>({steps:Array(16).fill(false),volume:.7,pan:0,muted:false,solo:false}))};project.tracks[0].steps[0]=true;
async function pair(a,b){await api('queue',a,{sponsor:false});await api('queue',b,{sponsor:false});assert.equal((await api('state',a)).data.match,null);await api('queue',b,{sponsor:true});const m=(await api('state',a)).data.match;assert.equal(m.phase,'composing');assert.ok(!JSON.stringify(m).includes('project'));return m.id;}
async function lock(a,b,id){assert.equal((await api('submit',a,{matchId:id,project:{...project,bpm:999}})).status,400);assert.equal((await api('submit',a,{matchId:id,project})).status,200);assert.equal((await api('submit',a,{matchId:id,project})).status,400);assert.equal((await api('submit',b,{matchId:id,project})).data.match.phase,'awaiting_judge');}
try{
 const db=await mf.getD1Database('RANKED_DB');await db.exec(readFileSync('migrations/0001_ranked.sql','utf8').replaceAll('\r','').replaceAll('\n',' '));
 const [a,b,c]=await Promise.all([profile('Alpha'),profile('Beta'),profile('Observer')]);
 const denied=await mf.dispatchFetch(base+'/api/ranked/queue',{method:'POST',headers:{Origin:'https://bad.test',Cookie:a.cookie},body:'{}'});assert.equal(denied.status,403);
 const id=await pair(a,b);await lock(a,b,id);
 assert.equal((await api('judge',c,{matchId:id,provider:'google',apiKey:'test-key-123456789012345'})).status,400);
 assert.equal((await api('judge',a,{matchId:id,provider:'google'})).status,400);
 const [one,two]=await Promise.all([api('judge',a,{matchId:id,provider:'google',apiKey:'test-key-123456789012345'}),api('judge',b,{matchId:id,provider:'google',apiKey:'test-key-123456789012345'})]);
 assert.deepEqual([one.status,two.status].sort(),[200,400]);assert.equal(judgeCalls,1);
 const final=(await api('state',a)).data;assert.equal(final.match.phase,'finished');assert.equal(final.leaderboard.length,2);assert.equal(final.leaderboard.reduce((s,p)=>s+p.rating,0),2000);assert.ok(final.leaderboard.every(p=>p.games===1));
 assert.equal((await db.prepare('SELECT count(*) AS n FROM ranked_results').first()).n,1);assert.equal((await api('leaderboard')).data.me,null);
 assert.equal((await api('judge',a,{matchId:id,provider:'google',apiKey:'test-key-123456789012345'})).status,400);assert.equal(judgeCalls,1);
 await api('queue',a,{sponsor:true});await api('queue',b,{sponsor:true});assert.equal((await api('state',a)).data.match.id,id);await api('cancel-queue',a,{});await api('cancel-queue',b,{});
 const [d,e]=await Promise.all([profile('Delta'),profile('Echo')]);const badId=await pair(d,e);await lock(d,e,badId);failJudge=true;
 const failed=await api('judge',d,{matchId:badId,provider:'google',apiKey:'test-key-123456789012345'});assert.equal(failed.data.me.games,0);assert.equal(failed.data.match.phase,'awaiting_judge');assert.ok(!JSON.stringify(failed.data).includes('private detail'));failJudge=false;
 const start=await mf.dispatchFetch(base+'/api/ranked/auth/start',{headers:{Cookie:c.cookie},redirect:'manual'});assert.equal(start.status,302);const google=new URL(start.headers.get('location'));assert.equal(google.searchParams.get('code_challenge_method'),'S256');assert.equal(google.searchParams.get('scope'),'openid');
 const callback=base+'/api/ranked/auth/callback?code=code&state='+encodeURIComponent(google.searchParams.get('state'));
 assert.equal((await mf.dispatchFetch(callback,{headers:{Cookie:a.cookie},redirect:'manual'})).status,400);
 assert.equal((await mf.dispatchFetch(callback,{headers:{Cookie:c.cookie},redirect:'manual'})).status,302);assert.equal((await api('state',c)).data.me.verified,true);
 assert.equal((await mf.dispatchFetch(callback,{headers:{Cookie:c.cookie},redirect:'manual'})).status,400);

 const clients=[];
 async function enter(role,name){
  const r=await mf.dispatchFetch(base+'/api/rooms/battle-test/join',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({role,name})});const session=await r.json();const cookie=r.headers.get('set-cookie').split(';')[0];
  const connected=await mf.dispatchFetch(base+'/api/rooms/battle-test/socket',{headers:{Origin:base,Cookie:cookie,Upgrade:'websocket'}});const ws=connected.webSocket;ws.accept();const inbox=[],waiters=[];
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);const i=waiters.findIndex(w=>w.p(m));if(i>=0){const w=waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(m);}else inbox.push(m);});
  const c={id:session.id,ws,send:m=>ws.send(JSON.stringify(m)),next(p){const i=inbox.findIndex(p);if(i>=0)return Promise.resolve(inbox.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={p,resolve,timer:setTimeout(()=>reject(Error('Battle message timeout')),12000)};waiters.push(w);});}};clients.push(c);await c.next(m=>m.type==='welcome');return c;
 }
 try{
  const players=await Promise.all([enter('producer','One'),enter('producer','Two'),enter('producer','Three')]);const viewer=await enter('spectator','Listener');
  players.forEach(c=>c.send({type:'ready',value:true}));const preparing=await viewer.next(m=>m.type==='battle'&&m.battle.phase==='preparing');assert.equal(preparing.battle.readyCount,3);
  const duel=(await viewer.next(m=>m.type==='duel'&&m.duel)).duel;assert.equal(duel.round,1);assert.equal(duel.a.revision,0);
  viewer.send({type:'vote',duelId:duel.id,choice:'A'});assert.match((await viewer.next(m=>m.type==='error')).message,/Listen/);
  await new Promise(r=>setTimeout(r,250));viewer.send({type:'vote',duelId:duel.id,choice:'A'});await viewer.next(m=>m.type==='voteRecorded');
  const round2=(await viewer.next(m=>m.type==='battle'&&m.battle.round===2)).battle;assert.equal(round2.alive,2);
  const eliminated=players.find(p=>p.id===round2.eliminated);eliminated.send({type:'edit',requestId:'locked',revision:0,edit:{kind:'clear'}});assert.match((await eliminated.next(m=>m.type==='error'&&m.requestId==='locked')).message,/locked/);
  const end=(await viewer.next(m=>m.type==='battle'&&m.battle.phase==='finished')).battle;assert.equal(end.alive,1);assert.ok(end.winner);
  console.log('PASS: real Durable Object WebSockets, ready gate, automatic alarms, anonymous duels, listening gate, voting, elimination edit lock and final winner.');
 }finally{for(const c of clients)c.ws.close();}
 console.log('PASS: ranked pairing, frozen beats, real Worker judge flow with isolated provider fixture, concurrent/replayed judging, Elo, D1, failed-judge safety, public leaderboard, cooldown, OAuth PKCE/state/session/replay. No real Google request made.');
}finally{await mf.dispose();}
