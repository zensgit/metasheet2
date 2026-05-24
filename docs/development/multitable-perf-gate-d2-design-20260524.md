# Multitable D2 大表性能基线门 — Scout & Design

Date: 2026-05-24
Status: docs-only design（无产品代码改动）— 后续 perf-test impl PR 独立链节
Branch: `docs/multitable-perf-gate-d2-scout-20260524`
Anchors:
- benchmark v2 §9 #1 `D2 large-table perf gate` 优先级 #1
- benchmark v2 §10 key judgment 原则 "measurement-before-optimization"
- benchmark v2 §13 changelog "perf gate before virtualization"

---

## 1. 目标

建立 multitable grid 在 **10k / 50k / 100k 行**规模下的可重复测量方法论 + 验收 JSON schema。

**本 gate 输出是一个二分判断**，不是预设的虚拟化方案：
- "CSS-native virt sufficient" — 已有的 `content-visibility: auto` 已足够，无需 JS 虚拟化
- "Needs JS virtualization" — CSS-native virt 在 N 行规模下崩盘，明确解锁 §9 #2 grid virtualization PR

这是把 benchmark v2 §10 measurement-before-optimization 原则递归地应用到 D2 自身：D2 不是"做虚拟化"的 PR，是"决定要不要做虚拟化"的 PR。

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

D2 perf-test PR 必须新增 frontend 测量层：
- **Playwright tracing API** — `page.tracing.start({ screenshots: false, snapshots: false, sources: false })` 收 perf timeline
- **PerformanceObserver** — `longtask` / `largest-contentful-paint` / `layout-shift`
- **`performance.mark/measure`** — 在 grid mount/update/scroll/edit/sort/filter/group hook 处打桩
- **Chrome DevTools Protocol via Playwright** — `Memory.getDOMCounters()` / `Performance.getMetrics()` 抓 DOM node count + JS heap

### 3.4 multitable bulk insert 入口（perf-test PR 待最终确认）

`packages/core-backend/src/multitable/` 内有 `record-write-service.ts` / `xlsx-service.ts` / `record-service.ts` — 候选 bulk insert path。D2 perf-test PR 第一步任务：确认 100k 级别 bulk insert 端点是否 ready、是否需新 seed endpoint（见 §9 Seed 策略决策）。

---

## 4. Metric 矩阵 — 6 层 × 12 数据点

| 层 | Metric | 何时是 discriminator | 工具 |
|---|---|---|---|
| Frontend mount | TTI after data arrives (ms) | CSS-virt 跳过 *之前* 的代价 | Playwright `page.evaluate` + `performance.mark` 在 `onMounted` |
| Frontend scroll | scroll FPS p50/p95/min | CSS-virt 实力体现处 | rAF delta + scroll loop |
| Frontend scroll | Long Task count + 总时长 | scripting bottleneck | PerformanceObserver `longtask` |
| **Frontend memory** | **DOM node count @ mount vs scroll-bottom + delta** | **CSS-virt 盲点 — 主导信号** | CDP `DOM.getDocument` 计数 |
| **Frontend memory** | **JS heap MB @ mount vs scroll-bottom + delta** | **CSS-virt 盲点 — 主导信号** | CDP `Performance.getMetrics` `JSHeapUsedSize` |
| Frontend interact | cell-edit roundtrip (focus→keystroke→commit) p50/p95 ms | scripting hot path（非 paint）| `performance.measure` 跨 hook |
| Frontend interact | sort apply latency (ms) | full-data re-sort scripting | `performance.measure` |
| Frontend interact | filter apply latency (ms) | full-data re-filter scripting | `performance.measure` |
| Frontend interact | group apply latency (ms) | groupedRows 计算 + 渲染 | `performance.measure` |
| Backend insert | bulk-insert p50/p95/p99 ms（一次入 N 行）| attendance pattern 直接迁移 | hybrid 复用 attendance-perf.mjs |
| Backend query | view-load latency at N rows (ms) | 数据进 frontend 之前的成本 | hybrid 复用 attendance-perf.mjs |
| Backend query | group/filter applied at backend latency (ms) | server-side 优化 ROI 参考 | hybrid 复用 attendance-perf.mjs |

