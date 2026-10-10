# 任务功能 M5 后端 PR-4a 设计：表结构与接口冻结（DRAFT，2026-10-10）

> **状态：DRAFT（冻结稿 v2：第 1 轮独立审阅的处置见 §8.1）。** owner 2026-10-10 裁定：现在开始 M5，先冻结 PR-4a 的表结构与接口，再在其上并行起草 PR-4b、PR-4c 与前端；只开 Draft，不合并、不应用 DDL。本文就是这份冻结：§2 的 DDL 与 §3 的接口一经独立审阅通过，PR-4b / 4c / FE-d / FE-e 以它为准起草；要改形状，先改本文再改实现。本文不授权合并、DDL 应用、staging 部署或打开任何 `TASKS_*` 开关。

- **基线**：`origin/main` `98cbca16ec`（2026-10-10）。M4 的 PR-3a（#6266）与锁 R01 增补（#6248）已在 main；PR-3c（#6269）与 M4 前端（#6265）在合并列车上，尚未进 main。本文的代码行号都指这个 SHA，实现开工时按当时 main 重核。
- **基线漂移（审阅后补记）**：PR-3b（#6281）在基线之后合入 main（`d2c33b8426`；本次修订时 `origin/main` = `9bbbdb29e3`）。在那个 ref 上 `writeEvents` 返回 `WrittenTaskEvent[]`，每个写事件的调用点同事务调用 `enqueueTaskEventNotifications`；翻转点的行号随之移动（`completeTask` `:647`；`removeAssignee` 翻转 `:374`；`switchCompletionMode` 翻转 `:436`；`addAssignee` 翻转 `:349`）。本文其余行号仍指 `98cbca16ec`；PR-4a 分支起草时从当时 main 起，不需要另等 PR-3b。
- **依赖**：任务 E 的纯函数层（#6249，Draft，head `39a2a29be9`）。PR-4a 的服务层直接调用其中的 `task-recurrence` / `task-dependencies` / `task-milestone` / `task-fields` / `task-civil-date`，所以 PR-4a 堆叠在 #6249 之上起草，合并顺序是 #6249 在前（§1.3）。附件与投影两个纯模块由 PR-4b / 4c 调用，PR-4a 只按它们的类型定表（§2.10）。
- **锁**：`docs/development/task-feature-design-lock-20260917.md`（main 版）。§4.2 的 P2 表名、§4.1 的两类非空约束、§6.4 的锁协议、§7 的投影边界、§11 的 M5 行、§12 `arm-set` 里的五条 `M5|` 行都按锁执行。
- **裁定的引用口径**：只写条目编号与日期。M5 裁决包的 S01–S37 于 owner 2026-10-09 裁定取推荐值（含 S32 第二句：PR-4a / 4b / 4c 按 4a → {4b, 4c} 的顺序起 Draft）；同日 owner 裁定的六项里，第 3 项（锁 §2 承重两项的归属）与第 6 项（M5 的起草方式）直接约束本文；M4 裁决包的 R01–R23、N1、N2 于 owner 2026-10-07 裁定。裁决包的 E 编号是它列出的「锁已定」条目，D 编号是闸方给的缺省实现约束——**D 编号没有被任何一次裁定点名**，本文用到时一律标 `ASSUMPTION`。裁决包是私有件，本文不引其原文。
- **标签**：已裁条目在代码里标 `RULED(<日期>): [Sxx]` / `[Rxx]`；本文自选的取舍标 `ASSUMPTION(task-m5a): [a-NN]`，每一条在 §7 有缺省值、备选与 owner 问题编号。

---

## 0. 结论摘要

1. **第一片是 G1「创建人为所有负责人完成」**（owner 2026-10-09 六项之第 3 项：放在 PR-4a 的第一片，先于重复任务的派生）。它不需要 DDL：`POST /api/tasks/:id/complete` 新增可选 `scope: 'all'`，只对任务创建人（`tasks.created_by`，直接角色）开放；任务已完成时重复调用是空操作、不写事件（§3.1、§5）。
2. **一个迁移装下 M5 的全部 DDL**：`tasks` 加 4 列，新建 7 张表（依赖、字段三表、附件两表、投影映射）与附件行删除触发器（§2）。附件两表与触发器随 PR-4a 是 S30 ③ 的已裁取值；投影映射表也放进来是 D1 的缺省（`ASSUMPTION`，§7 [a-06]），这样 PR-4b、PR-4c 都不带 DDL，可以在冻结后并行起草。
3. **接口**：PR-4a 新增 16 条路由（重复 1、里程碑 1、依赖 5、字段定义 4、字段绑定 4、字段值 1），改动 4 条既有路由的形状（complete 的请求体、详情、列表项、删除），全部挂在 `TASKS_ENABLED` 的同一个 `tasksRouter()` 上，**不新增任何 `TASKS_*` 读点、不新增开关**（§3）。
4. **锁**：所有写走 `withOrgStructure`；S09 已裁的锁序包装器 `withTaskLockOrder` 在 PR-4a 落地并首次武装 `M5|7|锁序控件`，不新增第四处取锁字面量（§4.2）。
5. **门**：PR-4a 承载既有 `M5|7|锁序控件` 与 `M5|10|P2子集` 中属于它的格，以及候选门 27（重复）、29（依赖）、30（字段）和 G1 的候选子集行；候选行要等锁修订写进 `arm-set` 才计分（§6）。
6. **仍待 owner 的**：本文自选 33 项（§7.1）；任务 E 的三个问题与四项偏离里影响 PR-4a 的部分（§7.2）；候选门行入锁的那次修订（§7.3）。

---

## 1. 范围与切片

### 1.1 做

1. G1：创建人为所有负责人完成（无 DDL，§3.1、§5）。
2. 一条迁移：`tasks` 的 P2 列与 7 张 P2 表、触发器、索引（§2）。
3. 重复任务：设 / 清规则、完成翻转时派生下一期、系列删除（S14–S17、S35）。
4. 里程碑开关（S13）。
5. 依赖：加边、删边、列出、候选（S11、S12）。
6. 自定义字段：定义、清单绑定、任务取值三层（S24–S28）。
7. 既有响应的增补：详情（里程碑、重复、系列链、依赖、字段值、`canCompleteForAll`）、列表项（`is_milestone`）、删除（系列删除时列出删了哪些）。
8. `TASK_ID_PREFIXES` 加 `field: 'tfld'` 与 `attachment: 'tatt'`（S30 ②；任务 E 的 `task-projection.ts` 里暂时写死的 `tfld_` 改为从这里派生）。
9. 锁序包装器与它的门格（S09）。

### 1.2 不做（归属）

- 附件的存储、上传、下载、移除、评论绑定、GC、`attachment_added` 通知（PR-4b；表已在本迁移）。
- 投影的 provisioning、reconcile、夹钳、deny sibling、sweep、导出（PR-4c；映射表已在本迁移）。
- 前端 FE-d / FE-e / FE-f。
- 富文本（S29：M5 不做，`description_rich` 不建）；cursor 分页（S34）；依赖阻断完成（S12：不阻断）；任务域 DML 普查闸（S37：不建，PR 正文如实声明）。
- 任务内历史与跨任务动态（owner 2026-10-09 六项之第 5 项：M5 之后单独补齐 / 继续后置）。本文新写的事件 payload 都不含任何清单 id 以外的业务值，供那次交付校验可见性（§4.4）。
- 状态筛选核心（同日第 3 项的后半：M4 之后单独交付、先于 FE-e），不在 PR-4a。

### 1.3 切片顺序（依赖）

开工前提：分支从当时的 `origin/main` 起，叠上 #6249。PR-3b 已在 main（见头部的基线漂移）；PR-4a 不用 `TaskScheduler`（§4.6），但每个新写事件的调用点都照 PR-3b 的写法同事务入队（§4.4）。

| 切片 | 内容 | 依赖 | 回归 |
|---|---|---|---|
| **1** | G1：`applyCompleteForAll` 与 `canCompleteForAll` 两个纯函数（`src/tasks/`），`TaskCompletionEvent` 加可选 `payload`、`writeEvents` 写入它（缺省 `{}`，`task_events.payload` 列已存在，不碰 DDL；保留 PR-3b 的 `WrittenTaskEvent[]` 返回形状），`completeTask` 收 `scope`，路由解析 `scope`，详情加 `canCompleteForAll`；真库文件 `task-m5-g1.db.test.ts` | 无（不碰 DDL） | `M2\|3`、`M3\|3` 重跑 |
| 2 | 迁移（§2）、`TASK_ID_PREFIXES` 两个前缀、锁序包装器、形状格 `task-m5-schema.db.test.ts` | 1 | 全部 `M2\|`、`M3\|`、`M4\|` 的形状格 |
| 3 | 重复：`PUT /recurrence`、三处翻转调用点的派生钩子（含切片 1 的 G1 路径）、系列删除、详情的系列字段 | 2 | `M2\|3`、`M3\|3`、`M3\|6` |
| 4 | 里程碑与依赖（含 `M5\|7\|锁序控件` 首次武装） | 2 | `M3` 设父格（同用结构锁） |
| 5 | 字段三层、详情 `fieldValues` | 2 | `M4\|19\|清单角色` |
| 6 | 收口：鉴权门子集（门 1 / 2 / 13 / 17 / 20）、真库三处登记、PR 正文 | 3、4、5 | 全部 `M2\|`、`M3\|`、`M4\|` 行 |

G1 是第一片且独立于迁移，是有意的：它只改完成路径，先落地、先过门，派生钩子（切片 3）挂到它已经稳定的翻转写入点上。

---

## 2. 表与迁移（冻结）

### 2.1 文件与共性

- 文件名：`zzzz20261011090000_create_task_m5_tables.ts`。它必须排在 main 当时最晚的迁移之后（今天最晚的是 `zzzz20261010124500_seed_stock_prep_role_templates.ts`），合并前按 PR-3a §2.1 的规则重核，必要时改名（`ASSUMPTION(task-m5a): [a-23]`）。
- 头注写明 `Draft migration: do not apply from this PR`；`down()` 逆序镜像 `up()`。
- 一个文件装下全部 M5 DDL（D1 缺省，`[a-06]`）：staging 的排除机制只能证明「表不存在」，列与索引随建表一起走（与 PR-3a 的 `[own-22]` 同理）。
- 任务域生成 id 列（`tfld_`、`tatt_`、`tpi_`，以及 `tasks` 的两个系列列）用锁 §4.1 的四合取 CHECK；`org_id` 与人员列只用单合取可打印 CHECK；人员列是 text，不建到 `users` 的外键。
- 同 org 用组合外键保证（PR-3a 的 `[own-37]` 写法）：凡同时指向任务、清单或字段的行都带 `org_id`，经 `(id, org_id)` 组合外键引用对方。`tasks` 与 `task_lists` 的 `(id, org_id)` 唯一约束已在 M4 迁移里；本迁移给 `task_fields` 建同样的约束。
- CHECK 里调用的函数一律写成 `pg_catalog.<名>`（`pg_catalog.btrim`、`pg_catalog.jsonb_typeof`），触发器函数体里的 `md5` 同样写 `pg_catalog.md5`，在 pg_restore 的空 `search_path` 下也能解析。
- 不写任何行、不碰 `permissions`；没有数据库硬限额（S28，常量软限额在纯函数里）。
- 触发器与它调用的函数都起任务域自己的新名字，不 `CREATE OR REPLACE` 任何已有函数。
- 每条 CHECK、外键与唯一约束都写 `CONSTRAINT <名>`，名字照 M2–M4 迁移的写法（`<表>_<含义>_chk` / `_fk` / `_key`，主键 `<表>_pkey`）；下文逐条列出，形状格与 `down()` 都按名引用，实现不得另起名字。

