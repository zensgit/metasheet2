# 「复制数据表（含数据）」设计锁 ADR（2026-09-26）

> 状态：**设计锁（Design Lock）**，docs-only，不含实现。
> 基线：`origin/main` @ `51acbb18f`（2026-09-26）。以下每条 `path:line` 在该 commit 上成立；main 前进后按符号名重定位，合并前 rebase 重跑。
> owner 决定（2026-09-25，记录于 PR #6074 `customer-anomaly-triage-20260924.md` §2.8 与 §3-B、issue #5864 讨论）：**「复制数据表（含数据）」作为独立功能开发；复制时保留表权限与字段权限；模板入口可以提供复制数据的选项。默认的模板本身仍然不带数据：共享模板带数据会越过权限，所以带数据只能走「复制」动作，并且要校验复制者对源数据的读权限。**
> 标 `Ratified-by-default-2026-09-26` 的条目按 AGENTS.md「默认前进 + 24h 异步否决」执行，owner 可否决。Refs #5864、#5909、#5861。

## 0. 一句话

服务端新增「复制数据表」动作：以复制者对源表的**全表读**为门、对目标 Base 的**建表权**为门，在一个事务里建新表（结构 + 视图 + 表级/字段级授权**逐行复制**），并经 `RecordService.createRecord` 逐行写入数据；复制物是**非托管快照**，永不进模板中心、永不登记到插件。「带数据」永远是复制**动作**，不是模板**内容**。

## 1. 现状与约束（读码结论）

1. **模板 values-free 是按构造证明的**：`POST /templates` 只 SELECT 四张结构表、不碰 `meta_records`（`packages/core-backend/src/routes/univer-meta.ts:8190-8193`）；抽取器白名单 property、丢 filter/sort、所有 id 重编号（`packages/core-backend/src/multitable/custom-template-store.ts:9-17`）；link/lookup/rollup/formula 降级为文本（`custom-template-store.ts:106`）。这一性质本 ADR **不改**。
2. **模板反查不到源表**：源库 sheet/field/view id 一个都不落进模板 JSON（`custom-template-store.ts:16-17`）。所以「使用模板 + 带数据」只能靠新增 provenance（§9 切片 4），不能从模板内容推出。
3. **「使用模板」只能新建 Base**：`baseId` 省略即 mint 新 id（`packages/core-backend/src/multitable/template-library.ts:579`），落已有 Base 撞 `Base already exists`（`:591-600`）；四个前端调用面都不传 `baseId`（issue #5909；`apps/web/src/multitable/composables/useTemplateInstall.ts:38-41`）。本 ADR 的「目标 = 当前 Base」独立于 #5909，不改 `installMultitableTemplate`。
4. **客户临时办法「导出 → 导入」不继承权限**（triage §2.8 `:190`）：`import-xlsx` 逐行 `createRecord`（`univer-meta.ts:15768-15772`），`POST /sheets` 只写 `meta_sheets` + 默认视图、不写任何授权行（`:15638-15660`）。按部门隐藏的列在新表里对所有全局读者可见——这正是本功能要关掉的洞。
5. **单条记录复制已有先例** `POST /records/:recordId/duplicate`（`univer-meta.ts:19301`）：源读门 `requireRecordReadable`（`:19342`），链接值从 `meta_links` 覆盖（`:19358`），只复制「可读 ∧ 可写」字段（`:19371-19378`），再走 `createRecord`（`:19387`）。本功能是它的表级推广；字段口径不同，见 §4.1。
6. **记录写路径唯一入口** `RecordService.createRecord`（`packages/core-backend/src/multitable/record-service.ts:534`）：`canCreateRecord` 门（`:545`）、写围栏（`:561-575`）、系统/派生只读字段拒绝写入（`:609-611`）、select 选项校验（`:623-631`）、link 外表记录存在性校验 + `meta_links` 写入（`:641-672`、`:757-762`）、attachment 归属校验（`:680-696`）、autoNumber **强制**分配覆盖入参（`:733-737`）、`INSERT ... created_by = actor`（`:739-744`）、同事务修订（`:774-785`）、formula 重算 best-effort（`:803-819`）。任何绕开它的批量 INSERT 不在本设计内。
7. **权限表**：`spreadsheet_permissions` 主键 `(sheet_id, subject_type, subject_id, perm_code)`（`packages/core-backend/src/db/migrations/zzzz20260406030000_add_spreadsheet_permission_subjects.ts:63-65`），主体含 `member-group`（`zzzz20260418143000_allow_member_group_multitable_permission_subjects.ts`）；`field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)`（`zzzz20260411140100_create_field_permissions.ts`）；`meta_view_permissions`（`zzzz20260411140000`）；`record_permissions`（`zzzz20260413100000`）；`meta_sheets.row_level_read_permissions_enabled`（`zzzz20260617140000_rowlevel_read_deny_foundation.ts:24`）与 `conditional_read_rules`（`zzzz20260618120000_conditional_read_rules.ts`）。读侧合成：字段 `visible` 取 AND、`read_only` 取 OR（`packages/core-backend/src/multitable/permission-service.ts:859-900`）；表级 `hasAssignments` 为真时能力与授权取交、`canManageSheetAccess = scope.canAdmin`（`:1473-1498`）。
8. **托管表**：`plugin_multitable_object_registry` 以 `sheet_id` 为主键、只在 provisioning 事务里写入、是「哪张表归插件」的唯一记录（`packages/core-backend/src/multitable/sheet-delete-guard.ts:17-27`）；删表 409（`univer-meta.ts:15363-15364`）、删字段同门（`packages/core-backend/src/multitable/managed-field-delete-guard.ts`）。托管表里插入的「野行」不带 PLM 键、刷新不认（PR #5647 正文）。**UI 目前没有托管徽标**（见附录 B）。
9. **附件**：`multitable_attachments.sheet_id` 为 `NOT NULL` 外键、`storage_file_id` 唯一索引（`zzzz20260319103000_create_multitable_attachments.ts`）；`createRecord` 校验附件 id 必须属于**同 sheet 同 field**（`packages/core-backend/src/multitable/attachment-service.ts:321-346`）；blob 有独立清理生命周期（`zzzz20260711090000_add_multitable_attachments_blob_purged_at.ts`、`zzzz20260919120000_add_attachment_blob_purge_claim.ts`）。所以复制表**不能**引用源表附件行，也不宜与源表共享 blob。
10. **异步作业**：仓内没有通用作业框架（附录 B）。最近可复用：`packages/core-backend/src/services/ai-bulk-job-service.ts`（`QueueService` 进程内 worker + header/rows 两表 + claim guard + cancel；表 `multitable_ai_bulk_job`，`zzzz20260622120000_create_multitable_ai_bulk_job.ts:46-62`；状态/取消路由 `packages/core-backend/src/routes/multitable-ai.ts:1297`、`:1374`）；`packages/core-backend/src/multitable/workflow-job-contract.ts` 是状态词表、contract-only 未接线（`:1-15`）。
11. **去重先例**：`packages/core-backend/src/multitable/template-install-dedupe.ts`（意图指纹 + 咨询锁 + 账本主键 + 重放前存活核对；窗口 5 分钟 `:91`，锁等待上限 `:98`）。
12. **Time Machine**：`meta_record_revisions.batch_id` 一次用户动作一批（`zzzz20260619120000_add_meta_record_revisions_batch_id.ts` 头注释）；投影按 `COALESCE(batch_id, id)` 分批（`packages/core-backend/src/multitable/history-projection.ts:5-9`）；`source` 是开放字符串（`packages/core-backend/src/multitable/record-history-service.ts:20`），`batchId` 可由调用方指定（`:37`、`:121`）。
13. **大小基线**：客户当前表 55 列 × 1239 行（PR #6074 `customer-reply-20260924.md:45`、`:62`）；`XLSX_MAX_ROWS = 50_000`（`packages/core-backend/src/multitable/xlsx-service.ts:5`）；聚合上限默认 10000（`univer-meta.ts:16212`）；连接池 `statement_timeout` 默认 30s（`template-install-dedupe.ts:45-47` 引）。

