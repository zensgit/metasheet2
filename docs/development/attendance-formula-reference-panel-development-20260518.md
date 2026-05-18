# 考勤公式函数参考面板与编辑体验补强 开发记录

Date: 2026-05-18

## Summary

P2 frontend-only slice：在既有公式参考面板（#1615）与内联编辑器（#1617）之上做增量补强，不重写组件、不动后端、不改公式计算语义、不改 `attendance_*` 事实源、不直接写 `meta_*`。

四项 gap：
1. 函数参考面板加 per-function 描述 + 示例（鼠标悬停 `title=`）
2. 独立的"禁用函数"块（NOW / TODAY / 查找函数 / 跨表引用 / 自定义脚本），既有的一句话提示保留以兼容现有测试
3. 引用范围可切换的 toggle（Record / Summary），文案随之变化
4. 内联编辑器内提示用户去看上方参考面板的辅助行

并把目录里"已启用且非公式"的字段动态派生成可引用 chips（与既有 4 个静态 chips 共存），在有 field filter 时抑制（与依赖图相同的 `hasActiveFieldFilters` 抑制模式）以避免污染搜索测试的全文断言。

## Background

`docs/development/attendance-dingtalk-formula-todo-20260515.md` P2 backlog 第三项「内联公式编辑器与函数参考面板」由 #1615 / #1617 落地了主体（参考面板 + 内联预览/保存）。本 slice 补齐：
- 现有面板把所有函数堆在 chips 中，没有 per-function 描述；用户不知道 `DATEDIF` 第三个参数能传什么
- 禁用函数信息以一行文字呈现，权重过低；管理员不容易意识到 NOW/TODAY 为什么不能用
- "Record / Summary" 仅在编辑器的 select 中体现，参考面板没有给到 scope-aware 的引用提示
- 内联编辑时用户看不到任何对参考面板的回指，新管理员易于迷失

后端公式预览 / 保存接口（`POST /api/attendance/report-fields/formula/preview` + `PATCH /api/attendance/report-fields/:code/formula`）已经成熟，无需触碰。所有补强都在 Vue 模板 / 脚本 / 样式层完成。

## Frontend

`apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`

**Script 新增（紧邻 `reportFields` 声明之后）：**
- `formulaReferenceDisabled`（5 条：now / today / lookup / cross-table / scripts，每条 name + description）
- `formulaFunctionDocs`（29 函数 → `{ description, example }`，覆盖 IF / AND / OR / NOT / ROUND / CEILING / FLOOR / ABS / MIN / MAX / SUM / AVERAGE / COUNT / COUNTA / DATEDIF / DATEDIFF / DATE / YEAR / MONTH / DAY / CONCAT / CONCATENATE / LEFT / RIGHT / MID / LEN / TRIM / UPPER / LOWER；示例里禁用了 NOW/TODAY，全部使用字面日期 + 现有字段 code）
- `formulaFunctionTooltip(fn)`：`title=` 文案组装器，输出 `<FN> — <description> Example: <example>`
- `formulaReferenceScope` ref + `setFormulaReferenceScope(scope)`：参考面板独立的范围 ref（不与编辑器 `formulaDraft.formulaScope` 耦合）
- `formulaReferenceScopeHint`：scope-aware 一句话提示
- `STATIC_FORMULA_REFERENCE_CHIPS` set + `formulaReferenceableCodes` computed：从 `reportFields` 派生「enabled 且非 formula 且非静态占位」的 code 列表

**Template 增量（4 处）：**
1. **Field references 块**（lines 159-190）：在标签下、chips 上方新增 toggle（两个按钮，`aria-pressed` 反映当前 scope）+ 一句 scope hint；既有 4 个静态 chips 原位保留；其后动态追加目录派生 chips，但当 `hasActiveFieldFilters` 为真时短路为空（与依赖图同模式）
2. **Allowed functions 组**（line 207-215）：每个 group div 加 `data-report-field-formula-reference-group="<id>"`，每个 `<code>` 加 `:title=` + `data-report-field-formula-function="<fn>"`
3. **Disabled functions 块**（接在 Examples 块后、Create-formula 之前）：独立 reference-block，列出 5 条 li，附 `<code>` chip + 文字说明
4. **Inline editor 顶部辅助行**（紧贴 `data-report-field-formula-editor` 之内、Expression label 之前）：单行 hint，指向上方参考面板，并提醒"保存前请预览"

