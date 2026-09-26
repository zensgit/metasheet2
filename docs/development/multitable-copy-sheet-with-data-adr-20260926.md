# 「复制数据表（含数据）」设计锁 ADR（2026-09-26，r2）

> 状态：**设计锁（Design Lock）**，docs-only，不含实现。r2 = 两轮评审（各 3-4 blocker、9-13 should-fix）后的修订；处置表见附录 C。
> 基线：`origin/main` @ `51acbb18f`；r2 复核于 `origin/main` @ `3fd352457`（`git diff --stat 51acbb18f 3fd352457 -- <附录 A 所引后端文件>` 为空，行号两处同时成立）。main 前进后按符号名重定位，合并前 rebase 重跑。
> owner 决定（2026-09-25，记录于 PR #6074 `customer-anomaly-triage-20260924.md` §2.8 与 §3-B、issue #5864 讨论）：**「复制数据表（含数据）」作为独立功能开发；复制时保留表权限与字段权限；模板入口可以提供复制数据的选项。默认的模板本身仍然不带数据：共享模板带数据会越过权限，所以带数据只能走「复制」动作，并且要校验复制者对源数据的读权限。**
> 标 `Ratified-by-default-2026-09-26` 的条目按 AGENTS.md「默认前进 + 24h 异步否决」执行，且只用于**收紧方向**的 T 层取值；放宽方向一律进 §11 先批后动。Refs #5864、#5909、#5861。

## 0. 一句话

服务端新增「复制数据表」动作：以复制者对源表的**全表读**（现成的 `hasFullTableReadAccess` 三轴门）为门、对目标 Base 的 `resolveBaseWritable` 为门，在**一个 REPEATABLE READ 事务**里建新表（结构 + 视图 + 表级/字段级/记录级授权与行级规则**逐行复制、id 全部 remap**），经 `RecordService.createRecord` 的**复制扩展**逐行写入数据（一个 batch、序数时间戳、保留 `created_by`、不发任何逐行事件），提交前断言「新表拒绝集 = 源表拒绝集的映射」，否则回滚。复制物是**非托管快照**，永不进模板中心、永不登记到插件、插件作用域拒绝访问。「带数据」永远是复制**动作**，不是模板**内容**。切片 1 只做**同 Base**、只做 `inherit` 权限模式。

## 1. 现状与约束（读码结论）

1. **模板 values-free 是按构造证明的**：`POST /templates` 只 SELECT 四张结构表、不碰 `meta_records`（`packages/core-backend/src/routes/univer-meta.ts:8190-8193`）；抽取器白名单 property、丢 filter/sort、所有 id 重编号（`packages/core-backend/src/multitable/custom-template-store.ts:9-17`）；link/lookup/rollup/formula 降级为文本（`:106`）。本 ADR **不改**。
2. **模板反查不到源表**：源 sheet/field/view id 一个都不落进模板 JSON（`custom-template-store.ts:16-17`）。「使用模板 + 带数据」只能靠新增 provenance（§9 S4）。
3. **「使用模板」只能新建 Base**：`baseId` 省略即 mint 新 id（`packages/core-backend/src/multitable/template-library.ts:579`），落已有 Base 撞 `Base already exists`（`:591-600`）；四个前端调用面都不传 `baseId`（issue #5909；`apps/web/src/multitable/composables/useTemplateInstall.ts:38-41`）。本 ADR 不改 `installMultitableTemplate`。
4. **客户临时办法「导出 → 导入」不继承权限**（triage §2.8 `:190`）：`import-xlsx` 逐行 `createRecord`（`univer-meta.ts:15768-15772`），`POST /sheets` 只写 `meta_sheets` + 默认视图 + 视图 create 修订、不写任何授权行（`:15638-15684`）。这正是本功能要关掉的洞——所以任何「复制表比源表更公开」的模式都与目标相反（§4.5）。
5. **单条记录复制先例** `POST /records/:recordId/duplicate`（`univer-meta.ts:19301`）：源读门 `requireRecordReadable`（`:19342`），链接值从 `meta_links` 覆盖（`:19358`），跳过 property-hidden 字段（`:19369`），只复制「可读 ∧ 可写」字段（`:19371-19378`），再 `new RecordService(pool, eventBus)`（`:19383`）→ `createRecord`（`:19387`）。
6. **记录写路径唯一入口** `RecordService.createRecord`（`packages/core-backend/src/multitable/record-service.ts:534`）：输入类型 `RecordCreateInput = { sheetId, data, actorId, capabilities, oapiAudit? }`（`:226-233`）；`canCreateRecord` 门（`:545`）；`recordId = rec_<uuid>`（`:550`）；写围栏（`:561-575`）；系统/派生只读字段**拒绝**写入（`:609-611`，autoNumber 在 `SYSTEM_FIELD_TYPES`，`field-codecs.ts:1155`）；person 名册校验（`:613-621`）；select 非字符串即拒（`:624-626`）、选项不在集合即拒且**消息带值**（`:629`；link 缺失亦带 id，`:665`）；`validateRecord` 执行 `property.validation`（`:483-497`、`:716-722`）；`INSERT` 不写 `created_at`、`created_by = actor`（`:739-744`；`created_at DEFAULT now()`，`zzzz20260404153000_repair_meta_core_schema.ts:26`）；修订 `source: 'rest'` 硬编码、无 `batchId`（`:774-785`）；`enqueueRecordEventIfDurable`（`:797`）；提交后 formula hook（`:803-819`）、`publishMultitableSheetRealtime`（`:821`）、**`emitRecordEventIfLegacy`（`:837`）**。`RecordValidationError` 只有 `message + code`、无 `fieldId`（`:161-169`）。任何绕开它的批量 INSERT 不在本设计内；本 ADR 锁一个**扩展**（§7.3）。
7. **权限表与读侧合成**：`spreadsheet_permissions` 主键 `(sheet_id, subject_type, subject_id, perm_code)`（`zzzz20260406030000_add_spreadsheet_permission_subjects.ts:63-65`），写入时同时填 legacy `user_id`（user 主体）且 code 为 `spreadsheet:read|write|write-own|admin`（`univer-meta.ts:9429-9439`；`permission-service.ts:166-172`）；`accessLevel='none'` 只删行、**没有表级 deny**（`:9428`）。`field_permissions` `visible` 取 AND、`read_only` 取 OR（`permission-service.ts:859-900`）。**`hasAssignments` 是按行动者算的**：`loadSheetPermissionScopeMap` 只 SELECT 命中当前用户主体的行（`:728-752`），`hasAssignments = codes.length > 0`（`:317`）；无行者拿到全局能力（`applySheetPermissionScope`，`:1479-1485`），有行者能力与授权取交、`canCreateRecord = 全局 ∧ (canWrite ∨ canWriteOwn)`、`canManageSheetAccess = scope.canAdmin`（`:1486-1494`）、`canManageFields` 由 scope 全写授予（`:1553-1565`）。write-own 行策略以 `meta_records.created_by === userId` 判 creator（`:1603-1608`、`:1636`）。
8. **行级读拒绝**：`record_permissions.access_level='none'` 是 deny（`zzzz20260617140000_rowlevel_read_deny_foundation.ts:22-24`），只在 `meta_sheets.row_level_read_permissions_enabled` 为真时生效（`permission-service.ts:916-919`）；deny 集 = grant-deny（user/member-group/role 主体，`:1200-1256`）∪ rule-deny（`conditional_read_rules` 对**存储数据**逐行求值，`:1338-1356`）；**字段缺失的规则 = DENY**（`:1332-1334`；`permission-rule-evaluator.ts:12-15`），autoNumber 是可入规则的数值类型（`:87`）；admin 绕过（`univer-meta.ts:10446`）；#18 无基数泄漏（`permission-service.ts:1282`）。
9. **现成的全表读门** `hasFullTableReadAccess`（`univer-meta.ts:7244-7263`，头注释 `:7225-7242`）：三轴 = ① 行级开关关或 admin（**只看开关不看数据**，因为 `loadDeniedRecordIds` 的规则臂读实时数据，用它做 403/200 边界会变成 1-bit 数据探针）② `field_permissions` 不遮任何字段 ③ formula 污点掩码不丢字段；**不回任何丢失计数**（无 oracle 面）。恢复路由用它做 DB-fresh 的事务内终审（`:7410-7433`）。
10. **托管表**：`plugin_multitable_object_registry` 以 `sheet_id` 为主键、只在 provisioning 事务写入（`packages/core-backend/src/multitable/sheet-delete-guard.ts:17-27`）；删表 409（`univer-meta.ts:15363-15364`）。**插件作用域**：源表限本插件（他人访问抛错，`packages/core-backend/src/multitable/plugin-scope.ts:266-269`），但**无 registry 行的表在默认 `observe` 模式下任何插件都可达**（`packages/core-backend/src/index.ts:2298-2308`；`pluginSheetScopeMode.ts:31-33`；registry 迁移头 `:13`「Missing registry rows are treated as legacy/unscoped and allowed」）。UI 无托管徽标（附录 B）。
11. **附件**：`multitable_attachments.sheet_id NOT NULL`、`storage_file_id` 唯一（`zzzz20260319103000_create_multitable_attachments.ts`）；`createRecord` 校验附件行属同 sheet，`field_id` 非空时须同 field（`attachment-service.ts:321-346`，NULL 放行 `:341-343`）；blob 有独立清理生命周期。复制表不能引用源附件行、不宜共享 blob。
12. **事件链**：`multitable.record.created` 路由到 `automation-record-trigger` 与 `webhook-event-bridge`（`automation-routing-manifest.ts:89`；`webhook-event-bridge.ts:42-47`）；`WebhookService.deliverEvent` 选**全部** active 且订阅该事件的 webhook、**无 sheet 过滤**（`packages/core-backend/src/multitable/webhook-service.ts:327-335`）；durable 路径只在 `AUTOMATION_DURABLE_DELIVERY_ENABLED === 'true'` 开（`automation-durable-delivery.ts:20-22`），默认走 legacy 逐行 emit（`automation-producer-emit.ts:63-72`），payload 含 `data: patch` 全值（`record-service.ts:555-560`）。
13. **异步作业**：无通用框架（附录 B）。可复用形状 `ai-bulk-job-service.ts`（`QueueService` 进程内 worker + header/rows 两表 + claim guard + cancel；`zzzz20260622120000_create_multitable_ai_bulk_job.ts:46-62`）。`workflow-job-contract.ts` 头注释称 contract-only（`:1-15`），但其状态词表**已被运行时 import**（`automation-job-service.ts:20`、`routes/automation.ts:30`、`ai-bulk-job-service.ts:71`）。
14. **去重先例** `template-install-dedupe.ts`：`pg_try_advisory_xact_lock` 必须是**同一事务的第一条语句**（`:38-44`），整段（锁 → 读账本 → 安装 → 写账本）在一个事务里（`:57`）；窗口 5 分钟（`:91`）、锁等待上限 15s（`:98`）。
15. **Time Machine / 配置历史**：`meta_record_revisions.batch_id` 一次动作一批，投影按 `COALESCE(batch_id, id)`（`history-projection.ts:5-9`）；`source` 开放字符串、`batchId` 可由调用方指定（`record-history-service.ts:20`、`:37`；`RecordWriteService.patchRecords` 已接受 `batchId`，`record-write-service.ts:299`、`:706`）。配置历史不变量 T9-R1：字段创建须同事务记 `field` create 修订（`univer-meta.ts:13570-13572`）；授权写记 `permission` 修订（`:9455-9466`、`:10139-10143`）；`POST /sheets` 记 `view` create 修订（`:15663-15678`）；`sheet_config` 现有调用全是 `update`（`:9552`、`:9645`、`:15528`）。
16. **大小基线**：客户表 55 列 × 1239 行（PR #6074 分支 `docs/development/takeover-beiliao-20260821/customer-reply-20260924.md:45`、`:62`，`:45` 同时记客户已注意到新视图「按录入先后」显示）；默认列表全部 `ORDER BY created_at ASC, id ASC`（`univer-meta.ts:5295`、`:16025`）；autoNumber 回填按同序 `ROW_NUMBER`（`auto-number-service.ts:84-100`）；`XLSX_MAX_ROWS = 50_000`（`xlsx-service.ts:5`）。