## 2. 决策清单（锁定）

| # | 决策 | 依据 / 备注 |
|---|---|---|
| CS-1 | 独立动作：`POST /api/multitable/sheets/:sheetId/copy`。模板 JSON 形状不变、永不带数据。 | owner 决定；§1.1 |
| CS-2 | 三个入口：① 侧栏当前数据表操作区「复制数据表」（与重命名/删除同排）；② 「存为模板」弹窗底部「改为复制数据表（含数据）」；③ 模板中心「使用模板」的「同时复制数据」只对带 provenance 的自定义模板出现（切片 4）。 | `MetaSheetViewRail.vue:96-111`、`MultitableWorkbench.vue:113-118` |
| CS-3 | 目标 Base：默认当前 Base；可选「我能建表的 Base」。目标门 = `POST /sheets` 同一规则。 | `univer-meta.ts:15600-15617`；`permission-service.ts:1962-1984` |
| CS-4 | 默认名「<源表名> 副本」；沿用显示名 hygiene 拒绝。 | `univer-meta.ts:15497-15500` |
| CS-5 | 源侧门 = `canRead`（scoped）∧ 源表**全部**字段对复制者可见 ∧ 无行级规则作用于复制者。任一不满足 → 拒绝（fail-closed，带码）。 | §4.1 |
| CS-6 | 复制者看不见的字段：默认拒绝整次复制；显式选项「去掉我无权查看的列」= **整列不建**（不是建空列、不是暗复制值）。 | §4.1 |
| CS-7 | 权限复制（默认，owner 决定）：`spreadsheet_permissions` / `field_permissions` / `meta_view_permissions` / 行级开关 + `conditional_read_rules`（remap）**逐行复制**，主体一一对应（同租户）；**一行不多、一级不升**；不给复制者追加任何授权行。 | §4.3 |
| CS-8 | 「仅自己可见」模式：不复制任何授权行，只写复制者 `admin` 一行。`Ratified-by-default-2026-09-26`。 | §4.3 越权分析 |
| CS-9 | `record_permissions` 不复制（记录 id 全部变化）；结果面披露被丢弃条数。 | §4.3 |
| CS-10 | 字段语义按 §5 表：同 Base 内 link/lookup/rollup/formula **保活**（id remap），跨 Base **冻结**为文本/数字。 | §5 |
| CS-11 | 附件：切片 1 不复制附件值（列保留、值为空并披露）；切片 2 复制 blob（新 storage key、新行），**不共享** blob。 | §1.9 |
| CS-12 | autoNumber：经 `createRecord` 重新编号（源按 `created_at ASC, id ASC` 写入，无删除历史时序号与源一致）；不保留源号。「冻结为数字列」为切片 2 选项。 | `record-service.ts:733-737`；`auto-number-service.ts:36-73` |
| CS-13 | createdTime / modifiedTime / createdBy / modifiedBy 反映复制动作，不作为数据保留。 | `record-service.ts:609-611`；`field-codecs.ts:1155-1161` |
| CS-14 | 托管表可作为源；复制物**永不登记** registry、可删可改结构、PLM 不刷新；`meta_sheets` 新增 `copied_from_sheet_id / copied_from_kind / copied_at` 三个可空列；UI 徽标「快照副本」。系统表拒绝作为源。 | §6 |
| CS-15 | 执行：切片 1 单事务同步，行数 ≤ N（默认 2000，env `MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS`，登记 flag manifest）；事务内经 txn-bound facade 调 `createRecord`；`fenceWriterEntry(newSheetId)`；全部修订共用一个 `batch_id`、`source = 'copy-sheet'`；超 N 在切片 3 前回 413；绝对上限 50 000。 | §7 |
| CS-16 | 幂等：复用 `template-install-dedupe` 机制，意图 = (tenant, actor, kind=`copy-sheet`, sourceSheetId, targetBaseId, name)，5 分钟窗口重放 201 + `Idempotent-Replayed`。 | §7.7 |
| CS-17 | 审计 values-free：结构化事件 `[multitable.sheet.copy]`（只有 id / 计数 / 模式 / 耗时）+ `operation_audit_logs` 一行（事务内）+ 新表 `sheet_config` create 配置修订带 `copiedFromSheetId`。 | §7.8 |
| CS-18 | 原子性：切片 1 全有或全无；任一行失败整体回滚并返回 `rowIndex + fieldId + code`（无值）。切片 3 异步 = 分块提交、可取消、失败即回收半成品，**不是**可续跑。 | §8 |
| CS-19 | 切片：1 结构 + 普通值 + 权限（同步）；2 附件 blob + 自链接 remap + 冻结选项；3 异步作业/进度/取消；4 模板 provenance + 「使用模板同时复制数据」。 | §9 |
| CS-20 | 测试：真库集成（`usePinnedServer`）+ 单元；清单见 §9。 | `packages/core-backend/tests/utils/pinned-server.ts` |

