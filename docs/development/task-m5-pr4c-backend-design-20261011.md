# 任务功能 M5 后端 PR-4c 设计：投影、夹钳、撤权读路径与 CSV 导出（DRAFT，2026-10-11）

> **状态：DRAFT（v1）。** owner 2026-10-10 裁定开始 M5：先冻结 PR-4a 的表结构与接口，再在其上并行起草 PR-4b、PR-4c 与前端；只开 Draft，不合并、不应用 DDL。本文是 PR-4c 的后端设计，以 PR-4a 冻结稿 v4（Draft PR #6332，分支 `claude/tasks-m5-pr4a`，head `cdf7ddba87`，文件 `docs/development/task-m5-pr4a-backend-design-20261010.md`）为准：**PR-4c 不带 DDL**，只用 PR-4a 迁移里的表与它冻结的路由；凡需要动那份冻结的地方都写成问题（§9.3），本文不自行改动。本文不授权合并、DDL 应用、staging 部署或打开任何 `TASKS_*` 开关。
>
> **第 1 轮修订（DRAFT v2，2026-10-12）**：一次独立审阅的 26 条处置见 §10。本次只追加文本，正文原句不改写；被修订之处后面加一行「第 1 轮修订」指针，**正文与 §10 不一致时以 §10 为准**。PR-4a 冻结稿现以 head `7f1c4c536f` 为准（替代上句的 `cdf7ddba87`；本文依赖的各节在两个 head 上逐字相同，§10.2 R1）。

- **基线**：`origin/main` `906840c74c`（2026-10-11）。PR-4a 冻结稿 v4 的基线 `a1c0972918` 到它之间，后端只改了 `directory/directory-sync.ts`、`integrations/dingtalk/transport.ts`、`routes/auth.ts`、`routes/data-sources.ts` 四个文件；本文引用的任务域文件与多维表文件在两个提交上逐行相同。本文的代码行号都指 `906840c74c`；PR-4a 尚未实现，引用的是它冻结的名字；#6249 的文件按 head `39a2a29be9` 引用。实现开工时按当时 main 再核一次（owner 2026-10-09 六项之第 6 项）。
- **依赖**：#6249（任务 E 纯函数层：`task-projection.ts`、`task-export.ts` 与它们用到的 `task-fields.ts`）；PR-4a（M5 迁移里的 `task_record_projection` 与字段三表、锁序包装器 `withTaskLockOrder`、字段与依赖服务、`TASK_ID_PREFIXES.field`）；main 上的 M4（清单、分组、PR-3b 的 `TaskScheduler`、PR-3c 的红点信号与写入点普查）。合并顺序 #6249 → PR-4a → {PR-4b, PR-4c}（PR-4a §7.3），每张都要 owner 单独点名合并（锁 §14-5）。
- **锁**：`docs/development/task-feature-design-lock-20260917.md`（main 版）：§6.4 锁序、§7 投影边界、§9 里 §13-11、门 19 投影端、`SYSTEM_SHEET_KINDS` 三行、§12 门 7 / 9 / 10 / 19。
- **裁定的引用口径**：同 PR-4a 头部，只写条目编号与日期。S01–S37 于 owner 2026-10-09 裁定取推荐值；D 编号是同一批 M5 条目附带的缺省实现约束，**没有被点名**，本文用到时一律写成「D<n>，`ASSUMPTION`」（§9.2 末条汇总）。条目原文是私有件，本文不引。
- **标签**：本文自选的取舍标 `ASSUMPTION(task-m5c): [c-NN]`，每一条在 §9.1 有缺省值与备选；任务 E 的未决偏离与问题在 §9.2；需要 owner 单独回答的列在 §9.3。

---

## 0. 结论摘要

1. **范围出自 PR-4a 自己的划分**（§1.1）：投影的 provisioning、reconcile、夹钳、deny sibling、sweep 与导出，以及 PR-4a §6.1 留给本 PR 的门格——`M5|7|src/multitable/task-*`、`M5|7|锁序控件` 的 fence 步、`M5|9|整门`、`M5|10|P2子集` 的 recordId 格、`M5|19|投影端`——和候选门 31（M5-e 夹钳）、32（M5-f 导出）。
2. **不加 DDL**：只用 `task_record_projection`（PR-4a §2.9）与既有的 `meta_*` 表。`meta_sheets.system_kind` 是没有 CHECK 的 text 列，盖 `'task_projection'` 不需要迁移；需要的是两处 kind 数组与盖章准入（§2、§4.7）。
3. **新路由 4 条**，挂在 `tasksRouter()` 上、受新开关 `TASKS_PROJECTION_ENABLED`（S30 ①）控制：开启投影（POST）、读投影状态（GET）、交互回写（POST，门 10 recordId 格在服务端的产生处）、清单 CSV 导出（GET，门 32）（§3）。
4. **多维表侧**：「是不是任务投影 sheet」只看 id 形状（任务 E 的两条候选正则；客户端建 base、建 sheet 时拒绝这两种形状）；四个能力解析器都经任务夹钳（S01，管理员不例外）；列表闸与评论收件箱把任务判定放在管理员捷径之前；行级读的四个入口接 deny sibling（S02 的成员臂与逐行臂；§13-11 (a)：失败一律抛出）；记录写入口按 kind 显式拒绝，与能力无关（§4）。
5. **一致性**：写入点在提交之后把受影响的范围交给一个进程内运行器（同步、不发语句、不含 `catch` 的注册钩子，PR-3c 普查的规则一条不改）；运行器按 pair 逐个事务对账（fence → 投影锁，从不取结构锁）；`TaskScheduler` 提交后作业里的 sweep 做全覆盖兜底。成员、租户、软删、移出、归档全在读时判定，所以对账的快慢只影响内容新旧，不改变任何人能读到的范围（§6）。
6. **导出**：数据取自任务表（SoR），不取投影记录；每一格（含表头）经共享 helper `sanitizeCsvCell`，这是 S10 的已裁取值。任务 E 对数值格的例外（X2）作为问题保留，缺省按已裁取值，需要改任务 E 一行（§7、§9.2）。
7. **仍待 owner 的**：自选 34 项（§9.1）；任务 E 的 X1、X2 与导出时区（§9.2）；问题 Q1–Q9（§9.3），其中两项涉及 PR-4a（Q6 映射表的巡检索引；Q7 包装器实例的交法与派生新一期 id 的返回），都是问题，不是已定值；候选门行写进锁的那次修订沿用 PR-4a §7.3 的问题（§9.4）。
8. **第 1 轮修订（§10）**：自选仍是 34 项，其中 6 项的缺省或出处有变（§10.3）；owner 问题增为 Q1–Q12（新增 Q10–Q12 是对已裁 S04、S06、S07 取值的偏离与读法，§10.4）；`GET /context` 在候选形 sheet 上按任务夹钳拒绝，评论写入口按 kind 拒绝，逐行臂对管理员同样生效（缺省，Q8），取 pair 锁之前先取清单哨兵键（§10.2 R2–R6）。

---

## 1. 范围与切片

### 1.1 范围的出处（PR-4a 冻结稿 v4 原文所指）

| PR-4a 位置 | 留给 PR-4c 的内容 |
|---|---|
| §1.2 | 投影的 provisioning、reconcile、夹钳、deny sibling、sweep、导出；映射表已在 PR-4a 的迁移里 |
| §2.9 | `task_record_projection` 的读写：主键 `(list_id, task_id)`、无外键、无 `org_id`；sheet id 与记录 id 由任务 E 推导、不存列；清单是否开启投影按 S04 由投影 sheet 是否存在推导、不存列；PR-4c 不加列 |
| §3.5 `[a-38]`、§6.2 M5-d | 选项 id 已不在定义里的格投影为空；选项改名后投影显示新 label（PR-4a 明写这一格归 PR-4c） |
| §4.2 | 锁序包装器的 fence 步（rank 2）由 PR-4c 接入；投影锁（rank 3）今天没有调用者，PR-4c 接入时经包装器取 |
| §4.6 | 投影列 `isMilestone`、`dependencies`、自定义字段列的来源是 PR-4a 的列与表；对 PR-4a 形状的改动先改 PR-4a |
| §6.1 | `M5\|7\|src/multitable/task-*`、`M5\|9\|整门`、`M5\|19\|投影端`；`M5\|10\|P2子集` 里投影写回 `recordId` 一格；`M5\|7\|锁序控件` 的 fence 步（只在 `MULTITABLE_ENABLE_WRITER_FENCE=true` 的 lane 计入） |
| §6.2 末句、§7.3 | 候选 M5-e（夹钳，门 31）、M5-f（导出，门 32）；27–32 一次写进 `arm-set`、自检改 `range(1,33)` 的那次锁修订由 PR-4a §7.3 提问，本文不重开，§9.4 只列本文承载的行 |
| §7.2 | 任务 E §7 问题 2（导出时区）、偏离 X1（S05：混合清单里不带时刻的开始）、X2（S10 / D11：导出的数值格）只影响 PR-4c |

上表之外的内容，要么是本文的 `[c-NN]`，要么不在本 PR。

### 1.2 做

1. 多维表侧：`task_projection` kind 的登记与盖章准入；两种保留 id 的拒绝；能力夹钳；列表闸；行级撤权（deny sibling）与自定义列的读时遮罩；记录写入口的 kind 拒绝；既有守卫测试的登记（§4）。
2. 任务侧：4 条路由（§3）；provisioning、行对账、清单级 schema 步、进程内运行器、sweep（§6）；各写入点的提交后交接（§6.4）。
3. 开关 `TASKS_PROJECTION_ENABLED` 与 sweep 周期旋钮，同 PR 登记 manifest（门 18）。
4. 锁序包装器的 fence 步（§6.6）。
5. `src/multitable/task-*` 新文件，落进门 7 的扫描根。
6. 任务 E 的一行改动：`task-export.ts` 的 `exportCell`（X2 的缺省，§7.3）；若 #6249 先行修改则作废。

### 1.3 不做

- DDL、迁移、`permissions` 行。
- 前端 FE-e（清单页的开启投影、深链、导出按钮）与 FE-f（工作台拦截）；本文只定它们调用的接口（§3）。
- 附件（PR-4b）。PR-4b 与本文都要用 `TaskScheduler` 的提交后槽位，见 `[c-28]` 与 Q5。
- 关闭或删除投影（S04：M5 不提供）；cursor 分页（S34）；任务域 DML 普查闸（S37：不建，PR 正文如实声明）。
- 多维表的通用改动：本文只给 `task_projection` 加臂，不改任何其他 kind 的行为。

### 1.4 切片

| 切片 | 内容 | 依赖 | 回归 |
|---|---|---|---|
| **0** | kind 登记（两处数组）、盖章准入、保留 id 的拒绝（建 base、建 sheet、base 与 sheet 级路由）、开关谓词、manifest 两条 | PR-4a、#6249 | 多维表后端 lane；`stock-preparation-overview-host.test.ts`；manifest 测试 |
| 1 | 四个能力解析器的夹钳、列表闸与评论收件箱、记录写入口的 kind 拒绝、表单分享与公开表单的拒绝；夹具直发 SQL 造投影 sheet | 0 | 同上，加门 2 / 13 既有格 |
| 2 | deny sibling：`src/tasks` 的纯 SQL builder、`src/multitable/task-projection-access.ts` 的加载函数、四个读入口、自定义列遮罩、TS/SQL 对拍、门 9、门 19 投影端 | 1 | 多维表后端 lane |
| 3 | provisioning（POST / GET）、行对账、schema 步、运行器、写入点交接、sweep 与 `TaskScheduler` 的提交后作业列表、包装器 fence 步 | 2 | 全部 `M2\|`、`M3\|`、`M4\|` 行（写入点多了交接）；`M4\|25\|整门`（调度器形状）；PR-3c 普查单测 |
| 4 | 交互回写（门 10 recordId 格）、CSV 导出（门 32）、任务 E 一行 | 3 | `M4\|` 的 PATCH 与分组放置格；PR-4a 写取值格 |
| 5 | 收口：门 7 新根、M5-g 子集、真库三处登记、PR 正文 | 4 | 全部 |

守卫先于写者：切片 0–2 落地之前，生产码里没有任何路径会建出任务投影 sheet，测试夹具直发 SQL 造它；所以任何时刻都不存在一张没有守卫的投影 sheet。

---

## 2. 表：不加 DDL，怎样用冻结的表

### 2.1 `task_record_projection`（PR-4a §2.9）

| 列 | 本文的用法 |
|---|---|
| `(list_id, task_id)` | 一个已投影的 pair。行在 ⇔ 该 pair 的投影记录在：两者在同一事务里建、删（§6.3）。刚加入清单的任务在第一次对账前没有映射行 |
| `projected_version` | 最近一次对账时的 `tasks.version`；同一个值投进只读列 `taskVersion`（S06；D7，`ASSUMPTION`）；摘要相同时仍更新（S08；D9，`ASSUMPTION`） |
| `projected_digest` | `taskProjectionNoopDigest` 的输出；与本次算出的摘要相同 ⇒ 不写记录与链接（S08） |
| `last_projected_at` | 最近一次对账成功的时刻（含 no-op）；sweep 的轮转从最旧的开始 |
| `last_error` | 最近一次失败的固定码（`[c-30]`）；成功即清空 |
| `created_at` / `updated_at` | 建行与每次写行都取 `clock_timestamp()` |

本表不存「待对账」标记（`[c-01]`）。

### 2.2 多维表的表（既有，不改结构）

- `meta_bases`：每 org 一行 `deriveTaskProjectionBaseId(orgId)`（S03），`owner_id = TASK_PROJECTION_SYSTEM_OWNER`。表上没有 tenant 列；租户边界由 sheet 层（清单加会话租户）承担，base 每 org 一个是纵深防御（S03）。
  - 第 1 轮修订：`owner_id` = 系统 owner、`workspace_id` = `NULL`，照两处系统基座的先例（§10.2 R12）。
- `meta_sheets`：每个开启投影的清单一行 `deriveTaskProjectionSheetId(listId)`，`base_id` 为上一条，`system_kind = TASK_PROJECTION_SYSTEM_KIND`。该列由 `zzzz20260715180000_create_meta_history_trust_checkpoints.ts:122` 加入，没有 CHECK，所以新 kind 不需要迁移。
- `meta_fields`：列目录（`taskProjectionColumns`）每列一行，id = `deriveTaskProjectionFieldId(sheetId, key)`，`"order"` = 目录下标；隐藏用多维表既有的字段级 `property.hidden = true`。表上没有软删列。
- `meta_views`：三张视图，id 确定性推导（`[c-09]`），`config` 带 D7 的标记键（`ASSUMPTION`）。
- `meta_records`：每个已投影的 pair 一行，id = `deriveTaskProjectionRecordId(listId, taskId)`，`created_by` / `modified_by` = 系统 owner。
- `meta_links`：`dependencies` 列的链接行（S05 (a)）。

### 2.3 「不加 DDL」的后果（照实写出）

1. 没有队列表，也没有「待对账」列。受影响的范围只在进程内交接（§6.4）；跨实例、跨重启的兜底只有 sweep（§6.7）。
2. 陈旧不能从 `tasks.version` 看出来：S08 与 PR-4a `[a-10]` 之下，下面这些写都不动 `version`：增删负责人（状态没有翻转时）、清单项、分组、字段取值、依赖、里程碑。要知道一行是否陈旧，只能重算摘要来比。
3. 新的 pair 不在映射表里：sweep 要从「开启投影的清单 × `task_list_items`」里找出没有映射行的 pair（§6.7 第 2 段），不能只扫映射表。
4. 映射表只有主键与 `idx_trp_task (task_id)`：按 `last_projected_at` 的轮转要扫整张映射表。本文用每次运行的上限约束它；要不要给 PR-4a 的迁移加索引是 Q6，本文不定。
5. id 长度：清单 id 是 `tlst_` 加 32 位十六进制，所以 sheet id 恰为 50 个字符；字段 id、视图 id（`[c-09]`）、记录 id 都超过 50。多维表建 sheet、建视图、建字段的客户端 id 都限 50（`zod` 的 `.max(50)`），所以客户端能提交的 sheet id 恰好可以落在候选形里——建 sheet 路由必须显式拒绝（§4.6）——而字段、视图、记录的 id 都在客户端 id 空间之外。