## 2. 决策清单（锁定）

| # | 决策 | 依据 |
|---|---|---|
| CS-1 | 独立动作：`POST /api/multitable/sheets/:sheetId/copy`（+ 零写 `…/copy/dry-run`）。**仅会话认证**（不挂 `apiTokenAuth`；多维表路由逐个 opt-in，`univer-meta.ts:13440`、`:19176`）。模板 JSON 形状不变、永不带数据。 | owner；§1.1 |
| CS-2 | 入口：① 侧栏当前表操作区「复制数据表」；② 「存为模板」弹窗底部「改为复制数据表（含数据）」；③ 模板中心「同时复制数据」只对带 provenance 的自定义模板、且只对**通过源表全表读门**的查看者出现（S4）。 | `MetaSheetViewRail.vue:96-111`、`MultitableWorkbench.vue:113-118` |
| CS-3 | 目标 Base：**S1 = 源表所在 Base，不可选**。跨 Base 在 S2+：候选 = 可读 Base（`GET /bases` 口径，`univer-meta.ts:7905`）∩ `resolveBaseWritable`（`permission-service.ts:1962-2012`，fail-closed，含 e-learning 投影排除 `:1984`）；显式拒绝 `APPROVAL_PROJECTION_BASE_ID`（`approval-projection-constants.ts:17-20`）与 e-learning 候选 id（`univer-meta.ts:15586-15591` 只查后者，审批投影是**新代码**）。不用 `POST /sheets` 的 `canManageViews ∨ owner` 谓词（`:15600-15617`，与前者不一致）。 | §4.2 |
| CS-4 | 默认名「<源表名> 副本」；沿用显示名 hygiene（`univer-meta.ts:15497-15500`）。 | |
| CS-5 | 源侧门 = 复用 `hasFullTableReadAccess`（§1.9），事务外快速拒 + **事务内 DB-fresh 终审**（§4.1）；拒绝码 `COPY_SOURCE_NOT_FULLY_READABLE`（403，**无计数**）。 | §4.1 |
| CS-6 | **S1 不提供**「去掉我无权查看的列」：任何列对复制者不可见即拒绝整次复制。该选项的披露量本身是 oracle（§1.9），是否在 S2+ 提供 → §11-4。 | §4.1 |
| CS-7 | 权限复制（唯一模式 `inherit`）：`spreadsheet_permissions`（含 legacy `user_id`）/ `field_permissions`（remap）/ `meta_view_permissions`（remap）/ **`record_permissions`（`record_id` 经事务内 id 映射 remap，含全部 `'none'` 行）** / 行级开关 / `conditional_read_rules`（`fieldId` remap，**规则永不丢弃**）**逐行复制**，主体一一对应；不给复制者追加任何行；提交前**拒绝集等价断言**（§4.3）。 | §4.3 |
| CS-8 | **「仅自己可见」模式不在本 ADR 内**（r1 的 CS-8 撤回，见 §4.5）：今天没有表级私有原语——`hasAssignments` 按人算（§1.7），只写复制者一行 admin 时所有全局 `multitable:read` 持有者仍可读新表、且该行把 `canManageSheetAccess` 升给一个可能没有 `multitable:share`（`access.ts:120-121`）的复制者。是否新增私有原语 → §11-1（owner 先批）。 | §4.5 |
| CS-9 | 字段 property 走**按类型 allowlist + 显式 remap 表**（§5.2），出现 allowlist 之外、值形如 `fld_…` 的键 → 拒绝（`COPY_UNMAPPED_FIELD_REF`）。新 id 保持 `fld_` 前缀（`formula-engine.ts:16`）。 | §5 |
| CS-10 | **永不跨外读边界冻结值**。S1 同 Base：link/lookup/rollup/formula **保活**（id remap、读时按读者权限计算）；镜像列不建、自链接 S1 值为空（S2 两遍写）；其传递依赖列保活并**逐列披露**。跨 Base（S2+）：只允许「经 `foreignBaseId` 显式声明保活」或「整列不建并披露」，不冻结。「冻结为文本/数字」（S2 选项）只对**全部传递输入都在源表内**的列可用。 | §5.1；B3 |
| CS-11 | 附件：S1 列保留、值为空并披露；S2 复制 blob（新 storage key、新行），不共享 blob。 | §1.11 |
| CS-12 | autoNumber：S1 经 `createRecord` 重新编号（复制路径先剥掉入参，`record-service.ts:609`）；dry-run 对比源值与 1..N，披露「N 行编号将变化」；若任何 `conditional_read_rules` 引用 autoNumber 列且 N > 0 → 拒绝（`COPY_SOURCE_RULE_ON_RENUMBERED_FIELD`，规则按存储值求值，重编号会换掉被隐藏的行）。「冻结为数字列」S2。 | §5；B1(iii)、SF12 |
| CS-13 | 系统列：`created_at` = 复制事务起点 + 行序数（微秒），保持源序（§7.3）；**`created_by` 保留源值**（write-own 行策略键于此，否则复制者独占全部行、其他 write-own 持有者失去自己的行）；`modified_by` = 复制者、`updated_at` = 复制时刻。`Ratified-by-default-2026-09-26`（收紧方向：无人多得一行）；owner 可改为 §11-3 备选。 | §4.4；S6/SF9、B3 |
| CS-14 | 托管表可作为源；复制物**永不登记** registry、PLM 不刷新；`meta_sheets` 新增可空 `copied_from_sheet_id / copied_from_kind / copied_at`；UI 徽标「快照副本」；**插件作用域 hook 对 `copied_from_kind='plugin-managed'` 的表在任何模式下拒绝**（§6）。系统表拒绝作为源。 | §6；S8 |
| CS-15 | 执行：S1 单事务同步、`REPEATABLE READ`、行数 ≤ N（默认 2000，env `MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS`，登记 flag manifest）；`RecordService` 由**事务绑定 facade**构造（§7.2，无现成先例）；`createRecord` 走 §7.3 复制扩展；字段数 ≤ 500（本功能自己的常量，`univer-meta.ts:8227` 是模板请求 `fieldIds` 的 zod 上限，不是模板字段上限）。 | §7 |
| CS-16 | 幂等：复用 `template-install-dedupe`；咨询锁是复制事务**第一条语句**、账本读写同事务；指纹 = (tenant, actor, kind=`copy-sheet`, sourceSheetId, targetBaseId, name, withData, permissionMode)；5 分钟窗口重放 201 + `Idempotent-Replayed`。 | §7.6 |
| CS-17 | 审计 values-free：`[multitable.sheet.copy]` 结构化日志 + `operation_audit_logs` **两行**（resource=目标、resource=源）+ 逐条 `field / view / permission` create 配置修订共用一个 `batchId`；拒绝尝试在事务外记一行。 | §7.7 |
| CS-18 | 原子性：S1 全有或全无，**首个失败即停**（PG 25P02 后事务已中止，不做逐行 SAVEPOINT）；响应只带一条 `{ rowIndex, fieldId, code }`。S3 异步：隐藏 `building` 态 + 单源快照 + 失败**硬清除**（不是软删）。 | §8 |
| CS-19 | 事件：复制路径**不发**逐行 `record.created`（无 legacy emit、无 outbox、无逐行 realtime）；提交后至多一条 values-free `multitable.sheet.copied`（不进 `webhook-event-bridge` 映射）。 | §7.4；B4 |
| CS-20 | 切片：S1（L）结构 + 普通值 + 权限 + 同步 + 事件抑制 + 插件作用域拒绝；S2 附件 / 自链接 / 跨 Base / 冻结；S3 异步；S4 模板 provenance。 | §9 |
| CS-21 | 校验：复制模式下 `createRecord` 用 **shape-only** 校验（类型形状 + link 外表记录存在 + 附件归属），不跑 `property.validation`、person 名册/组限制、select 选项集；`null`/空值键**省略**。理由：源值是被 grandfather 的既成事实（`person-field-restriction.ts:28`、`field-codecs.ts:343`；插件 SDK 路径对任何类型接受 null，`multitable/records.ts:242-244`），快照不该替源表补作业。 | §7.3；SF2 |
| CS-22 | 测试：真库集成（`usePinnedServer` + `request(pinned.url())`）+ 单元；清单见 §9。 | |

