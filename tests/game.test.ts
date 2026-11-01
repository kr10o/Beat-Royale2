import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { newProject } from '../shared/protocol';
import { anonymousProject, assignPairs } from '../shared/battle';
import { Battle } from '../worker/battle';
import { renderBeat, samplePcm } from '../shared/render';
import { eloDelta, totalScore, validVerdict, validProject } from '../shared/ranked';
import { judge } from '../worker/judge';
function setup(count=50) {
 const db=new DatabaseSync(':memory:');
 const storage={sql:{exec(sql:string,...params:any[]){const s=db.prepare(sql);return {toArray:()=>s.all(...params)};}},transactionSync(fn:()=>unknown){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
 // Durable SQL executes immediately, even when callers do not consume a cursor.
 storage.sql.exec=(sql,...params)=>{const s=db.prepare(sql);const rows=s.all(...params);return {toArray:()=>rows};};
 const members=Array.from({length:count},(_,i)=>({id:String(i),name:`P${i}`,role:'producer' as const,ready:true,online:true}));
 const project=newProject();
 const battle=new Battle(storage as any,{players:count,prepMs:60000,roundMs:60000,clipMs:4000},()=>members,()=>project);
 return {db,battle,project,members};
}
test('50-player battle finishes at minute 50, with exactly 49 eliminations; catch-up is idempotent',()=>{
 const {battle,db}=setup(); assert.equal(battle.maybeStart(1000),true); assert.equal(battle.maybeStart(1000),false);
 battle.advance(61000);assert.equal(battle.view(61000).alive,50);assert.equal(battle.view(61000).round,1);
 for(let minute=2;minute<=50;minute++){battle.advance(1000+minute*60000);assert.equal(battle.view(0).alive,51-minute);}
 const end=battle.read();assert.equal(end?.phase,'finished');assert.equal(new Set(end?.entrants.map(p=>p.rank)).size,50);
 assert.equal(battle.advance(999999999),false);assert.deepEqual(battle.read(),end);assert.equal(battle.canEdit(end!.winner!),false);db.close();
 const skipped=setup();skipped.battle.maybeStart(1000);skipped.battle.advance(3001000);assert.equal(skipped.battle.read()?.phase,'finished');skipped.db.close();
});
test('duels freeze snapshots, enforce ownership/listening/deadlines and lock votes',()=>{
 const {battle,db,project}=setup(3);battle.maybeStart(1000);battle.advance(61000);
 const duel=battle.duel('0',62000).duel!;assert.ok(duel);project.tracks[0].steps[0]=true;
 assert.equal(battle.duel('0',62000).duel!.a.tracks[0].steps[0],false);
 assert.match(battle.vote('0',duel.id,'A',62000)!,/Listen/);
 assert.match(battle.vote('1',duel.id,'A',71000)!,/assigned/);
 assert.equal(battle.vote('0',duel.id,'A',71000),null);assert.equal(battle.vote('0',duel.id,'A',71000),null);
 assert.match(battle.vote('0',duel.id,'B',71000)!,/locked/);
 assert.match(battle.vote('0',duel.id,'A',121000)!,/closed/);
 battle.advance(121000);assert.equal(battle.canEdit(battle.read()!.eliminated!),false);db.close();
});
test('pair assignments never contain voter; anonymous snapshots clear transport metadata',()=>{
 const ids=Array.from({length:50},(_,i)=>String(i));let seed=1;const rng=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
 const pairs=assignPairs(ids.map(id=>({id})),ids,rng);assert.equal(pairs.length,50);
 for(const p of pairs){assert.notEqual(p.a,p.b);assert.notEqual(p.voter,p.a);assert.notEqual(p.voter,p.b);}
 const p=newProject();p.revision=42;p.startedAt=100;p.playing=true;const anon=anonymousProject(p);assert.equal(anon.revision,0);assert.equal(anon.playing,false);assert.equal(anon.startedAt,0);
});
test('server PCM exactly matches the public sample pack; rendering respects silence and stereo pan',()=>{
 const manifest=JSON.parse(readFileSync('public/samples/foundry-v1/manifest.json','utf8'));
 manifest.samples.forEach((s:any,i:number)=>assert.deepEqual(Buffer.from(samplePcm(i).buffer),readFileSync(`public${s.url}`).subarray(44)));
 const p=newProject(),silent=renderBeat(p);assert.equal(silent.length,44+24000*8*4);assert.ok(silent.subarray(44).every(v=>v===0));
 p.tracks[0].steps[0]=true;p.tracks[0].pan=-1;const audio=renderBeat(p);const view=new DataView(audio.buffer);let peak=0;
 for(let i=44;i<audio.length;i+=4){peak=Math.max(peak,Math.abs(view.getInt16(i,true)));assert.equal(view.getInt16(i+2,true),0);}assert.equal(peak,27852);
 p.tracks[0].muted=true;assert.deepEqual(renderBeat(p),silent);
});
const card={groove:8,musicality:7,creativity:6,mix:9,feedback:'Balanced rhythm.'};
const verdict={a:card,b:{...card,groove:3},summary:'A has a stronger groove.'};
test('ranked validates frozen projects and scorecards; Elo is zero-sum and draws neutral',()=>{
 assert.equal(validProject(newProject()),true);assert.equal(validProject({...newProject(),bpm:Infinity}),false);
 assert.equal(validVerdict(verdict),true);assert.equal(validVerdict({...verdict,a:{...card,mix:11}}),false);
 assert.equal(totalScore(card),7.6);assert.equal(eloDelta(1000,1000,1),16);assert.equal(eloDelta(1000,1000,0),-16);assert.equal(eloDelta(1000,1000,.5),0);
});
test('Gemini receives two anonymous WAVs and key only in header; invalid/upstream failures never create scores',async()=>{
 const result=await judge(newProject(),newProject(),'private-test-key',async(url,init)=>{
 assert.match(String(url),/gemini-3\.8-flash:generateContent$/);assert.equal((init!.headers as any)['x-goog-api-key'],'private-test-key');
 const payload=JSON.parse(init!.body as string);assert.ok(!JSON.stringify(payload).includes('private-test-key'));
 const parts=payload.contents[0].parts;assert.equal(parts.filter((p:any)=>p.inlineData).length,2);assert.equal(Buffer.from(parts[1].inlineData.data,'base64').subarray(0,4).toString(),'RIFF');
 return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(verdict)}]}}]});
 });assert.deepEqual(result,verdict);
 await assert.rejects(judge(newProject(),newProject(),'secret',async()=>new Response('secret',{status:403})),/Google rejected/);
 await assert.rejects(judge(newProject(),newProject(),'secret',async()=>Response.json({candidates:[{content:{parts:[{text:'{"a":999}'}]}}]})),/invalid scorecard/);
});