## 3. 用户可见行为

- **弹窗**：源表（只读显示）；新表名（默认 CS-4）；目标 Base（下拉，默认当前，只列复制者可建表的 Base）；「包含数据（共 N 行）」（默认勾，N 来自服务端 COUNT）；「权限」单选：与源表相同（默认）/ 仅自己可见；高级：「去掉我无权查看的列（M 列）」只在服务端预检报告 M > 0 时出现。
- **预检**：打开弹窗即调 `POST .../copy/dry-run`（零写，与模板 dry-run 同一先例 `univer-meta.ts:8602-8608`）：回 行数、列数、隐藏列数、会被降级/冻结/丢弃的列（按 fieldId 与原因码）、会丢弃的项目（附件值、记录级授权、自动化…）、是否超同步上限。
- **结果**：成功后跳转新表；toast 披露「复制 X 行 / Y 列 / Z 条授权；未复制：附件值、记录级授权、自动化、评论、订阅、表单分享、锁定状态、修订历史」。
- **徽标**：新表名旁「快照副本」；来源为托管表时追加「不随 PLM 刷新」。徽标只依赖服务端列（CS-14），不依赖描述文本。
- **「私有默认」的口径**（计算任务文本与 owner 决定的冲突在此消解）：私有 = 不比源表更公开、不进模板中心、不共享给租户；默认权限口径按 owner 决定「与源表相同」，「仅自己可见」为显式选项。源表本身无授权行时复制表也无授权行——这正是「相同」（见 §4.3 的 `hasAssignments` 陷阱）。
- `/context` 增一个 `canCopySheet` 位（= 源 `canRead` ∧ 当前 Base 可建表），与 `canDeleteSheet` 同形（`univer-meta.ts:9037`），只做显隐，服务端再门。

## 4. 权限模型

### 4.1 源侧门（读）

「全表读」定义为三条同时成立：

- (a) `resolveSheetCapabilities(source).canRead`，含表级授权交集（`permission-service.ts:1473-1498`）与投影表/系统表过滤（`filterReadableSheetRowsForAccess`，`:1686`）。
- (b) 字段读面覆盖源表全部 property-可见字段：以记录读路径的同一条链计算（`loadAllowedFieldIds` `univer-meta.ts:5008` → `maskStoredRecordFieldIds` `:3625`），若存在任何 `visible = false` 命中复制者的字段 → 拒绝，码 `COPY_SOURCE_FIELDS_HIDDEN`，body 只带 `hiddenCount`（不带字段名）。
- (c) 行级：`row_level_read_permissions_enabled = true`（`permission-service.ts:919`）且复制者非 admin 且（`conditional_read_rules` 非空，或 `record_permissions` 对其存在任何 deny，`:1200`、`:1338`）→ 拒绝，码 `COPY_SOURCE_ROWS_RESTRICTED`。

为什么隐藏字段是**拒绝**而不是留空或暗复制：

- 暗复制隐藏值（复制者读不到、但服务端搬过去并复制隐藏规则）在 CS-8 私有模式下复制者成为 admin 即可解锁；即使在 CS-7 模式下，日后任何一次授权变更都会让「复制者从未读过的值」经他之手落到新表。values-free 原则是：不经复制者读面的数据不由他触发流动。
- 建空列 + 复制隐藏规则，对被授权看这列的人是谎言（他会以为数据丢了）。
- 因此唯一诚实的选项是「整列不建」，并在弹窗与结果面说明数量。默认仍是拒绝，避免一键复制出结构残缺的表而不自知。

