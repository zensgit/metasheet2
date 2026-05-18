# 考勤公式函数参考面板与编辑体验补强 验证记录

Date: 2026-05-18

## Commands Run

```bash
pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts --watch=false   # 环境级 pre-existing 失败,见下
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Results

| Check | Result |
| --- | --- |
| `AttendanceReportFieldsSection.spec.ts`(20 tests:13 baseline + 7 new) | **PASS,20/20** |
| `attendance-admin-regressions.spec.ts`(11 tests) | PRE-EXISTING FAIL,`window.localStorage.clear is not a function`(happy-dom env 问题,与本 slice 无关——验证方法:checkout `origin/main` 同步运行同样 11 全失败) |
| `vue-tsc --noEmit`(web 类型检查) | PASS,exit 0 |
| `pnpm --filter @metasheet/web build` | PASS,6.35s built |
| `git diff --check`(空白) | PASS |

## Hardening Evidence

### Augmentation #1 — function tooltips

`renders all six function reference groups with descriptions and examples in tooltips`

1. `[data-report-field-formula-reference-group]` 顺序 = `condition / logical / math / aggregate / date / text`
2. `[data-report-field-formula-function]` 总数 = 29(IF + 3 + 6 + 4 + 6 + 9)
3. `IF` chip 的 `title` 含 `IF` / `Conditional branch` / `Example:` / `IF({attendance_days}>0,1,0)`
4. `SUM` chip 的 `title` 含 `summary scope` 暗示
5. `DATEDIF` chip 的 `title` 含 `DATEDIF({work_date},DATE(2026,12,31),"D")`——示例未引用禁用的 NOW/TODAY

### Augmentation #2 — disabled-functions block

`renders the dedicated disabled-functions block with five entries`

1. `[data-report-field-formula-reference-disabled]` 块存在
2. 标题含 `Disabled functions`
3. `[data-report-field-formula-disabled-id]` 列表 = `['now', 'today', 'lookup', 'cross-table', 'scripts']`
4. 文案含 `Non-deterministic`(NOW/TODAY 说明)、`VLOOKUP`(lookup 说明)、`Spreadsheet-style references`(cross-table 说明)、`Free-form scripts`(scripts 说明)
5. 既有的一句话 hint `NOW, TODAY, lookup functions, ...`保留——既有断言 `renders the formula function reference panel` 仍 PASS

### Augmentation #3 — scope toggle + scope-aware hint

`toggles the formula reference scope and updates the scope hint`

1. 初始 `[data-report-field-formula-reference-scope-option="record"]` `aria-pressed=true`,summary `aria-pressed=false`
2. `[data-report-field-formula-reference-scope-hint]` 文案含 `Record scope` + `reads the row value directly`
3. 点击 summary 按钮:record `aria-pressed=false`、summary `aria-pressed=true`;hint 切换为含 `Summary scope` + `SUM, AVERAGE, COUNT, or COUNTA`
4. 点回 record 恢复——toggle 双向闭环

### Augmentation #3b — scope-aware referenceable chips

`renders catalog-derived referenceable chips, excluding formula and disabled fields`

测试 fixture `populatedCatalogPayload()` 含:
- `employee_name`(enabled=true,formula=false)→ chips contain ✓
- `punch_result`(enabled=true,formula=false)→ chips contain ✓
- `attendance_days`(enabled=true,formula=false)→ chips contain ✓
- `leave_duration`(enabled=true,formula=false)→ chips contain ✓
- `late_count`(enabled=true,formulaEnabled=true)→ chips NOT contain ✓
- `workday_overtime_duration`(enabled=false)→ chips NOT contain ✓

并且 chips 与既有 4 个静态 chips(`field_code` / `late_duration` / `leave_type_annual_duration` / `total_minutes`)不重复——`STATIC_FORMULA_REFERENCE_CHIPS` set 过滤生效。

### Augmentation #4 — inline editor help line

`shows the inline editor help line pointing to the reference panel when editing`

1. 进入编辑前 `[data-report-field-formula-editor-help="net_anomaly_minutes"]` 为 null
2. 点击 `[data-report-field-formula-edit="net_anomaly_minutes"]` → help 出现
3. 文案含 `function reference panel above` + `Preview before saving`

### Augmentation #4b — scope-aware static + catalog-derived chips（post-review fix）

`switches static chips to summary aliases and hides catalog-derived chips in summary scope`

针对 Codex 评论"summary scope still shows record-only/catalog-derived field chips"——把 chip 集合做成 scope-aware:

1. **Record scope**:
   - `[data-report-field-formula-static-chip]` = `[field_code, late_duration, leave_type_annual_duration, total_minutes]`(既有 4 个静态 chip)
   - `[data-report-field-formula-reference-code]` 数量 > 0(catalog-derived 渲染)
2. **切到 summary scope**:
   - 静态 chip 改为 `[total_minutes, leave_minutes, overtime_minutes, work_duration, late_duration, early_leave_duration]`——documented summary aliases
   - catalog-derived chips 数量为 0(隐藏 per-record 字段,避免误导)
   - hint 文案改为 "Summary scope — wrap field references in SUM, AVERAGE, COUNT, or COUNTA, or use documented summary aliases (e.g. {total_minutes}, {leave_minutes}). Preview validates against the active backend."——校验权显式交给后端
3. **切回 record scope**:静态 chips + catalog-derived 完全恢复
4. 前端不引入 client-side validator,真理仍由后端 `POST /formula/preview` 承担

### Augmentation #5 — preview error state surfacing

`surfaces preview errors from the existing formula preview endpoint`

1. mock `apiFetch` 第二次返回 `{ ok: true, data: { ok: false, error: 'Reference {foo} is not allowed in v1.' } }`
2. 点击 Edit、改表达式为 `={foo}+1`、点击 Preview
3. apiFetch 被以正确 method / headers / body（`{ expression: '={foo}+1', formulaScope: 'record' }`）调用既有 endpoint
4. `[data-report-field-formula-preview-result]` 文案含 `Preview error` + `Reference {foo} is not allowed in v1.`——既有 `formulaPreviewMessage` 错误分支落到 UI，对用户可见

### 行为锁定 — 既有 13 项 spec 全部保留

| 既有 test | 含义 | 状态 |
| --- | --- | --- |
| `renders the formula function reference panel` | 既有 4 chip + IF/SUM/DATEDIF/CONCAT + 既有 hint 一句话 | PASS |
| `filters report fields by text and operational state` | 搜索 `late_count` 后页面不应含 `employee_name` | PASS(动态 chips 在 `hasActiveFieldFilters=true` 时被抑制) |
| `previews and saves an existing custom formula field inline` | preview 走 `POST /formula/preview`、save 走 `PATCH /formula` | PASS |
| `creates a new custom formula field from the reference panel` | 创建公式字段流程 | PASS |
| 其余 9 项(分类/审批/同步状态/依赖图/源模式...) | 既有行为 | PASS |

合计 13 + 7 = 20 项全绿。

## Acceptance Criteria

- 函数参考面板覆盖 5 大类(条件 / 数学 / 聚合 / 日期 / 文本),实际拆为 6 组(条件 / 逻辑 / 数学 / 聚合 / 日期 / 文本),所有 29 函数都有 description + example tooltip ✓
- 禁用函数提示独立成块,覆盖 NOW / TODAY / 查找函数 / 跨表 / 自定义脚本 ✓
- Record / Summary 引用范围 toggle 可切换,hint 文案随之变化 ✓
- 目录中"已启用且非公式"的字段动态进入可引用 chips,公式字段与已禁用字段被排除 ✓
- 内联编辑器加入辅助行,提示用户去看参考面板并预览 ✓
- preview 与 save 仍走既有后端 API,未改 endpoint / body shape / method ✓
- preview 错误路径在 UI 上对用户可见(锁定计划中 "error states show" 第六项) ✓
- 未触碰 `plugins/plugin-attendance/index.cjs`,未新增 `attendance_*` 迁移,未直接写 `meta_*` ✓
- web 类型检查 + build + `git diff --check` 全部 PASS ✓
- 静态 chips + catalog-derived chips 均按 scope 切换,summary scope 不再误导 admin 引用 per-record 字段(回应 Codex post-review findings) ✓
- 20 项 spec 全绿,环境级 `attendance-admin-regressions` 失败已确认为 happy-dom pre-existing,与本 slice 无关 ✓

## Out of scope (future)

- 把 `title=` tooltip 升级为受控 popover(更适合长 description / 代码块 / 跳转锚点),需要新的 UI 组件
- 在内联编辑器内点击参考函数 chip 直接 insert 到表达式光标处——需要 textarea 光标 API + 写一组小的 insert 工具
- 周期汇总级公式(P2 backlog)——本 slice 只在 hint 文案里提示用户用 SUM/AVERAGE/COUNT/COUNTA;真正的 summary-scope evaluation 仍由后端 `formulaScope='summary'` 路径处理
