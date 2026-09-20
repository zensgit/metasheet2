# 只读盘点包（CRED-06 / TRG-04 / ADM-08 / ADM-13）设计（2026-09-16）

- 任务：W5-I，只产出只读 SQL + runbook，交给用户自己上 222 跑；本代理**没有连接过任何数据库、
  没有碰过 222**。
- worktree：`../metasheet-wt-w5i`（`git worktree add ../metasheet-wt-w5i -b
  ops/readonly-inventory-pack-20260916 origin/main`），HEAD 基于 `origin/main` 的
  `38caaf17b`（"docs: 第六次 24h 自主开发记录…"）。
- 产出：`scripts/ops/readonly-inventory-20260916/`（四个 `.sql` + `README.md`）+ 本设计文档 +
  配套验证文档 `readonly-inventory-pack-verification-20260916.md`。
- 边界：不连数据库、不碰 222、不进其它 worktree；只新增文件，不改任何既有代码/迁移；
  values-free（SQL 只返回计数/id，注释不含真实主机名/账号/密钥）。

## 1. 为什么是四份独立文件，而不是一份

四条待解锁工作分别绑定四张互不相关的表（`data_sources` / `automation_rules` +
`multitable_webhooks` / `users` + 三张 RBAC 表），彼此没有共享 schema 依赖，合成一份文件除了
方便"一口气跑完"之外没有别的好处，却会让某一段的语法错误挡住其它三段（`psql -f` 默认不是
`ON_ERROR_STOP`，但一份文件里出了错仍然更难定位）。拆开还有一个直接原因：CRED-06/TRG-04 两条
的 SQL 直接源自两组尚未合并分支里已经写好的设计文档（见下），保持"一个来源、一份文件"能让
将来这两条分支合并时更容易比对这份盘点包和它们各自设计文档里那份 SQL 是否还一致。

## 2. 四段盘点各自解锁什么、为什么 values-free

### CRED-06 → 解锁 PR #5648 / #5681

`data_sources.config->'connection'`（现役 app 代码读写的形状，简称"形状 A"）或
`data_sources.connection`（更早、仅存在于原始 SQL 迁移里的形状，简称"形状 B"，两套 DDL 都带
`IF NOT EXISTS`，谁先跑谁生效）里，可能存着形似口令的键名（`password` / `token` / `apiKey` /
`pass`（限定词+）/ `pw`（限定词+）……），明文落库且曾被 `GET /api/data-sources/:id` 回显。
这条判据 —— 哪些键名算"秘密形状" —— 的**唯一权威定义**是
`packages/core-backend/src/data-adapters/data-source-secret-keys.ts` 这个模块，但它**目前不在
`main` 上**，只存在于两支尚未合并的分支：

- `origin/fix/data-source-secret-keys-vocab-nfkc`（PR #5648 的头分支）
- `origin/test/secret-keys-realdb-inventory-sync`（PR #5681 的头分支，与上面内容一致）

本任务的指令明确要求"以这两支分支里的词表/盘点 SQL 为准"，所以这份盘点包的 SQL 不是从
`main` 上的代码推导出来的，而是**从这两支分支 `git show` 出来的模块源码和设计文档手工转写**
的——这是 CRED-06 这一段与其它三段最大的不同点，写进这里是为了让后续读这份盘点包的人不会
误以为词表也来自 `main`。

**values-free 的理由**：口令值一旦被 `SELECT` 出来，这份盘点包本身就成了新的泄漏面（它会被
粘贴进工单、聊天记录、终端 scrollback）。CRED-06 只需要回答"要不要清理、清理动到多少行"这两
个问题，两个问题都只需要**计数**和**主键 id**——不需要看任何值。键名（不是键值）在这份文件
里被当作可以出现的东西：键名是配置者自己起的标识符（例如 `dbPassword`），不是秘密本身；这个
立场和已有设计文档（`data-source-connection-secret-keys-design-20260912.md` §5 的"键普查"
查询）完全一致，本文件的 Q6/Q7（键名普查）沿用了同样的边界，并在 SQL 注释里明确标成
"SUPPLEMENTARY"，允许运维按更严格的口径直接跳过它们。

