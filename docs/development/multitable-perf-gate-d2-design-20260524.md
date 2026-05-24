# Multitable D2 大表性能基线门 — Scout & Design

Date: 2026-05-24
Revision: v3（stale-wording cleanup — v2 改了 §7/§16/§6 schema 但 §1/§13/§14/§15 残留 v1 binary 措辞，v3 全文对齐，详见 §17 Changelog）
Status: docs-only design（无产品代码改动）— 后续 perf-test impl PR 独立链节
Branch: `docs/multitable-perf-gate-d2-scout-20260524`
Anchors:
- benchmark v2 §9 #1 `D2 large-table perf gate` 优先级 #1
- benchmark v2 §10 key judgment 原则 "measurement-before-optimization"
- benchmark v2 §13 changelog "perf gate before virtualization"

---

## 1. 目标

建立 multitable grid 在 **10k / 50k / 100k 行**规模下的可重复测量方法论 + 验收 JSON schema。

**本 gate 输出是一个 5-class triage verdict**（详见 §7），不是预设的虚拟化方案：

- **A_CSS_sufficient** — 已有的 `content-visibility: auto` 已足够，无需任何后续优化
- **B_frontend_dom_memory_bound** — frontend DOM/heap 绝对值或 slope 越线 → **唯一**解锁 §9 #2 grid virtualization PR
- **C_backend_query_bound** — backend insert/query/group 越线 → 启独立 server-side optimization PR（virtualization 不解此问题）
- **D_client_algorithm_bound** — client 端 sort/filter/group 算法越线 → 启独立算法优化 PR（virtualization 不解此问题）
- **E_yjs_sync_overhead_bound** — multi-client sync overhead 越线 → 启独立 realtime perf PR（v1 仅声明分类位，**本 PR 不输出**）

A/B/C/D **互斥或可叠加**。这是把 benchmark v2 §10 measurement-before-optimization 原则递归地应用到 D2 自身：D2 不是"做虚拟化"的 PR，是"测量后按瓶颈分类决定下一步"的 PR——**仅 verdict B 触发虚拟化**，其它 verdict 走对应专属路径。

---

## 2. Framing pivot — CSS-native 虚拟化已经存在

**关键发现**（在 benchmark v2 起草时未注意）：`apps/web/src/multitable/components/MetaGridTable.vue:606`：

```css
.meta-grid__row {
  transition: background 0.1s;
  content-visibility: auto;          /* ← 浏览器原生跳过屏外行 paint/layout */
  contain-intrinsic-size: auto 36px; /* ← 占位高度，避免滚动条跳变 */
}
.meta-grid--compact .meta-grid__row { contain-intrinsic-size: auto 28px; }
.meta-grid--expanded .meta-grid__row { contain-intrinsic-size: auto 52px; }
```

含义：
- ✅ 浏览器自动跳过**屏外行**的 paint + layout（与 JS 虚拟化目标重叠）
- ❌ 但 `content-visibility: auto` **不**减少：
  - DOM node 总数（每行 + 每 cell 仍在树里）
  - JS heap（Vue reactive 对象、绑定、监听器都在内存）
  - scripting time（mount/update 阶段仍走全部行）

所以 D2 必须明确测的是 **`content-visibility` 的盲点**，决定它在 N 行规模下是否能扛住。这彻底改变了 benchmark v1 "无虚拟化所以必加虚拟化"的预设结论。

---

## 3. 现状扫描

### 3.1 已有 backend perf baseline 框架（可直接复用 env-var 约定）

| 资产 | 用途 |
|---|---|
| `scripts/ops/attendance-import-perf.mjs` | 完整 baseline harness — `ROWS` / `MODE` / `PERF_PROFILE` / `ROLLBACK` / `API_BASE` / `AUTH_TOKEN` / async commit 阈值 50k 等 env 约定 |
| `scripts/performance-baseline-test.sh` | p50 / p95 / p99 / max 统计 + CSV+JSON summary 输出 |
| `.github/workflows/attendance-import-perf-baseline.yml` | workflow_dispatch + profile=standard\|high-scale + rows + mode + preview_mode + commit_async 输入 |
| `.github/workflows/attendance-import-perf-highscale.yml` | 100k async 分级 |
| `.github/workflows/attendance-import-perf-longrun.yml` | 长跑分级 |
| `scripts/ops/attendance-import-perf-trend-report.mjs` | 跨次 baseline trend 报告 |

