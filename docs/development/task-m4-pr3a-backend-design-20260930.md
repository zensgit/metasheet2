# 任务功能 M4 后端 PR-3a 设计（草案修订 1，2026-09-30）

> **状态：DRAFT。** 本件的基是 main 加任务 D：M3 后端已随 #6229 合入 main（`57621d2403`），本分支在 `f1510d0bed` 并入了 main `cc6ca96ac2`；任务 D（`claude/tasks-d-pure`，Draft #6186）尚未合并。owner 于 2026-10-07 按回复模板裁定 M4 裁决包：R02–R23（含 R17）、N1、N2，以及模板末句一并同意的 R01（M4 退出门集合）与 R04；R12 取本件的收窄版，即 §3.4 的 (a1)、(a2)。同日裁定增删负责人与关注人须直接角色（`[own-53]`）。代码里已裁条目的标签是 `RULED(2026-10-07)`；未裁的（本件自选的 `[own-NN]`、裁决包的缺省实现约束 `[Dx]`、对锁或计划的偏离 `[dev-NN]`）仍标 `ASSUMPTION(task-m4)`；取值都不变（§11）。合并、上 staging、应用 DDL 仍要 owner 另行点名。裁决包是私有件，本文只按条目 id 与日期引用裁定，不引原文。

- **状态**：DRAFT。PR-3a 只作 Draft PR，不合并、不应用 DDL、不部署、不打开任何 `TASKS_*` 开关；§12 里仍待 owner 答的题见各题。
- **修订 1**：三个视角的评审（合规、授权与并发、迁移与 CI）共 25 条，逐条对源码核实后处置，结果见 §14。正文已按处置改过。
- **修订 2**（S1–S4 闸审修复切片）：清单身份在库与读路径两层绑定 org（§2.2、§4.3、§6.2，`[own-37]`）；截止瞬时的年份范围（§5.1，`[own-38]`）；PATCH 的时间戳取在锁后（§4.4、§4.5、§5.3）；设置 PATCH 只读 JSON 请求体（§3.6，`[own-39]`）；§9.2 的部署过渡态与回退三层按 runner 与 Kysely 的实际行为重写（§12-Q10 同改）；按 id 取行的站点与例外（§6.3）；补格清单（§10.10）；§11 补齐 `[own-29]`–`[own-39]`。逐条处置见验证 MD「修复切片（S1–S4 闸审）」一节。
- **修订 3**（S5 与修复切片闸审）：清单写的时间戳取在锁后、只在 SQL 里读一次（§4.4、§4.5），覆盖建清单、改名、归档、取消归档与成员写的事件；截止瞬时只判上界，下界是 `computeDueAt` 的日历探针（§5.1、`[own-38]`）；补格清单（§10.11）。逐条处置见验证 MD「S5 闸修复」一节。
- **S7**（清单项）：§3.4 三条路由的判定顺序与统一 404（`[own-43]`–`[own-45]`）；`listIds` 的同 org 与归档口径（§5.5，`[own-46]`）；单任务配额的计数口径（`[own-47]`）；第五个纯谓词 `visibleTaskListIds`（§4.1）；§13 S7 跨 org 加入格的期望改为「失败于组合外键、零新行」（与 §10.4 负控 1 一致）。
- **S8**（分组）：§3.5 末尾「S8 实现时定下的细则」：缺 org、判定顺序、名字、排序、事件与时间戳、`group_changed` 的 payload、默认组落行、个人分组列表的分页（`[own-48]`–`[own-52]`）；§4.1 补 `parseTaskGroupName`、`syntheticUserDefaultGroup`、`userGroupsWithDefault`、`parseTargetGroupId` 与 `buildTaskListGroupScopeCondition`。
- **修订 4**（S6+S7 闸审修复切片）：owner 2026-10-07 的两项裁定落进正文：R12 的 (a1)、(a2)（§3.4、§11 `[R12]` `[own-25]`、§12-Q16）与增删负责人、关注人须直接角色（§3.4、§5.5 的 `canManageMembers`、§6.3、§11 `[own-53]`）；第六个纯谓词 `canChangeTaskMembers`（§4.1）；名单 `createdAt` 的来源（§3.3、§4.4）；补格清单（§10.12）。逐条处置见验证 MD「S6+S7 闸修复」一节。
- **修订 5**（S9）：R17 与 N2 已于 2026-10-07 裁定采纳（回复模板句含这两条），S9 是必做片：§4.6 改为记裁定与实际落点，删去「owner 不采纳 R17 / N2」的拆除面；§13 S9 / S10 去掉「S9 整片可删」的说法与条件依赖；§12-Q3 只留本件自选的三处；§10.1 的 `task-m4-org-members` 一行与夹具 helper；§11 `[R17] [N2]`、`[own-16]`。实现记录见验证 MD「S9」一节。
- **修订 6**（S10）：鉴权门补齐 M4 的 30 条路由与路由人口格（§10.7 末尾的 S10 实现记录）；迁移改名，排到 main 当时最新的迁移之后（§2.1，SCH-4）；R01 与模板内其余条目、N1、N2 的裁定落进 §10.0、§11、§12；代码里已裁条目的标签改记 `RULED(2026-10-07)`。实现记录见验证 MD「S10」一节。
- **修订 7**（S8–S10 增量闸修复）：R17 的判据写全为登录的两半，会话 org 加账号闸（§4.6，§12-Q3）；删组只写 `group_deleted`（§3.5、§11 `[own-50]`）；鉴权门的停用关系 token、行与路由的分派绑定、只带 `tasks:admin` 的用户（§10.7 的闸修复记录）；§6.3、§10.4 只写现行规则；§12-Q15 问 #6186 的处置；§14 AZ-2 记为已裁。逐条处置见验证 MD「S8–S10 闸修复」一节。
- **修订 8**（2026-10-09）：迁移按 §2.1 的排序规则重新定名为 `zzzz20261009130000_create_task_m4_tables`（§2.1；§13 S1 / S10 的文件名旁加注日期；§9.2 两处以现名复测的日期注）；本件新增的生产源码注释不点名其他线的文件、表与符号（门 15）；代码注释与本文、验证 MD 引用裁定只写条目 id 与日期；后两项只改注释与文档。实现记录见验证 MD「2026-10-09 迁移重新定名与门 15」一节。
- **基座**：M3 后端分支 `claude/tasks-m3-backend` 与任务 D 分支 `claude/tasks-d-pure` 的合并，**以 S0 动手那一刻两条分支的 HEAD 为准**，实际用到的两个 SHA 记在验证 MD 里，不钉在本文抬头。写作时的观测（2026-09-30）：M3 后端 HEAD 是 `9015f9eec0`（该分支在本文初稿之后被 amend 过，初稿钉的 `2adc319436` 已不在分支上；两者只差 M3 验证 MD 的 4 行）；任务 D HEAD 是 `1193f0c0d7`。两者同出 main `4f19aa0b91`，相对它各改 19 个文件，路径交集为 0。S0 必须重跑 `git merge-tree --write-tree` 并重核；行号以各自 HEAD 为准，实现时重核。此后 M3 后端随 #6229 合入 main（`57621d2403`），本分支在 S6 开工前经 `f1510d0bed` 并入 main `cc6ca96ac2`（验证 MD §S6.0）；任务 D 仍是 Draft #6186。
- **锁**：`docs/development/task-feature-design-lock-20260917.md`。锁 §11 规定 M4 的进入条件是上一 PR 的合并授权；本件起草时 M3 后端尚未合并，所以 S0–S5 是先于进入条件的草案栈。M3 后端已于 2026-10-07 随 #6229 合并；本件仍是 Draft，合并另需 owner 点名。锁 §4 写明「本文件不授权写迁移」、§4.2 写明 P1 表「ratify 前不建」；本件的迁移沿用 M3 迁移头注的口径：`Draft migration: do not apply from this PR`。
- **M4 裁决包**：私有件。owner 于 2026-10-07 按回复模板裁定：R02–R23、N1、N2，以及模板末句的 R01、R04，取值与本文所取的推荐值相同；R12 取本件的收窄版（§3.4）。本文只按条目 id 引用（R03、D9 …），不引其原文。已裁条目在代码里标 `RULED(2026-10-07): [Rxx]`，owner 已裁的两项本件自选 `[own-25]`、`[own-53]` 同样标法；本件其余取舍标 `ASSUMPTION(task-m4): [own-NN]`。全表见 §11。
- **纯函数来源**：任务 B（`task-access` / `task-dates` / `task-ids` / `task-completion` / `task-lock-keys`）、任务 C（`task-tree` / `task-membership` / `task-comments` / `task-deletion`）、任务 D（`task-lists` / `task-groups` / `task-settings` / `task-pagination` / `task-reminders`）。服务层只调用，不另写规则（门 20）。任务 D 缺的纯函数由本 PR 补在 `src/tasks/` 下，见 §4.1。
- 前端对接以本文的路径、请求体、成功形状、错误码为准。要改形状，先改本文件再改实现。

M2、M3 已钉死的形状保持不变：列表项 snake_case 六列；不存在、不可见、他 org、已软删一律 404 `{ error: { code: 'NOT_FOUND' } }`；写操作缺 org 是 422 `{ error: { code: 'ORG_MISSING' } }`；403 体是 `{ error: 'Insufficient permissions' }`；成功一律 200。

---

## 1. 范围

**做**（PR-3a）：

1. 一条迁移：8 张 P1 表、`tasks.remind_at` 及其部分索引、`idx_tski_task`、outbox 索引（§2）。
2. R03：`POST /api/tasks` 收日期、时区、`remindAt`；新增 `PATCH /api/tasks/:id`（`expectedVersion`，冲突 409）；详情与 POST / PATCH / complete / reopen 的成功体带 `version`（§5）。
3. R04：`task-access.ts` 新增 `buildTaskByIdCondition`；详情与每条写路由在解析角色时都带上清单成员身份（§6）。
4. 清单、清单成员、清单项、清单动态、分组（清单 scope 与个人 scope）、用户设置的路由（§3）。
5. R15：分页合同，回填 `/api/tasks` 与 `/api/tasks/pending`（§7）。
6. `/api/tasks/pending-count` 读 `badge_scope`（§8）。
7. R17 + N2（owner 2026-10-07 裁定）：成员写入时校验本 org 在职，回填 M2 的 POST 与 M3 的增负责人、增关注人（§4.6，S9）。
8. 门：门 8 A 支与非法 IANA 写入、门 19 的 `i-m4`、候选门 M4-e、候选门 M4-g 中属于后端且不依赖新 flag 的部分。按 R01（2026-10-07 裁定，取推荐值的修订形），后两者不另起字母行键，而是落到整数门号的子集里：M4-e 的内容归门 19 的清单角色行，另加门 1、门 2 的清单子集；M4-g 的内容归门 1 / 2 / 13 / 17 / 20 的 M4 新表面子集（§10.0）。
9. `scripts/ops/staging-tasks-smoke.mjs` 的 preflight 多查三张 M4 表，`TASKS_ENABLED` 的 manifest 条目改写用途与引用位置（§9.2）。两者都只是脚本与登记文本，不触达任何环境。

**不做**：

| 不做的事 | 去向 |
|---|---|
| outbox producer、`TaskScheduler`、delivery worker、钉钉通道、三个 P1 flag 及其 manifest 条目、提醒收件人与扫描窗、每日汇总（含其 TS/SQL 双形对拍）、发送时的在职复核 | PR-3b |
| socket 事件与 handler 回改、M2/M3 全部门行在最终 head 上的回归重跑 | PR-3c |
| 任何前端 | FE-a/b/c |
| N1（增删负责人使状态翻转时补 `completed` / `reopened` 事件） | 本件不做，建议随消费它的扇出放进 PR-3b，见 §12-Q4 |
| 清单 `DELETE`、任何硬删作业（R13）；申请权限流、站内收件箱（锁 §3）；待办中心 registry 接入（R22）；`tasks:admin` 的任何旁路或消费路由（R18）；DML 普查闸（R21）；清单动态推送到群（R19） | 明确不做 |
| 分组自身的重排（拖动整列）；`task_lists.icon` 的读写接口；所有者已离开 org 的清单怎样换所有者 | 本件不做，见 §12 |
| 门 18 的三个新 flag 格、门 21/22 的新 spec 与路由 meta 格 | 分别随 PR-3b 与前端切片 |
| 把 M3 评论列表迁到 `parsePageParams` | 不回改（R15），两套分页规则并存，见 §7.4 |
| 改锁正文（加 `i-m4` 块、加 `arm-set` 行） | 需 owner 点名；本 PR 不改锁，见 §10.3 |

`TASKS_ENABLED` 仍是精确字符串 `'true'` 才挂路由，默认关闭。本 PR **不新增任何 flag**。

---

## 2. 表与迁移

### 2.1 迁移文件

`packages/core-backend/src/db/migrations/zzzz20261009130000_create_task_m4_tables.ts`（S1–S9 时名为 `zzzz20261001090000_create_task_m4_tables`，S10 改名为 `zzzz20261008090000_create_task_m4_tables`，2026-10-09 重新定名为现名，见本条「排序」末尾）

- **排序**：Kysely 按完整文件名排序，`allowUnorderedMigrations: true` 不报乱序，所以名字必须自己排对。规则：完整文件名排在合并时 main 的全部迁移之后（锁 §4 的命名规则），合并前按 main 届时的最大前缀再核一次。本迁移 `ALTER TABLE tasks`、并对 `tasks(id)` 建外键，必须排在 `zzzz20260926120000_create_task_p0a_tables.ts` 之后；取在 M3 分支最晚的 `zzzz20260930090000_create_task_comments.ts` 之后。main 当前最晚是 `zzzz20260927121000_…`。实现当天重查 main 与 M3 分支的最大前缀；`migration-timestamp-uniqueness.guard.test.ts` 要求 `zzzz<14 位>` 前缀全仓唯一。（S1–S4 闸审修复切片时，main 的最晚前缀已是 `zzzz20261001120000_create_approval_form_drafts`，排在旧名之后（SCH-4）。S10 按锁 §4 的命名规则把本迁移改名为 `zzzz20261008090000_create_task_m4_tables`：排在 main 当时（`00aac5b7b4`）最新的迁移之后，本地各任务线分支上没有同一前缀；同改 manifest 的 `purpose` 与形状测试的 import，迁移正文不变。旧名从未在任何共享环境应用过（staging 已应用的迁移清单里没有它）。合并前要按 main 届时的最大前缀再核一次。）（2026-10-09 按本条规则重新定名为 `zzzz20261009130000_create_task_m4_tables`：排在 main `fc139c868e` 的全部迁移之后，本地各分支的迁移目录里没有同一前缀；同改形状测试的 import 与 manifest 的 `purpose`，迁移正文不变，头注只写排序规则。本 PR 从未合并、从未部署；合并前核对各共享环境的迁移台账里没有旧名。）
- **只用一个文件**（`[own-22]`）：staging 的 owner 排除机制只能证明「表不存在」。把加列、建索引与建表放在同一条迁移里，排除这一条时 `remind_at` 与各索引一并被覆盖；拆成只加列或只建索引的迁移就无法用该机制表达。同一条理由也决定了 `tasks.remind_at` 的索引在本迁移里建，不留给 PR-3b 另起一条只建索引的迁移（`[own-26]`）。排除只在任务开关关着的环境里成立，见 §9.2 的三态表。
- 写法照 P0-A：`import { sql, type Kysely } from 'kysely'`，逐条 `` await sql`…`.execute(db) ``，朴素 `CREATE TABLE`（不加 `IF NOT EXISTS`）。头注写 `Draft migration: do not apply from this PR`。朴素 `CREATE TABLE` 有一个部署侧后果：staging 的迁移对齐报告把它判为高风险，共享的 `deploy` 动作会在换上新镜像之后、于对齐门处失败，见 §9.2。不为绕开这一点而改用 `IF NOT EXISTS`：那会让一张形状不同的同名旧表被静默接受。
- 不加进 `MIGRATION_EXCLUDE`；CI 各 lane 默认会跑它（PG14 / PG15 / postgres:15-alpine / PG16）。DDL 不用 PG15 才有的语法；`gen_random_uuid()` 自 PG13 起是内建函数，不装 `pgcrypto`。
- 本迁移不插入任何行，不改 `permissions`。

### 2.2 `up()`，按执行顺序

```sql
-- 1. tasks.remind_at                         ASSUMPTION(task-m4): [R03]；索引属 [R06] [own-26]
ALTER TABLE tasks ADD COLUMN remind_at timestamptz;
CREATE INDEX idx_tsk_remind ON tasks (remind_at) WHERE remind_at IS NOT NULL;
ALTER TABLE tasks ADD CONSTRAINT tasks_id_org_id_key UNIQUE (id, org_id);   -- [own-37] 组合外键的目标

-- 2. task_lists                              列形来自计划 v5 §2.1；不建 owner_id 列是偏离，见 [dev-01]
CREATE TABLE task_lists (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL,
  icon text,
  created_by text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_lists_id_generated_chk CHECK (
    id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
  ),
  CONSTRAINT task_lists_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
  CONSTRAINT task_lists_created_by_printable_chk CHECK (created_by ~ '^[!-~]+$'),
  CONSTRAINT task_lists_name_nonblank_chk CHECK (pg_catalog.btrim(name) <> ''),
  CONSTRAINT task_lists_id_org_id_key UNIQUE (id, org_id)                    -- [own-37]
);

-- 3. task_list_members                       ASSUMPTION(task-m4): [R12]
CREATE TABLE task_list_members (
  list_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id),
  CONSTRAINT task_list_members_list_fk FOREIGN KEY (list_id) REFERENCES task_lists (id) ON DELETE CASCADE,
  CONSTRAINT task_list_members_user_printable_chk CHECK (user_id ~ '^[!-~]+$'),
  CONSTRAINT task_list_members_role_chk CHECK (role IN ('read', 'edit', 'owner'))
);
CREATE UNIQUE INDEX uq_tlsm_owner ON task_list_members (list_id) WHERE role = 'owner';
CREATE INDEX idx_tlsm_user ON task_list_members (user_id);

-- 4. task_list_items                         ASSUMPTION(task-m4): [own-37] 清单与任务同 org
CREATE TABLE task_list_items (
  list_id text NOT NULL,
  task_id text NOT NULL,
  org_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, task_id),
  CONSTRAINT task_list_items_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
  CONSTRAINT task_list_items_list_fk FOREIGN KEY (list_id, org_id)
    REFERENCES task_lists (id, org_id) ON DELETE CASCADE,
  CONSTRAINT task_list_items_task_fk FOREIGN KEY (task_id, org_id)
    REFERENCES tasks (id, org_id) ON DELETE CASCADE
);
CREATE INDEX idx_tski_task ON task_list_items (task_id);            -- 锁 §4.2 最小索引集点名

-- 5. task_groups                             ASSUMPTION(task-m4): [R11] [R23]
CREATE TABLE task_groups (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  scope text NOT NULL,
  list_id text,
  user_id text,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_groups_id_generated_chk CHECK (
    id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
  ),
  CONSTRAINT task_groups_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
  CONSTRAINT task_groups_scope_chk CHECK (scope IN ('list', 'user')),
  CONSTRAINT task_groups_scope_owner_chk CHECK (
    (scope = 'list' AND list_id IS NOT NULL AND user_id IS NULL)
    OR (scope = 'user' AND user_id IS NOT NULL AND list_id IS NULL)
  ),
  CONSTRAINT task_groups_user_printable_chk CHECK (user_id IS NULL OR user_id ~ '^[!-~]+$'),
  CONSTRAINT task_groups_name_nonblank_chk CHECK (pg_catalog.btrim(name) <> ''),
  CONSTRAINT task_groups_position_chk CHECK (position >= 0),
  CONSTRAINT task_groups_id_org_id_key UNIQUE (id, org_id),                  -- [own-37]
  CONSTRAINT task_groups_list_fk FOREIGN KEY (list_id, org_id)               -- [own-37]；个人 scope 的 list_id 为 NULL，MATCH SIMPLE 不检查
    REFERENCES task_lists (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_tgrp_list_default ON task_groups (list_id) WHERE scope = 'list' AND is_default;
CREATE UNIQUE INDEX uq_tgrp_user_default ON task_groups (org_id, user_id) WHERE scope = 'user' AND is_default;
CREATE INDEX idx_tgrp_list ON task_groups (list_id) WHERE list_id IS NOT NULL;
CREATE INDEX idx_tgrp_user ON task_groups (org_id, user_id) WHERE user_id IS NOT NULL;

-- 6. task_group_items                        ASSUMPTION(task-m4): [own-37] 分组与任务同 org
CREATE TABLE task_group_items (
  group_id text NOT NULL,
  task_id text NOT NULL,
  org_id text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, task_id),
  CONSTRAINT task_group_items_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
  CONSTRAINT task_group_items_group_fk FOREIGN KEY (group_id, org_id)
    REFERENCES task_groups (id, org_id) ON DELETE CASCADE,
  CONSTRAINT task_group_items_task_fk FOREIGN KEY (task_id, org_id)
    REFERENCES tasks (id, org_id) ON DELETE CASCADE,
  CONSTRAINT task_group_items_position_chk CHECK (position >= 0)
);
CREATE INDEX idx_tgri_task ON task_group_items (task_id);

-- 7. task_list_events                        闭集 15 词，锁 §4.2，一次写全
CREATE TABLE task_list_events (
  id text PRIMARY KEY,
  list_id text NOT NULL,
  actor_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_list_events_id_generated_chk CHECK (
    id ~ '^[!-~]+$' AND id !~ '__' AND id !~ '^_' AND id !~ '_$'
  ),
  CONSTRAINT task_list_events_list_fk FOREIGN KEY (list_id) REFERENCES task_lists (id) ON DELETE CASCADE,
  CONSTRAINT task_list_events_actor_printable_chk CHECK (actor_id ~ '^[!-~]+$'),
  CONSTRAINT task_list_events_type_chk CHECK (event_type IN (
    'created', 'renamed', 'archived', 'unarchived', 'owner_transferred',
    'member_added', 'member_removed', 'member_role_changed',
    'item_added', 'item_removed',
    'group_created', 'group_renamed', 'group_deleted',
    'field_bound', 'field_unbound'
  ))
);
CREATE INDEX idx_tlev_list_time ON task_list_events (list_id, occurred_at DESC);

-- 8. task_user_settings                      ASSUMPTION(task-m4): [R02]；time_zone 列与其 CHECK 属 [R07]
CREATE TABLE task_user_settings (
  user_id text NOT NULL,
  org_id text NOT NULL,
  badge_scope text NOT NULL DEFAULT 'overdue',
  daily_reminder_enabled boolean NOT NULL DEFAULT false,
  default_remind_policy jsonb NOT NULL DEFAULT '{"mode":"default"}'::jsonb,
  time_zone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id),
  CONSTRAINT task_user_settings_user_printable_chk CHECK (user_id ~ '^[!-~]+$'),
  CONSTRAINT task_user_settings_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
  CONSTRAINT task_user_settings_badge_scope_chk CHECK (badge_scope IN ('off', 'overdue', 'overdue_or_today')),
  CONSTRAINT task_user_settings_daily_needs_tz_chk CHECK (daily_reminder_enabled = false OR time_zone IS NOT NULL)
);

-- 9. task_notification_deliveries            ASSUMPTION(task-m4): [D1] [R23]；本 PR 只建表，无写入方
CREATE TABLE task_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,                                   -- 不带默认值（锁 §4.3：不写 'default'）
  source_type text NOT NULL,
  source_id text,
  source_key text NOT NULL,
  recipient_user_id text NOT NULL,
  recipient_role text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claim_worker_id text,
  delivered_at timestamptz,
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  redelivery_safe boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_notification_deliveries_org_id_printable_chk CHECK (org_id ~ '^[!-~]+$'),
  CONSTRAINT task_notification_deliveries_recipient_printable_chk CHECK (recipient_user_id ~ '^[!-~]+$'),
  CONSTRAINT task_notification_deliveries_role_chk CHECK (
    recipient_role IN ('creator', 'assignee', 'follower', 'list_member')
  ),
  CONSTRAINT task_notification_deliveries_status_chk CHECK (
    status IN ('pending', 'sending', 'sent', 'retrying', 'failed', 'skipped', 'outcome_unknown')
  ),
  CONSTRAINT task_notification_deliveries_attempt_count_chk CHECK (attempt_count >= 0),
  CONSTRAINT task_notification_deliveries_delivered_status_chk CHECK (delivered_at IS NULL OR status = 'sent')
);
CREATE UNIQUE INDEX uq_tskn_source_key ON task_notification_deliveries (org_id, source_key);
CREATE INDEX idx_tskn_claim ON task_notification_deliveries (status, next_attempt_at);
CREATE INDEX idx_tskn_reclaim ON task_notification_deliveries (status, claim_expires_at);
CREATE INDEX idx_tskn_source ON task_notification_deliveries (org_id, source_type, source_id);
```

说明：

- **外键行为**：凡指向 `tasks(id)`、`task_lists(id)`、`task_groups(id)` 的外键都是 `ON DELETE CASCADE`。理由有二：现有真库夹具与 staging 冒烟用 `DELETE FROM tasks WHERE org_id …` 清理，非级联外键会让这些删除在有清单行时报 23503；清单没有删除路由（R13），级联只在测试清理与将来的硬删作业里发生。任务软删**不**触发级联：`task_list_items`、`task_group_items` 的行不删，读路径用 `tasks.deleted_at` 把它们滤掉（R13）。没有恢复软删的接口，也没有硬删作业，所以清单 scope 里已软删任务留下的行是永久的；它们对摆放下标的影响由 §3.5 的「可见集」规则处理。
- **org 一致性**（`[own-37]`，S1–S4 闸审 M4G1-AUTHZ-1 / SCH-1 之后加入）：清单项与分组项各带一列 `org_id`，以组合外键同时指向两端的 `(id, org_id)`，所以一行清单项连接的清单与任务、一行分组项连接的分组与任务，必是同一个 org 的行；清单 scope 分组以 `(list_id, org_id)` 指向其清单。三张被引用表各加 `UNIQUE (id, org_id)`（`tasks` 上的那一条随本迁移建、随 `down()` 删）。引用列一律 `NOT NULL`（`MATCH SIMPLE` 遇到 NULL 不检查），唯一例外是 `task_groups.list_id`，它恰在个人 scope 为 NULL。外键的 `ON UPDATE` 是缺省的 `NO ACTION`：有清单项的任务或清单不能改 `org_id`。`task_list_members` 不带 `org_id`：成员行不连接任何任务，它所属的 org 就是其清单的 org。读路径另有一道同 org 比较（§6.2），不依赖这里的约束。
- **人员列**都是 `text` 加单合取可打印 CHECK，不对 `users` 建外键（与 P0-A 一致）。
- **CHECK 里的函数调用**：只有两处名字非空 CHECK 调用 `btrim`，写作 `pg_catalog.btrim(name)`（S1 实现时从 P0-A 的裸名 `btrim` 改为显式限定，只改拼写）。`pg_get_constraintdef` 对两种写法输出相同的 `btrim(name)`；这样写是为了让「CHECK 不调用未限定函数」可以直接从源码读出。pg_restore 把 `search_path` 置空时，`pg_catalog` 仍然隐式在搜索路径上，所以两种写法恢复时都能解析；`task-m4-schema` 另有一格经 `pg_depend` 断言这八张表的约束与列缺省不依赖 `pg_catalog` 之外的函数。
- **生成 id**：`task_lists.id`（`tlst_`）、`task_groups.id`（`tgrp_`）、`task_list_events.id`（`tlev_`）用四合取 CHECK；成员表、清单项表、分组项表的主键是复合键；outbox 的 id 是 uuid（R23）。
- **不设数据库硬限额**（R14）：成员数、清单数、分组数的上限只在纯函数常量里（D14）。
- `task_lists` **没有 `owner_id` 列**（`[dev-01]`）。这是对已定方向条目的**偏离**，不是填空：锁 §13-15 的标题就带 `owner_id`，其来源计划 v5 §2.1 的 `task_lists` 列清单里有这一列。偏离的只是存放位置，语义照旧（创建人不可变、所有者可转、原所有者降为 `edit`）：所有者的唯一真相是 `task_list_members.role = 'owner'` 那一行，由 `uq_tlsm_owner` 保证至多一行；接口里的 `ownerId` 从这一行读出。两处都存就得在转让事务里双写，且没有约束能保证两者相等。以后要补列，加列再从成员行回填即可；反过来先建后删则要 `DROP COLUMN`。迁移与服务代码里的注释写「偏离锁 §13-15」，不写成本件的自选项。是否接受见 §12-Q9。
- `task_lists.icon` 按计划建列，本 PR 的接口不读不写（恒为 NULL）（`[own-03]`）。
- `idx_tsk_remind`（`[own-26]`）：谓词只有 `remind_at IS NOT NULL`，不带 `status` 与 `deleted_at`。PR-3b 的扫描条件取决于未裁的 R06，现在只能确定它按 `remind_at` 的区间取行；更窄的谓词可能在那时被证明是错的，而改索引又是一条只动索引的迁移。命名沿用 P0-A 的 `idx_tsk_*`。
- `default_remind_policy` 不加数据库 CHECK：闭集 `{"mode":"default"}` / `{"mode":"none"}` 由 `parseRemindPolicy` 把关，jsonb 留扩展位（R02）。
- 「outbox 三条同形」按 claim / reclaim / source 三条非唯一索引理解，`(org_id, source_key)` 唯一索引另算（D1）。
- 锁的最小索引集之外多建的索引（`[own-23]`）：`idx_tlsm_user`（「我的清单」与角色解析都按 `user_id` 找成员行，主键前导列是 `list_id`，理由同 `idx_tska_user`）、`idx_tgrp_list`、`idx_tgrp_user`、`idx_tgri_task`、`idx_tlev_list_time`。