**两种列形状**：详见上面"形状 A / 形状 B"，`01-cred06-secret-keys.sql` 的 Q1 是强制的列探针，
必须先跑。**两种嵌套**：顶层 `connection.<key>` 和嵌套 `connection.headers.<key>`——后者是
`data-source-connection-secret-keys-design-20260912.md` §1 反例 2 指出的"运行时可能是在用凭证"
的位置（`PLMAdapter` 会把自己签发的 Bearer 写回这个位置），所以 `01-cred06-secret-keys.sql`
的 id 级查询（Q3/Q5）把"顶层命中"和"嵌套命中"拆成两个独立的布尔列，方便后续迁移工单据此
分两步处理（顶层可以直接清、嵌套要先和 owner 约定重新签发窗口——这是设计文档自己的结论，本
盘点包只是让这个区分在 SQL 层面就可见，不代为决定要不要清）。

### TRG-04 → 解锁 PR #5619 / #5649

`automation_rules.actions`（规则驱动的 `send_webhook` 动作，运行时实际读取的列——见下方"字段
形状确认"）和 `multitable_webhooks.url`（webhook 订阅的目标地址，直接的 `text` 列，不是
JSON）里，现存多少条 `http://`（非 https）目标。这两条 PR 各自给同一个 EventBus 的两个出口
（规则驱动 vs 订阅投递）接上 SSRF 守卫，合并后**任何**现存的 `http://` 目标都会从"能送达"
变成以 `WEBHOOK_TARGET_REJECTED:scheme-not-allowed`（PR #5619 描述原话，通过 `gh pr view 5619`
直接读取确认；见下）终态失败——这是两条 PR 自己在描述里点名的"会打断现网"的行为变化，且
各自的设计文档都已经写好了"给 owner 的合并前盘点步骤"、只是从未在真库跑过。本文件把那两段
SQL 原样吸收进来，并加上了 CRED-06/TRG-04 任务要求但设计文档原版没有的 **id 列**（原版设计
文档的盘点 SQL 只给了 `count(*)` 和按 `sheet_id`/`created_by` 分组的计数，没有给出具体
`id`）。

字段形状确认（为什么主查询用 `automation_rules.actions`）：`action_config` 是
`automation_rules` 表最早的单动作列（`zzzz20260413120000_create_automation_rules.ts:32`），
后来被 V1 多动作数组列 `actions`（`zzzz20260414100000_extend_automation_rules.ts:27`）取代——
`packages/core-backend/src/multitable/automation-executor.ts` 里的读取点全是 `rule.actions`
（十余处，例如 `:1734`/`:1846`/`:1992`），所以 TRG-04 的主查询（`02-trg04-http-targets.sql`
Q2/Q3）扫的是 `actions`；`action_config` 作为 SUPPLEMENTARY 的 Q4 保留。

> **2026-09-20 更正（F6）**：本节原文写的是"零处非注释地读取 `action_config`……即使有，运行时
> 也不会读到它"。这句**是错的**，按纪律给行号：`toExecutorRule` 在
> `packages/core-backend/src/multitable/automation-service.ts:1187-1190` 有一条回退——
> `rule.actions` 为 NULL 或空数组时，执行器跑的就是
> `[{ type: rule.action_type, config: rule.action_config }]`，随后同样在
> `automation-executor.ts:4199` 读 `config.url`。所以 Q4 不是"理论上的陈列品"，它是那批行的
> **实际**出网目标来源；`02-trg04-http-targets.sql` 的 Q4 注释已同步更正。

**values-free**：两条设计文档都明说这些 URL"can carry credentials"（userinfo、query string
里的 token），所以 `02-trg04-http-targets.sql` 全文没有一处 `SELECT actions` / `SELECT url`。
scheme 判定本身也不需要把 JSON 读出来展示——URL 值只出现在 `WHERE` / `EXISTS` 的过滤条件里，
最终 `SELECT` 列表只有 `count(*)`、`id`、`sheet_id`、`created_by`、`active`，以及 F6 之后新增
的两个布尔量 `narrow_hit`/`upper_bound_hit`（它们是判定结果，不是值）。

### ADM-08 → 喂 ADM-07 裁决

`users.permissions`（两种列形状：`jsonb` 数组 / `text[]`，同样是两套 `IF NOT EXISTS` DDL 谁先
跑谁生效）、`user_permissions`、`role_permissions`（含经 `user_roles` 继承）里，有多少行/多少
用户持有字面量 `*:*`。这条盘点的依据是 `packages/core-backend/src/rbac/service.ts`
`userHasPermission()`（:36-72）和 `listUserPermissions()`（:74-111）——它们逐字给出了
`*:*` 在这套 RBAC 里能从哪三条路径生效：直接 `user_permissions` 行、经 `user_roles` 继承的
`role_permissions` 行、legacy `users.permissions` 数组里的字面量 `'*:*'`。`ADM-08` 不判断该
不该有 `*:*`，只回答"现在有多少、在谁身上"，留给 ADM-07 裁决。

