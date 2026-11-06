# 任务功能 M5 后端 PR-4b 设计：附件（DRAFT，2026-10-11）

> **状态：DRAFT（起草稿 v2：第 1 轮独立审阅的处置见 §10）。** owner 2026-10-10 裁定先冻结 PR-4a 的表结构与接口，再在其上并行起草 PR-4b、PR-4c 与前端。本文是 PR-4b 的起草设计，以 PR-4a 冻结稿为准：Draft PR #6332，分支 `claude/tasks-m5-pr4a`，head `7f1c4c536f`，文件 `docs/development/task-m5-pr4a-backend-design-20261010.md`（冻结稿 v4 及其 §8.4 与 §8.5）。v1 起草时引的是更早的 `cdf7ddba87`；两者之间 PR-4a 只改了头部基线、§3.6 字段绑定的排序、§4.1 普查规则 ③ 的范围与新增的 §8.5，本文依赖的 §1.2、§2.7、§2.8、§2.10、§3.0、§4.6、§6.2、§7.2、§7.3 逐字节相同。实现开工时，除按当时的 main 再核一次，也按当时 PR-4a 的 head 再核一次本文引用的每一节。PR-4b **不带 DDL**，只在 PR-4a 迁移建好的两张附件表与触发器上工作。PR-4a 冻结的表、约束、索引与路由形状，本文一处不改；需要改动的地方列为 owner 问题（§9），不在正文里悄悄改。本文不授权合并、DDL 应用、staging 部署或打开任何 `TASKS_*` 开关。

- **基线**：`origin/main` `906840c74c`（2026-10-11）。文中 main 上代码的行号都钉在这个提交上；实现开工时按当时的 main 再核一次（PR-4a 头部同一规则，owner 2026-10-09 六项之第 6 项）。PR-3b（#6281）与 PR-3c（#6269）都已在 main：PR-4b 用前者的通知 producer 与调度器，按后者的普查规则落位（§6.4、§6.5）。
- **依赖**：#6249（任务 E，head `39a2a29be9`）的纯模块 `src/tasks/task-attachments.ts`；PR-4a 的迁移（PR-4a §2.7、§2.8 的两张表与行删除触发器）、`TASK_ID_PREFIXES.attachment = 'tatt'`（PR-4a §1.1 第 8 条）与 `writeEvents` 写 payload、入参收 `task_events` 闭集里任一事件词的能力（PR-4a 切片 1，§6.3）。合并顺序 #6249 → PR-4a → {PR-4b, PR-4c}（PR-4a §7.3），每张都另需 owner 点名。
- **锁**：`docs/development/task-feature-design-lock-20260917.md`（main 版）的 §2 第 8 条、§4.2（P2 表名与两个事件闭集）、§4.3（org 只取会话租户）、§5.1（实例面失败与不存在逐字节相同）、§10（开关与 manifest）、§12 门 1/2/13/17/18/20、§13-23、§13-24、§13-27。
- **引用口径**：同 PR-4a 头部，裁定只写编号与日期。S01–S37 于 owner 2026-10-09 裁定取推荐值；E 编号是锁已定条目；D 编号没有被任何一次裁定点名，本文用到时一律写成「D<n>，`ASSUMPTION`」。本文自选的取舍写 `ASSUMPTION(task-m5b): [b-NN]`，每一条在 §9.1 有缺省值与备选；引用 PR-4a 的自选照写 `[a-NN]`。
- **范围依据**（全部出自 PR-4a 的文字，本文不另起）：PR-4a §1.2 把附件的存储、上传、下载、移除、评论绑定、GC 与 `attachment_added` 通知划给 PR-4b；§4.6 写明 PR-4b 不再带 DDL、`TASK_NOTIFIABLE_EVENTS` 加 `attachment_added` 归 PR-4b（S33）；§6.2 末行与 §7.3 把 M5-b、M5-e、M5-f（门 28、31、32）合写为「归 PR-4b / 4c」，具体分到哪一张由 §1.2 的分工决定：附件归 PR-4b，夹钳与导出归 PR-4c。所以 PR-4b 承载候选门 28 与它新表面上的门 1/2/13/17/18/20 子集，**不承载门 31、32**。

---

## 0. 结论摘要

1. **只做附件**：一套任务线自有的存储 provider（S22），6 条新路由加 M3 评论创建路由的一处请求体增补（§3），评论绑定（S19），三个 GC 作业（S23），`attachment_added` 通知（S33）。不带 DDL；表、约束、索引与触发器都是 PR-4a 的。
2. **唯一卡住定稿的是继承来的 S19 问题**（PR-4a §7.2 的评论绑定一项）：PR-4a 冻结的 `task_attachments_bound_has_task_chk` 要求评论绑定那条 `UPDATE` 同时写 `task_id`，S19 定下的列集不写。切片 3（评论绑定）与切片 1 里的暂存上传路由（§3.2）按冻结的 DDL 起草，即该问题的选项 A；选项 B 的差量写在 §3.7.3。owner 点名之前，这两处不定稿（§9.2 Q-b1）。
3. **新开关 `TASKS_ATTACHMENTS_ENABLED`**（S22、S30 ①）：关 ⇒ 附件路由不注册、GC 不注册、评论带非空 `attachmentIds` 答 422；开而调度器关 ⇒ 路由照常、GC 一个也不跑（S30 的真值表，§3.9）。它是 PR-4b 引入的唯一 `TASKS_*` 新读点，所以门 18 有 PR-4b 子集。
4. **锁与信号**：不取任何 advisory 锁，与 PR-4a 的锁序包装器没有交集；配额判定靠任务行的行锁串行化，全部写路径统一先锁任务行、后锁附件行（§6.1）。附件写入不改待办谓词的任何输入，不发 `tasks:counts-updated`（§6.5）。
5. **门**：候选门 28（M5-b）的全部格与负控（§8.1），M5-g 在门 1/2/13/17/18/20 上的 PR-4b 子集（§8.2）。M5-b 候选内容里有一个负控在 D1 的统一 intent id 下是等价变异，本文换成能杀死的变异，并作为问题登记（§9.3 Q-b6）。
6. **仍待 owner 的**：本文自选 38 项（§9.1）；继承的 4 项（S19 列集、任务 E 的 X4、移除要求 `view` 的收窄、PR-4b 用到的 D 编号，§9.2）；新增 3 个问题（§9.3）；门 28 写进锁的那次修订（§9.4，随 PR-4a §7.3）。

---

## 1. 范围与切片

### 1.1 做

1. 存储：任务线自有 provider，键前缀 `task-attachments/`；本地目录只用于开发与测试，生产只用 S3 兼容存储；启动探针；存储不可用时在鉴权之后答 503（S22，§5.1）。
2. 上传：任务级附件一步上传即绑定；评论级附件先暂存为 `unbound`，写评论时同一事务绑定（S19，§3.1、§3.2、§3.7）。
3. 读：任务的附件列表（§3.3）、下载（S21，§3.4）、批量引用解析（S21 ⑦，§3.6）。
4. 移除（S20、S23，§3.5）。
5. GC 三作业：未绑定过期清扫、purge intent 排空、孤儿对账（S23，§5.5），挂在 PR-3b 调度器的提交后阶段（S30）。
6. 通知：`attachment_added` 进 `TASK_NOTIFIABLE_EVENTS`（S33、E15，§6.4）。
7. 开关与 manifest（S22、S30，§3.9）。

### 1.2 不做（归属）

- DDL：全部在 PR-4a。投影、夹钳、导出：PR-4c。前端：FE-d。
- 扫描引擎：M5 没有，`scan_state` 只写 `unscanned`，也不设扫描开关（S22）。
- 任务软删时动附件：不动，行与 blob 都保留（S23）；任务硬删与保留期作业随 §13-27 以后裁定，M5 没有硬删路径，触发器是为它预备的（PR-4a §2.8）。
- 评论编辑时增删附件（`[b-17]`）；inline 预览、签名 URL、重定向（S21）。
- 任务详情 `GET /api/tasks/:id` 不加附件字段：PR-4a §3.8 冻结了详情的增补，本文不动它；附件经 §3.3 的列表读出。

### 1.3 切片顺序

| 切片 | 内容 | 依赖 | 回归 |
|---|---|---|---|
| 0 | 开关与 manifest（§3.9）；存储 provider、启动探针与运行时（§5.1）；`newTaskAttachmentId`；纯模块 `task-attachment-access.ts`（`[b-14]`）；三个真库文件在三处登记（§8.4） | PR-4a 的迁移与前缀 | `M2\|13\|整门`（`index.ts` 的启动顺序有改动） |
| 1 | 任务级上传、暂存上传、附件列表（§3.1–§3.3） | 0 | 门 7 的多重集 |
| 2 | 下载、移除、引用解析，含 `index.ts` 的精确路径解析器（§3.4–§3.6） | 1 | — |
| 3 | 评论绑定：改 `addComment`（§3.7）。**待 Q-b1，不定稿**（切片 1 的暂存上传路由同样待它） | 1；PR-4a 切片 1 | `task-m3-comments-deletion.db.test.ts` 整文件；PR-3c 普查单测 `task-counts-touchpoints.test.ts` |
| 4 | GC 三作业与调度器的提交后作业列表（§5.5、`[b-23]`） | 2 | `M4\|25\|整门`；`tests/unit/task-scheduler.test.ts` |
| 5 | 通知与 M4 钉住的三处期望（§6.4）；收口：门 1/2/13/17/18/20 子集、PR 正文（§8.2、§8.5） | 3、4 | `M4\|23\|整门`、`M4\|24\|整门`；最终 head 上全部 `M2\|`、`M3\|`、`M4\|` 行 |

切片 3 放在切片 1 之后、与 2 并行起草：它只依赖暂存行的形状。Q-b1 若取 B，切片 1 的暂存上传路由与切片 3 的绑定语句一起改（§3.7.3），切片 0、2、4、5 不受影响。

---

## 2. 表的使用（不改 DDL）

### 2.1 行的四种形状

| 形状 | `task_id` | `comment_id` | `bind_kind` | `status` | `bound_at` | `deleted_at` | 写入处 |
|---|---|---|---|---|---|---|---|
| 任务级 | 所属任务 | NULL | `task` | `bound` | 写入时刻 | NULL | §3.1 |
| 评论级暂存 | NULL | NULL | `comment` | `unbound` | NULL | NULL | §3.2 |
| 评论级已绑 | 评论所属任务 | 评论 | `comment` | `bound` | 评论时刻 | NULL | §3.7（选项 A） |
| 已删除 | 原值 | 原值 | 原值 | `deleted` | 原值 | 删除时刻 | §3.5、§5.5 |

逐条对 PR-4a §2.7 的约束：`bound_has_task`（绑定过才有任务）、`unbound_state`、`bound_state`、`task_kind`（任务级行从不处于未绑定）、`comment_kind`（评论 id 与绑定时刻同有同无）、`deleted_state` 四种形状都满足；`display_name` 由任务 E 的 `normalizeAttachmentDisplayName` 保证非空；`mime_type` 的 CHECK 与任务 E 的 `TASK_ATTACHMENT_MIME_EXTENSIONS` 七个键一一对应；`size_bytes` 的 `1..10485760` 与 `TASK_ATTACHMENT_LIMITS.maxFileBytes` 相同。行到纯函数类型的映射照 PR-4a §2.10，不另立。另加一条数值规则：`size_bytes`（`bigint`）与每个 `count(*)` 经驱动读出时是字符串，交给任务 E 的任何函数（`checkTaskAttachmentQuota`、`checkCommentAttachmentTotals`、项的 `sizeBytes`）之前一律先 `Number()`；转换结果不是安全整数 ⇒ 当作内部错误，答 500 `INTERNAL`。任务 E 对非数值输入抛 `TypeError`，不转换就会让每次上传与带附件的评论都答 500（审批引用解析的同一处写法：`routes/approval-attachments.ts:522`）。

已删除的行原地保留 `task_id`、`comment_id`、`bound_at`：任务 E 的 `requireConsistentBinding` 允许 `deleted` 带或不带 `boundAt`，下载判定靠 `boundAt` 区分从未绑定过的行（只有上传者）与绑定过的行（按任务 `view`）。

### 2.2 purge intent 的四个写入者（D1，`ASSUMPTION`）

| 写入者 | 原因值 | 所在 |
|---|---|---|
| 行删除触发器 | `row_deleted` | PR-4a §2.8（M5 没有硬删路径，测试夹具触发） |
| 用户移除 | `user_removed` | §3.5 |
| 未绑定过期清扫 | `unbound_ttl` | §5.5 |
| 孤儿对账 | `reconciler_orphan` | §5.5 |

四处的 id 一律是 `'tpi_' || pg_catalog.md5(storage_key)`，冲突目标一律 `ON CONFLICT (storage_key) DO NOTHING`。`last_error` 只写大写固定码（PR-4a 的 `task_attachment_purge_intents_last_error_code_chk`），PR-4b 只用两个：`BLOB_DELETE_FAILED`、`MAX_ATTEMPTS_EXHAUSTED`（`[b-26]`）。

### 2.3 每类语句用到的索引

| 语句 | 索引（PR-4a 已建） |
|---|---|
| 某任务的已绑定附件（列表、计数、引用解析的任务模式） | `idx_tatt_task (task_id) WHERE task_id IS NOT NULL` |
| 某评论的附件 | `idx_tatt_comment` |
| 未绑定过期清扫、暂存上限计数 | `idx_tatt_unbound_sweep (status, created_at)` |
| 排空认领 | `idx_tapi_pending (status, created_at)` |
| 「这个键还有活行吗」「这个键有行吗」 | `task_attachments_storage_key_key`、`task_attachment_purge_intents_storage_key_key` |