**主导信号顺位**：
1. **DOM node count delta + JS heap delta** — CSS-virt 盲点；这两个数决定 CSS-virt 是否足够
2. scroll FPS p95 + Long Task count — 用户感知核心
3. cell-edit / sort / filter / group apply latency — 交互连续性
4. Backend insert/query — 后端瓶颈是否前置

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
    "domNodes": { "afterMount": null, "afterScrollBottom": null, "delta": null },
    "jsHeapMb": { "afterMount": null, "afterScrollBottom": null, "delta": null },
    "editCellRoundtripMs": { "p50": null, "p95": null },
    "sortApplyMs": null,
    "filterApplyMs": null,
    "groupApplyMs": null,
    "backendInsertMs": { "p50": null, "p95": null, "p99": null },
    "backendQueryMs": { "p50": null, "p95": null }
  },
  "thresholds": { "ttiMs": null, "scrollFpsP95Min": null, "domNodesDeltaMax": null, "jsHeapMbDeltaMax": null },
  "passFail": "TBD",
  "notes": []
}
```

`thresholds` 与 `passFail` 在 §8 接受标准首跑后由人 review 后回填——之后变成 CI gate 的硬性比较。

`scenario` 取值：`primary`（collapsed row）或 `expanded`（部分行展开 — `EXPANDED_ROW_RATIO > 0`）。

---

## 7. 接受标准 — Decision branch（threshold 数值首跑后回填）

**「CSS-virt sufficient」当且仅当下列**全部**满足**（threshold X/Y/Z 待 perf-test PR 首跑后人工 review 锁定）：

1. `scrollFps.p95` ≥ X（候选 50 fps，需基线验证）
2. `domNodes.delta` < Y（候选 10% of `afterMount`，即接近零 — `content-visibility` 不应增 DOM）
3. `jsHeapMb.delta` < Z（候选 50 MB，需基线验证）
4. `editCellRoundtripMs.p95` < W（候选 200ms，行业基线）
5. `sortApplyMs` / `filterApplyMs` < V at N=50k（候选 1s，需基线验证）

**任一不满足 → "Needs JS virtualization"**，解锁 §9 #2 PR + 提供具体 ROI 论证（"虚拟化要打到这几个数才合理"）。

数值锁定流程：
1. perf-test PR 实施 metric collection
2. 三档 rows × 6 metricProfile = 18 baseline run
3. 数据进 trend-report，人工 review
4. 在新的 verification MD 里 propose threshold X/Y/Z/W/V
5. Threshold 锁定 = 后续 CI gate 比较基准

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
- ✅ 若 D2 输出 "CSS-virt sufficient"，benchmark v2 §9 排序 #2 取消，全部 effort 转 #3 D3 permission matrix（节约 2-3 周）
- ✅ 若 D2 输出 "Needs JS virtualization"，#2 PR 开工时 §6 acceptance 阈值反向作为虚拟化设计目标

---

## 14. Next slice — perf-test PR（独立链节，待 explicit opt-in）

待本 MD merge + 用户 explicit 启动 instruction 后，下一 slice：

1. 新增 `scripts/ops/multitable-perf-baseline.mjs` — backend 半（复用 attendance pattern）
2. 新增 `tests/e2e/multitable-perf-baseline.spec.ts` — frontend 半（Playwright tracing + PerformanceObserver + CDP）
3. 新增 `.github/workflows/multitable-perf-{baseline,highscale}.yml` — CI dispatch
4. 第一波 18 run（3 rows × 6 metricProfile）— 填 §6 JSON
5. 产 verification MD — propose §7 thresholds X/Y/Z/W/V → 锁定基线
6. 决定 §10 seed Path A vs B
7. 决定 §12 五个 open questions

---

## 15. 风险 / 副作用

- **零代码风险**：本 MD docs-only
- **K3 stage-1 lock 边界**：默认 Path A 不触线；Path B 触线但需独立 opt-in
- **CI cost**：18 run × ~5min/run = ~1.5h；后续 long-run 单独审批
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
| 主导信号 | DOM node count delta + JS heap delta | CSS-virt 盲点 — advisor 关键洞察 |

---

## 17. Changelog

### v1 (2026-05-24) — Initial scout + design
- 关键 pivot：发现 `content-visibility: auto` 已在 line 606 — benchmark v1/v2 "无虚拟化"假设需修正
- 复用 attendance-perf.mjs env-var 约定保证历史可比
- 6 层 × 12 metric 矩阵，DOM node + JS heap 为主导信号（CSS-virt 盲点）
- Output JSON schema 锁 + threshold TBD 流程明确
- Seed 路径双轨（A 优先 / B 备用 + 独立 opt-in）
- Open questions 5 项（含生产 row upper-bound 未知）显式声明非本 PR 范围