**values-free**：`*:*` 本身是一个权限**码**（固定、公开的字符串，属于系统词汇表而不是用户
数据），把它写进 WHERE 条件或 SELECT 列表不算泄漏；真正需要避免暴露的是**哪些资源**被通配
到（如果系统里还有其它更细粒度的通配符如 `spreadsheet:*`），但 ADM-08 只要 `*:*` 这一个
最高权限的字面量，所以没有这个顾虑。

### ADM-13（盘点段）→ 解锁 PR #5665 / #5677，只盘点不回填

有多少用户满足**声明式 admin 字段**（`users.is_admin = TRUE` 或 `users.role = 'admin'`），但
在 `user_roles` 里没有 `('<id>', 'admin')` 这一行。"声明式 admin 字段"这个说法不是本代理
自己定的，是从两处代码事实推出来的：

1. `packages/core-backend/src/rbac/service.ts` 的 `isAdmin()`（:19-34）**只**查
   `user_roles`，完全不看 `users.role` / `users.is_admin`；
2. 但仓库里至少十几个别的调用点——`services/approval-admin-capability.ts:71`、
   `services/approval-instance-readability.ts:259`、`services/ApprovalBridgeService.ts:258`、
   `services/approval-record-link-txn-auth.ts:571,608`、`routes/admin-users.ts:1171,1823`、
   `routes/api-tokens.ts:89`——统一用 `(is_admin = TRUE OR role = 'admin')` 判定"这是不是一个
   管理员"，和 `user_roles` 完全独立。

这两件事合起来就是 ADM-13 要盘点的缺口：一批用户被"仓库里大多数地方"当作管理员，却不会被
`rbac/service.ts` 的 `isAdmin()`（进而不会被任何只信任 `user_roles` 的权限解析路径，比如
`role_permissions` 的继承链）当作管理员。**本文件只数、只列 id，不写任何
`INSERT INTO user_roles`**——要不要把这批人补进 `user_roles`，还是反过来去掉他们的
`is_admin`/`role='admin'`，是 PR #5665/#5677 的裁决范围，明确不在这次任务里。

**values-free**：只 `SELECT id / role / is_admin / is_active`，`role` 是一个很小的固定枚举
（`'user'`/`'admin'`/…），不是密钥也不是 PII；没有 `email`/`name`/`password_hash`。

## 3. 列名/表名怎么核对的（概述，逐条见验证文档）

每一处表名/列名都要求"必须在 `packages/core-backend/migrations` 或
`packages/core-backend/src/db/migrations` 里实读到，注释引用迁移文件名"——四份 `.sql`
文件顶部注释和每条查询的行内注释都直接写了具体的迁移文件路径 + 行号，是从这个 worktree
（`origin/main` HEAD）里 `grep -n` 出来的实际行号，不是凭记忆写的。核对过程和结果的完整表格见
`readonly-inventory-pack-verification-20260916.md`。

CRED-06 是唯一的例外——它引用的 `data-source-secret-keys.ts` 本身不在 `main` 上，只能引用它
在两支来源分支上的路径（该文件在两支分支上内容一致，行号也一致），这一点在
`01-cred06-secret-keys.sql` 的头注释和上面 §2 里都写清楚了，不藏着。

## 4. 明确没写进去的东西（找不到依据、因而没写）

- **CRED-06 的去键 UPDATE 语句**：`data-source-connection-secret-keys-design-20260912.md` §5
  已经给出了完整的迁移 UPDATE（顶层 + 嵌套两步、两种列形状），但那是**写**语句，不属于"只读
  盘点包"的范围，任务边界也没有要求本文件产出它——本文件只把它在 README §4 里点名指路，不
  重复抄一遍写语句。
- **TRG-04 的 3xx-重定向盘点**：两条设计文档都各自说明"是否会跟随重定向"这件事从存量数据里
  看不出来（不是"是否 `http://`"这种存在列上的静态属性），所以没有对应的只读查询可写——两份
  设计文档原文都明说了这一点，本文件继承同样的结论，不是遗漏。
- **`connection.baseURL`/`connection.url` 里 URL userinfo 携带的口令**（CRED-06 设计文档 F01
  后续单指出的已知盲区）：任何一条 SQL 都看不见它，键名是 `baseURL`/`url`，不是秘密形状的
  键名。这不是"表/列找不到"，是判据本身的已知局限，写在 `01-cred06-secret-keys.sql` 的头
  注释里提醒，不假装盘点覆盖了它。
