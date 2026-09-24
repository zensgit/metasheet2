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
- 条件复检失败仍是 `PRECONDITION_CHANGED`（`error` 为空），不带 index。真正写入前的适配器失败才记 `USER_NOT_IN_ORG` 和 index JSON。两条都会阻止成员 INSERT。
- 检查与 INSERT 之间没有 `SELECT … FOR UPDATE`。W4 写入前的再查盖住入队后的窗口，盖不住检查通过后、INSERT 之前的并发停用。
- W4 没有负责人写入。managers POST 仍是同步路径上的门。
- async preview 的 job `error` 在 `updateImportJobProgress` 里截到 2000 字符。HTTP 入队前的 404 带完整 index `details`。
- #5945（报表日期区间）不在本 PR 的改动里。在 `main` `f31a88663` 上重跑 `tests/attendance-reports-analytics.spec.ts` 为 **7/7 PASS**（含倒置区间拦截与相等/升序区间仍可加载）。本 PR 不修改该行为。

## 8. 口径

合成 id（`member-user-2`、`inactive-user`、`other-org-user`、`missing-user`、`not-in-this-org`）。无主机、口令、authorityCode。