暂存上限（`[b-19]`）按 `status = 'unbound'` 走 `idx_tatt_unbound_sweep` 再按上传者过滤；未绑定行有 168 小时上限，这一读的规模有界，不为它加索引（加索引是 DDL，本 PR 不带）。

### 2.4 与 PR-4a 冻结值对不上的地方

只有一处：S19 的评论绑定列集与 `task_attachments_bound_has_task_chk`（PR-4a §7.2 已登记，本文 §9.2 Q-b1）。其余各条——四种行形状、四个 intent 写入者、原因闭集、`last_error` 的码形、索引——都按冻结值使用，PR-4b 不需要 PR-4a 改动任何 DDL。S33 加通知词也不需要 DDL：两个附件词早在 `task_events` 的闭集里，outbox 不在库里钉事件名（§6.4 列了核过的位置）。

---

## 3. 接口

### 3.0 共性

- **注册**：新文件 `src/routes/tasks-attachments.ts` 导出 `registerTaskAttachmentRoutes(router)`，`tasksRouter()` 在既有两行注册（`routes/tasks.ts:402-403`）之后加一行调用；开关判定在这个函数里，开关关则一条路由也不注册（`[b-01]`）。文件名以 `tasks` 开头，落在门 7 的扫描根内。路由仍挂在同一个 `tasksRouter()` 上，不新增路由挂载点；`index.ts` 只改两处：引用解析的请求体解析器与附件运行时的启动（`[b-03]`、`[b-15]`）。`registerTaskAttachmentRoutes` 里先注册两条静态子路径 `POST /api/task-attachments/upload`、`POST /api/task-attachments/refs`，再注册两条 `/:id` 路由（锁 §10、门 13 的静态子路径先于 `/:id`；方法不同本不会误配，这里照锁的写法排序）。
- 每条路由 `authenticate` + `rbacGuard('tasks', 'read' | 'write')`；没有路由用 `tasks:admin`（E06）。
- **org** 只取 `req.authenticatedTenantId`（E04）：写路由缺 org ⇒ 422 `ORG_MISSING`；路径里带一个 id 的读按单对象读处理，缺 org ⇒ 404（PR-4a §3.0 的分类）；引用解析的暂存模式按集合型读降级 200（§3.6）。
- **实例面**：行级失败统一回 404 `{ error: { code: 'NOT_FOUND' } }`，与目标不存在逐字节相同；行级从不答 403；任务 E 的 `forbidden` 也答 404（PR-4a §3.0）。
- **顺序**：请求体、路径参数、query 与上传文件的校验都排在行级判定之后；上传时行级判定先于读请求体（D5，`ASSUMPTION`：multer 只在行级判定通过之后才运行）。唯一的例外是引用解析的精确路径解析器（`[b-15]`）：它和平台的全局解析器一样挂在 `/api/**` 的 JWT 保护之前（`index.ts:1768-1770` 的审批先例、`:1816` 的全局解析器、`:1851` 的 JWT 保护），所以请求体超过 64 KiB 的 413 与不可解析的 400 先于鉴权与 `rbacGuard` 出现；这两个应答不带任何实例数据。门 1、门 2 里引用解析的格一律用 64 KiB 以内的合法请求体。
- **码**：任务 E 的 `reason` 转大写即 HTTP 码；没有纯函数 reason 对应的码由本文命名（§3.8）。错误体只有 `{ error: { code } }`。
- **503**：只在上传与下载上出现，码 `STORAGE_UNAVAILABLE`（码名 `[b-38]`）；它排在资源面判定（`authenticate` + `rbacGuard`）与 org 判定之后，有行级判定的路由（任务级上传、下载）还排在行级判定之后；暂存上传没有行级判定（§3.2），它的 503 紧跟 org 判定。`routes/tasks-http.ts` 的 `sendError` 把非 4xx 一律答 500 `INTERNAL`，所以附件路由文件自带一个只放行这一个 503 的映射，其余照转 `sendError`（`[b-04]`）。
- 路径里不可打印的 id ⇒ 发 SQL 之前 404；请求体里的任务域 id 必须过 `isValidTaskDomainId`，不过 ⇒ 422。
- 分页读用 PR-3a 的合同：`{ items, total }`，`limit` 1..100 缺省 100，`offset` ≥ 0，经 `parseTaskPage`（422 `INVALID_LIMIT` / `INVALID_OFFSET`），排序键最后一键是 `id`。附件列表在 E22 点名的新列表端点里，所以分页，不另立偏离。
- 成功体 camelCase，时间是 ISO-8601 或 `null`。

两种项形状：

- `TaskAttachmentItem` = `{ id, taskId, commentId, bindKind, fileName, mimeType, sizeBytes, uploaderId, boundAt, canRemove }`；`fileName` 是 `display_name`，`canRemove` 由 `canRemoveAttachment` 算出。
- `StagedAttachment` = `{ id, fileName, mimeType, sizeBytes, createdAt, expiresAt }`；`expiresAt` = `createdAt` 加任务 E 的 `TASK_ATTACHMENT_UNBOUND_TTL_MS`。

### 3.1 任务级上传：`POST /api/tasks/:id/attachments`

| 项 | 值 |
|---|---|
| 码 / 行级 | write；`canAddAttachment(roles, 'task')`，即 `can(roles, 'attach')`：创建人、负责人、清单可编辑者（S20） |
| 请求 | `multipart/form-data`，恰一个文件部件 `file`，没有其他字段（§5.2） |
| 成功 200 | `TaskAttachmentItem`（`bindKind: 'task'`，`commentId: null`，`canRemove: true`） |
| 错误 | 404；422 `ORG_MISSING`、`LIMIT`、`FILE_REQUIRED`、`INVALID_UPLOAD`、`FILE_TOO_LARGE`、`INVALID_SIZE`、`MIME_NOT_ALLOWED`、`EXTENSION_NOT_ALLOWED`、`EXTENSION_MIME_MISMATCH`、`CONTENT_MIME_MISMATCH`、`INVALID_NAME`；503 `STORAGE_UNAVAILABLE` |

判定顺序（读请求体之前，不进事务）：

1. 缺 org ⇒ 422；`:id` 不可打印 ⇒ 404。
2. 任务取行（`loadTask`，会话 org、未软删）与角色集（`loadRowRoles`，含清单身份）⇒ `canAddAttachment` 为假 ⇒ 404。
3. 存储不可用 ⇒ 503。
4. 配额预判：该任务已绑定且未删除的附件数（`count(*)` 先 `Number()`，§2.1），经 `checkTaskAttachmentQuota({ existingCount, adding: 1 })` ⇒ 422 `LIMIT`（`[b-07]`；计数口径见 §9.2 Q-b2）。

读请求体与写 blob：

5. multer 读文件（§5.2）：超限 ⇒ 422 `FILE_TOO_LARGE`；多余部件或字段、不可解析 ⇒ 422 `INVALID_UPLOAD`；没有文件 ⇒ 422 `FILE_REQUIRED`。
6. `validateAttachmentCandidate({ mimeType, fileName, sizeBytes, head })`（`head` 传整个缓冲）⇒ 不过答 reason 的大写。
7. `normalizeAttachmentDisplayName(originalname)` ⇒ 不过 ⇒ 422 `INVALID_NAME`。
8. 存储键 `deriveTaskAttachmentStorageKey(mimeType, now, 随机后缀)`；写 blob（独占创建）。写失败 ⇒ 500 `INTERNAL`。

事务（`READ COMMITTED`，首句设定隔离级别，与 M2–M4 同一写法）：

9. 锁任务行：`SELECT … FROM tasks WHERE <buildTaskByIdCondition> FOR NO KEY UPDATE`，取不到 ⇒ 404（`[b-08]`）。
10. 锁后读一次 `clock_timestamp()`，记为 `at`（`[b-22]`）。
11. 在这把锁里重读角色集，`canAddAttachment` 为假 ⇒ 404；重新计数（同样先 `Number()`），`checkTaskAttachmentQuota` ⇒ 422 `LIMIT`。
12. 插入行：任务级形状（§2.1），`created_at = bound_at = at`，`scan_state = 'unscanned'`。
13. 事件：`planAttachmentAddedEvents({ taskId, attachmentIds: [id], bindKind: 'task', actorId, now: at })`，经 `writeEvents` 写入（payload 见 §6.3），返回的 `WrittenTaskEvent[]` 同事务交给 `enqueueTaskEventNotifications`（§6.4）。
14. 提交。

第 9–13 步任一处失败（`COMMIT` 发出之前抛出的错误，含第 12 步 `INSERT` 被库拒绝）：事务回滚，再对第 8 步写下的 blob 做一次尽力内联删除，之后原样抛出原错误。E12 规定 blob 只由 GC 删除，S19 为这里登记了唯一的例外，只针对从未有过行的 blob；内联删除本身失败只记固定码，残留由孤儿对账在宽限期之后收走（§5.5）。第 14 步 `COMMIT` 本身抛错时（例如应答途中连接断开），行是否已落库不可知，**不做内联删除**，原样抛错：行若已落库，blob 正被它引用；行若没有落库，blob 是孤儿，由对账收走。规则是「只有确知从未有过行的 blob 才内联删除」，结果不明的一律交给 GC。

### 3.2 评论附件暂存：`POST /api/task-attachments/upload`

按冻结的 DDL（Q-b1 的选项 A），暂存行不属于任何任务：

| 项 | 值 |
|---|---|
| 码 / 行级 | write；没有行级判定（还没有任务）；绑定时再按评论路由的 `comment` 能力与上传者本人判定（§3.7） |
| 请求 | 同 §3.1 |
| 成功 200 | `StagedAttachment` |
| 错误 | 422 `ORG_MISSING`、`LIMIT`，以及 §3.1 第 5–7 步的各码；503 `STORAGE_UNAVAILABLE` |

顺序：缺 org ⇒ 422 → 存储不可用 ⇒ 503 → 暂存上限：该上传者在会话 org 内的未绑定行数 ≥ 20 ⇒ 422 `LIMIT`（`[b-19]`）→ §3.1 第 5–8 步 → 单条 `INSERT`（评论级暂存形状，`uploader_id` = 调用者，`org_id` = 会话 org，`created_at` 取列缺省）。插入失败照 §3.1 末段对 blob 尽力内联删除，但只在这条 `INSERT` 被库明确拒绝时（错误带 SQLSTATE）：它是自动提交的单句，连接层的失败（没有 SQLSTATE）与 `COMMIT` 结果不明同理，行可能已落库，blob 留给对账。不写事件、不入队通知（没有任务）。

### 3.3 附件列表：`GET /api/tasks/:id/attachments`

| 项 | 值 |
|---|---|
| 码 / 行级 | read；任务 `can(roles, 'view')`（S20、S21） |
| 请求 | query `limit`、`offset`；排序 `bound_at ASC, id ASC`（`[b-11]`） |
| 成功 200 | `{ items: TaskAttachmentItem[], total, canAddTaskAttachment }` |
| 错误 | 404；422 `INVALID_LIMIT`、`INVALID_OFFSET`（在 404 之后） |

- 列出的行：`task_id = :id`、`status = 'bound'`、`scan_state <> 'infected'`（`[b-12]`），两种绑定都在内；评论被删成墓碑后它的附件照列（S19：删除评论时附件保留）。行只从按 `buildTaskByIdCondition` 选出的任务出发按 `task_id` 读，组合外键 `task_attachments_task_fk` 保证它们与任务同 org，不另写 org 条件（照 PR-4a §4.7 的绑定表写法）。
- `canAddTaskAttachment` = `canAddAttachment(roles, 'task')`，给前端决定是否显示上传入口；评论里加附件的入口跟随评论能力，前端已有。
- 评论与附件的对应从项的 `commentId` 读：评论的响应体不加键（`[b-10]`）。

### 3.4 下载：`GET /api/task-attachments/:id/download`

S21 的七条规则落在这条路由上：

1. 资源面：`authenticate` + `rbacGuard('tasks', 'read')`，失败 403，响应体逐字 `{ error: 'Insufficient permissions' }`（S21 ①，门 2）。
2. 缺 org ⇒ 404；`:id` 不可打印 ⇒ 404。
3. 按 id 读行，SQL 里**不带** org 条件；org 只由纯函数判定（`[b-13]`）。
4. 角色集：从未绑定过的行不需要角色（传 `['none']`）；行的 org 与会话 org 不同 ⇒ 不取所属任务，直接 `['none']`（他 org 的行与不存在的 id 做同样多的工作）；其余绑定过的行按会话 org 取所属任务，取不到（不存在、已软删）⇒ `['none']`，取到 ⇒ `loadRowRoles`。这一步只决定要不要查任务，不答任何应答，org 的判定仍只在第 5 步的纯函数里（`[b-13]`）。
5. `authorizeTaskAttachmentDownload({ row, viewerId, viewerOrgId, roles })`：`not_found` ⇒ 404；`gone` ⇒ 410 `GONE`（码名 `[b-38]`）。它的判定顺序固定（org → 未绑定只认上传者 → 已绑定要 `view` → 之后才看 `deleted` / `infected`），所以 410 只在授权之后出现（S21 ②③）。
6. 存储不可用 ⇒ 503，只在第 5 步之后（S21 ④）。
7. 读整个 blob（D6，`ASSUMPTION`）；读失败 ⇒ 500 `INTERNAL`，日志只记固定码。行在而 blob 丢失属于数据丢失，由对账报告（§5.5），不在这里答 410。
8. 响应头只取 `buildTaskAttachmentDownloadHeaders({ mimeType, fileName })` 的四项：存储的 MIME、带 `filename` 与 RFC 5987 `filename*` 的 `attachment` 处置、`nosniff`、`default-src 'none'` 的 CSP（S21 ⑤）。永不 `inline`，永不签名 URL 或重定向（S21 ⑥）。