- **`role_permissions`/`user_permissions` 里 `<resource>:*` 这种细粒度通配符**（不是
  `*:*`）：任务明确只要求 `*:*`，没有把 `spreadsheet:*` 这类资源级通配符纳入范围，本文件
  没有额外去猜 ADM-07 是否也想要这个数字。

## 复核返修（F3 / F4 / F5）— 2026-09-18 设计变更

> **仍未在生产库执行；生产执行需 owner 另行授权。** 本轮只做开发侧修正与合成库验证。

三处设计变更（逐条根因、改法、正反例与两种 schema 的结果表见
`readonly-inventory-pack-verification-20260916.md` §6）：

1. **HTTP 判据从文本扫描改为 JSON 语义匹配（F3）**。原设计沿用两份来源设计文档里的
   `actions::text ILIKE '%"url":"http://%'`。这在 PostgreSQL 上是错的：JSONB 不保留输入排版，
   回显成员是 `"url": "http://…"`，不含空格的模式打不中正常行（合成库实测：4 条真实 `http://`
   存量被旧谓词报成 0）。新判据是 `jsonb_path_query(actions,'$.**')` + `jsonb_each_text`，
   按**键名语义 + 字符串值 scheme** 判定，覆盖顶层与嵌套两种位置，且对排版/大小写免疫。
   影响：TRG-04 的零计数在返修前**不能**用来批准 https-only 收紧。

2. **计数与 ID 共享同一命中谓词（F4）**。CRED-06 的两对查询（形状 A / 形状 B）各自抽出一个
   `hit` CTE，计数与 ID 都用 `WHERE matched_top_level OR matched_headers`。设计上的不变量：
   `|受影响 ID| == 计数`，由 `verify/run-verify.mjs` 断言。返修前的 ID 列表混入了零命中的普通
   连接，**不能直接驱动清理**。

3. **执行契约下沉到 `_preamble.sql`（F5）**。新增共享前言：唯一执行方式（整文件 `psql -f`）、
   `ON_ERROR_STOP on`、会话级 `default_transaction_read_only`、statement/lock/idle 超时、
   `-v schema=` 固定 `search_path`。schema 探针不再只是"给人看"，而是 `\gset` + `\if`
   **自动分派**互斥分支（含 `04` 旧 schema 下 `is_admin` 与 `is_active` 两个缺列的组合）。
   每个文件末尾输出 `INVENTORY_RESULT … status=complete|incomplete reason=…`：缺列、超时、
   截断一律 `incomplete`，**没有该行即视为不完整**，任何一种都不得解读为零命中。
   键名普查（`01` 的 Q6/Q7）改为 `-v census=1` 显式开启，默认不跑也不外传。

## 复核返修（F6）— 2026-09-20 设计变更：TRG-04 的 HTTP 目标白名单收窄

> **仍未在生产库执行；生产执行需 owner 另行授权。** 本轮同样只做开发侧修正与合成库验证。

F3 把判据从文本扫描换成 JSON 语义匹配，方向对，但那一版的"语义"有两处比实际读取面宽，
方向都是**高报**——而 TRG-04 的这个数字是 owner 用来判断"能不能合 #5619 / #5649、会不会打断
现网"的输入，高报比低报更容易把一次本可以直接合的收紧拖成"先去清存量"。

### F6-1 键名白名单：7 个名字里只有 1 个会被读

原白名单（归一化后）：`url` / `weburl` / `webhookurl` / `endpoint` / `endpointurl` /
`targeturl` / `callbackurl`。逐个核对这两张表的取值路径：

- `url` —— **唯一真读**。规则侧 `executeSendWebhook` 只读 `config.url`
  （`packages/core-backend/src/multitable/automation-executor.ts:4199`，派发点 `:2591`，
  模拟路径同一成员 `:1012`），类型契约 `SendWebhookConfig { url, method?, headers?, body?,
  secret? }` 在 `packages/core-backend/src/multitable/automation-actions.ts:144-151`；前端编辑器
  只写这一个成员（`apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:504` 的
  `v-model="action.config.url"`，回填在 `:3801`）。订阅侧读的是 `url` **列**
  （`packages/core-backend/src/multitable/webhook-service.ts:394`）。