## 3. 用户可见行为

- **弹窗**（S1）：源表（只读）；新表名（CS-4）；目标 Base 固定为当前 Base（灰显，S2 解锁）；「包含数据（共 N 行）」（默认勾）；权限固定「与源表相同」（灰显）。
- **预检** `POST …/copy/dry-run`（零写，与模板 dry-run 同层 `univer-meta.ts:8602-8608`）：**先跑 §4 两侧门再 COUNT**（门不过只回 403，不回任何计数，无基数泄漏）；通过后回：行数、列数、超限与否；将披露的列（按 fieldId + 原因码：`ATTACHMENT_BLANKED`、`SELF_LINK_BLANKED`、`MIRROR_NOT_BUILT`、`DEPENDS_ON_BLANKED_COLUMN`、`BUTTON_DISABLED`、`PROPERTY_HIDDEN_BLANKED`）；`autoNumberRenumberedRows`；将 shape-only 省略的 null 单元格计数；`record_permissions` 将 remap 的行数；不复制项（自动化、评论、订阅、表单分享、锁定、修订历史）。
- **结果**：201 → 跳转新表；toast 披露「复制 X 行 / Y 列 / Z 条授权（含 R 条记录级）；未复制：…」；201 body 带 `formulaRecompute: { attempted, recomputed, failed, errorCode? }`，`failed` 时 toast 醒目并给「重算」入口（= 对任一 formula 列重存同一表达式，`univer-meta.ts:14158` 的既有恢复路径）。
- **徽标**：新表名旁「快照副本」；源为托管表时追加「不随 PLM 刷新」。只依赖服务端列（CS-14）。
- `/context` 增 `canCopySheet`（= `hasFullTableReadAccess` ∧ 当前 Base `resolveBaseWritable`），只做显隐，服务端再门。

