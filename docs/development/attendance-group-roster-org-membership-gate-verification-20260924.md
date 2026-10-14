# 考勤组花名册写入：活跃组织成员门 — 验证记录（2026-09-24）

> Design: `docs/development/attendance-group-roster-org-membership-gate-design-20260924.md`  
> 基准：`main` @ `e046a21c0a0110fbe22ca765852f1e053d90c0cb`  
> 证据：本地 vitest；合成 fixture；values-free。无真实租户、无浏览器。

## 1. Verdict

**PASS** locally for the roster-write gate this PR claims: group member, group manager, and schedule-group member inserts fail closed with 404 `USER_NOT_IN_ORG` when the target is not an active member of the actor org. A mixed batch inserts nothing. CSV preview and commit use the same predicate and the same all-or-nothing 404, with per-row index `details`, and do not emit `ensure_member` or insert `attendance_group_members` for a rejected id. Import writes pin the authenticated org: a different body or query org is 404 `NOT_FOUND` and is not used as the membership org. Async preview runs the same gate before `INSERT INTO attendance_import_jobs`. A queued W4 `ensure_member` is rechecked with the same predicate before any group or member `INSERT`; failure is `USER_NOT_IN_ORG` with the index JSON. The #5899 owner-adds-member path still returns 200 for an active member.

Not a merge, deploy, or product-acceptance verdict. Existing ghost rows are not deleted.

## 2. What was verified

| 项 | 结果 | 证据 |
|---|---|---|
| owner 添加本组织活跃成员 200 + values-free event（#5899） | PASS | `lets an owner add members of a managed group…`；SQL 含 managers 谓词 **和** `user_orgs` ∩ `users.is_active` |
| owner 添加停用 / 他组织 / 不存在 id → 404，无 INSERT，无 event | PASS | `rejects an owner member add for %s` |
| admin 添加活跃成员为负责人 → 200 | PASS | `lets an admin add an active org member as a group manager`；既有 `manages attendance group owners separately…` 的 POST 也要求同一谓词 |
| admin 添加停用 / 他组织 / 不存在负责人 → 404，无 INSERT | PASS | `rejects an admin manager add for %s` |
| 成员批 `[active, bad]` → 404，details 只有坏 id，**无** INSERT | PASS | `rejects a mixed member batch before inserting the valid id` |
| 非 manager 成员写仍 403，且不进事务 | PASS | 既有腿 `db.transaction` 未被调用 |
| owner POST managers 仍 403（OW8） | PASS | 既有腿 |
| admin 仍能走 R0 组路由（成员/负责人 POST 在 mock 里视为活跃成员） | PASS | `admits attendance admins through every R0 group-route endpoint` |
| 排班组 admin / scoped scheduler 添加活跃成员仍 200，且 SQL 含同一谓词 | PASS | 既有两条 schedule-group member POST；断言 `expectActiveOrgMemberPredicate` |
| 排班组停用 / 他组织 / 不存在 → 404，无 INSERT | PASS | `rejects a schedule-group member add for %s without inserting` |
| 排班组批 `[active, bad]` → 404，details 只有坏 id，无 INSERT | PASS | `rejects a mixed schedule-group member batch before inserting the valid id` |
| CSV preview：停用 / 他组织 / 不存在 → 404，details 为 `{ code, rejectedCount, indexes }`，不含 userId | PASS | `preview rejects auto-assign for %s…` |
| CSV preview 混合批只报告被拒行；重复行只一条 detail | PASS | `preview rejects a mixed auto-assign batch…`、`preview reports one skipped-row detail…` |
| 不会被分配的行（无考勤组，或组不存在且不 autoCreate）不查这道门 | PASS | `preview does not gate a row that would not be assigned`、`preview leaves unknown groups ungated…` |
| 已存在的组、不 autoCreate，仍 404 | PASS | `preview still gates an existing group when auto-create is off` |
| 活跃成员 preview 200；commit 仍把 `ensure_member` 放进同步计划 | PASS | `preview accepts an active org member…`、`commit still plans ensure_member…` |
| commit 停用 / 他组织 / 不存在 / 混合批 → 404，不调用 `commitSyncImportPlan`，无成员 INSERT，无考勤记录 INSERT | PASS | `commit rejects auto-assign for %s…`、`commit rejects a mixed auto-assign batch…` |
| 导入组织选择器不是认证 org → 404 `NOT_FOUND`，不查 `user_orgs` | PASS | `rejects preview when the org selector is not the authenticated org`（body `org-b` 与 query `orgId=org-b`） |
| async preview 停用 id → 404，谓词已跑，**无** `attendance_import_jobs` INSERT | PASS | `async preview rejects an inactive auto-assign user before inserting a job` |
| W4 `ensure_member` 写入前再查；空结果则抛 `W4C3A_MEMBER_NOT_ACTIVE_IN_ORG`，status 404，index `[1]`，无 INSERT | PASS | `rejects an inactive ensure_member before any group or member insert` |
| worker 把该失败记成 `USER_NOT_IN_ORG`，`error` 为 index JSON，不 terminalize 成功 | PASS | `fails a queued plan when the write-time roster gate rejects a member` |
| `USER_NOT_IN_ORG` 走 `error = $4`；缺 detail 在查询前拒绝 | PASS | repository `markPlanFailed` 断言 |
| 入队后停用，真实 PG 不插入 `ensure_member` | PASS | `enqueue then deactivate does not insert ensure_member`（3/3） |