### 2.2 `tasks` 新增列

| 列 | 类型 | 约束（名） | 出处 |
|---|---|---|---|
| `is_milestone` | `boolean NOT NULL DEFAULT false` | — | S13 |
| `recurrence` | `jsonb` | `tasks_recurrence_object_chk`：`CHECK (recurrence IS NULL OR pg_catalog.jsonb_typeof(recurrence) = 'object')`；闭集由 `parseRecurrenceRule` 保证，库只验是对象 | S14；D2 `[a-06]` |
| `recurrence_series_id` | `text` | `tasks_recurrence_series_id_generated_chk`（四合取）；`tasks_recurrence_series_fk`：组合外键 `(recurrence_series_id, org_id) → tasks (id, org_id)`，不级联；`tasks_recurrence_series_not_self_chk`：`CHECK (recurrence_series_id <> id)` | S16 |
| `previous_occurrence_id` | `text` | `tasks_previous_occurrence_id_generated_chk`（四合取）；`tasks_previous_occurrence_fk`：组合外键 `(previous_occurrence_id, org_id) → tasks (id, org_id)`，不级联；`tasks_previous_occurrence_not_self_chk`：`CHECK (previous_occurrence_id <> id)` | S16、S17 |

另加一条约束与两个索引（`[a-20]`）：

- `tasks_series_columns_paired_chk`：`CHECK ((recurrence_series_id IS NULL) = (previous_occurrence_id IS NULL))`：系列第一期两列都空；派生出来的每一期两列都有值（`seriesId` = 第一期 id，`previousOccurrenceId` = 上一期 id，与任务 E `planSpawn` 的输出一致）。`tasks_recurrence_series_not_self_chk` 再保证一个系列只有一个第一期：自称第一期的行两列必须都空。
- 部分唯一索引 `uq_tsk_previous_occurrence ON tasks (previous_occurrence_id) WHERE previous_occurrence_id IS NOT NULL`：一期至多有一个后继。它是「重复完成不会派生两次」在库里的最后一道保证（第一道是 §3.2 的事件存在性检查）。
- 部分索引 `idx_tsk_recurrence_series ON tasks (recurrence_series_id) WHERE recurrence_series_id IS NOT NULL`（D2 缺省里的那个索引）。系列读都按这一列取同系列的各期，而且要含已软删的期：§2.10 的序号计数、§3.8 系列删除的成员装载。`tasks` 上既有的按 org 的索引都带 `deleted_at IS NULL` 的部分谓词，用不上；没有这个索引，这两种读就是在 org 结构锁内对整张多 org 表顺序扫描。

外键不级联、也不置空：任务只有软删（R13），没有硬删路径；置空单列的组合外键语法要 PostgreSQL 15，而 `plugin-tests` 仍跑 14。两条系列外键是 `NO ACTION`，所以以后的保留期作业（§2.8）若硬删任务，必须整条链一起删——同一条语句删掉整条链，或从链上最晚的一期往前逐期删；否则较早一期会被它后继的外键挡住。到那时也可以重新评估这两条外键的动作。

### 2.3 `task_dependencies`

```
predecessor_id text NOT NULL, successor_id text NOT NULL, org_id text NOT NULL,
created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT task_dependencies_pkey PRIMARY KEY (predecessor_id, successor_id),
CONSTRAINT task_dependencies_not_self_chk CHECK (predecessor_id <> successor_id),
CONSTRAINT task_dependencies_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
CONSTRAINT task_dependencies_created_by_printable_chk CHECK (created_by ~ '^[!-~]+$'),
CONSTRAINT task_dependencies_predecessor_fk FOREIGN KEY (predecessor_id, org_id) REFERENCES tasks (id, org_id) ON DELETE CASCADE,
CONSTRAINT task_dependencies_successor_fk   FOREIGN KEY (successor_id, org_id)   REFERENCES tasks (id, org_id) ON DELETE CASCADE
```

- 只有一种关系，没有 `type` / `lag` 列（S12）；自环由 CHECK 拒绝，成环由纯函数在结构锁内拒绝（S12、D4）。
- 软删任务的边留在表里，读取时按两端 `tasks.deleted_at IS NULL` 过滤；软删不写 `dependency_removed`（D17，`ASSUMPTION`，与任务 E 的输入合同一致）。
- 索引：`idx_tdep_successor (successor_id)`（主键已覆盖按前置查）；`idx_tdep_org (org_id)`：§3.4 加边时在结构锁内读出本 org 的全部边、候选读也要同一张图，这两处按 org 取边，不能落到全表扫描。

### 2.4 `task_fields`

```
id text PRIMARY KEY, org_id text NOT NULL, type text NOT NULL, name text NOT NULL,
config jsonb NOT NULL DEFAULT '{}'::jsonb, created_by text NOT NULL,
created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT task_fields_id_generated_chk CHECK (四合取 on id),
CONSTRAINT task_fields_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
CONSTRAINT task_fields_created_by_printable_chk CHECK (created_by ~ '^[!-~]+$'),
CONSTRAINT task_fields_type_chk CHECK (type IN ('text','number','select','multiSelect','member','date')),
CONSTRAINT task_fields_name_nonblank_chk CHECK (pg_catalog.btrim(name) <> ''),
CONSTRAINT task_fields_config_object_chk CHECK (pg_catalog.jsonb_typeof(config) = 'object'),
CONSTRAINT task_fields_id_org_id_key UNIQUE (id, org_id)
```

- 类型闭集六型（S25）；`config` 的闭合 schema 由 `parseFieldDefinition` 保证（D10，`ASSUMPTION`）。
- 字段没有软删：删除定义是硬删，值随之删除（S26）；有绑定时由服务层先拒绝（§3.5）。
- 索引：`idx_tfld_org (org_id)`。

### 2.5 `task_list_field_bindings`

```
list_id text NOT NULL, field_id text NOT NULL, org_id text NOT NULL,
position integer NOT NULL DEFAULT 0, hidden boolean NOT NULL DEFAULT false,
created_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT task_list_field_bindings_pkey PRIMARY KEY (list_id, field_id),
CONSTRAINT task_list_field_bindings_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
CONSTRAINT task_list_field_bindings_position_chk CHECK (position >= 0),
CONSTRAINT task_list_field_bindings_list_fk  FOREIGN KEY (list_id, org_id)  REFERENCES task_lists (id, org_id) ON DELETE CASCADE,
CONSTRAINT task_list_field_bindings_field_fk FOREIGN KEY (field_id, org_id) REFERENCES task_fields (id, org_id) ON DELETE RESTRICT
```

- 指向字段的外键用 `RESTRICT`（`[a-08]`）：「仍有绑定不能删定义」是服务层在锁内先查的规则，库层再挡一次，服务层若漏查得到的是外键错误而不是静默删掉绑定。
- 索引：`idx_tflb_field (field_id)`。

### 2.6 `task_field_values`

```
task_id text NOT NULL, field_id text NOT NULL, org_id text NOT NULL, value jsonb NOT NULL,
updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT task_field_values_pkey PRIMARY KEY (task_id, field_id),
CONSTRAINT task_field_values_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
CONSTRAINT task_field_values_updated_by_printable_chk CHECK (updated_by ~ '^[!-~]+$'),
CONSTRAINT task_field_values_value_not_json_null_chk CHECK (pg_catalog.jsonb_typeof(value) <> 'null'),
CONSTRAINT task_field_values_task_fk  FOREIGN KEY (task_id, org_id)  REFERENCES tasks (id, org_id) ON DELETE CASCADE,
CONSTRAINT task_field_values_field_fk FOREIGN KEY (field_id, org_id) REFERENCES task_fields (id, org_id) ON DELETE CASCADE
```

- 「清空」不存 `null`，而是删掉这一行（`[a-09]`）；`NOT NULL` 只挡 SQL 的 `NULL`，`task_field_values_value_not_json_null_chk` 再挡 JSON 的 `null`，所以行存在 ⇔ 有值在库里成立。
- 解绑不删值（S26）；任务软删时值保留（D17）。
- 索引：`idx_tfv_field (field_id)`。

### 2.7 `task_attachments`（表随 PR-4a，读写在 PR-4b；S30 ③）

```
id text PRIMARY KEY, org_id text NOT NULL, task_id text, comment_id text,
bind_kind text NOT NULL, uploader_id text NOT NULL, storage_key text NOT NULL,
display_name text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL,
status text NOT NULL DEFAULT 'unbound', scan_state text NOT NULL DEFAULT 'unscanned',
created_at timestamptz NOT NULL DEFAULT now(), bound_at timestamptz,
deleted_at timestamptz, deleted_by text
```

约束（全部带名）：

