import {STORES, PRODUCTS, targetKey} from './core.mjs';
export const RETENTION_DAYS = 14;
export function changesBetween(previous, state) {
  return Object.entries(state.rows).flatMap(([key, row]) => {
    if (row.kind === 'unknown') return [];
    const old = previous.definite?.[key] ?? (row.partNumber === 'MJXW4ZA/A' ? previous.definite?.[row.storeNumber] : undefined);
    if (old === row.kind) return [];
    return [{key, ...row, from: old ?? null, to: row.kind}];
  });
}
export async function recordPoll(env, previous, state, result, startedAt, endedAt) {
  const id = String(startedAt);
  const changes = changesBetween(previous, state);
  const statements = [env.DB.prepare('INSERT OR IGNORE INTO query_history (id, at, ended_at, healthy, http_status, blocked, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, startedAt, endedAt, state.healthy ? 1 : 0, result.httpStatus ?? null, result.blocked ? 1 : 0, JSON.stringify(state.rows))];
  if (changes.length) statements.push(env.DB.prepare('INSERT OR IGNORE INTO stock_history (id, at, source, changes) VALUES (?, ?, ?, ?)').bind(id, startedAt, 'query', JSON.stringify(changes)));
  await env.DB.batch(statements);
}
export async function recordNotification(env, event, status, now, attempts) {
  await env.DB.prepare('INSERT INTO notification_history (id, created_at, updated_at, type, targets, status, attempts) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status, attempts=excluded.attempts').bind(event.id, event.at, now, event.type, JSON.stringify(event.ids), status, attempts).run();
}
export async function cleanHistory(env, now) {
  const cutoff = now - RETENTION_DAYS * 86400000;
  await env.DB.batch(['query_history', 'stock_history', 'notification_history'].map(table => env.DB.prepare(`DELETE FROM ${table} WHERE ${table === 'notification_history' ? 'created_at' : 'at'} < ?`).bind(cutoff)));
}
export async function readHistory(env, url) {
  const part = url.searchParams.get('part') ?? PRODUCTS[0][0];
  const store = url.searchParams.get('store') ?? 'all';
  const days = Number(url.searchParams.get('days') ?? 1);
  if (!PRODUCTS.some(p => p[0] === part) || (store !== 'all' && !STORES.some(s => s[0] === store)) || ![1,7,14].includes(days)) return {error:'筛选参数无效'};
  const since = Date.now() - days * 86400000;
  const filter = "json_extract(j.value,'$.partNumber')=? AND (?='all' OR json_extract(j.value,'$.storeNumber')=?)";
  const polls = await env.DB.prepare(`SELECT q.at, q.ended_at, q.http_status, q.blocked, json_extract(j.value,'$.storeNumber') AS store, json_extract(j.value,'$.kind') AS kind, json_extract(j.value,'$.reason') AS reason FROM query_history q, json_each(q.snapshot) j WHERE q.at>=? AND ${filter} ORDER BY q.at DESC LIMIT 180`).bind(since,part,store,store).all();
  const changes = await env.DB.prepare(`SELECT q.at, q.source, json_extract(j.value,'$.storeNumber') AS store, json_extract(j.value,'$.from') AS previous, json_extract(j.value,'$.to') AS kind FROM stock_history q, json_each(q.changes) j WHERE q.at>=? AND ${filter} ORDER BY q.at DESC LIMIT 100`).bind(since,part,store,store).all();
  const notifications = await env.DB.prepare("SELECT created_at, updated_at, type, status, attempts FROM notification_history WHERE created_at>=? AND (type!='restock' OR EXISTS (SELECT 1 FROM json_each(targets) t WHERE t.value LIKE ? AND (?='all' OR t.value=?))) ORDER BY created_at DESC LIMIT 50").bind(since,'%|'+part,store,targetKey(store,part)).all();
  const coverage = await env.DB.prepare('SELECT MIN(at) AS since, MAX(at) AS latest, COUNT(*) AS count FROM query_history').first();
  return {part,store,days,retentionDays:RETENTION_DAYS,coverage,polls:polls.results,changes:changes.results,notifications:notifications.results,limits:{polls:180,changes:100,notifications:50}};
}
