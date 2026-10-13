import {queryInventory, evolve, deliver, sendMail, PRODUCT, PRODUCTS, STORES, BUY_URL} from './core.mjs';

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
      state = evolve(state, await queryInventory(), startedAt, random);
      await save(state);
    }
    await deliver(state, env, save);
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
    if (request.method === 'POST' && path === '/api/test-mail') {
      try { await sendMail(env, {id: crypto.randomUUID(), type: 'test', ids: [], at: Date.now()}); return json({ok: true}); }
      catch { return json({ok: false, error: '邮件测试失败；检查 Gmail relay 和 secret'}, 502); }
    }
    return json({error: 'Not found'}, 404);
  }
};
// Token stays in memory; it is never put into a URL, localStorage or server logs.
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>香港 iPhone 到货监控</title><style>body{font:16px system-ui;margin:40px auto;padding:0 24px;max-width:850px;background:#f7f7f5;color:#202524}h1{font-size:28px}h2{font-size:20px;margin-top:30px}p{line-height:1.7}.line{display:flex;justify-content:space-between;gap:20px;padding:10px 0;border-bottom:1px solid #ddd}input,button{font:inherit;padding:10px;margin:4px 0}button{cursor:pointer}small{color:#626966}#health{padding:16px;background:white}a{color:#145e8d}</style><h1>香港 iPhone 到货监控</h1><p>${PRODUCT}<br><small>香港六家 Apple 直营店 · 目标 45–90 秒查询 · 随机间隔 · 到货邮件提醒</small></p><form id="login"><input id="token" type="password" placeholder="管理员密钥" autocomplete="off" required><button>查看状态</button></form><p id="health">输入管理员密钥查看实时监控状态。</p><div id="stores"></div><p id="details"></p><button id="test" hidden>发送测试邮件</button><p><a href="${BUY_URL}" target="_blank" rel="noreferrer">打开 Apple 香港购买页</a></p><small>库存不预留；接口失败显示未知。超过计划查询时间会标记过期。被拦后随机冷却，连续被拦会加长等待。</small><script>
let key=''; const health=document.querySelector('#health');
const format=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'}):'尚未完成';
async function refresh(){if(!key)return;try{const r=await fetch('/api/status',{headers:{Authorization:'Bearer '+key}});if(!r.ok)throw Error('无法读取状态，检查管理员密钥');const s=await r.json();health.textContent=s.stale?'状态过期：检查 Cron 是否运行':s.cooldown?'Apple 拦截，冷却中；下一次计划：'+format(s.nextCheckAt):s.healthy?'六店 × 八个型号查询正常':'监控未查齐六店：未知不能当成无货';const root=document.querySelector('#stores');root.replaceChildren();for(const [id,name] of ${JSON.stringify(STORES)}){const section=document.createElement('section'),heading=document.createElement('h2');heading.textContent=name;section.append(heading);for(const [part,capacity,color] of ${JSON.stringify(PRODUCTS)}){const row=s.rows?.[id+'|'+part];const el=document.createElement('div');el.className='line';const a=document.createElement('span'),b=document.createElement('span');a.textContent=capacity+' · '+color;b.textContent=row?({in_stock:'可自取',out_of_stock:'无可自取库存',unknown:'未知'}[row.kind])+(row.reason?' · '+row.reason:''):'等待查询';if(row?.kind==='in_stock'){b.style.color='#08754a';b.style.fontWeight='700';}el.append(a,b);section.append(el);}root.append(section);}document.querySelector('#details').textContent='最近查询：'+format(s.lastCheckedAt)+' · 下次计划：'+format(s.nextCheckAt)+' · 最近六店完整成功：'+format(s.lastHealthyAt)+' · 最近邮件：'+format(s.lastMailAt)+' · 邮件待发送：'+(s.pending?.length||0)+(s.configured?'':' · 邮件尚未配置')+(s.mailError?' · '+s.mailError:'');document.querySelector('#test').hidden=false;}catch(e){health.textContent=e.message;}}
document.querySelector('#login').onsubmit=e=>{e.preventDefault();key=document.querySelector('#token').value;document.querySelector('#token').value='';refresh();};document.querySelector('#test').onclick=async()=>{try{const r=await fetch('/api/test-mail',{method:'POST',headers:{Authorization:'Bearer '+key}});const s=await r.json();health.textContent=s.ok?'测试发送成功，请检查 Gmail 收件箱和垃圾邮件。':s.error||'测试失败';}catch{health.textContent='测试请求失败';}};setInterval(refresh,30000);
</script></html>`;