### 2.3 `down()`

与 `up()` 严格逆序：先逐条 `DROP INDEX IF EXISTS`（`idx_tskn_source` → `idx_tskn_reclaim` → `idx_tskn_claim` → `uq_tskn_source_key` → `idx_tlev_list_time` → `idx_tgri_task` → `idx_tgrp_user` → `idx_tgrp_list` → `uq_tgrp_user_default` → `uq_tgrp_list_default` → `idx_tski_task` → `idx_tlsm_user` → `uq_tlsm_owner`），再 `DROP TABLE IF EXISTS`（`task_notification_deliveries` → `task_user_settings` → `task_list_events` → `task_group_items` → `task_groups` → `task_list_items` → `task_list_members` → `task_lists`），然后 `ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_id_org_id_key`（引用它的两张表此时已删），最后 `DROP INDEX IF EXISTS idx_tsk_remind`、`ALTER TABLE tasks DROP COLUMN IF EXISTS remind_at`。

`down()` 的验证进 lane，不靠手工：`task-m4-schema.db.test.ts` 有一格 import 迁移模块，在**同一条连接、同一个事务**里先记下目录快照（八张表与 `tasks.remind_at` 的列集、`pg_indexes.indexdef`、`pg_get_constraintdef`，另含 `tasks` 上的 `tasks_id_org_id_key` 约束与索引），跑 `down()`，断言八张表的 `to_regclass` 为空、`remind_at` 列、`idx_tsk_remind` 与 `tasks_id_org_id_key` 不存在，再跑 `up()`，断言快照逐项相等，最后无条件回滚。Postgres 的 DDL 是事务性的，lane 又是逐文件串行（`fileParallelism: false`），回滚之后别的文件看到的库没有变过。「回滚确实发生」由后一格证明：事务开始前记下 `task_lists` 的 OID 并经连接池插一行哨兵清单；事务之后 OID 不变、哨兵行仍在（提交了的 `down()` + `up()` 会换 OID 并丢掉这一行）。

两处实现细节，漏了这一格会误红：

- `up` / `down` 的参数是 `Kysely`，不是 `pg` 的 client。写法是 `await db.transaction().execute(async (trx) => { …; await down(trx); …; await up(trx); …; throw ROLLBACK_SENTINEL })`，外层只吞这个哨兵对象、其余异常照抛；`Transaction` 继承 `Kysely`，可以直接传给 `up` / `down`，全程在同一条连接上。事务里的断言查询也只经 `trx` 发。
- 列快照只比「列名、类型（`format_type`）、可空、缺省表达式」，**不比 `ordinal_position` / `attnum`**：重新 `ADD COLUMN` 的 `remind_at` 拿到新的列号，比列号必红。索引按 `indexname` 排序后比 `indexdef`，约束按 `conname` 排序后比 `pg_get_constraintdef`。

这一格的约束：该文件不启动 `MetaSheetServer`；事务期间不经连接池发别的查询（`DROP` 持有的排他锁会把它们挂住）。在一次性库上手工跑 `up → down → up` 的记录仍写进验证 MD，作为补充。

---

## 3. 接口

### 3.0 共性

- 路由工厂仍是 `tasksRouter()`，挂载点不变（审批段之后）。新路由写在两个新文件里，由 `tasksRouter()` 内部注册，**不新增挂载、不新增 flag 读点**：`src/routes/tasks-lists.ts`（清单、成员、清单项、动态、分组）与 `src/routes/tasks-settings.ts`（设置）。两个文件各导出一个注册函数（`registerTaskListRoutes(router)`、`registerTaskSettingsRoutes(router)`），把路由直接注册到 `tasksRouter()` 的**同一个** `router` 上，不另建嵌套 `Router()`：这样 `router.stack` 是平的，门 1 / 2 / 16 的路由人口可以从它机械枚举（§10.7）。`tasksRouter()` 里对这两个函数的调用各占一行，是门 13 负控的改写点（§10.7）。文件名以 `tasks` 开头，落在门 7 的扫描根 `src/routes/tasks*` 内。`actorId` / `orgId` / `sendError` 从 `routes/tasks.ts` 移到 `src/routes/tasks-http.ts` 共用。
- 每条路由都是 `authenticate` + `rbacGuard('tasks', 'read' | 'write')`。没有任何路由用 `tasks:admin`（R18）。
- org 只取 `req.authenticatedTenantId`。缺 org：写路由 422 `ORG_MISSING`；集合型读路由 200 `{ items: [], degraded: true, reason: 'org_missing' }`（不带 `total`）；单对象读路由（清单详情、设置）404 `NOT_FOUND`（`[own-19]`）。判定都在 handler 内、`rbacGuard` 之后。
- 行级判定失败一律 404 `NOT_FOUND`，不区分「不存在 / 他 org / 不是成员 / 是成员但没有这项能力」（`[own-09]`）。行级从不返回 403。
- **清单路由的第一道行级判定永远是「调用者是该清单的成员」**（清单 `view`）。没有成员行的调用者，不论路径参数与请求体是什么、不论目标是不是他自己，都得到与「清单不存在」逐字节相同的 404，并且不读、不回任何成员或清单数据。非成员能接触到清单的地方只有两处，都只对**任务创建人**、都只涉及他自己的任务（`[own-25]`，§12-Q16）：① §3.4 里把自己的任务移出清单的那条支路，它有自己的逐字节统一 404；② 任务详情的 `listIds`（§5.5）对创建人列出包含该任务的全部清单 id，只给 id，不给名字、成员或任何清单字段。除此之外，非成员取任何 `/api/task-lists/:id…` 都是上面那个 404。
- 请求体与路径参数的校验都在能力检查之后（M3 同）：看不到的对象不论请求体、路径里的用户 id 或任务 id 如何，都是 404，不是 422。
- 行级规则全部来自 `src/tasks` 的纯函数（门 20）；服务层只负责取行、调用、落库。清单级动作用 `canListAction`；它表达不了的三条组合规则（本人退出、加入清单的两端判定、移出清单的两条支路）在 `task-lists.ts` 里各补一个纯谓词（§4.1），不写在服务里。
- 错误码命名（`[own-09]`）：纯函数的 `reason` 转大写即 HTTP 码（`invalid_role` → `INVALID_ROLE`）；`not_found` → 404 `NOT_FOUND`；其余一律 422，只有 `VERSION_CONFLICT`（409）例外。
- 成功体 camelCase；时间是 ISO-8601 字符串或 `null`。列表项沿用 M2 的 snake_case 六列。
- 空操作返回 200，不写行、不写事件。
- 路径参数里的用户 id 与请求体里的用户 id 都过 M3 的成员 id 校验器 `isValidMemberId`；不合法是 422 `INVALID_MEMBER`（任务负责人 / 关注人路由沿用 M3 的 `INVALID_ASSIGNEES`）。

### 3.1 任务路由（既有前缀）

| 方法 路径 | 码 | 行级 | 请求 | 成功 200 | 错误 | 幂等 |
|---|---|---|---|---|---|---|
| `POST /api/tasks` | write | — | M2 三字段，另加可选 `dueDate` `dueTime` `startDate` `startTime` `timeZone` `remindAt` | `{ id, version }` | 422 `ORG_MISSING` `INVALID_TITLE` `INVALID_MODE` `INVALID_ASSIGNEES` `INVALID_DATE` `INVALID_TIME_ZONE` `TIME_ZONE_REQUIRED` `INVALID_REMIND_AT` `INACTIVE_ORG_MEMBER` | 否（每次新建） |
| `PATCH /api/tasks/:id` | write | `edit` | `{ expectedVersion, title?, description?, dueDate?, dueTime?, startDate?, startTime?, timeZone?, remindAt? }` | `{ id, version }` | 404；422 `ORG_MISSING` `INVALID_VERSION` `INVALID_TITLE` `INVALID_DESCRIPTION` `INVALID_DATE` `INVALID_TIME_ZONE` `TIME_ZONE_REQUIRED` `INVALID_REMIND_AT`；409 `{ error: { code: 'VERSION_CONFLICT' }, currentVersion }` | 同一请求重放：首次成功后 `version` 已变，重放得 409；内容与现值相同的请求是空操作 |
| `GET /api/tasks/:id` | read | `view` | — | M3 详情，另加 `description` `startDate` `startTime` `remindAt` `listIds` | 404 | — |
| `POST /api/tasks/:id/complete` | write | `complete`；零负责人任务只有创建人（§6.3） | — | `{ done, version }` | 同 M2 | 同 M2 |
| `POST /api/tasks/:id/reopen` | write | `reopen`；零负责人任务只有创建人（§6.3） | `{ scope? }` | `{ ok: true, version }` | 同 M2 | 同 M2 |
| `GET /api/tasks` | read | 视角臂 | query `view` `limit` `offset` | `{ items, total }` | 422 `INVALID_LIMIT` `INVALID_OFFSET`；坏 `view` 仍是 200 降级 | — |
| `GET /api/tasks/pending` | read | pending 链 | query `limit` `offset`；头 `x-viewer-time-zone` | `{ items, total }` | 422 `INVALID_LIMIT` `INVALID_OFFSET` | — |
| `GET /api/tasks/pending-count` | read | pending 链 | 头 `x-viewer-time-zone` | `{ count }`；`badge_scope='off'` 时 `{ count: 0, badgeScope: 'off' }` | — | — |

M3 的其余路由（设父、父候选、增删负责人、切模式、关注人、退出、评论、删除）路径与形状不变；变化有三处：角色解析带上清单身份（§6）；增删负责人与增删关注人这四条写要求调用者对任务有直接角色（创建人或负责人），不满足是与缺失 id 相同的 404（`[own-53]`，§6.3）；增负责人 / 增关注人多一个 422 `INACTIVE_ORG_MEMBER`（§4.6）。

`PATCH /api/tasks/:id` 是 `/api/tasks/` 下唯一的单段 PATCH，没有静态单段 PATCH 与它冲突；其余新路径都在新前缀下。

### 3.2 清单

`List` 形状：`{ id, name, createdBy, ownerId, archivedAt, createdAt, updatedAt, myRole }`。`ownerId` 取自角色为 `owner` 的成员行；`myRole` 是调用者在该清单的成员角色（`read` / `edit` / `owner`）。

清单级能力由任务 D 的 `canListAction({ role, isCreator }, action)` 判定：`owner` 全部；`edit` 除转让外全部；`read` 只有 `view`；`archive` / `unarchive` 对清单创建人额外放行。

| 方法 路径 | 码 | 清单能力 | 请求 | 成功 200 | 错误 | 幂等 |
|---|---|---|---|---|---|---|
| `POST /api/task-lists` | write | — | `{ name }` | `List`（调用者为 `owner`） | 422 `ORG_MISSING` `INVALID_NAME` `NAME_TOO_LONG` | 否 |
| `GET /api/task-lists` | read | 成员 | query `includeArchived`（缺省或 `false` 不含已归档；`true` 含）`limit` `offset` | `{ items: List[], total }` | 422 `INVALID_FILTER` `INVALID_LIMIT` `INVALID_OFFSET` | — |
| `GET /api/task-lists/:id` | read | `view` | — | `List` | 404 | — |
| `PATCH /api/task-lists/:id` | write | `rename` | `{ name }` | `List` | 404；422 `ORG_MISSING` `INVALID_NAME` `NAME_TOO_LONG` | 同名是空操作 |
| `POST /api/task-lists/:id/archive` | write | `archive` | — | `List` | 404；422 `ORG_MISSING` | 已归档是空操作 |
| `POST /api/task-lists/:id/unarchive` | write | `unarchive` | — | `List` | 404；422 `ORG_MISSING` | 未归档是空操作 |
| `GET /api/task-lists/:id/events` | read | `view` | query `limit` `offset` | `{ items: [{ id, listId, actorId, eventType, payload, occurredAt }], total }` | 404；422 分页 | — |

没有 `DELETE /api/task-lists/:id`（R13）。归档不改变任务状态、可见性、可编辑性；pending、五视角、角色解析都不看 `archived_at`；它只影响 `GET /api/task-lists` 的缺省过滤。

### 3.3 清单成员

成功体统一为 `{ id, members: [{ userId, role }] }`（`id` 是清单 id，`members` 按 `userId` 字节序，形同 M3 的负责人响应）。

| 方法 路径 | 码 | 清单能力 | 请求 | 纯函数 | 错误 | 幂等 |
|---|---|---|---|---|---|---|
| `GET /api/task-lists/:id/members` | read | `view` | query `limit` `offset` | — | 404；422 分页。成功体 `{ items: [{ userId, role, createdAt }], total }` | — |
| `POST /api/task-lists/:id/members` | write | `manage_members` | `{ userId, role: 'read' \| 'edit' }` | `applyAddMember` | 404；422 `ORG_MISSING` `INVALID_MEMBER` `INVALID_ROLE` `INACTIVE_ORG_MEMBER` `LIMIT` | 已是成员是空操作（不改角色） |
| `PATCH /api/task-lists/:id/members/:userId` | write | `manage_members` | `{ role: 'read' \| 'edit' }` | `applyChangeMemberRole` | 404（含目标不是成员）；422 `ORG_MISSING` `INVALID_MEMBER` `INVALID_ROLE` `OWNER_MUST_TRANSFER` | 同角色是空操作 |
| `DELETE /api/task-lists/:id/members/:userId` | write | 调用者**是成员**，**并且**（有 `manage_members`，或 `:userId` 是调用者本人）（`[own-14]`） | — | `canRemoveListMember`、`applyRemoveMember` | 404；422 `ORG_MISSING` `INVALID_MEMBER` `CREATED_BY_IMMUTABLE` `OWNER_MUST_TRANSFER` | 调用者过了行级判定之后，目标不是成员是空操作 |
| `POST /api/task-lists/:id/transfer-owner` | write | `transfer_owner`（只有 `owner`） | `{ userId }` | `applyTransferOwner` | 404；422 `ORG_MISSING` `INVALID_MEMBER` `TARGET_NOT_MEMBER` `INACTIVE_ORG_MEMBER` | 目标就是现任所有者是空操作 |

- 名单的 `createdAt`（`GET …/members`）是成员行的 `created_at`：所有者行在建清单时复制清单行的锁后读数（§4.4）；经 `POST …/members` 加入的成员行取列缺省 `now()`，即该次写事务的开始时刻，取在等结构锁之前。所以 `createdAt` 只表示「何时成为成员」，不与 `/events` 的 `occurred_at` 排序对齐：排在同一用户的移除之后执行的重新加入，其 `createdAt` 可以早于那条 `member_removed`。排序与先后以 `/events` 为准。
- `owner` 角色只经转让产生，不能经 POST / PATCH 直接指派（`parseTaskListMemberRole` 拒绝）。
- 清单创建人永远是成员，移除请求是 422；所有者不能被移除、不能被改角色，只能先转让（R12）。
- 转让成功后原所有者降为 `edit`。两行的写入顺序是**先降后升**：`uq_tlsm_owner` 是非延迟的部分唯一索引，先升会撞 23505。
- **移除成员的判定顺序**（锁后）：① 按 org 取清单行，没有 ⇒ 404；② 取全部成员行，得出调用者的角色（没有行即 `none`）；③ `canRemoveListMember({ role, isSelf })` 为假 ⇒ 404，`role` 为 `none` 时它恒为假，所以不是成员的人即使目标写的是自己也到不了后面；④ 校验 `:userId` 的形状，不合法 ⇒ 422 `INVALID_MEMBER`；⑤ `applyRemoveMember`。成功体里的成员名单只在 ③ 通过之后才会被组装。这个顺序保证同 org 的非成员对自己发 `DELETE` 得到 404，响应里没有任何成员 id；被移出的前成员同样得到 404。
- 本人退出的边界：`read` 成员可以退出；清单创建人退出是 422 `CREATED_BY_IMMUTABLE`；所有者退出是 422 `OWNER_MUST_TRANSFER`；`read` 成员移除别人是 404。
- **转让目标要过在职校验**（`[own-27]`，随 R17）：成员行不会在 `user_orgs.is_active` 变假时被清掉，而所有权只能由所有者转让、没有管理员旁路（R18），所以转让目标除了是成员，还须是本 org 的在职成员。校验时机同增负责人：`applyTransferOwner` 判定为真的转让（事件非空）才校验，未通过 ⇒ 422 `INACTIVE_ORG_MEMBER`，不写行。
- 已知的死角，本 PR 不解决：**现任所有者自己离开 org 之后**，这张清单没有人能转让所有权。`edit` 成员仍可改名、管成员、管分组、归档，失去的只是「转让」这一项。怎样给它换所有者需要 owner 定，见 §12-Q17。

### 3.4 清单项

| 方法 路径 | 码 | 行级 | 请求 | 成功 200 | 错误 | 幂等 |
|---|---|---|---|---|---|---|
| `GET /api/task-lists/:id/items` | read | 清单 `view` | query `limit` `offset` | `{ items, total }`，项形状同 `GET /api/tasks`（snake_case 六列），只含未软删任务，按 `TASK_PAGE_SORT_KEY`（`[own-43]`） | 404（缺 org 也是 404；非成员的 404 先于分页的 422，`[own-43]`）；422 分页 | — |
| `POST /api/task-lists/:id/items` | write | 清单 `add_item` **且** 调用者对任务有**直接角色**带来的 `edit`（创建人或负责人；清单身份带来的 `edit` 不算，`[own-25]`）**且** 同 org | `{ taskId }` | `{ listId, taskId }` | 404（三个条件任一不满足）；422 `ORG_MISSING` `INVALID_TASK` `LIMIT`。判定顺序见下（`[own-44]`） | 已在清单是空操作（在任务端判定之后） |
| `DELETE /api/task-lists/:id/items/:taskId` | write | 成员支路：清单 `remove_item` **且** 任务 `edit`（含清单身份）**且** 同 org。创建人支路（`[own-25]`）：调用者是任务创建人、同 org、且该清单项确实存在 | — | `{ listId, taskId }` | 404（全部失败逐字节同一个，`[own-45]`）；422 `ORG_MISSING` | 成员支路下不在清单是空操作；创建人支路下不在清单是 404 |

加入成功时同一事务写两条事件（D2）：`task_events.list_added`（payload `{ listId }`）与 `task_list_events.item_added`（payload `{ taskId }`）。移出对称。移出时同事务删掉该任务在本清单各分组里的分组项（别的清单的分组、个人分组不动）。两条事件的 `actor_id` 是调用者；`occurred_at` 是锁后在 SQL 里读一次的同一个瞬时（§4.4）：加入时清单项行的 `created_at` 取这一读数、两条事件从清单项行复制；移出时清单事件取这一读数、任务事件从清单事件行复制。清单项的写不碰 `task_lists.updated_at` 与 `tasks` 行。

判定顺序（锁后；S7 实现时定，`[own-44]` `[own-45]`）：

- **加入**：清单按 id 与 org 取、调用者有成员行（404）→ 清单 `add_item`（404；所以没有它的成员不论请求体如何都是 404）→ 请求体 `taskId` 是可打印 ASCII 字符串（否则 422 `INVALID_TASK`，`[own-44]`）→ 任务按 id 与 org 取、未软删（404）→ `canAddTaskToList`（404）→ `planAddTaskToList`：已在清单 ⇒ 空操作，配额 ⇒ 422 `LIMIT`。空操作与配额排在任务端判定之后：对任务没有直接 `edit` 的调用者（包括只有清单身份的 `edit` 成员重发一条已在清单里的任务）得到的都是 404。清单项行的 `org_id` 写两行按 id 取出时绑定的那个 org。
- **移出**：清单按 id 与 org 取，**不要求成员行**（创建人支路要用；没有成员行时角色为 `none`）→ 任务按 id 与 org 取、未软删 → 完整角色集（含清单身份）→ 任务当前所属清单 → `canRemoveTaskFromList`。到这一步之前清单的任何信息都不进响应；路径里不可存的 id（两种）、清单不存在、他 org、任务不存在 / 已软删 / 他 org、两条支路都不成立，响应逐字节相同（`[own-45]`）。

两条规则都由 `task-lists.ts` 的纯谓词给出（§4.1）：`canAddTaskToList` 在函数内部用空的清单身份解析任务角色，调用方传不进清单身份；`canRemoveTaskFromList` 接收完整角色集、`isTaskCreator`、`itemExists`。

现行规则（owner 2026-10-07 裁定：R12 取本件的收窄版 (a1)、(a2)；增删负责人与关注人须直接角色；`[own-25]` `[own-53]`）：

- **(a1) 加入**：任务端要求调用者对任务有直接角色带来的 `edit`（创建人或负责人）；清单身份带来的 `edit` 不算。这一半收窄 R12(a) 的推荐值。
- **(a2) 创建人移出与 `listIds`**：任务创建人可以不经成员身份把自己的任务移出任一包含它的清单；详情的 `listIds`（§5.5）对任务创建人列出包含该任务的**全部**清单 id，对其他人只列出他自己是成员的那些。只给 id，不给清单名；非成员取清单详情仍是 404。这一半是给任务创建人的一项新能力（相对 R12(a) 的推荐值是放宽，不是收窄），也是 §3.0「成员身份是第一道判定」唯一的例外。
  - 这条支路的 404 规则：清单不存在、他 org、任务不是调用者创建的、任务不在该清单，四种情况的响应逐字节相同。
  - 事件照写两条，`actor_id` 是任务创建人，即使他不是清单成员。
- **增删负责人与关注人**（M3 的四条写：`POST` / `DELETE …/assignees`、`POST` / `DELETE …/followers`）要求调用者对任务有直接角色（创建人或负责人），由纯谓词 `canChangeTaskMembers` 判定（§4.1、§6.3）；不满足是与缺失 id 相同的 404。只有清单身份的调用者照常可以 PATCH、设父、切模式、完成与重启（`canChangeCompletion`）、评论。关注人退出（`POST …/leave`）是自己的能力，不受这条影响。
- **配额**：单任务至多属于 10 张清单（D14），计数含已归档的清单与调用者不是成员的清单（`[own-47]`）；已在清单的空操作先于配额判定。

已软删任务的清单项经这两条路由都取不到（任务行按 `deleted_at IS NULL` 取），行保留（R13）。

### 3.5 分组

`Group` 形状：`{ id, scope, name, position, isDefault }`。`id` 是字符串；唯一的例外是个人 scope 里尚未落行的默认组，它的 `id` 是 `null`（见下「默认组」）。分组项（摆放）形状：`{ groupId, taskId, position }`，其中 `position` 是该任务在所属分组**可见集**里的 0 起稠密下标（见下「可见集与下标」），不是库里的原始列值。

清单 scope：

| 方法 路径 | 码 | 清单能力 | 请求 | 成功 200 | 错误 | 幂等 |
|---|---|---|---|---|---|---|
| `GET /api/task-lists/:id/groups` | read | `view` | query 分页 | `{ items: Group[], total }`，按 `position, id` | 404；422 分页 | — |
| `POST /api/task-lists/:id/groups` | write | `manage_groups` | `{ name }` | `Group` | 404；422 `ORG_MISSING` `INVALID_NAME` `NAME_TOO_LONG` `LIMIT` | 否 |
| `PATCH /api/task-lists/:id/groups/:groupId` | write | `manage_groups` | `{ name }` | `Group` | 404（含分组不属于该清单）；422 同上 | 同名是空操作 |
| `DELETE /api/task-lists/:id/groups/:groupId` | write | `manage_groups` | — | `{ id, deleted: true, reassignedTo }` | 404；422 `ORG_MISSING` `IS_DEFAULT` | 已不存在是 404 |
| `GET /api/task-lists/:id/group-items` | read | `view` | query 分页 | `{ items: 摆放[], total }`，按 `group_id, position, task_id` | 404；422 分页 | — |
| `PUT /api/task-lists/:id/group-items/:taskId` | write | `manage_groups`，且任务是该清单的未软删项 | `{ groupId, position }`，`groupId` 为 `null` 表示默认组 | `{ taskId, groupId, position }` | 404；422 `ORG_MISSING` `INVALID_GROUP` `INVALID_POSITION` | 同组同位是空操作 |

个人 scope（R11：只用于本人负责的任务）：

| 方法 路径 | 码 | 行级 | 请求 | 成功 200 | 错误 |
|---|---|---|---|---|---|
| `GET /api/task-groups` | read | 本人、本 org | query 分页 | `{ items: Group[], total }`（不写库；还没有默认组行时，返回恰好一项合成的默认组，`id` 为 `null`，`total` 为 1） | 422 分页 |
| `POST /api/task-groups` | write | 本人 | `{ name }` | `Group` | 422 `ORG_MISSING` `INVALID_NAME` `NAME_TOO_LONG` `LIMIT` |
| `PATCH /api/task-groups/:groupId` | write | 分组属于本人本 org | `{ name }` | `Group` | 404；422 |
| `DELETE /api/task-groups/:groupId` | write | 同上 | — | `{ id, deleted: true, reassignedTo }` | 404；422 `ORG_MISSING` `IS_DEFAULT` |
| `GET /api/task-groups/items` | read | 本人 | query 分页 | `{ items: 摆放[], total }`，只含仍在本人 assigned 臂上的未软删任务 | 422 分页 |
| `PUT /api/task-groups/items/:taskId` | write | 任务在本人 assigned 臂上 | `{ groupId, position }`，`groupId` 为 `null` 表示默认组 | `{ taskId, groupId, position }`，`groupId` 是默认组落行后的真实 id | 404；422 `ORG_MISSING` `INVALID_GROUP` `INVALID_POSITION` |

M4 的路由表里没有「同方法的静态段与参数段」相撞的一对：`/api/task-groups/items` 上只有 `GET`，带 `:groupId` 的路由只有 `PATCH` 与 `DELETE`；`PUT /api/task-groups/items/:taskId` 没有同方法的 `/:groupId/…` 对手；`/api/task-lists/:id/` 之下的各段都是静态字面量。所以门 13 的「静态先于参数」对 M4 不产生新的计分格。注册顺序上仍把静态段写在前面，只是防将来有人加 `GET /api/task-groups/:groupId`，不拿它当证据。

分组规则（R11、D2、D14，细节是本件取舍 `[own-12]` `[own-13]` `[own-24]`）：

- **默认组**：每个 scope 容器至多一行（部分唯一索引）。
  - 清单 scope：默认组在**建清单的同一事务**里创建，所以恰好一行。
  - 个人 scope（`[own-24]`）：容器 `(org, user)` 没有「创建」这个时刻，而 `GET` 不写库。所以默认组**在接口上始终恰好一个，在库里可以还没有行**。对 R11 的推荐值，接口层是符合的（任何时刻 `GET` 都恰好给出一个 `isDefault` 组）；库层从「恰好一行」变成「至多一行，首次写时落行」，这是存储层的取舍，单列为 `[own-24]`，由 owner 在 §12-Q7 一并确认。没有行时，`GET /api/task-groups` 返回一项合成的默认组 `{ id: null, scope: 'user', name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true }`；`PUT …/items/:taskId` 的 `groupId: null` 指的就是它。默认组行在该用户**第一次写**个人分组时落库（`POST /api/task-groups`，或 `groupId` 为 `null` 的 `PUT`），在结构锁之内先查后插，位置为 0。落行之后 `GET` 返回真实 id。自定义分组不可能先于默认组存在，因为 `POST` 总是先落默认组。
  - 这样，一个从没建过分组的用户也能在「我负责的」里拖动排序：`PUT { groupId: null, position }`。如果要求客户端给出默认组的 id，这条路走不通，因为那个 id 在第一次写之前不存在。
  - 剩下的一个限制：个人默认组在落行之前没有 id，不能被 `PATCH` 改名。要改名，先有一次落行的写。是否要为此另给入口，见 §12-Q7。
  - `groupId: null` 在清单 scope 同样表示默认组（那里它总有真实行），两种 scope 的客户端写法一致。`groupId` 键缺失是 422 `INVALID_GROUP`；给了字符串但不属于该容器也是 422 `INVALID_GROUP`。
  - 默认组名取单点常量 `TASK_DEFAULT_GROUP_NAME`，可以改名，不能删。
