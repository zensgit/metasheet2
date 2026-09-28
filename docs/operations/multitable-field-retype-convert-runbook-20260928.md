# Runbook：字段类型转换（文本 → 单选 / 多选）执行与整列撤销 — 2026-09-28

**适用范围**：第 3 刀（执行 + 整列撤销）。设计锁见 `docs/development/multitable-field-retype-first-batch-adr-20260926.md`（PR #6093）。
**本文不是上线授权。** 在任何客户环境打开 `MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT` 都是「生产写入」决定，属 owner 层「先批后动」；
本文只说明批准之后按什么次序做、做完怎么核对、出了问题怎么退。全文 values-free：只写位置与计数，不写主机、口令、单元格值、选项文本。

## 1. 这次上了什么

| 面 | 内容 | 默认状态 |
|---|---|---|
| 迁移 ×3 | 放宽前镜像表 `reason` 的 CHECK；新建作业表；审批投影表 `system_kind` 窄回填 | 随 `db:migrate` 执行 |
| `POST /api/multitable/fields/:fieldId/retype-execute` | 带前镜像的转换，一个事务 | 关（flag） |
| `POST /api/multitable/fields/:fieldId/retype-undo` | 整列撤销，一个事务 | 关（flag） |
| 配置回滚（Time Machine Tier-2） | 对转换修订与撤销修订答 422，不再放行 | 恒生效 |
| UI | 无。第 4 刀才接 | — |

`PATCH /api/multitable/fields/:fieldId` 与无损白名单一行未改：`文本 → 单选 / 多选` 在那里照旧 400 `FIELD_RETYPE_NOT_LOSSLESS`。

## 2. 上线次序（锁定）

**迁移 → 开规范表栅栏 → 开本 flag。** 每一步做完先核对再做下一步；任何一步核对不过就停在那里。

### 2.1 迁移（可以先于代码切换）

三份迁移都可以在旧代码还在跑的时候执行，原因各不相同：

| 文件 | 改了什么 | 为什么先迁移是安全的 | 改写既有行 |
|---|---|---|---|
| `zzzz20260928150000_relax_field_value_tombstone_reason_for_retype_convert` | `meta_field_value_tombstones.reason` 的 CHECK 从 `{field_delete, lossy_retype}` 放宽为再加 `retype_convert` | 新集合是旧集合的超集，旧代码写的两个值仍然合法 | 否。约束先 `NOT VALID` 加上再 `VALIDATE`，不 UPDATE / DELETE 任何行 |
| `zzzz20260928150100_create_meta_field_retype_conversions` | 新建 `meta_field_retype_conversions` 与两个索引 | 旧代码不认识这张表 | 否。只新建 |
| `zzzz20260928150200_backfill_approval_projection_system_kind` | 给「`system_kind` 为空、`base_id` 是审批系统 base、且 `approval_record_projection` 有行指向它」的表补 `system_kind = 'approval_projection'` | 被补的表本来就是审批投影的系统表，旧代码对这个 kind 的处理正是它们该有的待遇 | 是，但只写这一列、只写满足三条判据的行；没有这种残留的库更新 0 行 |

迁移后核对（只读，只回计数与布尔）：

```sql
-- ① CHECK 已放宽且已校验：应恰好一行，convalidated = true
SELECT con.conname, con.convalidated
  FROM pg_constraint con
  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attname = 'reason' AND att.attnum = ANY (con.conkey)
 WHERE con.conrelid = 'meta_field_value_tombstones'::regclass AND con.contype = 'c';

-- ② 作业表存在、为空
SELECT to_regclass('meta_field_retype_conversions') IS NOT NULL AS present;
SELECT count(*) AS conversions FROM meta_field_retype_conversions;

-- ③ 回填之后不应再有残留：应为 0
SELECT count(*) AS residue
  FROM meta_sheets s
 WHERE s.system_kind IS NULL
   AND s.base_id = 'base_apr_projection'
   AND EXISTS (SELECT 1 FROM approval_record_projection p WHERE p.sheet_id = s.id);
```

