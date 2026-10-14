# 考勤总览引导去重 + 报表区间校验对齐（#5963 / #5964）

> **文档性质：本 PR 的短设计**  
> **日期**：2026-09-23  
> **基准**：`main` @ `261835ad2`（已含 #5942 的报表倒序校验；不依赖其它未合并的考勤修复 PR）  
> **议题**：[#5963](https://github.com/zensgit/metasheet2/issues/5963)、[#5964](https://github.com/zensgit/metasheet2/issues/5964)

## 1. 结论

| 议题 | main 上的事实 | 本 PR |
|---|---|---|
| #5963 | 未分配考勤组长文案在总览打三遍：打卡列 `data-selfservice-setup-hint`、今日待办 `setup_needed`、常用区 `selfServiceQuickActionHint` | 长文案只留在今日待办这一处 canonical 关注项 |
| #5964 | #5942 已关上。顶部「重载报表」和申请报表「重载报表」走 `validateReportDateRange()`；记录卡「重载」、导出、以及空/半边区间不走同一合同。空边被当成通过，`buildQuery` 省掉空参，后端 `resolveAttendanceDateRange` 回落 30 天，标签仍可写「区间未设置」 | 报表重载与导出共用同一校验；两端都必填；`from > to` 用现有明确错误拦住且不发请求 |

## 2. #5963 — 引导只出现一次

门禁 `selfServiceNeedsSetupHint` **不改**：无记录、无申请、无异常，且 summary 无正信号时才为真。优先级表也不改：`setup_needed` 仍是 design-lock §4.2 第 6 行，且无虚构 CTA。

刻意保留、不算重复挂载：

- 状态卡在同一门禁下仍写「当前区间内还没有考勤数据」。这是状态描述，不是那句考勤组引导。
- 打卡失败仍按 lock §4.1 / §9.2：状态条展示消息与重试，关注项 `presentedByStatusBanner` 不再给第二个操作。本 PR 不动这条。

去掉的两处挂载：

1. 打卡列 `data-selfservice-setup-hint`，以及只为它存在的 workspace props。
2. `selfServiceQuickActionHint` 在 `needsSetup` 时不再返回 `selfServiceSetupFollowupHint`。常用区回到已有的短句（跳到申请或记录），不新造文案。

验收：空组织新员工总览上「可能还未被分配到考勤组」只出现一次，且在今日待办。有记录/异常时该句仍不出现。

## 3. #5964 — 与已修报表路径同一套日期校验

纯函数 `attendanceReportDateRangeIssue`：

| 输入 | 结果 |
|---|---|
| `from` 或 `to` trim 后为空 | `missing` |
| 两端都有且 `from > to` | `inverted` |
| 两端都有且 `from <= to`（含相等） | 通过 |

`isAttendanceReportDateRangeValid` 改为「issue 为空」。因此报表日期框的 `aria-invalid` / `--invalid` 与重载守卫同步：空边也会标红。

用户可见错误：

- `inverted`：沿用「开始日期不能晚于结束日期。」
- `missing`：「开始日期和结束日期都需要填写。」

调用点（失败则 return，不发请求）：

- 已有：`reloadReportsWithStatus`、`reloadRequestReportWithStatus`（含报表刷新与预设，预设会先写入两端）
- 补上：`reloadRecordsWithStatus`、`changeRecordsPage`、`exportCsv`、`exportXlsx`

导出先校验日期，再走原有 `reportsExportBlocked`。这样「从未成功重载就清空日期」或倒序时，不会靠省略空参打到后端 30 天窗或 400。

不改后端 `resolveAttendanceDateRange` 的 30 天回落（直接调 API 的行为不变）。不把未填区间自动写回输入框。总览历史筛选的 Refresh 仍走 `refreshAll`，不在本 PR。

## 4. 非目标

- 不改考勤计算、审批、打卡、组 ACL。
- 不重开 #5942。
- 不合并。