- **摆放是稀疏的**：没有分组项行的任务视为在默认组、排在有行的任务之后。前端用任务列表（`/items` 或 `/api/tasks?view=assigned`）加摆放列表自行合并。加入清单时不写分组项。
- **可见集与下标**（`[own-13]`）。分组项行会比它指向的任务「活得久」：任务软删后行保留；个人 scope 里负责人被移除后行也保留（R11：读取时过滤，不联动删除）。所以必须说清下标数的是哪些行：
  - **可见集**的定义只有一个，读与写共用：清单 scope = 任务仍是该清单的清单项且未软删；个人 scope = 任务仍在调用者的 assigned 臂上且未软删。两条过滤分别由 `buildTaskInListCondition` 与 `buildTaskScopeCondition({ view: 'assigned' })` 给出，不另写。
  - `GET …/group-items` 与 `GET /api/task-groups/items` 只返回可见集；每项的 `position` 是它在所属分组可见集里的 0 起稠密下标（按库里的 `position, task_id` 排序后重新编号，编号在分页之前完成）。
  - `PUT` 的 `position` 用的是**同一个下标空间**：目标组可见集（去掉被移动的任务自己）里的插入位置，取值 `0..len`，`len` 是那个集合的大小，越界 422 `INVALID_POSITION`。客户端从 `GET` 看到什么顺序，就按那个顺序数下标。
  - `PUT` 的事务在锁后把目标组的行分成可见与不可见两段（各按 `position, task_id`），调 `planGroupItemOrder` 得到新的可见顺序，然后把整组重写为「可见行在前、不可见行原序接在后面」的连续位置。不可见行**不删**，只是被排到可见行之后：它们的位置不会与重写后的可见行相撞；之后重新变为可见的任务（例如被重新指派）出现在该组末尾，位置确定。
  - 「同组同位是空操作」按可见顺序判断：可见顺序没变就什么都不写，库里不可见行的原有穿插保持不动。
  - 稀疏摆放的一个推论，前端要知道：没有行的任务排在有行任务之后，不在下标空间里。要把任务放到某个没有行的任务之后，得先给排在它前面的那些没有行的任务各发一次 `PUT`。
- **至多一个组**：`PUT` 在同一事务里先删该任务在同一容器其他组的行，再按纯函数给出的整组新位置写回。服务端自己构造目标组的新顺序，不接受客户端传整组顺序。来源组只少一行，不重写（留下的空位不影响排序，读取时重新编号）。
- **分组自身的位置**保持 `0..n-1` 连续：建组追加在末尾（任务 D 的 `applyCreateGroup` 用 `existingCount` 作位置，这只有在位置连续时才等于「末尾」）；删组的同一事务用纯函数 `planGroupPositionsAfterDelete` 把该容器剩下的分组重新编号。否则「建 A、B，删 A，再建 C」会让 C 与 B 同位，两者的先后落到随机 id 的比较上。
- 删组：分组项随外键级联删除，任务因此回到默认组（`reassignedTo` 是默认组 id）。删组只写 `group_deleted`，不为被送回默认组的任务写 `group_changed`（`[own-50]`）：一个任务最近一条 `group_changed` 的 `toGroupId` 可能是已删的分组，读事件的一方要按「该分组已删，任务在默认组」理解，那条 `group_deleted` 在它之后。
- 清单 scope 的跨组移动写 `task_events.group_changed`；同组内重排、个人 scope 的任何移动都不写事件。清单 scope 的建组、改名、删组写 `task_list_events`；个人 scope 不写。
- 每个容器的分组数上限 50（含默认组），超限 422 `LIMIT`。

S8 实现时定下的细则（`[own-48]`–`[own-52]`）：

- **缺 org**：个人 scope 的两条集合读（`GET /api/task-groups`、`GET /api/task-groups/items`）是 200 降级体（`[own-19]`，不带 `total`）；清单 scope 的两条读挂在一个清单 id 下，照 `[own-33]` / `[own-42]` / `[own-43]` 是 404，非成员的 404 先于分页的 422（`[own-48]`）。写路由一律 422 `ORG_MISSING`，先于一切。
- **判定顺序**（锁后）：
  - 摆放（`[own-49]`）：容器（清单 scope：成员行、`manage_groups`，404）→ 路径任务在该容器的可见集里（404；不可存的 id 不发 SQL）→ `groupId`（422 `INVALID_GROUP`）→ `position`（422 `INVALID_POSITION`）→ `planGroupItemOrder`、`applyMoveItem`。看不到的任务不论请求体如何都是 404；两个字段都非法时报 `INVALID_GROUP`。`groupId` 键必须在；`null` 指默认组；字符串须是可打印 ASCII，并且是本容器的分组（别的清单的、个人的、别人的、他 org 的分组都是 `INVALID_GROUP`）。`position` 必须是 JSON 数值里的非负安全整数，且不大于去掉被移动任务之后的可见集大小；它是必填的，没有「缺省追加到末尾」。
  - 建组、改名、删组（`[own-52]`）：清单 scope：成员行（404）→ `manage_groups`（404）→（改名、删组）该分组属于本清单（404）→ 名字（422）或默认组（422 `IS_DEFAULT`）→（建组）上限（422 `LIMIT`）。个人 scope 的建组没有行级对象，名字在开事务之前校验（与 `POST /api/task-lists` 同）；改名、删组先判「本人本 org 的分组」（404），再看名字或默认组。
- **名字**：`parseTaskGroupName` = `validateTaskGroupName`（D14）加可存文本规则，与清单名的 `parseTaskListName` 同：含 U+0000 或孤立代理项是 `INVALID_NAME`。
- **排序**（`[own-51]`）：id 一律按字节序（`COLLATE "C"`，不随库的缺省排序规则变）。分组按 `position, id`；组内按 `position, task_id`，读路径据此编稠密下标，写路径据此切出可见、不可见两段；摆放分页按 `group_id`、再按稠密下标；删组后的重编号是同一顺序（`planGroupPositionsAfterDelete`）。
- **事件与时间戳**（§4.4）：清单 scope 的 `group_created` / `group_renamed` / `group_deleted` 的 payload 为 `{ groupId }`（§4.3）。建组、改名：分组行的 `created_at` / `updated_at` 是锁后一次 `clock_timestamp()` 读数，事件从分组行复制（`writeListEvent` 的来源多一种 `{ from: 'group', groupId }`）；删组：行已经删了，事件取一次锁后读数。删组后的重编号只写 `position`，不碰其余分组的 `updated_at`；分组的写都不碰 `task_lists.updated_at` 与 `tasks` 行。摆放新写的分组项行的 `created_at` 是锁后一次读数；同一次写里刚落行的默认组与分组项共用默认组行的读数，建组时刚落行的默认组与新组同理。
- **`group_changed`**（`[own-50]`）：只在清单 scope、经摆放换了组时写；删组让任务回到默认组不算（见上一条「删组」）。payload `{ listId, fromGroupId, toGroupId }`；`fromGroupId` 是任务在本清单原有分组项行所在的组，没有行时是默认组，所以把没有行的任务放进默认组不算换组，不写事件。跨组移动总在目标组新写一行，事件的 `occurred_at` 从这一行复制。
- **默认组落行**：需要默认组的写（建组；`groupId: null` 的摆放）在锁后发现容器没有默认组行时先落行（位置 0，名字 `TASK_DEFAULT_GROUP_NAME`）。个人 scope 这就是 `[own-24]` 的首次写；清单 scope 的默认组随建清单落行、不能删，这条路径在接口上走不到。被拒的首次写（例如 422 `INVALID_POSITION`）随事务回滚，不留默认组行。删组时容器有分组行却没有默认组行（接口不会写出这种状态）是 500 `INTERNAL`，不是 4xx。
- **个人分组列表的分页**：合成默认组不是表行，`GET /api/task-groups` 先取出该用户本 org 的全部分组行（软上限 50），按需在最前面补合成项（纯函数 `userGroupsWithDefault`），再在内存里切页；`total` 是这个列表的长度，不是另一条 `count(*)`（对 §7.1 的偏离，结果相同）。

### 3.6 设置

`Settings` 形状：`{ badgeScope, dailyReminderEnabled, defaultRemindPolicy, timeZone }`。

| 方法 路径 | 码 | 请求 | 成功 200 | 错误 | 幂等 |
|---|---|---|---|---|---|
| `GET /api/task-settings` | read | — | `Settings`（无行时是缺省值：`'overdue'`、`false`、`{ mode: 'default' }`、`null`） | 404（缺 org） | — |
| `PATCH /api/task-settings` | write | `Settings` 的任意子集 | 合并后的 `Settings` | 422 `ORG_MISSING` `INVALID_SETTINGS`（请求体不是 JSON 普通对象：`Content-Type` 不是 `application/json`（文本、表单、没有请求体）也算，`[own-39]`）`INVALID_BADGE_SCOPE` `INVALID_DAILY_REMINDER_ENABLED` `INVALID_POLICY` `INVALID_TIME_ZONE` `DAILY_REMINDER_REQUIRES_TIME_ZONE` | 是（同体重放结果相同） |

- 键缺省表示不改；`timeZone: null` 表示清空；`badgeScope` / `defaultRemindPolicy` 显式 `null` 是 422。未知键忽略（任务 D `parseSettingsPatch` 的现状）。
- `timeZone` 只落规范名（D7）：`asia/shanghai` 存成 `Asia/Shanghai`。
- `dailyReminderEnabled` 与 `timeZone` 在本 PR 只是被存下来，没有任何读它们的调度（PR-3b）。

---

## 4. 服务分层

### 4.1 文件

| 层 | 文件 | 内容 |
|---|---|---|
| 纯函数（改） | `src/tasks/task-access.ts` | 私有 `taskOrgLiveClause()`；新导出 `buildTaskByIdCondition`、`buildTaskInListCondition`、`canChangeCompletion(roles, ability, assigneeCount)`（§6.3）、`canChangeTaskMembers({ task, me })`（§3.4、§6.3，S6+S7 闸修复补）；更新「清单角色本期不会出现」那条过时注释（§6） |
| 纯函数（新） | `src/tasks/task-list-access.ts` | 私有 `taskListOrgClause()` 与私有 `taskGroupOrgClause()`（`task_lists.org_id`、`task_groups.org_id` 各只在一处发射）；`buildTaskListScopeCondition`（我的清单）、`buildTaskListByIdCondition`、`buildTaskUserGroupScopeCondition`；非任务表的稳定排序键常量（D8）。S8 另补 `buildTaskListGroupScopeCondition`：清单 scope 的分组也经同一个 `task_groups.org_id` 子句取 |
| 纯函数（新） | `src/tasks/task-edit.ts` | `parseExpectedVersion`、`parseRemindAtInput`、`planTaskDates`、`planTaskPatch`、`resolveCreateRemindAt`、`TASK_DESCRIPTION_MAX_CODEPOINTS`（§5） |
| 纯函数（追加） | `src/tasks/task-lists.ts` | `applyRenameList`（同名空操作，否则事件 `renamed`）；`canRemoveListMember({ role, isSelf })`；`canAddTaskToList({ listRole, task, me })`；`canRemoveTaskFromList({ listRole, taskRoles, isTaskCreator, itemExists })`（§3.3、§3.4）；`visibleTaskListIds({ isTaskCreator, taskListIds, memberListIds })`（§5.5，S7 补） |
| 纯函数（追加） | `src/tasks/task-groups.ts` | `TASK_DEFAULT_GROUP_NAME`；`planGroupItemOrder({ visibleOrderedIds, hiddenOrderedIds, taskId, position })`，返回整组的前后两个顺序（可见在前、不可见在后）或 `invalid_position`；`planGroupPositionsAfterDelete({ groups, deletedGroupId })`，返回需要改位置的分组（§3.5）。S8 另补 `parseTaskGroupName`、`syntheticUserDefaultGroup`、`userGroupsWithDefault`（合成默认组的形状与「没有默认组行就补在最前」）、`parseTargetGroupId`（摆放请求体的 `groupId`） |
| 纯函数（追加） | `src/tasks/task-settings.ts` | `TASK_DEFAULT_USER_SETTINGS`、`toTaskUserSettings(row \| undefined)` |
| 服务（改） | `src/services/task-records.ts` | `createTask`、`listTasks`、`listPending`、`countPending`、`getTask`、`loadTask`、`assertRowAbility`、`completeTask`、`reopenTask`；新增 `countTasks`、`countPendingList`、`parseTaskPage`、`loadActorListMemberships` |
| 服务（改） | `src/services/task-structure.ts` | `loadRoles`、`deleteTaskById`、`getParentCandidates`、`lockLiveTaskForShare`；`addAssignee` / `removeAssignee` / `addFollower` / `removeFollower` 经私有的 `loadMembersForChange` 调 `canChangeTaskMembers`（S6+S7 闸修复）；`addAssignee` / `addFollower` 的在职校验 |
| 服务（改） | `src/services/task-ids-runtime.ts` | `newTaskListId`、`newTaskGroupId`、`newTaskListEventId` |
| 服务（新） | `src/services/task-patch.ts` | `patchTask` |
| 服务（新） | `src/services/task-user-settings.ts` | `getTaskSettings`、`patchTaskSettings`、`loadBadgeScope`、`loadRemindPolicy` |
| 服务（新） | `src/services/task-list-records.ts` | 清单、成员、清单项、动态 |
| 服务（新） | `src/services/task-group-records.ts` | 两种 scope 的分组与摆放（S8：两种 scope 共用一个「容器」形状，清单的载入、能力判定、请求体字段与清单事件的写法从 `task-list-records.ts` 导出共用） |
| 服务（新） | `src/services/task-org-members.ts` | `findActiveOrgMembers`、`assertActiveOrgMembers` |
| 路由 | `src/routes/tasks.ts`（改）、`tasks-http.ts`、`tasks-lists.ts`、`tasks-settings.ts`（新） | §3 |

`src/tasks/` 下的新代码不 import `db/`、`pg`、`crypto`，不新增 `Intl.DateTimeFormat` 调用点（D12）：日期与时区校验复用 `computeDueAt`、`validateViewerTimeZoneHeader`。

新增的四个纯谓词的定义（服务层只调用，不复述）：

| 谓词 | 定义 |
|---|---|
| `canChangeCompletion(roles, ability, assigneeCount)` | `can(roles, ability)` 且（`assigneeCount > 0` 或 `roles` 含 `creator`）。`ability` 只收 `complete` / `reopen`，其余抛 `TypeError` |
| `canRemoveListMember({ role, isSelf })` | `role !== 'none'` 且（`canListAction({ role }, 'manage_members')` 或 `isSelf`） |
| `canAddTaskToList({ listRole, task, me })` | `canListAction({ role: listRole }, 'add_item')` 且 `can(resolveTaskRoles(task, me), 'edit')`。第二项在函数内部以**空的清单身份**解析，签名里没有传入清单身份的位置 |
| `canRemoveTaskFromList({ listRole, taskRoles, isTaskCreator, itemExists })` | （`canListAction({ role: listRole }, 'remove_item')` 且 `can(taskRoles, 'edit')`）或（`isTaskCreator` 且 `itemExists`） |
| `visibleTaskListIds({ isTaskCreator, taskListIds, memberListIds })`（S7 补的第五个） | `isTaskCreator` 时取 `taskListIds`（包含该任务的全部清单），否则取 `memberListIds`（其中调用者是成员的那些）；去重、按字节序 |
| `canChangeTaskMembers({ task, me })`（S6+S7 闸修复补的第六个，`task-access.ts`，`[own-53]`） | `can(resolveTaskRoles(task, me), 'edit')`：只用任务的创建人、负责人、关注人三列解析，签名里没有传入清单身份的位置，所以为真当且仅当 `me` 是创建人或负责人。增删负责人、增删关注人四条写与详情的 `canManageMembers` 用它 |

写进 `task-access.ts` 的新代码（含注释）不得出现门 1 与门 19 的 needle 文本（§6.1）。`canAddTaskToList` 让 `task-lists.ts` 多 import `resolveTaskRoles` 与 `can`，仍是 `src/tasks` 内部的纯依赖。任务 D 的 `task-lists.ts` / `task-groups.ts` 在 Draft #6186 里；本 PR 只在文件末尾追加导出，不改它已有的函数。

### 4.2 事务与锁

**所有 M4 写操作都走 `withOrgStructure(orgId, run)`**（`[own-04]`），与 M2/M3 的结构写同一协议：