### 3.5 移除：`DELETE /api/task-attachments/:id`

| 项 | 值 |
|---|---|
| 码 / 行级 | write；`planRemoveAttachment`（S20；所属任务上没有 `view` 的人一律 404，上传者也一样，见 §9.2 Q-b3） |
| 成功 200 | `{ id, deleted: true }`（`[b-16]`） |
| 错误 | 404；422 `ORG_MISSING` |

1. 缺 org ⇒ 422；`:id` 不可打印 ⇒ 404。
2. 按会话 org 读行：`buildTaskAttachmentByIdCondition`（`[b-14]`，含已删除）。取不到 ⇒ 404。任务 E 的 `planRemoveAttachment` 不接收 org，靠的就是这一读只在会话 org 内（它的文档注释写明了这一合同）。
3. **未绑定的行**：先用读到的行调用 `planRemoveAttachment`（只有上传者通过，没有事件），不通过 ⇒ 404；通过则执行一条语句，认领与 intent 同语句：

   ```
   WITH claimed AS (
     UPDATE task_attachments
        SET status = 'deleted', deleted_at = clock_timestamp(), deleted_by = $actor
      WHERE <buildTaskAttachmentByIdCondition> AND uploader_id = $actor AND status = 'unbound'
     RETURNING storage_key
   ), intent AS (
     INSERT INTO task_attachment_purge_intents (id, storage_key, reason)
     SELECT 'tpi_' || pg_catalog.md5(storage_key), storage_key, 'user_removed' FROM claimed
     ON CONFLICT (storage_key) DO NOTHING
   )
   SELECT count(*) AS n FROM claimed
   ```

   认领 0 行（这期间被评论绑定，或被另一次移除、过期清扫抢先）⇒ 重读一次：已绑定 ⇒ 转第 4 步；否则 ⇒ 404。
4. **已绑定的行**，在一个事务里：锁所属任务行（`buildTaskByIdCondition`，会话 org，`FOR NO KEY UPDATE`；取不到 ⇒ 角色集 `['none']`）→ `loadRowRoles` → 锁附件行 `FOR UPDATE` 并重读 → 锁后读一次 `clock_timestamp()` → `planRemoveAttachment`：`not_found` / `forbidden` ⇒ 404 → 认领（`status` 由 `bound` 改 `deleted`，写 `deleted_at`、`deleted_by`）与 intent 同语句（同第 3 步的写法）→ 事件 `attachment_removed`（payload `{ attachmentId }`）经 `writeEvents` 写入并交给 producer（它不在可通知闭集里，producer 自行滤掉，`[b-34]`）。
5. 已删除的行 ⇒ `planRemoveAttachment` 答 `not_found` ⇒ 404（不是 200 空操作）。

加锁顺序与 §3.1、§3.7 相同：先任务行、后附件行（§6.1）。未绑定行的移除不碰任务行，只靠一条带状态谓词的语句，所以不会与绑定形成反向的加锁顺序。

### 3.6 引用解析：`POST /api/task-attachments/refs`

照 S21 ⑦ 的上限与审批先例的两种模式（`[b-18]`）：

| 项 | 值 |
|---|---|
| 码 | read（`tasks:read`） |
| 请求 | `{ ids: string[], taskId?: string }`；请求体 ≤ 64 KiB（`[b-15]`）；`ids` 的原始数组 ≤ 200 个（在去重与逐个校验之前计数，任务 E `parseAttachmentRefIds`） |
| 任务模式（带 `taskId`） | `{ items: Array<{ id, tombstone: false } & TaskAttachmentItem \| { id, tombstone: true }> }` |
| 暂存模式（不带 `taskId`） | `{ items: Array<{ id, stale: false } & StagedAttachment \| { id, stale: true }> }` |
| 错误 | 只在任务模式：404；422 `INVALID_TASK_ID`。两种模式：422 `INVALID_IDS`、`LIMIT`；413 `PAYLOAD_TOO_LARGE`、400 `INVALID_JSON`（请求体解析器） |

- 模式按请求体里有没有 `taskId` 键区分。项按去重后的 `ids` 首次出现的顺序排列。
- **任务模式**顺序：缺 org ⇒ 404 → `taskId` 过四合取，否则 422 `INVALID_TASK_ID`（码名 `[b-38]`）→ 任务取行与 `can(roles, 'view')`，否则 404 → `parseAttachmentRefIds` ⇒ 422 `INVALID_IDS` / `LIMIT` → 从该任务出发按 `task_id` 读 `id = ANY(ids)` 的行。行已绑定在这个任务上、未删除、不是 `infected` ⇒ 完整项；其余一律 tombstone，不区分原因。
- **暂存模式**顺序：缺 org ⇒ 200 `{ items: [], degraded: true, reason: 'org_missing' }` → `parseAttachmentRefIds` ⇒ 422 → 经 `buildStagedAttachmentsOfUploaderCondition`（会话 org、上传者 = 调用者、`status = 'unbound'`）读行。查得到 ⇒ `stale: false` 与暂存项；查不到 ⇒ `stale: true`，不区分别人的、已绑定的、已删除的、不存在的。已过 168 小时而尚未被清扫的行仍按 `stale: false` 报（它此刻仍能被绑定，与 §3.7 的绑定语句一致），项里的 `expiresAt` 已在过去。
- 分类规则写在纯模块 `task-attachment-views.ts`（`[b-14]`），服务层只取行。

### 3.7 M3 评论创建路由：`POST /api/tasks/:id/comments` 的 `attachmentIds`

#### 3.7.1 请求与判定顺序

请求体在 M3 的 `{ body }` 之外多收一个可选键 `attachmentIds: string[]`。响应体不变，仍是 M3 的评论对象（`[b-10]`）。

1. 既有：缺 org ⇒ 422；任务取行与 `comment` 能力 ⇒ 404（`addComment` 现有两步，`services/task-structure.ts:681` 起）。
2. 既有：`requireCommentBody` ⇒ 422 `COMMENT_BLANK` / `COMMENT_TOO_LONG` / `COMMENT_INVALID_CHAR`。
3. 新：`attachmentIds` 缺键或为空数组 ⇒ 以下各步都跳过，SQL 序列与 M3 逐句相同（`[b-20]`）。
4. 新：开关关 ⇒ 422 `ATTACHMENTS_DISABLED`（D20，`ASSUMPTION`），先于形状校验。
5. 新：`planCommentAttachmentBind({ attachmentIds })` ⇒ 422 `INVALID_IDS`（不是数组，或有 id 不过四合取）/ `LIMIT`（去重后多于 5 个）。

能加评论的人就能在评论里加附件：`comment` 能力含关注人与清单只读者（S20、锁 §13-23），任务 E 的 `canAddAttachment(roles, 'comment')` 与第 1 步是同一个判定，不另判一次。

#### 3.7.2 事务（选项 A：冻结的 DDL）

在 M3 的事务里，按下面的顺序（新步骤标「新」）：

1. 既有：`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`；`lockLiveTaskForComment`（任务行 `FOR KEY SHARE`，取不到 ⇒ 404）。
2. 新：同一任务行再取 `FOR NO KEY UPDATE`（`[b-09]`）。它与上传、移除的行锁互斥，所以配额判定在这里串行化；它与 M3 删除任务时的 `FOR UPDATE` 本来就互斥，评论写入的活性保证不变。
3. 新：任务配额：该任务已绑定未删除的附件数（先 `Number()`，§2.1）+ 本次个数，经 `checkTaskAttachmentQuota` ⇒ 422 `LIMIT`（计数口径见 Q-b2）。
4. 既有：插入评论，`RETURNING created_at`，记为 `at`；插入 `commented` 事件（列缺省时刻，与 `at` 同为事务时刻）。
5. 新：绑定。按冻结的 `task_attachments_bound_has_task_chk`，这条语句在 S19 的列集之外多写 `task_id`；谓词与 rowCount 合同照 S19：

   ```
   UPDATE task_attachments
      SET status = 'bound', comment_id = $commentId, task_id = $taskId, bound_at = $at
    WHERE <buildStagedAttachmentsOfUploaderCondition>   -- 会话 org、uploader_id = 调用者、status = 'unbound'
      AND bind_kind = 'comment' AND id = ANY($ids)
   RETURNING id, size_bytes
   ```

   返回行数与去重后的 id 数不等 ⇒ 422 `ATTACHMENT_NOT_BINDABLE`（`[b-21]`）；事务回滚，评论与绑定都不落库。别人暂存的行、已绑定的行、任务级的行、他 org 的行、已删除的行、不存在的 id 都落在这一个码上，不区分原因。
6. 新：`checkCommentAttachmentTotals(返回的 size_bytes 逐个 Number() 之后)` ⇒ 422 `LIMIT`（≤ 5 个、合计 ≤ 25 MiB，S18；同一事务，D18，`ASSUMPTION`；转换规则见 §2.1）。
7. 新：`planAttachmentAddedEvents({ taskId, attachmentIds, bindKind: 'comment', actorId, now: at })` 经 `writeEvents` 写入。
8. 改：`enqueueTaskEventNotifications` 一次交入 `commented` 与这几条 `attachment_added`（同一任务，producer 按任务装载收件人）。

`bind_kind = 'comment'` 这一谓词在 PR-4a 的 CHECK 下是冗余的：`task_attachments_task_kind_chk` 不允许任务级行处于未绑定，`status = 'unbound'` 已把任务级行排除。本文保留它作纵深防御。所以任务级的行混进 `attachmentIds` 有两道代码守卫（状态谓词与 `bind_kind` 谓词），后面还有 `task_attachments_task_kind_chk`：只去掉其中一道代码守卫是等价变异，不当负控；两道一起去掉时 `UPDATE` 选中任务级行、给它写评论 id，被这条 CHECK 拒绝（23514）⇒ 500 而不是 422，格照样红（与 §4.3 评论绑定那一行「去掉 org 合取 ⇒ 外键报错 500」同一处理）。§8.1 的 b28-bind-reject 为任务级的行单立一格，负控就是两道一起去掉。

#### 3.7.3 选项 B 的差量（owner 点名 B 时才做）

| 位置 | 选项 A（本文起草） | 选项 B |
|---|---|---|
| PR-4a 的 DDL | 不变 | `task_attachments_bound_has_task_chk` 改为只约束任务级行；这是 PR-4a 的改动 |
| 暂存路由 | `POST /api/task-attachments/upload`，不属于任务 | 改为 `POST /api/tasks/:id/comment-attachments`：路径带任务，行级判定 `can(roles, 'comment')`（404），上传时写 `task_id` |
| 绑定语句 | 多写 `task_id` | S19 原列集（`status`、`comment_id`、`bound_at`），谓词另加 `task_id = $taskId` |
| 暂存上限 | 每上传者每 org | 可改为每上传者每任务 |
| 任务 E | 不变 | `TaskAttachmentRowForRemoval.taskId` 的注释改写（只有从未绑定的行为空 ⇒ 任务级行与暂存行都带任务）；判定逻辑不变 |
| 下载、移除、清扫 | — | 不变（判定靠 `boundAt`，不靠 `taskId`） |

### 3.8 错误码总表（PR-4b 新增）

| 码 | HTTP | 出处 |
|---|---|---|
| `FILE_REQUIRED`、`INVALID_UPLOAD`、`FILE_TOO_LARGE` | 422 | §3.1 第 5 步（`[b-06]`；`FILE_TOO_LARGE` 与任务 E 的 `file_too_large` 同码） |
| `INVALID_SIZE`、`MIME_NOT_ALLOWED`、`EXTENSION_NOT_ALLOWED`、`EXTENSION_MIME_MISMATCH`、`CONTENT_MIME_MISMATCH` | 422 | 任务 E `validateAttachmentCandidate` 的 reason 转大写 |
| `INVALID_IDS` | 422 | 任务 E `planCommentAttachmentBind` / `parseAttachmentRefIds` 的 `invalid_ids` |
| `INVALID_TASK_ID` | 422 | §3.6 任务模式（码名 `[b-38]`） |
| `ATTACHMENT_NOT_BINDABLE` | 422 | §3.7.2 第 5 步 |
| `ATTACHMENTS_DISABLED` | 422 | §3.7.1 第 4 步（D20，`ASSUMPTION`） |
| `GONE` | 410 | §3.4 第 5 步（410 是 S21 的取值，码名 `[b-38]`） |
| `PAYLOAD_TOO_LARGE` | 413 | §3.6 请求体解析器 |
| `INVALID_JSON` | 400 | §3.6 请求体解析器 |
| `STORAGE_UNAVAILABLE` | 503 | §3.1、§3.2、§3.4（503 是 S22 的取值，码名 `[b-38]`） |

沿用的既有码：`NOT_FOUND`、`ORG_MISSING`、`INVALID_NAME`（显示名不合格，与清单名、字段名的空名同码）、`LIMIT`（各配额，D18，`ASSUMPTION`）、`INVALID_LIMIT` / `INVALID_OFFSET`（PR-3a 分页）、`INTERNAL`。

### 3.9 开关与调度器（S30 的真值表，PR 正文照写）

开关谓词 `isTaskAttachmentsEnabled(env)`：`env.TASKS_ATTACHMENTS_ENABLED === 'true'`，不修剪、不折叠大小写（与 `isTasksEnabled` 同形），放在 `services/task-attachment-flags.ts`（`[b-02]`）；每个生效处都与 `isTasksEnabled` 合取。manifest 条目：`dependsOn: ['TASKS_ENABLED', 'TASKS_SCHEDULER_ENABLED']`，只作文档、不设 `rules`（S30 ①）。