**D2 复用结论**：env 命名、profile 分级、CSV/JSON 输出格式、trend 聚合脚本——全部沿用，保证 multitable baseline 历史可比、CI workflow 可镜像式新增。

### 3.2 已有 multitable e2e harness（可扩展为 frontend perf harness）

```text
packages/core-backend/tests/e2e/multitable-helpers.ts        ← 共享 setup/teardown
packages/core-backend/tests/e2e/multitable-basic-views-smoke.spec.ts
packages/core-backend/tests/e2e/multitable-formula-smoke.spec.ts
packages/core-backend/tests/e2e/multitable-lifecycle-smoke.spec.ts
packages/core-backend/tests/e2e/multitable-hierarchy-smoke.spec.ts
packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts
packages/core-backend/tests/e2e/multitable-public-form-smoke.spec.ts
packages/core-backend/tests/e2e/multitable-automation-send-email-smoke.spec.ts
```

D2 perf-test PR 应在 `tests/e2e/` 下新增 `multitable-perf-baseline.spec.ts`（或 `multitable-grid-perf-baseline.spec.ts`），与 smoke 系列共置。

### 3.3 frontend perf 测量基础设施 = 零（D2 需从零搭建）

```bash
grep -R -E "performance\.mark|performance\.measure|requestAnimationFrame.*fps|playwright.*tracing" apps/web/src
# → 0 hits
```

**v1 立场：black-box measurement only** — D2 perf-test PR **不触碰** `apps/web/src/**` 任何产品代码。所有测量在浏览器外部 + 通过 Playwright `addInitScript` 注入测试侧脚本：

- **Playwright context tracing** — `browserContext.tracing.start({ screenshots: false, snapshots: false, sources: false })` + `browserContext.tracing.stop({ path })` 收 timeline（注意：tracing 是 context-level API，不是 page-level）
- **Chrome DevTools Protocol via Playwright** — `context.newCDPSession(page)` 后 `Memory.getDOMCounters()` / `Performance.getMetrics()` / `Performance.enable` 抓 DOM node count + JS heap
- **PerformanceObserver（注入式）** — 通过 `addInitScript` 在浏览器上下文订阅 `longtask` / `largest-contentful-paint` / `layout-shift` / `paint` / `event`（PerformanceEventTiming）；脚本由测试 PR 提供，不进产品 bundle
- **MutationObserver（注入式）** — 观察 grid DOM 节点增减、cell 内容变化（标识"cell-edit 完成"等事件），同 init script 注入
- **`requestAnimationFrame` 时间差采样 FPS** — 注入测试侧 raf 循环采样、滚动驱动循环，非产品代码

**v2 候选（**本 PR 显式不启**）**：若 v1 black-box 测得的事件粒度不足以定位 hook 层瓶颈（例如无法区分 `mount` vs `update` 内部阶段），可考虑在产品代码 `apps/web/src/multitable/**` 加 `performance.mark('multitable.grid.<hook>.start')` 命名 mark。该改动**触碰产品代码**，须 **separate kernel-polish opt-in**（与 §10 Path B、§11 K3 boundary 同级处理）。v1 不依赖此前置。

### 3.4 multitable bulk insert 入口（perf-test PR 待最终确认）

`packages/core-backend/src/multitable/` 内有 `record-write-service.ts` / `xlsx-service.ts` / `record-service.ts` — 候选 bulk insert path。D2 perf-test PR 第一步任务：确认 100k 级别 bulk insert 端点是否 ready、是否需新 seed endpoint（见 §9 Seed 策略决策）。

---

## 4. Metric 矩阵 — 6 层 × 12 数据点