---

## 3. 接口（任务侧）

### 3.0 共性（沿用 M2–M4 与 PR-4a §3.0）

- 新文件 `src/routes/tasks-projection.ts` 导出 `registerTaskProjectionRoutes`，由 `tasksRouter()`（`routes/tasks.ts:44`）在同一个 `router` 上调用一行。这一行只在 `isTaskProjectionEnabled()` 为真时执行（D20，`ASSUMPTION`），所以开关关时四条路由都是 404，与未挂载相同。文件名以 `tasks` 开头，落在门 7 的 `src/routes/tasks*` 扫描根内。
- 开关谓词 `isTaskProjectionEnabled(env)` 放在 `src/tasks/feature-flag.ts`：`isTasksEnabled(env) && env.TASKS_PROJECTION_ENABLED === 'true'`（精确字面量，S30 ①）。读点只有三处：路由注册这一行、服务启动时注册运行器（§6.4）、构造 sweep 作业（§6.7）。多维表侧的守卫**不读**它：开关关时，已存在的 sheet 照样只读、照样受行级 deny（D20，`ASSUMPTION`）。
- 每条路由 `authenticate` + `rbacGuard('tasks', 'read' | 'write')`；不用 `tasks:admin`。
- org 只取 `req.authenticatedTenantId`：写路由缺 org ⇒ 422 `ORG_MISSING`；四条路由的路径里都带清单 id，读路由按单对象读处理，缺 org ⇒ 404（PR-4a §3.0 的分类）。
- 清单与调用者的清单角色经 `buildTaskListByIdCondition`（`src/tasks/task-list-access.ts:54`；org 只经私有的 `taskListOrgClause`）读出；`owner` / `edit` 桥成 `editor`，`read` 桥成 `reader`（`toTaskListMemberships`，`src/tasks/task-lists.ts:79`）。
- 行级失败一律 404 `{ error: { code: 'NOT_FOUND' } }`，与清单不存在逐字节相同：不存在、他 org、不是成员、是成员但能力不够，都答这一个。
- 请求体与 query 的校验排在行级判定之后（PR-4a §3.0）。路径里不可打印的 id ⇒ 发 SQL 之前 404。
- 错误体只有 `{ error: { code } }`；未预期的错误答 500 `INTERNAL`（`routes/tasks-http.ts` 的 `sendError`）。

### 3.1 开启投影：`POST /api/task-lists/:id/projection`（S04）

| 项 | 冻结值 |
|---|---|
| 码 / 能力 | write；清单 `edit` / `owner`（S04） |
| 请求体 | 无（忽略） |
| 判定顺序 | 缺 org ⇒ 422 → 结构锁事务（`withOrgStructure`）里：清单取行（404）→ 调用者是 `edit` / `owner`（否则 404）→ 已归档 ⇒ 422 `LIST_ARCHIVED`（`[c-14]`）→ provisioning（§6.2）：base 或 sheet 的身份不符 ⇒ 409 `PROJECTION_IDENTITY_CONFLICT`（S03 的「复核不过即失败」；`[c-15]`）→ 提交 → 交接清单范围（§6.4） |
| 幂等 | 已开启时再调：返回同样的 id；补建缺失的视图；按当前绑定修正列目录；不改记录 |
| 成功体 | `{ listId, sheetId, viewIds: { grid, kanban, gantt }, pendingRows }`。`pendingRows` = 本清单未软删的任务项中还没有映射行的个数；行的投影在后台进行，本请求不等它（`[c-13]`） |
| 事件 | 不写（S05：开启投影没有事件词） |
| 错误 | 404；422 `ORG_MISSING`、`LIST_ARCHIVED`；409 `PROJECTION_IDENTITY_CONFLICT` |

> 第 1 轮修订：幂等分支同时把 sheet 名改成当前清单名（§10.2 R9）；`[c-13]` 怎样对应 S04 的取值、以及它为何是 Q10 的一部分，见 §10.2 R5。

### 3.2 读投影状态：`GET /api/task-lists/:id/projection`（S04）

| 项 | 冻结值 |
|---|---|
| 码 / 能力 | read；清单成员，角色不限 |
| 成功体 | `{ listId, enabled, sheetId, viewIds: { grid, kanban, gantt }, myRole, canManageViews, canEdit, pendingRows }`；未开启 ⇒ `enabled: false`、`sheetId: null`、三个视图 id 都是 `null`、`pendingRows: 0` |
| `enabled` | sheet 行存在、未删、`system_kind = 'task_projection'`、`base_id` 等于本清单 org 的派生 base id；任一不符 ⇒ `false`，并记一条固定码日志 |
| `myRole` | `'owner'`、`'edit'` 或 `'read'` |
| `canManageViews` / `canEdit` | `restrictTaskProjectionCapabilities` 与 `taskProjectionInteractionCanEdit` 给出的值：`editor` 且清单未归档（S01、S06、S36 (c)） |
| 视图 id | 按确定性 id 读（`[c-09]`）；不存在的那一张为 `null` |
| 副作用 | 无：本路由不写任何行。D7 写的是读时补建，本文不取（`[c-09]`）；补建在 POST 与 sweep 里做 |
| 错误 | 404 |

> 第 1 轮修订：读时补建出自已裁的 S04，不只是 D7。上表「视图 id」「副作用」两行以 §10.2 R5 为准：GET 发现缺视图即幂等补建，查找键仍是确定性 id（这一点是对 S04 的偏离，Q10）。

### 3.3 交互回写：`POST /api/task-lists/:id/projection/edits`（锁 §7；S06；D12、D21，`ASSUMPTION`）

> 第 1 轮修订：这条路由本身是本文的自选（`[c-16]`，Q4），不是已裁接口；S06 的闭集点名的写目标是任务路由（`PATCH /api/tasks/:id`、清单分组放置、字段取值），本路由只把记录 id 解析后委托给它们（§10.2 R12）。下文「成功体」一行的版本来源以 §10.2 R5 为准。

锁 §7 写的「写路径 422」与门 10 P2 子集里的 recordId 格，在服务端需要一个收到投影记录 id 的写路径；本路由就是它（`[c-16]`）。它只做解析与映射，然后委托给已有的任务服务；每个被委托的服务在自己的结构锁事务里重新鉴权（D21：记录 id 不是凭据）。

| 项 | 冻结值 |
|---|---|
| 码 / 能力 | write；清单 `edit` / `owner`，且清单未归档（S06、S36 (c)） |
| 请求体 | `{ recordId, fieldId, value, expectedVersion? }` |
| 判定顺序 | 缺 org ⇒ 422 → 清单取行（404）→ `editor`（404）→ 投影已开启（否则 404）→ 已归档 ⇒ 422 `LIST_ARCHIVED` → `recordId` 是字符串、`parseTaskProjectionRecordId` 解析成功、解出的 `listId` 等于路径 id（任一不成立 ⇒ 422 `INVALID_RECORD_ID`）→ `fieldId` 以本 sheet id 加 `__` 开头，剩下的键在可编辑集合里（否则 422 `UNSUPPORTED_EDIT`）→ 任务未软删且在本清单（否则 404）→ 值校验（见下）→ 委托 |
| 可编辑集合（S06 闭集） | `startDate`、`dueDate`（甘特单边改期）；`listGroup`（看板按清单分组列分组时）；类型为 `select` 的已绑定自定义字段（看板按它分组时）。其余列——`status`、`title`、`assignees`、`creator`、`completedAt`、`isMilestone`、`taskVersion`、`dependencies` 与其余自定义字段——都答 422 `UNSUPPORTED_EDIT` |
| 日期 | `value` 是 `YYYY-MM-DD`，或（`dateTime` 列时）ISO 时刻；时刻按任务自己的 `time_zone` 折成民用日期（`[c-19]`），格式不对 ⇒ 422 `INVALID_VALUE`。委托 `patchTask`：`{ startDate 或 dueDate, timeZone: 任务的 time_zone, expectedVersion }`，`due_time` / `start_time` 不动（D12，`ASSUMPTION`）。`expectedVersion` 必填，由 PATCH 自己判定：它的 422 `INVALID_VERSION` 与 409 `VERSION_CONFLICT` 原样返回 |
| 清单分组 | `value` 是分组名：本清单恰有一个同名分组 ⇒ 委托 M4 的 `placeTaskInListGroup`，放到组尾；没有 ⇒ 422 `INVALID_GROUP`；多于一个 ⇒ 422 `AMBIGUOUS_GROUP`（M4 的分组名不唯一，`[c-18]`） |
| 单选字段 | `value` 是选项 label：按忽略大小写的比较（与 `parseFieldDefinition` 判 label 重名同一口径）找到选项 id ⇒ 委托 PR-4a 的写取值服务；找不到 ⇒ 422 `NOT_IN_OPTIONS` |
| 版本 | 只有日期编辑比版本（经 PATCH）；分组与单选沿用它们自己的任务接口，不比版本（`[c-17]`） |
| 成功体 | `{ recordId, taskId, version }`，`version` 是写后的 `tasks.version`。响应不等对账，所以客户端下一次的 `expectedVersion` 取这个值，而不是投影里的 `taskVersion`；仍得到 409 时先刷新投影、再重试一次（S06） |
| 错误 | 404；422 `ORG_MISSING`、`LIST_ARCHIVED`、`INVALID_RECORD_ID`、`UNSUPPORTED_EDIT`、`INVALID_VALUE`、`INVALID_GROUP`、`AMBIGUOUS_GROUP`、`NOT_IN_OPTIONS`；被委托服务的码原样返回（含 409 `VERSION_CONFLICT`、422 `INVALID_VERSION`） |

前置判定在锁外读，委托在被委托服务自己的锁内执行。两者之间清单若被归档，委托照样成功：M4 的归档不改变任务的可编辑性，只是这次交互按 S36 (c) 本不该被提供；不影响任何人的读写范围。

### 3.4 CSV 导出：`GET /api/task-lists/:id/export?format=csv`（S10；D11，`ASSUMPTION`）

| 项 | 冻结值 |
|---|---|
| 码 / 能力 | read；清单成员，角色不限。D11 写的是清单 `view`，本文把它读成会话租户下的清单成员身份（`ASSUMPTION`） |
| query | `format`：缺省或 `csv` ⇒ CSV；其余 ⇒ 422 `UNSUPPORTED_FORMAT`（`parseTaskExportFormat` 的 reason 转大写）。不做 xlsx（S10） |
| 判定顺序 | 缺 org ⇒ 404 → 清单取行与成员身份（404）→ `format`（422）→ 行数超上限 ⇒ 422 `LIMIT`（`[c-21]`）→ 200 |
| 数据 | 取自任务表，不取 `meta_records`：一个 `READ ONLY`、`REPEATABLE READ` 事务（不取任何 advisory 锁），读出本清单未软删的任务项、负责人、同清单前置、分组名、绑定字段（不含 `hidden` 的绑定，`[c-10]`）与取值，经 `projectTaskRow` 得到各行，再交给 `buildTaskExportCsv`。与投影是否开启无关 |
| 响应 | 200；`Content-Type: text/csv; charset=utf-8`；`Content-Disposition: attachment; filename="task-list-<listId>.csv"`（`taskExportFileName`；D11，`ASSUMPTION`）；`X-Content-Type-Options: nosniff`；`Cache-Control: no-store`（`[c-22]`） |
| 错误 | 404；422 `UNSUPPORTED_FORMAT`、`LIMIT` |

开关（`[c-20]`）：导出与投影共用 `TASKS_PROJECTION_ENABLED`，开关关时 404。

### 3.5 错误码总表（PR-4c 新增）

| 码 | HTTP | 出处 |
|---|---|---|
| `LIST_ARCHIVED` | 422 | §3.1、§3.3 |
| `PROJECTION_IDENTITY_CONFLICT` | 409 | §3.1 |
| `INVALID_RECORD_ID`、`UNSUPPORTED_EDIT`、`AMBIGUOUS_GROUP` | 422 | §3.3 |
| `UNSUPPORTED_FORMAT` | 422 | §3.4（任务 E reason 转大写） |

沿用的既有码：`ORG_MISSING`、`LIMIT`、`INVALID_VALUE`、`NOT_IN_OPTIONS`（PR-4a）；`INVALID_GROUP`（M4 分组放置）；`INVALID_VERSION`、`VERSION_CONFLICT`（M4 PATCH）。多维表侧的拒绝见 §4.5、§4.6。

> 第 1 轮修订：上句的出处更正为 `ORG_MISSING`（M2 起的 org 规则）、`LIMIT`（M4）、`INVALID_VALUE` 与 `NOT_IN_OPTIONS`（PR-4a §3.9）（§10.2 R12）。

---

## 4. 多维表侧

### 4.1 认定

- 「是不是任务投影 sheet」只看 id 形状：`isTaskProjectionSheetIdCandidate`（任务 E，`^sht_tsk_proj_tlst_[A-Za-z0-9]+$`）；base 用 `isTaskProjectionBaseIdCandidate`（`^base_tsk_proj_[a-f0-9]{32}$`）。两者都是纯函数、不查表，所以这一判断不会因为一次查询失败而变成「不是」。两种形状由 §4.6 保留给服务端：客户端建 base、建 sheet、改 base 都拒绝它们；provisioning 之外，也不能给别的 id 盖 `task_projection`（§4.7）。
- 对候选形 sheet，守卫再读一次身份：`meta_sheets` 行未删、`system_kind = 'task_projection'`、`base_id` 等于对应清单 org 的派生 base id、清单行在 `task_lists` 里。身份不成立 ⇒ 对所有人都按非成员处理（不可读、不可写），并记一条固定码日志。
- 非候选形的 sheet 不碰任何任务表：普通 sheet 的读写路径只多一次正则匹配。
- 第 1 轮修订：身份复读的查询失败一律抛出，所有调用处同一口径（§10.2 R7）。

### 4.2 能力夹钳（S01）

把能力对象交给客户端、或据以放行写入的解析器共有四个；每个都对候选形 sheet 调用任务 E 的 `restrictTaskProjectionCapabilities(caps, true, viewerListRole, listArchived)`：

| 解析器 | 位置 | 会话租户从哪来 |
|---|---|---|
| REST `resolveSheetCapabilitiesForAccess` | `multitable/permission-service.ts:1782-1847` | `access.authenticatedTenantId` |
| 协作、API token、自动化用的 `resolveSheetCapabilitiesForUser` | `multitable/sheet-capabilities.ts:261-357` | 该函数的 tenant 参数；调用方不传时为空 |
| 记录链接事务的 `resolveSheetCapabilitiesForUserOnQuery` | `services/approval-record-link-txn-auth.ts:683-751` | 该函数没有会话租户输入，按空处理 |
| `GET /context` 组装的能力对象 | `routes/univer-meta.ts:9124` 起 | `access.authenticatedTenantId` |

规则：

- 九个写键对所有人为假，**包括管理员**：任务夹钳没有管理员参数，任务臂放在各解析器所有管理员分支之外。
- `canRead` = `viewerListRole !== null`。`viewerListRole` 由两件事决定：`task_lists.org_id` 等于会话租户；调用者有该清单的 `task_list_members` 行。org 条件经 `taskListOrgClause` 发射（S01、S02）。会话租户为空 ⇒ `null`（fail-closed）。
- 推论：协作通道（Yjs）、API token、自动化今天调用 `resolveSheetCapabilitiesForUser` 时不传租户，所以它们对任务投影 sheet 一律不可读、不可写。这是 S01 租户规则的直接结果，不是另加的规则。
- `canExport` 恒假（S10）：多维表自己的导出（`export-xlsx`，`univer-meta.ts:16733`，含 `format=csv`）对任务投影 sheet 拒绝；任务线的导出见 §3.4。
- `canManageViews` = `editor` 且清单未归档（S01、S36 (c)）。
- 清单角色与归档状态每次解析时读，不缓存：撤成员、归档在下一次请求即生效。
- 成员臂从真相表派生（`[c-25]`）：哪些清单角色算成员，由 `TASK_ROLE_ABILITY`（`src/tasks/task-access.ts:26`）里该角色桥接后的任务角色有没有 `view` 决定；今天 `list-reader` 与 `list-editor` 都有 `view`，所以三种清单角色都算。
- 第 1 轮修订：上表第四行只夹钳 `/context` 返回的能力对象，不足以挡住它返回的元数据；`/context` 在候选形 sheet 上另有拒绝规则，见 §10.2 R2。