## 4. 权限模型

### 4.1 源侧门（读）

`hasFullTableReadAccess(req, query, sheetId, access, capabilities)`（`univer-meta.ts:7244-7263`）原样复用，三轴见 §1.9。**不**自行以 `loadDeniedRecordIds` 判行级（那是数据探针，头注释 `:7229-7235` 明令禁止）；**不**回 `hiddenCount`（`:7225-7228`「no scoped loss counts」）。由此 S1 的推论：

- 行级开关开着的表**只有 admin 角色能复制**（轴 ①）。admin 复制时 `record_permissions` 与规则按 §4.3 全量 remap，新表对非 admin 的可见行集与源表一致。
- 有任何 `field_permissions` 遮住复制者的列 → 拒绝（轴 ②）。r1 的「去掉隐藏列」选项撤回（CS-6）。
- formula 污点（引用复制者读不到的外表字段）→ 拒绝（轴 ③）。r1 只查 `visible=false` 会漏掉这类列：复制后重算在复制者 req 下跳过污点（`:14125-14128`），该列对**所有人**都空。
- **property-hidden 列（第二层）**：对所有读者都从记录读中剥离（`permission-derivation.ts:70-75`；`univer-meta.ts:4860-4862`、`:4999-5003`）。S1：列**建**（保持 hidden），值只在复制者持有源表 `canManageFields`（他本可取消隐藏后读到）时复制，否则留空并披露 `PROPERTY_HIDDEN_BLANKED`。这不是「谎言」：该列对任何读者都不可见，取消隐藏是 schema 动作、由披露覆盖。

**TOCTOU**：事务外的门只是快速拒。事务内顺序 = 咨询锁 → `SELECT deleted_at FROM meta_sheets WHERE id = $src FOR SHARE`（与授权 PUT 持有的 `FOR UPDATE` 行锁互斥：`sheet-liveness.ts:152`、`:197`，`univer-meta.ts:9407`）→ 用 DB-fresh 的 `resolveSheetCapabilitiesForAccess`（`permission-service.ts:1771`）**重跑** `hasFullTableReadAccess` 与目标门 → 结构写入。先例：恢复路由 BEGIN → fence → DB-fresh 终审（`univer-meta.ts:12255`、`:12313`）；FWB 门用当前事务构造（`automation-service.ts:1414`）。S3 每块重跑。

### 4.2 目标侧门（写）

- S1 目标 = 源 Base；仍跑 `resolveBaseWritable(actor, txQuery, baseId)`（存在性 + live + e-learning 排除 + `multitable:base:write` 或 owner）。再加 `isApprovalProjectionBaseId` 拒绝（新代码）。
- 新表 id 服务端 mint，`fenceWriterEntry(newSheetId)`（`univer-meta.ts:15623`）照跑；每个建出的字段过字段创建路由的同一组校验：link 墙（`:1970-1995`）、悬空目标 fail-closed、button `actionType`。
- 复制者**不需要**源表 `canManageSheetAccess`（`:9363`）或 `canManageFields`（`:10037`）：授权复制不产生任何源表上不存在的 (主体, 级别, 对象) 三元组（§4.4）。

### 4.3 授权复制（`inherit`）

| 表 / 项 | 复制方式 | 备注 |
|---|---|---|
| `spreadsheet_permissions` | 逐行 `(new_sheet_id, user_id, subject_type, subject_id, perm_code)` | 主体照抄（同租户）；`user_id` 对 user 主体同填（`univer-meta.ts:9429-9439`） |
| `field_permissions` | 逐行，`field_id` remap；`created_by` 重打为 `operatorFieldPermissionCreatedBy(actor)` | 不带 pack 标记，备料 reconcile 只认自己标记的行（`stock-preparation-field-permissions.ts` 头注释） |
| `meta_view_permissions` | 随视图复制，`view_id` remap | |
| `record_permissions` | **逐行，`record_id` 经事务内 oldId → newId 映射**（含 read/write/admin 与全部 `'none'`） | 映射由 §7.2 第 5 步逐行返回的 recordId 构成；映射缺失（源行在快照外）→ 该行丢弃并计入披露 |
| `row_level_read_permissions_enabled` / `conditional_read_rules` | 复制；规则 `fieldId` remap；**引用未建列的规则不丢弃**：S1 唯一未建列是镜像列，若有规则引用它 → 拒绝（`COPY_SOURCE_RULE_UNBUILDABLE`）；引用 autoNumber 且重编号会改值 → 拒绝（CS-12） | 丢规则 = 把 fail-closed 翻成 allow（§1.8） |
| `meta_view_personal_configs` | 不复制 | 个人覆盖层 |

**拒绝集等价断言**（事务内、写完记录与授权后、COMMIT 前）：对源表每个持有 `'none'` 行的主体，`map(deny_src(subject)) == deny_new(subject)`；对规则臂，`map(loadRuleDeniedRecordIds(src)) == loadRuleDeniedRecordIds(new)`（`permission-service.ts:1338`）。任一不等 → 回滚，码 `COPY_PERMISSION_PARITY_FAILED`。这一步由 admin 复制者触发，读的是他本就能读的数据，不是探针。

### 4.4 不升级证明（r2 修正）

- 结构：新表每一行授权都是源表某一行的 id 投影；复制者自己不新增行 → 不存在源表上没有的 (主体, 级别, 对象)。
- 复制者能力：`inherit` 下 `applySheetPermissionScope` 对同一主体集合给同一结果；只读的复制者在新表仍只读。**他的写入不经他自己的能力**：§7.3 的服务端常量能力只在两侧门通过后、只在该事务内生效（否则 r1 的 `capabilities: newSheetCaps` 在授权行写入后即为 `canCreateRecord=false`，`record-service.ts:545` 抛错，只读复制者永远失败）。
- write-own：`created_by` 保留（CS-13），`isCreator` 判定（`:1636`）在新表与源表逐行一致；若改为 `created_by = 复制者`，复制者独占全部行——这是 r1 证明的漏洞，已修。
- 私有模式带来的 admin 行升级（`canManageSheetAccess = scope.canAdmin`，`:1494`；`canManageFields` 经 `:1553-1565`）随 CS-8 撤回一并消失。

### 4.5 为什么 S1 没有「仅自己可见」

`private` 的两个候选形状都不成立：(a) 不写任何行 → 新表对每个全局 `multitable:read` 持有者可读（`:1479-1485`），且不复制 `field_permissions` 会让源表按部门隐藏的列全露——正是 §1.4 的导出→导入洞；(b) 只写复制者 admin 一行 → 同样对全局读者可读（`hasAssignments` 是他人的、不是复制者的），还把 `canManageSheetAccess` 升给他。真正的私有需要新增「表级 assignment-required」原语（读模型改动，fail-closed 默认关），不属于本功能 → §11-1。

## 5. 字段类型语义

### 5.1 值语义（S1 同 Base）

