# metasheet2 调查+设计：views/view_states 迁移簇 CI 排除项（issue #4162）— 2026-07-12

> **状态：PROPOSED，待 owner 裁决。本文档仅为调查 + 设计，不含任何运行时代码或迁移变更。**
> 触发：issue #4162（P2, planning-only）。目标：`tests/integration/snapshot-protection.test.ts`（21 个真实断言，PR #4145 已杀掉其静默假绿）目前**无法接入任何 CI workflow**，因为 CI 测试库缺 `views` 表。本文档核实缺表的真实成因、实测解除排除后的行为，并列出 owner 需要裁决的选项。
> 基线：`origin/main` 新鲜 worktree（HEAD `db2eb8a57`，含 PR #4145 2026-07-12 当日合并）。核对方法：新鲜 throwaway Postgres（15.17，本机 Homebrew）+ 逐项真实迁移/真实测试运行，证据均为一手命令输出，非转述。

---

## 1. 机制：MIGRATION_EXCLUDE 精确清单与位置

`MIGRATION_EXCLUDE` 由 `createCoreBackendMigrationProvider()` 消费：

- `packages/core-backend/src/db/migration-provider.ts:195-200` — 从 `process.env.MIGRATION_EXCLUDE` 读取，逗号分隔；
- `:95-98` `normalizeMigrationName` + `:100-106` `getExcludedNames` — 按 basename 去扩展名归一化（`.sql/.ts/.js/.mjs/.mts` 均可省略），所以 workflow 里写 `20250925_create_view_tables.sql` 或 `20250925_create_view_tables` 效果相同；
- `:231-239` — 在拼好的 provider 迁移 + SQL 文件迁移全集上做最终过滤，**排除项直接从 Kysely 看到的迁移列表里消失**（连 `kysely_migration` 历史行都不会有）。

这与另一套完全独立的机制不同，必须先分清楚，否则会误判某项排除"清空即生效"：

- `SUPERSEDED_LEGACY_SQL_MIGRATIONS`（`migration-provider.ts:21-57`，29 项，`032_*`…`055_*` 及 `20250926_create_audit_tables`）——不是排除，是**替换成空 no-op**（`:120-127` `createNoopMigration`，`:231-235` 应用）。历史行仍然存在，`up()` 是空函数。逃生阀 `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true`（`:192-194`）。
- 两套清单在 issue #4162 关心的簇里有重叠：**`042a_core_model_views.sql` 同时在两个清单里**（`SUPERSEDED_LEGACY_SQL_MIGRATIONS` 第 32 行 + 全部 5 个 workflow 的 `MIGRATION_EXCLUDE`）。`048_create_event_bus_tables.sql`、`049_create_bpmn_workflow_tables.sql` 同理（第 43-44 行）。**从 workflow 的 `MIGRATION_EXCLUDE` 里删掉这三项是化妆式改动**——它们仍会被 SUPERSEDED 清单接管成空 no-op，删不删 `MIGRATION_EXCLUDE` 都不产生 `views`/`event_subscriptions`/`bpmn_*` 之外的任何 schema 变化（这三项从来不创建 `views` 表本身）。**真正对 `views`/`view_states` 表负责、且不受 SUPERSEDED 清单保护的三项是**：
  - `20250924120000_create_views_view_states.ts` — 创建 `views`、`view_states`、`kanban_configs`、`calendar_configs`、`form_configs`、`form_responses` 等；
  - `20250925_create_view_tables.sql`；
  - 外加 `20251117000001_add_snapshot_labels.ts`（给 `snapshots` 加 `tags`/`protection_level`/`release_channel` 列）与 `20251117000002_create_protection_rules.ts`（`protection_rules` 表）——`snapshot-protection.test.ts` 同时依赖这两个，不在 issue 列出的"views 簇"里，但同样被 CI 排除，且是 `beforeEach` 里第一个命中的失败点（见 §4.4）。

### 当前 5 个 workflow 的排除清单——彼此不一致（关键结构性发现）

