# 验证：考勤总览引导去重 + 报表区间校验（#5963 / #5964）

> **日期**：2026-09-23  
> **设计**：`docs/development/attendance-overview-setup-hint-report-range-design-20260923.md`  
> **基准**：`main` @ `261835ad2`  
> **未合并。** 未跑浏览器首屏 harness（`attendance-employee-overview-first-viewport.spec.ts`）。行为由下面的 jsdom 挂载测试覆盖。

## 1. 命令

```bash
pnpm install --frozen-lockfile --filter @metasheet/web...
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-reports-analytics.spec.ts \
  tests/attendance-selfservice-dashboard.spec.ts \
  tests/attendanceEmployeeQuickActionIcons.spec.ts \
  tests/attendance-overview-priority.spec.ts \
  tests/attendanceEmployeeWorkspacePresentation.spec.ts
```

结果：5 files, **136 passed**. 变异撤回后同一命令再跑，仍是 136 passed。

## 2. 正向

- 空组织总览：「you may not be assigned to an attendance group yet」只出现 1 次，在 `setup_needed` 待办里；打卡列没有 `data-selfservice-setup-hint`；常用区是短跳转句。状态卡仍保留「No attendance data is available in this range yet.」且没有那句考勤组引导。有异常数据的总览不出现该句。
- 记录卡「重载」、导出 CSV/Excel、顶部重载、申请报表重载：`from > to` 不发请求，状态为 “Start date must be on or before end date.”
- 清空 from 或 to：两端 `aria-invalid=true`，周期标签为 “Range not set”，上述重载/导出不发请求，状态为 “Both start and end dates are required.”
- 相等与正序区间的原有用例仍可加载。#5942 的顶部/申请报表倒序用例仍绿。

## 3. 变异（已撤回）

| 变异 | 变红的断言 |
|---|---|
| 去掉 `reloadRecordsWithStatus` 里的 `validateReportDateRange()`，并让常用区在 `needsSetup` 时再次返回长引导 | 记录卡倒序仍请求 `/api/attendance/records?from=2026-04-20&to=2026-04-10...`；总览长句出现次数 2 ≠ 1 |
| 空边重新当成通过（`attendanceReportDateRangeIssue` 对空边返回 null） | 清空开始日期后 `aria-invalid` 为 `false`；纯函数期望 `missing` 得到 `null` |

## 4. 未覆盖

- 总览历史「刷新」仍走 `refreshAll`，不经过这套报表校验。
- 后端省略 from/to 时仍回落 30 天；本 PR 只挡住报表 UI 的重载、翻页和导出。
- 记录翻页按钮在现有报表 mock 里是禁用的（总共 3 条），没有单独点击「下一页」；`changeRecordsPage` 与重载共用 `validateReportDateRange()`。
- 未在真实浏览器里点总览和报表。