| 类型 | 结构 | 值 | 说明 |
|---|---|---|---|
| string / longText / number / boolean / date / dateTime / select / multiSelect / currency / percent / rating / duration / url / email / phone / barcode / qrcode / location | property 经 §5.2 allowlist，含 select 选项与颜色 | 原值，shape-only（CS-21） | select 值不在选项内的既成事实照搬 |
| person | property 复制（`limitSingleRecord`、`restrictToMemberGroupIds`） | 原值，不跑名册（CS-21） | 停用用户照搬（r1 §11-7 的兜底问题随 CS-21 消失） |
| attachment | 列保留 | S1 空并披露；S2 复制 blob | §1.11 |
| link（正向，外表 ≠ 源表） | `foreignSheetId` 保持；`twoWay → false`、`mirrorFieldId` 丢弃（否则要在外表建镜像列） | 值从 `meta_links` 读（`univer-meta.ts:19358` 先例）→ `createRecord` 校验外表记录存在（`record-service.ts:652-667`） | 读者按自身权限看外表（`shouldMaskForeignField`、`loadDeniedRecordIds`，`univer-meta.ts:1660-1673`），无泄漏 |
| link（自链接） | `foreignSheetId → 新表` | S1 空并披露；S2 记录全建后经 `RecordWriteService.patchRecords`（带 `batchId`）remap 回填 | |
| link 镜像列（`mirrorOf`） | **不建**并披露 | — | 派生列属于外表的 link（`permission-derivation.ts:66`） |
| lookup / rollup | `linkFieldId` remap；`targetFieldId` 外表不变、自链接 remap | 读时计算（`record-service.ts:806`） | 依赖被清空 / 未建列 → 保活并披露 `DEPENDS_ON_BLANKED_COLUMN` |
| formula | `{fld_…}` 逐个 remap（`formula-engine.ts:16`、`:72-90`） | 提交后 chunked 重算，状态回 201 body（§3） | 同上 |
| autoNumber | property 复制；序列懒建 | 重新编号（CS-12） | |
| createdTime / modifiedTime / createdBy / modifiedBy | property 复制 | 反映 §7.3 写入的系统列 | |
| button | `label / variant / confirm` 复制；**`actionType → 'record_click'`、`actionConfig` 不复制**；披露 `BUTTON_DISABLED` | 无值 | 源 `actionConfig` 可含 `send_webhook` 的 url 与 HMAC `secret`（`routes/multitable-button.ts:332-335`）、按源字段 id 键的 `update_record`；codec 原样透传（`field-codecs.ts:533`）且 `actionType` 校验在路由不在 codec（`:521-523`） |
| 未知类型 | 拒绝并披露 | — | fail-closed |

### 5.2 property / 视图 id-remap 表（fail-closed allowlist）

- 字段 property 携带 id 的键（`sanitizeFieldProperty` 以 `...obj` 透传任意键，`field-codecs.ts:416`，故必须显式列举）：`linkFieldId` 及别名 `relatedLinkFieldId / linkedFieldId / sourceFieldId`（`:353-360`）；`targetFieldId`（自链接时）；`foreignSheetId` 及别名 `foreignDatasheetId / datasheetId`（`:410`，自链接 → 新表）；`mirrorFieldId`（丢）；`visibilityRule.fieldId`、`requiredWhen.fieldId`（`field-visibility-rule.ts:30-34`、`:92-118`）；formula `expression`。
- 视图：`filter_info` 叶子 `fieldId` remap，指向被清空 / 未建列的叶子**整条删除**（文字面 redaction 先例 `univer-meta.ts:5117-5125`）；`sort_info / group_info / hidden_field_ids` remap；`config.conditionalFormattingRules[*].fieldId` 与嵌套条件 remap（`:14427-14438`）；`config.*FieldId`（gantt/kanban/calendar）remap；**`config.publicForm` 整段剥离**（分享令牌，`:828-868`）。
- 任何未列出的键若值匹配 `^fld_` → `COPY_UNMAPPED_FIELD_REF`，整次拒绝。

## 6. 托管表与系统表

- **可作为源**：托管表过 §4.1 门即可复制（客户要的「备料表连数据复制一份去分析」）。
- **非托管快照**：复制路径不调 `ensureObject`，registry 无新行 → 可删、可改字段、`ext_` 成普通列、PLM 不刷新。
- **插件作用域（S8 修正）**：「registry 无行」在默认 `observe` 模式下等于「任何插件可达」（§1.10）。S1 在 host `assertSheetScope` hook（`index.ts:2298`）加一条：目标表 `copied_from_kind = 'plugin-managed'` → 任何模式下抛 `MultitableSheetScopeError(…, 'copied-snapshot')`。真库测试：以另一插件名经 plugin-scope records API 读复制表 → 拒绝；`enforce` 模式不作为前提。
- **provenance 列**：`copied_from_sheet_id text / copied_from_kind text ('user' | 'plugin-managed') / copied_at timestamptz`，惰性迁移；`GET /context` 与列表透出 `copiedFrom: { kind, at, sheetId? }`，`sheetId` 只对能读源表者透出。
- **系统表拒绝作为源**：`system_kind` / People 哨兵（`system-sheet-predicate.ts:55`）、审批 / e-learning 投影；码 `COPY_SOURCE_SYSTEM_SHEET`，门后才回。

## 7. 执行模型

### 7.1 路由

`POST /api/multitable/sheets/:sheetId/copy`，body `{ name?, withData: boolean, permissionMode: 'inherit' }`（S1 只接受 `inherit`；`targetBaseId` S2 起）；`…/copy/dry-run` 同形零写。`rbacGuard('multitable','write')` 之后再做两侧门。仅会话（CS-1）。

### 7.2 单事务顺序（S1）

1. 事务外快速拒：§4.1 / §4.2 / 源 liveness / 系统表。
2. `BEGIN ISOLATION LEVEL REPEATABLE READ`（记录、`meta_links`、授权、规则多条语句读同一快照；r1 的「单语句 = 单快照」只覆盖 `meta_records.data`）。
3. **第一条语句** `pg_try_advisory_xact_lock(intent_digest)` → 读账本（命中且新表 live → 回滚、重放 201）。
4. `SELECT deleted_at FROM meta_sheets WHERE id = $src FOR SHARE` → DB-fresh 重跑两侧门 → `INSERT meta_sheets`（provenance 三列）→ 字段（新 id、§5.2 remap、字段创建校验、逐条 `field` create 修订）→ 视图（remap、`publicForm` 剥离、逐条 `view` create 修订）。
5. 源记录 `SELECT id, data, created_by FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT N+1`（第 N+1 行存在 → 回滚 413）；link 值按 `meta_links` 覆盖；逐行 `recordService.createRecord({ …, copy: { batchId, ordinal, createdBy } })`（§7.3），收集 `oldRecordId → newRecordId`。**记录先于授权写**（名册来自全局资格与活跃状态，`permission-service.ts:614-627` / `:419`，不看表授权；r1 的先后理由不成立）。
6. 授权行 + `record_permissions` remap + 规则（§4.3；逐条 `permission` create 修订）→ **拒绝集等价断言** → `operation_audit_logs` 两行 → 账本写回 → `COMMIT`。
7. 提交后：chunked formula 重算（复制者 req，状态进 201 body）；缓存失效（`univer-meta.ts:15375-15377`）；一条 `multitable.sheet.copied`；结构化日志。

`RecordService` 构造：`new RecordService({ query: txQuery, transaction: (h) => h({ query: txQuery }) }, eventBus)`。**没有现成先例**：`automation-service.ts:1397` 与 `univer-meta.ts:12434` 每次调用都开新的 `pool.transaction`；仓内每个 `RecordService` 都是 `new RecordService(pool, eventBus)`（`:15759`、`:19383`）。按 r1 引用实现会逐行提交、破坏 CS-18。

### 7.3 `RecordService.createRecord` 复制扩展（唯一入口的**变更**）

`RecordCreateInput` 增 `copy?: { batchId: string; ordinal: number; startedAt: Date; createdBy: string | null }`。存在时：