| 层 | Metric | 何时是 discriminator | 工具 |
|---|---|---|---|
| Frontend mount | TTI after data arrives (ms) | CSS-virt 跳过 *之前* 的代价 | 注入 MutationObserver 观察 grid root 首次完整 render；与 Playwright `waitForFunction` 联用 |
| Frontend scroll | scroll FPS p50/p95/min | CSS-virt 实力体现处 | 注入 rAF 时间差采样 + 测试驱动 scroll loop |
| Frontend scroll | Long Task count + 总时长 | scripting bottleneck | 注入 PerformanceObserver `longtask` |
| **Frontend memory** | **DOM node count: afterMountMax / per10kSlope（绝对值与斜率，主导）+ delta（辅助）** | **CSS-virt 盲点 — 主导信号** | CDP `Memory.getDOMCounters` / `DOM.getDocument` 计数 |
| **Frontend memory** | **JS heap MB: afterMountMax / per10kSlope（绝对值与斜率，主导）+ delta（辅助）** | **CSS-virt 盲点 — 主导信号** | CDP `Performance.getMetrics` `JSHeapUsedSize` |
| Frontend interact | cell-edit roundtrip (focus→keystroke→commit) p50/p95 ms | scripting hot path（非 paint）| PerformanceEventTiming（input event）+ MutationObserver（cell DOM 提交完成时点）— 注入式 |
| Frontend interact | sort apply latency (ms) | full-data re-sort scripting | 测试侧触发 sort 操作 → MutationObserver row order 变更完成 → 时间差 |
| Frontend interact | filter apply latency (ms) | full-data re-filter scripting | 测试侧触发 filter → MutationObserver row count 稳定时点 → 时间差 |
| Frontend interact | group apply latency (ms) | groupedRows 计算 + 渲染 | 测试侧触发 group → MutationObserver group header 出现 → 时间差 |
| Backend insert | bulk-insert p50/p95/p99 ms（一次入 N 行）| attendance pattern 直接迁移 | hybrid 复用 attendance-perf.mjs |
| Backend query | view-load latency at N rows (ms) | 数据进 frontend 之前的成本 | hybrid 复用 attendance-perf.mjs |
| Backend query | group/filter applied at backend latency (ms) | server-side 优化 ROI 参考 | hybrid 复用 attendance-perf.mjs |

**主导信号顺位**：
1. **DOM node count `afterMountMax` + `per10kSlope`** + **JS heap `afterMountMax` + `per10kSlope`** — CSS-virt 盲点核心指标；CSS `content-visibility: auto` 跳过 paint/layout 但**不减少 DOM/heap 绝对值**，故必须看**绝对值与增长斜率**而非 scroll delta。delta 仅作辅助（可能接近零却说不明问题）
2. scroll FPS p95 + Long Task count — 用户感知核心
3. cell-edit / sort / filter / group apply latency — 交互连续性（client algorithm bound 信号）
4. Backend insert/query — 后端瓶颈是否前置（backend-query bound 信号）

---

## 5. Env-var schema — Hybrid 复用

### 5.1 Backend half（直接复用 attendance pattern）

| Env | 默认 | 说明 |
|---|---|---|
| `ROWS` | `10000` | 数据规模（10k / 50k / 100k 三档）|
| `MODE` | `commit` | `preview` \| `commit` |
| `PERF_PROFILE` | `multitable-d2-baseline` | `multitable-d2-baseline` \| `multitable-d2-highscale`（与 attendance 命名空间隔离）|
| `ROLLBACK` | `true` | 默认清理写入，避免环境污染 |
| `API_BASE` | — | 必填 — staging/pre-prod URL |
| `AUTH_TOKEN` | — | 必填 — never logged（attendance pattern 同款）|
| `PREVIEW_ASYNC_ROW_THRESHOLD` | `50000` | attendance 同款，commit-async 阈值 |
| `SHEET_ID` | — | 目标 sheet（须 fixture seed 后注入）|

### 5.2 Frontend half（D2 新增）

