# TRG-04 HTTP 目标白名单收窄（F6）验证记录 — 2026-09-20

> **执行状态声明：仍未在任何真实数据库上执行。** 本文所有数字来自**本机一次性合成
> PostgreSQL 16.9**（便携二进制、scratchpad 里的临时 cluster、回环地址、跑完即停并
> `DROP SCHEMA … CASCADE`），数据全是明显假值（`*.invalid` 主机、`FAKE-NOT-A-REAL-*`
> 占位、`user-fake-N`）。**没有连接 222，没有连接客户实例，没有连接任何生产库。**
> TRG-04 的真实盘点仍需 owner 另行授权（目标库、只读身份、窗口、超时与输出预算）。

改动对象：`scripts/ops/readonly-inventory-20260916/02-trg04-http-targets.sql`
（PR #5786 已合入 `main`，本轮是对它的收窄返修）。基线 commit：`34b64102c`。

## 1. 要修的是什么

PR #5786 的 F3 把 HTTP 命中判据从文本扫描换成 JSON 语义匹配，方向正确，但那一版的"语义"
在两个方向上比**实际会被读去发请求的面**更宽，且两处都是**高报**：

| # | 过宽在哪 | 后果 |
|---|---|---|
| F6-1 | 键名白名单 7 个（`url`/`webUrl`/`webhookUrl`/`endpoint`/`endpointUrl`/`targetUrl`/`callbackUrl`），其中只有 `url` 有读取点 | 6 个别名纯属噪声；任何碰巧叫这些名字的字段都会被算成出网目标 |
| F6-2 | `jsonb_path_query(actions,'$.**')` 递归整棵 `config` | 钻进 `send_webhook` 的**用户自撰 `body` / `headers`**；`body.callbackUrl = "http://…"` 这种正常回调约定被算成"http 出网目标" |

TRG-04 的这个数字是 owner 用来判断"能不能合 #5619 / #5649、会不会打断现网"的输入。高报比
低报更容易把一次本可以直接合的收紧拖成"先去清存量"。

## 2. 读取点（亲读，给 path:line）

| 位置 | 读取点 |
|---|---|
| `automation_rules.actions[*].config.url` | `packages/core-backend/src/multitable/automation-executor.ts:4199` —— `const url = config.url as string \| undefined`；派发点 `:2591`（`this.executeSendWebhook(action.config, …)`）；模拟路径同一成员 `:1012` |
| 类型契约 | `packages/core-backend/src/multitable/automation-actions.ts:144-151` —— `SendWebhookConfig { url, method?, headers?, body?, secret? }` |
| 前端唯一写入点 | `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:504`（`v-model="action.config.url"`），回填 `:3801` |
| `automation_rules.action_config`（旧列） | `packages/core-backend/src/multitable/automation-service.ts:1187-1190` —— `actions` 为 NULL/空时回退成 `[{ type: action_type, config: action_config }]`，随后同样走 `:4199` |
| `multitable_webhooks.url` | `packages/core-backend/src/multitable/webhook-service.ts:394` —— `this.fetchFn(wh.url, …)` |

嵌套只有一层，且有强制：

| 路径 | 代码 |
|---|---|
| `config.branches[*].actions` | `automation-executor.ts:2348`、`:2378`（condition_branch）；`:2247`（parallel_branch） |
| `config.defaultBranch.actions` | `automation-executor.ts:2342`、`:2372-2373` |
| 禁止第三层 | `automation-service.ts:874`、`:877`（branches 内不得再嵌 condition_branch / parallel_branch）；`:902`、`:905`（defaultBranch 同） |

### 2.1 六个别名"零读取点"怎么证的

