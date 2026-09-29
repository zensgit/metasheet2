# 员工总览 section id 归位验证（#5966）

> 对应设计 `docs/development/attendance-overview-section-id-swap-design-20260923.md`。未合并。

## 命令

在仓库根目录，依赖安装为 `pnpm install --filter @metasheet/web...`（exit 0）。

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-selfservice-dashboard.spec.ts \
  tests/attendance-overview-priority.spec.ts \
  tests/attendanceOverviewRequestReveal.spec.ts \
  tests/attendance-context-help-wiring.spec.ts \
  tests/attendance-experience-entrypoints.spec.ts \
  tests/attendance-admin-anchor-nav.spec.ts \
  tests/AttendanceAdminTaskHome.spec.ts
```

结果：7 files, 196 tests, 全部通过（vitest 1.6.1，约 21s）。

## 断言对应

- 总览 `#attendance-overview-anomalies` 的标题是 Anomalies，且不在补卡折叠卡内。总览上不存在 `#attendance-overview-request-report`。
- `initialSectionId=attendance-overview-anomalies` 时补卡折叠卡保持关闭，`scrollIntoView` 的目标包含异常卡、不包含补卡折叠卡。插件加载门禁结束后才会滚到该卡（加载中卡片尚未挂载）。
- pending 跟进按钮文案是 View my requests，点击后打开「我的申请」折叠卡，不滚到异常列表。无异常时关注条 `request_pending` 的「去处理」同样打开该折叠卡。
- 异常行 Create request 打开专用补卡卡，选中该行，可见时间预填为同日班次 `2026-04-15T09:00`，共享折叠卡保持关闭。
- reports 模式 `#attendance-overview-request-report` 仍在申请报表卡上，且没有 anomalies id。

## 未在浏览器里走通

本环境没有可用的考勤后端与插件进程。员工总览依赖 `pluginLoading` 结束后的真实接口，未启动整套服务，因此没有做浏览器点击。上面的 vitest 用例挂载的是 `AttendanceView.vue` 本身，覆盖了 id、滚动目标和按钮路径。
