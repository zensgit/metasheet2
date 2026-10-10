# 只读盘点包（CRED-06 / TRG-04 / ADM-08 / ADM-13）验证（2026-09-16）

配套设计文档：`readonly-inventory-pack-design-20260916.md`。

## 0. 本机验证方法 —— 没有真库，未实跑

在 `../metasheet-wt-w5i` 这个 worktree 里检查过一遍本机是否有能离线起的 PostgreSQL：

```
$ which psql   → 未找到
$ which docker → 未找到
$ which pg_ctl → 未找到
$ env | grep -i "DATABASE_URL\|PG" → 空
```

`scripts/ops` 目录下确实有别的只读观测 SQL（如 `multitable-o2-observation.sql`）以及大量真库
集成测试（`vitest.integration.config` 命中 240 个文件），但都要求一个可连接的
`DATABASE_URL`，本机没有，而且**任务边界明确禁止本代理连接任何数据库**（包括起一个本地
临时 PG 实例）——所以即便本机装了 Docker，也不会用它来跑这四份 SQL。

因此验证方法是**逐条对照迁移文件人工核对列名**：每条查询引用的表名/列名/数据类型，都在
下面 §1-§4 的表格里给出「查询 → 迁移文件:行」的映射，映射本身是本次会话里用 `grep -n`
在这个 worktree（`origin/main` HEAD `38caaf17b`）以及两个 `git fetch` 来的分支上现读出来的
实际行号，不是凭印象写的。**语法本身（函数名拼写、括号配对、操作符重载解析）以 `psql` 实跑
为准**——上机前请按 README §3 的步骤，至少先跑一遍每份文件的 Q1 列探针，理想情况下先在一个
测试库上跑通再对生产库跑。

已知的语法层面的不确定性（诚实列出，不是遗漏）：

- `data_sources.config #> '{connection}'`（不带 `::text[]` 强制转换的裸路径写法）：这个写法
  直接照抄自 `data-source-connection-secret-keys-design-20260912.md` §5 B3 查询里的用法（该
  设计文档同样注明"以上 SQL 一条都没有实跑"）。按 PostgreSQL 的操作符重载解析规则，`#>` 只有
  一个 `jsonb #> text[]` 签名，未知类型的字符串字面量应能被自动推断为 `text[]`，但这条推理
  没有被本次任务在真实 PostgreSQL 上验证过。
- `regexp_replace(…, 'g')` 配合单值（非重复匹配场景）：语义上等价于不带 `'g'`，只是多余，不
  应该导致语法错误，但同样没有实跑确认。

## 1. `01-cred06-secret-keys.sql`

| 查询 | 引用的表/列 | 迁移文件:行 |
|---|---|---|
| Q1 | `data_sources.config` (jsonb) | `packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts:30`（表创建 :21，`id` :23） |
| Q1 | `data_sources.connection` / `.credentials` (jsonb) | `packages/core-backend/migrations/040_data_sources.sql:12-13`（表创建 :7，`id` :8） |
| Q2/Q3 | `data_sources.config->'connection'`、`->'connection'->'headers'` | 同 Q1 形状 A；正则词表来自 `data-source-secret-keys.ts` `DATA_SOURCE_SECRET_KEY_WORDS`（`origin/fix/data-source-secret-keys-vocab-nfkc`，模块不在 `main`）+ SQL 侧近似正则，逐字取自 `docs/development/data-source-connection-secret-keys-design-20260912.md` §5（该文件同样只在上述分支 + `origin/test/secret-keys-realdb-inventory-sync` 上存在） |
| Q4/Q5 | `data_sources.connection`、`.connection->'headers'` | 同 Q1 形状 B；正则同上 |
| Q6 | `data_sources.config->'connection'` 键名普查 | 同 Q2；查询结构逐字取自设计文档 §5 "A. 键普查" |
| Q7 | `data_sources.connection` 键名普查 | 同 Q4，镜像 Q6 |

## 2. `02-trg04-http-targets.sql`

