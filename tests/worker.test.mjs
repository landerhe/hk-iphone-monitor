import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {run} from '../src/worker.mjs';
import {readFileSync} from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('./live-fixture.json',import.meta.url)));
function database(state = {}) {
  const row={state:JSON.stringify(state),lock_until:0,lock_token:null};
  return {row,prepare(sql){return {values:[],bind(...args){this.values=args;return this;},async first(){return {state:row.state};},async run(){const v=this.values;let changes=0;
    if(sql.includes('AND lock_until<')){if(row.lock_until<v[2]){row.lock_until=v[0];row.lock_token=v[1];changes=1;}}
    else if(sql.includes('SET state=')){if(row.lock_token===v[1]){row.state=v[0];changes=1;}}
    else if(sql.includes('SET lock_until=0')){if(row.lock_token===v[0]){row.lock_until=0;row.lock_token=null;changes=1;}}
    return {meta:{changes}};
  }}}};
}
test('status endpoint denies unauthenticated access and flags stale snapshots',async()=>{
  const env={DB:database({lastCheckedAt:1}),ADMIN_TOKEN:'unit-test-token'};
  assert.equal((await worker.fetch(new Request('https://test/api/status'),env)).status,401);
  const response=await worker.fetch(new Request('https://test/api/status',{headers:{Authorization:'Bearer unit-test-token'}}),env);
  const s=await response.json();assert.equal(s.stale,true);assert.equal(s.configured,false);assert.equal(s.expectedStores,6);
});
test('cron stores actual parsed snapshot and releases lease',async()=>{
  const previousFetch=globalThis.fetch;const DB=database();
  globalThis.fetch=async()=>Response.json(fixture);
  try{await run({DB},{random:()=>0,wait:async()=>{}});const s=JSON.parse(DB.row.state);assert.equal(s.healthy,true);assert.equal(Object.keys(s.rows).length,48);assert.equal(DB.row.lock_until,0);}
  finally{globalThis.fetch=previousFetch;}
});
test('overlapping cron invocations make only one inventory request',async()=>{
  const previousFetch=globalThis.fetch;const DB=database();let requests=0;
  globalThis.fetch=async()=>{requests++;await new Promise(resolve=>setTimeout(resolve,10));return Response.json(fixture);};
  try{await Promise.all([run({DB},{random:()=>0,wait:async()=>{}}),run({DB},{random:()=>0,wait:async()=>{}})]);assert.equal(requests,1);}
  finally{globalThis.fetch=previousFetch;}
});
test('blocked response persists immediate health alert without mail config',async()=>{
  const previousFetch=globalThis.fetch;const DB=database();
  globalThis.fetch=async()=>new Response('blocked',{status:541});
  try{await run({DB},{random:()=>0,wait:async()=>{}});const s=JSON.parse(DB.row.state);assert.equal(s.healthy,false);assert.equal(s.pending[0].type,'unhealthy');assert.ok(s.mailError);assert.ok(s.nextCheckAt>s.lastCheckedAt+14*60000);}
  finally{globalThis.fetch=previousFetch;}
});

test('a skipped cron tick makes no Apple request',async()=>{
 const previousFetch=globalThis.fetch;const DB=database({nextCheckAt:Date.now()+600000,pending:[]});let requests=0;
 globalThis.fetch=async()=>{requests++;return Response.json(fixture);};
 try{await run({DB},{wait:async()=>{throw Error('should not wait');}});assert.equal(requests,0);}
 finally{globalThis.fetch=previousFetch;}
});
test('planned cooldown is not misreported as stale',async()=>{
 const now=Date.now(), env={DB:database({lastCheckedAt:now-600000,nextCheckAt:now+600000,cooldown:true}),ADMIN_TOKEN:'unit-test-token'};
 const r=await worker.fetch(new Request('https://test/api/status',{headers:{Authorization:'Bearer unit-test-token'}}),env);
 assert.equal((await r.json()).stale,false);
});

test('cron waits for a nearby randomized deadline before querying',async()=>{
 const previousFetch=globalThis.fetch;const DB=database({nextCheckAt:Date.now()+30000,pending:[]});let waited=0,requests=0;
 globalThis.fetch=async()=>{requests++;return Response.json(fixture);};
 try{await run({DB},{random:()=>0,wait:async ms=>{waited=ms;}});assert.ok(waited>25000&&waited<=30000);assert.equal(requests,1);}
 finally{globalThis.fetch=previousFetch;}
});
test('cron never waits through an Apple block cooldown',async()=>{
 const previousFetch=globalThis.fetch;const DB=database({nextCheckAt:Date.now()+30000,cooldown:true,pending:[]});let requests=0;
 globalThis.fetch=async()=>{requests++;return Response.json(fixture);};
 try{await run({DB},{wait:async()=>{throw Error('cooldown must not wait');}});assert.equal(requests,0);}
 finally{globalThis.fetch=previousFetch;}
});
