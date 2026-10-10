# 任务功能 M5 后端 PR-4a 设计：表结构与接口冻结（DRAFT，2026-10-10）

> **状态：DRAFT（冻结稿 v3：第 1 轮独立审阅的处置见 §8.1 与 §8.2）。** owner 2026-10-10 裁定：现在开始 M5，先冻结 PR-4a 的表结构与接口，再在其上并行起草 PR-4b、PR-4c 与前端；只开 Draft，不合并、不应用 DDL。本文就是这份冻结：§2 的 DDL 与 §3 的接口一经独立审阅通过，PR-4b / 4c / FE-d / FE-e 以它为准起草；要改形状，先改本文再改实现。本文不授权合并、DDL 应用、staging 部署或打开任何 `TASKS_*` 开关。

- **基线**：`origin/main` `9bbbdb29e3`（2026-10-10，冻结稿 v3 重定）。M4 的 PR-3a（#6266）、PR-3b（#6281）与锁 R01 增补（#6248）已在 main；PR-3c（#6269，红点实时信号）与 M4 前端（#6265）在合并列车上，尚未进 main（PR-3c 落地后系列删除怎样接它见 §3.8）。本文的代码行号都指 `9bbbdb29e3`，实现开工时按当时 main 重核。
- **基线沿革**：冻结稿 v1、v2 的基线是 `98cbca16ec`。PR-3b（#6281）在其后合入（`d2c33b8426`）：`writeEvents` 改为返回 `WrittenTaskEvent[]`，每个写事件的调用点同事务调用 `enqueueTaskEventNotifications`。冻结稿 v3 把全文行号重钉到 `9bbbdb29e3`；PR-4a 分支起草时从当时 main 起。
- **依赖**：任务 E 的纯函数层（#6249，Draft，head `39a2a29be9`）。PR-4a 的服务层直接调用其中的 `task-recurrence` / `task-dependencies` / `task-milestone` / `task-fields` / `task-civil-date`，所以 PR-4a 堆叠在 #6249 之上起草，合并顺序是 #6249 在前（§1.3）。附件与投影两个纯模块由 PR-4b / 4c 调用，PR-4a 只按它们的类型定表（§2.10）。
- **锁**：`docs/development/task-feature-design-lock-20260917.md`（main 版）。§4.2 的 P2 表名、§4.1 的两类非空约束、§6.4 的锁协议、§7 的投影边界、§11 的 M5 行、§12 `arm-set` 里的五条 `M5|` 行都按锁执行。
- **裁定的引用口径**：只写条目编号与日期。M5 裁决包的 S01–S37 于 owner 2026-10-09 裁定取推荐值（含 S32 第二句：PR-4a / 4b / 4c 按 4a → {4b, 4c} 的顺序起 Draft）；同日 owner 裁定的六项里，第 3 项（锁 §2 承重两项的归属）与第 6 项（M5 的起草方式）直接约束本文；M4 裁决包的 R01–R23、N1、N2 于 owner 2026-10-07 裁定。裁决包的 E 编号是它列出的「锁已定」条目，D 编号是闸方给的缺省实现约束——**D 编号没有被任何一次裁定点名**，本文用到时一律标 `ASSUMPTION`。裁决包是私有件，本文不引其原文。
- **标签**：已裁条目在代码里标 `RULED(<日期>): [Sxx]` / `[Rxx]`；本文自选的取舍标 `ASSUMPTION(task-m5a): [a-NN]`，每一条在 §7 有缺省值、备选与 owner 问题编号。

---

## 0. 结论摘要

1. **第一片是 G1「创建人为所有负责人完成」**（owner 2026-10-09 六项之第 3 项：放在 PR-4a 的第一片，先于重复任务的派生）。它不需要 DDL：`POST /api/tasks/:id/complete` 新增可选 `scope: 'all'`，只对任务创建人（`tasks.created_by`，直接角色）开放；任务已完成时重复调用是空操作、不写事件（§3.1、§5）。
2. **一个迁移装下 M5 的全部 DDL**：`tasks` 加 4 列，新建 7 张表（依赖、字段三表、附件两表、投影映射）与附件行删除触发器（§2）。附件两表与触发器随 PR-4a 是 S30 ③ 的已裁取值；投影映射表也放进来是 D1 的缺省（`ASSUMPTION`，§7 [a-06]），这样 PR-4b、PR-4c 都不带 DDL，可以在冻结后并行起草。
3. **接口**：PR-4a 新增 16 条路由（重复 1、里程碑 1、依赖 5、字段定义 4、字段绑定 4、字段值 1），改动 5 条既有路由的形状（complete 的请求体、详情、`GET /api/tasks` 与清单任务项两条列表读、删除；待办 `/api/tasks/pending` 不改，§3.8），全部挂在 `TASKS_ENABLED` 的同一个 `tasksRouter()` 上，**不新增任何 `TASKS_*` 读点、不新增开关**（§3）。
4. **锁**：所有写走 `withOrgStructure`；S09 已裁的锁序包装器 `withTaskLockOrder` 在 PR-4a 落地并首次武装 `M5|7|锁序控件`，不新增第四处取锁字面量；生产上取结构锁的两处（`withOrgStructure`、`createTask`）与取调度 leader 锁的一处都改经包装器，正向格因此记录得到真实的取锁序列（§4.2、§6.1）。
5. **门**：PR-4a 承载既有 `M5|7|锁序控件` 与 `M5|10|P2子集` 中属于它的格，以及候选门 27（重复）、29（依赖）、30（字段）和 G1 的候选子集行；候选行要等锁修订写进 `arm-set` 才计分（§6）。
6. **仍待 owner 的**：本文自选 37 项（§7.1；a-11 已收回）；任务 E 的三个问题与四项偏离里影响 PR-4a 的部分（§7.2）；候选门行入锁的那次修订（§7.3）；冻结稿 v3 新增的 4 个问题 Q1–Q4（§7.4）。

---

## 1. 范围与切片

### 1.1 做

1. G1：创建人为所有负责人完成（无 DDL，§3.1、§5）。
2. 一条迁移：`tasks` 的 P2 列与 7 张 P2 表、触发器、索引（§2）。
3. 重复任务：设 / 清规则、完成翻转时派生下一期、系列删除（S14–S17、S35）。
4. 里程碑开关（S13）。
5. 依赖：加边、删边、列出、候选（S11、S12）。
6. 自定义字段：定义、清单绑定、任务取值三层（S24–S28）。
7. 既有响应的增补：详情（里程碑、重复、系列链、依赖、字段值、`canCompleteForAll`）、两条列表读的列表项（`is_milestone`；待办 `/pending` 不加，§3.8）、删除（系列删除时列出删了哪些）。
8. `TASK_ID_PREFIXES` 加 `field: 'tfld'` 与 `attachment: 'tatt'`（S30 ②；任务 E 的 `task-projection.ts` 里暂时写死的 `tfld_` 改为从这里派生）。
9. 锁序包装器与它的门格（S09）。

### 1.2 不做（归属）

- 附件的存储、上传、下载、移除、评论绑定、GC、`attachment_added` 通知（PR-4b；表已在本迁移）。
- 投影的 provisioning、reconcile、夹钳、deny sibling、sweep、导出（PR-4c；映射表已在本迁移）。
- 前端 FE-d / FE-e / FE-f。
- 富文本（S29：M5 不做，`description_rich` 不建）；cursor 分页（S34）；依赖阻断完成（S12：不阻断）；任务域 DML 普查闸（S37：不建，PR 正文如实声明）。
- 任务内历史与跨任务动态（owner 2026-10-09 六项之第 5 项：M5 之后单独补齐 / 继续后置）。本文新写的事件 payload 只放闭集键名与任务域 id（任务 id、字段 id），不放标题、取值之类的业务内容；那次交付读到这些 id 时仍要校验可见性（§4.4）。
- 状态筛选核心（同日第 3 项的后半：M4 之后单独交付、先于 FE-e），不在 PR-4a。

### 1.3 切片顺序（依赖）

开工前提：分支从当时的 `origin/main` 起，叠上 #6249。PR-3b 已在 main（见头部的基线漂移）；PR-4a 不用 `TaskScheduler`（§4.6），但每个新写事件的调用点都照 PR-3b 的写法同事务入队（§4.4）。

| 切片 | 内容 | 依赖 | 回归 |
|---|---|---|---|
| **1** | G1：`applyCompleteForAll` 与 `canCompleteForAll` 两个纯函数（`src/tasks/`），`TaskCompletionEvent` 加可选 `payload`、`writeEvents` 写入它（缺省 `{}`，`task_events.payload` 列已存在，不碰 DDL；保留 PR-3b 的 `WrittenTaskEvent[]` 返回形状），`completeTask` 收 `scope`，路由解析 `scope`，详情加 `canCompleteForAll`；真库文件 `task-m5-g1.db.test.ts` | 无（不碰 DDL） | `M2\|3`、`M3\|3` 重跑 |
| 2 | 迁移（§2）、`TASK_ID_PREFIXES` 两个前缀、锁序包装器（并把 `withOrgStructure`、`createTask` 与调度 leader 的取锁改经它，§4.2）、形状格 `task-m5-schema.db.test.ts` | 1 | 全部 `M2\|`、`M3\|`、`M4\|` 行（每条结构写与调度 tick 的取锁都改经包装器） |
| 3 | 重复：`PUT /recurrence`、三处翻转调用点的派生钩子（含切片 1 的 G1 路径）、系列删除、详情的系列字段 | 2 | `M2\|3`、`M3\|3`、`M3\|6` |
| 4 | 里程碑与依赖（含 `M5\|7\|锁序控件` 首次武装） | 2 | `M3` 设父格（同用结构锁） |
| 5 | 字段三层（含 §4.7 的字段 builder 模块）、详情 `fieldValues` | 2 | `M4\|19\|清单角色`、`M4\|1\|清单第二租户` |
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

唯一需要服务层换算的是序号：`planSpawn` 要当前实例在系列里的 1 起序号，本迁移**不存序号列**。服务层在结构锁内数「系列第一期本身 + 同系列、`created_at` 不晚于当前实例的各期」（含已软删的期；经 `idx_tsk_recurrence_series`，查询条件经 §4.7 的系列 builder），派生总在上一期完成之后、在另一个事务里插入，所以 `created_at` 的先后就是链的先后（`[a-16]`）。锚点（系列第一期的 `due_date`）在同一锁内按 id 读出，第一期可能已软删，所以经既有的 `buildTaskByIdAnyStateCondition`（§4.7）；锚点为空时不派生（§3.2 第 3 步）。任务 E §7 问题 1 若取 (c) 或 (iii) 的备选，要存锚点或计数起点，那是本迁移之外的新列——见 §7.2。

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
- 成功体 camelCase，时间是 ISO-8601 或 `null`；`GET /api/tasks` 与清单任务项两条列表读沿用 M2 的 snake_case 行（§3.8 加一列）；待办 `/api/tasks/pending` 的项是 camelCase 的 PendingItem，不属于这一类，本 PR 不改（§3.8）。

