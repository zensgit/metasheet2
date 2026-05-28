# 多维表剩余 open 项 — 验证 / 验收矩阵

> Date: 2026-05-27 · Status: **验收标准（实现后逐条填 ✅/❌）** · 配套：`multitable-open-items-development-plan-20260527.md` + `multitable-open-items-todo-20260527.md`
> 每个 slice 的"done"= 下方该节全绿 + `pnpm validate:all` 绿。

## 0. 横切验收纪律（所有 slice 适用 — 来自 PR-hardening 经验）

- **production code 无 `any`**（测试可用局部 `any`/cast 断言 ECharts 宽 option 联合）、type-only import（ESLint 强制）、无 dead helper、commit message Conventional + scope。
- **exact body assertions**（断状态码 **且** 断 body 结构/字段），不止断 200。
- **MD ↔ spec/code parity**：本验证文档与实现行为一致；RC/contract 同 commit 勾选。
- **wire-vs-fixture 纪律**：任何经 copy/whitelist/pick/select 投影的字段，**必须真 wire 集成测试**（手搓 fixture 抓不到 drop）。
- **no skip-when-unreachable**：集成/e2e 在真实路径不可达时必须 **fail 或显式标 not-run**，不得 early-return 静默绿。
- 权限相关用 **real-DB**（`describeIfDatabase` + `DATABASE_URL` 硬门；默认 `pnpm test` 会跳过，需专门跑）。

---

## Slice 1 — ECharts（可立即验收）

| ID | 验收项 | 方法 | 通过判据 |
|---|---|---|---|
| **V-S1-1** | `buildOption` 映射正确 | vitest 单测（纯函数，无需 echarts 运行时） | bar 竖：`xAxis.type='category'`+`.data=labels`、`series[0].type='bar'`；横向（`orientation='horizontal'`）x/y 轴交换；line：`series[0].type='line'`、category 轴；pie：`series[0]={type:'pie',data:[{name,value}]}`；**空 dataPoints 不崩**；per-point color→`itemStyle.color`，缺省 8 色 palette；number/table→`null` |
| **V-S1-2** | **行为契约（已锁，单测断言）** | vitest 单测 | **option 无 `legend`、无 `title`**（二者是 HTML chrome、不进 ECharts）；**pie/line `label.show=false`**（仅 bar 显值）；bar `showValues` 默认 on、`false`→`label.show=false`；`orientation` 仅切 bar 轴；`colorScheme` dormant 不接 |
| **V-S1-3** | renderer 分支正确 | vitest 挂载（mock echarts） | bar/line/pie 渲染 `<div ref>`（`data-chart-type` 在）、`echarts.init` 调用 1 次；**number/table 仍 HTML**（`data-chart="number"/"table"` + 值在），number/table **不** init echarts |
| **V-S1-3b** | **HTML chrome 契约（renderer-only，必须有 spec）** | renderer spec | `showLegend` 只能在 renderer 层证：pie + `showLegend=false` → HTML legend **不渲染**（`data-legend` 缺席）；pie 默认 → HTML legend 在、含 label+value；**title 单源**：仅一个 HTML 标题（option 无 title 已由 V-S1-1 锁），无双标题 |
| **V-S1-4** | 生命周期（含跨类型切换） | vitest（mock + reactive 重渲染） | prop data 变 → `setOption(...,true)` 二次调；**number/table → bar/line/pie 切换**（watch `flush:'post'`，canvas 此时才在 DOM）→ `init()` + observer 补挂；**chart → number 切换** → `dispose()`；observer 回调 → `chart.resize()`；卸载 → `dispose()` |
| **V-S1-5** | dashboard 消费者不崩 | `multitable-dashboard-view.spec.ts` + `vi.mock('echarts/core')` | 现有挂载测试在 mock 下绿（无 canvas 崩） |
| **V-S1-6** | 包体 tree-shaken | grep + `pnpm --filter @metasheet/web build` | **runtime** 只 `from 'echarts/core'` 及子路径（**无 runtime `from 'echarts'`**）；`import type … from 'echarts'`（如 `EChartsOption`）**例外**——编译期擦除、不进 bundle；构建产物里 echarts 不进首屏主 chunk（静态 import 下进 dashboard 路由 chunk 或 vendor，仅 used modules）。**✅ 验证 2026-05-27**：build 绿；echarts 仅在 `MultitableEmbedHost` chunk（**不在首屏 `index`**）；tree-shaking 确认 = 子集 **1254kB** vs 全量 echarts **1791kB**（受控实验，剔除 **~537kB raw / ~174kB gzip**） |
| **V-S1-7** | 视觉冒烟 | 手动 / Playwright（stack 起则跑，否则**显式标 not-run**） | **⏸ NOT-RUN（2026-05-27，无 stack）** — 待 dev server 起后人工核对：dashboard 5 类面板渲染一致、横向 bar 生效、resize 重排、切换/卸载无 console error、无 canvas 泄漏 |
| **V-S1-8** | 质量门 | `pnpm validate:all` | validate:plugins + lint + type-check 全绿；**production code 无 `any`**（测试局部 any 例外）；i18n 走既有模块无新模块 |

