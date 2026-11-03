# 任务功能 M4 后端 PR-3a 验证记录（2026-09-30）

- 设计：`docs/development/task-m4-pr3a-backend-design-20260930.md`（DRAFT）。锁：`docs/development/task-feature-design-lock-20260917.md`。
- 分支：`claude/tasks-m4-pr3a`。不推送、不开 PR、不合并、不应用 DDL 到任何共享库，不打开 `TASKS_ENABLED`。M4 裁决包已于 2026-10-07 由 owner 裁定（S0–S8 各节写于裁定之前）；本文只按条目 id 与日期引用裁定。
- 本文件按切片追加。当前覆盖 S0（基座）、S1（迁移、id、夹具 helper、形状测试）、S2（R04 角色解析与零负责人守卫）、S3（分页、设置、红点范围、部署耦合的登记）、M3 第三轮修复的合并记录（`6a055bf64f`）、S4（日期写入与 PATCH）、S5（清单核心）、S1–S4 闸审的修复切片、S6（成员与转让）、S5 闸修复、S7（清单项）、S8（分组）、S6+S7 闸修复（含 owner 2026-10-07 的成员增删裁定）、S9（R17 / N2 回填，owner 2026-10-07 裁定）与 S10（鉴权门与收口）；之后是 S0–S10 的总结，文末追记 2026-10-09 的迁移重新定名与门 15，以及同日重建为 main 上单个提交的一节。

## 0. 本地环境

- PostgreSQL **15.17**（Homebrew，`127.0.0.1`，用户 `postgres`）。CI 的 `tasks-realdb` 用 postgres:16；PG14（plugin-tests）与 postgres:15-alpine（migration-prod-image-parity）本地没有，见 §S1.9。
- Node 20.20.2（nvm 安装）。`pnpm` 未用：`node_modules` 是指向 M3 worktree 的符号链接，按指令不跑 `pnpm install`。
- 一次性库只用 `m4a_*` 前缀：`m4a_lane`（lane、变异、手工 up/down/up）、`m4a_restore`（pg_restore 验证）。两者在工作结束时均已 `DROP DATABASE`。

## S0 基座

| 项 | 值 |
|---|---|
| M3 后端源 HEAD | `9015f9eec0278e35ba5bddc1fd3ce4d25c7f5379`（`claude/tasks-m3-backend`） |
| 任务 D 源 HEAD | `50feb0d01b795b24fb66d771e22b8cad310eff92`（`claude/tasks-d-pure`） |
| 合并提交 | `b66980e2cf2e396aeca751883eb9a6285d998a8a`（父：上面两个） |
| 共同基点 | main `4f19aa0b91236cf8c4fa9f081a0fdbbba239242b` |
| 相对基点的改动文件 | M3 后端 19、任务 D 19，路径交集 0 |
| `git merge-tree --write-tree 9015f9eec0 50feb0d01b` | 无冲突，树 `d93f279e35…`，与合并提交的树相同 |
| `tsc --noEmit -p .`（`packages/core-backend`，合并提交上、S1 动手前） | 0 errors |

设计抬头写作时观测到的任务 D HEAD 是 `1193f0c0d7`；S0 动手时任务 D 已前进到 `50feb0d01b`，以后者为准。`git log 1193f0c0d7..50feb0d01b` 只有一条提交（`50feb0d01b`），`git diff --stat` 为 2 个文件、4 增 4 删：任务 D 设计文档与 `src/tasks/task-reminders.ts`，后者的改动是一段 `ASSUMPTION(task-d)` 注释的措辞，没有代码行变化。

S0 没有单独在合并提交上跑单测与真库 lane；这两项在 S1 的工作树上跑（§S1.4、§S1.5），其中 M2/M3 的七个既有真库文件与鉴权门均绿，门 20 harness（`tests/unit/task-pure-no-io.test.ts`）在单测全量里绿。

## S1 迁移、id、夹具 helper、形状测试

### S1.1 交付内容

| 文件 | 内容 |
|---|---|
| `packages/core-backend/src/db/migrations/zzzz20261001090000_create_task_m4_tables.ts`（新） | `tasks.remind_at` + `idx_tsk_remind`；八张表 `task_lists`、`task_list_members`、`task_list_items`、`task_groups`、`task_group_items`、`task_list_events`、`task_user_settings`、`task_notification_deliveries`，逐项照设计 §2.2（列、CHECK、外键全部 `ON DELETE CASCADE`、`uq_tlsm_owner`、`idx_tski_task`、`uq_tgrp_*_default`、outbox 一唯一加三非唯一索引，另五条 `[own-23]` 索引）；`down()` 严格逆序（§2.3）。头注 `Draft migration: do not apply from this PR`。不插行、不改 `permissions`。 |
| `packages/core-backend/src/services/task-ids-runtime.ts` | `newTaskListId`（`tlst_`）、`newTaskGroupId`（`tgrp_`）、`newTaskListEventId`（`tlev_`） |
| `packages/core-backend/tests/unit/task-ids-runtime.test.ts` | 三个生成器的前缀、四合取合法性（`.each` 3 行）与重复调用不重复 |
| `packages/core-backend/tests/helpers/task-m4-fixtures.ts`（新） | `seedTaskActor`、`seedOrgMembers`、`dropTaskM4Fixtures`、`runSourceMutant`（另导出 `signTaskToken`、`ensureTaskPermissions`） |
| `packages/core-backend/tests/integration/task-m4-schema.db.test.ts`（新） | 设计 §10.2 全部形状格与 §2.3 的事务内 `down → up` 格，见 §S1.3 |
| `packages/core-backend/vitest.config.ts` | exclude 加一条裸字面量 `'tests/integration/task-m4-schema.db.test.ts'`（无注释） |
| `.github/workflows/tasks-realdb.yml` | lane 文件清单追加同一文件 |
| `docs/development/task-m4-pr3a-backend-design-20260930.md`（新） | 设计入库；抬头加 DRAFT 声明；裁决包字面扫描退出 0 |

`ASSUMPTION(task-m4)` 标签在迁移里的分布：`[R03]`（`remind_at`）、`[R06]` `[own-26]`（`idx_tsk_remind` 谓词）、`[own-22]`（单文件）、`[dev-01]`（无 `owner_id` 列，注释写明偏离锁 §13-15）、`[own-03]`（`icon`）、`[R12]`、`[own-23]`、`[R11]` `[R23]`、`[R02]`、`[R07]`、`[D1]` `[R23]`、`[R13]`、`[R14]`；`task-ids-runtime.ts` 的两个新生成器标 `[R23]`。

### S1.2 迁移名与排序

- 取名 `zzzz20261001090000_create_task_m4_tables`（设计 §2.1 的建议名，实现当天重查仍可用）。
- `origin/main`（`cffd5dacbc`，2026-09-30 19:30）上 `src/db/migrations` 按 `LC_ALL=C` 排序的最后一条是 `zzzz20260927121000_add_multitable_install_ledger_intent_kind.ts`；本分支上最后两条是 `zzzz20260930090000_create_task_comments.ts` 与本迁移。本迁移的完整文件名排在 P0-A（`zzzz20260926120000_…`，本迁移 `ALTER TABLE tasks` 并外键指向 `tasks(id)`）与 M3 评论迁移之后。
- 前缀 `zzzz20261001090000` 在磁盘上唯一；`migration-timestamp-uniqueness.guard.test.ts` 20/20 绿。
- 没有把本迁移加进任何 `MIGRATION_EXCLUDE`，也没有加进 `scripts/ops/attendance-window-runner-pipeline.lib.sh` 的 `STAGING_OWNER_EXCLUDED_MIGRATIONS` / `STAGING_OWNER_EXCLUDED_TABLES`（设计 §12-Q10 是 owner 的二选一）。
- 从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项）：**422 条 executed successfully**，最后三条依次是 `zzzz20260927121000_…`、`zzzz20260930090000_create_task_comments`、`zzzz20261001090000_create_task_m4_tables`（M3 验证记录的 421 条加本条）。

### S1.3 形状测试 `task-m4-schema.db.test.ts`

文件顶部先 `import '../helpers/assert-rbac-optional-off'`，再是 `EXPECT_DB !== '1'` 即抛的哨兵。org 前缀 `org_tasks_m4schema_`，`afterAll` 用 `dropTaskM4Fixtures` 清理（跑完查过：八张新表与 `tasks` 均零残留行，`pg_depend` 正控的探针表与函数不存在，见 §S1.4 末）。不启动 `MetaSheetServer`。

| 组 | 格数 | 内容 |
|---|---|---|
| catalog pins | 6 | 八表与 `remind_at` 存在；列集（名、`format_type`、非空、缺省表达式）**整体相等**；约束集（名 → `pg_get_constraintdef`）整体相等；索引集（名 → `indexdef`）整体相等（含 `idx_tski_task`、`idx_tsk_remind`、outbox 四条）；7 条外键的目标、`confdeltype = 'c'`、不可延迟；`pg_depend` 断言八表的约束与列缺省不依赖 `pg_catalog` 之外的函数，同格正控：事务内建一个 `public` 函数与调用它的 CHECK，同一查询必须查到它，然后回滚 |
| outbox | 5 | 缺 `org_id` 23502；`observer` 23514；`outcome_unknown` 可插入与各缺省值（uuid、`pending`、0、false、`{}`）；同 `(org_id, source_key)` 23505、他 org 可复用；`delivered_at` 要求 `sent`、`attempt_count` 非负 |
| 清单成员 | 2 | 同清单第二个 `owner` 23505（`uq_tlsm_owner`）；`admin` 23514 |
| 分组 | 5 | 清单第二个默认组 23505；同 `(org_id, user_id)` 第二个个人默认组 23505、他 org 可建；`list` 缺 `list_id` 23514；`user` 带 `list_id` 23514；分组与分组项负位置 23514 |
| 设置 | 3 | `all_open` 23514；开每日提醒缺时区 23514、带时区可插；缺省 `overdue` / false / `{"mode":"default"}` |
| 清单事件 | 1 + 15 | 闭集外的词 23514；15 个词逐个可插入（`.each` 15 行） |
| 生成 id | 9 + 1 | `tlst` / `tgrp` / `tlev` × 前导 `_` / 尾随 `_` / `__` 各 23514（`.each` 9 行）；org / 人员列含空格 23514 |
| 名字 | 1 | `''` 与全空格 23514（清单与分组）；`备料复核` 可插入 |
| 级联与软删 | 4 | 只写 `deleted_at` 后清单项、分组项仍在；删任务行后两者消失；`DELETE FROM tasks WHERE org_id = …` 在有清单项时不报错；删清单级联成员、清单项、清单 scope 分组（及其分组项）、清单事件，任务行保留 |
| down → up | 2 | 专用 `pg.Pool({ max: 1 })` + Kysely，同一事务：快照 → `down(trx)` → 断言八表 `to_regclass` 为空、`remind_at` 与 `idx_tsk_remind` 不存在、`tasks` 仍在 → `up(trx)` → 列（不比列号）、约束、索引三份快照与之前相等 → 抛哨兵回滚；后一格在回滚后经连接池再查八表、`remind_at`、`idx_tsk_remind` 仍在 |

静态展开数：6 + 5 + 2 + 5 + 3 + (1 + 15) + (9 + 1) + 1 + 4 + 2 = **54**；verbose 日志收集并通过 54（门 17 ②）。

pin 的文本取自真库目录的规范化输出，再逐行对照设计 §2.2 手工核过（列、默认值、CHECK、外键、索引谓词均与设计一致；设计里的 `IN (…)` 在目录里规范化为 `= ANY (ARRAY[…])`，`'{"mode":"default"}'` 规范化为 `'{"mode": "default"}'`）。

### S1.4 命令与结果

所有命令在 `packages/core-backend` 下，`PATH` 前置 Node 20.20.2。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | **0 errors**（`tsconfig.json` 不含 `tests/**`） |
| 新测试文件的类型 | 临时 tsconfig（扩展包内 tsconfig，`include` 只列 `task-m4-fixtures.ts`、`task-m4-schema.db.test.ts`、`task-ids-runtime.test.ts`，`module: esnext`） | 0 errors；临时配置不入库 |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 1067 passed \| 173 skipped (1240)；Tests 18013 passed \| 1665 skipped (19678)；0 failed**。其中 `task-ids-runtime` 8/8、`migration-timestamp-uniqueness.guard` 20/20、`task-ci-coverage-enumeration` 4/4、`tasks-auth-ci-wiring` 2/2、`task-pure-no-io` 5/5、`migrations.rollback` 10/10 |
| 真库 lane × 3 | 见下 | 三遍均 **Test Files 8 passed；Tests 209 passed；0 failed** |
| 鉴权门 | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts --reporter=verbose` | 22/22（本片未改该文件） |
| 两个 recovery 守卫（`multitable-recovery-schema-drift.yml` 在 PR 上会跑） | `vitest --config vitest.integration.config.ts run tests/integration/recovery-schema-drift.db.test.ts tests/integration/recovery-authority-search-path.db.test.ts --reporter=verbose` | 2 files，14/14 |
| ops 脚本测试 | `node --test scripts/ops/attendance-window-runner-pipeline.test.mjs scripts/ops/staging-tasks-smoke.test.mjs scripts/ops/tasks-auth-ci-wiring.test.mjs`（仓库根） | 196/196 |
| 设计与改动文件的裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫设计、本文件与 S1 全部新增 / 改动文件 | 全部退出 0 |

全量单测第一遍是 **48 个文件失败**，原因全部是 `plugins/*/index.cjs` 解析不到 `zod`（46）或 `pg`（2）：本 worktree 只链接了根与 `packages/core-backend` 的 `node_modules`，`plugins/*/node_modules` 没有链接。照 M3 worktree 的做法给六个插件目录补了同样指向的符号链接（`node_modules` 被 git 忽略，不进提交）后重跑，即上表的 0 failed。失败与 S1 的改动无关。

真库 lane 的命令（与 `tasks-realdb.yml` 一致，只是库名不同；三遍相同）：

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/m4a_lane \
EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true \
./node_modules/.bin/vitest --config vitest.integration.config.ts run \
  tests/integration/task-p0a.db.test.ts \
  tests/integration/task-read-path.db.test.ts \
  tests/integration/task-completion-grid.db.test.ts \
  tests/integration/task-rbac-trust.db.test.ts \
  tests/integration/task-m3-tree.db.test.ts \
  tests/integration/task-m3-membership.db.test.ts \
  tests/integration/task-m3-comments-deletion.db.test.ts \
  tests/integration/task-m4-schema.db.test.ts \
  --reporter=verbose
```

逐文件通过数（三遍相同）：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 17、m3-membership 31、m3-comments-deletion 14、**m4-schema 54**，合计 209。每遍约 12 秒。

**最终代码上的复跑**（`c61407885a`，即给测试 pin 加 `ASSUMPTION(task-m4)` 注释、把设计 §14 删到处置结论之后；改动只有注释与文档）：新建库 `m4a_final`，从空库全量迁移 422 条；8 文件真库 lane 一遍 **8 files / 209 passed**（m4-schema 54）；lane 跑完后查八张新表与 `tasks` 均 0 行，`pg_depend` 正控的探针表与函数 0 个；`tsc --noEmit -p .` 0 errors；新测试文件的临时 tsconfig 0 errors；全量单测 **1067 passed | 173 skipped (1240) 文件，18013 passed | 1665 skipped (19678) 用例，0 failed**；ops `node --test` 196/196。`m4a_final` 已删除。

### S1.5 迁移 `up → down → up`（一次性库，补充记录）

在 `m4a_lane` 上（全量迁移之后）：

1. 以设计 §2.3 的八表 + `remind_at` 为范围取目录快照（列 / 约束 / 索引，129 行），存为 `snap-up1`。
2. `tsx src/db/migrate.ts --rollback`：回滚的正是本迁移。之后同一快照查询 0 行；`to_regclass('public.task_lists')`、`to_regclass('public.idx_tsk_remind')` 为空，`tasks.remind_at` 不存在，`kysely_migration` 里没有本迁移的记录。
3. `tsx src/db/migrate.ts`：只执行本迁移一条。快照与 `snap-up1` 用 `cmp` 比较**逐字节相同**。

lane 里的事务内 `down → up` 格（§S1.3）在三遍 lane 与每个变异里都跑过。

### S1.6 pg_restore（`search_path` 置空）

`pg_dump -Fd -t 'public.task*'`（13 张任务表，含本迁移的八张）→ 新库 `m4a_restore` → `pg_restore -j 2 --exit-on-error`：退出 0。转储里有 `SELECT pg_catalog.set_config('search_path', '', false);`。恢复后两条名字非空 CHECK 的定义是 `CHECK ((btrim(name) <> ''::text))`；在 `SET search_path = ''` 的会话里插入全空格名字得到 `task_lists_name_nonblank_chk` 违例，插入 `备料复核` 成功。`m4a_restore` 已删除。

### S1.7 变异证明（形状测试）

做法：`cp` 备份迁移文件 → 按唯一 needle 改写 `up()` → 用 tsx 对 `m4a_lane` 执行（未改的）`down()` 再执行变异后的 `up()` → 跑 `task-m4-schema.db.test.ts` → `cp` 还原 → `cmp` 与备份比较 → 再执行一次原版 `down()` + `up()`。只改迁移文件，不碰其他 worktree。全部结束后 `git diff --quiet HEAD` 为真，库的目录快照与 `snap-up1` 逐字节相同，原版形状测试 54/54。

| # | 变异 | 形状测试 | 变红的格 | 还原 |
|---|---|---|---|---|
| M01 | 去掉 `idx_tski_task` | 1 failed / 53 | 索引集 pin | cmp 相同 |
| M02 | 去掉 `idx_tskn_reclaim` | 1 failed / 53 | 索引集 pin | cmp 相同 |
| M03 | `task_group_items_task_fk` 去掉 `ON DELETE CASCADE` | 4 failed / 50 | 约束集 pin；外键 CASCADE 格；删任务行格；按 org 删任务格 | cmp 相同 |
| M04 | `uq_tlsm_owner` 去掉 `WHERE role = 'owner'` | 2 failed / 52 | 索引集 pin；第二个 owner 格 | cmp 相同 |
| M05 | `badge_scope` 缺省 `'overdue'` → `'off'` | 3 failed / 51 | 列集 pin；设置缺省格；down → up 格（其事务内先对列 pin 断言） | cmp 相同 |
| M06 | outbox `status` 闭集去掉 `outcome_unknown` | 2 failed / 52 | 约束集 pin；`outcome_unknown` 可插入格 | cmp 相同 |
| M07 | `task_user_settings_daily_needs_tz_chk` 改成 `CHECK (true)` | 2 failed / 52 | 约束集 pin；每日提醒缺时区格 | cmp 相同 |
| M08 | `task_lists_id_generated_chk` 四合取 → 单合取 | 4 failed / 50 | 约束集 pin；`tlst` 三格 | cmp 相同 |
| M09 | `idx_tsk_remind` 去掉谓词 | 1 failed / 53 | 索引集 pin | cmp 相同 |
| M10 | outbox `org_id` 加 `DEFAULT 'default'` | 3 failed / 51 | 列集 pin；缺 `org_id` 23502 格；down → up 格 | cmp 相同 |
| M11 | 清单事件闭集去掉 `field_unbound` | 2 failed / 52 | 约束集 pin；`field_unbound` 可插入格 | cmp 相同 |
| M12 | `uq_tgrp_user_default` 键 `(org_id, user_id)` → `(user_id)` | 2 failed / 52 | 索引集 pin；个人默认组「他 org 可建」格 | cmp 相同 |
| M13 | `task_list_items_task_fk` 去掉 `ON DELETE CASCADE` | 4 failed / 50 | 约束集 pin；外键 CASCADE 格；删任务行格；按 org 删任务格 | cmp 相同 |
| M14 | `task_groups_scope_owner_chk` 放宽为只看 `scope` | 3 failed / 51 | 约束集 pin；`list` 缺 `list_id` 格；`user` 带 `list_id` 格 | cmp 相同 |
| M15 | `task_lists_name_nonblank_chk` 弱化为 `length(name) > 0` | 2 failed / 52 | 约束集 pin；空白名字格 | cmp 相同 |

15 个变异全部变红，且每个都至少有一个 pin 格或行为格变红，不只靠 `down → up` 格（后者比的是同一份代码前后两次的结果，对 `up()` 的变异本来不敏感；它只在 M05、M10 里因为事务内先对列 pin 断言而变红）。

`pg_depend` 格没有对迁移做变异（要让 CHECK 依赖一个 `public` 函数，得在迁移里先建函数），它的有效性由同格的正控证明（§S1.3）。

### S1.8 与设计的偏差

1. **`btrim` 写成 `pg_catalog.btrim(name)`**（只改拼写）。设计 §2.2 原写 `btrim(name)`（与 P0-A 相同）。开工指令要求 CHECK 不调用未限定函数；`btrim` 属于 `pg_catalog`，裸名在 pg_restore 的空 `search_path` 下本来也能解析（§S1.6 实测），但显式限定让这一点可以直接从源码读出。`pg_get_constraintdef` 对两种写法输出相同，pin 不受影响。设计 §2.2 的 SQL 与「说明」已同步改写。
2. 形状测试比设计 §10.2 多出的格：外键目标 / 级联 / 不可延迟一格；`pg_depend` 函数命名空间一格（含正控）；outbox 的 `delivered_at` / `attempt_count` 两条 CHECK；分组与分组项负位置；人员 / org 列含空格；删清单的级联。均是对设计里已有约束的补充断言，不改形状。
3. 夹具 helper 的 `seedTaskActor` 比设计 §10.1 列的签名多 `stamp` 与 `orgId` 两个必填参数、一个可选 `direct`、一个可选 `activeInOrg`（JWT 的 `tenantId` 与清理匹配都需要它们）；`seedOrgMembers` 多一个可选 `{ active }`；另导出 `signTaskToken`、`ensureTaskPermissions`。`dropTaskM4Fixtures` 拒绝长度小于 6 的 org 前缀。
4. 设计 §14 按 §13 S1 的要求删到只剩「id / 处置 / 位置」三列，去掉解释性文字；入库前查过，全文不含私有路径与裁决包行号。

### S1.9 NOT RUN

- PG14（`plugin-tests` 的 required lane）、postgres:16（`tasks-realdb` 的 CI 服务）、postgres:15-alpine（`migration-prod-image-parity`）：本地只有 PG15.17。迁移只用 PG13 起就有的语法（`gen_random_uuid()` 内建、部分索引、`jsonb`）。
- `migration-replay.yml`、`web-tests`、contracts：本片没有在 CI 上触发任何 lane（不推送）。
- `seedTaskActor`、`seedOrgMembers`、`runSourceMutant` 没有被任何已登记的测试文件调用（第一个调用方是 S2）。本片用一次性 tsx 脚本对 `m4a_lane` 各跑了一遍：播种后 users 3、user_orgs 3（其中 2 条 `is_active = false`）、user_roles 1、admission 1、user_permissions 1、roles 1、role_permissions 2，JWT 三段；`dropTaskM4Fixtures` 带 userIds / roleIds 后全部归零；`runSourceMutant` 对私有工件目录里的一个临时文件验证了成功子进程、失败子进程重抛、缺 needle 抛错三种情况，文件均逐字节还原。
- S0 合并提交本身没有单独跑单测与 lane（§S0）。
- 门 17 ② 的收集数只在本地 verbose 日志里核对；CI 日志要等推送后。
- 形状 pin 是 PostgreSQL 目录的规范化文本（`pg_get_constraintdef`、`indexdef`、缺省表达式），对大版本最敏感；本地只在 PG15.17 上核过，本机没有 PG16 也没有 docker。CI 的 postgres:16 首跑才是这些 pin 的真正检查。

### S1.10 给 S2 的交接

- 夹具：`import { seedTaskActor, seedOrgMembers, dropTaskM4Fixtures, runSourceMutant } from '../helpers/task-m4-fixtures'`。`seedTaskActor({ label, stamp, orgId, codes, admission, direct?, activeInOrg? })` 生成的 id 形如 `usr_<label>_<stamp>` / `role_<label>_<stamp>`；清理时把它们放进 `dropTaskM4Fixtures({ orgPrefix, userIds, roleIds })`。
- `runSourceMutant` 原地改写 `src` 下的文件；只在自己的 worktree 里跑。
- 新的真库文件照例「登记三处」：`vitest.config.ts` exclude 裸字面量、`tasks-realdb.yml` 清单、文件顶部 `assert-rbac-optional-off`。`task-ci-coverage-enumeration` 会逼这三处一致。
- `task-m4-schema` 的 `down → up` 格在一个事务里对 `tasks` 持排他锁直到回滚；lane 是逐文件串行，别的文件不受影响。S2 的新文件不要在 `afterAll` 之外留下打开的事务或连接。
- 本迁移只是建形状，M2/M3 代码还不读 `remind_at` 与八张新表；S2 起角色解析读 `task_list_items` / `task_list_members`，从那时起「开了 `TASKS_ENABLED` 的环境必须已应用本迁移」的耦合生效（设计 §9.2）。
- 形状 pin 是整体相等比较；后续切片若确需改形状，先改设计 §2.2，再同改迁移与 pin。
- 本 worktree 的 `plugins/*/node_modules` 是指向 M3 worktree 同一目标的符号链接（git 忽略）；没有它们，全量单测会有 48 个文件因找不到 `zod` / `pg` 失败。

## S2 R04 角色解析与零负责人守卫

基于 `d983c52bf7`（S1 + M3 后端第二轮修复 `8ceba48277` 合入之后）。本地一次性库只用 `m4b_*` 前缀：`m4b_lane`（lane、变异、门 19 抽取），`m4b_final`（最终 head 的复跑）。两者在工作结束时均已 `DROP DATABASE`。

### S2.1 交付内容

| 文件 | 内容 |
|---|---|
| `packages/core-backend/src/tasks/task-access.ts` | 私有 `taskOrgLiveClause()`：org 子句与 `deleted_at IS NULL` 在源码里只写这一次；`buildTaskScopeCondition` 改为 `${taskOrgLiveClause()} AND (${arm})`（输出逐字节不变，见 §S2.3）。新导出 `buildTaskByIdCondition`（`$1` 任务 id、`$2` org）、`buildTaskInListCondition`（`$1` 清单 id、`$2` org）、`canChangeCompletion(roles, ability, assigneeCount)`（`ability` 只收 `complete` / `reopen`，其余抛 `TypeError`）。「清单角色本期不会出现」那条过时的 `ASSUMPTION(task-b)` 注释改成现状（`[R04]`）。 |
| `packages/core-backend/src/services/task-records.ts` | 新 `loadActorListMemberships(db, taskIds, actorId)`（设计 §6.2 的那条批量查询，经任务 D 的 `toTaskListMemberships` 映射）；新 `loadRowRoles(db, …)`（一次解析负责人、关注人与清单身份，并返回负责人行）。`getTask`：`isPrintableId` → `buildTaskByIdCondition` 取行 → 负责人 / 关注人 / 清单身份 → `can(roles, 'view')` 为假即 404 → 之后才取 `children`；`canComplete` / `canReopen` 改由 `canChangeCompletion` 给出。`loadTask` 走 `buildTaskByIdCondition`。`loadVisibleChildren` 批量带清单身份。`assertRowAbility` 经 `loadRowRoles` 带清单身份，并对 `complete` / `reopen` 抛 `TypeError`（这两项只由 `canChangeCompletion` 判定，不留第二处判据）。`completeTask` / `reopenTask`：锁后一次读出角色与负责人行，`canChangeCompletion` 为假即 404，同一份负责人行再交给 `applyComplete` / `applyReopen`。 |
| `packages/core-backend/src/services/task-structure.ts` | `loadRoles` 改为经 `loadRowRoles`；`deleteTaskById` 用 `loadRoles`；`getParentCandidates` 的候选过滤批量带清单身份；`lockLiveTaskForComment`（`FOR KEY SHARE`）与 `lockTaskRowForDelete`（`FOR UPDATE`）的取行都走 `buildTaskByIdCondition`，锁模式、`SET LOCAL lock_timeout` 与复位、`55P03` → 409 `TASK_BUSY`、`isPrintableId` 前置全部原样保留。 |
| `packages/core-backend/tests/helpers/gate19-identities.ts` | `passedIdentities(text, { prefix })`、`lockIdentities(md, { fence, prefix })`，缺省 `'gate19\|'` / `'i-m2'`；抽取正则按前缀生成。CLI 多两个可选参数 `--fence=` `--prefix=`，不带时行为与原来相同（`[own-20]`）。 |
| `packages/core-backend/tests/integration/task-m4-list-roles.db.test.ts`（新） | 见 §S2.2。登记三处：`vitest.config.ts` exclude 裸字面量、`tasks-realdb.yml` 清单、文件顶部 `assert-rbac-optional-off`。 |
| `packages/core-backend/tests/unit/task-access.test.ts` | 两个新构造器的文本快照、org 子句恰一次、只用 `$1/$2`、与视角构造器共用同一段 org + 存活子句；`canChangeCompletion` 真值表（2 能力 × 10 身份 × 负责人数 0/1/3 = 60 格）、守卫所针对的 6 个钉死格、其余 6 个能力抛 `TypeError`。原有快照一字未改。 |
| `packages/core-backend/tests/unit/task-gate19-identities.test.ts` | 两个前缀互不串扰；按名字取 fence；设计文档 `i-m4` 块 = 新真库文件里的 25 个名字。 |
| `packages/core-backend/vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 各加一行新文件。 |

`ASSUMPTION(task-m4)` 标签：`[R04]`（`task-access.ts` 的清单身份注释与按 id 构造器、`getTask`、`loadActorListMemberships` 的归档不过滤、`loadRoles`、测试文件头）、`[own-01]`（绑定位）、`[own-02]`（`buildTaskInListCondition`）、`[own-20]`（`i-m4` 抽取）。零负责人守卫执行锁 §6.2，注释引锁，不标 ASSUMPTION（设计 §11 末段）。

### S2.2 `task-m4-list-roles.db.test.ts`

org 前缀 `org_tasks_m4roles_`（第二租户的 org B 也在这个前缀下）；参与者用 `seedTaskActor`，清单、成员、清单项用 SQL 直接播种（`newTaskListId()` 生成 id）；`afterAll` 用 `dropTaskM4Fixtures` 清理。跑完查过：该前缀下 `tasks`、`task_lists` 与种子用户均 0 行。HTTP 经 `tasksRouter()` 挂在 express 上（`setup.integration.ts`，`RBAC_TOKEN_TRUST='true'`）。凡期望 404 的格都与「同一路由、不存在的 id」的响应比 `response.text`，写格另比较任务行、负责人行、事件行的快照。

| 组 | 格数 | 内容 |
|---|---|---|
| `gate19m4\|<s>\|<v>` | 25 | 设计 §10.3 的 25 格，字面 `cells` 数组喂 `it.each`。每格独立 org 与参与者；夹具按锁 §6.1 的 ambient 钉法（创建人格只在 `delegated` / `any_role` 视角加另一个负责人，与 M2 网格同一条规则）。先断言 `taskMatchesView`（去掉清单身份的行）= 设计表的期望，再断言 `listTasks` 行集 = 期望；正控：`can(resolveTaskRoles(row, me, memberships), 'view')` 为真，且 `GET /api/tasks/:id` 200。 |
| 负控 4 | 1 | 给 `any_role` 的 `.join(' OR ')`（断言唯一）接一条清单臂；子进程判定 `list-reader\|any_role` 那一格变红。父进程先断言原码下的行集。 |
| `m4list\|` 任务侧 | 13 | list-reader：详情 200，能力标志恰为 view + comment；完成、切模式、加关注人各 404（与不存在的 id 同体、无写入）；评论 200、列评论 200。list-editor：`any` 模式（夹具钉 `completion_mode='any'`、另一人的未完成负责人行）完成 200 `done: true`、任务 `done`、负责人行盖章、事件恰为 `created` + `completed_by_any`（`actor_id` 是 list-editor）；`all` 模式、本人无负责人行，完成 200 `done: false`，快照不变；零负责人完成 404（非 500）、快照不变、详情 `canEdit` 真而 `canComplete` / `canReopen` 假；零负责人已完成任务的重启 404、仍 `done`、`canReopen` 假；删任务 404、快照不变；经 M3 路由切模式 200，加关注人 404（`[own-53]`）；父候选含同清单的任务（同 org 非成员对该路由 404）、设父 200、父任务详情的 `children` 含同清单子任务。创建人完成零负责人任务 200、事件 `created` + `completed`（正控）。成员行被 SQL 删掉后下一次详情即 404。同 org 非成员（任务所在清单另有 `edit` 与 `read` 成员）对详情、完成、发评论、列评论、删除各 404，与不存在的 id 同体、快照不变、`any_role` 为空。 |
| 第二租户·任务 + 负控 1（任务一半） | 1 | 清单与任务在 org B，调用者是该清单 `edit` 成员，token 为 org A：详情 404（与不存在的 id 同体）、完成 404、快照不变。然后用门 1 的 needle 把 `task-access.ts` 的 org 子句改成恒真（断言唯一），子进程经 HTTP 取同一详情，判定变红。 |
| 负控 6 | 1 | 把 `canChangeCompletion` 的 `(assigneeCount > 0 \|\| roles.includes('creator'))` 改成 `(true)`（断言唯一），子进程里 list-editor 对零负责人任务的完成与重启都变成 500；原码下两者都是 404。子进程之后两条任务的快照仍与之前相同（抛错使事务回滚）。 |

静态展开数：25 + 1 + 13 + 1 + 1 = **41**；verbose 日志收集并通过 41（门 17 ②）。

设计 §10.4 任务侧表里属于 S2 的格与本文件的对应：详情 / 完成 / 评论 / `any` / `all` / 零负责人完成与重启 / 创建人正控 / 删任务 / 被移出清单 / 第二租户·任务全部在上表。PATCH 三格（含 `[R08]` 的 follower + list-reader）随 S4；「任务被移出清单」随 S7（list-items）。

### S2.3 `task-access.ts` 的输出逐字节不变

- `task-access.test.ts` 里 `buildTaskScopeCondition` 五臂、`buildTaskPendingCondition` 三个 scope 的整句快照一字未改，改动后全绿；`task-reminders.test.ts` 的整句 pin（派生自 `view: 'assigned'`）同样全绿。
- 源码 needle 计数（改动后）：`(tasks.org_id = ${ORG_PLACEHOLDER}) AND ` 1 处（只在 `taskOrgLiveClause`）；`.join(' OR ')` 1 处；`(assigneeCount > 0 || roles.includes('creator'))` 1 处；`COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone)` 4 处（与改动前相同，S4 的门 8 负控二要全换）；`case 'assigned':` 2 处与 `assignee: {` 能力块未动（门 19 两个探针）。新注释里不含这些字面量。
- 鉴权门的门 1 org mutant（`tasks-auth-gate.ts`，改写同一个 needle）在改动后照常变红，鉴权门 23/23。
- MA1（手工）：把 `taskOrgLiveClause` 去掉 `AND tasks.deleted_at IS NULL`，`task-access` + `task-reminders` 单测 12 格变红（265 格中），还原后 `cmp` 相同。

### S2.4 M2 / M3 行为不变的论证

`canChangeCompletion` 与 `can(roles, ability)` 只在「负责人数为 0、角色集不含 creator、但角色集有 `complete` / `reopen`」时不同。M4 之前角色集只含 creator / assignee / follower：有 assignee 就有负责人行，follower 没有这两项能力，所以这个组合只可能来自 list-editor。清单身份只来自 `task_list_items` × `task_list_members`，M2/M3 的夹具从不写这两张表，所以 M2/M3 每一格的角色集与改动前相同；`getTask` 从「`any_role` 臂筛行」改为「按 id 取行再判 `view`」，对没有清单身份的调用者两者等价（`can(view)` = creator ∨ assignee ∨ follower = `any_role` 四臂之并）。经验核对：改动后、新文件加入前，既有 8 文件 lane **243/243**（p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 24、m3-membership 44、m3-comments-deletion 28、m4-schema 54），与 M3 第二轮修复后的基线同数同绿。

### S2.5 命令与结果

所有命令在 `packages/core-backend` 下，`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/m4b_lane EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`。`m4b_lane` 从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项）：422 条 executed successfully，最后一条是本 PR 的 M4 迁移。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | 0 errors |
| 新 / 改测试文件的类型 | 临时 tsconfig（扩展包内 tsconfig，`include` 只列 S2 改动的四个测试文件与 `task-m4-fixtures.ts`） | 0 errors；临时配置建在包目录下、跑完即删，不入库 |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 1067 passed | 173 skipped (1240)；Tests 18084 passed | 1665 skipped (19749)；0 failed**（改用规范检出的 `node_modules` 之后，见 §S2.7 第 6 条）。其中 `task-access`、`task-gate19-identities`、`task-records-guards`、`task-ci-coverage-enumeration`、`task-pure-no-io` 五个文件在此之前单独跑过一遍：226/226 |
| 真库 lane × 3（9 文件，`tasks-realdb.yml` 清单） | `vitest --config vitest.integration.config.ts run <9 files> --reporter=verbose` | 三遍均 **Test Files 9 passed；Tests 284 passed；0 failed**，每遍约 20 秒。逐文件：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 24、m3-membership 44、m3-comments-deletion 28、m4-schema 54、**m4-list-roles 41** |
| 鉴权门 | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts --reporter=verbose` | 23/23（本片未改该文件） |
| 门 19 M2 抽取 | `vitest run --config vitest.integration.config.ts --reporter=verbose -t 'gate19[\|]' tests/integration < /dev/null > g19-m2.txt`；`tsx tests/helpers/gate19-identities.ts g19-m2.txt ../../docs/development/task-feature-design-lock-20260917.md` | 49 passed；抽取「passed identities equal the i-m2 list」，退出 0（25 个 `gate19m4\|` 名字没有混入）。同一次运行里有 1 个文件在收集阶段失败：一个考勤真库文件要求 `ATTENDANCE_TEST_DATABASE_URL`，与任务无关，本地未设 |
| 门 19 M4 抽取（候选） | 同上，`-t 'gate19m4[\|]'`；`tsx tests/helpers/gate19-identities.ts g19-m4.txt ../../docs/development/task-m4-pr3a-backend-design-20260930.md --fence=i-m4 '--prefix=gate19m4\|'` | 25 passed；抽取「passed identities equal the i-m4 list」，退出 0。M2 那次运行的通过行里 `gate19m4|` 名字为 0 条 |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫 S2 新增 / 改动的全部文件与本文件 | 全部退出 0 |

**最终 head 上的复跑**（`420b9ed729`，即本片代码提交；之后只有本文件）：新建库 `m4b_final`，从空库全量迁移 422 条；9 文件真库 lane 一遍 **9 files / 284 passed**（m4-list-roles 41）；鉴权门 23/23；跑完查 `tasks`、`task_lists`、`task_list_members`、`task_list_items` 均 0 行。`m4b_final` 与 `m4b_lane` 已删除。

### S2.6 变异证明

在文件内（每遍 lane 都跑，`runSourceMutant`：断言 needle 唯一 → 备份 → 改写 → tsx 子进程 → 还原 → 断言逐字节相同）：

| # | 变异 | 结果 |
|---|---|---|
| 负控 1（任务一半） | `task-access.ts` 的 org 子句 → `(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ` | 第二租户·任务详情格变红 |
| 负控 4 | `any_role` 加清单臂 | `list-reader\|any_role` 格变红 |
| 负控 6 | `canChangeCompletion` 的零负责人合取 → `(true)` | 零负责人完成与重启 404 → 500 / 500 |

手工（脚本在私有工件目录：`cp` 备份 → 按唯一 needle 改写 → 跑 `task-m4-list-roles.db.test.ts`（41 格）→ `cp` 还原 → `cmp` 与备份比较；逐个串行，不与其他 vitest 进程并行）：

| # | 变异（文件） | 失败 / 41 | 变红的格 | 还原 |
|---|---|---|---|---|
| MS01 | `getTask` 不带清单身份（records） | 16 | 10 个只有清单身份的网格正控；list-reader 详情；零负责人两格（详情取不到）；树格；被移出清单格（前置 200 取不到）；第二租户格（其子进程的 200 也取不到） | cmp 相同 |
| MS02 | `getTask` 去掉 `can(view)` 判定（records） | 2 | 非成员格；被移出清单格 | cmp 相同 |
| MS03 | `loadVisibleChildren` 不带清单身份（records） | 1 | 树格（`children`） | cmp 相同 |
| MS04 | `loadRowRoles` 不带清单身份（records，共用） | 6 | `any` / `all` 两格；M3 编辑格；树格；list-reader 评论；负控 6 | cmp 相同 |
| MS05 | 只在 `assertRowAbility` 滤掉清单角色（records） | 3 | M3 编辑格；树格（父候选的 `edit` 前置）；list-reader 评论 | cmp 相同 |
| MS06 | 只在 `loadRoles` 滤掉清单角色（structure） | 1 | 树格（设父） | cmp 相同 |
| MS07 | `getParentCandidates` 候选过滤不带清单身份（structure） | 1 | 树格（候选不含同清单任务） | cmp 相同 |
| MS08 | 只在 `completeTask` 滤掉清单角色（records） | 3 | `any` / `all` 两格；负控 6 | cmp 相同 |
| MS09 | `completeTask` 守卫换成 `can(roles, 'complete')`（records） | 2 | 零负责人完成格（500）；负控 6（前置那一步） | cmp 相同 |
| MS10 | `reopenTask` 守卫换成 `can(roles, 'reopen')`（records） | 2 | 零负责人重启格（500）；负控 6 | cmp 相同 |
| MS11 | 详情 `canComplete` / `canReopen` 换成 `can()`（records） | 2 | 零负责人两格的能力标志 | cmp 相同 |
| MS12 | 清单身份查询去掉 `tlm.user_id = $2`（records） | 5 | 非成员格；list-reader 写格与详情格；被移出清单格；树格 | cmp 相同 |
| MS13 | 只在 `deleteTaskById` 滤掉清单角色（structure） | 0 | **等价变异**：清单角色没有 `delete`，滤掉与否角色集的 `delete` 结果相同；只记录，不算击杀 | cmp 相同 |
| MA1 | `taskOrgLiveClause` 去掉存活子句（access） | 单测 12 / 265 | `task-access` / `task-reminders` 的整句快照 | cmp 相同 |

全部结束后 `git status` 下 `src` 只有本片的改动，`.task-probe*` 与临时脚本无残留。

### S2.7 与设计的偏差

1. **按 id 取任务的站点是四处，不是三处。** 设计 §6.3 写「`getTask`、`loadTask`、`lockLiveTaskForShare`（片段后接 `FOR SHARE`）」。M3 第二轮修复之后，评论写的行锁是 `lockLiveTaskForComment`，锁模式是 `FOR KEY SHARE`；删除另有 `lockTaskRowForDelete`（`FOR UPDATE`）。两处都改走 `buildTaskByIdCondition`，锁模式与删除的超时、复位、`TASK_BUSY` 映射原样保留；没有写成 `FOR SHARE`（那会回退 M3R2-CONC-1）。M3 评论 / 删除的并发格（m3-comments-deletion 28 格）全绿。
2. **`assertRowAbility` 对 `complete` / `reopen` 抛 `TypeError`**，不是静默放行：设计 §6.3 写「对这两个能力不再单独判定」，这里把它变成可检查的约束，任何新调用方误用会立刻暴露。当前没有调用方传这两个能力。
3. **新增导出 `loadRowRoles`**（设计 §4.1 的服务清单里没有）：`assertRowAbility`、`loadRoles`、`completeTask` / `reopenTask` 共用它，使负责人行只在锁后读一次、角色解析只有一处。
4. **`buildTaskInListCondition` 只有单测快照**，没有调用方（第一个调用方是 S7 的清单项）。
5. 设计 §10.4 的「list-editor 编辑」在 S2 用 M3 路由（切模式、设父）表达；增删负责人与关注人对只有清单身份的成员是 404（`[own-53]`）；`PATCH /api/tasks/:id` 的三格随 S4。另加了设计表里没有的格：同 org 非成员的统一 404、父候选 / 设父 / `children` 的同清单格、list-reader 对 M3 写路由的 404。这些格是为了让六处角色解析各有一格在丢掉清单身份时变红（§S2.6）。
6. **本地依赖改用规范检出的 `node_modules`（环境，不是代码）。** 全量单测与 §S2.5 末的最终 head 复跑用的是指向本仓库规范检出下同名目录的符号链接（该检出的 `pnpm-lock.yaml` 与本分支只差一个空的 `plugins/plugin-elearning: {}` 导入项，依赖版本相同）；没有跑 `pnpm install`。
7. **404 写格的「两张事件表不变」只比较了 `task_events`。** 设计 §10.4 的前言要求期望 404 的写格同时断言目标表与两张事件表行数不变；本文件的快照不含 `task_list_events`。S2 的任务侧路由都不写清单表，这一半在本片恒成立、没有判别力；S5 起的清单文件带上它，S7 是第一个任务侧写路由可能碰到 `task_list_events` 的切片。

### S2.8 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG15.17（同 §S1.9）。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- 门 19 M2 抽取命令扫整个 `tests/integration`：一个考勤真库文件因缺 `ATTENDANCE_TEST_DATABASE_URL` 在收集阶段失败，与本片无关；任务相关的 49 格全部通过并与 `i-m2` 相等。
- `i-m4` 与 `gate19m4|` 前缀仍是候选、未入锁（设计 §12-Q1 (b)、Q6）；25 格不能算 `M4|19|清单角色` 已计分。
- 负控 1 的「跨 org 加入」一半、负控 2 / 3 / 5：分别随 S7、S5、S8。
- 没有为「按 id 走 `buildTaskByIdCondition`」本身单独做变异（把 `loadTask` 换成手写 SQL 是等价变异）；它的判别力由负控 1 证明：门 1 的单一 needle 改写后，按 id 的详情格同样变红。

### S2.9 给 S3 的交接

- 从本片起，任务路由读 `task_list_items` 与 `task_list_members`：开了 `TASKS_ENABLED` 的环境必须已应用 M4 迁移（设计 §9.2）。S3 的 smoke preflight 加三张表正是为此。
- 角色解析的唯一入口：单任务用 `loadRowRoles`（或 `task-structure.ts` 内部的 `loadRoles`），批量用 `loadActorListMemberships` + `resolveTaskRoles`。新代码不要再手写负责人 / 关注人查询后直接 `resolveTaskRoles(row, me)`，那会漏掉清单身份。
- 完成 / 重启只经 `canChangeCompletion`；`assertRowAbility` 对这两项会抛 `TypeError`。S4 给 complete / reopen 的成功体加 `version` 时，沿用 `completeTask` / `reopenTask` 里锁后已读出的 `task.version` 与 `rows`，不要再读一次负责人。
- `getTask` 的顺序是「按 id 取行 → 角色 → `view` → 其余」。S4 的新四键与 S7 的 `listIds` 加在组装阶段，不要提前到 `view` 判定之前。
- `listTasks` / `listPending` / `countPending` 仍用视角构造器，清单身份不进任何视角臂；S3 回填分页时不要把 `loadActorListMemberships` 接进列表路径。
- `task-access.ts` 的 needle 计数（§S2.3）是 S3 / S4 负控的前提：新代码与注释里不要再出现 org 子句、`.join(' OR ')`、零负责人合取、`COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone)` 的字面量。
- **依赖**：S3 动手前把 `node_modules` 符号链接指到规范检出下的同名目录（锁文件只差空的 `plugins/plugin-elearning` 导入项），或由 owner 另给一份依赖（§S2.7 第 6 条）。
- 设计 §4.1 与 §6.3 仍写 `lockLiveTaskForShare`、`FOR SHARE`、「三处」；以 §S2.7 第 1 条为准（四处，评论锁 `FOR KEY SHARE`，删除锁 `FOR UPDATE`），不要按设计原文改回 `FOR SHARE`。
- `task-m4-list-roles` 用 express + `tasksRouter()`，子进程变异脚本用父进程 `createRequire` 解析出的 `express` / `supertest` 绝对路径（`runSourceMutant` 把探针脚本写在系统临时目录，裸包名解析不到）。
- 门 19 的 M2 抽取扫整个 `tests/integration`，本地一遍约 6.5 分钟（大部分是收集）；只需要核 M4 名字时用 `-t 'gate19m4[|]'`。

## S3 分页、设置、红点范围、部署耦合的登记

基于 `492d98afa6`（S2 之后）。代码提交 `35900fe984`；随后一条跟进提交只改注释与本文件（`parseTaskPage` 注释点名 Q8、smoke 头注锚点），跟进后重跑了 type-check、两份相关单测与 smoke 单测。本地一次性库只用 `m4c_*` 前缀：`m4c_lane`（lane × 3、鉴权门、变异），`m4c_final`（最终 head 复跑）。两者在工作结束时均已 `DROP DATABASE`。`node_modules` 仍是指向 M3 worktree 的符号链接（其目标再指到规范检出），本片没有改动任何符号链接、没有跑 `pnpm install`。

### S3.1 交付内容

| 文件 | 内容 |
|---|---|
| `packages/core-backend/src/routes/tasks-http.ts`（新） | `actorId` / `orgId` / `sendError` 从 `tasks.ts` 原样搬出，供各任务路由文件共用。 |
| `packages/core-backend/src/routes/tasks-settings.ts`（新） | `registerTaskSettingsRoutes(router)`：`GET /api/task-settings`（read；缺 org 404 `NOT_FOUND`）与 `PATCH /api/task-settings`（write；缺 org 422 `ORG_MISSING`，先于读请求体）。直接注册到 `tasksRouter()` 的同一个 `router` 上。 |
| `packages/core-backend/src/routes/tasks.ts` | 改从 `tasks-http.ts` 引入三个 helper；`GET /api/tasks` 与 `/pending` 先降级缺 org，再 `parseTaskPage`（非法 422），再各自取列表与计数，回 `{ items, total }`；`GET /api/tasks` 仍是「分页先于 `view`」，坏 `view` 仍 200 `predicate_error`；`/pending-count` 的两行 needle（`const viewerTz = …` 与 `const count = await countPending(…)`）逐字节未动，其后一行改为 `count === null ? { count: 0, badgeScope: 'off' } : { count }`；`return router` 之前单独一行 `registerTaskSettingsRoutes(router)`（门 13 负控的改写点）。 |
| `packages/core-backend/src/services/task-records.ts` | 新 `parseTaskPage`（任务 D `parsePageParams` → `fail(422, reason.toUpperCase())`）；私有 `pageClause`（`ORDER BY ${TASK_PAGE_SORT_KEY} LIMIT $n OFFSET $n+1`，`n = cond.params.length + 1`）；`listTasks` / `listPending` 多一个可选 `page`（缺省即 `limit 100 offset 0`，等于原来的硬上限），仍返回数组；新 `countTasks`（同一视角条件）、`countPendingList`（恒 `all_open`，不读设置）；`countPending` 先读调用者的 `badge_scope`，经 `pendingScopeForBadge` 取 scope，`off` 直接返回 `null`、不查 `tasks`。清单身份没有进入任何列表或计数路径。 |
| `packages/core-backend/src/services/task-user-settings.ts`（新） | `loadBadgeScope`、`getTaskSettings`（只读，无行给缺省）、`patchTaskSettings`（请求体须是普通对象，否则 422 `INVALID_SETTINGS`；事务首句 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`，`INSERT … ON CONFLICT (user_id, org_id) DO NOTHING` 占位，`SELECT … FOR UPDATE`，`parseSettingsPatch` 合并，合并结果与现值相同则不 `UPDATE`）。不进 org 结构锁（`[own-04]`）。 |
| `packages/core-backend/src/tasks/task-settings.ts`（追加） | `TASK_DEFAULT_USER_SETTINGS`（深冻结）、`TaskUserSettingsRow`、`toTaskUserSettings(row \| undefined)`：无行给缺省值的新副本；有行时逐列按与 PATCH 相同的闭集校验，库里出现闭集外的值抛 `TypeError`（fail closed）。 |
| `packages/core-backend/tests/integration/task-m4-paging-settings.db.test.ts`（新） | 见 §S3.2。登记三处：`vitest.config.ts` exclude 裸字面量、`tasks-realdb.yml` 清单、文件顶部 `assert-rbac-optional-off`。 |
| `packages/core-backend/tests/unit/task-settings.test.ts` | 缺省值与冻结、`undefined` 给新副本（改副本不影响缺省）、行映射、8 种库内非法值抛 `TypeError`、非对象行抛 `TypeError`，共 12 格。 |
| `packages/core-backend/tests/unit/task-records-guards.test.ts` | `countPending`：`off` 返回 `null` 且只发出一条读设置的语句、没有任何语句 `FROM tasks`；无行时按 `overdue` 的条件计数。`parseTaskPage`：缺省值与两个 422 码。共 4 格。 |
| `scripts/ops/staging-tasks-smoke.mjs` | 导出 `M4_TASK_TABLES`；头注里对 `routes/tasks.ts` 的行号引用（本分支上已因 helper 搬出而漂移）改为 `#tasksRouter` 锚点；`preflightDatabase` 在 P0-A 那条查询之后另发一条，查 `task_list_items`、`task_list_members`、`task_user_settings`；缺任一张即抛 `M4 task tables do not exist (<缺的表>): the task routes in this image need the M4 migration`，先于残留检查与任何种子写入。头注的 preflight 说明同步。 |
| `scripts/ops/staging-tasks-smoke.test.mjs` | 假 `pg` 对 M4 那条查询默认三张表都在，环境变量 `FAKE_PG_M4_MISSING` 让其中一张缺席；新增 4 格：源码恰好探测三张表（1 格）；逐表缺席时非零退出、点名信息、无 PASS 行、零 `INSERT`、零 `DELETE`（3 格）。 |
| `scripts/ops/global-history-flag-manifest.mjs` | `TASKS_ENABLED` 条目：`danger` `low` → `medium`（`[own-28]`）；`purpose` 写明现在挂 `/api/tasks` 与 `/api/task-settings`、开它的环境必须已应用 M4 迁移（写出迁移名）、否则任务路由 500；`source` 改为 `packages/core-backend/src/routes/tasks.ts#tasksRouter`。另两个前缀按 §13 随 S5、S8 追加。 |
| `packages/core-backend/vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 各加一行新文件。没有改其他 workflow。 |

`ASSUMPTION(task-m4)` 标签：`[R15]`（`parseTaskPage`（注释同时点名 Q8 与 M3 的 `INVALID_PAGE` 并存）、`/pending` 路由、测试文件头）、`[own-10]`（分页先于 `view`、服务保留数组返回）、`[own-19]`（缺 org 的降级先于分页、设置路由的 404 / 422）、`[R02]` `[R07]`（设置服务、缺省值）、`[D5]` `[own-11]`（`countPending` 与 `/pending-count` 的 `off`）、`[own-04]`（设置写不进结构锁）、`[own-17]`（同一 router 注册）、`[own-28]`（manifest）。设计 Q8 的错误码：M4 用 `INVALID_LIMIT` / `INVALID_OFFSET`，M3 评论列表保持 `INVALID_PAGE`，按设计缺省执行、未合流（测试文件头标 `[R15]` 并点名 Q8）。没有新增 `own-NN` 编号。

### S3.2 `task-m4-paging-settings.db.test.ts`

org 前缀 `org_tasks_m4page_`；参与者用 `seedTaskActor`，`afterAll` 用 `dropTaskM4Fixtures`。HTTP 经 `tasksRouter()` 挂在 express 上（`RBAC_TOKEN_TRUST='true'`）；门 13 两格用真实 `MetaSheetServer`。

| 组 | 格数 | 内容 |
|---|---|---|
| 分页 | 47 | 缺省：101 条任务，不带参数得 100 条、`total` 101、响应只有 `items` / `total` 两键、列表项仍是六列，`offset=100` 取到第 101 条，两页并集 = 全部；边界：`limit=1`、`limit=100&offset=0`、越过末尾（`{ items: [], total: 3 }`）、`offset=9007199254740991`（200，不是 500）；非法形式 21 种 × 两个端点 = 42 格，逐格 422 且体 `toEqual({ error: { code } })`（含 `limit=0&offset=-1` ⇒ `INVALID_LIMIT`）；同 `updated_at` 的稳定次序：5 条设成同一时刻，先断言插入次序 ≠ `id DESC`（相同就加行直到不同），`limit=2` 翻页结果 = `ORDER BY id DESC`、不重不漏，再改一行的 `updated_at` 看它排到最前；`/pending`：`all_open` 下 3 条未完成 + 1 条本人已完成，两页 = `updated_at DESC, id DESC`、`total` 3、`PendingItem` 键不变；降级：缺 org 时两个端点的降级体逐字节不变（不带 `total`），缺 org 且 `limit=0` 仍是降级体；坏 `view` + 合法分页 = `predicate_error` 原体；坏 `view` + `limit=0` = 422 `INVALID_LIMIT`。 |
| 设置 | 19 | 无行 GET 给缺省值且不落行；PATCH 子集合并、未知键忽略、`asia/shanghai` 存成 `Asia/Shanghai`、库里四列与响应一致、同体重放 200 且 `updated_at` 不变、`timeZone: null` 清空；12 种非法请求体逐格 422（码见 §3.6）且不留行；已有行（开了每日提醒）时清空时区 422 `DAILY_REMINDER_REQUIRES_TIME_ZONE` 且整行不变；缺 org：GET 404、PATCH（带数组体）422 `ORG_MISSING`、零行；按人按 org 隔离（同一用户在 org B、同 org 的另一用户都看到缺省值；org A 的 `off` 不影响 org B 的红点）；行锁两格（见下）。 |
| `badge_scope` | 4 | 夹具：一条逾期全天任务（UTC 前三天）、一条今天到期的全天任务，头 `x-viewer-time-zone: UTC`。无行 ⇒ `{ count: 1 }`；经 PATCH 设 `overdue_or_today` ⇒ `{ count: 2 }`，改回 `overdue` ⇒ `{ count: 1 }`；`off` ⇒ `{ count: 0, badgeScope: 'off' }`，同时 `/pending` 仍列出两条、`total` 2；缺 org 的降级体不变。常规响应都用 `toEqual` 钉死只有 `count` 一键。 |
| 门 13（设置） | 2 | 正控：真实 `MetaSheetServer` 上只有 `tasks:read` 的非 admin 打 `GET /api/task-settings` ⇒ 200 缺省值；同一服务器上未注册的兄弟路径 `/api/task-settings-not-a-route` ⇒ 404（先证明 404 不是 SPA 兜底或 401）。负控：`runSourceMutant` 把 `routes/tasks.ts` 里恰出现一次的 `  registerTaskSettingsRoutes(router)` 注释掉，tsx 子进程里新建 `MetaSheetServer`，`/api/task-settings` ⇒ 404、`/api/tasks/context` ⇒ 200（任务路由仍挂载）；子进程输出 `{"gate13settings":"red","settings":404,"context":200}`，文件逐字节还原。 |

行锁两格：(a) 另一个连接 `BEGIN; SELECT … FOR UPDATE; UPDATE … badge_scope = 'off'` 后不提交，发 `PATCH { timeZone: 'UTC' }`，300 ms 后提交；响应与库里两项都在（`off` + `UTC`）。(b) 另一个连接只持 `FOR KEY SHARE`，发 PATCH，400 ms 内它必须仍未返回，提交后才 200。

静态展开数：47 + 19 + 4 + 2 = **72**；三遍 verbose 日志均收集并通过 72（门 17 ②）。

### S3.3 命令与结果

所有命令在 `packages/core-backend` 下，`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/m4c_lane EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`。`m4c_lane` 从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项；M4 迁移不在排除里）：422 条 executed successfully。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | 0 errors |
| 改动前的既有 lane（改完代码、新文件加入前） | 9 文件 | 9 files / **284 passed**，与 S2 同数同绿 |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 1067 passed \| 173 skipped (1240)；Tests 18100 passed \| 1665 skipped (19765)；0 failed**（S2 为 18084，+16 = 本片新增的 12 + 4 格）。门 20 harness、三集合枚举在其中 |
| 真库 lane × 3（10 文件，`tasks-realdb.yml` 清单） | `vitest --config vitest.integration.config.ts run <10 files> --reporter=verbose` | 三遍均 **Test Files 10 passed；Tests 356 passed；0 failed**，每遍 24–36 秒。逐文件：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 24、m3-membership 44、m3-comments-deletion 28、m4-schema 54、m4-list-roles 41、**m4-paging-settings 72** |
| 鉴权门 | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts` | 23/23（本片未改该文件） |
| smoke 单测 | `node --test scripts/ops/staging-tasks-smoke.test.mjs`（仓库根） | 19/19（原 15 + 新 4） |
| manifest 与相邻守卫 | `node --test scripts/ops/global-history-flag-manifest.test.mjs scripts/ops/multitable-recovery-schema-containment.test.mjs`；`node --test scripts/ops/tasks-auth-ci-wiring.test.mjs` | 76/76；3/3 |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫本片新增 / 改动的全部 14 个文件，以及本文件 | 均退出 0 |

M2 门 8 的路由 mutant（rbac-trust）、门 19 的两个探针（read-path）、门 4 都在上面每一遍 lane 里，均绿：`/pending-count` 的两行 needle 未动，`{ count: 1 }` 的整体相等断言未改。

**最终 head 上的复跑**（`35900fe984`）：新建库 `m4c_final`，从空库全量迁移 422 条；10 文件 lane 一遍 **10 files / 356 passed**；鉴权门 23/23。跑完查 `m4c_final` 与 `m4c_lane`：`tasks`、`task_lists`、`task_user_settings` 与种子用户均 0 行。两库已删除。

### S3.4 变异证明

在文件内（每遍 lane 都跑）：门 13 设置负控（§S3.2），注册行注释掉 ⇒ 设置路由 200 → 404。

手工（脚本在私有工件目录：断言 needle 恰一次 → 备份 → 改写 → 跑 → 还原 → `filecmp` 逐字节比较；逐个串行，不与其他 vitest 进程并行）。DB = `task-m4-paging-settings`（72 格）；UNIT = `task-records-guards` + `task-settings`（48 格）；SMOKE = `staging-tasks-smoke.test.mjs`（19 格）。

| # | 变异（文件） | 失败 | 变红的格 | 还原 |
|---|---|---|---|---|
| MP01 | 排序去掉 `id` 平局键，只剩 `tasks.updated_at DESC`（records） | DB 1/72 | 同 `updated_at` 翻页格 | 相同 |
| MP02 | `/api/tasks` 的 `total` 改成 `items.length`（routes） | DB 3/72 | 缺省 101 条、边界、翻页 | 相同 |
| MP03 | `/pending` 的 `total` 改成 `items.length`（routes） | DB 1/72 | `/pending` 翻页格 | 相同 |
| MP04 | `parseTaskPage` 非法时夹取成缺省值（records） | DB 43/72；UNIT 1/48 | 42 个非法形式格 + 「坏 `view` + `limit=0`」；`parseTaskPage` 码映射单测 | 相同 |
| MP05 | `/api/tasks` 先验 `view` 后解析分页（routes） | DB 1/72 | 降级 / 优先级格 | 相同 |
| MP06 | `/api/tasks` 先解析分页后判缺 org（routes） | DB 1/72 | 降级 / 优先级格（缺 org + `limit=0` 变 422） | 相同 |
| MP07 | `countPending` 对 `off` 不短路，改按 `overdue` 查（records） | DB 2/72；UNIT 1/48 | `off` 格、隔离格；「`off` 不查 `tasks`」单测 | 相同 |
| MP08 | `countPending` 忽略 `overdue_or_today`，恒用 `overdue`（records） | DB 1/72 | `overdue_or_today` 格 | 相同 |
| MP09 | `countPendingList` 用 `overdue` 代替 `all_open`（records） | DB 2/72 | `/pending` 翻页格、`off` 格里的 `/pending` 总数 | 相同 |
| MP10 | 设置 PATCH 的取行去掉 `FOR UPDATE`（settings 服务） | DB 1/72 | 行锁格 (b)。行锁格 (a) **没有变红**：持锁方已 `UPDATE` 时，占位 `INSERT … ON CONFLICT DO NOTHING` 本身就等到对方提交，此后读到的已是新值，所以在这个编排里去掉 `FOR UPDATE` 是等价变异；(b) 用只持 `FOR KEY SHARE` 的编排证明行锁确实被取 | 相同 |
| MP11 | `getTaskSettings` 去掉 `org_id` 条件（settings 服务） | DB 1/72 | 隔离格 | 相同 |
| MP12 | `loadBadgeScope` 去掉 `org_id` 条件（settings 服务） | DB 1/72 | 隔离格 | 相同 |
| MP13 | 合并结果不变时仍 `UPDATE`（settings 服务） | DB 1/72 | PATCH 合并格（重放后 `updated_at` 变了） | 相同 |
| MP14 | `OFFSET` 恒为 0（records） | DB 4/72 | 缺省 101 条、边界、翻页、`/pending` 翻页 | 相同 |
| MP15 | smoke preflight 不再探测 `task_user_settings`（smoke） | SMOKE 1/19 | 「源码恰好探测三张表」格。三个逐表缺席的 harness 格**没有变红**：假 `pg` 不解释 SQL，只按环境变量回缺席的键，所以它们只证明「缺表 ⇒ 点名失败、不写不删」这段行为；探测语句本身由源码格钉住 | 相同 |
| MP16 | `toTaskUserSettings(undefined)` 返回共享的缺省策略对象（纯函数） | UNIT 1/48 | 「新副本」格 | 相同 |
| MP17 | 设置 PATCH 的普通对象判定放宽成「非 null 的对象」（settings 服务） | DB 1/72 | 数组请求体格 | 相同 |
| MP18 | `/pending-count` 对 `off` 回 `{ count: 0 }`（不带 `badgeScope`）（routes） | DB 2/72 | `off` 格、隔离格 | 相同 |

全部结束后 `git status` 干净（`src` 与 `scripts` 无残留改动，`runSourceMutant` 的临时文件已删）。

### S3.5 前端兼容性

对照对象是 `origin/claude/tasks-m3-frontend` 的当前 head `3efa17c3b6`（设计 §7.3 写作时钉的是 `68b0a624bc`）。两者之间 `apps/web/src/tasks/tasksApi.ts` 只改了评论正文的 U+0000 检查，`TasksView.vue` 只加了评论错误文案与关注人写后的重读；`listTasks`、`fetchPendingCount`、`useTasksBadge.ts`、`TasksTodoBadge.vue` 均未变。逐项核对：

- `listTasks(view)` 只发 `?view=`，只看 `degraded` / `reason` 与 `Array.isArray(items)`；多出的 `total` 不读。不带分页参数时缺省 `limit` 100 = 原硬上限，行集不变；超过 100 条时与原来一样只看到前 100 条。唯一可见差别是同一 `updated_at` 的行之间有了确定的次序。降级体逐字节不变（本片的降级格与 M2 的三处 `toEqual` 都绿）。
- `fetchPendingCount` 只看 `degraded` / `reason` 与 `count` 是否为非负有限数，多余键忽略。没有设置行的用户仍得到 `{ count }`。用户经新设置接口设为 `off` 后，M3 红点显示 `0` 而不是隐藏：设计 §7.3 与 §12-Q12 已接受的可见差别，不是破坏。
- `apps/web/src` 里没有 `/api/tasks/pending`（列表）的调用方；前端代码里也没有发 `limit` / `offset` 给这两个任务端点的地方。
- 设置接口是新路径，M3 前端不调用。

结论：**不改前端，M3 前端在本片后端上行为不变**（除上面两条已接受的差别外）。这一结论只基于读源码，没有在浏览器里跑 M3 前端（见 §S3.7）。

### S3.6 与设计的偏差

1. **缺 org 的降级先于分页解析。** 设计 §7.2 只规定了「分页先于 `view`」，没有规定缺 org 与分页谁先。本片让缺 org 先降级（与 §3.0「缺 org：集合型读路由 200 降级」一致，前端的 org 引导也依赖这个降级体），标 `[own-19]`，并由降级 / 优先级格钉住（MP06 证红）。
2. **无行用户的空操作 PATCH 会留下一条缺省行（按 §4.2 处理，已定）。** §3.0 的通则写「空操作不写行」；§4.2 是设置写的专门规定：先 `INSERT … ON CONFLICT DO NOTHING` 占位，并且它的末句已明确「留下的缺省行与无行语义相同」。本片按 §4.2 这条专门规定执行，只在合并结果与现值相同时跳过 `UPDATE`（`updated_at` 不变）；所以一个无行用户第一次发空 PATCH 会得到一条值全为缺省的行。这是 §4.2 自己接受的结果，不是本片另作的取舍；若要逐字满足 §3.0，可在合并结果不变时于事务内抛私有哨兵让占位插入回滚（行锁两格届时改用 SQL 播种行）。
3. **校验失败不留行**，比 §4.2「校验失败时留下的缺省行与无行语义相同」更严：422 在事务内抛出，整个事务回滚，占位行一并消失（12 个非法请求体格逐一断言无行）。
4. **`task-records.ts` 与 `task-user-settings.ts` 互相 import**（前者用 `loadBadgeScope`，后者用 `fail`）。两边在模块顶层都不使用对方，循环无副作用；门 8 路由 mutant、门 19 探针、门 13 负控的 tsx 子进程都能正常加载。
5. **`loadRemindPolicy` 未在本片实现**（§4.1 把它列在 `task-user-settings.ts`）：第一个调用方是 S4 的创建路径，留给 S4。
6. **只有数组请求体会走到 `INVALID_SETTINGS`。** `express.json()` 的 strict 模式会在路由之前拒掉顶层是字符串、数字或 `null` 的 JSON（400，由 body-parser 与应用的错误处理给出，不是本路由的 422）。本片没有为此改 body-parser 配置，只测了数组体。
7. **smoke preflight 另发一条查询**，没有把三张 M4 表拼进原来那条 11 列的查询：这样失败信息能单独点名缺的是哪张 M4 表，也不改原 P0-A 断言的文字。
8. **manifest 的 `purpose` 只写了两个前缀**（`/api/tasks`、`/api/task-settings`）。设计 §9.2 描述的是终态四个前缀，§13 S3 规定另两个随 S5、S8 追加；按 §13 执行。
9. **单测格加在 `task-records-guards.test.ts`**（设计 §13 S3 的文件清单没有它）：该文件已经 mock 了 `db/pg`，是证明「`off` 不查 `tasks`」的最直接位置。
10. **库里闭集外的设置值 fail closed**（`toTaskUserSettings` 抛 `TypeError` ⇒ 500），而不是悄悄回落到缺省值。`badge_scope` 与提醒开关有 CHECK，实际只可能发生在没有 CHECK 的 `default_remind_policy` 上。这是实现上的处理方式，不是新取值，没有另起标签。

### S3.7 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG15.17（同 §S1.9）。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- M3 前端没有在浏览器里对着本片后端跑过；§S3.5 的兼容结论只来自读源码。
- `MetaSheetServer` 对顶层非对象 JSON 请求体的实际响应（§S3.6 第 6 条）没有测。
- 真实 staging 上的 smoke preflight：只在假 `pg` 的 harness 里跑过；本片不触达任何环境。
- 门 19 的 M2 / M4 抽取命令本片没有重跑（本片没有动 `gate19` / `gate19m4` 格与抽取 helper；两组格都在 lane 里通过）。
- MP10 与 MP15 各有一格对应变异不变红，原因见 §S3.4，已作为等价或覆盖范围记录，不算击杀。
- 两条设置路由的权限码没有格证明：本片只用只带 `tasks:read` 的用户打过 `GET`，没有格证明 `PATCH /api/task-settings` 要求 `tasks:write`（把它的守卫改成 `'read'` 的变异今天会存活）。设计把新路由的非 admin 三件事与路由人口枚举放在 S10（`tasks-auth-gate.ts` 的 `M4_ROUTES`），两条设置路由目前不在门 1 / 2 / 16 的任何表里。

### S3.8 给 S4 的交接

- 从本片起任务路由还读 `task_user_settings`（`/pending-count`）：开了 `TASKS_ENABLED` 的环境必须已应用 M4 迁移；smoke preflight 与 manifest 已登记。
- 分页：新列表端点用 `parseTaskPage` + `pageClause` 同样的写法（`$n` 从 `cond.params.length + 1` 起）；错误码是 `INVALID_LIMIT` / `INVALID_OFFSET`，M3 评论的 `INVALID_PAGE` 不动（Q8）。降级体不带 `total`。
- 设置：`toTaskUserSettings` 是行 ⇄ 接口形状的唯一映射；S4 的 `loadRemindPolicy` 放进 `task-user-settings.ts`，读 `default_remind_policy` 后经 `toTaskUserSettings` 或 `parseRemindPolicy`，无行即 `{ mode: 'default' }`。设置 PATCH 不进结构锁；S4 若在 `createTask` 的结构锁内读创建人的提醒策略，是在另一张表上的普通读，不引入新的锁序。
- 门 8（§10.5）的 `badgeScope: 'overdue_or_today'` 夹具可以直接用 `PATCH /api/task-settings`；本文件的 `overdueAndToday` 夹具与 `x-viewer-time-zone: UTC` 写法可供参考。
- `/pending-count` 的两行 needle 仍原样在 `routes/tasks.ts`；S4 给 POST / PATCH 加字段时不要碰它们，也不要在 `task-access.ts` 里写出 §S2.3 列的 needle 文本。
- `tasks.ts` 里 `registerTaskSettingsRoutes(router)` 独占一行且恰出现一次（门 13 负控靠它）；S5 的 `registerTaskListRoutes(router)` 照同样写法另起一行。
- `task-m4-paging-settings` 用 `pg.Client` 开第二个连接做行锁格，`finally` 里 `end()`；新文件若同样需要第二连接，照此写，避免在 `afterAll` 之外留下打开的连接。
- S10 必须把 `GET /api/task-settings`、`PATCH /api/task-settings` 加进 `M4_ROUTES`（缺 org、无 admission ⇒ 403、只有另一个码 ⇒ 403、对照用户 ⇒ 200），并让路由人口格把它们算进 P0-A ∪ M3 ∪ M4；在那之前 `PATCH` 的 `tasks:write` 守卫没有格钉住（§S3.7）。
- 变异脚本在私有工件目录，需要复用时照 §S3.4 的表重建即可。

## 6a055bf64f：M3 后端第三轮修复并入 PR-3a（S3 之后、S4 之前）

`claude/tasks-m3-backend` 的第三轮闸方修复 `62c883a0ac`（有界删除行锁、锁前删除检查、创建上限、文本检查、测试补齐）并入本分支，合并提交 `6a055bf64f`（父 `b2da6df9e9` + `62c883a0ac`）。唯一冲突在 `packages/core-backend/src/services/task-records.ts` 的 import 块（两边各加了一行 import），取两边即解。合并后复跑：真库 lane（10 文件）两遍均 **362/362**；鉴权门 **23/23**；全量单测 **18108 passed**，其中 `tests/integration/public-form-flow.test.ts` 一次 `socket hang up`，单独重跑三遍 26/26 × 3，与本分支无关。

## S4 日期写入与 PATCH

基于 `6a055bf64f`。代码提交 `acd3846799`；本节随后以只改本文件的一条提交追加。上一位实现者留下的未提交草稿（`task-edit.ts`、`task-patch.ts`、`task-records.ts` / `task-user-settings.ts` / `routes/tasks.ts` 的改动与四处既有断言的更新）经逐项对照设计后保留了其中正确的部分，改动之处见 §S4.6。本地一次性库只用 `m4d_*` 前缀：`m4d_lane`（上一位实现者建、已迁移到 422 条、零任务行；lane × 3、变异、鉴权门都在它上面跑），工作结束时已 `DROP DATABASE`。`node_modules` 仍是符号链接（本 worktree → M3 worktree → 规范检出），本片没有改动任何符号链接、没有跑 `pnpm install`。

### S4.1 交付内容

| 文件 | 内容 |
|---|---|
| `packages/core-backend/src/tasks/task-edit.ts`（新，纯函数） | `parseExpectedVersion`（正安全整数 JSON number，其余 `invalid_version`）；`parseRemindAtInput`（`undefined` 保留 / `null` 清空 / 严格 `YYYY-MM-DDTHH:MM[:SS[.fff]]` + `Z` 或 `±HH:MM`，`[own-30]`，不用平台的宽松 `Date` 解析）；`planTaskDates(current, input)`：第 1 步类型闸（四个日期键出现时须为 `null` 或非空字符串，否则 `invalid_date`；`timeZone` 须为 `null` 或字符串，否则 `invalid_time_zone`），第 2 步逐键合并（缺省 = 保留、`null` = 清空）后用 `computeDueAt` 在 `try/catch` 里判日期与时间（`HH:MM` 落成 `HH:MM:SS`）、`validateViewerTimeZoneHeader` 判时区并落规范名（D7）、`[own-07]` 的两条时区规则（合并后有日期必须有时区；碰了任一日期键且合并后仍有日期，必须同体带时区）、清日期不隐式清时间、无「开始不晚于截止」；`''` 时区读作 `null`（`[own-29]`）；`due_at` 每次重算，库里存着平台不再接受的时区时给 `invalid_time_zone` 而不是抛出。`needsDefaultRemindPolicy` / `resolveCreateRemindAt`（锁 §4.4 缺省算法，任务自己的时区，经 `computeDefaultRemindAt`）。`planTaskPatch(current, input)`：`title`（`normalizeUserText` + 可存文本，不能为 `null`）→ `description`（`[own-08]` `[own-31]`：原样存、`''` 与 `null` 存 `NULL`、20000 码点上限、U+0000 / 孤立代理项拒绝）→ 日期 → `remindAt`（`[own-06]` 从不派生）；给出 `changed` 与变化面事件表（`[own-18]`：只换时区且无日期 ⇒ 有变化、无事件）。 |
| `packages/core-backend/src/services/task-patch.ts`（新） | `patchTask`：`withOrgStructure` → 按 id 取本 org 未软删的任务全行（非可打印 id 先 404）→ `loadRowRoles`（含清单身份）+ `can('edit')`（否则 404）→ `parseExpectedVersion`（422）→ 与锁后读到的 `version` 在 JS 里比较（过期 ⇒ 409，请求值不进 SQL）→ `planTaskPatch`（422）→ 无变化 ⇒ 200 不写 → 一条 `UPDATE tasks … updated_at = now(), version = version + 1 WHERE id = $1 AND version = $2 RETURNING version`（0 行按 409 兜底）→ 每个变化面一条 `task_events`（payload 缺省 `{}`，`occurred_at` 取事务的 `now()`）。请求体不是普通对象（数组也算）按 `{}` 处理；未知键忽略。`isVersionConflict` 供路由识别 409。 |
| `packages/core-backend/src/services/task-records.ts` | `createTask` 接收日期键、`timeZone`、`remindAt`：`planTaskDates` 与 `parseRemindAtInput` 在开事务之前跑（422 时事务数为 0）；锁后按需读创建人的 `default_remind_policy`（同一连接），`resolveCreateRemindAt` 得 `remind_at`；`INSERT INTO tasks` 前五个绑定位不变，新七列追加在后（瞬时以 ISO 文本绑 `::timestamptz`）；成功体 `{ id, version: 1 }`。`getTask` 在 `view` 判定之后组装 `description` `startDate` `startTime` `remindAt`。`completeTask` / `reopenTask` 成功体加 `version`：锁后读到的 `task.version`，本次翻转则 +1，不再读一次负责人。导出 `isoOrNull`。 |
| `packages/core-backend/src/services/task-user-settings.ts` | 新 `loadRemindPolicy(db, { orgId, actorId })`：在调用者给的客户端上读 `task_user_settings`，经 `toTaskUserSettings` 取 `defaultRemindPolicy`，无行即 `{ mode: 'default' }`。 |
| `packages/core-backend/src/routes/tasks.ts` | `POST /api/tasks` 透传六个新键（不透传 `description`）；新 `PATCH /api/tasks/:id`（`authenticate` + `rbacGuard('tasks','write')`，缺 org 422 `ORG_MISSING`；`VERSION_CONFLICT` 回 `{ error: { code }, currentVersion }`，其余经 `sendError`）。`/pending-count` 的两行 needle 与 `registerTaskSettingsRoutes(router)` 那一行逐字节未动。 |
| `packages/core-backend/src/tasks/task-ids.ts`、`src/services/task-create.ts` | `isStorableText` 原样搬到纯文本规则所在的 `task-ids.ts`，`task-create.ts` 改为 re-export（既有 importer 不变）；这样 `src/tasks/task-edit.ts` 不必从 `services/` 反向引入。 |
| `packages/core-backend/tests/helpers/task-m4-fixtures.ts` | `runSourceMutant` 增加可选 `all`（改写每一处）与 `count`（断言出现次数）；缺省行为不变。门 8 负控二要求「每一处都换」，靠它。 |
| `packages/core-backend/tests/integration/task-m4-dates.db.test.ts`（新） | 见 §S4.2。登记三处：`vitest.config.ts` exclude 裸字面量、`tasks-realdb.yml` 清单、文件顶部 `assert-rbac-optional-off`。 |
| `packages/core-backend/tests/integration/task-m4-list-roles.db.test.ts` | 补设计 §10.4 的三格：list-editor PATCH 200（`version` 2、一条 `title_changed`、actor 是编辑者）；list-reader PATCH 对合法 / 过期 / 非法三种体都是与缺失 id 逐字节相同的 404、行与事件不变、详情 `canEdit` 为 false；follower + list-reader（`[R08]`）同样 404。原有 41 格未动，只有 `completeTask` 的一处 `toEqual({ done: true })` 按 §5.4 改为带 `version: 2`。 |
| `packages/core-backend/tests/integration/task-p0a.db.test.ts`、`task-rbac-trust.db.test.ts`、`task-read-path.db.test.ts` | 设计 §5.4 点名的四处既有断言：`{ done: true }` → `{ done: true, version: 2 }`（rbac-trust 一处、read-path 一处）、`{ ok: true }` → `{ ok: true, version: 3 }`（rbac-trust 两处，两次完成一次翻转再重启翻转）；p0a 的详情 `toEqual` 加 §5.5 的四个新键（`listIds` 随 S7）。每处只加键，原断言其余部分未动。 |
| `packages/core-backend/tests/unit/task-edit.test.ts`（新） | 137 格：`parseExpectedVersion` 12；`parseRemindAtInput` 32（缺省 / `null`、7 种合法形态给出的瞬时、24 种非法形态）；类型闸 33（14 种值 × 空任务 / 有日期任务、`timeZone` 4 种非字符串、闸先于取值）；取值 32（全天 / 定时 `due_at`、非法日期与时间 11 种、非法时区 6 种、大小写变体落规范名、`time_zone_required` 的三种来源、`''` 时区、碰日期键不带时区 6 种体、只换时区重算、清日期不清时间、同清、清时间变全天、无「开始不晚于截止」、库存坏时区给 reason）；缺省提醒 8（何时读策略、定时 −30min、全天 18:00 任务时区、00:10 落前一日、`none`、显式值优先、无截止日、缺策略抛 `TypeError`）；`planTaskPatch` 20（空操作、同值重放为空操作、标题规则、描述规则与码点上限、非法描述 7 种、校验顺序、三字段一次改 = 五种事件按固定序、改截止日不动提醒、清截止日不动提醒、`remindAt` 设 / 清 / 同值、只换时区的事件、无日期只换时区无事件、日期 reason 透传）。 |
| `packages/core-backend/tests/unit/task-records-guards.test.ts` | 新增 `createTask dates` 16 格：13 种非法日期 / 时区 / `remindAt` 形态各 422 且事务数 0、零语句；带日期的创建首句仍 `SET TRANSACTION …`、策略读在锁之后、`INSERT` 之前、参数 `[actorId, orgId]`、第 2–5 个绑定位不变、后七位是规范化值（`asia/shanghai` → `Asia/Shanghai`、`10:00` → `10:00:00`、ISO 瞬时）；无日期不读设置表且后七位全 `null`；显式 `remindAt`（`null` / 瞬时）不读设置表。`structure-lock isolation` 加 2 格：PATCH 首句 `SET TRANSACTION …`、缺任务时 404 且体未被看（无 UPDATE / INSERT）；四种非可打印 id 404 且没有任何语句以该 id 为参数。 |
| `packages/core-backend/tests/unit/tasks-route-errors.test.ts` | 加 PATCH 的 `sendError` 落点：四种非合同错误 500 `INTERNAL` 不回显；409 体恰为 `{ error: { code: 'VERSION_CONFLICT' }, currentVersion }`；带 `VERSION_CONFLICT` 码但 `currentVersion` 不是整数时不给额外键；路由把路径 id 与原始请求体原样交给服务。共 7 格。 |
| `packages/core-backend/vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 各加一行新文件。没有改其他 workflow。 |

`ASSUMPTION(task-m4)` 标签：`[R03]`（`task-edit.ts` 头注、`createTask` 的校验位置与新绑定、`getTask` 的新四键、complete / reopen 的 `version`、`task-patch.ts` 头注与 409 体、路由的 POST 新键与 409 体、两份测试文件头）、`[own-04]`（PATCH 进结构锁）、`[own-05]`（`version` 只在有变化时 +1）、`[own-06]`（PATCH 不派生 `remind_at`；注释同时点名设计 §12-Q2）、`[own-07]`（时区两条规则、不隐式联动）、`[own-08]`（描述上限）、`[own-18]`（每个变化面一条事件、payload `{}`）、`[R08]`（list-roles 的 follower + list-reader 格）。本片新起三个编号（设计 §11 表止于 `[own-28]`）：**`[own-29]`** `''` 时区读作 `null`（有日期 ⇒ `TIME_ZONE_REQUIRED`，无日期 ⇒ 清空；空白串等其他非时区字符串仍是 `INVALID_TIME_ZONE`）；**`[own-30]`** `remindAt` 的文法（大写 `T` / `Z`、小数至多三位、真实日期、换算后年份 0001–9999）；**`[own-31]`** `description` 不做 NFC、不修剪，U+0000 与孤立代理项按与标题、评论相同的可存文本规则拒绝。三者都是设计里未定细节的取值，待 owner 裁。

### S4.2 `task-m4-dates.db.test.ts`

org 前缀 `org_tasks_m4dates_`；参与者用 `seedTaskActor`，`afterAll` 用 `dropTaskM4Fixtures`。HTTP 经 `tasksRouter()` 挂在 express 上（`RBAC_TOKEN_TRUST='true'`）。夹具任务一律经 `POST /api/tasks` 建（创建人即负责人），固定用 2031-03-15 10:00 Asia/Shanghai（`due_at` `2031-03-15T02:00:00.000Z`，缺省提醒 `01:30Z`）。「行未变」断言比较任务行（可编辑列 + `due_at` `remind_at` `updated_at` `deleted_at` `version`）与全部事件行的 JSON。

| 组 | 格数 | 内容 |
|---|---|---|
| POST 日期 | 32 | 全天 `due_at` = 当地 23:59:59.999、体恰为 `{ id, version: 1 }`；定时 `due_at`、起始日期 / 时间、`10:00` 存成 `10:00:00`、详情带新四键；`description` 在创建时被忽略；28 种非法体逐格 422 且 org 内零行（缺时区 3 种、时间无日期 2 种、`2031-02-30`、`25:00`、日期含 U+0000、时间含孤立代理项、`Not/AZone`、`+08:00`、数字时区、时区含 U+0000 / 孤立代理项、非法 `remindAt` 3 种、**类型闸 11 种**（`dueTime` / `startTime` 为 `''` `0` `false`，`dueDate` 为 `['…']` `20310315` `{}` `''`，`startDate` 为数组）都是 422 `INVALID_DATE` 而不是 500）；门 8 正控：`Not/AZone` 422 零行、同体换 `Asia/Shanghai` 200、`asia/shanghai` 存成 `Asia/Shanghai` 且 `due_at` 与规范拼写相同。 |
| 缺省提醒 | 5 | 定时 ⇒ `due_at − 30min`，只有一条 `created` 事件；全天 ⇒ 任务时区 18:00（查看者头设成 `America/New_York`，结果不变）；`00:10` ⇒ 前一日 15:40Z；策略 `none`（经 `PATCH /api/task-settings`）⇒ `NULL`，同 org 另一用户仍得缺省，同一用户在另一 org（无行）仍得缺省；显式 `null` ⇒ `NULL`、显式瞬时（过去的也）原样、无截止日 + 显式瞬时原样且 `time_zone` 为空、什么都不带 ⇒ `NULL`，四者都只有 `created` 事件。 |
| PATCH `version` | 10 | 六种缺失 / 非法 `expectedVersion`（含数组体）各 422 `INVALID_VERSION` 且无写；过期（旧值、未来值、过期 + 非法字段）都是 409 且体恰为 `{ error: { code: 'VERSION_CONFLICT' }, currentVersion: 2 }`、行不变；同一成功请求重放 409、与现值相同的请求（含大小写变体时区、`+08:00` 形式的同一瞬时、`description: ''` 对 `NULL`、未知键）是空操作、只带 `expectedVersion` 也是空操作，`updated_at` 与事件都不变；三字段一次改 `version` 恰 +1、`updated_at` 变、三条事件各一、`actor_id` 是操作者、`occurred_at` 相同、payload `{}`、`remind_at` 不动；两个并发请求同一 `expectedVersion` ⇒ 恰一个 200 一个 409（409 体里 `currentVersion` 2）、库里是赢家的标题、恰一条 `title_changed`。 |
| PATCH 日期与提醒 | 8 | 碰日期键不带时区 5 种体（含 `timeZone: null` / `''`）422 `TIME_ZONE_REQUIRED` 行不变、带时区 200；改截止日不带 `remindAt` ⇒ `remind_at` 不动、只有 `due_changed`；`remindAt` 设 / 同值空操作 / 清各写一条 `remind_changed`；只带时区 ⇒ `due_at` 重算、`due_changed`、`remind_at` 不动；无日期任务只带时区 ⇒ `version` +1、无事件；清空：只清 `dueDate` 422 `INVALID_DATE`、去掉时区 422 `TIME_ZONE_REQUIRED`（两者行不变）、日期与时间一起清 ⇒ `due_at` 空、时区与 `remind_at` 保留、再清 `startDate` + 时区 ⇒ 三列空，事件恰 `due_changed` + `start_changed`；描述 20000 个 emoji（40000 码元）200、多一个码点 422 `INVALID_DESCRIPTION` 行不变、`''` 存 `NULL`、`null` 对 `NULL` 是空操作、详情四键；详情在一次改起始日期 / 时间 / 描述 / 提醒之后返回四键与三条事件。 |
| PATCH 422 | 34 | 33 种非法值逐格 422 且行不变（类型闸 11 种与 `2031-02-30`、`25:00`、时间无日期、日期含 U+0000 / 孤立代理项 ⇒ `INVALID_DATE`；时区 5 种 ⇒ `INVALID_TIME_ZONE`；标题 `null` / 空白 / 数字 / U+0000 / 孤立代理项 ⇒ `INVALID_TITLE`；描述数字 / U+0000 / 孤立代理项 ⇒ `INVALID_DESCRIPTION`；`remindAt` 4 种 ⇒ `INVALID_REMIND_AT`）；门 8 PATCH 组：`Not/AZone` 422 行不变、`Asia/Shanghai` 200、`asia/shanghai` 存成规范名且 `due_at` 是当地 23:59:59.999。 |
| PATCH 行级 404 | 6 | 同 org 无角色者与 follower 对四种体（合法 / 过期 / 非法 / 空）都得与缺失 id 逐字节相同的 404、行不变、follower 详情 `canEdit` false；非创建人的负责人可以编辑（正控，`title_changed` 的 actor 是他）；第二租户：创建人拿 org A 的 token 打自己在 org B 的任务 ⇒ 四种体都 404、行不变，org A 的任务 200，换 org B 的 token 200；软删任务 404 行不变；四种非可打印路径 id（`tsk_%00`、真 id 后接 `%00`、含空格、非 ASCII）404 且体与缺失 id 相同、`version` 不变；无 org 的 token 422 `ORG_MISSING` 行不变。 |
| complete / reopen 的 `version` | 2 | 完成翻转 ⇒ `{ done: true, version: 2 }`，重复完成不翻转 ⇒ 仍 2，拿 1 去 PATCH 409（`currentVersion` 2）、拿 2 去 PATCH 200 ⇒ 3，重启翻转 ⇒ `{ ok: true, version: 4 }`，库里 4；`all` 模式两个负责人只一人完成不翻转 ⇒ `{ done: false, version: 1 }`。 |
| 门 8 A 支 | 3 | 夹具：用户经 `PATCH /api/task-settings` 设 `overdue_or_today`；先 `SELECT now()`，用 `viewerNextMidnight` 算上海与 UTC 各自的下一个零点，距最近翻转点不足 2 分钟就等过去（不 skip，用例超时 9 分钟），`due_at` 取两者中点（换算成上海墙上日期与时间经 `POST /api/tasks` 提交、断言库里 `due_at` 与中点相同），两种回退的期望值由运行期决定并断言不相等。正控：`Not/AZone` 头、不带头、`Asia/Shanghai` 头三个响应体逐字节相同且等于任务时区的答案；显式 `UTC` 头得到另一个答案（夹具确有判别力）。负控一：`routes/tasks.ts` 里 `validateViewerTimeZoneHeader(req.header('x-viewer-time-zone'))` 恰两处，都改成后接 `?? 'UTC'`；子进程里显式头仍是任务时区的答案、非法头与缺头都变成 UTC 的答案 ⇒ 证红。负控二：`task-access.ts` 里 `COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone)` 恰四处全部换成以 `'UTC'` 兜底；同样三问，缺头与非法头翻转 ⇒ 证红。两个负控都改生产码，文件逐字节还原。 |

静态展开数：32 + 5 + 10 + 8 + 34 + 6 + 2 + 3 = **100**；三遍 verbose 日志均收集并通过 100（门 17 ②）。

### S4.3 命令与结果

所有命令在 `packages/core-backend` 下，`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/m4d_lane EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`。`m4d_lane` 是上一位实现者留下的库（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项；本片开工时对它重跑 `migrate.ts`，0 条新迁移、`kysely_migration` 422 条、`tasks` 0 行）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | 0 errors |
| 新单测 + 门 20 + `task-create` | `vitest run tests/unit/task-edit.test.ts tests/unit/task-pure-no-io.test.ts tests/unit/task-create.test.ts` | 3 files / 154 passed（`task-edit.ts` 进入门 20 的扫描人口，无导出函数触达 DB stub） |
| `task-records-guards` + `tasks-route-errors` | `vitest run tests/unit/task-records-guards.test.ts tests/unit/tasks-route-errors.test.ts` | 2 files / 42 passed |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 1069 passed \| 173 skipped (1242)；Tests 18271 passed \| 1665 skipped (19936)；0 failed**（合并记录的 18108 + 1 个当时挂掉的 public-form-flow 用例 + 本片新增的 137 + 16 + 2 + 7 = 18271；本遍 public-form-flow 没有再出现 `socket hang up`）。门 20 harness（`task-edit.ts` 已在扫描人口里）、三集合枚举（新文件已登记）、`task-gate19-identities` 在其中 |
| 真库 lane × 3（11 文件，`tasks-realdb.yml` 清单） | `vitest --config vitest.integration.config.ts run <11 files> --reporter=verbose` | 三遍均 **Test Files 11 passed；Tests 465 passed；0 failed**（362 + 100 + 3），每遍 34–101 秒。逐文件：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m3-comments-deletion 32、m4-schema 54、m4-list-roles 44、m4-paging-settings 72、**m4-dates 100** |
| 鉴权门 | `DATABASE_URL=… vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false` 由配置给） | 23/23（本片未改该文件） |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫本片新增 / 改动的全部 18 个文件，以及本文件 | 均退出 0 |

M2 门 8 的路由 mutant（rbac-trust）、门 19 的两个探针（read-path）、门 4、S2 的三个 mutant、S3 的门 13 负控都在上面每一遍 lane 里，均绿：`/pending-count` 的两行 needle 未动，`{ count: 1 }` 的整体相等断言未改，`task-access.ts` 的 needle 计数与 §S2.3 相同（本片没有动该文件；门 8 负控二在子进程里临时改写它并逐字节还原）。

### S4.4 变异证明

在文件内（每遍 lane 都跑）：门 8 A 支的两个生产码负控（§S4.2 末行）。本地三遍 lane 里子进程都输出 `{"gate8route":"red","explicit":1,"invalid":0,"absent":0}` 与 `{"gate8sql":"red","explicit":1,"invalid":0,"absent":0}`（当时 UTC 时刻 ≥ 16:00，任务时区的答案是 1、UTC 的答案是 0）。

手工（脚本在私有工件目录：断言 needle 恰一次 → 备份 → 改写 → 跑 → 还原 → 逐字节比较；逐个串行，不与其他 vitest 进程并行）。DB = `task-m4-dates`（100 格）；DB+ = `task-m4-dates` + `task-m4-list-roles`（144 格）；UNIT = `task-records-guards`（30 格）。

| # | 变异（文件） | 失败 | 变红的格 | 还原 |
|---|---|---|---|---|
| M01 | 类型闸整段改成恒假（`task-edit.ts`） | DB 16/100 | POST 与 PATCH 的类型闸格各 8：`''` / `0` / `false` / 数组 / `{}` 等直接进了 SQL，500 或 23514 | 相同 |
| M02 | 「碰日期键须同体带时区」改成恒假（`task-edit.ts`） | DB 1/100 | 改截止日不带时区格（五种体） | 相同 |
| M03 | 时区落请求原值而不是规范名（`task-edit.ts`） | DB 4/100 | 门 8 POST 变体格、门 8 PATCH 变体格、同值重放格、只带时区格 | 相同 |
| M04 | PATCH 在碰日期键时把 `remind_at` 清空（`task-edit.ts`） | DB 3/100 | 三字段格、改截止日不带 `remindAt` 格、清空格 | 相同 |
| M06 | 描述去掉可存文本检查（`task-edit.ts`） | DB 2/100 | 描述 U+0000（500）与孤立代理项两格 | 相同 |
| M07 | PATCH 标题去掉可存文本检查（`task-edit.ts`） | DB 2/100 | 标题 U+0000、孤立代理项 | 相同 |
| M08 | 换时区不再算作 `due_changed`（`task-edit.ts`） | DB 1/100 | 只带时区格（无事件） | 相同 |
| M09 | 描述上限按码元而不是码点（`task-edit.ts`） | DB 1/100 | 描述格（20000 个 emoji 被拒） | 相同 |
| M10 | 去掉 `can(roles, 'edit')` 判定（`task-patch.ts`） | DB+ 3/144 | 无角色者 / follower 格；list-roles 的 list-reader PATCH 与 follower + list-reader PATCH 两格 | 相同 |
| M11 | 版本比较改成恒假（`task-patch.ts`） | DB 4/100 | 过期 409 格、重放格、并发格、complete / reopen 的 `version` 格 | 相同 |
| M12 | 去掉 `INVALID_VERSION` 检查（`task-patch.ts`） | DB 6/100 | 六种缺失 / 非法 `expectedVersion` 格（全部变成 409） | 相同 |
| M13 | 空操作也走 `UPDATE`（`task-patch.ts`） | DB 3/100 | 重放 / 空操作格、`remindAt` 同值格、描述 `null` 对 `NULL` 格 | 相同 |
| M14 | 不写事件行（`task-patch.ts`） | DB 8/100 | 三字段、并发、改截止日、`remindAt`、只带时区、清空、详情四键、负责人正控 | 相同 |
| M15 | 去掉路径 id 的可打印检查（`task-patch.ts`） | DB 1/100 | 非可打印路径 id 格（`%00` 变 500） | 相同 |
| M16 | 按 id 取行时去掉 org 与存活谓词（`task-patch.ts`） | DB 2/100 | 第二租户格、软删格 | 相同 |
| M17 | 在取行之前先验 `expectedVersion`（`task-patch.ts`） | DB+ 4/144 | 无角色者 / follower、第二租户、软删（空体与非法体变 422）；list-roles 的 list-reader PATCH（`{ title: null }` 体变 422） | 相同 |
| M18 | 字段校验先于 409（`task-patch.ts`） | DB 1/100 | 过期 409 格（过期 + 非法字段那一体变 422） | 相同 |
| M19 | POST 去掉 `INVALID_REMIND_AT`（`task-records.ts`） | DB 3/100 | 三种非法 `remindAt` 格 | 相同 |
| M20 | complete 恒回 `version + 1`（`task-records.ts`） | DB 2/100 | 翻转格（重复完成回 3）、不翻转格 | 相同 |
| M21 | complete 恒回锁后读到的 `version`（`task-records.ts`） | DB 1/100 | 翻转格 | 相同 |
| M22 | reopen 恒回锁后读到的 `version`（`task-records.ts`） | DB 1/100 | 翻转格 | 相同 |
| M23 | `loadRemindPolicy` 忽略读到的行（`task-user-settings.ts`） | DB 1/100 | 策略 `none` 格 | 相同 |
| M24 | `loadRemindPolicy` 去掉 `org_id` 条件（`task-user-settings.ts`） | DB 1/100 | 策略 `none` 格（同一用户的另一 org） | 相同 |
| M25 | `loadRemindPolicy` 去掉 `user_id` 条件（`task-user-settings.ts`） | DB 1/100 | 策略 `none` 格（同 org 另一用户） | 相同 |
| M26 | 全天缺省提醒改用 UTC 而不是任务时区（`task-edit.ts`） | DB 1/100 | 全天 18:00 格 | 相同 |
| M27 | 409 体去掉 `currentVersion`（`routes/tasks.ts`） | DB 4/100 | 过期 409、重放、并发、complete / reopen `version` 格 | 相同 |
| M29 | `''` 时区不再读作 `null`（`task-edit.ts`） | DB 2/100 | POST `''` 时区格、PATCH 改截止日不带时区格（`''` 那一体变 `INVALID_TIME_ZONE`） | 相同 |
| M30 | `remindAt` 正则不匹配时回退到平台 `Date` 解析（`task-edit.ts`） | DB 4/100 | POST / PATCH 的「无时区」与「含 U+0000」`remindAt` 格 | 相同 |
| M31 | 日期与 `remindAt` 校验挪进事务里（`task-records.ts`） | UNIT 13/30 | 13 种非法形态的「事务数 0」格 | 相同 |
| M32 | `INSERT INTO tasks` 第 4 个绑定位插入 `due_date`（`task-records.ts`） | UNIT 3/30 | 既有的「按位置读第 3、4 个参数」格与本片两格 | 相同 |

没有做、或做了但等价的变异：M05「有时间无日期」那条显式检查改成恒假 —— 其后 `canonicalTime(null, time)` 经 `computeDueAt` 抛出同样给 `invalid_date`，等价变异，未计；`timeZone` 非字符串的类型闸改成恒假 —— `validateViewerTimeZoneHeader` 对非字符串本来就返回 `null`，等价，未计；请求体是数组时按 `{}` 处理 —— 数组的 `expectedVersion` 同样是 `undefined`，落在同一个 422，等价，未计；`UPDATE … WHERE version = $2` 命中 0 行的 409 兜底在结构锁下不可达，没有变异（§S4.7）。全部结束后 `git status` 只有本片的改动（`src` 无残留），`runSourceMutant` 的临时文件已删。

### S4.5 前端兼容性

对照 `origin/claude/tasks-m3-frontend` 的 `apps/web/src/tasks/tasksApi.ts` 与 `TasksView.vue`（S3 核对时的 head `3efa17c3b6`，本片只读源码、没有在浏览器里跑）：

- `createTask` 只发 `title` / `assignees` / `completionMode`，只读响应里的 `id`；新键都是可选的，多出的 `version` 不读。M3 前端不会发日期键，所以不会撞上 `TIME_ZONE_REQUIRED` 等新码。
- `complete` / `reopen` 只读 `done` / `ok`（设计 §5.4）；多一个 `version` 键不影响。
- 详情解析忽略未知键（设计 §5.5）：`description` `startDate` `startTime` `remindAt` 对 M3 前端不可见。
- `PATCH /api/tasks/:id` 是新路径，M3 前端不调用；`GET /api/tasks/:id` 的 `version` 在 M3 已有，M4 前端拿它当 `expectedVersion`。

前端在 M4 需要认识的新错误码：`INVALID_VERSION`、`VERSION_CONFLICT`（409，体里另有 `currentVersion`，是唯一在 `error` 之外带字段的错误体）、`INVALID_DESCRIPTION`、`INVALID_DATE`、`INVALID_TIME_ZONE`、`TIME_ZONE_REQUIRED`、`INVALID_REMIND_AT`（后四个在 POST 与 PATCH 都会出现）。

### S4.6 与设计的偏差、对草稿的改动

1. **`isStorableText` 搬到 `src/tasks/task-ids.ts`**（`services/task-create.ts` re-export，既有 importer 与 M3 测试不变）。草稿让 `src/tasks/task-edit.ts` 从 `../services/task-create` 引入；门 20 是行为检查、不会因此变红，但纯函数层反向依赖服务层不合 §4.1 的分层，改成同层引入。
2. **`''` 时区读作 `null`（`[own-29]`）。** 草稿把 `''` 判成 `INVALID_TIME_ZONE`；设计 §5.1 的时区规则写的是「必须在同一请求里带非空 `timeZone`，否则 `TIME_ZONE_REQUIRED`」，按这句改：有日期时 `''` 是 `TIME_ZONE_REQUIRED`，无日期时 `''` 清空时区；空白串等其他非时区字符串仍是 `INVALID_TIME_ZONE`（`validateViewerTimeZoneHeader` 会 trim，所以空白串走的是它的 `null`）。
3. **库里存着平台不再接受的时区时，PATCH 给 422 `INVALID_TIME_ZONE` 而不是 500。** `planTaskDates` 每次都重算 `due_at`，对一条只改标题的 PATCH 也会用库里的时区调 `computeDueAt`；草稿会让这个 `RangeError` 冒到路由变成 500。改为在纯函数里接住给 `invalid_time_zone`，调用方换一个时区即可继续。这是实现上的处理方式，不是新取值，没有另起标签。
4. **`remindAt` 的文法（`[own-30]`）比设计的一句话更窄**：大写 `T` / `Z`、小数至多三位、`±HH:MM` 必须带冒号、真实日期、换算后年份 0001–9999。宽松形态（小写、空格分隔、无冒号偏移、`+08`）都是 `INVALID_REMIND_AT`。草稿已如此，保留并钉住（M30）。
5. **`description` 不做 NFC 归一（`[own-31]`）**：设计 §5.1 只写「不做修剪」；标题走 `normalizeUserText`（NFC + 修边），描述原样存。草稿已如此，保留。
6. **请求体是数组时按 `{}` 处理**（设计 §5.3「不是对象按 `{}`」）：草稿用「普通对象」判定，数组落到 `INVALID_VERSION`。与 S3 的设置 PATCH（数组体 ⇒ `INVALID_SETTINGS`）不同，各按各的设计句执行。
7. **门 8 负控一改写的是两行 needle**（`/pending` 与 `/pending-count` 各一）：设计 §10.5 写「沿用那两行 needle」，`runSourceMutant` 原来只改第一处（`String.replace`），为此给 helper 加了 `all` / `count` 两个可选项；缺省行为不变，S2 / S3 的调用不受影响。
8. **`tests/unit/tasks-route-errors.test.ts` 加了 PATCH 的格**（设计 §13 S4 的文件清单没有它）：它是 `sendError` 落点的直接证明位置，PATCH 多了一个 409 分支，需要钉住「其余错误仍走 `INTERNAL`」。
9. **「非编辑者 404」用同 org 无角色者与 follower 各一格**（设计 §10.6 只写「非编辑者」）；负责人作为正控（`assignee` 有 `edit`）。
10. **草稿保留未改的部分**：`task-patch.ts` 的顺序与 SQL、`createTask` 的校验位置与绑定顺序、`getTask` 的四键、complete / reopen 的 `version`、`loadRemindPolicy`、路由，以及四处既有断言的更新。逐项对照设计 §5.1–§5.5、§4.2–§4.5 后没有发现偏离。
11. **`tests/integration/task-p0a.db.test.ts` 的详情 `toEqual`** 现在含四个新键；S7 加 `listIds` 时要再改这一处。

### S4.7 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG15.17（同 §S1.9）。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- 门 8 A 支只在一种极性下跑过（三遍 lane 都在 UTC 17–18 时之间：任务时区答案 1、UTC 答案 0）；另一极性（UTC 小时 < 16）的判别力只由夹具里的运行期断言（两种回退的期望值不相等、显式 `UTC` 头得到另一个答案）保证，没有实际观察过。翻转点前 2 分钟的等待分支也没有被触发过。
- `UPDATE … WHERE id = $1 AND version = $2` 命中 0 行时的 409 兜底：结构锁下不可达，没有格、没有变异。
- 两个并发 PATCH 的格证明的是「恰一个 200 一个 409」；哪一个赢由锁的排队决定，没有断言次序。
- `PATCH /api/tasks/:id` 的 `tasks:write` 守卫与缺 org 之外的门 1 / 2 / 16 三件事：本片只在 `RBAC_TOKEN_TRUST='true'` 下用带 `tasks:write` 的用户打过；trust-off 配置下的非 admin 三件事与路由人口枚举按设计随 S10（`M4_ROUTES`）。在那之前把它的守卫改成 `'read'` 的变异会存活。
- M3 前端没有在浏览器里对着本片后端跑过；§S4.5 只来自读源码。
- `express.json()` 的请求体上限没有为 20000 码点的描述单独验证：本片的 HTTP 格用 20000 个 emoji（约 80 KB 的 JSON）在测试的 express 实例上通过；`MetaSheetServer` 自己的 body 上限没有查。
- 门 19 的 M2 / M4 抽取命令本片没有重跑（本片没有动 `gate19` / `gate19m4` 格与抽取 helper；两组格都在 lane 里通过）。

### S4.8 给 S5 的交接

- 写路径的样板：`task-patch.ts` 是「`withOrgStructure` → 按 id 取行（`buildTaskByIdCondition`，非可打印 id 先 404）→ `loadRowRoles` + `can` → 请求体 → 纯函数 → 一条 `UPDATE` + 事件」的最小实例；瞬时用 `isoOrNull`（`task-records.ts` 导出）以 ISO 文本绑 `::timestamptz`。
- `runSourceMutant` 现在有 `all`（改写每一处）与 `count`（断言出现次数）；需要「全换」的负控用它，不要再手写。
- lane 现在 11 文件 465 格；`task-m4-dates` 的门 8 A 支三格在距 UTC 16:00 / 00:00 不足 2 分钟时会等到翻转点过去（最多约 2 分钟），单格超时 9 分钟；CI 的 `timeout-minutes: 25` 够用，本地跑 lane 时若恰在整点前后见到这几格变慢，是等待而不是挂起。
- 新错误码见 §S4.5 末段；S5 的清单路由不要复用 `VERSION_CONFLICT`（清单没有 `version` 列，设计 §4.4）。
- `POST /api/tasks` 与 `PATCH /api/tasks/:id` 现在都会在有截止日时读 / 写 `remind_at`；PR-3b 的扫描下界取最近一条 `created` / `remind_changed` 的 `occurred_at`，本片的事件写法（PATCH 事件不带 `occurred_at`，取事务 `now()`）满足它。
- S10 的 `M4_ROUTES` 要把 `PATCH /api/tasks/:id`（write，体 `{ expectedVersion: 1 }`）算进 30 条新路由；`tests/tasks-auth/tasks-auth-gate.ts` 本片没有动。
- `tests/integration/task-p0a.db.test.ts` 的详情 `toEqual` 在 S7 加 `listIds` 时要再改。
- 变异脚本在私有工件目录，需要复用时照 §S4.4 的表重建即可。

## S5 清单核心

基于 `aafa05f2d5`（S4 之后）。代码提交 `fd1399bc05`（路由、服务、纯函数、56 格真库文件、鉴权门一格、单测）；变异证明之后补了 8 格并把一个平局格改成确定性的，提交 `54f7f5990a`（只改两份测试文件）；本节随后以只改本文件的一条提交追加。本地一次性库只用 `m4e_*` 前缀：`m4e_lane`（lane、鉴权门、全部变异），`m4e_final`（最终 head 从空库全量迁移后复跑）；两者在工作结束时均已 `DROP DATABASE`。`node_modules` 仍是符号链接，本片没有改动任何符号链接、没有跑 `pnpm install`。变异脚本、mutant 定义与逐个日志放在私有工件目录。

### S5.1 交付内容

| 文件 | 内容 |
|---|---|
| `packages/core-backend/src/tasks/task-list-access.ts`（新，纯函数） | 私有 `taskListOrgClause(rest)`：`(task_lists.org_id = ${ORG_PLACEHOLDER}) AND ` 这段文本在文件里恰出现一次（D8 单点发射；负控 2 与鉴权门清单格的 needle）。`buildTaskListScopeCondition({ actorParam, orgParam, includeArchived })`：`$1` 调用者、`$2` org，成员 `EXISTS`，`includeArchived` 不是恰好 `true` 时追加 `archived_at IS NULL`。`buildTaskListByIdCondition({ listIdParam, orgParam })`：`$1` 清单 id、`$2` org，不看归档。排序键 `TASK_LIST_PAGE_SORT_KEY = 'task_lists.updated_at DESC, task_lists.id DESC'` 与 `TASK_LIST_EVENT_PAGE_SORT_KEY = 'task_list_events.occurred_at DESC, task_list_events.id DESC'`。不 import 任何东西。 |
| `packages/core-backend/src/tasks/task-lists.ts`（末尾追加） | `parseTaskListName(raw)` = `validateTaskListName` 再加 `isStorableText`（U+0000、孤立代理项 ⇒ `invalid_name`，与任务标题同一规则；任务 D 的 `validateTaskListName` 只修边与计码点，不查这一条）；`applyRenameList({ currentName, name, actorId })`（同名 ⇒ `changed: false`、无事件；否则一条 `renamed`），事件类型单列为 `TaskListRenameEvent`，没有改动任务 D 已有的 `TaskListEventType` 联合；`parseIncludeArchived(raw)`（缺省或恰为 `'false'` ⇒ 不含，恰为 `'true'` ⇒ 含，其余 ⇒ `invalid_filter`）。`isStorableText` 从同层 `./task-ids` 引入。任务 D 已有的函数一个没动。 |
| `packages/core-backend/src/tasks/task-groups.ts`（末尾追加） | `TASK_DEFAULT_GROUP_NAME = '默认分组'`。 |
| `packages/core-backend/src/services/task-list-records.ts`（新） | `createTaskList`：名字在开事务之前校验；`withOrgStructure` 内依次写清单行、调用者的 `owner` 成员行、默认组（`scope='list'`、`position 0`、`is_default`）、`created` 事件，再按 id 读回。`getTaskList`；`listTaskLists`（先分页后 `includeArchived`；`{ items, total }`，`total` 是同一条件的 `count(*)`）；`renameTaskList`；`setTaskListArchived`（`archived_at` 取事务里 `SELECT now()` 的值，与 `updated_at`、事件 `occurred_at` 是同一瞬时）【更正：这一句不成立。那个值经 JS `Date` 往返只剩毫秒，库里 `archived_at` 比 `updated_at` 早不到 1 毫秒；三者又都是等锁之前的事务开始时刻。已改为锁后一次 `clock_timestamp()`，见「S5 闸修复」】；`listTaskListEvents`。读路径用 `plainDb`，不进事务、不取锁。 |
| `packages/core-backend/src/routes/tasks-lists.ts`（新） | `registerTaskListRoutes(router)`：7 条路由直接注册在 `tasksRouter()` 的同一个 `router` 上；静态段（`/api/task-lists`、`…/:id/events`、`…/:id/archive`、`…/:id/unarchive`）写在 `/:id` 之前。全部 `authenticate` + `rbacGuard('tasks', 'read' \| 'write')`；没有 `tasks:admin`；没有 `DELETE`。 |
| `packages/core-backend/src/routes/tasks.ts` | 一行 import；`registerTaskSettingsRoutes(router)` 之后独占一行的 `registerTaskListRoutes(router)`（门 13 负控的改写点，恰出现一次）。 |
| `packages/core-backend/tests/integration/task-m4-lists.db.test.ts`（新） | 见 §S5.2。登记三处：`vitest.config.ts` exclude 裸字面量、`tasks-realdb.yml` 清单、文件顶部 `assert-rbac-optional-off`。 |
| `packages/core-backend/tests/tasks-auth/tasks-auth-gate.ts` | 新增一格「清单第二租户读」（设计 §10.7，从 S10 提前，见 §S5.3、§S5.6-1）；收尾 sweep 多一句删 `task_lists`。没有加 `M4_ROUTES` 与路由人口格。 |
| `packages/core-backend/tests/unit/task-list-access.test.ts`（新） | 6 格：两个构造器三种输出的文本快照；每个输出里 `task_lists.org_id = $2` 恰一次；`includeArchived` 只在恰为 `true` 时去掉归档过滤；绑定值不内联；两个排序键。 |
| `packages/core-backend/tests/unit/task-lists.test.ts` | 追加 25 格：`parseTaskListName` 11（接受与规范化、6 种 `invalid_name`、`name_too_long`、3 种不可存文本）；`applyRenameList` 2；`parseIncludeArchived` 12（3 种合法、9 种 `invalid_filter`）。 |
| `packages/core-backend/tests/unit/task-records-guards.test.ts` | 追加 4 格：`createTaskList` 6 种非法名字 422 且事务数 0、零语句；建清单的语句顺序（`SET TRANSACTION …` → 结构锁 → 清单 → 所有者行 → 默认组 → `created` 事件）；三个写在清单不存在时首句是 `SET TRANSACTION …`、404 先于请求体、没有写语句；4 种不可存清单 id 对四个服务函数都是 404，且没有任何语句以该 id 为参数。 |
| `packages/core-backend/tests/unit/tasks-route-errors.test.ts` | 追加 8 格：7 条清单路由各一格「驱动错误 ⇒ 500 `INTERNAL`、不回显」；一格「路由把路径 id、原始请求体、原始 query 值原样交给服务」。 |
| `scripts/ops/global-history-flag-manifest.mjs` | `TASKS_ENABLED` 的 `purpose` 追加 `/api/task-lists`（§13 S5）；同处注释改为「剩下的一个前缀随它的路由追加」（`/api/task-groups`，S8）。 |
| `packages/core-backend/vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 各加一行新文件。没有改其他 workflow。 |

**行级判定顺序**（每条 `/:id` 路由走同一个 `loadMemberList`）：缺 org（路由层：写 422 `ORG_MISSING`；`GET /:id` 与 `/events` 404）→ 路径 id 不可打印 ⇒ 404，不发 SQL → 按 id 与 org 取清单行（`buildTaskListByIdCondition`），没有 ⇒ 404 → 调用者在该清单没有成员行 ⇒ 404 → `canListAction({ role, isCreator: createdBy === actor }, action)` 为假 ⇒ 404 → 请求体 / 分页 ⇒ 422 → 纯函数 → 写行与事件。写路由的这几步都在 `withOrgStructure` 里、锁之后。成员行判定是显式的一步，排在 `canListAction` 之前：`canListAction({ role: 'none', isCreator: true }, 'archive')` 为真，只靠它，没有成员行的清单创建人也能归档（变异 L01 证明）。

S5 的路由还读 `task_lists`、`task_list_events`、`task_groups`；它们与 smoke preflight 探测的三张表出自同一条迁移，preflight 不需要再加表。

`ASSUMPTION(task-m4)` 标签：`[R13]`（没有 `DELETE`）、`[R18]`（不用 `tasks:admin`）、`[R19]`（`/events`）、`[R11]` `[own-12]`（默认组随建清单落行）、`[D8]`（单点 org 子句）、`[D9]`（排序键）、`[own-01]`（占位）、`[own-04]`（写进结构锁）、`[own-09]`（行级一律 404）、`[own-10]`（分页先于过滤）、`[own-15]`（`includeArchived`）、`[own-19]`（缺 org 的三种答法）。本片新起五个编号（S4 止于 `[own-31]`），都是设计里没有定值的地方，待 owner 裁：

- **`[own-32]`** `includeArchived` 的取值集合：只认恰好的 `'true'` / `'false'` 或缺省；`''`、`TRUE`、`1`、`yes`、重复键（数组）、嵌套键（对象）一律 422 `INVALID_FILTER`；与分页同时非法时报分页的码。
- **`[own-33]`** `GET /api/task-lists/:id/events`：缺 org 是 404（不是集合降级体）；非成员是 404，先于分页的 422（成员带非法分页才是 422）。两点都照 M3 `GET /api/tasks/:id/comments` 的现状：它也是挂在单个对象下的集合，缺 org 404、先 `view` 后分页。设计 §3.0 的「集合型读路由 200 降级」按字面也可以读成适用于它；本片按 M3 的先例取 404。
- **`[own-34]`** 默认组名 `'默认分组'`（`TASK_DEFAULT_GROUP_NAME`，两种 scope 共用）。
- **`[own-35]`** 两个排序键：清单按 `updated_at DESC, id DESC`（改名、归档、取消归档会把清单排到前面；成员与清单项的变化不碰 `updated_at`，§4.4，所以不会）；动态按 `occurred_at DESC, id DESC`。
- **`[own-36]`** `created` / `renamed` / `archived` / `unarchived` 四种清单事件的 payload 是 `{}`（不带新旧名字）。设计 §4.3 只给了成员事件（`{ targetUserId }`）与分组事件（`{ groupId }`）的 payload。

### S5.2 `task-m4-lists.db.test.ts`

org 前缀 `org_tasks_m4lcore_`：与 `m4roles_` / `m4page_` / `m4dates_` 以及以后 S6–S8 可能取的 `m4list…` 类前缀都不会被对方的 `LIKE 'prefix%'` 命中。参与者用 `seedTaskActor`，`afterAll` 用 `dropTaskM4Fixtures`。HTTP 经 `tasksRouter()` 挂在 express 上（`RBAC_TOKEN_TRUST='true'`）；门 13 两格用真实 `MetaSheetServer`。本片的路由造不出来的清单（创建人以外的成员、他 org 的清单、创建人没有成员行的清单、已归档的种子）用 SQL 直接播种。凡期望 404 的格，都把 `response.text` 与「不存在的清单 id」的响应逐字节比较；写格另比较整个 org 的清单行、成员行、清单事件、分组行与 `task_events` 计数（`orgState`），前后必须相同。

| 组 | 格数 | 内容 |
|---|---|---|
| 建 | 13 | 200 体 `toEqual` 整个 `List`：`id` 形如 `tlst_…`；名字修边；`ownerId` 与 `myRole: 'owner'`；`archivedAt: null`；两个时间与库一致。库里恰一行 `owner` 成员；恰一个默认组（`scope='list'`、`list_id`、`user_id` 空、名字是常量、`position 0`、`is_default`）；恰一条 `created` 事件（actor 是调用者、payload `{}`、`occurred_at` = `created_at`）；`icon` 为空。100 码点名字接受，`Café` 存成 NFC。10 种非法体逐格 422，整个 org 零变化：缺键、`''`、空白、数字、`null`、数组名、数组体、U+0000、孤立代理项 ⇒ `INVALID_NAME`；101 码点 ⇒ `NAME_TOO_LONG`。缺 org：合法体与非法体都 422 `ORG_MISSING`，零行。 |
| 读 | 4 | `owner` / `edit` / `read` 三个成员读到同一张清单，各自的 `myRole`，`ownerId` 是所有者；同 org 非成员 404，逐字节同不存在；4 种不可存路径 id（`tlst_%00`、真 id 后接 `%00`、含空格、非 ASCII）与缺 org 都是同一个 404；创建人没有成员行 ⇒ 404。 |
| 我的清单 | 15 | 只列本 org 里本人是成员的清单（所有者、`read` 成员两种都列；别人的清单、他 org 的清单不列；已归档的缺省不列）。缺省与 `includeArchived=false` 相同，`true` 时含已归档。项形状 `toEqual`。翻页：5 张清单按 id 升序插入、同一个 `updated_at`，`limit=2` 三页不重不漏，顺序 = id 降序；越过末尾是 `{ items: [], total: 5 }`。12 种非法 query 逐格 422：分页 5 种、`includeArchived` 6 种、两者都非法时报 `INVALID_LIMIT`。缺 org：三种 query（含非法分页、非法过滤）都是逐字节相同的降级体，没有 `total`。 |
| 改名 | 10 | `edit` 与 `owner` 都能改：修边存储；`updated_at` 前移且与响应一致；事件依次是 `created`、`renamed`（edit）、`renamed`（owner），payload `{}`。同名（修边与 NFC 之后相同也算）是空操作：200，体不变，整个清单状态逐字节不变。6 种非法名字 422，清单不变。`read` 成员与同 org 非成员对 4 种体（合法、空名、超长、缺键）都是逐字节同不存在的 404（不是 422），整个 org 零变化。缺 org 422。 |
| 归档 | 7 | `edit` 成员归档：体 = 建清单的体加上 `archivedAt`、新的 `updatedAt`、`myRole: 'edit'`；库里 `archived_at` = `updated_at` = 事件 `occurred_at`（当时的格按毫秒比较，看不出微秒差；更正见「S5 闸修复」，现在在 SQL 里比较）。重复归档 200，体与清单状态都不变；取消归档、重复取消归档同理；事件恰为 `created`、`archived`、`unarchived`。`read` 成员与非成员对未归档、已归档两张清单的两条路由各 404，逐字节同不存在，零变化。创建人是 `read` 成员时可以归档与取消归档（`myRole` 仍是 `read`），但改名仍 404。创建人**没有成员行**时，归档与取消归档都是 404，零变化。缺 org 两条路由 422。归档格：负责人（同时是清单成员）有一条昨天到期的全天任务在清单里；归档前 `/pending` 的 `total` 为 1、`/pending-count` 为 `{ count: 1 }`、`view=assigned` 含它、详情 200；归档后四者逐项相等，清单详情仍 200，`archivedAt` 与归档响应一致。负控 3 见下。 |
| 动态 | 3 | 建、改名、归档、取消归档之后，`read` 成员取 `/events`：`total` 4，顺序 `unarchived, archived, renamed, created`，另一张清单的 `created` 不在；`created` 那一项 `toEqual` `{ id, listId, actorId, eventType, payload: {}, occurredAt }`，与库一致。翻页：4 条同一 `occurred_at` 的 SQL 种子（id 升序插入）加 1 条 `created`，`limit=2` 三页 = `ORDER BY occurred_at DESC, id DESC`。非成员对不带分页、`limit=0`、`offset=-1` 都是逐字节同不存在的 404；成员 `limit=0` ⇒ 422 `INVALID_LIMIT`，`offset=-1` ⇒ `INVALID_OFFSET`；缺 org 404。 |
| 权限码与 R13 | 8 | 7 条路由各一格：调用者是该清单的 `edit` 成员，但角色只有另一个码（写路由只有 `tasks:read`，读路由只有 `tasks:write`）⇒ 403 `{ error: 'Insufficient permissions' }`，整个 org 零变化；同一请求换成只有本路由那个码的成员 ⇒ 200。`DELETE /api/task-lists/:id` ⇒ 404，清单状态不变，`tasksRouter().stack` 上 `/api/task-lists` 与 `/api/task-lists/:id` 两条路径都没有 `delete` 方法。 |
| 第二租户·清单 | 2 | 同一用户在 org A 的 LA、org B 的 LB 都是 `edit` 成员，两张清单除 `org_id` 外同形；token 是 org A：`GET /api/task-lists` 恰为 `[LA]`，`GET /LA` 200；`GET /LB`、`/LB/events`、`PATCH /LB`、`/LB/archive`、`/LB/unarchive` 都是逐字节同不存在的 404，org B 零变化；正控：换 org B 的 token，`GET /LB` 200。**负控 2**：`runSourceMutant` 把 `task-list-access.ts` 里恰一次的 `(task_lists.org_id = ${ORG_PLACEHOLDER}) AND ` 改成 `(${ORG_PLACEHOLDER}::text IS NOT NULL) AND `（`$2` 仍被引用），子进程以 org A 的 token 取 `GET /LB` 与「我的清单」，两处都判定变红；输出 `{"nc2":"red",…}`。设计 §10.4 这一行还写了 `/items`：那条路由在 S7，本片用 `/events` 与「我的清单」作读面，`/items` 的第二租户格随 S7。 |
| 门 13（清单） | 2 | 正控：真实 `MetaSheetServer` 上只有 `tasks:read` 的非 admin 打 `GET /api/task-lists` ⇒ 200，只含他那一张；`/api/task-lists-not-a-route` ⇒ 404。负控：`runSourceMutant` 把 `routes/tasks.ts` 里恰一次的 `  registerTaskListRoutes(router)` 注释掉，子进程新建 `MetaSheetServer`：`/api/task-lists` ⇒ 404、`/api/tasks/context` ⇒ 200；输出 `{"gate13lists":"red","lists":404,"context":200}`，文件逐字节还原。 |

**负控 3**（归档组最后一格）：清单已归档（SQL 种子）时，不变异先断言 `listPending` 含该任务、`countPending` 为 1、`view=assigned` 含它；再 `runSourceMutant` 在 `task-access.ts` 里恰一次的 `tasks.status = 'open'` 后面接上「所属清单都未归档」的 `NOT EXISTS`（新别名，不含反引号与 `${`），子进程里 `listPending` 0 行、`countPending` 为 0；输出 `{"nc3":"red","rows":0,"count":0}`。这一格与上面的归档格是两份同形夹具：归档格经路由归档，负控 3 用 SQL 种子。

静态展开数：13 + 4 + 15 + 10 + 7 + 3 + 8 + 2 + 2 = **64**；最终 head 上四遍 verbose 日志（`m4e_lane` 三遍、`m4e_final` 一遍）都收集并通过 64（门 17 ②）。

### S5.3 鉴权门：清单第二租户读格（trust-off）

`tasks-auth-gate.ts` 新增一格 `gate 1 (M4 lists): a list read stays inside the caller org until the list org predicate is removed`，写法与注释格式照该文件现有的门 1 隔离读格：

- 夹具：一个用户，`user_orgs` 只有 org A 一行（`is_active = true`）；角色只带 `tasks:read`；有 admission。清单 LA（org A）与 LB（org B）除 `org_id` 外同形：各有一个创建人（`owner`），该用户在两张清单里都是 `edit` 成员，各含一条同形任务。全部由 SQL 播种。token 的 `tenantId` 为 org A，不带 `perms`。
- 前置在用例上方的注释里逐条标注：a–d、f–i 适用；e 不适用（读格）；b 适用（`user_orgs.org_id` = token 的 `tenantId` = org A，`RBAC_TOKEN_TRUST=false` 下经 DB 核对）。行名写的是设计 §10.0 的候选行 `M4|1|清单第二租户`，注明未入锁、未计分。
- 正控先跑：`GET /api/task-lists` 恰为 `[LA]`；`GET /api/task-lists/LA` 200；`GET /LB` 与 `GET /LB/events` 404，体与不存在的清单 id 逐字节相同。
- 负控：断言 needle 恰一次 → `cp` 备份 → 改成 `(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ` → tsx 子进程直接调 `listTaskLists` 与 `getTaskList`（org 参数 A）→ `finally` 还原并断言逐字节相同。两个读面分别判定，都变红才算证红：输出 `{"gate1lists":"red",…}`。

鉴权门由 23 格变为 **24 格**。`tasks-auth-ci-wiring.test.mjs`（单文件、无 `.skip(`、配置与 setup 的字面量）3/3。

### S5.4 命令与结果

所有命令在 `packages/core-backend` 下，`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/m4e_lane EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`。两个库都从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项；M4 迁移不在排除里），各 422 条 executed successfully。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | 0 errors（`fd1399bc05` 与 `54f7f5990a` 各一次） |
| 本片单测 | `vitest run tests/unit/task-lists.test.ts tests/unit/task-list-access.test.ts tests/unit/task-records-guards.test.ts tests/unit/tasks-route-errors.test.ts` | 4 files / 147 passed |
| 门 20 + 三集合枚举 | `vitest run tests/unit/task-pure-no-io.test.ts tests/unit/task-ci-coverage-enumeration.test.ts` | 2 files / 9 passed（`task-list-access.ts` 进入门 20 的扫描人口；新文件已在三处登记） |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 5 failed \| 1065 passed \| 173 skipped (1243)；Tests 44 failed \| 18270 passed \| 1665 skipped (19979)**。用例总数 19979 = S4 的 19936 + 本片新增 43（6 + 25 + 4 + 8）；passed + failed = 18314 = S4 的 18271 + 43。44 个失败全部在 5 个与本片无关的文件里，原因是本机环境，见下段。 |
| 真库 lane × 3（12 文件，`tasks-realdb.yml` 清单，最终 head） | `vitest --config vitest.integration.config.ts run <12 files> --reporter=verbose` | 三遍均 **Test Files 12 passed；Tests 529 passed；0 failed**（465 + 64），每遍 39–196 秒。逐文件：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m3-comments-deletion 32、m4-schema 54、m4-list-roles 44、m4-paging-settings 72、m4-dates 100、**m4-lists 64** |
| 最终 head、新库 `m4e_final` | 同上一遍 + 鉴权门一遍 | 12 files / 529 passed；鉴权门 24/24。跑完查 `m4e_lane` 与 `m4e_final`：`tasks`、`task_lists`、`task_list_events`、`task_groups`、`task_user_settings` 与种子用户都是 0 行。 |
| 鉴权门 | `DATABASE_URL=… vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false` 由配置给） | **24/24**（`fd1399bc05` 与 `54f7f5990a` 各一遍，另在 `m4e_final` 上一遍） |
| ops 脚本测试（仓库根） | `node --test scripts/ops/global-history-flag-manifest.test.mjs scripts/ops/multitable-recovery-schema-containment.test.mjs`；`node --test scripts/ops/tasks-auth-ci-wiring.test.mjs`；`node --test scripts/ops/staging-tasks-smoke.test.mjs` | 76/76；3/3；19/19 |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫本片新增 / 改动的全部 15 个文件，以及本文件 | 均退出 0 |

**全量单测里的 5 个失败文件与本片无关**（都不 import 任何本片改动的模块，源码也不在本片 diff 里）：

- `multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup`（43 格）：`recovery-archive-file-store.ts` 的 `checkedDirectory` 在 darwin 上只接受 `statfs` 类型 25，本地临时目录所在卷报 26（`fs.promises.statfs(...).type`）。把 `TMPDIR` 换成另一处真实目录结果相同，43 failed / 48 passed。该文件最后一次改动是 2026-09-16，S4 当时这四个文件全绿。
- `attendance-admin-plugin-lib-dist-layout-boot`（1 格）：`ELOOP`。规范检出里 `plugins/plugin-attendance/node_modules/node_modules` 是指向它自己所在目录的符号链接（2026-10-01 06:36 建，晚于 S4 的那次全量运行），本 worktree 的 `plugins/plugin-attendance/node_modules` 今天 08:08 被重建为指向那里。按指令不碰任何 `node_modules`，留给 owner 处理。

M2 门 8 的路由 mutant（rbac-trust）、门 19 的两个探针（read-path）、门 4、S2 的三个 mutant、S3 与 S5 的门 13 负控、S4 的门 8 两个负控、S5 的负控 2 与负控 3，都在上面每一遍 lane 里，均绿：本片没有改 `task-access.ts`（负控 3 只在子进程运行期间临时改写它，随后逐字节还原），needle 计数与 §S2.3 相同；`routes/tasks.ts` 的 `/pending-count` 两行 needle 未动。

### S5.5 变异证明

在文件内（每遍 lane 都跑）：负控 2（清单 org 谓词）、负控 3（pending 加归档过滤）、门 13 清单负控（注册行注释掉）；鉴权门里清单第二租户格的 org 谓词负控。

手工（私有工件目录里的脚本：断言 needle 恰一次 → 备份 → 改写 → 跑 → 还原 → 逐字节比较；逐个串行，不与其他 vitest 进程并行）。DB = `task-m4-lists`（L01–L31 跑在 56 格版本上，L20 / L29 复跑与 L32–L38 跑在 64 格版本上）；UNIT = `task-lists` + `task-list-access` + `task-records-guards` + `tasks-route-errors`（147 格）。

| # | 变异（文件） | 失败 | 变红的格 | 还原 |
|---|---|---|---|---|
| L01 | 删掉「没有成员行 ⇒ 404」那一行（服务） | DB 6/56 | 创建人无成员行的读格与归档格；同 org 非成员读；`read` 成员与非成员的改名、归档；非成员读动态（角色成了字符串 `'null'`，`canListAction` 抛 `TypeError` ⇒ 500） | 相同 |
| L02 | `isCreator` 恒为 false（服务） | DB 1/56 | 创建人以 `read` 角色归档格 | 相同 |
| L03 | 改名先校验请求体、后判能力（服务） | DB 1/56 | `read` 成员 / 非成员改名格（`read` 成员的非法体变 422） | 相同 |
| L04 | 改名用 `view` 判定（服务） | DB 2/56 | `read` 成员改名格；创建人以 `read` 角色改名应为 404 的那一步 | 相同 |
| L05 | 去掉名字的可存文本规则（纯函数） | DB 4/56；UNIT 4/147 | 建与改名的 U+0000（500）与孤立代理项四格；三格纯函数单测与「事务数 0」单测 | 相同 |
| L06 | 去掉路径 id 的可打印检查（服务） | DB 1/56；UNIT 1/147 | 不可存路径 id 格（`%00` 变 500）；「没有语句携带该 id」单测 | 相同 |
| L07 | 去掉改名的空操作守卫（服务） | DB 1/56 | 同名空操作格（`updated_at` 变了） | 相同 |
| L08 | 去掉归档的空操作守卫（服务） | DB 1/56 | 归档 / 取消归档格（重复时 `updated_at` 变了） | 相同 |
| L09 | `applyRenameList` 恒判为变化（纯函数） | DB 1/56；UNIT 1/147 | 同名空操作格（多一条 `renamed`）；同名单测 | 相同 |
| L10 | `includeArchived` 缺省时也含已归档（纯函数） | DB 1/56；UNIT 2/147 | 「我的清单」格；两格单测 | 相同 |
| L11 | 未知 `includeArchived` 回落成缺省（纯函数） | DB 6/56；UNIT 9/147 | 6 个 `INVALID_FILTER` 格；9 格单测 | 相同 |
| L12 | 「我的清单」的 `total` 改成本页条数（服务） | DB 1/56 | 翻页格 | 相同 |
| L13 | 动态的 `total` 改成本页条数（服务） | DB 1/64（复跑并留日志） | 动态翻页格（`expected 2 to be 5`）。首跑记为 3/56，多出的两格（非成员动态格、第二租户格）不读 `total`，复跑没有再现；首跑没有留日志，按未再现记，不算击杀依据 | 相同 |
| L14 | 「我的清单」去掉成员 `EXISTS`（纯函数） | 首跑 DB 5/56、UNIT 2/147，但其中包含 `$1` 不再被引用导致的 500；改写为保留 `$1` 的 L14b 后 DB 1/64 | L14b：「我的清单」格；两格快照单测 | 相同 |
| L15 | 不插默认组（服务） | DB 1/56；UNIT 1/147 | 建清单格；语句顺序单测 | 相同 |
| L16 | 不插所有者成员行（服务） | DB 18/56；UNIT 1/147 | 所有经路由建清单的格（读回 404）；语句顺序单测 | 相同 |
| L17 | 不写 `created` 事件（服务） | DB 5/56；UNIT 1/147 | 建、改名、归档、两个动态格；语句顺序单测 | 相同 |
| L18 | 动态不按清单过滤（服务） | DB 2/56 | 两个动态格（别的清单的事件混进来） | 相同 |
| L19 | 动态排序去掉 id 平局键（纯函数） | DB 1/56；UNIT 1/147 | 动态翻页格；排序键单测 | 相同 |
| L20 | 清单排序去掉 id 平局键（纯函数） | 首跑 DB **0/56**、UNIT 1/147；把翻页格改成「5 张清单 id 升序插入、同一个 `updated_at`」之后复跑 DB 1/64 | 首跑只有排序键单测变红：当时的翻页格用随机 id、只有 3 张同时刻，碰巧排对；改格后翻页格变红 | 相同 |
| L21 | 动态先解析分页、后取清单（服务） | DB 1/56 | 非成员动态格（`limit=0` 变 422） | 相同 |
| L22 | 归档 / 取消归档用 `view` 判定（服务） | DB 1/56 | `read` 成员 / 非成员归档格 | 相同 |
| L23 | 归档瞬时取 JS 时钟（前移 5 秒）（服务） | DB 1/56 | 归档格（`archived_at` ≠ `updated_at`） | 相同 |
| L24 | 改名不写 `updated_at`（服务） | DB 1/56 | 改名格 | 相同 |
| L25 | 归档不写 `updated_at`（服务） | DB 1/56 | 归档格 | 相同 |
| L26 | `myRole` 恒为 `owner`（服务） | DB 13/56 | 所有看 `myRole` 的格与非成员 404 的各格 | 相同 |
| L27 | `ownerId` 取 `edit` 行（服务） | DB 5/56 | 建、读、我的清单、改名、归档格 | 相同 |
| L28 | 建清单的名字校验挪进事务（服务） | UNIT 1/147 | 「事务数 0」单测（HTTP 结果不变，只能由单测证） | 相同 |
| L29 | `POST /api/task-lists` 的守卫改成 `tasks:read`（路由） | 首跑 DB **0/56**、UNIT 0/147（存活）；补了权限码格后复跑 DB 1/64 | 该路由的权限码格 | 相同 |
| L30 | 动态缺 org 改成降级体（路由） | DB 1/56 | 非成员动态格的缺 org 那一步 | 相同 |
| L31 | 名字不规范化，存原串（纯函数） | DB 4/56；UNIT 2/147 | 建（修边）、100 码点 / NFC、改名、同名空操作格；两格单测 | 相同 |
| L32 | `PATCH /:id` 守卫改成 `tasks:read`（路由） | DB 1/64 | 该路由的权限码格 | 相同 |
| L33 | `archive` 守卫改成 `tasks:read`（路由） | DB 1/64 | 同上 | 相同 |
| L34 | `unarchive` 守卫改成 `tasks:read`（路由） | DB 1/64 | 同上 | 相同 |
| L35 | `GET /api/task-lists` 守卫改成 `tasks:write`（路由） | DB 2/64 | 该路由的权限码格；门 13 清单正控（只有 `tasks:read` 的用户变 403） | 相同 |
| L36 | `GET /:id` 守卫改成 `tasks:write`（路由） | DB 1/64 | 该路由的权限码格 | 相同 |
| L37 | `/events` 守卫改成 `tasks:write`（路由） | DB 1/64 | 同上 | 相同 |
| L38 | 加一条 `DELETE /api/task-lists/:id`（路由） | DB 1/64 | R13 格 | 相同 |

没有做、或判为等价的变异：`getTaskList` 与 `listTaskListEvents` 里的 `assertListAction(…, 'view')` 去掉 —— 每个成员角色都有 `view`，非成员在它之前已经 404，等价，未计；`transactionNow` 里 `?? new Date()` 的兜底在 `SELECT now()` 必返回一行时不可达，未计。全部结束后 `git status` 干净（`src` 无残留，没有 `.s5bak` 文件）。

### S5.6 与设计的偏差

1. **鉴权门的清单第二租户读格提前到 S5。** 设计 §13 把它放在 S10；本片的任务说明把它列为 S5 的格，于是只把这一格（含它自己的 org 谓词负控）先落进 `tasks-auth-gate.ts`，`M4_ROUTES`、门 1 缺 org 格、门 2 / 16 三件事与路由人口格仍归 S10。S10 不要再加一格同样的东西；`/items` 的读面在 S7 之后可以补进这一格。
2. **`/items` 的第二租户读面不在本片**：路由在 S7。§10.4 第二租户·清单那一行本片用 `/:id`、`/events`、「我的清单」与三条写路由覆盖。
3. **纯函数多了两个**：设计 §4.1 给 `task-lists.ts` 本片只列了 `applyRenameList`。`parseTaskListName`（名字的可存文本规则；任务 D 的 `validateTaskListName` 不查 U+0000 与孤立代理项，名字含 U+0000 会以 500 落到驱动）与 `parseIncludeArchived`（`INVALID_FILTER` 的取值规则）都是规则，按门 20 放在纯函数层，不写在服务里。
4. **`/events` 缺 org 回 404**（`[own-33]`），不是 §3.0 字面上「集合读降级」的读法；理由见 §S5.1。S10 的 `M4_ROUTES` 要按 404 写。
5. **四种清单事件的 payload 是 `{}`**（`[own-36]`）。
6. **`archive` 的时间戳取事务时钟**，多一条 `SELECT now()`；任务 D 的 `applyArchive` 要求调用方给出 `now`，取 JS 时钟会让 `archived_at` 与同一事务里 `updated_at = now()` 的值不同（L23 证明这条有格钉住）。【更正：取事务时钟的那个值同样经过 JS `Date`，只剩毫秒，所以「同一瞬时」在 SQL 精度上不成立；L23 只证明了 5 秒的偏移会被抓到。`now()` 又是等锁之前的时刻。现在的做法与验证见「S5 闸修复」：`SELECT now()` 已删除，`archived_at`、`updated_at` 与事件取锁后同一个 `clock_timestamp()` 读数，在 SQL 里比较。】
7. **权限码格与 R13 格是额外的**：§13 S5 的测试清单没有它们。权限码格在 `RBAC_TOKEN_TRUST='true'` 下按路由钉住 `read` / `write`（L29、L32–L37），不是门 2 的 trust-off 格，门 2 / 16 的三件事仍归 S10。R13 格钉住「没有清单 `DELETE`」。
8. **单测落点**：`task-records-guards.test.ts` 与 `tasks-route-errors.test.ts` 不在 §13 S5 的文件清单里；前者是「事务数 0、语句顺序、不携带坏 id」的直接证明位置，后者是 `sendError` 的落点证明位置（与 S4 的做法相同）。
9. **「`edit` 成员把创建人降为 `read` 后创建人仍能归档」**（§10.4，归 S6）在本片用 SQL 种子近似：创建人以 `read` 成员身份归档 200。S6 要经成员路由再做一次。
10. **请求体不是普通对象**（数组体）时按缺名字处理，得 422 `INVALID_NAME`。

### S5.7 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG15.17（同 §S1.9）。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- 清单路由在 trust-off 配置下的门 1 缺 org 格、门 2 / 16 的非 admin 三件事、路由人口枚举：归 S10（`M4_ROUTES`）。本片在 trust-on 配置下的权限码格已经让 `read` / `write` 守卫的变异全部变红（L29、L32–L37）。
- 清单写的并发：本片没有并发格（设计 §13 S5 也没有）；清单写与 M3 的结构写共用 org 结构锁，`withOrgStructure` 的首句与取锁由单测钉住。
- `/items` 读面上的第二租户格（S7）。
- 前端：还没有清单的前端，没有在浏览器里跑过任何东西。
- `MetaSheetServer` 对顶层非对象 JSON 请求体的响应（同 §S3.6 第 6 条）：本片只用测试 express 实例测了数组体。
- 全量单测里 5 个与本片无关、因本机环境失败的文件（§S5.4）：本片没有修它们，也没有在 S4 的提交上重跑来对照；判断依据是它们的源码与 import 都不在本片 diff 里，失败原因分别指向本机临时卷的 `statfs` 类型与规范检出里的自引用符号链接。
- L13 首跑多出的两格失败没有再现，也没有日志（§S5.5）。

### S5.8 给 S6 的交接

- 入口：`task-list-records.ts` 的 `loadMemberList(db, { orgId, actorId, listId })` 做完「坏 id ⇒ 404、按 org 取行、没有成员行 ⇒ 404」三步并给出调用者的角色与 `createdBy`。S6 的成员路由需要锁后的**全部**成员行（§4.3）：可以在 `loadMemberList` 之后另读成员行，或改成一次读出全部成员行再从中取调用者的角色；无论哪种，「没有成员行 ⇒ 404」都要先于 `canListAction` / `canRemoveListMember`，并保持与不存在的清单逐字节相同（`m4list|` 格的写法照本文件）。
- 清单事件：`writeListEvent` 现在只写 payload `{}`；成员事件要 `{ targetUserId }`（§4.3），给它加一个可选 payload 参数即可。`TaskListEvent.targetUserId` 已在任务 D 的事件对象上。
- 成员变化不碰 `task_lists.updated_at`（§4.4）；`listColumns` 里的 `ownerId` / `myRole` 子查询在转让后自然反映新所有者，不需要另改。
- 路径与请求体里的用户 id 走 `isValidMemberId`（422 `INVALID_MEMBER`）；角色走 `parseTaskListMemberRole`（`owner` ⇒ `INVALID_ROLE`）；都排在能力判定之后。
- org 前缀不要与 `org_tasks_m4lcore_` 互相 `LIKE` 命中（例如 `org_tasks_m4lmem_` 可以）。
- 静态段先于参数段：`/:id/members`、`/:id/members/:userId`、`/:id/transfer-owner` 都在 `/:id` 之下，同方法没有相撞的静态 / 参数对。
- 本片的权限码格按路由逐条列在 `CODE_ROUTES`；S6 的新路由可以照样补格，S10 的 `M4_ROUTES` 另做 trust-off 版本。
- manifest 的 `purpose` 现在是 `/api/tasks`、`/api/task-settings`、`/api/task-lists`；`/api/task-groups` 随 S8。
- 鉴权门已经有清单第二租户读格（24 格）；S10 加 `M4_ROUTES` 时，本片的 7 条 + 设置 2 条 + `PATCH /api/tasks/:id` 都要进表，`/events` 缺 org 是 404（`[own-33]`）。
- lane 现在 12 文件 529 格。
- 变异脚本（私有工件目录）读 `MUTANTS` / `RESULTS` 环境变量指定的 JSON，逐个日志写在同一目录，可直接复用。

### S5.9 前端对接（S5 的 7 条路由）

`List` = `{ id, name, createdBy, ownerId, archivedAt, createdAt, updatedAt, myRole }`：`ownerId` 取角色为 `owner` 的成员行（没有该行时为 `null`，只会出现在 SQL 造出的数据里）；`myRole` 是调用者自己的成员角色 `read` / `edit` / `owner`；时间是 ISO-8601 UTC 字符串；`archivedAt` 未归档时为 `null`。`ListEvent` = `{ id, listId, actorId, eventType, payload, occurredAt }`，`eventType` 取 `task_list_events` 的闭集；本片写出的四种（`created` / `renamed` / `archived` / `unarchived`）payload 都是 `{}`。错误体都是 `{ error: { code } }`；403 仍是 `rbacGuard` 的 `{ error: 'Insufficient permissions' }`。清单路由没有 409，也没有 `VERSION_CONFLICT`（清单没有 `version` 列）。

| 方法 路径 | 码 | 行级 | 请求 | 成功 200 | 错误 | 空操作 |
|---|---|---|---|---|---|---|
| `POST /api/task-lists` | write | — | `{ name }`（修边、NFC，1–100 码点） | `List`（`myRole: 'owner'`，`ownerId` 是调用者） | 422 `ORG_MISSING`（先于请求体）、`INVALID_NAME`（缺、非字符串、空白、含 U+0000 或孤立代理项、请求体不是对象）、`NAME_TOO_LONG` | 不是，每次新建 |
| `GET /api/task-lists` | read | 本人是成员 | query `includeArchived`（缺省 / `false` / `true`）、`limit`（1–100，缺省 100）、`offset`（≥ 0） | `{ items: List[], total }`，按 `updatedAt` 降序、`id` 降序 | 422 `INVALID_LIMIT`、`INVALID_OFFSET`（先报）、`INVALID_FILTER`；缺 org：200 `{ items: [], degraded: true, reason: 'org_missing' }`（没有 `total`，先于 query 校验） | — |
| `GET /api/task-lists/:id` | read | 成员（任一角色，已归档也可以） | — | `List` | 404 `NOT_FOUND`（不存在、他 org、非成员、坏 id、缺 org，逐字节相同） | — |
| `PATCH /api/task-lists/:id` | write | `edit` / `owner` | `{ name }` | `List`（新名字，`updatedAt` 前移） | 404（含 `read` 成员与非成员，且先于请求体校验）；422 `ORG_MISSING`、`INVALID_NAME`、`NAME_TOO_LONG` | 规范化后同名：200 原样，`updatedAt` 不变，无事件 |
| `POST /api/task-lists/:id/archive` | write | `edit` / `owner`；清单创建人在任一成员角色下也可以（必须仍有成员行） | — | `List`（`archivedAt` 等于 `updatedAt`） | 404；422 `ORG_MISSING` | 已归档：200 原样，无事件 |
| `POST /api/task-lists/:id/unarchive` | write | 同上 | — | `List`（`archivedAt: null`） | 404；422 `ORG_MISSING` | 未归档：200 原样，无事件 |
| `GET /api/task-lists/:id/events` | read | 成员（任一角色） | query `limit`、`offset` | `{ items: ListEvent[], total }`，按 `occurredAt` 降序、`id` 降序 | 404（先于分页：非成员带非法分页仍是 404；缺 org 也是 404）；422 `INVALID_LIMIT`、`INVALID_OFFSET`（只对成员） | — |

另外几点：归档不改变任务的任何东西（pending、红点、五个视角、任务详情与角色都不看 `archivedAt`），只影响 `GET /api/task-lists` 的缺省过滤；没有删除清单的接口；`includeArchived` 只认小写的 `true` / `false`；分页与过滤同时非法时报分页的码；改名、归档、取消归档会改变清单在列表里的顺序（三者都写 `updatedAt`），成员与清单项的变化（S6、S7）不会。

## 修复切片（S1–S4 闸审）

基于 `00ddafad23`（S0–S5 与当时 main 的合并）。两份闸审清单：S4 闸审 8 条（终版），S1–S3 闸审 27 条（两轮审查的合集，互有重叠：M4G1-AUTHZ-1 ≈ AUTHZ-1 ≈ SCH-1；S3-PAGE-1 ≈ M4G1T-03；S3-BADGE-1 ≈ M4G1T-04；SCH-2 / SCH-3 ≈ M4G1-SCHEMA-01 / 02；M4G1-AUTHZ-2 ≈ AUTHZ-2）。P1 / P2 一律按属实处理，没有驳回任何一条。本片从干净的工作树开始。

本地一次性库只用 `m4f_*` 前缀：`m4f_base`（S0–S5 版迁移的全量库，用来复现 §9.2 的回退实测）、`m4f_lane`（修复与全部变异）、`m4f_final`（最终 head 从空库全量迁移后跑 lane × 6 与鉴权门 × 2）、`m4f_recov`（最终 head 从空库全量迁移后跑两个 recovery 守卫）。四个库在工作结束时都已 `DROP DATABASE`（删除前查过 `m4f_final` 与 `m4f_lane`：`tasks`、`task_lists`、`task_list_items`、`task_groups`、`task_user_settings`、`task_list_events` 与 `@tasks-m4.test` 的种子用户都是 0 行）。变异脚本、mutant 定义与逐个日志在私有工件目录。`node_modules` 仍是指向规范检出的符号链接，本片没有改动任何符号链接、没有跑 `pnpm install`。

提交：

| 提交 | 内容 |
|---|---|
| `83db9f24aa` | P1：清单身份在库与读路径两层绑定 org |
| `e7fdbf36fe` | 四个 M4 真库文件改为每文件一个 HTTP 监听 |
| `79c66bf39c` | S4 闸审：截止瞬时年份范围、PATCH 守卫钉住、缺省键保留库值、锁后时间戳 |
| `9a61bd7b04` | S1–S3 闸审：总数、清单身份边界、设置隔离等补格；设置 PATCH 只读 JSON；夹具前缀逐字匹配；manifest 钉住 |
| `8acc6baf9f` | 设计：§9.2 部署过渡态与回退三层按 runner 与 Kysely 的实际行为重写，及其余文档类处置 |
| 本节所在提交 | 本节 |

### F.1 逐条处置

S4 闸审（8 条）：

| id | 级别 | 处置 | 落点 | 证红 |
|---|---|---|---|---|
| DATES-1 | P2 | 已修：`planTaskDates` 在算出截止瞬时之后要求年份在 0001–9999，否则 `invalid_date`（`[own-38]`）；只改时区的 PATCH 也按重算后的瞬时判 | `task-edit.ts`；单测 5 格；`task-m4-dates` POST 两行、PATCH 一行、「东京 9999-12-31 改到纽约」一格 | D01 |
| DATES-4 | NIT | 已修：设计 §11 补 `[own-29]`–`[own-36]`（另加本片的 `[own-37]`–`[own-39]`）；§5.1 的 `timeZone` 行写明 `''` 读作 `null`，`remindAt` 行指向 `[own-30]` | 设计 §5.1、§11 | — |
| AUTHZ-1 | P2 | 已修，不等 S10：trust-on 格，角色只带 `tasks:read` 的任务创建人 PATCH 自己的任务与缺失 id 得同一个 403，行与事件不变，详情 `canEdit` 为真 | `task-m4-dates` | A01、A02 |
| AUTHZ-2 | P3 | 已修：`UPDATE tasks AS t … updated_at = s.at … FROM (SELECT clock_timestamp() AS at) AS s`，事件行从任务行复制 `updated_at`（锁后一次读数，与 M3R3-LOCK-2 同一做法） | `task-patch.ts`；`task-m4-dates` 锁序格 | T01、T02 |
| S4-T1 | P2 | 已修：四个 M4 真库文件改走 `tests/helpers/tasks-http-harness.ts`（每文件一个监听，`Connection: close`、不复用连接）；子进程变异脚本与门 13 的 `MetaSheetServer` 格保留各自的传输 | `task-m4-dates`、`-list-roles`、`-paging-settings`、`-lists` | lane × 6，hang-up 计数见 §F.3 |
| S4-T2 | P2 | 已修：单测「只改标题时其余字段（含描述）保留」；真库「先只改描述、再只改标题，每次除该列与 `version`、`updated_at` 外整行不变」 | `task-edit.test.ts`、`task-m4-dates` | G38、G32 |
| S4-T3 | P2 | 已修：同上两格覆盖 `start_time` 等读回列；单测「只改描述时日期、时区、提醒保留」 | 同上 | G33（另 G34、G35、G37 的红格都含这一格） |
| S4-T5 | NIT | 已修：设计 §10.5 改为 9 分钟 | 设计 §10.5 | — |

S1–S3 闸审（27 条）：

| id | 级别 | 处置 | 落点 | 证红 |
|---|---|---|---|---|
| M4G1-AUTHZ-1 / AUTHZ-1 / SCH-1 | P1 | 已修，两层：① 库：清单项与分组项带 `org_id NOT NULL`，组合外键同时指向两端的 `(id, org_id)`；清单 scope 分组以 `(list_id, org_id)` 指向清单；`tasks`、`task_lists`、`task_groups` 各加 `UNIQUE (id, org_id)`（`[own-37]`）。② 读路径：`loadActorListMemberships` 只经「清单行 `org_id` = 任务行 `org_id`」的清单给角色，六处角色解析共用这一处，签名不变，`task-access.ts` / `task-list-access.ts` 的 needle 计数不变 | 迁移；`task-records.ts`；`task-m4-schema` 四格；`task-m4-list-roles` 跨 org 清单项格（含负控 7） | X01–X05（库）；R01–R03 与负控 7（读路径） |
| M4G1-SCHEMA-01 / SCH-2 | P2 | 已修（文档）：设计 §9.2 按 runner 的实际顺序重写（先换镜像、再于对齐门失败，没有恢复）；规则「owner 二选一之前，含本迁移的镜像只能以 `tasks_enabled=false` 部署」；恢复路径；§12-Q10、§9.3 门 14 行、§13 S10 PR body 同改。runner 在 `compose up` 之前的 fail-closed 检查是 runner 线与共享 workflow 的改动，没有做，作为 §12-Q10(a) 交给 owner | 设计 §9.2、§9.3、§12-Q10、§13 | §F.5 实测 |
| M4G1-SCHEMA-02 / SCH-3 | P2 | 已修（文档）：回退三层按可执行性重写（迁移已应用的环境不能删迁移文件；`down()` 只在本迁移是最近执行的一条时可经 `--rollback` 执行；可执行的三种做法） | 设计 §9.2、§12-Q10(b) | §F.5 实测 |
| M4G1-SCHEMA-03 | NIT | 已修：`dropTaskM4Fixtures` 改为 `left(org_id, length($1)) = $1`，加一格「只在 `_` 当通配符时才匹配的 org 不被删」 | `task-m4-fixtures.ts`；`task-m4-schema` | LK1 |
| M4G1T-01 | P2 | 已修：只有清单身份的 list-reader / list-editor 对一条逾期任务，`any_role` 的 items 与 total、`/pending` 的 items 与 total、`/pending-count` 都是 0；同时是负责人的 list-reader 计入 1；三人详情都 200 | `task-m4-list-roles` | K18、K20、K21、K22 |
| M4G1T-02 | P2 | 已修：非成员格里调用者同时是同 org 另一张清单的 `edit` 成员（那张清单里的任务他看得到） | `task-m4-list-roles` | K01 |
| M4G1T-03 / S3-PAGE-1 | P2 | 已修：混合 org（自建、委派、被指派、关注、无关各一）里五个视角各自的 items 与 total（含 `limit=1` 时的 total 与 `countTasks`），`/pending` 只有自己的那一条、total 1 | `task-m4-paging-settings` | K16、K17、K19 |
| M4G1T-04 / S3-BADGE-1 | P2 | 已修：他人设 `off` 之后邻居的 `/pending-count` 仍是 `{ count: 1 }`；一个 org 的设置 PATCH 不改同一用户在另一 org 的行（含 `updated_at`） | `task-m4-paging-settings` | K26、K33 |
| M4G1T-05 | P2 | 已修：父候选不含同 org、清单外、调用者无直接角色的任务 | `task-m4-list-roles` | K12 |
| M4G1T-06 | P2 | 已修：只改 `defaultRemindPolicy`、只改 `dailyReminderEnabled`（开、关）各自落库且读回一致。`sameSettings` 的代码不改：对闭集 `{ mode }` 它已完整（多余键是 422） | `task-m4-paging-settings` | K28、K29 |
| M4G1T-07 | P3 | 已修：回滚格在事务前记下 `task_lists` 的 OID 并插一行哨兵清单，事务后两者都必须原样 | `task-m4-schema`；设计 §2.3、§10.2 | K41 |
| M4G1T-08 | P3 | 已修：list-reader 看得到同清单子任务（P09）；只有所有者行的成员能切模式（P10）；`read` + `edit` 的并集（P11，两名用户在同两张清单上角色互换，任何行序下都有一人先遇 `read`、一人后遇 `read`） | `task-m4-list-roles` | K05、K10、K11、K11b |
| M4G1T-09 | P3 | 已修：门 13 两个负控的子进程要求设置 / 清单路由的 404 是框架的（去掉路径后与未注册的兄弟路径同形）且 `/api/tasks/context` 解析出的 org 等于夹具的 org；父进程正控加一条「路由自己的 404 与框架的 404 不同形」 | `task-m4-paging-settings`、`task-m4-lists` | 判别力探针见 §F.4 |
| M4G1T-10 | P3 | 已修（文档）：§5.4 补 list-roles 的那一处；§4.6 与 §13 S9 列出 M4 文件里需要在职种子的格 | 设计 §4.6、§5.4、§13 | — |
| M4G1T-11 | NIT | 已修：红点夹具在 UTC 零点前不足一分钟时等过零点再写（不 skip），三格超时 120 秒 | `task-m4-paging-settings` | 未证红（见 §F.7） |
| M4G1T-12 | NIT | 已修：manifest 测试钉住 `TASKS_ENABLED` 的 `danger: 'medium'`、`source`（两个读点）与 `purpose` 里的 M4 迁移名（按磁盘上的文件名取，改名后跟着走）及三张表名 | `global-history-flag-manifest.test.mjs` | MF1、MF2 |
| M4G1-AUTHZ-2 / AUTHZ-2 | P3 / NIT | 已处置（文档），代码不改：设计 §6.3 改为列出按 id 取行的全部站点（`getTask`、`loadTask`、`lockLiveTaskForComment`、`lockTaskRowForDelete`、S4 的 PATCH 取行），并写明 `precheckDeleteAbility` 是单点发射之外唯一手写 org 子句的按 id 读。理由：它是 M3 的代码，已随 #6229 在 main；在本 PR 改它会让本分支与 main 的同一函数分叉；它只决定是否不等锁就 404，锁后的读经构造器重判，没有行为漏洞。§S2.7-1 的「四处」以本节为准（经构造器五处，另有这一处例外） | 设计 §6.3 | — |
| S3-MANIFEST-1 | P3 | 已由 `00ddafad23` 的合并解决（`purpose` 含 #6173 的会话特性一句与 M4 迁移依赖，`source` 点名两个读点）；本片的 manifest 测试把 `source` 整串钉住 | manifest 测试 | MF1 / MF2 之外，`source` 断言同测 |
| S3-SETTINGS-NIT-1 | NIT | 已修：`PATCH /api/task-settings` 只读 `application/json` 请求体，文本、表单、没有请求体都是 422 `INVALID_SETTINGS`，缺 org 仍先答 `ORG_MISSING`（`[own-39]`）。`{}` 照设计 §4.2 仍落缺省行（行锁两格依赖它） | `routes/tasks-settings.ts`；`task-m4-paging-settings` | NJ1 |
| SCH-4 | P3 | 推迟到 S10，理由与依据：main 的最大前缀已是 `zzzz20261001120000_create_approval_form_drafts`，排在本迁移之后；main 还在动（今天又并入了 #6229、#6159），现在改名并不能保证合并时仍排在最后；改名应在 S10 并入当时的 main 时做。功能上不受影响：`allowUnorderedMigrations` 下乱序应用可执行（本地全量迁移就是先本迁移、后 drafts）。设计 §2.1 已写明；manifest 测试按磁盘文件名核对，改名时跟着走。（S10 已改名，见 §S10.2） | 设计 §2.1 | — |

另补（两份清单之外，§S3.7 的 NOT RUN 一项）：两条设置路由的权限码格（只有 `tasks:read` 的用户 PATCH 403 且无行；只有 `tasks:write` 的用户 GET 403），SC1、SC2 证红。

### F.2 改动文件

| 文件 | 改动 |
|---|---|
| `src/db/migrations/zzzz20261001090000_create_task_m4_tables.ts` | `[own-37]`：`tasks_id_org_id_key`；`task_lists` / `task_groups` 的 `UNIQUE (id, org_id)`；清单项、分组项的 `org_id` 列、可打印 CHECK 与组合外键；清单 scope 分组的组合外键；`down()` 在删表之后删 `tasks_id_org_id_key` |
| `src/services/task-records.ts` | `loadActorListMemberships` 加 `JOIN tasks t` 与 `tl.org_id = t.org_id` |
| `src/tasks/task-edit.ts` | `[own-38]` 截止瞬时年份范围 |
| `src/services/task-patch.ts` | 锁后 `clock_timestamp()`；事件复制 `updated_at` |
| `src/routes/tasks-settings.ts` | `[own-39]` 只读 JSON 请求体 |
| `tests/helpers/task-m4-fixtures.ts` | 前缀逐字匹配 |
| `tests/integration/task-m4-schema.db.test.ts` | pin 更新；org 一致性 4 格；回滚格的 OID 与哨兵；夹具清理 1 格 |
| `tests/integration/task-m4-list-roles.db.test.ts` | 每文件一个监听；`task_list_items` 种子带 `org_id`；跨 org 清单项格（负控 7）；M4G1T-01 / 02 / 05 / 08 的格 |
| `tests/integration/task-m4-paging-settings.db.test.ts` | 每文件一个监听；混合 org 总数；邻居红点；跨 org 设置写；单字段；非 JSON；设置权限码；红点夹具避开零点；门 13 负控 |
| `tests/integration/task-m4-dates.db.test.ts` | 每文件一个监听；年份范围；缺省键保留；锁序时间戳；PATCH 权限码 |
| `tests/integration/task-m4-lists.db.test.ts` | 每文件一个监听；`task_list_items` 种子带 `org_id`；门 13 负控；一处既有的类型断言改经 `unknown` |
| `tests/tasks-auth/tasks-auth-gate.ts` | 清单第二租户格的 `task_list_items` 种子带 `org_id` |
| `tests/unit/task-edit.test.ts` | 年份范围 5 格、缺省键保留 2 格 |
| `scripts/ops/global-history-flag-manifest.test.mjs` | `TASKS_ENABLED` 条目一格 |
| `docs/development/task-m4-pr3a-backend-design-20260930.md` | 修订 2（见其抬头） |

`ASSUMPTION(task-m4)` 新标签：`[own-37]`（org 一致性的库层形状）、`[own-38]`（截止瞬时年份范围）、`[own-39]`（设置 PATCH 只读 JSON）。开工指令写「从 own-31 往后编」，但 `[own-32]`–`[own-36]` 已被 S5 用掉（§S5.1），所以从 `[own-37]` 起编，免得撞号。

### F.3 命令与结果

所有命令在 `packages/core-backend` 下，`PATH` 前置 Node 20.20.2。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | 0 errors |
| 改动的测试文件的类型 | 临时 tsconfig（`noUnusedLocals`，覆盖 `exclude`，包含五个 M4 真库文件、两个 helper、`task-edit.test.ts` 与 `tasks-auth-gate.ts`），在最终文件上跑，跑完即删 | 测试文件 0 errors（转换后多出的未用 import 已删）；报出的只有 `src/` 下在这套编译选项（`bundler` 解析加 `noUnusedLocals`）里的既有提示，与本片无关，`tsc --noEmit -p .` 为 0 |
| 两个 recovery 守卫（`multitable-recovery-schema-drift.yml` 在 PR 上会跑；本片改了迁移） | `m4f_recov` 上 `vitest --config vitest.integration.config.ts run tests/integration/recovery-schema-drift.db.test.ts tests/integration/recovery-authority-search-path.db.test.ts` | 2 files，14/14 |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 4 failed \| 1078 passed \| 172 skipped (1254)；Tests 43 failed \| 18546 passed \| 1712 skipped (20301)**。失败的 4 个文件全是 `multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup`，错误是 `RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED` / `RECOVERY_LOCAL_CUSTODY_STORE_REFUSED`（§S5.4 记过的本机临时卷问题；这四个文件不 import 任何任务模块）。其余文件全绿，含门 20 harness、三集合枚举、`task-edit`（144）、`task-records-guards`、`tasks-route-errors`、`task-gate19-identities`。§S5.4 记过的 `attendance-admin-plugin-lib-dist-layout-boot`（`ELOOP`）这次没有失败 |
| 真库 lane × 6（`m4f_final`，`tasks-realdb.yml` 的 12 个文件，最终 head） | `vitest --config vitest.integration.config.ts run <12 files> --reporter=verbose` | 六遍：第 1 遍 12 passed (12)，551 passed (551)，38.60s，hang-up 0；第 2 遍 12 passed (12)，551 passed (551)，37.08s，hang-up 0；第 3 遍 12 passed (12)，551 passed (551)，38.43s，hang-up 0；第 4 遍 12 passed (12)，551 passed (551)，38.38s，hang-up 0；第 5 遍 12 passed (12)，551 passed (551)，39.18s，hang-up 0；第 6 遍 12 passed (12)，551 passed (551)，37.20s，hang-up 0。六遍合计 `socket hang up` / `ECONNRESET` **0** 次 |
| 鉴权门 × 2（`m4f_final`） | `RBAC_BYPASS=false RBAC_TOKEN_TRUST=false … vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts` | 两遍：24 passed (24)；24 passed (24) |
| ops 脚本测试（仓库根） | `node --test scripts/ops/global-history-flag-manifest.test.mjs scripts/ops/multitable-recovery-schema-containment.test.mjs`；`… tasks-auth-ci-wiring.test.mjs`；`… staging-tasks-smoke.test.mjs` | 78/78；3/3；19/19 |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫本片改动的全部文件与本文件 | 均退出 0 |

逐文件通过数（六遍相同）：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m3-comments-deletion 32、m4-schema 59、m4-list-roles 49、m4-paging-settings 77、m4-dates 107、m4-lists 64，合计 551。

静态展开数（门 17 ②）：`task-m4-schema` 54 + 4 + 1 = 59；`task-m4-list-roles` 44 + 1 + 4 = 49；`task-m4-paging-settings` 72 + 5 = 77；`task-m4-dates` 100 + 2（POST 表行）+ 1（PATCH 表行）+ 4 = 107；`task-m4-lists` 64（只改了已有的格）。verbose 日志收集并通过的数与之相等。

门 8 A 支：本片的运行都在 UTC 16 时之前，子进程输出 `{"gate8route":"red","explicit":0,"invalid":1,"absent":1}` / `{"gate8sql":"red",…}`——任务时区的答案 0、UTC 的答案 1，正是 §S4.7 记为「没有实际观察过」的另一极性。

### F.4 变异证明

做法同前几片：断言 needle 恰出现应有的次数 → 备份 → 改写 → 跑 → 还原 → 逐字节比较。迁移一侧的变异照 §S1.7：先对库跑原版 `down()`，再跑变异后的 `up()`，跑测试，还原文件，再跑原版 `down()` + `up()`，并比较变异前后的目录快照（列、约束、索引，含 `tasks_id_org_id_key`）逐字节相同。全部逐个串行。每一行「还原」都是逐字节相同；迁移变异另有「目录快照相同」。

P1（库层与读路径）：

| # | 变异（文件） | 失败 | 变红的格 |
|---|---|---|---|
| X01 | 清单项两条外键退回单列（迁移） | 4 / 103（schema + list-roles） | 约束集 pin；跨 org 清单项 23503 格；改 org 23503 格；list-roles 跨 org 格 |
| X02 | 只把清单项的任务端外键退回单列（迁移） | 4 / 103 | 同上 |
| X03 | 清单项 `org_id` 可空（迁移） | 3 / 103 | 列集 pin；23502 那一步；`down → up` 格（事务内先比列 pin） |
| X04 | 清单 scope 分组的外键退回单列（迁移） | 2 / 103 | 约束集 pin；分组跨 org 格 |
| X05 | 分组项的分组端外键退回单列（迁移） | 2 / 103 | 约束集 pin；分组项跨 org 格 |
| R01 | 去掉 ` AND tl.org_id = t.org_id`（records） | 1 / 45 | 跨 org 清单项格（两个方向） |
| R02 | 比较清单项自己的 `org_id`：`tl.org_id = tli.org_id`（records） | 1 / 45 | 同上（方向二的 `org_id` 写的是清单一边） |
| R03 | 比较任务行与清单项：`t.org_id = tli.org_id`（records） | 1 / 45 | 同上（方向一的 `org_id` 写的是任务一边） |
| 负控 7（文件内，每遍 lane 都跑） | 去掉同一个合取 | — | 子进程输出 `{"nc7":"red",…}` |
| F07（S5 闸审补；变异在「S5 闸修复」§S5F.4 记为 A01） | 成员连接加 ` AND tl.archived_at IS NULL`（records） | 1 / 66（lists） | 「归档不改变可见性」格。闸审时它在整条 lane 下存活，那一格是 S5 闸修复补的 |

S4：

| # | 变异（文件） | 失败 | 变红的格 |
|---|---|---|---|
| D01 | 去掉年份范围判断（`task-edit.ts`） | UNIT 4 / 144；DB 4 / 107 | 年份范围单测 4 格；POST 两行、PATCH 一行、只改时区一格 |
| A01 | PATCH 守卫改成 `tasks:read`（routes） | DB 1 / 107 | PATCH 权限码格 |
| A02 | PATCH 去掉守卫（routes） | DB 1 / 107 | 同上 |
| G38 | 缺键时描述不再取库值（`task-edit.ts`） | UNIT 1 / 144；DB 1 / 107 | 单测「只改标题保留其余字段」；缺省键保留格 |
| G32 | 读回的描述恒为 `null`（`task-patch.ts`） | DB 2 / 107 | 缺省键保留格；描述格 |
| G33 | 读回的 `start_time` 恒为 `null`（`task-patch.ts`） | DB 1 / 107 | 缺省键保留格 |
| G34 | 读回的 `due_time` 恒为 `null` | DB 6 / 107 | 缺省键保留格与另 5 格 |
| G35 | 读回的 `remind_at` 恒为 `null` | DB 7 / 107 | 缺省键保留格与另 6 格 |
| G37 | 读回的 `start_date` 恒为 `null` | DB 2 / 107 | 缺省键保留格；清空格 |
| T01 | `updated_at = now()`（`task-patch.ts`） | DB 1 / 107 | 锁序时间戳格 |
| T02 | 事件不复制 `updated_at`、取列缺省 | DB 1 / 107 | 锁序时间戳格（事件与 `updated_at` 不再相等） |
| M15 复跑 | 去掉路径 id 的可打印检查（`task-patch.ts`） | DB 1 / 107 | 非可打印路径 id 格。换成每文件一个监听之后它仍有判别力（`%00` 等原样到达路由） |

S1–S3 补格（DB = 对应的单个文件；名称沿用闸审清单里的 K 编号）：

| # | 变异（文件） | 失败 | 变红的格 |
|---|---|---|---|
| K01 | 成员连接去掉 `tlm.list_id = tli.list_id`（records） | 1 / 49 | 非成员格（另一张清单的 `edit` 给了 T） |
| K12 | 父候选用锚点任务的清单身份判每个候选（structure） | 1 / 49 | 父候选格 |
| K05 | `children` 改按 `edit` 过滤（records） | 1 / 49 | list-reader 子任务格 |
| K10 | 成员连接排除 `owner` 行（records） | 1 / 49 | 所有者行格 |
| K11 | 同一任务的清单身份「后一行替换前一行」（records） | 1 / 49 | 并集格 |
| K11b | 「只留第一行」（records） | 1 / 49 | 并集格 |
| K18 / K21 / K20 / K22 | `countTasks` / `listPending` / `countPendingList` / `countPending` 各自 OR 一条清单臂（records） | 各 1 / 49 | 「只有清单身份不进视角总数、`/pending`、红点」格 |
| K16 | `countTasks` 只剩 org + 存活（records） | 1 / 77 | 混合 org 总数格 |
| K17 | `countTasks` 恒按 `any_role`（records） | 1 / 77 | 同上 |
| K19 | `countPendingList` 数整个 org 的未完成任务（records） | 1 / 77 | 同上（`/pending` 的 total） |
| K26 | `loadBadgeScope` 不看 `user_id`（settings） | 1 / 77 | 按人按 org 隔离格 |
| K33 | 设置 `UPDATE` 不看 `org_id`（settings） | 1 / 77 | 跨 org 设置写格 |
| K28 | `sameSettings` 去掉提醒策略合取（settings） | 1 / 77 | 单字段格 |
| K29 | `sameSettings` 去掉每日提醒合取（settings） | 1 / 77 | 单字段格 |
| NJ1 | 设置路由不看 `Content-Type`（routes） | 1 / 77 | 非 JSON 格 |
| SC1 | 设置 PATCH 守卫改成 `tasks:read`（routes） | 1 / 77 | 设置权限码格 |
| SC2 | 设置 GET 守卫改成 `tasks:write`（routes） | 3 / 77 | 设置权限码格；无行 GET 格；门 13 设置正控 |
| K41 | 回滚格的事务改为提交（测试文件自身） | 1 / 59 | 回滚之后的 OID / 哨兵格 |
| LK1 | 夹具清理退回 `LIKE`（helper） | 1 / 59 | 夹具清理格 |
| MF1 | manifest `danger` 改成 `low` | 1 / 36（`node --test`） | manifest 条目格 |
| MF2 | manifest `purpose` 删去 M4 迁移依赖那一句 | 1 / 36 | 同上 |

并集格的第一版（一名用户、四张清单按 id 排开）在 K11 下存活：`EXPLAIN` 显示这条查询以 `tasks` 探测 `task_lists` 的哈希表，同一任务的清单行按哈希桶链（物理插入的逆序）返回，不按 id，四张清单的随机 id 排不出预期的顺序。改成两名用户在同两张清单上角色互换之后，两张清单不论按什么顺序返回，总有一人先遇 `read`、一人后遇 `read`，K11 与 K11b 都证红。

门 13 判别力探针（M4G1T-09，私有工件目录里的一个探针脚本）：设置路由**已注册**、token **不带 org** 时，旧的红条件（设置 404 且 context 200）成立，新的不成立：`{"settings":404,"settingsBody":"{\"error\":{\"code\":\"NOT_FOUND\"}}","siblingBody":"<!DOCTYPE html>…","context":200,"contextBody":{"orgId":null},"oldRed":true,"newRed":false}`。

### F.5 §9.2 改写的实测依据

1. 回退之后的迁移（`m4f_base`：本分支 S0–S5 版迁移全量应用，426 条；`MIGRATION_EXCLUDE` 在 `tasks-realdb.yml` 的六项之外加本迁移名，模拟删掉迁移文件之后的文件集）：`migrate.ts`（latest）退出 1，`failed to migrate` / `Error: corrupted migrations: previously executed migration zzzz20261001090000_create_task_m4_tables is missing`；`--list` 退出 0，`Applied: 425` / `Pending: 0`；`--rollback` 退出 1，同一错误。
2. `--rollback` 的目标（同一个库，不排除任何 M4 文件）：退出 0，回退的是 `zzzz20261001120000_create_approval_form_drafts`；之后台账 425 行，`task_lists` 仍在、`approval_form_drafts` 已不在。随后重新迁移恢复（426 行）。
3. 对齐报告（本分支，`node scripts/ops/staging-migration-alignment-report.mjs`，待应用清单只有本迁移）：`decision=do_not_run_full_migrate`，本迁移 `risk: high`。
4. runner 的顺序以 `scripts/ops/attendance-staging-window-runner-remote.sh` 的 `04de335490` 版逐行读出：`:979`（override，含 `TASKS_ENABLED`）→ `:1010`（`compose up -d --no-deps backend web`）→ `:1024`（等健康检查报新 SHA）→ `:1028`（断言开关）→ `:1051-1052`（对齐门 `fail`）；`fail` 在 `:110`，是 `exit 1`。`docker-build.yml` 的生产部署 `:481` 先 `up -d`，`:487` 再 `migrate.js`。
5. Kysely 0.28.8（`migrator.js`）：`#getState` 先调 `#ensureNoMissingMigrations`，`allowUnorderedMigrations` 只影响其后的顺序检查；`#migrateDown` 取已执行迁移（按执行时间、再按名字排序）的最后一条。

### F.6 与设计的偏差、说明

1. **标签从 `[own-37]` 起编**，见 §F.2 末。
2. **读路径的同 org 比较写在 `task-records.ts` 的那条查询里**，不经 `task-list-access.ts` 的 `taskListOrgClause`：后者把清单的 org 绑到一个参数值上；这里要比较的是两张表的行（清单行与任务行），不是调用方的 org。新文本不含门 1（`(tasks.org_id = ${ORG_PLACEHOLDER}) AND `）与负控 2（`(task_lists.org_id = ${ORG_PLACEHOLDER}) AND `）的 needle，两者计数仍各为 1。
3. **跨 org 清单项格用 `session_replication_role = replica` 写入**被外键拒绝的行（只在那一条专用连接上，写完即 `RESET` 并关闭连接），需要超级用户；本地 `postgres` 与 CI 服务的 `POSTGRES_USER: postgres` 都是。格在连接不是超级用户时直接抛错，不 skip。行在 `finally` 里逐行删除（错配 org 的行未必被两条级联中的一条带走）。
4. **S7 的跨 org 加入格的期望变了**（设计 §10.4 负控 1）：任务 org 谓词被打掉之后，组合外键拒写，所以它断言的是「请求失败、零新行」（库层拒写）。
5. **设置 PATCH 的 `{}` 仍落缺省行**（§4.2 的专门规定，行锁两格依赖它）；只改了非 JSON 请求体。
6. **`precheckDeleteAbility` 不改**，见 §F.1 M4G1-AUTHZ-2。
7. **`sameSettings` 不改**，见 §F.1 M4G1T-06。
8. 门 13 正控里「路由自己的 404 与框架的 404 不同形」：设置用不带 org 的 token（路由 404 `NOT_FOUND`），清单用不存在的清单 id（路由 404）；框架的 404 是 Express 的 HTML，正文含路径，比较前去掉路径。

### F.7 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17（同 §S1.9）。新加的组合外键与 `UNIQUE` 约束的规范化文本（`pg_get_constraintdef`）只在 PG 15.17 上核过，CI 的 postgres:16 首跑才是它们的真正检查。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- 红点夹具「零点前一分钟等待」的分支没有被触发过（本片的运行都不在 UTC 23:59 附近）；M4G1T-11 的修复只有代码与这条说明，没有证红。
- 门 8 A 支的「距翻转点不足 2 分钟就等待」分支同样没有被触发过（两种极性现在都观察到了，见 §F.3）。
- runner 一侧的 fail-closed 检查（M4G1-SCHEMA-01 的可选修法）没有做，归 runner 线（§12-Q10(a)）。staging 上的部署过渡态没有实跑，§9.2 的叙述来自读 runner 源码与本地复现（§F.5）。
- 生产 `docker-build.yml` 的部署路径没有实跑，只读了源码。
- `MetaSheetServer` 对表单请求体的解析（是否挂了 `urlencoded`）没有查：非 JSON 格在测试的 express 实例上跑，路由的判定只看 `Content-Type`，不依赖请求体是否被解析。
- SCH-4 的改名推迟到 S10（§F.1）；S10 已改名（§S10.2）。
- 全量单测里 4 个与本片无关、因本机环境失败的文件（§F.3）没有修；S5 记录过的 `attendance-admin-plugin-lib-dist-layout-boot`（`ELOOP`）这次没有再现。

### F.8 给 S6 的交接

- **origin/main 又前进了**：`57621d2403`（#6229，M3 后端）与 `cc6ca96ac2`（#6159，M3 前端）已在 main，本分支（含 M3 的非 squash 提交）尚未并入。下一次并入 main 时，`task-structure.ts` / `task-records.ts` / M3 测试文件会与 main 的 squash 版本冲突；并入后按惯例重跑 lane 与鉴权门，并重核 §S2.3 的 needle 计数。
- 写 `task_list_items` / `task_group_items` 的代码（S7、S8）必须写 `org_id`，取值就是清单行与任务行按 id 取出时绑定的那个 `orgId`；写错会以 23503 失败（库层），不会悄悄给出跨 org 的角色（读路径）。
- `task_list_members` 没有 `org_id`；S6 的成员路由不用改写法。
- S7 的跨 org 加入格的期望见 §F.6 第 4 条；负控 1 下它断言零新行。
- 任何新的角色解析都要经 `loadActorListMemberships`（或 `loadRowRoles` / `loadRoles`），不要另写成员查询：同 org 比较只在那一处。
- 新的 M4 真库文件照 `tests/helpers/tasks-http-harness.ts` 起一个监听（`beforeAll` / `afterAll`），不要用 `request(app())`。`TasksClient` 没有 `put`，S8 的 `PUT` 路由需要先给它加一个方法。
- 设计 §4.6 与 §13 S9 已列出 M4 文件里需要在职种子的格；S9 动手时连同新文件里的同类格一并补。
- lane 现在 12 文件 551 格，鉴权门 24 格。
- 变异脚本（私有工件目录；`MUTANTS` / `RESULTS` / `ONLY` 环境变量，迁移变异带目录快照比较）可直接复用。

## S6 成员与转让

基于 `f1510d0bed`（S0–S5 与修复切片并入 main `cc6ca96ac2` 的合并提交，见 §S6.0）。提交：

| 提交 | 内容 |
|---|---|
| `f1510d0bed` | 并入 origin/main `cc6ca96ac2`（§S6.0） |
| `3e2699758c` | 纯谓词、在职 helper、服务、5 条路由、38 格真库文件、单测、三处登记 |
| `716fad6252` | 改角色格补上 §10.4「`edit` 成员经 `PATCH …/members/:userId` 传 `role: 'owner'`」那一半；`task-list-records.ts` 的两处注释与测试文件头注释改为如实陈述（判定顺序里的 `canRemoveListMember` 与在职查询的位置；加成员时调用者本人的在职结果不影响结论；文件用 SQL 播种的是哪几类） |
| `773ad84789` | 名单格旁边加一张有成员的清单；转让格加「既非成员也不在本 org 的目标 ⇒ `TARGET_NOT_MEMBER`」（§S6.4 的 M36、M37、M39） |
| 本节所在提交 | 设计 §11 的 `[own-40]`–`[own-42]`；本节 |

`716fad6252` 在 `src/` 下只改注释；三个后续提交都不改生产码的行为，真库文件仍是 38 格。

本地一次性库只用名字以 `m4g_` 开头的库（按 `left(datname, 4) = 'm4g_'` 认，不用 `LIKE 'm4g_%'`：`_` 在 `LIKE` 里是通配符，会把别的工作流同时在用的 `m4g1_*`、`m4g2_*`、`m4g3_*` 一并匹配进来）：`m4g_lane`（合并复核时从空库全量迁移；合并后的 lane 与鉴权门；三轮变异），`m4g_s6final`（`773ad84789` 上从空库全量迁移 426 条；最终 lane × 3 与鉴权门 × 2）。两库在工作结束时都已按名字 `DROP DATABASE`，删除前查过两库的 `tasks`、`task_lists`、`task_list_members`、`task_list_items`、`task_list_events`、`task_groups`、`task_user_settings`、`@tasks-m4.test` 的种子用户与 `org_tasks_m4lmem_` 的 `user_orgs` 行都是 0；`m4g1_*`、`m4g2_*`、`m4g3_*` 没有碰。`node_modules` 仍是指向规范检出的符号链接，本片没有改动任何符号链接、没有跑 `pnpm install`。脚本、mutant 定义与逐个日志在私有工件目录。

### S6.0 并入 origin/main（`cc6ca96ac2`）

合并提交 `f1510d0bed`。origin/main 相对合并基 `8e2e40d125` 多五个提交：#6229（M3 后端 squash）、#6159（M3 前端 squash）、#6227、#6224、#6154。本分支带的是 M3 后端的原始历史（经 `6a055bf64f` 合入第三轮修复 `62c883a0ac`），main 的 squash 另含第 4–5 轮（测试与文档改动、`task-structure.ts` 的一处注释、`tasks-auth-gate.ts` 的门 1 注释）。`git merge --no-edit origin/main` 报 15 个冲突文件，按「两边各自相对 `62c883a0ac` 的 delta」分三组处置，每一组都先用 `git diff 62c883a0ac <side> -- <file>` 核过：

| 组 | 判据 | 处置 | 文件 |
|---|---|---|---|
| A | main 相对 `62c883a0ac` 无改动，本分支有 | 取本分支整文件（main 的 hunk 本来就在其中） | `tasks-realdb.yml`、`routes/tasks.ts`、`task-create.ts`、`task-ids-runtime.ts`、`task-records.ts`、`task-p0a.db.test.ts`、`task-ids-runtime.test.ts` |
| B | 本分支相对 `62c883a0ac` 无改动，main 有第 4–5 轮 | 取 main 整文件 | `task-m3-backend-design-20260928.md`、`task-m3-backend-verification-20260930.md`、`task-m3-comments-deletion.db.test.ts`、`task-m3-tree.db.test.ts` |
| C | 两边都改 | 以 `62c883a0ac` 为基 `git merge-file` 三方合并：四个文件都干净、无标记；结果相对本分支恰为 main 的第 4–5 轮 hunk | `task-structure.ts`（`DELETE_ROW_LOCK_TIMEOUT` 注释）、`tasks-auth-gate.ts`（门 1 与门 2/16 的注释）、`tasks-route-errors.test.ts`（M3R4-TAM-4 一格）、`vitest.config.ts`（main 的 14 行已经由 `00ddafad23` 带进本分支，合并结果 = 本分支） |

自动合并的两边都改的文件（`task-m3-membership.db.test.ts`、`tasks-http-harness.ts`、`task-create.test.ts`、`task-completion.test.ts`、M3 迁移、task-c 设计）两边相对 `62c883a0ac` 都无 delta，结果与两边相同；main 独有的 `task-deletion-lock-errors.test.ts` 原样进入。`apps/web` 与 `tasks-web-guard.yml` 的合并结果与 main 逐字节相同（本分支不碰 M3 前端）。

合并提交前的检查（`m4g_lane`）：`tsc --noEmit -p .` 没有输出任何诊断（那一次没有记下退出码，以 §S6.3 在 `773ad84789` 上的退出码 0 为准）；`node --test scripts/ops/global-history-flag-manifest.test.mjs` 36/36；lane 12 文件 **552 passed (552)**，hang-up 0（不是修复切片记的 551：main 的第 4 轮给 `task-m3-comments-deletion` 加了一格，32 → 33；其余逐文件不变：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m4-schema 59、m4-list-roles 49、m4-paging-settings 77、m4-dates 107、m4-lists 64）；鉴权门 24/24。`m4g_lane` 从空库全量迁移 426 条（main 又多了 4 条，最后一条仍是 `zzzz20261001120000_create_approval_form_drafts`，M4 迁移在它之前；本片没有改迁移名，SCH-4 的改名仍归 S10）。

**逐文件复核**（S6 收尾时做；只读 git 对象，不动工作树）：

- 冲突集：`git merge-tree --write-tree --name-only 0de12b4a9d cc6ca96ac2` 重算出同样的 15 个冲突文件；它给出的自动合并树与 `f1510d0bed` 的树只在这 15 个路径上不同，其余路径都是 git 自己的自动合并结果。
- 文件集：两个 squash 改到的全部文件，#6229 的 22 个加 #6159 的 14 个，共 36 个。origin/main 此后又前进到 `7137688372`（#6187、#6244），两个提交都不碰这 36 个文件，所以与 `origin/main` 比和与 `cc6ca96ac2` 比结果相同。
- 方法：每个文件取四个版本——基 `62c883a0ac`（本分支 M3 历史的最后一个提交）、合并前 `0de12b4a9d`、main `cc6ca96ac2`、合并结果 `f1510d0bed`——用 `git merge-file -p` 三方合并，后端的每个文件都干净，且与合并结果逐字节相同。与 main 不同的文件，再比较 `git diff 62c883a0ac 0de12b4a9d` 与 `git diff cc6ca96ac2 f1510d0bed` 的 `+` / `-` 行多重集：相同即合并结果恰为 main 加上本分支自己的改动。本分支自己的改动按 `git log --no-merges 62c883a0ac..0de12b4a9d -- <文件>` 归到提交。
- `apps/web` 的 11 个文件、`tasks-web-guard.yml`：本分支与合并基 `8e2e40d125` 相同（从没碰过），合并结果就是 main 的版本。拿 `62c883a0ac` 当基对它们做三方合并时 `tasks-web-guard.yml` 会报冲突，那是基选错了（`62c883a0ac` 早于这些文件在 main 上的改动），与这次合并无关。

| 文件 | 合并处置 | 与 main 的差（`f1510d0bed` / `773ad84789`） | 差的来源 |
|---|---|---|---|
| `.github/workflows/tasks-realdb.yml` | A | +5 / +6 | S1–S5 各加一个 lane 文件（`e5f6ab0ee0`、`420b9ed729`、`35900fe984`、`acd3846799`、`fd1399bc05`）；S6 再加一个 |
| `src/routes/tasks.ts` | A | +55 −36 / 同 | S3 `35900fe984`（请求辅助函数移到 `tasks-http.ts`、设置路由注册、分页）、S4 `acd3846799`（`PATCH /api/tasks/:id`、POST 新字段）、S5 `fd1399bc05`（清单路由注册） |
| `src/services/task-create.ts` | A | +4 −14 / 同 | S4 `acd3846799`（`isStorableText` 移到 `src/tasks/task-ids.ts`，这里重新导出） |
| `src/services/task-ids-runtime.ts` | A | +14 / 同 | S1 `e5f6ab0ee0`（三个 id 生成器） |
| `src/services/task-records.ts` | A | +237 −43 / 同 | S2 `420b9ed729`、S3 `35900fe984` 与 `b2da6df9e9`、S4 `acd3846799`、修复切片 `83db9f24aa` |
| `src/services/task-structure.ts` | C | +16 −24 / 同 | S2 `420b9ed729`（角色解析带清单身份）；main 第 4 轮的注释在结果里 |
| `tests/integration/task-p0a.db.test.ts` | A | +5 / 同 | S4 `acd3846799`（§5.4 的既有断言） |
| `tests/tasks-auth/tasks-auth-gate.ts` | C | +110 / 同 | S5 `fd1399bc05`（清单第二租户格）、修复切片 `83db9f24aa`（种子带 `org_id`）；main 的门 1 与门 2/16 注释在结果里 |
| `tests/unit/task-ids-runtime.test.ts` | A | +27 −1 / 同 | S1 `e5f6ab0ee0`、`c61407885a` |
| `tests/unit/tasks-route-errors.test.ts` | C | +98 / +129 | S4、S5；main 的 M3R4-TAM-4 一格在结果里；S6 加 6 格 |
| `vitest.config.ts` | C（结果 = 本分支） | +5 / +6 | S1–S5 各一个 exclude 字面量，S6 再加一个。本分支相对 `62c883a0ac` 另多 14 行，来自 main 的 #6205、#6060（经 `00ddafad23` 带入），main 也有这 14 行，所以不在与 main 的差里 |
| `tests/helpers/tasks-http-harness.ts` | 两边相对基都没改，= main | 0 / +4 −3 | S6（`rawRequest` 多回 `text`） |
| 其余 24 个（`apps/web` 11、`tasks-web-guard.yml`、5 份 M3 文档、M3 迁移、3 个 M3 真库文件、3 个 M3 单测文件） | B，或只有 main 改过，或两边都没改 | 0 / 0 | — |

§S2.3 的 needle 在 `773ad84789` 上重数：`(tasks.org_id = ${ORG_PLACEHOLDER}) AND ` 1、`.join(' OR ')` 1、`(assigneeCount > 0 || roles.includes('creator'))` 1、`COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone)` 4、`case 'assigned':` 2、`assignee: {` 1，与 §S2.3 相同；`task-access.ts` 自合并前的 `0de12b4a9d` 起没有改动。`task-list-access.ts` 的清单 org needle 1 处；任务域源码里 `pg_advisory_xact_lock(hashtext(` 仍是 `task-advisory-locks.ts` 的 3 处（门 7）。

### S6.1 交付内容

| 文件 | 内容 |
|---|---|
| `packages/core-backend/src/tasks/task-lists.ts`（末尾追加） | `canRemoveListMember({ role, isSelf })` = `role !== 'none'` 且（`canListAction({ role }, 'manage_members')` 或 `isSelf`）；`'none'` 恒假，不论 `isSelf`（`[own-14]`）。任务 D 与 S5 已有的函数一个没动。 |
| `packages/core-backend/src/tasks/task-list-access.ts`（末尾追加） | `TASK_LIST_MEMBER_PAGE_SORT_KEY = 'task_list_members.user_id COLLATE "C"'`（`[own-40]`：字节序，不随库的缺省排序规则变；`(list_id, user_id)` 是主键，清单内全序）。 |
| `packages/core-backend/src/services/task-org-members.ts`（新） | `findActiveOrgMembers(db, orgId, userIds)`：`user_orgs ⋈ users`，`uo.org_id = $1 AND uo.user_id = ANY($2) AND uo.is_active = true AND u.is_active = true`，与 `AuthService.resolveSessionTenantId` 解析会话 org 的判据同形（`[R17]`）；`assertActiveOrgMembers` ⇒ 422 `INACTIVE_ORG_MEMBER`，不区分四种失败。本片只接清单成员与转让目标；负责人、关注人、创建归 S9。 |
| `packages/core-backend/src/services/task-list-records.ts` | `writeListEvent` 加可选 payload（S5 的四种事件仍写 `{}`，成员与转让事件写 `{ targetUserId }`）。新增：`listTaskListMembers`（`plainDb`；成员 404 → 分页 422；`{ items: [{ userId, role, createdAt }], total }`，`[own-42]`）、`addTaskListMember`（能力 → `userId` → `role` → 全部成员行 → 在职查询 → `applyAddMember`，`[own-41]`）、`changeTaskListMemberRole`（`not_found` ⇒ 404）、`removeTaskListMember`（§3.3 ①–⑤ 顺序：`loadMemberList` 的成员行 404 → `canRemoveListMember` 404 → 路径 id 422 → 名单 → `applyRemoveMember`）、`transferTaskListOwner`（`applyTransferOwner` 判为真转让才查在职，先降后升）。四个写都在 `withOrgStructure` 里；成功体 `{ id, members: [{ userId, role }] }`，`members` 按 `userId` 字节序（与 M3 `membershipResponse` 同一比较；成员 id 受库里的可打印 ASCII CHECK 约束，JS 的字符串比较与 `COLLATE "C"` 给出同一顺序）。成员写不碰 `task_lists.updated_at`。模块头注释与 `addTaskListMember` 的注释在 `716fad6252` 改过（见本节抬头）。 |
| `packages/core-backend/src/routes/tasks-lists.ts` | 5 条路由，注册在 `GET/PATCH /:id` 之前；`GET …/members` 缺 org 404，四条写缺 org 422；都是 `authenticate` + `rbacGuard('tasks', 'read' \| 'write')`，没有 `tasks:admin`；仍没有删清单的路由（`[R13]`）。 |
| `packages/core-backend/tests/integration/task-m4-list-members.db.test.ts`（新） | 见 §S6.2（`716fad6252`、`773ad84789` 补的断言也在那里）。登记三处：`vitest.config.ts` exclude 裸字面量、`tasks-realdb.yml` 清单、文件顶部 `assert-rbac-optional-off`。 |
| `packages/core-backend/tests/helpers/tasks-http-harness.ts` | `rawRequest` 的结果多一个 `text`（原样响应体，供逐字节比较）。路径字节须原样到达服务端的请求一律经它发送（见 §S6.5-1）。 |
| `packages/core-backend/tests/unit/task-lists.test.ts` | `canRemoveListMember` 真值表 8 格，与 `canListAction` 的一致性 1 格。 |
| `packages/core-backend/tests/unit/task-list-access.test.ts` | 成员排序键 1 格。 |
| `packages/core-backend/tests/unit/task-records-guards.test.ts` | 共享 mock 加 `state.respond`（按语句给行，缺省仍是空行集，S5 以前的格不受影响）。S6 9 格：四个写的首句是 `SET TRANSACTION …` 且清单不存在时 404 先于请求体 / 路径 id、无写语句、无在职查询；五个函数对不可存清单 id 都 404 且没有语句携带它；无成员行的调用者 404 先于能力、请求体与路径 id，不组名单、不查在职；加成员的在职查询在锁后、事务内，否定答案 422 且不写；已是成员空操作、新成员恰一条 `INSERT` 加一条带 `targetUserId` 的事件；成员 id 先于角色（`[own-41]`），两者都先于名单与在职查询；DELETE 的 `read` 成员只能点名自己、路径 id 在其后、名单只在其后才读、`edit` 成员的坏 id 是 422；转让只对真转让查在职、查在职先于两条 `UPDATE`、先降后升、自转让与目标非成员都不查不写、停用目标不写；改角色的目标非成员 404（请求体解析之后）、所有者 422、同角色不写。 |
| `packages/core-backend/tests/unit/tasks-route-errors.test.ts` | 5 条路由各一格「驱动错误 ⇒ 500 `INTERNAL`、不回显」；1 格「路由把两个路径 id、原始请求体、原始 query 原样交给服务」。 |
| `packages/core-backend/vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 各加一行新文件。`tasks-realdb.yml` 没有 `paths` 过滤；`plugin-tests.yml` 的 `pull_request` 也没有，`push` 的过滤含 `packages/core-backend/**`，新文件都在其中。 |
| 设计 §11 | 追加 `[own-40]`（名单字节序）、`[own-41]`（成员 id 先于角色；在职查询在其后、事务内）、`[own-42]`（`GET …/members` 照 `[own-33]`）。 |

**行级判定顺序**（锁后）：缺 org（路由层：写 422 `ORG_MISSING`，`GET …/members` 404）→ 路径里的清单 id 不可打印 ⇒ 404，不发 SQL → 按 id 与 org 取清单行，没有 ⇒ 404 → 调用者没有成员行 ⇒ 404（`loadMemberList`，先于一切能力）→ 能力：增 / 改用 `canListAction('manage_members')`、转让用 `canListAction('transfer_owner')`、删用 `canRemoveListMember({ role, isSelf })`，为假 ⇒ 404 → 成员 id（路径段或请求体 `userId`）⇒ 422 `INVALID_MEMBER` → `role` ⇒ 422 `INVALID_ROLE` → 读全部成员行 → 增成员查在职 → 纯函数 → 转让对真转让查在职 → 写行与事件。成功体里的成员名单只在能力判定通过之后才被读出：同 org 的非成员对自己发 `DELETE`、被移出的前成员再发同一个 `DELETE`，得到的都是与不存在的清单逐字节相同的 404，响应里没有任何成员 id。

`ASSUMPTION(task-m4)` 标签：`[R12]`（创建人不可移除、所有者先转让、转让后降为 `edit`、`owner` 只经转让）、`[R17]` `[own-27]`（在职校验：新成员、转让目标）、`[own-16]`（操作者本人的在职不决定结果）、`[own-14]`（本人退出）、`[own-09]`（行级一律 404）、`[own-36]`（S5 事件 payload 不变）、`[R13]` `[R18]`、`[own-40]`、`[own-41]`、`[own-42]`。本片新起三个编号（S1–S4 修复切片止于 `[own-39]`），都是设计里没有定值的地方，待 owner 裁：

- **`[own-40]`** 名单顺序：`user_id` 字节序。设计 §3.3 只说写路由成功体「按 `userId` 字节序」，没说 `GET …/members` 的顺序，也没说字节序怎样落到 SQL；本片 SQL 端用 `COLLATE "C"`（本地两个库的缺省排序规则都是 `en_US.UTF-8`，在它下面 `Zeta_…`、`alpha_…`、`Beta_…` 的先后与字节序不同，M20 证明有格钉住），JS 端用与 M3 相同的字符串比较。
- **`[own-41]`** 校验顺序：能力之后先成员 id、后角色；两者都非法时报 `INVALID_MEMBER`。设计 §3.0 只说两者都在能力之后。在职查询在这两步之后、读完成员行之后、事务内；对已是成员的目标也查（结果被 `applyAddMember` 的「已是成员 ⇒ 空操作」盖过），多一次索引查询，少一处与纯函数重复的判断。
- **`[own-42]`** `GET …/members`：缺 org 404、非成员 404 先于分页 422，照 `[own-33]`（S5 对 `/events` 的取法），不取 §3.0 字面上「集合型读路由降级」的读法。

### S6.2 `task-m4-list-members.db.test.ts`

org 前缀 `org_tasks_m4lmem_`（与 `m4lcore_` 等既有前缀互不为前缀）。参与者用 `seedTaskActor`，能被写进清单的目标用 `seedOrgMembers`（`users` + `user_orgs`），`afterAll` 用 `dropTaskM4Fixtures`。HTTP 经本文件的一个监听（`tasks-http-harness.ts`，`RBAC_TOKEN_TRUST='true'`）；路径字节须原样到达服务端的请求经 `rawRequest`（文件内 `send()` 按路径自动选）。路由造不出来、或格不经路由造的东西用 SQL 播种：创建人不是所有者的清单、没有 org 关系的成员 id、满员的名单、名单格旁边的第二张清单。凡期望 404 的格，都把响应体与「不存在的清单 id」的响应逐字节比较（`NOT_FOUND_TEXT`）；写格另比较整个清单（行、成员行、事件）或整个 org 的状态（`listState` / `orgState`），前后必须相同。

| 组 | 格数 | 内容 |
|---|---|---|
| 名单 | 2 | `read` 成员取名单：`{ items: [{ userId, role, createdAt }], total }`，顺序是字节序（六个 id 里有 `Zeta_…` / `alpha_…` / `Beta_…`，字节序与 locale 排序不同），每项与库一致；同 org 另有一张 3 个成员的清单，名单与 `total` 都只算本清单；`limit=2` 三页不重不漏、越过末尾 `{ items: [], total: 6 }`。非成员对不带分页、`limit=0`、`offset=-1` 都是逐字节同不存在的 404，响应不含所有者 id；成员 `limit=101` ⇒ 422 `INVALID_LIMIT`、`offset=x` ⇒ `INVALID_OFFSET`；缺 org 404。 |
| 增 | 10 | `edit` 与 `owner` 各加一人：体 = 库里名单（含新成员）；事件 `created`、`member_added {targetUserId}` ×2，`actor_id` 是调用者；`task_lists.updated_at` 不变、详情的 `updatedAt` 不变。已是成员（换角色、或目标是调用者自己）空操作：200、同名单、清单状态逐字节不变。`read` 成员与非成员对 4 种体（合法、`role: 'owner'`、`userId: '..'`、空对象）都是逐字节同不存在的 404，org 零变化。`edit` 成员传 `role` 为 `owner` / `admin` / `Read` / `''` / `7` / `null` / 缺键 / 数组 ⇒ 各 422 `INVALID_ROLE`，清单不变，恰一行 `owner`。11 种坏 `userId`（缺、空、`.`、`..`、含 U+0000、含空格、256 字节、数字、数组、`'..'` 配 `role: 'owner'`、数组体）⇒ 422 `INVALID_MEMBER`。R17 四格（`it.each`）：他 org 用户、`users.is_active = false`、`user_orgs.is_active = false`、完全不存在的 id ⇒ 422 `INACTIVE_ORG_MEMBER`，清单不变（同 org 在职的正控就是第一格）。上限：SQL 播到 100 行后再加 ⇒ 422 `LIMIT`，而对既有成员（没有 org 关系的 id）再发仍是 200 空操作（纯函数的「已是成员」先于在职与上限）。 |
| 改角色 | 6 | `edit` 降 `edit → read`、`owner` 升 `read → edit`：体 = 库里名单；事件 `member_role_changed {targetUserId}`；同角色空操作；`updated_at` 不变。所有者被改角色（`edit` 与所有者本人各试 `read` / `edit`）⇒ 422 `OWNER_MUST_TRANSFER`。目标不是成员 ⇒ 逐字节同不存在的 404；坏角色（`owner` / `admin` / 缺键）由所有者与 `edit` 成员各发，对非成员目标、所有者、`read` 成员、`edit` 成员都是 422 `INVALID_ROLE`，清单不变、恰一行 `owner`（`716fad6252`）。`read` 成员与非成员对 4 种目标（别人、自己、`..`、`usr%00x`）× 3 种体都是逐字节同不存在的 404，org 零变化。管理者对 5 种坏路径段（`.`、`..`、`usr%00x`、`usr%20x`、256 字节）× 2 种体 ⇒ 422 `INVALID_MEMBER`。`edit` 成员把创建人降为 `read`：创建人仍能归档与取消归档（`myRole` 为 `read`），改名 404（S5 §S5.6-9 的 SQL 近似，本片经路由做实）。 |
| 删 | 8 | 同 org 非成员对自己、别人、所有者、`..`、`.`、`usr%00x` 发 `DELETE`：逐字节同不存在的 404，响应不含任何成员 id，org 零变化。经路由被移出的前成员再对自己发同一个 `DELETE` ⇒ 同一个 404，取名单也 404，事件只多一条 `member_removed`。`read` 成员删别人、删所有者、删 `..` / `usr%00x` / 不存在的 id ⇒ 都是 404（坏 id 不是 422：③ 先于 ④），目标行还在。`read` 成员本人退出 ⇒ 200，行消失，一条 `member_removed`（actor 与 target 都是本人），名单不含本人，`updated_at` 不变，随后取清单 404。管理者删 `read` 与 `edit` 成员，体 = 库里名单；目标不是成员（刚删掉的、从未存在的）⇒ 200 空操作，状态不变。创建人（`edit` 成员删、所有者删、本人退出）⇒ 422 `CREATED_BY_IMMUTABLE`；所有者（`edit` 成员删、本人退出）⇒ 422 `OWNER_MUST_TRANSFER`。管理者对 5 种坏路径段 ⇒ 422 `INVALID_MEMBER`。只有清单身份的 `read` 成员：移出前任务详情 200，经路由移出后 404、与缺失 id 逐字节相同。 |
| 转让 | 6 | 所有者转给 `edit` 成员：原所有者变 `edit`、新所有者 `owner`，体 = 库里名单，详情的 `ownerId` / `myRole` / `createdBy` 相应；前所有者再转让 404；新所有者转给 `read` 成员 200；恰一行 `owner`；事件 `owner_transferred {targetUserId}` ×2；`updated_at` 不变。目标是现任所有者 ⇒ 200 空操作、状态不变。`edit`、`read`、非成员对 4 种体（自己、`edit` 成员、`..`、空）⇒ 逐字节同不存在的 404，org 零变化。目标非成员（同 org 在职的、既不是成员也没有任何 org 关系的 id 各一）⇒ 422 `TARGET_NOT_MEMBER`（后者在 `773ad84789` 补：在职查询只对真转让）；6 种坏 `userId` ⇒ 422 `INVALID_MEMBER`；清单不变。目标是成员但 `user_orgs.is_active = false` / `users.is_active = false`（`it.each`）⇒ 422 `INACTIVE_ORG_MEMBER`，两行角色不变、无事件。 |
| 权限码与缺 org | 6 | 5 条路由各一格：调用者是成员但角色只有另一个码 ⇒ 403 `{ error: 'Insufficient permissions' }`，org 零变化；只有本路由那个码的成员 ⇒ 200（转让格里他是所有者）。缺 org：四条写 422 `ORG_MISSING`、名单 404，清单不变。 |

静态展开数：2 + 10 + 6 + 8 + 6 + 6 = **38**；§S6.3 的三遍 lane 都收集并通过 38（门 17 ②）。

### S6.3 命令与结果

所有命令在 `packages/core-backend` 下（ops 测试在仓库根），`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<库> EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`；迁移 `MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项（M4 迁移不在排除里）。除合并检查外，全部在代码最终 head `773ad84789` 上跑（本节所在提交只改两份文档；读设计文档的 `task-gate19-identities` 只读 `i-m4` 块，本次没有改它）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .`，退出码直接取 `$?` | 退出码 0，没有输出 |
| 本片测试文件的类型 | 临时 tsconfig（`extends` 本包配置，`module: esnext`、`moduleResolution: bundler`、`noUnusedLocals`、`types: ["node"]`，`include` 只列新真库文件、`task-m4-fixtures.ts`、`tasks-http-harness.ts` 与四个单测文件），放在私有工件目录 | 这 7 个文件 0 条诊断；本片的 5 个 `src` 文件（经 import 进入这次编译，`--listFilesOnly` 核过）0 条。另有 47 条都在与本片无关的 `src` 文件里：34 条 TS2339 是 Express `Request` 的增补属性（`user`、`authenticatedTenantId`、`apiTokenId` 等）在这套只含测试文件的配置里没有被引入，13 条 TS6133 / TS6196 是 `noUnusedLocals` 的提示（修复切片 §F.3 记过同一现象） |
| 本片单测 + 门 20 + 三集合枚举 | `vitest run tests/unit/task-lists.test.ts tests/unit/task-list-access.test.ts tests/unit/task-records-guards.test.ts tests/unit/tasks-route-errors.test.ts tests/unit/task-pure-no-io.test.ts tests/unit/task-ci-coverage-enumeration.test.ts` | 6 files / **183 passed**（本片四个文件 174；门 20 harness 5，`task-lists.ts`、`task-list-access.ts` 在扫描人口里；三集合枚举 4，新真库文件三处登记一致） |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 5 failed \| 1078 passed \| 172 skipped (1255)；Tests 44 failed \| 18578 passed \| 1712 skipped (20334)**，132 秒。总数对账：修复切片 §F.3 的 20301，加合并带进来的 8（`task-deletion-lock-errors` 6；main 给 `internalCases` 加的一行在本分支有两个 `it.each` 用它，+2），加本片 25（9 + 1 + 9 + 6）= 20334；文件数 1254 + 1 = 1255。失败见下段 |
| 真库 lane × 3（13 文件，`tasks-realdb.yml` 清单，`m4g_s6final`） | `vitest --config vitest.integration.config.ts run <13 files> --reporter=verbose` | 三遍均 **Test Files 13 passed (13)；Tests 590 passed (590)**，43.76–44.29 秒，`socket hang up` / `ECONNRESET` 0 次。逐文件：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m3-comments-deletion 33、m4-schema 59、m4-list-roles 49、m4-paging-settings 77、m4-dates 107、m4-lists 64、**m4-list-members 38**（552 + 38） |
| 鉴权门 × 2（`m4g_s6final`） | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false` 由配置与 `setup.ts` 给，`setup.ts` 不是这两个值就抛） | 两遍 **24 passed (24)** |
| manifest（仓库根） | `node --test scripts/ops/global-history-flag-manifest.test.mjs` | 36/36 |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫 `git diff --name-only f1510d0bed` 与工作树的并集：本片改动的 13 个代码 / 测试 / 登记文件与两份文档，共 15 个 | 退出 0 |
| 变异 | §S6.4 | 53 / 53 变红 |

**全量单测的 5 个失败文件都与本片无关**（都不 import 任何任务模块，自合并前的 `0de12b4a9d` 起都没有改动）：

- `multitable-recovery-archive-file-store`、`-local-startup`、`-local-custody-store`、`-archive-reader`（22 + 16 + 4 + 1 = 43 格，`RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED` / `RECOVERY_LOCAL_CUSTODY_STORE_REFUSED`）：§S5.4 与 §F.3 记过的本机临时卷 `statfs` 类型问题，失败数与 §F.3 相同。
- `attendance-admin-plugin-lib-dist-layout-boot`（1 格）：`ELOOP`，路径是本 worktree 的 `plugins/plugin-attendance/node_modules`（指向规范检出的同名目录）之下无限嵌套的 `node_modules/node_modules/…`。规范检出里 `plugins/plugin-attendance/node_modules/node_modules` 是指向它自己所在目录的符号链接，10-07 19:28 又被重建（§S5.4 记过同一问题，§F.3 那一次没有出现）。按指令不碰任何 `node_modules`，留给 owner 处理。

### S6.4 变异证明

做法（第二、三轮，同一个脚本）：断言 needle 恰出现应有的次数 → 把原文件的字节存到工作树之外（私有工件目录）→ 写入变异 → 跑 → 写回原字节 → `cmp -s` 比较，两轮各 53 个都逐字节相同；两轮结束后 `git status` 都只有两份未提交的文档。首轮用的是旧脚本（备份放在被改文件旁边，还原后按字符串比较），39 个都还原。逐个串行，期间不跑别的 vitest 进程。DB = `task-m4-list-members`（38 格，`m4g_lane`）；UNIT = `task-lists` + `task-list-access` + `task-records-guards` + `tasks-route-errors`（174 格）。DB 与 UNIT 各写各的日志、各记各的 `Tests` 行；只有出现失败格才算变红，没有一个变异是因为收集失败或进程崩溃而「变红」的。

三轮：首轮 39 个（M01–M35，M24 分 a–e）在 `3e2699758c` 上跑过，全部变红（当时的脚本把一条命令里 DB 与 UNIT 两次运行的输出写进同一个日志、只记最后一个 `Tests` 行，所以汇总里 M23、M25 看上去是 174/174；逐个日志里它们的 DB 一半分别是 6/38、1/38 失败）。第二轮在 `716fad6252` 上跑 53 个（加 M36–M49）：M36、M37 存活（名单格是文件的第一格，那时库里只有它自己的一张清单，名单读不按清单过滤也看不出来）；M39 只有单测变红（HTTP 上只有「目标既非成员也不在本 org」才分得出两种顺序，原来没有这一格）。`773ad84789` 补了这两处断言。第三轮在 `773ad84789` 上跑全部 53 个，下表就是这一轮的结果。

| # | 变异（文件） | DB / UNIT 失败 | 变红的格 |
|---|---|---|---|
| M01 | 删掉「没有成员行 ⇒ 404」（服务 `loadMemberList`） | 7/38；— | 非成员的名单、增、改角色、删自己、转让各 404 格；前成员格；本人退出格 |
| M02 | `canRemoveListMember` 去掉 `isSelf` 一支（纯函数） | 2/38；3/174 | 本人退出格；创建人不可删格里创建人（`read` 成员）本人退出那一步（成了 404）；真值表与一致性两格；DELETE 顺序单测 |
| M03 | `canRemoveListMember` 改成 `isSelf` 先于 `'none'` 判（纯函数） | 只跑 UNIT：2/174 | 真值表 `none` / `isSelf` 格、一致性格。HTTP 上不可达：非成员在 `loadMemberList` 已经 404，只能由单测证 |
| M04 | DELETE 先校验路径 id、后判 `canRemoveListMember`（服务） | 1/38；1/174 | `read` 成员删别人 / 坏 id 格（坏 id 成了 422）；DELETE 顺序单测 |
| M05 | DELETE 用 `manage_members` 判定（服务） | 2/38；1/174 | 本人退出格；创建人本人退出那一步（成了 404）；DELETE 顺序单测 |
| M06 | `applyRemoveMember` 去掉「创建人不可移除」（纯函数） | 1/38；2/174 | 创建人 / 所有者不可删格；两格既有纯函数单测 |
| M07 | `applyRemoveMember` 去掉「所有者先转让」（纯函数） | 1/38；1/174 | 同上格；一格既有纯函数单测 |
| M08 | 转让先升后降（服务） | 2/38；1/174 | 转让格与转让的权限码格（23505 ⇒ 500）；转让顺序单测 |
| M09 | 转让去掉在职校验（服务） | 2/38；1/174 | 停用目标两格；转让顺序单测 |
| M10 | 加成员的在职恒为真（服务） | 4/38；1/174 | 在职四格；在职查询单测 |
| M11 | 在职查询去掉 `u.is_active = true`（helper） | 2/38；1/174 | 加成员与转让的 `users.is_active = false` 格；在职查询单测（断言 SQL 含两个合取） |
| M12 | 在职查询去掉 `uo.is_active = true`（helper） | 2/38；1/174 | 加成员与转让的 `user_orgs.is_active = false` 格；同一单测 |
| M13 | 在职查询不看 org（helper） | 1/38；— | 他 org 用户格 |
| M14 | 可指派角色常量含 `owner`（纯函数） | 2/38；7/174 | 加成员 `role: owner` 格（`INSERT` 撞 `uq_tlsm_owner`，500）；改角色坏角色格（第一步对非成员目标就成了 404）；5 格既有纯函数单测、2 格服务单测 |
| M15 | `applyChangeMemberRole` 去掉「所有者先转让」（纯函数） | 1/38；2/174 | 所有者改角色格；纯函数与服务单测各一 |
| M16 | 改角色目标非成员时回 200 空操作（服务） | 1/38；1/174 | 目标非成员格；改角色单测 |
| M17 | 成员事件 payload 恒为 `{}`（服务） | 6/38；4/174 | 增、改角色、前成员、本人退出、管理者删除、转让各格的事件断言；4 格服务单测 |
| M18 | 加成员时写 `task_lists.updated_at`（服务） | 1/38；— | 增格（`updated_at` 与详情的 `updatedAt` 不变那两步） |
| M19 | 名单 `total` 改成本页条数（服务） | 1/38；— | 名单格（`limit=2` 时 `total` 应为 6） |
| M20 | 名单排序键去掉 `COLLATE "C"`（纯函数常量） | 1/38；1/174 | 名单格（本地库 `en_US.UTF-8` 下顺序变了）；排序键单测 |
| M21 | 自转让不再空操作（纯函数） | 1/38；2/174 | 自转让格；纯函数与服务单测各一 |
| M22 | 已是成员不再空操作（纯函数） | 2/38；3/174 | 已是成员格；上限格里既有成员那一步；两格纯函数单测与服务单测 |
| M23 | 写成功体的名单不排序（服务） | 6/38；0/174 | 增、已是成员、改角色、管理者删除、转让、自转让各格（体 ≠ 库里按字节序读出的名单） |
| M24a–e | 五条路由各自的守卫码换成另一个码（路由） | 各 1/38；— | 各自的权限码格 |
| M25 | 加成员先校验请求体、后判能力（服务） | 1/38；0/174 | `read` 成员 / 非成员增 404 格（坏体成了 422） |
| M26 | `edit` 角色有 `transfer_owner`（纯函数表） | 2/38；1/174 | 转让格（降为 `edit` 的前所有者再转让应 404）；非所有者转让格；既有 `canListAction` 单测 |
| M27 | 名单读先解析分页、后取清单（服务） | 1/38；— | 名单非成员格（`limit=0` 成了 422） |
| M28 | 去掉成员上限（纯函数） | 1/38；1/174 | 上限格；既有纯函数单测 |
| M29 | 删除不发 `DELETE`（服务） | 4/38；1/174 | 前成员、本人退出、管理者删除、移出后详情 404 各格；DELETE 顺序单测 |
| M30 | 名单读缺 org 改成降级体（路由） | 2/38；— | 名单非成员格与缺 org 格里缺 org 那一步 |
| M31 | `isSelf` 恒为真（服务） | 1/38；1/174 | `read` 成员删别人格；DELETE 顺序单测 |
| M32 | 转让用 `manage_members` 判定（服务） | 2/38；— | 转让格（前所有者再转让应 404）；非所有者转让格 |
| M33 | 改角色不发 `UPDATE`（服务） | 2/38；1/174 | 改角色格（体与库里的名单不同）；降创建人格（库里创建人仍是 `edit`，归档体的 `myRole` 不是 `read`）；改角色单测 |
| M34 | 加成员不写事件（服务） | 1/38；1/174 | 增格；加成员单测 |
| M35 | 加成员的 `userId` 只查「非空字符串」（服务） | 4/38；2/174 | 增的坏 `userId` 格，以及改角色、删除、转让的坏 id 格（同一个 `requireMemberId`）；两格服务单测 |
| M36 | 名单行读不按清单过滤（服务） | 1/38；— | 名单格（第二张清单的成员混进来；`773ad84789` 之前存活） |
| M37 | 名单 `total` 不按清单过滤（服务） | 1/38；— | 名单格（同上） |
| M38 | 写路径读成员行不按清单过滤（服务） | 10/38；0/174 | 增、已是成员、上限、改角色、前成员、本人退出、管理者删除、转让、自转让、加成员权限码各格 |
| M39 | 转让的在职查询挪到纯函数之前、每次都查（服务） | 1/38；1/174 | 转让「目标非成员」格（没有 org 关系的 id 成了 `INACTIVE_ORG_MEMBER`；`773ad84789` 之前只有单测变红）；转让顺序单测 |
| M40 | 删除时不把创建人传给纯函数（服务） | 1/38；0/174 | 创建人 / 所有者不可删格 |
| M41 | 成员事件的 `actor_id` 写成目标（服务） | 5/38；3/174 | 增、改角色、前成员、管理者删除、转让各格的事件断言；3 格服务单测 |
| M42 | 转让路由缺 org 回 404（路由） | 1/38；— | 缺 org 格 |
| M43 | DELETE 路由把调用者当作目标（路由） | 6/38；1/174 | 删组 6 格；路由透传单测 |
| M44 | PATCH 不校验路径 id（服务） | 1/38；0/174 | 改角色坏路径段格（`.` 等成了 404） |
| M45 | DELETE 不校验路径 id（服务） | 1/38；1/174 | 删除坏路径段格；DELETE 顺序单测 |
| M46 | 转让不校验请求体 `userId`（服务） | 1/38；0/174 | 转让坏 `userId` 格（成了 `TARGET_NOT_MEMBER`） |
| M47 | 加成员的 `INSERT` 恒写 `read`（服务） | 1/38；1/174 | 增格（体里是 `edit`，库里是 `read`）；加成员单测 |
| M48 | 改角色的 `UPDATE` 不限于目标行（服务） | 1/38；— | 改角色格 |
| M49 | 删除的 `DELETE` 不限于目标行（服务） | 1/38；— | 管理者删除格 |

没有做、或判为等价的变异：`listTaskListMembers` 里的 `assertListAction(…, 'view')` 去掉——每个成员角色都有 `view`，非成员在它之前已经 404，等价；`findActiveOrgMembers` 对空数组的捷径——没有调用方传空数组，不可达；`assertActiveOrgMembers` 的 `some` 换成 `every`——两个调用点都只传一个 id，等价。脚本、变异定义、三轮的汇总与逐个日志都在私有工件目录（脚本读 `MUTANTS` / `RESULTS` / `LOGDIR` / `MUT_DB` / `ONLY` / `DRY`）。

### S6.5 与设计的偏差

1. **首跑 36/38，两格是测试自己的错**：两格的请求路径没有按原样发出，比较的对象不对。修法：`rawRequest` 加 `text`，路径字节须原样到达服务端的请求一律经它发送（文件内 `send()`），三格改后 38/38。生产码没有因此改动。
2. **`GET …/members` 缺 org 回 404**（`[own-42]`），不是 §3.0 字面的集合降级体；理由同 `[own-33]`。S10 的 `M4_ROUTES` 要按 404 写。
3. **加成员总是查一次在职**，包括目标已是成员的空操作，也包括目标就是调用者本人的时候（`[own-41]`）；设计 §4.6 只说「结果作为 `isActiveInOrg` 传给 `applyAddMember`」。调用者本人一定已是成员，查询结果被空操作盖过，所以 `[own-16]`「操作者本人豁免」在这条路由上是「结论不受影响」，不是「不查」（`716fad6252` 把注释改成这样说）。
4. **`NOT_OWNER` 不可达**：转让先过 `canListAction('transfer_owner')`（只有 `owner`），`applyTransferOwner` 的 `not_owner` 在同一事务里不会再出现；仍按 §3.0 的通则映射，不另写分支。
5. **权限码格是额外的**（与 S5 同形，`RBAC_TOKEN_TRUST='true'` 下按路由钉 `read` / `write`，M24a–e 证红）；门 2 / 16 的三件事仍归 S10。
6. **单测的共享 mock 多了 `state.respond`**：S5 的格靠「全部空行集」，本片的语句顺序格需要清单行与成员行，钩子缺省仍返回空行集，S5 的格一个没改。
7. **`requireMemberId` 放在 `task-list-records.ts`**，答 `INVALID_MEMBER`；M3 的 `requireMemberUserId` 在 `task-structure.ts` 答 `INVALID_ASSIGNEES`。校验器是同一个 `isValidMemberId`（设计 §3.0），只是码不同。
8. **名单读取对 `createdAt` 的来源**：`task_list_members.created_at`。（S6+S7 闸修复更正：S6 当时写「所有者行与清单行都取缺省 `now()`」；自 `dcc498f6e4` 起建清单时清单行取锁后一次 `clock_timestamp()`，所有者行复制它；经 `POST …/members` 加入的成员行仍取列缺省 `now()`，即该次写事务的开始时刻，取在等结构锁之前，所以 `createdAt` 不与 `/events` 排序对齐。设计 §3.3、§4.4 写明这一口径。）
9. **成员路由不读 `task_lists.archived_at`**：已归档清单的成员照常增删改转（设计 §3.2：归档只影响「我的清单」的缺省过滤）。（S6+S7 闸修复补了格：`members|archived` 在归档与未归档两张清单上跑同一串成员路由并逐一比较，变异 D24–D29 各自变红。）

### S6.6 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17（同 §S1.9）。`COLLATE "C"` 的判别只在本地 `en_US.UTF-8` 库上证过（M20）；CI 的 postgres 镜像用什么缺省排序规则没有查——`COLLATE "C"` 正是为了让这件事无关。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- 五条新路由在 trust-off 配置下的门 1 缺 org 格、门 2 / 16 的非 admin 三件事、路由人口枚举：归 S10（`M4_ROUTES` 加 5 条）。
- 成员写的并发：没有并发格（设计 §13 S6 也没有）；四个写都在 org 结构锁里，首句与取锁由单测钉住，所有者唯一由 `uq_tlsm_owner` 兜底（M08 证明先升后降会撞它）。
- 成员路由上的第二租户格（他 org 的清单）：本文件没有；成员路由与 S5 的路由共用 `loadMemberList`，它按 token 的 org 取清单行，S5 的第二租户格与负控 2 覆盖的是同一处。
- `MetaSheetServer` 对顶层非对象 JSON 请求体的响应（同 §S3.6 第 6 条）：本片只用测试 express 实例测了数组体。
- 已离开 org 的现任所有者（§12-Q17 的死角）：没有格，本片也没有给它出口。
- 本片测试文件的类型只在 §S6.3 那份临时配置下查过；仓库的 `tsconfig.json` 不含测试文件。
- 全量单测里 5 个与本片无关、因本机环境失败的文件（§S6.3）：本片没有修它们。
- S9 的在职种子：本片新文件里经路由加的成员都用 `seedOrgMembers` 播过 `user_orgs`，S9 回填 M2/M3 时本文件不需要再补。

### S6.7 给 S7 的交接

- `task-list-records.ts` 里已有 `bodyField(body, key)`、`requireMemberId`、`loadMembers`、`membersJson`、`writeListEvents(db, listId, events)` 与带 payload 的 `writeListEvent(db, listId, actorId, type, payload)`；清单项事件 `item_added` / `item_removed` 的 payload `{ taskId }` 直接走后者，任务侧的 `list_added` / `list_removed`（payload `{ listId }`）要写 `task_events`，照 `task-structure.ts` 的 `writeMembershipEvents` 另写一条 `INSERT`。
- 写 `task_list_items` 必须带 `org_id`，取清单行与任务行按 id 取出时绑定的那个 `orgId`（§F.8）；组合外键会拒绝写错的行。
- 任务端的直接角色（`[own-25]`）由 `canAddTaskToList` 在纯函数里以空清单身份解析，服务层不要再调 `loadActorListMemberships`；移出支路要完整角色集，走 `loadRowRoles`。
- 创建人支路的统一 404：清单不存在、他 org、任务不是调用者创建的、任务不在该清单，四种响应逐字节相同；`loadMemberList` 对非成员直接 404，创建人支路要先于它判「调用者是任务创建人」还是在它之后另取清单行，S7 自定；非成员得到的都是同一个 404。
- `rawRequest` 现在带 `text`；路径字节须原样到达服务端的请求只能经它发（本文件的 `send()` 可以照抄）。`TasksClient` 仍没有 `put`。
- 单测 `task-records-guards.test.ts` 的 `state.respond` 可以按语句给行（`FROM task_lists` → 清单行、`FROM task_list_members` → 成员行、`FROM tasks` 等），S7 的语句顺序格可直接用。
- 名单类读格要在库里另有一个同类容器时读（本片 M36 / M37 的教训）：文件里的第一格读时库里往往只有它自己的数据，「不按容器过滤」的变异看不出来。
- org 前缀不要与 `org_tasks_m4lmem_` / `org_tasks_m4lcore_` 互为前缀（例如 `org_tasks_m4litem_`）。
- lane 现在 13 文件 590 格，鉴权门 24 格；全量单测 20334 格（本机 5 个文件因环境失败，§S6.3）。
- S10 的 `M4_ROUTES` 要加本片的 5 条；`GET …/members` 缺 org 是 404（`[own-42]`）。
- 变异脚本（私有工件目录）把 DB 与 UNIT 分开记日志、原字节存在工作树之外、还原后 `cmp`，可直接复用；`DRY=1` 只数 needle。

### S6.8 前端对接（S6 的 5 条路由）

成功体：名单读 `{ items: [{ userId, role, createdAt }], total }`（`createdAt` 是成员行的写入时刻：所有者行等于清单的创建时刻；加入的成员是那次写事务的开始时刻，不与 `/events` 排序对齐，显示「何时加入」可以用，排序与先后看 `/events`）；四条写都回 `{ id, members: [{ userId, role }] }`（`id` 是清单 id，`members` 是写后的完整名单，不分页，按 `userId` 字节序）。`role` 取 `read` / `edit` / `owner`；每张清单恰有一个 `owner`。错误体都是 `{ error: { code } }`；403 仍是 `rbacGuard` 的 `{ error: 'Insufficient permissions' }`。成员写不改清单的 `updatedAt`，也不改清单在「我的清单」里的顺序。合法的成员 id 是 1–255 个可打印 ASCII 字符（`!` 到 `~`），且不是 `.`、`..`。

| 方法 路径 | 码 | 行级 | 请求 | 成功 200 | 错误 | 空操作 |
|---|---|---|---|---|---|---|
| `GET /api/task-lists/:id/members` | read | 成员（任一角色） | query `limit`（1–100，缺省 100）、`offset`（≥ 0） | `{ items, total }`，按 `userId` 字节序 | 404 `NOT_FOUND`（不存在、他 org、非成员、坏 id、缺 org，逐字节相同，且先于分页）；422 `INVALID_LIMIT`、`INVALID_OFFSET`（只对成员） | — |
| `POST /api/task-lists/:id/members` | write | `edit` / `owner` | `{ userId, role: 'read' \| 'edit' }` | `{ id, members }` | 404（含 `read` 成员与非成员，先于请求体）；422 `ORG_MISSING`、`INVALID_MEMBER`（缺、不是字符串、不是合法成员 id；与坏 `role` 同时出现时报它）、`INVALID_ROLE`（`owner` 与闭集外的一切）、`INACTIVE_ORG_MEMBER`（不在本 org 在职）、`LIMIT`（已有 100 人） | 目标已是成员：200 原名单，角色不变，无事件 |
| `PATCH /api/task-lists/:id/members/:userId` | write | `edit` / `owner` | `{ role: 'read' \| 'edit' }` | `{ id, members }` | 404（含目标不是成员——在请求体校验之后）；422 `ORG_MISSING`、`INVALID_MEMBER`（坏路径段）、`INVALID_ROLE`、`OWNER_MUST_TRANSFER`（目标是所有者） | 同角色：200 原名单，无事件 |
| `DELETE /api/task-lists/:id/members/:userId` | write | 成员，且（`edit` / `owner`，或 `:userId` 是本人） | — | `{ id, members }` | 404（非成员对任何目标；`read` 成员对别人——坏路径段也是 404）；422 `ORG_MISSING`、`INVALID_MEMBER`（管理者的坏路径段）、`CREATED_BY_IMMUTABLE`（目标是清单创建人，含创建人自己退出）、`OWNER_MUST_TRANSFER`（目标是所有者，含所有者自己退出） | 管理者删一个不是成员的目标：200 原名单，无事件 |
| `POST /api/task-lists/:id/transfer-owner` | write | 只有 `owner` | `{ userId }` | `{ id, members }`（目标为 `owner`，原所有者为 `edit`） | 404（`edit` / `read` / 非成员）；422 `ORG_MISSING`、`INVALID_MEMBER`、`TARGET_NOT_MEMBER`（目标不是成员，不论是否在职）、`INACTIVE_ORG_MEMBER`（目标是成员但已离开 org 或被停用） | 目标就是现任所有者：200 原名单，无事件 |

事件（`GET /api/task-lists/:id/events`）：`member_added` / `member_removed` / `member_role_changed` / `owner_transferred`，payload 都是 `{ targetUserId }`，`actorId` 是操作者（本人退出时两者相同；转让时 `targetUserId` 是新所有者）。前端据此可以做：成员列表（分页）、加人（目标必须在本 org 在职，否则 422）、改角色（所有者行不可改，提示先转让）、移除（创建人行、所有者行不可移除；非管理者只有「退出」）、转让（只有所有者看得到；目标必须已是成员且在职）。

## S5 闸修复（S5 与修复切片闸审）

基于 `510fba6917`（S0–S6）。闸审清单 7 条存活（0 P1、1 P2、4 P3、2 NIT），全部按属实处理，没有驳回。提交：

| 提交 | 内容 |
|---|---|
| `dcc498f6e4` | 代码与测试：清单写的锁后时间戳、三处补格与补断言、截止日期下界、`whileStructureLockHeld` |
| 本节所在提交 | 设计修订 3（§4.4、§4.5、§5.1、§10.11、§11 `[own-38]`）；本节；§S5.1、§S5.2、§S5.6-6 的更正；§F.4 补 F07 |

本地一次性库只用名字以 `m4h_` 开头的库（按 `left(datname, 4) = 'm4h_'` 认）：`m4h_lane`（从空库全量迁移 426 条；本节与 S7 的 lane、变异）。最终 head 上的全量运行与删库记录在 S7 一节。脚本、mutant 定义与逐个日志在私有工件目录。`node_modules` 仍是指向规范检出的符号链接，没有改动、没有跑 `pnpm install`。

### S5F.1 逐条处置

| id | 级别 | 处置 | 落点 | 证红 |
|---|---|---|---|---|
| M4G3T-01 | P2 | 已修（补格）：只有清单身份的 `read` 成员与 `edit` 成员（任务的创建人兼负责人是第三人），归档前后：两人取详情 200 且逐字节相同（`canEdit` / `canComment` 不变），`edit` 成员 PATCH 200（版本 2 → 3），两人评论 200，评论列表四条齐全 | `task-m4-lists`「归档不改变可见性」格 | A01（= 闸审的 F07，并记入 §F.4） |
| S5-TS-1 | P3 | 已修：建清单、改名、归档、取消归档都在结构锁之后于 SQL 里读一次 `clock_timestamp()`（`UPDATE … FROM (SELECT clock_timestamp() AS at) AS s`；建清单是 `INSERT … SELECT … FROM (…) AS s`），事件从清单行复制；成员写的事件取一次 `clock_timestamp()`；`transactionNow` 删除。设计 §4.4:526 改为与 §4.5 同一规则 | `task-list-records.ts`；`task-m4-lists` 锁序格；`task-m4-list-members` 锁序格 | A05、A06、A09、A10、A11 |
| S5-TS-2 | P3 | 已修：`archived_at` 取 UPDATE 里的同一个 `s.at`，不再经 JS `Date`；格改成在 SQL 里比较 `archived_at = updated_at` 与事件 `occurred_at = updated_at` | 同上；`task-m4-lists` 归档格、建清单格、改名格 | A07、A08 |
| M4G3T-02 | P3 | 同 S5-TS-2（同一根因） | 同上 | A07、A08、A09 |
| M4G3T-03 | P3 | 已修（补格）：六张清单的 `updated_at` 与 id 顺序相反、三张同刻（按 id 升序插入），三页拼起来等于 SQL 的 `ORDER BY updated_at DESC, id DESC`；改名把最旧的一张排到第一页最前 | `task-m4-lists` 翻页格 | A02（= M07）、A03（= L20） |
| S5-NIT-1 | NIT | 已修（补断言）：创建人以 `read` 成员身份归档 / 取消归档时，响应的 `createdBy` 是创建人、`ownerId` 是另一人；S6 的转让格在第二次转让之后再核 `createdBy` / `ownerId` / `myRole` | `task-m4-lists`、`task-m4-list-members` | A04 |
| M4G3T-05 | NIT | 已修，取「写明真实下界、删掉死分支」：`dueYear < 1` 删除，注释、设计 §5.1 与 `[own-38]` 写明下界来自 `computeDueAt` 的日历探针（截止日期从 `0100-01-01` 起）；`task-edit.test.ts` 加两格钉住这个下界（`0001-01-01`、`0099-12-31` 在 UTC 与东京是 `invalid_date`；`0100-01-01` 可存，东京的瞬时在 0099 年） | `task-edit.ts`；设计 §5.1、§11；单测 | A14（下界格）；删掉的分支本身是等价变异（闸审 F04） |

M4G3T-05 选这一种的理由：另一种（让 `parseIsoDate` 接受 0001–0099 年）不是一行的改动。`task-dates.ts` 是任务 B 已在 main 的模块，里面还有两处 `Date.UTC`（`zonedWallClockToUtcMs` 的初猜与翻天计算）同样把 0–99 年映射到 1900 年代，只改探针会得出错的瞬时；`computeDueAt` 的其他调用方（待办的截止回退、提醒）也会一并开始接受这些年份。闸审有一票认为守卫应当保留：删掉之后下界完全依赖日历探针，所以加了两格单测——以后谁让 `computeDueAt` 接受 0100 年之前的日期，这两格先红，那时再补下界判断。

### S5F.2 改动文件

| 文件 | 改动 |
|---|---|
| `src/services/task-list-records.ts` | `writeListEvent` 改为对象参数，`occurred_at` 的来源是闭集 `{ from: 'list' }`（复制清单行的 `updated_at`）或 `{ from: 'clock' }`（一次 `clock_timestamp()`），返回事件 id；`createTaskList` 的四次写共用一个读数；`renameTaskList`、`setTaskListArchived` 的 `UPDATE` 取锁后读数；`transactionNow` 删除；`applyArchive` 的 `now` 只用于判定、不落库 |
| `src/tasks/task-edit.ts` | 截止瞬时只判上界，注释写明下界的来由 |
| `tests/helpers/task-m4-fixtures.ts` | `whileStructureLockHeld(orgId, start, beforeCommit?)`：另一条连接持 org 结构锁，等本库出现未授予的 advisory 锁（`pg_locks` 按 `database` 过滤到当前库，别的库的等待者不算），可选地在持锁方写一行，再读 `clock_timestamp()::text`、提交 |
| `tests/integration/task-m4-lists.db.test.ts` | 锁序格；归档可见性格；翻页格重写；建清单、改名、归档三格改成 SQL 比较；创建人不是所有者时的 `createdBy` / `ownerId`（64 → 66 格） |
| `tests/integration/task-m4-list-members.db.test.ts` | 成员事件锁序格；第二次转让之后的 `createdBy` / `ownerId`（38 → 39 格） |
| `tests/unit/task-edit.test.ts` | 下界两组（3 + 1 格，144 → 148） |

### S5F.3 命令与结果（`dcc498f6e4`）

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | 退出码 0 |
| 相关单测 | `vitest run tests/unit/task-lists.test.ts tests/unit/task-list-access.test.ts tests/unit/task-records-guards.test.ts tests/unit/tasks-route-errors.test.ts tests/unit/task-edit.test.ts` | 5 files / 322 passed |
| 两个改过的真库文件 | `vitest --config vitest.integration.config.ts run tests/integration/task-m4-lists.db.test.ts tests/integration/task-m4-list-members.db.test.ts` | 2 files / 105 passed（66 + 39） |
| 真库 lane × 1（13 文件，`m4h_lane`） | `vitest --config vitest.integration.config.ts run <tasks-realdb.yml 的 13 个文件> --reporter=verbose` | 13 passed；**593 passed (593)**，45 秒，`socket hang up` / `ECONNRESET` 0 次（590 + 3） |
| 变异 | §S5F.4 | 14 / 14 变红 |

最终 head 上的全量单测、lane × 3、鉴权门 × 2 见 S7 一节（同一批运行覆盖本节的提交）。

### S5F.4 变异证明

做法同 §S6.4（私有工件目录里的脚本，改成每个变异自带 DB 与单测文件清单）：断言 needle 恰一次 → 原字节存到工作树之外 → 写入变异 → 跑 → 写回原字节 → `cmp -s`，14 个全部逐字节还原；逐个串行，期间不跑别的 vitest 进程。DB = 对应的真库文件（`m4h_lane`）；UNIT_LISTS = `task-lists` + `task-list-access` + `task-records-guards` + `tasks-route-errors`（174 格）。

| # | 变异（文件） | 失败 | 变红的格 |
|---|---|---|---|
| A01 | 成员连接加 ` AND tl.archived_at IS NULL`（records；闸审 F07） | lists 1/66 | 归档可见性格 |
| A02 | 「我的清单」改成只按 `task_lists.id DESC` 排（list-records；闸审 M07） | lists 1/66；UNIT 0/174 | 翻页格（单测钉的是常量字面量，看不出服务不用它） |
| A03 | 清单排序键去掉 id 平局键（list-access；L20 复跑） | lists 1/66；UNIT 1/174 | 翻页格（三张同刻）；排序键单测 |
| A04 | `createdBy` 取所有者行（list-records；闸审的变异） | lists 1/66 | 创建人以 `read` 归档格 |
| A05 | 改名写 `updated_at = now()`（list-records） | lists 1/66 | 锁序格 |
| A06 | 归档 / 取消归档写 `now()`（list-records） | lists 1/66 | 锁序格（两列同取 `now()` 时 SQL 等式仍成立，只有锁序格看得出） |
| A07 | `archived_at` 另取一次 `clock_timestamp()`（list-records） | lists 2/66 | 归档格（`archived_at ≠ updated_at`）；锁序格 |
| A08 | `archived_at` 绑定 JS 时钟（S5 的写法，毫秒） | lists 2/66 | 同上 |
| A09 | 写了清单行的事件取 `now()`（list-records） | lists 4/66 | 建清单、改名、归档三格的 SQL 等式；锁序格 |
| A10 | 成员事件取 `now()`（list-records） | members 1/39 | 成员锁序格 |
| A11 | 建清单的清单行取 `now()`（list-records） | lists 1/66 | 锁序格 |
| A12 | 建清单的所有者行取 `now()`（list-records） | lists 2/66 | 建清单格；锁序格 |
| A13 | 建清单的默认组取 `now()`（list-records） | lists 2/66 | 同上 |
| A14 | `parseIsoDate` 的日历探针恒通过（`task-dates.ts`） | UNIT `task-edit` 5/148 | 下界三格；`2026-02-30`、`2026-13-01` 两格 |

等价、未计：在 `task-edit.ts` 里把 `dueYear < 1` 加回去（闸审 F04；下界由探针保证，不可达）。

### S5F.5 与设计、清单的偏差

1. **建清单与成员写也改了**：闸审点名的是改名、归档、取消归档与 `writeListEvent` 的列缺省；同一根因也在建清单（四次写都取事务开始时刻）与成员写的事件（列缺省 `now()`）里，动态是按 `occurred_at` 合在一起排的，只改三条路由的话，排在后面的 `member_added` 照样会排到先提交的改名之下。所以 `writeListEvent` 的来源整个换掉，成员写也取锁后的读数。成员行自己的 `created_at` 没有改（列缺省；名单按 `user_id` 排序，没有顺序依赖它），记在设计 §4.4。
2. **`applyArchive` 的 `now` 传 JS 时钟**，只用于判定是否变化，不落库（计划的 `archivedAt` 值被丢弃；A08 证明若把它写回会被抓到）。闸审的另一种写法（`transactionNow` 只作判定）多一条查询，没有采用。
3. **锁序格的等待探针按库过滤**：本机同一个服务器上还有别的工作流的库（`m4g1_*` / `m4g3_*`）；不按 `database` 过滤时，别处的未授予 advisory 锁会让等待循环提前结束，`now()` 类变异就可能存活。`task-m4-dates` 里 S4 的同类格没有改（它是 S4 的格，过滤与否不影响它在 CI 的判别力；本节不碰该文件）。

### S5F.6 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17。
- CI 上的任何 lane（不推送）。
- `task-m4-dates` 的锁序格没有改成按库过滤（见 §S5F.5-3）。

## S7 清单项

基于 `7f71546d58`（S0–S6 与 S5 闸修复）。提交：

| 提交 | 内容 |
|---|---|
| `dfc9b600d6` | 纯谓词三个、`loadTaskListIds` 与详情的 `listIds`、三条路由与服务、24 格真库文件、单测、鉴权门清单第二租户格的 `/items` 读面、p0a 详情 `toEqual`、三处登记 |
| `54f1f8f90c` | 两格改成确定性（§S7.5 的 B17、B12 首轮只被单测击杀，原因与修法见那里） |
| `f0ce046f86` | 设计（抬头 S7 一行、§3.4、§4.1、§4.3、§5.5、§11 `[own-43]`–`[own-47]`、§13 S7 的跨 org 加入格期望）；本节 |
| 补记提交（只改本文件） | 三条清单项路由缺 org 分支的变异 B42–B44（§S7.5）；§S7.9 `listIds` 的前端用法改正 |

本地一次性库：`m4h_lane`（本节与「S5 闸修复」的全部变异与过程运行）、`m4h_final`（`54f1f8f90c` 上从空库全量迁移 426 条；最终 lane × 3 与鉴权门 × 2）。删库记录见 §S7.4 末。`node_modules` 仍是指向规范检出的符号链接，没有改动、没有跑 `pnpm install`。

### S7.1 交付内容

| 文件 | 内容 |
|---|---|
| `src/tasks/task-lists.ts`（末尾追加） | `canAddTaskToList({ listRole, task, me })` = `canListAction({ role: listRole }, 'add_item')` 且 `can(resolveTaskRoles(task, me), 'edit')`；任务只取创建人 / 负责人 / 关注人三项传给 `resolveTaskRoles`，不传清单身份，输入里也没有放它的位置（`[R12]` `[own-25]` (a1)）。`canRemoveTaskFromList({ listRole, taskRoles, isTaskCreator, itemExists })` = （`canListAction(remove_item)` 且 `can(taskRoles, 'edit')`）或（`isTaskCreator` 且 `itemExists`）（(a2)）。`visibleTaskListIds({ isTaskCreator, taskListIds, memberListIds })`：创建人取全部，其他人取自己是成员的那些；去重、字节序（`[own-46]`）。新 import 只有同层 `task-access.ts` 的 `can`、`resolveTaskRoles` 与两个类型。 |
| `src/services/task-records.ts` | `loadTaskListIds(db, taskId)`：包含该任务、且清单行 `org_id` 等于任务行 `org_id` 的全部清单（别名与 `loadActorListMemberships` 不同，负控 7 与 F07 的 needle 仍各恰一次）。`getTask` 在 `view` 判定之后组装 `listIds`：`visibleTaskListIds({ isTaskCreator: roles.includes('creator'), taskListIds: loadTaskListIds(…), memberListIds: <loadActorListMemberships 已读出的清单 id> })`。 |
| `src/services/task-list-records.ts` | `loadMemberList` 拆成 `loadOrgList`（按 id 与 org 取清单，没有成员行时角色为 `'none'`）与成员判定；`writeListEvent` 多一个来源 `{ from: 'item', taskId }`（复制清单项行的 `created_at`）。新增：`listTaskListItems`（`plainDb`；成员 404 → 分页 422 → `buildTaskInListCondition` 加 `TASK_PAGE_SORT_KEY`，`[own-43]`）、`addTaskToList`、`removeTaskFromList`，以及私有的 `requireTaskId`（`isPrintableId`，否则 422 `INVALID_TASK`，`[own-44]`）、`loadItemTask`（按 id 与 org 取任务行与三类直接角色的持有人）、`writeTaskItemEvent`（任务事件 `list_added` / `list_removed`，payload `{ listId }`，`occurred_at` 复制清单项行或同一次写的清单事件行）。两个写都在 `withOrgStructure` 里。 |
| `src/routes/tasks-lists.ts` | `GET /api/task-lists/:id/items`（read；缺 org 404）、`POST /api/task-lists/:id/items`（write；缺 org 422）、`DELETE /api/task-lists/:id/items/:taskId`（write；缺 org 422），注册在 `GET/PATCH /:id` 之前；没有 `tasks:admin`。 |
| `tests/integration/task-m4-list-items.db.test.ts`（新） | 见 §S7.2。登记三处：`vitest.config.ts` exclude 裸字面量、`tasks-realdb.yml` 清单、文件顶部 `assert-rbac-optional-off`。 |
| `tests/integration/task-p0a.db.test.ts` | 详情 `toEqual` 加 `listIds: []`（§S4.6-11 预告的那一处）。 |
| `tests/tasks-auth/tasks-auth-gate.ts` | 清单第二租户读格的正控多两步：`GET /LA/items` 200 且恰为 `[taskA]`；`GET /LB/items` 与不存在的清单 id 逐字节相同的 404（§S5.6-1 说 S7 之后可以补）。格数不变（24）。 |
| `tests/unit/task-lists.test.ts` | 29 格：`canAddTaskToList` 11 行真值表 + 「清单身份传不进去」1 格（`length === 1`；顶层或任务对象上夹带 `listMemberships` 都不起作用）；`canRemoveTaskFromList` 13 行 + 与 `canListAction` 的一致性 1 格；`visibleTaskListIds` 3 格（含字节序与 locale 序不同的一格）。 |
| `tests/unit/task-records-guards.test.ts` | 6 格：两个写的首句与取锁、清单不存在时 404 先于请求体与任务读；4 种不可存的清单 id / 任务 id 对四种调用都是 404 且没有语句携带它；没有 `add_item` 的成员 404 先于请求体、`edit` 成员的 8 种坏 `taskId` 422 先于任务读；加入：只有清单身份的 `edit` 成员 404 且不读清单身份、不读任务当前所属清单（空操作与配额在任务端之后）、空操作、配额、新项的三条写（清单项行带 `clock_timestamp()`、两条事件复制它）；移出：两条支路都不成立的四种 404、成员支路的空操作、创建人支路的四条写（两条删除、清单事件取 `clock_timestamp()`、任务事件按 id 复制它）；`/items` 的 404 先于分页、读的是清单内条件与任务分页键。 |
| `tests/unit/tasks-route-errors.test.ts` | 3 条路由各一格「驱动错误 ⇒ 500 `INTERNAL`、不回显」；1 格「路由把路径 id、原始请求体、原始 query 原样交给服务」；mock 工厂补三个导出。 |

**判定顺序**（锁后；读路由不进事务）：

- `GET …/items`：缺 org 404（路由）→ 清单 id 不可存 ⇒ 404 → 按 id 与 org 取清单 → 没有成员行 ⇒ 404 → 分页 ⇒ 422 → 读。
- `POST …/items`：缺 org 422（路由）→ 清单 id 不可存 / 不存在 / 他 org / 没有成员行 ⇒ 404 → 清单 `add_item` ⇒ 404 → `taskId` ⇒ 422 `INVALID_TASK` → 任务按 id 与 org 取、未软删 ⇒ 404 → `canAddTaskToList` ⇒ 404 → 任务当前所属的全部清单 → `planAddTaskToList`（已在 ⇒ 200 空操作；10 张 ⇒ 422 `LIMIT`）→ 清单项行（`org_id` = 绑定的 org，`created_at` = 一次锁后读数）→ `item_added`、`list_added`（复制清单项行的 `created_at`）。
- `DELETE …/items/:taskId`：缺 org 422（路由）→ 清单 id 不可存 ⇒ 404 → 按 id 与 org 取清单（不存在 / 他 org ⇒ 404；没有成员行时角色为 `none`）→ 任务 id 不可存 / 任务不存在 / 已软删 / 他 org ⇒ 404 → 完整角色集（`loadRowRoles`，含清单身份）→ 任务当前所属清单 → `canRemoveTaskFromList` ⇒ 404 → `planRemoveTaskFromList`（不在清单 ⇒ 200 空操作，只有成员支路走得到这里）→ 删清单项行、删本清单分组里的分组项、`item_removed`（`clock_timestamp()`）、`list_removed`（按 id 复制它）。

`ASSUMPTION(task-m4)` 标签：`[R12]` `[own-25]`（(a1) 加入只认直接角色、(a2) 创建人支路与 `listIds`；两半已于 2026-10-07 裁定，见设计 §3.4）、`[own-09]`、`[own-37]`（写入 `org_id` 与读路径的两行比较）、`[D2]`（两条事件）、`[D14]`（配额）、`[R13]`（软删任务的清单项保留）。本片新起五个编号（S6 止于 `[own-42]`），都是设计里没有定值的地方，待 owner 裁：

- **`[own-43]`** `GET …/items` 照 `[own-33]` / `[own-42]`：缺 org 404、非成员的 404 先于分页的 422；顺序用任务的分页键 `TASK_PAGE_SORT_KEY`（`tasks.updated_at DESC, tasks.id DESC`）。
- **`[own-44]`** `POST …/items`：清单 `add_item` 之后才看请求体；`taskId` 要求可打印 ASCII 字符串（与任务 id 列的 CHECK 同一形状；缺键、非字符串、空串、含空格或不可打印字符都是 422 `INVALID_TASK`）；任务端判定先于空操作与配额。
- **`[own-45]`** `DELETE …/items/:taskId`：清单按 org 取而不要求成员行；路径 id 不可存、清单不存在或他 org、任务不存在 / 已软删 / 他 org、两条支路都不成立，全部是同一个 404。
- **`[own-46]`** 详情的 `listIds`：只算与任务同 org 的清单（两行比较）；已归档的照算；去重、字节序。
- **`[own-47]`** 单任务 10 张清单的配额数包含该任务的全部清单，含已归档的、含调用者不是成员的；已在清单的空操作先于配额（任务 D `planAddTaskToList` 的顺序）。

### S7.2 `task-m4-list-items.db.test.ts`

org 前缀 `org_tasks_m4litem_`（与 `m4lcore_`、`m4lmem_` 等既有前缀互不为前缀）。参与者用 `seedTaskActor`，`afterAll` 用 `dropTaskM4Fixtures`。HTTP 经本文件的一个监听（`RBAC_TOKEN_TRUST='true'`）；路径字节须原样到达服务端的请求经 `rawRequest`（文件内 `send()` 按路径自动选）。所有者没有 token 的清单、他 org 的清单、越过外键写入的行、S8 之前的分组项都用 SQL 播种。凡期望 404 的格，都把响应体与「不存在的 id」的响应逐字节比较；写格另比较整个 org 的状态（清单项、清单行、两张事件表、分组项，`orgState`），前后必须相同。名单类读格旁边都另有一个同类容器（S6 的 M36 / M37 教训）：加入格有另一张也含该任务的清单，移出格有另一张清单与一个个人分组，`/items` 格有另一张有自己清单项的清单，`listIds` 格有另一条任务的清单。

| 组 | 格数 | 内容 |
|---|---|---|
| 加入 | 9 | 任务创建人（`edit` 成员）与负责人（所有者）各加一条：200 `{ listId, taskId }`；清单项行的 `org_id` 是本 org；`item_added { taskId }` 与 `list_added { listId }` 的 actor 是调用者，二者与清单项行的 `created_at` 是同一读数（SQL 比较）；清单行的 `updated_at` 不变；详情的 `listIds` 列出两张清单；清单归档之后照样能加。`edit` 成员对任务没有任何角色 ⇒ 与不存在的任务逐字节相同的 404，org 零变化。任务创建人与负责人在清单上只有 `read` ⇒ 与不存在的清单逐字节相同的 404。是关注人的 `edit` 成员 ⇒ 404；只有清单身份的 `edit` 成员重发一条已在清单里的任务 ⇒ 404（不是空操作）。(a1)：L1 的 `edit` 成员只经 L1 持有任务（详情 `canEdit` 为真），把它加进自己建的 L2 ⇒ 404、L2 零项；经路由被移出 L1 后取详情 404。已在清单 ⇒ 200 空操作、状态逐字节不变；SQL 播到 10 张（其中一张已归档）后加第 11 张 ⇒ 422 `LIMIT`、零变化；满额时对已在的清单再加仍是空操作。10 种坏 `taskId`（缺键、空串、数字、`null`、数组、对象、含 U+0000、含空格、非 ASCII、数组体）对所有者是 422 `INVALID_TASK`，对 `read` 成员与非成员是与不存在的清单逐字节相同的 404，零变化。不存在的任务 id、已软删的任务、他 org 的任务 ⇒ 同一个 404，零变化。**跨 org 加入**：org A 清单的 `edit` 成员把自己在 org B 建的任务加进来 ⇒ 与不存在的任务逐字节相同的 404，三张表零新行；**负控 1（清单项一半）**：`runSourceMutant` 把门 1 的 needle 改成恒真，子进程判定：加入是 500 `INTERNAL`（日志里是 `task_list_items_task_fk`），子进程输出 `{"nc1items":"red",…}`；子进程之后三张表仍是零新行（设计 §4.3 第 ② 层）。 |
| 移出 | 5 | `edit` 成员移出：200；本清单的清单项行没了，另一张清单的还在；本清单分组里的分组项删掉，另一张清单分组里的与个人分组里的还在；`item_removed { taskId }` 与 `list_removed { listId }` 的 actor 是调用者、同一读数；只有清单身份的 `read` 成员随后取详情 404。成员对自己有 `edit` 的、不在清单里的任务 ⇒ 200 空操作；对没有角色的任务 ⇒ 404；零变化。不是创建人的 `read` 成员（他是负责人）移出清单里的任务 ⇒ 404，零变化。(a2)：负责人把任务加进自己建的 L3，被创建人撤掉负责人之后只经 L3 的成员身份持有任务（list-editor：详情 200、`canEdit` 真）；创建人的 `listIds` 是 `[L3]`，取 L3 本身是 404；创建人不经成员身份移出 ⇒ 200，两条事件的 actor 是创建人、同一读数，L3 的成员不变；之后创建人的 `listIds` 为 `[]`，前负责人取详情 404。创建人支路的统一 404：不存在的清单、他 org 的清单（两种任务）、不含该任务的清单、他是 `read` 成员但不含该任务的清单、`tlst_%00`、`tsk%00x`、`.`、`..`（清单段与任务段）、不存在的任务，以及「既不是创建人也不是成员」的人对含该任务的清单，12 个响应都是 `{"error":{"code":"NOT_FOUND"}}`，两个 org 都零变化；随后对真正含该任务的清单 200。 |
| 读 `/items` | 3 | `read` 成员读：四条存活项按 `updated_at DESC, id DESC`（四个 id 按字节序排好后，`updated_at` 反着给、中间两条同刻，任一单键都排不出这个顺序；先在 SQL 里断言期望顺序），`limit=2` 两页不重不漏、`total` 4；项 `toEqual` `GET /api/tasks` 的六列；越过末尾 `{ items: [], total: 4 }`；另一张清单只读到自己的两条；已软删任务不出现、清单项行仍在，对它的移出是 404。非成员对不带分页、`limit=0`、`offset=-1` 都是与不存在的清单逐字节相同的 404；成员 `limit=101` ⇒ 422 `INVALID_LIMIT`、`offset=x` ⇒ `INVALID_OFFSET`；缺 org 404。第二租户：org B 清单的成员持 org A 的 token，三条路由都是与不存在的清单逐字节相同的 404，org B 零变化；换 org B 的 token 读到 `[taskB]`。 |
| `listIds` | 2 | 创建人看到包含任务的全部清单（其一已归档），按字节序：三张清单按 c、B、a 的顺序插入，字节序是 B、a、c，库的缺省排序规则与 locale 比较给 a、B、c；只在其中一张的 `read` 成员看到那一张；不在任何清单里的负责人看到 `[]`；另一条任务的清单不出现。越过外键写入的清单项（他 org 的清单持有本 org 的任务，`session_replication_role = replica`，先断言普通 `INSERT` 得 23503 `task_list_items_list_fk`）不进创建人的 `listIds`；行在 `finally` 里删除。 |
| 权限码与缺 org | 4 | 3 条路由各一格：调用者是 `edit` 成员兼负责人，但角色只有另一个码 ⇒ 403 `{ error: 'Insufficient permissions' }`，零变化；只有本路由那个码的同类成员 ⇒ 200。缺 org：两条写 422 `ORG_MISSING`（含坏请求体），读 404，零变化。 |
| 锁后时间戳 | 1 | 加入与移出在结构锁上排队：清单项行与两条事件晚于持锁方提交前的读数，各自同一读数（SQL 比较）。 |

静态展开数：9 + 5 + 3 + 2 + 4 + 1 = **24**；§S7.4 的三遍 lane 都收集并通过 24（门 17 ②）。

### S7.3 鉴权门

清单第二租户读格（§S5.3）的正控里加了 `/items` 读面：`GET /LA/items` 200 且恰为 `[taskA]`；`GET /LB/items` 与不存在的清单 id 逐字节相同的 404。清单 org 谓词的负控没有改（子进程直接调「我的清单」与「按 id 取清单」；`/items` 走的是同一个 `loadMemberList` → `buildTaskListByIdCondition`）。格数仍是 **24**；`tasks-auth-ci-wiring.test.mjs` 3/3。三条新路由在 trust-off 配置下的门 1 缺 org 格、门 2 / 16 的三件事与路由人口格仍归 S10（`M4_ROUTES`）。

### S7.4 命令与结果

所有命令在 `packages/core-backend` 下（ops 测试在仓库根），`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<库> EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`；迁移 `MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项。最终运行都在代码最终 head `54f1f8f90c` 上（本节所在提交只改两份文档；读设计文档的 `task-gate19-identities` 只读 `i-m4` 块，本片没有改它）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .`，退出码取 `$?` | 0，没有输出 |
| 改动的测试文件的类型 | 临时 tsconfig（`extends` 本包配置，`module: esnext`、`moduleResolution: bundler`、`noUnusedLocals`、`types: ["node"]`，`include` 只列四个真库文件、两个 helper、四个单测文件与 `tasks-auth-gate.ts`），放在私有工件目录 | 这 11 个文件 0 条诊断；本片改动的 `src` 文件 0 条。另有 47 条都在本片没有改的 `src` 文件里（34 条 TS2339：Express `Request` 的增补属性在这套配置里没有被引入；13 条 TS6133 / TS6196：`noUnusedLocals` 的提示），与 §S6.3 相同 |
| 本片单测 + 门 20 | `vitest run tests/unit/task-lists.test.ts tests/unit/task-list-access.test.ts tests/unit/task-records-guards.test.ts tests/unit/tasks-route-errors.test.ts tests/unit/task-edit.test.ts tests/unit/task-pure-no-io.test.ts` | 6 files / **366 passed**（`task-lists.ts` 的三个新导出在门 20 的扫描人口里） |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 5 failed \| 1078 passed \| 172 skipped (1255)；Tests 44 failed \| 18621 passed \| 1712 skipped (20377)**，120 秒。对账：§S6.3 的 20334，加 S5 闸修复的 4（`task-edit` 下界 3 + 1），加本片 39（`task-lists` 29、`task-records-guards` 6、`tasks-route-errors` 4）= 20377；passed 18578 + 43 = 18621。失败的 5 个文件正是已知的那 5 个：`multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup`（43 格，本机临时卷的 `statfs` 类型，§S5.4）与 `attendance-admin-plugin-lib-dist-layout-boot`（1 格，`ELOOP`：本 worktree 的 `plugins/plugin-attendance/node_modules` 之下无限嵌套的 `node_modules/node_modules/…`，§S6.3）。其余文件全绿，含三集合枚举（新真库文件三处登记一致） |
| 真库 lane × 3（14 文件，`tasks-realdb.yml` 清单，`m4h_final`） | `vitest --config vitest.integration.config.ts run <14 files> --reporter=verbose` | 三遍均 **Test Files 14 passed (14)；Tests 617 passed (617)**，54 / 54 / 51 秒，`socket hang up` / `ECONNRESET` 0 次。逐文件：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m3-comments-deletion 33、m4-schema 59、m4-list-roles 49、m4-paging-settings 77、m4-dates 107、m4-lists 66、m4-list-members 39、**m4-list-items 24**（590 + 3 + 24） |
| 鉴权门 × 2（`m4h_final`） | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false` 由配置与 `setup.ts` 给） | 两遍 **24 passed (24)** |
| ops 脚本测试（仓库根） | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs`；`… global-history-flag-manifest.test.mjs`；`… staging-tasks-smoke.test.mjs` | 3/3；36/36；19/19 |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫 S5 闸修复与本片改动的全部文件与两份文档 | 退出 0 |
| 变异 | §S7.5（本片 44 个）与 §S5F.4（14 个） | 58 / 58 变红 |

needle 复核（`54f1f8f90c`）：`task-access.ts` 自 `0de12b4a9d` 起没有改动，`(tasks.org_id = ${ORG_PLACEHOLDER}) AND ` 1、`.join(' OR ')` 1、`(assigneeCount > 0 || roles.includes('creator'))` 1、`COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone)` 4、`case 'assigned':` 2、`assignee: {` 1；`task-list-access.ts` 的清单 org needle 1；负控 7 的 ` AND tl.org_id = t.org_id` 在 `task-records.ts` 里仍恰 1 处；任务域源码里 `pg_advisory_xact_lock(hashtext(` 仍是 3 处（门 7）。

删库：两个库删除前查过 `tasks`、`task_lists`、`task_list_members`、`task_list_items`、`task_list_events`、`task_groups`、`task_group_items`、`task_user_settings`、`@tasks-m4.test` 的种子用户与 `org_tasks_m4litem_` 的 `user_orgs` 行都是 0，然后按名字 `DROP DATABASE m4h_lane`、`DROP DATABASE m4h_final`（按 `left(datname, 4) = 'm4h_'` 认，没有碰 `m4g1_*` / `m4g2_*` / `m4g3_*`）。

### S7.5 变异证明

做法同 §S5F.4（同一脚本，原字节存在工作树之外、写回后 `cmp -s`；44 个全部逐字节还原；逐个串行，期间不跑别的 vitest 进程）。DB = `task-m4-list-items`（24 格）加注明的文件，`m4h_lane`；UNIT = `task-lists` + `task-list-access` + `task-records-guards` + `tasks-route-errors`（213 格）。首轮在 `dfc9b600d6` 上跑 B01–B41：B12（`listIds` 用 locale 比较）与 B17（`/items` 只按 id 排）只被单测击杀——前者的格里三张清单的 id 在字节序与 locale 序下排得一样，后者的格用随机任务 id 按夹具位置给 `updated_at`，「只按 id 排」有约 1/12 的机会碰巧排对。`54f1f8f90c` 把两格改成确定性的（见 §S7.2），复跑 B11、B12、B17、B18 四个，DB 都变红；下表这四行是复跑的结果。B42–B44（三条路由缺 org 的分支）在 `54f1f8f90c` 的代码上另跑。其余是首轮。

| # | 变异（文件） | DB / UNIT 失败 | 变红的格 |
|---|---|---|---|
| B01 | `canAddTaskToList` 去掉任务端（纯函数） | 3/24；6/213 | 无角色的 `edit` 成员、关注人与只有清单身份的重发、(a1) 加入自己建的清单三格；真值表与服务单测 |
| B02 | `canAddTaskToList` 去掉清单端（纯函数；服务的 `add_item` 前置判定还在） | 0/24；3/213 | 只有单测：HTTP 上被服务的前置判定挡住（这一项是防线的第二道） |
| B03 | `canAddTaskToList` 把清单身份算进任务端（纯函数） | 3/24；6/213 | 同 B01 的三格；真值表、「清单身份传不进去」与服务单测 |
| B04 | 任务端用 `view` 代替 `edit`（纯函数） | 1/24；3/213 | 关注人格；真值表 |
| B05 | 去掉创建人支路（纯函数） | 2/24；4/213 | (a2) 移出格、统一 404 格的末步；真值表与服务单测 |
| B06 | 创建人支路不看 `itemExists`（纯函数） | 1/24；3/213 | 统一 404 格 |
| B07 | 成员支路不看任务的 `edit`（纯函数） | 1/24；3/213 | 成员移出无角色任务的格 |
| B08 | 成员支路不看清单角色（纯函数） | 2/24；6/213 | `read` 成员（负责人）移出格；统一 404 格（`read` 成员那一步） |
| B09 | `listIds`：创建人也只看成员清单（纯函数） | 4/24；2/213 | 加入格、(a2) 移出格、两个 `listIds` 格 |
| B10 | `listIds`：人人看全部（纯函数） | 1/24；1/213 | `listIds` 格 |
| B11 | `listIds` 不排序（纯函数） | 1/24；3/213 | `listIds` 格（插入序 c、B、a） |
| B12 | `listIds` 用 locale 比较（纯函数） | 1/24；1/213 | `listIds` 格（a、B、c）；字节序单测 |
| B13 | `loadTaskListIds` 去掉两行 org 比较（records） | 1/24 | 越过外键写入的清单项格 |
| B14 | `loadTaskListIds` 不按任务过滤（records） | items + p0a 7/37 | 全在 items：加入、(a2) 移出、两个 `listIds`、`POST` 权限码、锁序格，以及跨 org 加入格的负控 1（当前清单数被全库的项填满，子进程得到的是 422 `LIMIT` 而不是外键的 500）。p0a 的详情没有变红：它的查看者不是创建人 |
| B15 | 详情恒按「非创建人」组装 `listIds`（records） | items + p0a 4/37 | 加入格、(a2) 移出格、`listIds` 两格 |
| B16 | 清单内条件不按清单过滤（`task-access.ts` 的 `buildTaskInListCondition`） | 1/24；`task-access` 单测 1/200 | `/items` 格；快照单测 |
| B17 | `/items` 只按 `tasks.id DESC` 排（list-records） | 1/24；1/213 | `/items` 格；读语句单测 |
| B18 | `/items` 的 `total` 改成本页条数（list-records） | 1/24；0/213 | `/items` 格（`total` 应为 4） |
| B19 | `/items` 先解析分页、后取清单（list-records） | 1/24；1/213 | 非成员格（`limit=0` 成了 422）；单测 |
| B20 | 加入不做 `add_item` 前置判定（list-records） | 1/24；1/213 | 坏 `taskId` 格（`read` 成员与非成员成了 422） |
| B21 | 空操作与配额排到任务端之前（list-records） | 1/24；1/213 | 只有清单身份的 `edit` 成员重发已在的任务的格 |
| B22 | 清单项行写成别的 org（list-records） | 5/24；1/213 | 所有成功加入的格（组合外键 23503 ⇒ 500） |
| B23 | 配额与空操作看不到当前清单（list-records） | 1/24；1/213 | 空操作 / 配额格（重复 `INSERT` 撞主键；配额那一步） |
| B24 | `item_added` 的 payload 为 `{}`（list-records） | 3/24；1/213 | 事件断言各格 |
| B25 | `item_added` 另取一次 `clock_timestamp()`（list-records） | 2/24；1/213 | 加入格与锁序格的「同一读数」 |
| B26 | `list_added` 另取一次 `clock_timestamp()`（list-records） | 2/24；1/213 | 同上 |
| B27 | 清单项行取 `now()`（list-records） | 1/24；0/213 | 锁序格（只有它看得出取在锁前） |
| B28 | `list_removed` 另取一次 `clock_timestamp()`（list-records） | 3/24；1/213 | 三个移出格的「同一读数」 |
| B29 | 取 `clock` 的清单事件改成 `now()`（list-records，§S5F.4 的 A10 用本文件复跑） | 1/24 | 锁序格的移出一步 |
| B30 | 移出不删分组项（list-records） | 1/24；1/213 | 移出格（本清单分组里的那一行还在） |
| B31 | 移出删掉所有清单分组里的分组项（list-records） | 1/24；1/213 | 移出格（另一张清单分组里的那一行没了） |
| B32 | 删清单项不限本清单（list-records） | 1/24；0/213 | 移出格（另一张清单的项没了） |
| B33 | `itemExists` 恒为真（list-records） | 1/24；1/213 | 统一 404 格 |
| B34 | 移出要求成员行（`loadOrgList` 换成 `loadMemberList`） | 2/24；1/213 | (a2) 移出格、统一 404 格的末步 |
| B35 | `loadMemberList` 不再挡 `'none'`（list-records；拆分后的复核） | lists + members + items 1/129；0/213 | lists 的「没有成员行的创建人归档 404」。拆分之后没有成员行的调用者角色是 `'none'`，`canListAction` / `canRemoveListMember` 对它本来就是假，只有「创建人可归档」这一条放行要靠这道判定；S5 的 L01 当时变红得多，是因为那时的角色会变成字符串 `'null'`、`canListAction` 抛错 |
| B36 | 任务事件（`list_added` / `list_removed` 共用的写法）的 payload 为 `{}`（list-records） | 5/24；2/213 | 加入、移出、(a2) 移出、统一 404 末步、锁序格的事件断言；两格服务单测 |
| B37 | `GET …/items` 守卫改成 `tasks:write`（路由） | 1/24 | 该路由的权限码格 |
| B38 | `POST …/items` 守卫改成 `tasks:read`（路由） | 1/24 | 同上 |
| B39 | `DELETE …/items/:taskId` 守卫改成 `tasks:read`（路由） | 1/24 | 同上 |
| B40 | `taskId` 只查非空字符串（list-records） | 1/24；1/213 | 坏 `taskId` 格（含 U+0000、空格、非 ASCII 的成了 404） |
| B41 | 移出路由把清单 id 当任务 id 传（路由） | 6/24；1/213 | 所有移出格；路由透传单测 |
| B42 | `GET …/items` 缺 org 回降级体 200（路由） | 2/24 | 缺 org 格的读一步；非成员 `/items` 格的缺 org 一步 |
| B43 | `POST …/items` 缺 org 回 404（路由） | 1/24 | 缺 org 格 |
| B44 | `DELETE …/items/:taskId` 缺 org 回 404（路由） | 1/24 | 缺 org 格 |

文件内（每遍 lane 都跑）：负控 1 的清单项一半（§S7.2 跨 org 加入格）。

没有做、或判为等价的变异：`loadItemTask` 不读关注人——关注人没有 `edit`，加入的判定不变，等价；`getTask` 把 `listIds` 挪到 `view` 判定之前——不可见的任务照样 404，HTTP 上等价（设计 §6.2 / §S2.9 的顺序要求由代码位置保证）；`removeTaskFromList` 里先 `loadOrgList` 再 `loadTask` 的顺序互换——两者对坏 id 都是 404、响应逐字节相同，等价。

### S7.6 与设计的偏差

1. **第五个纯函数** `visibleTaskListIds`：`listIds` 的可见范围是行级规则（门 20），设计 §4.1 只列了四个谓词。服务层只取数（`loadTaskListIds` 与已经读出的清单身份），规则在纯函数里。设计 §4.1 已补。
2. **`loadMemberList` 拆成 `loadOrgList` + 成员判定**：创建人支路要在没有成员行时取清单行。拆分之后「没有成员行 ⇒ 404」主要由能力谓词对 `'none'` 恒假来保证，`loadMemberList` 的那道判定只在「创建人归档」上起作用（B35）。行为没有变化（S5、S6 的格全绿）。
3. **清单项写的时间戳**：照 S5 闸修复的规则（§4.4），清单项行与两条事件共用一次锁后读数（加入时以清单项行为源，移出时以清单事件为源）。设计 §3.4 只写了「同一事务写两条事件」。
4. **`taskId` 的形状**（`[own-44]`）：用 `isPrintableId`（与任务 id 列的 CHECK 同一形状），没有长度上限（任务 id 都是生成的；过长的值只会查不到，得 404）。
5. **鉴权门的 `/items` 读面**提前放进 S5 的清单第二租户格（§S5.6-1 预告过）；`M4_ROUTES` 等仍归 S10。
6. **`loadTaskListIds` 的两行 org 比较**写在 `task-records.ts`，用了不同的别名（`item_task` / `holding_list`），负控 7 与 F07 的 needle 仍各恰一次。
7. **§13 S7 的跨 org 加入格期望**改为「负控 1 下失败于组合外键、零新行」（修复切片 §F.6-4 已指出，§13 当时没改）。负控 1 的清单项一半做成文件内的 `runSourceMutant`，每遍 lane 都跑。
8. **移出请求先读任务、角色与清单项再判定**：四种失败的响应逐字节相同。
9. **清单项写不碰 `task_lists.updated_at`**（设计 §4.4），所以加入、移出不改变清单在「我的清单」里的位置；格里有一步断言。

### S7.7 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- 三条新路由在 trust-off 配置下的门 1 缺 org 格、门 2 / 16 的非 admin 三件事、路由人口枚举：归 S10（`M4_ROUTES` 加 3 条；`GET …/items` 缺 org 是 404，`[own-43]`）。
- 加入与任务软删、成员移除的并发：没有专门的并发格。三者都在 org 结构锁里（单测钉住首句与取锁），后到的一方在锁后重读。
- 两个 recovery 守卫（`recovery-schema-drift` 等）：本片没有改迁移，没有重跑。
- `[own-25]` (a1) / (a2) 的 owner 裁决（§12-Q16）：已于 2026-10-07 裁定，两半照本节交付的形状保留（见「S6+S7 闸修复」一节）。
- 前端：没有在浏览器里跑过任何东西。
- 本片测试文件的类型只在 §S7.4 那份临时配置下查过；仓库的 `tsconfig.json` 不含测试文件。
- 全量单测里 5 个与本片无关、因本机环境失败的文件：没有修。

### S7.8 给 S8 的交接

- 分组的写照 §4.4 的时间戳规则：锁后在 SQL 里读一次 `clock_timestamp()`，`task_groups.updated_at`（改名）与清单 scope 的分组事件、`group_changed` 取同一读数；`writeListEvent` 的来源闭集可以照样加一种（例如 `{ from: 'group', groupId }`）。
- 移出清单已在同一事务删掉该任务在本清单分组里的分组项，所以清单 scope 的「残留分组项」只会来自任务软删（设计 §3.5 的可见集）。
- `TasksClient` 仍没有 `put`，S8 的 `PUT` 路由要先加一个方法。
- `whileStructureLockHeld(orgId, start, beforeCommit?)` 在 `tests/helpers/task-m4-fixtures.ts`，等待探针按当前库过滤。
- 读路径的清单身份仍只经 `loadActorListMemberships`；任务所属清单的全集用 `loadTaskListIds`（两者都做两行 org 比较）。
- org 前缀不要与 `org_tasks_m4litem_` / `m4lmem_` / `m4lcore_` 互为前缀（例如 `org_tasks_m4lgrp_`）。
- S10 的 `M4_ROUTES` 要加本片 3 条。
- lane 现在 14 文件 617 格，鉴权门 24 格；全量单测 20377 格（本机 5 个文件因环境失败）。
- 变异脚本（私有工件目录）：每个变异自带 `db` / `unit` 文件清单，原字节存在工作树之外、还原后 `cmp`；`DRY=1` 只数 needle。

### S7.9 前端对接（S7 的 3 条路由与 `listIds`）

成功体：两条写都回 `{ listId, taskId }`；读回 `{ items, total }`，项是 `GET /api/tasks` 的六列 `{ id, title, status, completion_mode, created_by, due_at }`（snake_case，`due_at` 为 ISO 字符串或 `null`），按任务的 `updatedAt` 降序、`id` 降序。错误体都是 `{ error: { code } }`；403 仍是 `rbacGuard` 的 `{ error: 'Insufficient permissions' }`。

| 方法 路径 | 码 | 谁能用 | 请求 | 成功 200 | 错误 | 空操作 |
|---|---|---|---|---|---|---|
| `GET /api/task-lists/:id/items` | read | 清单成员（任一角色，已归档也可以） | query `limit`（1–100，缺省 100）、`offset`（≥ 0） | `{ items, total }`，只含未删除的任务 | 404 `NOT_FOUND`（不存在、他 org、非成员、坏 id、缺 org，逐字节相同，且先于分页）；422 `INVALID_LIMIT`、`INVALID_OFFSET`（只对成员） | — |
| `POST /api/task-lists/:id/items` | write | 清单 `edit` / `owner`，**并且**是该任务的创建人或负责人（只经清单拿到的编辑权不算） | `{ taskId }` | `{ listId, taskId }` | 404（不是成员、`read` 成员——都先于请求体；任务不存在 / 已删除 / 他 org；对任务没有直接角色）；422 `ORG_MISSING`（先于一切）、`INVALID_TASK`（缺、不是字符串、空串、含空格或非 ASCII）、`LIMIT`（任务已在 10 张清单里，含已归档的） | 任务已在这张清单：200 原样 `{ listId, taskId }`，无事件 |
| `DELETE /api/task-lists/:id/items/:taskId` | write | 清单 `edit` / `owner` 且能编辑该任务（经清单也算）；**或**任务的创建人（不必是成员），只要任务确实在这张清单里 | — | `{ listId, taskId }` | 404（所有不允许的情形逐字节相同：清单不存在 / 他 org / 坏 id、任务不存在 / 已删除、两条都不成立）；422 `ORG_MISSING` | 成员对一条他能编辑、但不在这张清单里的任务：200 原样，无事件（创建人走的那条路没有空操作：不在清单就是 404） |

`GET /api/tasks/:id` 新增 `listIds: string[]`（键恒在，按字节序）：任务的创建人看到包含该任务的全部清单 id（含已归档的、含他不是成员的）；其他人只看到其中自己是成员的那些。只有 id。创建人也可能是其中一些清单的成员：把 `listIds` 与 `GET /api/task-lists?includeArchived=true`（分页取全）的 id 求交，交集里的清单有名字可显示；剩下的 id 是他看不到的清单（`GET /api/task-lists/:id` 对它们是 404），只能显示为「另有 N 个你不是成员的清单」，每个只给「移出」操作（`DELETE /api/task-lists/:id/items/:taskId`）。非创建人的 `listIds` 都是他自己的清单。

事件：`GET /api/task-lists/:id/events` 里多了 `item_added` / `item_removed`，payload `{ taskId }`，`actorId` 是操作者（创建人支路移出时是任务创建人，即使他不是成员）；任务这边的事件（不经接口读）是 `list_added` / `list_removed`，payload `{ listId }`。加入、移出不改清单的 `updatedAt`，也不改它在「我的清单」里的位置；任务的 `version` 与 `updatedAt` 也不变。

## S8 分组

基于 `c63a61c4c9`（S0–S7 与修复切片；与 S6+S7 闸审并行，闸审的修复不在本片）。提交：

| 提交 | 内容 |
|---|---|
| `132cf9d945` | 四个纯函数与两个计划函数、两个分组构造器与排序键、`task-group-records.ts`、12 条路由、36 格真库文件、单测、三处登记、`TasksClient.put`、锁 helper 的多等待者参数、`TASKS_ENABLED` 的 manifest |
| `14486aec2b` | 变异首轮之后补的三处（§S8.6）：组内顺序与源组两格改成确定性的；区间内的小数位置；同位分组删除后的重编号 |
| `a1162030bf` | 设计（抬头 S8 一行、§3.5 末尾细则、§4.1、§7.1、§11 `[own-48]`–`[own-52]`、§13 S8 实现记录） |
| `ec766a190a` | 本节 |
| `496747c5a9` | 单测的第一格改为钉住八个分组写的锁键都是 org 的（个人 scope 四个原先没有判别格，§S8.6 的 C74–C77） |
| `ac497adcd3` | 本节补记 C74–C77 |
| 本节第二次补记所在提交 | 本节补记 C78–C98（其余八条路由的权限码、十个缺 org 分支、三处读写守卫）、测试文件类型复核与已知失败原因的核对 |

本地一次性库：`m4i_lane`（开发与全部变异）、`m4i_final`（`14486aec2b` 上从空库全量迁移 426 条；最终 lane × 3 与鉴权门 × 2）。删库记录见 §S8.5 末。`node_modules` 仍是指向规范检出的符号链接，没有改动、没有跑 `pnpm install`。

### S8.1 交付内容

| 文件 | 内容 |
|---|---|
| `src/tasks/task-groups.ts`（末尾追加） | `parseTaskGroupName`（`validateTaskGroupName` 加可存文本规则，与 `parseTaskListName` 同）；`TaskGroupView`、`syntheticUserDefaultGroup()`（`{ id: null, scope: 'user', name: '默认分组', position: 0, isDefault: true }`，每次新对象）、`userGroupsWithDefault(rows)`（没有一行 `isDefault === true` 时把合成项放在最前）；`parseTargetGroupId(body)`（键必须在；`null` 是默认组；可打印 ASCII 字符串原样交给调用方核对容器；其余 `invalid_group`）；`planGroupItemOrder`（去掉被移动任务之后在可见集里插入；`position` 必须是非负安全整数且不大于该集合大小，否则 `invalid_position`；返回 `before` = 可见在前、不可见在后的现状，`after` = 要写的整组顺序；被移动任务出现在不可见行里抛 `TypeError`）；`planGroupPositionsAfterDelete`（按 `position`、再按 id 字节序重编 0..n-2，只返回位置变了的）。新 import 只有同层 `task-ids.ts` 的 `isStorableText`、`isValidPrintableAsciiId`。 |
| `src/tasks/task-list-access.ts`（末尾追加） | 私有 `taskGroupOrgClause`（`task_groups.org_id` 只在这里发射一次）；`buildTaskListGroupScopeCondition`（`$1` 清单、`$2` org，与 `buildTaskInListCondition` 同绑定）、`buildTaskUserGroupScopeCondition`（`$1` 用户、`$2` org，与 `buildTaskScopeCondition` 同绑定）；`TASK_GROUP_PAGE_SORT_KEY`、`TASK_GROUP_ITEM_ORDER_KEY`、`TASK_GROUP_PLACEMENT_PAGE_SORT_KEY`（id 一律 `COLLATE "C"`）。 |
| `src/services/task-group-records.ts`（新） | 两种 scope 共用一个「容器」（清单 scope：清单 id 加 org；个人 scope：用户加 org），分组条件与可见集条件绑定同一组两个值。读：`listTaskListGroups`、`listUserTaskGroups`（全部行加合成项，内存分页）、`listTaskListGroupItems` / `listUserTaskGroupItems`（窗口函数在分页之前给每组可见行编稠密下标；`total` 只数可见行）。写（都在 `withOrgStructure` 里）：`createTaskListGroup` / `createUserTaskGroup`、`renameTaskListGroup` / `renameUserTaskGroup`、`deleteTaskListGroup` / `deleteUserTaskGroup`、`placeTaskInListGroup` / `placeTaskInUserGroup`。 |
| `src/services/task-list-records.ts` | 导出 `loadMemberList`、`assertListAction`、`bodyField`、`writeListEvent`（与 `LoadedList`、`ListEventAt` 两个类型）；`writeListEvent` 的来源多一种 `{ from: 'group', groupId }`：复制该分组行的 `updated_at`，并要求它的 `list_id` 就是事件的清单。 |
| `src/routes/tasks-lists.ts` | 12 条路由，注册在同一个 `router` 上：清单 scope 6 条在 `GET/PATCH /api/task-lists/:id` 之前；个人 scope 6 条在末尾，静态的 `/api/task-groups/items` 先于 `/:groupId`。都是 `authenticate` 加 `rbacGuard('tasks', 'read' \| 'write')`，没有 `tasks:admin`。缺 org：写 422；清单 scope 两条读 404；个人 scope 两条读降级体。 |
| `tests/integration/task-m4-groups.db.test.ts`（新） | 见 §S8.3。登记三处：`vitest.config.ts` exclude 裸字面量、`tasks-realdb.yml` 清单、文件顶部 `assert-rbac-optional-off`。 |
| `tests/helpers/tasks-http-harness.ts` | `TasksClient.put`。 |
| `tests/helpers/task-m4-fixtures.ts` | `whileStructureLockHeld(orgId, start, beforeCommit?, waiters = 1)`：等到本库里有 `waiters` 个未授予的咨询锁再放行（并发首次写格用两个）；原有调用不变。 |
| `tests/unit/task-groups.test.ts` | 27 → 47 格：上面六个函数的真值表，含 `-0`、`MAX_SAFE_INTEGER + 1`、继承来的 `groupId`、字节序与 locale 序不同的并列、`planGroupItemOrder` 喂给 `applyMoveItem` 的空操作与整组重写。 |
| `tests/unit/task-list-access.test.ts` | 7 → 12 格：两个构造器的文本快照（`task_groups.org_id = $2` 恰一次、不含 `task_lists.org_id`）、绑定值不内联、每个分组构造器与同 scope 的可见集构造器绑定相同的 `$1` / `$2`、三个排序键。 |
| `tests/unit/task-records-guards.test.ts` | 49 → 59 格：八个分组写的首句与取锁（锁键是 `task-structure:<org>`，个人 scope 也取 org 的锁，不是调用者的）、清单 scope 四个写在清单不存在时 404 先于一切；`read` 成员 404 先于请求体；改名的名字 422 只在分组找到之后；个人建组的名字在开事务之前；四种不可存的 id 对九个函数都是 404 且没有语句携带它；摆放的任务、`groupId`、`position` 三步的顺序；跨组移动的四条写（按容器删其它行、新行取 `clock_timestamp()`、整组位置、`group_changed` 复制新行）与同序空操作不写；个人首次写落默认组、分组项复制其读数；建组的位置与上限（合成默认组计入）；删组的 422、重编号与 `group_deleted`；容器有分组却没有默认组行时抛错；读路径的成员 404 先于分页、窗口函数先于 `LIMIT`。 |
| `tests/unit/tasks-route-errors.test.ts` | 32 → 45 格：12 条路由各一格「驱动错误 ⇒ 500 `INTERNAL`、不回显」；1 格路径 id、原始请求体与 query 原样交给服务。`task-group-records` 整个换成桩。 |
| `vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 新文件各一行。 |
| `scripts/ops/global-history-flag-manifest.mjs` 与 `.test.mjs` | `TASKS_ENABLED` 的 `purpose` 补 `/api/task-groups`（四个前缀写全）；测试补一格逐个核对四个前缀。 |

`ASSUMPTION(task-m4)` 标签：沿用 `[R11]`、`[D2]`、`[D9]`、`[D14]`、`[own-04]`、`[own-09]`、`[own-12]`、`[own-13]`、`[own-19]`、`[own-24]`、`[own-37]`；本片新起五个（S7 止于 `[own-47]`），都是设计里没有定值的地方，待 owner 裁：

- **`[own-48]`** `GET /api/task-lists/:id/groups` 与 `/group-items`：缺 org 404，非成员的 404 先于分页的 422（照 `[own-33]` / `[own-42]` / `[own-43]`）。
- **`[own-49]`** 摆放的判定顺序与两个字段的形状：路径任务在可见集里（404）→ `groupId`（422 `INVALID_GROUP`）→ `position`（422 `INVALID_POSITION`）；两者都非法报前者；`position` 必填。
- **`[own-50]`** 没有分组项行的任务算在默认组里；清单 scope 换组的 `group_changed` payload `{ listId, fromGroupId, toGroupId }`，`occurred_at` 是目标组新写的分组项行的 `created_at`。
- **`[own-51]`** 分组与摆放的 id 一律按字节序；分组 `position, id`，组内 `position, task_id`，摆放分页按 `group_id` 再按稠密下标，删组重编号同序。
- **`[own-52]`** 分组写的判定顺序：清单 scope 成员 → `manage_groups` →（改名、删组）分组属于本清单，都是 404，再看名字、默认组、上限；个人 scope 建组的名字在开事务之前，改名、删组先判本人本 org 的分组。

**判定顺序**（锁后；读路由不进事务）：

- 清单 scope 的读：缺 org 404（路由）→ 清单 id 不可存 ⇒ 404 → 按 id 与 org 取清单 → 没有成员行 ⇒ 404 → 分页 ⇒ 422 → 读。
- 清单 scope 建组：缺 org 422（路由）→ 清单与成员行 ⇒ 404 → `manage_groups` ⇒ 404 → 名字 ⇒ 422 → 全部分组 → `applyCreateGroup`（50 个 ⇒ 422 `LIMIT`）→ 分组行（一次锁后读数）→ `group_created`（复制分组行）。
- 改名：… → `manage_groups`（清单 scope）→ 分组 id 不可存或不在本容器 ⇒ 404 → 名字 ⇒ 422 → 同名 ⇒ 200 原样 → `UPDATE`（`updated_at` 一次锁后读数）→ `group_renamed`（清单 scope，复制分组行）。
- 删组：… → 分组 ⇒ 404 → 默认组 ⇒ 422 `IS_DEFAULT` → 删行（分组项级联）→ 其余分组重编号（只写 `position`）→ `group_deleted`（清单 scope，一次锁后读数）。
- 摆放：… → 路径任务不可存或不在容器可见集 ⇒ 404 → `groupId` ⇒ 422 → 全部分组（`null` ⇒ 默认组；缺默认组行则本次写先落行）→ 任务在本容器各组里的行 → 目标组全部行按可见集分两段 → `planGroupItemOrder` ⇒ 422 `INVALID_POSITION` → `applyMoveItem`（空操作 ⇒ 200 不写）→ 删本容器其它组里该任务的行 → 目标组没有该任务的行则新写一行 → 整组位置 → 清单 scope 换组写 `group_changed`。
- 个人 scope 建组：缺 org 422（路由）→ 名字 ⇒ 422（开事务之前）→ 锁 → 全部分组 → 上限 → 缺默认组行则先落行 → 新组。

### S8.2 `TASKS_ENABLED` 路由人口

`tasksRouter().stack` 的路由层在本片之后是 51 条：P0-A 8 加 M3 13 加 M4 30（PATCH 任务 1、设置 2、清单 7、成员 5、清单项 3、分组 12），与设计 §10.7 的数字相同（本地以 `tsx` 跑一个枚举脚本；S10 的人口格会钉住它）。

### S8.3 `task-m4-groups.db.test.ts`

org 前缀 `org_tasks_m4lgrp_`（与既有前缀互不为前缀）。参与者用 `seedTaskActor`，`afterAll` 用 `dropTaskM4Fixtures`。HTTP 经本文件的一个监听（`RBAC_TOKEN_TRUST='true'`）；路径字节须原样到达服务端的请求经 `rawRequest`。他 org 的清单、指定 id 与位置的分组、任务已不在清单里的分组项、超过软上限的分组用 SQL 播种。凡期望 404 的格都与「不存在的 id」的响应逐字节比较；写格前后比较整个 org 的分组、分组项、清单行、两张事件表（`orgState`）。每条名单类读都有另一个自带行的容器（S6 的 M36 / M37 教训）：清单分组读有另一张清单的分组；清单摆放读有另一张也含该任务、自己摆放了它的清单；个人分组读有同 org 另一个用户的分组；个人摆放读有另一个用户对同一条（两人都负责的）任务的摆放；跨组移动有另一张清单与一个个人分组都摆放了该任务；删组的重编号旁边有另一张清单的三个分组。

| 组 | 格数 | 内容 |
|---|---|---|
| 清单 scope 的分组 | 7 | 建组：所有者与 `edit` 成员各建一个，位置 1、2，行带清单与 org，`group_created { groupId }` 的 actor 是调用者、与分组行同一读数（SQL 比较），清单行与另一张清单不变，`GET` 依次给出默认组与两组、`total` 3。读：指定 id 的五个分组（z 按位置排在 m 之前；B 与 a 同在 3，字节序 B 先），整页顺序、`limit=2` 三页不重不漏、`total` 5、越过末尾；非成员对不带分页、`limit=0`、`offset=-1` 都是不存在的清单的 404；成员 `limit=101` / `offset=x` 422；之后删掉 z，同位的 B、a 按字节序重编为 2、3，另一张清单不变。改名：`edit` 成员改普通组与默认组，`updated_at` 晚于 `created_at`、与 `group_renamed` 同一读数；同名空操作逐字节不变；别的清单的分组、`tgrp_%00`、`.`、`..` 带合法或非法名字都是不存在的分组的 404；8 种坏名字 422，零变化。删组：A 里的两条任务随级联失去分组项（回到默认组，摆放读里不再出现），`reassignedTo` 是默认组，B 从 2 变 1，其余分组与清单行的 `updated_at` 不变，`group_deleted`；之后建的 C 位置 2；另一张清单的位置不变；删默认组 422 `IS_DEFAULT`，再删 A、删别的清单的分组都是 404，零变化。上限：播到 49 个后再建得到位置 49，第 51 个 422 `LIMIT`，满额时的坏名字报名字的 422。`m4list`：`read` 成员与非成员对 4 条写路由（7 种请求，含坏请求体）都是不存在的清单的 404，零变化，`read` 成员读得到。第二租户：org B 清单的成员持 org A 的 token，6 条清单 scope 路由都是不存在的清单的 404，org B 零变化；换 org B 的 token 读到分组。 |
| 清单 scope 的摆放 | 6 | 可见集下标（设计 §10.4 的四行）：组 G 存为 [A, H, L, B]（H 的任务软删，L 的任务已不在清单里），读到 A、B 为 0、1、`total` 2；X 放到 2 ⇒ 读到 [A, B, X]，库里 [A0, B1, X2, H3, L4]，X 有一条 `group_changed`（从默认组到 G）；X 放到 1 ⇒ [A, X, B]，库里 [A0, X1, B2, H3, L4]，组内重排不写事件；3、0.5、1.5 各 422 `INVALID_POSITION`，零变化。空操作：同一夹具下 A 放 0、B 放 1 都是 200，库里仍是 [A0, H1, L2, B3]，零变化。移动：T 从 A 移到 B ⇒ A 只少一行、留下的 U 在库里仍是 1，读到 A:U 0、B:T 0；`group_changed { listId, fromGroupId: A, toGroupId: B }` 的 actor 是调用者、与 B 里新行同一读数；另一张清单与个人分组里 T 的行不变；`null` 移回默认组再写一条（从 B 到默认组）；没有行的 V 放进默认组不写事件；默认组内重排不写事件。404：不在清单的任务、已软删的项、他 org 的任务、不存在的 id、`tsk%00x`、`.`、`..`，各带三种请求体（含坏请求体），全是同一个 404，两个 org 零变化。422：14 种 `INVALID_GROUP`（缺键、非字符串、空串、数组、含 U+0000、不存在的、另一张清单的分组与默认组、个人分组、他 org 清单的分组、两字段都坏、数组请求体）与 8 种 `INVALID_POSITION`，零变化。摆放读：组 id 选成字节序 B < a < c、locale 序 a < B < c，各组里的任务都按「与 id 序相反」摆放，`limit=3` 的第二页从组 a 中间开始、t2 仍是下标 1，`total` 只数可见行，另一张清单的摆放不出现，非成员的 404 先于分页。 |
| 个人 scope | 9 | 合成默认组：没有行时 `{ items: [合成项], total: 1 }`，`limit=1` 同，`offset=1` 为 `{ items: [], total: 1 }`，读后库里零行，摆放读为空，分页 422；邻居（同 org 另一用户）有自己的两组。首次写（`PUT`）：先发一次 `position: 1` 被 422 拒，库里仍零行；再发 `position: 0` 得到真实 id，库里恰一行默认组（位置 0），分组项与默认组同一读数、`org_id` 都是本 org，之后 `GET` 给出真实 id，无 `group_changed`。首次写（`POST`）：默认组 0 与新组 1 同一读数，再建得 2；播满 50 后 422 `LIMIT`，四种坏名字 422，零变化；`task_list_events` 总数不变。并发首次写：一个 `POST` 与一个 `groupId: null` 的 `PUT` 同时在结构锁上排队（等到两个未授予的锁）再放行，都 200，恰一行默认组，新组位置 1。可见集（设计 §10.4 第五行）：U 负责 T1–T4，T1–T3 依次放进默认组；邻居把 T1 放进自己的组；创建人撤掉 U 在 T2 上的负责人 ⇒ 读到 [T1, T3]，库里行还在；T4 追加到 2 ⇒ [T1, T3, T4]，库里 T2 排到 3；此时对 T2 的摆放是 404；重新指派 ⇒ [T1, T3, T4, T2]；邻居只读到自己的那一条；全程没有任务事件。改名与删组：默认组落行后可改名；同名空操作；邻居对 U 的分组改名（含坏名字）与删除都是 404；`tgrp_%00`、`.`、`..`、`null` 404；坏名字 422；删默认组 422；删 A ⇒ 回默认组、B 重编为 1、邻居的分组不变、无事件。摆放的 404 与 422：只是创建人、只是关注人、别人的、已软删、他 org、不存在、`tsk%00x`、`..` 全是 404；邻居的分组、清单的默认组、自己在他 org 的分组、不存在的分组都是 422 `INVALID_GROUP`；零变化。第二租户（设计 §10.4 末段）：同一用户在 org A、B 各有 `user_orgs` 行与同名分组、各摆一条任务；org A 的 token 只看到 A 的分组与摆放，对 B 的分组与默认组改名（含同名）、删除都是 404，以 B 的分组为目标 422，org B 零变化；org B 的 token 看到 B 的那一份。**负控 5**（文件内 `runSourceMutant`）：把 `(task_groups.org_id = ${ORG_PLACEHOLDER}) AND ` 改成恒真，子进程判定变红并输出 `{"nc5":"red",…}`；之后 B 的行不变。 |
| 权限码与缺 org | 13 | 12 条路由各一格：调用者是清单的 `edit` 成员、该任务的负责人、有自己的个人分组，但角色只有另一个码 ⇒ 403 `{ error: 'Insufficient permissions' }`，零变化；只有本路由那个码的同类调用者 ⇒ 200。缺 org：8 条写 422 `ORG_MISSING`（含坏请求体），清单 scope 两条读 404，个人 scope 两条读（含 `limit=0`）是不带 `total` 的降级体，零变化。 |
| 锁后时间戳 | 1 | 清单 scope 建组、改名、跨组摆放、删组各自在结构锁上排队：分组行、分组项行与事件都晚于持锁方提交前的读数，建组与改名的事件与分组行同一读数，`group_changed` 与新行同一读数。 |

静态展开数：7 + 6 + 9 + 13 + 1 = **36**；§S8.5 的三遍 lane 都收集并通过 36（门 17 ②）。

### S8.4 鉴权门

本片没有改 `tests/tasks-auth/tasks-auth-gate.ts`。12 条新路由在 trust-off 配置下的门 1 缺 org 格、门 2 / 16 的三件事与路由人口格归 S10（`M4_ROUTES` 加 12 条后为 30 条）。两遍 **24 passed (24)**。

### S8.5 命令与结果

所有命令在 `packages/core-backend` 下（ops 测试在仓库根），`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<库> EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`；迁移 `MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项。最终运行在代码最终 head `14486aec2b` 上（`a1162030bf` 只改设计；读设计的 `task-gate19-identities` 只读 `i-m4` 块，本片没有改它，单测 9/9）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .`，退出码取 `$?` | 0，没有输出 |
| 改动的测试文件的类型 | 临时 tsconfig（同 §S7.4 的配置，`include` 列本片的真库文件、S7 的真库文件、两个 helper、四个单测文件），放在私有工件目录 | 这 8 个文件与本片改动的 `src` 文件 0 条诊断；另有 47 条都在本片没有改的 `src` 文件里（34 条 TS2339、13 条 TS6133 / TS6196），与 §S6.3、§S7.4 相同。`496747c5a9` 改过单测之后重跑一遍，结果相同 |
| 本片单测与门 20 | `vitest run tests/unit/task-groups.test.ts tests/unit/task-list-access.test.ts tests/unit/task-records-guards.test.ts tests/unit/tasks-route-errors.test.ts tests/unit/task-pure-no-io.test.ts` | 全绿（47、12、59、45、5）；两个纯函数文件的新导出在门 20 的扫描人口里 |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 5 failed \| 1078 passed \| 172 skipped (1255)；Tests 44 failed \| 18669 passed \| 1712 skipped (20425)**，136 秒；补记的锁键格（格数不变）之后在最终测试 head 上再跑一遍，数字相同（170 秒）；该遍日志里 attendance 那个文件的失败是 `ELOOP: too many symbolic links encountered`（`plugins/plugin-attendance/node_modules/node_modules/…`），四个 recovery 文件在存储守卫处拒绝（`RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED`、`RECOVERY_LOCAL_CUSTODY_STORE_REFUSED`），与 §S5.4、§S6.3 记的原因相同。对账：§S7.4 的 20377 加本片 48（`task-groups` 20、`task-list-access` 5、`task-records-guards` 10、`tasks-route-errors` 13）= 20425；passed 18621 加 48 = 18669。失败的 5 个文件正是已知的那 5 个（`multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup`：本机临时卷的 `statfs` 类型；`attendance-admin-plugin-lib-dist-layout-boot`：`ELOOP`）。第一遍全量另有 2 条 vitest worker 的 `onTaskUpdate` RPC 超时、49 格未上报，起源文件是与本片无关的 `multitable-field-schema-fence-recheck.guard.test.ts`；第二遍没有，上面的数字取第二遍 |
| 真库 lane × 3（15 文件，`tasks-realdb.yml` 清单，`m4i_final`） | `vitest --config vitest.integration.config.ts run <15 files> --reporter=verbose` | 三遍均 **Test Files 15 passed (15)；Tests 653 passed (653)**，67 / 76 / 69 秒，`socket hang up` / `ECONNRESET` 0 次。逐文件：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m3-comments-deletion 33、m4-schema 59、m4-list-roles 49、m4-paging-settings 77、m4-dates 107、m4-lists 66、m4-list-members 39、m4-list-items 24、**m4-groups 36**（617 加 36） |
| 鉴权门 × 2（`m4i_final`） | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false` 由配置与 `setup.ts` 给） | 两遍 **24 passed (24)** |
| ops 脚本测试（仓库根） | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs`；`… global-history-flag-manifest.test.mjs`；`… staging-tasks-smoke.test.mjs` | 3/3；36/36；19/19 |
| 三集合枚举与私有路径扫描 | `vitest run tests/unit/task-ci-coverage-enumeration.test.ts tests/unit/approval-a3-dangling-reviews-path-sweep.test.ts` | 绿（新文件三处登记一致；`vitest.config.ts` 只加了字面量） |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫本片改动的全部文件与两份文档 | 退出 0 |
| 变异 | §S8.6（99 个） | 99 / 99 变红 |

needle 复核（`14486aec2b`）：`task-access.ts` 本片没有改动，各 needle 计数同 §S7.4；`task-list-access.ts` 里清单 org needle `(task_lists.org_id = ${ORG_PLACEHOLDER}) AND ` 1 处、分组 org needle `(task_groups.org_id = ${ORG_PLACEHOLDER}) AND ` 1 处；负控 7 的 ` AND tl.org_id = t.org_id` 在 `task-records.ts` 里仍恰 1 处；任务域源码里 `pg_advisory_xact_lock(hashtext(` 仍是 3 处（门 7）；本片没有新增 `Intl.DateTimeFormat` 调用点。

删库（补记的 C74–C77 与 C78–C98 各用一次重建的 `m4i_lane` 跑，每次跑完同样核对为零后删除）：两个库删除前查过 `tasks`、`task_lists`、`task_list_members`、`task_list_items`、`task_list_events`、`task_groups`、`task_group_items`、`task_user_settings` 里本文件前缀的行与 `@tasks-m4.test` 的种子用户都是 0，然后按名字 `DROP DATABASE m4i_lane`、`DROP DATABASE m4i_final`（按 `left(datname, 4) = 'm4i_'` 认，没有碰别的前缀的库）。

### S8.6 变异证明

做法同 §S7.5（私有工件目录里的脚本，由上一片的脚本改库名而来；原字节存在工作树之外，写回后 `cmp -s`；99 个全部逐字节还原；逐个串行，期间不跑别的 vitest 进程）。DB = `task-m4-groups`（36 格），`m4i_lane`；UNIT = `task-groups` 加 `task-list-access` 加 `task-records-guards` 加 `tasks-route-errors`（163 格）。首轮跑 C01–C73，代码是 `132cf9d945`，真库文件是工作树里已经改好、尚未提交的版本（含下面说的两格确定性改动，不含 C03、C09 的两格）：全部变红，其中 C03、C09、C11、C12、C53 只被单测击杀。C03（小数位置）与 C09（同位的重编号按 locale）在真库里没有判别格：首轮的小数位置都同时越界，删组格里没有同位的分组；`14486aec2b` 补了两格（区间内的 0.5 与 1.5；同位的 B、a 删组后的重编号），复跑两个都在 DB 变红。C11 在 HTTP 上等价：缺键已被 `hasOwnProperty` 那一行先挡住，`raw == null` 只多放过 JSON 表达不了的 `undefined`；另加 C11b（把缺键的答案改成默认组，这才是现实中会写错的地方），在 DB 变红。`14486aec2b` 一并提交了首轮之前做的两格确定性改动（摆放读里各组任务按与 id 序相反摆放，C21 才必然变红；跨组移动格让别的容器的分组 id 排在前面，C61 才必然变红），首轮的 C21、C61 就是在改好的格上得到的。下表 C03、C09、C11b 三行是 `14486aec2b` 上的结果，其余是首轮。

| # | 变异（文件） | DB / UNIT 失败 | 变红的格 |
|---|---|---|---|
| C01 | `planGroupItemOrder` 多放过末尾之后一位（纯函数） | 3/36；4/163 | 可见集下标、422、个人首次写 |
| C02 | 负的位置放行（纯函数） | 1/36；1/163 | 422 |
| C03 | 小数位置放行（纯函数） | 1/36；1/163 | 可见集下标（0.5、1.5） |
| C04 | 被移动的任务不先移出（纯函数） | 2/36；4/163 | 可见集下标、空操作 |
| C05 | 重写时丢掉不可见行（纯函数） | 3/36；4/163 | 可见集下标、空操作、个人可见集 |
| C06 | 不可见行写在可见行之前（纯函数） | 3/36；4/163 | 同上 |
| C07 | `before` 不是可见在前的规范顺序（纯函数） | 1/36；4/163 | 空操作（被穿插的不可见行让同序也写库） |
| C08 | 删组后不重编号（纯函数） | 2/36；3/163 | 清单删组、个人删组 |
| C09 | 重编号的并列按 locale（纯函数） | 1/36；1/163 | 清单分组读的删组一步 |
| C10 | 组名不查可存文本（纯函数） | 2/36；2/163 | 改名（U+0000 与孤立代理项两种名字）、个人建组 |
| C11 | `raw == null` 放过 `undefined`（纯函数） | 0/36；1/163 | HTTP 上等价（见上）；单测的 `{ groupId: undefined }` |
| C11b | 缺 `groupId` 键当成默认组（纯函数） | 1/36；2/163 | 422（`{ position: 0 }` 那一种体） |
| C12 | `groupId` 任何字符串都放行（纯函数） | 0/36；1/163 | HTTP 上等价：分组在已读出的本容器行里按 id 查找，不是 id 的字符串查不到，同样 422，也不进 SQL；单测 |
| C13 | 总是给合成默认组（纯函数） | 3/36；1/163 | 合成默认组、个人首次写、个人第二租户 |
| C14 | 从不给合成默认组（纯函数） | 2/36；4/163 | 合成默认组、负控 5 的前置 |
| C15 | 合成默认组带 id（纯函数） | 2/36；2/163 | 同上 |
| C16 | 负控 5：分组 org 子句恒真（`task-list-access.ts`） | 3/36；4/163 | 个人第二租户、个人摆放、负控 5 格（needle 已被改写） |
| C17 | 个人分组不按用户过滤（`task-list-access.ts`） | 4/36；3/163 | 合成默认组、个人可见集、个人改名与删组、个人摆放 |
| C18 | 清单分组不按清单过滤（`task-list-access.ts`） | 7/36；2/163 | 建组、读、改名、删组、移动、422、摆放读 |
| C19 | 分组排序的 id 用库的缺省排序规则（`task-list-access.ts`） | 1/36；1/163 | 清单分组读（同位的 B、a） |
| C20 | 分组只按 id 排（`task-list-access.ts`） | 2/36；1/163 | 清单分组读、合成默认组（邻居的分组顺序） |
| C21 | 组内只按任务 id 排（`task-list-access.ts`） | 4/36；2/163 | 摆放读、可见集下标、移动、个人可见集 |
| C22 | 摆放分页先按下标（`task-list-access.ts`） | 1/36；2/163 | 摆放读 |
| C23 | 摆放分页的组 id 用库的缺省排序规则（`task-list-access.ts`） | 1/36；2/163 | 摆放读（B、a、c） |
| C24 | 摆放读给库里的原始位置（records） | 4/36；1/163 | 可见集下标、移动、摆放读、个人可见集 |
| C25 | 摆放读不按可见集过滤（records） | 3/36；1/163 | 可见集下标、摆放读、个人可见集 |
| C26 | 稠密下标在页内编号（records） | 1/36；0/163 | 摆放读（第二页从组 a 中间开始） |
| C27 | 摆放读的 `total` 数了不可见行（records） | 3/36；0/163 | 可见集下标、摆放读、个人可见集 |
| C28 | 清单分组读的 `total` 是本页条数（records） | 1/36；0/163 | 清单分组读 |
| C29 | 清单分组读先解析分页（records） | 1/36；1/163 | 清单分组读（非成员 `limit=0` 成了 422） |
| C30 | 摆放读先解析分页（records） | 1/36；1/163 | 摆放读 |
| C31 | 清单建组先看名字再判能力（records） | 1/36；1/163 | `m4list`（`read` 成员的坏请求体成了 422） |
| C32–C35 | 建组、改名、删组、摆放只要 `view`（records，各一个） | 各 1/36；1/163 | `m4list`（`read` 成员的格） |
| C36 | 建组不先落默认组（records） | 4/36；1/163 | 个人建组、个人改名与删组、个人第二租户、负控 5 的前置 |
| C37 | 缺默认组行时不计入上限与位置（records） | 3/36；1/163 | 个人建组（新组到了 0）、并发首次写、个人第二租户 |
| C38 | `group_created` 的 payload 为 `{}`（records） | 3/36；1/163 | 建组、改名、锁后时间戳 |
| C39 | 分组行取 `now()`（records） | 1/36；1/163 | 锁后时间戳（只有它看得出取在锁前） |
| C40 | 分组事件另取一次 `clock_timestamp()`（list-records） | 3/36；1/163 | 建组、改名、锁后时间戳（「同一读数」） |
| C41 | 同名也写（records） | 1/36；0/163 | 改名（同名空操作的 org 状态变了） |
| C42 | 改名先看名字再找分组（records） | 2/36；1/163 | 改名（别的清单的分组带空名字成了 422）、个人改名与删组 |
| C43 | 改名取 `now()`（records） | 1/36；0/163 | 锁后时间戳 |
| C44 | 默认组可以删（records） | 2/36；1/163 | 清单删组、个人删组 |
| C45 | 删组后不写重编号（records） | 2/36；1/163 | 同上 |
| C46 | `group_deleted` 的 payload 为 `{}`（records） | 1/36；1/163 | 清单删组 |
| C47 | `reassignedTo` 写成被删的分组（records） | 2/36；1/163 | 清单删组、个人删组 |
| C48 | 摆放的任务只查本 org（records） | 3/36；2/163 | 摆放 404、个人摆放、个人可见集（撤掉之后的 404） |
| C49 | 摆放先看请求体再查任务（records） | 1/36；1/163 | 摆放 404（坏请求体成了 422） |
| C50 | 摆放先看 `position` 再看 `groupId`（records） | 1/36；1/163 | 422（两字段都坏成了 `INVALID_POSITION`） |
| C51 | 每次摆放都另落一个默认组（records） | 5/36；0/163 | 移动、摆放 404 的末步、个人可见集、并发首次写、权限码（23505 ⇒ 500） |
| C52 | 不可见行算作可见（records） | 15/36；1/163 | 可见集下标、空操作等 15 格 |
| C53 | 同序也走写库（records） | 0/36；1/163 | 真库上等价：`applyMoveItem` 的空操作计划没有位置，目标组已有该任务的行不会新写，删其它组的语句删不到行；单测（多出的语句）击杀 |
| C54 | 删其它组的行不限本容器（records） | 2/36；2/163 | 移动（另一张清单与个人分组的行没了）、个人可见集（邻居的摆放没了） |
| C55 | 不删其它组的行（records） | 1/36；2/163 | 移动（T 同时在 A、B） |
| C56 | 不重写目标组（records） | 3/36；2/163 | 可见集下标、移动、个人可见集 |
| C57 | `group_changed` 的 payload 为 `{}`（records） | 2/36；1/163 | 可见集下标、移动 |
| C58 | `group_changed` 另取一次读数（records） | 2/36；1/163 | 移动、锁后时间戳 |
| C59 | 源组总是默认组（records） | 1/36；1/163 | 移动（从 A 到 B 写成了从默认组） |
| C60 | 没有行的任务算在目标组（records） | 2/36；0/163 | 可见集下标、锁后时间戳（换组事件没写） |
| C61 | 读「任务在哪些组」不限本容器（records） | 1/36；0/163 | 移动（源组成了另一张清单的默认组） |
| C62 | 分组项写成别的 org（records） | 14/36；2/163 | 所有成功的摆放（组合外键 23503 ⇒ 500） |
| C63 | 分组项取 `now()`（records） | 1/36；1/163 | 锁后时间戳 |
| C64 | 分组写成别的 org（records） | 22/36；2/163 | 所有建组与首次写（清单 scope 撞组合外键；个人 scope 落到看不见的 org） |
| C65 | 落行的默认组不用默认名（records） | 2/36；1/163 | 个人首次写、并发首次写 |
| C66 | 首次写的分组项另取一次读数（records） | 1/36；1/163 | 个人首次写（「同一读数」） |
| C67–C70 | 四条路由的权限码对调（`GET …/groups`、`PUT …/group-items/:taskId`、`GET /api/task-groups/items`、`DELETE /api/task-groups/:groupId`） | 各 1/36；0/163 | 各自的权限码格 |
| C71 | `GET …/group-items` 缺 org 回降级体（路由） | 1/36；0/163 | 缺 org |
| C72 | `GET /api/task-groups` 缺 org 回 404（路由） | 1/36；0/163 | 缺 org |
| C73 | 个人摆放把请求体的 `groupId` 当任务 id（路由） | 7/36；1/163 | 个人首次写等 7 格 |
| C74 | 个人建组的结构锁以调用者为键（records） | 1/36；1/163 | 并发首次写（两个请求不再在 org 的锁上排队）；锁键单测 |
| C75 | 个人改名的结构锁以调用者为键（records） | 0/36；1/163 | 只有锁键单测：真库里没有改名与别的写在锁上相遇的格 |
| C76 | 个人删组的结构锁以调用者为键（records） | 0/36；1/163 | 同上 |
| C77 | 个人摆放的结构锁以调用者为键（records） | 1/36；1/163 | 并发首次写；锁键单测 |
| C78–C85 | 其余八条路由的权限码对调（清单 scope 的建组、改名、删组与 `GET …/group-items`；个人 scope 的 `GET`、`POST /api/task-groups`、`PUT …/items/:taskId`、`PATCH …/:groupId`，各一个） | 各 1/36；0/163 | 各自的权限码格 |
| C86 | `GET …/groups` 缺 org 回降级体（路由） | 1/36；0/163 | 缺 org |
| C87–C95 | 其余九个缺 org 分支：八条写的 422 `ORG_MISSING` 改成 404、`GET /api/task-groups/items` 的降级体改成 404（路由，各一个） | 各 1/36；0/163 | 缺 org |
| C96 | 摆放不先挡不可存的任务 id（records，`requireVisibleTask`） | 2/36；1/163 | 摆放 404、个人摆放（`tsk%00x` 进了 SQL，22021 ⇒ 500）；「没有语句携带它」单测 |
| C97 | 个人分组读不分页（records） | 1/36；1/163 | 合成默认组（`offset=1` 仍给出合成项） |
| C98 | 个人分组读的 `total` 只数表行（records） | 2/36；1/163 | 合成默认组（`total` 成了 0）、负控 5 的前置 |

文件内（每遍 lane 都跑）：负控 5（§S8.3）。

C78–C98 也是终审时补的（库 `m4i_lane` 再重建一次、跑完核对为零后删除）：首轮只对 12 条路由里的 4 条变异了权限码、2 条变异了缺 org 分支，其余的守卫虽有格在钉，却没有变异证明，S7 的 B37–B44 是同一类的先例；另补读写路径上三处守卫。21 个都在 DB 变红。

C74–C77 是终审时补的（库 `m4i_lane` 为此重建一次、跑完即删）：个人 scope 的四个写原先只有「首句是 `SET TRANSACTION`、第二句取咨询锁」的格，锁键换成调用者也不会变红；把第一格改成逐个核对八个写的锁参数都是 `task-structure:org-1` 之后，四个都在单测变红，建组与摆放另在并发首次写格变红。改名与删组的锁键只有单测钉着（§S8.8）。

没有做、或判为等价的变异：`buildTaskUserGroupScopeCondition` 去掉 `scope = 'user'`——清单 scope 的行 `user_id` 为空（`task_groups_scope_owner_chk`），`user_id = $1` 已经排除它们，等价；清单构造器去掉 `scope = 'list'` 同理；`parseTargetGroupId` 去掉对象类型的检查——非对象的请求体在 `hasOwnProperty` 上同样取不到键，等价；`planGroupItemOrder` 去掉 `typeof position !== 'number'`——`Number.isSafeInteger` 对非数值本来就是假，等价。

### S8.7 与设计的偏差

1. **多一个构造器** `buildTaskListGroupScopeCondition`：设计 §4.1 只列了个人 scope 的构造器；清单 scope 的分组现在也经同一个 `task_groups.org_id` 子句取，两种 scope 的分组读都单点发射。负控 5 因此也会放宽清单 scope 的分组条件，但清单 scope 先按 id 与 org 取清单（负控 2 管的那一处），第二租户格不受影响。设计 §4.1 已补。
2. **多四个纯函数**（`parseTaskGroupName`、`syntheticUserDefaultGroup`、`userGroupsWithDefault`、`parseTargetGroupId`）：合成默认组的形状与「没有默认组行就补在最前」、`groupId` 的形状都是规则，按门 20 放进 `src/tasks`。设计 §4.1 已补。
3. **个人分组列表在内存里分页**：合成项不是表行，`total` 是补过合成项的列表长度，不是另一条 `count(*)`（设计 §7.1）；结果相同，个人分组有软上限 50。设计 §3.5 已写。
4. **`task-list-records.ts` 导出四个共用件**（清单载入、能力判定、请求体字段、清单事件写入），供 `task-group-records.ts` 用。
5. **默认组落行不限个人 scope**：需要默认组的写（建组、`groupId: null` 的摆放）在两种 scope 下都会先补默认组行；清单 scope 的默认组随建清单落行、不能删，这条路径在接口上走不到。删组时容器有分组却没有默认组行（只能绕过接口写出来）是 500，不是 4xx。设计 §3.5 已写。
6. **`writeListEvent` 的分组来源多核一个条件**：复制 `updated_at` 时要求该分组的 `list_id` 就是事件的清单，取不到行就不写事件（本片的调用处不会传别的清单的分组）。
7. **`whileStructureLockHeld` 多一个参数** `waiters`（缺省 1），原有调用不变。
8. **库的排序规则**：C19、C23 在缺省排序规则是 `C` 的库上等价（字节序与缺省序相同）。本地库是 `en_US.UTF-8`；CI 用的 `postgres:16` 镜像的缺省排序规则没有实测（§S8.8）。

### S8.8 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17。CI 镜像的缺省排序规则（§S8.7-8）没有实测。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- 12 条新路由在 trust-off 配置下的门 1 缺 org 格、门 2 / 16 的非 admin 三件事、路由人口枚举：归 S10。
- 个人分组的第二租户只在 realdb（trust-on）里有格；trust-off 下的同类格没有做（门 1 的清单第二租户格只覆盖清单前缀）。
- 并发：除「并发首次写」外没有专门的并发格（同一分组的并发摆放与删除、摆放与移出清单、摆放与撤掉负责人、个人分组的改名与删组）。它们都在 org 结构锁里串行（单测钉住首句、取锁与锁键），后到的一方在锁后重读。
- 分组项随任务软删或负责人撤掉而留下的残留行：设计说不删，本片也不清；它们的数量没有上限，摆放写每次都整组重写（含残留行），没有量过大组的耗时。
- 两个 recovery 守卫（`recovery-schema-drift` 等）：本片没有改迁移，没有重跑。
- R11 / R12 / `[own-48]`–`[own-52]` 的 owner 裁决：都按缺省交付。
- 前端：没有在浏览器里跑过任何东西。
- 本片测试文件的类型只在 §S8.5 那份临时配置下查过；仓库的 `tsconfig.json` 不含测试文件。
- 全量单测里 5 个与本片无关、因本机环境失败的文件：没有修。

### S8.9 给 S9 / S10 的交接

- **S9**：`task-m4-groups` 里所有负责人都是该任务 org 里经 `seedTaskActor` 播种的参与者；跨 org 的任务都由参与者自己创建（创建人豁免，`[own-16]`）、自己负责，并且另插了那个 org 的 `user_orgs` 行；关注人只用 SQL 插。「个人可见集」格经 `POST /api/tasks/:id/assignees` 重新指派的目标也是同 org 的参与者。所以 S9 的在职校验不需要给本文件补种子。
- **S10**：`M4_ROUTES` 加本片 12 条（读：`GET /api/task-lists/:id/groups`、`GET /api/task-lists/:id/group-items`、`GET /api/task-groups`、`GET /api/task-groups/items`；其余 8 条是写），合计 30 条；路由人口应为 51（本地已枚举）。缺 org 在 trust-off 下：清单 scope 两条读 404，个人 scope 两条读是不带 `total` 的降级体，8 条写 422。
- `TasksClient` 有了 `put`；`whileStructureLockHeld` 可以等多个排队的请求。
- lane 现在 15 文件 653 格，鉴权门 24 格；全量单测 20425 格（本机 5 个文件因环境失败）。
- 变异脚本与 99 个变异的定义在私有工件目录（`DRY=1` 只数 needle）。

### S8.10 前端对接（S8 的 12 条路由）

形状：`Group` = `{ id, scope, name, position, isDefault }`（`scope` 为 `'list'` 或 `'user'`；`id` 只有个人 scope 还没落行的默认组是 `null`）；摆放 = `{ groupId, taskId, position }`，`position` 是该任务在所属分组「可见集」里的 0 起稠密下标。错误体都是 `{ error: { code } }`；403 仍是 `rbacGuard` 的 `{ error: 'Insufficient permissions' }`；缺 org 的降级体是 `{ items: [], degraded: true, reason: 'org_missing' }`（没有 `total`）。

| 方法 路径 | 码 | 谁能用 | 请求 | 成功 200 | 错误 | 空操作 |
|---|---|---|---|---|---|---|
| `GET /api/task-lists/:id/groups` | read | 清单成员（任一角色，已归档也可以） | query `limit`（1–100，缺省 100）、`offset`（≥ 0） | `{ items: Group[], total }`，按 `position`、再按 `id` | 404 `NOT_FOUND`（不存在、他 org、非成员、坏 id、缺 org，逐字节相同，且先于分页）；422 `INVALID_LIMIT` `INVALID_OFFSET`（只对成员） | — |
| `POST /api/task-lists/:id/groups` | write | 清单 `edit` / `owner` | `{ name }` | `Group`，`position` 是建组前的分组数（排在最后） | 404（非成员、`read` 成员，都先于请求体）；422 `ORG_MISSING`（先于一切）、`INVALID_NAME`、`NAME_TOO_LONG`、`LIMIT`（每张清单 50 个，含默认组） | 否（每次新建） |
| `PATCH /api/task-lists/:id/groups/:groupId` | write | 同上 | `{ name }` | `Group`（默认组也能改名） | 404（同上；分组不属于这张清单、已删除、坏 id，都先于请求体）；422 `ORG_MISSING`、`INVALID_NAME`、`NAME_TOO_LONG` | 同名：200 原样 |
| `DELETE /api/task-lists/:id/groups/:groupId` | write | 同上 | — | `{ id, deleted: true, reassignedTo }`，`reassignedTo` 是默认组的 id；被删分组里的任务回到默认组（排在有摆放的任务之后），其余分组的 `position` 重新编成 0..n-1 | 404（同上；已删除也是 404）；422 `ORG_MISSING`、`IS_DEFAULT` | — |
| `GET /api/task-lists/:id/group-items` | read | 清单成员 | query 分页同上 | `{ items: 摆放[], total }`，按 `groupId`、再按 `position`；只含仍在清单里、未删除的任务；`total` 只数这些 | 同 `GET …/groups` | — |
| `PUT /api/task-lists/:id/group-items/:taskId` | write | 清单 `edit` / `owner`，且任务是这张清单里未删除的项 | `{ groupId, position }`；`groupId: null` 指默认组，也可以给默认组的真实 id | `{ taskId, groupId, position }`，`groupId` 是真实 id | 404（非成员、`read` 成员、任务不在清单 / 已删除 / 他 org / 坏 id，都先于请求体）；422 `ORG_MISSING`、`INVALID_GROUP`（缺 `groupId` 键、不是 `null` 也不是字符串、不是这张清单的分组）、`INVALID_POSITION`（缺、不是非负整数、超出范围）；两者都错报 `INVALID_GROUP` | 可见顺序不变：200 原样，不写 |
| `GET /api/task-groups` | read | 本人（本 org） | query 分页 | `{ items: Group[], total }`；还没有任何个人分组时恰一项 `{ id: null, scope: 'user', name: '默认分组', position: 0, isDefault: true }`、`total: 1`；读不写库 | 422 分页；缺 org：降级体 | — |
| `POST /api/task-groups` | write | 本人 | `{ name }` | `Group`；第一次建组同时落默认组（位置 0），新组位置 1 | 422 `ORG_MISSING`、`INVALID_NAME`、`NAME_TOO_LONG`、`LIMIT`（每人每 org 50 个，含默认组） | 否 |
| `GET /api/task-groups/items` | read | 本人 | query 分页 | `{ items: 摆放[], total }`；只含本人仍负责、未删除的任务（被撤掉负责人的任务不再出现，重新指派后出现在原组末尾） | 422 分页；缺 org：降级体 | — |
| `PUT /api/task-groups/items/:taskId` | write | 本人负责的任务 | `{ groupId, position }`；`groupId: null` 指默认组（还没落行时这次写会落行） | `{ taskId, groupId, position }`，`groupId` 是默认组落行后的真实 id | 404（不是本人负责、已删除、他 org、坏 id，先于请求体）；422 `ORG_MISSING`、`INVALID_GROUP`（含别人的分组、清单的分组、本人在别的 org 的分组）、`INVALID_POSITION` | 可见顺序不变：200 原样，不写 |
| `PATCH /api/task-groups/:groupId` | write | 本人本 org 的分组 | `{ name }` | `Group` | 404（别人的、他 org 的、不存在的、`null`，都先于请求体）；422 `ORG_MISSING`、`INVALID_NAME`、`NAME_TOO_LONG` | 同名：200 原样 |
| `DELETE /api/task-groups/:groupId` | write | 同上 | — | `{ id, deleted: true, reassignedTo }` | 404；422 `ORG_MISSING`、`IS_DEFAULT` | — |

前端合并规则：摆放是稀疏的，没有摆放的任务属于默认组、排在有摆放的任务之后，不在下标空间里；任务列表来自 `GET /api/task-lists/:id/items`（清单）或 `GET /api/tasks?view=assigned`（个人）。`PUT` 的 `position` 数的是目标组里**去掉被移动任务之后**、`GET …/group-items` 返回的那些任务，取值 0 到它们的个数；要把任务放到某个没有摆放的任务后面，先给排在前面的没有摆放的任务各发一次 `PUT`。个人默认组在落行之前没有 id，不能 `PATCH` / `DELETE`；第一次写之后 `GET /api/task-groups` 给出真实 id。

事件：清单的 `GET /api/task-lists/:id/events` 里多了 `group_created`、`group_renamed`、`group_deleted`，payload `{ groupId }`，`actorId` 是操作者；任务这边（不经接口读）清单 scope 换组时有 `group_changed`，payload `{ listId, fromGroupId, toGroupId }`。组内重排与个人分组的任何写都不产生事件。分组的写不改清单的 `updatedAt`、不改任务的 `version` 与 `updatedAt`。

## S6+S7 闸修复（S6 与 S7 闸审，owner 2026-10-07 的成员增删裁定）

基于 `d18c436c8d`（S0–S8）。S6、S7 与 S5 闸修复的增量闸审共 9 条：8 条成立（三票），M4G4T-05（NIT）在投票环节缺票、没有成立也没有被推翻，按文档清理处理。同一天 owner 作了两项裁定：R12 取本件的收窄版，即 (a1)、(a2) 两半都保留；增删负责人与关注人须直接角色。本片的主体改动是落实后一项，记为 `[own-53]`。提交：

| 提交 | 内容 |
|---|---|
| `1ae289233c` | `canChangeTaskMembers`；四条写改走它；详情的 `canManageMembers`；`leedit` 格改写、新 `dirmem` 格、清单项的 (a1) (a2) 合并格；p0a 的详情形状；单测 |
| `3b9a126961` | 闸审补格：成员写只动本清单的行（M4G4T-01）、清单项移出钉到任务（M4G4T-02）、`listIds` 按角色（M4G4T-03）、已归档清单的成员路由（S6-ARCH-1）；单测钉整条语句 |
| `f7aa098f05` | (a1) 加入格的名字改为陈述规则（只改名字） |
| 本节所在提交 | 设计修订 4（抬头、§3.1、§3.3、§3.4、§4.1、§4.4、§4.6、§5.5、§6.2、§6.3、§10.1、§10.4、§10.12、§11、§12-Q5、§12-Q16、§13）；本节；本文抬头与 §S6.5-8、§S6.5-9、§S6.8、§S7.1、§S7.2、§S7.5、§S7.7 的更正 |

本地一次性库只用名字以 `m4j_` 开头的库（按 `left(datname, 4) = 'm4j_'` 认）：`m4j_lane`（开发、全部变异、单文件重复）、`m4j_final` 与 `m4j_final2`（最终代码 head `f7aa098f05` 上各自从空库全量迁移 426 条）。删库记录见 §S67F.3 末。`node_modules` 仍是指向规范检出的符号链接，没有改动、没有跑 `pnpm install`。脚本、变异定义与逐个日志在私有工件目录。

### S67F.1 逐条处置

| id | 级别 | 处置 | 落点 | 证红 |
|---|---|---|---|---|
| owner 2026-10-07 裁定 | — | 已落实，`[own-53]`：增删负责人、增删关注人四条写要求调用者对任务有直接角色（创建人或负责人）；判定在结构锁之后、请求体与路径用户 id 之前，不满足是与缺失 id 逐字节相同的 404；详情多 `canManageMembers`。只有清单身份的调用者保留 PATCH、设父、切模式、完成与重启、评论；关注人 `leave` 不变。设计 §3.4、§12-Q16 改为只写现行规则与带日期的裁定 | `task-access.ts`、`task-structure.ts`、`task-records.ts`；list-roles 的 `leedit`、`dirmem` 格，list-items 的 `rmdir` 格；两份单测 | D01–D15 |
| M4G4-S7-PACK-1 | P2 | 已改（文档）：(a2) 记为对 R12(a) 推荐值的放宽，是给任务创建人的新能力，只有 (a1) 记为收窄。两半都已于 2026-10-07 裁定，所以 (a2) 照原样开着交付 | 设计 §3.4、§11 `[R12]` `[own-25]`、§12-Q16 | — |
| M4G4T-04 | P3 | 同上（同一处标签与 §3.4 的「不是新权力」一句，后者已删） | 同上 | — |
| M4G4T-01 | P2 | 已修（补格）：改角色、移除、转让三格里，目标与转让方另在别的清单里有成员行（一张是所有者，一张是 `read`）；写后那些清单的行、成员行、事件逐字节不变，各仍恰一行 `owner`。单测钉四条语句的整句 | list-members 的 `members\|role`、`members\|remove`、`members\|transfer`；`task-records-guards` | D16–D19（= 闸审 G06、G05、G03、G04） |
| M4G4T-02 | P2 | 已修（补格）：移出格与 (a2) 移出格里，同一清单、同一分组另有一条任务；移出后它的清单项与分组项（位置不变）都在。单测钉两条 `DELETE` 的整句 | list-items 的 `items\|remove` 与 (a2) 移出格；`task-records-guards` | D20、D21（= 闸审 G01、G02） |
| M4G4T-03 | P2 | 已修（补格）：`listIds` 格加一个只在一张持有清单里的 `edit` 成员、一个读另一张持有清单的关注人，各只看到自己那张 | list-items 的 `items\|listIds` | D22（= 闸审 G16）、D23 |
| S6-ARCH-1 | P3 | 已修（补格）：同一串成员路由（名单、增、`read` 成员增、改角色、本人退出、前成员读名单、转让、前所有者转让、新所有者移除、读名单）在经路由归档的清单与未归档的清单上各跑一遍，状态码、响应体（去掉清单 id 与各清单自己的 `createdAt`）、成员行、成员事件逐一相同；归档清单的 `archived_at`、`updated_at` 不变 | list-members 的 `members\|archived`（新格） | D24–D29（D25 = 闸审 R3） |
| S6-TS-NIT-1 | NIT | 取「保留取舍、写明口径」：加入的成员行 `created_at` 仍取列缺省（写事务的开始时刻，在等锁之前），所有者行复制清单行的锁后读数；`createdAt` 不与 `/events` 排序对齐，排序与先后看 `/events` | 设计 §3.3、§4.4；本文 §S6.5-8、§S6.8 | — |
| M4G4T-05 | NIT | 已改（文档）：§S6.5-8 同上；本文抬头的覆盖范围；设计抬头、「基座」「锁」「M4 裁决包」三条与 §12-Q5 改为 #6229 合并之后的状态 | 设计抬头、§12-Q5；本文抬头 | — |

拒绝码取 404 `NOT_FOUND`，不是 403，依据三条既有约定：M3 设计 §3.0「看不到、不能做、他 org、已软删，写与读都回 404，不区分原因」；本件 §3.0 与 `[own-09]`「行级判定失败一律 404、行级从不返回 403」；M3 各写路由「先能力、后请求体」，所以这个判定也排在请求体与路径 id 的校验之前。看得见任务、但不能增删成员的调用者因此与任务不存在得到逐字节相同的回答。

### S67F.2 改动文件

| 文件 | 改动 |
|---|---|
| `src/tasks/task-access.ts`（末尾追加） | `canChangeTaskMembers({ task, me })` = `can(resolveTaskRoles(三列, me), 'edit')`：任务对象只取 `createdBy` / `assigneeIds` / `followerIds` 三项传给 `resolveTaskRoles`，签名里没有清单身份的位置（与 `canAddTaskToList` 同形）。门 1 与门 19 的 needle 计数不变（§S67F.3 末）。 |
| `src/services/task-structure.ts` | 私有 `loadMembersForChange(db, task, { taskId, actorId })`：在锁内读负责人行与关注人行，调 `canChangeTaskMembers`，为假 ⇒ 404，为真把这两组行交给随后的纯函数。`addAssignee`、`removeAssignee`、`addFollower`、`removeFollower` 在 `loadTask` 之后、请求体与路径用户 id 之前调用它；这四条写只按直接角色（创建人或负责人）判定，清单身份不是输入。`switchCompletionMode`、`setTaskParent`、`leaveTask`、评论与删除不变。 |
| `src/services/task-records.ts` | `getTask`：创建人、负责人、关注人组成的一行（`roleRow`）同时交给 `resolveTaskRoles` 与 `canChangeTaskMembers`；响应多 `canManageMembers`。 |
| `tests/integration/task-m4-list-roles.db.test.ts` | `snapshot()` 多读关注人行；`orgUsers`（`seedOrgMembers` 并登记清理）；`leedit` 格按裁定改写为直接角色格；新 `dirmem` 格。49 → 50 格 |
| `tests/integration/task-m4-list-items.db.test.ts` | 新 `rmdir` 格；移出格与 (a2) 移出格加同清单、同分组的第二条任务，后者的名字与一条注释改为陈述规则；`listIds` 格加 `edit` 成员与关注人；(a1) 加入格改名。24 → 25 格 |
| `tests/integration/task-m4-list-members.db.test.ts` | 改角色、移除、转让三格加别的清单；新 `members\|archived` 格。39 → 40 格 |
| `tests/integration/task-p0a.db.test.ts` | 详情 `toEqual` 加 `canManageMembers: true`；另断言创建人为真、关注人为假。格数不变（13） |
| `tests/unit/task-access.test.ts` | `canChangeTaskMembers`：7 行真值表、与直接角色 `edit` 在三列全部组合上一致、清单身份传不进去（`length === 1`；顶层或任务对象上夹带的清单身份不起作用）、钉点。200 → 210 格 |
| `tests/unit/task-records-guards.test.ts` | 新 describe：只有清单身份的调用者对四条写（合法与坏的 `userId` / 路径 id）都是 404，首句与取锁照常，不读 `task_list_members`，零写入；关注人 404 而 `leave` 照常；创建人坏 id 422、加负责人一行一事件；负责人加关注人、移除负责人各一行一事件。S6 的成员写与 S7 的清单项移出各加整句断言。59 → 61 格 |

**四条写的判定顺序**（锁后）：缺 org 422（路由）→ 任务 id 不可存 ⇒ 404，不发 SQL → 按 id 与 org 取任务、未软删 ⇒ 404 → 负责人行、关注人行 → `canChangeTaskMembers` ⇒ 404 → 请求体 / 路径的 `userId` ⇒ 422 `INVALID_ASSIGNEES` → 任务 C 的纯函数（`LIMIT` 等）→ 写行与事件。S9 的在职查询要排在纯函数判定为真的新增之后，也就在这条判定之后（设计 §4.6、§13 S9）。

### S67F.3 命令与结果

所有命令在 `packages/core-backend` 下（ops 测试在仓库根），`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<库> EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`；迁移 `MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项。最终运行都在代码最终 head `f7aa098f05` 上（本节所在提交只改两份文档；读设计文档的 `task-gate19-identities` 只读 `i-m4` 块，本片没有改它）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .`，退出码取 `$?` | 0，没有输出 |
| 改动的测试文件的类型 | 临时 tsconfig（同 §S7.4 的配置，`include` 列四个改过的真库文件、两个 helper、两个单测文件），放在工件目录 | 这 8 个文件与本片改动的 `src` 文件 0 条诊断；另有 47 条都在本片没有改的 `src` 文件里（34 条 TS2339、11 条 TS6133、2 条 TS6196），与 §S6.3、§S7.4、§S8.5 相同 |
| 任务单测子集 | `vitest run tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts`（29 个文件） | 29 files / **1152 passed**（S8 之后的 1140 加本片 12） |
| 三集合枚举、门 20、`i-m4` | `vitest run tests/unit/task-ci-coverage-enumeration.test.ts tests/unit/task-pure-no-io.test.ts tests/unit/task-gate19-identities.test.ts` | 3 files / 18 passed |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 5 failed \| 1078 passed \| 172 skipped (1255)；Tests 44 failed \| 18681 passed \| 1712 skipped (20437)**，147 秒。对账：§S8.5 的 20425 加本片 12 = 20437；passed 18669 加 12 = 18681。失败的 5 个文件正是已知的那 5 个：`multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup`（日志里是 `RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED` / `RECOVERY_LOCAL_CUSTODY_STORE_REFUSED`）与 `attendance-admin-plugin-lib-dist-layout-boot`（`ELOOP: too many symbolic links encountered`），原因与 §S5.4、§S6.3、§S8.5 相同 |
| 真库 lane × 3（15 文件，`m4j_final`） | `vitest --config vitest.integration.config.ts run <tasks-realdb.yml 的 15 个文件> --reporter=verbose` | 第 1、2 遍 **15 passed；656 passed (656)**，55 / 56 秒，hang-up 0。第 3 遍 655 / 656：`task-m4-list-roles` 的「负控 6」子进程里 supertest 的请求得到 `socket hang up`（ECONNRESET），子进程的日志先记下了预期的 500 路径（`applyComplete: a zero-assignee task can only be completed by its creator`），之后连接被断开，子进程退出 1（M3 验证 MD 第五轮记过同类的瞬时 `socket hang up`）。这一格走的是完成与重启，本片没有改动它经过的代码 |
| 复核 | `task-m4-list-roles` 单文件 × 5（`m4j_lane`）；另建 `m4j_final2` 从空库全量迁移后 lane × 3 | 单文件五遍各 50 passed (50)、hang-up 0；`m4j_final2` 三遍均 **15 passed；656 passed (656)**，66 / 58 / 79 秒，hang-up 0。逐文件：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m3-comments-deletion 33、m4-schema 59、**m4-list-roles 50**、m4-paging-settings 77、m4-dates 107、m4-lists 66、**m4-list-members 40**、**m4-list-items 25**、m4-groups 36（653 加 3） |
| 鉴权门 | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false` 由配置与 `setup.ts` 给） | `m4j_final` 两遍、`m4j_final2` 一遍，均 **24 passed (24)** |
| ops 脚本测试（仓库根） | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs`；`… global-history-flag-manifest.test.mjs`；`… staging-tasks-smoke.test.mjs` | 3/3；36/36；19/19 |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫本片改动的全部文件与两份文档 | 退出 0 |
| 本机路径、机器名、局域网地址 | 对 `git diff d18c436c8d` 的新增行查用户主目录前缀、用户名、私有工件目录前缀、系统临时目录前缀、机器名、三个私有网段前缀与部署主机地址 | 实际的路径、名字、地址 0 处（本行只写模式的名称，不写模式本身） |
| 变异 | §S67F.4 | 29 / 29 变红 |

needle 复核（`f7aa098f05`）：`task-access.ts` 里 `(tasks.org_id = ${ORG_PLACEHOLDER}) AND ` 1、`.join(' OR ')` 1、`(assigneeCount > 0 || roles.includes('creator'))` 1、`COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone)` 4、`case 'assigned':` 2、`assignee: {` 1，与 §S2.3 相同；`task-list-access.ts` 的清单与分组 org needle 各 1；负控 7 的 ` AND tl.org_id = t.org_id` 在 `task-records.ts` 里仍恰 1 处；任务域源码里 `pg_advisory_xact_lock(hashtext(` 仍是 3 处（门 7）；没有新增 `Intl.DateTimeFormat` 调用点。

删库：三个库删除前查过 `tasks`、`task_lists`、`task_list_members`、`task_list_items`、`task_list_events`、`task_groups`、`task_group_items`、`task_user_settings` 与 `task_events` 里本片各文件前缀的行、`@tasks-m4.test` 的种子用户都是 0，然后按名字 `DROP DATABASE m4j_lane`、`m4j_final`、`m4j_final2`（按 `left(datname, 4) = 'm4j_'` 认，没有碰别的前缀的库）。

### S67F.4 变异证明

做法同 §S8.6（私有工件目录里的脚本，由上一片的脚本改默认库名而来；断言 needle 恰一次 → 原字节存到工作树之外 → 写入变异 → 跑 → 写回原字节 → `cmp -s`；29 个全部逐字节还原；逐个串行，期间不跑别的 vitest 进程；跑完 `git status` 干净）。全部在代码 head `3b9a126961` 上跑（`f7aa098f05` 只改一格的名字）。规则一组（D01–D15）的 DB = `task-m4-list-roles` 加 `task-m4-list-items` 加 `task-p0a`（88 格），UNIT = `task-access` 加 `task-records-guards`（271 格）；其余各组的 DB 是对应的真库文件，UNIT 是 `task-records-guards`（61 格）或不跑。下表「失败」一栏是 DB / UNIT 的失败格数，只有失败格才算变红，没有一个是因为收集失败或进程崩溃。

| # | 变异（文件） | 失败 | 变红的格 |
|---|---|---|---|
| D01 | `canChangeTaskMembers` 恒真（access） | 6/88；7/271 | 直接角色格、`dirmem` 格（关注人的 `canManageMembers`）、`rmdir` 格、list-reader 写格与跨 org 清单项格、p0a 详情；真值表、一致性、清单身份传不进去、钉点、两格服务单测 |
| D02 | 谓词用 `view` 代替 `edit`，关注人算进来（access） | 3/88；5/271 | 直接角色格（经清单 `edit` 的关注人那一组）、`dirmem`、p0a；真值表等 |
| D03 | 谓词去掉创建人（access） | 3/88；5/271 | `dirmem`（创建人的写成了 404）、(a2) 移出格（创建人撤掉负责人一步）、p0a；真值表等 |
| D04 | 谓词去掉负责人（access） | 2/88；5/271 | `dirmem`（负责人的写成了 404）、p0a；真值表等 |
| D05 | 谓词恒假（access） | 3/88；8/271 | `dirmem`、(a2) 移出格、p0a；真值表等 |
| D06 | `addAssignee` 改用 `assertRowAbility(…, 'edit')`（structure） | 2/88；1/271 | 直接角色格、`rmdir` 格；服务单测 |
| D07 | `removeAssignee` 同上（structure） | 2/88；2/271 | 直接角色格、`rmdir` 格；两格服务单测 |
| D08 | `addFollower` 同上（structure） | 2/88；1/271 | 直接角色格、`rmdir` 格；服务单测 |
| D09 | `removeFollower` 同上（structure） | 1/88；1/271 | 直接角色格；服务单测 |
| D10 | `addAssignee` 先校验请求体、后判直接角色（structure） | 1/88；1/271 | 直接角色格（坏 `userId` 成了 422）；服务单测 |
| D11 | `removeFollower` 先校验路径 id、后判直接角色（structure） | 1/88；1/271 | 直接角色格（坏路径 id 成了 422）；服务单测 |
| D12 | `loadMembersForChange` 不拒绝（structure） | 4/88；2/271 | 直接角色格、`rmdir` 格、list-reader 写格、跨 org 清单项格；两格服务单测 |
| D13 | `leaveTask` 改走成员增删的判定（structure） | 1/88；1/271 | 直接角色格（关注人 `leave` 成了 404）；服务单测 |
| D14 | `canManageMembers` 取 `can(roles, 'edit')`（records） | 3/88；— | 直接角色格、`dirmem`、`rmdir`（`canManageMembers` 的断言） |
| D15 | `canManageMembers` 恒真（records） | 4/88；— | 同上三格与 p0a |
| D16 | 成员 `DELETE` 去掉清单谓词（list-records；闸审 G06） | 2/40；1/61 | `members\|remove`（别的清单里的行没了）、`members\|archived`；整句单测 |
| D17 | 改角色 `UPDATE` 去掉清单谓词（list-records；G05） | 1/40；1/61 | `members\|role`（别的清单里没了所有者）；整句单测 |
| D18 | 转让降级 `UPDATE` 去掉清单谓词（list-records；G03） | 2/40；1/61 | `members\|transfer`、`members\|archived`；整句单测 |
| D19 | 转让升级 `UPDATE` 去掉清单谓词（list-records；G04） | 2/40；1/61 | `members\|transfer`（撞 `uq_tlsm_owner`，500）、`members\|archived`；整句单测 |
| D20 | 清单项 `DELETE` 去掉任务谓词（list-records；G01） | 2/25；1/61 | `items\|remove`、(a2) 移出格（第二条任务的清单项没了）；整句单测 |
| D21 | 分组项清理去掉任务谓词（list-records；G02） | 2/25；1/61 | 同上两格（第二条任务的分组项没了）；整句单测 |
| D22 | `listIds`：清单 `edit` 成员按创建人算（records；G16） | 1/25；— | `items\|listIds`（`edit` 成员的断言） |
| D23 | `listIds`：关注人按创建人算（records） | 1/25；— | `items\|listIds`（关注人的断言） |
| D24 | `loadMemberList` 拒绝已归档清单（list-records） | 2/40；— | `members\|archived`；降创建人格（归档之后创建人取消归档成了 404） |
| D25 | 增成员拒绝已归档清单（list-records；闸审 R3） | 1/40；— | `members\|archived` |
| D26 | 改角色拒绝已归档清单（list-records） | 1/40；— | `members\|archived` |
| D27 | 移除 / 本人退出拒绝已归档清单（list-records） | 1/40；— | `members\|archived` |
| D28 | 转让拒绝已归档清单（list-records） | 1/40；— | `members\|archived` |
| D29 | 名单读拒绝已归档清单（list-records） | 1/40；— | `members\|archived` |

没有做、或判为等价的变异：`canChangeTaskMembers` 不再逐项复制任务对象的三列、直接把 `input.task` 交给 `resolveTaskRoles`——`resolveTaskRoles` 本来只读三列，第三个参数缺省为空，HTTP 上等价；单测里「任务对象上夹带清单身份」那一格对它也是等价的（`resolveTaskRoles` 不读对象上的多余键），所以这条约束靠签名（`length === 1`）与代码审读，不靠变异。`loadMembersForChange` 先读关注人、后读负责人——两条只读查询互换，等价。

### S67F.5 与设计、清单的偏差

1. **切模式要 `edit`（含清单身份）**：owner 的裁定只点名增删负责人与关注人；切模式与 PATCH 同为 `edit`，只有清单身份的 `edit` 成员也可以切（设计 §3.4、§6.3）。
2. **谓词的形状**是 `canChangeTaskMembers({ task, me })`，与 `canAddTaskToList` 同形：任务端只从三列直接角色解析，签名里没有清单身份的位置；没有取「接收角色集、内部过滤」的写法，那样调用方仍可能传进完整角色集。
3. **四条写只按直接角色判定**，清单身份不是输入；负责人行与关注人行在锁内读一次，判定与随后的纯函数用同一份行。
4. **S6-TS-NIT-1 取「写明口径」**，没有把加入的成员行改成锁后读数（闸审给的另一种修法）。
5. **被改变期望的既有断言**只有两处：`task-m4-list-roles` 里按裁定改写的一格（只有清单身份的 `edit` 成员经路由增删负责人与关注人一律 404）与 p0a 的详情 `toEqual`（多一个键）。另有 `snapshot()` 多读关注人行，用到它的格只在格内前后比较，期望不变。
6. **新格写入的用户都用 `seedOrgMembers` 播了 `user_orgs`**（`orgUsers`），S9 加在职校验之后这些格不需要再补种子。
7. **M4G4T-05 的三处**之外，设计抬头里「owner 尚未裁」「M3 尚未合并」两句与 §11 表头一并改为 2026-10-07 之后的状态；R02–R23 标签的改记仍归 S10。

### S67F.6 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- S10 的 trust-off 门行：本片没有新增路由，`M4_ROUTES` 不变；四条 M3 路由的门 1 / 2 / 16 格在鉴权门的 M3 表里，用的是创建人，期望不变（24/24）。
- R02–R23 在设计与代码里的 `ASSUMPTION(task-m4)` 标签改记「已裁 2026-10-07」：归 S10。本片只改 `[R12]`、`[own-25]` 与新的 `[own-53]`。R01 的裁定（2026-10-07）本片没有记。设计 §4.6 与 §13 S9 里「owner 不采纳 R17 / N2」的拆除面写于 2026-10-07 的裁定之前，本片没有改，交 S9 / S10 核对。
- 前端：没有在浏览器里跑过；M3 前端的成员控件仍按 `canEdit` 显示（§S67F.8）。
- 本文件不含本机绝对路径（§S10.4）。
- 全量单测里 5 个与本片无关、因本机环境失败的文件：没有修。

### S67F.7 给 S9 的交接

- 增负责人、增关注人的在职查询放在 `loadMembersForChange`（直接角色）与成员 id 校验之后、只对纯函数判定为真的新增（设计 §4.6、§13 S9）：没有直接角色的调用者先得到 404，不触发在职查询。
- `task-m4-list-roles` 的 `leedit`、`dirmem` 两格写入的用户已经 `seedOrgMembers`；`gate19m4` 两格、`task-m4-paging-settings` 与 `task-m4-dates` 里设计 §4.6 点名的格仍要补。
- lane 15 文件 656 格，鉴权门 24 格，全量单测 20437 格（本机 5 个文件因环境失败）。
- 变异脚本与定义在私有工件目录，`DRY=1` 只数 needle。

### S67F.8 前端对接（`canManageMembers`）

- `GET /api/tasks/:id` 新增 `canManageMembers: boolean`，键恒在。为真当且仅当调用者是任务的创建人或负责人。
- 为真：显示负责人、关注人的增删控件；四条写（`POST` / `DELETE /api/tasks/:id/assignees`、`POST` / `DELETE /api/tasks/:id/followers`）的请求、成功体与 422（`INVALID_ASSIGNEES`、`LIMIT`）同 M3。
- 为假：隐藏这四个控件。直接调用得到 404 `NOT_FOUND`，与任务不存在逐字节相同，先于请求体校验。
- 与 `canEdit` 分开看：只有清单身份的 `edit` 成员是 `canEdit: true`、`canManageMembers: false`，标题、描述、日期、提醒（PATCH）、父任务、完成方式照常可改，完成与重启看 `canComplete` / `canReopen`，负责人与关注人只读。M3 前端现在用 `canEdit` 决定成员控件（`apps/web/src/tasks/tasksApi.ts` 的注释写「`canEdit` covers membership, completion mode and parent」），要改为成员控件看 `canManageMembers`，完成方式与父任务仍看 `canEdit`。旧响应里没有这个键时，控件照旧显示，由服务端的 404 把关（与该文件对其余可选能力键的处理一致）。
- 关注人退出仍看 `canLeave`（`POST /api/tasks/:id/leave`）。关注人移除自己也走 `leave`；`DELETE …/followers/:self` 对没有直接角色的人是 404。
- 名单 `createdAt` 的口径见 §S6.8。

## S9 R17 / N2 回填（owner 2026-10-07 裁定）

基于 `c8fdd07e2b`（S6+S7 闸修复之后）。R17 与 N2 已于 2026-10-07 裁定采纳（回复模板句含这两条），本片是必做片，设计里「不采纳」的拆除面已删（设计修订 5）。同日的另一项裁定（`[own-53]`）定了增删负责人与关注人须直接角色，在职查询排在它之后。发送时的再次复核属 PR-3b，不在本片。提交：

| 提交 | 内容 |
|---|---|
| `e6d118f097` | 三个写入点的在职查询，以及它要求的夹具：M2/M3 文件、鉴权门与三个 M4 格的种子，`orgMemberSeeds`，`[own-53]` 单测 mock 回答在职查询 |
| `e619fb60d4` | 新真库文件 `task-m4-org-members`（27 格）与登记三处；`task-records-guards` 的 S9 六格 |
| `f4a0eb532c` | 设计修订 5（抬头、§1、§4.6、§10.1、§11、§12-Q3、§13 S9 / S10、§14 末句的注）；本节；本文抬头 |
| 本行所在提交 | 鉴权门准入格的关注目标改回固定 id `'usr_follow_target'`（`e6d118f097` 曾把它改成带 stamp 的变量，连带改了一处断言字面量）：按精确 id 先删后播、格末与清扫再删，断言回到原样；本节 §S9.3、§S9.4、§S9.6 与设计 §4.6 的一句相应改写 |

第一个提交把代码与它要求的种子放在一起，使每个提交上 lane 都是绿的：只上代码、不补种子时 lane 有 75 格红（§S9.3）。

本地一次性库只用名字以 `m4s9_` 开头的库（按 `left(datname, 5) = 'm4s9_'` 认）：`m4s9_lane`（基线、不补种子的一遍、开发、全部变异）与 `m4s9_final`（代码最终 head `e619fb60d4` 上从空库全量迁移 426 条；最终 lane × 3、鉴权门 × 2）。删库记录见 §S9.4 末。`node_modules` 仍是指向规范检出的符号链接，没有改动、没有跑 `pnpm install`。脚本、变异定义与逐个日志在私有工件目录。

### S9.1 交付内容

| 文件 | 改动 |
|---|---|
| `src/services/task-records.ts` | `createTask`：事务内、取结构锁之后、读创建人缺省提醒策略与第一条 `INSERT` 之前，`assertActiveOrgMembers(db, orgId, assignees 去掉创建人)`；列表为空时 helper 不发查询，所以省略 `assignees`、只写创建人或 `[]` 的创建都不查。事务里多一个 `Db` 适配，`loadRemindPolicy` 改用同一个（原来是一个内联适配，行为不变）。 |
| `src/services/task-structure.ts` | `addAssignee`、`addFollower`：在任务 C 纯函数「事件非空」的分支里、`INSERT` 之前，`if (userId !== input.actorId) assertActiveOrgMembers(db, orgId, [userId])`。 |
| `src/services/task-org-members.ts` | 只改模块注释：五个调用点、R17 / N2 的裁定日期、成员行不随离职清理。查询与 422 都没变。 |
| `tests/helpers/task-m4-fixtures.ts` | `orgMemberSeeds()`：`seed(orgId, userIds)` 走 `seedOrgMembers`，同一份记录里已经播过的 id 只补 `user_orgs` 行；`drop()` 删掉记下的 id 的 `user_orgs` 与 `users` 行并清空记录（一个文件里几个 `afterAll` 都可以调）。 |
| 既有真库文件、鉴权门 | 种子与两格改用 SQL，见 §S9.3 |
| `tests/integration/task-m4-org-members.db.test.ts`（新） | §S9.2。登记三处：`vitest.config.ts` 的 exclude 字面量、`tasks-realdb.yml` 的清单、文件顶部的 `assert-rbac-optional-off`（三集合枚举 4 格绿） |
| `tests/unit/task-records-guards.test.ts` | `[own-53]` 一组的 `respondWith` 多回答在职查询（`active`），创建人加 `usr-2`、负责人加 `usr-3` 两处给了在职名单，期望不变。新 describe「task org membership (M4 PR-3a S9)」6 格：创建只查一次、只带创建人以外的 id、在锁之后与第一条 `INSERT` 之前，否定答案 422 零写入，查询文本含登录判据的五个片段；只有创建人、`[]`、重复的创建人都不查；两个 M3 写入点的查询在成员行之后、`INSERT` 之前，否定答案 422 零写入；重复添加、调用者写自己、满员、坏 id、没有直接角色，都不查。61 → 67 格 |
| `vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 各加一行新文件 |

**两个 M3 写入点的判定顺序**（锁后）：缺 org 422（路由）→ 任务 id 不可存 ⇒ 404 → 取任务 ⇒ 404 → 直接角色（`loadMembersForChange`）⇒ 404 → 成员 id ⇒ 422 `INVALID_ASSIGNEES` → 任务 C 纯函数（已是成员 ⇒ 空操作；满员 ⇒ 422 `LIMIT`）→ 新增且不是调用者本人 ⇒ 在职查询，否定 ⇒ 422 `INACTIVE_ORG_MEMBER` → 写行与事件。创建：标题、模式、负责人 id 的形状与 `LIMIT`、日期在开事务之前（不变）→ 读写锁 → 在职查询（创建人以外的 id）→ 缺省提醒策略 → 三条 `INSERT`。

**写入新用户的点的普查**（`git grep`，排除测试、迁移与文档）：`INSERT INTO task_assignees` 两处（`createTask`、`addAssignee`）、`INSERT INTO task_followers` 一处（`addFollower`）、`INSERT INTO task_list_members` 两处（建清单时调用者自己的所有者行——那就是操作者本人；`addTaskListMember`——S6 已查）、`UPDATE task_list_members SET role = 'owner'` 一处（转让，S6 已查）。其余 `UPDATE task_assignees` / `UPDATE task_list_members` 只改既有行的完成时刻或角色，不写入新用户。所以写入别人的点现在都过同一个 helper。

`ASSUMPTION(task-m4)` 标签：本片的新注释用 `[R17] [N2]` 并注明「ruled 2026-10-07」，另有 `[own-16]`、`[own-53]`；S6 的两处调用点与其余 R02–R23 标签的统一改记仍归 S10。

### S9.2 `task-m4-org-members.db.test.ts`

org 前缀 `org_tasks_m4orgm_`（与既有前缀互不为前缀）。调用者用 `seedTaskActor`，被写入的人用 `seedOrgMembers`，`afterAll` 用 `dropTaskM4Fixtures`。HTTP 经本文件的一个监听，全部用 `rawRequest`，拿原样响应体做逐字节比较。只需要存在的任务经服务函数建；清单、清单成员与满员的成员行用 SQL 播种。「零写入」比较整个 org 的任务行、负责人行、关注人行与事件行（`orgState`）。

「不查在职」在库里观测，不从结果推断：`readsUserOrgs(start)` 在本文件自己的连接上开事务并 `LOCK TABLE user_orgs IN ACCESS EXCLUSIVE MODE`，再发请求。查 `user_orgs` 的语句会排在这把锁后面，本库的 `pg_locks` 里于是出现一条未授予的 `user_orgs` 关系锁，观测器记 `read = true`、提交放行；不查的请求在锁还持有时就已完成，记 `read = false`。lane 的文件串行跑（`fileParallelism: false`），token 信任下的鉴权一步也不读 `user_orgs`，所以那段时间没有别人碰这张表。三格在职正控断言 `read = true`，就是这台观测器的正控（S17 只靠它变红）。

| 组 | 格数 | 内容 |
|---|---|---|
| 写入点 × 原因 | 12 | 创建（`assignees: [创建人, 目标]`）、增负责人、增关注人 × 四种不在职：只在别的 org 在职（只有 `uo.org_id` 拦得住）、org 关系停用（`user_orgs.is_active = false`，用户在职）、用户停用（`users.is_active = false`，org 关系在职）、查无此人（两张表都没有行）。各 422，响应体逐字节等于 `{"error":{"code":"INACTIVE_ORG_MEMBER"}}`，org 状态不变。一格只差一列，所以判据的每一列各自只让本原因的三格变红（S04–S06） |
| 在职正控 | 3 | 同 org 在职的目标在三个写入点各被写入，`read = true`；负责人行或关注人行与事件（`actor_id`、`payload.targetUserId`）落库 |
| 422 逐字节相同 | 1 | 每个写入点四种原因的响应体相同，三个写入点之间也相同，只有 `error.code` |
| 混合列表 | 1 | 创建时 `[在职, 停用]`（停用在后、不含创建人）⇒ 422、不建任务；去掉停用的那个再建 ⇒ 200 |
| 完成态任务 | 1 | `all` 模式已完成的任务加停用负责人 ⇒ 422，任务仍是 `done`、版本不变（纯函数会把它翻回 `open`，那一步没有落库） |
| 操作者豁免 | 1 | 自身 org 关系停用的调用者（lane 的配置下）：三种只写自己的创建、在自己的任务上自加负责人、自加关注人，都 200 且 `read = false` |
| 只豁免操作者 | 1 | 创建人的 org 关系停用后，负责人把创建人写成负责人、写成关注人 ⇒ 各 422，零写入 |
| 只有创建人的创建 | 1 | 省略 `assignees`、`[创建人]`、`[]` ⇒ 200、`read = false`；同格再建一个多写一位在职成员的任务 ⇒ `read = true` |
| 重复添加 | 2 | 负责人 / 关注人加入后离开 org（`user_orgs.is_active = false`）：再加一次 ⇒ 200，响应体与第一次逐字节相同，`read = false`，org 状态不变，成员行还在 |
| 只有清单身份 | 2 | 只有清单 `edit` 身份的成员对负责人 / 关注人路由写停用目标与在职目标 ⇒ 都是与缺失任务 id 逐字节相同的 404，`read = false`，零写入；同一人取详情 200、`canManageMembers` 为假 |
| 顺序 | 2 | 坏 id `..` ⇒ 422 `INVALID_ASSIGNEES`、`read = false`；用 SQL 把负责人 / 关注人填到 50 再加一个查无此人的 id ⇒ 422 `LIMIT`、`read = false`、零写入 |

静态展开数：12 + 3 + 1 + 1 + 1 + 1 + 1 + 1 + 2 + 2 + 2 = **27**；§S9.4 的三遍 lane 都收集并通过 27（门 17 ②）。

### S9.3 补种子：不补种子的一遍与逐格处置

只上代码、不动任何夹具时，`m4s9_lane` 上 lane 15 文件 **75 failed | 581 passed (656)**，鉴权门 **5 failed | 19 passed (24)**；同一库上改代码之前的基线是 656 / 656 与 24 / 24。这 80 格就是要补的人口（设计 §4.6 起草时按 `createTask(` 调用数估的规模多数是创建人自己，`task-m3-tree` 一格也不要）。每格只播它写入的、不是写入者本人的 id，播在第一次写入它之前：

| 文件 | 红格 | 处置 |
|---|---|---|
| `task-p0a` | 6 | 把 `userB` 写成负责人的六格各播 `userB` |
| `task-read-path` | 25 | 门 4 两格播 `[me, other]`，待办拆分与门 5 两格播 `[me]`；门 19 网格的格体里加一行「负责人里除创建人以外的 id 才播」：21 格因此播了 1 个 id，另 28 格这一行什么也不播 |
| `task-completion-grid` | 2 | `all × n`、`any × n` 播 `[a, b]` |
| `task-rbac-trust` | 5 | 三处 `other` 用 `seedOrgMembers`（id 带本文件的 stamp，由既有清扫删除）；在 org `'default'` 种诱饵任务的一格见下 |
| `task-m3-membership` | 27 | 门 3 七格、切模式两格、关注人三格、事件一格、详情一格各播被写入的 `userB` / `userC` / 关注人；锁格六格播 `userB`，其中加负责人、加关注人两格另播 `userC`（用例多一个 `addsC` 标记）；行级 404 两格只在创建人的 200 正控之前播目标，于是前面陌生人与关注人的 404 是在目标不在职时得到的；255 字符 id 三格与 50 人上限一格在生成 id 之后播 |
| `task-m3-comments-deletion` | 6 | 各播 `userB` |
| `task-m4-list-roles` | 2 | `gate19m4\|creator+list-editor\|delegated` 与 `\|any_role`：只在另有负责人时播 `other` |
| `task-m4-paging-settings` | 1 | 混合 org 格播 `usrO_mix_*` |
| `task-m4-dates` | 1 | `cnoflip` 格播 `usrO_cnoflip_*` |
| 鉴权门 | 5 | 门 1 无 claim 格（200 循环）与门 2 / 16 的增负责人、增关注人两格：`M3_TARGET` 在共享 `beforeAll` 里播进本文件的 org；准入格：关注目标在 200 之前播；x-tenant-id 格见下 |

M2/M3 里只清任务行的五个文件（p0a、read-path、completion-grid、m3-membership、m3-comments-deletion）用 `orgMemberSeeds()`，`afterAll` 里 `drop()`；`task-rbac-trust` 与鉴权门的种子 id 都带本文件的 stamp，由各自既有的清扫删除；三个 M4 文件记进各自的 `seededUsers`，由 `dropTaskM4Fixtures` 删除。补种子后的一遍 lane 之后查过 `m4s9_lane`：`@tasks-m4.test` 的用户、三个带 stamp 的目标前缀、没有 `users` 行的 `user_orgs` 行、`tasks` 都是 0。

**本意就是「被写入的人不在职」的两格**：不补种子，改用 SQL 写那一行负责人，期望一个没改。

- 鉴权门 `gate 1: an x-tenant-id header cannot supply the org when the token has no tenant claim`：`bare` 刻意没有 `user_orgs` 行（前置 b 刻意取反），而 `POST /api/tasks` 只把本 org 在职成员写成负责人：任务只带共享夹具用户，`bare` 的负责人行与它的关注人、评论行一样用 SQL 写。
- `task-rbac-trust` `pending routes degrade when the tenant is missing and do not read org default`：诱饵任务在 org `'default'`，负责人是只属于本文件 org 的调用者；任务行仍经 `createTask`（`assignees: []`），负责人行用 SQL 写。

**固定 id**（种子落 `users` 表，固定 id 在一次被中途杀掉的运行之后会留下撞主键的行）：只出现在路径与请求体里的两个改成带 stamp——鉴权门的 `M3_TARGET` 与 `task-m3-membership` 行级 404 一组的目标（`ROW_TARGET`）。鉴权门准入格的关注目标出现在断言里，保留固定 id `'usr_follow_target'`：该格在播种之前按精确 id 删掉可能残留的 `user_orgs` / `users` 行，格末与 `afterAll` 清扫各按精确 id 再删一次（本节抬头提交表的最后一行）。所以没有任何既有断言改动；动到的只是夹具：两个带 stamp 的 id、`[own-53]` 单测 mock 的 `active` 名单、`task-m3-membership` 用例表的 `addsTarget` / `addsC` 标记、两格改用 SQL 写的负责人行。

### S9.4 命令与结果

所有命令在 `packages/core-backend` 下（ops 测试在仓库根），`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<库> EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`；迁移 `MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项。tsc、单测、lane 与变异都在 `e619fb60d4` 上跑；其后的 `f4a0eb532c` 只改两份文档（读设计文档的 `task-gate19-identities` 只读 `i-m4` 块，本片没有改它），提交表最后一行的提交只改鉴权门文件与文档，鉴权门在它上面另跑了两遍（下表）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .`，退出码取 `$?` | 0，没有输出 |
| 改动的测试文件的类型 | 临时 tsconfig（同 §S7.4 的配置，`include` 列本片改过的十个真库文件、鉴权门、两个 helper 与 `task-records-guards`），放在工件目录 | 这 14 个文件与本片改动的三个 `src` 文件 0 条诊断；另有 47 条都在本片没有改的 `src` 文件里（34 条 TS2339、11 条 TS6133、2 条 TS6196），与 §S6.3、§S7.4、§S8.5、§S67F.3 相同 |
| 任务单测子集 | `vitest run tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts`（29 个文件） | 29 files / **1158 passed**（§S67F.3 的 1152 加本片 6） |
| 三集合枚举、门 20、`i-m4` | `vitest run tests/unit/task-ci-coverage-enumeration.test.ts tests/unit/task-pure-no-io.test.ts tests/unit/task-gate19-identities.test.ts` | 3 files / 18 passed |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 5 failed \| 1078 passed \| 172 skipped (1255)；Tests 44 failed \| 18687 passed \| 1712 skipped (20443)**，135 秒。对账：§S67F.3 的 20437 加本片 6 = 20443；passed 18681 加 6 = 18687。失败的 5 个文件正是已知的那 5 个：`multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup`（`RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED` / `RECOVERY_LOCAL_CUSTODY_STORE_REFUSED`）与 `attendance-admin-plugin-lib-dist-layout-boot`（`ELOOP: too many symbolic links encountered`），原因同 §S5.4、§S6.3、§S8.5、§S67F.3 |
| 真库 lane × 3（16 文件，`m4s9_final`） | `vitest --config vitest.integration.config.ts run <tasks-realdb.yml 的 16 个文件> --reporter=verbose` | 三遍均 **16 passed；683 passed (683)**，63 / 86 / 61 秒，`socket hang up` / `ECONNRESET` 0 次。逐文件三遍相同：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m3-comments-deletion 33、m4-schema 59、m4-list-roles 50、m4-paging-settings 77、m4-dates 107、m4-lists 66、m4-list-members 40、m4-list-items 25、m4-groups 36、**m4-org-members 27**（656 加 27） |
| 鉴权门 × 2（`m4s9_final`） | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false` 由配置与 `setup.ts` 给） | 两遍 **24 passed (24)**；准入格改回固定 id 之后（提交表最后一行）在同一库上再跑两遍，仍是 24 passed (24)，跑完库里没有 `usr_follow_target` 的 `users` / `user_orgs` 行。鉴权门文件不是 `*.test.ts`，lane 与全量单测都不加载它，所以那次改动之后只需重跑鉴权门 |
| 开发库上的两遍 | 同上，`m4s9_lane` | 改代码前基线 656 / 656、24 / 24；只上代码 75 + 5 格红（§S9.3）；补种子后 656 / 656、24 / 24；加新文件后 683 / 683 |
| ops 脚本测试（仓库根） | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs`；`… global-history-flag-manifest.test.mjs`；`… staging-tasks-smoke.test.mjs` | 3/3；36/36；19/19 |
| 裁决包字面扫描 | 字面扫描器 v1（私有工件目录），扫本片改动的全部文件与两份文档 | 退出 0 |
| 本机路径、机器名、局域网地址 | 对 `git diff c8fdd07e2b` 的新增行查用户主目录前缀、用户名、私有工件目录前缀、系统临时目录前缀、机器名、三个私有网段前缀与部署主机地址 | 0 处（本行只写模式的名称，不写模式本身） |
| 变异 | §S9.5 | 26 / 26 变红 |

needle 复核（`e619fb60d4`）：任务域源码里 `pg_advisory_xact_lock(hashtext(` 仍是 3 处（门 7）；`task-access.ts`、`task-list-access.ts` 本片没有改动；没有新增 `Intl.DateTimeFormat` 调用点。

删库：两个库删除前查过 `tasks`、`task_lists`、`task_list_members`、`task_list_items`、`task_list_events`、`task_groups`、`task_group_items`、`task_user_settings` 与 `task_events` 里本片各文件前缀的行、`@tasks-m4.test` 的种子用户都是 0，然后按名字 `DROP DATABASE m4s9_lane`、`m4s9_final`（按 `left(datname, 5) = 'm4s9_'` 认，没有碰别的前缀的库）。

### S9.5 变异证明

做法同 §S67F.4，换成私有工件目录里的一个脚本：一个变异可以带几处编辑（「把查询挪到别处」要删一处、加一处）；断言每个 needle 恰一次 → 原字节存到工作树之外 → 写入变异 → 跑 → 写回原字节 → 对每个被改的文件 `cmp -s`。26 个全部逐字节还原；逐个串行，期间不跑别的 vitest 进程；跑完 `git status` 干净。全部在代码 head `e619fb60d4` 上跑，库是 `m4s9_lane`。DB = `task-m4-org-members`（27 格），UNIT = `task-records-guards`（67 格）。下表「失败」一栏是 DB / UNIT 的失败格数，只有失败格才算变红，没有一个是因为收集失败或进程崩溃。

| # | 变异（文件） | 失败 | 变红的格 |
|---|---|---|---|
| S01 | `createTask` 去掉在职查询（records） | 8/27；1/67 | 创建 × 四种原因、创建的在职正控（`read` 为假）、422 逐字节、混合列表、只有创建人的创建（同格的正控那一步）；创建的顺序单测 |
| S02 | `addAssignee` 去掉在职查询（structure） | 8/27；1/67 | 负责人 × 四种原因、负责人正控、422 逐字节、完成态任务、只豁免操作者；单测 |
| S03 | `addFollower` 去掉在职查询（structure） | 7/27；1/67 | 关注人 × 四种原因、关注人正控、422 逐字节、只豁免操作者；单测 |
| S04 | 查询不比 `uo.org_id`（helper，`$1` 改成 `$1::text IS NOT NULL`） | 4/27；1/67 | 三个写入点的「只在别的 org 在职」、422 逐字节；查询文本单测 |
| S05 | 查询去掉 `uo.is_active = true`（helper） | 7/27；2/67 | 三个写入点的 org 关系停用、422 逐字节、混合列表、完成态任务、只豁免操作者（这几格的停用都在 org 关系上）；查询文本单测与 S6 的加成员查询单测 |
| S06 | 查询去掉 `u.is_active = true`（helper） | 4/27；2/67 | 三个写入点的用户停用、422 逐字节；同上两格单测 |
| S07 | 创建时也查创建人（records） | 2/27；6/67 | 操作者豁免、只有创建人的创建；6 格单测（含 4 格既有的 `createTask` 单测：它们的 mock 不回答查询，创建人被判为不在职） |
| S08 | 调用者给自己加负责人也查（structure） | 1/27；1/67 | 操作者豁免；不查单测 |
| S09 | 调用者给自己加关注人也查（structure） | 1/27；1/67 | 操作者豁免；不查单测 |
| S10 | 名单里有创建人就整个不查（records，豁免放宽） | 7/27；1/67 | 创建 × 四种原因、创建正控、422 逐字节、只有创建人的创建（正控那一步）；单测 |
| S11 | `addAssignee` 也豁免任务创建人（structure，豁免放宽） | 1/27；— | 只豁免操作者 |
| S12 | `addFollower` 也豁免任务创建人（structure，豁免放宽） | 1/27；— | 只豁免操作者 |
| S13 | `addAssignee` 的查询挪到纯函数之前（structure） | 2/27；1/67 | 负责人重复添加（成了 422）、负责人顺序（满员成了 `INACTIVE_ORG_MEMBER`）；单测 |
| S14 | `addFollower` 的查询挪到纯函数之前（structure） | 2/27；1/67 | 关注人重复添加、关注人顺序；单测 |
| S15 | `addAssignee` 的查询在 `LIMIT` 之后、「事件非空」之外（structure） | 1/27；1/67 | 负责人重复添加；单测 |
| S16 | `addFollower` 同上（structure） | 1/27；1/67 | 关注人重复添加；单测 |
| S17 | helper 对空列表也发查询（helper） | 2/27；1/67 | 操作者豁免、只有创建人的创建（都只因 `read` 为真；HTTP 结果不变）；不查单测 |
| S18 | `createTask` 的查询挪到三条 `INSERT` 之后（records） | 0/27；1/67 | 只有单测：否定答案时事务里已写过三条 `INSERT` 再整体回滚，库里看不出来 |
| S19 | `createTask` 的查询挪到取结构锁之前（records） | 0/27；1/67 | 只有单测：单连接的格里看不出锁序 |
| S20 | `addAssignee` 的查询挪到直接角色判定之前（structure） | 3/27；3/67 | 只有清单身份（停用目标成了 422）、负责人重复添加、负责人顺序；`[own-53]` 单测与两格 S9 单测 |
| S21 | `addFollower` 同上（structure） | 3/27；2/67 | 只有清单身份、关注人重复添加、关注人顺序；两格单测 |
| S22 | `addAssignee` 的查询挪到成员 id 校验之前（structure） | 2/27；2/67 | 负责人重复添加、负责人顺序（`..` 成了 `INACTIVE_ORG_MEMBER`）；`[own-53]` 单测（创建人的坏 id）与 S9 单测 |
| S23 | 只在全部 id 都不在职时才 422（helper，`some` 改 `every`） | 1/27；1/67 | 混合列表；单测 |
| S24 | 创建只查第一个 id（records） | 1/27；1/67 | 混合列表；单测 |
| S25 | `addAssignee` 查调用者而不是目标（structure） | 7/27；2/67 | 负责人 × 四种原因、422 逐字节、完成态任务、只豁免操作者；两格单测 |
| S26 | `addFollower` 查调用者而不是目标（structure） | 6/27；2/67 | 关注人 × 四种原因、422 逐字节、只豁免操作者；两格单测 |

没有做、或判为等价的变异：查询去掉 `uo.user_id = ANY($2)`——结果多出本 org 其他在职成员，`active.has(userId)` 仍逐个判，等价；`JOIN users` 改 `LEFT JOIN` 而留着 `u.is_active = true`——空值不等于真，等价；S6 两个调用点的变异见 §S6.4（本片没有改它们）。S18 在库里不可观测，由单测的语句顺序钉住。S19（创建的查询挪到取结构锁之前）在库里可以观测：用 `whileStructureLockHeld` 让创建排在锁后、持锁方在提交前停用目标即可；闸修复补了这一格（`m4orgm|create|queued`，§S8–S10 闸修复），在此之前由单测的语句顺序钉住。脚本、定义、汇总与逐个日志都在私有工件目录（脚本读 `MUTANTS` / `RESULTS` / `LOGDIR` / `MUT_DB` / `ONLY` / `DRY`）。

### S9.6 与设计的偏差

1. **创建的查询排在读缺省提醒策略之前**：设计原文只写「取锁之后、`INSERT` 之前」，两者都满足；把可能失败的校验放在只读的策略读取之前。设计 §4.6 的表已写明。
2. **要补种子的人口与设计估的不同**：设计按 `createTask(` 调用数估（`task-m3-tree` 52 等），实际以不补种子的一遍为准：lane 75 格、鉴权门 5 格，`task-m3-tree` 0（§S9.3）。设计 §4.6 已改。
3. **两格改用 SQL 写负责人行而不是补种子**：本意就是被写入的人不在职（§S9.3）。
4. **两个固定目标 id 改成带 stamp**（`M3_TARGET`、`ROW_TARGET`，只在路径与请求体里）；鉴权门准入格的关注目标出现在断言里，保留固定 id，按精确 id 先删后播（§S9.3）。没有既有断言改动。
5. **共享 helper 多了 `orgMemberSeeds`**：设计原来只点名 `seedOrgMembers`；M2/M3 文件只清任务行，需要一份记录来删种子。设计 §10.1 已补。
6. **「不查在职」靠锁 `user_orgs` 观测**，不是在进程里拦截语句：这依赖 lane 串行跑文件与 token 信任下鉴权不读 `user_orgs`，两者都是现状（§S9.2）。
7. **操作者豁免的格跑在 lane 的配置下**（`RBAC_TOKEN_TRUST='true'`）；信任关闭的配置下没有这一格（§S9.7）。
8. **helper 的空列表捷径现在可达**：§S6.4 记为「没有调用方传空数组，不可达」；现在 `createTask` 会传空数组，S17 证明有格钉住它。
9. **`createTask` 的缺省提醒策略改用同一个 `Db` 适配**（原来是内联的一个），行为不变，S4 的单测照绿。

### S9.7 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17。
- CI 上的任何 lane（不推送）。门 17 ② 的收集数只在本地 verbose 日志里核对。
- 发送时的在职复核（R17 的另一半）：属 PR-3b。
- 信任关闭配置下的 S9 格：鉴权门本片只补了种子，没有为三个写入点加在职格；信任关闭时自身停用的调用者解析不出 org，豁免格在那里无从构造。
- M3 后端设计文档（契约）没有改：三条路由新增的 422 记在本件设计 §4.6 与本节 §S9.9。
- 前端：没有在浏览器里跑过；M3 前端的错误文案表没有这个码（§S9.9）。
- 本文件不含本机绝对路径（§S10.4）。
- 全量单测里 5 个与本片无关、因本机环境失败的文件：没有修。

### S9.8 给 S10 的交接

- 鉴权门的 `M3_TARGET` 现在带 stamp，并在共享 `beforeAll` 里播成本文件 org 的在职成员。S10 给 `M4_ROUTES` 加的 200 正控里凡是写入别人的（加清单成员、转让、`POST /api/tasks` 带负责人），目标同样要带 stamp 并 `seedOrgMembers`，否则正控得到 422 `INACTIVE_ORG_MEMBER`。
- R02–R23 的 `ASSUMPTION(task-m4)` 改记「已裁 2026-10-07」仍归 S10；本片新注释已写明裁定日期，S6 的调用点与其余标签没有改。
- §12-Q3 只剩本件自选的三处（码名、`[own-16]`、`[own-27]`），PR body 照此写。
- lane 16 文件 683 格，鉴权门 24 格，全量单测 20443 格（本机 5 个文件因环境失败）。
- 变异脚本（一个变异可带几处编辑）与定义在私有工件目录，`DRY=1` 只数 needle。

### S9.9 前端对接（三个写入点的 422）

- `POST /api/tasks`、`POST /api/tasks/:id/assignees`、`POST /api/tasks/:id/followers` 写入一个不是本 org 在职成员的用户时，回 422 `{ error: { code: 'INACTIVE_ORG_MEMBER' } }`：与加清单成员、转让所有者同一个码（§S6.8），不区分「查无此人 / 属于别的 org / org 关系停用 / 用户停用」，响应里没有用户 id。失败的创建不留下任何任务。
- 先后：没有直接角色或任务不存在是 404；坏的成员 id 是 422 `INVALID_ASSIGNEES`；满员是 422 `LIMIT`；这三种都先于在职判定。创建时标题、模式、负责人 id、`LIMIT`、日期的 422 都先于它。
- 调用者写自己永远不会被拒；再次添加已在名单里的人（包括已离开 org 的人）是 200 空操作，名单照旧显示他。
- 选人控件应只给出本 org 的在职成员。M3 前端的 `TasksView.vue` 用 `CODE_MESSAGES` 把码映射成文案，表里没有 `INACTIVE_ORG_MEMBER`，现在会落到通用的「操作失败」；按 R20 应由前端切片在 `labels.ts` 里加上这个码的文案。

## S10 鉴权门与收口

基于 `bd8a99276e`（S9 之后）。提交：

| 提交 | 内容 |
|---|---|
| `92a5c6695b` | 迁移改名（SCH-4）：迁移文件、形状测试的 import、manifest 的 `purpose` |
| `ca8f1efb5b` | 鉴权门：`P0A_ROUTES`、`M4_ROUTES`、路由人口格、门 1 与门 2 / 16 的 M4 格、`[own-53]` 的 trust-off 格；清单第二租户读格覆盖清单 id 之下的六个读；清扫补个人分组与设置行 |
| `865ffba88e` | 已裁条目的代码标签改记 `RULED(2026-10-07)` |
| `6425741b62` | 注释与测试名只陈述规则 |
| `6a8a8e029b` | 设计修订 6 |
| 本节所在提交 | 本节与文末总结；两份设计、本文件的公开文本整理 |

本地一次性库只用三个按全名认的库：`m4s10_lane`（开发、20 个变异、手工 `up → down → up`）、`m4s10_final`（最终 lane × 3 与鉴权门 × 2）、`m4s10_recov`（两个 recovery 守卫）。删库记录见 §S10.5 末。`node_modules` 仍是指向规范检出的符号链接，没有改动、没有跑 `pnpm install`。脚本、变异定义与逐个日志在私有工件目录。

### S10.1 鉴权门（`tests/tasks-auth/tasks-auth-gate.ts`）

| 组 | 格数 | 内容 |
|---|---|---|
| 既有格 | 24 | M2、M3 的门 1 / 2 / 16 格与 S5 的清单第二租户读格。后者现在对清单 id 之下的六个读（详情、`/events`、`/members`、`/items`、`/groups`、`/group-items`）各断言 LA 200、LB 与不存在的清单逐字节相同的 404 |
| 路由人口 | 1 | `tasksRouter().stack` 每一层都必须带一条路由，展开为「方法 + 路径」51 条；三张表（P0-A 8、`M3_ROUTES` 13、`M4_ROUTES` 30）合起来没有重复，并集与路由器逐项相等；同一格内逐个去掉 `M4_ROUTES` 的每一行，30 次比较都为假 |
| 门 1，每条 M4 路由 | 30 | 一个用户（两个码、admission、本 org 在职）三种 token：不带租户声明（并带指向本 org 的 `x-tenant-id` / `x-org-id` 头）、声明一个没有 `user_orgs` 行的 org、声明本 org。前两种都得到缺 org 的回答，逐字节比较：13 条写 422 `ORG_MISSING`；`GET /api/task-lists`、`/api/task-groups`、`/api/task-groups/items` 是不带 `total` 的降级体；其余 7 条读 404。本 org 的任务域行（任务、负责人、关注人、事件、清单、成员、清单项、清单事件、分组、分组项、设置）前后逐字节相同。第三种在本格先播种的行上 200 |
| 门 2 / 16，每条 M4 路由 | 30 | 无 admission 403；只有另一个码 403（体都是 `{ error: 'Insufficient permissions' }`）；对照用户在自己播种的行上 200。四个用户的授予在整组里固定 |
| `[own-53]` 的 trust-off 格 | 1 | 只有清单 `edit` 身份的成员对增删负责人、增删关注人四条写都得到与缺失任务逐字节相同的 404，org 的任务域行不变；同一人 PATCH 200；创建人四条写各 200 |

鉴权门 24 → **86** 格；静态展开数 13 + 30 + 30 + 13 = 86，两遍都收集并通过 86（门 17 ②）。`M4_ROUTES` 的 30 行按切片：`PATCH /api/tasks/:id`（S4）1、设置（S3）2、清单（S5）7、成员（S6）5、清单项（S7）3、分组（S8）12；路由人口格把它与路由器机械对齐。前置 a–i 逐条写在各组上方的注释里（门 1 的前两种 token 是 b 刻意取反）。`tasks-auth-ci-wiring`（ops 3/3、单测 2/2）照绿：单文件、无 `.skip(`、配置与 setup 的字面量不变。

### S10.2 迁移改名（SCH-4）

- 新名 `zzzz20261008090000_create_task_m4_tables`：排在 origin/main（`00aac5b7b4`）最新的 `zzzz20261001120000_create_approval_form_drafts` 之后；本地所有分支（含远端跟踪分支）的迁移目录里没有同一前缀，最接近的是另一条线未合并的 `zzzz20261007120000_…`。迁移正文不变，头注补一句排序依据。PR-3b 分支仍带旧名，随它下一次并入本分支时跟着改。（2026-10-09 起文件名为 `zzzz20261009130000_create_task_m4_tables`，见文末「2026-10-09 迁移重新定名与门 15」一节。）
- 旧名从未在任何共享环境应用过：staging 已应用的迁移里没有它，生产没有部署过这些提交。
- 跟着改的只有两处：形状测试的 import、manifest 的 `purpose`（manifest 测试按磁盘文件名核对，36/36）。`migration-timestamp-uniqueness.guard` 20/20，`migrations.rollback` 与 `migration-provider` 16/16，`tsc` 0。
- 一次性库 `m4s10_lane` 从空库全量迁移 426 条，本迁移最后执行。目录快照（八张表与 `tasks.remind_at`、`tasks_id_org_id_key` 的列、约束、索引，139 行）→ `migrate.ts --rollback` 回退的正是本迁移（台账 425 行，`to_regclass('task_lists')` 为空，`remind_at` 不存在）→ `migrate.ts` 只执行本迁移一条 → 快照与第一次 `cmp` 逐字节相同。
- 以新名复测设计 §9.2 的「删掉文件」情形：`MIGRATION_EXCLUDE` 加上本迁移名后，`migrate.ts` 与 `--rollback` 都退出 1，`corrupted migrations: previously executed migration zzzz20261008090000_create_task_m4_tables is missing`；`--list` 退出 0、`Pending: 0`；台账与表不受影响。（2026-10-09 以现名 `zzzz20261009130000_create_task_m4_tables` 再测，结果相同，见同一节。）
- `task-m4-schema` 的事务内 `down → up` 两格在三遍 lane 里都绿（59/59）。两个 recovery 守卫在 `m4s10_recov`（从空库全量迁移 426 条）上 14/14。

### S10.3 已裁条目的代码标签

- 规则（设计 §11）：2026-10-07 已裁的 R01–R23、N1、N2、`[own-25]`、`[own-53]` 在代码里写 `RULED(2026-10-07)`；未裁的 `[own-NN]`、`[Dx]`、`[dev-01]` 仍写 `ASSUMPTION(task-m4)`；任务 D 自己的 `ASSUMPTION(task-d)` 不动。
- 结果：`RULED(2026-10-07)` 94 行（37 个文件），`ASSUMPTION(task-m4)` 110 行（32 个文件）。同一段注释里两种标签都有时，两个标记并列，各管自己的标签。按注释段检查：没有一个 `ASSUMPTION(task-m4)` 段里带已裁的标签，也没有一个 `RULED` 段里带未裁的标签。这一步只改注释，取值一个没变。
- 没有测试断言 `ASSUMPTION(` 文本；`task-access.test.ts` 有一个测试名带 `ASSUMPTION(task-m4): [own-02]`，属未裁项，原样保留。

### S10.4 公开文本的整理

- 本文件早先各节里的本机路径（用户主目录下的私有工件目录、nvm 目录、系统临时目录下的 worktree）换成中性说明（「私有工件目录」「系统临时目录」「规范检出」）；三份文档里没有用户名、机器名、局域网地址。
- 文字只陈述规则：变异表的「变红的格」一栏只写格名；负控只写「判定变红」与它看的格；按条目 id 引用裁定，不引原话（2026-10-09 起只写条目 id 与日期）。
- 两个字面扫描器（v1 与 v2）对分支改动的全部文件都退出 0（§S10.5）。

### S10.5 命令与结果

所有命令在 `packages/core-backend` 下（ops 测试在仓库根），`PATH` 前置 Node 20.20.2。真库环境同 §S9.4。lane、鉴权门、recovery 守卫、全量单测与 ops 测试都在 `6425741b62` 上按顺序跑（一个脚本串行执行，期间没有别的 vitest 进程）；之后的提交只改文档，读设计文档的 `task-gate19-identities` 与鉴权门在最终 head 上另跑（表末两行）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | 0，没有输出 |
| 测试文件的类型 | 临时 tsconfig（同 §S7.4，`include` 列鉴权门、两个 helper、`task-m4-schema`），放在工件目录 | 这 4 个文件 0 条诊断；另 47 条都在本片没有改的 `src` 文件里，与 §S9.4 相同 |
| 任务单测子集 | `vitest run tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts` | 29 files / **1158 passed** |
| 守卫 | `vitest run` 门 20 harness（`task-pure-no-io`）、三集合枚举、`task-gate19-identities`、私有路径扫描、迁移前缀唯一、`migrations.rollback`、`tasks-auth-ci-wiring` | 7 files / 58 passed |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 5 failed \| 1078 passed \| 172 skipped (1255)；Tests 44 failed \| 18687 passed \| 1712 skipped (20443)**，122 秒；与 §S9.4 逐数相同。失败的是已知的 5 个文件（四个 recovery 存储文件：`RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED` / `RECOVERY_LOCAL_CUSTODY_STORE_REFUSED`；`attendance-admin-plugin-lib-dist-layout-boot`：`ELOOP`） |
| 迁移 | `m4s10_final` 从空库全量迁移 | 426 条，最后一条是本迁移 |
| 真库 lane × 3（16 文件，`m4s10_final`） | `vitest --config vitest.integration.config.ts run <tasks-realdb.yml 的 16 个文件> --reporter=verbose` | 三遍均 **16 passed；683 passed (683)**，53 / 52 / 51 秒，`socket hang up` / `ECONNRESET` 0 次。逐文件三遍相同，见总结表 |
| lane 之后的残留 | 八张 M4 表、`tasks`、`task_events` 与 `@tasks-m4.test` 的种子用户 | 全部 0 行 |
| 鉴权门 × 2（`m4s10_final`） | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false` 由配置与 `setup.ts` 给） | 两遍 **86 passed (86)**，各约 3 秒；之后鉴权门的用户、`user_orgs`、任务、清单、个人分组、设置都是 0 行 |
| recovery 守卫（`m4s10_recov`） | `recovery-schema-drift`、`recovery-authority-search-path` | 2 files / 14 passed |
| ops 脚本测试（仓库根） | `node --test` 五个文件：`tasks-auth-ci-wiring`、`global-history-flag-manifest`、`multitable-global-history-flag-status`、`staging-tasks-smoke`、`attendance-window-runner-pipeline` | 3/3；36/36；21/21；19/19；178/178 |
| 裁决包字面扫描 | 字面扫描器 v1 与 v2（私有工件目录），参数是 `git diff --name-only origin/main...HEAD` 的全部文件（70 个）；另扫 PR body 与 squash 提交信息的草稿；同一个 v2 扫描器另换一份私有参照，扫同一批文件 | 都退出 0 |
| 本机路径、机器名、局域网地址 | 对 `git diff origin/main...HEAD` 的新增行查用户主目录前缀、用户名、私有工件目录前缀、系统临时目录前缀、机器名、三个私有网段与部署主机地址 | 0 处（本行只写模式的名称） |
| 最终 head 上另跑（`accda4af0c`；之后的提交只改文档，读设计文档的 `task-gate19-identities` 在最后一次改设计之后又跑一遍，9/9） | `tsc`；任务单测子集与守卫（读设计文档的 `task-gate19-identities` 在内）；鉴权门 × 2（`m4s10_final`）；`tasks-auth-ci-wiring` 与 flag manifest 的 `node --test` | 0；29 files / 1158 passed 与 7 files / 58 passed；两遍 86 passed (86)；3/3 与 36/36 |
| 变异 | §S10.6 | 20 / 20 变红 |

删库：三个库删除前查过八张 M4 表、`tasks`、`task_events` 里的行、`@tasks-m4.test` 的种子用户与鉴权门的用户都是 0（`m4s10_recov` 只跑 recovery 守卫，不写任务表），然后按全名 `DROP DATABASE m4s10_lane`、`m4s10_final`、`m4s10_recov`，没有碰别的库。

### S10.6 变异证明

做法同 §S9.5（私有工件目录里的脚本）：断言每个 needle 恰一次 → 原字节存到工作树之外 → 写入变异 → 跑鉴权门（trust-off 配置，`m4s10_lane`）→ 写回原字节 → `cmp -s`。20 个全部逐字节还原；逐个串行；跑完 `git status` 干净。代码 head `ca8f1efb5b`。G01 后来又被重跑过一次，结果相同（同样两格变红），源码同样逐字节还原。下表「失败」是鉴权门的失败格数（基线 86/86），没有一个是因为收集失败或进程崩溃。

| # | 变异（文件） | 失败 | 变红的格 |
|---|---|---|---|
| G01 | `GET /api/task-lists/:id/members` 要 `tasks:write`（`tasks-lists.ts`） | 2/86 | 该路由的门 2 / 16 格；清单第二租户读格（只带 `tasks:read` 的用户读名单那一步） |
| G02 | `POST /api/task-groups` 要 `tasks:read`（`tasks-lists.ts`） | 1/86 | 该路由的门 2 / 16 格 |
| G03 | `PATCH /api/task-settings` 要 `tasks:read`（`tasks-settings.ts`） | 1/86 | 同上 |
| G04 | `PATCH /api/tasks/:id` 要 `tasks:read`（`tasks.ts`） | 1/86 | 同上 |
| G05 | `PUT …/group-items/:taskId` 缺 org 回 404（`tasks-lists.ts`） | 1/86 | 该路由的门 1 格 |
| G06 | `GET /api/task-groups/items` 缺 org 回 404（`tasks-lists.ts`） | 1/86 | 同上 |
| G07 | `GET /api/task-settings` 缺 org 回降级体（`tasks-settings.ts`） | 1/86 | 同上 |
| G08 | `GET /api/task-lists` 的降级体多一个 `total: 0`（`tasks-lists.ts`） | 1/86 | 同上（逐字节比较） |
| G09 | 工厂的 router 上多注册一条路由（`tasks-lists.ts`） | 1/86 | 路由人口格 |
| G10 | `registerTaskSettingsRoutes(router)` 注释掉（`tasks.ts`） | 5/86 | 路由人口格；两条设置路由的门 1、门 2 / 16 格 |
| G11 | `GET /api/task-groups` 改挂在一个嵌套的 router 上（`tasks-lists.ts`） | 1/86 | 路由人口格（嵌套的一层不带路由） |
| G12 | `POST …/transfer-owner` 要 `tasks:admin`（`tasks-lists.ts`） | 2/86 | 该路由的门 2 / 16 格与门 1 格（两者的 200 正控） |
| G13 | `loadMembersForChange` 不拒绝（`task-structure.ts`） | 1/86 | `[own-53]` 的 trust-off 格 |
| G14 | `canChangeTaskMembers` 恒真（`task-access.ts`） | 1/86 | 同上 |
| G15 | `M4_ROUTES` 少一行（测试表，`DELETE /api/task-groups/:groupId`） | 1/84 | 路由人口格（其余格少了这条路由的两格） |
| G16 | `GET /api/task-lists/:id/events` 不挂 `authenticate`（`tasks-lists.ts`） | 3/86 | 该路由的门 1、门 2 / 16 格；清单第二租户读格 |
| G17 | `PATCH /api/tasks/:id` 缺 org 回 404（`tasks.ts`） | 1/86 | 该路由的门 1 格 |
| G18 | `GET /api/task-lists/:id` 缺 org 回降级体（`tasks-lists.ts`） | 1/86 | 同上 |
| G19 | token 没有租户声明时由租户头给出 org（`jwt-middleware.ts`） | 31/86 | 30 格门 1 的 M4 格；M2 的「租户头不能提供 org」格 |
| G20 | 租户声明不经 `user_orgs` 核对就采信（`AuthService.ts`） | 25/86 | 24 格门 1 的 M4 格；M2 的「租户声明是别的 org 的写 422」格 |

G20 下另 6 格门 1 的 M4 格仍绿：清单 id 之下的 6 条读在一个没有该清单的 org 里本来就是 404，与缺 org 的回答相同；这 6 格不带租户声明的那一半由 G19 证红。

### S10.7 与设计的偏差

1. **`[own-53]` 的 trust-off 格是额外的**：设计 §10.7 的表没有它。增删负责人与关注人的规则在 S6+S7 闸修复里改过，realdb 的格都跑在 token 信任下，这一格在 trust-off 下核对同一条规则。
2. **门 1 的 M4 格每条路由一格**（30 格），不是 M3 那样一格里循环：每格自己播种、比较 org 状态、跑 200 正控，失败时直接点名路由。三种 token 合在同一格里。
3. **迁移改名没有并入 main**：设计 §2.1 原写「S10 并入当时的 main 时改名」。本片没有并入 main（不改变本分支的基），前缀按 origin/main 当时的最大前缀取，合并前要再核一次。
4. **`[Dx]` 仍标 `ASSUMPTION(task-m4)`**：它们是裁决包列出的缺省实现约束，包内写明不需要裁、owner 可以点名推翻（设计 §11 表头）。
5. **改了任务 D 的文件**：注释与设计文档的文字（取值不变）。
6. **清扫多删两类行**：鉴权门的 `afterAll` 现在也按 org 前缀删个人分组与设置行（M4 格会写它们）。

### S10.8 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17；形状 pin 与新约束的规范化文本只在 15.17 上核过。
- CI 上的任何 lane（不推送）：`tasks-realdb`、`plugin-tests`（含鉴权门步骤、manifest、三集合枚举、门 20 harness）、`web-tests`、contracts、`migration-replay`、`migration-prod-image-parity`、`recovery-schema-drift`。门 17 ② 的收集数只在本地 verbose 日志里核对。
- staging 与生产：没有部署，DDL 没有应用到任何共享库；设计 §9.2 的过渡态只来自读 runner 源码与本地复现。
- 前端：没有在浏览器里跑过任何东西。
- PR-3b 的内容：outbox producer、调度与投递、钉钉通道、三个 P1 flag、N1、发送时的在职复核。
- 锁的改动：R01 的新行（另一个只改锁的 Draft PR）与 `i-m4` 块（设计 §12-Q1）。
- 门 18 / 21 / 22 的 M4 子集行（PR-3b、前端）；M2 / M3 全部门行在 M4 最终 head 上的回归按设计 §10.9 记在 PR-3c。
- 全量单测里 5 个与本片无关、因本机环境失败的文件：没有修。

## S8–S10 闸修复（S8–S10 增量闸审）

基于 `d940fa8745`。闸审 3 条 P2 与 14 条 P3 / NIT，全部按属实处理；下表按处置列出，未改的 P3 在 §S8S10F.5 各附一句理由。提交：

| 提交 | 内容 |
|---|---|
| `3765da5c48` | 鉴权门：门 1 的 M4 格与 M2 的跨 org 写格加「声明一个本用户 `user_orgs` 行停用的 org」的 token |
| `9e74f956c1` | 创建任务：停用目标是唯一或第一个负责人的真库格；创建人不在首位的单测格 |
| `ebef46a383` | R17 的在职查询与登录同判据（会话 org 加账号闸）；新格 |
| `64412e8b75` | 鉴权门：路由人口格把 M3 / M4 每一行经分派绑定到它的标签；门 2 / 16 加只带 `tasks:admin` 的用户 |
| `f06666d2d2` | 分组：已归档清单上的六条清单分组路由；个人分组读超过 `limit` 的分页（真库与单测） |
| `02557adc2d` | 创建任务排在结构锁后、持锁方停用目标的真库格 |
| `8f7ce33937` | 测试注释只写「路径字节须原样到达服务端」的规则；`addTaskToList` 注释只写判定顺序 |
| `77d5486966` | 任务 D 的注释只写规则与条目 id，模块抬头记 2026-10-07 的裁定（只改注释） |
| `e73aaf6de6` | 删组只写 `group_deleted`：设计写明，`groups|delete` 钉住 |
| `2595c60b64` | 设计修订 7；任务 D 两份文档与本文件只写现行规则与条目 id |
| `3c69bdbe13` | 任务 D 两处注释改为按节号引用设计锁，不再引锁的原句（只改注释） |
| 本节所在提交 | 本节与文末总结 |

本地一次性库只用三个按全名认的库：`p3gf3_dev`（开发与全部变异）、`p3gf3_final`（`2595c60b64` 上从空库全量迁移 426 条；lane × 3 与鉴权门 × 2）、`p3gf3_final2`（最终代码 head `3c69bdbe13` 上从空库全量迁移 426 条；lane × 3 与鉴权门 × 2）。删库记录见 §S8S10F.3 末。`node_modules` 仍是指向规范检出的符号链接，没有改动、没有跑 `pnpm install`。脚本、变异定义与逐个日志在私有工件目录。

### S8S10F.1 逐条处置

| 条目 | 级别 | 处置 | 位置 |
|---|---|---|---|
| 鉴权门没有「租户声明指向关系已停用的 org」的 token | P2 | 已改：门 1 的 30 格各加这一种 token，回答与缺 org 的回答逐字节相同，该 org 的任务域行不变；M2 的跨 org 写格同样加（`POST /api/tasks` 与一条 M3 写，按文本比较）。格数仍 86 | `tasks-auth-gate.ts`；设计 §10.7 闸修复记录 |
| 创建任务时停用用户是唯一或第一个负责人，没有格 | P2 | 已改：新 `it.each`（四种原因 × 「唯一」「排在创建人之前」共 8 格），422 逐字节、零写入；单测把创建人放在第二位、不放、放中间，断言查询参数恰为其余 id | `task-m4-org-members`；`task-records-guards.test.ts` |
| 分支改动文件里的注释与文档要只写规则 | P2 | 已改：任务 D 的注释写成英文的「规则 + 条目 id」，任务 D 两份文档与本 PR 两份文档同样只写规则与条目 id；三个字面扫描器零命中（§S8S10F.3） | 任务 D 七个模块、`task-ids.ts`、`task-dates.ts`、`task-ids.test.ts`；四份文档 |
| R17 的判据窄于登录 | P3 | 已改：查询加账号闸（`activation_status = 'activated'`，角色不是 `disabled`，持 RBAC `admin` 角色按 `admin` 看），与登录逐条等价（设计 §4.6）；对拍格把八种账号形状交给 `AuthService.verifyToken` 与本查询，两边结论相同 | `task-org-members.ts`；`task-m4-org-members`、`task-m4-list-members` |
| 删组是否写 `group_changed` 未写明 | P3 | 已写明：删组只写 `group_deleted`，消费方把指向已删分组的 `toGroupId` 读作默认组；`groups|delete` 断言回到默认组的任务没有新的 `group_changed` | 设计 §3.5、§11 `[own-50]`；`task-m4-groups` |
| S19 在库里可观测 | NIT | 已改：§S9.5 的说法订正；补 `m4orgm|create|queued` 格（停用发生在创建排队等锁时 ⇒ 422，重新启用 ⇒ 200） | 本文件 §S9.5；`task-m4-org-members` |
| 路由人口格只比标签 | P3 | 已改：每一行的方法与带占位 id 的路径按 Express 的分派规则解析，命中的那一层的「方法 + 路径」必须等于标签；替换同格原来逐行去掉再比的负控（M3 行一并覆盖） | `tasks-auth-gate.ts`；设计 §10.7 |
| R18 没有只带 `tasks:admin` 的反例 | P3 | 已改：门 2 / 16 加第五个用户，每条 M4 路由 403 | 同上 |
| 已归档清单上的分组路由没有格 | P3 | 已改：`groups|archived` 在未归档与已归档两张同形清单上跑同一串分组读写，逐项相同，清单行的 `archived_at`、`updated_at` 不变 | `task-m4-groups` |
| 个人分组读的 `limit` 没在多于上限的数据上测 | P3 | 已改：三组时 `limit=1` 逐页、`limit=2` 两页；单测同形 | `task-m4-groups`；`task-records-guards.test.ts` |
| 测试注释写了路径段的处理机制 | P3 | 已改：只写「路径字节须原样到达服务端的请求经 `rawRequest`」；两个格名改为「malformed path ids」 | 三个真库文件、`tasks-http-harness.ts`；本文件的对应描述 |
| 文档写了增删负责人与关注人在本分支早先的规则 | P3 | 已改：§S2.2、§S2.7-5、§S67F.2、§S67F.5 与设计 §6.3、§10.4、§10.12 只写现行规则；`addTaskToList` 的注释只写判定顺序 | 本文件；设计；`task-list-records.ts` |
| 设计 §12-Q15 | P3 | 已改：只问 #6186 的处置 | 设计 §12-Q15 |
| 私有工件名与本地环境的叙述；过期的裁定状态 | NIT | 已改：工件名换成「私有工件目录」，删去临时目录清理、限流与负载的叙述；任务 D 两份文档与设计 §14 AZ-2 记 2026-10-07 的裁定 | 本文件；任务 D 两份文档；设计 §14 |
| 两条「早先各节有本机路径」的 NOT RUN 过期 | P3 | 已改：两条改为「本文件不含本机绝对路径」 | 本文件 §S67F.6、§S9.7 |
| P0-A 八条路由里六条没有门 2 / 16 的格 | P3 | 未改，见 §S8S10F.5 | — |

### S8S10F.2 格数变化

| 文件 | 之前 | 之后 | 新增 |
|---|---|---|---|
| `task-m4-org-members` | 27 | 46 | 唯一 / 第一个负责人 8；账号闸 9（3 写入点 × 「角色 disabled」「待激活」「disabled 且持 admin 角色」）；对拍 1；排队创建 1 |
| `task-m4-list-members` | 40 | 44 | 加成员两种账号闸原因 2；转让两种 2 |
| `task-m4-groups` | 36 | 38 | `groups|archived` 1；`groups|personal paging` 1；`groups|delete` 多一组断言（格数不变） |
| `tasks-realdb` 16 个文件合计 | 683 | 708 | — |
| 鉴权门 | 86 | 86 | 断言加在既有格里：门 1 的 30 格、M2 跨 org 写格、人口格、门 2 / 16 的 30 格 |
| `task-records-guards.test.ts` | 67 | 69 | 创建人位置 1；个人分组分页 1 |

静态展开数：`task-m4-org-members` 是 `it.each` 的 3 × 4、3、4 × 2、3 × 3 加 2 + 2 + 2 与 12 个普通 `it`，共 46；`task-m4-list-members` 的两张表各多 2 行。

### S8S10F.3 命令与结果

所有命令在 `packages/core-backend` 下（ops 测试在仓库根），`PATH` 前置 Node 20.20.2。真库环境：`DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<库> EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`；迁移 `MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项。tsc、任务单测子集与 lane、鉴权门在最终代码 head `3c69bdbe13` 上跑；全量单测、守卫、测试文件的类型与变异在 `2595c60b64` 上跑（`3c69bdbe13` 只改两行注释）；本节所在提交只改本文件。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .`；`./node_modules/.bin/tsc -p scripts/tsconfig.recovery-archive-acceptance.json` | 都是 0，没有输出 |
| 改动的测试文件的类型 | 临时 tsconfig（`extends` 本包配置，`module: esnext`、`moduleResolution: bundler`、`noUnusedLocals`、`types: ["node"]`，`include` 列本节改过的 8 个测试与 helper 文件），放在私有工件目录 | 55 条诊断，与 `d940fa8745` 上同一配置、同一批文件的诊断逐条相同（47 条在本 PR 没有改的 `src` 文件里，8 条在三个真库文件里本节没有改的行上：`whileStructureLockHeld` 的结果在这套配置下推断成 `unknown`）；本节新增 0 条 |
| 任务单测子集 | `vitest run tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts` | 29 files / **1160 passed** |
| 守卫 | `vitest run tests/unit/tasks-auth-ci-wiring.test.ts tests/unit/task-ci-coverage-enumeration.test.ts tests/unit/approval-a3-dangling-reviews-path-sweep.test.ts`；仓库根 `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs` | 3 files / 14 passed；3/3 |
| 全量单测 | `env -u DATABASE_URL CI=true ./node_modules/.bin/vitest run --config vitest.config.ts` | **Test Files 5 failed \| 1078 passed \| 172 skipped (1255)；Tests 44 failed \| 18689 passed \| 1712 skipped (20445)**，128 秒。失败的是已知的 5 个文件（四个 recovery 存储文件与 `attendance-admin-plugin-lib-dist-layout-boot`），与 §S10.5 相同；格数比 §S10.5 多 2，都是 `task-records-guards` 的新格 |
| 迁移 | `p3gf3_final`、`p3gf3_final2` 各从空库全量迁移 | 各 426 条，最后一条是本迁移 |
| 真库 lane × 3（16 文件） | `vitest --config vitest.integration.config.ts run <tasks-realdb.yml 的 16 个文件> --reporter=verbose` | `3c69bdbe13` / `p3gf3_final2` 三遍均 **16 passed；708 passed (708)**，58 / 59 / 58 秒；`2595c60b64` / `p3gf3_final` 三遍同样 708 / 708，79 / 70 / 57 秒；六遍 `socket hang up` / `ECONNRESET` 0 次。逐文件三遍相同：p0a 13、read-path 57、completion-grid 6、rbac-trust 17、m3-tree 25、m3-membership 45、m3-comments-deletion 33、m4-schema 59、m4-list-roles 50、m4-paging-settings 77、m4-dates 107、m4-lists 66、**m4-list-members 44**、m4-list-items 25、**m4-groups 38**、**m4-org-members 46** |
| 鉴权门 × 2 | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`（`RBAC_BYPASS=false RBAC_TOKEN_TRUST=false` 由配置与 `setup.ts` 给） | `p3gf3_final2` 两遍、`p3gf3_final` 两遍，均 **86 passed (86)**，各约 4 秒 |
| 跑完之后的残留 | 三个库的八张 M4 表、`tasks`、`task_events`、两类种子用户、任务 org 的 `user_orgs`、新格的用户与 `user_roles` | 全部 0 行 |
| 与 PR-3b 分支的合并 | `git merge-tree --write-tree HEAD claude/tasks-m4-pr3b` | 无冲突 |
| 字面扫描 | 私有工件目录里的三个扫描器：v1、v2（裁决包里 ≥ 10 字的连续中文），以及引号内字符串（`「」『』“”‘’""''` 与反引号之间、≥ 5 个汉字，两边去掉空白、标记与引号并做 NFKC 后整串比对两份私有裁决包；直引号与反引号按相邻两个标记之间的每一段都算，所以代码段之间的正文也在比对之列）；参数是 `git diff --name-only origin/main...HEAD` 的全部文件与 PR body、squash 提交信息两份草稿 | 三个都退出 0。引号扫描器只豁免门子集行的标签（`M4\|1\|…`，测试名必须带它，它在已推送待审的锁修订里）；不带任何豁免的另一个引号检查同样退出 0。正控（把一个命中句放进临时文件）退出 1 |
| 本机路径、机器名、局域网地址 | 对 `git diff origin/main...HEAD` 的新增行与两份草稿查用户主目录前缀、用户名、私有工件目录前缀、系统临时目录前缀、机器名、三个私有网段与部署主机地址 | 0 处（本行只写模式的名称） |
| 变异 | §S8S10F.4 | 19 个变异、21 次运行，全部变红 |

删库：三个库删除前查过上表「残留」一行都是 0，然后按全名 `DROP DATABASE p3gf3_dev`、`p3gf3_final`、`p3gf3_final2`，没有碰别的库。

### S8S10F.4 变异证明

做法同 §S10.6（私有工件目录里的脚本）：断言每个 needle 恰出现应有的次数 → 原字节存到工作树之外 → 写入变异 → 跑 → 写回原字节 → 对每个被改的文件 `cmp -s`；一个变异可以改几个文件。全部在 `2595c60b64` 上跑，库是 `p3gf3_dev`；逐个串行，期间不跑别的 vitest 进程；21 次运行全部逐字节还原，跑完 `git status` 干净。下表「失败」是该套件的失败格数，没有一个是因为收集失败或进程崩溃。

| # | 变异（文件） | 套件 | 失败 | 变红的格 |
|---|---|---|---|---|
| M13 | 租户声明的 org 不再要求 `user_orgs.is_active`（`AuthService.ts`，请求了租户的分支） | 鉴权门 | 25/86 | 门 1 的 24 格 M4 格；M2 的跨 org 写格。清单 id 之下的 6 条读仍绿：清单在本 org，换到停用关系的 org 里本来就是 404 |
| OA02 | 创建时的查询跳过第一个 id（`assignees.slice(1)`，`task-records.ts`） | 真库 `task-m4-org-members` | 8/46 | 8 格「唯一 / 第一个负责人」 |
| OA02 | 同上 | 单测 `task-records-guards` | 1/69 | 创建人位置格 |
| R17a | 查询去掉 `activation_status = 'activated'`（`task-org-members.ts`） | 真库 `org-members` + `list-members` | 6/90 | 三个写入点的待激活格；加成员、转让的待激活格；对拍格 |
| R17b | 查询去掉角色条件（同上） | 同上 | 6/90 | 三个写入点的 disabled 格；加成员、转让的 disabled 格；对拍格 |
| R17c | 角色条件去掉 admin 角色那一支（同上） | 同上 | 4/90 | 三个写入点的「disabled 且持 admin 角色」格；对拍格 |
| MR01 | `GET /api/task-groups` 一行请求 `/api/task-groups/items`（鉴权门表） | 鉴权门 | 1/86 | 路由人口格 |
| MR02 | `GET …/group-items` 一行请求 `…/groups`（同上） | 鉴权门 | 1/86 | 同上 |
| MR03 | `PATCH /api/task-lists/:id/groups/:groupId` 一行发 DELETE（同上） | 鉴权门 | 1/86 | 同上 |
| MR04 | `PATCH /api/task-groups/:groupId` 一行发 DELETE（同上） | 鉴权门 | 1/86 | 同上 |
| F05 | `GET /api/task-groups/items` 一行请求 `/api/task-groups`（同上） | 鉴权门 | 1/86 | 同上 |
| MR3C | M3 表 `GET /api/tasks/:id/comments` 一行请求 `/parent-candidates`（同上） | 鉴权门 | 1/86 | 同上 |
| F05b | F05 加上真实路由 `GET /api/task-groups/items` 去掉 `rbacGuard`（两个文件） | 鉴权门 | 1/86 | 同上 |
| M04 | `POST …/transfer-owner` 的守卫改成 `rbacGuardAny(['tasks:write', 'tasks:admin'])`（`tasks-lists.ts`） | 鉴权门 | 1/86 | 该路由的门 2 / 16 格（只带 `tasks:admin` 的用户得到 404 而不是 403） |
| GS01 | 个人分组读不切 `limit`（`task-group-records.ts`） | 真库 `task-m4-groups` | 1/38 | `groups|personal paging` |
| GS01 | 同上 | 单测 `task-records-guards` | 1/69 | 个人分组分页格 |
| GS19 | 清单分组的容器在清单已归档时 404（同上，六条路由都受影响） | 真库 `task-m4-groups` | 1/38 | `groups|archived` |
| GS20 | 同上，只对读 | 同上 | 1/38 | 同上 |
| GS21 | 同上，只对写 | 同上 | 1/38 | 同上 |
| S19 | 创建的查询挪到取结构锁之前（`task-records.ts`，两处编辑） | 真库 `task-m4-org-members` | 1/46 | `m4orgm|create|queued` |
| GDEL | 删组时为被删分组里的每个任务写一条 `group_changed`（`task-group-records.ts`） | 真库 `task-m4-groups` | 1/38 | `groups|delete` |

### S8S10F.5 未改的 P3 与说明

- **P0-A 八条路由里六条没有门 2 / 16 的格**（`/pending`、`/pending-count`、`GET /api/tasks`、`POST /api/tasks`、`/complete`、`/reopen`）：在 PR-3a 之前（`cc6ca96ac2`）就是这样，不是本 PR 引入的；留给 M2 路由的所有者或单独一个只改鉴权门的切片。
- **任务 D 的 `ASSUMPTION(task-d)` 标签没有改记 `RULED(2026-10-07)`**：§S10.3 的规则不动任务 D 的标签；全量改标签会碰 PR-3b 也在改的文件，模块抬头已写明 R、N 条目已裁。

### S8S10F.6 NOT RUN

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17。
- CI 上的任何 lane（不推送）。
- staging 与生产：没有部署，没有应用 DDL。
- 前端：没有在浏览器里跑。
- 其他 trust-off 鉴权门（待办中心、云课堂）在 M13 下的表现：没有跑，那两个门不在本 PR。
- 本分支并入 PR-3b 之后的测试：只用 `git merge-tree` 确认没有文本冲突，合并后的树上没有跑任何测试。
- 两个 recovery 守卫、flag manifest 与 staging smoke 的 ops 测试没有重跑：闸修复没有改迁移与这些脚本，沿用 §S10.5 的结果。
- 闸修复本身还没有过闸。

## 总结（S0–S10 与闸修复）

### 切片

| 片 | 内容 | lane（片末：文件 / 格） | 鉴权门 | 手工变异 |
|---|---|---|---|---|
| S0 | M3 后端与任务 D 合并为基座 | 没有单独跑（§S0） | — | — |
| S1 | 迁移、id、夹具 helper、形状测试 | 8 / 209 | 22 | 15 |
| S2 | R04 角色解析与零负责人守卫 | 9 / 284 | 23 | 14（另 3 个文件内负控） |
| S3 | 分页、设置、红点范围、部署耦合的登记 | 10 / 356 | 23 | 18（另 1 个文件内负控） |
| S4 | 日期写入与 PATCH | 11 / 465 | 23 | 30（另 2 个文件内负控） |
| S5 | 清单核心 | 12 / 529 | 24 | 38（另 4 个文件内负控） |
| 修复切片（S1–S4 闸审） | 清单身份两层绑定 org 等 | 12 / 551 | 24 | 39（另 1 个文件内负控） |
| S6 | 成员与转让 | 13 / 590 | 24 | 53 |
| S5 闸修复 | 清单写的锁后时间戳等 | 13 / 590 | 24 | 14 |
| S7 | 清单项 | 14 / 617 | 24 | 44（另 1 个文件内负控） |
| S8 | 分组 | 15 / 653 | 24 | 99（另 1 个文件内负控） |
| S6+S7 闸修复 | 增删负责人与关注人须直接角色等 | 15 / 656 | 24 | 29 |
| S9 | R17 / N2 回填 | 16 / 683 | 24 | 26 |
| S10 | 鉴权门与收口 | 16 / 683 | 86 | 20 |
| S8–S10 闸修复 | 停用关系 token、首位负责人格、R17 与登录同判据、行与路由的绑定、只带 `tasks:admin` 的用户、归档清单的分组格、分页格、删组的事件规则、文字 | 16 / 708 | 86 | 19 |

手工变异合计 **458** 个，457 个变红；1 个（§S2.6 的 MS13）判为等价变异，只记录、不算击杀。每节另记了判为等价而没有计入的变异与理由。文件内负控（门 1、门 8、门 13、门 19 与负控 1–7）每遍 lane 或鉴权门都跑。

### 最终 head 的格数

| 文件 | 静态展开数 | 收集并通过（三遍 lane） |
|---|---|---|
| `task-p0a` | 13 | 13 |
| `task-read-path` | 57 | 57 |
| `task-completion-grid` | 6 | 6 |
| `task-rbac-trust` | 17 | 17 |
| `task-m3-tree` | 25 | 25 |
| `task-m3-membership` | 45 | 45 |
| `task-m3-comments-deletion` | 33 | 33 |
| `task-m4-schema` | 59 | 59 |
| `task-m4-list-roles` | 50 | 50 |
| `task-m4-paging-settings` | 77 | 77 |
| `task-m4-dates` | 107 | 107 |
| `task-m4-lists` | 66 | 66 |
| `task-m4-list-members` | 44 | 44 |
| `task-m4-list-items` | 25 | 25 |
| `task-m4-groups` | 38 | 38 |
| `task-m4-org-members` | 46 | 46 |
| 合计（`tasks-realdb.yml` 的 16 个文件） | 708 | 708 |
| 鉴权门（`vitest.tasks-auth.config.ts`） | 86 | 86 |

静态展开数在最终 head 上从源码重新数过：普通 `it` 一格，`it.each` 按表的行数（字面数组按顶层元素数；由 `flatMap` 等算出的表按源数组手算：`task-m4-schema` 3 × 3、`task-m4-paging-settings` 21 × 2、`task-m4-lists` 6、`task-m4-org-members` 3 × 4、4 × 2、3 × 3）。任务单测子集 29 个文件 1160 格；全量单测 20445 格（本机 5 个文件因环境失败，与本 PR 无关）。

### 闸审与裁定（只列编号）

- S1–S3 闸审与 S4 闸审：DATES-1、DATES-4、AUTHZ-1、AUTHZ-2、S4-T1、S4-T2、S4-T3、S4-T5；M4G1-AUTHZ-1 / AUTHZ-1 / SCH-1、M4G1-SCHEMA-01 / SCH-2、M4G1-SCHEMA-02 / SCH-3、M4G1-SCHEMA-03、M4G1T-01 至 M4G1T-12、M4G1-AUTHZ-2 / AUTHZ-2、S3-MANIFEST-1、S3-SETTINGS-NIT-1、SCH-4。处置见 §F.1；SCH-4 在 S10 关闭（§S10.2）。
- S5 与修复切片闸审：M4G3T-01、S5-TS-1、S5-TS-2、M4G3T-02、M4G3T-03、S5-NIT-1、M4G3T-05。处置见 §S5F.1。
- S6 与 S7 闸审：M4G4-S7-PACK-1、M4G4T-04、M4G4T-01、M4G4T-02、M4G4T-03、S6-ARCH-1、S6-TS-NIT-1、M4G4T-05，以及 owner 2026-10-07 的 `[own-53]` 裁定。处置见 §S67F.1。
- owner 2026-10-07 的裁定：M4 裁决包按回复模板落槌，R02–R23（含 R17）、N1、N2 与模板末句的 R01、R04；R12 取本件的收窄版 (a1)、(a2)；增删负责人与关注人须直接角色（`[own-53]`）。R01 的新子集行由另一个只改锁的 Draft PR 写进锁，在它合并之前本 PR 落在新行里的格是候选、未计分。
- S8–S10 增量闸审：3 条 P2、14 条 P3 / NIT，处置见 §S8S10F.1；闸修复本身还没有过闸。

### 仍待 owner 的问题

设计 §12 里仍待答的：Q1（`i-m4` 写进锁的 PR）、Q2、Q3 的三处自选、Q4（N1 放哪个 PR）、Q5（基分支）、Q6 的一处拆法、Q7、Q8(b)、Q9、Q10（合并后 staging 的二选一及三问）、Q11、Q12、Q13、Q15、Q17。

### NOT RUN（全 PR）

- PG14 / postgres:16 / postgres:15-alpine：本地只有 PG 15.17；形状 pin 只在 15.17 上核过，CI 的 postgres:16 首跑才是它们的真正检查。
- CI 上的任何 lane：本分支没有推送过。
- staging 与生产：没有部署，没有应用 DDL，没有打开任何 `TASKS_*` 开关。
- 前端与浏览器：没有跑过。
- PR-3b、PR-3c 与前端切片的内容；锁的改动（R01 新行、`i-m4`）。
- 本机环境导致失败的 5 个单测文件没有修。

## 2026-10-09 迁移重新定名与门 15

基于 `68e40323bd`。提交：

| 提交 | 内容 |
|---|---|
| `ed338b69cb` | 迁移重新定名为 `zzzz20261009130000_create_task_m4_tables`；形状测试的 import、manifest 的 `purpose`、迁移头注（只写排序规则）、设计 §2.1 与 §13 S1 / S10 的日期注 |
| `bb58356875` | 门 15：本 PR 新增的生产源码注释不点名其他线的文件、表、函数与迁移（`task-reminders.ts`、`task-dates.ts`、`task-groups.ts`） |
| `c45d1fe9e6` | 本文件 §S8.5 全量单测一行去掉环境叙述，只留超时的技术原因与「取第二遍」 |
| `382e2b78eb` | 代码注释、测试注释与两份文档引用裁定只写条目 id 与日期；只改注释与文档 |
| 本提交 | 本节、§S10.2 的两条日期注、设计 §9.2 的两条日期注；只改文档 |

代码 head 是 `382e2b78eb`，本提交之后没有代码改动。

### 1009.1 迁移重新定名

- 规则（设计 §2.1）：完整文件名排在合并时 main 的全部迁移之后；合并前按 main 届时的最大前缀再核一次。
- 新名排在 main `fc139c868e` 最晚的 `zzzz20261008120000_add_stock_prep_pull_permission` 之后。本地仓库的全部分支与远端跟踪引用（4918 个）里，除本分支外，迁移目录的最大前缀都不晚于 `zzzz20261008120000`，也都没有 `zzzz20261009130000`。
- 跟着改的：形状测试的 import；manifest `TASKS_ENABLED` 的 `purpose`（本分支只有这一处，PR-3b 分支另有三处 `purpose` 写着旧名）；迁移头注只写排序规则，不再点名别的迁移；设计 §2.1、§13 S1 / S10 的日期注与 §9.2 的两条复测注。迁移正文不变。
- manifest 测试按磁盘文件名核对：把 `purpose` 改回旧名时它变红（36 格中 1 格，`purpose names the M4 migration`），还原后与 HEAD 的 blob 逐字节相同。

### 1009.2 门 15

- 人口：`cc6ca96ac2..382e2b78eb` 在 `packages/core-backend/src` 下新增的注释行，按 TypeScript 语法树取，整行注释与行尾注释都算（SQL 模板里没有 `--` 注释）：26 个文件、1381 行。改前（`68e40323bd`）是 1396 行。
- 记号表，不区分大小写：`approval todo attendance multitable elearning e-learning dingtalk stock-prep stockprep plm kanban workflow after-sales aftersales directory feishu k3 census`。改前 7 行命中（迁移头注 1 行，`task-dates.ts` 1 行，`task-groups.ts` 1 行，`task-reminders.ts` 4 行），改后 0 行。
- 锁的门 15 原文「生产源码注释不点名其他线符号」：注释里的标识符逐个查声明处（TypeScript 声明、迁移建表、文件名）。改前只在任务路径之外有声明的有 22 个，其中 8 个是其他线的符号（日期提醒的两个函数及其两个参数名、时区校验函数、两个模块文件名、一个提醒服务的文件名）。改后 14 个，其他线的符号 0 个：11 个是任务代码自己的字段或参数名，在任务路径的代码里都有使用；3 个是平台鉴权（`src/auth/` 下的 `AuthService.resolveSessionTenantId`、`evaluateUserAuthenticationGate`、`user-activation.ts`），不属于任何功能线，保留。
- 改法：注释只写规则或先例，不写对方的名字。复用的日期提醒函数与时区校验函数写成「导入的函数」；`source_key` 一段写共用的键后缀与「渠道是普通 `text` 列」这一先例；迁移头注只写排序规则。
- 只改注释：`bb58356875` 与 `382e2b78eb` 改到的 12 个源码与测试文件，去掉注释后由 TypeScript 打印的结果与改前逐字节相同。对照：改一行代码时同一比较报不同。

### 1009.3 命令与结果

本机，Node 20.20.2，代码 head `382e2b78eb`（命令在 `packages/core-backend` 下，ops 测试在仓库根）：

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `./node_modules/.bin/tsc --noEmit -p .` | 0，没有输出 |
| 任务单测子集与迁移守卫 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts tests/unit/migration-timestamp-uniqueness.guard.test.ts tests/unit/migrations.rollback.test.ts tests/unit/migration-provider.test.ts` | 32 个文件 1196 格全绿：任务子集 29 个文件 1160 格；前缀唯一 20、`migrations.rollback` 10、`migration-provider` 6 |
| ops 脚本测试 | `node --test scripts/ops/global-history-flag-manifest.test.mjs`；`… staging-tasks-smoke.test.mjs`；`… tasks-auth-ci-wiring.test.mjs` | 36/36；19/19；3/3 |
| 公开文本 | 三个字面扫描器（私有工件目录），参数是本轮改动的全部文件、五条提交信息与 PR body、squash 提交信息的草稿 | 都退出 0 |
| 本机路径、机器名、局域网地址 | 对 `git diff 68e40323bd` 的新增行与两份草稿查用户主目录前缀、用户名、私有工件目录前缀、系统临时目录前缀、机器名、三个私有网段与部署主机地址 | 0 处（本行只写模式的名称） |

另一台机器，PostgreSQL 16.15，一次性库，跑完删除：

| 项 | 结果 |
|---|---|
| lane 与鉴权门（`382e2b78eb`） | 从空库全量迁移 426 条（CI 的排除清单），本迁移最后执行；`tasks-realdb.yml` 的 16 个文件 708 / 708（逐文件与「总结」里最终 head 的格数表相同）；鉴权门 86 / 86 |
| 同上（`c45d1fe9e6`，改裁定引用之前） | 426 条；708 / 708；86 / 86 |
| main 并入本分支（临时合并 `fc139c868e` + `382e2b78eb`） | 三个 ops 文件有文本冲突（见 1009.4）；这次只为建树，三处取 main 一侧；迁移目录与 `migrate.ts` 没有冲突。从空库全量迁移 427 条，最后三条依次是 `zzzz20261001120000_create_approval_form_drafts`、`zzzz20261008120000_add_stock_prep_pull_permission`、本迁移；台账按时间、名字倒序的第一行是本迁移 |
| `--rollback` | 先写入 `stock-prep:pull` 的一行角色授予与一行用户授予；目录快照（八张表与 `remind_at`、`tasks_id_org_id_key` 的列、约束、索引）139 行。`--rollback` 退出 0，只回退本迁移：台账 427 → 426，少的正是本迁移；八张表、`remind_at`、`idx_tsk_remind`、`tasks_id_org_id_key` 都不在；`permissions`、`role_permissions`、`user_permissions` 里该码的行数 1 / 1 / 1 不变，那条迁移的台账行仍在 |
| 再迁移 | 只执行本迁移一条；快照 139 行，与回退前 `cmp` 逐字节相同；台账 427；授予行不变 |
| 删掉文件的情形（设计 §9.2） | `MIGRATION_EXCLUDE` 加上现名：`migrate.ts` 与 `--rollback` 都退出 1，`corrupted migrations: previously executed migration zzzz20261009130000_create_task_m4_tables is missing`；`--list` 退出 0，`Applied: 426`、`Pending: 0`；台账、表与授予行不变 |
| 对照（临时合并 `fc139c868e` + 旧 head `68e40323bd`） | 同样的冲突，同样的取法。从空库全量迁移 427 条，旧名排在倒数第二；`--rollback` 回退的是最后执行的 `zzzz20261008120000_add_stock_prep_pull_permission`，本迁移的表都在 |

### 1009.4 合并前须知

- 与 main `fc139c868e` 有文本冲突的三个文件：`scripts/ops/staging-tasks-smoke.mjs`、`scripts/ops/staging-tasks-smoke.test.mjs`、`scripts/ops/global-history-flag-manifest.test.mjs`（main 上 #6278 改写了任务冒烟脚本，manifest 测试是同一位置各自新增的测试）。本轮没有并入 main，也没有解冲突；合并前要并入 main 并解决，之后重跑 ops 测试与 lane。（2026-10-09 注：已在重建提交里解决，见文末 1009r.1。）
- 迁移前缀：合并前按 main 届时的最大前缀再核一次。
- PR-3b、PR-3c 与前端验证文档里仍是旧名；PR-3b 的 manifest 另有三处 `purpose` 写着旧名，它们并入本分支之后 manifest 测试会报出。（2026-10-09 注：PR-3b 已改写现名，见文末 1009r.2。）
- `task-reminders.ts`、`task-dates.ts`、`task-groups.ts` 的注释改过之后，本 PR 里这三个文件不再是 #6186 同名文件的严格超集（只差注释）。

### 1009.5 NOT RUN

- CI 上的任何 lane（本轮没有推送）；PG14 与 postgres:15-alpine。
- 全量单测：只跑了任务单测子集与三个迁移守卫。
- 临时合并结果上的 lane、单测与 ops 测试：只在它上面跑了迁移、回退与再迁移；三个 ops 文件的冲突没有解。
- 两个 recovery 守卫：本轮没有改迁移正文与 recovery 相关文件。
- 门 15 对本 PR 以外既有注释的重扫。
- staging 与生产：没有部署，没有应用 DDL，没有打开任何 `TASKS_*` 开关。
- 前端与浏览器。

## 2026-10-09 重建为 main 上的单个提交

本 PR 重建为 main `8f90307d5a` 上的单个提交。内容是上一节结束时的分支，加上 main 自 `cc6ca96ac2` 以来的提交，再加三个 ops 文件的冲突解法（1009r.1）与两份任务 D 文档的新修订（1009r.2）。本节取代 §1009.4 的第 1、3 条（那两条原文保留，各加了一条指向本节的日期注）；其余各节是当时的记录，原样保留。

### 1009r.1 与 main 的三处冲突

- `scripts/ops/staging-tasks-smoke.mjs` 与 `scripts/ops/staging-tasks-smoke.test.mjs` 是 main 在 #6278 改写过的 staging 冒烟脚本与它的测试 harness；`scripts/ops/global-history-flag-manifest.test.mjs` 里两边在同一位置各加了测试。三处都在重建提交里解决，两边的内容都保留。
- M4 的 preflight 现在在改写后的脚本与 harness 里。脚本头注多一条规则：写任何种子行之前，先查任务路由读的三张 M4 表，缺哪张就按表名失败。测试里 M4 的 `to_regclass` 语句进入钉住的 preflight 语句序列，happy path 的断言数 99 → 100，权限拒绝格读前三条语句，三个 M4 缺表格改用 main 的缺表钩子 `FAKE_PG_MISSING_TABLE` 与 `entry.text`。
- manifest 测试先放 main 的两格审批红点测试，再放本 PR 的 `TASKS_ENABLED` 格。
- 合并前若 main 又改了这三个文件，要再核一次。

### 1009r.2 迁移名、PR-3b 与任务 D 文档

- PR-3b 的分支叠在重建后的本提交上。它的 manifest 里三个开关的 `purpose` 与它的设计都写现名 `zzzz20261009130000_create_task_m4_tables`，旧名只留在当时的记录句里，带日期注；§1009.4 第 3 条说的 manifest 报错不再出现（重建后的 PR-3b 上 manifest 测试 41 / 41）。PR-3c 的文档不写迁移文件名；前端验证文档在写旧名的地方加了日期注，写明现名。
- 迁移前缀：main `8f90307d5a` 上最晚的迁移仍是 `zzzz20261008120000_add_stock_prep_pull_permission`（`fc139c868e` 之后 main 没有新增迁移），本迁移排在它之后。合并前按 main 届时的最大前缀再核一次（§1009.4 第 2 条不变）。
- 两份任务 D 文档换成任务 D 分支的最新修订：收窄后的 R12 写成规则，已裁条目按 id 引用。只改文档，两份文档的标题与小节号都不变。

### 1009r.3 R01 的 ①–③ 在合并之前判定

- R01（2026-10-07）给 M4 定的退出条件分四部分：① 锁里已有的两条 `M4|` 行全绿；② R01 新加的每一条 `M4|` 行全绿；③ 全部 `M2|`、`M3|` 行重跑一遍且全绿；④ staging 真投递一次，outbox 账本留一行。①–③ 是合并之前的判定；只有 ④ 在合并之后，是 owner 的步骤。
- 判定用的树是合并之前的最终候选集成树：含锁 PR（#6248）的 main，加上按合并顺序叠好的 PR-3a、PR-3b、PR-3c 与 M4 前端，冲突按各 PR 写明的解法解好。② 的新行在锁 PR 合并之前不计分，所以这棵树以合并了锁 PR 的 main 为基。判定在 M4 的任何一张 PR 合并之前做完并留下记录。
- 本文 §S10.8 与设计 §1、§10.9 说的 M2 / M3 全部门行在最终 head 上的回归，指的就是这棵树上的这一遍。PR-3c 在自己的 head 上跑过的那一遍是预备，不代替它。

### 1009r.4 重建之后的结果

下面的运行都在加本节之前的树上做，它与本节所在的树只差本文件。本机，Node 20.20.2（命令同 §1009.3）：

| 项 | 结果 |
|---|---|
| type-check | `tsc --noEmit -p .` 0 |
| 任务单测子集 | 29 个文件 1160 格。第一遍里 main 自己的 `tasks-auth-ci-wiring` 有一格因 python3 启动超时失败，单独跑与整组重跑都全绿 |
| 迁移守卫 | 三件 36 格：前缀唯一 20、`migrations.rollback` 10、`migration-provider` 6 |
| ops 脚本测试 | `staging-tasks-smoke` 191 / 191；flag manifest 38 / 38；鉴权门接线 3 / 3 |

另一台机器，PostgreSQL 16.15，一次性库，跑完删除：

| 项 | 结果 |
|---|---|
| 迁移 | 从空库全量迁移 427 条（CI 的排除清单），本迁移最后执行 |
| `--rollback` | 先写入 `stock-prep:pull` 的一行角色授予与一行用户授予。`--rollback` 只回退本迁移（台账 427 → 426）；授予行 1 / 1 / 1 不变 |
| 再迁移 | 只执行本迁移一条；目录快照（139 行）逐字节相同 |
| lane 与鉴权门 | `tasks-realdb.yml` 的 16 个文件 708 / 708，逐文件与「总结」里最终 head 的格数表相同；鉴权门 86 / 86 |

本节只改本文件。读文档的两个单测在加了本节之后的树上跑过：`task-gate19-identities` 9 / 9，`task-ci-coverage-enumeration` 4 / 4。三个字面扫描器对本文件都退出 0。

### 1009r.5 NOT RUN

- CI 上的任何 lane（没有推送）；PG14、postgres:15-alpine 与 CI 的 postgres:16 容器。
- 全量单测；迁移回放的另两种：`migration-replay.yml` 的排除子集，以及不排除任何迁移的全量迁移。
- R01 ①–③ 的判定：要在最终候选集成树上做（1009r.3），不在本 PR 自己的 head 上做。
- staging 与生产：没有部署，没有应用 DDL，没有打开任何 `TASKS_*` 开关。
- 前端与浏览器。