- `task_attachments_id_generated_chk`（四合取）；`task_attachments_org_id_printable_chk`、`task_attachments_uploader_id_printable_chk`、`task_attachments_storage_key_printable_chk`；`task_attachments_deleted_by_printable_chk`：`deleted_by IS NULL OR deleted_by ~ '^[!-~]+$'`；`task_attachments_display_name_nonblank_chk`：`pg_catalog.btrim(display_name) <> ''`；`task_attachments_storage_key_key`：`UNIQUE (storage_key)`。
- `task_attachments_mime_type_chk`：`mime_type IN ('application/pdf','image/png','image/jpeg','image/gif','image/webp','text/plain','text/csv')`（S18 的白名单，与任务 E `TASK_ATTACHMENT_MIME_EXTENSIONS` 的键一一对应）。
- `task_attachments_size_chk`：`size_bytes BETWEEN 1 AND 10485760`（S18）。
- `task_attachments_bind_kind_chk`：`bind_kind IN ('task','comment')`；`task_attachments_status_chk`：`status IN ('unbound','bound','deleted')`；`task_attachments_scan_state_chk`：`scan_state IN ('unscanned','clean','infected')`（任务 E 的三个闭集；M5 只写 `unscanned`，S22）。
- 行状态的一致性（任务 E 对行的要求在库里再写一遍，`[a-07]`）：
  - `task_attachments_bound_has_task_chk`：`(bound_at IS NULL) = (task_id IS NULL)`：绑定过才有所属任务（PR-4b 的评论绑定因此在同一条 `UPDATE` 里同时写 `task_id`、`comment_id`、`bound_at`）；
  - `task_attachments_unbound_state_chk`：`status <> 'unbound' OR bound_at IS NULL`；`task_attachments_bound_state_chk`：`status <> 'bound' OR bound_at IS NOT NULL`；
  - `task_attachments_task_kind_chk`：`bind_kind <> 'task' OR (comment_id IS NULL AND bound_at IS NOT NULL)`：任务级附件上传即绑定（S19），从不处于未绑定；
  - `task_attachments_comment_kind_chk`：`bind_kind <> 'comment' OR ((comment_id IS NULL) = (bound_at IS NULL))`：评论附件绑定过才有评论 id，未绑定的行不带评论 id。指向评论的外键在 `task_id` 为空时按 MATCH SIMPLE 不检查，未绑定行上的评论 id 只有这条 CHECK 能挡；
  - `task_attachments_deleted_state_chk`：`(status = 'deleted') = (deleted_at IS NOT NULL)`。
- 外键：`task_attachments_task_fk`：`(task_id, org_id) → tasks (id, org_id) ON DELETE CASCADE`；`task_attachments_comment_fk`：`(comment_id, task_id) → task_comments (id, task_id)`，**`NO ACTION`**。后者要求 `task_comments` 有 `(id, task_id)` 唯一约束，本迁移加上 `task_comments_id_task_id_key`（`[a-07]`）。有了上面的 `comment_kind` CHECK，带评论 id 的行一定已绑定、一定有 `task_id`，外键一定检查——评论附件的所属任务与评论的所属任务在库里就不可能分叉。
- 指向评论的外键不级联（`[a-07]`）：S19 定的是删评论不删附件，级联正好相反。今天删评论只写墓碑、不硬删，这条路径够不到；以后若有硬删评论的路径，它会在附件没被另行处理时报错，而不是静默删掉附件行。`NO ACTION` 在语句结束时才检查，所以任务硬删经 `task_comments_task_fk` 与 `task_attachments_task_fk` 两条级联同一语句删掉评论与附件时不受它阻挡（`RESTRICT` 会挡）。
- 索引：`idx_tatt_task (task_id) WHERE task_id IS NOT NULL`、`idx_tatt_comment (comment_id) WHERE comment_id IS NOT NULL`、`idx_tatt_unbound_sweep (status, created_at)`。

### 2.8 `task_attachment_purge_intents` 与行删除触发器

```
id text PRIMARY KEY, storage_key text NOT NULL, reason text NOT NULL,
status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
lease_expires_at timestamptz, fence bigint NOT NULL DEFAULT 0, last_error text,
created_at timestamptz NOT NULL DEFAULT now(), purged_at timestamptz
```

- 约束：`task_attachment_purge_intents_id_generated_chk`（四合取）；`task_attachment_purge_intents_storage_key_printable_chk`；`task_attachment_purge_intents_reason_chk`：`reason IN ('user_removed','unbound_ttl','reconciler_orphan','row_deleted')`（`[a-22]`：S23 的三条来源加触发器）；`task_attachment_purge_intents_status_chk`：`status IN ('pending','in_progress','done','dead_letter')`；`task_attachment_purge_intents_attempts_chk`：`attempts >= 0`；`task_attachment_purge_intents_last_error_code_chk`：`last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]*$'`（只存固定码）；`task_attachment_purge_intents_storage_key_key`：`UNIQUE (storage_key)`。
- `UNIQUE (storage_key)` 从建表起就有（D1）。每个写 intent 的地方——触发器、用户移除、未绑定过期清扫、孤儿对账——都用同一个 id `'tpi_' || pg_catalog.md5(storage_key)`，冲突目标都是 `ON CONFLICT (storage_key) DO NOTHING`（D1，`ASSUMPTION`）。md5 的十六进制不含 `_`，四合取 CHECK 自然成立。
- 触发器：函数 `task_attachment_enqueue_purge_on_delete()`，触发器 `task_attachment_purge_on_delete`，`AFTER DELETE ON task_attachments FOR EACH ROW`，插入 `reason='row_deleted'` 的 intent。直接 `DELETE` 与 `tasks` 硬删引起的级联都会经过它；M5 没有硬删路径，它是给以后的保留期作业预备的（S23；那个作业删任务时的整链要求见 §2.2）。
- 索引：`idx_tapi_pending (status, created_at)`。

### 2.9 `task_record_projection`（表随 PR-4a，读写在 PR-4c；`[a-06]`）

```
list_id text NOT NULL, task_id text NOT NULL,
projected_version integer NOT NULL, projected_digest text,
last_projected_at timestamptz, last_error text,
created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT task_record_projection_pkey PRIMARY KEY (list_id, task_id),
CONSTRAINT task_record_projection_list_id_generated_chk CHECK (四合取 on list_id),
CONSTRAINT task_record_projection_task_id_generated_chk CHECK (四合取 on task_id),
CONSTRAINT task_record_projection_version_chk CHECK (projected_version >= 1),
CONSTRAINT task_record_projection_digest_chk CHECK (projected_digest IS NULL OR projected_digest ~ '^[a-f0-9]{64}$'),
CONSTRAINT task_record_projection_last_error_code_chk CHECK (last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]*$')
```

- 主键 `(list_id, task_id)`、**没有外键**（锁 §4.2、§7）；不带 `org_id`，org 边界由清单与 sheet 承担（E04、S01–S03）。
- 两个键列各有四合取 CHECK：没有外键可依靠，而记录 id `rec_tsk_<listId>__<taskId>` 的可拆分性（锁 §7）正靠两段都是合格的任务域 id；与 `tasks` 两个系列列同一做法（§2.1）。
- `projected_digest` 存上一次投影内容的摘要（任务 E `taskProjectionNoopDigest` 的输出形状），PR-4c 用它判 no-op（S08；摘要相同仍更新 `projected_version`，D9）。`[a-21]`
- sheet id 与记录 id 都由 `(list_id, task_id)` 推导（任务 E `deriveTaskProjectionSheetId` / `deriveTaskProjectionRecordId`），不存列。
- 清单是否已开启投影也不存列、不建表：按 S04，它从该清单的投影 sheet 是否存在推导。PR-4c 因此不加列，本迁移是 M5 唯一的 DDL。
- 索引：`idx_trp_task (task_id)`（软删与移出时按任务找映射行）。

### 2.10 列与纯函数类型的对照

PR-4b / 4c 将按下表把行映射成任务 E 的输入；对不上的地方在这里登记，避免两边各执一词。

| 纯函数类型（#6249） | 字段 | 列 |
|---|---|---|
| `TaskOccurrenceSource` / `SpawnedTaskRow` | `seriesId` / `previousOccurrenceId` / `isMilestone` / `recurrence` | `recurrence_series_id` / `previous_occurrence_id` / `is_milestone` / `recurrence` |
| `TaskDependencyEdge` | `predecessorId` / `successorId` | 同名两列 |
| `TaskFieldDefinition` | `id` / `type` / `name` / `config` | 同名四列 |
| `TaskFieldBinding` | `listId` / `fieldId` / `position` / `hidden` | 同名四列 |
| `TaskAttachmentRowForDownload` | `orgId` / `uploaderId` / `status` / `boundAt` / `scanState` | `org_id` / `uploader_id` / `status` / `bound_at` / `scan_state` |
| `TaskAttachmentRowForRemoval` | `id` / `taskId` / `uploaderId` / `status` / `bindKind` / `boundAt` | 同名列；`taskId` 为空 ⇔ `bound_at` 为空，与 §2.7 的 CHECK 一致 |

唯一需要服务层换算的是序号：`planSpawn` 要当前实例在系列里的 1 起序号，本迁移**不存序号列**。服务层在结构锁内数「系列第一期本身 + 同系列、`created_at` 不晚于当前实例的各期」（含已软删的期；经 `idx_tsk_recurrence_series`，查询条件经 §4.7 的系列 builder），派生总在上一期完成之后、在另一个事务里插入，所以 `created_at` 的先后就是链的先后（`[a-16]`）。锚点（系列第一期的 `due_date`）在同一锁内按 id 读出，第一期可能已软删，所以同样经 §4.7 的任意状态 builder；锚点为空时不派生（§3.2 第 3 步）。任务 E §7 问题 1 若取 (c) 或 (iii) 的备选，要存锚点或计数起点，那是本迁移之外的新列——见 §7.2。

### 2.11 `up()` 与 `down()`

`up()` 的顺序：① `tasks` 的四列、§2.2 的八条约束、两个索引；② `task_comments_id_task_id_key`；③ `task_dependencies`（含索引，下同）；④ `task_fields`；⑤ `task_list_field_bindings`；⑥ `task_field_values`；⑦ `task_attachments`；⑧ `task_attachment_purge_intents`；⑨ 触发器函数与触发器；⑩ `task_record_projection`。

`down()` 是它的严格逆序，全部 `IF EXISTS`：⑩ 删 `task_record_projection`；⑨ 删触发器、再删函数；⑧ 删 `task_attachment_purge_intents`；⑦ `task_attachments`；⑥ `task_field_values`；⑤ `task_list_field_bindings`；④ `task_fields`；③ `task_dependencies`（表上的索引与约束随表删除）；② 删 `task_comments_id_task_id_key`；① 删 `tasks` 的两个索引（`idx_tsk_recurrence_series`、`uq_tsk_previous_occurrence`）、按名删 §2.2 的八条约束、再删四列。

---

## 3. 接口（冻结）

### 3.0 共性（沿用 M2–M4）

