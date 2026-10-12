import {readFile, writeFile, rename, unlink, open} from 'node:fs/promises';
import {queryInventory, evolve, deliver} from './core.mjs';
// Local fallback uses the same state machine and Gmail relay, without a web host.
let lease;
try { lease = await open('monitor.lock', 'wx'); await lease.writeFile(String(process.pid)); }
catch { throw new Error('monitor.lock 已存在。确认没有其他监控进程后才能删除锁文件。'); }
const clean = async () => { await lease.close(); await unlink('monitor.lock').catch(()=>{}); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {await clean(); process.exit(0);});
const save = async state => {await writeFile('state.json.tmp', JSON.stringify(state, null, 2), {mode: 0o600}); await rename('state.json.tmp', 'state.json');};
try {
  let state = {};
  try { state = JSON.parse(await readFile('state.json', 'utf8')); }
  catch (e) {if (e.code !== 'ENOENT') throw e;}
  do {
    if (Date.now() >= (state.nextCheckAt ?? 0)) {state = evolve(state, await queryInventory()); await save(state);}
    await deliver(state, process.env, save);
    console.log(JSON.stringify({lastCheckedAt: state.lastCheckedAt, healthy: state.healthy, rows: state.rows, mailError: state.mailError, pending: state.pending?.length}));
    if (process.argv.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, 60000));
  } while (true);
} finally {await clean();}
