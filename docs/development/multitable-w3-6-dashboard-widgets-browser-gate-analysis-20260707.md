# W3-6 · 仪表盘非图表 widgets · browser-gated 语义解锁分析（PROPOSED）

> 状态：**PROPOSED — 分析 + 解锁判定**。docs-only。
> 背景：goal-pool 把 W3-6「仪表盘 B4 非图表 widgets 批」标 🔒，门禁理由=**"先核 browser-gated 语义再解锁"**。本文做这个核实并给出解锁判定。
> 模型分档：分析/设计 = Fable；后续 widget 实现 = Sonnet。

## 1. 核实结论：browser-gate 担忧**基本不成立**（当前 widget 是 jsdom 可测的）

读 `MetaDashboardView.vue`（origin/main）核实：
- **非图表 widgets 已存在（B4 已落）**：metric/number card（`:125`）、text widget（`data-widget="text"` `:139`）、filter widget（`data-widget="filter"` `:150`），加"新增非图表 widget"模态（metric/text/filter，`:222-234`）。
- **resize 是 `<select>`（small/medium/large，`:96`）**——不是拖拽网格；**无** drag-drop / gridster / ResizeObserver / getBoundingClientRect 测量（grep 未见）。
- **已有可挂载 FE spec**：`apps/web/tests/multitable-dashboard-view.spec.ts`（jsdom 挂载），+ 一批后端 dashboard golden（authz/rowdeny/preview-data/level-filter）。

→ 当前非图表 widget 的**交互都是 select/表单/模态**，**jsdom 可测**；"browser-gated"的真正触发条件（拖拽布局、像素测量、响应式 reflow 断言）**当前不存在**。**所以 W3-6 可以解锁**——它不需要 Playwright 前置，就能按既有 FE-spec + 后端 golden 模式做。

## 2. 唯一的真 browser-gate 边界（划清，避免未来踩）

**只有当**未来 widget 引入以下之一，才需要真浏览器（Playwright）：
- 拖拽重排 widget 网格（drag-drop grid layout）；
- 依赖真实像素测量的自适应（ResizeObserver / getBoundingClientRect 驱动的 reflow）；
- 依赖真实渲染的图表截图/视觉回归。

**本 W3-6 批明确不做上述**——保持 select/表单/模态交互，jsdom 可测。若哪天要做拖拽网格，那是**独立立项 + Playwright 前置**，不在本批。

## 3. W3-6 批范围（解锁后可做，⬜）

在既有 metric/text/filter 之上，补一批 **jsdom 可测的非图表 widget**（每个走既有 preview-data field-read-enforced 路径 + 后端 golden + FE mount 测试）：
- ⬜ **W3-6a list widget**（按视图/过滤列出 top-N 记录，只读，权限/掩码经既有 preview-data 路径）。
- ⬜ **W3-6b progress / goal widget**（数值 vs 目标的进度，纯计算 + 展示）。
- ⬜ **W3-6c metric 增强**（对比期/趋势箭头，纯计算，无图表库）。
- 每个：后端 preview-data golden（含 row-deny/掩码不被绕的负向断言，仿既有 dashboard authz golden）+ FE mount 交互测试（仿 `multitable-dashboard-view.spec.ts`）。

## 4. 硬闸门（不变式）
1. **权限/掩码不被绕**：所有 widget 数据经既有 field-read-enforced preview-data 路径（`:125` 注释点名）；row-deny/字段掩码在 widget 上仍成立（后端 golden 负向断言）。
2. **jsdom 可测**：本批 widget 不引入拖拽/像素测量；交互=select/表单/模态；FE mount 测试覆盖。
3. **无新图表库 / 无真浏览器前置**（本批）。

## 5. 门禁（TODO-checklist）
- ✅ **前置核实**：browser-gate 担忧不成立（本文）→ **建议 owner 解锁 W3-6**。
- 🔒 **W3-6a/b/c**：解锁后各自 slice（后端 preview-data golden + FE mount 测试）— Sonnet。
- 🔒 **不做（独立立项 + Playwright 前置）**：拖拽网格布局 · 像素测量自适应 · 图表视觉回归。

## 6. 一句话
核实过：仪表盘非图表 widget（metric/text/filter）已在、交互是 select/表单/模态、有可挂载 FE spec——**"browser-gated"担忧不成立,W3-6 可解锁**、不需 Playwright。本批补 list/progress/metric-增强 等 jsdom 可测 widget,走既有 field-read-enforced preview-data + 后端 golden + FE mount 测试;真拖拽/像素测量才需真浏览器,那是独立立项、不在本批。
