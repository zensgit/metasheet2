# 请假抵扣「部分扣（余下计缺勤）」诚实门禁（#6009）

> **文档性质：本 PR 的实现设计**
> **日期**：2026-09-23
> **基准**：`main` @ `261835ad2dea6331e7880893e781b7f7c3439588`
> **Issue**：#6009
> **本 PR**：设计 + 实现 + 验证；draft，不合并。不依赖其它未合并的考勤修复 PR。

## 0. 结论

`partial_unpaid_absence`（界面文案「部分扣（余下计缺勤）」）在本 PR **下线为 fail-closed**，不在本 PR 接线账4 缺勤分钟。

管理端不能再选中并保存该模式。已存规则在最终批准时返回 `422 LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE`，事务回滚：余额不动、申请保持 `pending`、`attendance_records` 不按全额请假投影。

唯一可执行的余额不足模式仍是 `block`（不足则整单阻断）。

## 1. 为什么不在本 PR 把 shortfall 写成缺勤

批准路径今天的事实（`plugins/plugin-attendance/index.cjs`）：

1. `deductLeaveBalance(..., mode:'partial')` 会返回 `shortfall`，调用点丢掉返回值。
2. `loadApprovedMinutes` / `loadApprovedMinutesRange` 按已批准申请的 `metadata.minutes` **全额**求和。报表上的请假分钟来自这里，不是来自余额扣减事件。
3. `upsertAttendanceRecord` 把该全额传进 `computeMetrics`。无打卡且 `leaveMinutes > 0` 时状态写成 `adjusted`。表上没有缺勤分钟列；`status='absent'` 是整日无打卡状态，不是「余下 N 分钟未付缺勤」。
4. 同文件注释写明 real absence 属于账4 / v1-4，v1-2b 只做账2 扣减。

把 shortfall 写对需要同时改：批准分钟的求和口径、余量的持久位置、以及每个读 `leave_minutes` 的报表面。那是账4，不是这个模式的小补丁。本 PR 不发明这套投影。

因此不采用「改名但仍部分扣、请假分钟改成已扣分钟」：余下分钟没有合同落点，运营仍会看到一个说不清的缺口。

## 2. 合同

| 入口 | 行为 |
|---|---|
| 管理端下拉 | 新规则只有「不足则阻断」。不提供可再次选中的「部分扣（余下计缺勤）」。卡片文案写明缺勤核算未上线。 |
| 已存 `partial_unpaid_absence` | GET / 正常化 **保留** 该值（不在读路径悄悄改成 `block`）。编辑器显示为禁用项，并提示必须改成阻断后才能保存。客户端在保存前拒绝，不发 PUT。 |
| `PUT /api/attendance/settings` | 请求体的 `rules` 里只要有该模式 → `422 LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE`，不写设置。只改 `enabled`、不带 `rules` 的局部 PUT 仍按原合并逻辑走，避免一张遗留规则卡住其它设置写入。 |
| 最终批准 | 规则启用、命中、且扣减池不是 `unpaid` 时，若 `insufficient === 'partial_unpaid_absence'`，在 `deductLeaveBalance` **之前**抛上述 422。余额、申请状态、当日考勤记录都不变。池子够不够扣都拒绝，避免「够扣就当 block、不够才拒绝」的半合同。 |
| `block` | 不变：不足则 `422 LEAVE_OFFSET_BALANCE_INSUFFICIENT` 并回滚；足够则全额扣。 |
| `deductLeaveBalance` 的 `mode='partial'` | 引擎保留，请假抵扣策略不再调用。注释不再把 `shortfall` 说成已经落到账3 缺勤。 |

`unpaid` 池不扣余额，`insufficient` 在该分支不参与。遗留的「不付 + partial_unpaid_absence」仍按不付请假批准（没有「少扣余额」这一半错误）。新的保存请求仍然 422，不能再写成该组合。

## 3. 非目标

- 不改 #5982 销假重算（本分支从当前 main 起，不并入其它开放 PR）。
- 不改 #5969 折天展示。
- 不新增缺勤分钟列、不改 `loadApprovedMinutes` 的求和、不做账4 结算套件。
- 不迁移已存 JSON。遗留值靠批准 fail-closed 挡住，直到管理员改成 `block` 再保存。

## 4. 测试要抓住的降级

- 去掉批准前的拒绝后，遗留规则会重新变成「少扣余额 + 全额请假投影」。集成测试要求该批准为 `422 LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE`，且余额不变、申请仍为 `pending`、当日无 `attendance_records` 行。
- 只在余额不足时拒绝、余额足够时改走 `block`，会被「池子 200、申请 60」这条抓住：必须同样 422，且余额仍是 200。
- 去掉 PUT 拒绝后，保存该模式会回到 200。集成测试要求 422 且已存规则不变。