### 3.1 G1：`POST /api/tasks/:id/complete`

| 项 | 冻结值 |
|---|---|
| 请求体 | 可选 `{ scope?: 'self' \| 'all' }`；缺省 = `'self'`（与今天完全相同） |
| `scope` 校验 | 严格：出现 `scope` 且不是 `'self'` / `'all'` ⇒ 422 `INVALID_SCOPE`（`[a-01]`）。排在行级判定之后 |
| `'all'` 的调用者 | 只有任务创建人：纯谓词 `canCompleteForAll({ actorId, createdBy })` 只比较 `actorId === createdBy`，不接收角色集，清单身份传不进来（与 `canChangeTaskMembers` 同一做法）；负责人、清单可编辑者、关注人一律 404（`[a-02]`） |
| `'all'` 的效果 | `all` 模式：所有 `completed_at` 为空的负责人行取同一个 `now`，已有的完成时刻保留；任务翻为 done，`version + 1`。`any` 模式与零负责人：与 `'self'` 同一路径（这两种情况下创建人的完成本来就作用于整个任务，`[a-04]`） |
| 已完成时 | 空操作：200 `{ done: true, version }`，`version` 不变，不改行、不写事件（`applyComplete` 现有的 `wasDone` 规则） |
| 事件 | 翻转时一条 `completed`，actor = 创建人，payload `{ "scope": "all" }`（`[a-03]`）；`completed` 已在 `TASK_NOTIFIABLE_EVENTS`（`task-notifications.ts:39`），照 PR-3b 的写法同事务入队、照常通知，不改闭集；它的时刻见 `[a-37]` |
| 成功体 | `{ done, version }`（不变） |
| 错误 | 404；422 `ORG_MISSING`、`INVALID_SCOPE` |

判定顺序（锁后）：取任务（404）→ 角色集与 `canChangeCompletion(roles, 'complete', n)`（404）→ 解析 `scope`（422）→ `scope === 'all'` 时 `canCompleteForAll`（404）→ 纯函数 → 写。

`reopen` 不变：它已有 `scope=self|all`（`routes/tasks.ts:196` 把非 `'all'` 一律当 `'self'`），本文不动它的解析，两条路由的 `scope` 解析严格程度因此不同，列为 owner 问题（`[a-01]`）。

### 3.2 重复：`PUT /api/tasks/:id/recurrence`

| 项 | 冻结值 |
|---|---|
| 码 / 行级 | write；`can(roles, 'edit')`（S35：持 `edit` 者，即创建人、负责人、清单可编辑者；授权格见 §6.2.1） |
| 请求体 | `{ recurrence: Rule \| null }`；`Rule` 是 S14 的闭集（`freq` / `interval` / `byWeekday` / `byMonthDay` / `end`），由 `parseRecurrenceRule` 解析与规范化 |
| 设规则 | 任务没有截止日 ⇒ 422 `DUE_REQUIRED`；规则不合法 ⇒ 422 `INVALID_RECURRENCE`（先校验规则、再查截止日，任务 E 的自选）；与现值规范化后相同 ⇒ 空操作；否则写列、事件 `recurrence_set` |
| 清规则（`null`） | 已无规则 ⇒ 空操作；不是系列里最新且未完成的一期 ⇒ 422 `NOT_CURRENT_OCCURRENCE`（「最新」= 没有未软删的后继，与 §3.8 的 `nextOccurrenceId` 同一口径）；否则清列、事件 `recurrence_cleared`（S17 (a)） |
| 成功体 | `{ id, recurrence, seriesId, previousOccurrenceId }` |
| 错误 | 404；422 `ORG_MISSING`、`INVALID_RECURRENCE`、`DUE_REQUIRED`、`NOT_CURRENT_OCCURRENCE` |

`count` 越界答 `INVALID_RECURRENCE`，不答 `LIMIT`（任务 E §7 问题 3 的缺省，§7.2）。

**派生**（S15、S16、D3）：在三个把任务从 open 翻成 done 的调用点上——`completeTask`（`services/task-records.ts:647`，含 §3.1 的 G1 路径）、`removeAssignee`（`services/task-structure.ts:357`，翻转在 `:374`）、`switchCompletionMode`（同文件 `:418`，翻转在 `:436`）——同一事务、同一把结构锁里，在写入翻转之后调用同一个服务函数 `spawnNextOccurrenceIfDue(db, …)`。它读的是翻转写入之后的行：负责人集合与完成模式都取翻转之后的值（`removeAssignee` 删掉的人不进新一期）。它按下面「派生的判定顺序」走到 `planSpawn`，再用独立的插入函数写入新一期的任务行，以及它的负责人（`completed_at` 为空）、关注人、所属清单、字段取值和两条事件，不经 `createTask`（它自开事务并再次取锁）。新一期的行与两条事件用翻转调用点已在锁内取好的同一个 `now`（`[a-37]`）。`addAssignee`（`:321`，翻转在 `:349`）是 done → open 方向，不派生。

- 一次性守卫：锁内查本任务是否已有 `recurrence_spawned` 事件（D3）；库里再有 §2.2 的唯一索引兜底。reopen 之后再完成不派生第二次。
- 新一期的日期与提醒（E05、S16）：新的 `due_date` 由 `nextOccurrenceDueDate` 算出，`start_date` 与它顺延相同的民用天数，`due_time`、`start_time`、`time_zone` 照抄，`due_at` 用 `computeDueAt` 重算。`remind_at`：上一期有提醒 ⇒ 新一期保持相对新 `due_at` 的同一提前量；上一期没有 ⇒ 按系列创建人的 `default_remind_policy` 经 `computeDefaultRemindAt` 计算（任务 E `planSpawn` 返回的两种指示）。新一期的 `created` 事件就是它的提醒下界，PR-3b 的扫描据此判断是否该提醒。
- 派生的人员（`[a-15]`）：新一期的负责人、关注人，以及成员型字段取值里的每个用户 id，都过同一个在职判定：R17 / N2 对负责人与关注人、S25 对成员型取值定的都是它，即 `services/task-org-members.ts` 的 `findActiveOrgMembers`。锁内对「负责人 ∪ 关注人 ∪ 成员型取值里的 id」只查一次。不在职的 id 不写进新一期：不写它的负责人行、关注人行；成员型取值去掉这些 id，去掉后为空则新一期没有这一字段的取值行（与 `[a-09]` 一致）。哪些取值是成员型按字段定义判断，定义经 §4.7 的字段 builder 读出。加关注人时调用者本人免查（PR-3a 的 `[own-16]`），这一条不适用于派生：照抄来的每个 id 都要查。去掉的 id 不写事件，也不让完成失败，完成照常 200。直接写入路径对同一判定答 422（§3.7、M3 加关注人）；派生改为去掉，因为它没有一个能改请求体重试的调用者。`task-org-members.ts` 头注的调用方清单在同一 PR 加上派生。
- 派生的清单项与字段值照抄（成员型取值按上一条过滤），不写 `list_added` / `item_added` 事件（任务 E `planSpawn` 只给两条事件；`[a-30]`）。
- 派生不发通知（S33）：新任务的 `created` 不在可通知闭集里。
- `PATCH` 清空有规则任务的截止日不拒绝（`[a-27]`）；之后它完成时不派生。下面的顺序保证这种状态只是「不派生」，不会让完成失败。

**派生的判定顺序**（冻结）：

1. `shouldSpawnOnFlip` 为假 ⇒ 不派生。
2. 本期 `due_date` 为空 ⇒ 不派生（结果记 `no_due_date`），**不调用 `planSpawn`**。截止日与时区一起被清空（`planTaskDates` 在不剩任何日期时接受空时区，P0-A 的 `tasks_time_zone_when_dated_chk` 也允许）必然落在这一步，因为有日期就一定有时区。
3. 读锚点：系列第一期的当前 `due_date`（本期没有 `seriesId` 时就是本期，第 2 步已保证非空）；第一期可能已软删，按 id 经既有的 `buildTaskByIdAnyStateCondition` 读（§4.7）。锚点为空（有人清空了第一期的截止日）⇒ 不派生（结果记 `no_due_date`，`[a-33]`）。
4. 数序号（§2.10），调用 `planSpawn`。下一期截止日越过民用日期上限（`9999-12-31`）⇒ 按 `series_ended` 处理、不派生；这要 #6249 的 `planSpawn` 把越界当作 `series_ended` 返回，而不是让 `nextOccurrenceDueDate` 抛 `RangeError`（§4.1、§7.2）。

「不派生」在三个调用点与 G1 路径上都不影响翻转本身：完成照常 200、照常写 `completed` 等事件。任务 E 现行的 `planSpawn` 先校验时区与锚点、后判 `no_due_date`，第 2、3 步的情形若直接交给它会抛 `TypeError`、整次完成 500 并回滚——第 2、3 步就是为了不把这两种状态交给它。

### 3.3 里程碑：`PATCH /api/tasks/:id/milestone`

write；`can(roles, 'edit')`（S13；授权格见 §6.2.1）；请求体 `{ isMilestone: boolean }`，只收真布尔值，否则 422 `INVALID_MILESTONE`；同值空操作；否则事件 `milestone_set` / `milestone_cleared`。不要求截止日（S13）。成功体 `{ id, isMilestone }`。

### 3.4 依赖

| 方法 路径 | 码 | 行级 | 请求 | 成功 200 | 错误 |
|---|---|---|---|---|---|
| `GET /api/tasks/:id/dependencies` | read | 本任务 `view` | — | `{ predecessors: DepItem[], successors: DepItem[] }` | 404 |
| `POST /api/tasks/:id/dependencies` | write | 两端都 `can(roles,'edit')` 且同 org 且都未软删（S11；`roles` 是含清单身份的完整角色集） | 恰一个键：`{ predecessorId }`（加 `predecessorId → :id`）或 `{ successorId }`（加 `:id → successorId`）；路由形状见 `[a-12]` | `{ predecessorId, successorId }` | 404；422 `ORG_MISSING`、`INVALID_DEPENDENCY`、`SELF`、`DUPLICATE`、`CYCLE`、`LIMIT` |
| `DELETE /api/tasks/:id/dependencies/predecessors/:otherId` | write | 同上（两端 `edit`） | — | `{ predecessorId, successorId }` | 404；422 `ORG_MISSING` |
| `DELETE /api/tasks/:id/dependencies/successors/:otherId` | write | 同上 | — | 同上 | 同上 |
| `GET /api/tasks/:id/dependency-candidates` | read | 本任务 `edit` | query `direction=predecessor\|successor`（必填）、`q`（可选，按标题包含匹配，不区分大小写，`[a-32]`）、`limit` `offset`；按 `created_at DESC, id ASC` 排序（`[a-34]`） | `{ items: [{ id, title, status }], total }` | 404；422 `INVALID_DIRECTION`、分页 |

