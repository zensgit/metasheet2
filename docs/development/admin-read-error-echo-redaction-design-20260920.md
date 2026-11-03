# admin 读侧 GET 的 500 分支脱敏（ADM-05 后续）— 设计

- 日期：2026-09-20
- 分支：`fix/admin-read-error-echo-redaction`
- 范围：`packages/core-backend/src/routes/admin-routes.ts` 读侧 GET 的 500 分支
- 前置：ADM-05 批次 2（#5884）、批次 3（#5897）

## 1. 背景：这是批次 2/3 自己留下的决策点

批次 2/3 给 `/api/admin` 下的无门 GET 补 `requireAdminRole()` 时，刻意只做"收紧、不改形状"，
并把"500 body 是否回显 `err.message`"写进路由注释留作独立决策点。改前 `admin-routes.ts` 的
`/health/summary` 注释原文即：

> The 500 branch below still echoes err.message; redacting that is a separate decision point
> (see the design note), deliberately not folded into this "tighten only, change no shape" change.

本 PR 就是关掉这个决策点，只动读侧。

## 2. 为什么要脱敏（威胁面）

落进这些 catch 的是驱动 / 基础设施错误，它们的 `message` 天然带部署信息：

- pg 连接失败：`connect ECONNREFUSED <host>:<port>`
- pg 认证失败：`password authentication failed for user "<role>"`（SQLSTATE 28P01）
- 连接池 / Redis 同形；子系统抛出的 Error 还可能带服务端绝对路径

"调用者是平台管理员、所以可以看"不成立——问题不在人，在**通道**：HTTP body 会落到浏览器
devtools、反向代理 / CDN 访问日志、贴进 issue 的截图、以及任何把 `error` 原样渲染的运维面板。
运维需要细节，但细节应该留在服务端日志里，不应该上线路。

## 3. 改法

新增模块内助手 `sendAdminReadFailure(res, context, error, extra?)`（admin-routes.ts，
`const router = Router()` 之后），语义：

1. `logger.error(context, error)` —— 原始 message + stack 只进服务端日志（`core/logger.ts:112`
   会把 `error.message` 与 `error.stack` 塞进 winston meta）。
2. HTTP body 只回稳定错误码 + 固定文案：

```jsonc
{ "success": false, "code": "ADMIN_READ_FAILED", "error": "读取失败，详情见服务端日志" }
```

3. `extra` 只放**调用者自己给的、非敏感**字段（目前仅 `pluginId`，来自请求路径本身）。

### 3.1 为什么不复用 `util/response.ts` 的 `jsonError()`

仓库里确有 `packages/core-backend/src/util/response.ts:3` 的 `jsonError()`，但它的信封是
`{ ok: false, error: { code, message, details } }`，与本路由（及全部现存 admin 用例）读的
`{ success, error }` 不是同一个。复用它会把一次"脱敏"变成一次**破坏性响应形状变更**。
因此这里保持 `success: false` 且 `error` 仍是**字符串**，只是内容换成固定文案，并**新增** `code`
字段——对既有消费者是纯增量。`src/utils`、`src/errors` 下没有通用的 HTTP 错误发送/脱敏工具
（`src/errors` 目录不存在；`src/utils` 只有 `database-errors.ts` 等），所以没有造第二套。

### 3.2 状态码不变

500 仍是 500。404 / 400 分支（`Plugin not found`、`Shard '<name>' not found`、subsystem 白名单）
一律未动——它们的文案来自调用者输入或静态白名单，且已被批次 2/3 的 authz 用例锁定。

## 4. 覆盖面：13 个读侧 GET

盘点方式：`grep -n "error: \(err\|(error as Error)\)\.message" admin-routes.ts`，再按 `router.<method>(`
的行号归属到路由。改后的 13 个读侧调用点（改后行号）：

| 路由 | 调用点 |
| --- | --- |
| `GET /plugins` | admin-routes.ts:527 |
| `GET /plugins/:id` | admin-routes.ts:570 |
| `GET /plugins/:id/config` | admin-routes.ts:652 |
| `GET /slo/status` | admin-routes.ts:1428 |
| `GET /dlq` | admin-routes.ts:1480 |
| `GET /shards` | admin-routes.ts:1591 |
| `GET /shards/:name` | admin-routes.ts:1636 |
| `GET /queues` | admin-routes.ts:1691 |
| `GET /ratelimits` | admin-routes.ts:1845 |
| `GET /ratelimits/:key` | admin-routes.ts:1894 |
| `GET /health/detailed` | admin-routes.ts:2000 |
| `GET /health/summary` | admin-routes.ts:2042 |
| `GET /health/subsystem/:name` | admin-routes.ts:2082 |

任务单点名的 7 个（`/shards`、`/shards/:name`、`/health/detailed`、`/health/subsystem/:name`、
`/health/summary`、`/ratelimits`、`/ratelimits/:key`）全在内；另外 6 个是同一 grep 盘点出的
读侧 GET，同一改法一并处理，避免下一波再开一个同形 PR。

`GET /plugins/health` 与 `GET /yjs/status` 没有 try/catch，不在此列。

## 5. 契约影响

`packages/openapi/src/paths/admin-plugins.yml` 等只声明了 `200/401/403`，没有任何 `'500'`
响应体，所以本次**不涉及 openapi 契约**，`packages/openapi/src` 未改动，dist / dist-sdk 无需重生成。

## 6. 明确的残余（本 PR 不做）

写侧（POST / PUT / DELETE）的 22 个 `err.message` 回显点全部保留，理由：写失败的 body 是刚发起
写操作的那个管理员在读，且插件 / 快照前端会把这串文案直接展示给操作者。这是一个**独立**的决策点，
和读侧不同量——读侧可以被轮询、可以被未授权前的探测复用，写侧不行。

为了不让它悄悄消失，新 spec 底部有一条结构化扫描用例：解析 `admin-routes.ts`，把每个残留回显点
归属到它的路由方法，断言**没有任何 GET 路由**再回显 `err.message`。新加一个会回显的读侧 GET 会让
它红。

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