### 4.3 列表闸（S01）

| 位置 | 规则 |
|---|---|
| `filterReadableSheetRowsForAccess`（`permission-service.ts:1690-1735`；`GET /bases` 与 `GET /sheets` 共用） | 候选形 sheet 只留给 `canRead` 为真的调用者；这一判定放在 `:1696` 的管理员返回之前 |
| `resolveReadableSheetIds`（`:1872-1905`） | 同上，放在 `:1883-1885` 之前 |
| `resolveBaseReadableForAccess`（`:1936-1971`） | 任务基座只在调用者能读其中至少一张任务投影 sheet 时可读；放在 `:1966` 之前 |
| 评论收件箱 `resolveInboxReadableSheetIds`（`routes/comments.ts:285-306`） | 列表闸对管理员早返回之后，收件箱对管理员再做一次任务判定 |
| 第 1 轮修订：收件箱的行级批量判定 `loadInboxRowDenySheetIds`（`routes/comments.ts:306-330`） | 候选形 sheet 一律算作行级受限，与 §4.4 对 `loadRowLevelReadDenyEnabled` 的规则相同；管理员同样（§10.2 R3、R4） |

### 4.4 行级撤权：deny sibling（§13-11 (a)、S02）与自定义列遮罩

**纯 builder**（`src/tasks/task-list-access.ts`，门 20 harness 自动覆盖）：

- `buildTaskProjectionMemberCondition({ actorParam, listIdParam, orgParam })`：成员臂。org 条件只经 `taskListOrgClause`；允许的清单角色集合由真相表派生（`[c-25]`），在模块装载时算出、以字面量写进 SQL 文本。
- `buildTaskProjectionReadableTasksCondition({ listIdParam, orgParam })`：逐行臂，选出本清单的、未软删的任务项。它直接复用 `buildTaskInListCondition`（`src/tasks/task-access.ts:346`）的文本，不另写任务的 org 条件。

§13-11 (a) 说的「共用 WHERE 文本生成器」在这里这样落实：逐行臂直接取 `buildTaskInListCondition` 的文本（M4 读清单项用的同一个 builder），成员臂的 org 条件只经 `taskListOrgClause`（所有清单 builder 共用的那一处）；任务中心的五个视角臂不用这两条。

**加载函数**（`src/multitable/task-projection-access.ts`）：`loadTaskProjectionDeniedRecordIds(query, { sheetId, userId, recordIds? })` 返回被拒的记录 id 集：调用者不是该清单的成员 ⇒ 该 sheet 的全部记录（或请求的那些）；是成员 ⇒ 记录 id 不等于任何可读任务的 `deriveTaskProjectionRecordId(listId, taskId)` 的那些。后一种就是 S02 的逐行臂：任务软删或被移出清单，下一次读立即被拒，不等对账。**任何查询失败都抛出**：不返回空集，也不把表缺失当作空集（锁 §7、门 9）。

**接入的读入口**：

| 入口 | 位置 | 任务 kind 的规则 |
|---|---|---|
| `loadRowLevelReadDenyEnabled` / `...Strict` | `permission-service.ts:923-941` / `:1002-1024` | 候选形 sheet ⇒ 直接返回 `true`，位置在函数体里任何查询与错误处理之前（按 id 形状，不查表） |
| `hasRecordPermissionAssignments` | `:1408-1446` | 候选形 ⇒ `true`，同样在任何查询之前 |
| `loadRecordPermissionScopeMap` | `:1096-1189` | 对被拒记录给出合成的 `'none'` 范围，与既有的合成范围同形；任务臂写在所有带 `catch` 的块之外 |
| `loadDeniedRecordIds` | `:1204-1301` | 并上任务被拒集；任务臂写在所有带 `catch` 的块之外 |
| `isRecordReadDeniedForUser` / `...Strict` | `:984-994` / `:1031-1041` | 经上面几个函数得到，不另加 |

这几个函数服务于列表、视图、单记录、记录历史、按时间点读、汇总与视图聚合、仪表盘与图表、表单上下文、回收站、附件、链接选项、关联聚合、lookup / rollup、链接摘要等读路径（各路由先判能力，再调它们）。接在这里，任务臂就覆盖全部行级读。

> 第 1 轮修订：空 actor id 在候选形 sheet 上得到全拒集，任务臂排在两个 deny 加载函数的任何早返回之前；候选形 sheet 上，按记录 id 寻址的每条读路由的任务夹钳都排在该路由的任何读之前（§10.2 R7）。

**租户**（`[c-26]`）：这几个函数今天不收会话租户，本文不改它们的签名。租户合取在能力层（§4.2）与列表层（§4.3）判定，那两层拿得到会话租户；行级 deny 运行在能力门之后，只判成员身份与逐行在册。拿不到会话租户的通道在能力层已是非成员，走不到行级。§8.3 门 19 有一格证明：第二租户的成员在每个读路由上都止于能力门。

**管理员**（`[c-27]`）：平台的行级 deny 由各调用点对管理员跳过，任务臂沿用这一惯例。管理员只有在本身是清单成员时才读得到这张 sheet（§4.2 不放行非成员管理员）；他比普通成员多看到的，只有本清单里已软删或已移出、但还没被对账删掉的那几行。要不要在每个调用点为任务 kind 取消这一跳过，是 Q8。

> 第 1 轮修订：上段的缺省改了。S02 的人口没有管理员例外，所以缺省改为逐行臂对管理员同样生效；上段说的残留在调度器关或交接丢失时也没有上界。规则、调用点的发现法与格见 §10.2 R4；Q8 改为请 owner 确认。

**自定义列遮罩**（S27；`[c-11]`）：`loadFieldPermissionScopeMap`（`permission-service.ts:863-921`）对候选形 sheet 追加合成范围：自定义字段列 `<sheetId>__tfld_*` 在该字段当前没有绑在本清单、或绑定是 `hidden` 时给 `visible: false`。判定读 `task_list_field_bindings`，查询失败抛出，写在该函数已有的 `catch` 之外。效果是：解绑或隐藏在提交后的下一次读即生效，不等 schema 步。残留：不看字段可见性的聚合类读路径，在 schema 步把列标成隐藏、并把各行重投去掉该键之前，仍可能用到旧值；这个窗口通常只是一次交接的耗时，最坏到 sweep 的 schema 段（§6.7）。这一残留是 Q9。

> 第 1 轮修订：上段的行号范围更正为 `permission-service.ts:863-917`（`:918` 起是下一个函数的注释）；「最坏到 sweep」不是上界（调度器关时 sweep 不跑），残留的说法以 §10.2 R8 为准。

### 4.5 写入面：与能力无关的 kind 拒绝（S01）

S01 要求在能力夹钳之外，对记录写入口再按 kind 显式拒绝。拒绝按 id 形状判定、不查表，统一回 403 `{ ok: false, error: { code: 'FORBIDDEN', message: 'Task projection sheets are read-only.' } }`（固定句，`[c-23]`）：

| 写入口 | 位置（`routes/univer-meta.ts`，另注明者除外） |
|---|---|
| `POST /patch` | `:21046` |
| `POST /records`、`PATCH /records/:id`、`DELETE /records/:id` | `:20134`、`:18897`、`:20407` |
| 复制记录、恢复记录 | `:20259`、`:20559` |
| 记录加锁、导入、表单提交、历史恢复诸路由 | `:20676`、`:16635`、`:18278`、`:11992` / `:12076` / `:12191` / `:12407` / `:12559` |
| Yjs 的写判定 `canWriteRecord` | `multitable/sheet-capabilities.ts:404-415` |
| 字段的建、改、删 | `:13999`、`:14367`、`:15112`；另：别的 sheet 上新建或改成 link / lookup 字段、`foreignSheetId` 指向任务投影 sheet ⇒ 同一拒绝 |
| 表单分享与公开表单 | `canManageFormShareForSheet`（`:941-946`）与 `isPublicFormAccessAllowed`（`:918-939`）对候选形返回假 |

投影服务自己写 `meta_records`、`meta_fields`、`meta_views` 走直写 SQL，不经这些入口，所以这些拒绝不挡它。

> 第 1 轮修订：上表加评论写的六个入口（`routes/comments.ts` 的建、改、删、加反应、去反应、解决），见 §10.2 R3。

### 4.6 建表面与基座面（S03 ②）

| 位置 | 规则 |
|---|---|
| `POST /bases`（`univer-meta.ts:8435-8484`） | 客户端给的 id 匹配 `isTaskProjectionBaseIdCandidate` ⇒ 403 固定句 |
| `POST /sheets`（`:16457-16608`） | sheet id 匹配 `isTaskProjectionSheetIdCandidate`，或请求里的 `baseId` 匹配任务基座候选形 ⇒ 403 固定句 |
| `PATCH /bases/:baseId`（`:8497`）、`GET /bases/:baseId/trash`（`:8330`） | 任务基座 ⇒ 403 |
| 删除、恢复、改 sheet（`:16234` / `:16298` / `:16385`） | 候选形 ⇒ 403；删除另由 `resolveSheetDeleteRefusal` 按系统 kind 答 409 |
| `resolveBaseWritable`（`permission-service.ts:1986-2034`）、`resolveCopyTargetWritable`（`:2056-2076`） | 任务基座对所有人不可写 |
| 复制源 `assertSourceIsNotSystemSheet`（`multitable/copy-sheet-service.ts:454-464`） | kind 登记之后自然拒绝 |
| 字段改型的预览与执行（`multitable/field-retype-convert-preview.ts:73-83`） | kind 登记之后自然拒绝 |

两条候选正则只在任务 E 写一次（S03），路由与守卫都从那里导入。

### 4.7 kind 登记与盖章准入（锁 §7、§9）

- `SYSTEM_SHEET_KINDS`（`multitable/system-sheet-predicate.ts:78-83`）与 `multitable/history-trust-checkpoint.ts:84-89` 的同一数组各加 `'task_projection'`。两处相等由既有的 `tests/unit/stock-preparation-overview-host.test.ts:121` 断言；本 PR 另加一格，断言两处都含 `'task_projection'`。登记之后：删 sheet、作复制源、改型都按系统 sheet 拒绝；历史完整性检查按系统 sheet 对待它（投影写不产生 revision，§6.3）。
- `multitable/provisioning.ts:482-486` 的盖章准入：`'task_projection'` 只准盖在候选形 sheet id 上，照该处对 stock-prep 概览 kind 的 id 绑定写法；其他 id 请求它即抛（`[c-24]`）。投影服务自己不经这个 helper 建 sheet（§6.2），这一条防的是其他调用方。

### 4.8 多维表既有守卫测试的登记

| 守卫 | 本 PR 的登记 |
|---|---|
| revision 处置（`tests/unit/multitable-revision-disposition-guard.guard.test.ts`） | 投影服务每条写 `meta_records` 的语句上方 3 行内带 `// revision-exempt: …`（系统 kind sheet、服务端投影、不记 revision）；若新语句使站点数超过该守卫的冒烟上界，同 PR 调上界并写明增量 |
| 记录锁（`tests/unit/multitable-record-lock-guard.guard.test.ts`） | 删投影记录的 `DELETE FROM meta_records` 带 `// lock-exempt: …`（投影记录不能被加锁：加锁路由按 §4.5 拒绝） |
| fence 持有者台账（`tests/unit/multitable-field-schema-fence-recheck.guard.test.ts`） | 投影服务的三类 fence 持有者（provisioning、schema 步、行对账）各登记一行 `EXEMPT`，与审批投影、学习统计投影两行同一类：写的是系统 kind sheet，改型转换对它答 422 |
| 裸 record data 投影（`tests/unit/multitable-raw-record-data-projection.guard.test.ts`） | 不写被它匹配的形状；若写了，按 WRITE-PATH 登记 |

> 第 1 轮修订：fence 持有者台账三行的键以普查实际报出的为准，包装器的 fence 步须能被普查解析（§10.2 R11）。

---

## 5. 权限与租户

### 5.1 谁读得到什么

| 对象 | 规则 | 出处 |
|---|---|---|
| 投影 sheet（列表、能力） | 会话租户下的清单成员；管理员不例外 | S01；§4.2、§4.3 |
| 投影的行 | 成员可读本清单未软删、仍在清单里的任务行；撤成员、软删、移出在下一次读即生效 | S02；§4.4 |
| 自定义列 | 字段当前绑在本清单，且该绑定未隐藏 | S27；§4.4 |
| 多维表写 | 无：投影 sheet 上没有任何多维表写；交互只经 §3.3 | S01、S06 |
| 视图摆放 | `editor` 且清单未归档 | S01、S36 (c) |
| 多维表导出 | 无（`canExport` 恒假） | S10 |
| 任务线导出 | 会话租户下的清单成员；行 = 本清单未软删的任务项；列含绑定且未隐藏的字段 | S10、S27；D11（`ASSUMPTION`） |

导出与投影对同一个成员给出同一组行与列：行都是「未软删且仍在清单里」，列都是「当前绑定且未隐藏」。所以导出不会比投影多给任何东西。

> 第 1 轮修订：上表「多维表写」一行含评论写（§10.2 R3）；「投影的行」一行对身为成员的管理员同样成立（缺省，§10.2 R4，Q8）。

### 5.2 租户隔离

| 层 | 机制 |
|---|---|
| 任务路由（§3） | org 只取会话租户；清单经 `taskListOrgClause` 选出；他 org 的清单与不存在同为 404 |
| 能力与列表（§4.2、§4.3） | 成员身份要求清单 org 等于会话租户；会话租户为空 ⇒ 非成员 |
| 行级（§4.4） | 运行在能力门之后，只判成员身份与逐行在册（`[c-26]`） |
| base | 每 org 一个派生 id（S03）；它是纵深防御，主屏障在 sheet 层 |
| 后台（§6） | 对账不带会话：先按主键读出清单行，以它的 `org_id` 为准，之后的任务读都经带这个 org 的 builder；清单项、绑定、取值与清单同 org 由 PR-4a 与 M4 的组合外键保证 |
| 回写（§3.3） | 解出的 `(listId, taskId)` 再经任务服务按会话租户鉴权（D21，`ASSUMPTION`） |

多维表访问层把会话租户 trim 之后再用（`multitable/access.ts:75-78`），任务路由不 trim。库里的 org id 有可打印 CHECK、不含空白，所以两边按同一个租户选出的是同一个 org。

---

## 6. 一致性

### 6.1 原则

可读性在读时判定（§4、§5），对账只决定内容新旧。所以本文对对账的要求是：最终一致、有兜底、不改变任何人的可见范围。S07 不写 SLA 数字。PR 正文照 S07 说明四点：对账主要由写入后的交接触发；sweep 只做兜底；sweep 的周期可以配置；sweep 只在调度器开关打开时运行。

### 6.2 provisioning（§3.1）

在 `withOrgStructure` 的事务里经包装器依次取锁：rank 1 结构锁 → rank 2 fence（`fenceWriterEntry(sheetId)`，只在 `isWriterFenceEnabled()` 为真时真的取锁，§6.6）→ rank 3 清单级投影锁（`[c-06]`）。之后照学习统计投影的确保写法（`services/elearning-stats-multitable-projection.ts:301-376`），满足 S03「找到的行先复核，不一致即失败」：