- 新路由写在两个新文件里，各导出一个注册函数，由 `tasksRouter()` 在同一个 `router` 上各用一行调用（PR-3a §3.0 的写法；门 13 负控的改写点就是这两行）：`src/routes/tasks-entity.ts`（`registerTaskEntityRoutes`：依赖、重复与里程碑）与 `src/routes/tasks-fields.ts`（`registerTaskFieldRoutes`：字段定义、绑定、取值）。文件名以 `tasks` 开头，落在门 7 的扫描根 `src/routes/tasks*` 内。**不新增挂载点、不新增 `TASKS_*` 读点、不新增开关**（S30 ①：这四个子功能不单独设开关）。
- 每条路由 `authenticate` + `rbacGuard('tasks', 'read' | 'write')`；没有路由用 `tasks:admin`（R18、S26）。
- org 只取 `req.authenticatedTenantId`：写路由缺 org ⇒ 422 `ORG_MISSING`；集合型读 ⇒ 200 `{ items: [], degraded: true, reason: 'org_missing' }`；单对象读 ⇒ 404。判定都在 `rbacGuard` 之后的 handler 里。分类沿用 PR-3a 的 `[own-19]`：路径里带一个任务 id 或清单 id 的读都算单对象读——`GET /api/tasks/:id/dependencies`、`GET /api/tasks/:id/dependency-candidates`、`GET /api/task-lists/:id/field-bindings` 缺 org ⇒ 404；本 PR 唯一的集合型读是 `GET /api/task-fields` ⇒ 降级 200。
- 行级失败统一回 404 `{ error: { code: 'NOT_FOUND' } }`，响应与目标不存在时完全一样，不区分不存在、他 org、已软删、看不见、看得见但没有这项能力；行级从不返回 403。
- 请求体与路径参数的校验排在行级能力判定之后：看不到的对象不论请求体如何都是 404。
- 本文写 `can(roles, …)` 的地方，`roles` 都是 `resolveTaskRoles` 给出的完整角色集，含清单身份（S11、S13、S35 与 S26 的取值写法）。只看直接角色的判定有两处，都写明了：G1 的 `canCompleteForAll`（只比较创建人），以及沿用 PR-3a `[own-53]` 的增删负责人与关注人（本 PR 不改）。
- 错误码：纯函数的 `reason` 转大写即 HTTP 码；`not_found` / `forbidden` / `cross_org` ⇒ 404；`has_children` 沿用 M3 的 409 `HAS_CHILDREN`；`VERSION_CONFLICT` 409 不变；其余 422。错误体只有 `{ error: { code } }`（`[a-14]`）。
- 空操作 200，不写行、不写事件。
- 路径里不可打印的 id ⇒ 发 SQL 之前 404；请求体里的任务域 id 必须过 `isValidTaskDomainId`（四合取），不过 ⇒ 422（门 10 的 id 两格）。
- 列表用 PR-3a 的分页合同 `{ items, total }`、`limit` 1..100 缺省 100、`offset` ≥ 0（R15、S34）；每个分页读都有冻结的稳定排序键（§3.4 候选、§3.5 `GET`），最后一键是 `id`。两处有意不分页：`GET /api/tasks/:id/dependencies`（两个数组，每任务前置加后置至多 50，D18）与 `GET /api/task-lists/:id/field-bindings`（`{ items }`，每清单绑定至多 50，D18）。两者结果集有上限，不收 `limit` / `offset`、不带 `total`（`[a-34]`）。
- 成功体 camelCase，时间是 ISO-8601 或 `null`；列表项沿用 M2 的 snake_case 列（§3.8 加一列）。

### 3.1 G1：`POST /api/tasks/:id/complete`

| 项 | 冻结值 |
|---|---|
| 请求体 | 可选 `{ scope?: 'self' \| 'all' }`；缺省 = `'self'`（与今天完全相同） |
| `scope` 校验 | 严格：出现 `scope` 且不是 `'self'` / `'all'` ⇒ 422 `INVALID_SCOPE`（`[a-01]`）。排在行级判定之后 |
| `'all'` 的调用者 | 只有任务创建人：纯谓词 `canCompleteForAll({ actorId, createdBy })` 只比较 `actorId === createdBy`，不接收角色集，清单身份传不进来（与 `canChangeTaskMembers` 同一做法）；负责人、清单可编辑者、关注人一律 404（`[a-02]`） |
| `'all'` 的效果 | `all` 模式：所有 `completed_at` 为空的负责人行取同一个 `now`，已有的完成时刻保留；任务翻为 done，`version + 1`。`any` 模式与零负责人：与 `'self'` 同一路径（这两种情况下创建人的完成本来就作用于整个任务，`[a-04]`） |
| 已完成时 | 空操作：200 `{ done: true, version }`，`version` 不变，不改行、不写事件（`applyComplete` 现有的 `wasDone` 规则） |
| 事件 | 翻转时一条 `completed`，actor = 创建人，payload `{ "scope": "all" }`（`[a-03]`）；`completed` 已在 `TASK_NOTIFIABLE_EVENTS`（`task-notifications.ts:28`），PR-3b 合入后照常通知，不改闭集 |
| 成功体 | `{ done, version }`（不变） |
| 错误 | 404；422 `ORG_MISSING`、`INVALID_SCOPE` |

判定顺序（锁后）：取任务（404）→ 角色集与 `canChangeCompletion(roles, 'complete', n)`（404）→ 解析 `scope`（422）→ `scope === 'all'` 时 `canCompleteForAll`（404）→ 纯函数 → 写。

`reopen` 不变：它已有 `scope=self|all`（`routes/tasks.ts:196` 把非 `'all'` 一律当 `'self'`），本文不动它的解析，两条路由的 `scope` 解析严格程度因此不同，列为 owner 问题（`[a-01]`）。

### 3.2 重复：`PUT /api/tasks/:id/recurrence`

| 项 | 冻结值 |
|---|---|
| 码 / 行级 | write；`can(roles, 'edit')`（S35：持 `edit` 者，即创建人、负责人、清单可编辑者） |
| 请求体 | `{ recurrence: Rule \| null }`；`Rule` 是 S14 的闭集（`freq` / `interval` / `byWeekday` / `byMonthDay` / `end`），由 `parseRecurrenceRule` 解析与规范化 |
| 设规则 | 任务没有截止日 ⇒ 422 `DUE_REQUIRED`；规则不合法 ⇒ 422 `INVALID_RECURRENCE`（先校验规则、再查截止日，任务 E 的自选）；与现值规范化后相同 ⇒ 空操作；否则写列、事件 `recurrence_set` |
| 清规则（`null`） | 已无规则 ⇒ 空操作；不是系列里最新且未完成的一期 ⇒ 422 `NOT_CURRENT_OCCURRENCE`；否则清列、事件 `recurrence_cleared`（S17 (a)） |
| 成功体 | `{ id, recurrence, seriesId, previousOccurrenceId }` |
| 错误 | 404；422 `ORG_MISSING`、`INVALID_RECURRENCE`、`DUE_REQUIRED`、`NOT_CURRENT_OCCURRENCE` |

`count` 越界答 `INVALID_RECURRENCE`，不答 `LIMIT`（任务 E §7 问题 3 的缺省，§7.2）。

**派生**（S15、S16、D3）：在三个把任务从 open 翻成 done 的调用点上——`completeTask`（`services/task-records.ts:637`，含 §3.1 的 G1 路径）、`removeAssignee`（`services/task-structure.ts:347`，翻转在 `:364`）、`switchCompletionMode`（同文件 `:406`，翻转在 `:424`）——同一事务、同一把结构锁里，在写入翻转之后调用同一个服务函数 `spawnNextOccurrenceIfDue(db, …)`：按下面「派生的判定顺序」走到 `planSpawn`，再用独立的插入函数写入新一期的任务行，以及它的负责人（`completed_at` 为空）、关注人、所属清单、字段取值和两条事件，不经 `createTask`（它自开事务并再次取锁）。`addAssignee`（`:313`，翻转在 `:341`）是 done → open 方向，不派生。

- 一次性守卫：锁内查本任务是否已有 `recurrence_spawned` 事件（D3）；库里再有 §2.2 的唯一索引兜底。reopen 之后再完成不派生第二次。
- 新一期的日期与提醒（E05、S16）：新的 `due_date` 由 `nextOccurrenceDueDate` 算出，`start_date` 与它顺延相同的民用天数，`due_time`、`start_time`、`time_zone` 照抄，`due_at` 用 `computeDueAt` 重算。`remind_at`：上一期有提醒 ⇒ 新一期保持相对新 `due_at` 的同一提前量；上一期没有 ⇒ 按系列创建人的 `default_remind_policy` 经 `computeDefaultRemindAt` 计算（任务 E `planSpawn` 返回的两种指示）。新一期的 `created` 事件就是它的提醒下界，PR-3b 的扫描据此判断是否该提醒。
- 派生的负责人：只带上仍是本 org 在职成员的那些（经 `services/task-org-members.ts` 的 `findActiveOrgMembers`），离开 org 的人不进新一期，也不让完成失败（`[a-15]`）。
- 派生的清单项与字段值照抄，不写 `list_added` / `item_added` 事件（任务 E `planSpawn` 只给两条事件；`[a-30]`）。
- 派生不发通知（S33）：新任务的 `created` 不在可通知闭集里。
- `PATCH` 清空有规则任务的截止日不拒绝（`[a-27]`）；之后它完成时不派生。下面的顺序保证这种状态只是「不派生」，不会让完成失败。

**派生的判定顺序**（冻结；行号是 `98cbca16ec` 上的，PR-3b 合入后的行号见头部）：

1. `shouldSpawnOnFlip` 为假 ⇒ 不派生。
2. 本期 `due_date` 为空 ⇒ 不派生（结果记 `no_due_date`），**不调用 `planSpawn`**。截止日与时区一起被清空（`planTaskDates` 在不剩任何日期时接受空时区，P0-A 的 `tasks_time_zone_when_dated_chk` 也允许）必然落在这一步，因为有日期就一定有时区。
3. 读锚点：系列第一期的当前 `due_date`（本期没有 `seriesId` 时就是本期，第 2 步已保证非空）；第一期可能已软删，按 id 经 §4.7 的任意状态 builder 读。锚点为空（有人清空了第一期的截止日）⇒ 不派生（结果记 `no_due_date`，`[a-33]`）。
4. 数序号（§2.10），调用 `planSpawn`。下一期截止日越过民用日期上限（`9999-12-31`）⇒ 按 `series_ended` 处理、不派生；这要 #6249 的 `planSpawn` 把越界当作 `series_ended` 返回，而不是让 `nextOccurrenceDueDate` 抛 `RangeError`（§4.1、§7.2）。

「不派生」在三个调用点与 G1 路径上都不影响翻转本身：完成照常 200、照常写 `completed` 等事件。任务 E 现行的 `planSpawn` 先校验时区与锚点、后判 `no_due_date`，第 2、3 步的情形若直接交给它会抛 `TypeError`、整次完成 500 并回滚——第 2、3 步就是为了不把这两种状态交给它。

### 3.3 里程碑：`PATCH /api/tasks/:id/milestone`

write；`can(roles, 'edit')`（S13）；请求体 `{ isMilestone: boolean }`，只收真布尔值，否则 422 `INVALID_MILESTONE`；同值空操作；否则事件 `milestone_set` / `milestone_cleared`。不要求截止日（S13）。成功体 `{ id, isMilestone }`。

### 3.4 依赖