| 别名（含下划线写法） | 扫描 | 结果 |
|---|---|---|
| `webUrl` / `web_url` | `grep -rn --include=*.ts --include=*.vue --include=*.js --include=*.mjs` over `packages/ apps/ plugins/` | 0 命中 |
| `endpointUrl` / `endpoint_url` | 同上 | 0 命中 |
| `targetUrl` / `target_url` | 同上 | 0 命中 |
| `callbackUrl` / `callback_url` | 同上 | 0 命中 |
| `endpoint`（裸键） | `grep -rn --include=*.ts "\bendpoint\b" packages/core-backend/src/multitable/` | 0 命中（全仓其它命中都是 HTTP 路由路径一类用法，不是这两张表里的取值键） |
| `webhookUrl` / `webhook_url` | 有命中，但**不在这两张表里** | ① `dingtalk_group_destinations.webhook_url`（密文存储；`packages/core-backend/src/integrations/dingtalk/robot.ts:33-55` 强制 https + 固定 host + 必带 access_token，**结构上装不下 `http://`**）；② 创建 `multitable_webhooks` 行的**请求体**字段 `packages/core-backend/src/routes/api-tokens.ts:55` —— 落库后的列名就是 `url`，Q5/Q6 已直接读它 |

## 3. 收窄后的判据

```
$[*].config.url
$[*].config.branches[*].actions[*].config.url
$[*].config.defaultBranch.actions[*].config.url
```

旧列 `action_config` 同一套路径上移一层，并按 `action_type` 分派：
`send_webhook` → `$.url`；`condition_branch` / `parallel_branch` →
`$.branches[*].actions[*].config.url` 与 `$.defaultBranch.actions[*].config.url`。

两个刻意的非对称：

- **键名大小写敏感**。`config.url` 是 JavaScript 属性读取，存成 `"URL"` 的成员执行器读不到
  （那种规则今天就以 `Webhook URL is required` 失败，与守卫无关），所以它不是出网目标。
- **值的 scheme 判定仍不敏感**（`ILIKE 'http://%'`）。URL scheme 本就大小写不敏感，
  `HTTP://…` 会被 `fetch` 真的拨出去。

**不丢信息**：原 `$.**` + 7 键逻辑一条不删，降级为并排的上界列
（`http_rules_upper_bound`、`http_rules_legacy_column_upper_bound`、
`internal_target_rows_upper_bound`），Q3 每行同时给 `narrow_hit` 与 `upper_bound_hit`。
`multitable_webhooks`（Q5/Q6）没有上界孪生列——它读的是专用 `text` 列，本来就是窄的。

## 4. 合成库与执行方式

```
PostgreSQL 16.9（便携二进制，scratchpad 里 initdb 的一次性 cluster）
监听 127.0.0.1，非默认端口，trust 认证，仅本机
PGCLIENTENCODING=UTF8
跑完 DROP SCHEMA … CASCADE + pg_ctl stop
```

```bash
# 干净跑（两层：静态契约 + 合成库两种 schema）
DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/<scratch> \
METASHEET_REAL_DB_TEST_STEP=1 \
PSQL=<scratchpad>/pgsql/bin/psql.exe \
  node --test scripts/ops/readonly-inventory-20260916/verify/readonly-inventory-pack.test.mjs
```

**干净跑结果：9/9 通过，0 失败、0 跳过**（含 `synthetic PostgreSQL: F3 / F4 / F5 / F6 on
both schema shapes`）。

顺带修掉一处**环境相关的假红**：psql 的 `client_encoding` 默认取自控制台代码页，在中文
locale 的 Windows 上是 GBK，装载 UTF-8 的 `fixture-modern.sql` 会死在注释里的破折号上
（`character with byte sequence 0x80 0xe2 in encoding "GBK" has no equivalent in encoding
"UTF8"`）。`verify/run-verify.mjs` 现在给每次 psql 调用钉死 `PGCLIENTENCODING=UTF8`。这是
harness 的健壮性修正，不改任何判据。

## 5. 正反例（合成新 schema，`fixture-modern.sql`）