`grep -rl MIGRATION_EXCLUDE .github/workflows/` 命中 5 个 workflow，共 6 处赋值。归一化后其实是 **3 种不同的清单**，没有单一真源：

| Workflow | 行号 | `20250925_create_view_tables.sql`？ | `zzzz20260114110000_create_user_orgs_table.ts`？ | 备注 |
|---|---|---|---|---|
| `plugin-tests.yml`（job `test`） | :179 | ✅ 在 | ❌ 不在 | **本 issue 的目标 workflow** |
| `plugin-tests.yml`（job `after-sales-integration`） | :618 | ✅ 在 | ❌ 不在 | 与上面完全相同文本 |
| `observability-strict.yml` | :108 | ✅ 在 | ✅ 在 | |
| `safety-guard-e2e.yml` | :67 | ✅ 在 | ✅ 在 | |
| `observability-e2e.yml` | :68 | ✅ 在 | ✅ 在 | |
| `migration-replay.yml` | :81, :88 | ❌ **不在**（PR #3632 已移除） | ✅ 在 | **唯一被更新过的一份** |

结论：`plugin-tests.yml` 的清单既不是最新的（比 `migration-replay.yml` 落后一个已修复项），也不是历史最全的（缺 `user_orgs` 一项，原因不明——可能是该项从未在 plugin-tests 场景下触发过，从未被人加过）。5 份清单靠人工复制维护，drift 已成事实。

---

## 2. 为什么被排除——历史考古

### 2.1 起源：PR #918（2026-04-19）

`git log --follow -- packages/core-backend/src/db/migration-provider.ts` 与 `git log -S create_views_view_states --all` 定位到根：`30604239b fix(db): load legacy sql migrations in migrate entrypoint (#918)`。其提交序列里逐条 subject 就是排除动作本身：
`fix(ci): exclude legacy view table replay migration` / `exclude snapshot label replay migration` / `exclude protection rules replay migration` / `exclude change management replay migration` / `exclude user org replay migration`。**排除动作从诞生起就是为 `migration-replay.yml`（"replay" = 同一新库连续 `db:migrate` 两次）量身写的**，不是为 `plugin-tests.yml`（只 `migrate` 一次）写的。

`docs/development/yjs-migration-exclude-and-ci-hardening-development-20260419.md` 记录了同一事件的另一半：`plugin-tests.yml` 的 `MIGRATION_EXCLUDE` 是后来"对齐"进去的——原文："added the documented `MIGRATION_EXCLUDE` list to both `Run DB migrations` steps... aligning plugin CI with the same migration exclusions **already required by replay/observability paths**"。这是一次**未独立验证的整体复制**：没有证据表明当时有人验证过 `plugin-tests.yml`（单次 migrate）是否真的需要 replay 场景（两次 migrate）的排除项。

### 2.2 权威成因记录：`packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md`

该文件（`Last Updated: 2026-05-12`）逐项记录了 CI 排除清单里每一项的具体原因，全部原文摘录如下（第 19-49 行）：

| 迁移 | 记录原因（原文） |
|---|---|
| `042a_core_model_views.sql` | References non-existent `last_accessed` column during replay paths |
| `20250924120000_create_views_view_states.ts` | Creates view-state foreign keys against pre-fix `text` view ids, which fails once **replay paths** rebuild the newer UUID-based schema |
| `20250924140000_create_gantt_tables.ts` | Creates gantt foreign keys against the same pre-fix `text` view ids and fails with `uuid` vs `text` FK incompatibility **during replay paths** |
| `20250925_create_view_tables.sql` | Applies `tables_owner_id_fkey` against a legacy `owner_id` shape that no longer exists in **replay-built schemas** |
| `20251117000001_add_snapshot_labels.ts` | Re-applies `chk_protection_level` **after replay paths have already created** the newer snapshot schema |
| `20251117000002_create_protection_rules.ts` | Re-creates `protection_rules` **after replay paths have already applied** the legacy protection-rule schema |
| `20251201000001_create_change_management_tables.ts` | Applies `snapshot_id` FKs against newer uuid `snapshots.id` while **replay paths still rebuild** legacy text snapshot references |
| `zzzz20260114110000_create_user_orgs_table.ts` | Rebuilds `user_orgs` against a **replay path** that still carries legacy `is_active` shape |