三种负向（停用、他组织、不存在）在 API 上是**同一个空结果**：谓词不返回该 id。单测用不同 userId 分别打，响应码与 `details` 相同，不提供「用户是否存在于他组织」的区分。

## 3. Commands and results

`main` SHA：`f31a88663d5dcb7a290b6237abff53d8c43d55fe`。#5945 重跑时 `HEAD` 仍是该 SHA，且 `apps/web` 报表文件无本地改动。

```bash
# 本 PR 的组路由单测（含新增门 + #5899 回归）
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-uuid-validation-routes.test.ts
# Test Files  1 passed (1)
# Tests  127 passed (127)
# 含排班组成员门与 CSV preview/commit 门（在原 109 之上）

# 考勤插件既有 unit 套件（tests/unit/attendance*）+ O3 源扫描
cd packages/core-backend && pnpm exec vitest run \
  tests/unit/attendance*.test.ts \
  tests/unit/attendance*.spec.ts
# Test Files  96 passed (96)
# Tests  1744 passed (1744)
# 上一轮 head 的全量考勤 unit 是 1744（当时路由文件 109）。
# 本轮路由文件单独重跑为 127 passed；另加
# src/attendance/__tests__/w4c3a-plugin-v1-boundary.test.ts
# 与路由文件一起：Test Files 2 passed，Tests 155 passed。

# #5945 回归（issue #5942）：main tip，未改报表代码
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-reports-analytics.spec.ts
# Test Files  1 passed (1)
# Tests  7 passed (7)
# 含 blocks inverted report ranges… 与 keeps equal and ascending report ranges loadable

# 三条残留门（认证 org 选择器、async preview 入队前、W4 写入前）合跑
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-uuid-validation-routes.test.ts \
  src/attendance/__tests__/w4c3a-legacy-plan-mutation-seams.test.ts \
  src/attendance/__tests__/w4c3a-legacy-plan-worker.test.ts \
  src/attendance/__tests__/w4c3a-legacy-plan-worker-repository.test.ts \
  src/attendance/__tests__/w4c3a-plugin-v1-boundary.test.ts \
  tests/unit/attendance-import-permission.test.ts --watch=false
# Test Files  6 passed (6)
# Tests  209 passed (209)

DATABASE_URL=postgresql://127.0.0.1/postgres \
pnpm --filter @metasheet/core-backend exec vitest run \
  --config vitest.integration.config.ts \
  tests/integration/attendance-w4c3a-group-effects.db.test.ts --watch=false
# Test Files  1 passed (1)
# Tests  3 passed (3)
# 含 enqueue then deactivate does not insert ensure_member

# 导入链读接口组织边界 + 成员未命中终态统一 + FOR SHARE（rebase 到 main f2d5331d 之后）
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-uuid-validation-routes.test.ts \
  tests/unit/attendance-import-permission.test.ts \
  src/attendance/__tests__/w4c3a-legacy-plan-mutation-seams.test.ts \
  src/attendance/__tests__/w4c3a-legacy-plan-worker.test.ts \
  src/attendance/__tests__/w4c3a-plugin-v1-boundary.test.ts --watch=false
# Test Files  5 passed (5)
# Tests  234 passed (234)

pnpm --filter @metasheet/core-backend exec tsc -p tsconfig.json --noEmit --pretty false
pnpm --filter @metasheet/core-backend exec tsc -p tsconfig.cache.tests.json --noEmit --pretty false
# both exited 0

node --test --test-name-pattern 'generated runtime call-path census' \
  scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs
# 1/1 pass

# 真实 PostgreSQL 16。三个文件全跑：
# Test Files  3 passed (3)
# Tests  39 passed (39)
# 全链：enqueue → 停用 user_orgs → createAttendanceLegacyPlanProcessorV1
# → status failed，reason USER_NOT_IN_ORG，error JSON indexes [0]，成员行与本批 records 为 0。
# FOR SHARE：并发 UPDATE user_orgs.is_active 在成员 INSERT 提交前停在 Lock。
```

## 4. Adversarial / mutation

成员 POST 暂时去掉 `assertActiveOrgMemberUserIds`、改回直接用请求 id 做 INSERT 后，同一文件过滤运行：

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-uuid-validation-routes.test.ts \
  -t "mixed member batch|owner member add for inactive|owner add members"
