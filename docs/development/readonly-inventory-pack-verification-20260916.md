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