**8/8 条记录的措辞都是"during replay paths"/"replay-built schemas"** —— 与 §2.1 的 git 考古完全吻合：这是一份记录"两次 migrate / 漂移历史"场景冲突的清单，从未声称在"新库单次 migrate"场景下会冲突。该文档同样是 2026-05-12 的快照，**没有随 §2.3 的修复更新**——它仍把 `20250925_create_view_tables.sql` 列为当前排除（已被 #3632 从 `migration-replay.yml` 移除），"Current Exclude Count: 11 files" 这个数字也已经不准。

### 2.3 root cause 修复：PR #3627 → PR #3632（2026-07-05，本次调查 7 天前）

`git log -S create_view_tables --all` 定位到：

- **PR #3627**「fix(db): drifted-history migration hardening — FK type guard + un-swallowed conditional constraint」：`20250925_create_view_tables.sql` 的 7 处 FK 守卫只检查 `users` 表**存在**，没检查 `users.id` 的**类型**是否与本地整数列兼容；`EXCEPTION WHEN duplicate_object` 抓不住 42804 类型不匹配错误，漂移路径下整个迁移事务会 abort。修复：给每个存在性守卫加 `information_schema.columns` 类型兼容检查。PR 描述的自证："Empty postgres:16 → full `db:migrate`: exit 0, Applied: 237, Pending: 0"（**当时用的是不带任何 `MIGRATION_EXCLUDE` 的默认全量迁移**）。
- **PR #3632**「ci(db): drop `20250925_create_view_tables.sql` from migration-replay exclude — root cause fixed by #3627」：验证方式与本调查完全一致的手法——"replicating the workflow recipe exactly (fresh postgres:16, the NEW exclude list, db:migrate twice + db:list): both runs exit 0, Pending: 0"。**只改了 `migration-replay.yml`，`plugin-tests.yml`/`observability-*.yml`/`safety-guard-e2e.yml` 均未同步**（§1 表格里的 drift 由此产生）。

PR #3627 的描述里还留了一句诚实的"未修复、超出范围"记录："under the off-by-default `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true` debug flag, a different uuid/text FK mismatch fires first in `20250924120000_create_views_view_states.ts` (legacy 051/052 SQL creates `views.id` as text)"。本调查在 §4.3 独立复现了这条记录，并确认它与 issue #4162 无关（CI 从不设置该 flag）。

---

## 3. 实证：解除排除到底会发生什么

方法：新建 throwaway Postgres 15.17 实例（Homebrew，本机专用 socket，与任何共享/开发库隔离），对每个场景 `dropdb && createdb && CREATE EXTENSION pgcrypto`，然后按场景跑 `pnpm --filter @metasheet/core-backend db:migrate`（对应 `plugin-tests.yml:176-180` 的确切命令形状）。全部命令与输出均为本次会话一手运行，非转述。

### 3.1 场景 A——`plugin-tests.yml` 的真实路径：全新库、单次 migrate、完全不设 `MIGRATION_EXCLUDE`

```
dropdb && createdb && CREATE EXTENSION pgcrypto
unset MIGRATION_EXCLUDE MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL
pnpm --filter @metasheet/core-backend db:migrate
```

**结果：exit 0。263/263 迁移全部 `was executed successfully`，含**
`042a_core_model_views`（no-op，见 §1）、`20250924120000_create_views_view_states`、`20250924140000_create_gantt_tables`、`20250925_create_view_tables`、`20251117000001_add_snapshot_labels`、`20251117000002_create_protection_rules`、`20251201000001_create_change_management_tables`。**零错误。**