| Env | 默认 | 说明 |
|---|---|---|
| `TARGET_VIEW_ID` | — | 必填 — 已 seed N 行数据的 grid view |
| `METRIC_PROFILE` | `scroll` | `scroll` \| `edit` \| `sort` \| `filter` \| `group` \| `mount` — 单 profile 一次跑 |
| `HEADLESS` | `true` | Playwright headless |
| `VIEWPORT_HEIGHT` | `900` | 视口高度（DPI norm 影响可视行数）|
| `VIEWPORT_WIDTH` | `1440` | 视口宽度 |
| `DEVICE_SCALE_FACTOR` | `1` | DPR norm |
| `TRACE_OUTPUT` | `output/multitable-perf/<baselineId>` | trace + screenshot 输出根 |
| `SCROLL_TARGET` | `bottom` | `bottom` \| `random` \| `mid` — scroll FPS 测量场景 |
| `EXPANDED_ROW_RATIO` | `0` | 0..1 — expanded-row 比例（次场景）|

### 5.3 Profile 分级

| Profile | Rows | Async | Long-run |
|---|---|---|---|
| `multitable-d2-baseline` | 10k | sync | 否 |
| `multitable-d2-highscale` | 50k / 100k | async commit | 否 |
| `multitable-d2-longrun` | 100k | async + 24h scroll endurance | 是 |

`longrun` 在本 design MD 仅声明结构、不入第一波 perf-test PR；后续如需 endurance 信号再单独开 slice。

---

## 6. Output JSON schema

每次 baseline run 产一个 JSON 文件 `<TRACE_OUTPUT>/baseline-<rows>-<metricProfile>-<timestamp>.json`，schema 如下：

```json
{
  "baselineId": "20260524T120000Z-abc1234",
  "perfProfile": "multitable-d2-baseline",
  "metricProfile": "scroll",
  "rows": 10000,
  "scenario": "primary",
  "hardware": {
    "runner": "ubuntu-latest",
    "cpuCount": 4,
    "memMb": 16384,
    "kernel": "Linux 6.x",
    "playwrightChromium": "131.0.x"
  },
  "viewport": {
    "widthPx": 1440,
    "heightPx": 900,
    "deviceScaleFactor": 1
  },
  "metrics": {
    "ttiMs": null,
    "scrollFps": { "p50": null, "p95": null, "min": null },
    "longTask": { "count": null, "totalMs": null },
    "domNodes": { "afterMount": null, "afterScrollBottom": null, "delta": null, "per10kSlope": null },
    "jsHeapMb": { "afterMount": null, "afterScrollBottom": null, "delta": null, "per10kSlope": null },
    "editCellRoundtripMs": { "p50": null, "p95": null },
    "sortApplyMs": null,
    "filterApplyMs": null,
    "groupApplyMs": null,
    "backendInsertMs": { "p50": null, "p95": null, "p99": null },
    "backendQueryMs": { "p50": null, "p95": null }
  },
  "thresholds": {
    "ttiMs": null,
    "scrollFpsP95Min": null,
    "longTaskCountMax": null,
    "longTaskTotalMsMax": null,
    "domNodesAfterMountMax": null,
    "domNodesPer10kSlopeMax": null,
    "domNodesDeltaMax": null,
    "jsHeapMbAfterMountMax": null,
    "jsHeapMbPer10kSlopeMax": null,
    "jsHeapMbDeltaMax": null,
    "editCellRoundtripP95Max": null,
    "sortApplyMax": null,
    "filterApplyMax": null,
    "groupApplyMax": null,
    "backendInsertP95Max": null,
    "backendQueryP95Max": null
  },
  "verdict": "TBD — A_CSS_sufficient | B_frontend_dom_memory_bound | C_backend_query_bound | D_client_algorithm_bound | E_yjs_sync_overhead_bound",
  "notes": []
}
```

`thresholds` 在首跑后由人 review 回填——之后变成 CI gate 的硬性比较；`verdict` 由 trend-report 按 §7.1 决策树自动分类（A/B/C/D；E 在 multi-client metric profile 启动后才可输出）。

`scenario` 取值：`primary`（collapsed row）或 `expanded`（部分行展开 — `EXPANDED_ROW_RATIO > 0`）。

---

## 7. 接受标准 — 5-class triage（threshold 数值首跑后回填）