```

| 腿 | 变异后 |
|---|---|
| `rejects an owner member add for inactive user without inserting` | **红**：`expected 200 to be 404` |
| `rejects a mixed member batch before inserting the valid id` | **红**：`expected 200 to be 404` |
| `lets an owner add members of a managed group…` | **红**：SQL 不再含 `FROM user_orgs uo` |

断言已恢复。那次恢复后全文件是 **109 passed**。本轮补上排班组与 CSV 门之后，同一文件是 **127 passed**。

负责人 POST 与成员 POST 共用 `assertActiveOrgMemberUserIds`。去掉负责人调用会让 `rejects an admin manager add for %s` 变成 200（mock 在 INSERT 被调用时返回成功行）。谓词文本被 `expectActiveOrgMemberPredicate` 锁住：`FROM user_orgs uo`、`JOIN users u`、`uo.is_active = true`、`u.is_active = true`、`uo.user_id = ANY($2::text[])`。

## 5. PostgreSQL 上的谓词

单测桩不执行 SQL。本轮在本机 PostgreSQL **16.15** 上用合成 text id 跑了与代码相同的 `ANY($2::text[])` 查询（临时库，跑完可丢，不是客户库）。

插入：`active-user`（本 org、两侧 `is_active`）、`inactive-user`（`users.is_active = false`）、`inactive-membership`（`user_orgs.is_active = false`）、`other-org-user`（只在另一个 org）、请求里再带一个不存在的 `missing-user`。

`EXECUTE gate('org-a', ARRAY[...]::text[])` **只返回 `active-user` 一行**。`text[]` 与 `user_id text` 能匹配，没有 uuid 转换错误。

这不是考勤插件的集成套件，也没有起 `attendance_group_members` 业务表。本机没有已迁移的 `metasheet_test`，所以没有在本机重跑 `plugin-tests.yml` 里的考勤集成步骤。

## 5.1 CI on `7b5f5347b` and the fixture follow-up

`test (18.x)` job `107739345168`（run `36030943911`）的考勤集成步骤 **17 failed | 1767 passed**。失败都是同一件事：测试用合成 userId 调成员 POST，期望 200，门返回 404 `USER_NOT_IN_ORG`。

| 文件 | 失败腿 |
|---|---|
| `attendance-plugin.test.ts` | multi-shift fixed apply、publish lifecycle、temporary-shift fixed rebuild、unscheduled punch、shift-compliance cap、scoped schedule-group member add、snake_case member alias、auto-shift preview 的 8 条（都走 `createGroupForAutoShift`） |
| `attendance-shift-segments-writer-matrix.db.test.ts` | fixed schedule apply/rebuild、automatic matching apply |

修正只补 fixture，不放宽门：写之前用既有 `ensureActiveImportIdentitiesForTest`（插件集成）或 `seedActiveIdentity`（writer matrix）插入活跃 `users` + `user_orgs`。排班组那条里，scope 拒绝的 `otherUserId` 仍不播种；`assertAttendanceSchedulerScopeAllowed` 在门之前返回 403。

`test (20.x)` 同一 head 上，考勤 unit / lint / typecheck 通过。唯一红的是 elearning schema gate：`bounds the real catalog scan at 10,000 active scope rules` 在 30000ms 超时。该步不跑本 PR 的考勤代码。

`MARK_ROSTER_ORG_FAILED_SQL` 是 private worker 对 `attendance_import_jobs` 的第五条 `UPDATE`。P25 call-path 分类把 `w4c3a-legacy-plan-worker-repository.ts` / `mapStoredChunk` / `attendance_import_jobs` / write / update 的 count 从 4 改成 5，census 长度从 109 改成 110。角色仍是 `operational_status`，adapter 仍是 `private_worker`。

导入路由现在要求 token 上的认证组织。集成夹具给这些调用补了 `tenantId`（`default`，或该用例自己的 org），与 body/query 的 org 一致。P08 的 `ensure_member` 目标用户在写入前种进活跃 `users` + `user_orgs`。门本身不放宽。

## 6. 只读：已有幽灵行

本 PR **不** UPDATE / DELETE。下面的语句只列出「行上的 org 里，这个 userId 不是活跃 `user_orgs` ∩ `users`」的花名册行。id 仅供人工核对。

```sql
SELECT 'attendance_group_members' AS source, m.org_id, m.user_id, m.group_id AS container_id
  FROM attendance_group_members m
  LEFT JOIN user_orgs uo
    ON uo.org_id = m.org_id
   AND uo.user_id = m.user_id
   AND uo.is_active = true
  LEFT JOIN users u
    ON u.id = uo.user_id
   AND u.is_active = true
 WHERE u.id IS NULL