- `DepItem` = `{ id, title, status, dueAt, isMilestone, canRemove }`，只列调用者能 `view` 的对端；`canRemove` = 调用者对两端都有 `edit`，用删边路由的同一个 `canManageDependency` 算出（`[a-12]`）；看不见的对端不列出、也不计数（与 M3 详情里的子任务同一规则，`[a-28]`）。
- 判定顺序（锁后）：本任务取行与 `edit`（404）→ 请求体恰一个键且 id 过四合取（422 `INVALID_DEPENDENCY`）→ 对端取行（同 org、未软删；取不到 ⇒ 404）→ `canManageDependency`（两端的完整角色集与同 org；假 ⇒ 404）→ `validateAddDependency`：`cross_org` ⇒ 404，`self` ⇒ 422 `SELF`，`duplicate` ⇒ 422 `DUPLICATE`，`limit` ⇒ 422 `LIMIT`，`cycle` ⇒ 422 `CYCLE`（纯函数按这个先后判定）。重复加边答 422 是 S31 采纳的候选 M5-c 格定下的：自依赖、重复、成环三者都是 422；码按 §3.0 的规则取任务 E reason 的大写。删边时边不存在仍是空操作（该格没有涉及）。
- 加边时锁内读出本 org 两端都未软删的全部边（D4；经 §4.7 的 org 边 builder 与 `idx_tdep_org`），纯函数判环（允许菱形）；事件两端各一条 `dependency_added`，payload 带对端 id（S11）。删边同形 `dependency_removed`；边不存在 ⇒ 空操作。
- 候选：只返回调用者能编辑、同 org、未软删的任务（org 条件经 §4.7 的候选 builder，不手写），排除自身、两端之间任一方向已有边的任务，以及加上后会成环的任务（最后一类是任务 E 的偏离，§7.2 X3）；父子关系不排除；不按上限过滤。
- 每任务前置加后置至多 50（D18），超出 422 `LIMIT`。

### 3.5 字段定义

`Field` = `{ id, type, name, config, createdBy, createdAt, updatedAt }`。

| 方法 路径 | 码 | 行级 | 请求 | 成功 200 | 错误 |
|---|---|---|---|---|---|
| `GET /api/task-fields` | read | — | query `limit` `offset`；按 `created_at ASC, id ASC` 排序（`[a-34]`） | `{ items: Field[], total }`：调用者可复用的字段 = 自己建的 ∪ 绑在调用者能编辑的清单上的（S24），两半都只在会话 org 内（§4.7 的字段 builder） | 422 分页 |
| `POST /api/task-fields` | write | — | `{ type, name, config? }` | `Field` | 422 `ORG_MISSING`、`INVALID_TYPE`、`INVALID_NAME`、`INVALID_CONFIG`、`LIMIT` |
| `PATCH /api/task-fields/:id` | write | `canManageFieldDefinition`：创建者，或在任一绑定了它的清单上是 edit/owner（S26） | `{ name?, config? }`；请求体里出现 `type` 键（不论值与现值是否相同）⇒ 422 `INVALID_TYPE`（类型不可改）；这一判定在调用 `parseFieldDefinition` 之前，传给它的类型是库里的现值 | `Field` | 404；422 同上 |
| `DELETE /api/task-fields/:id` | write | `planDeleteFieldDefinition`：只有创建者；非创建者 ⇒ 404，先于绑定数判定 | — | `{ id, deleted: true }` | 404；422 `FIELD_IN_USE` |

- 每 org 定义至多 200、每字段选项至多 100（D18，超出 `LIMIT`）；选项 id 由服务端生成 `opt_<随机>`。
- 定义的建、改、删不写事件：两个事件闭集里都没有对应的词（`[a-25]`）。删除定义时它的值随外键一并删除，也不写 `field_value_changed`。
- 改定义不动已存的取值（`[a-38]`）：删掉选项、调低 `maxLength`、把成员型的 `single` 改为真，都不改写、也不拒绝已存的取值；读取照存值返回，下一次写这个取值时按当前定义校验；PR-4c 投影时，选项 id 已不在定义里的格按空值投影。`task_fields` 没有版本列，两人同时改同一个定义时后写的覆盖先写的。
- 授权格见 §6.2.1。

### 3.6 清单的字段绑定

| 方法 路径 | 码 | 清单能力 | 请求 | 成功 200 | 错误 |
|---|---|---|---|---|---|
| `GET /api/task-lists/:id/field-bindings` | read | 清单成员 | — | `{ items: [{ fieldId, position, hidden, field: Field }] }`，按 `position, fieldId` 排序 | 404 |
| `POST /api/task-lists/:id/field-bindings` | write | 清单 edit/owner（`canBindField`） | `{ fieldId }`；该字段须在调用者可复用的集合里（同 §3.5 的 `GET`），否则 404 | 同 `GET` 的单项 | 404；422 `ORG_MISSING`、`INVALID_FIELD`、`LIMIT` |
| `PATCH /api/task-lists/:id/field-bindings/:fieldId` | write | 同上 | `{ position?, hidden? }`（至少一个；`position` 是 0..49 的整数，即每清单绑定上限 50 减一（D18），越界或非整数 ⇒ 422 `INVALID_BINDING`，不让超出 `integer` 列的值落到库里；`hidden` 布尔；`[a-32]`） | 同上 | 404；422 `ORG_MISSING`、`INVALID_BINDING` |
| `DELETE /api/task-lists/:id/field-bindings/:fieldId` | write | 同上 | — | `{ listId, fieldId }` | 404；422 `ORG_MISSING` |

- 判定顺序（锁后，与 §3.4 同形）：清单取行与能力（404）→ 请求体（`POST`：`fieldId` 过四合取，否则 422 `INVALID_FIELD`；`PATCH`：形状不对 ⇒ 422 `INVALID_BINDING`；路径里的 `:fieldId` 不可打印 ⇒ 发 SQL 之前 404）→ 字段取行：`POST` 要求字段在调用者可复用的集合里，`PATCH` 要求它已绑在本清单上，否则 404 → 已绑空操作与上限（422 `LIMIT`）。
- 已绑 ⇒ 空操作；未绑而删 ⇒ 空操作。每清单绑定至多 50（D18）。
- 绑与解绑写 `task_list_events` 的 `field_bound` / `field_unbound`（payload `{ fieldId }`）；调顺序与显隐不写事件（S05：没有词的动作不写事件）。解绑不删值（S26）。
- 清单归档不影响这四条路由（归档只改清单列表的缺省过滤，PR-3a §3.2）。
- 授权格（含可复用集合这道门槛）见 §6.2.1。

### 3.7 任务的字段取值：`PUT /api/tasks/:id/field-values`

write；行级 = 任务 `can(roles,'edit')` **且** 该字段绑在包含此任务的某张清单上（`canWriteFieldValue`），任一不满足 404。判定顺序（锁后，与 §3.4 同形）：任务取行与 `edit`（404）→ 请求体 `fieldId` 过四合取（422 `INVALID_FIELD`）→ 字段取行与 `canWriteFieldValue`（404）→ 值校验（下列各 422）。请求体 `{ fieldId, value }`，一次一个字段（`[a-13]`）；`value` 为 `null` 或 `''` ⇒ 清空（删行）。值的错误：422 `INVALID_FIELD`（id 不合格）、`INVALID_VALUE`、`NOT_IN_OPTIONS`、`INACTIVE_ORG_MEMBER`、`TOO_LONG`、`OUT_OF_RANGE`、`LIMIT`。成员型的候选集 = 本 org 在职成员（S25；R17 的 helper），不在候选集 ⇒ 422 `INACTIVE_ORG_MEMBER`，与加负责人、加关注人同一个码：任务 E 的 `not_a_candidate` 由路由映射成它（`[a-31]`）。授权格见 §6.2.1。同值空操作；否则事件 `field_value_changed`（payload `{ fieldId }`）。成功体 `{ taskId, fieldId, value }`。

### 3.8 既有响应的增补

**详情 `GET /api/tasks/:id`**（全部在 `view` 判定之后组装）：

- `isMilestone: boolean`；`recurrence: Rule | null`；`seriesId: string | null`；`previousOccurrenceId: string | null`；`nextOccurrenceId: string | null`（同 org、未软删、**且调用者能 `view`** 的后继，否则 `null`：它是反向查找，与子任务、`DepItem` 用同一过滤规则；`[a-17]`、`[a-28]`）。`seriesId` 与 `previousOccurrenceId` 是本行自己的列、指向更早的期，照 `parentId` 的先例不过滤（残留登记为 `[a-35]`）。
- `dependencies: { predecessors: DepItem[], successors: DepItem[] }`（同 §3.4 的 `GET`）。
- `fieldValues: [{ listId, fields: [{ fieldId, name, type, config, hidden, value }] }]`：按 S27，某个字段值对调用者可见的条件是：调用者能 `view` 这个任务，并且有一张清单同时绑着这个字段、装着这个任务、以调用者为成员。只凭直接角色看到任务、却不在任何相关清单里的人，这一项是空数组。
- `canCompleteForAll: boolean` = `canCompleteForAll(...)` ∧ 任务 open ∧ `completion_mode = 'all'` ∧ 至少一个负责人（`[a-05]`）。

**列表项**（`GET /api/tasks` 与 `GET /api/task-lists/:id/items`）：这两条读返回 M2 的 snake_case 行，在既有列之后加 `is_milestone`（S13 要求列表也显示里程碑徽标；`[a-18]`）。只加列，不改既有列。

**待办 `GET /api/tasks/pending` 不改**：它返回 `toTaskPendingItem`（`services/task-records.ts:241`）给出的 camelCase PendingItem，键集由锁 §6.1 定死（无截止日五键，有截止日六键），门 5（`M2|5|整门`）逐键断言。PR-4a 不给它加键。要在待办里显示里程碑，需要 owner 点名修订锁 §6.1 与门 5（§7.4 Q1），不是本文能取的值；§6.4 有一格钉住它不变。

**删除 `DELETE /api/tasks/:id`**：任务属于一个系列（有规则，或 `recurrence_series_id` 非空，或是某一期的 `previous_occurrence_id`）时改走 `planSeriesDelete`（S17 (b)(d)）：软删目标与链上更晚、未软删且未完成的各期；每一期都先过任务 C 的删除判定（只有创建人；仍有未删子任务 ⇒ 整体拒绝 409 `HAS_CHILDREN`）；删除后链上最晚的未删一期若仍有规则则清掉并记 `recurrence_cleared`。成功体在 M3 的 `{ id, deleted: true }` 上加 `deletedIds: string[]`（目标在第一个；不属于系列时就是 `[id]`；`[a-19]`）。

