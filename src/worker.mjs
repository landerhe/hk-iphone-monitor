import {queryInventory, evolve, deliver, sendMail, PRODUCT, PRODUCTS, STORES, BUY_URL} from './core.mjs';
import {recordPoll, recordNotification, cleanHistory, readHistory} from './history.mjs';

async function readState(env) {
  const row = await env.DB.prepare('SELECT state FROM monitor WHERE id=1').first();
  return JSON.parse(row?.state ?? '{}');
}
export async function run(env, {random = Math.random, wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const now = Date.now(), token = crypto.randomUUID();
  const acquired = await env.DB.prepare('UPDATE monitor SET lock_until=?, lock_token=? WHERE id=1 AND lock_until<?').bind(now + 180000, token, now).run();
  if (!acquired.meta.changes) return;
  const save = async state => {
    const written = await env.DB.prepare('UPDATE monitor SET state=? WHERE id=1 AND lock_token=?').bind(JSON.stringify(state), token).run();
    if (!written.meta.changes) throw new Error('Monitor lease lost');
  };
  try {
    let state = await readState(env);
    const remaining = (state.nextCheckAt ?? 0) - Date.now();
    // One-minute cron is a wake-up, not a polling interval. Wait for a nearby
    // randomized deadline, but never wait through a block cooldown.
    if (remaining <= 60000 && (!state.cooldown || remaining <= 0)) {
      if (remaining > 0) await wait(remaining);
      const startedAt = Date.now();
      const previous = structuredClone(state);
      const result = await queryInventory();
      state = evolve(state, result, startedAt, random);
      await save(state);
      try {
        await recordPoll(env, previous, state, result, startedAt, Date.now());
        state.historyStartedAt ??= startedAt;
        state.historyError = null;
        for (const event of state.pending.filter(e => !previous.pending?.some(p => p.id === e.id))) await recordNotification(env,event,'pending',Date.now(),0);
        if (Date.now() - (state.historyCleanupAt ?? 0) > 86400000) {await cleanHistory(env,Date.now());state.historyCleanupAt=Date.now();}
      } catch {state.historyError='查询或通知历史写入失败；当前库存监控继续运行';}
      await save(state);
    }
    await deliver(state, env, save, fetch, Date.now(), async (event,status,at,attempts) => {
      try {await recordNotification(env,event,status,at,attempts);}
      catch {state.historyError='通知历史写入失败';await save(state);}
    });
  } finally {
    await env.DB.prepare('UPDATE monitor SET lock_until=0, lock_token=NULL WHERE id=1 AND lock_token=?').bind(token).run();
  }
}
const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'};
const json = (data, status = 200) => Response.json(data, {status, headers});
export default {
  async scheduled(_event, env, ctx) { ctx.waitUntil(run(env)); },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response(page, {headers: {...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"}});
    if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({error: '需要管理员密钥'}, 401);
    if (request.method === 'GET' && path === '/api/status') {
      const state = await readState(env);
      return json({...state, stale: !state.lastCheckedAt || Date.now() > Math.max(state.lastCheckedAt + 180000, (state.nextCheckAt ?? 0) + 90000), configured: Boolean(env.MAIL_RELAY_URL && env.MAIL_RELAY_SECRET), product: PRODUCT, expectedStores: 6, expectedTargets: 48, products: PRODUCTS, targetVersion: state.targetVersion});
    }
    if (request.method === 'GET' && path === '/api/history') {
      try {const data=await readHistory(env,new URL(request.url));return json(data,data.error?400:200);}
      catch {return json({error:'历史记录尚未就绪或读取失败'},503);}
    }
    if (request.method === 'POST' && path === '/api/test-mail') {
      try { await sendMail(env, {id: crypto.randomUUID(), type: 'test', ids: [], at: Date.now()}); return json({ok: true}); }
      catch { return json({ok: false, error: '邮件测试失败；检查 Gmail relay 和 secret'}, 502); }
    }
    return json({error: 'Not found'}, 404);
  }
};
// Token stays in memory; it is never put into a URL, localStorage or server logs.
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>香港 iPhone 到货监控</title><style>body{font:16px system-ui;margin:40px auto;padding:0 24px;max-width:850px;background:#f7f7f5;color:#202524}h1{font-size:28px}h2{font-size:20px;margin-top:30px}p{line-height:1.7}.line{display:flex;justify-content:space-between;gap:20px;padding:10px 0;border-bottom:1px solid #ddd}input,button{font:inherit;padding:10px;margin:4px 0}button{cursor:pointer}small{color:#626966}#health{padding:16px;background:white}a{color:#145e8d}</style><h1>香港 iPhone 到货监控</h1><p>${PRODUCT}<br><small>香港六家 Apple 直营店 · 目标 45–90 秒查询 · 随机间隔 · 到货邮件提醒</small></p><form id="login"><input id="token" type="password" placeholder="管理员密钥" autocomplete="off" required><button>查看状态</button></form><p id="health">输入管理员密钥查看实时监控状态。</p><div id="stores"></div><p id="details"></p><button id="test" hidden>发送测试邮件</button><section><h2>查询记录与到货时间</h2><p>逐次记录从启用此功能后开始保留 14 天；到货时间是检测时间，不能证明精确放货时刻。未知或冷却期间可能错过短暂补货。</p><select id="history-part">${PRODUCTS.map(([part,capacity,color])=>'<option value="'+part+'">'+capacity+' '+color+'</option>').join('')}</select> <select id="history-store"><option value="all">全部门店</option>${STORES.map(([id,name])=>'<option value="'+id+'">'+name+'</option>').join('')}</select> <select id="history-days"><option value="1">最近24小时</option><option value="7">最近7天</option><option value="14">最近14天</option></select> <button id="history-load">查询历史</button><p id="history-coverage"></p><div id="history-results"></div></section><p><a href="${BUY_URL}" target="_blank" rel="noreferrer">打开 Apple 香港购买页</a></p><small>库存不预留；接口失败显示未知。超过计划查询时间会标记过期。被拦后随机冷却，连续被拦会加长等待。</small><script>
let key=''; const health=document.querySelector('#health');
const format=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'}):'尚未完成';
async function refresh(){if(!key)return;try{const r=await fetch('/api/status',{headers:{Authorization:'Bearer '+key}});if(!r.ok)throw Error('无法读取状态，检查管理员密钥');const s=await r.json();health.textContent=s.stale?'状态过期：检查 Cron 是否运行':s.cooldown?'Apple 拦截，冷却中；下一次计划：'+format(s.nextCheckAt):s.historyError?s.historyError:s.healthy?'六店 × 八个型号查询正常':'监控未查齐六店：未知不能当成无货';const root=document.querySelector('#stores');root.replaceChildren();for(const [id,name] of ${JSON.stringify(STORES)}){const section=document.createElement('section'),heading=document.createElement('h2');heading.textContent=name;section.append(heading);for(const [part,capacity,color] of ${JSON.stringify(PRODUCTS)}){const row=s.rows?.[id+'|'+part];const el=document.createElement('div');el.className='line';const a=document.createElement('span'),b=document.createElement('span');a.textContent=capacity+' · '+color;b.textContent=row?({in_stock:'可自取',out_of_stock:'无可自取库存',unknown:'未知'}[row.kind])+(row.reason?' · '+row.reason:''):'等待查询';if(row?.kind==='in_stock'){b.style.color='#08754a';b.style.fontWeight='700';}el.append(a,b);section.append(el);}root.append(section);}document.querySelector('#details').textContent='最近查询：'+format(s.lastCheckedAt)+' · 下次计划：'+format(s.nextCheckAt)+' · 最近六店完整成功：'+format(s.lastHealthyAt)+' · 最近邮件：'+format(s.lastMailAt)+' · 邮件待发送：'+(s.pending?.length||0)+(s.configured?'':' · 邮件尚未配置')+(s.mailError?' · '+s.mailError:'');document.querySelector('#test').hidden=false;}catch(e){health.textContent=e.message;}}
document.querySelector('#login').onsubmit=e=>{e.preventDefault();key=document.querySelector('#token').value;document.querySelector('#token').value='';refresh();};document.querySelector('#test').onclick=async()=>{try{const r=await fetch('/api/test-mail',{method:'POST',headers:{Authorization:'Bearer '+key}});const s=await r.json();health.textContent=s.ok?'测试发送成功，请检查 Gmail 收件箱和垃圾邮件。':s.error||'测试失败';}catch{health.textContent='测试请求失败';}};setInterval(refresh,30000);

document.querySelector('#history-load').onclick=async()=>{if(!key){health.textContent='请先输入管理员密钥';return;}const out=document.querySelector('#history-results');try{const query=new URLSearchParams({part:document.querySelector('#history-part').value,store:document.querySelector('#history-store').value,days:document.querySelector('#history-days').value});const r=await fetch('/api/history?'+query,{headers:{Authorization:'Bearer '+key}});const h=await r.json();if(!r.ok)throw Error(h.error);out.replaceChildren();document.querySelector('#history-coverage').textContent='完整查询历史起点：'+format(h.coverage?.since)+'；累计 '+(h.coverage?.count||0)+' 次实际查询。每次筛选最多显示180条状态、100条变化、50条通知。';const name=id=>${JSON.stringify(STORES)}.find(x=>x[0]===id)?.[1]||id;const add=(title,rows,render)=>{const heading=document.createElement('h3');heading.textContent=title;out.append(heading);if(!rows.length){const p=document.createElement('p');p.textContent='所选范围内没有记录；不等于一直无货。';out.append(p);}for(const row of rows){const p=document.createElement('p');p.textContent=render(row);out.append(p);}};const label=k=>({in_stock:'可自取',out_of_stock:'无货',unknown:'未知'}[k]||k);add('库存变化／检测到货',h.changes,x=>format(x.at)+' · '+name(x.store)+' · '+(x.previous?label(x.previous)+' → ':'首次观察：')+label(x.kind)+(x.source==='email'?'（根据已发送邮件回溯）':''));add('最近实际查询',h.polls,x=>format(x.at)+' · '+name(x.store)+' · '+label(x.kind)+(x.reason?' · '+x.reason:'')+' · HTTP '+(x.http_status??'网络失败'));add('通知记录（启用日志后）',h.notifications,x=>format(x.created_at)+' · '+({restock:'到货',unhealthy:'监控异常',recovered:'监控恢复',test:'测试'}[x.type]||x.type)+' · '+({sent:'发送成功',failed:'发送失败，将重试',pending:'待发送'}[x.status]||x.status)+' · '+x.attempts+' 次失败重试');}catch(e){out.textContent=e.message;}};
</script></html>`;
