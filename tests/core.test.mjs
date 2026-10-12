import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {SKU, STORES, parseInventory, queryInventory, evolve, deliver} from '../src/core.mjs';
const fixture = JSON.parse(readFileSync(new URL('./live-fixture.json', import.meta.url)));
const result = () => ({rows: parseInventory(fixture), blocked: false});
test('real Apple fixture covers all six stores and correct product', () => {
  assert.equal(Object.keys(result().rows).length, 6);
  for (const [id] of STORES) {
    assert.equal(result().rows[id].kind, 'out_of_stock');
    assert.match(fixture.body.stores.find(s => s.storeNumber === id).partsAvailability[SKU].messageTypes.regular.storePickupProductTitle, /512GB/);
  }
});
test('missing stores, missing SKU, unknown value and bad envelope remain unknown', () => {
  let f = structuredClone(fixture); f.body.stores.pop();
  assert.equal(Object.values(parseInventory(f)).filter(r => r.kind === 'unknown').length, 1);
  f = structuredClone(fixture); delete f.body.stores[0].partsAvailability[SKU];
  assert.equal(parseInventory(f)[f.body.stores[0].storeNumber].kind, 'unknown');
  f = structuredClone(fixture); f.body.stores[0].partsAvailability[SKU].pickupDisplay = 'surprise';
  assert.equal(parseInventory(f)[f.body.stores[0].storeNumber].kind, 'unknown');
  f.head.status = '500'; assert.ok(Object.values(parseInventory(f)).every(r => r.kind === 'unknown'));
});
test('nested envelope supported; duplicate store and mismatched SKU rejected', () => {
  assert.deepEqual(parseInventory({head:fixture.head, body:{content:{pickupMessage:{stores:fixture.body.stores}}}}), result().rows);
  const f = structuredClone(fixture); f.body.stores.push(f.body.stores[0]);
  assert.equal(parseInventory(f)[f.body.stores[0].storeNumber].kind,'unknown');
  f.body.stores.pop(); f.body.stores[0].partsAvailability[SKU].partNumber='WRONG/A';
  assert.equal(parseInventory(f)[f.body.stores[0].storeNumber].kind,'unknown');
});
test('HTTP 541 and HTML never become no stock; blocked query cools down', async () => {
  const blocked = await queryInventory(async()=>new Response('blocked',{status:541}));
  assert.ok(Object.values(blocked.rows).every(r=>r.kind==='unknown'));
  assert.equal(evolve({},blocked,100).nextCheckAt,900100);
  assert.equal(evolve({},blocked,100).pending[0].type,'unhealthy');
  const html = await queryInventory(async()=>new Response('<html>'));
  assert.ok(Object.values(html.rows).every(r=>r.kind==='unknown'));
});
test('restock dedup survives restart and unknown; confirmed no-stock rearms', () => {
  const r = result(); r.rows.R428.kind='in_stock';
  let s=evolve({},r,1); assert.equal(s.pending.length,1);
  s=evolve(JSON.parse(JSON.stringify(s)),r,2); assert.equal(s.pending.length,1);
  const bad=result(); bad.rows.R428.kind='unknown'; s=evolve(s,bad,3);
  s=evolve(s,r,4); assert.equal(s.pending.length,1);
  s=evolve(s,result(),5); s=evolve(s,r,6); assert.equal(s.pending.length,2);
});
test('failure health alert appears once at three consecutive failures; recovery alerts', () => {
  const bad=result(); bad.rows.R499.kind='unknown'; let s={};
  for(let i=0;i<4;i++)s=evolve(s,bad,i);
  assert.deepEqual(s.pending.map(e=>e.type),['unhealthy']);
  s=evolve(s,result(),5); assert.deepEqual(s.pending.map(e=>e.type),['unhealthy','recovered']);
});
test('mail failure keeps durable pending event; later success acknowledges it',async()=>{
  const r=result();r.rows.R428.kind='in_stock';const s=evolve({},r,100);
  const env={MAIL_RELAY_URL:'https://example.com',MAIL_RELAY_SECRET:'x'};let saved;
  await deliver(s,env,async x=>{saved=structuredClone(x);},async()=>new Response('{"ok":false}'),100);
  assert.equal(saved.pending.length,1);assert.ok(saved.mailError);
  await deliver(s,env,async x=>{saved=structuredClone(x);},async()=>new Response('{"ok":true}'),200000);
  assert.equal(saved.pending.length,0);assert.equal(saved.mailError,null);
});
test('Gmail relay authenticates, fixes recipient and deduplicates retries',()=>{
  const props=new Map([['RELAY_SECRET','x'.repeat(32)],['RECIPIENT','self@example.com']]);const sent=[];
  const context=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v),getProperties:()=>Object.fromEntries(props),deleteProperty:k=>props.delete(k)})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},MailApp:{getRemainingDailyQuota:()=>100,sendEmail:e=>sent.push(e)},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})}});
  vm.runInContext(readFileSync(new URL('../gmail/Code.gs',import.meta.url),'utf8'),context);
  const payload={id:'test-1',subject:'[香港库存监控测试]',text:'test',to:'attacker@example.com',secret:'bad'};
  const post=()=>context.doPost({postData:{contents:JSON.stringify(payload)}});
  assert.equal(post().ok,false);payload.secret='x'.repeat(32);assert.equal(post().ok,true);assert.equal(post().duplicate,true);
  assert.equal(sent.length,1);assert.equal(sent[0].to,'self@example.com');
});