系列删除的执行（结构锁内，冻结）：

1. 装载整个系列，含已软删的期：第一期按 id（经 `buildTaskByIdAnyStateCondition`），其余按 `recurrence_series_id`（经 `idx_tsk_recurrence_series` 与 `buildTaskSeriesMembersCondition`）；见 §4.7。
2. 对将要软删的每一行——目标，以及链上更晚、未软删且未完成的各期——**按 id 升序**取 M3 删除路径的同一个有界 `FOR UPDATE`（M3 的行锁 helper；超时 ⇒ 409 `TASK_BUSY`，整体回滚）。这样持 `FOR KEY SHARE` 的评论写不会在同一次删除里落到任何一期上：M3 单删已有的保证扩到整条链。完成态只在结构锁内改，所以这个集合在锁内不会变。
3. 调用 `planSeriesDelete`，写软删与事件：每一期一条 `deleted`，最晚未删一期若被清规则再加一条 `recurrence_cleared`。
4. 照 PR-3b 的写法同事务入队：这次写出事件的每一期各调用一次 `enqueueTaskEventNotifications`，传入那一期自己的 `taskId`、它自己的 `created_by` 与只属于它的事件。producer 按传入的 `taskId` 装载收件人，一次调用只覆盖一个任务，所以不能把整条链的事件交给一次调用。`deleted` 在可通知闭集里，每一期的负责人、关注人按那一期自己的成员收到删除通知，与逐期单删一致；`recurrence_cleared` 不在闭集里，由 producer 自行滤掉。
5. 红点信号（锁门 26）：PR-3c（#6269）合入之后，系列删除照它的单删写法接 `taskCountsSignal()`：整次删除一个收集器；每软删一期调用一次 `note`，前后两侧都是那一期的负责人集合；事务提交之后调用一次 `publish`。收集器对全部 `note` 取并集，所以任何一期的负责人在这次写入里都恰好收到一条 `tasks:counts-updated`，关注人不收，回滚则一条不发；之后由客户端按门 26 的 500 ms 窗口合并重拉 `/pending-count`。派生不必另发：新一期的负责人是被翻转那一期负责人的子集（`[a-15]` 只会去掉人），翻转那次写已经给他们发过。PR-4a 起草时 PR-3c 若已在 main，这一步就是 PR-4a 的必做项；否则由后合入的一方补上。

### 3.9 错误码总表（PR-4a 新增）

| 码 | HTTP | 出处 |
|---|---|---|
| `INVALID_SCOPE` | 422 | §3.1 |
| `INVALID_RECURRENCE`、`DUE_REQUIRED`、`NOT_CURRENT_OCCURRENCE` | 422 | §3.2（任务 E reason 转大写） |
| `INVALID_MILESTONE` | 422 | §3.3 |
| `INVALID_DEPENDENCY`、`SELF`、`DUPLICATE`、`CYCLE`、`INVALID_DIRECTION` | 422 | §3.4 |
| `INVALID_TYPE`、`INVALID_CONFIG`、`FIELD_IN_USE` | 422 | §3.5 |
| `INVALID_FIELD`、`INVALID_BINDING` | 422 | §3.6、§3.7 |
| `INVALID_VALUE`、`NOT_IN_OPTIONS`、`TOO_LONG`、`OUT_OF_RANGE` | 422 | §3.7 |

沿用的既有码：`LIMIT`（M4）；`INVALID_NAME`（M4 清单名已在用；§3.5 的字段名为空或过长都答它，任务 E 的 `invalid_name` 不区分两者）；`INACTIVE_ORG_MEMBER`（R17 的 helper，§3.7）；`HAS_CHILDREN`、`TASK_BUSY`（M3）。与既有写法不同的两处照实登记、不另对齐（§3.0：码直接取纯函数 reason 的大写；`[a-32]`）：清单名过长答 `NAME_TOO_LONG`，字段名过长答 `INVALID_NAME`；M3 设父的自指与成环都答 `INVALID_PARENT`，依赖分别答 `SELF` 与 `CYCLE`。

---

## 4. 服务分层、锁、版本与事件

### 4.1 文件

| 层 | 文件 | 内容 |
|---|---|---|
| 纯函数 | `src/tasks/task-completion.ts`（改） | 新增 `applyCompleteForAll`：创建人以外的调用者抛错；`wasDone` 为真 ⇒ 空操作；`all` 模式填满空行并给一条 `completed`；其余模式委托 `applyComplete` |
| 纯函数 | `src/tasks/task-access.ts`（改） | 新增 `canCompleteForAll({ actorId, createdBy })`；新增 §4.7 的三个 SQL 条件 builder（另复用既有的 `buildTaskByIdAnyStateCondition`），并在同一 PR 改写 `[own-3b-17]` 的注释 |
| 纯函数 | `src/tasks/task-field-access.ts`（新） | 字段定义的两个 SQL 条件 builder 与唯一的私有 org 子句 `taskFieldOrgClause`（§4.7，`[a-40]`） |
| 纯函数 | `src/tasks/task-recurrence.ts`（#6249 的文件，改一处） | `planSpawn`：下一期截止日越过 `9999-12-31` 时返回 `series_ended`，不抛 `RangeError`（§3.2 第 4 步；若 #6249 先行修改则此行作废） |
| 纯函数 | `src/tasks/task-ids.ts`（改） | `TASK_ID_PREFIXES` 加 `field: 'tfld'`、`attachment: 'tatt'` |
| 纯函数 | `src/tasks/task-projection.ts`（#6249 的文件，改一处） | 字段 id 前缀改从 `TASK_ID_PREFIXES.field` 派生 |
| 取锁 | `src/db/task-advisory-locks.ts`（改） | 锁序包装器 `withTaskLockOrder`、`TaskLockOrderViolation` 与只供测试的记录钩子（§4.2） |
| 服务 | `src/services/task-records.ts`（改） | `completeTask` 收 `scope`；`writeEvents` 支持 payload（切片 1，保留 PR-3b 的 `WrittenTaskEvent[]` 返回）；详情增补；`withOrgStructure` 与 `createTask` 改经包装器取结构锁（§4.2） |
| 服务 | `src/services/task-structure.ts`（改） | 两处翻转调用点接派生；删除改走系列判定 |
| 服务 | `src/services/task-recurrence-records.ts`（新） | 设 / 清规则、`spawnNextOccurrenceIfDue`、系列删除 |
| 服务 | `src/services/task-dependency-records.ts`（新） | 里程碑、依赖四条、候选 |
| 服务 | `src/services/task-field-records.ts`（新） | 定义、绑定、取值、详情的可见值 |
| 服务 | `src/services/task-scheduler.ts`（改一处） | leader 锁改经包装器取（§4.2，`[a-36]`），tick 的其余行为不变 |
| 服务 | `src/services/task-org-members.ts`（只改头注） | 调用方清单加上派生（§3.2） |
| 路由 | `src/routes/tasks-entity.ts`、`src/routes/tasks-fields.ts`（新） | §3.0 |

行级规则全部出自 `src/tasks` 的纯函数（门 20）；服务层只取行、调用、落库。各路由调用的纯函数如下（除注明本 PR 新增的，都是 #6249 的导出）：

| 路由 | 纯函数 |
|---|---|
| §3.1 complete 的 `scope: 'all'` | `canCompleteForAll`、`applyCompleteForAll`（本 PR 新增） |
| §3.2 设 / 清规则 | `parseRecurrenceRule`、`applySetRecurrence`、`applyClearRecurrence` |
| §3.2 派生 | `shouldSpawnOnFlip`、`planSpawn`（内部调用 `nextOccurrenceDueDate`、`isWithinRecurrenceEnd`） |
| §3.3 里程碑 | `parseMilestoneFlag`、`applySetMilestone` |
| §3.4 依赖 | `canManageDependency`、`validateAddDependency`、`applyAddDependency`、`applyRemoveDependency`、`dependencyCandidates` |
| §3.5 字段定义 | `parseFieldDefinition`、`checkFieldDefinitionQuota`、`canManageFieldDefinition`、`planDeleteFieldDefinition`、`listReusableTaskFieldIds` |
| §3.6 字段绑定 | `canBindField`、`listReusableTaskFieldIds`、`applyBindField`、`applyUnbindField` |
| §3.7 字段取值 | `canWriteFieldValue`、`validateFieldValue`、`applySetFieldValue` |
| §3.8 详情与删除 | `resolveVisibleTaskFieldValues`、`canManageDependency`（`DepItem.canRemove`）、`planSeriesDelete` |

### 4.2 事务与锁