`automation_rules` 共 14 行。Q2 实跑：**`http_rules = 6`，`http_rules_upper_bound = 8`**；
Q3 列出 8 行（= 上界），其中 `narrow_hit = t` 的正好 6 行。

| 类 | 行 | 形状 | 窄口径 | 上界 |
|---|---|---|---|---|
| 正 | `r-top` | 顶层 `config.url` = `http://` | 命中 | 命中 |
| 正 | `r-nested` | `config.branches[*].actions[*].config.url` | 命中 | 命中 |
| 正 | `r-default` | `config.defaultBranch.actions[*].config.url` | 命中 | 命中 |
| 正 | `r-spaced` | 带空格排版写入 | 命中 | 命中 |
| 正 | `r-upper` | 值是 `HTTP://`（scheme 大小写） | 命中 | 命中 |
| 正 | `r-internal` | `config.url` = 回环字面量 | 命中 | 命中 |
| **假阳性** | `r-body-callback` | `config.url` 是 https，`config.body.callbackUrl` 是 `http://` | **不中** | 命中 |
| **假阳性** | `r-keycase` | 键写成 `config.URL` | **不中** | 命中 |
| 反 | `r-https` | `https://` | 不中 | 不中 |
| 反 | `r-https-upper` | `HTTPS://` | 不中 | 不中 |
| 反 | `r-decoy` | 普通文本字段里含 `"url":"http://…` 字面量 | 不中 | 不中 |
| 旧列 | `r-legacy` | `actions` NULL，`action_config.$.url` = `http://` | Q4 命中 | Q4 命中 |
| 旧列 | `r-legacy-branch` | `actions` NULL，`action_config.branches[*].actions[*].config.url` | Q4 命中 | Q4 命中 |
| 旧列 | `r-legacy-body` | `actions` NULL，`$.url` 是 https、`body.callbackUrl` 是 `http://` | **Q4 不中** | Q4 命中 |

Q4 实跑：`http_rules_legacy_column = 2`，`http_rules_legacy_column_upper_bound = 3`。
Q7（内网字面量）实跑：`internal_target_rows = 1`，上界 `= 1`。
Q5/Q6（`multitable_webhooks`）不受本轮影响：4 条，`active` 分组 3 + 1，id 列表与计数一致。

`fixture-modern.sql` 里 `actions` 各行这次**被改写成运行时真实形状**
`{ "type": …, "config": { … } }`。收窄前的 fixture 把 `url` 直接挂在 action 对象上，那个形状
没有任何代码路径会产生——`$.**` 两种都能扫到，所以旧 fixture 的不准确一直不可见；窄判据是
形状精确的，fixture 必须跟着精确。

**F3 的证据仍然成立**：在同一批数据上单独跑返修前的文本谓词
`actions::text ILIKE '%"url":"http://%'` 得 **0**（6 条真实存量全漏）。

## 6. 两种 schema

| schema | `INVENTORY_RESULT` | 说明 |
|---|---|---|
| 新（`fixture-modern.sql`） | `status=complete scope=automation_rules+multitable_webhooks` | Q2/Q3/Q4/Q5/Q6/Q7 全跑 |
| 旧（`fixture-legacy.sql`，无 `actions` 列） | `status=incomplete reason=missing-column:automation_rules.actions scope=multitable_webhooks-only` | Q2/Q3 被 `\if` 跳过（**不是静默 0**）；Q4 仍跑，且旧 schema 下 `action_config` **就是**执行器读的配置（无 `actions` 列 ⇒ `automation-service.ts:1187-1190` 的回退永远生效），实跑 `1 \| 2` —— 窄口径 1（`r-b-legacy`），上界 2（多一条 `r-b-body`，它的 `http://` 在 body 里） |

F5 的中止语义没有被本轮改动碰：锁超时 → psql 退出码 3、**不打印任何 `INVENTORY_RESULT` 行**；
无 `SELECT` 权限的角色 → `status=incomplete reason=missing-table:data_sources` 且不打印任何计数。