UNION ALL
SELECT 'attendance_group_managers', m.org_id, m.user_id, m.group_id
  FROM attendance_group_managers m
  LEFT JOIN user_orgs uo
    ON uo.org_id = m.org_id
   AND uo.user_id = m.user_id
   AND uo.is_active = true
  LEFT JOIN users u
    ON u.id = uo.user_id
   AND u.is_active = true
 WHERE u.id IS NULL
UNION ALL
SELECT 'attendance_schedule_group_members', m.org_id, m.user_id, m.schedule_group_id
  FROM attendance_schedule_group_members m
  LEFT JOIN user_orgs uo
    ON uo.org_id = m.org_id
   AND uo.user_id = m.user_id
   AND uo.is_active = true
  LEFT JOIN users u
    ON u.id = uo.user_id
   AND u.is_active = true
 WHERE u.id IS NULL;
```

## 7. 仍测不到的降级

- 无浏览器。管理端粘贴框 / global-scope 负责人选择器未点。
- 已经落库的幽灵成员、负责人、排班组成员 **不会**被本 PR 清掉。用第 6 节的只读查询找，不要当清理脚本跑。
- 单测分不出「停用成员关系」和「用户行 `is_active = false`」的执行差异；第 5 节的真实库查询把这两种都排除了，单测本身仍靠谓词文本 + 空结果。
- 组织成员未命中，无论卡在条件复检还是执行适配器，终态都是 `USER_NOT_IN_ORG` 加 index JSON。结构漂移仍是 `PRECONDITION_CHANGED` 且 `error` 为空。同一条效果上结构检查先于成员查询。
- 成员查询与 INSERT 在同一事务，并对本批 `user_orgs` / `users` 行 `FOR SHARE`。并发停用要等事务提交，不能插在检查和 INSERT 之间。不存在的 userId 没有行锁；该情况直接拒绝、不 INSERT。锁不覆盖事务提交之后的停用，也不阻止不锁这些行的旁路写入。
- W4 没有负责人写入。managers POST 仍是同步路径上的门。
- async preview 的 job `error` 在 `updateImportJobProgress` 里截到 2000 字符。HTTP 入队前的 404 带完整 index `details`。
- #5945（报表日期区间）不在本 PR 的改动里。在 `main` `f31a88663` 上重跑 `tests/attendance-reports-analytics.spec.ts` 为 **7/7 PASS**（含倒置区间拦截与相等/升序区间仍可加载）。本 PR 不修改该行为。

## 8. 口径

合成 id（`member-user-2`、`inactive-user`、`other-org-user`、`missing-user`、`not-in-this-org`）。无主机、口令、authorityCode。

## 9. Token tenant when the selector is absent or blank

`getOrgId` returns `'default'` when the selector is `""` (empty string is not skipped by `??`, then the trim check falls through to `DEFAULT_ORG_ID`). Import and integration handlers do not call it.

| Check | Test |
|---|---|
| Every import/integration handler has no `getOrgId(req)` and binds the authenticated org | `keeps every import and integration handler off getOrgId` |
| prepare, legacy `POST /import`, and `integrations/:id/sync` with no selector use `authenticatedTenantId` | `prepare, legacy import, and integration sync use the token tenant when no org selector is sent` |
| `orgId=""` query, body, or `x-org-id` stays on that tenant; with no token the same selector is 403 and does not query `'default'` | `an empty-string org selector stays on the token tenant` |

The token-only user is `{ id: 'admin-1' }` plus `authenticatedTenantId: 'org-tenant'`, and the same routes are repeated with `user.orgId: ''`. SQL parameters include `org-tenant` and do not include `'default'`.

## 10. Alignment to main 64bf18b5e (2026-10-09)

Draft #6051 was merged onto `origin/main` `64bf18b5e833b5cf938d83afe420ae0df4370c86` (#6250 squash, parent `7723d950dc4f7fd2f903eb8588fb5f2b622dc2ef`). Nothing had landed past that SHA at fetch time. The previous alignment parent was `3884d49e90d1e4340b65a87d5bebbd3c5041307e`. Zero conflicts.

Commits brought in, oldest first. Sensitive paths are listed; they were merged under the align-to-latest-main policy.

| Commit | What | Sensitive paths |
|---|---|---|
| `00aac5b7b4de` #6246 | Drop the Node 18.x matrix leg. `apps/web` type-check now runs `vue-tsc` with a 4096 MB heap. | `.github/workflows/plugin-tests.yml` |
| `afd32b704c6f` #6247 | Route the plugin-test job through `MS2_PLUGIN_RUNNER` (default `ubuntu-latest`). | `.github/workflows/plugin-tests.yml` |
| `317cf60d9042` #6252 | Stock-prep customer-reply draft. | none |
| `644310ba6095` #6254 | Date-only leftovers use the business-timezone day. | `packages/core-backend/src/routes/univer-meta.ts` |
| `9eee3a3cd0e7` #6253 | Access presets stop granting unregistered `workflow:read`. | none |
| `ceb5442ed2fa` #6260 | Approval date fields and history actors. | `.github/workflows/approval-web-guard.yml` |
| `311c1fc2e820` #6264 | `stock-prep:pull` gates pull sub-routes. | migration `zzzz20261008120000_add_stock_prep_pull_permission`, `plugins/plugin-integration-core/lib/http-routes.cjs`, `s6a-package-provenance-pins.json` |
| `a6321f3b4bb4` #6257 | Create-user validation reason codes. | none |
| `2f91694c6fa0` #6255 | Approval-center CSV export headers follow the UI language. | none |
| `c147a2d78029` #6256 | Record-link target pickers in the Designer field inspector. | none |
| `9d65b8318f3d` #6261 | Delete condition branches; extra parallel lanes stay reachable. | none |
| `7723d950dc4f` #6263 | Directory create-and-bind returns 400 `INVALID_USERNAME` for a login-name rule failure. | none |
| `64bf18b5e833` #6250 | Stop the attendance-web-guard `onTaskUpdate` timeout. | `apps/web/tests/attendance-admin-regressions.spec.ts` only (no workflow file) |

Earlier context still in this head, already on the previous baseline: #6187 narrowed provenance so `evidenceFiles.pluginTestsWorkflow` became `evidenceFiles.s6aPowershell51Workflow` (still 63 SHA-256 values across 66 leaf fields). #6245 replaced a customer project reference and moved `runtimeFiles.pluginHttpRoutes`.

Pins recomputed on this merge tree against main's pin file: 63 SHA-256 values, 66 leaf fields, 0 differing fields. The pin file was not rewritten. `sealed-export-package-provenance.test.cjs` passed locally. `plugins/plugin-attendance/index.cjs` is byte-identical to `24bb31894`. Residuals #6234–#6237 are unchanged: a deactivation that commits after the insert keeps the row; W4 still has no manager write; already-stored ghost rows are not deleted; `loadDefaultRule` still falls back to the `'default'` org.

`plugin-tests.yml` is now a one-entry matrix `[20.x]`. The required check name stays `test (20.x)`. There is no `test (18.x)` leg. The attendance step still does not set `EXPECT_DB` (#6238). The approval real-DB step still sets `EXPECT_DB: '1'` and `if: matrix.node-version == '20.x'`.

## 11. Alignment to main 1dd42d087 (2026-10-12)

Draft #6051 was merged onto `origin/main` `1dd42d08761039c9937dae06c712fadd10092ab6` (#6348, parent `2ee3531faa978ec01865c4b89423707137bd3830`). The previous alignment baseline was `64bf18b5e833b5cf938d83afe420ae0df4370c86`. The range is 80 commits. Zero conflicts. Auto-merged attendance and OpenAPI files (`plugins/plugin-attendance/index.cjs`, attendance integration/unit tests, `packages/openapi/src/paths/attendance.yml` and generated OpenAPI artifacts, `scripts/attendance/w4c0-dml-inventory/p25-call-path-classification.cjs`) kept the roster org gate: `USER_NOT_IN_ORG` is still thrown before member inserts. `plugins/plugin-attendance/index.cjs` is no longer byte-identical to `24bb31894` because main's attendance edits merged in.

Fifty of the 80 commits do not change a sensitive path on their first-parent diff (workflows, migrations, the provenance pin file, the checkpoint script and the files it loads, `vitest.config.ts`, timemachine). The checkpoint script, `recovery-archive-contract.ts`, and the private-db drain test were not in that set. The 30 that do, oldest first:

| Commit | What | Sensitive paths |
|---|---|---|
| `195e24ac8737` | Opt-in range copy and series fill. | `multitable-web-guard.yml` |
| `65e8ee7c76aa` | Approval CC-unread and new-outcome badges. | `approval-realdb-list-scope.yml`, `approval-web-guard.yml`, `vitest.config.ts` |
| `fc139c868ea9` #6278 | Staging window smokes. | `attendance-staging-window-runner.yml` |
| `8bbe8d3c5dcd` | Range-fill real-database verification. | `plugin-tests.yml`, `vitest.config.ts` |
| `5a7e7897b864` #6273 | Recreate the test database before migrations; cap the test job at 150 minutes. The commit message mentions self-hosted runner prerequisites. #6288 later removed that routing. | `plugin-tests.yml` |
| `fab131348957` #6282 | Stock-prep S1 project sheets. | `plugin-tests.yml`, `087_create_integration_stock_prep_project_target.sql`, `088_extend_stock_prep_audit_project_target_actions.sql`, `zzzz20261009120000_update_stock_prep_admin_permission_description_project_sheets.ts`, `src/index.ts`, `http-routes.cjs`, pin file |
| `52aae89fc777` #6286 | Stock-prep S2 front line. | `http-routes.cjs`, pin file |
| `80cb87322553` #6288 | Public-repo checks stay on GitHub-hosted runners. | `plugin-tests.yml` |
| `b5a9bb07e740` #6292 | Stock-prep S4 archive and restore. | `http-routes.cjs`, pin file |
| `548c1d5834ec` #6291 | Stop offering return targets the server always refuses. | `approval-web-guard.yml` |
| `0db1cb9dcc2f` #6294 | Real-browser return-candidate verification. | `approval-browser-verify.yml` |
| `00caf5f63905` #6296 | Drop the client-side return-candidate mirror. | `approval-browser-verify.yml`, `approval-web-guard.yml` |
| `1b843faeecd6` #6266 | Tasks M4 lists. | `tasks-realdb.yml`, `zzzz20261009130000_create_task_m4_tables.ts`, `vitest.config.ts` |
| `7aae3eda0f9e` #6295 | Stock-prep S3 project overview. | `src/index.ts`, `univer-meta.ts`, `http-routes.cjs`, pin file |
| `c5a2d85bccbc` #6305 | Stock-prep S5a role templates. | `plugin-tests.yml`, `zzzz20261010124500_seed_stock_prep_role_templates.ts`, `vitest.config.ts` |
| `93214d2ea634` #6307 | Stock-prep S5b members page. | `src/index.ts`, `http-routes.cjs`, pin file |
| `e44392d033a8` #6302 | Register approval write, act, and template-manage permissions. | `approval-realdb-permission-catalogue.yml`, `zzzz20261010120000_add_approval_write_act_template_manage_permissions.ts`, `vitest.config.ts` |
| `2df1acbadeee` #6306 | Read-only startup probe for undecryptable stores. | `src/index.ts` |
| `f2bd21662d52` #6312 | Stock-prep S3 follow-ups. | `http-routes.cjs`, pin file |
| `8a272f4bc7f6` #6275 | Attendance settings page shows server run switches. | `approval-web-guard.yml`, `attendance-web-guard.yml` |
| `153575f9fce9` #6274 | Approval cancel-round findings. | `approval-web-guard.yml`, `attendance-web-guard.yml` |
| `d2c33b842679` #6281 | Tasks notification outbox. | `tasks-realdb.yml`, `src/index.ts`, `vitest.config.ts` |
| `9bbbdb29e352` #6300 | Attendance QA today-state and punch-order gaps. | `attendance-web-guard.yml`, `plugin-tests.yml`, `vitest.config.ts` |
| `f14fbabd9326` #6317 | Fresh-install local org membership. | `attendance-onprem-encryption-material-contracts.yml`, `plugin-tests.yml`, `vitest.config.ts` |
| `14c82206ce3d` #6269 | Task badge realtime invalidation. | `tasks-realdb.yml`, `src/index.ts`, `vitest.config.ts` |
| `a1c09729180e` #6265 | Tasks M4 frontend. | `tasks-web-guard.yml` |
| `24652ce8b77d` #6327 | Values-free 500 responses on stock-prep routes. | `http-routes.cjs`, pin file |
| `154df39332fd` #6321 | Server time for online punches. | `attendance-web-guard.yml`, `plugin-tests.yml`, `src/index.ts`, `vitest.config.ts` |
| `06092052d9e8` #6318 | Stock-prep S3 follow-ups 2. | `http-routes.cjs`, pin file |
| `1dd42d087610` #6348 | Merge the legacy floor role into the built-in operator role. | `plugin-tests.yml`, `zzzz20261012090000_rename_stock_prep_frontline_display_name.ts` |

#6288 (`80cb87322553`) is the hosted-runner decision. Required Linux jobs use the literal `ubuntu-latest`. `scripts/ops/github-hosted-runner-routing.test.mjs` rejects `MS2_PLUGIN_RUNNER`, self-hosted labels, and variable expressions. #6270 is closed and superseded by #6288. This branch does not reintroduce self-hosted runner routing. On the merged tree every `runs-on` in `plugin-tests.yml` is the literal `ubuntu-latest`.

Pins recomputed on this merge tree against the pin file: 63 SHA-256 values, 66 leaf fields, 0 differing fields. The pin file was not rewritten. `sealed-export-package-provenance.test.cjs` passed locally (Node v22.23.3; v20.20.2 is not installed on this image). #6051-owned paths are not pin inputs.

Residuals #6234–#6237 are unchanged: a deactivation that commits after the insert keeps the row; `w4c3a-legacy-plan-group-effects.ts` still has no group-manager write; already-stored ghost roster rows are not deleted; `loadDefaultRule` still falls back to the `'default'` org when the pinned org has no default rule.

The matrix is still `[20.x]`. The attendance real-DB step (`attendance-real-db-integration`) still sets `DATABASE_URL` and `ATTENDANCE_TEST_DATABASE_URL` and does not set `EXPECT_DB` (#6238, left as-is). The approval real-DB step still has `if: matrix.node-version == '20.x'` and `EXPECT_DB: '1'`. #6273 recreates the test database before `Run DB migrations` and sets `timeout-minutes: 150` on the test job.

Git auto-merged `p25-call-path-classification.cjs` and kept both sides: the roster job-status classification stays at five updates (the four plan writes plus the org-gate failure write), and #6306's read-only encrypted-store probe entry stays. Each parent still expected a generated census of 110 sites. Together the generated census is 111, with no unclassified sites and no count drift. The explicit length in `attendance-w4c0-dml-inventory-collector.test.mjs` is 111.

## 12. Alignment to main 5acc139a4 (2026-10-12)

Draft #6051 was merged onto `origin/main` `5acc139a44e6e4eb0e8e23a9b0f4e6b2f16d0ed6` (#6358, parent `4e9bafed7b1e06a8df445983aa451f052d8949db`). Nothing had landed past that SHA at fetch time. The previous alignment baseline was `1dd42d08761039c9937dae06c712fadd10092ab6`. Zero conflicts. Harold approved merging this tip, including the workflow edits, and re-running the required checks.

Four commits since the previous baseline. The first three do not change a sensitive path. The fourth does.

| Commit | What | Sensitive paths |
|---|---|---|
| `8fb388f0a71b` #6355 | Decision-register note. | none |
| `8b2213f1fad8` #6356 | Operator-merge script line endings and runbook notes. | none |
| `4e9bafed7b1e` #6357 | Stock-prep deploy record and customer reply. | none |
| `5acc139a44e6` #6358 | UUID v4 helper with a `getRandomValues` fallback. | `attendance-web-guard.yml`, `stock-prep-browser-verify.yml` |

#6358 adds `apps/web/src/utils/uuid.ts` to the attendance-web-guard path filter and to the module-graph wiring in both workflows. Job names stay `attendance-web-guard` and `browser-verify`. `plugin-tests.yml` still uses literal `ubuntu-latest` on every `runs-on`.

Pins recomputed on this merge tree: 63 SHA-256 values, 66 leaf fields, 0 differing fields. The pin file was not rewritten. `sealed-export-package-provenance.test.cjs` passed locally on Node v22.23.3.

## 13. Alignment to main 67874b9bc (2026-10-13)

Draft #6051 was merged onto `origin/main` `67874b9bcd73d686796f57bcddf9e6aa47080a7b` (#6371, parent `0e02495a3c2f973af228dd8e8315918ef322a7b9`). Nothing had landed past that SHA at fetch time. The previous alignment baseline was `5acc139a44e6e4eb0e8e23a9b0f4e6b2f16d0ed6`. Zero conflicts. Harold approved folding the sensitive-path commits and re-running required checks. Workflow files came from main unchanged by this branch: every `runs-on` in `plugin-tests.yml` stays the literal `ubuntu-latest`.

Ten commits since the previous baseline. Sensitive paths are the first-parent diff.

| Commit | What | Sensitive paths |
|---|---|---|
| `389c9d71d1bc` #6359 | Locale replacement token tenant. | none |
| `7f9f0d98edea` #6360 | Smoke request readback bound to the organization. | none |
| `58f4842e0be5` #6363 | On-prem backend log rotation. | `plugin-tests.yml` |
| `b7096129df28` #6364 | Narrow the R65 permission-catalogue migration `down()`. | `zzzz20261010120000_add_approval_write_act_template_manage_permissions.ts` |
| `d9882a8ad01a` #6361 | Open history filters in the production verifier. | `plugin-tests.yml` |
| `625d18ae4767` #6365 | Honour each T9 pwsh suite exit code. | `plugin-tests.yml` |
| `94de2994d566` #6367 | Record submit dialog visibility rules. | none |
| `e2345ab6b4a1` #6368 | Condition values follow the field type. | `approval-web-guard.yml` |
| `0e02495a3c2f` #6372 | Bind performance tenant and runtime provenance. | `attendance-import-perf-baseline.yml`, `attendance-import-perf-highscale.yml`, `attendance-import-perf-longrun.yml`, `plugin-tests.yml`, `attendance-import-perf-gate.mjs`, `attendance-import-perf-gate.test.mjs`, `attendance-import-perf.mjs` |
| `67874b9bcd73` #6371 | R65 record: narrowed `down()` ships from the re-cut package. | none |

The roster org gate, streamed roster preview, `ensure_member` optional `sourceOrdinals` (the five member keys plus that field), migration `zzzz20261013090000_attendance_roster_member_source_ordinals`, the P25 member-source rollback registration, and the legacy membership error provenance stay on this tree. The generated P25 census test expects 112 sites and passed locally. Pins recomputed on this merge tree: 63 SHA-256 values, 66 leaf fields, 0 differing fields. The pin file was not rewritten. `sealed-export-package-provenance.test.cjs` passed locally on Node v22.23.3.

The attendance real-DB step still sets `DATABASE_URL` and `ATTENDANCE_TEST_DATABASE_URL` and does not set `EXPECT_DB`. The approval real-DB step still sets `EXPECT_DB: '1'`.

## 14. Alignment to main 7960c8f42 (2026-10-13)

Draft #6051 was merged onto `origin/main` `7960c8f4203ff837e8bf204b25067f761aaca151` (#5749, parent `5700830d15a8aad16043b94bec0ed6fc7e413c7a`). Nothing had landed past that SHA at fetch time. The previous alignment baseline was `67874b9bcd73d686796f57bcddf9e6aa47080a7b`. Zero conflicts. Harold approved folding the sensitive-path commits and re-running required checks. Workflow files came from main unchanged by this branch: `plugin-tests.yml`, `attendance-web-guard.yml`, `approval-realdb-projection-key-parity.yml`, and `multitable-realdb-context-read-verdict.yml` keep literal `ubuntu-latest` on `runs-on`.

Five commits since the previous baseline.

| Commit | What | Sensitive paths |
|---|---|---|
| `c5ad041df1b7` #6362 | Management-center help guide and Chinese admin controls. | `attendance-web-guard.yml`, `attendance-web-guard-workflow.spec.ts` |
| `effa221b03d4` #6376 | Post-R66 demo role annotation. | none |
| `f024deba3813` #6378 | R66 on-site record. | none |
| `5700830d15a8` #6377 | Formula-field create button stays idle until save starts. | none |
| `7960c8f4203f` #5749 | GET `/context` sheet read verdict from the shared resolver. | `approval-realdb-projection-key-parity.yml`, `multitable-realdb-context-read-verdict.yml`, `univer-meta.ts`, `vitest.config.ts` |

The roster org gate, streamed roster preview, `ensure_member` optional `sourceOrdinals` (the five member keys plus that field), migration `zzzz20261013090000_attendance_roster_member_source_ordinals`, the P25 member-source rollback registration, and the legacy membership error provenance stay on this tree. The generated P25 census test expects 112 sites and passed locally. Pins recomputed on this merge tree: 63 SHA-256 values, 66 leaf fields, 0 differing fields. The pin file was not rewritten. `sealed-export-package-provenance.test.cjs` passed locally on Node v22.23.3.

The attendance real-DB step still sets `DATABASE_URL` and `ATTENDANCE_TEST_DATABASE_URL` and does not set `EXPECT_DB`. The approval real-DB step still sets `EXPECT_DB: '1'`.

## 15. Alignment to main d86cf921 (2026-10-14)

Draft #6051 was merged onto `origin/main` `d86cf921d852cc46ab4d17760f0bdf0c1161727a` (#6391). Nothing had landed past that SHA at fetch time. The previous alignment baseline was `7960c8f4203ff837e8bf204b25067f761aaca151`. Fourteen commits. Workflow files came from main: `plugin-tests.yml`, `attendance-web-guard.yml`, and `stock-prep-browser-verify.yml` keep literal `ubuntu-latest` on `runs-on`.

Five files conflicted, all in the attendance group-effect path. Resolution keeps both sides. The org-membership check still runs before any group or member insert, including inside main's timezone source-change wrapper on `POST /api/attendance/groups/:id/members`. `HttpError` responses use `attendanceHttpErrorBody`, so `USER_NOT_IN_ORG` still carries `details`. The group-effect fixture keeps `users` / `user_orgs` and main's timezone policy tables. Membership tests prepare the timezone source proof first, then still reject an inactive member before insert and still hold `FOR SHARE` until commit. Main's unprepared-writer, stale-proof, and verifier-rollback tests stay.

The roster org gate, streamed roster preview, `ensure_member` optional `sourceOrdinals`, migration `zzzz20261013090000_attendance_roster_member_source_ordinals`, the P25 member-source rollback registration, and the legacy membership error provenance stay on this tree. That migration shares its timestamp prefix with main's `zzzz20261013090000_create_attendance_business_trips`. The prefix-uniqueness guard allowlists that exact pair; neither filename was renamed. The deactivation worker fixture also applies the timezone policy migration and a noop source guard, so the membership failure is still `USER_NOT_IN_ORG` after the timezone proof. The snake_case assignment in the plugin integration test is created before that user becomes an active org member, so the already-started window is not inside the timezone source scan. The generated P25 census test expects 112 sites and passed locally. Pins recomputed on this merge tree: 63 SHA-256 values, 66 leaf fields, 0 differing fields. The pin file was not rewritten.