1. base：`INSERT … ON CONFLICT (id) DO NOTHING`，`owner_id = TASK_PROJECTION_SYSTEM_OWNER`；再 `SELECT … FOR UPDATE`：恰一行、owner 相同、未删，否则 409。
2. sheet：带 `base_id` 与 `system_kind` 插入，冲突不动；`SELECT … FOR UPDATE` 复核 `base_id`、`system_kind`、未删，否则 409。sheet 名 = 清单名（`[c-12]`）。
3. 列：调用 §6.5 schema 步的同一个确保函数（同一事务）。
4. 视图：三张，确定性 id（`[c-09]`），缺哪张补哪张；`config` 带 D7 的标记键；`kanban` 按 `status` 分组，`gantt` 的起止为 `startDate` / `dueDate`、依赖字段为 `dependencies`（`buildTaskProjectionViewSpecs`；D7，`ASSUMPTION`）。

本事务不投行（`[c-13]`）；提交后交接清单范围。

> 第 1 轮修订：第 2 步在 sheet 行已存在时，把 `name` 更新为当前清单名（§10.2 R9）。

本事务需要 `withOrgStructure` 把它自己的包装器实例交给回调，才能在同一实例上续取 rank 2 与 rank 3（另建实例会看不到已持有的 rank 1，锁序检查形同虚设）。PR-4a 冻结了包装器的语义，没有写交出的方式；这是 Q7。

### 6.3 行对账（一个 pair 一个事务，`[c-05]`）

1. `BEGIN`，首句 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`（与 `withOrgStructure` 同理：先取锁、后读）；经包装器取 [rank 2 fence(sheet)] → rank 3 pair 锁（`acquireTaskProjectionLock(listId, taskId)`）。**不取结构锁**（锁 §6.4：reconcile 不在结构锁事务内）。
2. 按主键读清单行得到 org；读 sheet 身份（§4.1）。不成立 ⇒ 回滚，映射行在则记 `last_error`。
3. `SELECT … FROM meta_fields WHERE sheet_id = $1 FOR SHARE`：读出并锁住当前列目录（`[c-07]`）。
4. 读输入：任务行（`buildTaskByIdAnyStateCondition`，含软删）、是否在本清单（`task_list_items`）、负责人、本清单里两端都未软删的前置（经 PR-4a 的 org 边 builder）、本清单的分组名、绑定（按 `position, field_id`）与字段定义、取值、本清单全部未软删任务的 `due_time` / `start_time`（供 `resolveTaskProjectionDateColumnType`）、映射行。
5. 任务已软删或已不在本清单 ⇒ 删该记录（连同以它为源的链接行）与映射行，提交（S36 (b)；在这之前它已被逐行臂拒读）。
6. 由第 4 步算出期望的列目录；与第 3 步读到的不同（绑定变了、分组名变了、`date` / `dateTime` 翻转了）⇒ 回滚，交接清单范围（schema 步），本 pair 等 schema 步之后再跑。
7. `projectTaskRow` 给出行与摘要；摘要与映射行的 `projected_digest` 相同 ⇒ 只更新映射行的 `projected_version`、`last_projected_at` 并清 `last_error`（S08；D9，`ASSUMPTION`），提交。
8. 否则：`meta_records` 以 `ON CONFLICT (id) DO UPDATE … WHERE meta_records.sheet_id = EXCLUDED.sheet_id RETURNING id` upsert（照学习统计投影 `:442-454`；返回的行数不是 1 即失败）；以它为源的 `dependencies` 链接行整组替换（先删后插）；映射行 upsert（新摘要、`projected_version`、时刻、清空 `last_error`）；提交。
9. 失败：回滚；另起一条语句写 `last_error` 固定码（映射行在时），再把错误交回运行器（D19，`ASSUMPTION`）。

写 `meta_records` 的语句都标 `revision-exempt`（§4.8）：投影不写多维表 revision、不发多维表实时事件、不触发多维表自动化（`[c-31]`）；客户端在刷新或轮询时看到新内容。

> 第 1 轮修订：上面第 1 步在 pair 锁之前先取本清单的哨兵键，第 3 步不再对 `meta_fields` 加行锁、目录比对在哨兵之下做（§10.2 R6）；第 4 步的绑定按 `position, field_id COLLATE "C"` 读（§10.2 R9）。

链接（`[c-34]`）：`dependencies` 只投本清单内的前置（S05）。`meta_links.foreign_record_id` 没有外键（`zzz20251231_create_meta_schema.ts:53-60`；`zzzz20260404153000_repair_meta_core_schema.ts:32-36` 同形），而 `record_id` 外键 `ON DELETE CASCADE`，所以删一条投影记录会连带删掉以它为源的链接行。前置的行若还没投出，链接照样按确定性的记录 id 写入，前置投出之后甘特即可连线。前置被软删或移出时，后继的行由交接里的 `dependentsOf` 范围重投（§6.4）。

### 6.4 写入点的提交后交接（`[c-02]`、`[c-03]`）

**形状**照 PR-3c 的红点信号（`services/task-counts-realtime.ts`）：

```
const projection = taskProjectionTouch()
const result = await withOrgStructure(orgId, async (db) => {
  // 原有的读、纯函数与写，不变
  projection.note({ tasks: [...], dependentsOf: [...], lists: [...], fields: [...] })
  return result
})
projection.publish()
```

- 新模块 `src/services/task-projection-touch.ts` 导出 `taskProjectionTouch()` 与 `setTaskProjectionHandOff(fn)`。`note` 只记 id；`publish` 在事务提交之后同步调用一次注册的函数，传入四类范围各自的并集；没记过就什么也不做，第二次调用也什么都不做。缺省注册的是空函数。
- 服务启动时（`index.ts`，与 `setTaskCountsBroadcaster` 同处），只在 `isTaskProjectionEnabled()` 为真时注册运行器的 `enqueue`。所以开关关时，写入点不交接任何东西（D20，`ASSUMPTION`）。
- **PR-3c 普查规则 ③ 不改**：`task-projection-touch.ts` 被三个写入文件导入，会落进 `writerModules()` 的遍历；它没有 `try` / `catch`、没有 promise 处理器、不发语句，所以那条扫描对它照常成立。运行器在 `src/multitable/task-record-projection-service.ts`，不被任何写入模块导入（依赖经注册反转）；它对单个 pair 失败的隔离（记 `last_error` 后继续）发生在提交之后、在它自己的事务里，不在写入点的事务回调中。本 PR 只在普查单测 `writerModules()` 的期望集合里加上 `services/task-projection-touch.ts`；`SWALLOW_ALLOWED` 与三条规则不变。
- `enqueue` 必须是全函数：同步、不 `await`、不发语句，对任何输入都不抛——它只往集合里加 id，必要时用 `setImmediate` 安排一次排水。提交之后才抛出，会让一次已提交的写入答 500，所以 §8.5 有单测钉住这三点。
- 响应不等对账（§3.3 的版本规则由此而来）。

**交接范围**（运行期解析成 pair）：

| 范围 | 解析 |
|---|---|
| `tasks: T` | T 所在的每个清单的 pair，并上 T 现有映射行的 pair（后者覆盖「刚被移出」） |
| `dependentsOf: P` | 以 P 为前置的每个后继 S 的 `tasks` 范围。从经 `buildTaskByIdAnyStateCondition` 选出的 P 出发连接 `task_dependencies`；任务软删后它的边仍在（D17，`ASSUMPTION`），所以刚被软删的 P 也找得到后继 |
| `lists: L` | 先跑 L 的 schema 步，再跑 L 全部任务项与映射行的 pair |
| `fields: F` | 绑着 F 的每个清单的 `lists` 范围 |

**触发表**（写入点与它记下的范围）：

| 写 | 位置 | 记 |
|---|---|---|
| `PATCH /api/tasks/:id`（标题、日期、时区；描述与提醒只改 `version`，但 `taskVersion` 列随之变） | `services/task-patch.ts` `patchTask` | `tasks: [id]` |
| 完成、重启（含 G1） | `services/task-records.ts` `completeTask` / `reopenTask` | `tasks: [id]`；派生出新一期时另记 `tasks: [新 id]`（新一期继承清单项） |
| 加、删负责人；切换完成模式 | `services/task-structure.ts` `addAssignee` / `removeAssignee` / `switchCompletionMode` | `tasks: [id]`；派生同上 |
| 删除（含系列删除） | `services/task-structure.ts` `deleteTaskById` | `tasks: deletedIds`，`dependentsOf: deletedIds` |
| 加入清单、移出清单 | `services/task-list-records.ts` `addTaskToList` / `removeTaskFromList` | `tasks: [taskId]`，`dependentsOf: [taskId]` |
| 清单改名 | 同文件 `renameTaskList` | `lists: [listId]`（sheet 名随之变，`[c-12]`） |
| 清单分组的建、改名、删；把任务放进分组 | `services/task-group-records.ts` 的四个清单分组函数 | 分组变化记 `lists: [listId]`；放置记 `tasks: [taskId]` |
| 里程碑 | PR-4a `services/task-dependency-records.ts` | `tasks: [id]` |
| 依赖增删 | 同上 | `tasks: [后继 id]`（只有后继行的 `dependencies` 列会变） |
| 字段取值 | PR-4a `services/task-field-records.ts` | `tasks: [id]` |
| 绑定、解绑、调序、显隐 | 同上 | `lists: [listId]` |
| 改字段定义（改名、改选项） | 同上 | `fields: [fieldId]` |

不交接的写：建任务（新任务不在任何清单里）、设父 / 转独立、关注人的增删与退出、评论、提醒、清单成员的增删与改角色、转移清单 owner、清单归档与取消归档、删字段定义（只在零绑定时允许，S26）、设 / 清重复规则（不在列目录里，也不改 `version`）。它们要么不改任何投影输入，要么只影响读时判定。

### 6.5 清单级 schema 步（`[c-08]`）

独立事务：`READ COMMITTED` → [rank 2 fence(sheet)] → rank 3 清单级锁（`[c-06]`）→ 读绑定、分组、日期列类型 → 算出列目录 → 确保 `meta_fields`：目录内的列按 id upsert（名字、类型、property、`"order"`，覆盖本投影自有的列）；不再绑定的自定义列保留，`property.hidden = true`（S36 (a)：解绑时这一列只被隐藏，任务上的取值保留）；`hidden` 的绑定同样隐藏（`[c-10]`）→ 确保三张视图 → 提交 → 交接本清单的全部 pair。它**不在同一事务里重投行**，也不取任何 pair 锁。

列类型翻转（S05：清单里一旦有带时刻的任务，`startDate` / `dueDate` 都是 `dateTime`；D7，`ASSUMPTION`：全部是全天任务则为 `date`）只由这一步改 `meta_fields.type`。多维表面向用户的改型路由（`assertLosslessFieldRetype`、改型转换）对系统 kind sheet 不开放；这里是服务端对自有列的直写。翻转后每一行的起止值形状都变了，由上面的交接逐行重投。

> 第 1 轮修订：schema 步另把 `meta_sheets.name` 更新为当前清单名，绑定按 `position, field_id COLLATE "C"` 读（§10.2 R9）。

### 6.6 锁与锁序

| 事务 | 取锁序列（经 `withTaskLockOrder`；`/` 前为 fence 打开时，`/` 后为关闭时） |
|---|---|
| 任务写入点（M2–M5） | [1] |
| provisioning（§6.2） | [1, 2, 3(清单)] / [1, 3(清单)] |
| schema 步（§6.5） | [2, 3(清单)] / [3(清单)] |
| 行对账（§6.3） | [2, 3(pair)] / [3(pair)] |
| 导出（§3.4） | 无 |
| 回写（§3.3） | 被委托服务自己的 [1] |
| sweep 所在的 tick | leader 独占（PR-4a `[a-36]`）；每个 pair 在 leader 事务提交之后、在各自的行对账事务里 |

- 包装器的 fence 步 `fence(sheetId)` 调用 `fenceWriterEntry`（`multitable/canonical-sheet-fence.ts:212`），**只在 `isWriterFenceEnabled()`（`:168`）为真时记录 rank 2**：开关关时该函数首行返回、不取锁，锁 §6.4 规定这种情形不得算作锁序证据（`[c-33]`）。
- 清单级锁用投影锁 helper 的哨兵键：`acquireTaskProjectionLock(query, listId, listId)`，键为 `task-projection:<listId>:<listId>`。任务 id 以 `tsk_` 开头、清单 id 以 `tlst_` 开头，哨兵键与任何 pair 键都不相交；不新增取锁字面量，门 7 的多重集不变（`[c-06]`）。
- 无环的理由：所有事务都先按 rank 取 advisory 锁、后写行。行对账在 pair 锁之下先对 `meta_fields` 取共享锁、后写记录与映射行；schema 步持清单级锁改 `meta_fields`，从不碰记录、映射行或 pair 锁。所以行对账可能等 schema 步（等字段行），schema 步从不等行对账。任务写入点不碰 `meta_*` 与映射表，与二者都没有共享的行。fence 打开时，同一 sheet 的 provisioning、schema 步、行对账在 fence 上串行。
- 第 1 轮修订：上一条的无环论证在 fence 关闭（缺省）时不成立：行对账对 `meta_fields` 的共享行锁与 schema 步逐列 upsert 的行锁可以互等。上表「行对账」一行与本条以 §10.2 R6 为准：凡取 pair 锁的事务都先取本清单的哨兵键，取锁序列为 [2, 3(清单), 3(pair)] / [3(清单), 3(pair)]。

### 6.7 运行器与 sweep

**运行器**（`src/multitable/task-record-projection-service.ts`，`[c-04]`）：每个实例一个，单并发；待办集合按 pair 与清单去重；某 pair 正在跑时再次入队 ⇒ 跑完再跑一次；待办上限 10000 个 pair，溢出丢弃并记一条固定码日志（由 sweep 兜底）。服务关闭时停止接收，并在有界时间内等在途的那一个 pair 结束。运行器不依赖 `TaskScheduler`：调度器开关关闭时，交接与运行器照常工作，只是没有 sweep 兜底。

**sweep**（S07；D8，`ASSUMPTION`；`[c-28]`、`[c-29]`）：`TaskScheduler` 的一个 `TaskSchedulerJob`，名为 `task-projection-sweep`，在 leader 事务提交之后运行（不在 leader 事务里，锁 §6.4），响应 `stopping()` / `leaderLost()`。它要求 `TASKS_ENABLED`、`TASKS_SCHEDULER_ENABLED`、`TASKS_PROJECTION_ENABLED` 三者都为真，与投递 worker 的开关无关。周期旋钮 `TASKS_PROJECTION_SWEEP_INTERVAL_MS`：缺省 300000（S07），解析与夹取照 `resolveTaskSchedulerIntervalMs` 的写法，未到周期的 tick 直接返回。每次运行至多 200 个 pair（D8），依次分给四段：

1. schema：按清单 id 轮转，抽查若干开启投影的清单的列目录（与 §6.3 第 6 步同一比较），不同即跑 schema 步；
2. 缺行：开启投影的清单里、未软删且没有映射行的任务项；
3. 孤儿：任务已软删或已不在清单、却仍有映射行的 pair；`meta_records` 里属于任务投影 sheet、却没有映射行的记录；
4. 轮转：其余映射行按 `last_projected_at` 从旧到新，重算摘要。

每个 pair 都调用 §6.3 的同一个函数。

> 第 1 轮修订：周期旋钮「不进 manifest」出自已裁的 S07，不只是 D8；本文登记它是对 S07 的偏离（Q12）。周期的记账（上次运行时刻放在哪、leader 更替时怎样）见 §10.2 R10。

**`TaskScheduler` 的改动**（PR-3b 的模块）：它今天只有一个提交后槽位 `deliveryJob`（`services/task-scheduler.ts:190`、`:269`、`:470`、`:910`）。本文新增选项 `postCommitJobs?: readonly TaskSchedulerJob[]`：在 `deliveryJob` 之后按序各经 `runJob`（`:478`）隔离运行；`deliveryJob` 的位置与行为不变；`startTaskScheduler` 只在投影开关为真时把 sweep 放进这个列表。PR-4b 的 GC 作业要用同一处，谁先合入谁带这一改动，另一张 rebase（Q5）。回归含 `M4|25|整门`。

> 第 1 轮修订：PR-4a §4.1（head `7f1c4c536f`）写明它对 `services/task-scheduler.ts` 只改 `:428` 那一行取锁入口；`postCommitJobs` 是另一处改动，不在 PR-4a 内（§10.2 R1）。

### 6.8 版本、事件、通知、红点

- 投影从不写 `tasks`：`tasks.version` 的递增点不变（S08、PR-4a §4.3）。
- 不写 `task_events` / `task_list_events`：开启投影、对账、回写本身都没有事件词（E03、S05）；回写委托的服务照常写它们自己的事件。
- 不发通知，也不发红点信号：投影写不改待办谓词的任何输入。回写委托 `patchTask` 时，红点信号由 `patchTask` 自己发（它本就是 PR-3c 的写入点）。
- PR-3c 普查的规则 ①（全 `src` 写待办输入的只有三个服务文件）与 ②（写入者只能是写入点与 `WRITE_HELPERS`）不受影响：投影只写 `meta_*` 与映射表。规则 ③ 见 §6.4。

---

## 7. CSV 导出的安全规则

### 7.1 规则

1. 每一格都经共享 helper `services/csv-cell.ts` 的 `sanitizeCsvCell`：先把值转成文本；若开头（跳过 helper 认定可忽略的前导字符之后）是 `CSV_FORMULA_INJECTION_LEAD_CHARS` 里的字符（`=`、`+`、`-`、`@`、TAB、CR、LF），在原文前加一个 `'`；再按 RFC 4180 加引号。表头同样处理（S10）。导出模块与路由都不自己写中和或加引号的逻辑。
2. 每行的各格以 `,` 连接，行以 `CSV_LINE_TERMINATOR`（CRLF）结尾；正文前加 UTF-8 BOM（任务 E 的 `TASK_EXPORT_CSV_BOM`，任务 E 的自选）。
3. 规则 1 覆盖全部可能含作者文字的格：任务标题、分组名、字段名（表头）、选项 label、文本型取值、人员显示名、前置任务标题（依赖列）。
4. 文件名固定为 `task-list-<listId>.csv`，不含任何用户文字；它全是 ASCII，所以只给 `filename=`。
5. 响应头见 §3.4；不 inline。
6. 只有会话租户下的清单成员能导出；导出的行与列与投影相同（§5.1）。