| 方法 路径 | 码 | 行级 | 请求 | 成功 200 | 错误 |
|---|---|---|---|---|---|
| `GET /api/tasks/:id/dependencies` | read | 本任务 `view` | — | `{ predecessors: DepItem[], successors: DepItem[] }` | 404 |
| `POST /api/tasks/:id/dependencies` | write | 两端都 `can(roles,'edit')` 且同 org 且都未软删（S11；`roles` 是含清单身份的完整角色集） | 恰一个键：`{ predecessorId }`（加 `predecessorId → :id`）或 `{ successorId }`（加 `:id → successorId`） | `{ predecessorId, successorId }` | 404；422 `ORG_MISSING`、`INVALID_DEPENDENCY`、`SELF`、`CYCLE`、`LIMIT` |
| `DELETE /api/tasks/:id/dependencies/predecessors/:otherId` | write | 同上（两端 `edit`） | — | `{ predecessorId, successorId }` | 404；422 `ORG_MISSING` |
| `DELETE /api/tasks/:id/dependencies/successors/:otherId` | write | 同上 | — | 同上 | 同上 |
| `GET /api/tasks/:id/dependency-candidates` | read | 本任务 `edit` | query `direction=predecessor\|successor`（必填）、`q`（可选，按标题包含匹配，不区分大小写，`[a-32]`）、`limit` `offset`；按 `created_at DESC, id ASC` 排序（`[a-34]`） | `{ items: [{ id, title, status }], total }` | 404；422 `INVALID_DIRECTION`、分页 |

- `DepItem` = `{ id, title, status, dueAt, isMilestone }`，只列调用者能 `view` 的对端；看不见的对端不列出、也不计数（与 M3 详情里的子任务同一规则，`[a-28]`）。
- 判定顺序（锁后）：本任务取行与 `edit`（404）→ 请求体恰一个键且 id 过四合取（422 `INVALID_DEPENDENCY`）→ 对端取行（同 org、未软删）与 `edit`（404）→ `validateAddDependency`：`cross_org` ⇒ 404，`self` ⇒ 422 `SELF`，**`duplicate` ⇒ 200 空操作**（`[a-11]`：PR-3a 的约定是重复加入为空操作；任务 E 的 reason 名不变，只是路由把它当空操作），`limit` ⇒ 422 `LIMIT`，`cycle` ⇒ 422 `CYCLE`。
- 加边时锁内读出本 org 两端都未软删的全部边（D4；经 §4.7 的 org 边 builder 与 `idx_tdep_org`），纯函数判环（允许菱形）；事件两端各一条 `dependency_added`，payload 带对端 id（S11）。删边同形 `dependency_removed`；边不存在 ⇒ 空操作。
- 候选：只返回调用者能编辑、同 org、未软删的任务（org 条件经 §4.7 的候选 builder，不手写），排除自身、两端之间任一方向已有边的任务，以及加上后会成环的任务（最后一类是任务 E 的偏离，§7.2 X3）；父子关系不排除；不按上限过滤。
- 每任务前置加后置至多 50（D18），超出 422 `LIMIT`。

### 3.5 字段定义

`Field` = `{ id, type, name, config, createdBy, createdAt, updatedAt }`。

| 方法 路径 | 码 | 行级 | 请求 | 成功 200 | 错误 |
|---|---|---|---|---|---|
| `GET /api/task-fields` | read | — | query `limit` `offset`；按 `created_at ASC, id ASC` 排序（`[a-34]`） | `{ items: Field[], total }`：调用者可复用的字段 = 自己建的 ∪ 绑在调用者能编辑的清单上的（S24） | 422 分页 |
| `POST /api/task-fields` | write | — | `{ type, name, config? }` | `Field` | 422 `ORG_MISSING`、`INVALID_TYPE`、`INVALID_NAME`、`INVALID_CONFIG`、`LIMIT` |
| `PATCH /api/task-fields/:id` | write | `canManageFieldDefinition`：创建者，或在任一绑定了它的清单上是 edit/owner（S26） | `{ name?, config? }`；出现 `type` ⇒ 422 `INVALID_TYPE`（类型不可改） | `Field` | 404；422 同上 |
| `DELETE /api/task-fields/:id` | write | `planDeleteFieldDefinition`：只有创建者 | — | `{ id, deleted: true }` | 404；422 `FIELD_IN_USE` |

- 每 org 定义至多 200、每字段选项至多 100（D18，超出 `LIMIT`）；选项 id 由服务端生成 `opt_<随机>`。
- 定义的建、改、删不写事件：两个事件闭集里都没有对应的词（`[a-25]`）。删除定义时它的值随外键一并删除，也不写 `field_value_changed`。

### 3.6 清单的字段绑定

| 方法 路径 | 码 | 清单能力 | 请求 | 成功 200 | 错误 |
|---|---|---|---|---|---|
| `GET /api/task-lists/:id/field-bindings` | read | 清单成员 | — | `{ items: [{ fieldId, position, hidden, field: Field }] }`，按 `position, fieldId` 排序 | 404 |
| `POST /api/task-lists/:id/field-bindings` | write | 清单 edit/owner（`canBindField`） | `{ fieldId }`；该字段须在调用者可复用的集合里（同 §3.5 的 `GET`），否则 404 | 同 `GET` 的单项 | 404；422 `ORG_MISSING`、`INVALID_FIELD`、`LIMIT` |
| `PATCH /api/task-lists/:id/field-bindings/:fieldId` | write | 同上 | `{ position?, hidden? }`（至少一个；`position` 非负整数，`hidden` 布尔） | 同上 | 404；422 `ORG_MISSING`、`INVALID_BINDING` |
| `DELETE /api/task-lists/:id/field-bindings/:fieldId` | write | 同上 | — | `{ listId, fieldId }` | 404；422 `ORG_MISSING` |

- 判定顺序（锁后，与 §3.4 同形）：清单取行与能力（404）→ 请求体（`POST`：`fieldId` 过四合取，否则 422 `INVALID_FIELD`；`PATCH`：形状不对 ⇒ 422 `INVALID_BINDING`；路径里的 `:fieldId` 不可打印 ⇒ 发 SQL 之前 404）→ 字段取行：`POST` 要求字段在调用者可复用的集合里，`PATCH` 要求它已绑在本清单上，否则 404 → 已绑空操作与上限（422 `LIMIT`）。
- 已绑 ⇒ 空操作；未绑而删 ⇒ 空操作。每清单绑定至多 50（D18）。
- 绑与解绑写 `task_list_events` 的 `field_bound` / `field_unbound`（payload `{ fieldId }`）；调顺序与显隐不写事件（S05：没有词的动作不写事件）。解绑不删值（S26）。
- 清单归档不影响这四条路由（归档只改清单列表的缺省过滤，PR-3a §3.2）。

### 3.7 任务的字段取值：`PUT /api/tasks/:id/field-values`

write；行级 = 任务 `can(roles,'edit')` **且** 该字段绑在包含此任务的某张清单上（`canWriteFieldValue`），任一不满足 404。判定顺序（锁后，与 §3.4 同形）：任务取行与 `edit`（404）→ 请求体 `fieldId` 过四合取（422 `INVALID_FIELD`）→ 字段取行与 `canWriteFieldValue`（404）→ 值校验（下列各 422）。请求体 `{ fieldId, value }`，一次一个字段（`[a-13]`）；`value` 为 `null` 或 `''` ⇒ 清空（删行）。值的错误：422 `INVALID_FIELD`（id 不合格）、`INVALID_VALUE`、`NOT_IN_OPTIONS`、`NOT_A_CANDIDATE`、`TOO_LONG`、`OUT_OF_RANGE`、`LIMIT`。成员型的候选集 = 本 org 在职成员（R17 的 helper），不在候选集答 `NOT_A_CANDIDATE`（`[a-31]`）。同值空操作；否则事件 `field_value_changed`（payload `{ fieldId }`）。成功体 `{ taskId, fieldId, value }`。

### 3.8 既有响应的增补

**详情 `GET /api/tasks/:id`**（全部在 `view` 判定之后组装）：

- `isMilestone: boolean`；`recurrence: Rule | null`；`seriesId: string | null`；`previousOccurrenceId: string | null`；`nextOccurrenceId: string | null`（同 org、未软删、**且调用者能 `view`** 的后继，否则 `null`：它是反向查找，与子任务、`DepItem` 用同一过滤规则；`[a-17]`、`[a-28]`）。`seriesId` 与 `previousOccurrenceId` 是本行自己的列、指向更早的期，照 `parentId` 的先例不过滤（残留登记为 `[a-35]`）。
- `dependencies: { predecessors: DepItem[], successors: DepItem[] }`（同 §3.4 的 `GET`）。
- `fieldValues: [{ listId, fields: [{ fieldId, name, type, config, hidden, value }] }]`：按 S27，某个字段值对调用者可见的条件是：调用者能 `view` 这个任务，并且有一张清单同时绑着这个字段、装着这个任务、以调用者为成员。只凭直接角色看到任务、却不在任何相关清单里的人，这一项是空数组。
- `canCompleteForAll: boolean` = `canCompleteForAll(...)` ∧ 任务 open ∧ `completion_mode = 'all'` ∧ 至少一个负责人（`[a-05]`）。

**列表项**（`GET /api/tasks`、`/pending`、`/api/task-lists/:id/items`）：在 M2 的 snake_case 列之后加 `is_milestone`（S13 要求列表也显示里程碑徽标；`[a-18]`）。只加列，不改既有列。

**删除 `DELETE /api/tasks/:id`**：任务属于一个系列（有规则，或 `recurrence_series_id` 非空，或是某一期的 `previous_occurrence_id`）时改走 `planSeriesDelete`（S17 (b)(d)）：软删目标与链上更晚、未软删且未完成的各期；每一期都先过任务 C 的删除判定（只有创建人；仍有未删子任务 ⇒ 整体拒绝 409 `HAS_CHILDREN`）；删除后链上最晚的未删一期若仍有规则则清掉并记 `recurrence_cleared`。成功体在 M3 的 `{ id, deleted: true }` 上加 `deletedIds: string[]`（目标在第一个；不属于系列时就是 `[id]`；`[a-19]`）。

系列删除的执行（结构锁内，冻结）：

1. 装载整个系列，含已软删的期：第一期按 id，其余按 `recurrence_series_id`（经 `idx_tsk_recurrence_series`）；两处的 org 条件都经 §4.7 的系列 builder。
2. 对将要软删的每一行——目标，以及链上更晚、未软删且未完成的各期——**按 id 升序**取 M3 删除路径的同一个有界 `FOR UPDATE`（M3 的行锁 helper；超时 ⇒ 409 `TASK_BUSY`，整体回滚）。这样持 `FOR KEY SHARE` 的评论写不会在同一次删除里落到任何一期上：M3 单删已有的保证扩到整条链。完成态只在结构锁内改，所以这个集合在锁内不会变。
3. 调用 `planSeriesDelete`，写软删与事件：每一期一条 `deleted`，最晚未删一期若被清规则再加一条 `recurrence_cleared`。
4. 照 PR-3b 的写法，把这次写出的全部事件同事务交给 `enqueueTaskEventNotifications`：`deleted` 在可通知闭集里，所以每一期的关注人都收到删除通知，与逐期单删一致；`recurrence_cleared` 不在闭集里，由 producer 自行滤掉。

