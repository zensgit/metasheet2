# 班次/轮班分派写守卫：与 view 同一交集口径

> **文档性质：实现设计（本 PR）**  
> **日期**：2026-09-23  
> **基准**：`main` @ `261835ad2`  
> **问题**：#5988  
> **不合并**。不依赖其它未合并的考勤修复 PR。不改 O3 组负责人 fail-closed。

## 问题

`assertAttendanceScheduleAssignmentDispatchAllowed` 把窗口内**全部** `schedule_group_id` 放进 target，再走 `attendanceSchedulerScopeMatchesTarget`（`targets.every` 全覆盖）。

同一 `dispatch` 的 auto-shift 系统写，以及 export / import / approve / remind，走 `attendanceSchedulerScopeAllowsActorActionFacts`：只对 scope **已约束**的维度做交集。`GET /assignments` 的 `buildAttendanceAssignmentViewSql` 是 `EXISTS`：窗口重叠的**任一条**成员行满足该 scope 的组条件即可。

因此员工同时属于排班组 A+B、scope 只覆盖 A 时，view / export / auto-shift 放行，`POST/PUT/DELETE` 分派返回 `SCHEDULER_SCOPE_FORBIDDEN`。仅 `userIds`、`scheduleGroupIds: []` 的 scope 也会被空组列表的全覆盖误杀。

## 决定

写路径改为调用**已有** `attendanceSchedulerScopeAllowsActorActionFacts(..., 'dispatch', facts)`，不新增第三套匹配。

事实按 **view 的 EXISTS** 组装，避免写比 view 更宽：

1. 成员窗口与 `buildAttendanceAssignmentViewSql` 相同：重叠，不是 export 的「整段必须被一条成员覆盖」。
2. **每一条**成员行单独做 facts（该行的 `schedule_group_id`、排班组上的 `attendance_group_id`、`department_ref`，加上 `userIds: [该员工]`）。禁止把 A 的组与 B 的部门并成一次交集。
3. 投影掉 `roles` / `roleTags`。view SQL 不使用这两维；roles-only scope 投影后无约束维度，helper 返回拒绝。带 view 维度的 scope 不被 role 额外否决。
4. **零成员仍 403**，先于 scope 查询。比 userIds-only 的 view/export 更严，保持「先入排班组再分派」，不放宽。
5. `fullAdmin` 仍跳过 scope。排班组成员增删仍走单组 `assertAttendanceSchedulerScopeAllowed`，不在本次范围。

O3（`canManageAttendanceGroup`、固定班 preview 的组负责人、apply/rebuild/clear 不下放）不改。自动对班 apply 仍先要求 `mode === 'apply'`，之后才进入本守卫。

## 非目标

- 不把 export 的整段覆盖或跨行并集改成 view 口径。
- 不把 view SQL 改成全覆盖。
- 不放宽 O3 apply。