**Slice 1 done = V-S1-1..8 全绿**（V-S1-7 若 stack 不可达，显式标 not-run + 列手动复核步骤，不算静默通过）。

---

## Slice 3 — A2b 宏展开转义（contract-first 验收）

| ID | 验收项 | 方法 | 通过判据 |
|---|---|---|---|
| **V-A2b-0** | contract 表已锁 | 评审 | 开发计划 §Slice 3 的 per-type 表经 owner 拍板（含 object 分支裁决），与实现同 commit |
| **V-A2b-1** | **标量行为零回归** | vitest golden | string/number/boolean/rollup-number 进公式的求值输出**改动前后逐字相同**（pin 现行为） |
| **V-A2b-2** | 对抗性无注入 | vitest | 值含 `"`、`{fld_x}`、`1+1`、array、object、date、超长串 → ① 表达式**不被污染/注入**；② 产出符合锁定 contract（如 array→引号 literal） |
| **V-A2b-3** | lookup-进-公式真 wire | **real-DB 集成**（非 fixture） | 建 string 字段 X → lookup L 拉 X → formula F 引用 L；经真 patch 路径写入；断 F 产出符合 contract（wire-vs-fixture 纪律） |
| **V-A2b-4** | 最小化 | 评审 | 未越界做语义纠偏（如"lookup array 可 SUM"另开决策）；若 Track B 决定上马则记录 A2b 作废条件 |

**A2b done = V-A2b-0..4 全绿**；**V-A2b-1（零回归）是硬门** —— 任何标量产出变化都视为契约破坏，需回到 V-A2b-0 重新拍板。

---

## Slice 2 — grid 分组/滚动（gated：C0 决策后再执行，先定标准）

> 未启动；以下为**待执行验收标准**，C0 拍板后填实。

| ID | 验收项 | 通过判据（预定） |
|---|---|---|
| **V-2b-1** | 分组完整性 | grouped view 显示**全集所有组**（不再页局部丢组）；每组 `count` = 全集计数（非当页） |
| **V-2b-2** | 分组行正确 | 组下行覆盖全集（按分页模型），无重复/缺失 |
| **V-2b-3** | 权限 parity | group field 不可见 → 422 `AGGREGATE_GROUP_FIELD_DENIED` 前端正确处理；real-DB |
| **V-2c-0** | 窗口化 spike | 1k 行窗口化 + 横向滚动下 frozen 列仍钉住、无 jank（**spike 不过则改手搓方案，重估**） |
| **V-2c-1** | 窗口化正确 | 滚动行回收无重复/缺失；focus/selection 跨窗口保持；frozen + 条件格式不丢 |

---

## 验收执行顺序

1. **Slice 1** 现在可执行（V-S1-1..8）。
2. **A2b** 待 A2b-1 contract 拍板后执行（V-A2b-0 先行）。
3. **Slice 2** 待 C0 决策后执行。

**落地提示**：docs 与后续实现若要 land，先 `git fetch` 后从 `origin/main` 切新分支提交，勿从可能落后的本地分支提交（先 `git rev-list --count HEAD..origin/main` 确认基线）。