### 2.2 开规范表栅栏

`MULTITABLE_ENABLE_WRITER_FENCE=true`，重启后端。这是全体记录写入者的开关，不是本功能专用；开它之前按它自己的上线要求办
（其 L6 账本迁移必须已执行，否则开了之后每个写入都会 fail-closed）。栅栏没开时，执行与撤销一律 409
`FIELD_RETYPE_TRUST_REQUIRED`（`details.reason = writer_fence_disabled`），预览不受影响。

### 2.3 开本 flag

`MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT=true`——**字节精确**，不 trim、不转小写；`TRUE`、`1`、带空格的 `true` 都等于没开。
同时确认 `MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA` **没有**开着：它开着时三个端点一律 409
`FIELD_RETYPE_TRUST_REQUIRED`（`details.reason = legacy_manage_schema_flag`）。

开 flag 前后各跑一次 flag 状态检查（`scripts/ops/multitable-global-history-flag-status.mjs`）；上面那条组合会被它报成 conflicts。

**不需要**开 `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED`：转换的前镜像是无条件写的，不看这个开关，也不改变删字段 / 删记录路径的行为。

## 3. 用法

三个端点都要：`canManageFields`（需 `multitable:manage-schema`）、表是活的、对该表有**全表读**（能读、无行级拒读、无字段遮罩、无公式遮罩）。

**执行与撤销的权限以数据库为准。** 这两个端点在事务里、取得栅栏之后，从数据库重新读一次请求者的权限与账号状态（设计锁「增补 B」）。在库里收回权限、停用账号之后，即使对方手里的登录凭证还没过期，执行与撤销也会被拒（403，零写入）。预览是只读的，仍按登录凭证里的权限作答。排查「预览能过、执行 403」时先查库里的授权，不要先怀疑凭证。

```
POST /api/multitable/fields/:fieldId/retype-preview   { "targetType": "select" | "multiSelect" }
POST /api/multitable/fields/:fieldId/retype-execute   { "previewToken": "<预览返回的凭证>", "confirm": "convert-field-type" }
POST /api/multitable/fields/:fieldId/retype-undo      { "convertRevisionId": "<执行返回的 id>", "confirm": "undo-field-type-convert" }
```

- 凭证有效期 10 分钟，只对签发给的那个人、那一列有效。预览之后表里任何一格、任何一行（含回收站）变了，执行答 409 `PLAN_DRIFT`，重新预览即可。
- 执行返回 `convertRevisionId`。**把它记下来**——整列撤销只认这个 id。它同时是三样东西的锚：配置修订的 id、前镜像的
  `config_revision_id`、记录修订的 `batch_id`。
- 请求体不接受别的键。没有 `force`、没有部分撤销、没有撤销的撤销。

### 3.1 响应码