| `TASKS_ENABLED` | `TASKS_ATTACHMENTS_ENABLED` | `TASKS_SCHEDULER_ENABLED` | 附件路由 | 评论带非空 `attachmentIds` | GC 三作业 |
|---|---|---|---|---|---|
| 不是 `'true'` | 任意 | 任意 | 不存在（整个任务路由不挂载） | 不可达 | 不跑 |
| `'true'` | 不是 `'true'` | 任意 | 不注册（404） | 422 `ATTACHMENTS_DISABLED` | 不注册 |
| `'true'` | `'true'` | 不是 `'true'` | 照常 | 照常绑定 | **不跑**：三个作业挂在调度器上，调度器不启动它们也就不运行。暂存行到期也不清扫，intent 不排空，孤儿对象不对账，blob 只增不减 |
| `'true'` | `'true'` | `'true'` | 照常 | 照常绑定 | 跑（存储可用时） |

前端怎样知道开关的状态（`[b-33]`）：不加会话 feature，也不另开探测路由；任务详情 `GET /api/tasks/:id` 答 200 而 `GET /api/tasks/:id/attachments` 答 404 ⇒ 视为附件开关关（开关关时附件路由不注册，§3.0），隐藏附件栏与评论里的附件入口。开关开时列表对有 `view` 的人恒 200，两者不会同时出现于开关开着的实例。FE-d 按这一条写，不另找信号。

另一个维度是存储解析（§5.1）：生产环境缺 S3 配置时，路由照常注册，上传与下载在鉴权之后答 503，列表、引用解析、移除照常（移除只改行与写 intent，不碰 blob），GC 不注册（没有可删的存储）。

---

## 4. 授权（按已裁调用者集合）

### 4.1 能力矩阵

身份：创建人 C、负责人 A、清单可编辑者 LE、清单只读者 LR、关注人 F、局外人 O（同 org 在职、与任务无关）、上传者 U（与上述身份叠加）。

| 动作 | 通过 | 404 | 出处 |
|---|---|---|---|
| 任务级上传 | C、A、LE | F、LR、O | S20：`attach` |
| 评论里加附件 | C、A、LE、F、LR | O | S20：`comment`；锁 §13-23 |
| 暂存上传 | 持 `tasks:write` 且有会话 org 的任何人 | — | 选项 A：绑定时才落到任务 |
| 列表、引用解析的任务模式 | C、A、LE、F、LR | O | S20、S21：`view` |
| 下载已绑定的附件 | C、A、LE、F、LR | O；他 org | S21 ② |
| 下载未绑定的附件 | 上传者本人 | 其余所有人 | S21 ② |
| 移除任务级附件 | 有 `view` 的上传者；C、A、LE | F、LR（非上传者）、O | S20 |
| 移除评论级附件 | 有 `view` 的上传者 | 其余所有人，含 C、A、LE | S20（已裁取值，2026-10-09） |
| 移除未绑定的附件 | 上传者本人 | 其余所有人 | S20 |

「有 `view` 的上传者」来自任务 E 的 `canRemoveAttachment`：没有 `view` 时上传者也不能移除。这比 S20 的字面更窄，任务 E 已登记为它在锁 §5.1 之上的读法，本文继承并列为问题（§9.2 Q-b3）。

### 4.2 每条路由用到的纯函数

| 路由 | 纯函数（无注明的都是任务 E `task-attachments.ts` 的导出） |
|---|---|
| §3.1 任务级上传 | `canAddAttachment`、`checkTaskAttachmentQuota`、`validateAttachmentCandidate`、`normalizeAttachmentDisplayName`、`deriveTaskAttachmentStorageKey`、`planAttachmentAddedEvents` |
| §3.2 暂存上传 | 同上去掉 `canAddAttachment`、`checkTaskAttachmentQuota`、`planAttachmentAddedEvents` |
| §3.3 列表 | `canAddAttachment`、`canRemoveAttachment`；项的组装在 `task-attachment-views.ts`（本 PR 新增） |
| §3.4 下载 | `authorizeTaskAttachmentDownload`、`buildTaskAttachmentDownloadHeaders` |
| §3.5 移除 | `planRemoveAttachment`（内部调用 `canRemoveAttachment`） |
| §3.6 引用解析 | `parseAttachmentRefIds`；分类在 `task-attachment-views.ts` |
| §3.7 评论绑定 | `planCommentAttachmentBind`、`checkTaskAttachmentQuota`、`checkCommentAttachmentTotals`、`planAttachmentAddedEvents` |
| §5.5 过期清扫 | `TASK_ATTACHMENT_UNBOUND_TTL_MS`（SQL 边界与 `isUnboundAttachmentExpired` 由单测对拍，`[b-25]`） |

### 4.3 org 的守卫与负控的判别力

| 路由 | org 守卫 | 单一守卫的格（负控能杀死） |
|---|---|---|
| 下载 | 纯函数的 org 比对（所有行）；已绑定的行另有「按会话 org 取所属任务」 | 同一用户在两个 org 都在职、在 org B 暂存、会话 org 为 A 去下载：只有纯函数一道 |
| 移除 | `taskAttachmentOrgClause`（所有行）；已绑定的行另有取任务那一道 | 同上的暂存行去移除：只有私有 org 子句一道 |
| 引用解析的暂存模式 | `taskAttachmentOrgClause` | 同上的暂存行出现在暂存模式里 |
| 评论绑定 | `taskAttachmentOrgClause`；组合外键 `task_attachments_task_fk` | 他 org 的暂存行混进 `attachmentIds`：去掉 org 合取后得到 500（外键报错）而不是 422，格照样红 |
| 列表、引用解析的任务模式、任务级上传 | M2 的 `buildTaskByIdCondition`（门 1 已覆盖） | 不另立 |

已绑定的行有两道互相独立的 org 守卫，只去掉其中一道时格仍是 404；它们的负控要两道一起去掉，与 PR-4a M5-g 写取值那一格同一处理。`[b-13]` 让下载的 SQL 不带 org 条件，正是为了让暂存行那一格只有一道守卫、负控有判别力。

---

## 5. 存储（S18–S23）

### 5.1 provider、解析与启动

- **自带 provider**（S22）：不共用、不改别的业务线的存储文件。S3 实现照仓内既有 S3 provider 的形状另写一份任务线的（`services/task-attachment-s3.ts`），本地实现只用于开发与测试（`services/task-attachment-storage.ts`），本地路径的包含检查复用平台的 `resolveWithinBase`（`services/StorageService.ts`）。每个操作——写、读、列举、删除——都先断言键以 `task-attachments/` 开头且不含 `..`、反斜杠或 NUL，否则在发出任何请求之前拒绝。写入是独占创建（S3 用 `IfNoneMatch: '*'`，本地用 `wx`）。删除对不存在的键视为成功。
- **环境变量**（S22 的名单）：`TASK_ATTACHMENT_S3_BUCKET`、`TASK_ATTACHMENT_S3_REGION`、`TASK_ATTACHMENT_S3_ENDPOINT`、`TASK_ATTACHMENT_S3_ALLOW_HTTP`、`TASK_ATTACHMENT_S3_FORCE_PATH_STYLE`，开发用 `TASK_ATTACHMENT_STORAGE_DIR`（缺省 `<cwd>/storage/task-attachments`，与别的业务线的目录分开）。桶与区域都非空才算配置完整；端点必须能解析为 URL，协议只认 `https:`，`ALLOW_HTTP` 精确为 `'true'` 时另认 `http:`；`FORCE_PATH_STYLE` 精确为 `'true'` 才开（`[b-28]`）。解析失败只抛固定信息，不回显变量的值。值可以与别的业务线相同，靠前缀隔离。
- **解析**：生产环境（`NODE_ENV === 'production'`）配置完整 ⇒ S3；不完整 ⇒「需要 S3」，路由照常注册，上传与下载在鉴权之后答 503，GC 不注册。非生产 ⇒ 本地目录。解析读的是传入的 `env`，不直接读 `process.env`（见下一条）。
- **启动**（`[b-03]`）：路由在构造期注册（`tasksRouter()` 同步），处理请求时经取值函数拿已启动的运行时；运行时在 `start()` 里、`startTaskScheduler()`（`index.ts:4334`）之前启动，开关关时直接返回空。`startTaskAttachmentRuntime(options: { env?, cwd?, logger? })` 与存储解析都收注入的 `env`（缺省 `process.env`），与 `startTaskScheduler(options: { env? … })`（`task-scheduler.ts:895`）同形；另导出只供测试的 `resetTaskAttachmentRuntimeForTests()`（照 `resetTaskCountsBroadcasterForTests`，`task-counts-realtime.ts:55`）。真库 harness 把进程的 `NODE_ENV` 固定为 `'test'` 并开着令牌信任（`tests/setup.integration.ts:5-8`），改进程变量会连带改掉同一请求的鉴权，所以「需要 S3」与本地临时根这两种状态都只经注入的 `env` 得到（§8.1 b28-503、§8.2 门 1）。
- **启动探针**（`[b-37]`）：启动对解析出的存储做一次探针：写入探针键 → 读回比对字节 → 在 `task-attachments/` 前缀下发**一次**有界列举（只证明对前缀有列举权限，不断言结果里含探针键）→ 对探针键做 head（证明刚写入的对象可见）→ 删除。探针**从不**断言探针键出现在按前缀、按页数上限截断的列举结果里：S3 按键的字节序返回，按月份命名的对象键排在探针键之前，前缀下的对象一旦多于一页，这种断言就恒假，会让后端在一次普通的重启时中止。这与审批 runtime 在生产存储上的探针同形（`approval-attachment-runtime.ts:159-163`：一次有界列举 + head）。探针失败（任一步抛错、读回不等、head 不可见）先尽力删除探针键，再抛固定信息，调用方中止启动（S22：与审批同形，开关开着而存储不可用是故障，不是降级）。
- 本地目录与别的业务线的目录是否重叠，任务线代码不去检查（那要读别的业务线的设置）；本地实现只在开发与测试里使用。

### 5.2 上传

- multer：内存存储，`limits: { fileSize: TASK_ATTACHMENT_LIMITS.maxFileBytes, files: 1, fields: 0, parts: 2 }`（D5，`ASSUMPTION`；`parts: 2` 让恰一个文件部件通过），并设 `defParamCharset: 'utf8'`（`[b-05]`）。仓内 multer 是 2.x，它在没有这个选项时按 latin1 解 `filename` 参数，浏览器以原始 UTF-8 发送的中文文件名会解成乱码，再被显示名卫生判为不合格；任务线的产品面以中文文件名为常态，所以这个选项是必需的，§8.1 有一格钉住。
- multer 的错误映射成固定码（§3.1 第 5 步），不回显文件名、字段名与上限值（`[b-06]`）。
- 校验顺序全由任务 E 定：大小 → MIME 在白名单 → 扩展名在白名单 → 扩展名与 MIME 一致 → 内容。图片与 PDF 必须签名一致（S18）；txt / csv 的内容判定是任务 E 在 S18 之上的读法（X4，§9.2 Q-b2）。声明的类型只做小写与去空白，带参数的类型不在白名单。
- 存储键由校验通过的 MIME 决定扩展名，与上传时的文件名无关；随机后缀由服务端生成。
- 白名单、单文件 10 MiB、每任务 20、每评论 5 个与 25 MiB 都是任务 E 的单点常量（S18、D18，`ASSUMPTION`）；DB 的 CHECK 在 PR-4a。

### 5.3 下载

服务端读出整个 blob 再发送（D6，`ASSUMPTION`；单文件不超过 10 MiB，整块读出的内存代价有界）。不发签名链接，也不跳转到存储；`Content-Length` 由框架给出。四个响应头只来自任务 E 的 `buildTaskAttachmentDownloadHeaders`，路由不另加、不另改。

### 5.4 删除与保留（S23）

- blob 的删除只有三个来源：用户移除（行改 `deleted` 并写 intent）、未绑定过期（同）、孤儿对账（只写 intent）。行删除触发器是第四个 intent 写入者，但 M5 没有删行的路径。真正删 blob 的只有排空作业，外加 §3.1 末段登记的那一个例外。
- 任务软删：附件行与 blob 都保留，下载与移除因为取不到所属任务而 404，留待保留期作业（§13-27 以后裁）。删除评论：附件留在任务的附件栏里，仍可下载，仍只有上传者能移除（S19、S20）。
- intent 表里 `done` 的行不清理，保留期随 §13-27 一并裁定（与 M4 outbox 行的处理相同）。

### 5.5 GC 三作业与调度器

三个作业都实现 PR-3b 的 `TaskSchedulerJob`（`name` + `run(ctx)`），在每个分批之间检查 `ctx.stopping()`，跑在调度器的提交后阶段，不进 leader 锁事务（S30、S07 的宿主形状）。PR-3b 的 `TaskSchedulerOptions` 只有一个提交后槽位 `deliveryJob`（`services/task-scheduler.ts:190`，运行在 `:470`），所以 PR-4b 给它加一个列表选项 `afterCommitJobs`（缺省空），在投递作业之后逐个运行、各经 `runJob` 隔离失败；`startTaskScheduler`（`:895`）把附件运行时给出的作业放进去，开关关或存储不可用时给空列表（`[b-23]`）。PR-4c 的投影 sweep 追加到同一列表，谁先合并谁带这个选项（§9.3 Q-b7）。