- 所有写走 `withOrgStructure(orgId, run)`：首句 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`，取 org 结构锁，锁后在同一连接上重读决定这次写的全部行，再调纯函数，事件同事务写入（与 M2–M4 同一协议）。加边、删边按 E07 属于结构写，判环之前必须在这把锁里把整张依赖图重新读一遍。
- 读路径不进事务、不取锁。
- **锁序包装器**（S09，owner 2026-10-09 裁定的取值）：`withTaskLockOrder(query)` 放在 `src/db/task-advisory-locks.ts`。每个事务在自己的 `query` 上建一个实例，经它取锁：structure = 1、fence = 2（PR-4c 接入 canonical fence 步）、projection = 3；同一事务里 rank 递减即抛 `TaskLockOrderViolation`。实例按先后记录这个事务取过的锁，测试经只供测试的记录钩子读出。抛出点在包装层；三处 `pg_advisory_xact_lock(hashtext(` 字面量仍只在三个登记导出里，门 7 的多重集不变。lane 是 `tasks-realdb`。
- **生产路径一律经包装器**（S09 的取值是包装器进生产码，而不是只在测试里记录）：今天生产上取结构锁的只有两处，`withOrgStructure`（`services/task-records.ts:83`，取锁在 `:93`）与自开事务的 `createTask`（同文件，取锁在 `:127`）；PR-4a 把两处都改成经包装器取 rank 1。投影锁今天没有调用者，PR-4c 接入时经包装器取 rank 3。改完之后，三个取锁 helper 在生产码里除包装器之外没有调用者（§6.1 有静态格钉住）。M2–M5 的结构写都经 `withOrgStructure`，所以每一条都落在包装器的记录里。
- **调度 leader 锁**（`[a-36]`）：锁 §6.4 定了它不与另外两把任务锁同处一个事务，但 S09 没有给它 rank，包装器怎样执行这一条是本文的取值。缺省：leader 在包装器里是独占的，同一事务已持有任一 rank 锁时再取 leader，或已持有 leader 时再取任一 rank 锁，都抛 `TaskLockOrderViolation`。为让这条规则在生产上真起作用，`services/task-scheduler.ts:428` 的取锁也改经包装器；它的 tick 事务只取这一把锁，行为不变。
- 本 PR 的业务写只取结构锁；不取投影锁、不取 fence。对调度器只改取锁的入口（上一条）。

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
- 本 PR 的新写入点（设 / 清规则、里程碑、依赖、字段三层、系列删除）同一次写的事件 `occurred_at` 取锁后读一次的 `clock_timestamp()`（PR-3a §4.4 的规则；系列删除照 M3 单删从行上复制），不用事务开始时的 `now()`。例外是挂在既有翻转调用点上的写（G1 与派生）：那几处今天在锁内取一次应用时钟 `now`，给行与事件盖时刻；G1 的 `completed`、派生出的新一期的行、`recurrence_spawned` 与 `created` 都沿用这一个 `now`，同一次写里的事件时刻相同、先后不会因两种时钟而颠倒（`[a-37]`）。

### 4.5 部署耦合

PR-4a 合并后，详情与列表读 `tasks.is_milestone` 等新列：凡 `TASKS_ENABLED='true'` 且运行这份代码的环境必须已应用本迁移（与 PR-3a §9.2 同一种耦合）。staging 的迁移执行仍按 owner 2026-10-09 对 PR-3a §12-Q10 的裁定走：经授权后执行，事先按目标 SHA 列出完整的待执行集合。生产不动。

### 4.6 与 PR-3b、PR-4b、PR-4c 的边界

- PR-3b 已在 main（头部的基线漂移）。PR-4a 不用 `TaskScheduler`：派生在请求事务内完成。它用的是 PR-3b 的 producer：新写事件的调用点同事务入队（§4.4）。
- PR-4b 在本迁移的两张附件表上写路由与 GC，不再带 DDL；`TASK_NOTIFIABLE_EVENTS` 加 `attachment_added` 归 PR-4b（S33）。
- PR-4c 在映射表上写 reconcile；投影列 `isMilestone`、`dependencies`、自定义字段列的来源就是本文的列与表。
- 两者对本文的任何形状改动都先改本文。

### 4.7 新读、新写的 SQL 条件 builder

M3 有两处按 org 读任务的条件是手写的（`services/task-structure.ts:185`、`:285`），门 1 的单字面量变异看不到它们。PR-4a 的新读、新写都不手写 org 条件：要么经下面两张表里的 builder 选出行，要么只从这些 builder 选出的行出发做连接。

任务、系列与依赖：`src/tasks/task-access.ts`（一个既有、三个新增），org 条件只经那里的单一 org 子句。

| builder | 选出 | 使用处 |
|---|---|---|
| `buildTaskByIdAnyStateCondition`（既有，PR-3b） | 一个 org 内按 id 的一个任务，**含已软删** | §3.2 第 3 步的锚点（第一期）、§3.8 系列删除装载第一期 |
| `buildTaskSeriesMembersCondition`（新） | 一个 org 内 `recurrence_series_id` 等于给定第一期 id 的各期，**含已软删** | §2.10 序号计数、§3.8 系列删除装载其余各期 |
| `buildOrgDependencyEdgesCondition` | 一个 org 内两端都未软删的边 | §3.4 加边判环、候选的成环排除 |
| `buildDependencyCandidateTasksCondition` | 一个 org 内未软删的任务（可编辑性仍由纯函数逐行判定） | §3.4 候选 |

字段定义：新文件 `src/tasks/task-field-access.ts`（纯函数、无 I/O，门 20 的 harness 自动覆盖）。`task_fields.org_id` 只在它的一个私有 org 子句 `taskFieldOrgClause` 里出现，与 M4 的 `taskListOrgClause` 同一做法（`[a-40]`）。

| builder | 选出 | 使用处 |
|---|---|---|
| `buildTaskFieldByIdCondition` | 一个 org 内按 id 的一个字段定义 | `PATCH` / `DELETE /api/task-fields/:id`；`POST` 绑定与 `PUT` 取值时的字段取行；派生时判断照抄的取值哪些是成员型（§3.2） |
| `buildTaskFieldsOfOrgCondition` | 一个 org 的全部字段定义 | `GET /api/task-fields` 交给 `listReusableTaskFieldIds` 的字段集合；每 org 定义上限的计数 |

绑定表与取值表没有自己的 builder，也不手写 org 条件：

- 绑定行只从已选出的清单（`buildTaskListByIdCondition`，`src/tasks/task-list-access.ts`）或已选出的字段定义出发，按 `list_id` / `field_id` 连接读出；
- 取值行只从已选出的任务（`buildTaskByIdCondition`）出发按 `task_id` 连接读出，或在删定义时随外键删除；
- 两张表的组合外键（§2.5、§2.6）保证它们的 `org_id` 与所连接的清单、任务、字段相同，所以从会话 org 里选出的行出发，连接不会跨出这个 org。

`listReusableTaskFieldIds` 的两半因此都限在会话 org 内：「自己建的」那一半的字段来自 `buildTaskFieldsOfOrgCondition`；「绑在能编辑的清单上的」那一半，清单来自 `buildTaskListScopeCondition`（再按角色取 edit/owner），绑定从这些清单出发连接。`POST` 绑定的可复用判定用同一个函数，输入是按 id 选出的那个字段、它的绑定与调用者的可编辑清单。

负控：把 `taskFieldOrgClause` 的 org 合取删掉 ⇒ M5-g 的字段第二租户格红（§6.2）。

`[own-3b-17]` 今天写的是「只有投递 worker 读可能已软删的任务」。系列读（锚点、序号、系列删除）是第二个这样的读者，PR-4a 在同一 PR 改写那条注释，把两个读者与各自的理由都列上。本节不改 M3 那两处手写条件，它们归 M3 的后续。

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
| g1-repeat-null-row | 夹具直发 SQL 播种一个已 done 的 `all` 模式任务，带一行 `completed_at` 为空的负责人行（任务 C 的 A6 形：任务已 done 时加人、再切成 `all`）⇒ 创建人 `scope: 'all'` ⇒ 200 空操作，那一行仍为空，`version` 不变，不写事件 |
| g1-concurrent | 两个连接同时以 `scope: 'all'` 调用，交错由夹具强制（§6.2 开头的持锁法，挡写的表锁加在 `task_assignees` 上）⇒ 两个都 200，`completed` 恰一条 |
| g1-assignee | 负责人（非创建人）`scope: 'all'` ⇒ 404，逐字节同不存在；行与事件不变 |
| g1-list-editor | 只有清单可编辑身份的成员 ⇒ 404 |
| g1-follower / g1-outsider | ⇒ 404 |
| g1-bad-scope | 创建人 `scope: 'x'` ⇒ 422 `INVALID_SCOPE`；看不见任务的人带同样请求体 ⇒ 404 |
| g1-self-unchanged | 缺省与 `scope: 'self'` 的行为与 `M2\|3` / `M3\|3` 的既有格逐一相同 |
| g1-any / g1-zero | `any` 模式、零负责人：`scope: 'all'` 与缺省同结果 |
| g1-detail | 详情 `canCompleteForAll`：创建人且 open、`all`、有负责人 ⇒ true；其余 ⇒ false |

变异（每个都要让对应格变红）：去掉 `canCompleteForAll` 判定 ⇒ g1-assignee 红；把它换成 `can(roles, 'edit')` ⇒ g1-list-editor 红；去掉 `wasDone` 空操作分支 ⇒ g1-repeat-null-row 红（g1-repeat 的夹具里各行都已有时刻，去掉这个分支也不会多写，单靠它杀不死这个变异）；去掉结构锁 ⇒ g1-concurrent 红；把同一个 `now` 换成逐行取时 ⇒ g1-creator-all 红。

---

## 6. 门与测试计划

### 6.1 既有 `M5|` 行里属于 PR-4a 的部分（§12 已 ratify，直接计分）

- `M5|7|锁序控件`（S09；包装器的接入见 §4.2）：
  - 正向：设父、依赖增删、派生、建任务、调度 tick 各走真实路径（前三者两两并发），经记录钩子读出每个事务的取锁序列。结构写的序列**非空、第一项是 rank 1**、全程单调；调度 tick 的序列恰是一项 leader。只断言「单调」在什么都没记录时也为真，所以「非空、首项」是这一格的主断言。
  - 静态：生产码里三个取锁 helper 除包装器之外没有调用者（按导入点扫描 `src/`）。
  - 反序格：测试里同一事务先取投影锁、再取结构锁 ⇒ 抛 `TaskLockOrderViolation`；leader 与结构锁同处一个事务，两种先后各一格 ⇒ 抛出（`[a-36]`）。抛出是这几格的期望结果。
  - 负控（各自让对应格变红）：去掉包装器里的 rank 比较 ⇒ 反序格不再抛；把 `withOrgStructure` 改回直接调用 helper ⇒ 正向格读到空序列（静态格同时红）；去掉 leader 的独占判断 ⇒ leader 共存格不再抛。
  - fence 步在 PR-4c 加入后再计入（只在 `MULTITABLE_ENABLE_WRITER_FENCE=true` 的 lane）。
- `M5|10|P2子集`：PR-4a 承载 id 两格中的写路径部分——依赖请求体里前导 `_` 与尾随 `_` 的任务 id ⇒ 422 `INVALID_DEPENDENCY`，绑定与取值请求体里同形的字段 id ⇒ 422 `INVALID_FIELD`。投影写回的 `recordId` 一格归 PR-4c。
- `M5|7|src/multitable/task-*`、`M5|9|整门`、`M5|19|投影端`：PR-4c。

### 6.2 候选行（未计分，等锁修订写进 `arm-set`）

S31 已裁 M5 的退出结构：五条既有行、候选 M5-a…g 落到整数门号（R01 已落为 23–26，所以候选从 27 编起）、最终 head 上回归全部 `M2|` / `M3|` / `M4|` 行、staging 真开一次记为合并后的 owner 步骤。门号与行键要由一次锁修订写进 §12，这次修订本身需要 owner 点名（§7.3）。并发格的交错一律由夹具强制，不靠时机：第三个连接先持有一把挡写不挡读的表锁（M5-c 交叉加边用 `task_dependencies` 上的 `SHARE` 锁，g1-concurrent 用 `task_assignees` 上的同一种锁），两个请求发出后按门 6 的 settle 规则轮询 `pg_stat_activity`，等两个请求的后端都处于等锁状态再释放。结构锁在时，后一个请求等的是结构锁，它的读发生在前一个提交之后；变异去掉结构锁之后，两个请求都已读完、都停在表锁上，释放后两边都写入，于是格必红。

PR-4a 承载的候选：

| 候选 | 门号（按 S31） | PR-4a 的格 |
|---|---|---|
| G1 | 不在 M5-a…g 之内；建议作为门 3 的子集行 `M5\|3\|创建人为全员完成`（`[a-24]`） | §5 全表 |
| M5-a 重复 | 27 | 完成翻转恰派生一期（三个调用点各一格，含 G1 路径）；新一期的日期步进、时刻与时区、系列两列、负责人行未完成；reopen 再完成不派生；`until` / `count` 用尽后不再派生；系列删除只动链上更晚且仍 open 的期；**不派生但完成照常 200**（§3.2 判定顺序，三个调用点与 G1 路径各一格）：截止日与时区一起清空后完成、只清空第一期自己的截止日后完成、后一期仍有截止日但第一期的截止日已清空时完成，每格都 200、无新一期、无 `recurrence_spawned`；截止日 `9999-12-31` 的有规则任务完成 ⇒ 200、`series_ended`；详情 `nextOccurrenceId`：派生后被移出负责人的人读上一期 ⇒ `null`；系列删除：链上更晚一期的关注人收到 `deleted` 通知行，且与另一连接对该期的评论写互斥（评论先持锁 ⇒ 删除等它提交；删除先持锁 ⇒ 评论 404）；派生的人员（`[a-15]`）：已离开 org 的关注人不进新一期；多人成员型取值里离开的那个 id 被去掉、其余照带；只含离开者的成员型取值在新一期没有行；在职的关注人照常带上（正控）；这几格的完成都是 200；授权格见 §6.2.1；负控：去掉事件存在性检查 ⇒「reopen 后再完成」那一格被唯一索引挡住、得到 500 ⇒ 红；检查与唯一索引都去掉 ⇒ 派生出第二期 ⇒ 红；去掉关注人的在职过滤 ⇒ 离开的关注人那一格红；去掉成员型取值的过滤 ⇒ 两个取值格红 |
| M5-c 依赖 | 29 | 自依赖、重复、成环各 422（`SELF` / `DUPLICATE` / `CYCLE`，即 S31 采纳的候选格）；菱形合法；删不存在的边为空操作；两个连接同时加 A→B 与 B→A，只有一个成功，结束时图里没有环；一端无 `edit` ⇒ 404；跨 org ⇒ 404；同一用户在两个 org 都在职时，候选里不出现另一个 org 的任务；依赖与里程碑的授权格见 §6.2.1（里程碑挂在本行，`[a-39]`）；负控：去掉取锁 ⇒ 两方都成功 ⇒ 红（交错按本节开头的持锁法强制） |
| M5-d 字段 | 30 | 闭集外的类型、config 里多出的键各 422；值引用不存在的选项 422；成员值含已离开 org 的人 422 `INACTIVE_ORG_MEMBER`；创建人删仍有绑定的定义 422 `FIELD_IN_USE`；不在任何相关清单里的人读不到值；删掉一个选项后，引用它的旧取值原样留在库里、详情照存值返回（`[a-38]`）；授权格见 §6.2.1；负控：选项比对改用 label 而非 id ⇒ 选项改名之后旧值那一格红 |
| M5-g 新表面 | 门 1 / 2 / 13 / 17 / 20 的 M5 子集 | 每条新写路由缺 org ⇒ 422（在 `rbacGuard` 之后）与跨 org 写格；每条新路由的非 admin 正格与 403 负格；两个新注册行置空 ⇒ 门 13 红；每个新 `task-*.db.test.ts` 满足门 17 ①②④；新纯函数在门 20 的行为 harness 与静态检查之下；**字段第二租户**（门 1 子集，候选行键 `M5|1|字段第二租户`，放在 `tests/tasks-auth/tasks-auth-gate.ts`，信任关闭，照 `M4|1|清单第二租户` 的形状）：同一用户在 org A、B 都在职，org B 里有他建的字段、绑定它的清单与带取值的任务（夹具直发 SQL 播种），会话 org 为 A；正控先跑：`GET /api/task-fields` 非空且只含 org A 的字段，再断言不含 org B 那个；按 id 对 org B 字段的 `PATCH` 与 `DELETE`、把它绑到 org A 清单的 `POST`、在 org A 任务上写它的取值、读 org B 清单的绑定，都是 404，与 id 不存在时相同（绑定那一格不得是 500）；org B 的数据零变化；负控：删掉 `taskFieldOrgClause` 的 org 合取 ⇒ 列表格与按 id 各格红；§12.0 a–i 逐条标注随 PR 正文。PR-4a 没有新开关，门 18 无 PR-4a 子集 |

M5-b（附件）、M5-e（夹钳）、M5-f（导出）归 PR-4b / 4c。

### 6.2.1 行级授权格（S35、S13、S11、S24、S26）

身份：创建人 C、负责人 A、清单可编辑者 LE（任务所在清单的 editor/owner，不是 C、A）、关注人 F、清单只读者 LR、局外人 O（同 org 在职、与任务无关）。每个 404 格都断言响应与目标不存在时逐字节相同，行与事件不变（与 §5 的 G1 表同一写法）。格放在各自族的真库文件里，承载行见最后一列。

| 路由族（裁定） | 正格 200 | 404 格 | 变异 ⇒ 变红的格 | 承载 |
|---|---|---|---|---|
| `PUT /recurrence`，设规则与清规则各一组（S35） | C、A、LE | F、LR、O | `can(roles,'edit')` 换成 `can(roles,'view')` ⇒ F、LR 格红；只认直接角色（丢掉清单身份）⇒ LE 格红 | M5-a |
| `PATCH /milestone`（S13） | C、A、LE | F、LR、O | 同上 | M5-c（`[a-39]`） |
| 依赖加边、删边（S11） | 调用者对本任务是 A、对对端是 LE | 对本任务有 `edit`、对对端只是 F 或 LR；对本任务只是 F、对对端有 `edit` | `canManageDependency` 只看 `:id` 一端 ⇒ 对端为 F 的那格红 | M5-c |
| 依赖候选（S11） | 对本任务有 `edit`：结果只含调用者能编辑的任务 | 对本任务只是 F ⇒ 404；调用者只关注的任务不在结果里 | 去掉逐行 `edit` 过滤 ⇒ 只关注的任务出现 ⇒ 红 | M5-c |
| 改字段定义（S26） | 创建者；不是创建者、但在某张绑着这个字段的清单上是 editor/owner | 绑定该字段的清单的 reader；只在不绑定该字段的清单上是 editor | `canManageFieldDefinition` 恒真 ⇒ reader 格红；去掉「绑定清单的编辑者」那一臂 ⇒ 绑定清单 editor 的正格红 | M5-d |
| 删字段定义（S26） | 创建者、零绑定 ⇒ 200，取值随之删除；创建者、仍有绑定 ⇒ 422 `FIELD_IN_USE` | 非创建者（含绑定清单的 editor）⇒ 404，先于 `FIELD_IN_USE` | 去掉创建者判定，或把它挪到绑定数判定之后 ⇒ 非创建者那格得到 422 或 200 ⇒ 红 | M5-d |
| 绑定、解绑、调序与显隐（S26） | 清单 editor、owner | 清单 reader；非成员 | `canBindField` 接受 reader ⇒ 红 | M5-d |
| 绑定的可复用集合（S24） | 绑调用者自己建的字段；绑一个绑在调用者能编辑的另一张清单上的字段 | 调用者是清单 X 的 editor、清单 Y 的 reader，把别人建的、只绑在 Y 上的字段绑到 X ⇒ 404 | 去掉可复用判定 ⇒ 这一格 200 ⇒ 红 | M5-d |
| 写取值（S26） | A，字段绑在一张装着该任务的清单上 | F ⇒ 404；有 `edit` 但字段只绑在不装该任务的清单上 ⇒ 404；字段没有任何绑定 ⇒ 404 | `canWriteFieldValue` 去掉绑定条件 ⇒ 后两格红；`edit` 换成 `view` ⇒ F 格红 | M5-d |

### 6.3 真库文件与登记

新文件：`task-m5-g1.db.test.ts`、`task-m5-schema.db.test.ts`、`task-m5-recurrence.db.test.ts`、`task-m5-dependencies.db.test.ts`、`task-m5-fields.db.test.ts`。每个同 PR 登记三处（锁 §5.2.1：exclude 逐文件字面量、`tasks-realdb` 清单、④ 三集合相等），PR 正文写 `.each` 展开后的计数（门 17）。形状格覆盖 §2 的每一条 CHECK、外键与唯一索引各一正一反（按 §2 的约束名断言），以及 `down()` 后再 `up()`。其中点名的几格：未绑定的评论附件带评论 id ⇒ `task_attachments_comment_kind_chk` 拒绝；字段值存 JSON `null` ⇒ `task_field_values_value_not_json_null_chk` 拒绝；`recurrence_series_id = id` 的行 ⇒ `tasks_recurrence_series_not_self_chk` 拒绝；硬删一个带评论附件的任务（测试夹具里）⇒ 成功，附件行与评论行同语句删掉、触发器写出 intent（`NO ACTION` 不挡）；直接硬删那条评论 ⇒ 被 `task_attachments_comment_fk` 拒绝。非唯一索引（含 `idx_tsk_recurrence_series`、`idx_tdep_org`）按名断言存在于 `pg_indexes`，`down()` 后断言不存在。字段第二租户格加在既有的 `tests/tasks-auth/tasks-auth-gate.ts`（信任关闭的专属 harness），不新增文件。

### 6.4 回归与声明

- 最终 head 上重跑全部 `M2|`、`M3|`、`M4|` 行：PR-4a 改了 complete、增删负责人、切模式、删除四个写入点，详情与两条列表读的形状，以及取结构锁与调度 leader 锁的入口（都经包装器）。
- 待办不变格：里程碑任务（有截止日、无截止日各一）出现在 `/api/tasks/pending` 时，项仍恰为门 5 的五键 / 六键，不含任何里程碑键；`M2|5|整门` 在最终 head 上重跑（§3.8）。
- 门 26（PR-3c 合入之后）：一格系列删除，目标与链上更晚一期的负责人不同（A 只在目标上，B 只在后一期上，C 两期都在）⇒ 提交后 A、B、C 各恰一条 `tasks:counts-updated`，两期的关注人零条；同一次删除被迫回滚 ⇒ 零条（§3.8 第 5 步）。
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
| a-12 | 依赖路由的形状（§3.4）与 `DepItem.canRemove` | 一个 `POST` 收 `predecessorId` 或 `successorId`；两条 `DELETE` 按方向分路径；`DepItem` 带 `canRemove`（两端都 `edit`） | `POST …/predecessors` 与 `POST …/successors` 两条；不带 `canRemove`：前端算不出对端的角色，删边入口只能一律显示、点了再 404 |
| a-13 | 字段取值一次一个 | 一次一个 | 批量 `{ values: {…} }`：一次保存多个字段，但一个坏值使整批失败 |
| a-14 | 错误体只有 `code` | 不带 `field` | `INVALID_RECURRENCE` 附 `field`：前端能定位，但多了一种错误体形状 |
| a-15 | 派生时已离开 org 的人（负责人、关注人、成员型取值里的 id；在职判定本身是 R17 / N2 与 S25 已裁的） | 去掉，取值去空则不写行，完成照常 200 | 整次完成 422：用户无法完成自己的任务；照抄关注人与取值：新一期出现直接写入路径会拒绝的行 |
| a-16 | 序号不存列，按 `created_at` 计数 | 不存列 | 加 `occurrence_index` 列：多一列，但读起来不依赖插入顺序 |
| a-17 | 详情 `nextOccurrenceId` | 加，调用者不能 `view` 后继时为 `null` | 不加：前端「下一条」要再查；不过滤：泄露一期看不见的任务的 id |
| a-18 | `GET /api/tasks` 与清单任务项两条列表读加 `is_milestone`（待办 `/pending` 不加，见 §7.4 Q1） | 加 | 不加：列表上没有里程碑徽标，与 S13 不符 |
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
| a-31 | 成员型字段不在候选集的码 | `INACTIVE_ORG_MEMBER`（与加负责人、加关注人同码） | `NOT_A_CANDIDATE`（任务 E reason 的大写）：同一个离开的人在两类写入上得到两个码 |
| a-33 | 系列第一期的截止日已清空时（锚点为空）后一期完成 | 不派生（`no_due_date`），完成照常 | 退回用本期截止日作锚点：系列继续，但按月日的步进可能偏离第一期定下的日子 |
| a-34 | 分页读的排序键；两条有上限的读不分页 | 候选 `created_at DESC, id ASC`；字段定义 `created_at ASC, id ASC`；依赖列表与清单绑定不分页、不带 `total` | 按标题或名称排序：要定排序规则（collation）；两条有上限的读也套分页：前端多一层翻页 |
| a-35 | 详情里 `seriesId` / `previousOccurrenceId` 不按 `view` 过滤；`NOT_CURRENT_OCCURRENCE` 也透露了存在更晚的一期 | 照 `parentId` 的先例不过滤（指向本行自己记录的更早一期） | 过滤：看不见第一期的人拿不到系列 id，详情的系列导航断开 |
| a-32 | 没有纯函数 reason 对应、由本文命名的码与规则：`INVALID_DEPENDENCY`、`INVALID_DIRECTION`、`INVALID_FIELD`、`INVALID_BINDING`、`INVALID_SCOPE`；候选的 `q` 按标题包含匹配（不区分大小写）；绑定的 `position` 限 0..49；字段名过长答 `INVALID_NAME`、依赖自指与成环答 `SELF` / `CYCLE`，不对齐到 M4 的 `NAME_TOO_LONG` 与 M3 的 `INVALID_PARENT` | 如左 | 改名或合并为一个 `INVALID_BODY`：前端少几个分支，但定位不到哪个参数错了 |
| a-36 | 调度 leader 锁在锁序包装器里的规则（§4.2） | 独占：与任一 rank 锁同处一个事务即抛，两种先后都抛；调度器的取锁改经包装器 | 给 leader 一个 rank（例如最先取的 0）：允许它与结构锁同事务，与锁 §6.4 的不共存相反；或调度器仍直接调用 helper、只加静态检查：规则在生产上不起作用 |
| a-37 | G1 与派生的时刻（§4.4） | 沿用翻转调用点在锁内取的应用时钟 `now`，新一期的行与两条事件同一时刻 | 把五个翻转调用点改成锁后读一次 `clock_timestamp()`：改动 M2–M4 的写入点，回归面更大 |
| a-38 | 改字段定义对已存取值的影响（§3.5） | 不改写、不拒绝：已存取值原样保留、照存值读出，下次写入按当前定义校验；PR-4c 把已不在选项里的 id 投影为空；定义没有版本列，并发修改后写覆盖先写 | 删除仍被引用的选项 ⇒ 新的 422：要扫全部取值，编辑者还可能看不到那些任务；一并清空引用它的取值并写 `field_value_changed`：改到编辑者看不见的任务；加 `updated_at` 前置条件：请求多一个字段，前端多一种冲突 |
| a-39 | 里程碑授权格的承载行（§6.2.1） | 挂在候选 M5-c 行（同一切片、同一服务文件） | 新开一条门 2 子集行：锁修订多一行 |
| a-40 | 字段三表的 org 条件（§4.7） | 新纯模块 `task-field-access.ts` 的单一私有 org 子句；绑定与取值只从已按 org 选出的清单、任务、字段出发连接 | 放进 `task-list-access.ts`：一个模块管两个域；绑定与取值各写一份 org 条件：org 文本多处出现，单字面量变异覆盖不全 |

（编号 a-26、a-29 预留未用：起草时归入已裁的 S05 与 S09，不再是自选。a-11 在冻结稿 v3 收回：重复加依赖的答法由 S31 采纳的候选 M5-c 格定为 422，§3.4 照它冻结为 `DUPLICATE`，不再是自选。a-33–a-35 是第 1 轮审阅后新增，a-36–a-40 是冻结稿 v3 新增。现存 37 项。）

### 7.2 影响 PR-4a 的既有未决项

- **任务 E §7 问题 1（重复的锚点）**：本文按缺省 (a) 冻结（锚点 = 系列第一期当前的 `due_date`，§2.10）。若 owner 取 (c)，或取问题 1 (iii) 的备选（换规则时重设锚点与计数起点），需要存锚点或计数起点：规则闭集加键（S14 改动）或本迁移加列。**因此在问题 1 落槌之前，§2 的冻结对 `tasks` 的列集合是有条件的**；其余表不受影响。取 (b) 不改表。
- **任务 E §7 问题 3（`count` 越界的码）**：缺省 `INVALID_RECURRENCE`；取 D18 则超过 365 答 `LIMIT`，只改 §3.2 的码表与一格。
- **任务 E §7 问题 2（导出时区）**：只影响 PR-4c。
- **任务 E 与已裁取值的四项偏离（X1–X4，#6249 正文「与已裁取值的偏离」第 1–4 项）**：X1（S05 混合清单里不带时刻的开始）、X2（S10 / D11 导出数值格）只影响 PR-4c；X4（S18 文本类附件的内容判定与每任务上限的计数口径）只影响 PR-4b。**X3（S11 依赖候选另排除会成环的任务）改变 §3.4 候选接口的结果集**：本文按 #6249 的现行代码（排除）冻结；owner 若取 A（只排除自身与已有边），只改候选结果，不改接口形状。
- **任务 E 的 `planSpawn` 两处失败形（审阅后补记）**：① 它先校验时区与锚点、后判 `no_due_date`，所以截止日与时区都已清空、或锚点为空的输入会抛 `TypeError`，而 §3.2 认定这两种状态是「不派生」。PR-4a 的服务层第 2、3 步不把它们交给 `planSpawn`，所以不依赖 #6249 改顺序；#6249 若把 `no_due_date` 的判断提到校验之前，只是多一道保险。② 下一期截止日越过 `9999-12-31` 时 `nextOccurrenceDueDate` 抛 `RangeError`；§3.2 第 4 步要它返回 `series_ended`，这一处必须改在 #6249（或按 §4.1 由 PR-4a 改那一行）。
- **D 编号**：本文用到的 D1、D2、D3、D4、D9、D10、D13、D17、D18 都没有被点名，是缺省约束；owner 若认为它们随对应的 S 编号一并获准，需要点名。

### 7.3 锁与合并

- 候选门 27、29、30、G1 的子集行与字段第二租户的门 1 子集行写进锁 §12 `arm-set` 的那次修订：由哪张 PR 承载、何时提交，请 owner 点名（S31 已定内容，未定载体）。
- 那次修订的门号必须一次写齐：`arm-set` 的自检要求门号集合是从 1 起的连续整数（今天是 `range(1,27)`）。M5 的六个整数门号 27–32 里，PR-4a 只承载 27、29、30；28（附件）、31（夹钳）、32（导出）归 PR-4b / 4c。所以修订要把 27–32 一起写进去（4b / 4c 的行在各自 PR 之前记 NOT RUN）并把自检改为 `range(1,33)`，只写 PR-4a 的三个门号会让自检不过。
- 合并顺序：#6249 → PR-4a → {PR-4b, PR-4c}；每张都需要 owner 单独的合并点名（锁 §14-5）。PR-4a 的迁移名必须排在合并那一刻 main 上最晚的迁移之后，届时重核（`[a-23]`）。

### 7.4 冻结稿 v3 新增的 owner 问题

- **Q1 待办项是否显示里程碑**：PR-4a 不改 `/api/tasks/pending`（§3.8）。要在待办里显示里程碑，需要修订锁 §6.1 的 PendingItem 键集与门 5 的逐键断言，并与待办中心线对齐；这要 owner 点名，不在 PR-4a。
- **Q2 调度 leader 锁的规则**（`[a-36]`）：锁 §6.4 只写了不共存，包装器怎样执行它是本文的取值，请 owner 确认或改选。
- **Q3 改字段定义与已存取值**（`[a-38]`）：PR-4c 的投影与 FE-d 的编辑器都按这一条起草，越早定越好；若改成拒绝或加版本前置条件，是 §3.5 的接口改动。
- **Q4 新增的候选门行**：字段第二租户的门 1 子集行（§6.2 M5-g）与里程碑授权格的承载（`[a-39]`），随 §7.3 的那次锁修订一起点名。

---

## 8. 审阅处置

独立审阅的结论与逐条处置记在这里，被拒绝的意见各附一行理由。

### 8.1 第 1 轮（2026-10-10，冻结稿 v1 → v2）

收到的意见清单在交付时被截断：确认项读到两条 P2，次要项读到第 (d) 条中途为止。下表只处置读到的部分；完整清单的补处置见 §8.2。

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
| 11 | NIT | 基线漂移：PR-3b 已在 main，返回形状与翻转行号已变 | 采纳：头部补记新 ref 与行号，§1.3、§4.4、§4.6 改为 PR-3b 已在 main。拒绝其中「现在就 rebase」的部分：本轮只在分支上追加提交、不移动分支；头部已写明实现开工时按当时 main 重核 |
| 12 | P3 | 新的按 org / 按系列 / 含软删的读没有点名 builder；`[own-3b-17]` 需要改写 | 采纳：新增 §4.7 的三个 builder 与同 PR 改写 `[own-3b-17]`；M5-c 加两 org 用户的候选格。M3 既有的两处手写条件不在本 PR 改（§4.7 末句） |
| 13 | P3 | `nextOccurrenceId` 不按 `view` 过滤 | 采纳：§3.8 改为不能 `view` 时为 `null`，`[a-17]` 改写；`seriesId` / `previousOccurrenceId` 照 `parentId` 先例不过滤，登记为 `[a-35]` |
| 14 | P3 | 系列删除没有扩展 M3 的行锁协议，也没有为每一期入队 `deleted` | 采纳：§3.8 冻结四步执行（按 id 升序的有界 `FOR UPDATE`、经 producer 入队）；M5-a 加格 |
| 15 | P3 | 路由合同缺：(a) 两条读不分页未标注；(b) 分页读无稳定排序键；(c) 字段路由的检查顺序；(d) 单 id 下的读缺 org 时属于哪一类 | 采纳：§3.0 标注两条有上限的读不分页、写明缺 org 的分类（(d) 的原文被截断，按 PR-3a `[own-19]` 的口径补全）；§3.4 / §3.5 写排序键；§3.6 / §3.7 写检查顺序；新增 `[a-34]` |

### 8.2 第 1 轮补处置（2026-10-10，冻结稿 v2 → v3）

第 1 轮的完整意见清单（确认项 13 条、次要项 34 条，另有 1 条未确认的 P2）与那一轮的终检结论在交付后补齐。终检判定 6 个确认问题仍未处置、另有 2 条 P3。下表按完整清单的顺序逐条处置；与 §8.1 重复的条目只写指向。

确认项：

| # | 级别 | 意见 | 处置 |
|---|---|---|---|
| 1 | P2 | `recurrence_series_id` 没有索引 | 已在 §8.1 #1 |
| 2 | P2 | 截止日与时区清空后完成 ⇒ 500 | 已在 §8.1 #2 |
| 3 | P1 | §3.8 给 `/pending` 加 `is_milestone`，破坏 PendingItem 键集与门 5 | 采纳：§3.8 只给 `GET /api/tasks` 与清单任务项加列，改正「M2 snake_case」的说法（待办返回 camelCase 的 PendingItem）；§0 第 3 条改为 5 条既有路由；§1.1、§3.0、`[a-18]` 同步；§6.4 加待办不变格；待办显示里程碑列为 §7.4 Q1（锁修订，需 owner 点名） |
| 4 | P2 | 字段定义没有点名的 org 机制，也没有第二租户格；§4.7 说过了头 | 采纳：§4.7 新增 `task-field-access.ts` 的两个 builder 与唯一私有 org 子句，写明绑定表、取值表只从按 org 选出的行连接，`listReusableTaskFieldIds` 两半都限在会话 org（`[a-40]`）；§6.2 M5-g 加字段第二租户格（列表、`PATCH`、`DELETE`、绑定、写取值、读绑定，均 404）与删 org 合取的负控 |
| 5 | P2 | 新路由已裁的行级调用者集合没有格与变异；可复用集合这道门槛未测 | 采纳：新增 §6.2.1，S35、S13、S11、S24、S26 每族一组正格、404 格与变异，含可复用集合格；里程碑格的承载行为 `[a-39]` |
| 6 | P2 | 派生照抄关注人与成员型取值，没过 R17 / N2 的在职判定 | 采纳：§3.2 对负责人、关注人、成员型取值里的 id 一次查询、去掉不在职的，取值去空则不写行；`[a-15]` 扩大；头注调用方清单同 PR 改；M5-a 加格与两个负控 |
| 7 | P1 | 同 #3 | 同 #3 |
| 8 | P2 | 锚点为空 ⇒ 500 | 已在 §8.1 #2 |
| 9 | P2 | 同 #1 | 已在 §8.1 #1 |
| 10 | P2 | 系列删除没有逐期经 PR-3b 的 producer | 已在 §8.1 #14；v3 把 §3.8 第 4 步改写为逐期调用（见下面终检 P3 之一） |
| 11 | P2 | 同 #6 | 同 #6 |
| 12 | P2 | `M5|7|锁序控件` 的正向格空转；调度 leader 锁没有规则 | 采纳：§4.2 冻结 `withOrgStructure`、`createTask` 经包装器取 rank 1，调度器的取锁也经包装器；leader 独占规则为 `[a-36]`（§7.4 Q2）；§6.1 正向格主断言改为「非空、首项 rank 1」，加静态格、leader 共存格与三个负控 |
| 13 | P2 | 原 a-11（重复加边 200 空操作）推翻了 S31 采纳的候选 M5-c 格 | 采纳选项 A（照格）：§3.4 冻结 422 `DUPLICATE`，M5-c 行与 §3.9 同步；`a-11` 收回，§7.1 注明。不需要偏离项 |

次要项：

| # | 级别 | 意见 | 处置 |
|---|---|---|---|
| 1 | P3 | 切片 1 断言的 payload 排在切片 2 | 已在 §8.1 #3 |
| 2 | P3 | 依赖表没有按 org 的索引 | 已在 §8.1 #4（未确认的那条 P2 同指此事） |
| 3 | P3 | 附件行的评论 id 与评论外键 | 已在 §8.1 #5 |
| 4 | NIT | 字段值可存 JSON `null` | 已在 §8.1 #6 |
| 5 | NIT | 缺系列列不自指的 CHECK | 已在 §8.1 #7 |
| 6 | NIT | 约束名、`down()` 逆序 | 已在 §8.1 #8 |
| 7 | NIT | 投影映射键列的 CHECK 与开启状态 | 已在 §8.1 #9 |
| 8 | NIT | 系列自引用外键与保留期作业 | 已在 §8.1 #10 |
| 9 | NIT | 基线漂移 | 已在 §8.1 #11；v3 把头部基线与全文行号重钉到 `9bbbdb29e3` |
| 10 | P3 | 新读没有点名 builder；`[own-3b-17]` 要改 | 已在 §8.1 #12；字段表部分见确认项 #4 |
| 11 | P3 | `nextOccurrenceId` 不按 `view` 过滤 | 已在 §8.1 #13 |
| 12 | P3 | 系列删除的行锁与入队 | 已在 §8.1 #14 |
| 13 | P3 | 同次要项 #1 | 已在 §8.1 #3 |
| 14 | P3 | 路由合同的分页、排序、检查顺序、缺 org 分类 | 已在 §8.1 #15 |
| 15 | P3 | `[a-31]` 的缺省码 | 采纳：缺省改为 `INACTIVE_ORG_MEMBER`，备选反过来（§3.7、§3.9、`[a-31]`） |
| 16 | P3 | 改字段定义对已存取值与并发编辑的影响未定 | 采纳：§3.5 冻结「不改写、不拒绝、照存值读、下次写按新定义校验；后写覆盖先写」为 `[a-38]`，列为 §7.4 Q3 |
| 17 | NIT | `DepItem` 缺逐边可删标记 | 采纳：`DepItem.canRemove`，由 `canManageDependency` 算出，并入 `[a-12]` |
| 18 | NIT | 错误码与既有闭集的对齐 | 采纳：§3.9 把 `INVALID_NAME` 移出新增码，并照实登记与 `NAME_TOO_LONG`、`INVALID_PARENT` 的差异（`[a-32]`） |
| 19 | NIT | §1.2 的 payload 说法与 §4.4 不符 | 采纳：§1.2 改为只放闭集键名与任务域 id |
| 20 | NIT | 锁序控件的负控被写成了正向断言 | 采纳：§6.1 改为「去掉 rank 比较 ⇒ 反序格红」 |
| 21 | P3 | 同次要项 #1 | 已在 §8.1 #3 |
| 22 | P3 | §4.4 的 `clock_timestamp()` 与翻转调用点的应用时钟冲突 | 采纳：§4.4 写明 G1 与派生沿用翻转调用点的 `now`，其余新写入点用 `clock_timestamp()`（`[a-37]`） |
| 23 | P3 | 并发负控依赖时机 | 采纳：§6.2 开头冻结持锁法（挡写不挡读的表锁 + 门 6 的 settle），g1-concurrent 与 M5-c 交叉加边都按它跑 |
| 24 | P3 | g1-repeat 杀不死「去掉 `wasDone`」的变异 | 采纳：§5 新增 g1-repeat-null-row（A6 形夹具），变异改指向它 |
| 25 | P3 | 路由用到的纯函数没有全部点名 | 采纳：§4.1 加路由与纯函数对照表；§3.4 的两端判定改为调用 `canManageDependency` |
| 26 | P3 | 系列三个 id 不按 `view` 过滤 | 已在 §8.1 #13 |
| 27 | P3 | PR-3b 相关说法过时；需要 rebase | 部分采纳：§8.1 #11 已改说法，v3 重钉基线与行号。拒绝其中移动分支的部分：本轮只在分支上追加提交、不 rebase；头部写明实现开工时按当时 main 重核 |
| 28 | P3 | 单 id 集合读缺 org 的分类 | 已在 §8.1 #15 (d) |
| 29 | NIT | 措辞与计数不一致 | 采纳：§7.2 补 D9；§3.4 表里标 `[a-12]`；§0 改为 5 条既有路由；§1.2 改写；两条不分页的读已在 §8.1 #15 标明 |
| 30 | NIT | 绑定 `position` 没有上限，超出列宽会 500 | 采纳：§3.6 限 0..49，越界 422 `INVALID_BINDING`（`[a-32]`） |
| 31 | NIT | 改定义时带同值 `type` 的处理与纯函数不一致 | 采纳：§3.5 写明路由先拒绝任何 `type` 键，再把库里的类型交给 `parseFieldDefinition` |
| 32 | NIT | 派生读哪一刻的输入、何谓「最新」一期未定 | 采纳：§3.2 写明读翻转写入之后的行；「最新」= 没有未软删的后继 |
| 33 | NIT | 锁修订要保持门号连续 | 采纳：§7.3 写明 27–32 一次写齐、自检改为 `range(1,33)` |
| 34 | NIT | 系列删除的门 26 信号未定 | 采纳：见下面终检 P3 之二 |

终检的两条 P3：

| # | 意见 | 处置 |
|---|---|---|
| 1 | §3.8 第 4 步读起来像一次 producer 调用，而 producer 是按任务的 | 采纳：第 4 步改为逐期各调用一次，传那一期自己的 `taskId`、`created_by` 与事件 |
| 2 | 系列删除是多任务删除路径，门 26 没有提到 | 采纳：§3.8 第 5 步写明 PR-3c 合入后接 `taskCountsSignal()`：逐期 `note`、提交后一次 `publish`，收件人取并集、关注人不收，客户端按 500 ms 窗口合并重拉；派生不另发的理由同写；§6.4 加一格门 26 回归 |
