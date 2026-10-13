// Adapted from ENCHIGO/apple-pickup-watcher's API contract and catalog.
export const SKU = 'MJXW4ZA/A'; // Previous single-SKU target, for state migration.
export const PRODUCTS = [
  ['MJXT4ZA/A', '512GB', '黑色'], ['MJXU4ZA/A', '512GB', '银色'],
  ['MJXV4ZA/A', '512GB', '布根地红色'], ['MJXW4ZA/A', '512GB', '冰川色'],
  ['MJXX4ZA/A', '1TB', '黑色'], ['MJXY4ZA/A', '1TB', '银色'],
  ['MJY04ZA/A', '1TB', '布根地红色'], ['MJY14ZA/A', '1TB', '冰川色']
];
export const PRODUCT = 'iPhone 18 Pro Max · 512GB / 1TB · 全部颜色';
export const BUY_URL = 'https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro';
export const STORES = [
  ['R428', 'ifc mall'], ['R673', 'apm Hong Kong'],
  ['R610', 'New Town Plaza'], ['R409', 'Causeway Bay'],
  ['R499', 'Canton Road'], ['R485', 'Festival Walk']
];
export const targetKey = (store, part) => store + '|' + part;
export const targetLabel = key => {
  const [store, part = SKU] = key.split('|');
  const product = PRODUCTS.find(p => p[0] === part);
  return (STORES.find(s => s[0] === store)?.[1] ?? store) + ' · ' + (product ? product[1] + ' ' + product[2] : part);
};
function targetRows(build) {
  return Object.fromEntries(STORES.flatMap(([id, name]) => PRODUCTS.map(([part, capacity, color]) => [targetKey(id, part), {storeNumber:id, name, partNumber:part, capacity, color, ...build(id, part)}])));
}
export function parseInventory(data) {
  const stores = data?.body?.stores?.length ? data.body.stores : data?.body?.content?.pickupMessage?.stores;
  const envelopeOK = Number(data?.head?.status) === 200;
  return targetRows((id, part) => {
    const matches = Array.isArray(stores) ? stores.filter(s => s.storeNumber === id) : [];
    const info = matches.length === 1 ? matches[0].partsAvailability?.[part] : null;
    let kind = 'unknown', reason = '门店或目标型号缺失';
    if (!envelopeOK) reason = 'Apple 响应状态异常';
    else if (info && (!info.partNumber || info.partNumber === part)) {
      const value = String(info.pickupDisplay ?? '').trim().toLowerCase();
      if (value === 'available') kind = 'in_stock';
      else if (['unavailable', 'ineligible'].includes(value)) kind = 'out_of_stock';
      else reason = '无法识别 pickupDisplay';
    }
    return {kind, ...(kind === 'unknown' ? {reason} : {})};
  });
}
export function unknownAll(reason) {
  return targetRows(() => ({kind:'unknown',reason}));
}
export async function queryInventory(fetcher = fetch) {
  const url = new URL('https://www.apple.com/hk-zh/shop/retail/pickup-message');
  url.search = new URLSearchParams({location: 'Hong Kong', pl: 'true', 'mts.0': 'regular'});
  PRODUCTS.forEach(([part], i) => url.searchParams.set('parts.' + i, part));
  try {
    const response = await fetcher(url, {headers: {Accept: 'application/json', Referer: BUY_URL}, signal: AbortSignal.timeout(15000)});
    if (!response.ok) return {rows: unknownAll(`Apple HTTP ${response.status}`), blocked: [403, 429, 541].includes(response.status)};
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('oversize');
    return {rows: parseInventory(JSON.parse(text)), blocked: false};
  } catch {
    return {rows: unknownAll('网络超时或响应不是有效 JSON'), blocked: false};
  }
}
export function evolve(previous, result, now = Date.now(), random = Math.random) {
  const state = structuredClone(previous);
  state.definite ??= {};
  if (state.targetVersion !== 2) {
    // Preserve the previous SKU's notification baseline across deployment.
    for (const [id] of STORES) {
      if (state.definite[id] && !state.definite[targetKey(id, SKU)]) state.definite[targetKey(id, SKU)] = state.definite[id];
      delete state.definite[id];
    }
    state.targetVersion = 2;
  }
  state.pending ??= [];
  state.sequence ??= 0;
  const queue = (type, ids) => {
    const id = `${now}-${++state.sequence}-${type}`;
    state.pending.push({id, type, ids, at: now, attempts: 0, retryAt: now});
  };
  const newStock = [];
  for (const [id, row] of Object.entries(result.rows)) {
    // Unknown never resets a confirmed in-stock state or creates a restock.
    if (row.kind === 'unknown') continue;
    if (row.kind === 'in_stock' && state.definite[id] !== 'in_stock') newStock.push(id);
    state.definite[id] = row.kind;
  }
  if (newStock.length) queue('restock', newStock);
  const healthy = Object.values(result.rows).every(r => r.kind !== 'unknown');
  state.failures = healthy ? 0 : (state.failures ?? 0) + 1;
  if ((state.failures >= 3 || result.blocked) && !state.healthAlerted) { queue('unhealthy', []); state.healthAlerted = true; }
  if (healthy && state.healthAlerted) { queue('recovered', []); state.healthAlerted = false; }
  state.rows = result.rows;
  state.healthy = healthy;
  state.lastCheckedAt = now;
  if (healthy) state.lastHealthyAt = now;
  state.blockStreak = result.blocked ? (state.blockStreak ?? 0) + 1 : healthy ? 0 : (state.blockStreak ?? 0);
  const sample = Math.max(0, Math.min(1, random()));
  state.scheduleVersion = 2;
  state.cooldown = Boolean(result.blocked);
  const delay = result.blocked
    ? Math.min(120, 15 * 2 ** Math.min(state.blockStreak - 1, 3)) * 60000 + Math.floor(sample * 5 * 60000)
    : 45000 + Math.floor(sample * 45000);
  state.nextCheckAt = now + delay;
  return state;
}
export function compose(event) {
  const time = new Date(event.at).toLocaleString('zh-CN', {timeZone: 'Asia/Hong_Kong'});
  const names = event.ids.map(targetLabel).join('\n');
  const label = {restock: '香港 iPhone 到货', unhealthy: '香港库存监控异常', recovered: '香港库存监控恢复', test: '香港库存监控测试'}[event.type];
  return {id: event.id, subject: `[${label}] ${PRODUCT}`, text: `${PRODUCT}\n${time}（香港时间）\n${event.type === 'restock' ? `检测到可自取：${names}\n这是检测时的库存，不会预留。` : event.type === 'unhealthy' ? '请求被拦截或连续三次未查齐六家门店，当前监控不可信。请查看状态页。' : event.type === 'test' ? '测试邮件：收到说明邮件链路正常，不代表有货。' : '六家门店查询已恢复。'}\n${BUY_URL}`};
}
export async function sendMail(env, event, fetcher = fetch) {
  if (!env.MAIL_RELAY_URL || !env.MAIL_RELAY_SECRET) throw new Error('邮件尚未配置');
  const response = await fetcher(env.MAIL_RELAY_URL, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...compose(event), secret: env.MAIL_RELAY_SECRET}), signal: AbortSignal.timeout(20000), redirect: 'follow'});
  if (!response.ok || (await response.json()).ok !== true) throw new Error('邮件服务未确认发送成功');
}
export async function deliver(state, env, save, fetcher = fetch, now = Date.now()) {
  // At most 3 deliveries per tick; persisted before send, acked only on success.
  for (const event of state.pending.filter(e => e.retryAt <= now).slice(0, 3)) {
    try {
      await sendMail(env, event, fetcher);
      state.pending = state.pending.filter(e => e.id !== event.id);
      state.lastMailAt = now;
      state.mailError = null;
    } catch {
      event.attempts++;
      event.retryAt = now + Math.min(3600000, 60000 * 2 ** Math.min(event.attempts, 6));
      state.mailError = '邮件未成功发送；事件已保留，稍后重试';
    }
    await save(state);
  }
}