与单记录 `duplicate` 的差别：`duplicate` 只复制「可读 ∧ 可写」字段（`univer-meta.ts:19371-19378`），因为它写的是同一张表、要尊重列的业务只读。表级快照里「不可写」不是丢弃理由（只读列的值正是要保留的历史），只有「不可读」才是。

### 4.2 目标侧门（写）

- 目标 Base 存在且 live；复制者 `canManageViews` 或为 Base owner（`univer-meta.ts:15600-15617`；跨 Base 复用 `resolveBaseWritable` 的 fail-closed 口径，`permission-service.ts:1962-1984`）。
- 目标不得是审批投影 Base / e-learning 投影（`univer-meta.ts:15586-15591`）。
- 新表 id 服务端 mint（`buildId('sheet')`），`fenceWriterEntry(newSheetId)`（`:15623`）与「不得回溯造成跨 Base 链接」检查（`:15628-15636`）照跑。
- 复制者**不需要**源表的 `canManageSheetAccess`（`:9364`）或 `canManageFields`（`:10038`）：授权复制不是「授权写」，它不产生任何源表上不存在的（主体, 级别）对；见 4.3 不升级证明。

### 4.3 授权复制

| 表 / 项 | 复制方式 | 备注 |
|---|---|---|
| `spreadsheet_permissions` | 逐行 `(new_sheet_id, subject_type, subject_id, perm_code)` | 主体照抄；同租户无需映射（Base 与 sheet 同部署同租户，租户只由 `authenticatedTenantId` 决定） |
| `field_permissions` | 逐行，`field_id` remap；`created_by` 重打为 `operatorFieldPermissionCreatedBy(actor)` | 与授权路由同源（`univer-meta.ts:10117`）；**不带**源表 pack 标记，备料 pack 的 reconcile 只认自己 sheet 矩形内自己标记的行（`packages/core-backend/src/services/stock-preparation-field-permissions.ts` 头注释），复制表永不被它当作自己的 |
| `meta_view_permissions` | 随视图复制，`view_id` remap | |
| `row_level_read_permissions_enabled` / `conditional_read_rules` | 复制；规则 `fieldId` remap；引用被去掉列的规则整条丢弃并披露 | |
| `record_permissions` | **不复制** | 记录 id 变化；披露条数 |
| `meta_view_personal_configs` | 不复制 | 个人覆盖层（`zzzz20260705150000`） |

**不升级证明**：新表上的每一行授权都是源表某一行的投影；复制者自己没有新增行；复制者在新表上的能力 = 在源表上的能力（同一 scope 形状经 `applySheetPermissionScope` 得到同一结果）。复制者若在源表只是读者，在新表也只是读者——这是刻意的，不是缺陷；他可以请源表 admin 处理，或选 CS-8。

**`hasAssignments` 陷阱**（为何 CS-7 恒不追加行）：`applySheetPermissionScope` 在 `hasAssignments` 为真时把能力与授权取交（`permission-service.ts:1478-1498`）。源表无授权行时若给复制者写一行 admin，新表立刻翻成授权模式，所有靠全局 `multitable:read` 看源表的人在新表上全被关在外面——与「保留权限」相反。因此只有 CS-8 才写行。

**CS-8 越权分析**：复制者对新表全部数据本就可读、可导出（`canExport = canRead`，`packages/core-backend/src/multitable/access.ts:146`、`permission-service.ts:1498`）；admin 一行只让他能在系统内再授权，等价于把 XLSX 发给别人。owner 可否决为「私有模式仅 `canManageSheetAccess` 持有者可用」（§11-1）。

## 5. 字段类型语义

| 类型 | 结构 | 值（同 Base） | 值（跨 Base） | 说明 |
|---|---|---|---|---|
| string / longText / number / boolean / date / dateTime / select / multiSelect / currency / percent / rating / duration / url / email / phone / barcode / qrcode / location | property **全量**经 `sanitizeFieldProperty`（`field-codecs.ts:227`）复制，含 select 选项值与颜色 | 原值经 `createRecord` 校验 | 同 | 不走模板白名单（那是跨库场景）；select 值必在选项内（`record-service.ts:623-631`），选项同源复制故恒成立 |
| person | property 复制（`limitSingleRecord`、`restrictToMemberGroupIds` 同租户有效） | 原值；经成员名册校验（`record-service.ts:613-621`，名册 `permission-service.ts:614-626`） | 同 | 授权行**先于**记录写入以保证名册一致；已停用用户会使该行失败 → §8 / §11-7 |
| attachment | 列保留 | 切片 1 值为空并披露；切片 2 复制 blob 并建新行 | 同 | §1.9 |
| link（正向，外表 ≠ 源表） | `foreignSheetId` 保持；`twoWay → false`、`mirrorFieldId` 丢弃（否则要在外表建镜像列 = 对外表的 schema 写） | 值从 `meta_links` 读（`univer-meta.ts:19358` 先例）→ `createRecord` 校验外表记录存在（`record-service.ts:652-667`） | **冻结**为 string（显示文本） | 跨 Base 需 `foreignBaseId` 显式声明过墙（`univer-meta.ts:1982`），切片内不做 |
| link（自链接，外表 = 源表） | 同上，`foreignSheetId → 新表` | 切片 1 列保留、值为空并披露；切片 2 两遍写（先全部记录，再经 `RecordWriteService` patch remap 后的 id） | 冻结为 string | 需要 recordId 映射表 |
| link 镜像列（`mirrorOf`） | **不建**（派生列，属于外表的 link） | — | — | `permission-derivation.ts:66`；披露 |
| lookup / rollup | `linkFieldId` remap；`targetFieldId` 指外表字段不变、自链接时 remap（键名 `field-codecs.ts:353-417`） | 读时计算，无需复制（`record-service.ts:806`） | 冻结为 string / number | 引用被去掉列 → 冻结 |
| formula | `expression` 中 `{fld_…}` 逐个 remap（`packages/core-backend/src/multitable/formula-engine.ts:16`、`:72-90`） | 复制完成后一次 chunked 重算（best-effort，`univer-meta.ts:14141` 先例） | 冻结 | 引用被去掉/降级列 → 冻结为文本 |
| autoNumber | property 复制；新表序列懒建（`auto-number-service.ts:36-58`） | 经 `allocateAutoNumberValues` 重新编号 | 同 | CS-12 |
| createdTime / modifiedTime / createdBy / modifiedBy | property 复制 | 反映复制动作 | 同 | `createRecord` 拒绝作为输入（`record-service.ts:609-611`） |
| button | property 复制（同租户） | 无值 | 同 | 自动化不复制 |
| 未知类型 | 该列拒绝复制并披露 | — | — | fail-closed |

