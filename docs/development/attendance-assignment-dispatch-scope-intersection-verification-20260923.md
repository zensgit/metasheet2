# 验证：班次/轮班分派写守卫交集口径（#5988）

> **日期**：2026-09-23  
> **设计**：`docs/development/attendance-assignment-dispatch-scope-intersection-design-20260923.md`  
> **基准**：`main` @ `261835ad2`  
> **不合并**。

## 命令

```bash
pnpm install --filter @metasheet/core-backend... --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-advanced-scheduling-scope.test.ts \
  tests/unit/attendance-uuid-validation-routes.test.ts \
  --reporter=dot
```

结果：2 files，113 tests，全部通过。

## 锁住的行为

| 场景 | 期望 | 测试 |
|---|---|---|
| 成员 A+B，scope 仅 A，`dispatch` | `POST /assignments` 201，有 INSERT | `lets scoped dispatch write a worker who also belongs to a schedule group outside the scope` |
| 仅 `userIds`，员工已有排班组成员 | 201 | `lets a userIds-only dispatch scope write a worker who already has schedule group membership` |
| 组约束在 A、部门约束在 B，没有同一条成员同时满足 | 403，无 INSERT | `rejects dispatch when schedule group and department constraints are only satisfied by different memberships` |
| 仅 `roles` | 403 | `rejects a roles-only dispatch scope even when the worker has schedule group membership` |
| 零成员 | 403，不查 scope、不写 | 原有 `rejects scoped shift assignment dispatch without resolved schedule group membership` |
| 更新必须同时盖住旧目标与新目标 | 403 | 原有 `requires scoped shift assignment updates to cover both existing and next targets` |
| 全覆盖 `MatchesTarget(A+B)` 仍为 false；单行 A 的 dispatch helper 为 true | 纯函数 | `authorizes assignment dispatch from one in-scope membership instead of full group coverage` |
| 班次与轮班的 POST/PUT/DELETE 都调用同一守卫 | source scan | `guards the new scheduling group...` |

O3 相关用例（组负责人 preview 可过、apply/rebuild/clear 不走 `canManageAttendanceGroup`、owner 不能改花名册）仍在同一文件里通过，本 PR 未改那些路由。

## 承重（去掉守卫会红）

- 写路径改回「全部 membership → `assertAttendanceSchedulerScopeAllowed`」：多成员用例与纯函数用例变红（全覆盖对 A+B 为 false）。
- 把多行并成一次 facts 交集：跨行组+部门用例变红。
- 去掉零成员 403：原有无成员用例变红。
- roles-only 被投影后的空 scope 若改成放行：roles-only 用例变红。

## 这些测试抓不到的降级

- mock 不解析日期谓词。把重叠窗口改成 export 的整段覆盖，当前用例仍绿，但「只与窗口部分重叠」的成员会在真实库上被拒绝，而 view 仍可见。
- mock 的 `attendance_group_id` 为空。若改成用员工的 `attendance_group_members` 而不是排班组上的 `attendance_group_id`，当前用例仍绿，写可能宽于 view。

## 未跑

- 未跑 integration / 浏览器。变更在插件守卫与单测，无 UI。
- 未合并。