- `capabilities` 必须是服务端常量 `COPY_SHEET_RECORD_CAPABILITIES`（`canCreateRecord: true`，其余 false），由复制路由在两侧门通过后 mint，不从客户端或全局能力派生。
- 校验 = shape-only（CS-21）；autoNumber 入参由路由剥离；attachment / link 校验照跑。
- `INSERT … (created_at, created_by) = ($startedAt + ordinal µs, $createdBy)`；`updated_at` 默认 now。序数时间戳保证默认列表序与源一致（`created_at DEFAULT now()` 是事务起点，2000 行会同值、随机排列，§1.16）；先例 `clock_timestamp()` 在 checkpoint 迁移头（`zzzz20260715180000:26`）但精度不足以排序，故用序数。
- 修订 `source: 'copy-sheet'`、`batchId`（`record-history-service.ts:37`）。
- **抑制**：不 `enqueueRecordEventIfDurable`、不 `emitRecordEventIfLegacy`、不 `publishMultitableSheetRealtime`、不逐行 formula hook。
- `RecordValidationError` 增 `fieldId?`，路由只回 `{ rowIndex, fieldId, code }`，**永不**转发 `message`（含值，§1.6）。

### 7.4 副作用与事件（B4）

r1「新表无自动化规则 → 无动作」错误：`record.created` 经 `webhook-event-bridge` 发给租户**全部**订阅 webhook（§1.12），facade 下 legacy emit 在外层 COMMIT 前触发，回滚后 1239 条含全值（含被字段权限隐藏列）的 POST 已出网。CS-19 抑制之。真库测试：预置一个 active `record.created` webhook，复制后 `multitable_webhook_deliveries` 与 `meta_automation_outbox` 对新表零行，durable flag on/off 各跑一遍。

### 7.5 大小与性能

- N = 2000（客户 1239 在内）；字段 ≤ 500；绝对上限 50 000（异步也不超）。
- 「秒级」需实测：S1 test 记录 2000 行耗时。shape-only 跳过 person 名册解析（该解析每次 `createRecord` 重跑 `listSheetPermissionCandidates`，`person-field-restriction.ts:31-71` 缓存只活一次调用）。

### 7.6 异步作业（S3，> N 行）— 三条不变量

1. **隐藏构建态**：`meta_sheets.copy_state = 'building'` 期间从所有列表 / 读面排除（未知态 = 隐藏，fail-closed），授权行最后一块才写。
2. **单源快照**：作业开始时一条 `INSERT INTO multitable_sheet_copy_job_rows SELECT …` 固化源行；分块从 staging 读，不跨源快照。
3. **失败即硬清除**：cancel / crash / fail → 物理删除新表全部行（记录、links、字段、视图、授权、sheet 行）；不用 `deleted_at`（`univer-meta.ts:15373` 软删可经 `POST /sheets/:id/restore` 复活，`permission-service.ts:1759`）。
表形状照 `multitable_ai_bulk_job`；`status` 词表 `workflow-job-contract.ts`；细节 S3 前单独 ADR。

### 7.7 幂等 / 审计

- 幂等见 CS-16；账本 `templateId` 一般化为 `intent_kind + intent_key`；账本缺表 fail-open（`univer-meta.ts:8506-8520` 同）。
- `[multitable.sheet.copy]`：`{ sourceSheetId, targetSheetId, targetBaseId, userId, ok, rowCount, fieldCount, blankedFieldCount, permissionRowCount, recordPermissionRowCount, permissionMode, withData, durationMs, statusCode?, errorCode? }`，与 `[multitable.template.save-as]` 同口径（`:8350-8359`）；重放 `[multitable.sheet.copy.replayed]`。
- `operation_audit_logs`：`action='multitable.sheet.copy'`, `resource_id=target` + `action='multitable.sheet.copy-source'`, `resource_id=source`，`metadata` 同上计数；拒绝尝试（403 / 422 / 413）在事务外用 pool 写一行 `ok=false, errorCode`。
- 配置历史：逐字段 / 视图 / 授权行的 `create` 修订共用 `batchId`（先例形状 §1.15）；**不**写 `sheet_config` 修订（`POST /sheets` 亦不写，provenance 在列与审计里）。
- Time Machine：新表从一批 `create` 修订开始，`source='copy-sheet'`。

## 8. 失败模式与原子性

| 情形 | 行为 | 码 |
|---|---|---|
| 门不过（含行级开关开且非 admin、字段遮蔽、formula 污点） | 403，不透露存在性、**不带计数** | `COPY_SOURCE_NOT_FULLY_READABLE` |
| 目标 Base 不可写 / 投影 Base | 403 | `FORBIDDEN` |
| 源表门后被软删 | `FOR SHARE` 读到 `deleted_at` → 回滚 | 404 `SHEET_NOT_LIVE` |
| 规则引用未建列 / 引用将重编号的 autoNumber | 拒绝 | 422 `COPY_SOURCE_RULE_UNBUILDABLE` / `COPY_SOURCE_RULE_ON_RENUMBERED_FIELD` |
| property 有未列举的 `fld_` 引用 | 拒绝 | 422 `COPY_UNMAPPED_FIELD_REF` |
| 行 shape 校验失败（link 外表记录不存在、类型形状不合） | **首个失败即回滚** | 422 `COPY_ROW_VALIDATION_FAILED { rowIndex, fieldId, code }` |
| 拒绝集断言不等 | 回滚 | 500 `COPY_PERMISSION_PARITY_FAILED` |
| 写围栏冲突 | 回滚 | 409（`sendWriterFenceConflict`） |
| 超限 | 拒绝 | 413 `COPY_TOO_LARGE { rowCount, limit }` |
| 幂等重放 | 201 + `Idempotent-Replayed: true` | — |
| formula 重算失败（提交后） | 201，body `formulaRecompute.failed=true` | `BULK_RECOMPUTE_FAILED` |
| 进程崩溃（S1） | PG 回滚，无残留 | — |

全有或全无（S1）：快照价值在「与源表某一时刻一致」，可续跑会跨源快照。S3 用「隐藏构建 + 单源快照 + 硬清除」保住二值结果。

## 9. 交付切片与测试

| 切片 | 量 | 内容 |
|---|---|---|
| S1 | **L** | 路由 + dry-run + 两侧门（事务内终审）+ 结构/视图/授权/记录级授权/规则逐行复制 + 拒绝集断言 + 普通值 + `createRecord` 复制扩展（序数 `created_at`、`created_by`、batch、事件抑制、shape-only、结构化错误）+ facade + 去重一般化 + provenance 迁移 + 插件作用域拒绝 + 逐条配置修订 + 双审计 + `canCopySheet` + 入口①② + 徽标 |
| S2 | M | 附件 blob（配额 env，默认 500 MB）+ 自链接回填 + 跨 Base（`foreignBaseId` 保活 / 不建）+ 「冻结」选项（仅源内输入列）+ autoNumber 冻结 |
| S3 | L | 异步：`building` 态 + staging 快照 + worker + 进度/取消 + 硬清除 |
| S4 | S-M | 自定义模板 `source_sheet_id` provenance + 「同时复制数据」（只对过源门者出现；复制的是源表**当前**数据） |

**S1 真库测试（`usePinnedServer()`，`tests/unit` 禁 `request(app)`）**：