`\d views` 验证：`views` 表存在，含 `id uuid PK`、`views_type_check`、`views_table_id_fkey → tables(id)` 等完整 schema；`\dt view_states` 确认表存在。

这是本文档最重要的单条证据：**issue 描述的"这些迁移几乎肯定互相冲突"这一假设，在 `plugin-tests.yml` 实际运行的场景（全新库 + 单次 migrate + 默认 flags）下不成立——一个都不冲突。**

### 3.2 场景 B——模拟 "replay"（同库连续 migrate 两次，`migration-replay.yml` 的字面动作），同样不设排除

第一次、第二次均 exit 0（第二次因为全部已在 `kysely_migration` 历史里，`Pending: 0`，属于 kysely `migrateToLatest()` 的正常幂等行为——见 `migrate.ts:25-39`，`allowUnorderedMigrations: true`）。这个字面意义上的"跑两次"对**同一份新库**从未构成问题（kysely 不会重放已记录的迁移，不管 SQL 本身是否幂等）。

### 3.3 场景 C——更贴近"漂移历史"本意的复现：先用当前排除清单跑一次，再撤销排除跑第二次

这更接近 §2.2 记录里"replay paths already created X, then Y tries to recreate it"的真实含义（历史上曾经跳过这些迁移的环境，之后再补跑）：

```
第一次：MIGRATION_EXCLUDE=<plugin-tests.yml 当前值> db:migrate   → exit 0
第二次：unset MIGRATION_EXCLUDE; db:migrate（补跑之前被排除的 7 项，allowUnorderedMigrations 允许乱序） → exit 0
```

**同样零错误**，7 项全部 `was executed successfully`。**在今天的代码上，本文档能够构造出的所有"单库/漂移/双跑"排列都没有复现 `MIGRATION_EXCLUDE_TRACKING.md` 记录的任何一条冲突。** 最合理的解释：PR #3627 的类型兼容性守卫是一个通用模式修复（"AND a type-compatibility check onto each existence guard"），恰好把这簇迁移里同构的"守卫存在性但不查类型"缺陷一并堵上了；`add_snapshot_labels`/`create_protection_rules`/`create_change_management_tables` 的 "re-applies X after already created" 类描述本身依赖 kysely 历史表状态，在本文档能构造的场景里没有被触发到（不能排除还存在本文档未构造出的更细分漂移路径——见 §7 残留风险）。

### 3.4 唯一真实复现的冲突——`MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true`（CI 从不设置，非本 issue 阻塞路径）

按 PR #3627 描述的"未修复、超出范围"路径复现：

```
MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true db:migrate   （新库，不设 MIGRATION_EXCLUDE）
```

**结果：exit 1。**

```
failed to execute migration "20250924120000_create_views_view_states"
error: relation ...
  code: '42804'
  detail: 'Key columns "view_id" and "id" are of incompatible types: uuid and text.'
  routine: 'ATAddForeignKeyConstraint'
```

定位：`20250924120000_create_views_view_states.ts:112`（`kanban_configs.view_id uuid REFERENCES views.id`）。根因：legacy `051_create_minimal_views`/`052_recreate_minimal_views`（`SUPERSEDED_LEGACY_SQL_MIGRATIONS` 清单内，默认 no-op）一旦被该 flag 打开重放，会先把 `views.id` 建成 `text`，与后续 UUID 版本冲突。

`grep -rn MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL .github/workflows/` **零命中**——没有任何 workflow 设置这个 flag，此故障与 `plugin-tests.yml` 无关，与本 issue 无关，只作为"确实存在真实、当前仍未修的 views 相关冲突，但不在 CI 路径上"的独立记录。

---

## 4. 对 `snapshot-protection.test.ts` 本身的正/负对照实测

`vitest --config vitest.integration.config.ts run tests/integration/snapshot-protection.test.ts --reporter=verbose`，`DATABASE_URL` 指向场景对应的库。

### 4.1 负对照——`plugin-tests.yml` **当前**的排除清单（§1 表格第一行原样复制）

