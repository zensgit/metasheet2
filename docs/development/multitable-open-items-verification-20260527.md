# 多维表剩余 open 项 — 验证 / 验收矩阵

> Date: 2026-05-27 · Status: **验收矩阵 / archive** · 配套：`multitable-open-items-development-plan-20260527.md` + `multitable-open-items-todo-20260527.md`
> 每个**未 shipped** slice 的"done"= 下方该节全绿 + `pnpm validate:all` 绿。已 shipped 的 Slice 1/A2b 节为 **historical 证据快照**（非前置门）；**Slice 2 已由 C0（#1982）deferred**，其原验收项仅作 future reopen 参考。

## 0. 横切验收纪律（所有 slice 适用 — 来自 PR-hardening 经验）

- **production code 无 `any`**（测试可用局部 `any`/cast 断言 ECharts 宽 option 联合）、type-only import（ESLint 强制）、无 dead helper、commit message Conventional + scope。
- **exact body assertions**（断状态码 **且** 断 body 结构/字段），不止断 200。
- **MD ↔ spec/code parity**：本验证文档与实现行为一致；RC/contract 同 commit 勾选。
- **wire-vs-fixture 纪律**：任何经 copy/whitelist/pick/select 投影的字段，**必须真 wire 集成测试**（手搓 fixture 抓不到 drop）。
- **no skip-when-unreachable**：集成/e2e 在真实路径不可达时必须 **fail 或显式标 not-run**，不得 early-return 静默绿。
- 权限相关用 **real-DB**（`describeIfDatabase` + `DATABASE_URL` 硬门；默认 `pnpm test` 会跳过，需专门跑）。

---

## Slice 1 — ECharts ✅ **SHIPPED (#1950, merge `b665b2b1c`)** — 证据快照

> 结果：V-S1-1..8 ✅（33 specs + `vue-tsc -b` + build/tree-shaking 绿，受控实验剔除 ~537KB / 174KB-gzip）；**V-S1-7 视觉冒烟 = RAN + PASS（2026-05-28，前端-only 真浏览器渲染）**。下表为 as-verified 记录。

| ID | 验收项 | 方法 | 通过判据 |
|---|---|---|---|
| **V-S1-1** | `buildOption` 映射正确 | vitest 单测（纯函数，无需 echarts 运行时） | bar 竖：`xAxis.type='category'`+`.data=labels`、`series[0].type='bar'`；横向（`orientation='horizontal'`）x/y 轴交换；line：`series[0].type='line'`、category 轴；pie：`series[0]={type:'pie',data:[{name,value}]}`；**空 dataPoints 不崩**；per-point color→`itemStyle.color`，缺省 8 色 palette；number/table→`null` |
| **V-S1-2** | **行为契约（已锁，单测断言）** | vitest 单测 | **option 无 `legend`、无 `title`**（二者是 HTML chrome、不进 ECharts）；**pie/line `label.show=false`**（仅 bar 显值）；bar `showValues` 默认 on、`false`→`label.show=false`；`orientation` 仅切 bar 轴；`colorScheme` dormant 不接 |
| **V-S1-3** | renderer 分支正确 | vitest 挂载（mock echarts） | bar/line/pie 渲染 `<div ref>`（`data-chart-type` 在）、`echarts.init` 调用 1 次；**number/table 仍 HTML**（`data-chart="number"/"table"` + 值在），number/table **不** init echarts |
| **V-S1-3b** | **HTML chrome 契约（renderer-only，必须有 spec）** | renderer spec | `showLegend` 只能在 renderer 层证：pie + `showLegend=false` → HTML legend **不渲染**（`data-legend` 缺席）；pie 默认 → HTML legend 在、含 label+value；**title 单源**：仅一个 HTML 标题（option 无 title 已由 V-S1-1 锁），无双标题 |
| **V-S1-4** | 生命周期（含跨类型切换） | vitest（mock + reactive 重渲染） | prop data 变 → `setOption(...,true)` 二次调；**number/table → bar/line/pie 切换**（watch `flush:'post'`，canvas 此时才在 DOM）→ `init()` + observer 补挂；**chart → number 切换** → `dispose()`；observer 回调 → `chart.resize()`；卸载 → `dispose()` |
| **V-S1-5** | dashboard 消费者不崩 | `multitable-dashboard-view.spec.ts` + `vi.mock('echarts/core')` | 现有挂载测试在 mock 下绿（无 canvas 崩） |
| **V-S1-6** | 包体 tree-shaken | grep + `pnpm --filter @metasheet/web build` | **runtime** 只 `from 'echarts/core'` 及子路径（**无 runtime `from 'echarts'`**）；`import type … from 'echarts'`（如 `EChartsOption`）**例外**——编译期擦除、不进 bundle；构建产物里 echarts 不进首屏主 chunk（静态 import 下进 dashboard 路由 chunk 或 vendor，仅 used modules）。**✅ 验证 2026-05-27**：build 绿；echarts 仅在 `MultitableEmbedHost` chunk（**不在首屏 `index`**）；tree-shaking 确认 = 子集 **1254kB** vs 全量 echarts **1791kB**（受控实验，剔除 **~537kB raw / ~174kB gzip**） |
| **V-S1-7** | 视觉冒烟 | 手动 / Playwright（前端-only vite :8899 + sample data，无需 backend/Docker） | **✅ RAN + PASS（2026-05-28）** — 真浏览器渲染逐条核对：bar/line/pie 真 canvas 有绘制内容（`getImageData` 非空像素，实测彩色占比 bar 27% / line 24% / pie 5% / 横向 bar 29%）；**横向 bar** 生效（x/y 轴交换可视）；**resize 重排** canvas 1388→668 宽随容器回流；**pie HTML legend** 随 `showLegend` live 切换（关→`data-legend` 消失）；**number/table** 仍 HTML（无 canvas）；切换/卸载仅 favicon-404 一条 console err（无 chart 报错）；卸载无泄漏（dispose 由 V-S1-4 单测锁）。tooltip 已配置（hover 未自动化）。**截图**：MCP capture-timeout（canvas 重页）→ 改由 DOM + canvas 像素 + reflow 实证替代 |
| **V-S1-8** | 质量门 | `pnpm validate:all` | validate:plugins + lint + type-check 全绿；**production code 无 `any`**（测试局部 any 例外）；i18n 走既有模块无新模块 |