| 查询 | 引用的表/列 | 迁移文件:行 |
|---|---|---|
| Q1 | `automation_rules.id/sheet_id/action_config/actions` | `id`/`sheet_id`/`action_config` 创建于 `packages/core-backend/src/db/migrations/zzzz20260413120000_create_automation_rules.ts:26,27,32`；`actions` 追加于 `packages/core-backend/src/db/migrations/zzzz20260414100000_extend_automation_rules.ts:27`（`send_webhook` 加入 `action_type` CHECK 同文件 :57） |
| Q1 | `multitable_webhooks.id/url/active/created_by` | `packages/core-backend/src/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts:34（表创建）,37,40,41` |
| Q2/Q3 | `automation_rules.actions`（V1 多动作数组，运行时实际读取列） | 同上；运行时读取点核对方式：`grep -n "rule.actions" packages/core-backend/src/multitable/automation-executor.ts` 命中十余处非注释代码（如 `:1734,:1846,:1992`），`grep -n "action_config"` 在该文件里零处非注释命中 |
| Q4（SUPPLEMENTARY） | `automation_rules.action_type/action_config`（V0 单动作列，运行时不读） | `zzzz20260413120000_create_automation_rules.ts:31,32` |
| Q5/Q6 | `multitable_webhooks.url/active/created_by` | 同 Q1 |
| Q7（SUPPLEMENTARY） | 同 Q2/Q5 | 同上；内网字面量正则逐字取自 `webhook-service-ssrf-guard-design-20260912.md`（`origin/fix/webhook-service-ssrf-guard`）对应查询块 |
| 全文 `WEBHOOK_TARGET_REJECTED:scheme-not-allowed` 引用 | — | 直接 `gh pr view 5619 --json body` 读取 PR 描述原文确认拼写（非猜测；PR 状态 `OPEN`，头分支 `fix/automation-webhook-ssrf-guard`），`gh pr view 5649` 同样确认（头分支 `fix/webhook-service-ssrf-guard`，标题里写明"叠在 #5619 上"） |

## 3. `03-adm08-wildcard-permissions.sql`

| 查询 | 引用的表/列 | 迁移文件:行 |
|---|---|---|
| Q1/Q2 | `users.id/permissions`（jsonb，形状 A） | `packages/core-backend/src/db/migrations/zzzz20260119100000_create_users_table.ts:11,16`（`role` :15，`is_admin` :19，供 Q1 一并探测） |
| Q1/Q3 | `users.id/permissions`（text[]，形状 B） | `packages/core-backend/migrations/054_create_users_table.sql:5,10`（`role` :9） |
| Q4 | `user_permissions.user_id/permission_code` | `packages/core-backend/migrations/033_create_rbac_core.sql:43-45`（列名与 `packages/core-backend/src/db/migrations/20250924190000_create_rbac_tables.ts:54-57` 一致，仅类型 `text` vs `varchar(255)` 不同，不影响查询） |
| Q5 | `role_permissions.role_id/permission_code` | `033_create_rbac_core.sql:16-18`（同上，与 `20250924190000_create_rbac_tables.ts:74-77` 列名一致） |
| Q6 | `user_roles.user_id/role_id` JOIN `role_permissions` | `033_create_rbac_core.sql:34-36`（与 `20250924190000_create_rbac_tables.ts:34-37` 列名一致） |
| 全部 | `*:*` 判据来源 | `packages/core-backend/src/rbac/service.ts:61`（legacy 数组）、:44（`user_permissions` 直接匹配）、:47-54（经 `user_roles`/`role_permissions` 继承） |

## 4. `04-adm13-declared-admins.sql`

| 查询 | 引用的表/列 | 迁移文件:行 |
|---|---|---|
| Q1/Q2/Q3 | `users.id/role/is_admin/is_active` | `zzzz20260119100000_create_users_table.ts:11,15,17,19`；`is_admin` 在旧的 `054_create_users_table.sql` 里**不存在**（该文件只到 :14，只有 `id/email/name/password_hash/role/permissions/last_login_at/created_at/updated_at`），已在 Q1 之后写明 FALLBACK |
| Q1/Q2/Q3 | `user_roles.user_id/role_id` | `033_create_rbac_core.sql:34-36` |
| 判据来源（`isAdmin()` 只查 `user_roles`） | — | `packages/core-backend/src/rbac/service.ts:19-34`，具体 `:22` |
| 判据来源（`(is_admin OR role='admin')` 是仓库里其它地方的实际用法） | — | `packages/core-backend/src/services/approval-admin-capability.ts:71`、`packages/core-backend/src/services/approval-instance-readability.ts:259`、`packages/core-backend/src/services/ApprovalBridgeService.ts:258`、`packages/core-backend/src/services/approval-record-link-txn-auth.ts:571,608`、`packages/core-backend/src/routes/admin-users.ts:1171,1823`、`packages/core-backend/src/routes/api-tokens.ts:89`（`grep -rn "is_admin\b" packages/core-backend/src` 逐条核对，非全量列出，只取跨多个子系统的代表性样本） |

## 5. 表/列找不到依据、因而没写进任何 `.sql` 的东西

- `DataSourceManager.addDataSource/updateDataSource` 进程内写入口——不是表/列问题，是"这条
  路径不经过任何数据库表层面能观察到的守卫"，盘点 SQL 无法覆盖，`01-` 文件头注释里点了但没
  单独开查询。