`db:migrate` exit 0（排除项本来就不会报错，它们只是消失）。测试 exit 1，**21 个用例全部失败**，第一个失败点是：

```
error: column "tags" of relation "snapshots" does not exist
  code: '42703'
  at SnapshotService.createSnapshot src/services/SnapshotService.ts:146:24
    (insertInto('snapshots').values({ ..., tags: [], protection_level: 'normal', ... }))
  at tests/integration/snapshot-protection.test.ts:86:24 (beforeEach)
```

**注意**：这不是 issue 文中引用的 "relation views does not exist"。`SnapshotService.createSnapshot`（`src/services/SnapshotService.ts:108-198`）在真正调用 `captureViewState`（`:167`，即 issue 引用的 `selectFrom('views')` 所在，位于 `:212-216`）**之前**，先在 `:146-164` 对 `snapshots` 表做一次 `insertInto`，其 `values` 包含 `tags`/`protection_level`/`release_channel` 三列——这三列由 `20251117000001_add_snapshot_labels.ts` 添加，而这个迁移**也在当前 CI 排除清单里**。所以按当前 `plugin-tests.yml` 原样跑，21/21 失败的第一手错误是 `tags` 列缺失，不是 `views` 表缺失；`views` 表缺失是"如果先把两条 snapshot-label 迁移放回去，但 views 簇仍排除"这个中间态才会命中的错误（下面 §4.2 验证）——issue 正文里"Re-enabling the two snapshot-label migrations alone is safe and additive, but insufficient"这句话准确描述了这个顺序。

### 4.2 中间态——issue 文中描述的确切场景：放回两条 snapshot-label 迁移，views 簇仍排除

```
MIGRATION_EXCLUDE=008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924120000_create_views_view_states.ts,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql,20251201000001_create_change_management_tables.ts
```
（即去掉 `add_snapshot_labels` 与 `create_protection_rules` 两项，其余不变）

**结果：21/21 失败**，错误变为：

```
error: Failed to create snapshot {"context":"SnapshotService","error":"relation \"views\" does not exist", ...}
  stack: "error: relation \"views\" does not exist\n    at .../pg/lib/client.js:545:17\n    ...\n    at SelectQueryBuilderImpl.executeTakeFirst ..."
```

——与 issue 原文引用逐字一致，验证了 issue 作者当时的复现路径准确。

### 4.3 正对照——views 簇 + 两条 snapshot-label 迁移全部放行（等价场景 A 的全量迁移库）

**结果：`Test Files 1 passed (1)`，`Tests 21 passed (21)`，Duration 4.68s，零跳过、零静默。** 21 个用例（Snapshot Labeling API 8 个、Protection Rules API 8 个、Protected Snapshot Cleanup 2 个、SafetyGuard Integration 3 个）全部执行并通过断言（PR #4145 已经把 `expect.hasAssertions()`、去除 `if (!baseUrl) return` 静默跳过等硬化落地，本次通过不是假绿）。

**这是本文档第二个最重要的证据：把 views 簇 + 两条 snapshot-label 迁移从 `plugin-tests.yml` 的排除清单里去掉，`snapshot-protection.test.ts` 21/21 全部真实通过，没有观察到任何新的失败模式。**

---

## 5. 结论：issue 假设与实证的对比

Issue 原文断言："Re-enabling the two snapshot-label migrations alone is safe and additive, but insufficient — the `views` cluster is the real blocker, **and it is almost certainly excluded because those migrations conflict with each other or with later ones**。"

本文档的实证结果：**这个"almost certainly conflict"的猜测，在 `plugin-tests.yml` 实际运行的场景（全新 CI 库、单次 migrate、默认 flags）下不成立。** §3.1-3.3 构造的三种排列（单次、双跑、"先排除后解除"漂移）全部 exit 0，§4.3 用真实的 `snapshot-protection.test.ts` 直接验证 21/21 通过。