### 7.2 时区

`dateTime` 列按 UTC 的 ISO 时刻输出，表头写成 `<列名> (UTC)`；`date` 列是不带时区的民用日期。这是任务 E 的现行做法；导出用哪个时区是任务 E §7 问题 2，仍待 owner（§9.2）。

### 7.3 数值格（X2）

任务 E `task-export.ts:96-99` 的 `exportCell`，对数值列里编解码能产生的数（有限、绝对值小于 1e15）只经 `quoteRfc4180`，不做前导中和（`:97`）。S10 的已裁取值引用的是逐格中和（D11），所以 X2 是对已裁取值的偏离，尚未被点名。本文的缺省按已裁取值：PR-4c 删去 `:97` 这一行，让所有格都经 `sanitizeCsvCell`；代价是负数在表格软件里显示为文本 `'-5`。若 #6249 先行修改，这一行作废。owner 若接受 X2，PR-4c 不动这一行，§8.3 门 32 的数值格改为断言「数值列的编解码数照原样输出，其余格照规则 1」。缺省怎么选，原则见 §9.2。

---

## 8. 门与测试

### 8.1 既有 `M5|` 行里属于 PR-4c 的部分（§12 已 ratify，直接计分）

- `M5|7|src/multitable/task-*`：本 PR 首次在该根下建文件（`task-projection-access.ts`、`task-record-projection-service.ts`），满足「`.ts` 文件数 ≥ 1」；ERE 命中多重集仍是三个登记导出各一次。负控：在 `task-record-projection-service.ts` 里插入第四处 `pg_advisory_xact_lock(hashtext(` ⇒ 红。
- `M5|7|锁序控件`（本 PR 的部分）：正向格各走真实路径，经记录钩子读出取锁序列——行对账 `[3]`（默认 lane）与 `[2, 3]`（fence lane）；schema 步同形；provisioning `[1, 3]` / `[1, 2, 3]`。行对账与 schema 步的序列都**不含** 1。fence lane 由 `tasks-realdb` 对锁序文件以 `MULTITABLE_ENABLE_WRITER_FENCE=true` 再跑一遍（`[c-33]`）。负控：让行对账在投影锁之后取结构锁 ⇒ 抛 `TaskLockOrderViolation`；把包装器的「只在启用时记录 rank 2」改成无条件记录、在默认 lane 跑 ⇒ 序列里出现 2 ⇒ 红。
- `M5|9|整门`、`M5|10|P2子集`（recordId 格）、`M5|19|投影端`：见 §8.3。
- 第 1 轮修订：行对账的正向序列改为 `[3, 3]`（默认 lane：清单哨兵、pair）与 `[2, 3, 3]`（fence lane）；另加双连接格（§10.2 R6）。

### 8.2 候选行（未计分，等 PR-4a §7.3 那次锁修订写进 `arm-set`）

| 候选 | 门号（按 S31） | 承载 |
|---|---|---|
| M5-e 夹钳与写入拒绝 | 31 | §8.3「门 31」 |
| M5-f 导出 | 32 | §8.3「门 32」 |
| M5-g 新表面（本 PR 的部分） | 门 1 / 2 / 13 / 17 / 18 / 20 的 M5 子集 | §8.3「M5-g」 |

### 8.3 各门的格

并发与交错的格照 PR-4a §6.2 开头的持锁法。每个 404 格断言响应与目标不存在时逐字节相同、行不变。每个负控照门 6：`cp` 备份、`cmp` 证明变异已落地、测完恢复。

> 第 1 轮修订：门 10、18、19、31、32 与 §8.4、§8.5 的增补格与一处更正（门 32 的 CR 格）见 §10.2 R11，与下文不一致时以它为准。

**门 9（deny 注错，`M5|9|整门`）**

- 夹具：清单 L 已开启投影；成员 V（`read`）；L 里任务 T1 在册、T2 已软删，T2 的投影记录与映射行由夹具直发 SQL 保留，本文件不注册运行器，所以对账不会先把它删掉。
- 正控（先跑）：V 读 `GET /records`（scope-map 路径）⇒ 200，含 T1、不含 T2；V 走一条 deny-set 路径（`POST /dashboard/query` 的计数）⇒ T2 不计入；`GET /records/:recordId`（T2）⇒ 该入口对被拒记录的既有答复，403 `{ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }`。被拒集非空（T2），负控乙才有判别力。
- 负控甲：注入点是 `loadTaskProjectionDeniedRecordIds`（不是审批的加载函数）；让它抛错 ⇒ 两条路径都 500。
- 负控乙：把它注成空集或反相 ⇒ T2 出现 ⇒「被拒行不在」的断言红（HTTP 仍 200）。不写「注空集 ⇒ 500」，也不写 `not.toBe(200)`。
- 链接格：另一任务 T3 以 T2 为前置，T3 的投影行在 `dependencies` 列里仍链着 T2 的记录（夹具保留）⇒ V 读 T3 的链接摘要时不带出 T2 的标题（链接摘要经 `loadDeniedRecordIds`）。

**门 10 P2 子集（回写的 recordId，`M5|10|P2子集` 中归本 PR 的一格）**

- 下面的 `<L>`、`<T>` 是夹具里真实的清单 id（等于路径 id）与该清单里真实的任务 id。坏 id 都围绕真实 id 构造，这样校验被去掉之后，请求会走到更后面的判定、得到别的答复，变异才看得见。
- 正控：`editor` 带 `rec_tsk_<L>__<T>` 改 `dueDate` ⇒ 200，返回新 `version`。
- 422 `INVALID_RECORD_ID` 的格：后半含 `__`（`rec_tsk_<L>__x__<T>`，按首个 `__` 切分后 taskId 为 `x__<T>`）；taskId 前导 `_`（`rec_tsk_<L>___<T>`）；taskId 尾随 `_`（`rec_tsk_<L>__<T>_`）；前缀不是 `rec_tsk_`、但长度相同（`rec_xyz_<L>__<T>`）；解出的 listId 是另一张清单的 id。
- 顺序格：不是 `editor` 的成员带坏的 `recordId` ⇒ 404（行级先于请求体）。
- 负控：去掉 `parseTaskProjectionRecordId` 里对两半各自的 `isValidTaskDomainId` 校验 ⇒ 前三格解析成功、listId 等于路径，再在取任务时得到 404 而不是 422 ⇒ 红；去掉前缀检查 ⇒ `rec_xyz_<L>__<T>` 被当成合法记录、改期成功 ⇒ 红。

**门 19 投影端（`M5|19|投影端`；格名 `gate19m5|<身份>|projection`，`[c-32]`）**

- 身份：`list-owner`、`list-editor`、`list-reader`（三个成员身份）；`assignee-not-member`、`creator-not-member`、`follower-not-member`、`admin-not-member`、`none`（同 org 在职、与任务无关）；`second-tenant`（清单在 org B，会话租户为 A）。
- 期望按路由类别写死：三个成员身份 ⇒ `GET /records` 与 `GET /view` 为 200，行集恰为 L 中在册且未软删的行（非空）。其余身份 ⇒ 能力读数 `canRead=false`；记录读（`GET /records`、`GET /view`、`GET /records/:recordId`、记录历史）与 `POST /dashboard/query` 都答 403 `{ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }`；`GET /bases`、`GET /sheets` 为 200，但不含该 base 与 sheet。`admin-not-member` 与 `second-tenant` 逐条照此断言；`second-tenant` 另断言它在每个读路由上止于能力门（`[c-26]`）。
- 存在性格：非成员对「已开启的投影 sheet」与「没有对应 sheet 的候选形 id」得到同一个 403（夹钳按 id 形状生效，§4.1），不因 sheet 是否存在而不同。
- 撤权格：删掉一个成员后立即读 ⇒ 记录读 403、两个列表都不再含该 sheet（本文件不注册运行器，中间没有对账）。软删格：成员读到 200，那条已软删任务的记录当即不在结果里。
- 从属链探针：把 `TASK_ROLE_ABILITY['list-reader'].view` 置反 ⇒ `list-reader` 格变空 ⇒ 红，同时任务详情对 list-reader 变 404（`[c-25]`）。
- 负控：删掉成员臂 ⇒ `assignee-not-member` 变非空 ⇒ 红；把列表闸的任务判定挪到管理员返回之后 ⇒ `admin-not-member` 红；删掉租户合取 ⇒ `second-tenant` 红；删掉逐行臂 ⇒ 软删格红。
- TS/SQL 对拍（§13-11 (a)）：清单角色 {owner, edit, read, 无} × 会话租户 {相同, 不同, 无} × 任务 {未删, 已删} × {在册, 不在册} 共 48 格；SQL builder 的结果与 `isTaskProjectionRowReadable`（角色先按会话租户过滤再传入）逐格相等。负控：SQL 去掉租户合取 ⇒「不同」的那些格不再相等 ⇒ 红。

**门 31（M5-e）**

- 能力：成员 `canRead=true`、`canExport=false`、九个写键全假（身为成员的管理员同样全假）；`canManageViews` 只在 `editor` 且未归档时为真；归档之后 `canManageViews=false`，回写答 422 `LIST_ARCHIVED`；非成员管理员 `canRead=false`；第二租户 `canRead=false`；不带租户的协作解析器 ⇒ 成员也 `canRead=false`；`GET /context` 与 REST 解析器给出同一组能力。
- 写入拒绝（§4.5 每个入口一格，调用者含成员 `editor` 与管理员）：`/patch`、`/records` 三种写、复制、恢复、加锁、导入、表单提交、历史恢复、Yjs 写、字段三种写、指向它的 link 字段 ⇒ 403 固定句；公开表单与表单分享 ⇒ 拒绝。
- 建表面（§4.6）：`POST /bases` 带 `base_tsk_proj_` 加 32 位十六进制 ⇒ 403；`POST /sheets` 带 `sht_tsk_proj_tlst_…`，或以任务基座为 `baseId` ⇒ 403；`PATCH /bases`、回收站、sheet 的删 / 改 / 恢复 ⇒ 拒绝；复制源与复制目标 ⇒ 拒绝。
- 盖章准入：经 `provisioning.ts` 给非候选形 id 盖 `task_projection` ⇒ 抛。
- 生命周期（S36）：解绑 ⇒ 列保留且隐藏、行不再带值，而读时遮罩在 schema 步之前已生效；任务软删 ⇒ 对账之后记录与映射行都被删除；清单归档 ⇒ 投影保留、只读。
- 内容：选项改名 ⇒ 投影显示新 label；被删掉的选项 ⇒ 该格为空（PR-4a `[a-38]`）；`date` / `dateTime` 翻转（给一个任务加上时刻 ⇒ 全清单起止列变 `dateTime`、各行重投；去掉最后一个时刻 ⇒ 变回 `date`）；只改两次描述之后，回写用上一次写的响应里的 `version` 改期 ⇒ 首发成功（D9，`ASSUMPTION`）。
- 未开启的清单没有 sheet，GET 答 `enabled: false`。
- 负控：给夹钳加一个管理员早返回 ⇒ 管理员成员的能力格（`canEditRecord`）红；写入格有两道独立守卫（能力与 kind 拒绝），只去掉一道仍会拒绝，所以负控是两道一起去掉 ⇒ 写入格红；去掉盖章准入里的 id 绑定 ⇒ 盖章格红。

**门 32（M5-f）**

- 多维表导出（`export-xlsx` 与 `format=csv`）对任务投影 sheet ⇒ 拒绝（成员与管理员各一格）。
- 任务线导出：标题、分组名、选项 label、文本取值、字段名（表头）分别以 `=`、`+`、`-`、`@`、TAB、CR 开头 ⇒ 该格以 `'` 起头；前导空白之后跟 `=` ⇒ 同样中和；含 `,`、`"` 或换行的格按 RFC 4180 加引号；BOM 与 CRLF；数值列里的负数 ⇒ `'-5`（X2 的缺省，§7.3）。
- 访问：非成员、第二租户、非成员管理员 ⇒ 404；`format=xlsx` ⇒ 422；超过上限 ⇒ 422 `LIMIT`；软删与移出的任务不在导出里；隐藏或已解绑字段的列不在导出里。
- 负控：把某一类格改成不经 helper 的拼接 ⇒ 对应的格红；表头不经 helper ⇒ 表头格红；把数值列的例外扩到所有列 ⇒ 文本 `-x` 那一格红。
- 第 1 轮修订：上面「以 CR 开头 ⇒ 该格以 `'` 起头」对 CR 不成立（含 CR 的格随后按 RFC 4180 加了引号）；CR 与 LF 的格改为断言去掉 RFC 4180 引号之后的文本以 `'` 起头（§10.2 R11）。

**M5-g（本 PR 的部分）**

- 门 1：两条写路由（开启投影、回写）缺 org ⇒ 422，位置在 `rbacGuard` 之后，同夹具换有效 org ⇒ 200；跨 org 写格；第二租户：同一用户在 org A、B 都在职，org B 有一张他做 owner 且已开启投影的清单（夹具直发 SQL），会话 org 为 A ⇒ 四条路由按 id 访问 org B 的清单都 404，org B 的数据零变化。负控：删掉 `taskListOrgClause` 的 org 合取 ⇒ 红。这些格放在 `tests/tasks-auth/tasks-auth-gate.ts`（信任关闭）。
- 门 2：四条路由的非 admin 正格与 403 负格。
- 门 13：注册行置空 ⇒ 红。
- 门 17：§8.4 的每个新文件满足 ①②④。
- 门 18：`TASKS_PROJECTION_ENABLED`（`dependsOn` 列 `TASKS_ENABLED` 与 `TASKS_SCHEDULER_ENABLED`，S30 ①）与 `TASKS_PROJECTION_SWEEP_INTERVAL_MS` 都在 manifest；删掉任一条 ⇒ `pnpm verify:global-history-flag-manifest:test` 红。
- 门 20：新的纯 builder 在行为 harness 与 (A)(B) 静态检查之下。