- `webUrl` / `endpointUrl` / `targetUrl` / `callbackUrl`（含下划线写法）—— 对
  `packages/` `apps/` `plugins/` 全仓 grep **零命中**，不存在任何写入方或读取方。
- `endpoint` —— `packages/core-backend/src/multitable/` 下零命中；全仓其它命中都是 HTTP 路由
  路径一类的用法，不是这两张表里的取值键。
- `webhookUrl` / `webhook_url` —— 确实存在，但**不在这两张表里**：一是钉钉机器人目标列
  `dingtalk_group_destinations.webhook_url`（密文存储，且
  `packages/core-backend/src/integrations/dingtalk/robot.ts:33-55` 强制 https + 固定 host +
  必带 access_token，**结构上装不下 `http://` 目标**），二是创建 `multitable_webhooks` 行的
  HTTP 请求体字段（`packages/core-backend/src/routes/api-tokens.ts:55`）——落库后的列名就是
  `url`，Q5/Q6 已经直接读它。

结论：白名单收敛到 `url` 一个键，且键名匹配改为**大小写敏感**——`config.url` 是 JavaScript
属性读取，存成 `"URL"` 的成员执行器根本读不到（这种规则今天就以 `Webhook URL is required`
失败，与守卫无关）。值上的 scheme 判定保持大小写不敏感（URL scheme 本就大小写不敏感）。

### F6-2 `$.**` 递归：假阳性的来源

`jsonb_path_query(actions, '$.**')` 会走到 `config` 下的每一个节点，其中包括
`send_webhook` 动作里**用户自撰的 `body` 与 `headers`**。`body` 的去向是被
`JSON.stringify` 后 POST 给 `config.url`（`automation-executor.ts:4205-4216`）——它是给
**接收方**用的载荷，不是本进程会去拨的地址，#5619/#5649 的守卫也不会拒它。所以
`body.callbackUrl = "http://…"` 这种再正常不过的回调约定，会被旧判据算成一条"http 出网目标"。

收窄后只匹配执行器真正解引用的 jsonpath：

```
$[*].config.url
$[*].config.branches[*].actions[*].config.url
$[*].config.defaultBranch.actions[*].config.url
```

**一层嵌套就是全部**，不是省略：`condition_branch` 读 `config.branches[*].actions`
（`automation-executor.ts:2348`、`:2378`）和 `config.defaultBranch.actions`（`:2342`、
`:2372-2373`）；`parallel_branch` 读 `config.branches[*].actions`（`:2247`）；保存期校验
拒绝分支内再嵌分支（`packages/core-backend/src/multitable/automation-service.ts:874`、`:877`
对 `branches`，`:902`、`:905` 对 `defaultBranch`），因此不存在第三层。旧列 `action_config`
同一套路径上移一层（`$.url`、`$.branches[*].actions[*].config.url`、
`$.defaultBranch.actions[*].config.url`），并按 `action_type` 决定用哪一组——因为那一列就是
那条规则的 `config` 本身。

### F6-3 不丢信息：宽口径降级为并排输出的"参考上界"

收窄只改**默认解读**，不删数字。每个收窄了的查询都保留原 `$.**` + 7 键逻辑，作为显式标注的
上界列并排输出（`http_rules_upper_bound`、`http_rules_legacy_column_upper_bound`、
`internal_target_rows_upper_bound`），Q3 的每一行同时带 `narrow_hit` 与 `upper_bound_hit`。
窄口径恒 ⊆ 上界（`url` 本来就在旧键表里，窄路径也是 `$.**` 所走节点的子集），所以
**上界 − 窄口径 = "长得像 http 目标、但没有任何代码会读它"**，owner 想单独看这批行，Q3 里有 id。

`multitable_webhooks` 侧（Q5/Q6）没有上界孪生列，因为那里的出网目标是一个专用 `text` 列，
既没有键名要猜也没有 JSON 要递归——它本来就是窄的。

### F6-4 F4 纪律不退化

Q2（计数）与 Q3（id）的 `hit` CTE 逐字符相同，Q3 用同一组布尔量过滤
（`WHERE narrow_hit OR upper_bound_hit`）。两条不变量因此可断言，并且确实被断言：
`count(Q3 rows WHERE narrow_hit) == Q2.http_rules`、`count(Q3 rows) == Q2.http_rules_upper_bound`。
静态层还额外断言 Q2/Q3 的 CTE 文本相等，防止后人只改一处。

正反例、两种 schema 的实跑数字与三个变异探针见
`readonly-inventory-http-target-allowlist-narrow-verification-20260920.md`。