**Style 新增（CSS scoped）：**
- `.attendance-report-fields__formula-reference-scope` + `-btn` + `-btn--active`：toggle 按钮 pill 样式
- `.attendance-report-fields__formula-reference-disabled`：禁用函数列表
- `.attendance-report-fields__formula-editor-help`：内联编辑器辅助行

## Tests

`apps/web/tests/AttendanceReportFieldsSection.spec.ts` 新增 6 项（既有 13 → 19）：

1. `renders all six function reference groups with descriptions and examples in tooltips`
   - 6 组 id 顺序断言（condition / logical / math / aggregate / date / text）
   - 函数 chip 总数 = 29
   - `IF` title 包含 description + `Example:` + `IF({attendance_days}>0,1,0)`
   - `SUM` title 包含 `summary scope` 暗示
   - `DATEDIF` title 包含完整示例 `DATEDIF({work_date},DATE(2026,12,31),"D")`（验证示例没有引用禁用的 TODAY）

2. `renders the dedicated disabled-functions block with five entries`
   - `[data-report-field-formula-reference-disabled]` 块存在
   - 5 条 li id = `now / today / lookup / cross-table / scripts`
   - 文案含 `Non-deterministic` / `VLOOKUP` / `Spreadsheet-style references` / `Free-form scripts`

3. `toggles the formula reference scope and updates the scope hint`
   - 初始 record 按钮 `aria-pressed=true`、summary `false`
   - hint 含 `Record scope` + `reads the row value directly`
   - 点击 summary → 按钮 aria-pressed 翻转、hint 含 `Summary scope` + `SUM, AVERAGE, COUNT, or COUNTA`
   - 点回 record 恢复

4. `renders catalog-derived referenceable chips, excluding formula and disabled fields`
   - `employee_name` / `punch_result` / `attendance_days` / `leave_duration` 在 chips
   - `late_count`（formulaEnabled=true）不在
   - `workday_overtime_duration`（enabled=false）不在

5. `shows the inline editor help line pointing to the reference panel when editing`
   - 进入编辑前 help 元素为 null
   - 点击 Edit → help 出现，文案含 `function reference panel above` + `Preview before saving`

6. `surfaces preview errors from the existing formula preview endpoint`
   - mock 预览返回 `{ ok: true, data: { ok: false, error: 'Reference {foo} is not allowed in v1.' } }`
   - 断言 apiFetch 被以正确 method/body（含 `formulaScope: 'record'`）调用了既有 endpoint
   - 断言 `[data-report-field-formula-preview-result]` 同时含 `Preview error` 与原始错误字符串
   - 锁定 "error states show"——preview 失败不仅不 throw，还在 UI 上对用户可见

## Constraints honored

- 不重写既有面板/编辑器；既有 13 项 spec 全部保留通过
- 不改后端：preview 走既有 `POST /api/attendance/report-fields/formula/preview`，save 走既有 `PATCH /api/attendance/report-fields/:code/formula`
- 不增客户端 validator
- 不改 `attendance_*` 事实源、不直接写 `meta_*`
- 不触碰 `plugins/plugin-attendance/index.cjs`（本 slice diff 为空）
- 既有「NOW, TODAY, lookup functions, ...」一句话提示原位保留，确保 #1615 已锁定的 panel content 断言不破坏

## Changed files

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue` | +script(disabled / docs / tooltip / scope ref + setter + hint / referenceable codes)、+template(toggle / hint / dynamic chips / per-fn title / disabled block / editor help line)、+CSS(scope toggle / disabled list / editor help) |
| `apps/web/tests/AttendanceReportFieldsSection.spec.ts` | +5 tests covering augmentation |
| `docs/development/attendance-formula-reference-panel-{development,verification}-20260518.md` | 本 slice 文档 |