### 3.9 错误码总表（PR-4a 新增）

| 码 | HTTP | 出处 |
|---|---|---|
| `INVALID_SCOPE` | 422 | §3.1 |
| `INVALID_RECURRENCE`、`DUE_REQUIRED`、`NOT_CURRENT_OCCURRENCE` | 422 | §3.2（任务 E reason 转大写） |
| `INVALID_MILESTONE` | 422 | §3.3 |
| `INVALID_DEPENDENCY`、`SELF`、`CYCLE`、`INVALID_DIRECTION` | 422 | §3.4 |
| `INVALID_TYPE`、`INVALID_NAME`、`INVALID_CONFIG`、`FIELD_IN_USE` | 422 | §3.5 |
| `INVALID_FIELD`、`INVALID_BINDING` | 422 | §3.6、§3.7 |
| `INVALID_VALUE`、`NOT_IN_OPTIONS`、`NOT_A_CANDIDATE`、`TOO_LONG`、`OUT_OF_RANGE` | 422 | §3.7 |
| `LIMIT` | 422 | 沿用 M4 |

---

## 4. 服务分层、锁、版本与事件

### 4.1 文件

| 层 | 文件 | 内容 |
|---|---|---|
| 纯函数 | `src/tasks/task-completion.ts`（改） | 新增 `applyCompleteForAll`：创建人以外的调用者抛错；`wasDone` 为真 ⇒ 空操作；`all` 模式填满空行并给一条 `completed`；其余模式委托 `applyComplete` |
| 纯函数 | `src/tasks/task-access.ts`（改） | 新增 `canCompleteForAll({ actorId, createdBy })`；新增 §4.7 的三个 SQL 条件 builder，并在同一 PR 改写 `[own-3b-17]` 的注释 |
| 纯函数 | `src/tasks/task-recurrence.ts`（#6249 的文件，改一处） | `planSpawn`：下一期截止日越过 `9999-12-31` 时返回 `series_ended`，不抛 `RangeError`（§3.2 第 4 步；若 #6249 先行修改则此行作废） |
| 纯函数 | `src/tasks/task-ids.ts`（改） | `TASK_ID_PREFIXES` 加 `field: 'tfld'`、`attachment: 'tatt'` |
| 纯函数 | `src/tasks/task-projection.ts`（#6249 的文件，改一处） | 字段 id 前缀改从 `TASK_ID_PREFIXES.field` 派生 |
| 取锁 | `src/db/task-advisory-locks.ts`（改） | 锁序包装器（§4.2） |
| 服务 | `src/services/task-records.ts`（改） | `completeTask` 收 `scope`；`writeEvents` 支持 payload（切片 1，保留 PR-3b 的 `WrittenTaskEvent[]` 返回）；详情增补 |
| 服务 | `src/services/task-structure.ts`（改） | 两处翻转调用点接派生；删除改走系列判定 |
| 服务 | `src/services/task-recurrence-records.ts`（新） | 设 / 清规则、`spawnNextOccurrenceIfDue`、系列删除 |
| 服务 | `src/services/task-dependency-records.ts`（新） | 里程碑、依赖四条、候选 |
| 服务 | `src/services/task-field-records.ts`（新） | 定义、绑定、取值、详情的可见值 |
| 路由 | `src/routes/tasks-entity.ts`、`src/routes/tasks-fields.ts`（新） | §3.0 |

行级规则全部出自 `src/tasks` 的纯函数（门 20）；服务层只取行、调用、落库。

### 4.2 事务与锁