**Slice 1 = shipped via #1950（historical snapshot）**：V-S1-1..8 ✅；**V-S1-7 视觉冒烟 RAN + PASS（2026-05-28，前端-only 真浏览器渲染）** —— #1950 最后一项非代码验证已闭环，无 outstanding。

---

## Slice 3 — A2b 宏展开转义 ✅ **MERGED (#1958, squash `d9b5b031a`)** — defensive hardening

| ID | 验收项 | 结果 |
|---|---|---|
| **V-A2b-0** | contract 表已锁 | ✅ owner 拍板 **object → `#VALUE!`**；scalar array→引号 join；array-with-object→`#VALUE!`；date 走 string 分支（quoted） |
| **V-A2b-1** | 标量行为零回归 | ✅ unit：string/number/boolean 求值逐字不变（`String(value)` 兜底分支外未动） |
| **V-A2b-2** | 对抗性无注入 | ✅ unit：`"`/`{fld_x}`/`1+1`/object-array/超长串 → 表达式不被注入、产出合 contract（13 测试；既有 formula/dry-run/write-path 套件无回归） |
| **V-A2b-3** | ~~lookup→formula 真 wire~~ | ⛔ **NOT-APPLICABLE（architecture note）**：hydrated lookup 数据当前不流入 formula recalc（`recalculateRecord` 走 DB reload `formula-engine.ts:249`；lookup computed-on-read 不 materialize，`applyLookupRollup` 只写内存 `row.data` `univer-meta.ts:1795`）→ A2b 是 defensive，e2e `#VALUE!` 断言与架构不符 |
| **V-A2b-4** | 最小化 | ✅ 仅收口 `String(value)` 一处、未做语义纠偏；Track B 若上马则 A2b 作废 |

**A2b = MERGED**（defensive hardening）。**🆕 Backlog（独立、out-of-scope）**：formula 引用 lookup → recalc 缺席 lookup 值 → `undefined→'0'`（`formula-engine.ts:109`，"按 0 算"）；characterization/design note only，单独决策。

---

## Slice 2 — grid 分组/滚动 ⏸ **DEFERRED by C0 (#1982 = keep pager)**

> 本轮不执行。下表保留为 **future reopen reference**：仅当产品未来改拍连续 grouped browsing 时再恢复为 active gate。

| ID | 验收项 | 通过判据（预定） |
|---|---|---|
| **V-2b-1** | 分组完整性 | grouped view 显示**全集所有组**（不再页局部丢组）；每组 `count` = 全集计数（非当页） |
| **V-2b-2** | 分组行正确 | 组下行覆盖全集（按分页模型），无重复/缺失 |
| **V-2b-3** | 权限 parity | group field 不可见 → 422 `AGGREGATE_GROUP_FIELD_DENIED` 前端正确处理；real-DB |
| **V-2c-0** | 窗口化 spike | 1k 行窗口化 + 横向滚动下 frozen 列仍钉住、无 jank（**spike 不过则改手搓方案，重估**） |
| **V-2c-1** | 窗口化正确 | 滚动行回收无重复/缺失；focus/selection 跨窗口保持；frozen + 条件格式不丢 |

---

## 验收执行顺序 / 当前状态

1. ✅ **Slice 1** — done（#1950；V-S1-7 视觉冒烟 RAN + PASS 2026-05-28，前端-only 真浏览器渲染）。
2. ✅ **A2b** — done（#1958，defensive；V-A2b-3 → NOT-APPLICABLE）。
3. ⏸ **Slice 2** 已由 **C0（#1982）** deferred；当前不执行、无 active gate。

**落地提示**：docs 与后续实现若要 land，先 `git fetch` 后从 `origin/main` 切新分支提交，勿从可能落后的本地分支提交（先 `git rev-list --count HEAD..origin/main` 确认基线）。