- `connection.baseURL`/`connection.url` 里 URL userinfo 携带的口令——键名本身不是秘密形状
  （`baseURL`/`url` 都不在词表里），任何基于键名的 SQL 都结构性地看不到它，不是"没找到列"，
  是判据本身的已知边界（详见设计文档 §4）。
- `<resource>:*` 细粒度通配符（如 `spreadsheet:*`）——不在任务范围内（只要求 `*:*`），不是
  找不到列，是没有被要求盘它。
- TRG-04 的"3xx 重定向"盘点——不是表/列缺失，是这个属性根本不是存量数据的静态字段，两份
  来源设计文档都各自说明了这一点。

## 6. 复核返修（F3 / F4 / F5）— 2026-09-18 合成 PostgreSQL 实跑

**执行状态声明：仍未在生产库执行；生产执行需 owner 另行授权**（目标库、只读身份、窗口、
超时与输出预算）。本节全部结果来自**本机一次性合成 PostgreSQL 16.9**（便携二进制，临时
cluster，端口 55432），数据全是明显假值（`*.invalid` 主机、`FAKE-NOT-A-REAL-*` 占位），
跑完即 `DROP SCHEMA … CASCADE`。没有连接 222 或任何真实库。

复核报告：`artifacts/reviews/queue-closeout-20260916/review-and-decisions.md` §3 F3/F4/F5、§7.3。

### 6.1 F3 — HTTP 存量漏报

**根因**：`02-trg04-http-targets.sql` 旧版用 `actions::text ILIKE '%"url":"http://%'` 扫
`jsonb::text`。JSONB 不保留输入排版，回显成员一律是 `"url": "http://…"`（冒号后一个空格），
这个不含空格的模式因此**永远打不中正常存储的行**；它同时对键的大小写敏感，还会把"描述字段
里恰好写了 `"url":"http://`"这种文本当成命中。

**改法**：JSON 字段语义匹配。`jsonb_path_query(ar.actions, '$.**')` 遍历数组本身、每个 action
对象以及 `condition_branch` 的内层 `actions`；`jsonb_each_text` 取该节点的成员；命中条件是
**键名归一化后属于 url 类键名**（`url`/`webhookUrl`/`endpoint`/…）**且**其字符串值 `btrim`
后 `ILIKE 'http://%'`。不依赖任何渲染形式、空格、键序或大小写。`multitable_webhooks.url` 是
text 列，仍是直接前缀判定，但加了 `btrim`。

**正反例（合成新 schema，`fixture-modern.sql`）**：

| 例 | 行 | 形状 | 新谓词 | 旧文本谓词 |
|---|---|---|---|---|
| 正 | `r-top` | 顶层 action 的 `url: http://` | 命中 | 漏 |
| 正 | `r-nested` | `condition_branch` 内层 actions | 命中 | 漏 |
| 正 | `r-spaced` | 带空格排版写入 | 命中 | 漏 |
| 正 | `r-upper` | 键 `URL`、scheme `HTTP://` | 命中 | 漏 |
| 反 | `r-https` | `https://` | 不中 | 不中 |
| 反 | `r-https-upper` | `HTTPS://` | 不中 | 不中 |
| 反 | `r-decoy` | 普通文本字段里含 `"url":"http://…` 字面量 | 不中 | 不中（转义后也不匹配） |

实跑数字：新谓词 `http_rules = 4`，id 集合 `{r-nested, r-spaced, r-top, r-upper}`；
**旧谓词在同一批数据上得 0**——即旧版会把 4 条真实存量报成"零 HTTP 存量"。

### 6.2 F4 — ID 与计数集合不一致

**根因**：旧版 Q3/Q5 的行过滤是 `jsonb_typeof(config #> '{connection}') = 'object'`（只看形状），
与计数用的秘密键谓词不是一回事，普通连接因此进 ID 列表而不进计数。

**改法**：计数与 ID 共用同一个 `hit` CTE，且都用 `WHERE matched_top_level OR matched_headers`
过滤（形状 A / 形状 B 各一对，共 4 处，静态测试断言正好 4 处）。

**正反例**：`ds-clean`（有 connection 对象、零秘密键）既不进计数也不进 ID；`ds-top`（顶层
`password`）与 `ds-headers`（`headers.Authorization`）两者都进；`ds-noconn` 两者都不进。
实跑：`count = 2`，`|ids| = 2`，集合 `{ds-headers, ds-top}`；**旧的形状谓词在同一批数据上
返回 3 行**（多出 `ds-clean`），与计数不等。

### 6.3 F5 — 执行指引无可靠完成态

**根因**：README 同时教"整文件跑"、"遇错停止"、"别整文件跑、默认会继续"；Q1 只是探针不会
自动选互斥 schema 分支；`04` 的旧 schema 回退只提了 `is_admin`，漏了 Q3 选的 `is_active`
——恰好在它声称覆盖的那种库上会以 42703 中断。