- 门：非读者 403 且不区分存在性、body 无计数；字段遮蔽 / 污点 formula / 行级开关开 + 非 admin → 同一 403；dry-run 同门先于 COUNT。
- **表级读者在 `inherit` 下复制成功**（全局 `multitable:write` + 源表 `spreadsheet:read`）：r1 设计在此抛 `RecordPermissionError`。
- 授权相等：`spreadsheet_permissions` / `field_permissions` / 视图权限 / 行级开关 / 规则集合相等（remap 后）；复制者无新增行；源表无授权行 → 新表也无。
- **行级 deny 相等**：源表行级开、3 个主体各有 `'none'` 行 + 1 条规则；admin 复制后，对每个主体 `loadDeniedRecordIds(new)` = map(源)；用受限用户实际 GET 记录列表核对行数相等。注入一条引用 autoNumber 的规则 + 源有删除空洞 → 422。
- write-own：源表 write-own 用户 U 创建了 3 行；复制后 U 在新表恰好对这 3 行 `canEdit`，复制者（write-own）对非己行不可编辑。
- 数据：1000 行 × 全类型夹具（含 null select、不在选项的 select、停用用户 person、required 缺失）逐字段相等（省略键除外）；**默认列表序与源一致**；`meta_record_revisions` 恰一个 `batch_id`、`source='copy-sheet'`；每字段 / 视图 / 授权行各一条 create 配置修订、同一 `batchId`。
- 事件：预置 active webhook → `multitable_webhook_deliveries` 与 `meta_automation_outbox` 新表零行（flag on/off）。
- 回滚：注入第 k 行失败 → `meta_sheets / meta_fields / meta_views / meta_records / meta_links / *_permissions / meta_record_revisions / 账本` 对新表 id **全部 0 行**；body 按字节扫描无单元格值。
- 托管源：registry 无新表行；以他插件名经 plugin-scope 读新表 → 拒绝；`DELETE /sheets` 成功。
- button：源 `send_webhook` 按钮 → 新表 `actionType='record_click'`、无 `actionConfig`。
- 幂等：同意图连发 3 次 → 一张表；改 `withData` 再发 → 新表。
- 单元：§5.2 remap 表逐键；未列举 `fld_` 键 → 拒绝；`publicForm` 剥离；filter 叶子删除；日志事件 values-free 断言。

## 10. 非目标

- 不做跨租户 / 跨部署复制；不做增量同步或镜像（「同步表」路线已封存）。
- 不复制：修订历史、评论、订阅、自动化规则、按钮动作配置、表单分享、API token、记录锁、个人视图配置、回收站。
- 不做「使用模板落到当前 Base」（#5909）；不改模板 JSON；不给模板加数据。
- 不绕过 `createRecord`；S1 不做可续跑、不做跨 Base、不做私有模式、不做去隐藏列。

## 11. 待 owner / 客户 决定（放宽方向，先批后动）

1. 是否需要真正的「仅自己可见」：需新增表级 assignment-required 读原语（§4.5）；若需要，独立 ADR。
2. autoNumber 是否有业务上必须保留源号的列（备料单号？）——问客户；若有，S2「冻结为数字列」是否成该列默认。
3. CS-13 备选：`created_by = 复制者` 并**丢弃** write-own 授权行（披露）。默认保留源 `created_by`。
4. S2+ 是否提供「去掉我无权查看的列」及其披露量（该量对复制者是 oracle，§1.9）。
5. N = 2000、附件配额 500 MB 取值；2000 行实测耗时。
6. 跨 Base（S2）：link 经 `foreignBaseId` 保活 vs 整列不建，默认保活。
7. S4 provenance 改变「自定义模板不含任何源 id」的性质（只记源 sheet id、只对过门者透出）——是否接受。
8. 是否附加「源创建时间」数据列（`created_at` 已用于序数时间戳，源时间只能作为数据列保留；默认不加）。

## 附录 A：证据索引（origin/main @ 51acbb18f = 3fd352457 对所引文件）

- 模板：`packages/core-backend/src/routes/univer-meta.ts:8168`、`:8190-8193`、`:8199-8203`、`:8227`（请求 `fieldIds` zod 上限）、`:8266`、`:8350-8359`、`:8461-8543`、`:8602-8608`；`custom-template-store.ts:9-17`、`:106`；`template-library.ts:579`、`:591-600`；`template-install-dedupe.ts:38-44`、`:57`、`:91`、`:98`。
- 记录写：`record-service.ts:161-169`、`:226-233`、`:483-497`、`:534-545`、`:550-575`、`:605-632`、`:652-667`、`:716-722`、`:739-744`、`:774-785`、`:797`、`:803-821`、`:837`；`record-write-service.ts:299`、`:706`；`record-history-service.ts:20`、`:37`；`history-projection.ts:5-9`；`multitable/records.ts:242-244`；`person-field-restriction.ts:28`、`:31-71`。
- 权限：`permission-service.ts:166-172`、`:317`、`:419`、`:614-627`、`:728-752`、`:859-900`、`:916-919`、`:1200-1256`、`:1282`、`:1332-1356`、`:1479-1498`、`:1553-1565`、`:1603-1608`、`:1636`、`:1759`、`:1771`、`:1962-2012`（`:1984` e-learning）；`permission-rule-evaluator.ts:12-15`、`:87`；`access.ts:120-121`、`:146`；`permission-derivation.ts:59`、`:66`、`:70-75`；`approval-projection-constants.ts:17-20`；`univer-meta.ts:7225-7263`、`:7410-7433`、`:9363`、`:9407`、`:9428-9439`、`:9455-9466`、`:10037`、`:10139-10143`、`:10446`、`:1660-1673`、`:3600-3644`、`:4860-4862`、`:4999-5003`、`:5117-5125`、`:12255`、`:12313`、`:14125-14128`、`:14140-14160`；`sheet-liveness.ts:152`、`:197`；`automation-service.ts:1397`、`:1414`。
- 表 / 字段 / 视图路由：`univer-meta.ts:828-868`、`:1970-1995`、`:5295`、`:7905`、`:13440`、`:13570-13572`、`:14427-14438`、`:15363-15377`、`:15497-15500`、`:15586-15620`、`:15623`、`:15638-15684`、`:15759`、`:15768-15772`、`:16025`、`:19176`、`:19301-19387`、`:12434`。
- 字段类型：`field-codecs.ts:343`、`:353-360`、`:410-418`、`:521-533`、`:1155`；`field-visibility-rule.ts:30-34`、`:92-118`；`routes/multitable-button.ts:99-110`、`:332-335`；`automation-actions.ts:6-26`；`formula-engine.ts:16`、`:72-90`；`auto-number-service.ts:84-100`；`attachment-service.ts:321-346`。
- 事件：`automation-routing-manifest.ts:89`；`webhook-event-bridge.ts:42-47`；`multitable/webhook-service.ts:327-335`；`automation-durable-delivery.ts:20-22`；`automation-producer-emit.ts:63-72`；迁移 `zzzz20260715120000_create_automation_outbox.ts:61`、`zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts`。
- 托管 / 插件作用域：`sheet-delete-guard.ts:17-27`、`:38`；`plugin-scope.ts:266-269`；`pluginSheetScopeMode.ts:31-33`；`index.ts:2298-2308`；`zzzz20260408123000_create_plugin_multitable_object_registry.ts:13`；`system-sheet-predicate.ts:55`。
- 作业：`ai-bulk-job-service.ts:71`；`zzzz20260622120000:46-62`；`workflow-job-contract.ts:1-15`；`automation-job-service.ts:20`；`routes/automation.ts:30`；`QueueService.ts:1-4`。
- 迁移：`zzzz20260404153000_repair_meta_core_schema.ts:26`；`zzzz20260406030000:63-65`；`zzzz20260617140000:22-24`；`zzzz20260618120000_conditional_read_rules.ts`；`zzzz20260319103000`；`zzzz20260715180000:26`。
- 前端：`MultitableWorkbench.vue:113-118`；`MetaSheetViewRail.vue:96-111`；`useTemplateInstall.ts:38-41`。
- 客户材料（PR #6074 分支）：`docs/development/takeover-beiliao-20260821/customer-anomaly-triage-20260924.md:181-190`、`:216`；`customer-reply-20260924.md:45`、`:62`。