D2 gate 输出是一个**多路 triage**，不是 sufficient/insufficient 二分。失败可能来自 frontend DOM/memory、backend query、client 算法、Yjs sync overhead 中任意之一或叠加；不同失败模式对应不同后续 PR，把"任一不达标 → 必做 JS 虚拟化"是错误推论。

### 7.1 Triage 决策树（verdict 取值）

| Verdict | 触发条件 | 对应后续 PR |
|---|---|---|
| **A_CSS_sufficient** | 所有 frontend + backend 指标均达标 | 取消 v2 §9 #2 — effort 转 #3 D3 permission matrix（节约 2-3 周）|
| **B_frontend_dom_memory_bound** | DOM `afterMountMax` 或 `per10kSlope` 越线 ∨ JS heap `afterMountMax` 或 `per10kSlope` 越线 ∨ scroll FPS p95 越线 | 启 v2 §9 #2 grid virtualization PR — JS 虚拟化才能减少 DOM node 总数（CSS-virt 做不到）|
| **C_backend_query_bound** | backend insert/query/group p95 超阈值 + frontend 指标合格 | 启独立 server-side optimization PR（分页 / server-side group / index 优化）；JS 虚拟化**不解此问题** |
| **D_client_algorithm_bound** | sortApplyMs / filterApplyMs / groupApplyMs 越线 + DOM/heap 合格 + backend 合格 | 启独立 client-side 算法优化 PR（O(N²) → O(N log N)、web worker offload、stable sort 等）；JS 虚拟化**不解此问题** |
| **E_yjs_sync_overhead_bound** | scroll/edit 在 multi-client 场景越线但 single client 合格 | 启独立 realtime perf PR（v1 不含 multi-client metric profile，verdict E **本 PR 不输出**，仅声明分类位）|

A/B/C/D **互斥**或**可叠加**（B+C / B+D / C+D 等）；首跑 verdict 由人工 review JSON metrics 按上述决策树打标，后续 trend-report 可自动分类。

### 7.2 阈值清单（首跑后回填）

**frontend DOM/memory（绝对值 + slope 主导；delta 辅助）**：

| Field | 含义 | 候选起点（首跑前 hallucination；锁定值由 baseline review 定）|
|---|---|---|
| `domNodes.afterMountMax` @ N=10k | mount 完成后 DOM 总数上限 | TBD |
| `domNodes.afterMountMax` @ N=50k | | TBD |
| `domNodes.afterMountMax` @ N=100k | | TBD |
| `domNodes.per10kSlope` | 每增 10k 行 DOM 增长上限 | TBD（候选：< 1.2× 体现 CSS-virt 在 mount 阶段未线性炸开）|
| `jsHeapMb.afterMountMax` @ N=10k / 50k / 100k | | TBD |
| `jsHeapMb.per10kSlope` | 每增 10k 行 heap 增长上限 | TBD |
| `domNodes.delta` / `jsHeapMb.delta` | scroll 前后差（**辅助**）| 接近零 ≠ 通过；与 afterMount 绝对值联合判断（CSS-virt 下 delta 天然小但 mount 已经爆）|

**frontend scroll / interact**：

| Field | 含义 | 候选 |
|---|---|---|
| `scrollFps.p95` | scroll 时 95th 帧率下限 | ≥ 50 fps（行业 baseline）|
| `longTask.count` | longtask 数上限 | < 5（候选）|
| `longTask.totalMs` | longtask 总时长上限 | < 500ms（候选）|
| `editCellRoundtripMs.p95` | cell 编辑端到端 95th | < 200ms（候选）|
| `sortApplyMs` / `filterApplyMs` / `groupApplyMs` @ N=50k | full-data 操作完成上限 | < 1000ms（候选）|

**backend**：

| Field | 含义 | 候选 |
|---|---|---|
| `backendInsertMs.p95` | bulk insert 95th | attendance pattern 同档（50k async 内 60s）|
| `backendQueryMs.p95` | view-load 95th | < 500ms（体感门槛）|

### 7.3 阈值锁定流程

