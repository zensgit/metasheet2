# 考勤组花名册写入：活跃组织成员门 — 验证记录（2026-09-24）

> Design: `docs/development/attendance-group-roster-org-membership-gate-design-20260924.md`  
> 基准：`main` @ `f31a88663d5dcb7a290b6237abff53d8c43d55fe`  
> 证据：本地 vitest；合成 fixture；values-free。无真实租户、无浏览器。

## 1. Verdict

**PASS** locally for the roster-write gate this PR claims: group member and group manager inserts fail closed with 404 `USER_NOT_IN_ORG` when the target is not an active member of the actor org, a mixed member batch inserts nothing, and the #5899 owner-adds-member path still returns 200 for an active member.

Not a merge, deploy, or product-acceptance verdict.

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

三种负向（停用、他组织、不存在）在 API 上是**同一个空结果**：谓词不返回该 id。单测用不同 userId 分别打，响应码与 `details` 相同，不提供「用户是否存在于他组织」的区分。

## 3. Commands and results

`main` SHA：`f31a88663d5dcb7a290b6237abff53d8c43d55fe`。#5945 重跑时 `HEAD` 仍是该 SHA，且 `apps/web` 报表文件无本地改动。

```bash
# 本 PR 的组路由单测（含新增门 + #5899 回归）
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-uuid-validation-routes.test.ts
# Test Files  1 passed (1)
# Tests  109 passed (109)

# 考勤插件既有 unit 套件（tests/unit/attendance*）+ O3 源扫描
cd packages/core-backend && pnpm exec vitest run \
  tests/unit/attendance*.test.ts \
  tests/unit/attendance*.spec.ts
# Test Files  96 passed (96)
# Tests  1744 passed (1744)
# 其中 attendance-advanced-scheduling-scope.test.ts 7 passed
# 其中 attendance-uuid-validation-routes.test.ts 109 passed

# #5945 回归（issue #5942）：main tip，未改报表代码
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-reports-analytics.spec.ts
# Test Files  1 passed (1)
# Tests  7 passed (7)
# 含 blocks inverted report ranges… 与 keeps equal and ascending report ranges loadable
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

断言已恢复。恢复后全文件 **109 passed**。

负责人 POST 与成员 POST 共用 `assertActiveOrgMemberUserIds`。去掉负责人调用会让 `rejects an admin manager add for %s` 变成 200（mock 在 INSERT 被调用时返回成功行）。谓词文本被 `expectActiveOrgMemberPredicate` 锁住：`FROM user_orgs uo`、`JOIN users u`、`uo.is_active = true`、`u.is_active = true`、`uo.user_id = ANY($2::text[])`。

## 5. 未跑 / 测不到的降级

- 无真实 PostgreSQL。`ANY($2::text[])` 与 `user_orgs.user_id text` 的类型匹配没有在库上执行。单测桩按参数过滤，不执行 SQL。
- 无浏览器。管理端粘贴框 / global-scope 负责人选择器未点。
- **排班组** `POST /api/attendance/schedule-groups/:id/members` 仍不查 `user_orgs`（#6045 可选残留，本 PR 明确不做）。
- **导入** `insertAttendanceGroupMembers` 仍按 CSV 解析出的 userId 批量 INSERT，不走本门。
- 已经落库的幽灵成员/负责人 **不会**被本 PR 清掉。
- 检查与 INSERT 之间没有 `SELECT … FOR UPDATE`。并发把用户停用，仍可能在检查通过后插入。事务只保证「检查失败则本语句不提交」。
- 单测分不出「停用成员关系」和「用户行 `is_active = false`」的 SQL 执行差异；两者都靠谓词文本 + 空结果拒绝。删掉其中一列 `is_active` 会红在文本断言，不会红在「另一种停用仍然 200」的行为差上——因为桩不解释 SQL。
- #5945（报表日期区间）不在本 PR 的改动里。在 `main` `f31a88663` 上重跑 `tests/attendance-reports-analytics.spec.ts` 为 **7/7 PASS**（含倒置区间拦截与相等/升序区间仍可加载）。本 PR 不修改该行为。

## 6. 口径

合成 id（`member-user-2`、`inactive-user`、`other-org-user`、`missing-user`、`not-in-this-org`）。无主机、口令、authorityCode。