| 作业 | 每次运行 | 规则 |
|---|---|---|
| `task-attachment-unbound-sweep` | 至多 200 行（`[b-24]`） | 未绑定且 `created_at <= ctx.now() - TTL` 的行，`FOR UPDATE SKIP LOCKED` 认领，改 `deleted`（`deleted_at = ctx.now()`，`deleted_by` 为空），同一条语句写 `unbound_ttl` intent；已绑定的行从不清扫 |
| `task-attachment-purge-drain` | 至多 50 条 intent；至多 5 次；租约 5 分钟 | 认领 `pending` 或租约过期的 `in_progress`，**跳过仍被非删除行引用的键**（S23）；认领时 `attempts`、`fence` 各加一、写新租约；已用尽次数的在认领语句里直接转 `dead_letter`（`MAX_ATTEMPTS_EXHAUSTED`），不调用删除；删除成功 ⇒ `done` 与 `purged_at`；失败 ⇒ 次数未尽回 `pending`，用尽 ⇒ `dead_letter`（`BLOB_DELETE_FAILED`）；结果写回都带 `fence` 比较，过期的旧认领写不进去 |
| `task-attachment-orphan-reconcile` | 至多 250 个对象；宽限 1 小时；游标在进程内 | 列举前缀下的对象：没有任何行（不论状态）引用、且年龄超过宽限的对象 ⇒ 写 `reconciler_orphan` intent；年龄不足的跳过（可能正在上传）；反向：活行的 blob 不存在 ⇒ 只报告（作业结果带计数与行 id，日志只记计数），从不自动删行 |

过期边界用 tick 的库锚定时钟 `ctx.now()` 与任务 E 的 TTL 常量，TS 与 SQL 两份边界由单测对拍（`[b-25]`）。三个作业的数值都是常量，不是开关，不进 manifest。

---

## 6. 事务、锁、时刻、事件、通知、红点

### 6.1 事务与行锁

- 读路径不进事务、不加锁（与 M2–M4 相同）。
- 附件写入不是结构写（E07 点名的是设父、删除级联、依赖增删），不走 `withOrgStructure`，也不取任何 advisory 锁；门 7 的三处取锁字面量与 PR-4a 的锁序包装器都不受影响（`[b-08]`）。
- 配额判定（每任务 20）靠所属任务行的 `FOR NO KEY UPDATE` 串行化：它与另一次上传、绑定、移除互斥，与 M3 删除任务时的 `FOR UPDATE` 互斥，与评论的 `FOR KEY SHARE` 不互斥。所以不带附件的评论不会因附件写入而等待；带附件的评论在 M3 的 `FOR KEY SHARE` 之后再取这一把（`[b-09]`），两次同时带附件的评论不会死锁（`FOR KEY SHARE` 与 `FOR NO KEY UPDATE` 不冲突，后取的只等先取的）。
- 加锁顺序统一为先任务行、后附件行：任务级上传（任务行，再插附件行）、评论绑定（任务行，再更新附件行）、已绑定附件的移除（任务行，再锁附件行）。未绑定附件的移除与过期清扫只碰附件行、从不再去锁任务行，所以不会出现反向的顺序。
- 暂存上限（`[b-19]`）的计数不加锁：同一上传者并发暂存时可能多出几行，它是软上限，由 168 小时清扫兜底。

### 6.2 时刻

- 任务级上传与已绑定附件的移除：锁后读一次 `clock_timestamp()`，行的时刻列与事件的 `occurred_at` 都用它（PR-4a §4.4 的规则）；任务级行的 `created_at` 与 `bound_at` 写同一个值（`[b-22]`）。
- 评论绑定：用评论行的 `created_at`。它与 `commented` 事件的列缺省同为事务时刻，于是一次评论写出的评论、绑定时刻与全部事件是同一个时刻。
- 暂存行的 `created_at` 取列缺省；未绑定附件的移除用语句里的 `clock_timestamp()`。
- GC 用 tick 的库锚定时钟（§5.5）。

### 6.3 事件与 payload

- 只用锁 §4.2 闭集里已有的两个词，不新增（E03）：`attachment_added`（任务级上传写一条；评论绑定时一个附件对应一条，S19）、`attachment_removed`（已绑定附件的移除一条）。暂存、未绑定附件的移除、过期清扫、GC 都不写事件：它们没有所属任务。
- payload 来自任务 E：`attachment_added` 为 `{ attachmentId, bindKind }`，`attachment_removed` 为 `{ attachmentId }`。只有闭集键名、任务域 id 与闭集枚举值，不放文件名、类型、大小。任务内历史以后读到 `attachmentId` 时仍要按读者的可见性校验（owner 2026-10-09 六项之第 5 项）。
- 写入经 PR-4a 切片 1 之后的 `writeEvents`（它写入 payload，返回 `WrittenTaskEvent[]`）。`writeEvents` 的入参类型今天只收完成类事件（`services/task-records.ts:643`）。PR-4a 经它写 `recurrence_spawned`、依赖增删等非完成类事件（PR-4a §4.4），所以把入参放宽到 `task_events` 闭集是 PR-4a 切片 1 对 `writeEvents` 的改动的一部分；PR-4b 把它列为依赖（头部「依赖」一条），不改 `task-records.ts`。PR-4b 重建时若发现入参仍只收完成类事件，回到 PR-4a 修，不在 PR-4b 里改这个函数。
- `tasks.version` 不变：附件不在 `PATCH` 可编辑的字段里，也不是完成态（PR-4a `[a-10]` 的同一理由）；取行锁不改行。

### 6.4 通知（S33、E15）

- `TASK_NOTIFIABLE_EVENTS`（`src/tasks/task-notifications.ts:39`）加 `'attachment_added'`；`attachment_removed` 不加。收件人沿用 PR-3b 已合入的规则（D13，`ASSUMPTION`）：创建人 ∪ 负责人 ∪ 关注人 ∪ 装着该任务的每张清单的成员（含已归档），排除 actor，一人只出一行、取最高优先级角色。任务级与评论级都发（S33）。
- 渲染：`task-notification-text.ts` 的 `EVENT_SENTENCES`（`:145`）是按闭集的穷尽映射，必须加一句；句子只含任务标题、不含文件名（`[b-27]`），标题照既有的卫生规则处理。
- 钉住旧闭集的三处 M4 期望在同一 PR 里改，只改这三处：`tests/unit/task-notifications.test.ts:37-38`（闭集逐项相等，标题里写着附件推迟到 P2）、`tests/unit/task-notification-producer.test.ts:156`（`attachment_added` 列在不通知的词里，换成 `attachment_removed`，这一格仍证明附件移除不通知）、`tests/unit/task-notification-text.test.ts:98-104`（期望句子表加一项）。`tests/unit/task-notifications.test.ts:486` 的 `{ kind: 'attachment_added' }` 答 `unknown_kind` 不受影响（那是 payload 的 kind，不是事件）。这三处改动就是 S33 裁定的取值，不是放宽门 24；负控：把字面量里的 `'attachment_added'` 删掉 ⇒ 闭集逐项相等那一格与 §8.1 的 b28-notify 同时变红（句子表那一格按闭集循环，删掉的词它不再访问，不能单独作负控）。
- 不需要 DDL（按 `906840c74c` 核过）：`task_events_type_chk` 已含两个附件词（P0-A 迁移 `zzzz20260926120000_create_task_p0a_tables.ts:38-39`、`:136`）；outbox 没有库级的事件闭集，`task_notification_deliveries` 的六条 CHECK 只管 org、收件人、角色、状态、计数与投递状态，没有一条涉及事件名（M4 迁移 `zzzz20261009130000_create_task_m4_tables.ts:266-279`），`source_type` 与 `payload` 不设 CHECK，这张表建好之后再没有迁移动过它；`buildTaskEventSourceKey`（`task-reminders.ts:232`）只由任务 id、事件 id、用户与通道组成，不含事件名。
- 一条带 k 个附件的评论对每个收件人产生 k + 1 条通知（1 条 `commented`、k 条 `attachment_added`）。这是 S19（一个附件对应一条事件）与 S33（评论级也发）合起来的结果，本文照做，并把它作为问题登记（§9.3 Q-b5）。

### 6.5 红点信号与 PR-3c 普查

- 附件的上传、绑定、移除与 GC 都不改 `buildTaskPendingCondition` 的任何输入（负责人集合、`completed_at`、`status`、`deleted_at`、截止日期与时间、时区），不是门 26 的触发写入，不调用 `taskCountsSignal()`，不发 `tasks:counts-updated`。§8.1 有一格断言这一点，并在同一夹具里用一次完成作正控。
- PR-3c 普查的三条规则（`tests/unit/task-counts-touchpoints.test.ts`）：规则 ① 的人口（只有三个服务文件写待办输入）与规则 ② 的写入者名单都不变，PR-4b 不写 `tasks` 与 `task_assignees`。规则 ③ 的扫描范围是三个写入文件及它们传递导入的每个 `services/task-*`、`db/task-*` 模块（`writerModules()`，`:681`）：`task-structure.ts` 为评论绑定导入的新模块 `services/task-attachment-bind.ts` 与开关模块 `services/task-attachment-flags.ts` 会自动落进去，所以它们守规则 ③（每个 `catch` 以 `throw` 或 `fail(…)` 结束、块内没有 `return` / `break` / `continue`，`finally` 块里也不出现这三者（`FINALLY_CLAUSE`，`:699`），不用 `.then` / `.catch` 与会吞错的组合子）。§3.1 末段那个吞错的尽力删除只在 `services/task-attachment-records.ts` 与存储模块里，这两个模块不被三个写入文件导入；一格静态单测钉住绑定模块的导入边界（`[b-36]`）。`services/task-scheduler.ts` 只由 `src/index.ts` 导入，`writerModules()` 走不到它（PR-4a §4.1 已写明它在规则 ③ 之外）；PR-4b 给它加 `afterCommitJobs`（`[b-23]`）与 GC 作业模块 `services/task-attachment-gc.ts` 都只经调度器与附件运行时接入，同样不进这一遍历，与 PR-4a 对调度器的处理一致。排空作业要接住单个 blob 的删除失败、把它写回为 `BLOB_DELETE_FAILED`（§5.5），这种接住不以 `throw` 结束，所以 GC 模块与 `task-attachment-records.ts` 一样，不得被三个写入文件直接或传递导入（`[b-36]` 那一格的禁止集合含它）。普查单测本身一字不改。

---

## 7. 文件

| 层 | 文件 | 内容 |
|---|---|---|
| 纯函数 | `src/tasks/task-attachment-access.ts`（新） | `taskAttachmentOrgClause`（私有，`task_attachments.org_id` 只在这里出现）；`buildTaskAttachmentByIdCondition`（会话 org 内按 id，含已删除）、`buildStagedAttachmentsOfUploaderCondition`（会话 org、上传者、未绑定）（`[b-14]`） |
| 纯函数 | `src/tasks/task-attachment-views.ts`（新） | 列表项与能力位的组装；引用解析两种模式的逐 id 分类（`[b-14]`、`[b-18]`） |
| 纯函数 | `src/tasks/task-notifications.ts`（改一处） | 闭集加 `'attachment_added'` |
| 纯函数 | `src/tasks/task-notification-text.ts`（改一处） | `EVENT_SENTENCES` 加一句 |
| 服务 | `src/services/task-attachment-flags.ts`（新） | `isTaskAttachmentsEnabled` |
| 服务 | `src/services/task-attachment-s3.ts`（新） | 配置读取与 S3 provider |
| 服务 | `src/services/task-attachment-storage.ts`（新） | 存储接口、本地实现、前缀适配、解析（收注入的 `env`）、探针（`[b-37]`） |
| 服务 | `src/services/task-attachment-runtime.ts`（新） | 启动（收注入的 `{ env, cwd?, logger? }`）与取值函数、只供测试的 `resetTaskAttachmentRuntimeForTests()`、GC 作业的解析（§5.1，`[b-03]`） |
| 服务 | `src/services/task-attachment-records.ts`（新） | §3.1–§3.6 的服务函数 |
| 服务 | `src/services/task-attachment-bind.ts`（新） | §3.7.2 第 2、3、5–7 步；被 `task-structure.ts` 导入，守 PR-3c 规则 ③ |
| 服务 | `src/services/task-attachment-gc.ts`（新） | §5.5 的三个作业 |
| 服务 | `src/services/task-structure.ts`（改） | `addComment` 接 `attachmentIds`（§3.7） |
| 服务 | `src/services/task-ids-runtime.ts`（改） | `newTaskAttachmentId()` |
| 服务 | `src/services/task-scheduler.ts`（改） | `afterCommitJobs` 选项与 `startTaskScheduler` 的接线（`[b-23]`） |
| 路由 | `src/routes/tasks-attachments.ts`（新）、`src/routes/tasks.ts`（加一行） | §3.0 |
| 启动 | `src/index.ts`（改两处） | 全局 JSON 解析器（`:1816`）之前的精确路径解析器（`[b-15]`）；`startTaskScheduler()` 之前启动附件运行时（`[b-03]`） |
| manifest | `scripts/ops/global-history-flag-manifest.mjs` 与它的测试（改） | `TASKS_ATTACHMENTS_ENABLED` 条目与格（§8.2 门 18，`[b-29]`、`[b-30]`） |
| 测试 | 见 §8.3、§8.4 | — |

PR-4a 也改 `task-structure.ts`（系列删除）与 `task-scheduler.ts`（leader 锁改经包装器）；PR-4b 在 PR-4a 合入之后按当时 main 重建，这两个文件里双方的改动彼此不在同一函数里。`task-records.ts` 只有 PR-4a 改（`writeEvents` 的 payload 与入参闭集，§6.3），PR-4b 不改它、只依赖它。

---

## 8. 门与测试

### 8.1 候选门 28（M5-b）

S31 已定 M5-b 落到整数门 28（PR-4a §6.2、§7.3）；在锁修订把它写进 `arm-set` 之前不计分。并发格的交错一律按 PR-4a §6.2 开头的持锁法由夹具强制，不靠时机。