## 6. 托管表与系统表

- **可作为源**：托管表（registry 有行）只要过 §4.1 门就能复制——这是客户要的「把备料表连数据复制一份去分析」。
- **复制物是非托管快照，按构造成立**：registry 行只在 provisioning 事务里 mint（`sheet-delete-guard.ts:17-27`）；复制路径不调 `ensureObject`，新 sheet id 与 `getObjectSheetId` 派生无关；插件刷新只写自己 registry 里那张表。因此复制表：可删（`univer-meta.ts:15363` 不命中）、可改字段（`managed-field-delete-guard.ts` 不命中）、`ext_` 列成为普通列、PLM 永不刷新它。真库测试断言 `plugin_multitable_object_registry` 无新表行。
- **标签是服务端列，不是描述文本**（描述客户端可写、不可信，`sheet-delete-guard.ts` 同一论证）：`meta_sheets` 新增可空列 `copied_from_sheet_id text`、`copied_from_kind text`（`user | plugin-managed`）、`copied_at timestamptz`；惰性迁移，旧行全 NULL。`GET /context` 与 sheet 列表透出 `copiedFrom: { kind, at, sheetId? }`——`sheetId` 只对能读源表的人透出。
- **系统表拒绝作为源**：`system_kind` / People 哨兵（`packages/core-backend/src/multitable/system-sheet-predicate.ts:55`）、审批投影 Base、e-learning 投影 sheet；码 `COPY_SOURCE_SYSTEM_SHEET`，在门之后回（未授权者不得知其为系统表）。

## 7. 执行模型

### 7.1 路由

`POST /api/multitable/sheets/:sheetId/copy`，body：`{ name?, targetBaseId?, withData: boolean, permissionMode: 'inherit' | 'private', dropHiddenFields?: boolean }`；`POST .../copy/dry-run` 同形、零写。`rbacGuard('multitable','write')` 之后再做 §4 两侧门（与 `POST /templates` 同层次）。

### 7.2 单事务顺序（切片 1）

1. 门：源读（§4.1）→ 目标写（§4.2）→ 源 liveness → 系统表拒绝。
2. 去重：咨询锁 + 读账本（§7.7）。
3. `BEGIN` → `fenceWriterEntry(newSheetId)` → `INSERT meta_sheets`（含 provenance 三列）→ 字段（新 id，建 `oldFieldId → newFieldId` 映射；property 经 §5 remap + `sanitizeFieldProperty`）→ 视图（`filter_info / sort_info / group_info / hidden_field_ids / config` remap；**整段剥离 `config.publicForm`**，它装着分享令牌 `univer-meta.ts:828-868`；A4「复制视图」同一口径）→ 授权行（§4.3）→ `sheet_config` create 配置修订（`recordConfigRevision` 先例 `:15526-15536`）。
4. 源记录**一条** `SELECT ... WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT N+1`（单语句 = 单快照；第 N+1 行存在即回滚 413）；link 值按 `meta_links` 覆盖；逐行 `recordService.createRecord({ sheetId: newSheetId, data: remapped, actorId, capabilities: newSheetCaps })`，`RecordService` 由 txn-bound facade 构造（`{ query, transaction: (h) => h({ query }) }`，先例 `packages/core-backend/src/multitable/automation-service.ts:1397`、`univer-meta.ts:12434`），formula hook 关闭，所有修订共用一个 `batchId`、`source: 'copy-sheet'`（`record-history-service.ts:37`、`:20`）。
5. `operation_audit_logs` 一行（`univer-meta.ts:5107` 形状）→ 账本写回 → `COMMIT`。
6. 提交后：chunked formula 重算（best-effort，失败只记日志）；`invalidateSheetSummaryCache / invalidateFieldCache / invalidateViewConfigCache`（`:15375-15377`）；结构化日志。

### 7.3 副作用说明

- `createRecord` 内的 `enqueueRecordEventIfDurable('multitable.record.created')`（`record-service.ts:797`）在事务内、随提交生效；新表无自动化规则（不复制）→ 无动作。`publishMultitableSheetRealtime`（`:821`）在 facade 下发生在提交前，新表尚不可见 → 无害。
- 每行 `acquireCanonicalSheetFence(newSheetId)`（`:573`）是事务级咨询锁、可重入。**源表不加写围栏**：快照来自单条 SELECT，源表并发写既不阻塞也不进入快照。
- `MULTITABLE_ENABLE_WRITER_FENCE` 默认 OFF（`packages/core-backend/src/multitable/canonical-sheet-fence.ts:25-30`）；开启时 `fenceWriterEntry` 的 durable-block 检查对新表照常生效。