但这不等于"这些排除项从一开始就是错的"——§2 的历史考古证明它们在 2026-04-19（PR #918）确实是为了让当时会失败的 `migration-replay.yml`（真正的"连续 migrate 两次"场景）变绿而加的，`MIGRATION_EXCLUDE_TRACKING.md` 逐项记录的失败原因都是真实存在过的。**真正过时的是"对齐"这个动作本身**：2026-07-05 的 PR #3627/#3632 把根因（FK 类型守卫缺失）修掉后，只有 `migration-replay.yml` 跟着更新，`plugin-tests.yml`（以及 `observability-*.yml`、`safety-guard-e2e.yml`）从未被重新验证过是否还需要这份清单——而它们本来就不需要，因为它们从未真正遭遇过 replay 特有的失败模式（单次 migrate 不会撞见"re-applies X after replay already created it"这类问题）。

一句话总结：**阻塞 `snapshot-protection.test.ts` 接入 CI 的不是一个需要修的 schema 冲突，而是一份 7 天前就已经过时、且从未被独立验证过是否适用于 `plugin-tests.yml` 场景的排除清单。**

---

## 6. 当前因此无法接入 CI 的测试——清点

仓库范围内对 `views`/`view_states` 表（或 `captureViewState`/`SnapshotService.createSnapshot`）有真实依赖的**集成测试**（`tests/integration/`，走真实 Postgres，非 mock）：

```
grep -rl "captureViewState\|selectFrom('views')\|selectFrom(\"views\")\|from('view_states')" packages/core-backend/tests/integration/
→ tests/integration/snapshot-protection.test.ts   （唯一命中）
```

**1 个文件，21 个测试用例**（`grep -cE "^\s*(it|test)\(" tests/integration/snapshot-protection.test.ts` = 21），逐一见 §4.3 的 4 个 `describe` 分组。仓库里另有 8 个**单测**（`tests/unit/SnapshotService.test.ts`、`SchemaSnapshotService.test.ts`、`RiskControl.test.ts`、`ChangeManagementSimulation.test.ts`、`ChangeManagementService.test.ts`、`SnapshotService.labels.test.ts`、`admin-yjs-status-routes.test.ts`、`IntegrationSimulation.test.ts`）间接提到 `SnapshotService`/`createSnapshot`，但这些是不连真实 DB 的单测，已经在无 DB 的默认 job 里跑，不受本调查影响。仓库里以 `multitable-*-view*.test.ts` 命名的一批测试（`multitable-view-aggregate.test.ts` 等 24 个文件）是 multitable 的"视图配置"（`meta_views`/`view_states` 属于 multitable 域的独立表族，见场景 A 输出里的 `meta_views`/`meta_view_permissions`），与本 issue 讨论的 core `views`/`view_states` 表无关，逐一 grep 确认零命中，不受影响。

---

## 7. 修复选项（owner 待裁决，见 §8）

### 选项 A——最小改动：只改 `plugin-tests.yml`，从两处 `MIGRATION_EXCLUDE` 里删掉 views 簇 4 项（`20250924120000_create_views_view_states.ts`、`20250925_create_view_tables.sql`、`20251117000001_add_snapshot_labels.ts`、`20251117000002_create_protection_rules.ts`），并用"two-point wiring"（PR #4145 已确立的模式：从无 DB 默认 job 排除 + 在 `test (20.x)` 里以整文件 `--reporter=verbose` 跑）把 `snapshot-protection.test.ts` 接进去
- **代价**：2 行 workflow diff（两个 `MIGRATION_EXCLUDE` 值各删 4 项）+ 1 行新增测试引用（比照 `router-isolation.smoke.test.ts` 已有的接入方式，`plugin-tests.yml:198-207`）。
- **风险**：
  - `plugin-tests.yml` 的两个 job（`test`、`after-sales-integration`）都在 **Postgres 14**（`:170`、`:608`）上跑；本文档全部实证在 **Postgres 15.17**（本机 Homebrew）上完成，**未在 PG14 上复核**——见 §9 残留风险，必须在实现 PR 里补跑。
  - 本文档只验证了 `snapshot-protection.test.ts` 自身 21/21 通过和 `db:migrate` exit 0，**未跑 `test` job 里共享同一个已迁移库的其余约 150+ 个真实 DB 测试**（`plugin-tests.yml:191` 那一整段 multitable/approval/attendance real-DB allowlist）。新增表/新增列结构上是纯增量（不改名、不删列），对不涉及 `views`/`snapshots.tags` 的查询语义上应当零影响，但"结构上应当"不等于"已证明"——这是实现 PR 的验收门槛，不是本文档能替代的证据。
  - `20250924140000_create_gantt_tables.ts`、`20251201000001_create_change_management_tables.ts` 两项**不需要**为 `snapshot-protection.test.ts` 解除（该测试不依赖 gantt/change-management 表），可以留在排除清单里，缩小本次改动半径；`042a_core_model_views.sql`/`048`/`049` 三项因为已被 `SUPERSEDED_LEGACY_SQL_MIGRATIONS` 接管，删不删都不产生效果（见 §1），删除属于清理型改动而非功能型改动。