| 格 | 夹具与期望 | 负控（每个都要让该格变红） |
|---|---|---|
| b28-type / ext | 白名单外的 MIME ⇒ 422 `MIME_NOT_ALLOWED`；扩展名与 MIME 不符（扩展名在白名单内，内容与声明的 MIME 签名一致）⇒ 422 `EXTENSION_MIME_MISMATCH`；两格都没有新行、存储里没有新键 | 去掉任务 E 的 MIME 白名单判定 ⇒ 类型格落到后续判定或 PR-4a 的 `task_attachments_mime_type_chk`（后者 ⇒ 500），不再是 `MIME_NOT_ALLOWED` ⇒ 红；去掉扩展名与 MIME 的一致性判定 ⇒ 扩展名格 200 |
| b28-sig | 声明 `application/pdf`、扩展名 `.pdf`、内容是 PNG ⇒ 422 `CONTENT_MIME_MISMATCH` | 注释掉任务 E 的签名比对 ⇒ 200 |
| b28-size | 恰 10 MiB ⇒ 200（正控）；多一个字节 ⇒ 422 `FILE_TOO_LARGE`；零字节 ⇒ 422 `INVALID_SIZE` | 超限有三道守卫：multer 的 `fileSize`、任务 E `validateAttachmentCandidate` 的大小判定、PR-4a 的 `task_attachments_size_chk`（`1..10485760`）。只放宽一道代码守卫，格仍是 422；两道代码守卫一起放宽一个字节 ⇒ 上传走到第 12 步的 `INSERT`，被 CHECK 拒绝（23514）、回滚并内联删除 blob ⇒ 500 `INTERNAL`，超限格（期望 422）红。完全杀死的变体：夹具里再把 CHECK 放宽一个字节 ⇒ 200 |
| b28-name | 文件名含中文、以原始 UTF-8 发送 ⇒ 200，`fileName` 原样往返 | 去掉 `defParamCharset: 'utf8'` ⇒ 422 或乱码 |
| b28-cleanup | 预判时 19 个。第三个连接先持有该任务行的 `FOR NO KEY UPDATE`，上传在第 9 步等锁（按门 6 的 settle 规则确认它在等），第三个连接此时补一行到 20 并提交 ⇒ 上传 422 `LIMIT`，没有新行，第 8 步写下的 blob 已被内联删除 | 去掉内联删除 ⇒ blob 残留 |
| b28-quota | 已有 15 个任务级、5 个评论级附件 ⇒ 第 21 个任务级上传 ⇒ 422 `LIMIT`（Q-b2 的缺省口径） | 计数只数任务级 ⇒ 200 |
| b28-quota-race | 19 个时两个连接同时上传。第三个连接先持 `LOCK TABLE task_attachments IN SHARE MODE`：计数读不受它阻挡，两次 `INSERT` 都被它挡住；按门 6 的 settle 规则确认两个上传的后端都在等锁之后释放 ⇒ 恰一个 200、另一个 422，结束时 20 个 | 去掉任务行锁 ⇒ 两个都在锁外读到 19、都等在 `INSERT` 上，释放后两个都 200（结果确定，不靠时机） |
| b28-staged-cap | 同一上传者第 21 个暂存 ⇒ 422 `LIMIT`（`[b-19]`） | 去掉上限判定 ⇒ 200 |
| b28-403 | 没有 `tasks:read` 去下载 ⇒ 403，体逐字 `{ error: 'Insufficient permissions' }` | — |
| b28-dl-unbound | 暂存行：上传者 200；同 org 别人 404，与 id 不存在逐字节相同 | 去掉上传者比对 ⇒ 别人 200 |
| b28-dl-bound | C、A、LE、F、LR 200；O 404 | 去掉 `can(roles, 'view')` ⇒ O 200 |
| b28-dl-tenant | 同一用户在 org A、B 都在职，在 B 暂存，会话 org 为 A 去下载 ⇒ 404；正控先跑：会话 org 为 B 时 200 | 删掉纯函数的 org 比对 ⇒ 200 |
| b28-410 | 已删除的行：上传者或有 `view` 的人 ⇒ 410 `GONE`；O ⇒ 404 | 把 `gone` 判定挪到授权之前 ⇒ O 得 410 |
| b28-headers | 四个响应头逐字相等 | 处置改 `inline`，或去掉 CSP ⇒ 红 |
| b28-503 | 本文件的 `tasksRouter()` 建在一个以注入的 `env`（`NODE_ENV: 'production'`、开关开、五个 S3 变量都不设）启动的附件运行时上（§5.1），进程的 `NODE_ENV` 不动：有 `view` 的人下载 ⇒ 503 `STORAGE_UNAVAILABLE`；O ⇒ 404 | 把存储判定挪到授权之前 ⇒ O 得 503 |
| b28-softdel | 所属任务软删后：下载与移除都 404；行与 blob 都在 | 取所属任务改用 `buildTaskByIdAnyStateCondition`（含已软删）⇒ 下载 200 |
| b28-rm-matrix | 任务级：有 `view` 的上传者、C、A、LE 能移除；不是上传者的 F、LR ⇒ 404。评论级：只有上传者；C ⇒ 404 | `canRemoveAttachment` 不看绑定类型 ⇒ C 移除评论附件 200 |
| b28-rm-view | 上传者被移出关注人、对任务已无 `view` ⇒ 移除自己的附件 404（Q-b3 的缺省） | 去掉 `view` 前提 ⇒ 200 |
| b28-rm-intent | 移除 ⇒ 行为 `deleted`、`deleted_at`、`deleted_by`；恰一条 `user_removed` intent，id 为 `'tpi_' \|\| md5(storage_key)`；已绑定的写一条 `attachment_removed`，未绑定的不写事件 | 去掉 §3.5 语句里的 `intent` CTE ⇒ 零条 intent |
| b28-rm-twice | 移除之后夹具硬删这一行 ⇒ 语句成功，intent 仍恰一条 | 把触发器的 `ON CONFLICT` 子句整个去掉 ⇒ 硬删报 23505（取代候选内容里那个改冲突目标的负控，见 Q-b6） |
| b28-trigger | 夹具直接删一行活附件 ⇒ 一条 `row_deleted` intent；夹具硬删一个任务 ⇒ 级联删掉它的附件、每个各一条 intent；排空作业随后把 blob 删掉 | 停用触发器 ⇒ 没有 intent |
| b28-rm-tenant | 在 B 暂存、会话 org 为 A 去移除 ⇒ 404，B 的行不变 | 删掉 `taskAttachmentOrgClause` 的 org 合取 ⇒ 200 且行被删 |
| b28-rm-race | 同一暂存行上，评论绑定与上传者的移除同时发生。第三个连接先对这一暂存行持 `SELECT … FOR UPDATE`，两条语句都等在行锁上（按门 6 的 settle 规则确认）之后释放 ⇒ 恰一方的语句先生效：评论 422 `ATTACHMENT_NOT_BINDABLE` 且行已删，或评论 200 且移除按已绑定的路径完成（认领 0 行 ⇒ 重读 ⇒ 第 4 步，写一条 `attachment_removed`）。两种顺序各跑一格：夹具先发其中一条、确认它在等锁之后再发另一条，排队顺序即生效顺序 | 去掉移除认领语句里的 `status = 'unbound'` ⇒ 「先绑定」那一格里移除的认领直接把已绑定的行改成 `deleted`，不走已绑定的路径、没有 `attachment_removed` ⇒ 红 |
| b28-bind（切片 3） | 3 个自己暂存的 id ⇒ 评论 200；三行为评论级已绑定形状，`bound_at` 等于评论的 `created_at`；1 条 `commented` 与 3 条 `attachment_added` 的 `occurred_at` 相同，payload `{ attachmentId, bindKind: 'comment' }` | 绑定语句的 `bound_at` 改写 `clock_timestamp()`、不用评论的 `created_at` ⇒ 时刻相等的断言红 |
| b28-bind-reject | 与一个合法 id 混在一起，各一格：别人暂存的、已绑定的（评论级）、任务级的（调用者本人上传、同 org）、他 org 的（同一上传者）、已删除的、不存在的 ⇒ 422 `ATTACHMENT_NOT_BINDABLE`；没有评论行、没有事件，所有附件行不变 | 去掉上传者谓词 ⇒ 别人那一格 200；去掉状态谓词 ⇒ 已绑定那一格被改绑；去掉 org 合取 ⇒ 他 org 那一格 500；状态谓词与 `bind_kind` 谓词一起去掉 ⇒ 任务级那一格 500（`task_attachments_task_kind_chk`）。单独去掉 `bind_kind` 谓词是等价变异，不立负控（§3.7.2 末段） |
| b28-bind-limit | 6 个 id ⇒ 422 `LIMIT`（进事务之前）；5 个合计超过 25 MiB ⇒ 422 `LIMIT`，评论不落库 | 去掉 `checkCommentAttachmentTotals` ⇒ 200 |
| b28-bind-quota | 任务已有 18 个附件，评论带 3 个 ⇒ 422 `LIMIT`（Q-b2 的缺省口径） | 去掉 §3.7.2 第 3 步 ⇒ 200 |
| b28-bind-ids | `attachmentIds` 里有前导或尾随 `_` 的 id ⇒ 422 `INVALID_IDS`（与 `M5\|10\|P2子集` 的 id 两格同形，`[b-31]`） | 调用方跳过 `planCommentAttachmentBind` 的 id 校验 ⇒ `UPDATE` 选不中那一行，格得 `ATTACHMENT_NOT_BINDABLE` 而不是 `INVALID_IDS` |
| b28-bind-off | 开关关（暂存路由此时未注册，夹具直接插入一行调用者本人的暂存行）：带这一个 id ⇒ 422 `ATTACHMENTS_DISABLED`；空数组与缺键 ⇒ 200，行为与 M3 相同 | 去掉 §3.7.1 第 4 步 ⇒ 200，开关关着而那一行被绑定 |
| b28-comment-del | 删掉带附件的评论 ⇒ 附件仍在列表里、仍可下载，仍只有上传者能移除 | 让 `deleteComment`（`services/task-structure.ts:757`）同时把该评论的附件改成 `deleted` ⇒ 列表与下载两格红 |
| b28-ttl | 暂存行建于 168 小时前 ⇒ 清扫后为 `deleted`，一条 `unbound_ttl` intent；差 1 毫秒 ⇒ 不动；已绑定的行从不清扫 | TTL 减半 ⇒ 边界格红；去掉状态条件 ⇒ 已绑定行被清扫 |
| b28-drain | 待排空的 intent ⇒ blob 删除、`done`、`purged_at`；键仍被活行引用 ⇒ 不认领；删除失败 ⇒ 回 `pending` 且次数加一；第 5 次之后 ⇒ `dead_letter`，`last_error` 为大写固定码（CHECK 通过）；租约过期 ⇒ 可被重新认领；旧 `fence` 的结果写回不生效 | 去掉「仍被引用」的排除 ⇒ 被引用的 blob 被删；去掉 `fence` 比较 ⇒ 旧认领覆盖新结果 |
| b28-reconcile | 超过宽限、没有任何行的对象 ⇒ 一条 `reconciler_orphan` intent；不足宽限 ⇒ 不写；活行的 blob 丢失 ⇒ 报告、行不变 | 去掉宽限 ⇒ 年轻对象被写 intent |
| b28-sched-off | 开关开、调度器关 ⇒ 上传与下载照常；三个作业都不运行（过期的暂存行一直在） | — |
| b28-flag-off | 开关关 ⇒ 6 条附件路由都 404（未注册）；GC 作业列表为空 | 去掉 `registerTaskAttachmentRoutes` 里的开关判定 ⇒ 路由应答（不再是 404） |
| b28-notify | 通知管线打开：A 上传任务级附件 ⇒ outbox 给 C、F 与清单成员各一行 `attachment_added`，A 自己没有；移除 ⇒ 没有行 | 闭集删掉 `'attachment_added'` ⇒ 零行 |
| b28-no-counts | 上传、带附件的评论、移除 ⇒ 零条 `tasks:counts-updated`；同一夹具里一次完成 ⇒ 负责人恰一条（正控） | — |
| b28-refs-stage | 暂存模式：自己暂存的 ⇒ `stale: false`；别人的、已绑定的、已删除的、不存在的 ⇒ 都是 `stale: true`，彼此不可区分 | 分类按原因给出不同的项（例如已绑定的另带一个键）⇒ 「彼此不可区分」的断言红 |
| b28-refs-task | 任务模式：绑在这个任务上的 ⇒ 完整项；绑在别的任务上的、已删除的、不存在的 ⇒ tombstone；对任务没有 `view` ⇒ 404 | 只按 id 读、不从任务出发 ⇒ 别的任务的附件出现 |
| b28-refs-limit | 原始数组 201 个 ⇒ 422 `LIMIT`；请求体超过 64 KiB（真服务器）⇒ 413 `PAYLOAD_TOO_LARGE` | 去掉 `index.ts` 的精确路径解析器 ⇒ 超限请求体被收下 |
| b28-refs-tenant | 在 B 暂存、会话 org 为 A 的暂存模式 ⇒ `stale: true` | 删掉 org 合取 ⇒ `stale: false` |

### 8.2 M5-g：门 1/2/13/17/18/20 的 PR-4b 子集