### 8.4 真库文件与登记

新文件：`task-m5-projection-provision.db.test.ts`、`task-m5-projection-reconcile.db.test.ts`、`task-m5-projection-read.db.test.ts`（门 9、门 19、TS/SQL 对拍）、`task-m5-projection-clamp.db.test.ts`（门 31）、`task-m5-projection-edits.db.test.ts`（门 10）、`task-m5-export.db.test.ts`（门 32）、`task-m5-projection-locks.db.test.ts`（`M5|7|锁序控件`，跑两遍）。每个同 PR 登记三处（锁 §5.2.1：exclude 逐文件字面量、`tasks-realdb` 清单、④ 三集合相等），PR 正文写 `.each` 展开后的计数（门 17）。锁序文件的第二遍是 `tasks-realdb` 里同一文件、另设 `MULTITABLE_ENABLE_WRITER_FENCE=true` 的一步；④ 按文件名比集合，不受影响，若它的实现按步计数，同 PR 调整其登记。多维表侧的改动另跑多维表后端的既有 lane。

### 8.5 单测

- `tests/unit/task-projection-touch.test.ts`：`publish` 只在 `note` 之后、只调用一次钩子；运行器的 `enqueue` 同步返回、不发语句（把数据库根打成门 20 的哨兵也不触发）、对空范围、重复 id、超长输入都不抛。负控：给 `enqueue` 加一个 `await` 或一条查询 ⇒ 红。
- PR-3c 普查单测：`writerModules()` 的期望集合含 `services/task-projection-touch.ts`；规则与 `SWALLOW_ALLOWED` 不变。
- `src/tasks` 新 builder 的纯函数格（门 20 harness 自动覆盖）。
- `isTaskProjectionEnabled` 与 `isTasksEnabled` 的组合格（照 `tests/unit/tasks-feature-flag.test.ts`）。
- kind 登记格（§4.7）；manifest 测试。

### 8.6 回归与声明

- 最终 head 上重跑：全部 `M2|`、`M3|`、`M4|` 行（写入点多了交接）；PR-4a 的 `M5|` 行；PR-3c 普查单测；多维表后端既有 lane（含 §4.8 的守卫）；`stock-preparation-overview-host.test.ts`。
- 部署耦合：多维表侧的任务臂只在候选形 id 上查任务表；任务路由与运行器要求 PR-4a 的迁移已应用（与 PR-4a §4.5 同一耦合）。本 PR 不带 DDL，门 14 的「含 DDL」首段不适用；PR 正文首段写明这一点。
- S30 的真值表写进 PR 正文：`TASKS_PROJECTION_ENABLED` 开、`TASKS_SCHEDULER_ENABLED` 关 ⇒ 四条路由、夹钳、行级 deny、写入点交接与运行器照常，sweep 不跑（没有宿主），只剩写后交接这一条对账来源；投影开关关 ⇒ 四条路由 404、写入点不交接、sweep 不注册，已存在的投影 sheet 仍受夹钳与行级 deny。
- S37：PR 正文与验证记录如实写明：任务域的表（含 `task_record_projection`）不在任何 DML 普查的分母里；投影服务对 `meta_*` 的直写只受 §4.8 的标记守卫约束。

---

## 9. 自选、偏离与 owner 问题

### 9.1 本文自选（`ASSUMPTION(task-m5c): [c-NN]`；缺省即本文的设计值）

| 编号 | 取舍 | 缺省 | 备选与代价 |
|---|---|---|---|
| c-01 | 陈旧怎样被发现 | 写后交接加全覆盖 sweep；写入点的事务里不碰映射表 | 在写事务里把受影响映射行的 `projected_digest` 置空作「待对账」标记：结构锁下的每条 M2–M5 写都多一条 UPDATE，可能等对账持有的映射行锁，清单级标记会卡住同 org 的写；还要把 §2.9 那一列的语义扩成工作标记，属于 PR-4a 冻结的改动；新 pair 仍要靠 sweep 找 |
| c-02 | 交接的实现 | 同步、不发语句、不含 `catch` 的注册钩子（同 `setTaskCountsBroadcaster` 的注册法）；PR-3c 规则不改 | 照 `sendOne` 再登记一个 `SWALLOW_ALLOWED` 例外：放宽一条已合入的守卫；或在路由层交接：路由不知道派生的新一期、系列各期、依赖另一端与字段绑着的清单 |
| c-03 | 交接范围 | `tasks`、`dependentsOf`、`lists`、`fields` 四类，运行期解析成 pair | 写入点自己算出 pair：每条写多读清单与依赖，事务更长 |
| c-04 | 运行器 | 每实例一个、单并发、去重、在途时再入队则跑完再跑一次、上限 10000 溢出丢弃 | 不设上限：极端写入下内存无界；多并发：同一 sheet 在 fence 打开时本就串行，收益小 |
| c-05 | 对账单元 | 一个 pair 一个事务；schema 步单独成事务 | 一个清单一个事务：锁持有时间随清单大小增长，失败影响整张清单 |
| c-06 | 清单级串行点 | 投影锁 helper 的哨兵键 `(listId, listId)` | 用结构锁：违背锁 §6.4 的「对账不在结构锁内」；新增锁 helper：门 7 的多重集要改，需要修订锁 |
| c-07 | 行对账与列目录 | 在 pair 锁下对 `meta_fields` 取共享锁、比对目录，不一致则延后并交接 schema 步 | 不比对：列类型翻转与解绑期间可能按旧目录写出形状不对的行 |
| c-08 | schema 步 | 只改列与视图、提交后交接全部 pair；同一事务里不重投行、不取 pair 锁 | 同一事务里顺带重投：持字段行锁时去取 pair 锁，与行对账形成锁环 |
| c-09 | 视图 id 与读时补建 | 确定性 id `<sheetId>__view_<kind>`（超过 50 个字符，落在客户端 id 空间之外），`config` 仍带 D7 的标记键但不靠它查找；GET 不写，补建在 POST 与 sweep | 按 D7 用标记键查找、GET 时补建：视图的 PATCH 若整体替换 `config`，标记键会丢，导致重复补建；读者的 GET 引发写入 |
| c-10 | `hidden` 的绑定 | 对应列 `property.hidden = true`；导出不含该列 | 照常显示：与清单界面不一致；完全不投影：显隐切换要删列再建列 |
| c-11 | 解绑与 S27 的窗口 | 列保留并隐藏（S36 (a)），行重投去掉该键；读时按绑定现状给自定义列加字段可见性遮罩 | 只靠 schema 步：解绑提交到 schema 步之间，成员仍读得到已不再授予的取值 |
| c-12 | 名称 | sheet 名 = 清单名，清单改名经交接同步；base 名为固定文字 | sheet 名固定：多维表里分不清是哪张清单 |
| c-13 | 开启投影的同步范围 | 只做 provisioning，行在后台投出，响应带 `pendingRows` | 同步投出全部行：大清单的请求时长不可控 |
| c-14 | 归档清单上开启投影或回写 | 422 `LIST_ARCHIVED` | 允许开启：S36 (c) 已使视图摆放与交互为假，开启后得到一张谁都不能摆的 sheet |
| c-15 | 身份复核不过 | 409 `PROJECTION_IDENTITY_CONFLICT` | 500：调用方分不清是冲突还是故障 |
| c-16 | 回写路由 | `POST /api/task-lists/:id/projection/edits`，请求体 `{ recordId, fieldId, value, expectedVersion? }`，§3.3 的检查顺序 | 前端自行解析记录 id、直接调任务接口：服务端从不收到记录 id，门 10 的 recordId 格没有产生处（Q4） |
| c-17 | 回写的版本 | 只有日期编辑经 PATCH 比版本；分组与单选不比；响应带写后 `version` | 一律比版本：分组与单选的任务接口本身不收版本，要另读一次再比，且只能在锁外比 |
| c-18 | 按分组名回写 | 恰一个同名分组才放置；重名 422 `AMBIGUOUS_GROUP` | 取位置最前的那个：可能放错组 |
| c-19 | `dateTime` 列的回写值 | 接受民用日期或 ISO 时刻，时刻按任务时区折成民用日期，时刻列不动 | 只收民用日期：前端要自己知道任务时区 |
| c-20 | 导出的开关 | 与投影共用 `TASKS_PROJECTION_ENABLED` | 只看 `TASKS_ENABLED`：导出与投影分开上线，但 PR-4c 的表面不再整体由一个开关收住 |
| c-21 | 导出的数据与规模 | 取自 SoR，一个只读 `REPEATABLE READ` 事务，不取锁；上限 5000 行，超过答 422 `LIMIT` | 取 `meta_records`：导出依赖投影是否开启、是否新鲜，可见性还要再过一遍 deny；流式不设上限：内存与时长不可控 |
| c-22 | 导出的响应头与显示名 | §3.4 的四个响应头；人员显示名取自 `users` 表中出现的那些 id，没有对应行的照 id 显示 | 只输出 id：表格里无法辨认人 |
| c-23 | 多维表侧 kind 拒绝的判定与答复 | 按 id 形状判定、不查表；403 固定句 | 先读 `system_kind`：查询失败时只能在放行与 500 之间选 |
| c-24 | 盖章准入 | `task_projection` 只准盖在候选形 sheet id 上 | 不绑定：别的 provisioning 调用方可以给任意 sheet 盖上这个 kind |
| c-25 | 成员臂从真相表派生 | 允许的清单角色由 `TASK_ROLE_ABILITY` 的 `view` 列经清单角色桥算出 | 写死「任一角色」：真相表变了投影端不跟，门 19 投影端的从属链探针无从落地 |
| c-26 | 行级 deny 与会话租户 | 不改行级函数的签名；租户合取在能力层与列表层，行级只判成员与逐行 | 给十余个调用点都传会话租户：改动面大，效果相同（能力门已先拦下） |
| c-27 | 管理员成员与行级 deny | 沿用平台惯例：调用点对管理员跳过行级 deny（Q8） | 在每个调用点为任务 kind 取消跳过：约二十处改动 |
| c-28 | sweep 的宿主与旋钮 | `TaskScheduler` 新增 `postCommitJobs`；周期旋钮登记 manifest（AGENTS.md:68 与 `TASKS_SCHEDULER_INTERVAL_MS` 的先例；D8 写的是不进 manifest） | 把 sweep 塞进 `deliveryJob`：与投递 worker 的开关耦合；旋钮不登记：违背 AGENTS.md:68 |
| c-29 | sweep 的分段 | schema、缺行、孤儿、轮转四段共用每次 200 个 pair 的上限（D8，`ASSUMPTION`） | 只轮转映射表：找不到新 pair |
| c-30 | `last_error` 的码 | 闭集 `PROJECTION_RECONCILE_FAILED`、`PROJECTION_IDENTITY_MISMATCH`、`PROJECTION_WRITER_BLOCKED`、`PROJECTION_RECORD_CONFLICT` | 记原始错误：违反该列的固定码 CHECK 与「证据不带值」 |
| c-31 | 投影写的副作用 | 不写多维表 revision、不发多维表实时事件、不触发自动化 | 走记录写服务：每次对账都产生用户可见的修订与通知 |
| c-32 | 门 19 投影端的格名 | `gate19m5\|<身份>\|projection`，与 `gate19\|` 分开计数 | 并入 `gate19\|`：`i-m2` 清单的 diff 会把它们当成漏格 |
| c-33 | fence 步的证据 | 只在 `isWriterFenceEnabled()` 为真时记录 rank 2；`tasks-realdb` 对锁序文件跑两遍（开关关、开各一遍） | 只在 fence lane 跑：默认 lane 的锁序没有证据 |
| c-34 | 依赖链接的写法 | 按源记录整组替换；前置尚未投出时仍按确定性记录 id 写链接（`foreign_record_id` 没有外键，§6.3） | 等前置投出再写：要在两个 pair 之间排序，并多一种延后状态 |

（共 34 项。）

> 第 1 轮修订：仍是 34 项，不新增编号；`c-06`、`c-07`、`c-09`、`c-13`、`c-27`、`c-28` 六项的缺省或出处以 §10.3 为准。

### 9.2 任务 E 的未决项（只影响 PR-4c 的部分）

缺省的取法：**涉及安全规则的偏离，缺省取已裁原文；只影响呈现的偏离，照 PR-4a 对 X3 的先例，缺省取 #6249 的现行代码。** 两种都只是缺省，不是已定值。

- **X1（S05：混合清单里不带时刻的开始）**：`task-projection.ts:405-410` 的 `projectDate` 在 `dateTime` 列里把不带时刻的开始取为当天 00:00（`:408`），S05 的已裁文字是开始与截止都取当天最后一毫秒。缺省：照现行代码（只影响甘特条的画法）。owner 若取 S05 的字面读法，改 `:408` 一行与对应单测，门 31 的翻转格随之改期望。
- **X2（S10 / D11：导出的数值格）**：见 §7.3。缺省：已裁取值（每格都经 `sanitizeCsvCell`），PR-4c 删去 `task-export.ts:97`；owner 若接受 X2，不删这一行，门 32 的数值格改期望。
- **任务 E §7 问题 2（导出时区）**：缺省照现行代码，UTC 加表头注明（§7.2）。备选：按任务自己的时区（要另加一列时区）；按导出者的时区（路由读查看者时区头）。
- **D 编号**：本文用到的 D7、D8、D9、D11、D12、D17、D19、D20、D21 都没有被点名，是缺省约束（正文每处写 `ASSUMPTION`）。其中本文偏离的有两处：D7 的「GET 时补建视图、按标记键查」（`[c-09]`）与 D8 的「周期旋钮不进 manifest」（`[c-28]`）。owner 若认为 D 编号随对应的 S 编号一并获准，需要点名。
- **第 1 轮修订：对已裁 S 取值的偏离**。上一条把 `[c-09]` 与 `[c-28]` 只记成对 D7、D8 的偏离，不准确：两处偏离的都是已裁的 S04、S07 的取值；另有 `[c-13]`（S04）与 §3.3 的版本来源（S06）落在已裁取值之内。四处的缺省、理由与对应的问题 Q10–Q12 见 §10.2 R5。这几处不是任务 E 的偏离，上面「缺省的取法」那一句不管它们；R5 写明管它们的规则。

### 9.3 owner 问题