## 附录 B：否定性结论与搜索词

- **无表级复制路由**：`grep -n -E "router\.post\('[^']*(duplicate|import|export|copy)[^']*'" univer-meta.ts` 只命中 `:15710`、`:19301`。
- **无通用异步作业框架**（范围：仓内 `packages/core-backend/src`）：`grep -rln -i -E "class .*Job(Runner|Queue|Service)|job_runs|async_jobs|bullmq|pg-boss"` 命中 `automation-job-service.ts`（只持久化）、`ai-bulk-job-service.ts`、`recovery-archive-restore-jobs.ts`、`QueueService.ts`（头注释称支持 Bull/BullMQ 与内存队列，`:1-4`；实际接线为进程内）、`workflow-job-contract.ts`（头称 contract-only，但词表已被三处运行时 import，§1.13）及考勤导入系列。结论限于「没有可直接复用的通用**执行**框架」。
- **`meta_sheets` 无 provenance 列**：`grep -rn -i -E "copied_from|duplicated_from|source_sheet_id|cloned_from" packages/core-backend/src/db/migrations` 零命中。
- **UI 无托管徽标**：`grep -rn -E "pluginManaged|isPluginManaged|managedBy|plugin_managed" univer-meta.ts apps/web/src/multitable` 零命中。
- **`POST /sheets` 不写授权行**：`univer-meta.ts:15638-15684`。
- **`RecordService` 无批量接口、无 batchId/source 入参**：`grep -n -E "async (createRecords|bulkCreate)|batchId|source:" record-service.ts` 只命中 `:779` 的 `source: 'rest'`。
- **无事务绑定的 `RecordService` 构造先例**：`grep -rn "new RecordService(" packages/core-backend/src` 全部传 `pool`。
- **`POST /sheets` 无审批投影 Base 拒绝**：`grep -n "APPROVAL_PROJECTION_BASE_ID\|isApprovalProjectionBaseId" univer-meta.ts` 在 `:15561-15708` 区间零命中。
- **无 `sheet.copied` 事件**：`grep -rn "sheet.copied" packages/core-backend/src` 零命中。

## 附录 C：评审回合处置（r1 → r2）

两轮评审合并去重；A = 第一轮、B = 第二轮。**全部采纳，无拒绝项。**

| 项 | 处置 | 落点 |
|---|---|---|
| A-B1 / B-B1 行级 deny 丢失、规则丢弃翻 allow、autoNumber 规则错位 | 修：`record_permissions` 全量 remap；规则永不丢弃（未建列 → 拒绝）；autoNumber 规则 + 重编号 → 拒绝；事务内拒绝集断言 | CS-7、CS-12、§4.3 |
| A-B2 / B-SF10 CS-8 私有模式既不私有又升级 | 修：撤回 CS-8 及其 Ratified-by-default；S1 只有 `inherit`；私有原语 → §11-1 | CS-8、§4.5 |
| A-B3 冻结值越过外读边界 | 修：永不跨外读边界冻结；S1 同 Base；跨 Base 保活或不建；冻结仅限源内输入列 | CS-3、CS-10 |
| A-B4 逐行 record.created 出网 | 修：复制扩展抑制三类事件；一条 values-free 表级事件；真库零投递断言 | CS-19、§7.3-7.4 |
| B-B2 `newSheetCaps` 未定义、只读复制者失败、先写授权理由错 | 修：服务端常量能力；记录先于授权；测试加表级读者用例 | §4.4、§7.2-7.3 |
| B-B3 单事务 `created_at` 同值、序被打乱 | 修：序数时间戳；测试断言序相等 | CS-13、§7.3 |
| A-S1 TOCTOU | 修：`FOR SHARE` + DB-fresh 事务内终审 | §4.1 |
| A-S2 / B-SF8 配置修订缺失 | 修：逐条 field/view/permission create 修订共用 batchId；不写 sheet_config；双审计行 | CS-17、§7.7 |
| A-S3 / B-SF3 `RecordService` 能力不存在 | 修：显式锁定 `copy` 扩展（batchId/source/created_at/created_by/抑制/shape-only/fieldId） | §7.3 |
| A-S4 facade 先例不成立 | 修：直接给出 facade 构造，声明无先例；回滚测试断 records/links 0 行 | §7.2、§9 |
| A-S5 / B-SF11 property-hidden 列 | 修：建列；值仅复制者持源 `canManageFields` 时复制，否则留空并披露 | §4.1 |
| A-S6 / B-SF9 write-own 证明错 | 修：保留 `created_by`；备选进 §11-3 | CS-13、§4.4 |
| A-S7 / B-SF4 button 原样、remap 不全 | 修：button 降为 `record_click` 无 `actionConfig`；fail-closed allowlist + remap 表 | CS-9、§5.2 |
| A-S8 未登记表任何插件可达 | 修：hook 对 `copied_from_kind='plugin-managed'` 任何模式拒绝 | CS-14、§6 |
| A-S9 目标门两套谓词、投影排除引用错 | 修：`resolveBaseWritable` ∩ 可读；显式拒审批 / e-learning 投影 | CS-3 |
| B-SF1 复用 `hasFullTableReadAccess`、不回计数、污点轴 | 修：原样复用；`COPY_SOURCE_NOT_FULLY_READABLE` 无计数 | CS-5、§4.1 |
| B-SF2 grandfather 值致全失败 | 修：shape-only、省略 null；dry-run 预检计数 | CS-21 |
| B-SF5 S1 不闭合、非 M | 修：S1 同 Base、无去隐藏列、传递依赖逐列披露、跑字段创建校验；S1 = L | CS-3/6/20、§9 |
| B-SF6 去重锁序、指纹缺参 | 修：锁为事务第一条语句；指纹加 withData/permissionMode | CS-16、§7.2 |
| B-SF7 重算失败静默 | 修：201 body + toast + 重试路径 | §3、§8 |
| B-SF12 autoNumber 静默改号 | 修：dry-run 披露 N 行将变化 | CS-12 |
| B-SF13 S3 与二值结果矛盾 | 修：隐藏 building 态 + 单源快照 + 硬清除 | CS-18、§7.6 |
| Nits（两轮共 25 条） | 全部采纳：`:9363/:10037`；`spreadsheet:admin` + `user_id`；`hasAssignments` 按人；`:8227` 语义；附件 `field_id` NULL；门定义改为复用；filter 叶子删除；仅会话；dry-run 先门后 COUNT；拒绝尝试审计；S3 硬清除；S4 选项只对过门者；附录 B 范围化（`workflow-job-contract` 运行时 import、`QueueService` 头注释）；`:837` 纳入；REPEATABLE READ；名册性能实测；首个失败即停；`fld_` 前缀；CS-16/17 交叉引用；CS-3 与 `GET /bases` 过滤 | 各处 |
