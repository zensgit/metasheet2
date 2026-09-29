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
| 全体记录写入者的栅栏后复核（第 3 刀 a） | 写入在等锁期间，它要写的列被转换了 ⇒ 拒绝，零写入（§3.2） | 关（**两个**开关同时开才启用） |
| 自动化「修改记录 / 新建记录」的选项校验（第 3 刀 a） | 往单选 / 多选列写不合选项的值 ⇒ 该步失败（§2.4） | 关（同上） |
| 实时协同 | 被上面那条复核拒掉的实时编辑，会让该记录的协同文档失效并通知编辑者（§3.2） | 关（同上） |
| UI | 只有一句提示语（写入被拒时）。转换 / 撤销的界面第 4 刀才接 | — |

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

**本 flag 与栅栏同时开着时，改变的不只是三个端点。** 全体记录写入者多了一次栅栏后的字段复核，自动化的两个写动作多了选项校验
（设计锁「增补 C」C1、Decision Register R-22）。任一开关关着，这两样都不执行，各写入者的行为与今天完全相同。所以开本 flag 之前
必须先做 §2.4。

**每个后端进程必须带相同的两个开关值。** 门读的是进程自己的环境变量。凡是会写记录的进程都算：API 进程、单独起的自动化 /
调度 worker、实时协同所在的进程。少带一个的进程不会复核——别的进程做转换时，它那边排队的写入会照转换前的类型写进去。做法：

1. 两个开关写进**同一份**环境配置，所有后端进程从这一份读；不要只改某一个进程的启动参数。
2. 改完**全部**重启，不要滚动到一半停下。
3. 重启后逐进程核对（只回布尔，不回值）：每个进程的环境里 `MULTITABLE_ENABLE_WRITER_FENCE` 与
   `MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT` 是否都生效。有一个进程对不上，就把本 flag 关回去再查。

### 2.4 开 flag 之前：数一遍会受影响的自动化规则

两个开关都开之后，自动化的「修改记录」「新建记录」往**任何**单选 / 多选列（不只是转换过的列）写下列值时，由「值落库」变成
「该步失败」：

| 目标列 | 规则里配的值 | 失败原因 |
|---|---|---|
| 单选 | 不在选项里的文字 | `select_value_not_in_options` |
| 单选 | 不是文字——数字、布尔、**空值 `null`**（用写 `null` 来「清空」单选的规则属于这一类） | `select_value_not_string` |
| 多选 | 不是数组；数组里有不在选项里的项；数组里有对象 / 布尔 | `multiselect_value_invalid` |

不受影响：单选写空字符串；多选写 `null`、空字符串、空数组；多选项首尾带空格或重复（写入时自动去空格、去重）。

下面的查询只读，只回规则 id、动作类型、目标表 id、字段 id、字段类型与原因，**不回规则里配的值**。嵌在分支动作里的写动作也会被数到。

```sql
WITH rule_actions AS (
  SELECT r.id AS rule_id, r.sheet_id AS rule_sheet_id, r.enabled,
         CASE WHEN jsonb_typeof(r.actions) = 'array' AND jsonb_array_length(r.actions) > 0
              THEN r.actions
              ELSE jsonb_build_array(jsonb_build_object('type', r.action_type, 'config', COALESCE(r.action_config, '{}'::jsonb)))
         END AS doc
    FROM automation_rules r
), writes AS (
  SELECT ra.rule_id, ra.enabled, a.node ->> 'type' AS action_type,
         CASE a.node ->> 'type'
           WHEN 'update_record' THEN COALESCE(NULLIF(a.node #>> '{config,targetSheetId}', ''), ra.rule_sheet_id)
           ELSE COALESCE(NULLIF(a.node #>> '{config,sheetId}', ''), ra.rule_sheet_id)
         END AS target_sheet_id,
         CASE a.node ->> 'type'
           WHEN 'update_record' THEN a.node #> '{config,fields}'
           ELSE a.node #> '{config,data}'
         END AS written
    FROM rule_actions ra
   CROSS JOIN LATERAL jsonb_path_query(ra.doc, 'strict $.** ? (@.type == "update_record" || @.type == "create_record")') AS a(node)
), cells AS (
  SELECT w.rule_id, w.enabled, w.action_type, w.target_sheet_id, kv.key AS field_id, kv.value AS v
    FROM writes w
   CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(w.written) = 'object' THEN w.written ELSE '{}'::jsonb END) AS kv
), targets AS (
  SELECT c.*, CASE WHEN lower(btrim(f.type)) = 'select' THEN 'select' ELSE 'multiSelect' END AS field_type,
         ARRAY(SELECT COALESCE(o.value ->> 'value', o.value #>> '{}')
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.property -> 'options') = 'array' THEN f.property -> 'options' ELSE '[]'::jsonb END) AS o(value)) AS options
    FROM cells c
    JOIN meta_fields f ON f.id = c.field_id AND f.sheet_id = c.target_sheet_id
   WHERE lower(btrim(f.type)) IN ('select', 'multiselect', 'multi_select', 'multi-select')
), judged AS (
  SELECT t.rule_id, t.enabled, t.action_type, t.target_sheet_id, t.field_id, t.field_type,
         CASE
           WHEN t.field_type = 'select' AND jsonb_typeof(t.v) <> 'string' THEN 'select_value_not_string'
           WHEN t.field_type = 'select' AND (t.v #>> '{}') = '' THEN 'ok'
           WHEN t.field_type = 'select' AND (t.v #>> '{}') = ANY (t.options) THEN 'ok'
           WHEN t.field_type = 'select' THEN 'select_value_not_in_options'
           WHEN jsonb_typeof(t.v) = 'null' OR t.v = '""'::jsonb THEN 'ok'
           WHEN jsonb_typeof(t.v) <> 'array' THEN 'multiselect_value_invalid'
           WHEN EXISTS (
             SELECT 1 FROM jsonb_array_elements(t.v) AS e(item)
              WHERE jsonb_typeof(e.item) NOT IN ('string', 'number')
                 OR (btrim(e.item #>> '{}') <> '' AND NOT (btrim(e.item #>> '{}') = ANY (t.options)))
           ) THEN 'multiselect_value_invalid'
           ELSE 'ok'
         END AS verdict
    FROM targets t
)
SELECT rule_id, enabled, action_type, target_sheet_id, field_id, field_type, verdict
  FROM judged
 WHERE verdict <> 'ok'
 ORDER BY enabled DESC, rule_id, action_type, field_id;
```