1. perf-test PR 实施 metric collection（black-box，§3.3 v1 立场）
2. 三档 rows × 6 metricProfile × 2 scenario（primary/expanded）= **36 baseline run**
3. 数据进 trend-report，人工 review
4. 在新的 verification MD 里 propose 全部 thresholds → 锁定
5. Threshold 锁定后 → CI gate 比较基准 + verdict 自动分类（A/B/C/D 决定下一 PR 路径，E 暂悬置）

---

## 8. 硬件 / Runner 约束

- **CI runner 等级**：复用 attendance baseline workflow 同款（`ubuntu-latest`）— 历史可比
- **本地数据仅 signal**：开发者本地跑出的数字不能作 gate 决策依据（CPU 频率、其它进程压力差异巨大）
- **跨 runner class 数据不可比**：output JSON `hardware.runner` 字段记录 runner，trend report 须按 runner 切分聚合
- **Playwright Chromium 版本固定**：output JSON `hardware.playwrightChromium` 记录版本——版本升级须重锁基线（与现有 attendance pattern 一致）

---

## 9. 场景拆分

- **主场景（`primary`）**：collapsed row mode — `groupedRows` 折叠 + 全 `visibleFields` × N — 渲染热点
- **次场景（`expanded`）**：部分行展开（`meta-grid__expand-row` line 192-200）— `EXPANDED_ROW_RATIO` 控制
- 主场景作 **gate**，次场景作 **reference**（不阻塞主结论但需要数据）

---

## 10. Seed 策略 — 决策待 perf-test PR 首跑

两条路径：

### Path A — 复用现有 multitable bulk-import endpoint（**优先**）

- 候选实现：`packages/core-backend/src/multitable/{record-write-service.ts,xlsx-service.ts,record-service.ts}`
- 优势：零 backend touch，符合 K3 PoC stage-1 lock
- 风险：100k 级 bulk import 可能 chokes（attendance 已知 50k 触发 async commit；multitable 待验证）

### Path B — 新增 seed endpoint / seed script（**仅在 Path A 阻塞时启动**）

- 影响：触碰 `packages/core-backend/src/multitable/` → 触发 K3 PoC stage-1 lock 边界
- 须用户 explicit "kernel-polish opt-in" 才能启
- 若必需，与 Phase 2 approval-resolver kernel-polish 同档级处理

---

## 11. K3 PoC stage-1 lock 边界

- **本 design MD**：纯文档，零代码触碰 ✓
- **perf-test PR impl 层**：
  - 默认 Path A → 零 backend touch → stage-1 安全
  - 若回退 Path B → 触发 backend touch → **separate kernel-polish opt-in 必须**
- **不触碰**：K3 wise / integration-core / attendance / approval / dingtalk — 全在 multitable 内核范围
- **新增**：`tests/e2e/multitable-perf-baseline.spec.ts` + `scripts/ops/multitable-perf-baseline.mjs` + `.github/workflows/multitable-perf-baseline.yml` + `.github/workflows/multitable-perf-highscale.yml`

---

## 12. Open questions（perf-test PR 须回答；本 MD 不答）

1. **生产实际 row upper-bound？**
   - 现 D2 三档 10k / 50k / 100k 仅来自 intuition + 飞书业内基线
   - perf-test PR 首跑前查 prod 或 representative slice：当前最大 sheet 行数？P95 sheet 行数？
   - 若上界 < 10k，三档应降为 1k / 5k / 10k；若 > 100k，须加 500k 档
2. **Path A bulk-insert endpoint at 100k 是否 chokes？**
   - 决定 §10 seed 路径
3. **跨用户并发场景**（多 user 同时 scroll/edit/sort 同 sheet）是否独立 metric profile？
   - 暂列后续 slice，第一波 baseline 单用户
4. **Yjs sync overhead 是否独立 metric profile？**
   - 已有 `realtime` 模块 — 大表 + 多 client = realtime 压测场景
   - 暂列后续 slice，第一波 baseline 关 Yjs 或单 client
5. **Expanded-row 比例 baseline 取多少有代表性？**
   - 取 `EXPANDED_ROW_RATIO=0.05`（5%）作 reference baseline 是否够？
   - 待 perf-test PR 首跑后看次场景对主指标的偏移幅度决定

---