- **证明方式**：实现 PR 里重放本文档 §3.1 + §4.3 的确切命令，但用 `postgres-version: 14`（对齐 CI 实际版本），并追加跑一遍 `test` job 里现有的完整 real-DB allowlist 确认零回归；CI 绿即为证明。

### 选项 B——对齐全部 5 个 workflow 的 `MIGRATION_EXCLUDE` 到单一真源
- 在选项 A 之上，额外把 `observability-strict.yml`、`observability-e2e.yml`、`safety-guard-e2e.yml`、`migration-replay.yml` 的清单也核对一致（§1 表格暴露的 3 变体归一为 1 份），并更新 `MIGRATION_EXCLUDE_TRACKING.md` 的过时记录（仍列着已修复的 `20250925_create_view_tables.sql`、"Current Exclude Count: 11" 等）。
- **代价**：改动面扩大到 6 个文件（5 workflow + 1 tracking doc），且 `observability-*`/`safety-guard-e2e` 三个 workflow 用途与 `plugin-tests.yml` 不同（真正的 replay/漂移语义），**不能照抄选项 A 的删除结果**——需要对每个 workflow 各自重新走一遍 §3 的实证流程，工作量数倍于选项 A。
- **风险**：范围扩大意味着触碰更多与本 issue 无关的 workflow，任何一处判断失误的连锁半径更大；这也是本 issue 的 guard-rail 明确警告的"不要不理解冲突就零散改"的反面——选项 B 恰恰要求先把每个 workflow 的冲突逐一理解清楚，工作量对应地更大。
- **证明方式**：5 个 workflow 各自的 CI 绿；`MIGRATION_EXCLUDE_TRACKING.md` 更新后与实测结果一致。

### 选项 C——审计文档 `superseded-legacy-migrations-gap-audit-20260710.md` 已提出的 P0：加一条不带 `MIGRATION_EXCLUDE` 的"全新库全量迁移 + schema 断言"CI 作业，作为独立于本 issue 的常设护栏
- **代价**：新增一个轻量 workflow（或 `plugin-tests.yml` 里的一个新 job），只做 `dropdb && createdb && db:migrate`（不设排除、不设 SUPERSEDED 逃生阀）+ 关键表存在性断言，不需要跑测试套件本身。
- **价值**：本文档 §3.1 手工做的事情，变成每次 PR 自动跑一遍——今后任何人再往 `MIGRATION_EXCLUDE` 加一项，如果它其实不影响"全新库单次迁移"，这条护栏会持续证明"加了也没必要"或者在真正需要时第一时间标红，防止清单继续只增不减、继续 drift。
- **与选项 A/B 的关系**：互补，不互斥。可以作为选项 A 落地后的跟进，不阻塞选项 A。

---

## 8. 待 owner 裁决