**改法**：新增 `_preamble.sql`（每个文件 `\ir` 引入）统一执行契约——`\set ON_ERROR_STOP on`、
`SET default_transaction_read_only = on`、`statement_timeout=120s` / `lock_timeout=5s` /
`idle_in_transaction_session_timeout=30s`、`-v schema=` 时固定 `search_path`；探针结果经
`\gset` + `\if` **自动分派**兼容分支；每个文件最后一条语句输出
`INVENTORY_RESULT file=… status=complete|incomplete reason=…`。**没有这行 = 不完整**。

**两种 schema × 四个文件的实跑结果行**：

| 文件 | 新 schema（`fixture-modern.sql`） | 旧 schema（`fixture-legacy.sql`） |
|---|---|---|
| `01` | `status=complete shapes=A census=off(default)` | `status=complete shapes=B census=off(default)` |
| `02` | `status=complete scope=automation_rules+multitable_webhooks` | `status=incomplete reason=missing-column:automation_rules.actions scope=multitable_webhooks-only` |
| `03` | `status=complete shape=A(jsonb)` | `status=complete shape=B(text[])` |
| `04` | `status=complete predicate=is_admin-or-role` | `status=incomplete reason=missing-column:users.is_admin users.is_active note=role-only-lower-bound` |

旧 schema 上 `02` 的 `http_rules` 计数**根本不打印**（分支被跳过），而不是打印 0；`04` 打印的
是 `declared_admin_not_in_user_roles_role_only`（明确标注为下界），结果行同时给出
`note=role-only-lower-bound`。

**缺列 / 超时 / 权限不足 → incomplete 的证据**：

| 场景 | 制造方式 | 结果 |
|---|---|---|
| 缺列 | 旧 schema 没有 `automation_rules.actions` / `users.is_admin` / `users.is_active` | `status=incomplete reason=missing-column:…`，退出码 0，计数不打印或标注为下界 |
| 锁超时 | 并发会话 `LOCK TABLE data_sources IN ACCESS EXCLUSIVE MODE` 后跑 `01` | psql 退出码 3，stderr `ERROR: canceling statement due to lock timeout`，**没有任何 `INVENTORY_RESULT` 行** |
| 权限不足 | 新建无 `SELECT` 权限的角色跑 `01`（`information_schema` 按权限过滤，表对它不可见） | `status=incomplete reason=missing-table:data_sources`，**不打印任何计数**，不会伪装成零命中 |

### 6.4 变异探针（去掉修复 → 测试红）

在 scratchpad 的**副本**上做（仓库树未改动），跑
`node --test verify/readonly-inventory-pack.test.mjs`：

| 变异 | 结果 |
|---|---|
| 把 `02` 的语义谓词换回 `actions::text ILIKE '%"url":"http://%'` | 2 红：静态契约测试 + 合成库测试（`actual: []` vs 期望 4 条 id） |
| 把 `01` 的 ID 过滤从 `WHERE matched_top_level OR matched_headers` 换成 `WHERE true` | 2 红：静态计数 3≠4 + id 集合出现 `ds-clean`、`ds-noconn` |
| 把 `04` 的 `incomplete` 文案改成 `complete`，并把前言 `ON_ERROR_STOP on` 改成 `off` | 2 红：前言契约测试 + 旧 schema 结果行断言 |

### 6.5 验证件与建议接线

- 一次性脚本：`scripts/ops/readonly-inventory-20260916/verify/run-verify.mjs`
  （建临时 schema → 灌合成数据 → 按 runbook 的唯一方式跑四个文件 → 断言 → `DROP SCHEMA`）。
- 自动化：`scripts/ops/readonly-inventory-20260916/verify/readonly-inventory-pack.test.mjs`
  （`node --test`；第一层静态契约无需数据库，第二层 `DATABASE_URL` 门控）。
- **建议接线泳道**：仿
  `.github/workflows/approval-s1-evidence-replay-gate-realdb.yml` 新开一条小泳道——
  `services: postgres:16` + `METASHEET_REAL_DB_TEST_STEP=1`，只装 Node、不走
  `plugin-tests.yml` 的依赖链（本测试只用 Node 内置模块 + runner 自带 `psql`），
  路径过滤 `scripts/ops/readonly-inventory-20260916/**`。**本轮没有改 `.github/workflows/**`**，
  接线留给协调方。

### 6.6 本轮明确没做的事

- 没有在任何真实数据库（含 222）上执行本包的任何一条语句。
- 没有改 `.github/`、`packages/`、`plugins/` 下任何文件。
- 没有为 `connection.url` 的 userinfo 口令、`<resource>:*` 细粒度通配符等 §5 已列的已知盲区
  新增查询——返修只针对 F3/F4/F5。