## 13. 与 benchmark v2 一致性

- ✅ benchmark v2 §9 #1 D2 = 本 MD（优先级 #1，effort 1 PR / 1 周）
- ✅ benchmark v2 §10 measurement-before-optimization 原则递归应用于 D2 自身
- ✅ 本 MD 不预设 #2 grid virtualization 必做 — gate 输出决定 #2 是否必要
- ✅ 若 D2 输出 verdict **A_CSS_sufficient**，benchmark v2 §9 排序 #2 取消，全部 effort 转 #3 D3 permission matrix（节约 2-3 周）
- ✅ 若 D2 输出 verdict **B_frontend_dom_memory_bound**，#2 grid virtualization PR 开工时 §7.2 frontend DOM/memory 阈值反向作为虚拟化设计目标
- ✅ 若 D2 输出 verdict **C_backend_query_bound** 或 **D_client_algorithm_bound**，benchmark v2 §9 #2 仍取消（virtualization 不解此类瓶颈），代之以独立专属优化 PR 插入到 §9 顺序中重新排序

---

## 14. Next slice — perf-test PR（独立链节，待 explicit opt-in）

待本 MD merge + 用户 explicit 启动 instruction 后，下一 slice：

1. 新增 `scripts/ops/multitable-perf-baseline.mjs` — backend 半（复用 attendance pattern）
2. 新增 `tests/e2e/multitable-perf-baseline.spec.ts` — frontend 半（black-box only：Playwright `browserContext.tracing` + CDP + 注入 PerformanceObserver/MutationObserver/raf；不触碰产品代码）
3. 新增 `.github/workflows/multitable-perf-{baseline,highscale}.yml` — CI dispatch
4. 第一波 **36 baseline run**（3 rows × 6 metricProfile × 2 scenario `primary`/`expanded`）— 填 §6 JSON
5. 产 verification MD — propose §7.2 全部 thresholds（DOM/heap 绝对值与 slope 族 + scroll/interact 族 + backend 族共 16 字段）→ 锁定基线
6. 数据 review 后给出首跑 verdict（A/B/C/D；E 因不含 multi-client 不输出）
7. 决定 §10 seed Path A vs B
8. 决定 §12 五个 open questions

---

## 15. 风险 / 副作用

- **零代码风险**：本 MD docs-only
- **K3 stage-1 lock 边界**：默认 Path A 不触线；Path B 触线但需独立 opt-in
- **CI cost**：36 run × ~5min/run = ~3h（3 rows × 6 metricProfile × 2 scenario）；后续 long-run 单独审批
- **数据污染**：`ROLLBACK=true` default + Path A 复用现有 endpoint 即不污染
- **K3 PoC GATE 影响**：零 — D2 是 multitable 内核 polish，不属于 ERP 集成战线

---

## 16. 决策摘要

| 决策 | 选择 | 理由 |
|---|---|---|
| 本 slice 范围 | 仅 design MD | benchmark v2 §13 + advisor 5 个回答一致；perf-test 是独立链节 |
| 数值 threshold | TBD（首跑后回填）| measurement-before-optimization；任何预设数字都是 hallucination |
| Env-var pattern | Hybrid（backend 复用 attendance，frontend 新增）| 历史可比 + 不重新发明 |
| 输出格式 | JSON schema 锁定（§6）| 后续 #2 PR 须能机械化消费 ROI 证据 |
| 场景 | primary 主 + expanded ref | 主决策路径单一不被次要变量噪音掩盖 |
| Seed 路径 | Path A 优先，Path B 仅在阻塞时启 + 独立 opt-in | K3 stage-1 lock |
| 主导信号 | DOM node count `afterMountMax` + `per10kSlope` + JS heap `afterMountMax` + `per10kSlope`；delta 辅助 | CSS `content-visibility` 跳 paint/layout 但不减 DOM/heap 绝对值；只看 delta 会漏掉 mount 阶段已爆的关键问题 |
| Triage 模式 | 5-class A–E（E 暂悬置至 multi-client metric profile，本 PR 不输出）| 失败模式 ≠ "必做 JS 虚拟化"——可能是 backend query / client 算法 / Yjs 等；二分决策会让下一 PR 跑偏 |
| 测量立场 | v1 black-box only（Playwright + CDP + injected PerformanceObserver/MutationObserver/raf）| 不触碰产品代码；`performance.mark` 注入命名 mark 留 v2 separate opt-in |