### 7.4 大小与上限

- 同步上限 N = 2000 行（客户 1239 行落在内；每行约 6-8 条语句，秒级）；env `MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS`，登记 `scripts/ops/global-history-flag-manifest.mjs`（numeric）。
- 字段 ≤ 500（与模板同量，`univer-meta.ts:8227`）。
- 绝对上限 50 000 行（= `XLSX_MAX_ROWS`），异步也不超；超出回 413 `COPY_TOO_LARGE` 并建议按视图导出。

### 7.5 异步作业（切片 3，> N 行）

- 表 `multitable_sheet_copy_job`，照 `multitable_ai_bulk_job` 形状：`job_id, actor_id, source_sheet_id, target_base_id, target_sheet_id, status, total, copied, error_code, created_at, updated_at, expires_at`；`status` 用 `workflow-job-contract.ts` 词表；partial unique index 保证同 (actor, source_sheet_id) 至多一个活跃作业（BJ-7 先例）。
- worker：`QueueService` 进程内（`ai-bulk-job-service.ts` 头注释）；claim guard（queued → running）；每块 1000 行一个事务、块间检查取消位；进度 `GET .../copy-jobs/:id`；取消 `POST .../copy-jobs/:id/cancel` → 置 cancelled 并软删半成品表（与 `DELETE /sheets` 同一事务形状 + fence）。
- 崩溃恢复：启动扫描 `running` 且超时 → `failed` + 回收半成品。因此异步是「成功即完整、失败即回收」，不是可续跑（CS-18）。

### 7.6 幂等 / 重试

复用 `template-install-dedupe.ts`：把 `templateId` 一般化为 `intent_kind + intent_key`（迁移加 `intent_kind text NOT NULL DEFAULT 'template-install'`），指纹加入 kind 前缀；窗口 5 分钟；重放前核对新表 live；账本缺表 fail-open（照常复制，与 `univer-meta.ts:8506-8520` 同）。客户端重试同一意图拿回同一张表。

### 7.7 审计（values-free）

- `[multitable.sheet.copy]`：`{ sourceSheetId, targetSheetId, targetBaseId, userId, ok, rowCount, fieldCount, droppedFieldCount, permissionRowCount, permissionMode, withData, durationMs, statusCode?, errorCode? }`——只有 id、计数、模式；不记名字、不记值（与 `[multitable.template.save-as]` 同口径 `univer-meta.ts:8350-8359`）。重放走独立 token `[multitable.sheet.copy.replayed]`（不同动作不同 token，`:8530-8535`）。
- `operation_audit_logs`：`action = 'multitable.sheet.copy'`，`resource_id = targetSheetId`，`metadata` 同上计数。
- Time Machine：新表历史从一批 `create` 修订开始（一次动作一批，LOCK-12），源表历史不带过来；`source = 'copy-sheet'` 让投影可区分。

## 8. 失败模式与原子性

| 情形 | 行为 | 码 |
|---|---|---|
| 门不过 | 401 / 403（不透露源表是否存在） | `FORBIDDEN` |
| 源表在门后被软删 | 事务内回查 `deleted_at` → 回滚 | 404 `SHEET_NOT_LIVE` |
| 目标 Base 被删 / 不可写 | 回滚 | 404 / 403 |
| 复制者有隐藏列且未选「去掉」 | 拒绝 | 422 `COPY_SOURCE_FIELDS_HIDDEN { hiddenCount }` |
| 行级规则作用于复制者 | 拒绝 | 422 `COPY_SOURCE_ROWS_RESTRICTED` |
| 行校验失败（select 值不在选项、person 已停用、link 外表记录不存在、longText 超限…） | 整体回滚 | 422 `COPY_ROW_VALIDATION_FAILED { failures: [{ rowIndex, fieldId, code }] }`，最多 50 条，**不带值** |
| 写围栏冲突 | 回滚 | 409（复用 `sendWriterFenceConflict`） |
| 超同步上限 / 绝对上限 | 拒绝 | 413 `COPY_TOO_LARGE { rowCount, limit }` |
| 幂等重放 | 原样 201 + `Idempotent-Replayed: true` | — |
| 去重账本缺表 | fail-open 照常复制 | — |
| 进程半途崩溃（同步） | PG 回滚，无残留、账本无痕 | — |
| 异步崩溃 / 取消 | §7.5 回收 | — |

选择全有或全无而不是可续跑（切片 1）的理由：快照的价值在「与源表某一时刻一致」；可续跑会跨多个源快照。异步切片用「块提交 + 失败回收」换取进度可见，但结果仍二值。

## 9. 交付切片与测试

| 切片 | 量 | 内容 |
|---|---|---|
| S1 | M | 路由 + dry-run + 两侧门 + 结构/视图/授权逐行复制 + 普通值 + provenance 三列迁移 + `canCopySheet` + 入口①② + 徽标 |
| S2 | M | 附件 blob 复制（总字节配额 env，默认 500 MB）+ 自链接两遍写 + 「冻结为文本/数字」选项 + autoNumber 冻结 |
| S3 | L | 异步作业表 + worker + 进度/取消 + 回收 |
| S4 | S-M | 自定义模板 `source_sheet_id` provenance 可空列 + 模板中心「同时复制数据」（复制的是 provenance 源表的**当前**数据，模板内容不参与；门同 §4；源表已删则选项不出现） |

