# 验证：考勤默认工作日与负责人名册上限（#6023 / #6024）

> 对照设计：`docs/development/attendance-civil-date-roster-caps-design-20260923.md`  
> 基准：`main` @ `261835ad2dea6331e7880893e781b7f7c3439588`。未合并。

## 结果

- 手动欠卡默认 `from`/`to` 与决策追踪 admin/self 的默认 `workDate` 来自 `attendanceCivilDateWindow`（`formatAttendanceDateKey` + 日历日减 30）。时区优先本人考勤规则 IANA，否则用组织默认规则里服务端返回的 IANA。无效时区留空，不用 UTC、不用浏览器本地日。
- 操作者改过的日期字段，在规则时区稍后到达时不被覆盖。
- 负责人与成员列表请求 `pageSize=200`，读取 `total`。超过已加载行数时显示「Showing X of Y」和「加载更多」；51 条负责人在一页内全部出现，不再停在默认 50。

## 命令

```bash
pnpm install --frozen-lockfile --filter @metasheet/web...
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-civil-date-window.spec.ts \
  tests/attendance-catalog-page.spec.ts \
  tests/attendance-civil-date-roster.spec.ts \
  tests/attendance-admin-anchor-nav.spec.ts \
  tests/attendance-decision-trace-wiring.spec.ts \
  tests/attendance-admin-regressions.spec.ts
```

2026-09-23 本地结果：上述 6 个文件 **199 passed**（新规格 14，回归 185）。

## 未覆盖

- 未跑整包 `vue-tsc` / `pnpm validate:all`。
- 未做浏览器手测；日期与名册行为由 jsdom 里的 `AttendanceView` 规格驱动。
- 后端 `resolveAttendanceDateRange` 与 `rules/me` 的 `asOf` 仍按 UTC 兜底，本 PR 不改。
- `useAttendanceAdminRulesAndGroups.ts` 中未接到本页的成员 loader 仍不传 pageSize。