---

## 17. Changelog

### v3 (2026-05-24) — Stale-wording cleanup（push 前第二轮）

v2 改了 §7（4-way triage）、§16（决策摘要 Triage/测量立场）、§6（JSON schema `passFail` → `verdict`），但同文 §1 / §13 / §14 / §15 仍残留 v1 binary 措辞，逻辑上互相矛盾。v3 对齐：

- **§1 目标**："本 gate 输出是一个二分判断" → 5-class triage verdict 全文展开；明确**仅 verdict B_frontend_dom_memory_bound 触发虚拟化**，A/C/D/E 各走专属路径
- **§6 schema 后说明**："`passFail` 在 §8 ... 回填" → `verdict` 由 trend-report 按 §7.1 决策树自动分类
- **§13 与 benchmark v2 一致性**："CSS-virt sufficient" / "Needs JS virtualization" → verdict A / B / C+D（C/D 同样取消 v2 §9 #2，代之以专属优化 PR）
- **§14 Next slice**："18 run（3 rows × 6 metricProfile）" + "thresholds X/Y/Z/W/V" → 36 run（3 rows × 6 metricProfile × 2 scenario） + thresholds 16 字段全族（DOM/heap 绝对值与 slope + scroll/interact + backend）
- **§15 CI cost**："18 run × ~5min/run = ~1.5h" → 36 run × ~5min/run = ~3h

### v2 (2026-05-24) — Post-review precision pass（push 前）

3 个 Should-Fix finding 修正：

- **§7 二分 → 4-way triage**：原 "任一不达标 → Needs JS virtualization" 是错误推论；失败可能源自 backend query / client 算法 / Yjs sync 等，JS 虚拟化只解 frontend DOM-memory bound 一类。改为 A_CSS_sufficient / B_frontend_dom_memory_bound / C_backend_query_bound / D_client_algorithm_bound / E_yjs_sync_overhead_bound 5 类 verdict（E 本 PR 仅声明分类位）。
- **§4 / §6 / §7 阈值结构修正**：原以 `domNodes.delta` / `jsHeapMb.delta` 为主导是错觉——CSS `content-visibility: auto` 跳 paint/layout 但不减 DOM/heap 绝对值，scroll 前后 delta 可能接近零却 mount 已经爆。改为 `afterMountMax` + `per10kSlope` 为主导，delta 仅辅助。JSON schema metrics + thresholds 同步扩展。
- **§3.3 black-box 立场 + tracing API 修正**：原写 `page.tracing.start` 是错误 API（Playwright tracing 是 `browserContext.tracing.start`）；原文又提到在 grid hook 加 `performance.mark/measure` 会触碰 `apps/web/src/**` 与"零产品代码"口径冲突。改为明确 v1 black-box only（Playwright + CDP + 注入 PerformanceObserver/MutationObserver/raf），产品代码命名 mark 留 v2 separate opt-in。同步修正 §4 metric matrix 工具列 4 处 `performance.mark/measure` 表述。

旁路更新：§16 决策摘要补 Triage 模式 + 测量立场两行；§6 JSON schema `passFail` 字段替换为 `verdict` 字段（5 类 enum）；JSON metrics 加 `per10kSlope` 字段。

### v1 (2026-05-24) — Initial scout + design
- 关键 pivot：发现 `content-visibility: auto` 已在 line 606 — benchmark v1/v2 "无虚拟化"假设需修正
- 复用 attendance-perf.mjs env-var 约定保证历史可比
- 6 层 × 12 metric 矩阵，DOM node + JS heap 为主导信号（CSS-virt 盲点）
- Output JSON schema 锁 + threshold TBD 流程明确
- Seed 路径双轨（A 优先 / B 备用 + 独立 opt-in）
- Open questions 5 项（含生产 row upper-bound 未知）显式声明非本 PR 范围