| 状态 | code | 含义 | 处理 |
|---|---|---|---|
| 403 | `FIELD_RETYPE_CONVERT_DISABLED` | 本 flag 没开 | §2.3 |
| 409 | `FIELD_RETYPE_TRUST_REQUIRED` | `legacy_manage_schema_flag` 或 `writer_fence_disabled` | §2.2 / §2.3 |
| 403 | `FORBIDDEN` / `FULL_TABLE_READ_REQUIRED` | 无改结构权 / 无全表读 | 换有权的人，或解除该表上对他的遮罩 |
| 404 | `NOT_FOUND` / `SHEET_DELETED` | 字段不存在 / 表已删；撤销时也表示「没有这次转换」（含拿别的表、别的列的 id 来） | 核对 id |
| 422 | `FIELD_RETYPE_CONVERT_NOT_SUPPORTED` | 不在首批范围，或表被插件 / 系统 / 管线 / 审批投影托管（`details.reason`） | 首批不做 |
| 400 | `CONFIRM_REQUIRED` / `VALIDATION_ERROR` | 确认串不对 / 请求体不对 | 改请求 |
| 401 | `PREVIEW_IDENTITY_INVALID` | 凭证无效；`details.reason = expired` 表示过期 | 重新预览 |
| 409 | `PLAN_DRIFT` | 预览之后表变了 | 重新预览 |
| 409 | `RECOVERY_IN_PROGRESS` | 这张表正被恢复 / 归档占用 | 等它结束再试 |
| 409 | `CONFLICT` | 数据库锁冲突 | 稍后重试 |
| 413 | `SHEET_TOO_LARGE` | live 行 + 本表回收站行超过记录上限（默认 5000） | 首批不做；不截断 |
| 422 | `TOMBSTONE_CAPTURE_CAP_EXCEEDED` | live 行数超过前镜像上限 | 同上 |
| 409 | `ALREADY_UNDONE` | 这次转换已经撤销过 | — |
| 409 | `PRE_IMAGE_EXPIRED` | 前镜像已被保留期清理删掉 | 不可撤销，见 §5 |
| 409 | `UNDO_PRECONDITION_FAILED` | 转换之后这一列或这张表变了（`details.reason`，见下） | 见下 |

`UNDO_PRECONDITION_FAILED` 的四个原因，按判定顺序：

| `details.reason` | 含义 | 怎么恢复撤销能力 |
|---|---|---|
| `field_config_changed` | 字段的类型或 property（含选项、选项颜色）在转换后被改过 | 把字段配置改回转换刚结束时的样子 |
| `record_set_changed` | 转换后新增或删除了记录（`details.added` / `details.removed` 列全 id） | 删掉新增的、恢复被删的 |
| `trashed_rows_with_post_state` | 回收站里有一行在这一列上带着「转换后的形状」（多选目标下的数组等） | 把那几行从回收站彻底清掉 |
| `cells_changed` | 这一列有格子在转换后被改过（`details.recordIds` 列全 id） | 把那几格改回转换写进去的值 |

以上每一种拒绝都是**零写入**：事务里只有锁与读。

## 4. 转换后要告诉使用者的事

- 往这一列写「不在选项里的文字」会被拒（REST、批量写、表单、插件 SDK 今天就拒）。
- **改这一列任何一格之后，整列撤销就不可用了**（改别的列不影响）。要撤销就先撤销、再编辑。
- 公式物化值、视图的筛选 / 排序 / 分组、实时推送**不会**跟着迁移——与 `PATCH` 改类型同口径。
- 转换不触发自动化的 `record.updated`。
- 带首尾空白、纯空白、或非文本值的格子会让预览整次拒绝并列出全部记录 id；先清洗再转换。
- 预览的拒绝原因里出现 `record_data_not_object`，表示列出的记录（或回收站行）整行数据不是 JSON 对象——这是损坏的行，不是格子的问题。不要手工改库去「修」它；把记录 id 交给技术负责人，由其判断来源后处理。

## 5. 撤销窗口与保留期

前镜像与其它 tombstone 走同一套保留期（`MULTITABLE_META_REVISION_RETENTION_ENABLED=1` 才清理；窗口
`MULTITABLE_META_REVISION_RETENTION_DAYS`，默认 365、下限 30）。

- **保留期没开**：前镜像不会被清，撤销一直可用（只要 §3.1 的前置条件成立）。
- **保留期开着**：转换之日起 `retentionDays` 天内可撤销；过期后整组前镜像被删，撤销答 409 `PRE_IMAGE_EXPIRED`，
  **不会**部分恢复。作业行不参与清理，所以过期后答的是「过期」而不是「不存在」。

查某一列有哪些转换、还剩多少前镜像（只回 id、时间与计数）：

```sql
SELECT c.convert_revision_id, c.created_at, c.undone_at IS NOT NULL AS undone, c.record_count,
       (SELECT count(*) FROM meta_field_value_tombstones t
         WHERE t.config_revision_id = c.convert_revision_id AND t.reason = 'retype_convert') AS pre_image_rows
  FROM meta_field_retype_conversions c
 WHERE c.sheet_id = :sheet_id AND c.field_id = :field_id
 ORDER BY c.created_at DESC;
```

