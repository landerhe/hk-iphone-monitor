import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parseInventory,PRODUCTS,targetKey} from '../src/core.mjs';
import {changesBetween,recordPoll,recordNotification,readHistory,cleanHistory} from '../src/history.mjs';
const fixture=JSON.parse(readFileSync(new URL('./live-fixture.json',import.meta.url)));
const rows=parseInventory(fixture);
const previous={definite:Object.fromEntries(Object.keys(rows).map(k=>[k,'out_of_stock']))};
test('history records only confirmed changes and identifies first observations',()=>{
 const next=structuredClone(rows);const one=targetKey('R428',PRODUCTS[0][0]),two=targetKey('R428',PRODUCTS[1][0]);
 next[one].kind='in_stock';next[two].kind='unknown';
 assert.deepEqual(changesBetween(previous,{rows:next}).map(x=>x.key),[one]);
 assert.equal(changesBetween({}, {rows:next}).find(x=>x.key===one).from,null);
});
test('history SQL roundtrip supports target filters, mail status and retention',async()=>{
 const operations=[];
 const db={prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async run(){operations.push({sql,args:this.args});return {meta:{changes:1}};},async all(){operations.push({sql,args:this.args,read:'all'});return {results:[]};},async first(){operations.push({sql,args:this.args,read:'first'});return {};}};},async batch(statements){for(const s of statements)await s.run();}};
 const env={DB:db},now=Date.now(),next=structuredClone(rows),key=targetKey('R428',PRODUCTS[0][0]);next[key].kind='in_stock';
 await recordPoll(env,previous,{rows:next,healthy:true},{httpStatus:200,blocked:false},now,now+10);
 await recordPoll(env,previous,{rows,healthy:true},{httpStatus:200,blocked:false},now-20*86400000,now-20*86400000+10);
 const event={id:'mail-1',at:now,type:'restock',ids:[key]};
 await recordNotification(env,event,'pending',now,0);await recordNotification(env,event,'sent',now+50,0);
 await cleanHistory(env,now);
 await readHistory(env,new URL('https://test/api/history?part='+encodeURIComponent(PRODUCTS[0][0])+'&store=R428&days=1'));
 const python=`import sqlite3,json,sys\np=json.load(sys.stdin);c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row;c.executescript(p['schema']);result=[]\nfor op in p['ops']:\n q=c.execute(op['sql'],op['args'])\n if op.get('read'): result.append([dict(r) for r in q.fetchall()])\nprint(json.dumps(result))`;
 const result=JSON.parse(execFileSync('python3',['-c',python],{input:JSON.stringify({schema:readFileSync(new URL('../schema.sql',import.meta.url),'utf8'),ops:operations}),encoding:'utf8'}));
 assert.equal(result[0].length,1);assert.equal(result[0][0].kind,'in_stock');
 assert.equal(result[1][0].previous,'out_of_stock');assert.equal(result[1][0].kind,'in_stock');
 assert.equal(result[2].length,1);assert.equal(result[2][0].status,'sent');assert.equal(result[3][0].count,1);
});
test('history filter validation denies unknown targets',async()=>{
 assert.ok((await readHistory({},new URL('https://test/api/history?part=WRONG'))).error);
});