- 所有写走 `withOrgStructure(orgId, run)`：首句 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`，取 org 结构锁，锁后在同一连接上重读决定这次写的全部行，再调纯函数，事件同事务写入（与 M2–M4 同一协议）。加边、删边按 E07 属于结构写，判环之前必须在这把锁里把整张依赖图重新读一遍。
- 读路径不进事务、不取锁。
- **锁序包装器**（S09，owner 2026-10-09 裁定的取值）：`withTaskLockOrder(query)` 放在 `src/db/task-advisory-locks.ts`，把三把 helper（以及 PR-4c 才接入的 canonical fence 步）包成按 rank 校验的取锁器：structure = 1、fence = 2、projection = 3；同一事务里 rank 递减即抛 `TaskLockOrderViolation`。抛出点在包装层；三处 `pg_advisory_xact_lock(hashtext(` 字面量仍只在三个登记导出里，门 7 的多重集不变。PR-4a 只用到 rank 1；它的作用是首次武装 `M5|7|锁序控件`（§6.1），lane 是 `tasks-realdb`。
- 本 PR 不取投影锁、不取 fence、不涉及调度 leader 锁。

### 4.3 `tasks.version`

| 写 | `version` |
|---|---|
| 完成态翻转（含 G1、派生触发的那次翻转） | +1（不变） |
| 派生出的新一期 | 新行，列缺省 1 |
| 设 / 清规则、里程碑、依赖增删、字段取值 | **不变**（`[a-10]`） |
| 系列删除 | 不变（与 M3 软删一致） |

理由：`version` 只保护 `PATCH` 可编辑的字段与完成态（PR-3a §4.4 的 `[own-05]`）；S08 已裁投影用内容摘要判 no-op，不为投影去增加递增点。代价是持旧 `version` 的客户端在别人改了里程碑之后仍能 `PATCH` 成功——这几列不在 `PATCH` 里，覆盖不到。

### 4.4 事件

- 只用锁 §4.2 的闭集词，不新增（E03）。本 PR 写到的词：`completed`（G1）、`recurrence_set` / `recurrence_cleared` / `recurrence_spawned` / `created`（派生）、`deleted`（系列删除）、`milestone_set` / `milestone_cleared`、`dependency_added` / `dependency_removed`、`field_value_changed`，以及清单事件 `field_bound` / `field_unbound`。
- `writeEvents` 改为写入纯函数给出的 payload（缺省 `{}`；切片 1 就做，G1 的格要断言它）。每个写事件的新调用点都照 PR-3b 的写法，把 `writeEvents` 返回的 `WrittenTaskEvent[]` 同事务交给 `enqueueTaskEventNotifications`；可通知与否只由 `TASK_NOTIFIABLE_EVENTS` 决定，本 PR 不改这个闭集。所以 G1 的 `completed` 与系列删除的每条 `deleted` 照常通知，派生出的 `created` / `recurrence_spawned` 不通知（S33）。payload 只放闭集键名与任务域 id：`{ scope: 'all' }`、`{ predecessorId }` / `{ successorId }`、`{ spawnedTaskId }`、`{ fieldId }`。任务内历史以后读这些事件时，对其中的 id 仍要做可见性校验（owner 2026-10-09 六项之第 5 项）。
- 同一次写的事件 `occurred_at` 取锁后读一次的 `clock_timestamp()`（PR-3a §4.4 的规则），不用事务开始时的 `now()`。

### 4.5 部署耦合

PR-4a 合并后，详情与列表读 `tasks.is_milestone` 等新列：凡 `TASKS_ENABLED='true'` 且运行这份代码的环境必须已应用本迁移（与 PR-3a §9.2 同一种耦合）。staging 的迁移执行仍按 owner 2026-10-09 对 PR-3a §12-Q10 的裁定走：经授权后执行，事先按目标 SHA 列出完整的待执行集合。生产不动。

### 4.6 与 PR-3b、PR-4b、PR-4c 的边界

- PR-3b 已在 main（头部的基线漂移）。PR-4a 不用 `TaskScheduler`：派生在请求事务内完成。它用的是 PR-3b 的 producer：新写事件的调用点同事务入队（§4.4）。
- PR-4b 在本迁移的两张附件表上写路由与 GC，不再带 DDL；`TASK_NOTIFIABLE_EVENTS` 加 `attachment_added` 归 PR-4b（S33）。
- PR-4c 在映射表上写 reconcile；投影列 `isMilestone`、`dependencies`、自定义字段列的来源就是本文的列与表。
- 两者对本文的任何形状改动都先改本文。

### 4.7 新读的 SQL 条件 builder

M3 有两处按 org 读任务的条件是手写的（`services/task-structure.ts:176`、`:277`），门 1 的单字面量变异看不到它们。PR-4a 新增的按 org 或按系列的读不再手写，一律经 `src/tasks/task-access.ts` 的 builder，org 条件只经那里的单一 org 子句：

| builder | 选出 | 使用处 |
|---|---|---|
| `buildTaskSeriesMembersCondition` | 一个 org 内某系列的第一期与各期，**含已软删** | §2.10 序号计数、§3.2 第 3 步的锚点、§3.8 系列删除的装载 |
| `buildOrgDependencyEdgesCondition` | 一个 org 内两端都未软删的边 | §3.4 加边判环、候选的成环排除 |
| `buildDependencyCandidateTasksCondition` | 一个 org 内未软删的任务（可编辑性仍由纯函数逐行判定） | §3.4 候选 |

`[own-3b-17]` 今天写的是「只有投递 worker 读可能已软删的任务」。系列读是第二个这样的读者，PR-4a 在同一 PR 改写那条注释，把两个读者与各自的理由都列上。本节不改 M3 那两处手写条件，它们归 M3 的后续。

---

## 5. G1 的规则与验证（切片 1）

规则（owner 2026-10-09 六项之第 3 项；锁 §2 第 3 条的产品面）：

1. 只有任务创建人能「为所有负责人完成」。判定只看 `tasks.created_by`，任何清单身份、负责人身份都不能替代。
2. 完成动作重复执行时不重复产生事件：任务已是 done 的调用是空操作。
3. 它是一次 open → done 的翻转，走的就是 `completeTask` 的写入点，所以切片 3 的派生钩子天然覆盖它；切片 3 必须有一格证明这一点。

真库格（`task-m5-g1.db.test.ts`，候选行键见 §6.2）：

| 格 | 夹具与期望 |
|---|---|
| g1-creator-all | `all` 模式，两名负责人都未完成，创建人不是负责人 ⇒ 200 `{ done: true, version: v+1 }`；两行 `completed_at` 相同；恰一条 `completed`，actor 为创建人、payload `{ scope: 'all' }` |
| g1-keep-first | 一名负责人已在 t0 完成 ⇒ 调用后该行仍是 t0，另一行为新时刻 |
| g1-repeat | 对 g1-creator-all 再调一次 ⇒ 200，`version` 不变，`completed` 仍只有一条，行不变 |
| g1-concurrent | 两个连接同时以 `scope: 'all'` 调用 ⇒ 两个都 200，`completed` 恰一条 |
| g1-assignee | 负责人（非创建人）`scope: 'all'` ⇒ 404，逐字节同不存在；行与事件不变 |
| g1-list-editor | 只有清单可编辑身份的成员 ⇒ 404 |
| g1-follower / g1-outsider | ⇒ 404 |
| g1-bad-scope | 创建人 `scope: 'x'` ⇒ 422 `INVALID_SCOPE`；看不见任务的人带同样请求体 ⇒ 404 |
| g1-self-unchanged | 缺省与 `scope: 'self'` 的行为与 `M2\|3` / `M3\|3` 的既有格逐一相同 |
| g1-any / g1-zero | `any` 模式、零负责人：`scope: 'all'` 与缺省同结果 |
| g1-detail | 详情 `canCompleteForAll`：创建人且 open、`all`、有负责人 ⇒ true；其余 ⇒ false |

变异（每个都要让对应格变红）：去掉 `canCompleteForAll` 判定 ⇒ g1-assignee 红；把它换成 `can(roles, 'edit')` ⇒ g1-list-editor 红；去掉 `wasDone` 空操作分支 ⇒ g1-repeat 红；去掉结构锁 ⇒ g1-concurrent 红；把同一个 `now` 换成逐行取时 ⇒ g1-creator-all 红。

---

## 6. 门与测试计划

### 6.1 既有 `M5|` 行里属于 PR-4a 的部分（§12 已 ratify，直接计分）

- `M5|7|锁序控件`：正向——设父、依赖增删、派生在真实路径上并发调用，记录到的每个事务的 rank 序列单调；负向——测试里故意先取投影锁再取结构锁 ⇒ 包装器抛出，该格红。fence 步在 PR-4c 加入后再计入（只在 `MULTITABLE_ENABLE_WRITER_FENCE=true` 的 lane）。
- `M5|10|P2子集`：PR-4a 承载 id 两格中的写路径部分——依赖请求体里前导 `_` 与尾随 `_` 的任务 id ⇒ 422 `INVALID_DEPENDENCY`，绑定与取值请求体里同形的字段 id ⇒ 422 `INVALID_FIELD`。投影写回的 `recordId` 一格归 PR-4c。
- `M5|7|src/multitable/task-*`、`M5|9|整门`、`M5|19|投影端`：PR-4c。

### 6.2 候选行（未计分，等锁修订写进 `arm-set`）

S31 已裁 M5 的退出结构：五条既有行、候选 M5-a…g 落到整数门号（R01 已落为 23–26，所以候选从 27 编起）、最终 head 上回归全部 `M2|` / `M3|` / `M4|` 行、staging 真开一次记为合并后的 owner 步骤。门号与行键要由一次锁修订写进 §12，这次修订本身需要 owner 点名（§7.3）。PR-4a 承载的候选：

| 候选 | 门号（按 S31） | PR-4a 的格 |
|---|---|---|
| G1 | 不在 M5-a…g 之内；建议作为门 3 的子集行 `M5\|3\|创建人为全员完成`（`[a-24]`） | §5 全表 |
| M5-a 重复 | 27 | 完成翻转恰派生一期（三个调用点各一格，含 G1 路径）；新一期的日期步进、时刻与时区、系列两列、负责人行未完成；reopen 再完成不派生；`until` / `count` 用尽后不再派生；系列删除只动链上更晚且仍 open 的期；**不派生但完成照常 200**（§3.2 判定顺序，三个调用点与 G1 路径各一格）：截止日与时区一起清空后完成、只清空第一期自己的截止日后完成、后一期仍有截止日但第一期的截止日已清空时完成，每格都 200、无新一期、无 `recurrence_spawned`；截止日 `9999-12-31` 的有规则任务完成 ⇒ 200、`series_ended`；详情 `nextOccurrenceId`：派生后被移出负责人的人读上一期 ⇒ `null`；系列删除：链上更晚一期的关注人收到 `deleted` 通知行，且与另一连接对该期的评论写互斥（评论先持锁 ⇒ 删除等它提交；删除先持锁 ⇒ 评论 404）；负控：去掉事件存在性检查 ⇒「reopen 后再完成」那一格被唯一索引挡住、得到 500 ⇒ 红；检查与唯一索引都去掉 ⇒ 派生出第二期 ⇒ 红 |
| M5-c 依赖 | 29 | 自依赖 / 成环 ⇒ 422；菱形合法；重复加为空操作；两个连接同时加 A→B 与 B→A，只有一个成功，结束时图里没有环；一端无 `edit` ⇒ 404；跨 org ⇒ 404；同一用户在两个 org 都在职时，候选里不出现另一个 org 的任务；负控：去掉取锁 ⇒ 两方都成功 ⇒ 红 |
| M5-d 字段 | 30 | 闭集外的类型、config 里多出的键各 422；值引用不存在的选项 422；成员值含已离开 org 的人 422；仍有绑定时删定义 422；不在任何相关清单里的人读不到值；负控：选项比对改用 label 而非 id ⇒ 选项改名之后旧值那一格红 |
| M5-g 新表面 | 门 1 / 2 / 13 / 17 / 20 的 M5 子集 | 每条新写路由缺 org ⇒ 422（在 `rbacGuard` 之后）与跨 org 写格；每条新路由的非 admin 正格与 403 负格；两个新注册行置空 ⇒ 门 13 红；每个新 `task-*.db.test.ts` 满足门 17 ①②④；新纯函数在门 20 的行为 harness 与静态检查之下。PR-4a 没有新开关，门 18 无 PR-4a 子集 |

M5-b（附件）、M5-e（夹钳）、M5-f（导出）归 PR-4b / 4c。

### 6.3 真库文件与登记

新文件：`task-m5-g1.db.test.ts`、`task-m5-schema.db.test.ts`、`task-m5-recurrence.db.test.ts`、`task-m5-dependencies.db.test.ts`、`task-m5-fields.db.test.ts`。每个同 PR 登记三处（锁 §5.2.1：exclude 逐文件字面量、`tasks-realdb` 清单、④ 三集合相等），PR 正文写 `.each` 展开后的计数（门 17）。形状格覆盖 §2 的每一条 CHECK、外键与唯一索引各一正一反（按 §2 的约束名断言），以及 `down()` 后再 `up()`。其中点名的几格：未绑定的评论附件带评论 id ⇒ `task_attachments_comment_kind_chk` 拒绝；字段值存 JSON `null` ⇒ `task_field_values_value_not_json_null_chk` 拒绝；`recurrence_series_id = id` 的行 ⇒ `tasks_recurrence_series_not_self_chk` 拒绝；硬删一个带评论附件的任务（测试夹具里）⇒ 成功，附件行与评论行同语句删掉、触发器写出 intent（`NO ACTION` 不挡）；直接硬删那条评论 ⇒ 被 `task_attachments_comment_fk` 拒绝。非唯一索引（含 `idx_tsk_recurrence_series`、`idx_tdep_org`）按名断言存在于 `pg_indexes`，`down()` 后断言不存在。

### 6.4 回归与声明

- 最终 head 上重跑全部 `M2|`、`M3|`、`M4|` 行：PR-4a 改了 complete、增删负责人、切模式、删除四个写入点和详情、列表两种读形状。
- PR 正文首段照门 14：「含 DDL，未应用、未合并」。
- S37：PR 正文与验证记录如实写明任务域 20 张表（本 PR 新建 7 张）都不在任何 DML 普查的分母里；对这些表的直接 DML，现有 CI 一条也查不出来。

---

## 7. owner 问题

### 7.1 本文自选的取舍（`ASSUMPTION(task-m5a): [a-NN]`；缺省即冻结值）

| 编号 | 取舍 | 缺省 | 备选与代价 |
|---|---|---|---|
| a-01 | complete 的 `scope` 解析 | 严格：非法值 422 `INVALID_SCOPE` | 照 reopen 把非 `'all'` 当 `'self'`：拼错时静默只完成自己，比请求的少 |
| a-02 | 非创建人请求 `scope: 'all'` | 404 | 422 `SCOPE_NOT_ALLOWED`：调用者看得见任务时更好懂，但破坏「行级失败一律 404」的约定 |
| a-03 | G1 的事件 | `completed`，payload `{ scope: 'all' }` | payload `{}`：历史里分不出是谁替全员完成的 |
| a-04 | `any` 模式与零负责人下的 `scope: 'all'` | 与缺省同路径 | 422：调用方要先判断模式 |
| a-05 | 详情 `canCompleteForAll` | 加 | 不加：前端自己判断，会与服务端的判定分叉 |
| a-06 | 投影映射表随 PR-4a 迁移（D1） | 随 4a | 随 4c 自带迁移：4c 多一个迁移、多一次 staging 对齐；`recurrence` 只验对象（D2）同在此条 |
| a-07 | 附件行的一致性 CHECK（含「评论附件有评论 id ⇔ 已绑定」）与指向评论的组合外键（给 `task_comments` 加 `(id, task_id)` 唯一约束；外键 `NO ACTION`，不级联） | 加；`NO ACTION` | 只靠服务层：库里可能出现所属任务与评论分叉的行，或未绑定行带着不存在的评论 id；外键改 `CASCADE`：与 S19 的删评论不删附件相反 |
| a-08 | 绑定指向字段的外键 | `RESTRICT` | `CASCADE`（M4 的写法）：服务层漏查时绑定被静默删掉 |
| a-09 | 清空字段值 | 删行 | 存 JSON `null`：行存在不再等于有值 |
| a-10 | 新路由的写不动 `tasks.version` | 不动 | 递增：持旧 `version` 的 `PATCH` 会因无关写入而 409 |
| a-11 | 重复加依赖 | 200 空操作 | 422 `DUPLICATE` |
| a-12 | 依赖路由的形状（§3.4） | 一个 `POST` 收 `predecessorId` 或 `successorId`；两条 `DELETE` 按方向分路径 | `POST …/predecessors` 与 `POST …/successors` 两条 |
| a-13 | 字段取值一次一个 | 一次一个 | 批量 `{ values: {…} }`：一次保存多个字段，但一个坏值使整批失败 |
| a-14 | 错误体只有 `code` | 不带 `field` | `INVALID_RECURRENCE` 附 `field`：前端能定位，但多了一种错误体形状 |
| a-15 | 派生时离开 org 的负责人 | 过滤掉 | 整次完成 422：用户无法完成自己的任务 |
| a-16 | 序号不存列，按 `created_at` 计数 | 不存列 | 加 `occurrence_index` 列：多一列，但读起来不依赖插入顺序 |
| a-17 | 详情 `nextOccurrenceId` | 加，调用者不能 `view` 后继时为 `null` | 不加：前端「下一条」要再查；不过滤：泄露一期看不见的任务的 id |
| a-18 | 列表项加 `is_milestone` | 加 | 不加：列表上没有里程碑徽标，与 S13 不符 |
| a-19 | 删除响应加 `deletedIds` | 加 | 不加：前端不知道系列里还删了哪几期 |
| a-20 | 系列两列的一致性 CHECK 与「一期至多一个后继」唯一索引 | 加 | 只靠服务层的事件检查 |
| a-21 | 映射行存 `projected_digest` | 存 | 每次 reconcile 重算旧行的摘要：要读出 `meta_records` |
| a-22 | purge intent 的原因闭集 | 四值（含 `user_removed`） | 照审批三值：用户移除与过期清扫混在同一原因里 |
| a-23 | 迁移文件名 | `zzzz20261011090000_create_task_m5_tables.ts`，合并前重核 | — |
| a-24 | G1 的门行 | 门 3 的子集行 `M5\|3\|创建人为全员完成` | 新开一个整数门号 |
| a-25 | 字段定义的建、改、删不写事件 | 不写 | 加事件词：新 DDL 与 owner 授权（E03） |
| a-27 | `PATCH` 清空有规则任务的截止日 | 允许，之后不派生 | 422：必须先结束重复 |
| a-28 | 依赖列表里看不见的对端 | 不列、不计数 | 列出 id 不列标题：泄露存在性 |
| a-30 | 派生照抄清单项时不写清单事件 | 不写 | 写 `list_added` / `item_added`：清单动态里出现每一期的加入 |
| a-31 | 成员型字段不在候选集的码 | `NOT_A_CANDIDATE` | `INACTIVE_ORG_MEMBER`（与负责人校验同码） |
| a-33 | 系列第一期的截止日已清空时（锚点为空）后一期完成 | 不派生（`no_due_date`），完成照常 | 退回用本期截止日作锚点：系列继续，但按月日的步进可能偏离第一期定下的日子 |
| a-34 | 分页读的排序键；两条有上限的读不分页 | 候选 `created_at DESC, id ASC`；字段定义 `created_at ASC, id ASC`；依赖列表与清单绑定不分页、不带 `total` | 按标题或名称排序：要定排序规则（collation）；两条有上限的读也套分页：前端多一层翻页 |
| a-35 | 详情里 `seriesId` / `previousOccurrenceId` 不按 `view` 过滤；`NOT_CURRENT_OCCURRENCE` 也透露了存在更晚的一期 | 照 `parentId` 的先例不过滤（指向本行自己记录的更早一期） | 过滤：看不见第一期的人拿不到系列 id，详情的系列导航断开 |
| a-32 | 没有纯函数 reason 对应、由本文命名的码与规则：`INVALID_DEPENDENCY`、`INVALID_DIRECTION`、`INVALID_FIELD`、`INVALID_BINDING`、`INVALID_SCOPE`；候选的 `q` 按标题包含匹配（不区分大小写） | 如左 | 改名或合并为一个 `INVALID_BODY`：前端少几个分支，但定位不到哪个参数错了 |

（编号 a-26、a-29 预留未用：起草时归入已裁的 S05 与 S09，不再是自选。a-33–a-35 是审阅后新增。）

### 7.2 影响 PR-4a 的既有未决项

- **任务 E §7 问题 1（重复的锚点）**：本文按缺省 (a) 冻结（锚点 = 系列第一期当前的 `due_date`，§2.10）。若 owner 取 (c)，或取问题 1 (iii) 的备选（换规则时重设锚点与计数起点），需要存锚点或计数起点：规则闭集加键（S14 改动）或本迁移加列。**因此在问题 1 落槌之前，§2 的冻结对 `tasks` 的列集合是有条件的**；其余表不受影响。取 (b) 不改表。
- **任务 E §7 问题 3（`count` 越界的码）**：缺省 `INVALID_RECURRENCE`；取 D18 则超过 365 答 `LIMIT`，只改 §3.2 的码表与一格。
- **任务 E §7 问题 2（导出时区）**：只影响 PR-4c。
- **任务 E 与已裁取值的四项偏离（X1–X4，#6249 正文「与已裁取值的偏离」第 1–4 项）**：X1（S05 混合清单里不带时刻的开始）、X2（S10 / D11 导出数值格）只影响 PR-4c；X4（S18 文本类附件的内容判定与每任务上限的计数口径）只影响 PR-4b。**X3（S11 依赖候选另排除会成环的任务）改变 §3.4 候选接口的结果集**：本文按 #6249 的现行代码（排除）冻结；owner 若取 A（只排除自身与已有边），只改候选结果，不改接口形状。
- **任务 E 的 `planSpawn` 两处失败形（审阅后补记）**：① 它先校验时区与锚点、后判 `no_due_date`，所以截止日与时区都已清空、或锚点为空的输入会抛 `TypeError`，而 §3.2 认定这两种状态是「不派生」。PR-4a 的服务层第 2、3 步不把它们交给 `planSpawn`，所以不依赖 #6249 改顺序；#6249 若把 `no_due_date` 的判断提到校验之前，只是多一道保险。② 下一期截止日越过 `9999-12-31` 时 `nextOccurrenceDueDate` 抛 `RangeError`；§3.2 第 4 步要它返回 `series_ended`，这一处必须改在 #6249（或按 §4.1 由 PR-4a 改那一行）。
- **D 编号**：本文用到的 D1、D2、D3、D4、D10、D13、D17、D18 都没有被点名，是缺省约束；owner 若认为它们随对应的 S 编号一并获准，需要点名。

### 7.3 锁与合并

- 候选门 27、29、30 与 G1 的子集行写进锁 §12 `arm-set` 的那次修订：由哪张 PR 承载、何时提交，请 owner 点名（S31 已定内容，未定载体）。
- 合并顺序：#6249 → PR-4a → {PR-4b, PR-4c}；每张都需要 owner 单独的合并点名（锁 §14-5）。PR-4a 的迁移名必须排在合并那一刻 main 上最晚的迁移之后，届时重核（`[a-23]`）。

---

## 8. 审阅处置

独立审阅的结论与逐条处置记在这里，被拒绝的意见各附一行理由。

### 8.1 第 1 轮（2026-10-10，冻结稿 v1 → v2）

收到的意见清单在交付时被截断：确认项读到两条 P2，次要项读到第 (d) 条中途为止。下表只处置读到的部分；截断之后若还有条目，下一轮补处置。

| # | 级别 | 意见 | 处置 |
|---|---|---|---|
| 1 | P2 | `tasks.recurrence_series_id` 没有索引，系列读要含已软删的期，既有部分索引用不上；`down()` 写「两个索引」与 `up()` 不符 | 采纳：§2.2 加 `idx_tsk_recurrence_series`，§2.11 按名删除，§6.3 加存在性格；`[a-16]` 的 `created_at` 计数保留 |
| 2 | P2 | 有规则任务清空截止日（与时区）后完成，`planSpawn` 先校验后判 `no_due_date`，抛错 ⇒ 500；越过 `9999-12-31` 同类 | 采纳并扩大：§3.2 冻结四步判定顺序（截止日为空、锚点为空都不进 `planSpawn`；越界 ⇒ `series_ended`），新增 `[a-33]`；§4.1 / §7.2 记 #6249 一处改动；M5-a 加各调用点的格 |
| 3 | P3 | 切片 1 的 G1 格断言 payload，而 payload 支持排在切片 2（两条意见同指） | 采纳：`writeEvents` 的 payload 移入切片 1，保留 PR-3b 的返回形状（§1.3、§4.1、§4.4） |
| 4 | P3 | `task_dependencies` 没有按 org 的索引 | 采纳：§2.3 加 `idx_tdep_org (org_id)` |
| 5 | P3 | 未绑定的评论附件可带不存在的评论 id；评论外键 `CASCADE` 与 S19 相反 | 采纳：§2.7 的评论附件 CHECK 改为「有评论 id ⇔ 已绑定」，外键改 `NO ACTION`；`[a-07]` 改写；§6.3 加格 |
| 6 | NIT | 字段值可存 JSON `null` | 采纳：`task_field_values_value_not_json_null_chk` |
| 7 | NIT | 缺 `CHECK (recurrence_series_id <> id)` | 采纳：`tasks_recurrence_series_not_self_chk` |
| 8 | NIT | 约束名未冻结；`down()` 不是严格逆序 | 采纳：§2.1 定命名规则、§2.2–§2.9 逐条写名；§2.11 写出 `up()` 顺序与严格逆序的 `down()` |
| 9 | NIT | 投影映射键列没有 id CHECK；投影开启的推导方式未写 | 采纳：§2.9 加两条四合取 CHECK，并写明开启状态按 S04 推导、PR-4c 不加列 |
| 10 | NIT | 系列自引用外键 `NO ACTION` 约束以后的保留期作业 | 采纳：§2.2 写明整链删除的要求 |
| 11 | NIT | 基线漂移：PR-3b 已在 main，返回形状与翻转行号已变 | 采纳：头部补记新 ref 与行号，§1.3、§4.4、§4.6 改为 PR-3b 已在 main。拒绝其中「现在就 rebase」的部分：本轮只在分支上追加提交，rebase 按 owner 2026-10-09 第 6 项在实现开工时做 |
| 12 | P3 | 新的按 org / 按系列 / 含软删的读没有点名 builder；`[own-3b-17]` 需要改写 | 采纳：新增 §4.7 的三个 builder 与同 PR 改写 `[own-3b-17]`；M5-c 加两 org 用户的候选格。M3 既有的两处手写条件不在本 PR 改（§4.7 末句） |
| 13 | P3 | `nextOccurrenceId` 不按 `view` 过滤 | 采纳：§3.8 改为不能 `view` 时为 `null`，`[a-17]` 改写；`seriesId` / `previousOccurrenceId` 照 `parentId` 先例不过滤，登记为 `[a-35]` |
| 14 | P3 | 系列删除没有扩展 M3 的行锁协议，也没有为每一期入队 `deleted` | 采纳：§3.8 冻结四步执行（按 id 升序的有界 `FOR UPDATE`、经 producer 入队）；M5-a 加格 |
| 15 | P3 | 路由合同缺：(a) 两条读不分页未标注；(b) 分页读无稳定排序键；(c) 字段路由的检查顺序；(d) 单 id 下的读缺 org 时属于哪一类 | 采纳：§3.0 标注两条有上限的读不分页、写明缺 org 的分类（(d) 的原文被截断，按 PR-3a `[own-19]` 的口径补全）；§3.4 / §3.5 写排序键；§3.6 / §3.7 写检查顺序；新增 `[a-34]` |
