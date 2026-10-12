# 香港 iPhone 到货监控

为个人自取购买准备的第一阶段工具，基于 [ENCHIGO/apple-pickup-watcher](https://github.com/ENCHIGO/apple-pickup-watcher) 的接口契约和目录移植到 Cloudflare Workers。无自动下单。

固定目标：**iPhone 18 Pro Max / 512GB / Glacier Blue（Apple 香港称“冰川色”）**，香港版 `MJXW4ZA/A`。

覆盖 ifc mall（R428）、apm Hong Kong（R673）、New Town Plaza（R610）、Causeway Bay（R409）、Canton Road（R499）、Festival Walk（R485）。[Apple 官方门店列表](https://www.apple.com/hk/retail/storelist/)。

## 当前验证状态

2026-10-12 已从 Apple 官方购买页核实 SKU，并在本机网络完成真实接口查询：返回全部六家店及正确商品名，当时六店均无自取库存。证据保存在 `verification.json`，用于测试的最小响应在 `tests/live-fixture.json`。

单元测试覆盖六店核对、字段缺失、未知字段、接口拦截、库存变化去重、异常恢复、邮件失败持久化与 Gmail relay 鉴权。Worker 已通过 Wrangler dry-run 编译。

**这不等于已经在云端运行。** 需要完成 Cloudflare 账号授权、D1 创建、Gmail relay 部署，并实测云端查询和收件。Apple 可能对数据中心出口限流；本机成功不代表 Cloudflare 一定成功。

## 为什么选这个运行方式

Cloudflare Cron 每分钟触发 Worker，一次按香港地点查询全部门店；D1 保存最近状态和待发邮件。Google Apps Script 使用你的 Gmail 账号发送邮件，固定收件人，免邮箱密码、免域名。GitHub 只保存源码和执行手动部署工作流。

按当前 [Workers 免费配额](https://developers.cloudflare.com/workers/platform/limits/) 和 [D1 免费配额](https://developers.cloudflare.com/d1/platform/pricing/)，这个规模预计可在免费套餐内运行；以账号其他项目的共享用量为准。普通 Google 账号 [Apps Script 每天最多 100 个邮件收件人](https://developers.google.com/apps-script/guides/services/quotas)，持续有货不会每分钟发送邮件。配额可能调整。

每店有货、无货、未知三态。少一家门店、少目标 SKU、接口失败、非 JSON 或不认识的字段都显示未知。仅当六店都有明确结果时监控显示正常。首次查询已有货会提醒；持续有货不重复，明确无货之后再次有货才再提醒。未知不清空上次明确库存。

邮件先保存到 D1，再发送；失败按指数退避重试，最长每小时重试一次。Gmail relay 在 48 小时内按事件 ID 去重。发送与去重记录无法跨 Gmail 实现原子事务，极端故障可能收到重复邮件。

HTTP 403 / 429 / 541 立即发送一次健康告警并冷却 15 分钟。其他连续三次不完整查询发健康告警，恢复六店完整查询后发恢复邮件。网页会标出 3 分钟以上未更新的状态；冷却期间也会显示过期。Worker 自身完全停掉时，无法自己发送告警，需查看状态页或额外外部心跳服务。

每分钟是计划间隔，不是到货必达承诺。短于轮询间隔的补货、接口拦截、云端故障、邮件延迟仍可能导致错过；提醒不预留库存。

## 部署 Gmail 发送器

1. 用你的 Gmail 账号打开 [Google Apps Script](https://script.google.com/)，新建项目，将 `gmail/Code.gs` 复制为脚本。
2. 项目设置 → 脚本属性，设置 `RECIPIENT` 为你的 Gmail 收件地址；设置 `RELAY_SECRET` 为随机的至少 32 字符密钥。不要提交到 GitHub。
3. 如果启用 manifest 编辑，使用 `gmail/appsscript.json`。只申请发送邮件的权限，不读取收件箱。
4. 部署 → 新建部署 → Web 应用：执行身份为你，谁可以访问选“任何人”。访问虽公开，但每次调用必须提交密钥，收件人固定为脚本属性中的地址。工作区管理员可能禁止此部署方式。
5. 由你确认 Google 的发送邮件授权。保存 `/exec` URL；不要使用只对编辑者有效的 `/dev` URL。脚本更新后要更新部署版本。

## 部署 Cloudflare

需要 Node.js 22。以下命令在项目目录执行，登录与第一次部署可在本机做，之后电脑可以关机。

```sh
npm ci
npm test
npx wrangler login
npx wrangler d1 create hk-iphone-monitor
```

把创建返回的 `database_id` 填入 `wrangler.toml`，再执行：

```sh
npx wrangler d1 execute hk-iphone-monitor --remote --file schema.sql
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put MAIL_RELAY_URL
npx wrangler secret put MAIL_RELAY_SECRET
npm run deploy
```

`ADMIN_TOKEN` 使用另一个至少 32 字符随机密钥；`MAIL_RELAY_URL` 是 Gmail 脚本 `/exec` URL；`MAIL_RELAY_SECRET` 必须与 Gmail 脚本属性一致。三个值通过交互输入，不写进源码。Cloudflare 使用免费 Workers 套餐，不用升级。

部署输出 `workers.dev` URL。打开它，输入管理员密钥，确认：

- 状态有六家门店、目标正确、最近查询时间持续更新。
- 点击“发送测试邮件”，在 Gmail 中实际收到邮件（也检查垃圾邮件）。
- 至少观察几轮，云端没有持续未知或拦截。Cron 配置首次生效可能需要 [最多 15 分钟](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

如果 Cloudflare 持续被拦，先暂停 Cron、使用下面的本机后备方式，不将云端“未知”解释为无货。

## GitHub 保存与部署

创建私有仓库并上传源码（不上传 `.dev.vars` / `.env` / 密钥 / `node_modules`）。已经提供 `.github/workflows/deploy.yml`。

首次用上面的 Wrangler 命令完成 D1 和 secrets 设置。然后在 GitHub 仓库 Secrets 中填 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。API Token 使用 Cloudflare 官方 Worker 部署模板，限制到目标账号。运行 Actions → Test and deploy → Run workflow。工作流只做测试和发布，不用 Actions 定时查询库存。

## 本机后备

同一套目标、判定与邮件逻辑，无需启动网页服务器。Node 22 下可把 `MAIL_RELAY_URL` 和 `MAIL_RELAY_SECRET` 写在 `.env`（文件忽略提交），运行：

```sh
node --env-file=.env src/local.mjs
```

仅查一次：

```sh
node --env-file=.env src/local.mjs --once
```

会创建 `state.json` 保留到货判定和待发事件；电脑要保持联网和唤醒。`Ctrl+C` 退出。若强制关闭后留下 `monitor.lock`，先确认没有监控进程运行再删除锁。不要同时开本机和云端版，以免共享出口限流或收到两套提醒。

## 文件

- `src/core.mjs`：库存判定、状态变化、邮件队列。
- `src/worker.mjs`：Cloudflare Cron、D1 防重入、受保护状态页。
- `gmail/Code.gs`：Gmail 发送服务。
- `src/local.mjs`：本机后备。
- `schema.sql` / `wrangler.toml`：云端配置。

GPL-3.0-or-later；上游出处见 `NOTICE`、`UPSTREAM-NOTICE` 和 `LICENSE`。