## 7. 变异探针（"去掉守卫测试就红"）

每个探针把**整个包**复制到 scratchpad 的独立子目录、只改副本、从副本跑 harness
（`run-verify.mjs` 用 `path.resolve(HERE, '..')` 定位包，所以副本测的是副本）。仓库树全程
未被写入；探针目录互不重名，不会和别的 agent 撞。

| 探针 | 改什么 | 干净值 | 变异后 | 红在哪 |
|---|---|---|---|---|
| **m1** 取消收窄 | 窄谓词的三条读取路径 → 换回 `ARRAY['$.**'::jsonpath]` | `6 \| 8` | **`8 \| 8`**，`r-body-callback`、`r-keycase` 混进窄集合 | 静态 `F6: …` 红（`narrow predicate must address '$[*].config.url'`）+ 合成库 `synthetic PostgreSQL…` 红（`narrow set must be exactly the six read-path http:// rows`）——2 红 |
| **m2** 去掉 https 排除 | `ILIKE 'http://%'` → `ILIKE 'http%'`（全文件） | `6 \| 8` | **`9 \| 10`**，`r-https`、`r-https-upper` 被扫进来 | 合成库 `synthetic PostgreSQL…` 红（同上断言）——1 红 |
| **m3** 断开 hit CTE 共用 | Q3 的 `WHERE narrow_hit OR upper_bound_hit` → `WHERE true` | Q3 列 8 行 | Q3 列 **14 行**（全表） | 静态 `F4 (not regressed)…` 红（`the id query must filter on the shared CTE booleans`）+ 合成库红（`F4 invariant: |listed ids| == upper-bound count`）——2 红 |

三个探针都**只在变异后红**；干净树 9/9 全绿。

## 8. 顺带更正的一处否定性结论

`readonly-inventory-pack-design-20260916.md` 原文写过"零处非注释地读取 `action_config`……
即使有，运行时也不会读到它"。这句是错的：`automation-service.ts:1187-1190` 的
`toExecutorRule` 回退让 `actions` 为 NULL/空的行**实际执行** `action_config`。设计文档与
`02-trg04-http-targets.sql` 的 Q4 注释都已更正。影响：Q4 不是陈列品，它是那批行真正的出网
目标来源——旧 schema 上更是**全部**行。

## 9. 残余 / 没做的事

- **本轮没在任何真库跑过**，包括 222。真实盘点仍需 owner 授权。
- **PR #5786 已经合进 `main`**。在本 PR 合入之前，owner 若照 `main` 上的版本执行，拿到的是
  **上界计数**而不是精确计数——数字偏大、方向安全（不会漏报会坏的行），但据此评估破坏面会
  高估。合入后重跑即得窄/宽两个数。
- **Q7 仍是下界**：它只认 `127.`/`10.`/`192.168.`/`169.254.`/`0.0.0.0`/`localhost`/`[::1]`
  这几个字面量，漏 `172.16/12`、`*.internal`/`*.local`、IPv6 ULA/link-local、`::ffff:`
  映射地址——这些 `webhook-ssrf-guard.ts` 接上后都会拒。本轮只改了它的取值路径，没扩它的
  主机词表。
- **3xx 重定向**仍然盘不出来：它不是存量数据上的静态属性，与 F6 无关，结论继承自 #5786。
- **`config.url` 里 userinfo / query string 携带的凭据**：values-free 纪律下 URL 值只进
  `WHERE`，不进 `SELECT`，所以盘点看得见"是不是 http://"，看不见也不外传具体值。
- **上界差额没有单独的处置建议**。本轮只保证 owner 能同时看到两个数、并能从 Q3 拿到差额行的
  id；这批行要不要单独排查（例如 `body.callbackUrl` 指向内网的回调约定）是 owner 的判断，
  本包不代为决定。