1. **是否批准选项 A（最小改动，仅 `plugin-tests.yml`）作为本 issue 的落地范围？** 本文档建议 **是**——§3、§4 的实证显示这是被验证过的最小改动，未过度扩大到与本 issue 无关的 workflow。
2. **选项 A 落地时，是否要求先在 PG14（对齐 CI 实际版本）上重跑 §3.1+§4.3 的验证，并跑一遍 `test` job 现有 real-DB allowlist 确认零回归，作为该 PR 的合并前置条件？** 本文档建议 **是**——这是 §9 列出的唯一未闭合的证据缺口。
3. **选项 B（5 workflow 全部对齐 + 更新 `MIGRATION_EXCLUDE_TRACKING.md`）是否作为独立后续 issue，而不是本次一并做？** 本文档建议 **是，作为独立票**——范围、工作量、风险都与选项 A 不在同一量级，不应该混在一次 PR 里。
4. **选项 C（无排除全量迁移护栏 job）是否采纳，作为选项 A 之后的跟进，还是维持 `superseded-legacy-migrations-gap-audit-20260710.md` 里的已有 P0 建议，按那条线单独排期？** 本文档不重复裁决，仅指出两处建议指向同一个方案，避免重复立项。
5. **`users.permissions TEXT[] → jsonb` 转换缺口**（`superseded-legacy-migrations-gap-audit-20260710.md` §2 记录）与本文档完全无关，仅作交叉引用，不在本次裁决范围内。

---

## 9. 残留风险 / 未验证事项（诚实清单，非"已完成"）

- **PG14 vs PG15.17**：本文档全部实证在本机 Homebrew Postgres 15.17 上完成；`plugin-tests.yml` 两个相关 job 都固定 `postgres-version: 14`。两个版本在本文档触及的 DDL（`CREATE TABLE`/`ALTER TABLE ADD COLUMN`/FK/`CHECK` 约束）上没有已知语义差异，但**没有在 PG14 上重跑**，不应视为已证明，留给实现 PR 补齐（§7 选项 A 已列为前置条件）。
- **同库其余 real-DB 测试的回归面**：`plugin-tests.yml` 的 `test` job 在同一个已迁移库上还跑着 `plugin-tests.yml:191` 那一大段 100+ 个 multitable/approval/attendance/oapi real-DB 集成测试。本文档只验证了 `db:migrate` exit 0 与 `snapshot-protection.test.ts` 21/21，**没有跑这一整段允许列表**。新增表/列结构上是纯增量，理论回归风险低，但这是断言而非实测证据。
- **§3.3 的漂移复现是本文档能构造的排列，不是穷举**：`MIGRATION_EXCLUDE_TRACKING.md` 记录的 "re-applies X after replay paths already created Y" 类描述依赖历史环境的具体状态；本文档只构造了"先排除后解除"一种漂移路径，不能排除存在更细分的历史状态组合仍会触发 §2.2 记录的某条冲突。如果 owner 需要更强保证，可以要求选项 A 落地 PR 额外跑 `migration-replay.yml` 现有的两跑复现流程作为交叉验证（该 workflow 本身不在本次改动范围内，可用作独立检验）。
- **`MIGRATION_EXCLUDE_TRACKING.md` 未被本文档修改**：本文档只是大量引用它作为"历史为什么排除"的一手证据，其内容已知过时（仍列 `20250925_create_view_tables.sql` 为当前排除、"Current Exclude Count: 11" 不准），更新它是选项 B 的范围，本文档刻意不动它以保持本次 PR 只含一份新文档。

---

## 附：本次调查环境

- Postgres 15.17（Homebrew，本机 throwaway 实例，独立 socket，用后即弃，未连接任何共享/开发库）。
- Node v25.9.0 / pnpm 10.33.0，`worktree` 基于 `origin/main` HEAD `db2eb8a57`（含 2026-07-12 当日合并的 PR #4145）。
- 所有 `db:migrate`/`vitest` 命令均为本次会话内一手运行，退出码与错误文本均逐字摘录于 §3、§4；未使用任何共享或生产数据库。
