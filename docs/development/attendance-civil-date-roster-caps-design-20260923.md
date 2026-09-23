# 考勤默认工作日与负责人名册上限（#6023 / #6024）

> 实现设计。基准：`main` @ `261835ad2dea6331e7880893e781b7f7c3439588`。  
> 不依赖其它未合并的考勤修复 PR。

## 问题

1. **#6023** 管理端手动欠卡提醒的默认 `from`/`to`，以及决策追踪 admin/self 的默认 `workDate`，用 `Date#toISOString().slice(0, 10)` 取 **UTC 日历日**。同页总览「今日」已经走 `formatAttendanceDateKey(..., resolvedAttendanceTimezone)`。浏览器日或 UTC 日与考勤规则 IANA 不一致时，未改日期就加载欠卡候选，工作日窗口会偏一天。
2. **#6024** `GET /api/attendance/groups/:id/managers` 的 `parsePagination` 默认 `pageSize=50`、上限 200，响应带 `total`。前端不传分页、不读 `total`，负责人超过 50 条时表格和「N owner(s)」计数都静默少人。成员列表已读 `total` 并披露，但请求仍落在默认 50。

## 决定

### 工作日默认（#6023）

- 纯函数放在 `attendanceDateTimePresentation.ts`：`shiftAttendanceDateKey` 对 `YYYY-MM-DD` 做**日历日**加减（UTC 日期分量，不走 30×24h，避免夏令时把端点再偏一天）；`attendanceCivilDateWindow(now, timeZone, 30)` 的 `to` 是 `formatAttendanceDateKey`，`from` 是再减 30 个日历日。时区无效或缺失时返回 `null`，**不**回退 UTC 或浏览器本地日。
- 页面时区：`resolvedAttendanceTimezone`（与总览「今日」同一条：本人 `rules/me` 的 runtime rule IANA；报表页仍是单一记录时区）。管理端补一次已有的 `loadSelfAttendanceRules()`，让这条 computed 在欠卡提醒页也能有值。
- 本人规则时区还没有时，用已加载的组织默认规则 `GET /api/attendance/rules/default` 里**服务端返回的** IANA（`normalizeAttendanceTimeZone`）。规则编辑表单上的浏览器时区兜底**不**参与默认日期。
- 两者都没有时，日期框留空，并提示操作者自选。不把空 `from`/`to` 伪装成合法窗口（后端该接口要求非空日期）。
- 用户改过的字段不再被后续时区到达覆盖。欠卡 `from`/`to`、admin `workDate`、self `workDate` 各自记「已改」。
- 不改后端 `resolveAttendanceDateRange` 的 UTC 兜底，也不改 `rules/me` 的 `asOf` 默认日。

### 名册上限（#6024）

main 上没有可复用的 catalog list helper（排班侧是各 loader 手写 `pageSize=200` + total 警告）。本 PR 在 `attendanceCatalogPage.ts` 放一个最小等价：目录页大小常量 **200**（与 `parsePagination` 的 `maxPageSize` 一致）、读取 `total`、合并后续页、`total > 已加载` 即还有更多。

- 负责人与成员的首次加载都带 `page=1&pageSize=200`。
- 负责人计数：已全部载入时仍是「N owner(s) · M sub-owner(s)」（只统计已加载行，此时等于全量）。未载完时改为「Showing X of Y owners」，避免把前 50/200 行的角色数当成全组人数。
- `total > 已加载` 时显示「加载更多」，下一页 `pageSize` 仍为 200，按 id 追加。追加页没有新行时，把 total 收到已加载行数，避免死循环的「加载更多」。
- 成员沿用已有「Showing X of Y members」，同样改为显式 200 和加载更多。成员总数同步仍用服务端 `total`。
- 不改后端分页，不加跳页 UI。`useAttendanceAdminRulesAndGroups.ts` 里另一份未接到 `AttendanceView` 的成员 loader 不动。

## 非目标

- 不修 #6000 欠卡候选分页、#6001 报表快捷区间、#6016 综合工时窗口，以及其它未合并考勤 PR 的清单。
- 不把负责人名册一次拉到超过目录上限（200）的单页。
- 不改考勤计算、打卡或审批语义。