- **门 1**：每条新写路由（任务级上传、暂存上传、移除）缺 org ⇒ 422，422 在 `rbacGuard('tasks','write')` 之后，同夹具换有效 org 得 200 反证；带一个 id 的读（列表、下载、引用解析的任务模式）缺 org ⇒ 404；引用解析的暂存模式缺 org ⇒ 降级 200。跨 org 写格：往 org B 的任务上传、移除 org B 的附件 ⇒ 404，org B 的数据零变化。附件的第二租户格（b28-dl-tenant、b28-rm-tenant、b28-refs-tenant 与 b28-bind-reject 的他 org 一格）放在 `tests/tasks-auth/tasks-auth-gate.ts`（信任关闭），照 PR-4a 字段第二租户的形状，正控先跑；它们同时是门 28 的格（`[b-32]`）。附件开关与存储根由门文件在建路由之前设定，不动专属 config 的 env 块：门文件以注入的 `env`（开关开、`TASK_ATTACHMENT_STORAGE_DIR` 指向 `mkdtemp` 建的临时根）调用 `startTaskAttachmentRuntime`，收尾时调 `resetTaskAttachmentRuntimeForTests()`（§5.1），不改进程的环境变量。
- **门 2**：每条新路由一组非 admin 正格与三个 403 负格（缺角色授码、缺准入行、只有同 namespace 的另一个码），各用独立用户；403 体逐字。
- **门 13**：真 `MetaSheetServer`、开关开，`GET /api/tasks/:id/attachments` ⇒ 200；把 `tasksRouter()` 里新加的那一行注册置空 ⇒ 该格 404 ⇒ 红。
- **门 17**：§8.4 的三个新文件各自满足 ①②④，PR 正文写 `.each` 展开后的计数。
- **门 18**：`TASKS_ATTACHMENTS_ENABLED` 被源码发现并登记在 manifest；删掉该条 ⇒ `pnpm verify:global-history-flag-manifest:test` 红。条目的 purpose 写出 M5 迁移在盘上的文件名，测试按盘上文件名钉住（`[b-30]`，照 M4 三个开关的先例）。
- **门 20**：两个新纯模块在行为 harness 与 2026-10-09 加严的静态导入检查之下；另把它们加进任务 E 的 `'x'` 探针表（`[b-35]`）。
- 门 21、22 属前端，不在 PR-4b。

### 8.3 单测

| 文件 | 格 |
|---|---|
| `tests/unit/task-attachment-access.test.ts`（新） | 两个 builder 的 SQL 文本与参数；`task_attachments.org_id` 在模块里恰出现一次；负控：再手写一处 org 文本 ⇒ 计数格红 |
| `tests/unit/task-attachment-views.test.ts`（新） | 列表项与 `canRemove` 的身份网格；引用解析两种模式的分类（`infected`、已删除、别的任务 ⇒ tombstone；暂存模式只认本人、本 org、未绑定） |
| `tests/unit/task-attachment-storage.test.ts`（新） | 本地包含检查（`..`、绝对路径、NUL ⇒ 抛）；独占创建；删除幂等；前缀适配在写、读、列举、删除上都拒绝前缀外的键；解析矩阵（生产且配置完整 ⇒ S3；生产且不完整 ⇒ 需要 S3；非生产 ⇒ 本地，目录变量与缺省；全部经注入的 `env`）；探针成功与各步失败（失败只抛固定信息）；前缀下预先放入多于列举上限的对象、且它们的键按字节序都排在探针键之前 ⇒ 探针照样通过（负控：探针改为断言列举结果含探针键 ⇒ 这一格红，`[b-37]`） |
| `tests/unit/task-attachment-s3.test.ts`（新） | 桶与区域缺一 ⇒ 不完整；端点不可解析 ⇒ 固定信息的错误；`http:` 只在 `ALLOW_HTTP` 精确为 `'true'` 时接受（`'TRUE'`、`' true'`、`'1'` 都不算）；写入带 `IfNoneMatch: '*'`；前缀外的键在发出任何请求之前被拒 |
| `tests/unit/task-attachment-gc.test.ts`（新） | 三个作业的名字；`stopping()` 之后不再开新批；`last_error` 只出现两个大写码；TTL 边界 TS 与 SQL 对拍（差 1 毫秒两侧） |
| `tests/unit/task-attachment-routes.test.ts`（新，按仓库约定用 `usePinnedServer()`，不用 `request(app)`） | multer 错误到码的映射且不回显输入；503 的映射；引用解析解析器的 413 与 400；开关关时一条路由也不注册；内联删除的范围（§3.1 末段）：第 12 步 `INSERT` 被拒 ⇒ 删一次 blob，`COMMIT` 抛错 ⇒ 不删，暂存路由的连接层失败（没有 SQLSTATE）⇒ 不删（负控：把 `COMMIT` 纳入删除范围 ⇒ 第二格红） |
| `tests/unit/task-attachment-bind-imports.test.ts`（新） | 绑定模块只导入允许的集合（不导入存储、GC、运行时与 `task-attachment-records.ts`）；负控：加一行存储模块的导入 ⇒ 红（`[b-36]`） |
| `tests/unit/task-scheduler.test.ts`（加格） | `afterCommitJobs` 在投递作业之后按序运行；其中一个失败不影响后面的；follower、leader 丢失、`stopping` 时一个也不跑；既有格不改 |
| `tests/unit/task-notifications.test.ts`、`task-notification-producer.test.ts`、`task-notification-text.test.ts`（改三处） | §6.4 |
| `tests/unit/task-attachment-flags.test.ts`（新） | `'true'` 开；`'TRUE'`、`' true'`、`'1'`、空串、缺省都关 |
| manifest 测试（加格） | 条目存在、`dependsOn` 两项、`source` 指向开关函数、purpose 含盘上的 M5 迁移名 |

### 8.4 真库文件与登记

新文件：`task-m5-attachments.db.test.ts`（上传、列表、下载、移除、引用解析、配额、响应头、503、通知、红点）、`task-m5-attachment-comments.db.test.ts`（评论绑定，切片 3）、`task-m5-attachment-gc.db.test.ts`（清扫、排空、对账、触发器的配合）。每个同 PR 登记三处（锁 §5.2.1：`vitest.config.ts` 的 exclude 逐文件字面量、`tasks-realdb` 清单、④ 的三集合相等），顶部带 `assert-rbac-optional-off` 的导入。每个文件的存储根是测试自建的临时目录，不用固定路径。PR-4a 与 PR-4c 也往这三处追加文件，后合并的一方按当时 main 重排。

### 8.5 回归与 PR 正文

- 最终 head 上重跑全部 `M2|`、`M3|`、`M4|` 行（S31 ③）。PR-4b 改了 M3 的评论创建（`task-m3-comments-deletion.db.test.ts` 整文件必跑）、调度器的选项（`M4|25|整门`）与通知闭集（`M4|23|整门`、`M4|24|整门`）。PR-3c 的普查单测在最终 head 上也要绿，PR-4b 不改它。
- PR 正文首段：本 PR 不含 DDL；它依赖 PR-4a 的迁移，凡 `TASKS_ATTACHMENTS_ENABLED='true'` 的环境必须已应用该迁移；合并不会自动到达生产（锁 §5.4）。
- 照写 §3.9 的真值表（S30 要求 PR 正文必写），尤其「开关开而调度器关 ⇒ GC 不跑、blob 只增不减」。
- S37：任务域的表（含附件两表）不在任何 DML 普查的分母里，现有 CI 查不出对它们的直接 DML。
- `.each` 展开计数（门 17）；三项扫描的结果。
- 合并后的 owner 步骤（S31 ④，不阻合并）：在 staging 把 `TASKS_ATTACHMENTS_ENABLED` 实际打开一次，留下至少一行 `task_attachments` 作证据；它需要 staging runner 的输入与另行的授权，PR 正文照写为待办，不在本 PR 里执行。门 28 写进锁时，这一步作为该行的合并后一项一并记下。

---

## 9. owner 问题与自选

### 9.1 本文自选（`ASSUMPTION(task-m5b): [b-NN]`；缺省即起草值）

| 编号 | 取舍 | 缺省 | 备选与代价 |
|---|---|---|---|
| b-01 | 路由文件与注册 | 新文件 `routes/tasks-attachments.ts`，`tasksRouter()` 加一行；开关判定在注册函数里 | 判定写在调用行上：门 13 的置空负控要改的不止一行 |
| b-02 | 开关谓词的位置 | `services/task-attachment-flags.ts`，精确 `'true'`，生效处与 `isTasksEnabled` 合取 | 放进 `src/tasks/feature-flag.ts`：那个文件只管会话 feature |
| b-03 | 运行时与启动顺序 | 构造期注册路由，处理时取已启动的运行时；`start()` 里先启动附件运行时、再启动调度器；探针失败中止启动；未启动或需要 S3 ⇒ 鉴权之后 503；运行时与存储解析收注入的 `{ env, cwd?, logger? }`（缺省 `process.env`），另有只供测试的复位函数 | 照审批另起挂载点、启动后再挂路由：多一个挂载点，门 13 要置空两处 |
| b-04 | 503 的发出 | 附件路由文件自带映射，只放行 `STORAGE_UNAVAILABLE` | 改 `sendError` 放行 503：动 M2–M4 共用的 helper |
| b-05 | multer 的参数字符集 | `defParamCharset: 'utf8'` | 缺省（latin1）：中文文件名一律 422 |
| b-06 | 上传错误的状态码 | 一律 422，multer 超限与纯函数超限同为 `FILE_TOO_LARGE` | 413：同一个超限因检测位置不同而有两种状态码 |
| b-07 | 配额判定的次数 | 读请求体之前预判一次，事务里持锁再判一次为准；`COMMIT` 发出之前的失败内联删除从未有过行的 blob，`COMMIT` 结果不明时不删、交给对账 | 只在事务里判：超限的上传也先写 blob 再删 |
| b-08 | 附件写入的锁 | 任务行 `FOR NO KEY UPDATE`，先任务行、后附件行；不取 advisory 锁 | `withOrgStructure`：附件写入与全 org 的结构写串行 |
| b-09 | 带附件的评论 | M3 的 `FOR KEY SHARE` 之后再取 `FOR NO KEY UPDATE`；不带附件时 SQL 一句不变 | 改 M3 的加锁 helper：动 M3 的代码与它的说明 |
| b-10 | 评论响应体 | 不加键；对应关系从附件项的 `commentId` 读 | 加 `attachmentIds`：M3 真库格（`task-m3-comments-deletion.db.test.ts:201`）对删除评论的响应逐键相等，要改那一格 |
| b-11 | 列表的排序与信封 | `bound_at ASC, id ASC`；信封带 `canAddTaskAttachment` | 倒序；不带能力位：前端不知道能否上传 |
| b-12 | `infected` 行 | 列表与引用解析不列（M5 不写 `infected`，这一支休眠） | 列出并标状态：多一种前端状态 |
| b-13 | 下载读行不带 org | org 只由纯函数判定，暂存行那一格只有一道守卫；行的 org 与会话 org 不同时不去取所属任务，与不存在的 id 做同样多的工作 | SQL 也带 org：两道守卫，负控要两处一起删 |
| b-14 | 新纯模块 | `task-attachment-access.ts`（单一私有 org 子句，照 `[a-40]`）与 `task-attachment-views.ts` | 服务层手写条件：门 1 的单字面量变异看不到它 |
| b-15 | 64 KiB 的实现 | `index.ts` 全局解析器之前按精确路径挂解析器（受两个开关合取），路由上再挂同一个；413 `PAYLOAD_TOO_LARGE`、400 `INVALID_JSON` | 只限 id 个数：偏离 S21 的字节上限 |
| b-16 | 移除的形状 | 未绑定一条条件语句、已绑定在事务里先锁任务；200 `{ id, deleted: true }`；已删除 ⇒ 404 | 204：与其余任务路由的 200 JSON 不一致 |
| b-17 | 评论编辑 | `PATCH` 不收 `attachmentIds`（多余键照 M3 忽略） | 编辑时可增删：新的绑定与解绑语义，裁定里没有 |
| b-18 | 引用解析的模式 | 带 `taskId` 为任务模式、不带为暂存模式；过期未清扫的暂存行仍报可用 | 只做任务模式：撰写中的评论无法复核暂存项 |
| b-19 | 暂存上限 | 每上传者每 org 至多 20 个未绑定行，软上限 | 不设：只靠 168 小时清扫 |
| b-20 | 开关关时的 `attachmentIds` | 缺键或空数组照 M3；其余 422 `ATTACHMENTS_DISABLED`，先于形状校验 | 一律忽略：调用方以为附件已加上 |
| b-21 | 绑定行数不符的码 | 一个码 `ATTACHMENT_NOT_BINDABLE`，不区分原因 | 分原因：违背实例面失败不说明原因的约定（锁 §5.1） |
| b-22 | 时刻 | 任务级上传与移除锁后读一次 `clock_timestamp()`，任务级行 `created_at = bound_at`；评论路径用评论的 `created_at` | 事务时刻 `now()`：与 PR-4a §4.4 的新写入点规则不一致 |
| b-23 | 调度器的提交后作业 | 加 `afterCommitJobs` 列表选项；PR-4c 追加 | 把投递与 GC 合成一个组合作业：失败隔离要另写 |
| b-24 | GC 的数值 | 清扫 200、排空 50 / 5 次 / 5 分钟、对账 250 / 1 小时；常量 | 做成环境旋钮：每个都要进 manifest |
| b-25 | 过期判定的时钟 | tick 的库锚定时钟与任务 E 的 TTL 常量，TS / SQL 对拍 | SQL 的 `now()`：与调度器其余扫描的时钟来源不一致 |
| b-26 | `last_error` 的码 | `BLOB_DELETE_FAILED`、`MAX_ATTEMPTS_EXHAUSTED` | 记驱动的错误码：不是固定码，过不了 CHECK |
| b-27 | 通知句子 | 只含任务标题，不含文件名 | 带文件名：outbox 渲染要读附件行，通知里出现用户内容 |
| b-28 | S3 端点与路径风格 | `https:` 必需；`ALLOW_HTTP` 精确 `'true'` 才另认 `http:`；`FORCE_PATH_STYLE` 精确 `'true'` | 不认 `ALLOW_HTTP`（只认 `https:`）：与 S22 列出的变量名不符 |
| b-29 | manifest 的范围 | 只登记开关；六个 `TASK_ATTACHMENT_*` 存储变量是连接配置、不是开关，不登记。这是对 `AGENTS.md`「新增 env flag 必须登记」一条的偏离，在此记录：先例是审批线的 `APPROVAL_ATTACHMENT_S3_*` 同样没有登记；manifest 的完整性扫描只认 `TASKS_*_ENABLED`，发现不了这六个，门 18 不会因此变红 | 逐个登记：多六条非开关条目 |
| b-30 | 开关与迁移名 | purpose 写盘上的 M5 迁移名，测试按盘上文件名钉 | 不写：迁移改名后 purpose 悄悄过时 |
| b-31 | 门行键 | 门 28 提议 `M5\|28\|整门`；新表面格挂在 M5-g 子集行；附件 id 两格记在门 28，不计入 PR-4a 已承载的 `M5\|10\|P2子集` | 新开子集行：锁修订多行 |
| b-32 | 第二租户格的位置 | `tests/tasks-auth/tasks-auth-gate.ts`（信任关闭），照 PR-4a | 放进真库文件：信任开着的 harness 判别力弱 |
| b-33 | 前端如何知道开关 | 不加会话 feature；任务详情 200 而附件列表 404 即视为关 | 会话 features 加一项：改会话合同 |
| b-34 | `attachment_removed` 的入队 | 也交给 producer，由它滤掉 | 不交：写事件的调用点写法不一 |
| b-35 | `'x'` 探针 | 两个新纯模块加进任务 E 的探针表（`task-m5-probe.test.ts` 的 `TASK_E_MODULES`）；`'x'` 是合法的任务域 id，两个 builder 在 `('x', 'x')` 上返回 SQL 文本与参数，所以 `buildTaskAttachmentByIdCondition`、`buildStagedAttachmentsOfUploaderCondition` 同 PR 在 `POSITIVE_ON_X` 里各钉一项，钉到精确的输出 | 只靠门 20 |
| b-36 | 绑定模块的导入边界 | 只导入允许的集合，一格静态单测钉住 | 不钉：日后有人导入存储模块，普查才会在规则 ③ 上发现 |
| b-37 | 探针 | 写 → 读回比对 → 前缀下一次有界列举（只证明列举权限，不断言含探针键）→ 对探针键 head（证明可见）→ 删除，键在 `task-attachments/` 前缀下 | 只写与删：列举与 head 的能力到运行时才暴露；断言有界列举含探针键：前缀下对象多于一页时恒假，重启即中止 |
| b-38 | 三个码名 | 引用解析的 `taskId` 不合格 ⇒ `INVALID_TASK_ID`；已删除附件的 410 ⇒ `GONE`；存储不可用的 503 ⇒ `STORAGE_UNAVAILABLE`（422 按 §3.0 请求体 id 的规则，410 与 503 分别是 S21、S22 的取值；三个码名是本文取的） | `INVALID_IDS`（与 `ids` 不合格同码，调用方分不清是哪一项）；`ATTACHMENT_GONE`；`SERVICE_UNAVAILABLE` |

