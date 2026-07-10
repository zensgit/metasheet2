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

在既有 metric/text/filter 之上，补一批 **jsdom 可测的非图表 widget**。数据路径按 rung 分两类（见各条），每个 rung 都要：后端 golden + **per-rung 载重 mutation 行** + FE mount 测试（且 FE spec 同 PR 进 CI gate run-list，见 §4.4）：
- ⬜ **W3-6a list widget**（按视图/过滤列出 top-N 记录，只读）。**不能走 preview-data**：它需要 per-record 字段值，而 preview-data 的 `ChartData` 载荷（`packages/core-backend/src/multitable/chart-aggregation-service.ts:35-51`）只携带聚合 `dataPoints:[{label,value}]`——`ChartType` 全集（`charts.ts:11`）= `bar|line|pie|number|table|area|funnel|gauge|scatter`，**无 raw-record 列表模式**（连 `table` 型也是 group-by 聚合）。W3-6a 必须走与既有 grid/records 读闸**同等 row-deny + 字段掩码强制**的 record-read 路径：row-deny 同 `/view`（`univer-meta.ts:13426`）的行过滤（`deriveRecordPermissions` + `loadRowLevelReadDenyEnabled`/`loadDeniedRecordIds`，`permission-service.ts:917/:1121`），字段掩码同 `loadAllowedFieldIds`（`univer-meta.ts:4446`）+ `filterRecordDataByFieldIds`（`:4315`）。**具体读路径决定（复用哪个既有读闸/端点、golden 形状）= W3-6a 解锁的显式命名前置 gate（§5）。**
  - 载重 mutation 行：neuter 所选读路径的 row-deny 行过滤（或字段掩码投影）→ 本 rung 的 `not.toContain(deniedRecordCanary)` / `not.toContain(maskedFieldCanary)` golden 必须 RED。
- ⬜ **W3-6b progress / goal widget**（数值 vs 目标的进度，纯计算 + 展示；**聚合形，走既有 preview-data 路径**）。
  - 载重 mutation 行：neuter `isChartDataRestricted`（`packages/core-backend/src/routes/dashboard.ts:209`，route 施加点 `:404/:501`；FE 侧注释锚 `MetaDashboardView.vue:969`）→ 本 rung 的 denied-field restricted-state / `not.toContain(canary)` golden 必须 RED。
- ⬜ **W3-6c metric 增强**（对比期/趋势箭头，纯计算，无图表库；**聚合形，走既有 preview-data 路径**）。
  - 载重 mutation 行：neuter `loadChartRecords` 的字段掩码投影（`dashboard.ts:111-121`）→ 本 rung 对比期聚合的 masked-field canary `not.toContain` golden 必须 RED。
- 每个：后端 golden（W3-6b/c = preview-data golden；W3-6a = record-read golden；均含 row-deny/掩码不被绕的负向断言，仿既有 dashboard authz golden）+ 上列 per-rung 载重 mutation 行 + FE mount 交互测试（仿 `multitable-dashboard-view.spec.ts`）。

## 4. 硬闸门（不变式）
1. **权限/掩码不被绕**：**聚合形 rungs（既有 metric card、W3-6b progress、W3-6c metric-增强）** 的 widget 数据经既有 field-read-enforced preview-data 路径（`MetaDashboardView.vue:125` 注释点名；server 侧 = `isChartDataRestricted` `dashboard.ts:209` wholesale-refuse + `loadChartRecords` row-deny 过滤/字段掩码 `dashboard.ts:99-121`）——其 `ChartData` 载荷只携带聚合 label/value 数据点（无 raw-record 模式，连 `table` 型也是 group-by 聚合），且每条输入行先经 row-deny 过滤 + 字段掩码再进聚合引擎。**W3-6a（list）不在此列**：它需要 per-record 字段值，必须走 §3 所述与既有 grid/records 读闸同等 row-deny + 字段掩码强制的 record-read 路径（其读路径决定 = 显式前置 gate）。row-deny/字段掩码在**每个** widget 上仍成立（后端 golden 负向断言 + per-rung 载重 mutation 行）。
2. **jsdom 可测**：本批 widget 不引入拖拽/像素测量；交互=select/表单/模态；FE mount 测试覆盖。
3. **无新图表库 / 无真浏览器前置**（本批）。
4. **FE spec 必须进 CI gate**：`apps/web/tests/multitable-dashboard-view.spec.ts` 当前**不在任何 workflow 里跑**（`attendance-web-guard.yml` 的显式 paths 触发列表 `:58-88` 与 targeted `vitest run` run-list `:165` 均不含它；required `test (20.x)` 只 build apps/web 不跑其 vitest；`plugin-tests.yml` 不跑 apps/web vitest）。W3-6a/b/c 每个 slice 的 FE spec 必须**同 PR** 加入某个 gate workflow 的显式 run-list（扩既有 targeted run-list 或新建 multitable-web-guard），否则只是本地绿。

## 5. 门禁（TODO-checklist）
- ✅ **前置核实**：browser-gate 担忧不成立（本文）→ **建议 owner 解锁 W3-6**。
- 🔒 **W3-6a-read-path gate（W3-6a 的前置）**：先定 list widget 的 record-read 路径（复用哪个既有 row-deny + 字段掩码读闸/端点、golden 形状），owner 批准后 W3-6a 才可动工——W3-6a **不走** preview-data（§3/§4.1）。
- 🔒 **W3-6a/b/c**：解锁后各自 slice（后端 golden + per-rung 载重 mutation 行 + FE mount 测试 + FE spec 同 PR 进 gate workflow run-list，§4.4）— Sonnet。
- 🔒 **不做（独立立项 + Playwright 前置）**：拖拽网格布局 · 像素测量自适应 · 图表视觉回归。

## 6. 一句话
核实过：仪表盘非图表 widget（metric/text/filter）已在、交互是 select/表单/模态、有可挂载 FE spec——**"browser-gated"担忧不成立,W3-6 可解锁**、不需 Playwright。本批补 list/progress/metric-增强 等 jsdom 可测 widget——聚合形（progress/metric-增强）走既有 field-read-enforced preview-data;list（W3-6a）需 per-record 字段值,**不能**走 preview-data,必须走 row-deny + 字段掩码同等强制的 record-read 路径（读路径决定=显式前置 gate）;每 rung 后端 golden + 载重 mutation 行 + FE mount 测试,且 FE spec 须同 PR 进 CI gate run-list;真拖拽/像素测量才需真浏览器,那是独立立项、不在本批。
