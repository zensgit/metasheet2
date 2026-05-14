# 考勤统计字段多维表底座验证记录

日期：2026-05-13（2026-05-14 于 `codex/attendance-report-fields-foundation-20260514` 重跑）

## 目标

验证考勤统计字段目录已经通过插件 multitable API provision，前端管理中心可以展示固定、基础、出勤、异常、请假、加班六类字段，并且原有考勤事实源与导入/回滚链路不被迁移或改写。

## 覆盖项

- 后端字段目录 descriptor 稳定性。
- `projectId = ${orgId}:attendance`。
- 插件通过 `context.api.multitable.provisioning.ensureObject()` 和 `records.createRecord()` provision/seed 字段目录。
- 多维表配置缺失时，聚合接口降级返回内置字段。
- 前端统计字段区块展示字段分类、启用状态、报表可见状态，并生成多维表入口。
- 管理中心左侧 rail 新增“统计字段”导航。
- 记录表使用字段配置渲染列，配置不可用时回退到原有核心列。
- JSON/CSV 导出复用同一字段配置，并返回字段指纹响应头。
- CSV 导出支持字段名称和字段编码两种表头模式。

## 验证命令

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts --reporter=dot
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-anchor-nav.spec.ts --watch=false
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts --watch=false --reporter=dot
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web build
git diff --check
```

## 结果

- `node --check plugins/plugin-attendance/index.cjs`：通过。
- `attendance-report-field-catalog.test.ts`：7 个后端单元测试通过。
- `AttendanceReportFieldsSection.spec.ts` 与 `attendance-admin-anchor-nav.spec.ts`：25 个前端测试通过。
- `attendance-admin-regressions.spec.ts`：11 个前端回归测试通过，覆盖记录表字段配置、JSON/CSV 导出字段指纹、CSV label/code 表头和配置降级提示。
- `pnpm --filter @metasheet/core-backend build`：通过。
- `pnpm --filter @metasheet/web type-check`：通过。
- `pnpm --filter @metasheet/web build`：通过；Vite 仅输出既有 large chunk / dynamic import warning。
- `git diff --check`：通过。

## 备注

当前 Node 运行环境会暴露实验性的 `globalThis.localStorage` 空对象，导致 jsdom 用例里的 `window.localStorage` 没有 `getItem/clear` 方法。前端 Vitest 命令使用 `NODE_OPTIONS=--no-experimental-webstorage` 让 jsdom 接管 Web Storage；同时 `useLocale` 增加了轻量防御判断，避免真实运行时遇到异常 storage 形状时中断页面初始化。

## 当前结论

实现已按方案完成并通过目标验证。考勤领域数据源仍为 `attendance_*` 表，多维表只作为统计字段目录与报表配置层。