**测试（S1 必含，真库走 `usePinnedServer()` + `request(pinned.url())`，`tests/unit` 里禁止 `request(app)`）**：

- 门：读者无 `canRead` → 403 且不区分存在性；隐藏列 → 422 带 `hiddenCount`；行级规则 → 422；目标 Base 无权 → 403。
- 授权逐行相等：复制后 `spreadsheet_permissions` / `field_permissions`（remap 后）/ 视图权限 / 行级配置与源表集合相等；复制者自身**无新增行**；源表无授权行时新表也无授权行（`hasAssignments` 不翻转，全局读者仍可读）。
- 私有模式：仅一行 `admin`，其余为空。
- 托管源：registry 无新表行；新表可 `DELETE /sheets` 成功；源表 registry 行不变。
- 系统表源 → 拒绝。
- 数据：1000 行 × 全类型夹具，值逐字段相等（autoNumber 按序重编、系统字段为复制时刻、附件为空、镜像列不存在、twoWay 降为单向）；`meta_record_revisions` 恰好一个 `batch_id`、`source = 'copy-sheet'`；历史投影显示一批。
- 回滚：注入第 k 行校验失败 → 新表、字段、授权、修订、账本全部不存在；响应不含任何单元格值（按字节扫描 body）。
- 幂等：同意图连发 3 次 → 一张表、后两次 `Idempotent-Replayed`。
- 单元：field-id remap（views / lookup / rollup / formula 表达式）；`config.publicForm` 剥离；跨 Base 冻结矩阵；日志事件 values-free 断言（无字段名、无值）。

## 10. 非目标

- 不做跨租户 / 跨部署复制；不做增量同步或镜像（那是「同步表」路线，已封存）。
- 不复制：修订历史、评论、订阅、自动化规则、表单分享（`publicForm`）、API token、记录锁（`locked / locked_by`）、`record_permissions`、个人视图配置、回收站。
- 不做「使用模板落到当前 Base」（#5909 独立）；不改模板 JSON 形状；不给模板加数据。
- 不绕过 `createRecord`；不在切片 1 做可续跑。

## 11. 待 owner / 客户 决定

1. 私有模式（CS-8）是否收紧为「仅 `canManageSheetAccess` 持有者可用」。默认按现文执行（Ratified-by-default）。
2. autoNumber 是否有业务上必须保留源号的列（备料单号语义？）——问客户；若有，S2 的「冻结为数字列」是否应成为该列默认。
3. 是否附加「源创建时间 / 源创建人」两列（默认不加）。
4. 同步上限 N = 2000、附件配额 500 MB 的取值。
5. 行级规则存在时是否允许「只复制我可见的行」并标注为部分快照（S3 之后）。
6. 跨 Base 复制时 link 是否改走 `foreignBaseId` 显式声明保活，而非冻结。
7. person 值指向已停用用户时：整体失败（现文）还是 S2「冻结为文本」自动兜底。
8. S4 provenance 会改变「自定义模板不含任何源 id」的现有性质（只记源 sheet id、不记字段 id，且只对能读源表者透出）——是否接受。

## 附录 A：证据索引（origin/main @ 51acbb18f）