- **Q1 X1 的取值**（§9.2）：照现行代码（开始取 00:00），还是照 S05 的字面（开始与截止都取最后一毫秒）？
- **Q2 X2 的取值**（§7.3、§9.2）：保持已裁的逐格中和（缺省），还是接受数值格例外？
- **Q3 导出时区**（§7.2、§9.2）：UTC 加表头注明（缺省）、任务时区、还是导出者时区？
- **Q4 回写路由**（`[c-16]`）：门 10 P2 子集要求的「投影写回 recordId 解析失败 422」需要一个收到记录 id 的服务端写路径。本文的缺省是 §3.3 的路由，FE-f 的拖拽改期与看板拖拽都经它，而不直接调任务接口。若 owner 希望前端直接调任务接口，门 10 的这一格就没有服务端产生处，需要另行修订该格。
- **Q5 `TaskScheduler` 的提交后作业列表**（`[c-28]`）：这是对 PR-3b 已合入模块的形状改动，PR-4b 的 GC 作业也要用。缺省：两张中先合入的那张带这一改动，另一张 rebase；回归含 `M4|25|整门`。请 owner 确认，或指定由哪张承载。
- **Q6 映射表的巡检索引**（§2.3 第 4 条）：sweep 的轮转按 `last_projected_at` 取最旧的若干行，PR-4a 的迁移里没有这一列的索引。缺省：不加索引，靠每次运行的上限约束扫描；若要加，是对 PR-4a 冻结迁移的改动（加在 PR-4a 的那一个迁移里），需要 owner 点名。
- **Q7 PR-4a 实现上的两个接口要求**：(a) provisioning 要在 `withOrgStructure` 的同一事务、同一包装器实例上续取 rank 2 与 rank 3（§6.2）；PR-4a §4.2 冻结了「每个事务一个实例」，没有写怎样交给回调。缺省：回调收到的 `db` 带上本事务的实例。(b) 三个翻转写入点要把派生出的新一期记进交接（§6.4 触发表），而新一期的 id 只在 PR-4a 的 `spawnNextOccurrenceIfDue` 里产生，PR-4a 没有冻结它的返回值。缺省：它把新一期的 id（不派生时为 `null`）返回给写入点。两项都是对 PR-4a 实现的要求，不改它冻结的表与路由；owner 若认为它们属于 PR-4a 冻结的形状，请在 PR-4a 上点名。
- **Q8 管理员成员与行级 deny**（`[c-27]`）：缺省沿用平台惯例，残留为「身为成员的管理员在对账删掉之前还看得到软删或移出的行」。是否要求在各调用点为任务 kind 取消跳过？
- **Q9 S27 的聚合类残留**（`[c-11]`、§4.4）：读时遮罩覆盖看字段可见性的读路径；不看字段可见性的聚合类读路径，在解绑到 schema 步重投之间仍可能用到旧值。缺省：接受这一有界窗口并在 PR 正文写明；还是要求在这些路径也加遮罩？
- **第 1 轮修订：Q8、Q9 改写，新增 Q10–Q12**（理由见 §10.2 R4、R5、R8）。
  - **Q8（改写）**：S02 的人口没有管理员例外，缺省改为逐行臂对身为成员的管理员同样生效（§10.2 R4）。请 owner 确认；若改取平台惯例（调用点对管理员跳过），PR 正文须写明这一残留在 S30 真值表的「调度器关」一行下没有上界。
  - **Q9（改写）**：按 `906840c74c` 的枚举，没有找到不看字段可见性的读行数据路径（§10.2 R8），所以读时遮罩之外的残留目前为空；这一残留不受 sweep 封顶（调度器关时 sweep 不跑）。缺省：不另加遮罩，实现开工时按当时 main 重新枚举，若有新路径不看字段范围，在该路径补上遮罩。请 owner 确认。
  - **Q10 S04 的两处读法**：(a) 视图查找键（`[c-09]`）：缺省用确定性 id 查找，读时缺视图即幂等补建（补建回到 S04）；备选是按 S04 用 D7 的标记键查找。(b) 开启投影的同步范围（`[c-13]`）：缺省把 S04 的「开通加全量对账」读成请求内开通、提交后交接全清单对账、`pendingRows` 报告尚未投出的行数；备选是请求内同步投出全部行。两项各请 owner 点名。
  - **Q11 S06 的版本来源**：缺省回到 S06 的取值，客户端的 `expectedVersion` 取投影只读列 `taskVersion`，409 后刷新投影、重试一次；响应体照样带写后的 `version`。备选（本文 v1 的写法）：同一记录的紧接着一次回写用上一次响应里的 `version`，这一写法是对 S06 的偏离，须 owner 点名。
  - **Q12 S07 的旋钮登记**：缺省登记 `TASKS_PROJECTION_SWEEP_INTERVAL_MS` 进 manifest，理由是仓库规则（AGENTS.md:68：新的环境开关一律登记）与 `TASKS_SCHEDULER_INTERVAL_MS` 的先例（它同样是周期旋钮，已登记，并在 manifest 测试的非布尔允许集里）；这与 S07 的取值相反，须 owner 点名。备选：照 S07 不登记、也不进非布尔允许集；manifest 测试对任务前缀只扫 `*_ENABLED` 与该允许集，所以不登记不会让它变红，但与 AGENTS.md:68 不符。

### 9.4 锁修订里本文承载的行

PR-4a §7.3 已提问「候选门行写进 `arm-set` 的那次修订由哪张 PR 承载、何时提交」，本文不另起问题，只列出本文承载、需要那次修订一并写入的内容：门 31（M5-e）、门 32（M5-f）两行（PR-4c 合入之前记 NOT RUN），以及 M5-g 的门 1 / 2 / 13 / 17 / 18 / 20 子集中归本 PR 的格。既有的 `M5|7|src/multitable/task-*`、`M5|7|锁序控件` 的 fence 步、`M5|9|整门`、`M5|10|P2子集` 的 recordId 格、`M5|19|投影端` 已在 `arm-set` 里，本 PR 直接计分。

---

## 10. 第 1 轮独立审阅的处置（2026-10-12，DRAFT v2）

一次独立审阅提出 26 条：1 条 P1、5 条 P2、8 条 P3、12 条 NIT。逐条对照 `origin/main` `906840c74c`、PR-4a 冻结稿 head `7f1c4c536f`、#6249 head `39a2a29be9` 与 main 上的锁文件核过之后处置如下，全部采纳（其中一条建议的一个分句不采纳，见 #2）。本次只追加文本：正文原句不改写，被修订之处后面加一行「第 1 轮修订」指针，**正文与本节不一致时以本节为准**。自选仍是 34 项（不新增 `[c-NN]`，6 项的缺省或出处有变，§10.3）；owner 问题由 Q1–Q9 增为 Q1–Q12（§10.4）。

### 10.1 处置表

| # | 级别 | 意见 | 处置 |
|---|---|---|---|
| 1 | P1 | 本文把 `GET /context` 列为第四个夹钳点，却只夹钳它返回的能力对象，没有要求它按夹钳结果拒绝；门 19 的拒绝路由与存在性格都不含 `/context` | 采纳：R2。候选形 sheet 上，`/context` 在对该 sheet 做任何读之前按任务夹钳的 `canRead` 拒绝，三种入口形式一致；base 级的 sheet 列表只留调用者读得到的候选形 sheet；门 19 加 `/context` 的拒绝格与存在性格，门 31 的对拍格保留 |
| 2 | P2 | §4.5 的 kind 拒绝表没有评论写入口，评论写在投影 sheet 上没有按 kind 的拒绝；收件箱的行级批量判定没有任务臂 | 采纳：R3。六个评论写入口在候选形 sheet 上于共享拒绝点按 kind 拒绝，与评论写码无关；收件箱的批量判定把候选形 sheet 当作行级受限；门 31 加评论写格，门 19 加收件箱格。建议里「行上的已读标记也拒绝」一句不采纳：已读是每人自己的读状态、不是评论内容，而写全拒绝之后投影 sheet 上本就不会有评论 |
| 3 | P2 | `[c-27]` 让身为成员的管理员跳过逐行臂，S02 的人口没有这一例外；所说「到对账为止」在调度器关或交接丢失时没有上界 | 采纳：R4。缺省改为逐行臂对管理员同样生效；调用点由扫描发现、不靠手写清单；Q8 改为请 owner 确认；门 19 加 `admin-member` 身份 |
| 4 | P2 | `[c-09]` 偏离的是已裁 S04 的取值（读时按标记键查视图、缺则补建），却只记成对 D7 的偏离 | 采纳：R5。读时补建回到 S04；查找键仍用确定性 id（理由见 R5），作为对 S04 的偏离记入 §9.2，成为 Q10 (a) |
| 5 | P2 | `[c-28]` 把旋钮登记进 manifest，偏离的是已裁 S07 的取值，却只记成对 D8 的偏离 | 采纳：R5。出处改为 S07；缺省仍登记（AGENTS.md:68 与 `TASKS_SCHEDULER_INTERVAL_MS` 的先例），成为 Q12 |
| 6 | P2 | fence 关时（缺省），行对账对 `meta_fields` 的共享行锁与 schema 步逐列 upsert 的行锁可以互等成环（40P01）；§6.6「schema 步从不等行对账」不成立，列出的锁序格也看不到它 | 采纳：R6。凡取 pair 锁的事务，先在同一事务里取本清单的哨兵键；行对账不再对 `meta_fields` 加行锁，目录比对在哨兵之下做；§6.6 的论证以 R6 为准；加双连接格 |
| 7 | P3 | 引用的 PR-4a head 已被取代；它冻结的绑定读序已收紧为 `position, field_id COLLATE "C"` | 采纳：R1、R9 |
| 8 | NIT | 门 10 的 recordId 格没有逐字对应锁 §7 点名的「listId 含 `__`」 | 采纳：R11 门 10 |
| 9 | NIT | §3.5 把 `ORG_MISSING` 与 `LIMIT` 归到 PR-4a | 采纳：R12 |
| 10 | NIT | 门 18 没写 manifest 测试的非布尔允许集；§2.2 没写 `meta_bases.workspace_id` | 采纳：R11 门 18、R12 |
| 11 | P3 | 任务臂须排在 deny 加载函数的任何早返回之前（含空 actor id），不只是在 `catch` 之外 | 采纳：R7 (a) |
| 12 | P3 | 门 19 缺记录级存在性格：候选形 sheet 上，按记录 id 寻址的每条读路由对存在与不存在的任务记录 id 都应得到同一个 403 | 采纳：R7 (c) 的规则与 R11 门 19 的格 |
| 13 | P3 | Q9 说窗口由 sweep 封顶，但调度器关时 sweep 不跑；枚举也找不到 Q9 担心的路径 | 采纳：R8；Q9 改写 |
| 14 | NIT | §4.1 没写身份复读的查询失败时怎么办 | 采纳：R7 (b)：一律抛出 |
| 15 | P3 | 引用的 PR-4a head 早于本文两次提交，其间 PR-4a 改了基线并加了 §8.5 | 采纳：R1（与 #7、#26 同一处理） |
| 16 | P3 | `[c-13]` 没有交代它怎样对应 S04 的「开通加全量对账」 | 采纳：R5；成为 Q10 (b) |
| 17 | NIT | §3.3 的标题把自选的路由与 S06 并列，读起来像已裁接口 | 采纳：R12 |
| 18 | NIT | `loadFieldPermissionScopeMap` 的行号范围多引了下一个函数的注释 | 采纳：R12 |
| 19 | P3 | 三处取舍落在已裁取值之内，却写成自选或只对 D 的偏离：`[c-13]`（S04）、§3.3 的版本来源（S06）、`[c-28]`（S07） | 采纳：R5；三处都记入 §9.2 的已裁取值偏离，成为 Q10–Q12；§3.3 的版本来源改回 S06 的取值 |
| 20 | P3 | 门 32 的「以 CR 开头 ⇒ 该格以 `'` 起头」在 RFC 4180 加引号之后不成立，对正确实现也会红 | 采纳：R11 门 32 |
| 21 | NIT | 门 18 旋钮的负控依赖一处没点名的非布尔允许集改动 | 采纳：R11 门 18（与 #10 同一处理） |
| 22 | NIT | fence 持有者台账的键取决于普查怎样解析包装器的 fence 步，本文没写 | 采纳：R11 |
| 23 | NIT | sweep 的周期怎样记账没写：不加表，作业上下文里也没有上次运行时刻 | 采纳：R10 |
| 24 | NIT | schema 步不更新 `meta_sheets.name`，清单改名的交接落不到投影 | 采纳：R9 |
| 25 | NIT | §8.4 没写每个任务真库文件都要导入 `assert-rbac-optional-off` | 采纳：R11 |
| 26 | NIT | 头部的 PR-4a head 仍是 `cdf7ddba87` | 采纳：R1 |

### 10.2 修订后的规则

**R1 PR-4a 的引用与基线（#7、#15、#26）**

- PR-4a 冻结稿以 head `7f1c4c536f` 为准，替代头部的 `cdf7ddba87`；它的基线现在也是 `906840c74c`，与本文相同。`cdf7ddba87..7f1c4c536f` 只改 PR-4a 设计文档一个文件：头部基线、§3.6 字段绑定的 `GET` 排序与表下一段、§4.1 的规划函数与规则 ③ 的范围、§8.4 末段，另加 §8.5。本文依赖的 §1.2、§2.9、§3.5、§4.2、§4.6、§6.1–§6.2、§7.2–§7.3 在两个 head 上逐字相同（按 diff 的块位置核过）。
- 头部第 5 行「`a1c0972918` 到 `906840c74c` 之间后端只改四个文件」作为事实仍成立，只是 PR-4a 已不再以 `a1c0972918` 为基线。
- 影响本文的收紧只有绑定排序，见 R9。PR-4a §4.1 另写明它对 `services/task-scheduler.ts` 只改 `:428` 那一行取锁入口；本文的 `postCommitJobs` 是另一处改动（Q5）。

**R2 `GET /context`（#1）**

只对候选形 sheet 生效，不改其他 sheet 的行为：

1. 入口形式：`sheetId` 是候选形；`viewId` 解析出的 sheet 是候选形；`baseId` 是任务基座候选形。派生形的视图 id（`<候选 sheet id>__view_<kind>`，`[c-09]`）按 id 形状直接认定所属 sheet，不先读 `meta_views`；其他形状的视图 id 照常解析，一旦解析出候选形 sheet，就在其后的任何读之前拒绝。
2. `sheetId` 与 `viewId` 两种形式：在 `/context` 对该 sheet 做任何读（存活判定、sheet 行、视图配对、视图、字段与字段权限）之前，按 §4.2 算出任务夹钳的 `canRead`（身份、成员臂、会话租户）；为假 ⇒ 403，答复体与记录读路由相同：`{ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }`。候选形但不存在的 sheet id 身份不成立，按非成员处理，得到同一个 403。
3. `baseId` 是任务基座：响应里的 `sheets` 与缺省选中的 sheet 都只取调用者读得到的候选形 sheet（与 §4.3 修补后的 `filterReadableSheetRowsForAccess` 同一判定）；一张都读不到 ⇒ 同一个 403（与 §4.3 的 `resolveBaseReadableForAccess` 一致）。在任何 base 的 sheet 列表里，候选形 sheet 都只留给读得到它的调用者。
4. 能读的成员得到的能力对象仍经任务夹钳（§4.2 表第四行），门 31 的对拍格不变。
5. 身份复读的查询失败照 R7 (b) 抛出。

**R3 评论写与评论收件箱（#2）**

- 六个评论写入口——建（`routes/comments.ts:758`）、改（`:811`）、删（`:838`）、加反应（`:877`）、去反应（`:899`）、解决（`:941`）——在候选形 sheet 上于共享拒绝点 `refuseCommentWriteOnReadOnlySheet`（`:242`，六个入口都已在读门之后调用它）拒绝：位置在读门之后、任何写之前，与全局评论写码无关，判定按 sheet id 形状（按评论 id 寻址的入口取该评论所在的 sheet id）。答复是 §4.5 的 403 固定句（`[c-23]`）。
- 已读类入口（单条已读、提及汇总已读、整表已读）不变：它们改的是每个人自己的读状态，不是评论内容；且投影 sheet 上的评论写从一开始就被拒绝，不会有评论可读。
- 收件箱：`loadInboxRowDenySheetIds`（`:306-330`）在查询之前按 id 形状把候选形 sheet 算作行级受限，与 §4.4 对 `loadRowLevelReadDenyEnabled` 的规则相同；收件箱为候选形 sheet 建的行级允许集对管理员同样建（R4）。

**R4 逐行臂与管理员（#3；`[c-27]` 的新缺省，Q8）**