`pre_image_rows = record_count` ⇒ 前镜像完整；`0`（而 `record_count > 0`）⇒ 已过期。

`meta_field_value_tombstones` 里 `reason = 'retype_convert'` 的行，`value` 是信封
`{"k": 原来有没有这个键, "v": 原值, "post": 转换写入的值}`，**不是**单元格值。任何读这张表的归档 / 导出 / 排障脚本都要按信封解读。

## 6. 回退

按代价从小到大，能用前一条就不用后一条。

1. **关 flag**（`MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT` 置空，重启）。三个端点立刻全部 403，零读库。已经做过的转换不受影响，
   它们的数据完好；只是 flag 关着的时候撤销也不可用——要撤销，先开回来。
2. **撤销某次转换**：`retype-undo`。这是把一列数据改回去的唯一受支持途径。**不要**用 Time Machine 的配置回滚去回滚转换修订
   （它会答 422），**不要**手工 `UPDATE meta_fields` 把类型改回文本——那样单元格仍是选项形状，整列撤销从此过不了字段比对，
   前镜像取不回。
3. **回滚代码**到上一个版本。三份迁移可以留在库里：CHECK 是超集、作业表旧代码不读、回填的 kind 旧代码照常认。
   **注意**：旧代码没有 §1 那条 Tier-2 拒绝。如果库里已经有转换（`meta_field_retype_conversions` 非空），回滚代码之前先把
   `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT` 关掉（或确认它本来就关着），否则配置回滚会重新放行转换修订。
4. **回滚 schema**（`down`），只在确有必要时做，且有前提：
   - 作业表的 `down` 在表里**有任何一行**时拒绝执行（抛错、什么都不删）。
   - CHECK 的 `down` 在还有 `reason = 'retype_convert'` 的前镜像时拒绝执行。
   - 这两条拒绝是故意的：删了作业行，整列撤销不可达；收紧了约束，库里却还留着新值的行。要回滚 schema，先把每一次转换
     撤销掉、确认 `meta_field_retype_conversions` 里每一行都有 `undone_at`，再由 owner 决定是否清空这两处——那是删除历史数据的决定，
     不在本 runbook 的授权范围内。
   - 回填的 `down` 是空操作：被回填的表与一开始就带 kind 建出来的投影表无法区分，按条件改回 NULL 会连带清掉后者。
     确需还原个别表，逐表执行 `UPDATE meta_sheets SET system_kind = NULL WHERE id = :sheet_id`，并接受该表随即失去系统表的保护
     （可被删除、进入用户历史连续性检查）；字段类型转换对它仍然拒绝（判定 (e) 不依赖 kind）。

## 7. 已知边界

- **并发写入者的栅栏后复核不在这一刀**。ADR §3.11 的助手 `assertFieldSchemaUnchangedAfterFence` 与 §3.12 的自动化选项校验在
  A 线（分支 `feat/multitable-retype-fenced-writer-recheck`）。A 线合入之前，一个在转换持栅栏期间排队的写入者仍可能按旧类型把
  纯文本写进已转换的列；该格之后会让整列撤销答 `cells_changed`。**A 线未合入、真库十三条未全绿之前，不要在客户环境开本 flag。**
- 首批只做 `文本 → 单选`、`文本 → 多选`；源只限 `string`，不含长文本。
- 托管表整表排除（插件登记表、系统表、带插件命名空间的字段所在表、管线 staging 表、审批投影表）。
- 记录上限与选项上限各 5000，超限整次拒绝，不截断。

## 8. 证据面

提交到 issue / PR 的证据只含：端点、状态码、错误码、`details.reason`、计数、记录 id、修订 id。不贴单元格值、选项文本、
字段 property、前镜像信封内容、主机与凭据。