- 模板：`packages/core-backend/src/routes/univer-meta.ts:8168`（GET）、`:8212`（POST，`:8190-8193` values-free、`:8199-8203` 默认 private、`:8266` canManageFields 门、`:8289-8302` 可读过滤、`:8350-8359` 只记计数）、`:8419`（install，`:8461-8474` 去重意图、`:8492-8520` 账本 fail-open、`:8530-8543` replayed token）、`:8602-8608`（dry-run 零写）。
- `packages/core-backend/src/multitable/custom-template-store.ts:9-17`、`:106`、`:112-147`、`:162-167`。
- `packages/core-backend/src/multitable/template-library.ts:568-600`、`:616`、`:629-638`。
- `packages/core-backend/src/multitable/template-install-dedupe.ts:12-23`、`:38-58`、`:62-66`、`:91`、`:98`。
- 记录写：`packages/core-backend/src/multitable/record-service.ts:534-834`（各点见 §1.6）；`packages/core-backend/src/multitable/record-history-service.ts:20`、`:37`、`:111-121`、`:200`；`packages/core-backend/src/multitable/history-projection.ts:5-9`。
- 权限：`packages/core-backend/src/multitable/permission-service.ts:614-626`、`:721`、`:859-900`、`:919`、`:1200`、`:1338`、`:1473-1498`、`:1686`、`:1962-1984`；`packages/core-backend/src/multitable/access.ts:119`、`:146`；`packages/core-backend/src/multitable/manage-schema-permission.ts:85`；`packages/core-backend/src/multitable/permission-derivation.ts:58-66`、`:70-75`；`univer-meta.ts:4694-4700`（`hasSheetLifecycleAuthority`）、`:4751`、`:5008`、`:3625`、`:9037`、`:9344-9364`、`:10015-10038`、`:10117`。
- 表 / 字段 / 视图路由：`univer-meta.ts:15338-15388`（DELETE）、`:15489-15559`（PATCH 改名）、`:15561-15708`（POST /sheets）、`:15710-15790`（import-xlsx）、`:19301-19387`（duplicate）、`:7905-7935`（GET /bases）、`:1188`、`:1982`、`:2049`、`:828-868`、`:5107`、`:14141`、`:16212`、`:466`。
- 字段类型：`packages/core-backend/src/multitable/field-codecs.ts:227`、`:353-429`、`:1061`、`:1155-1163`；`packages/core-backend/src/multitable/formula-engine.ts:16`、`:72-90`；`packages/core-backend/src/multitable/auto-number-service.ts:36-73`；`packages/core-backend/src/multitable/attachment-service.ts:321-346`；`packages/core-backend/src/multitable/link-writer-fence.ts`（`prepareLinkWriterFencePlan`）；`packages/core-backend/src/multitable/canonical-sheet-fence.ts:25-30`；`packages/core-backend/src/multitable/cross-base-write-authority.ts:1-30`。
- 托管 / 系统：`packages/core-backend/src/multitable/sheet-delete-guard.ts:1-40`；`packages/core-backend/src/multitable/managed-field-delete-guard.ts`；`packages/core-backend/src/multitable/system-sheet-predicate.ts:55`；`packages/core-backend/src/db/migrations/zzzz20260408123000_create_plugin_multitable_object_registry.ts`。
- 作业：`packages/core-backend/src/services/ai-bulk-job-service.ts:1-45`；`packages/core-backend/src/db/migrations/zzzz20260622120000_create_multitable_ai_bulk_job.ts:46-62`；`packages/core-backend/src/routes/multitable-ai.ts:1297`、`:1374`；`packages/core-backend/src/multitable/workflow-job-contract.ts:1-15`；`packages/core-backend/src/services/QueueService.ts:1-4`；`packages/core-backend/src/multitable/automation-service.ts:1397`、`univer-meta.ts:12434`（txn-bound facade 先例）。
- 迁移：`zzzz20260405190000_create_spreadsheet_permissions.ts`、`zzzz20260406030000_add_spreadsheet_permission_subjects.ts:63-65`、`zzzz20260418143000_allow_member_group_multitable_permission_subjects.ts`、`zzzz20260411140100_create_field_permissions.ts`、`zzzz20260411140000_create_meta_view_permissions.ts`、`zzzz20260413100000_create_record_permissions.ts`、`zzzz20260617140000_rowlevel_read_deny_foundation.ts:24`、`zzzz20260618120000_conditional_read_rules.ts`、`zzzz20260705150000_create_meta_view_personal_configs.ts`、`zzzz20260319103000_create_multitable_attachments.ts`、`zzzz20260711090000_add_multitable_attachments_blob_purged_at.ts`、`zzzz20260919120000_add_attachment_blob_purge_claim.ts`、`zzzz20260430172000_create_meta_record_revisions.ts`、`zzzz20260619120000_add_meta_record_revisions_batch_id.ts`、`zzzz20260715180000_create_meta_history_trust_checkpoints.ts:122`（`system_kind`）、`zzzz20260404153000_repair_meta_core_schema.ts:8-45`。
- 前端：`apps/web/src/multitable/views/MultitableWorkbench.vue:113-118`、`:266`、`:1025`、`:1418-1428`、`:1787`、`:4053`、`:4075`；`apps/web/src/multitable/components/MetaSheetViewRail.vue:96-111`；`apps/web/src/multitable/composables/useTemplateInstall.ts:38-41`。
- 客户材料（PR #6074 分支 `docs/customer-anomaly-triage-20260924`）：`customer-anomaly-triage-20260924.md:181-190`（§2.8）、`:216`（§3-B owner 决定）；`customer-reply-20260924.md:45`、`:62-69`。issue #5909、PR #5647 正文。
- 测试基座：`packages/core-backend/tests/utils/pinned-server.ts:1-20`；`tests/integration` 现有 `*realdb*` 套件 166 个。

## 附录 B：否定性结论与搜索词

- **仓内没有表级复制路由**：`grep -n -E "router\.post\('[^']*(duplicate|import|export|copy)[^']*'" packages/core-backend/src/routes/univer-meta.ts` 只命中 `:15710`（import-xlsx）与 `:19301`（records duplicate）。
- **没有通用异步作业框架**：`grep -rln -i -E "class .*Job(Runner|Queue|Service)|job_runs|async_jobs|bullmq|pg-boss" packages/core-backend/src` 命中的只有 `automation-job-service.ts`（只持久化不执行）、`ai-bulk-job-service.ts`、`recovery-archive-restore-jobs.ts`、`QueueService.ts`、`workflow-job-contract.ts`（contract-only）及考勤 w4c3a 导入系列。
- **`meta_sheets` 没有任何来源 / 复制 provenance 列**：`grep -rn -i -E "copied_from|duplicated_from|source_sheet_id|cloned_from" packages/core-backend/src/db/migrations` 零命中（`src/multitable` 里的 `source_sheet_id` 只是恢复代码里的 SQL 别名）。
- **UI 没有托管徽标**：`grep -rn -E "pluginManaged|isPluginManaged|managedBy|plugin_managed" packages/core-backend/src/routes/univer-meta.ts apps/web/src/multitable` 零命中；在飞 PR #6089 只隐藏删除图标。
- **`POST /sheets` 不给创建者写任何授权行**：`univer-meta.ts:15638-15684` 只写 `meta_sheets`、默认视图与配置修订。
- **`RecordService` 没有批量创建接口**：`grep -n -E "async (createRecords|bulkCreate)" record-service.ts record-write-service.ts` 零命中；`import-xlsx` 亦为逐行循环（`univer-meta.ts:15768-15772`）。
- **模板 JSON 不含源 sheet/field id**：`custom-template-store.ts:16-17` 明文，故 S4 必须新增 provenance 列才能从模板反查源表。