- 规则：在候选形 sheet 上，逐行臂对管理员同样生效。成员臂本来就不放行非成员管理员（§4.2）；本条补上身为成员的管理员：任务软删或移出清单后，他在下一次读即读不到那一行，与普通成员相同。这一缺省按 S02 的人口（没有管理员例外），Q8 请 owner 确认。
- 写法：在 `permission-service.ts` 加一个共享谓词 `rowLevelReadDenyApplies(access, sheetId)` = `!access.isAdminRole || isTaskProjectionSheetIdCandidate(sheetId)`；凡以管理员标志决定是否执行行级 deny 的调用点，都改用这个谓词。其他 kind 的行为不变。
- 调用点的人口由扫描发现，不靠手写清单：一个静态单测扫 `packages/core-backend/src`，找出调用 `loadRowLevelReadDenyEnabled`（含 `Strict`）、`loadDeniedRecordIds`、`hasRecordPermissionAssignments`、`loadRecordPermissionScopeMap`、`isRecordReadDeniedForUser`（含 `Strict`）的每个函数；其中以管理员标志决定是否执行 deny 的，必须经共享谓词。按 `906840c74c` 已知在这一人口里的有：`routes/univer-meta.ts` 的单记录、按时间点读、仪表盘、导出、视图聚合、记录列表、记录汇总各处，`routes/comments.ts:221` 与收件箱 `:385` 的管理员分支，`routes/dashboard.ts:112`，`multitable/history-projection.ts:124` 对管理员的整体早返回（改为按 sheet 判定）。实现时以扫描结果为准；扫描找到的数目写进 PR 正文。
- 格：门 19 加 `admin-member` 身份（R11）；负控：把任一调用点改回只看管理员标志 ⇒ 静态格红，且该路由上的 `admin-member` 格红。

**R5 对已裁 S 取值的偏离与读法（#4、#5、#16、#19；Q10–Q12）**

管这几处的规则：它们不是任务 E 的偏离，§9.2「缺省的取法」那一句不适用。本文的规则是：缺省回到已裁取值，除非有具体的缺陷或仓库规则作理由；保留本文取法的，写出理由，并列成 owner 问题，在点名之前都不算已定。

- **视图（S04；`[c-09]`；Q10 (a)）**：读时补建回到 S04。`GET …/projection` 在 `enabled` 为真且有视图缺失时，在读之后另起一个事务：`READ COMMITTED` → [rank 2 fence(sheet)] → rank 3 清单哨兵键 → 用 schema 步的同一个确保函数按确定性 id `ON CONFLICT (id) DO NOTHING` 补建 → 提交；不写事件；补建失败时本次答复里该视图 id 为 `null` 并记一条固定码日志，不让一次读因修补失败而失败。查找键保留确定性 id，这是对 S04 的偏离，理由是缺陷：清单 `editor` 可以改视图（`canManageViews`），视图的改写在请求体带 `config` 时整体取代存值（`PATCH /views/:viewId`，`routes/univer-meta.ts:15400` 起，`906840c74c` 核过），D7 的标记键随之丢失，按标记键查找就会在每次 GET 时再补建一张重复的视图；确定性 id 不受影响。`config` 里仍写 D7 的标记键。§3.2 的「视图 id」「副作用」两行与 §9.1 `c-09` 以本条为准。
- **开启投影的同步范围（S04；`[c-13]`；Q10 (b)）**：缺省不变，这是对 S04 的一种读法：S04 要求开启时开通并做全清单对账；本文在请求内开通，提交后把整张清单交给运行器对账（§6.4 的 `lists` 范围），`pendingRows` 报告尚未投出的行数，请求不等行投完。理由：大清单同步投出的请求时长不可控。备选是请求内同步投出。
- **回写的版本来源（S06；Q11）**：缺省改回 S06 的取值：客户端的 `expectedVersion` 取投影只读列 `taskVersion`；409 ⇒ 刷新该清单的投影、重试一次。成功体照样带写后的 `version`（只是信息）。§3.3「成功体」一行里「下一次的 `expectedVersion` 取这个值」不再是缺省，改为 Q11 的备选（同一记录紧接着的下一次回写用上一次响应里的 `version`，避免投影还没追上时的必然 409），须 owner 点名。门 31 的「内容」格相应改为：只改两次描述、对账完成之后，用投影的 `taskVersion` 改期 ⇒ 首发成功（D9）。
- **sweep 旋钮的登记（S07；`[c-28]`；Q12）**：出处改为 S07（D8 只是复述）。缺省仍登记进 manifest，理由是仓库规则（AGENTS.md:68：新增的环境开关必须登记）与 `TASKS_SCHEDULER_INTERVAL_MS` 的先例；这与 S07 的取值相反，须 owner 点名。

**R6 对账的锁序（#6；`[c-06]`、`[c-07]` 的新缺省）**

- 规则：凡取 pair 锁（`acquireTaskProjectionLock(query, listId, taskId)`）的事务，都先在同一事务里、经同一个包装器实例取本清单的哨兵键（`acquireTaskProjectionLock(query, listId, listId)`），再取 pair 锁。两者都是 rank 3；PR-4a §4.2 的包装器只在 rank 递减时抛，3 → 3 允许。这适用于 §6.3 的每一个调用方：运行器、sweep 的四段（含孤儿段对没有映射行的 `meta_records` 的清理）。
- 行对账不再对 `meta_fields` 加行锁（§6.3 第 3 步的 `FOR SHARE` 取消）：在哨兵之下按普通读取出列目录并比对。投影 sheet 上写 `meta_fields` 的只有 provisioning 与 schema 步，两者都持本清单的哨兵（多维表的字段写入口对候选形 sheet 一律拒绝，§4.5），所以行对账持哨兵期间列目录不会变。
- 无环（替代 §6.6 第三条）：投影的每个事务都在写任何行之前按 [rank 2 fence(sheet)] → rank 3 清单哨兵 → [rank 3 pair] 取齐 advisory 锁。同一清单里，凡写 `meta_fields`、`meta_views`、`meta_records`、`meta_links` 或映射行的事务都持这把哨兵，所以同一时刻至多一个，它们之间没有行锁等待。不同清单的这些行互不相交（按 sheet 或 `list_id` 划分；依赖链接只连本清单内的记录，S05）。provisioning 另持 rank 1，同 org 的两次 provisioning 在结构锁上串行；行对账、schema 步与 GET 的补建都不取 rank 1。任务写入点只取 rank 1、不碰 `meta_*` 与映射表。
- 取锁序列（替代 §6.6 表与 §8.1 的对应项；`/` 前为 fence 打开时）：行对账 [2, 3(清单), 3(pair)] / [3(清单), 3(pair)]；schema 步不变 [2, 3(清单)] / [3(清单)]；provisioning 不变；GET 的读时补建 [2, 3(清单)] / [3(清单)]。
- 代价：同一清单的行对账跨实例逐个进行，并与 schema 步、GET 补建互斥；每个实例的运行器本就单并发，sweep 在 leader 上与之争同一把哨兵。pair 锁保留，作为 PR-4a §4.2 投影锁的单位；在本规则下它对串行不再是必需的。
- 格：`M5|7|锁序控件` 的行对账正向序列改为 `[3, 3]`（默认 lane）与 `[2, 3, 3]`（fence lane）。另加双连接格（照门 6 的持锁法）：连接甲跑 schema 步，取到哨兵后由夹具停住；连接乙对同一清单的一个 pair 跑行对账，断言乙在 advisory 锁上等待（`pg_locks` 里乙等的是 advisory 锁，不是行或表锁）；甲提交后乙继续并按新目录投出该行；全程没有 40P01。负控：去掉行对账里的哨兵 ⇒ 乙不在 advisory 锁上等 ⇒ 红。

**R7 行级与身份判定的补充（#11、#12、#14）**

- (a) 空 actor id：在 `loadDeniedRecordIds` 与 `loadRecordPermissionScopeMap` 里，候选形 sheet 的任务臂是第一步，排在任何早返回之前：空 actor id ⇒ 请求的每条记录都被拒（`loadDeniedRecordIds` 未给记录 id 列表时为该 sheet 的全部记录；范围表对每个请求的 id 给合成的 `'none'`）；请求的 id 列表为空时范围表照旧为空。经它们得到的 `isRecordReadDeniedForUser`（含 `Strict`）随之成立。§8.5 加单测格。
- (b) 身份复读的查询失败一律抛出：四个能力解析器、三个列表闸、`/context` 与评论收件箱都同一口径，错误原样上抛（路由上是 500），不折成「非成员」或「隐藏」。查询成功但身份不成立时，照 §4.1 按非成员处理并记固定码日志。§8.5 加单测格：身份查询抛错 ⇒ 解析器与列表闸都抛。
- (c) 记录存在性：在候选形 sheet 上，所有记录读路由（列表、视图、单记录、记录历史、按时间点读等）的任务夹钳拒绝都排在该路由的任何读之前；非成员对存在与不存在的任务记录 id 得到同一个 403。

**R8 S27 的残留（#13；Q9 改写）**

- 读时遮罩加在 `loadFieldPermissionScopeMap` 上；按 `906840c74c` 的枚举，读行数据的路径——视图、记录列表、单记录、按时间点读、视图聚合、记录汇总、仪表盘与图表（`routes/univer-meta.ts` 与 `routes/dashboard.ts`）、多维表导出、表单上下文、链接选项、链接摘要、lookup / rollup、回收站、Yjs 读——都经 `loadFieldPermissionScopeMap` 或建在它之上的 `loadAllowedFieldIds`，所以遮罩对它们都生效。这次枚举没有找到不看字段可见性的读行数据路径。
- 因此 §4.4 末段的残留目前为空；它也不受 sweep 封顶：S30 真值表里调度器关时 sweep 不跑，运行器又是每实例、不持久的。实现开工时按当时 main 重新枚举；若出现不看字段范围的读行数据路径，在该路径补上遮罩。

**R9 绑定读序与 sheet 名（#7、#24）**

- §6.3 第 4 步与 §6.5 读绑定一律 `ORDER BY position, field_id COLLATE "C"`，与 PR-4a §3.6 `GET`（head `7f1c4c536f`）相同，也与 #6249 `task-fields.ts:592` 的码元比较同序；所以 schema 步算出的目录与行对账比对的目录不随数据库的缺省排序规则变化。
- schema 步在哨兵之下把 `meta_sheets.name` 更新为当前清单名（`name IS DISTINCT FROM` 新名时才写）；provisioning 的第 2 步在 sheet 已存在时做同一更新（§3.1 的幂等分支）。清单改名交接的 `lists: [listId]` 由此落到投影（`[c-12]`）。

**R10 sweep 的周期记账（#23）**

不加表，`TaskSchedulerJobContext`（`services/task-scheduler.ts:128-147`）也没有上次运行时刻，所以上次运行时刻只存在跑 sweep 的那个实例的内存里（作业对象的状态）。重启或 leader 更替会清掉它：更替后的第一个 leader tick 不论旋钮都跑一次；leader 来回切换时，sweep 的实际间隔可能短于所配周期。sweep 幂等、每次至多 200 个 pair，这可以接受；PR 正文照实写明。不取「由 `max(last_projected_at)` 推出」：那一列也随运行器的每次对账前进，量不出 sweep 自己的周期。

**R11 门与测试的增补**

- 门 10：加一格，名字照锁 §7：listId 段含 `__`（在真实的 `<L>` 中间插入 `__` 构造）⇒ 422 `INVALID_RECORD_ID`。
- 门 18：同一 PR 把 `TASKS_PROJECTION_SWEEP_INTERVAL_MS` 加进 manifest 测试的 `TASKS_NON_BOOLEAN_FLAGS`（`scripts/ops/global-history-flag-manifest.test.mjs:164`；任务前缀的扫描只收 `*_ENABLED` 与这个允许集，`:372`，不加则扫描看不到它，manifest 里那一条会被判成没有读点），并照 `TASKS_SCHEDULER_INTERVAL_MS` 那一格（`:220-236`）加这个旋钮自己的一格：数值型、缺省 300000、来源指向它的解析函数、`dependsOn` 列 `TASKS_PROJECTION_ENABLED` 与 `TASKS_SCHEDULER_ENABLED`、缺省值不算开启。「删掉任一条 ⇒ 红」的负控在这一改动之后才成立。本条以 Q12 的缺省为前提。
- 门 19：加 `admin-member` 身份（平台管理员、清单 `read` 成员）：记录读只含 L 中在册且未软删的行；软删格与移出格当即不含那一行（不注册运行器）。`/context`：其余身份（含 `admin-not-member`、`second-tenant`）以 `sheetId`、派生视图 id、任务基座 `baseId` 三种形式调用 ⇒ 403（记录读路由的答复体）；存在性格：存在与不存在的候选形 sheet id ⇒ 同一个 403；成员以任务基座 `baseId` 调用 ⇒ `sheets` 只含他是成员的清单。按记录 id 寻址的每条读路由（单记录、记录历史、按时间点读等）：非成员对存在与不存在的任务记录 id ⇒ 同一个 403。收件箱：夹具直发 SQL 在 T1、T2 的行上各放一条评论，成员 V 与 `admin-member` 的收件箱都只含 T1 那一条。负控：把 `/context` 的任务拒绝挪到读 sheet 行之后 ⇒ 不存在的 id 答复不同 ⇒ 存在性格红；把收件箱批量判定的任务臂去掉 ⇒ T2 那条出现 ⇒ 红。
- 门 31：评论写格：身为 `editor` 且持评论写码的成员、`admin-member` 各一组，对候选形 sheet 建、改、删、加反应、去反应、解决 ⇒ 403 固定句（改、删、反应、解决用夹具直发 SQL 放好的评论）。负控：去掉共享拒绝点里的候选形判定 ⇒ 建评论那一格变 200 ⇒ 红。
- 门 32：`=`、`+`、`-`、`@`、TAB 开头的格断言原始格以 `'` 起头；CR 与 LF 开头的格断言去掉 RFC 4180 引号之后的文本以 `'` 起头（`sanitizeCsvCell` 先中和、后加引号，`services/csv-cell.ts:258-259`）。
- `M5|7|锁序控件`：见 R6。
- §4.8 fence 持有者台账：包装器的 fence 步必须是普查解析得到的调用（具名导入或 `this.` 方法，`tests/unit/multitable-field-schema-fence-recheck.guard.test.ts:29-39` 跟随的那几种）；三行台账的键以 `runFenceHolderCensus` 对三个站点实际报出的为准，与本文写法不同时以普查为准。
- §8.4：每个新的 `task-*.db.test.ts` 都导入 `assert-rbac-optional-off`（`tests/unit/task-ci-coverage-enumeration.test.ts:46-51` 逐文件检查）。
- §8.5：R7 (a) 的空 actor 格；R7 (b) 的身份抛错格；R4 的调用点扫描格。

**R12 文字更正（#9、#10、#17、#18）**

- §3.5 沿用码的出处：`ORG_MISSING` 是 M2 起的 org 规则；`LIMIT` 是 M4 的码；`INVALID_VALUE`、`NOT_IN_OPTIONS` 由 PR-4a §3.9 新增。
- §2.2 `meta_bases`：`owner_id` = `TASK_PROJECTION_SYSTEM_OWNER`，`workspace_id` = `NULL`，照学习统计投影（`services/elearning-stats-multitable-projection.ts:308-310`）与备料系统基座（`multitable/provisioning.ts:297`）的先例。
- §3.3 标题：这条路由是本文的自选（`[c-16]`，Q4）；S06 的闭集点名的写目标是任务路由本身（`PATCH /api/tasks/:id`、清单分组放置、字段取值），本路由只解析记录 id 并委托给它们，锁 §7 的写路径 422 由它产生。
- §4.4：`loadFieldPermissionScopeMap` 的位置更正为 `permission-service.ts:863-917`。

### 10.3 自选项的变化（仍是 34 项）

| 编号 | 变化 |
|---|---|
| c-06 | 清单哨兵键也是行对账的串行点：凡取 pair 锁的事务都先取它（R6） |
| c-07 | 不再对 `meta_fields` 加行锁；目录比对在哨兵之下做（R6） |
| c-09 | 读时补建回到 S04；查找键仍是确定性 id，是对 S04 的偏离（R5，Q10 (a)） |
| c-13 | 缺省不变，记作对 S04 的一种读法（R5，Q10 (b)） |
| c-27 | 缺省改为逐行臂对管理员同样生效；原缺省成为备选（R4，Q8） |
| c-28 | 出处改为 S07（不只是 D8）；缺省仍登记（R5，Q12） |

### 10.4 owner 问题的变化

Q1–Q7 不变；Q8、Q9 改写，Q10–Q12 新增，文字都在 §9.3 末条。共 12 个问题。