1. `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 是第一条语句。
2. `acquireTaskStructureLock(client, orgId)`。
3. 锁后在同一连接上重读决定这次写的全部行（清单行、成员行、任务行、角色、分组行）。
4. 调纯函数，只写纯函数说变了的东西，事件同事务写入。

理由：锁 §6.4 只登记三把键，门 7 要求任务域源码里 `pg_advisory_xact_lock(hashtext(` 字面量恰好三处；新增第四把键既改锁又破门 7。复用 org 结构锁让清单写与 M3 的成员写天然串行（例如往清单里加任务要求调用者对任务有 `edit`，而这个角色可能正被并发移除），软上限计数与所有者唯一性也都在同一把锁里判定。代价是同 org 的清单写互相排队，P1 规模可接受。

锁序（锁 §6.4：structure → canonical fence → projection）：本 PR 只取第一把，不取 fence 与投影锁，不引入新的锁序关系。调度 leader 锁不涉及。

唯一的例外是 `PATCH /api/task-settings`：它只动调用者自己的一行，不进结构锁。普通事务，首句同样是 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`，然后 `INSERT … ON CONFLICT (user_id, org_id) DO NOTHING` 占位缺省行、`SELECT … FOR UPDATE` 取行、`parseSettingsPatch` 合并、`UPDATE`。行锁防止同一用户两个并发 PATCH 互相覆盖对方没提的字段。校验失败时留下的缺省行与「无行」语义相同。

读路径不进事务、不取锁（`plainDb`）。

校验失败先于开事务的约定保持：`createTask` 的标题、模式校验，以及新加的日期形状校验，都在开事务之前；现有单测断言这类失败时事务数为 0。

数据库错误的处理：所有可能撞唯一约束的写要么在锁后先查再写，要么用 `ON CONFLICT … DO NOTHING`，不让原始 SQLSTATE 以 500 漏给客户端。

### 4.3 各写路由的「读什么、调什么、写什么」

| 路由 | 锁后读 | 纯函数 | 写 |
|---|---|---|---|
| `POST /api/tasks` | 需要缺省提醒时读创建人的 `default_remind_policy`；需要时读负责人的在职状态 | `normalizeUserText`、`resolveCreateAssigneeIds`、`planTaskDates`、`computeDueAt`、`parseRemindPolicy`、`resolveCreateRemindAt`（内部 `computeDefaultRemindAt`） | `tasks`（含日期四列、`time_zone`、`due_at`、`remind_at`）、`task_assignees`、`task_events.created` |
| `PATCH /api/tasks/:id` | 任务全行、负责人、关注人、调用者的清单身份 | `resolveTaskRoles` + `can('edit')`、`parseExpectedVersion`、`planTaskPatch` | 一条 `UPDATE tasks … WHERE id = $1 AND version = $2`，每个变化面一条 `task_events` |
| `POST /api/task-lists` | — | `validateTaskListName` | `task_lists`、所有者成员行、默认组、`task_list_events.created` |
| `PATCH /api/task-lists/:id` | 清单行、调用者成员行 | `canListAction('rename')`、`validateTaskListName`、`applyRenameList` | `task_lists.name`、`updated_at`、事件 `renamed` |
| archive / unarchive | 同上 | `canListAction`、`applyArchive` / `applyUnarchive` | `archived_at`、`updated_at`、事件 |
| 成员增 / 改 / 转让 | 清单行、全部成员行（调用者没有成员行 ⇒ 404，先于一切）；增成员与转让另读目标的在职状态 | `canListAction`、`parseTaskListMemberRole`、`applyAddMember` / `applyChangeMemberRole` / `applyTransferOwner` | 成员行、`task_list_events`（payload `{ targetUserId }`） |
| 成员删（含本人退出） | 清单行、全部成员行，从中取调用者自己的那一行 | `canRemoveListMember`（调用者不是成员 ⇒ 假 ⇒ 404，此时不调 `applyRemoveMember`、不组装名单）、`applyRemoveMember` | 成员行、`task_list_events.member_removed` |
| 清单项增 | 清单行、调用者成员行、任务行（`buildTaskByIdCondition`，同一 org 参数）、任务的创建人 / 负责人 / 关注人、任务当前所属清单 id | `canAddTaskToList`（内部只用直接角色）、`planAddTaskToList` | `task_list_items`、两条事件 |
| 清单项删 | 清单行（按 org 取，不要求成员行）、调用者成员行（可以没有）、任务行、任务完整角色（含清单身份）、该清单项是否存在、任务当前所属清单 id | `canRemoveTaskFromList`、`planRemoveTaskFromList` | `task_list_items`、两条事件；另删本清单内的分组项 |
| 建组 / 改名 | 容器（清单行加成员行，或本人）、该容器分组数或目标分组；个人 scope 建组时另查默认组行是否存在 | `canListAction('manage_groups')`、`validateTaskGroupName`、`applyCreateGroup` / `applyRenameGroup` | `task_groups`（个人 scope 首次写时先插默认组行）；清单 scope 另写 `task_list_events`（payload `{ groupId }`） |
| 删组 | 容器、该容器全部分组行 | `canListAction('manage_groups')`、`applyDeleteGroup`、`planGroupPositionsAfterDelete` | 删一行 `task_groups`（分组项级联），改其余分组的 `position`；清单 scope 另写事件 |
| 摆放 | 容器、目标分组（`null` ⇒ 默认组，个人 scope 缺行时先插）、任务归属（清单项或 assigned 臂）、任务当前所在组、目标组的全部行并按可见集分成两段 | `planGroupItemOrder`、`applyMoveItem`（传入的前后顺序都是「可见在前、不可见在后」的整组顺序） | `task_group_items`：删该任务在同容器其他组的行，重写目标组全部行的位置；清单 scope 跨组时写 `task_events.group_changed` |

同 org 的保证方式，三层，各自独立：① 写路径：清单行经 `buildTaskListByIdCondition`、任务行经 `buildTaskByIdCondition`，两者绑的是同一个 `orgId`；清单项与分组项的 `org_id` 列写的就是这个 `orgId`。② 库：组合外键（§2.2，`[own-37]`）拒绝清单与任务、分组与任务分属两个 org 的行，不论 `org_id` 写成哪一边。③ 读路径：`loadActorListMemberships` 只经「清单行 `org_id` = 任务行 `org_id`」的清单给角色（§6.2）。三层各自成立：写路径之外，库层也拒写；库里即使出现跨 org 的行，读路径也不给角色。§10.4 的跨 org 清单项格对②③分别证红（负控 7 与迁移 mutant）。

### 4.4 `version` 与 `updated_at`

| 写 | `tasks.version` | `tasks.updated_at` |
|---|---|---|
| 状态翻转（complete / reopen / 增删负责人 / 切模式引起的翻转） | +1（M2/M3 现状，不变） | `now()` |
| `PATCH /api/tasks/:id` 且至少一个字段真的变了 | +1，一条 `UPDATE`，不论变了几个字段 | 结构锁之后读一次 `clock_timestamp()`（不是事务开始时的 `now()`，见 §4.5） |
| `PATCH` 空操作 | 不变 | 不变 |
| 设父、不翻转的成员变更、软删、评论、加入或移出清单、分组摆放 | 不变（`[own-05]`） | M3 现状不变；清单与分组的写不碰 `tasks` 行 |

`version` 因此只保护 `PATCH` 可编辑的字段与完成态。结构与成员写是否也接 `expectedVersion`，本件不做，M3 设计文档已把它留给后续。

清单与分组：`task_lists.updated_at` 在建清单、改名、归档、取消归档时写；成员、清单项变更不碰它。`task_groups.updated_at` 在改名时写。清单没有 `version` 列，也没有乐观并发（结构锁已串行）。

清单写的时间戳与 PATCH 同一规则（§4.5；S5 闸审 S5-TS-1 / S5-TS-2 / M4G3T-02）：结构锁到手之后在 SQL 里读一次 `clock_timestamp()`，这次写的各个时间戳都取这一个读数，值不出 SQL（保留微秒），不经 JS `Date` 往返。不用 `now()`：它是事务开始时刻，取在等锁之前，排在后面的写会拿到比先提交的写更早的时间戳，`GET /api/task-lists`（按 `updated_at`）与 `/events`（按 `occurred_at`）的顺序因此与提交顺序相反。具体：

- 建清单：清单行的 `created_at` 与 `updated_at` 取这一读数（`INSERT … SELECT … FROM (SELECT clock_timestamp() AS at) AS s`），所有者成员行与默认组的时间戳、`created` 事件的 `occurred_at` 从清单行复制。
- 改名、归档、取消归档：一条 `UPDATE task_lists AS l SET …, updated_at = s.at FROM (SELECT clock_timestamp() AS at) AS s`；归档时 `archived_at` 取同一个 `s.at`，取消归档写 `NULL`；事件的 `occurred_at` 从清单行复制。于是库里 `archived_at = updated_at = 事件 occurred_at` 在 SQL 精度上成立。纯函数 `applyArchive` 仍只用来判定「是否变化、写哪条事件」，它的 `now` 输入不落库。
- 不写清单行的清单写（成员增、改、删、转让）：事件的 `occurred_at` 取一次锁后的 `clock_timestamp()`。加入的成员行自己的 `created_at` 仍是列缺省 `now()`（该次写事务的开始时刻，取在等锁之前；名单按 `user_id` 排序，不依赖它）；建清单时的所有者行复制清单行的读数（上一条）。名单 `createdAt` 的口径见 §3.3。
- 清单项（S7）与分组（S8）的写照同一规则，见 §4.5。

### 4.5 事件

- 任务事件沿用 M3 写法：`task_events (id, task_id, actor_id, event_type, payload, occurred_at)`，`actor_id` 是操作者。不新增闭集词。
- `PATCH` 的事件合同（`[own-18]`）：同一次 PATCH 里每个变化面一条，`occurred_at` 相同，payload 为 `{}`。这个共同的 `occurred_at` 就是该次 `UPDATE` 写进 `tasks.updated_at` 的值：结构锁到手之后读一次 `clock_timestamp()`，事件行从任务行复制它（值不出 SQL，保留微秒）。不用 `now()`：它是事务开始时刻，取在等锁之前，排在这次 PATCH 前面提交的写会得到更晚的时间戳（S4 闸审 AUTHZ-2；与 M3 删除的 M3R3-LOCK-2 同一做法）：
  - `title_changed`：标题变了；
  - `description_changed`：描述变了；
  - `due_changed`：`due_date` 或 `due_time` 变了，或 `time_zone` 变了且任务有截止日；
  - `start_changed`：`start_date` 或 `start_time` 变了，或 `time_zone` 变了且任务有开始日；
  - `remind_changed`：`remind_at` 变了。PR-3b 的扫描下界取最近一条 `created` / `remind_changed` 的 `occurred_at`，所以这条事件不能省。
  - 只改了 `time_zone` 而任务没有任何日期：不写事件（闭集里没有对应的词）。
- 清单事件：`task_list_events`，id 由 `newTaskListEventId()` 生成。本 PR 用到 13 个词（`field_bound` / `field_unbound` 留给 P2）。每条清单事件的 `occurred_at` 都是锁后在 SQL 里取的读数（§4.4）：写了清单行的，从清单行复制；没写的，取一次 `clock_timestamp()`。
- 本 PR 只落事件行，不产生 outbox 行、不投递、不发 socket。

### 4.6 在职校验（R17、N2）

**已裁**：owner 2026-10-07 按 M4 裁决模板落槌（模板句含 R17 与 N2）。R17：写入负责人、关注人或清单成员时，校验该用户是本 org 的在职成员，判据与登录相同（见下），一个共享 helper、一个 422 码；发送时再复核一次，那一半属 PR-3b，不在本 PR。N2：同一批把这项校验回填到 M2 的 `POST /api/tasks`，并给 M2（及 M3）的真库夹具补在职种子。两项都在 S9 落地（§13 S9）。同日另有一项裁定（`[own-53]`）：增删负责人与关注人须直接角色；在职查询排在这一判定之后。

`src/services/task-org-members.ts`：

```sql
SELECT uo.user_id
FROM user_orgs uo
JOIN users u ON u.id = uo.user_id
WHERE uo.org_id = $1 AND uo.user_id = ANY($2) AND uo.is_active = true AND u.is_active = true
  AND u.activation_status = 'activated'
  AND (u.role <> 'disabled' OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin'))
```

判据是登录时的两半：会话 org 的解析（`AuthService.resolveSessionTenantId`：该 org 的 `user_orgs.is_active` 与 `users.is_active`），加上每次登录与验 token 都跑的账号闸（`evaluateUserAuthenticationGate`：`activation_status` 为 `activated`、角色不是 `disabled`）。账号闸看的角色是登录解析出的角色：持 RBAC `admin` 角色的用户按 `admin` 看，所以 `role = 'disabled'` 而持 `admin` 角色的用户照样在职。只属于口令登录的「本地口令已设」不在判据里（单点登录的用户没有本地口令）。`users.role`、`users.activation_status` 都是 `NOT NULL`，后者有 CHECK 限定两个取值，所以上面的 SQL 与登录逐条等价；`task-m4-org-members` 的对拍格把八种账号形状逐一交给 `AuthService.verifyToken` 与本查询，两边的结论必须相同。不在结果里的 id 即不在职。失败统一是 422 `{ error: { code: 'INACTIVE_ORG_MEMBER' } }`，不区分「用户不存在 / 属于别的 org / org 关系停用 / 用户停用」。

| 写入点 | 校验对象 | 时机 |
|---|---|---|
| `POST /api/task-lists/:id/members` | `userId` | 事务内；结果作为 `isActiveInOrg` 传给 `applyAddMember`（顺序由该函数定：角色 → 已是成员则空操作 → 在职 → 上限） |
| `POST /api/task-lists/:id/transfer-owner` | 转让目标 `userId` | 事务内，先调 `applyTransferOwner`；只有它判定为真的转让（事件非空）才校验，未通过则不写（`[own-27]`） |
| `POST /api/tasks/:id/assignees`、`POST /api/tasks/:id/followers` | `userId` | 事务内，排在直接角色判定（`canChangeTaskMembers`，§3.4，`[own-53]`）与成员 id 校验之后，先调任务 C 的纯函数（它先判「已是成员」，再判 `LIMIT`）；只有它判定为真的新增（事件非空）才校验，未通过则不写。没有直接角色的调用者在查在职之前已是 404；坏的成员 id 是 422 `INVALID_ASSIGNEES`、满员是 422 `LIMIT`，都不查；重复添加是不查的空操作（S9） |
| `POST /api/tasks` | `assignees` 去重后除创建人本人以外的 id，一次查询 | 事务内、取锁之后、读创建人缺省提醒策略与第一条 `INSERT` 之前；标题、模式、负责人 id 的形状与 `LIMIT`、日期都在开事务之前校验，先于在职查询（S9） |

操作者本人豁免（`[own-16]`）：操作者的 org 声明在验证 token 时已经过同一判据。这也使「省略 `assignees`、只插创建人一行」的创建不多一次查询（列表为空时 helper 不发查询）。豁免只给操作者：任务创建人被别人写成负责人或关注人时照样校验。

转让所有者也校验目标（`[own-27]`，§3.3）：成员行不随离职清除，目标除了是成员，还须是本 org 的在职成员。发送时的再次复核属 PR-3b。

成员行本身不随 `user_orgs.is_active` 变化：已离开 org 的成员仍留在名单里，只是他的 token 再也解析不到这个 org，所以读不到任何东西。本 PR 不做清理。负责人与关注人同理：已离开 org 的负责人或关注人仍在任务上，再次添加他是不查在职的空操作（`task-m4-org-members` 的 `re-add` 两格）。

**夹具后果**（N2，S9 已做）：M2/M3 的真库夹具多数直接调服务函数，用的是没有 `users` / `user_orgs` 行的任意字符串 id。回填后，凡把**别人**写成负责人、或走增负责人 / 增关注人路由写入别人的格子，都要先播种在职关系。哪些格要补，以「先上代码、不补种子」跑一遍 lane 与鉴权门为准（验证 MD §S9.3）：lane 75 格（`task-read-path` 25、`task-m3-membership` 27、`task-p0a` 6、`task-m3-comments-deletion` 6、`task-rbac-trust` 5、`task-completion-grid` 2、`task-m4-list-roles` 2、`task-m4-paging-settings` 1、`task-m4-dates` 1；`task-m3-tree` 0），鉴权门 5 格。起草时按 `createTask(` 调用数估的规模（如 `task-m3-tree` 52）大多是创建人自己，不需要种子。播种一律经 `seedOrgMembers(orgId, userIds)`；只清理任务行的 M2/M3 文件用 `orgMemberSeeds()` 记下播过的 id、在 `afterAll` 里删掉对应的 `user_orgs` 与 `users` 行；`task-rbac-trust` 与鉴权门的种子由各自既有的清扫删除（鉴权门准入格的关注目标出现在断言里，保留固定 id，按精确 id 先删后播、再删）。两格的本意就是「被写入的人不在该 org 在职」，没有补种子，而是把那一行负责人改用 SQL 写入、期望不动：鉴权门的 x-tenant-id 格（`bare` 刻意没有 `user_orgs` 行，前置 b 刻意取反）与 `task-rbac-trust` 在 org `'default'` 种下诱饵任务的格。M4 文件里 S6 / S6+S7 闸修复已用 `seedOrgMembers` 播种的格（`task-m4-list-members`、`leedit`、`dirmem` 等）不需要再补。

修订 1 起本节与 §13 S9 记有「owner 不采纳 N2 / 不采纳 R17」两种拆除面；两条都已采纳（上文），S9 是必做片，拆除面已删。

---

## 5. R03：日期写入与 `PATCH`

### 5.1 字段与校验（纯函数 `src/tasks/task-edit.ts`）

| 字段 | 取值 | 校验失败 |
|---|---|---|
| `title` | 字符串，过 `normalizeUserText`；不能为 `null` | 422 `INVALID_TITLE` |
| `description` | 字符串或 `null`；空串存成 `NULL`；上限 20000 个码点（`[own-08]`）；不做修剪 | 422 `INVALID_DESCRIPTION` |
| `dueDate` `startDate` | `'YYYY-MM-DD'`（真实存在的日期）或 `null` | 422 `INVALID_DATE` |
| `dueTime` `startTime` | `'HH:MM'` / `'HH:MM:SS'` 或 `null`；有时间必须有对应日期 | 422 `INVALID_DATE` |
| `timeZone` | IANA 具名时区、`null` 或 `''`；具名时区过 `validateViewerTimeZoneHeader`，**落规范名**（D7）；偏移形式不收。`''` 读作 `null`（`[own-29]`）：合并后仍有日期是 `TIME_ZONE_REQUIRED`，否则清空时区；空白串等其他非时区字符串是 `INVALID_TIME_ZONE` | 422 `INVALID_TIME_ZONE` / `TIME_ZONE_REQUIRED` |
| `remindAt` | 带 `Z` 或显式偏移的 ISO-8601 瞬时，或 `null`；文法与年份范围见 `[own-30]`（§11） | 422 `INVALID_REMIND_AT` |
| `expectedVersion`（仅 PATCH，必填） | 正的安全整数（JSON number） | 422 `INVALID_VERSION` |

校验分两步，都在 `planTaskDates` 里：

1. **类型闸**，先于一切：`dueDate` `dueTime` `startDate` `startTime` 四个键，出现时必须是 `null` 或**非空字符串**（`typeof === 'string'` 且长度大于 0）。空串、数字、布尔、数组、对象一律 `INVALID_DATE`。`timeZone` 出现时必须是 `null` 或字符串；`remindAt` 同理（`parseRemindAtInput`）。
2. **取值**：日期与时间的合法性用 `computeDueAt` 在 `try/catch` 里判，不另抄一份正则；`RangeError` 在纯函数内转成 `reason`，不会冒到路由成为 500。由日期、时间、时区算出的截止瞬时不得越过 9999 年末（`[own-38]`，即 `[own-30]` 给 `remindAt` 的瞬时范围的上界），否则 `INVALID_DATE`。下界不另判：`computeDueAt` 的日历探针拒收 0000–0099 年的日期（`Date.UTC` 把这些年份映射到 1900 年代，往返比对失败），可存的截止日期从 `0100-01-01` 起，任何时区都只能把它的瞬时移到 0099 年，仍在范围内（S5 闸审 M4G3T-05 之后改正；`task-edit.test.ts` 有两格钉住这个下界）。上界的来由：`9999-12-31` 在 UTC 以西的时区里，全天截止或晚于时区偏移的时间会算到 10000 年，那个瞬时以 ISO 文本绑定时 Postgres 拒收（S4 闸审 DATES-1）。只改时区也会重算，所以一条把东八区 `9999-12-31` 的任务改到纽约的 PATCH 同样是 `INVALID_DATE`。

类型闸不能省，因为 `computeDueAt` 本身不做类型检查：它把任何假值的 `dueTime`（`''`、`0`、`false`）都当成「全天」，于是这些值会通过校验、再以原样绑进 `time` 列，变成一条裸 SQL 错误（500）；它的两个解析器对原始值调 `RegExp.exec`，会把 `['2026-09-30']` 这样的单元素数组隐式转成字符串而放行，随后绑进去的是数组。落库的值取 `planTaskDates` 返回的规范化字符串，不取请求体原值。

合并结果在写库前满足 P0-A 的三条 CHECK（有日期必须有时区、时间必须有日期），不让 23514 漏出来。

时区规则（`[own-07]`，取计划 v5 §2.6 的读法）：

- 合并后只要有任一日期，就必须有时区，否则 422 `TIME_ZONE_REQUIRED`。
- **请求体只要碰了四个日期键中的任何一个、且合并后仍有日期，就必须在同一请求里带非空 `timeZone`**，否则 422 `TIME_ZONE_REQUIRED`。新的墙上时间不会被套进一个调用方没确认过的旧时区里。
- 只带 `timeZone` 的 PATCH 表示换时区：覆盖并重算 `due_at`。
- 不做隐式联动：清掉 `dueDate` 而库里还有 `dueTime`，调用方必须同时传 `dueTime: null`，否则 422 `INVALID_DATE`。
- 锁没有「开始不晚于截止」的规则，本件不加。

`due_at` 每次写入重算（锁 §4.4）：有截止日则 `computeDueAt({ dueDate, dueTime, timeZone })`（全天取当地 23:59:59.999），没有则 `NULL`。

### 5.2 `POST /api/tasks`

在 M2 的三字段之外接收 §5.1 的日期键与 `remindAt`。不接收 `description`（R03 只把它列给 PATCH）。

`remind_at` 的取值（锁 §4.4 的缺省算法）：

| 请求 | `remind_at` |
|---|---|
| 没有 `remindAt` 键，且有截止日 | 读创建人在本 org 的 `default_remind_policy`（无行即缺省策略），`computeDefaultRemindAt`：定时任务 `due_at − 30min`；全天任务取**任务自己的时区**当天 18:00；策略为 `none` 得 `NULL`。不用查看者时区 |
| 没有 `remindAt` 键，且没有截止日 | `NULL` |
| `remindAt: null` | `NULL`（显式不提醒，不看策略） |
| `remindAt: '<瞬时>'` | 原样存；已经过去的值也照存，是否入队是 PR-3b 的事 |

创建只写一条 `created` 事件，不另写 `remind_changed`。成功体 `{ id, version }`，`version` 为 1。

`INSERT INTO tasks` 的前五个绑定位保持 `(id, org_id, title, completion_mode, created_by)` 的顺序，新列追加在后：现有单测按位置读第 3、4 个参数。

### 5.3 `PATCH /api/tasks/:id`

顺序：

1. `withOrgStructure`。按 id 取本 org 未软删的任务全行（`buildTaskByIdCondition`）；没有 ⇒ 404。
2. 角色解析（含清单身份）；`can(…, 'edit')` 不通过 ⇒ 404。
3. `parseExpectedVersion`；缺失或非法 ⇒ 422 `INVALID_VERSION`。
4. `expectedVersion !== 当前 version` ⇒ 409，体为 `{ error: { code: 'VERSION_CONFLICT' }, currentVersion }`。这一步排在字段校验之前：版本过期的调用方反正要重新取详情。
5. `planTaskPatch({ current, patch })`：逐键合并（键缺省 = 不改；`null` = 清空，`title` 除外），跑 §5.1 的校验，算出新的 `due_at`，给出变化面与事件表。
6. 没有任何变化 ⇒ 200 `{ id, version }`（`version` 不变），不写行、不写事件。
7. 有变化 ⇒ 一条 `UPDATE tasks AS t SET …, updated_at = s.at, version = t.version + 1 FROM (SELECT clock_timestamp() AS at) AS s WHERE t.id = $1 AND t.version = $2 RETURNING t.version`；0 行按 409 处理（结构锁下不应发生，留作兜底）。再写事件，每条的 `occurred_at` 从任务行的 `updated_at` 复制（§4.5）。
8. 成功体 `{ id, version }`。

`remind_at` 在 PATCH 里的规则（`[own-06]`）：**PATCH 从不派生**。没有 `remindAt` 键 ⇒ 不动；`null` ⇒ 清空；瞬时 ⇒ 设置。锁的缺省算法只定义在创建时，而库里没有任何信息能区分一个 `remind_at` 是缺省派生的还是用户指定的。后果要写明：改截止日而不带 `remindAt`，提醒时刻不跟着动。这是否可接受需要 owner 定，见 §12-Q2。

`PATCH` 吸收了计划里的 `PATCH …/reminder`，不另开路由（对计划的偏离，R03）。

未知键忽略；请求体不是对象按 `{}` 处理（于是落到 `INVALID_VERSION`）。

### 5.4 complete / reopen

语义不变（`wasDone` 口径，不建幂等键表，R03）。只在成功体上加 `version`：锁后读到的 `version`，状态翻转则加 1。受影响的现有断言四处，同片更新：`task-rbac-trust.db.test.ts` 的 `{ done: true }` 一处、`{ ok: true }` 两处，`task-read-path.db.test.ts` 的 `{ done: true }` 一处；另有 S2 新文件 `task-m4-list-roles.db.test.ts` 里对 `completeTask` 返回值的一处 `{ done: true }`（S4 已改为 `{ done: true, version: 2 }`；S1–S3 闸审 M4G1T-10）。M3 前端对这两个响应只读 `done` / `ok`，多一个键不影响。

### 5.5 详情新增字段

`GET /api/tasks/:id` 在 M3 字段之外加 `description`、`startDate`、`startTime`、`remindAt`（ISO 或 `null`）、`listIds`。`version` 已在 M3。M3 前端的详情解析忽略未知键。`PendingItem` 不变，仍不带正文。

`listIds`（`[own-25]`）：字符串数组，按字节序，键恒在。调用者是任务创建人时，是包含该任务的全部清单的 id；否则只是其中调用者自己是成员的那些。只有 id，没有清单名或成员信息。它的用途见 §3.4：让创建人知道任务被放进了哪些清单。规则由纯函数 `visibleTaskListIds` 给出，在 `view` 判定之后组装。只算 `org_id` 等于任务行 `org_id` 的清单（与 §6.2 同一种两行比较，组合外键之外的又一层），已归档的清单照算（`[own-46]`）。

`canComplete` / `canReopen` 改由 `canChangeCompletion` 给出（§6.3），与 complete / reopen 两条路由用同一个谓词；其余四个能力标志（`canEdit` `canDelete` `canComment` `canLeave`）仍是 `can(roles, …)`。

`canManageMembers`（`[own-53]`，ruled 2026-10-07；S6+S7 闸修复补）：布尔，键恒在。由 `canChangeTaskMembers` 给出，与增删负责人、增删关注人四条写用同一个谓词，所以不会出现「按钮亮着、点了 404」。为真当且仅当调用者是任务的创建人或负责人；为真时四条写（`POST` / `DELETE /api/tasks/:id/assignees`、`POST` / `DELETE /api/tasks/:id/followers`）按 M3 的规则执行，为假时四条都是与缺失 id 相同的 404。它与 `canEdit` 分开：只有清单身份的 `list-editor` 是 `canEdit: true`、`canManageMembers: false`（仍可 PATCH、设父、切模式）。关注人退出看 `canLeave`，与它无关。

---

## 6. R04：单对象可见性与清单角色

### 6.1 `task-access.ts` 的改动

```ts
const TASK_ID_PLACEHOLDER = '$1'

function taskOrgLiveClause(): string {
  return `(tasks.org_id = ${ORG_PLACEHOLDER}) AND tasks.deleted_at IS NULL`
}

// buildTaskScopeCondition：把原来内联的同一段文本换成 `${taskOrgLiveClause()} AND (${arm})`，输出逐字节不变。

export function buildTaskByIdCondition(input: { taskIdParam: string; orgParam: string }): TaskScopeCondition
// sql:    tasks.id = $1 AND (tasks.org_id = $2) AND tasks.deleted_at IS NULL
// params: [taskIdParam, orgParam]

export function buildTaskInListCondition(input: { listIdParam: string; orgParam: string }): TaskScopeCondition
// sql:    EXISTS (SELECT 1 FROM task_list_items tli WHERE tli.task_id = tasks.id AND tli.list_id = $1)
//         AND (tasks.org_id = $2) AND tasks.deleted_at IS NULL
// params: [listIdParam, orgParam]
```

约束，每一条都有现成的测试在钉：

- `tasks.org_id` 子句在**源码里仍只出现一次**，在私有生成器里。门 1 的 org 隔离 mutant 把源码里第一处 `(tasks.org_id = ${ORG_PLACEHOLDER}) AND ` 换掉；抽成生成器之后，这一个 mutant 同时打掉五视角、pending、按 id、按清单四条路径，单点发射才有判别力。**新加的注释里不得出现这段字面量**，否则 mutant 会先命中注释。
- `buildTaskScopeCondition` 与 `buildTaskPendingCondition` 的输出文本不变（`task-access.test.ts` 逐字节快照，并断言输出里 `tasks.org_id = $2` 恰一次）。
- 门 19 两个探针的 needle（`case 'assigned':` 那一臂、`assignee: {` 能力块）原样保留。
- 绑定位（`[own-01]`）：按 id 与按清单这两个构造器没有操作者臂，`$1` 是对象 id，`$2` 是 org。不能沿用 M3 `getTask` 的「`$3` 放 id、`$1` 闲置」：Postgres 对未被引用的参数无法推断类型。这两个片段不与五视角片段拼在同一条查询里。调用方自己的参数从 `cond.params.length + 1` 起编号。
- 把文件里「清单角色本期不会出现」那条 `ASSUMPTION(task-b)` 注释改成现状。

改的是任务 B 已在 main 的模块，需要 owner 确认（§12-Q1）。

### 6.2 详情流程

`getTask`：

1. `SELECT … FROM tasks WHERE ${buildTaskByIdCondition(…).sql}`；没有行 ⇒ 404。
2. 读负责人、关注人、以及调用者在**包含这条任务的清单**里的成员行。
3. `resolveTaskRoles(row, me, toTaskListMemberships(rows))`。
4. `can(roles, 'view')` 为假 ⇒ 404。
5. 组装响应；`canEdit` `canDelete` `canComment` `canLeave` 与 `canComplete` / `canReopen` 来自同一份角色集；`canManageMembers` 由 `canChangeTaskMembers` 只从同一行的创建人、负责人、关注人三列给出（§5.5）。

清单身份的加载（`loadActorListMemberships(db, taskIds, actorId)`，一条查询，批量）：

```sql
SELECT tli.task_id, tlm.list_id, tlm.role
FROM task_list_items tli
JOIN tasks t ON t.id = tli.task_id
JOIN task_lists tl ON tl.id = tli.list_id AND tl.org_id = t.org_id
JOIN task_list_members tlm ON tlm.list_id = tli.list_id AND tlm.user_id = $2
WHERE tli.task_id = ANY($1)
```

不按 `archived_at` 过滤：已归档清单照样给角色（归档不改变可见性）。**清单只在它的 `org_id` 等于任务行的 `org_id` 时给角色**（S1–S4 闸审 M4G1-AUTHZ-1 / AUTHZ-1 / SCH-1 之后加入）：比较的是两张表的行，不是清单项自己的 `org_id` 列，也不是调用方传入的 org（调用方的 org 已在取任务 id 时经 `task-access.ts` 的单点 org 谓词用过）。这样六处角色解析共用这一处比较，签名不变。这一条不写 `tasks.org_id = $n` / `task_lists.org_id = $n` 形式的 org 谓词：门 1 与负控 2 的 needle 计数不变。库层另有组合外键（§2.2）拒绝这种行；本查询不依赖它。成员角色 `read` 映射为 `list-reader`，`edit` 与 `owner` 都映射为 `list-editor`（任务 D 的 `toTaskListMemberships`）；角色闭集里没有 list-owner。

### 6.3 清单角色怎样进入各能力

- **五个视角臂不变**。任务不会因为清单身份进入 `assigned` / `following` / `created` / `delegated` / `any_role` 中的任何一个，也不进 pending 与红点。只有清单身份的人：详情 200，五个视角里都看不到这条任务；他们经 `GET /api/task-lists/:id/items` 看到清单里的任务。
- **单对象能力**取 `TASK_ROLE_ABILITY` 的并集（已在 main，本件不改表）：

| 身份 | view | edit | complete / reopen | comment | delete | leave | 增删负责人 / 关注人 |
|---|---|---|---|---|---|---|---|
| list-editor | ✓ | ✓ | ✓\* | ✓ | ✗ | ✗ | ✗（`[own-53]`） |
| list-reader | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| follower + list-reader | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ |

「增删负责人 / 关注人」一列不取能力表的并集：它由 `canChangeTaskMembers` 只看直接角色（创建人或负责人）给出，清单身份不进入它（§3.4，`[own-53]`，ruled 2026-10-07）。

\* 零负责人任务除外。锁 §6.2 规定零负责人任务只有创建人能完成、重启；任务 C 的 `applyComplete` / `applyReopen` 在「零行且操作者不是创建人」时抛一个不带 `status` 的 `Error`，`sendError` 会把它变成 500 `INTERNAL`。清单身份接进角色解析之后，持有 `complete` 能力的不再只有创建人，所以这条规则由单独的谓词执行：

- 新纯谓词 `canChangeCompletion(roles, ability, assigneeCount)`（`task-access.ts`，§4.1）：`can(roles, ability)` 且（`assigneeCount > 0` 或角色集含 `creator`）。
- `completeTask` / `reopenTask` 在锁后先读负责人行，再用它判定；为假 ⇒ 404 `NOT_FOUND`，不调 `applyComplete` / `applyReopen`，不写任何行。`assertRowAbility` 对这两个能力不再单独判定，以免两处判据漂移。
- 详情的 `canComplete` / `canReopen` 用同一个谓词（§5.5），所以不会出现「按钮亮着、点了 404」。
- `all` 模式下 list-editor 若本人没有负责人行，`complete` 是任务 C 已定的空操作（200、`done` 不变、不写行、不写事件）；`any` 模式下它照常把任务置完成。这是任务 C 的既有语义，本件不改，只在测试里把夹具的模式钉明（§10.4）。

- **服务层六处角色解析统一带清单身份**：`getTask`、`loadVisibleChildren`（批量）、`assertRowAbility`、`task-structure.ts` 的 `loadRoles`、`getParentCandidates`（批量）、`deleteTaskById`。于是 list-editor 可以 PATCH、设父、切模式，并可以完成、重启**有负责人的**任务；list-reader 可以看详情与评论；两者都不能删任务，也都不能增删负责人与关注人：那四条写由 `canChangeTaskMembers` 只看直接角色（`[own-53]`），锁后读负责人与关注人行判定，不读清单身份。切模式要 `edit`，清单身份计入。只改详情一处会出现「能编辑父任务却在 `children` 里看不到同清单的子任务」这类不一致。
- **按 id 取任务的站点统一走 `buildTaskByIdCondition`**：`getTask`、`loadTask`（绑定顺序本来就是 `[id, orgId]`，直接替换）、评论写的行锁 `lockLiveTaskForComment`（`FOR KEY SHARE`）、删除的行锁 `lockTaskRowForDelete`（`FOR UPDATE`），以及 S4 的 `PATCH` 取行（`task-patch.ts`）。初稿写的「三处、`lockLiveTaskForShare`、`FOR SHARE`」已被 M3 第二轮修复取代（验证 MD §S2.7-1）。**例外一处**（S1–S3 闸审 AUTHZ-2 / M4G1-AUTHZ-2）：M3 第三轮修复带来的删除锁前预检 `precheckDeleteAbility` 手写 `org_id = $2`，不在单点发射之内。它只决定「是否不等锁就 404」：删除只看创建人，清单角色没有 `delete`，所以它不需要清单身份；锁后的 `lockTaskRowForDelete` 与 `loadTask` 再经构造器判一次。后果是门 1 的 org mutant 改不到这一处，「DELETE 的 org 隔离」负控不能只靠那一个 needle。这段代码随 #6229 已在 main，是否改走构造器归 M3 代码的所有者；本 PR 不改它。M3 里不是按 id 取的手写 org 子句（按 `parent_id` 取子任务、整 org 树节点、父候选全集）不在 R04 范围内，本件不动。
- 被移出清单、或任务被移出清单后，下一次请求的角色解析就读不到那一行，立即生效，没有缓存。

---

## 7. R15：分页

### 7.1 合同

- query `limit`：1..100，缺省 100。`offset`：≥ 0，缺省 0。缺省值的来源要说明：裁决包里 R15 的条目行与 owner 回复模板给出的 `limit` 缺省值不一致，本件取回复模板的 100（`ASSUMPTION(task-m4): [R15]`）。理由：它等于 `/api/tasks` 与 `/pending` 现在的硬上限，M3 前端不带分页参数时拿到的行不变（§7.3）；取更小的值会让现有前端静默少看到行。取哪一个列进 §12-Q8。
- 非整数、越界、负数、前导零、数组或对象形式的参数：422 `INVALID_LIMIT` 或 `INVALID_OFFSET`，不夹取。解析用任务 D 的 `parsePageParams`。
- 响应 `{ items, total }`。`total` 是同一条件下不分页的行数，由单独一条 `count(*)` 查出；两条查询不在同一事务里，并发写入时可以差一两行（M3 评论列表同此）。
- 排序稳定，末位用 id 打破平局。任务行用任务 D 的 `TASK_PAGE_SORT_KEY`（`tasks.updated_at DESC, tasks.id DESC`，D9）。其余列表的排序键是 `task-list-access.ts` 里的常量：清单 `task_lists.updated_at DESC, task_lists.id DESC`；成员 `created_at, user_id`；动态 `occurred_at DESC, id DESC`；分组 `position, id`；摆放 `group_id, position, task_id`（S8：分组与摆放的 id 按字节序，`position` 在摆放里是稠密下标，`[own-51]`）。
- cursor 不做（R15 把它再推到 P2）。
- 降级响应（`org_missing`、`predicate_error`）**不带 `total`**，与 M2 逐字节相同（三处 `toEqual` 在钉）。

适用的端点：`GET /api/tasks`、`/api/tasks/pending`、`/api/task-lists`、`/api/task-lists/:id/members`、`/items`、`/events`、`/groups`、`/group-items`、`/api/task-groups`、`/api/task-groups/items`。

### 7.2 回填 `/api/tasks` 与 `/pending`

服务签名保持向后兼容（`[own-10]`）：

```ts
listTasks(input: { orgId; actorId; view; page?: TaskPageParams }): Promise<Row[]>          // 仍返回数组
countTasks(input: { orgId; actorId; view }): Promise<number>                               // 新
listPending(input: { orgId; actorId; viewerTz; page?: TaskPageParams }): Promise<Record<string, string>[]>
countPendingList(input: { orgId; actorId }): Promise<number>                               // 新，scope 恒为 all_open
parseTaskPage(query: { limit?: unknown; offset?: unknown }): TaskPageParams                // parsePageParams → fail(422, …)
```

不把返回值改成 `{ items, total }`：`listTasks` / `listPending` 在三份测试文件和鉴权门的子进程脚本里被当数组用，改返回类型要动十余处既有断言，其中一处是写在字符串里的脚本。路由自己调两次服务再拼 `{ items, total }`。

SQL：`… WHERE ${cond.sql} ORDER BY ${TASK_PAGE_SORT_KEY} LIMIT $n OFFSET $n+1`，`n = cond.params.length + 1`（五视角与 `all_open` 的片段只有两个绑定值，不能按「从 `$4` 起」硬编号）。列集不变（列表项仍是 snake_case 六列；`PendingItem` 仍是五键或六键）。

`GET /api/tasks` 的判定顺序：先解析分页，再验 `view`。分页非法是 422；`view` 非法仍是 M2 的 200 降级；两者都非法时 422 胜出。分页错误不是 `TypeError`、码也不是 `INVALID_VIEW`，不会被该路由的降级分支吞掉。

### 7.3 前端兼容

M3 前端对这三个端点的用法（分支 `claude/tasks-m3-frontend` @ `68b0a624bc`）：

- `listTasks(view)` 只发 `?view=`，取 `items`，不看别的键。缺省 `limit` 100 等于现在的硬上限，返回的行不变；多出的 `total` 被忽略。唯一可见差别是同一 `updated_at` 的行之间现在有确定的先后。
- `fetchPendingCount` 只要求 `count` 是非负有限数，多余键忽略。没有设置行的用户缺省是 `overdue`，响应仍是 `{ count }`。用户把 `badge_scope` 设成 `off` 后（只有新的设置接口能做到），M3 的红点会显示 `0` 而不是隐藏，直到 M4 前端读 `badgeScope`。
- `apps/web` 里没有 `/api/tasks/pending` 的调用方。
- 创建、完成、重启的响应分别只读 `id`、`done`、`ok`。

### 7.4 与 M3 评论分页并存

M3 评论列表用的是服务层私有解析器：接受前导零、上界 2^31−1、错误码是单一的 `INVALID_PAGE`。任务 D 的 `parsePageParams` 拒绝前导零、上界是安全整数、区分 limit 与 offset。R15 明确不回改 M3，所以两套规则并存，前端按端点区分错误码。合流留待 owner 定（§12-Q8）。

---

## 8. `/api/tasks/pending-count` 与 `badge_scope`

`countPending({ orgId, actorId, viewerTz })` 的签名不变，返回类型改为 `number | null`：

1. 读 `task_user_settings.badge_scope`（`user_id = actor AND org_id = org`）。无行 ⇒ `parseBadgeScope(undefined)` ⇒ `'overdue'`。
2. `pendingScopeForBadge(scope)`：`'off'` ⇒ `null`，函数直接返回 `null`，**不查 `tasks`**（D5）。
3. 否则 `buildTaskPendingCondition({ scope, viewerTzParam })` 加 `count(*)`，与现在相同。

路由：

```ts
      const viewerTz = validateViewerTimeZoneHeader(req.header('x-viewer-time-zone'))
      const count = await countPending({ orgId: org, actorId: actorId(req), viewerTz })
      res.json(count === null ? { count: 0, badgeScope: 'off' } : { count })
```

- **前两行必须与现有文本逐字节相同**（含缩进）。M2 门 8 的路由层 mutant 用这两行作 needle，先断言源码包含它再改写；改动其中任何字符，该门在重跑时变红。把 scope 的解析放进 `countPending` 内部，就是为了不碰这两行。
- 只有 `off` 时多一个 `badgeScope` 键（`[own-11]`）。常规响应仍是 `{ count }`：两处 `toEqual({ count: 1 })` 与门 19 探针一的子进程断言都不用改。
- `/pending`（列表）恒用 `all_open`，不读设置。`all_open` 不是列值。count 与 list 是同一个条件构造器、不同参数（锁 §13-4）。
- pending 从属链不变：仍由 assigned 臂派生；没有负责人的任务不计入任何人的红点（R09），不按 `archived_at` 过滤。
- 缺 org 的降级体不变：`{ count: 0, degraded: true, reason: 'org_missing' }`。

---

## 9. 权限目录、flag、需要满足的仓库守卫

### 9.1 权限

不新增权限码，不 seed 角色，不写 `role_permissions`。非 admin 的可达条件不变：角色带码，且有 `user_namespace_admissions(user_id, 'tasks', enabled = true)`。新代码不写 `user_roles`（单写者守卫）。

### 9.2 flag

不新增 flag。新路由随 `TASKS_ENABLED` 一起开关（`[own-17]`）。`packages/core-backend/src` 下**不得出现** PR-3b 三个 flag 的名字，注释里也不行：manifest 测试对 `TASKS_[A-Z_0-9]+` 且以 `_ENABLED` 结尾的 token 做源码与 manifest 的双向核对，名字一出现就要求 manifest 有条目。

**部署耦合**：本 PR 之后，M2/M3 的任务路由在每次角色解析时都会读 `task_list_items` / `task_list_members`，`/pending-count` 会读 `task_user_settings`。凡 `TASKS_ENABLED='true'` 并运行这份代码的环境，必须已应用本迁移；否则这些路由是 500（42P01）。这条耦合此前只写在文档里，没有任何东西强制它。本 PR 补两处，都只是脚本与登记文本：

- `scripts/ops/staging-tasks-smoke.mjs` 的 `preflightDatabase` 在现有 11 个 `to_regclass` 之外加 `task_list_items`、`task_list_members`、`task_user_settings` 三张表；缺任一张时失败信息点名「M4 任务表不存在，本镜像的任务路由需要 M4 迁移」，而不是等到 HTTP 断言处以 500 表现出来。`staging-tasks-smoke.test.mjs` 同片补一格。
- `scripts/ops/global-history-flag-manifest.mjs` 的 `TASKS_ENABLED` 条目改写（AGENTS.md 要求 flag 语义变化时同步登记）：`purpose` 写明它现在同时挂载 `/api/tasks`、`/api/task-lists`、`/api/task-groups`、`/api/task-settings` 四个前缀，且打开它的环境必须已应用 M4 迁移；`source` 改成读点的实际位置（M3 基座上是 `routes/tasks.ts` 的 `tasksRouter()`，不再写死行号 `:35`，改用 `#tasksRouter` 的锚点形式，与同文件其他条目一致）；`danger` 从 `low` 调到 `medium`（`[own-28]`；同文件已有 15 条 `medium`，不是新取值），理由是打开它现在依赖一条尚未应用的迁移。manifest 测试只查 token 与非空 `source`，这一改动它不会逼出来，所以列在 S3 的文件清单里。

**staging 的三种状态**（本 PR 不触达任何环境；下表是合并后 owner 要做的选择）：

| M4 迁移在 staging | `TASKS_ENABLED` | 结果 | 允许？ |
|---|---|---|---|
| 已应用（owner 授权 `action=migrate`，DDL 落 staging） | `true` 或 `false` | 正常 | 允许 |
| owner 排除（名字进 `STAGING_OWNER_EXCLUDED_MIGRATIONS`，八张表进表缺席证明），未应用 | `false` | 任务路由不挂载，不读 M4 表；runner 的 `smoke=tasks` 本来就要求开关为 `true`，会 fail-closed 拒跑 | 允许 |
| owner 排除，未应用 | `true` | M2/M3 路由 500；扩展后的 preflight 以点名信息失败 | **禁止** |

**过渡态：合并之后、owner 做出上面二选一之前**（S1–S3 闸审 M4G1-SCHEMA-01 / SCH-2 之后改写。初稿写「`deploy` 停下、staging 继续跑合并前的旧镜像」，与 runner 的实际顺序不符。）window-runner 的 `deploy` 动作（`scripts/ops/attendance-staging-window-runner-remote.sh` 的 `action_deploy`；行号以该文件的 `04de335490` 版为准）依次：

1. 写持久 override；`tasks_enabled=true` 时其中含 `TASKS_ENABLED`（`:979`）；
2. `compose up -d --no-deps backend web`，换上新镜像（`:1010`）；
3. 等健康检查报出新 SHA（`:1024`），断言请求的开关已生效（`:1028`）；
4. 之后才跑迁移对齐报告。本迁移用朴素 `CREATE TABLE`，报告把它判为 `high`，决策是 `do_not_run_full_migrate`（修复切片在本分支上对「只有本迁移待应用」的清单实跑过报告，结果相同），`fail` 退出（`:1051-1052`；`fail` 是普通的 `exit 1`，没有恢复旧镜像的 trap）。

所以这次 deploy 以失败告终时，staging 已经在跑新镜像，开关是请求时给的值，本迁移没有应用：

- `tasks_enabled=false`：任务路由不挂载，不读 M4 表。允许（与上表第二行同效，只是没有登记排除）。
- `tasks_enabled=true`：上表第三行的禁止态。M2/M3 的详情、写路由与 `/pending-count` 是 500（42P01），直到有人重新部署。
- **规则**：owner 二选一之前，以及选定 (ii) 之后一直，含本迁移的镜像只能以 `tasks_enabled=false` 部署。误以 `true` 部署之后的恢复办法有两条，都可执行：以 `tasks_enabled=false` 重新部署同一 SHA；或重新部署合并前的 SHA（没有迁移被应用，runner 头注的回滚规则允许）。
- 让 runner 在 `compose up` 之前就拒绝「`tasks_enabled=true` 而 M4 表不存在」，或把对齐报告挪到换镜像之前，是 runner 线与共享 workflow 的改动（本 PR 只改 `tasks-realdb.yml`，§9.3），作为 §12-Q10 的一问交给 owner。workflow 的 `tasks_enabled` 输入说明仍写它只挂 P0-A 的 `/api/tasks`，同样归那条线更新。
- 过渡态里有人用合并后的仓库跑 `smoke=tasks`：开关为 `false` 时它先以「需要 `TASKS_ENABLED=true`」fail-closed；开关为 `true` 时扩展后的 preflight 以「M4 任务表不存在」的点名信息失败。不因此放宽 preflight。
- 这道对齐门不是本迁移带来的：任何含朴素 `CREATE TABLE` 的未应用迁移都会让 staging 的共享 `deploy` 在这里失败（M3 的 `task_comments` 迁移已随 #6229 进 main）。本迁移新增的是耦合：S2/S3 起 M2/M3 的任务路由读 M4 表。

**合并后 staging deploy 会在换上新镜像之后失败，直到 owner 二选一**：这份代码一旦进入 staging 要部署的镜像，**所有线**的 staging 部署都会在对齐门处失败，直到 owner 选定：(i) 授权 `action=migrate` 把本迁移应用到 staging；或 (ii) 把它列入 owner 排除清单，并且 staging 保持 `tasks_enabled=false`。这是 §12-Q10 要问的具体问题，PR body 在门 14 声明旁边写这一句，并写明「在此之前含本迁移的镜像只能以 `tasks_enabled=false` 部署」。

生产的部署是 `docker-build.yml` 的手动 dispatch：先 `up -d --no-deps --force-recreate backend web`（`:481`），再 `migrate.js`（`:487`，全量、不带排除），所以生产在第一次部署合并后的镜像时就会应用本迁移（生产不经对齐报告）。本 PR 不打开生产的 `TASKS_ENABLED`。

**回退分三层**（只陈述默认，不授权任何一步。S1–S3 闸审 M4G1-SCHEMA-02 / SCH-3 之后改写：初稿的「revert 本 PR、schema 保留无害」在本迁移已应用的环境里不可执行。）

1. **代码回退**。
   - 本迁移**从未在该环境应用**：revert 本 PR 的全部提交（含迁移文件），或直接部署合并前的 SHA，都可执行。
   - 本迁移**已应用**（staging 经 owner 授权的 `action=migrate`，或生产的任何一次部署）：迁移文件必须留在代码里。实测（PG 15.17，一份已应用本迁移的库，`MIGRATION_EXCLUDE` 加上本迁移名，模拟 revert 之后的文件集；修复切片以旧名实测，S10 以新名复测，结果相同）：`migrate.ts`（latest）退出 1，`corrupted migrations: previously executed migration zzzz20261008090000_create_task_m4_tables is missing`；`--rollback` 同一错误退出 1；`--list` 退出 0 并报 `Pending: 0`——它不做这项检查，所以不会提前报警。（2026-10-09 以现名 `zzzz20261009130000_create_task_m4_tables` 在 PostgreSQL 16.15 上再测：报错里的名字随之变化，退出码与 `--list` 的结果相同；验证 MD「2026-10-09 迁移重新定名与门 15」一节。）Kysely 0.28.8 的 `Migrator#getState` 不论 `allowUnorderedMigrations` 如何都先做这项检查。文件被删之后，该环境此后每一次 deploy 的内联 migrate 都会失败（staging 在 `set -e` 下中止；生产在新镜像已经 `up` 之后的 migrate 阶段失败），所有线都受影响，直到文件恢复或有人手改 `kysely_migration`。
   - 可执行的做法：(a) 只 revert 路由与服务代码，保留迁移文件（M4 表与 `remind_at` 留在库里，回退后的 M3 代码不读它们）；(b) runner 头注写明的路径：以 `tasks_enabled=false`（加 `force_recreate=true`）重新部署同一 SHA，任务路由不挂载；(c) 保留文件名、把 `up` / `down` 换成空操作，让 provider 继续认识这个名字。`SUPERSEDED_LEGACY_SQL_MIGRATIONS` 的机制只替换磁盘上存在的文件，文件删了就不起作用。
   - 镜像回滚（部署更早的 SHA）只在该环境没有应用过本迁移时可行（runner 头注的同一条规则）。
2. **迁移回退（`down()`）**。唯一的入口是 `migrate.ts --rollback`，它回退**最近一次执行的**迁移（按执行时间排序，同时刻再按名字）；没有「回退指定迁移」的命令。
   - 只有本迁移是该环境最近执行的那一条时，`--rollback` 才回退它。之后若有别的迁移执行过，`--rollback` 回退的是那一条：修复切片（本迁移还用旧名、排在 `zzzz20261001120000_create_approval_form_drafts` 之前时）在本地全量迁移之后跑 `--rollback`，回退的是 drafts 那一条，M4 表原样保留（之后已重新迁移恢复）。S10 改名之后，从空库全量迁移时本迁移是最后执行的一条，`--rollback` 回退的就是它（验证 MD §S10）。（2026-10-09：main 随后有了前缀更晚的迁移，旧名在合并结果上排到倒数第二；重新定名之后，在 main `fc139c868e` 并入本分支的结果上从空库全量迁移，本迁移最后执行，`--rollback` 只回退本迁移，再迁移只执行本迁移一条；验证 MD「2026-10-09 迁移重新定名与门 15」一节。）已经应用过别的迁移的环境仍按本条前半句判断。这种情况下 `down()` 不是可执行的运维路径；要么另做一条指定迁移的回退命令，要么手写 SQL 加手改台账，两者都需要 owner 决定。
   - 必须在迁移文件仍在代码里时执行（`down()` 就在这个文件里；文件删了，`--rollback` 报上面的 corrupted 错误），并且 `TASKS_ENABLED` 已关（任务路由读这些表）。
   - `down()` 成功之后台账里没有本迁移的行，这时才可以删文件。
   - `down()` 删掉八张表的全部行与 `tasks.remind_at` 的值，不可逆。
3. **业务补偿**：本 PR 不产生对外副作用（不投递、不发 socket），清单与分组数据随 `down()` 消失，没有需要逐单补偿的东西。

### 9.3 守卫清单

| 守卫 | 要求 | 本 PR 的做法 |
|---|---|---|
| `migration-timestamp-uniqueness.guard.test.ts` | `zzzz<14 位>` 前缀全仓唯一 | 一个新文件，前缀实现当天重查 |
| 迁移排序 | 引用 `tasks` 的迁移排在 P0-A 之后 | §2.1 |
| 门 14 / 锁 §5.4 | 含 DDL 的 PR 首段写明未应用、未合并、迁移不自动应用、`down()` 是否验证；不进 `MIGRATION_EXCLUDE` | PR body 首段；`down()` 的验证是 `task-m4-schema` 里那一格（§2.3），一次性库的手工记录只作补充；紧接着写 §9.2 那句「合并后 staging deploy 会在换上新镜像之后失败，直到 owner 二选一；在此之前含本迁移的镜像只能以 `tasks_enabled=false` 部署」 |
| PG 版本 | required lane 在 PG14 上迁移 | 不用 PG15+ 语法 |
| `task-ci-coverage-enumeration.test.ts`（门 17 ④） | 磁盘上的 `task-*.db.test.ts` = `vitest.config.ts` 逐文件字面量 = `tasks-realdb.yml` 清单；每个文件含 `assert-rbac-optional-off` | 每个新文件同片登记三处；文件顶部先 import 该 helper，再 `EXPECT_DB` 哨兵 |
| `approval-a3-dangling-reviews-path-sweep.test.ts` | `vitest.config.ts` 在受扫名单里，不得出现私有评审目录的路径 token | 只加字面量条目，不加注释 |
| 门 17 ② | lane 绿后从 verbose 日志读出收集用例数，与静态展开数（含每张 `.each` 表的行数）相等，写进 PR body | 验证 MD 逐文件列数 |
| flag manifest 测试 | 源码里的 `TASKS_*_ENABLED` 与 manifest 双向一致 | 不引入新 token；`TASKS_ENABLED` 条目的 `purpose` / `source` / `danger` 按 §9.2 改写（测试不逼这一步，照做） |
| `staging-tasks-smoke.test.mjs` | preflight 的表清单 | 加三张 M4 表与点名失败信息，同片补一格（§9.2） |
| `tasks-auth-ci-wiring.test.mjs` | 鉴权门只有一个文件、配置与 setup 的字面量各恰一次、文件里没有 `.skip(` | M4 的鉴权格写进现有的 `tasks-auth-gate.ts`；不改配置、setup、`plugin-tests.yml` |
| 门 7 | 任务域源码里咨询锁字面量恰三处 | 不新增；新路由文件名以 `tasks` 开头以留在扫描根内 |
| 门 13 | 静态段先于 `/:id`；真实 `MetaSheetServer` 打通；挂载置空后变红 | 正控两格（`/api/task-settings`、`/api/task-lists`）；负控改写 `tasksRouter()` 里对应的注册调用行（§10.7）。M4 没有同方法的静态/参数相撞对，不为此另立计分格（§3.5） |
| 门 15 | 生产源码注释不点名其他线的符号 | 注释只引条目 id，不引裁决包原文、不写私有路径 |
| 门 20 | `src/tasks` 无 I/O；harness 自动发现并调用每个导出 | 新纯函数不 import `db` / `pg` / `crypto`，方法形 `.query(` 不出现在 `src/tasks` |
| hourcycle 守卫 | `Intl.DateTimeFormat` 调用点计数 | 不新增调用点（D12） |
| 源码改写型探针的 needle | 六处字面文本被测试钉住 | `routes/tasks.ts` 的两行（§8）、`task-access.ts` 的三处（§6.1）、`task-dates.ts` 与 `task-advisory-locks.ts` 各一处都不动 |
| 整体相等断言 | `{ count: 1 }`、三个降级体 | 不加键（§7.1、§8） |
| sha 钉住的文件 | `plugin-tests.yml`、`pnpm-lock.yaml` | 不碰；不加依赖 |
| `user_roles` 单写者 | 任务服务不写 `user_roles` | 不写 |
| 共享 CI | 只允许改 `tasks-realdb.yml`、`tasks-web-guard.yml` | 只改前者（加文件清单；若总时长逼近 25 分钟上限，调这个 workflow 自己的 `timeout-minutes`） |

无需改动：OpenAPI（规范里没有任务路径，也没有路由对齐检查）、`src/db/types.ts`（任务域用原始 SQL）、权限目录接口（读库）。

### 9.4 哪些 lane 会在 Draft PR 上跑

`tasks-realdb`、`recovery-schema-drift` 的 `pull_request` 触发不限基分支；`migration-prod-image-parity` 按路径触发。`plugin-tests`（`test (20.x)`：单测守卫、manifest 测试、三集合枚举、门 20 harness、鉴权门步骤）、`web-tests`、contracts、`migration-replay` 只在基分支是 main（或各自名单里的分支）时触发。PR-3a 若以非 main 分支为基，这些守卫不会在 CI 里执行，必须本地跑并把结果写进验证 MD。基分支怎么选见 §12-Q5。

---

## 10. 测试计划

### 10.0 格落在哪一行（`RULED(2026-10-07): [R01]`）

R01 已于 2026-10-07 裁定（回复模板末句一并同意的部分），取推荐值的修订形：锁的 `arm-set` 门号列只收整数，所以不另起字母键的候选行；M4 的新格要么落在锁里已有的两条 M4 行（`M4|8|A支与非法IANA`、`M4|19|清单角色`），要么落在「整数门号 + M4 子集」的新行里。这些新行还没有写进锁：锁的增补（M4 的退出条件、新子集行与新门）由另一个只改锁文件的 Draft PR 承载，合并另需 owner 点名。在它合并之前，下表里的新行以及本 PR 落在其中的格一律是**候选、未计分**；锁里已有的两条 M4 行不受影响。

| 行 | 本 PR 的格 | 位置 | 本文小节 |
|---|---|---|---|
| `M4\|8\|A支与非法IANA`（锁里已有） | 非法 IANA 写入 422、大小写变体、A 支运行期定极性与两个生产码 mutant | `task-m4-dates` | §10.5 |
| `M4\|19\|清单角色`（锁里已有） | `gate19m4` 25 格与 `any_role` 清单臂 mutant；清单能力、写授权、`m4list` 各格；realdb 里的第二租户格与任务 / 清单 / 个人分组三个 org 谓词 mutant | `task-m4-list-roles`、`-lists`、`-list-members`、`-list-items`、`-groups` | §10.3、§10.4 |
| `M4\|1\|清单第二租户`（新子集行） | 在 trust-off 配置下、前置 a–i 逐条标注的清单第二租户读格（正控 + 清单 org 谓词 mutant） | `tasks-auth-gate.ts` | §10.7 |
| `M4\|2\|清单路由`（新子集行） | 清单前缀下每条路由的非 admin 三件事 | `tasks-auth-gate.ts` | §10.7 |
| 门 1 / 2 / 13 / 17 / 20 的 M4 新表面子集行 | 30 条新路由的缺 org、非 admin 三件事与路由人口枚举；门 13 正负控；门 17 登记与收集数；门 20 harness | `tasks-auth-gate.ts`、`task-m4-paging-settings`、`task-m4-lists`、验证 MD | §10.7 |
| 门 18 / 21 / 22 的 M4 子集行 | 不在本 PR（PR-3b、前端） | — | §10.7 |
| 门 8 的提醒与每日汇总子集行 | 本 PR 只有缺省提醒三格（§10.6），扫描窗与每日汇总随 PR-3b | `task-m4-dates` | §10.6 |

为什么清单第二租户要在 `tasks-auth-gate.ts` 里另有一格，而不是只靠 realdb 的格：锁的门 1 规定本门的格落在该文件、跑在 trust-off 配置下，并逐条标注前置 a–i。realdb 文件用的是 `setup.integration.ts`，那里 `RBAC_TOKEN_TRUST='true'`，`AuthService` 的信任路径直接采信 token 里的 `tenantId`，不查 `user_orgs`。在那种配置下「token 是 org A」这件事本身没有被证明过，所以 realdb 的第二租户格只算门 19 清单角色行的内容，不算门 1 的格。

### 10.1 新的真库文件

每个文件：顶部 `import '../helpers/assert-rbac-optional-off'`，模块顶层 `EXPECT_DB !== '1'` 则抛（不 skip），独立的 org 前缀，`afterAll` 清理。三处登记同片完成。

| 文件 | 切片 | 内容 |
|---|---|---|
| `task-m4-schema.db.test.ts` | S1 | 表与约束的形状格；`down → up` 事务内回滚格（§10.2、§2.3） |
| `task-m4-list-roles.db.test.ts` | S2（S4 补三格） | `gate19m4` 25 格；`m4list` 任务侧能力与隔离格；list-editor 完成的 `any` / `all` 两格（夹具模式钉明）；零负责人完成 / 重启格；三个 mutant（负控 1 的第二租户·任务一半、负控 4、负控 6） |
| `task-m4-paging-settings.db.test.ts` | S3 | 分页合同、设置路由、`badge_scope`、门 13 的设置正负控 |
| `task-m4-dates.db.test.ts` | S4 | R03、门 8 的 422 格与 A 支 |
| `task-m4-lists.db.test.ts` | S5 | 清单核心路由、动态、第二租户、归档格与两个 mutant；门 13 的清单正负控；`read` 成员对清单写路由的 404 |
| `task-m4-list-members.db.test.ts` | S6 | 成员与转让；非成员删除的 404；角色边界；R17 四格 |
| `task-m4-list-items.db.test.ts` | S7 | 清单项；两端授权反格；跨 org 加入格；(a1) 只有清单身份的成员加入自己建的清单的反格；创建人移出支路；`listIds`；双事件；上限 |
| `task-m4-groups.db.test.ts` | S8 | 两种 scope 的分组与摆放；可见集下标（软删残留行、撤掉再重新指派的残留行）；分组位置连续；个人默认组（合成项、首次写落行、并发首次写）；`read` 成员对分组写路由的 404；个人分组第二租户与 mutant |
| `task-m4-org-members.db.test.ts` | S9 | R17 / N2 在创建、增负责人、增关注人三个写入点上的格（27 格）：每个写入点 × 四种不在职（只在别的 org 在职、org 关系停用、用户停用、查无此人）各一格，422 逐字节相同、零写入；每个写入点的同 org 在职正控；四种原因与三个写入点的 422 逐字节相同；创建时一个停用 id 排在在职 id 之后；完成态 `all` 任务上加停用负责人；操作者本人豁免（自身 org 关系停用的调用者建任务、自加负责人、自加关注人）与「只豁免操作者」（负责人把已停用的创建人写成负责人或关注人）；只有创建人的创建、重复添加已离开 org 的成员、只有清单身份的 `edit` 成员（停用与在职两种目标都是缺失 id 的 404）、坏 id 与满员，都不查在职。「不查」在库里观测：本文件自己的连接对 `user_orgs` 持 ACCESS EXCLUSIVE，查它的请求会在 `pg_locks` 里排队（三格在职正控就是这台观测器的正控） |

共用 helper `tests/helpers/task-m4-fixtures.ts`（不是 `task-*.db.test.ts`，不进三集合）：

- `seedTaskActor({ label, codes, admission })`：`permissions`（`ON CONFLICT DO NOTHING`）、`roles`、`role_permissions`、`users`、`user_roles`、`user_orgs`、admission、JWT。
- `seedOrgMembers(orgId, userIds)`：只播种 `users` 与 `user_orgs`。
- `orgMemberSeeds()`（S9）：`seedOrgMembers` 加一份本文件的记录，`drop()` 删掉记下的 id 的 `user_orgs` 与 `users` 行；给只清理任务行的 M2/M3 真库文件用（`[N2]`）。
- `dropTaskM4Fixtures({ orgPrefix, userIds, roleIds })`：按序删 `tasks`（级联清单项、分组项、事件、评论）、`task_lists`（级联成员、清单 scope 分组、清单事件）、`task_groups`（个人 scope）、`task_user_settings`、`task_notification_deliveries`，再删 admission、`user_permissions`、`user_roles`、`user_orgs`、`users`、`role_permissions`、`roles`。每张新表都有 `org_id` 或经外键挂在有 `org_id` 的表上，清理可以按 org 前缀写。前缀逐字匹配（`left(org_id, length($1)) = $1`），不用 `LIKE`：各文件的前缀都含 `_`，在 `LIKE` 里它是通配符（S1–S3 闸审 M4G1-SCHEMA-03；schema 文件有一格钉住）。
- `runSourceMutant(file, needle, replacement, script, env)`：断言源码含 needle（且按需断言唯一）→ `cp` 备份 → 改写 → `tsx` 子进程 → 恢复 → 断言恢复后逐字节相同。

**mutant 会原地改写 `src` 下的文件**。只能在一次性检出（CI 的 checkout，或实现者自己的 worktree）里跑，不得在别的代理正在使用的共享 worktree 里跑。

### 10.2 形状格（`task-m4-schema`）

- 八张表与 `tasks.remind_at` 存在；各索引在 `pg_indexes` 里存在，名字与 §2.2 相同。
- outbox：缺 `org_id` 插入得 23502（证明没有默认值）；`recipient_role = 'observer'` 得 23514；`status = 'outcome_unknown'` 可插入；同一 `(org_id, source_key)` 插两次得 23505；`redelivery_safe` 缺省为 false。
- 清单成员：同一清单第二个 `owner` 得 23505；`role = 'admin'` 得 23514。
- 分组：同一清单第二个默认组得 23505；同一 `(org_id, user_id)` 第二个个人默认组得 23505；`scope = 'list'` 而 `list_id` 为空得 23514；`scope = 'user'` 同时带 `list_id` 得 23514。
- 设置：`badge_scope = 'all_open'` 得 23514；`daily_reminder_enabled = true` 而 `time_zone` 为空得 23514。
- 清单事件：闭集外的词得 23514；15 个词逐个可插入。
- 生成 id 四合取：`tlst` / `tgrp` / `tlev` 的前导 `_`、尾随 `_`、`__` 各得 23514。
- 名字：`''` 得 23514；`备料复核` 可插入。
- 级联：删任务行后其清单项与分组项消失；软删（只写 `deleted_at`）后仍在。
- org 一致性（`[own-37]`）：清单与任务分属两个 org 的清单项，不论 `org_id` 取哪一边都是 23503（各自点名违反的那一条外键）；缺 `org_id` 23502；清单 scope 分组与其清单不同 org 23503，个人 scope 不受影响；分组与任务不同 org 的分组项 23503；有清单项的任务或清单改 `org_id` 23503。
- `DELETE FROM tasks WHERE org_id = …` 在该 org 有清单项时不报错。
- `down → up`：§2.3 那一格。`down()` 之后八张表的 `to_regclass` 为空、`remind_at`、`idx_tsk_remind` 与 `tasks_id_org_id_key` 不存在；`up()` 之后列（名、类型、可空、缺省）、索引、约束三份快照与之前逐项相等；事务回滚后，文件里排在它后面的一格断言 `task_lists` 的 OID 与事务前相同、事务前插入的哨兵行仍在（证明回滚确实发生；只查表存在分不出回滚与提交，因为 `up()` 会把表重建出来）。

### 10.3 门 19 的 `i-m4`（`M4|19|清单角色` 的视图格）

用例名 `gate19m4|<s>|<v>`，**不用** `gate19|` 前缀：M2 的门 19 命令用 `-t 'gate19[|]'` 扫整个 `tests/integration` 并只与 `i-m2` 比对，M4 的名字若落在同一前缀下，重跑 `M2|19|网格` 时会多出 25 个名字而变红。`gate19m4|…` 既不匹配 `gate19[|]`，也不被 `gate19\|[A-Za-z0-9|+_-]+` 抽出。

身份 `s`（角色名升序，`+` 连接）× 五个视角，共 25 格。期望行集 = 把 `s` 去掉清单角色后按锁 §6.1 的 ambient 钉法得到的结果（任何视角臂都不含清单身份）：

| `s` | assigned | following | created | delegated | any_role |
|---|---|---|---|---|---|
| `list-reader` | ∅ | ∅ | ∅ | ∅ | ∅ |
| `list-editor` | ∅ | ∅ | ∅ | ∅ | ∅ |
| `follower+list-reader` | ∅ | {T} | ∅ | ∅ | {T} |
| `assignee+list-reader` | {T} | ∅ | ∅ | ∅ | {T} |
| `creator+list-editor` | ∅ | ∅ | {T} | {T} | {T} |

- 写法同 M2 的 49 格：字面 `cells` 数组喂 `it.each(cells)('%s', …)`，每格独立 org 与用户，任务行不共享（人口隔离）。清单与成员行用 SQL 直接播种，不依赖清单路由。每格先断言 `taskMatchesView`（去掉清单身份的行）与期望一致，再比对 `listTasks` 的行集。
- 每格另加正控：`can(resolveTaskRoles(row, me, memberships), 'view') === true`，且 `GET /api/tasks/:id` 为 200。25 格里有 18 格是「详情可见、视角里没有」，这正是 R04 的内容。
- 负控：在 `buildTaskScopeCondition` 的 `any_role` 上加一条清单臂（改写 `.join(' OR ')` 那一处，实现时断言 needle 唯一），子进程里 `list-reader|any_role` 那一格必须变红。
- **期望清单的载体**（`[own-20]`）：25 个名字作为 ```` ```i-m4 ```` fenced block 放在本设计文档里（下块），标「候选，未入锁」。`tests/helpers/gate19-identities.ts` 的 `lockIdentities` 与 `passedIdentities` 各加可选参数（fence 名缺省 `'i-m2'`，前缀缺省 `'gate19|'`），现有单测与 M2 命令不受影响；新单测钉「设计文档里的 `i-m4` 块 = 测试文件里的 25 个名字」。抽取命令与 M2 同形，把 `-t` 换成 `'gate19m4[|]'`、正则换成 `gate19m4\|[A-Za-z0-9|+_-]+`、fence 换成 `i-m4`。把这一块搬进锁、并在 `arm-set` 里落行，是改已 ratify 的文本，需要 owner 点名（§12-Q1、Q6）。

```i-m4
gate19m4|assignee+list-reader|any_role
gate19m4|assignee+list-reader|assigned
gate19m4|assignee+list-reader|created
gate19m4|assignee+list-reader|delegated
gate19m4|assignee+list-reader|following
gate19m4|creator+list-editor|any_role
gate19m4|creator+list-editor|assigned
gate19m4|creator+list-editor|created
gate19m4|creator+list-editor|delegated
gate19m4|creator+list-editor|following
gate19m4|follower+list-reader|any_role
gate19m4|follower+list-reader|assigned
gate19m4|follower+list-reader|created
gate19m4|follower+list-reader|delegated
gate19m4|follower+list-reader|following
gate19m4|list-editor|any_role
gate19m4|list-editor|assigned
gate19m4|list-editor|created
gate19m4|list-editor|delegated
gate19m4|list-editor|following
gate19m4|list-reader|any_role
gate19m4|list-reader|assigned
gate19m4|list-reader|created
gate19m4|list-reader|delegated
gate19m4|list-reader|following
```

### 10.4 清单的可见性、隔离与写授权（`M4|19|清单角色` 的 `m4list` 格）

用例名前缀 `m4list|`，全部经 HTTP。每格独立用户或格间清理。凡期望 404 的写格，同时断言：响应体与「该 id 不存在」的响应逐字节相同（`response.text` 相等），且目标表与两张事件表的行数不变。

**任务侧：清单身份进入单对象能力**（list-roles，S2；PATCH 三格 S4 补）

| 格 | 期望 |
|---|---|
| list-reader 取详情 | 200 |
| list-reader 完成 | 404 |
| list-reader 评论（M3 路由） | 200 |
| list-editor 完成，`any` 模式、任务有一个别人的负责人行且未完成 | 200 `{ done: true, … }`；任务 `status='done'`；负责人行被盖章；一条 `completed_by_any`，`actor_id` 是 list-editor |
| list-editor 完成，`all` 模式、list-editor 本人没有负责人行 | 200 `{ done: false, … }`；`version` 不变；负责人行与 `task_events` 行数都不变（任务 C 的既有空操作） |
| list-editor 完成，零负责人任务 | 404，不是 500；任务行不变，无事件；详情里该用户的 `canComplete` 为 false |
| list-editor 重启，零负责人且已完成的任务 | 404，不是 500；任务仍 `done`；详情里 `canReopen` 为 false |
| 创建人完成零负责人任务（正控） | 200 `{ done: true, … }`；一条 `completed` |
| list-editor 删任务 | 404 |
| list-reader PATCH | 404（S4） |
| list-editor PATCH | 200（S4） |
| follower + list-reader PATCH（R08） | 404（S4） |
| 成员被移出清单后取详情 | 404，下一次请求即生效（list-roles 用 SQL 删行；list-members 经路由再做一次） |
| 任务被移出清单后，仅有清单身份的人取详情 | 404（list-items） |
| 第二租户·任务：清单与任务在 org B，调用者是该清单成员，token 是 org A | 详情 404 |
| 增删负责人与关注人须直接角色（`[own-53]`，S6+S7 闸修复）：只有清单身份的 `edit` 成员、以及经清单 `edit` 的关注人，对四条写各发合法请求、坏请求体、坏路径用户 id | 都是与缺失 id 逐字节相同的 404，先于请求体与路径 id 的校验；任务行、负责人、关注人、事件都不变；两人详情 `canEdit: true`、`canManageMembers: false`。关注人经 `leave` 退出 200 |
| 同一个只有清单身份的 `edit` 成员 | PATCH、设父（新父也在清单里）、切模式、评论各 200；`any` 模式、有别人的未完成负责人行时完成 200 且 `done: true` |
| 创建人与负责人增删负责人、关注人（正控） | 四条写各 200；坏 `userId` 是 422 `INVALID_ASSIGNEES`；`canManageMembers` 对创建人、负责人为真，对关注人、只有清单身份的 `edit` 成员为假 |

**清单侧：成员身份是第一道判定**（lists S5、list-members S6）

| 格 | 期望 |
|---|---|
| 第二租户·清单：同上，取 `GET /api/task-lists/:id` 与 `/items` | 404（lists） |
| 清单已归档 | 成员取详情仍 200；负责人的 `/pending`、`/pending-count`、`view=assigned` 不变（lists） |
| 清单已归档，成员路由（S6+S7 闸修复） | 名单、增成员、改角色、本人退出、转让、新所有者移除成员，状态码、响应体、成员行与成员事件都与同样的操作在未归档清单上逐一相同；清单仍是归档态，`archived_at` 与 `updated_at` 不变（list-members） |
| 同 org 非成员对自己发 `DELETE /api/task-lists/:id/members/:self` | 404，体与不存在的清单 id 逐字节相同；无事件；响应里没有任何成员 id |
| 被移出的前成员再对自己发同一个 `DELETE` | 同上；该前成员读名单也是 404 |
| `read` 成员删除别人 | 404；目标成员行还在 |
| `read` 成员本人退出（正控） | 200；自己的成员行消失；一条 `member_removed` |
| 对清单前缀下每条写路由（改名、归档、取消归档、成员增 / 改 / 删他人 / 转让、清单项增删、分组建 / 改 / 删 / 摆放），调用者是 `read` 成员 | 各 404，无行、无事件。按路由到达的切片分文件：lists（S5）覆盖改名、归档、取消归档；list-members（S6）覆盖成员路由；list-items（S7）覆盖清单项路由；groups（S8）覆盖分组路由 |
| `edit` 成员经 `POST …/members` 或 `PATCH …/members/:userId` 传 `role: 'owner'` | 422 `INVALID_ROLE`；该清单仍恰有一行 `owner`（不是 23505 冒成 500） |
| `edit` 成员把清单创建人降为 `read`，创建人随后归档 | 降级 200；归档 200（创建人对归档的额外放行不看角色） |
| 移除清单创建人 | 422 `CREATED_BY_IMMUTABLE` |
| 移除所有者、改所有者角色 | 422 `OWNER_MUST_TRANSFER` |
| 转让 | 原所有者变 `edit`，新所有者 `owner`，事件 `owner_transferred`；非所有者调用 404；目标非成员 422 `TARGET_NOT_MEMBER` |
| 转让给一个成员行还在、但 `user_orgs.is_active = false` 的成员 | 422 `INACTIVE_ORG_MEMBER`；两行角色不变，无事件 |
| 加成员：他 org 用户 | 422 `INACTIVE_ORG_MEMBER` |
| 加成员：`users.is_active = false` | 422 `INACTIVE_ORG_MEMBER` |
| 加成员：同 org 在职 | 200（正控） |

**清单项：两端授权**（list-items，S7）

| 格 | 期望 |
|---|---|
| 清单 `edit`、对任务没有任何角色 | 404，不写行、不写事件 |
| 反过来：任务创建人、清单只有 `read` | 404 |
| 两端都满足（清单 `edit`，任务创建人或负责人） | 200；`task_events.list_added` 与 `task_list_events.item_added` 各一行 |
| 跨 org：调用者在 org A 的清单 L 是 `edit`，在 org B 的任务 T 是创建人，token 是 org A，把 T 加进 L | 404；`task_list_items` 与两张事件表零新行 |
| (a1)：E 是 L1 的 `edit` 成员（T 在 L1 里，E 对 T 没有直接角色），E 把 T 加进自己建的 L2 | 404（`[own-25]`：加入只认直接角色）；随后把 E 移出 L1，E 取 T 详情 404 |
| (a2)：负责人 A 把 T 加进自己建的 L3，随后不再是负责人 | 加入 200；之后 A 只经 L3 的成员身份持有 T（list-editor）；创建人取详情，`listIds` 含 L3；创建人 `DELETE /api/task-lists/L3/items/T` ⇒ 200，两条事件的 `actor_id` 是创建人，L3 里别的清单项与分组项不动；之后 A 取 T 详情 404 |
| (a1) (a2) 与 `[own-53]` 一起：只有清单身份的 `edit` 成员 E（经 L1 持有 T，创建人不是 L1 的成员） | 下列写各是与缺失 id 逐字节相同的 404、零变化：把 T 加进 E 自己的清单（(a1)），给 T 增删负责人或关注人（`[own-53]`）。创建人经 (a2) 把 T 移出 L1 ⇒ 200，之后 E 取 T 详情 404 |
| 创建人支路的 404 统一性 | 创建人对「不存在的清单 id」「他 org 的清单」「不含 T 的清单」各发一次 `DELETE …/items/T`，三个响应体逐字节相同；非创建人、非成员对含 T 的清单发同一请求也是同一个 404 |
| `listIds` 的可见范围 | 创建人看到全部包含 T 的清单 id；只在 L1 的 list-reader 只看到 `[L1]`；只在 L2 的 `edit` 成员只看到 `[L2]`，读 L3 的关注人只看到 `[L3]`（S6+S7 闸修复） |

**分组：可见集下标、分组位置、个人默认组**（groups，S8；`[own-13]` `[own-24]`）

| 格 | 期望 |
|---|---|
| 清单 scope：组 G 库里顺序为 [A, H, B]，H 所指任务已软删；`GET …/group-items` | 只返回 A、B，`position` 为 0、1 |
| 同上，`PUT` 把 X 放到 `position: 2`（追加到可见末尾） | 200；`GET` 的可见顺序为 [A, B, X]；库里 H 的位置大于 A、B、X 的位置 |
| 同上，`PUT` 把 X 放到 `position: 1` | 200；可见顺序为 [A, X, B] |
| 同上，`position: 3` | 422 `INVALID_POSITION`（可见集大小是 2，去掉 X 自己后插入位取值 0..2） |
| 个人 scope：用户 U 是 T1、T2、T3 的负责人，三者依次摆进默认组；撤掉 U 在 T2 上的负责人行；`PUT` 把 T4 追加到可见末尾，再把 U 重新指派到 T2 | 撤掉后 `GET /api/task-groups/items` 为 [T1, T3]；追加后为 [T1, T3, T4]；重新指派后为 [T1, T3, T4, T2]（T2 的旧行排在可见行之后，重现时落在末尾，不与重写后的位置相撞） |
| 同组同位是空操作 | 200；库里各行 `position` 与 `task_group_items` 行数不变，无事件 |
| 分组位置连续：建 A、B（默认组 0，A 1，B 2），删 A，再建 C | 删 A 后 B 的 `position` 为 1；C 的 `position` 为 2，排在 B 之后（不与 B 同位） |
| 从没建过分组的用户：`GET /api/task-groups` | 200，恰一项，`id: null`、`isDefault: true`、`total: 1`；库里该用户零行 `task_groups` |
| 同一用户 `PUT /api/task-groups/items/T { groupId: null, position: 0 }` | 200，返回体 `groupId` 是新落行的真实 id；库里该 `(org, user)` 恰有一行 `is_default`；再 `GET` 返回该真实 id |
| 两个并发的首次写（`POST /api/task-groups` 与 `groupId: null` 的 `PUT`） | 都 200；恰一行默认组（结构锁内先查后插，不是 23505 冒成 500） |
| `groupId` 键缺失 | 422 `INVALID_GROUP` |

负控（生产码 mutant，子进程）：

1. 任务 org 谓词：沿用门 1 的 needle 改写 `task-access.ts`，第二租户·任务格必须变红，证明按 id 的路径确实骑在同一个单点上。跨 org 加入格（S7）在这个 mutant 下断言的是：组合外键（§2.2）拒绝写入，请求失败、`task_list_items` 零新行（库层独立拒写）。
2. 清单 org 谓词：把 `task-list-access.ts` 里的 `(task_lists.org_id = ${ORG_PLACEHOLDER}) AND ` 改成恒真，第二租户·清单格必须变红。
3. 给 pending 条件加「所属清单未归档」的过滤（改写 `buildTaskPendingCondition` 里拼 `tasks.status = 'open'` 的那一处，断言 needle 唯一），归档格的 pending 行必须消失。
4. §10.3 的 `any_role` 清单臂。
5. 个人分组 org 谓词（S8，groups 文件）：把 `task-list-access.ts` 里 `taskGroupOrgClause()` 发射的 `(task_groups.org_id = ${ORG_PLACEHOLDER}) AND ` 改成恒真，下面「个人分组第二租户」格必须变红。
6. 零负责人守卫：把 `canChangeCompletion` 里「`assigneeCount > 0` 或含 `creator`」那一合取改成恒真，零负责人两格必须从 404 变成 500。它证明这两格判别的是守卫本身，而不是别的 404 来源。
7. 清单身份的同 org 比较（list-roles，S1–S4 闸审修复切片）：跨 org 清单项格先断言普通 `INSERT` 得 23503（点名外键），再在一条 `session_replication_role = replica` 的连接上写入两行（任务在 A、清单在 B，`org_id` 取任务一边；任务在 B、清单在 A，`org_id` 取清单一边），经 HTTP 断言详情、完成、切模式、加关注人、PATCH、列评论、父候选都是与缺失 id 逐字节相同的 404、行不变。负控：去掉 `loadActorListMemberships` 里的 ` AND tl.org_id = t.org_id`（断言唯一），子进程里两个方向的详情格都必须变红。迁移一侧的 mutant（组合外键退回单列、`org_id` 可空）按 §S1.7 的做法手工证红，记在验证 MD。

个人分组第二租户（groups，S8）：同一用户在 org A 与 org B 各有 `user_orgs` 行，各建一个个人分组并各摆放一条任务；token 为 org A 时，`GET /api/task-groups` 与 `/items` 只含 A 的分组与摆放，`PATCH /api/task-groups/<B 的分组 id>` 与 `DELETE` 都是 404，B 的行不变。正控：token 换成 org B，看到的是 B 的那一份。

### 10.5 门 8（`M4|8|A支与非法IANA`）

纯函数层的六格边界与 UTC mutant 已在 main，本 PR 不重写，只在最终 head 上重跑。真库的 `now()` 钉不到秒级，边界六格留在纯函数层，PR body 写明。

**422 格**（`task-m4-dates`，POST 与 PATCH 各一组）：

- `timeZone: 'Not/AZone'` ⇒ 422 `INVALID_TIME_ZONE`，库里没有新行 / 行未变。
- 同一请求体换成 `'Asia/Shanghai'` ⇒ 200（正控）。
- 变体：`'asia/shanghai'` ⇒ 200，读库得 `time_zone = 'Asia/Shanghai'`（D7）。变体只用大小写，不用别名对：别名是否折叠取决于运行时的 ICU 数据。

**A 支**（HTTP + 真库）：

- 载体 `/api/tasks/pending-count`。夹具用户经 `PATCH /api/task-settings` 把 `badgeScope` 设为 `'overdue_or_today'`（顺带走一遍设置路由）。
- 夹具任务经 `POST /api/tasks` 创建：定时、`timeZone: 'Asia/Shanghai'`、负责人是夹具用户。
- `now()` 钉不住，用**运行期定极性**：先 `SELECT now()`，用 `viewerNextMidnight` 算出上海与 UTC 各自的下一个零点，`due_at` 取两者的中点（把这个瞬时换算成上海的墙上日期与时间提交）。UTC 小时 < 16：正确回退得 0，回退成 UTC 得 1；UTC 小时 ≥ 16：正确回退得 1，回退成 UTC 得 0。两种极性都有判别力。
- 距翻转点（UTC 16:00 或 00:00）不足 2 分钟时，**等到越过翻转点再跑，不 skip**。用例超时设到 9 分钟（等待至多约 2 分钟，其余是子进程变异的余量）。
- 正控：头为 `Not/AZone`、不带头、头为 `Asia/Shanghai`，三个响应体逐字节相同（比 `response.text`），且等于当前极性的期望值。
- 负控一（路由层）：沿用那两行 needle，把校验结果后接 `?? 'UTC'`；非法头与缺头的计数必须与显式头不同。
- 负控二（SQL）：把 `task-access.ts` 里 `COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone)` 的**每一处**都换成以 `'UTC'` 兜底（该文本出现多次，必须全换）；缺头的计数必须翻转。
- 两个负控都是改**生产码**，不是在测试里模拟回退。

### 10.6 R03 的其余格（`task-m4-dates`）

- POST：全天任务的 `due_at` 是当地 23:59:59.999；定时任务的 `due_at` 是该墙上时间的瞬时；有日期没时区 422；有时间没日期 422；`2026-02-30` 422；`25:00` 422。
- 类型闸（§5.1 第 1 步），POST 与 PATCH 各一组：`dueTime` / `startTime` 为 `''`、`0`、`false`，`dueDate` 为 `['2026-09-30']`、`20260930`、`{}` ⇒ 各 422 `INVALID_DATE`，不是 500；库里没有新行 / 行未变。`task-edit.test.ts` 里同一组值对 `planTaskDates` 各有一格单测，断言返回 `reason: 'invalid_date'` 而不是抛错。
- 缺省提醒三格：定时 ⇒ `due_at − 30min`；全天 ⇒ 任务时区 18:00（查看者头设成别的时区，结果不变）；`00:10` 截止 ⇒ 前一日。策略 `none` ⇒ `NULL`；显式 `remindAt: null` ⇒ `NULL`；显式瞬时原样；非法 `remindAt` 422。
- PATCH：缺 `expectedVersion` 422；过期 409 且体里的 `currentVersion` 等于库值；成功后 `version` +1 且只 +1（一次改三个字段）；空操作 `version` 不变、无事件；每个变化面恰一条事件、`actor_id` 是操作者；改截止日不带 `timeZone` 422；只带 `timeZone` 时 `due_at` 重算并写 `due_changed`；改截止日不带 `remindAt` 时 `remind_at` 不变；`remindAt` 变化写 `remind_changed`；非编辑者 404 且行未变；他 org 404；已软删 404。
- 缺省的键保留库值（S4 闸审 S4-T2 / S4-T3）：一个日期、时间、时区、提醒、描述都有值的任务，先只改描述、再只改标题，每一次除被改的列与 `version`、`updated_at` 外整行不变；纯函数层同样两格（`planTaskPatch` 的 `next` 等于库值只换那一列）。
- 截止瞬时的年份范围（`[own-38]`）：POST 与 PATCH 各有 `9999-12-31` 在 UTC 以西算到 10000 年的格，422 `INVALID_DATE`、无新行 / 行不变；东京的同一天是 200（`due_at` `9999-12-31T14:59:59.999Z`），把它的时区改到纽约 422 且行不变。
- 时间戳取在锁后（S4 闸审 AUTHZ-2）：另一条连接持 org 结构锁，PATCH 在锁上排队（`pg_locks` 里出现未授予的 advisory 锁）之后，持锁方读一次 `clock_timestamp()` 再提交；PATCH 的 `updated_at` 必须晚于这个时刻，事件的 `occurred_at` 与 `updated_at` 相等。
- 权限码（S4 闸审 AUTHZ-1，不等 S10）：角色只带 `tasks:read` 的任务创建人 PATCH 自己的任务与缺失 id，都是同一个 403 `{ error: 'Insufficient permissions' }`，行与事件不变；同一人取详情 200 且 `canEdit` 为真（行级能力在，挡住它的只有路由守卫）。
- 两个并发 PATCH 带同一 `expectedVersion`：恰一方 200、另一方 409（结构锁串行后按版本判）。
- complete / reopen 的成功体带 `version`，翻转时 +1。
- 详情返回新四键（`description` `startDate` `startTime` `remindAt`）。`listIds` 的格在 S7（§10.4 清单项表）。

### 10.7 M4 新路由在已有门里的子集行（门 1 / 2 / 13 / 16 / 17 / 20）

| 门 | 本 PR 的格 | 位置 |
|---|---|---|
| 1（`M4\|1\|清单第二租户` 与门 1 的 M4 新表面子集） | ① 每条新写路由缺 org ⇒ 422 `ORG_MISSING`；集合读 ⇒ 降级体；单对象读 ⇒ 404；token 的 org 与用户无在职关系（没有 `user_orgs` 行，或该行停用）⇒ 写 422、读同缺 org。② 清单第二租户读格（见下） | `tasks-auth-gate.ts`，新表 `M4_ROUTES` |
| 2 / 16（`M4\|2\|清单路由` 与门 2 的 M4 新表面子集） | 每条新路由：无 admission ⇒ 403；只有另一个码 ⇒ 403；只有 `tasks:admin` ⇒ 403（R18）；对照用户 ⇒ 200 | 同上，`it.each(M4_ROUTES)` |
| 13 | 正控：真实 `MetaSheetServer` 上非 admin 打 `GET /api/task-settings` ⇒ 200（S3），打 `GET /api/task-lists` ⇒ 200（S5）。负控：把 `tasksRouter()` 里 `registerTaskSettingsRoutes(router)` 那一行注释掉，设置格变成 404；把 `registerTaskListRoutes(router)` 那一行注释掉，清单格变成 404。改写经 `runSourceMutant`，先断言 needle 在 `routes/tasks.ts` 里恰出现一次 | `task-m4-paging-settings`、`task-m4-lists` |
| 1 / 2 / 16 的路由人口 | 枚举 `tasksRouter().stack`，得到「方法 + 路径」集合，断言它**等于** P0-A 的 8 条字面量 ∪ `M3_ROUTES` ∪ `M4_ROUTES`（本 PR 之后应为 8 + 13 + 30 = 51 条），且三张表之间没有重复项。同一格内把 `M3_ROUTES`、`M4_ROUTES` 的每一行按 Express 的分派规则解析（该行的方法与带占位 id 的路径命中的第一层路由），那一层的「方法 + 路径」必须等于该行的标签 | `tasks-auth-gate.ts` |
| 17 | 新文件满足 ①②④；收集数 = 静态展开数 | 验证 MD、PR body |
| 20 | 新纯函数模块无 I/O | 现有 harness 自动覆盖 |

**清单第二租户读格**（`tasks-auth-gate.ts`，trust-off 配置，照该文件现有的门 1 隔离读格的写法与注释格式）：

- 夹具：一个用户，`user_orgs` 只有 org A 一行（`is_active = true`）；角色只带 `tasks:read`，有 admission。清单 LA 在 org A、LB 在 org B，两者除 `org_id` 外同形，该用户在两张清单里都有 `edit` 成员行（LB 与它的成员行只能由测试直发 SQL 播种），各含一条同形任务。token 的 `tenantId` 为 org A，不带 `perms`。
- 前置逐条标注（写在用例上方的注释里）：a–d、f–i 适用；e 不适用（读格）；b 适用（`user_orgs.org_id` = token 的 `tenantId` = org A，trust-off 下经 DB 核对）。
- 正控先跑：`GET /api/task-lists` 200，`items` 只含 LA 且非空；清单 id 之下的六个读（详情、`/events`、`/members`、`/items`、`/groups`、`/group-items`）对 LA 各 200，对 LB 各 404，体与不存在的清单 id 逐字节相同（S5 时是详情、`/events` 与 S7 的 `/items`，S10 补齐其余三个）。
- 负控：把 `task-list-access.ts` 里 `(task_lists.org_id = ${ORG_PLACEHOLDER}) AND ` 改成恒真（先断言 needle 恰一次，`cp` 备份，`finally` 恢复并断言逐字节复原），子进程直接调清单服务的「我的清单」与「按 id 取清单」两个函数、org 参数为 A，两个读面分别证红。

`M4_ROUTES` 仍是手写的表（`it.each` 需要它），但它的完整性不再靠验证 MD 里的一个数字：上面的人口格把它与路由器实际注册的东西机械对齐，漏登记或多登记都会红；每一行实际发出的请求也经分派绑定到它的标签上，行的方法或路径漂到相邻路由同样会红。这一格要求新路由直接注册在 `tasksRouter()` 的同一个 `router` 上（§3.0），不能嵌套子 `Router()`，否则 `stack` 里只看到一层挂载。P0-A 的 8 条目前在该文件里没有表，本 PR 以字面量补上。文件里不出现 `.skip(`。鉴权门只经 `vitest.tasks-auth.config.ts` 跑，不在 `tasks-realdb` 的清单里。

**S10 实现记录**（`tests/tasks-auth/tasks-auth-gate.ts`）：

- `P0A_ROUTES`（8 条字面量）与 `M4_ROUTES`（30 行）。每行的标签就是「方法 + 路径」，另带权限码、请求体、200 正控要先播种的行（任务、清单、已归档、成员、清单项、分组、个人分组），三条集合读另有标记。
- 路由人口格：`tasksRouter().stack` 的每一层都必须带一条路由，展开得到 51 条；与三张表的并集相等，三张表合起来没有重复；同一格内 `M3_ROUTES` 与 `M4_ROUTES` 的每一行经分派绑定到自己的标签（闸修复）。
- 门 1，每条 M4 路由一格（30 格）。同一个用户（两个码、admission、本 org 在职）用三种 token：不带租户声明（同时带指向本 org 的 `x-tenant-id` / `x-org-id` 头）；声明一个没有 `user_orgs` 行的 org；声明本 org。前两种的回答都与缺 org 的回答逐字节相同：写 422 `ORG_MISSING`，三条集合读（`GET /api/task-lists`、`/api/task-groups`、`/api/task-groups/items`）是不带 `total` 的降级体，其余七条读 404；本 org 的任务域行逐字节不变。第三种是 200 正控。前置：前两种 a、c、d、f–i 适用，b 刻意取反，写路由 e 适用；第三种 a–i 适用。
- 门 2 / 16，每条 M4 路由一格（30 格）：无 admission 403；只有另一个码 403；对照用户在自己播种的行上 200。每个用户的授予在整组里固定。
- `[own-53]` 在 trust-off 配置下一格：只有清单 `edit` 身份的成员对增删负责人、增删关注人四条写都得到与缺失任务逐字节相同的 404，任务域行不变，PATCH 照常 200；创建人的四条写各 200。realdb 的全套格跑在 token 信任下，这一格补上 trust-off 的一侧。
- 鉴权门由 24 格变为 86 格（加 1 + 30 + 30 + 1）。变异 20 个，见验证 MD §S10。

**闸修复记录**（S8–S10 增量闸审，格数仍是 86）：

- 门 1 的 M4 格加第四种 token：声明一个本用户 `user_orgs` 行停用（`is_active = false`）的 org。回答与缺 org 的回答逐字节相同，该 org 的任务域行不变。前置：a、c、d、f–i 适用，b 刻意取反（该行停用），写路由 e 适用。M2 的跨 org 写格同样补这一种 token（`POST /api/tasks` 与一条 M3 写，按文本比较）。
- 路由人口格的分派绑定（见上表）替换了同格原来逐行去掉再比的负控。
- 门 2 / 16 加第五个用户：角色只带 `tasks:admin`，有 admission 与本 org 在职行；每条 M4 路由 403 `{ error: 'Insufficient permissions' }`（R18：这里没有路由收 `tasks:admin`）。

门 18（三个新 flag）随 PR-3b；门 21 / 22 随前端。这三个门的 M4 子集行不在 PR-3a 计分。

### 10.8 单测

- `task-access.test.ts`：两个新构造器的文本快照；`tasks.org_id = $2` 在每个输出里恰一次；原有快照不动。
- 新文件 `task-list-access.test.ts`、`task-edit.test.ts`；`task-groups` / `task-lists` / `task-settings` 的追加函数各补用例。
- `task-ids-runtime.test.ts`：三个新生成器的前缀与四合取。
- `task-gate19-identities.test.ts`：新参数；`i-m4` 块与测试文件名字相等。
- `task-records-guards.test.ts`：日期形状非法时事务数为 0；`createTask` 首句仍是 `SET TRANSACTION …`。
- 门 20 harness、三集合枚举、前缀唯一性守卫、鉴权接线测试、manifest 测试：不改，跑绿。

### 10.9 回归

M2 与 M3 的全部真库文件、鉴权门在最终 head 上重跑。完整的「M2| 与 M3| 全部门行回归」按 R01 记在 PR-3c；本 PR 只保证 `tasks-realdb` lane 与鉴权门全绿，并在验证 MD 里列出被动过的既有断言（§5.4 的四处、§4.6 的播种）。

### 10.10 S1–S4 闸审修复切片补的格

两轮闸审（S1–S3、S4）指出若干守卫没有格钉住：对应的变异在全量 lane 下存活。修复切片按文件补格，每一格都在验证 MD 里有让它变红的变异。

| 文件 | 补的格 | 钉住的东西（闸审编号） |
|---|---|---|
| `task-m4-schema` | org 一致性四格；回滚格改为比 OID 与哨兵行；夹具清理逐字匹配前缀一格 | 组合外键（M4G1-AUTHZ-1 / SCH-1）；回滚确实发生（M4G1T-07）；`LIKE` 通配（M4G1-SCHEMA-03） |
| `task-m4-list-roles` | 跨 org 清单项（两层 + 负控 7）；只有清单身份的人不进视角总数、`/pending`、红点，同时是负责人的计入；非成员同时是同 org 另一张清单的 `edit` 成员；父候选不含清单外的任务；list-reader 看得到同清单子任务；只有所有者行的成员能编辑；两张清单 `read` + `edit` 的并集（两名用户角色互换，任何行序下都有一人先遇 `read`、一人后遇 `read`） | M4G1-AUTHZ-1；M4G1T-01；M4G1T-02；M4G1T-05；M4G1T-08 |
| `task-m4-paging-settings` | 混合 org 里五个视角与 `/pending` 的 `total` 各等于该视角的行数；他人设 `off` 后邻居的红点仍数自己的逾期任务；一个 org 的设置 PATCH 不改同一用户在另一 org 的行；只改 `defaultRemindPolicy`、只改 `dailyReminderEnabled` 都落库；非 JSON 请求体 422（`[own-39]`）；两条设置路由的权限码；红点夹具避开 UTC 零点前一分钟；门 13 负控的子进程要求框架 404 的形状与解析出的 org | S3-PAGE-1 / M4G1T-03；S3-BADGE-1 / M4G1T-04；M4G1T-06；S3-SETTINGS-NIT-1；M4G1T-11；M4G1T-09 |
| `task-m4-dates` | 截止瞬时年份范围（`[own-38]`）；缺省的键保留库值；锁后时间戳；PATCH 的 `tasks:write` | DATES-1；S4-T2 / S4-T3；AUTHZ-2；AUTHZ-1 |
| `task-m4-lists` | 门 13 负控的子进程要求框架 404 的形状与解析出的 org | M4G1T-09 |
| `global-history-flag-manifest.test.mjs` | `TASKS_ENABLED` 条目的 `danger`、两个读点、按磁盘文件名点名的 M4 迁移 | M4G1T-12 |

四个 M4 真库文件的 HTTP 改走 `tests/helpers/tasks-http-harness.ts`：每个文件一个监听，请求带 `Connection: close`、不复用连接（S4 闸审 S4-T1；M3 的 M3R2-CONC-6 同一做法）。子进程变异脚本与门 13 的 `MetaSheetServer` 格仍各用自己的传输。

### 10.11 S5 与修复切片闸审补的格

| 文件 | 补的格 | 钉住的东西（闸审编号） |
|---|---|---|
| `task-m4-lists` | 锁后时间戳：建清单、改名、归档、取消归档在结构锁上排队，各自的时间戳晚于持锁方提交前读的 `clock_timestamp()`，行与事件同一读数（SQL 比较），持锁方在等待期间写下的事件在动态里排在它们之后；建清单、改名、归档三格的「同一读数」改成在 SQL 里比较 | S5-TS-1、S5-TS-2、M4G3T-02 |
| `task-m4-lists` | 归档不改变可见性：只有清单身份的 `read` 成员与 `edit` 成员在清单归档前后取详情（逐字节相同）、`edit` 成员 PATCH、两人评论都照常 | M4G3T-01 |
| `task-m4-lists` | 「我的清单」顺序：六张清单的 `updated_at` 与 id 顺序相反、其中三张同刻，整页顺序等于 SQL 的 `ORDER BY updated_at DESC, id DESC`；改名把最旧的一张排到最前 | M4G3T-03 |
| `task-m4-lists`、`task-m4-list-members` | `createdBy` 与 `ownerId` 在创建人不是所有者的清单上分得开；第二次转让之后再核一次 | S5-NIT-1 |
| `task-m4-list-members` | 锁后时间戳：成员增、改、删、再增、转让在结构锁上排队，事件晚于持锁方的读数 | S5-TS-1（同一根因） |
| `task-edit.test.ts` | 截止日期的下界：`0001-01-01`、`0099-12-31`（UTC 与东京）是 `invalid_date`，`0100-01-01` 可存且东京的瞬时落在 0099 年 | M4G3T-05 |

### 10.12 S6+S7 闸审修复切片补的格

| 文件 | 补的格 | 钉住的东西（闸审编号或裁定） |
|---|---|---|
| `task-m4-list-roles` | 增删负责人与关注人须直接角色：只有清单身份的 `edit` 成员与经清单 `edit` 的关注人，四条写（合法、坏请求体、坏路径 id）都是缺失 id 的 404，零写入，`canManageMembers` 为假；同一 `edit` 成员 PATCH、设父、切模式、评论、完成照常；关注人 `leave` 照常。创建人与负责人四条写各 200、`canManageMembers` 为真（新格 `dirmem`） | owner 2026-10-07 裁定，`[own-53]` |
| `task-m4-list-items` | (a1)、(a2) 与 `[own-53]` 一起：只有清单身份的 `edit` 成员加入清单与增删成员都是 404；创建人经 (a2) 移出之后该成员取详情 404 | 同上；(a1)、(a2)（owner 2026-10-07 裁定） |
| `task-m4-list-items` | 移出格与创建人支路格：同一清单、同一分组里另有一条任务，移出之后它的清单项与分组项仍在 | M4G4T-02 |
| `task-m4-list-items` | `listIds` 格：只在一张清单里的 `edit` 成员、读另一张清单的关注人，各只看到自己那张 | M4G4T-03 |
| `task-m4-list-members` | 改角色、移除、转让三格：目标与转让方另在别的清单里有成员行（一张是所有者、一张是 `read`），写后那些清单逐字节不变、各仍恰一行 `owner` | M4G4T-01 |
| `task-m4-list-members` | 已归档清单上的成员路由与未归档清单逐一相同（新格） | S6-ARCH-1 |
| `task-p0a` | 详情形状多 `canManageMembers`；创建人为真、关注人为假 | §5.5 |
| `task-access.test.ts` | `canChangeTaskMembers` 真值表、与直接角色的 `edit` 一致、清单身份传不进去 | `[own-53]` |
| `task-records-guards.test.ts` | 四条写：只有清单身份的调用者 404 先于请求体与路径 id、不读清单身份、零写入；关注人 404、`leave` 照常；创建人与负责人的写；成员写与清单项移出的整条语句 | `[own-53]`；M4G4T-01、M4G4T-02 |

---

## 11. `ASSUMPTION(task-m4)` 全表

依赖裁决包条目的。`[Rxx]` 与 `[N2]` 全部已于 2026-10-07 裁定，取值与下表相同，代码里标 `RULED(2026-10-07)`。`[Dx]` 是裁决包列出的缺省实现约束：包内写明它们不需要裁、owner 可以点名推翻，所以代码里仍标 `ASSUMPTION(task-m4)`，取值同下表：

| 标签 | 内容 | 位置 |
|---|---|---|
| `[R02]` | 建 `task_user_settings`；`badge_scope` 三值缺省 `overdue`；每日提醒缺省关；提醒策略闭集 default / none，缺行视为 default；`GET/PATCH /api/task-settings` | 迁移、`task-user-settings.ts` |
| `[R07]` | 设置表的 `time_zone` 列与「开每日提醒必须有时区」的 CHECK（只建列，行为在 PR-3b） | 迁移 |
| `[R03]` | POST 收日期、时区、`remindAt`；新增 PATCH，`expectedVersion` 必填，冲突 409 带 `currentVersion`；PATCH 兼管提醒；`tasks.remind_at`；不建幂等键表；各成功体回 `version`；时区只落规范名 | 迁移、`task-edit.ts`、`task-patch.ts`、`task-records.ts` |
| `[R04]` | 五视角臂不变；`buildTaskByIdCondition` 与视角构造器共用私有 org/deleted 生成器；详情 = 取行 → 角色（含清单身份）→ `view`；用例前缀 `gate19m4\|`；锁加 `i-m4`（锁的改动不在本 PR，见 §12-Q1；在那之前期望清单放在本文，`[own-20]`） | `task-access.ts`、服务层六处 |
| `[R08]` | follower + list-reader 不能编辑（夹具钉住，不改表） | `task-m4-list-roles` |
| `[R09]` | 没有负责人的任务不计入任何人的红点（维持现状） | — |
| `[R01]` | 回复模板末句一并同意（2026-10-07），取推荐值的修订形：不另起字母键；M4 格落在锁里已有的 `M4\|8\|A支与非法IANA`、`M4\|19\|清单角色`，以及「整数门号 + M4 子集」的新行（`M4\|1\|清单第二租户`、`M4\|2\|清单路由`、门 1/2/13/17/20 的 M4 新表面子集）；新行由另一个只改锁的 Draft PR 写进锁，在它合并之前一律候选、未计分；清单第二租户格落 `tasks-auth-gate.ts`（trust-off） | §10.0、§10.7、`tasks-auth-gate.ts` |
| `[R06]` | 只取其中与本 PR 相关的一点：扫描按 `remind_at` 取区间，所以本迁移建 `idx_tsk_remind`，谓词只到 `remind_at IS NOT NULL`（收件人、扫描窗、到点判定都在 PR-3b） | 迁移 |
| `[R11]` | 分组 scope 为 list / user；接口上每个容器恰好一个默认组（清单 scope 库里恰一行；个人 scope 未落行时 `GET` 给合成项，库里至多一行，见 `[own-24]`），部分唯一索引保证至多一行；个人 scope 只对 assigned；残留分组项不联动删除、读写都按可见集过滤；整数位置、同事务重排；默认组禁止删除，被删分组里的项归入默认组 | 迁移、`task-group-records.ts` |
| `[R12]` | 加入或移出清单要清单 edit/owner、任务 `edit`、同 org；创建人不可移除；所有者唯一、先转让；转让后原所有者降为 edit。owner 2026-10-07 裁定取本件的版本，它与推荐值有两处不同，分开记：**(a1)** 加入一侧的任务 `edit` 只按直接角色判，是对推荐值的收窄；**(a2)** 任务创建人不经成员身份的移出支路与创建人的 `listIds`，是给任务创建人的一项新能力，是对推荐值的放宽，不是收窄。见 `[own-25]`、§3.4、§12-Q16 | `task-list-records.ts`、`task-lists.ts` 的两个谓词与 `visibleTaskListIds` |
| `[R13]` | 清单只归档不删；不做硬删；软删后清单项保留、读取时过滤 | 路由表、读路径 |
| `[R14]` | 不设数据库硬限额 | 迁移 |
| `[R15]` | `limit` 1..100 缺省 100（包内两处取值不一致，取回复模板，§7.1）、`offset`、`total`、越界 422、回填 `/api/tasks` 与 `/pending`、不回改 M3 评论、cursor 推后 | §7 |
| `[N1]` | 已裁（同上）。内容见 §1「不做」表：增删负责人使状态翻转时补 `completed` / `reopened` 事件。本 PR 不实现（`[own-21]`），放进哪个 PR 见 §12-Q4 | — |
| `[R17]` `[N2]` | owner 2026-10-07 裁定。写入负责人、关注人或清单成员时，校验该用户在本 org 在职（判据与登录一致）；转让所有者的目标同样校验（`[own-27]`）；一个 helper、一个 422 码；回填 M2 的 POST 与 M3 的增负责人、增关注人，并补夹具种子（S9）。发送时的再次复核属 PR-3b | `task-org-members.ts`；调用点：`task-list-records.ts`（增成员、转让，S6）、`task-records.ts` 的 `createTask`、`task-structure.ts` 的 `addAssignee` / `addFollower`（S9） |
| `[R18]` | 新路由不用 `tasks:admin` | 路由 |
| `[R19]` | `GET /api/task-lists/:id/events` 读 `task_list_events`，成员可读，分页 | `task-list-records.ts` |
| `[R21]` | PR body 说明：任务相关表没有计入 DML 普查的分母 | PR body |
| `[R22]` | 不接待办中心 registry；`source` 仍为 `'task'` | — |
| `[R23]` | 前缀 `tgrp_` / `tlev_` 用四合取 CHECK；outbox id 用 uuid；成员表与各项表以复合键为主键 | 迁移、`task-ids-runtime.ts` |
| `[D1]` | outbox 表形：`org_id` 无默认值、`status` 含 `outcome_unknown`、`recipient_role` 四值、`redelivery_safe`、一条唯一加三条非唯一索引 | 迁移 |
| `[D2]` | 加入或移出清单同事务写两条事件；清单 scope 跨组移动写 `group_changed`，个人 scope 不写 | `task-list-records.ts`、`task-group-records.ts` |
| `[D5]` | `badge_scope='off'` 时不查库，回 `{ count: 0, badgeScope: 'off' }` | `countPending`、路由 |
| `[D7]` | 写入时区只落规范名；门 8 加大小写变体格 | `task-edit.ts` |
| `[D8]` | `task_lists.org_id` 单点发射，配第二租户负例 | `task-list-access.ts` |
| `[D9]` | 稳定排序键 | §7.1 |
| `[D12]` | 不新增 `Intl.DateTimeFormat` 调用点 | `task-edit.ts` |
| `[D14]` | 软上限：成员 100、单任务清单 10、每容器分组 50，超限 `LIMIT`；名字空白 `INVALID_NAME`、超 100 码点 `NAME_TOO_LONG` | 任务 D 常量 |
| `[task-d]` | 沿用任务 D 自己的取舍：`edit` 即可改名、管成员、管分组；转让目标必须已是成员；`owner` 不能直接指派 | `canListAction` 的调用处 |

对锁或计划中已定方向条目的偏离（不是填空；代码注释写「偏离锁 §13-15」，不写成自选项）：

| 标签 | 内容 | 偏离的对象 |
|---|---|---|
| `[dev-01]` | `task_lists` 不建 `owner_id` 列；所有者的唯一真相是 `task_list_members.role = 'owner'` 那一行（`uq_tlsm_owner`），接口的 `ownerId` 从它读出；语义照旧（创建人不可变、所有者可转、原所有者降为 `edit`） | 锁 §13-15（已定方向，标题带 `owner_id`）与其来源计划 v5 §2.1 的 `task_lists` 列清单；§12-Q9 |

本件自己的取舍（裁决包与锁都没写；`[own-25]` 与 `[own-53]` 已于 2026-10-07 裁定，代码里标 `RULED(2026-10-07)`，其余仍标 `ASSUMPTION(task-m4)`）：

| 标签 | 内容 |
|---|---|
| `[own-01]` | 按 id / 按清单的条件构造器用 `$1` 放对象 id、`$2` 放 org |
| `[own-02]` | 新增 `buildTaskInListCondition`，给清单项列表与「任务是否在清单里」用 |
| `[own-03]` | `task_lists.icon` 按计划建列，本 PR 的接口不读不写 |
| `[own-04]` | 所有 M4 写操作复用 org 结构锁，不新增锁键；设置写用行锁 |
| `[own-05]` | `version` 只在状态翻转与 PATCH 有变化时 +1 |
| `[own-06]` | PATCH 从不派生 `remind_at`；缺省算法只在创建时用 |
| `[own-07]` | 碰日期的请求必须同体带 `timeZone`；不做隐式联动清空；不加「开始不晚于截止」 |
| `[own-08]` | `description` 上限 20000 码点，空串存 NULL，不修剪 |
| `[own-09]` | 清单级能力不足也回 404；错误码 = 纯函数 reason 转大写 |
| `[own-10]` | 分页先于 `view` 判定；降级体不带 `total`；服务保留数组返回，另加计数函数 |
| `[own-11]` | `badgeScope` 键只在 `off` 时出现；`countPending` 对 `off` 返回 `null`；路由两行 needle 原样保留 |
| `[own-12]` | 默认组：清单 scope 随建清单创建；个人 scope 在首次写时落行（细节见 `[own-24]`）；名字取常量 `TASK_DEFAULT_GROUP_NAME`；计入 50 的上限；`groupId: null` 在两种 scope 都指默认组 |
| `[own-13]` | 摆放稀疏，缺行视为默认组；`PUT { groupId, position }`，服务端构造顺序；读与写共用一个「可见集」（清单 scope：仍是清单项且未软删；个人 scope：仍在本人 assigned 臂且未软删），`position` 是可见集里的 0 起稠密下标；不可见的残留行不删，每次重写时原序排到可见行之后；分组自身位置保持 `0..n-1` 连续，删组同事务重编号（`planGroupPositionsAfterDelete`）；不提供分组自身重排 |
| `[own-14]` | 成员可以经同一条 `DELETE` 移除自己（退出清单）；前提是调用者**是成员**，判定由纯谓词 `canRemoveListMember` 给出，非成员一律 404 |
| `[own-15]` | `GET /api/task-lists` 用 `includeArchived` 过滤，缺省不含已归档 |
| `[own-16]` | 在职校验豁免操作者本人；对负责人与关注人只在确有新增时校验。S9：创建时只查创建人以外的 id（只有创建人、或没有负责人的创建不发查询）；增负责人、增关注人时调用者写入自己不查；只豁免操作者，任务创建人被别人写入时照查 |
| `[own-17]` | 不新增 flag；新路由挂在同一个 router 工厂里 |
| `[own-18]` | PATCH 每个变化面一条事件，payload 为 `{}` |
| `[own-19]` | 缺 org 时单对象读 404、集合读降级 |
| `[own-20]` | `i-m4` 期望清单先放在本设计文档里，本 PR 不改锁（R04 已裁定锁要加它；由哪个 PR 写进锁见 §12-Q1） |
| `[own-21]` | N1 不在本 PR |
| `[own-22]` | 只用一条迁移文件（staging 的排除机制只能证明「表不存在」，加列与建索引必须随建表同一条） |
| `[own-23]` | 锁的最小索引集之外加五条索引 |
| `[own-24]` | 个人 scope 默认组：接口上恒有一个（未落行时 `GET` 返回 `id: null` 的合成项），库里在首次写（`POST /api/task-groups` 或 `groupId: null` 的 `PUT`）时于结构锁内先查后插；落行前不能改名 |
| `[own-25]` | ruled 2026-10-07。(a1) 加入清单时任务端只认直接角色（创建人或负责人），清单身份带来的 `edit` 不算；(a2) 任务创建人有一条不经成员身份的移出支路（四种失败逐字节同一个 404），详情 `listIds` 对创建人列出全部包含该任务的清单 id、对其他人只列他是成员的那些 |
| `[own-26]` | `tasks.remind_at` 的部分索引在本迁移里建，谓词只到 `remind_at IS NOT NULL` |
| `[own-27]` | 转让所有者的目标过在职校验，未通过 422 `INACTIVE_ORG_MEMBER` |
| `[own-28]` | `TASKS_ENABLED` 的 manifest 条目 `danger` 从 `low` 调到 `medium`，`purpose` 写明四个前缀与对 M4 迁移的依赖，`source` 改成锚点形式 |
| `[own-29]` | `timeZone: ''` 读作 `null`：合并后仍有日期 ⇒ `TIME_ZONE_REQUIRED`，没有日期 ⇒ 清空时区；空白串等其他不是具名时区的字符串仍是 `INVALID_TIME_ZONE`（S4） |
| `[own-30]` | `remindAt` 文法：`YYYY-MM-DDTHH:MM[:SS[.fff]]` 后接 `Z` 或 `±HH:MM`，`T` / `Z` 大写，小数至多三位，日期真实存在，换算成瞬时后年份在 0001–9999；不用平台的宽松日期解析（S4） |
| `[own-31]` | `description` 原样存，不做 NFC、不修剪；含 U+0000 或孤立代理项是 `INVALID_DESCRIPTION`，与标题、评论正文同一条可存文本规则（S4） |
| `[own-32]` | `includeArchived` 只认恰好的 `'true'` / `'false'` 或缺省，其余（含空串、大写、重复键、嵌套键）422 `INVALID_FILTER`；与分页同时非法时报分页的码（S5） |
| `[own-33]` | `GET /api/task-lists/:id/events` 缺 org 回 404；非成员的 404 先于分页的 422（照 M3 评论列表的先例）（S5） |
| `[own-34]` | 默认组名取 `'默认分组'`（`TASK_DEFAULT_GROUP_NAME`，两种 scope 共用）（S5） |
| `[own-35]` | 清单列表按 `updated_at DESC, id DESC`，清单动态按 `occurred_at DESC, id DESC`（S5） |
| `[own-36]` | `created` / `renamed` / `archived` / `unarchived` 四种清单事件的 payload 为 `{}`（S5） |
| `[own-37]` | 清单项与分组项带 `org_id`，经组合外键同时指向两端的 `(id, org_id)`；清单 scope 分组以 `(list_id, org_id)` 指向其清单；`tasks`、`task_lists`、`task_groups` 各加 `UNIQUE (id, org_id)`；成员表不带 `org_id`。读路径另以「清单行 org = 任务行 org」限定清单身份（§2.2、§6.2；S1–S4 闸审修复切片） |
| `[own-38]` | 由 `dueDate` / `dueTime` / `timeZone` 算出的截止瞬时不得越过 9999 年末（`[own-30]` 瞬时范围的上界），否则 422 `INVALID_DATE`；只改时区的 PATCH 也按重算后的瞬时判（S1–S4 闸审修复切片）。下界是 `computeDueAt` 的日历探针：截止日期从 `0100-01-01` 起（0001–0099 年是 `INVALID_DATE`），算出的瞬时最早在 0099 年，不另判（S5 闸审 M4G3T-05） |
| `[own-39]` | `PATCH /api/task-settings` 只读 JSON 请求体：`Content-Type` 不是 `application/json` 时按没有请求体处理，422 `INVALID_SETTINGS`（缺 org 仍先答 `ORG_MISSING`）；`{}` 照 §4.2 落缺省行（S1–S4 闸审修复切片） |
| `[own-40]` | 成员名单按 `user_id` 字节序（SQL 端 `COLLATE "C"`，不随库的缺省排序规则变）；成员四条写路由的成功体 `{ id, members }` 与分页的 `GET …/members` 同一顺序（S6） |
| `[own-41]` | 成员路由在能力判定之后先校验成员 id（路径段或请求体的 `userId`，422 `INVALID_MEMBER`），再校验 `role`（422 `INVALID_ROLE`）；两者都非法时报 `INVALID_MEMBER`；在职查询在这两步之后、事务内（S6） |
| `[own-42]` | `GET /api/task-lists/:id/members` 照 `[own-33]`：缺 org 404；非成员的 404 先于分页的 422（S6） |
| `[own-43]` | `GET /api/task-lists/:id/items` 照 `[own-33]` / `[own-42]`：缺 org 404；非成员的 404 先于分页的 422；顺序是任务的分页排序键 `TASK_PAGE_SORT_KEY`（S7） |
| `[own-44]` | `POST …/items` 的判定顺序：清单 `add_item` 之后才校验请求体；`taskId` 必须是可打印 ASCII 字符串（缺键、非字符串、空串、含不可打印字符都是 422 `INVALID_TASK`）；任务端判定先于空操作与配额（S7） |
| `[own-45]` | `DELETE …/items/:taskId` 按 org 取清单而不要求成员行；路径 id 不可存、清单不存在或他 org、任务不存在 / 已软删 / 他 org、两条支路都不成立，全部是同一个 404（S7） |
| `[own-46]` | 详情的 `listIds` 只算与任务同 org 的清单（两行比较）；已归档的清单照算；去重、字节序（S7） |
| `[own-47]` | 单任务 10 张清单的配额（D14）数包含该任务的全部清单，含已归档的、含调用者不是成员的；已在清单的空操作先于配额判定（任务 D `planAddTaskToList` 的顺序）（S7） |
| `[own-48]` | `GET /api/task-lists/:id/groups` 与 `/group-items` 照 `[own-33]` / `[own-42]` / `[own-43]`：缺 org 404；非成员的 404 先于分页的 422（S8） |
| `[own-49]` | 摆放（两种 scope 的 `PUT`）的判定顺序：容器 → 路径任务在可见集里（404）→ `groupId`（422 `INVALID_GROUP`：键缺失、不是 `null` 也不是可打印 ASCII 字符串、不是本容器的分组）→ `position`（422 `INVALID_POSITION`：不是 JSON 非负安全整数，或大于去掉被移动任务之后的可见集大小）；两者都非法时报 `INVALID_GROUP`；`position` 必填（S8） |
| `[own-50]` | 没有分组项行的任务算在默认组里，把它放进默认组不算换组；清单 scope 换组时的 `group_changed` payload 为 `{ listId, fromGroupId, toGroupId }`，`occurred_at` 是目标组新写的分组项行的 `created_at`（S8）；删组只写 `group_deleted`，不为回到默认组的任务写 `group_changed`（闸修复） |
| `[own-51]` | 分组与摆放的排序里 id 按字节序（`COLLATE "C"`）：分组 `position, id`；组内 `position, task_id`；摆放分页按 `group_id` 再按稠密下标；删组重编号同序（S8） |
| `[own-52]` | 分组写的判定顺序：清单 scope 先成员、`manage_groups`、（改名与删组）分组属于本清单，都是 404，再看名字（422）、默认组（422 `IS_DEFAULT`）、上限（422 `LIMIT`）；个人 scope 建组的名字在开事务之前校验，改名与删组先判本人本 org 的分组（404）（S8） |
| `[own-53]` | ruled 2026-10-07。增删负责人与增删关注人四条写要求调用者对任务有直接角色（创建人或负责人），由纯谓词 `canChangeTaskMembers` 只从三列直接角色判定，在结构锁之后、请求体与路径用户 id 之前；不满足是与缺失 id 相同的 404（`[own-09]`）。只有清单身份的调用者保留 PATCH、设父、切模式、完成与重启（`canChangeCompletion`）、评论。关注人 `leave` 不受影响。详情的 `canManageMembers` 用同一个谓词（§3.4、§5.5、§6.3；S6+S7 闸修复） |

本件没有另起标签、而是直接执行锁的两处（写在这里，免得被当成自选项）：零负责人任务的完成与重启只有创建人（锁 §6.2），由 `canChangeCompletion` 执行（§6.3）；行级 `none` 的 404 与「不存在」的 404 逐字节相同（锁 §5.1），清单路由以「调用者是成员」为第一道判定执行（§3.0）。

---

## 12. 只有 owner 能答的问题

1. **R04（已裁 2026-10-07，只剩一处）**：(a) 改任务 B 的 `task-access.ts`（加两个导出、抽私有生成器，既有输出逐字节不变）与 (b) `i-m4` 清单、`gate19m4|` 前缀，都在回复模板末句里一并同意。仍待点名的是：`i-m4` 块何时、由哪个 PR 写进锁（承载 R01 新行的锁 PR 不改这一块）。在那之前，本 PR 的 25 格算候选，不算 `M4|19|清单角色` 已计分。
2. **`remind_at` 在改期时怎么办**：库里分不出「缺省派生」与「用户指定」。本件取「PATCH 从不派生」，后果是改截止日后提醒不跟着动。备选：(i) 加一列记来源，改期时只重算缺省派生的；(ii) 允许请求显式要求「按我的策略重算」；(iii) 以「现值等于旧缺省值」推断来源。三者都要 owner 说一句；(i) 还要加 DDL。
3. **R17 / N2（已裁，本题只剩本件自选的三处）**：owner 2026-10-07 裁定：负责人、关注人与清单成员的写入按登录判据校验本 org 在职（会话 org 与账号闸两半，§4.6），一个 helper、一个 422 码，发送时再复核（PR-3b）；回填 M2 的创建与 M3 的增负责人、增关注人并补夹具种子，已在 S9 落地（§4.6）。仍是本件自选、owner 可以点名推翻的：(a) 码名 `INACTIVE_ORG_MEMBER`，四种原因不区分；(b) 操作者本人豁免（`[own-16]`）；(c) 转让所有者的目标也过同一校验（`[own-27]`）。
4. **N1 归哪个 PR**（N1 的内容已于 2026-10-07 裁定）：本件没做。它要改 M3 的两个 handler，消费方是 PR-3b 的通知扇出，本件建议放进 PR-3b。放 PR-3a 还是 PR-3b，请点名。
5. **基分支与栈**：M3 后端已随 #6229 合入 main（`57621d2403`），本分支经 `f1510d0bed` 并入了它（验证 MD §S6.0），所以 PR-3a 以 main 为基时 diff 里不再带 M3 的提交；任务 D 仍是 #6186（Draft，基为 main），以 main 为基时 diff 里会带上任务 D 的全部提交。PR-3a 的 Draft 以什么为基？以非 main 为基时 `plugin-tests`、`web-tests`、contracts、`migration-replay` 不会触发。
6. **R01 的门行（已裁 2026-10-07，剩落锁与一处拆法）**：R01 取推荐值的修订形（§10.0）。本 PR 的格落在锁里已有的 `M4|8|A支与非法IANA`、`M4|19|清单角色`，以及新的整数门号子集行 `M4|1|清单第二租户`、`M4|2|清单路由`、门 1 / 2 / 13 / 17 / 20 的 M4 新表面子集行。新行由另一个只改锁的 Draft PR 写进锁，其合并另需点名；在那之前 PR-3a 以「新行候选、未计分」的状态交付。仍请确认一处拆法：门 18 的 M4 子集行随 PR-3b、门 21 / 22 的 M4 子集行随前端。
7. **R11 / R12 的细则**（R11、R12 本身已于 2026-10-07 裁定；下面是本件在其之下的取舍，见 `[own-12]` `[own-13]` `[own-14]` `[own-24]` 与 `[task-d]`）：默认组的创建时机与名字；个人 scope 默认组在首次写之前只在接口上存在（`id: null` 的合成项），库里至多一行，落行前不能改名，是否可以、是否要另给改名入口；摆放接口的形状与「可见集」下标；是否需要分组自身重排；`edit` 成员能否改名、管成员、管分组；成员能否自己退出清单；清单级能力不足回 404 而不是 403。
8. **分页**：(a) `limit` 缺省值：已随 R15 于 2026-10-07 裁定为 100（与 §7.1 相同），本问不再待答；(b) 两套规则并存：M3 评论（`INVALID_PAGE`，接受前导零）与 M4（`INVALID_LIMIT` / `INVALID_OFFSET`，拒绝前导零）。是否在某个 PR 里合流，合到哪一套？
9. **`task_lists` 不建 `owner_id` 列**（`[dev-01]`）：这是对锁 §13-15（已定方向，标题带 `owner_id`）及其来源计划 v5 §2.1 列清单的**偏离**，不是填空；语义不变，存放位置改为成员行。是否同意这一偏离；`icon` 列建而不接（`[own-03]`）是否同意。
10. **合并后 staging 的二选一**（§9.2）：本迁移用朴素 `CREATE TABLE`，staging 迁移对齐报告会把它判为高风险。**合并之后，所有线的 staging 部署都会在换上新镜像之后、于对齐门处失败（不是停在旧镜像上），直到您选定其一：(i) 授权 `action=migrate`，把 M4 迁移应用到 staging；或 (ii) 把它列入 owner 排除清单，并且 staging 保持 `tasks_enabled=false`。** 在您选定之前，含本迁移的镜像只能以 `tasks_enabled=false` 部署：以 `true` 部署时，deploy 先换镜像、打开开关，再于对齐门处失败，staging 停在禁止态（M2/M3 路由 500），要靠重新部署恢复。「排除且开关打开」是禁止态。另三问：(a) 是否要求 runner 线在 `compose up` 之前拒绝「`tasks_enabled=true` 而 M4 表不存在」，或把对齐门挪到换镜像之前（runner 与共享 workflow 的改动，不在本 PR）；(b) 回退：已应用本迁移的环境不能删迁移文件，`down()` 只在本迁移是该环境最近执行的一条时可经 `--rollback` 执行（§9.2 回退第 1、2 层），是否需要一条指定迁移的回退命令；(c) 是否接受「不新增 flag，M4 迁移必须先于或随同这份代码应用到任何 `TASKS_ENABLED='true'` 的环境」，还是要求另加一个开关把清单身份的读取隔开（那需要新 flag、manifest 条目与 staging runner 的输入）。
11. **迁移的口径**：锁 §4 写「不授权写迁移」、§4.2 写「ratify 前不建」。本 PR 以 `Draft migration: do not apply` 的形式起草 DDL，是否可以。`tasks.remind_at` 的扫描索引已在本迁移里建（`[own-26]`，理由同 `[own-22]`：只建索引的后续迁移无法被表缺席证明覆盖），谓词只到 `remind_at IS NOT NULL`，不带 `status` / `deleted_at`；R06 已于 2026-10-07 裁定，谓词仍是本件自选（`[own-26]`）：这个谓词是否可以，还是要在本迁移里就收窄。
12. **`badge_scope='off'` 的响应**：只在 `off` 时带 `badgeScope` 键（常规响应不变）是否可以；M3 前端在此期间对 `off` 显示 `0`，是否接受到 M4 前端为止。
13. **日期写入的两条严格规则**（`[own-07]`）：碰日期必须同体带 `timeZone`；清空日期不自动清空时间。是否同意。`description` 的 20000 码点上限是否同意。
14. **R13 与计划的冲突（已裁，本题不再有待答部分）**：计划写清单 CRUD；R13 于 2026-10-07 裁定只归档不删，本件不提供删除。
15. **任务 D 的 Draft #6186**：PR-3a 带着任务 D 的全部文件（§13 S0）。#6186 拟按「被本 PR 取代」关闭，请点名。
16. **R12(a) 的收窄、创建人支路与成员增删（已裁，本题不再有待答部分）**（`[own-25]`、`[own-53]`，§3.4、§6.3）：
    - **(a1)**：把任务加入清单，任务端要求调用者对任务有直接角色带来的 `edit`（创建人或负责人）。owner 2026-10-07 裁定（R12 取本件的收窄版）。这一半是对 R12(a) 推荐值的收窄。
    - **(a2)**：任务创建人可以不经成员身份把自己的任务移出任一包含它的清单（四种失败逐字节同一个 404）；详情的 `listIds` 对创建人列出包含该任务的全部清单 id（只有 id，没有名字与成员）。owner 2026-10-07 裁定（同上）。这一半是给任务创建人的一项新能力，是对 R12(a) 推荐值的放宽，不是收窄；§3.0「清单路由第一道判定是成员身份」为它开了唯一的例外。
    - **增删负责人与关注人**：四条写要求调用者对任务有直接角色（创建人或负责人）；只有清单身份的调用者保留 PATCH、设父、切模式、完成与重启、评论。owner 2026-10-07 裁定（`[own-53]`）。
    - **配额**：单任务至多属于 10 张清单（D14，`[own-47]`），计数含已归档的清单与调用者不是成员的清单。
17. **所有者已离开 org 的清单**（§3.3）：所有权只能由所有者本人转让，又没有管理员旁路（R18）。现任所有者离开 org 之后，这张清单没有人能再转让所有权（`edit` 成员的其余能力不受影响）。本 PR 不解决，只在转让时校验目标在职（`[own-27]`），防止主动转进死角。需要您定：是否要有一条换所有者的路径（例如由清单创建人接手、或由 `tasks:admin` 做一次性移交），以及归哪个 PR。

---

## 13. 实现切片

顺序执行。每片结束时 `pnpm --filter @metasheet/core-backend type-check`、`test:unit`、`tasks-realdb` 清单里的全部文件（本地一次性库，`EXPECT_DB=1`、`TASKS_ENABLED=true`）都要绿；动到鉴权门的片另跑 `vitest --config vitest.tasks-auth.config.ts`；动到 `scripts/ops/` 的片另跑对应的 `node --test`。每片一个代理。路径省略前缀 `packages/core-backend/`；「登记三处」指 `vitest.config.ts` 的 exclude 字面量、`.github/workflows/tasks-realdb.yml` 的文件清单、文件顶部的 `assert-rbac-optional-off` import。生产码 mutant 只在一次性检出里跑（§10.1）。

### S0 基座（依赖：无）

- 从 M3 后端**当时的** HEAD 起新分支，合入任务 D **当时的** HEAD。不写代码。先重跑 `git merge-tree --write-tree` 确认无冲突、两边相对 main 的改动路径仍不相交；两个 SHA 与结果记进验证 MD（不回填本文抬头）。
- 验证：合并结果上 type-check、`test:unit`、`tasks-realdb` 七个文件、鉴权门全绿；门 20 harness 的扫描人口包含任务 D 的新模块。

### S1 迁移、id、夹具 helper（依赖：S0）

- 文件：`src/db/migrations/zzzz20261001090000_create_task_m4_tables.ts`（新；前缀实现当天重查；S10 改名为 `zzzz20261008090000_create_task_m4_tables.ts`，2026-10-09 重新定名为 `zzzz20261009130000_create_task_m4_tables.ts`，§2.1）；`src/services/task-ids-runtime.ts`；`tests/helpers/task-m4-fixtures.ts`（新）；`tests/integration/task-m4-schema.db.test.ts`（新，登记三处）；`tests/unit/task-ids-runtime.test.ts`；本设计文档入库（§14 只保留处置结论，不带私有路径与裁决包行号）。
- 测试：§10.2 全部形状格，含 §2.3 的 `down → up` 事务内回滚格及其「回滚确实发生」的后置格；前缀唯一性守卫；三集合枚举。在一次性库上手工跑 `up → down → up` 并记进验证 MD，作补充。

### S2 R04 角色解析与零负责人守卫（依赖：S1）

- 文件：`src/tasks/task-access.ts`（`taskOrgLiveClause`、`buildTaskByIdCondition`、`buildTaskInListCondition`、`canChangeCompletion`、过时注释）；`src/services/task-records.ts`（`getTask`（能力标志改用 `canChangeCompletion`）、`loadTask`、`assertRowAbility`、`loadVisibleChildren`、`completeTask` / `reopenTask` 的零负责人守卫、新 `loadActorListMemberships`）；`src/services/task-structure.ts`（`loadRoles`、`deleteTaskById`、`getParentCandidates`、`lockLiveTaskForShare`）；`tests/helpers/gate19-identities.ts`；`tests/integration/task-m4-list-roles.db.test.ts`（新，登记三处）；`tests/unit/task-access.test.ts`（含 `canChangeCompletion` 真值表）；`tests/unit/task-gate19-identities.test.ts`。
- 零负责人守卫必须在这一片：清单身份在这一片进入 `assertRowAbility`，守卫与它同片交付。
- 测试：`gate19m4` 25 格与 `any_role` 清单臂 mutant（负控 4）；§10.4 任务侧表中不依赖 PATCH 的全部格：详情、list-reader 完成 404、评论、list-editor 完成的 `any` / `all` 两格（夹具模式钉明）、零负责人完成与重启 404 且能力标志为 false、创建人完成零负责人任务的正控、删任务、被移出清单（SQL 删行）、第二租户·任务；负控 1 的「第二租户·任务」一半（跨 org 加入的一半在 S7）；负控 6（零负责人守卫）。M2 的门 19 抽取命令对 `i-m2` 仍然相等；既有 needle 与快照全绿。
- 清单、成员、清单项行用 SQL 直接播种，不依赖清单路由。

### S3 分页、设置、红点范围、部署耦合的登记（依赖：S2）

- 文件：`src/routes/tasks-http.ts`（新）、`src/routes/tasks-settings.ts`（新，`registerTaskSettingsRoutes`）、`src/routes/tasks.ts`（一行注册调用）；`src/services/task-records.ts`（`listTasks`、`listPending`、`countPending`，新 `countTasks`、`countPendingList`、`parseTaskPage`）；`src/services/task-user-settings.ts`（新）；`src/tasks/task-settings.ts`（追加）；`tests/integration/task-m4-paging-settings.db.test.ts`（新，登记三处）；`tests/unit/task-settings.test.ts`；`scripts/ops/staging-tasks-smoke.mjs` 与 `scripts/ops/staging-tasks-smoke.test.mjs`（preflight 加三张 M4 表与点名的失败信息，§9.2）；`scripts/ops/global-history-flag-manifest.mjs`（`TASKS_ENABLED` 条目：`danger` 调到 `medium`、`source` 改锚点、`purpose` 写明对 M4 迁移的依赖与 `/api/task-settings`；另两个前缀随 S5、S8 追加）。
- 这两处 ops 文件放在这一片，因为到 S3 为止任务路由已读 `task_list_items`、`task_list_members`（S2）与 `task_user_settings`（S3）三张表。
- 测试：分页合同（缺省、边界、各种非法形式、`total`、两页不重不漏、同 `updated_at` 的稳定次序、降级体不带 `total`、分页非法先于坏 `view`）；设置的读写与各 422；`badge_scope` 三值下的 `/pending-count`（`off` 不查 `tasks`）；M2 门 8 路由 mutant、门 19 两个探针、门 4 仍绿；门 13 的设置正控与负控（注释掉 `registerTaskSettingsRoutes(router)` 那一行后变 404，§10.7）；smoke 单测：缺任一张 M4 表时 preflight 以点名信息失败。

### S4 日期写入与 PATCH（依赖：S3）

- 文件：`src/tasks/task-edit.ts`（新；`planTaskDates` 含类型闸）；`src/services/task-patch.ts`（新）；`src/services/task-records.ts`（`createTask`、`getTask` 的新四键、`completeTask` / `reopenTask` 成功体的 `version`）；`src/routes/tasks.ts`（`PATCH /api/tasks/:id`、POST 新字段）；`tests/integration/task-m4-dates.db.test.ts`（新，登记三处）；`tests/integration/task-m4-list-roles.db.test.ts`（补三格 PATCH 能力格）；`tests/unit/task-edit.test.ts`（新）；`tests/unit/task-records-guards.test.ts`；既有断言四处（§5.4）。
- 测试：§10.5 的 422 格与 A 支（含两个生产码 mutant、翻转点等待）；§10.6 全部，含类型闸的单测与 HTTP 格（`''`、数字、布尔、数组、对象 ⇒ 422 `INVALID_DATE`，不是 500）。

### S5 清单核心（依赖：S4）

- 文件：`src/tasks/task-list-access.ts`（新；本片只含 `taskListOrgClause`、`buildTaskListScopeCondition`、`buildTaskListByIdCondition` 与排序键常量）；`src/tasks/task-lists.ts`（追加 `applyRenameList`）；`src/tasks/task-groups.ts`（追加 `TASK_DEFAULT_GROUP_NAME`，建清单要落默认组）；`src/services/task-list-records.ts`（新）；`src/routes/tasks-lists.ts`（新，`registerTaskListRoutes`）、`src/routes/tasks.ts`（一行注册调用）；`scripts/ops/global-history-flag-manifest.mjs`（`purpose` 追加 `/api/task-lists`）；`tests/integration/task-m4-lists.db.test.ts`（新，登记三处）；`tests/unit/task-list-access.test.ts`（新）、`tests/unit/task-lists.test.ts`。
- 测试：建清单同事务产生所有者行、默认组、`created` 事件；查、列（`includeArchived`）、改名、归档与取消归档的能力格与空操作；`read` 成员改名 / 归档 / 取消归档 404；动态分页；第二租户·清单格与负控 2；归档格与负控 3；门 13 的清单正控与负控（注释掉 `registerTaskListRoutes(router)` 那一行后变 404）。

### S6 成员与转让（依赖：S5）

- 文件：`src/tasks/task-lists.ts`（追加 `canRemoveListMember`）；`src/services/task-org-members.ts`（新）；`src/services/task-list-records.ts`；`src/routes/tasks-lists.ts`；`tests/integration/task-m4-list-members.db.test.ts`（新，登记三处）；`tests/unit/task-lists.test.ts`（`canRemoveListMember` 真值表，`role: 'none'` 时恒假）。
- 测试：§10.4 清单侧表里成员相关的全部格：同 org 非成员对自己 `DELETE` 得 404（体与不存在的清单逐字节相同、无事件、无成员 id）；被移出的前成员同上；`read` 成员删别人 404；`read` 成员对成员增 / 改 / 转让 404；`edit` 成员传 `role: 'owner'` 得 422 `INVALID_ROLE` 且仍恰一行 `owner`；`edit` 成员把创建人降为 `read` 后创建人仍能归档；创建人不可移除；所有者先转让；转让先降后升、非所有者 404、目标非成员 422；转让给已停用成员 422；本人退出正控；上限 100；R17 加成员三格；经路由移出后详情 404。
- 在职 helper 在这一片只接清单成员与转让。

### S7 清单项（依赖：S6）

- 文件：`src/tasks/task-lists.ts`（追加 `canAddTaskToList`、`canRemoveTaskFromList`）；`src/services/task-list-records.ts`；`src/routes/tasks-lists.ts`；`src/services/task-records.ts`（`getTask` 的 `listIds`）；`tests/integration/task-m4-list-items.db.test.ts`（新，登记三处）；`tests/unit/task-lists.test.ts`（两个谓词的真值表；`canAddTaskToList` 的签名里没有传清单身份的位置）。
- 测试：§10.4 清单项表全部格：两端授权正反格；跨 org 加入格（负控 1 下读得到他 org 的任务，加入失败于组合外键 `task_list_items_task_fk`、500、零新行；与 §10.4 负控 1 一致）；只有清单身份的成员把任务加入自己建的清单得 404（a1）；负责人加入的清单由创建人移出（a2）；创建人支路的统一 404；`listIds` 的可见范围；双事件；单任务 10 个清单的上限；软删任务不出现在 `/items` 而行仍在；移出后仅有清单身份者详情 404；`read` 成员对清单项路由 404；`/items` 分页。

### S8 分组（依赖：S7）

- 文件：`src/tasks/task-groups.ts`（追加 `planGroupItemOrder`、`planGroupPositionsAfterDelete`）；`src/tasks/task-list-access.ts`（追加 `taskGroupOrgClause`、`buildTaskUserGroupScopeCondition`）；`src/services/task-group-records.ts`（新）；`src/routes/tasks-lists.ts`（两种 scope 的分组路由）；`scripts/ops/global-history-flag-manifest.mjs`（`purpose` 追加 `/api/task-groups`）；`tests/integration/task-m4-groups.db.test.ts`（新，登记三处）；`tests/unit/task-groups.test.ts`、`tests/unit/task-list-access.test.ts`。
- 测试：两种 scope 的建、改名、删（默认组不可删、删组后回默认组）；上限 50；至多一组；清单 scope 跨组写 `group_changed`，同组重排与个人 scope 不写事件；个人 scope 的 `GET` 不写库；§10.4 分组表全部格（可见集下标的软删残留与撤掉再重新指派两类、越界 422、空操作、分组位置连续、合成默认组、首次写落行、并发首次写）；`read` 成员对分组写路由 404；个人分组第二租户与负控 5。不为「静态段先于参数段」立格（§3.5：M4 没有相撞对）。
- 实现记录（S8）：服务文件之外，`task-list-access.ts` 多了 `buildTaskListGroupScopeCondition`（清单 scope 的分组也走单点 org 子句），`task-groups.ts` 多了四个纯函数（§4.1），`task-list-records.ts` 导出四个共用件；`tests/helpers/tasks-http-harness.ts` 的客户端补 `put`，`whileStructureLockHeld` 可以等多个排队的请求（并发首次写格用）。清单 scope 的可见集残留除了软删任务，测试里另用 SQL 播了一行「任务已不在清单里」的分组项（经路由移出清单会同事务删掉它，所以这一行用 SQL 播种），用来证明可见集过滤确实由 `buildTaskInListCondition` 给出。负控 5 在文件内以 `runSourceMutant` 跑（子进程只读、只做同名改名的空操作）。

### S6+S7 闸修复（依赖：S8；排在 S9 之前）

- 起因：S6+S7 增量闸审（9 条，8 条成立）与 owner 2026-10-07 的两项裁定（R12 与 `[own-53]` 的成员增删）。
- 文件：`src/tasks/task-access.ts`（`canChangeTaskMembers`）；`src/services/task-structure.ts`（私有 `loadMembersForChange`，四条写改走它）；`src/services/task-records.ts`（`getTask` 的 `canManageMembers`）；`tests/integration/task-m4-list-roles.db.test.ts`、`task-m4-list-items.db.test.ts`、`task-m4-list-members.db.test.ts`、`task-p0a.db.test.ts`；`tests/unit/task-access.test.ts`、`tests/unit/task-records-guards.test.ts`；本设计与验证 MD。
- 测试：§10.12 全部格；四条写的调用点、谓词、详情标志、判定顺序、`leave`、清单成员写与清单项移出的行谓词、`listIds` 的角色、已归档清单的成员路由各有变异，逐个变红（验证 MD「S6+S7 闸修复」）。
- 不新增路由、表、迁移、flag；`M4_ROUTES`（S10）不变。

### S9 R17 / N2 回填（依赖：S6、S8；必做：owner 2026-10-07 裁定）

- 增负责人、增关注人的在职查询放在直接角色判定（`canChangeTaskMembers`，`[own-53]`）与成员 id 校验之后：没有直接角色的调用者先得到 404，不触发在职查询（§4.6）。
- 逻辑上只依赖 S6（在职 helper）；执行上排在 S8 之后，因为它与 S7 同改 `task-records.ts`（S7 改 `getTask`，S9 改 `createTask`），又改七份既有真库文件，不能与 S7 / S8 并行。
- 文件：`src/services/task-records.ts`（`createTask`）；`src/services/task-structure.ts`（`addAssignee`、`addFollower`）；`src/services/task-org-members.ts`（只改模块注释）；`tests/integration/task-m4-org-members.db.test.ts`（新，登记三处）；`tests/helpers/task-m4-fixtures.ts`（`orgMemberSeeds`）；需要种子的既有真库文件（M2/M3 七份里的六份，`task-m3-tree` 不需要）与 `tests/tasks-auth/tasks-auth-gate.ts`；§4.6 点名的 M4 文件里的格（`task-m4-list-roles`、`task-m4-paging-settings`、`task-m4-dates`）；`tests/unit/task-records-guards.test.ts`。
- 测试：§10.1 `task-m4-org-members` 一行的全部格；`task-records-guards` 里三个写入点的语句顺序（锁之后、成员行之后、第一条 `INSERT` 之前，只带创建人以外的 id）与五条不查的路径；M2/M3 全部既有格在补种子后仍绿。
- 实现记录（S9）：创建的在职查询排在读创建人缺省提醒策略之前（§4.6 表）；两个 M3 写入点的查询放在纯函数「事件非空」的分支里、`INSERT` 之前。哪些既有格要补种子以「代码先上、不补种子」的一遍 lane 为准（§4.6 夹具后果），两格本意是「被写入的人不在职」，改用 SQL 写那一行负责人。「不查在职」由新文件在库里观测（对 `user_orgs` 持 ACCESS EXCLUSIVE，看 `pg_locks` 里有没有排队），不靠推断。变异 26 个，见验证 MD「S9」一节。

### S10 鉴权门与收口（依赖：S4、S8、S9）

- S10 排在 S9 之后，是因为 S9 也改 `tasks-auth-gate.ts` 的夹具。
- 文件：`tests/tasks-auth/tasks-auth-gate.ts`（P0-A 8 条的字面量表、`M4_ROUTES`、路由人口格、清单第二租户读格及其清单 org 谓词 mutant、门 1 缺 org 格、门 2 / 16 三件事）；迁移改名（SCH-4，§2.1：`src/db/migrations/zzzz20261008090000_create_task_m4_tables.ts`、形状测试的 import、manifest 的 `purpose`；2026-10-09 重新定名为 `zzzz20261009130000_create_task_m4_tables.ts`，§2.1）；代码注释里已裁条目的标签；验证 MD（新：S0 的两个 SHA 与 merge-tree 结果、各文件收集数与展开数、一次性库 `up → down → up` 记录、未在 CI 触发的 lane 的本地结果）；PR body。
- 测试：门 1、门 2 / 16 对 30 条新路由；路由人口格（8 + 13 + 30 = 51，含去掉一行即假的负控）；清单第二租户读格（trust-off，前置 a–i 逐条标注，正控先跑）；鉴权接线测试仍绿；全部 lane 在最终 head 上重跑并记收集数。

- 实现记录（S10）：鉴权门按 §10.7 补齐（实现记录见 §10.7 末尾），另加一格 `[own-53]` 在 trust-off 下的格；鉴权门 86 格。迁移改名后在一次性库上从空库全量迁移 426 条，本迁移最后执行；`--rollback` 回退的正是它，再迁移后目录快照逐字节相同；删掉文件后的 corrupted 报错以新名复测（§9.2）。已裁条目的代码标签改为 `RULED(2026-10-07)`，混有未裁标签的注释两种标记并存（§11）。公开文本的清理：去掉本机路径与私有原文的引用，文中只陈述规则（验证 MD「S10」一节）。

收口时 PR body 必须写到的几件事：首段声明未应用、未合并、迁移不自动应用，`down()` 由 `task-m4-schema` 的事务内格在 lane 里验证、一次性库手工记录作补充（门 14）；紧接着写「合并后所有线的 staging deploy 都会在换上新镜像之后、于迁移对齐门处失败，直到 owner 二选一：授权 `action=migrate`，或排除本迁移并保持 `tasks_enabled=false`；在此之前含本迁移的镜像只能以 `tasks_enabled=false` 部署」（§9.2）；回退三层按 §9.2 的可执行性写（已应用本迁移的环境不能删迁移文件；`down()` 只在本迁移是最近执行的一条时可经 `--rollback` 执行）；任务相关表没有计入 DML 普查的分母（R21）；门 8 的边界六格留在纯函数层；每个新真库文件的收集数与展开数（门 17）；哪些 lane 没有在这个 PR 上触发、本地跑的结果在哪；R01 的新子集行尚未入锁、未计分；R17 / N2 随本 PR（S9，owner 2026-10-07 裁定），发送时的复核在 PR-3b。PR body 公开可读，只写本 PR 的内容与已裁事项。

---

## 14. 评审处置（修订 1）

三个视角（合规 C、授权与并发 AZ、迁移与 CI MIG）共 25 条，逐条核实，全部属实，没有驳回。「已改」= 正文已按发现改写；「待 owner」= 正文带缺省值交付，缺省值需 owner 确认（给出 §12 题号）。本表只列处置结论与改动位置。

| id | 处置 | 位置 |
|---|---|---|
| C1 | 已改（同 AZ-1） | §3.0、§3.3、§4.1（`canRemoveListMember`）、§10.4 |
| C2 | 已改（同 AZ-3） | §6.3（`canChangeCompletion`）、§10.4、§13 S2 |
| C3 | 已改；存储层取舍待 owner（§12-Q7） | §3.5、§11 `[R11]` `[own-24]`、§10.4 |
| C4 | 已改 | §10.0、§10.7、§11 `[R01]`、§12-Q6 |
| C5 | 已改 | §10.7、§3.5、§13 S3 / S5 / S8 |
| C6 | 已改；偏离待 owner（§12-Q9） | §2.2、§11 `[dev-01]` `[own-03]` |
| C7 | 已改 | §5.1、§10.6 |
| C8 | 已改 | §4.3、§10.4、§4.1（`taskGroupOrgClause`） |
| C9 | 已改（同 AZ-4、AZ-5、MIG-2） | §3.5、§4.1、§10.4 |
| C10 | 已改（同 MIG-8） | 抬头、§13 S0、验证 MD |
| AZ-1 | 已改（同 C1） | §3.3、§4.3 |
| AZ-2 | 已裁（2026-10-07，§12-Q16） | §3.0、§3.4、§5.5、§11 `[own-25]`、§10.4 |
| AZ-3 | 已改（同 C2） | 见 C2 |
| AZ-4 | 已改（同 C9、MIG-2） | §3.5、§10.4 |
| AZ-5 | 已改（同 C9） | §3.5、§4.1（`planGroupPositionsAfterDelete`）、§10.4 |
| AZ-6 | 部分已改（`[own-27]`）；剩余待 owner（§12-Q17） | §3.3、§4.6、§10.4 |
| AZ-7 | 已改 | §10.4 |
| MIG-1 | 已改；二选一待 owner（§12-Q10） | §9.2、§12-Q10、§13 S3 |
| MIG-2 | 已改（同 C9、AZ-4），残留行保留而不删 | §3.5、§10.4 |
| MIG-3 | 已改；谓词待 owner（§12-Q11） | §2.2、§11 `[own-26]` |
| MIG-4 | 已改 | §9.2、§11 `[own-28]`、§13 S3 / S5 / S8 |
| MIG-5 | 已改 | §3.0、§10.7 |
| MIG-6 | 已改 | §2.3、§9.3、§10.2 |
| MIG-7 | 已改 | §4.6、§13 S9 / S10 |
| MIG-8 | 已改（同 C10） | 见 C10 |

修订后对切片计划的复核：每一条新格都落在它所依赖的路由首次出现的那一片；§10.1 的文件表与 §13 的文件清单一一对应；S9 被去掉时 S10 直接接 S8，其余依赖不变。（修订 5 注：R17、N2 已裁定采纳，S9 是必做片，「S9 被去掉」的情形不再存在。）