### 9.2 继承的未决项（不是本文能取的值）

- **Q-b1 评论绑定的列集（S19 × PR-4a 的 CHECK）**：PR-4a §7.2 已登记的 owner 问题。A：接受修订，绑定语句另写 `task_id`（PR-4a 现行冻结值，本文 §3.7.2 按它起草）；B：保留 S19 的列集、改 PR-4a 的 CHECK、暂存路由改为属于任务（§3.7.3）。**PR-4b 切片 3 与切片 1 的暂存上传路由在 owner 点名之前不定稿**；切片 0、2、4、5 与切片 1 的任务级上传、附件列表不受影响。
- **Q-b2 任务 E 的 X4**（只影响 PR-4b）：① 每任务 20 个的计数含评论附件（任务 E 的缺省；本文 §3.1、§3.7.2 与 b28-quota、b28-bind-quota 按它写）还是只数任务级附件；② txt / csv 的内容判定（任务 E 在 S18 只要求图片与 PDF 带签名之上的读法）。取「只数任务级」时，§3.7.2 第 3 步去掉、两格改写，接口形状不变。
- **Q-b3 移除要求 `view`**：任务 E 的 `canRemoveAttachment` 让对所属任务没有 `view` 的上传者也不能移除自己的附件，比 S20 的字面（上传者在任何绑定下都能移除）更窄；本文照任务 E 起草（b28-rm-view）。若取字面，只改这一个谓词与一格。
- **Q-b4 PR-4b 用到的 D 编号**：D1（intent 的 id 与冲突目标）、D5（上传的机制）、D6（下载的机制）、D13（通知收件人，PR-3b 已按它合入，§6.4）、D18（各配额常量）、D20（开关关时的形状与 `ATTACHMENTS_DISABLED`）都没有被点名，正文按缺省约束使用；owner 若认为它们随对应的 S 编号一并获准，需要点名。

### 9.3 新增问题

- **Q-b5 评论附件的通知条数**：S19（一个附件对应一条 `attachment_added`）与 S33（评论级也通知）合起来，一条带 k 个附件的评论让每个收件人收到 k + 1 条通知。本文照已裁取值实现。请 owner 确认这是想要的；若不是，备选是评论级的 `attachment_added` 不进通知（事件照写，只在 producer 里不通知评论绑定写出的那几条），这要改 S33 的取值。
- **Q-b6 M5-b 候选内容里的一个负控是等价变异**：候选内容里有一个负控，是把 intent 写入的冲突目标从 `storage_key` 换成 `id`，期望第二次删行那一格变红。在 D1 下四个写入者的 intent id 都是 `'tpi_' || md5(storage_key)`，同一个键的两次写入在 id 上也冲突，`ON CONFLICT (id) DO NOTHING` 一样吞掉，格不会红。本文换成「把触发器的 `ON CONFLICT` 子句整个去掉 ⇒ 硬删报 23505」（b28-rm-twice）。这改的是 S31 采纳的候选门内容，随门 28 写进锁的那次修订请 owner 一并确认。
- **Q-b7 调度器提交后作业列表的承载**：PR-3b 的调度器只有一个提交后槽位，PR-4b 的 GC 与 PR-4c 的 sweep 都要用。本文提议 PR-4b 加 `afterCommitJobs`（`[b-23]`），PR-4c 追加；4b 与 4c 互不依赖、合并先后未定，请 owner 定由哪一张承载这个选项（缺省：先合并的一张带它，另一张重建时去掉自己的副本）。

### 9.4 锁修订

门 28 写进锁 §12 `arm-set` 的方式随 PR-4a §7.3：27–32 一次写齐、自检改为 `range(1,33)`，门 28 的行在 PR-4b 之前记 NOT RUN；由哪张 PR 承载、何时提交，是 PR-4a §7.3 已向 owner 提出的问题，本文不另提。门 28 的行键提议见 `[b-31]`；它的内容以 §8.1 为准，其中 b28-rm-twice 的负控待 Q-b6。

---

## 10. 第 1 轮独立审阅的处置（2026-10-12，起草稿 v2）

第 1 轮独立审阅提出 1 条 P2 与 27 条 P3 / NIT；其中有重复（PR-4a head 的重钉两条、`:486` 的文件名三条、任务级行那一格两条），合并后 24 条。逐条对照 `origin/main` `906840c74c`、PR-4a `7f1c4c536f`、任务 E `39a2a29be9` 与锁核过后处置如下，全部采纳，没有拒绝的。自选由 37 项变为 38 项（新增 `[b-38]`；运行时的 `env` 注入并进 `[b-03]`，`[b-07]`、`[b-13]`、`[b-29]`、`[b-35]`、`[b-37]` 的缺省改写），§0 第 6 条随之改；不新增 owner 问题。附件开关 `TASKS_ATTACHMENTS_ENABLED` 本身已核为 S22 与 S30 ① 的已裁取值（2026-10-09），不转为问题。

| # | 级别 | 意见 | 处置 |
|---|---|---|---|
| 1 | P2 | 启动探针要求按前缀、按页数上限截断的列举结果里含探针键；前缀下对象多于一页后恒假，而探针失败会中止整个后端的启动 | 采纳：§5.1 改为一次有界列举只证明前缀的列举权限、对探针键 head 证明可见，从不断言截断列举里含探针键，与审批 runtime 在生产存储上的探针同形（`approval-attachment-runtime.ts:159-163`）；`[b-37]` 改写缺省与代价；§8.3 存储单测加一格：前缀下预先放入多于上限、键序在前的对象，探针照样通过，负控是改回含键断言 |
| 2 | P3 | 头部钉的 PR-4a head 已被取代 | 采纳：重钉到 `7f1c4c536f`，引 §8.4 与 §8.5，并写明两个 head 之间本文依赖的各节逐字节相同；加一句实现开工时也按当时 PR-4a 的 head 再核；§6.5 写明调度器在 `writerModules()` 之外，与 PR-4a §4.1 一致 |
| 3 | P3 | 门 28 的绑定拒绝格没有单列任务级的行 | 采纳：b28-bind-reject 加任务级那一格；§3.7.2 末段写明它有两道代码守卫加 `task_attachments_task_kind_chk`，负控是两道一起去掉 ⇒ 500 ⇒ 红，单独去掉 `bind_kind` 谓词仍是等价变异 |
| 4 | NIT | `:486` 那一格写成了别的测试文件 | 采纳：改为 `tests/unit/task-notifications.test.ts:486` |
| 5 | NIT | outbox 的 CHECK 漏了投递状态那一条 | 采纳：写成六条，没有一条涉及事件名 |
| 6 | NIT | `writeEvents` 入参放宽的条件句会让 PR-4b 改 PR-4a 改的函数 | 采纳：放宽属于 PR-4a 切片 1（它经该函数写非完成类事件），列为依赖；PR-4b 不改 `task-records.ts`；§7 末段改写 |
| 7 | NIT | 三个自取的码名没有自选条目 | 采纳：新增 `[b-38]`，§3.0、§3.4、§3.6、§3.8 处标注 |
| 8 | NIT | §8.5 没写 S31 ④ 的合并后 owner 步骤 | 采纳：§8.5 加一条，不阻合并，需 runner 输入与另行授权 |
| 9 | NIT | 静态子路径与 `/:id` 的注册顺序没写 | 采纳：§3.0 写明两条静态 `POST` 先于两条 `/:id`（锁 §10） |
| 10 | P3 | 内联删除的范围含 `COMMIT`，结果不明的提交可能删掉已落库行的 blob | 采纳：§3.1 末段改为只有 `COMMIT` 发出之前的失败才内联删除，`COMMIT` 抛错不删、交给对账；§3.2 暂存路由只在 `INSERT` 被库明确拒绝时删；`[b-07]` 改写；§8.3 加对应单测格 |
| 11 | NIT | `bigint` 与 `count(*)` 是字符串，直接交给任务 E 会抛 `TypeError` | 采纳：§2.1 加数值规则（先 `Number()`，非安全整数按内部错误），§3.1、§3.7.2 引用 |
| 12 | NIT | 下载对他 org 的行仍去取所属任务 | 采纳（建议里的可选项）：行的 org 与会话 org 不同时不取所属任务，与不存在的 id 做同样多的工作；org 判定仍只在纯函数里，`[b-13]` 改写 |
| 13 | NIT | §3.0 说 503 只在行级判定之后，暂存路由没有行级判定 | 采纳：改为排在资源面与 org 之后，有行级判定的路由还排在它之后 |
| 14 | P3 | `[b-33]` 只在自选表里，正文没有 | 采纳：§3.9 写出前端判断开关状态的规则 |
| 15 | NIT | D13 没按「D<n>，`ASSUMPTION`」写，Q-b4 漏了它；§3.8 的 D18 没标 | 采纳：两处照写，Q-b4 加 D13 |
| 16 | NIT | 评论级附件的移除写成本文选的读法 | 采纳：改为 S20 已裁取值（2026-10-09） |
| 17 | P3 | 503 格在真库 harness 里拿不到生产解析 | 采纳：§5.1 与 §7 写明运行时与存储解析收注入的 `env`，另有只供测试的复位函数；b28-503 与门 1 的门文件都经注入的 `env` 起运行时，不改进程变量；并进 `[b-03]` |
| 18 | P3 | b28-size 的负控少算一道 CHECK，期望写错 | 采纳：写成三道守卫；放宽两道代码守卫 ⇒ CHECK 拒绝 ⇒ 500 ⇒ 红；另给完全杀死的变体 |
| 19 | P3 | 七个门 28 格没有负控 | 采纳：b28-softdel、b28-rm-intent、b28-bind-ids、b28-bind-off、b28-comment-del、b28-flag-off、b28-refs-stage 各补一条；b28-rm-race、b28-type / ext、b28-bind 也各补了一条；b28-bind-off 的夹具写明直接插入暂存行；b28-403、b28-sched-off、b28-no-counts 仍是「—」（前者的守卫归门 2，后两者是带正控的零断言） |
| 20 | NIT | 引用解析的 413 / 400 先于鉴权，正文没说 | 采纳：§3.0 写明，并要求门 1、门 2 的引用解析格用 64 KiB 以内的请求体 |
| 21 | NIT | 并发格没写夹具持的是哪把锁 | 采纳：b28-quota-race 写明第三个连接持 `task_attachments` 的 `SHARE` 表锁，b28-rm-race 写明对暂存行持 `FOR UPDATE`，并让两种排队顺序各跑一格 |
| 22 | NIT | `[b-35]` 没写两个 builder 的 `POSITIVE_ON_X` 钉值 | 采纳：写明同 PR 各钉一项 |
| 23 | NIT | 规则 ③ 的概述漏了 `finally` | 采纳：§6.5 补上（`:699`）；同时写明 GC 模块因要接住单个删除失败而不得被写入文件导入 |
| 24 | NIT | `[b-29]` 应写成对 `AGENTS.md` 登记规则的显式偏离 | 采纳：改写缺省一栏，记下偏离、先例与扫描范围 |