- 结果为空 ⇒ 没有规则会因为开关而改变结局。
- 结果非空 ⇒ **先不要开 flag**。把规则 id 交给规则的负责人：改规则里配的值，或给那一列补选项。`enabled = false` 的规则此刻不跑，
  但重新启用后同样会失败，一并处理。
- 这条查询按**此刻**的选项判断。开 flag 之后有人删掉一个选项，原本合格的规则也会开始失败——那是选项列今天对其它写入途径
  就有的行为。
- 查询不覆盖审批结果回写与审批表单回写：它们今天就有自己的类型与选项检查，不因本 flag 改变。

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

### 3.2 转换进行时，别的写入者会看到什么

转换或撤销持着这张表的栅栏改写整列的那一小段时间里，同一张表上的其它写入会排队。转换提交之后它们醒来，发现自己要写的列
已经换了类型，于是**拒绝、零写入**：

| 写入途径 | 看到的结果 |
|---|---|
| 表格 / 记录抽屉里的编辑、批量写、表单提交、OpenAPI 写入 | 409 `FIELD_SCHEMA_CHANGED`。界面提示「这一列刚刚被改成了别的类型，你这次的修改没有保存。请刷新页面后重新修改。」 |
| 插件经 SDK 写入 | 抛出带同一错误码的错误，由插件决定怎么告诉它的使用者 |
| 自动化「修改记录 / 新建记录」 | 该步失败，执行日志里是同一句英文消息 |
| 审批结果回写 | 回写被跳过：运行记录里「发起审批」那一步的输出带 `backwriteSkipped`（同一句英文消息）。审批本身的结果不受影响 |
| AI 批量填充的写入 | 那一行记为「预览后已变更——未写入」，重新运行填充即可 |
| 实时协同里正在输入的编辑 | 该记录的协同文档失效，编辑者退回普通编辑，看到的是已保存的值；那次输入没有保存 |
| 公式 / 引用 / 汇总值的物化 | 只在一种情形下相关：一列**原本是公式**、被改成文本、再被转换。排队中的那次物化被跳过，算出来的值不会写进已经不是公式的列 |

**转换提交的那一刻，这张表上所有打开着的协同文档都会失效**（不只是被改写的行）：整列换了类型，打开着的文档里那一格还是旧
类型的样子。编辑者会退回普通编辑，重新打开记录即可继续协同。转换前请告知正在这张表上协同编辑的人。

这些只在两个开关同时开着时发生。排查「写入莫名其妙 409」时，先查这张表最近有没有转换或撤销（§5 的查询）。

## 4. 转换后要告诉使用者的事

- 往这一列写「不在选项里的文字」会被拒（REST、批量写、表单、插件 SDK 今天就拒；自动化的「修改记录 / 新建记录」在两个开关
  同时开着时也拒——§2.4）。
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

1. **关 flag**（`MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT` 置空，**所有**后端进程一起重启）。三个端点立刻全部 403，零读库。
   已经做过的转换不受影响，它们的数据完好；只是 flag 关着的时候撤销也不可用——要撤销，先开回来。
   同时停掉的还有写入者的栅栏后复核与自动化选项校验：自动化规则恢复到开 flag 之前的行为，**包括把选项外的值写进选项列**。
   如果关 flag 是因为某条自动化规则开始失败，关之前先按 §2.4 把那条规则改好，否则它会在 flag 关着的期间继续写入不合格的值。
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

- **并发写入者的栅栏后复核已随第 3 刀 a 合入**，真库十三条在本刀全部真跑（⑦ 九个写入者形状各自对真实的执行与撤销）。
  它只在两个开关同时开着、且**每个**写记录的进程都带着这两个开关时才成立（§2.3）。
- **实时协同里别的拒绝仍然不通知编辑者**：输入了选项外的文字、没有权限、记录被锁——这些编辑在协同文档里看得见，却没有保存，
  也没有提示。这是本功能之前就有的行为，不因本 flag 改变；转换之后，一张没有重新打开的旧文档更容易碰到第一种。
- **结构守卫有已知盲区**（设计锁「增补 C」C2）：它看不见的新增写入路径，仍要靠评审去读。
- 首批只做 `文本 → 单选`、`文本 → 多选`；源只限 `string`，不含长文本。
- 托管表整表排除（插件登记表、系统表、带插件命名空间的字段所在表、管线 staging 表、审批投影表）。
- 记录上限与选项上限各 5000，超限整次拒绝，不截断。

## 8. 证据面

提交到 issue / PR 的证据只含：端点、状态码、错误码、`details.reason`、计数、记录 id、修订 id。不贴单元格值、选项文本、
字段 property、前镜像信封内容、主机与凭据。
