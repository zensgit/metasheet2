# Multitable D2 Perf Gate — Impl PR Verification

Date: 2026-05-24
Status: harness impl verification（首次 CI baseline run + 阈值 propose 留作下一独立链节）
Subject design MD: `docs/development/multitable-perf-gate-d2-design-20260524.md` (v3)
Branch: `frontend/multitable-d2-perf-test-impl-20260524`

---

## 1. PR scope（per user 2026-05-24 lock）

本 PR 严格交付：

- ✅ Black-box harness — backend mjs + frontend spec
- ✅ workflow_dispatch CI 触发面（baseline 10k + highscale 50k/100k）
- ✅ 本地 harness 机械验证（syntax / typecheck / playwright spec --list）
- ⏳ **首次 CI baseline run** — workflow_dispatch 手动触发（需 user + staging env 配置）
- ⏳ **verification MD propose thresholds** — 待 CI baseline 数据回填

明确**不交付**（独立链节，需独立 explicit opt-in）：
- ❌ Threshold lock — 留作 review-and-lock 独立 PR（需 1 次首跑 + 1 次复跑稳定性验证）
- ❌ Virtualization 实现 — 仅 verdict B_frontend_dom_memory_bound 触发，独立 PR
- ❌ Backend seed endpoint — Path A 默认零 backend touch；Path B 独立 kernel-polish opt-in
- ❌ Product code performance.mark 注入 — v2 separate opt-in
- ❌ multi-client metric profile / verdict E — 独立后续 slice

---

## 2. Path A reachability 决策记录

**Verdict: REACHABLE**（无 `packages/core-backend/src/**` 修改需求）。

| 维度 | 结果 |
|---|---|
| 端点 | `POST /api/multitable/sheets/:sheetId/import-xlsx` (`packages/core-backend/src/routes/univer-meta.ts:5541`) |
| 模式 | 同步：服务端 for-loop 调 `recordService.createRecord` per row（multitable 无 async-commit pattern，不同于 attendance）|
| XLSX 文件大小上限 | **100 MB**（`XLSX_MAX_BYTES`，`xlsx-service.ts:6`）— 100k 行 ~5 MB 充裕 |
| **单次 row 上限** | **`XLSX_MAX_ROWS = 50_000`**（`xlsx-service.ts:5`）— 超过则 `truncated: true` |
| 100k seed 实现 | **2 次 ≤50k chunked upload**（无需 backend 修改）|
| 字段类型 enum | `MULTITABLE_FIELD_INPUT_TYPES`：`string` / `number` / `date` / ...（注：text 类是 `'string'`，非 `'text'`）|
| Yjs 控制 | `yjsInvalidator: null` 时不触发 invalidation hook（`univer-meta.ts:187-189`）；通过 `ENABLE_YJS_COLLAB!=true` env 关闭（`index.ts:1075,1958`）|
| Rollback | `DELETE /api/multitable/sheets/:sheetId`（`univer-meta.ts:5417`）+ `meta_records.sheet_id` FK `onDelete('cascade')`（migration `zzz20251231_create_meta_schema.ts:46`）干净级联 |

---

## 3. 锁定决策记录（2026-05-24）

| 决策 | 选择 | 理由 |
|---|---|---|
| Yjs invalidation | **OFF**（`ENABLE_YJS_COLLAB=false`）| 与 design §13 `E_yjs_sync_overhead_bound` deferred 一致；B/C/D 与 E 隔离纯净度；advisor 关键洞察 — Yjs hook 触发 per record 会污染 backend insert p95 |
| Field set | **20 fields = 16 string + 2 number + 2 date** | server validation 轻；DOM = 20 cells × N rows；baseline 主测 CSS-virt + grid renderer 瓶颈，不被字段类型 cost 干扰 |
| Seed 路径 | Path A 优先（chunked XLSX upload @ 50k）| 零 backend touch；Path B 需独立 kernel-polish opt-in |
| Seed vs Measure 拆分（advisor 结构性修正）| **3 阶段**：XLSX seed (aggregate timing) + 200×POST /records (per-record p50/p95/p99) + 50×GET /records (query distribution) | XLSX 给的是 server-side for-loop 总耗时，不是 per-record 分布；混淆 → verdict 误判 |
| 测量立场 | **v1 black-box only** | 不触碰 `apps/web/src/**`；产品代码 `performance.mark` 注入留 v2 separate opt-in |
| CI 触发面 | workflow_dispatch only | NO push trigger，NO schedule trigger；perf cost 不入标准 PR pipeline |
| 阈值锁定 | TBD（首跑 + 复跑后 propose）| measurement-before-optimization 原则；本 PR 不锁 |
| Verdict 模型 | 5-class A/B/C/D + E deferred | 唯一 B_frontend_dom_memory_bound 触发 virtualization；C/D 各走专属 PR |

---

## 4. Harness 实现摘要

### 4.1 Backend mjs — `scripts/ops/multitable-perf-baseline.mjs` (424 lines)

Path A discipline + advisor 修正全部落地：

- **`ensureBase` / `ensureSheet` / `ensureFields` / `ensureView`** — 4-step fixture 创建（20 fields 共调 20 次 POST /fields，加 base/sheet/view 共 23 个 setup HTTP calls）
- **`seedRows`** — chunked XLSX upload at `XLSX_CHUNK_SIZE=50000`；100k 自动 2 chunk
- **`buildXlsxBuffer`** — `xlsx` npm 包 `utils.aoa_to_sheet` + `book_append_sheet` + `write({type:'buffer'})`；headers 与 field 名一致 → 服务端 `mapXlsxColumnsToFields` 自动映射，**不需要 mapping form field**
- **`measureBackendInsertDistribution`** — 200 × POST /records，performance.now() 包夹
- **`measureBackendQueryDistribution`** — 50 × GET /records?filter._bust=<random>，cache-bust via 随机 filter key（advisor 提醒：line 6936 records cache）
- **`deleteSheet`** — rollback 单调用，FK cascade 自动清记录
- **xlsx 解析** — `createRequire(packages/core-backend/package.json)` fallback（顶层 workspace 不 hoist；从 packages/core-backend 解析 0.18.5）

环境变量（attendance pattern 兼容）：
- 复用：`ROWS` / `MODE` / `PERF_PROFILE` / `ROLLBACK` / `API_BASE` / `AUTH_TOKEN`（never logged）
- 新增：`PHASE=seed_and_backend|rollback` / `SCENARIO=primary|expanded` / `XLSX_CHUNK_SIZE=50000` / `BACKEND_INSERT_SAMPLE_SIZE=200` / `BACKEND_QUERY_SAMPLE_SIZE=50` / `STATE_FILE` / `BASELINE_ID` / `CI_RUNNER_TAG` / `OUTPUT_DIR` / `BASE_ID` / `SHEET_ID`

输出：`output/multitable-perf/baseline-<rows>-backend-<scenario>-<baselineId>.json`，per design §6 schema（backend metrics 填充；frontend 字段 null 待 spec 跑后合并）。

### 4.2 Frontend spec — `packages/core-backend/tests/e2e/multitable-perf-baseline.spec.ts` (421 lines)

V1 black-box only：

- **`addInitScript` 注入** `window.__d2Perf`：
  - `PerformanceObserver(longtask|paint)` — 收 longtask + paint events
  - `startFpsSampling` / `stopFpsSampling` — rAF 时间差采样
  - `observeStability(selector, timeoutMs)` — MutationObserver 派生 "interactive" 时点
  - `snapshot()` / `reset()` — 周期采集
- **CDP via `context.newCDPSession(page)`**：
  - `Memory.getDOMCounters` → DOM node count @ mount + @ scroll-bottom
  - `Performance.getMetrics` → `JSHeapUsedSize` → MB
- **`browserContext.tracing`** — full timeline zip (`screenshots=false, snapshots=false, sources=false`)
- **TTI** — `Date.now()` 包夹 nav + grid 稳定（1500ms MutationObserver silence）
- **per metricProfile dispatch**：
  - `mount` — FULL（TTI + DOM/heap snapshot）
  - `scroll` — FULL（FPS p50/p95/min + longtask + DOM/heap @ scroll-bottom）
  - `edit` / `sort` / `filter` / `group` — **SCAFFOLDED with TODO(d2-followup)** — UI selector stability + reset-between-interactions 设计留独立 PR

环境变量：`METRIC_PROFILE` / `SCENARIO` / `ROWS` / `PERF_PROFILE` / `BASELINE_ID` / `CI_RUNNER_TAG` / `OUTPUT_DIR` / `STATE_FILE` / `VIEWPORT_{WIDTH,HEIGHT}` / `DEVICE_SCALE_FACTOR` / `SCROLL_TARGET` / `TARGET_SHEET_ID` / `TARGET_VIEW_ID`

Targets：`STATE_FILE`（mjs seed phase 写）or `TARGET_SHEET_ID + TARGET_VIEW_ID` env override。

输出：`output/multitable-perf/baseline-<rows>-<metricProfile>-<scenario>-<baselineId>.json` per §6。

### 4.3 CI workflows — 2 个 yml（343 lines 合计）

- `.github/workflows/multitable-perf-baseline.yml` — 1k / 10k，timeout 30 min
- `.github/workflows/multitable-perf-highscale.yml` — 50k / 100k，timeout 90 min（100k chunked XLSX seed 可能 15-30 min server-side）

两个均：
- **workflow_dispatch ONLY**（无 push/schedule/PR trigger）
- inputs：`rows` / `metric_profile` / `scenario` / `api_base` / `fe_base`
- env：`ENABLE_YJS_COLLAB=false`（server-side Yjs off）
- 顺序：env validate → backend seed+measure → frontend Playwright → rollback (always)
- 产 30-day-retention artifact: `output/multitable-perf/**`
- 需 secret `MULTITABLE_PERF_AUTH_TOKEN`，vars `MULTITABLE_PERF_{API_BASE,FE_BASE}`

Full baseline = 36 dispatches（3 rows × 6 metricProfile × 2 scenario），用户用 wrapper script 触发：

```bash
for rows in 10000 50000 100000; do
  WF=$([[ $rows == "10000" ]] && echo "multitable-perf-baseline.yml" || echo "multitable-perf-highscale.yml")
  for mp in mount scroll edit sort filter group; do
    for sc in primary expanded; do
      gh workflow run "$WF" -f rows="$rows" -f metric_profile="$mp" -f scenario="$sc"
    done
  done
done
```

---

## 5. Mechanical validation log（live smoke deferred）

| 验证 | 工具 | 结果 |
|---|---|---|
| Backend mjs syntax | `node --check scripts/ops/multitable-perf-baseline.mjs` | OK ✓ |
| Frontend spec typecheck | `tsc --noEmit -p packages/core-backend/tsconfig.json` | OK ✓（0 errors specific to spec）|
| Playwright spec parseable | `playwright test --list multitable-perf-baseline.spec.ts` | 1 test listed correctly ✓ |
| Workflow yml validate | `python3 -c "import yaml; yaml.safe_load(...)"` × 2 | both OK ✓ |
| xlsx createRequire fallback | `createRequire(.../packages/core-backend/package.json).resolve('xlsx')` | resolved 0.18.5 ✓ |
| DELETE /sheets cascade | `meta_records.sheet_id.onDelete('cascade')` 直接确认 migration line 46 | ✓ |

**Live smoke（实际命中 endpoints）deferred**：
- 本机 dev stack 未启动（API :7778 / FE :8899 / staging :8081 均不可达）
- 等价覆盖路径：**首次 CI workflow_dispatch run 即 live smoke at scale**
- 替代验证：本表 6 项机械验证（syntax / typecheck / parseability / yml validity / dep resolution / FK cascade）覆盖 v1 harness 的可达性 + 结构正确性

---

## 6. Design deltas 发现（discovered during impl）

advisor + impl 过程中发现的 design 修订（不阻塞，记录作 design v4 candidate）：

| Delta | 说明 |
|---|---|
| **D1: Seeding ≠ measuring**（advisor 结构性修正）| design v3 §4 metric matrix 把 backend insert 描述为"hybrid 复用 attendance-perf.mjs"暗示了一个 endpoint = 一个 metric。实际 XLSX seed 给的是 aggregate timing，per-record 分布需独立 ~200 × POST /records 样本。harness 已实现为 3 阶段（seed / insert sample / query sample），design v4 candidate 需更新 §4 metric matrix 工具列描述 |
| **D2: Multitable 无 async-commit pattern** | design §5.1 `PREVIEW_ASYNC_ROW_THRESHOLD=50000` 是从 attendance 复制的假设，对 multitable 不适用。multitable 同步 XLSX upload；50k 是 server-side row cap (`XLSX_MAX_ROWS`)，非 async 阈值。harness env var 已改为 `XLSX_CHUNK_SIZE=50000`，design v4 candidate 需明确两者不可混淆 |
| **D3: Yjs invalidation 默认 off** | design §3.3 测量立场未涉及 server-side Yjs 配置。Yjs 在 `ENABLE_YJS_COLLAB=true` 时才开（`index.ts:1075,1958`），CI/staging 默认 false。harness env enforced；verification MD §3 记录用户决策。design v4 candidate 可在 §3.3 或 §10/§11 边界声明部分补 Yjs server env requirement |
| **D4: XLSX_MAX_ROWS server cap** | design §10 Seed Path A 未列出 50k/upload 限制。harness 已 chunked 应对（100k = 2 chunks），但 design v4 candidate 应在 §10 Path A 描述中明确 |
| **D5: Field type enum is `'string'` not `'text'`** | design 文本表述用"text fields"是直觉用语，实际 schema enum 是 `'string'`。harness 已纠正；不影响 design 语义 |
| **D6: 36 → 12 优化未实现**（advisor 优化 #5）| advisor 建议 5 个非-mount metric profile 可共享 1 nav per scenario，把 36 run 优化为 12 run（节约 ~2.5h CI cost）。v1 PR 保持 36 run 简化结构；优化留作 follow-up impl PR。design v4 candidate 可在 §15 CI cost 部分补优化路径 |

design v4 是否启动取决于 CI baseline 跑出来后是否触发实际方法学变更；如果只是 D1-D5 标注性修正，可与 threshold lock PR 合并；如果 D6 优化要做，需独立 design delta MD。

---

## 7. Threshold proposal scaffold（TBD by first CI baseline）

待 36 baseline run 数据回填。结构 placeholder：

```json
{
  "thresholds": {
    "ttiMs": "TBD-CI-baseline-derived",
    "scrollFpsP95Min": "TBD",
    "longTaskCountMax": "TBD",
    "longTaskTotalMsMax": "TBD",
    "domNodesAfterMountMax": { "10k": "TBD", "50k": "TBD", "100k": "TBD" },
    "domNodesPer10kSlopeMax": "TBD",
    "domNodesDeltaMax": "TBD (auxiliary)",
    "jsHeapMbAfterMountMax": { "10k": "TBD", "50k": "TBD", "100k": "TBD" },
    "jsHeapMbPer10kSlopeMax": "TBD",
    "jsHeapMbDeltaMax": "TBD (auxiliary)",
    "editCellRoundtripP95Max": "TBD",
    "sortApplyMax": "TBD",
    "filterApplyMax": "TBD",
    "groupApplyMax": "TBD",
    "backendInsertP95Max": "TBD",
    "backendQueryP95Max": "TBD"
  }
}
```

每个 TBD 由人 review 36 个 baseline JSON + 至少 1 次复跑稳定性验证后 propose；最终 lock 通过下一独立 PR。

---

## 8. First verdict diagnosis scaffold（TBD by first CI baseline）

待 36 run 后由人 review JSON metrics + 决策树打标：

```
verdict = TBD ∈ { A_CSS_sufficient | B_frontend_dom_memory_bound | C_backend_query_bound | D_client_algorithm_bound }
(E_yjs_sync_overhead_bound 本 PR 不输出 — multi-client metric profile 未含)
```

如 verdict 是叠加（B+C / B+D / C+D），列全部 + 优先级。

---

## 9. 下一链节（待 explicit opt-in）

1. **首次 CI baseline run**（用户触发）：
   - 配置 GH secrets：`MULTITABLE_PERF_AUTH_TOKEN`
   - 配置 GH vars：`MULTITABLE_PERF_API_BASE` + `MULTITABLE_PERF_FE_BASE`
   - 触发 36 workflow_dispatch（用上述 wrapper bash）
   - 等 ~3h（baseline ~30min × 24 + highscale ~60min × 12 — 实际并发上限决定）
   - 下载 artifacts → 整合 36 个 JSON
2. **Review-and-lock PR**（独立 chain link）：
   - Propose §7 thresholds 数值
   - 输出 §8 verdict
   - 跑第 2 次复跑确认稳定性
   - Lock thresholds 为 CI gate baseline
3. **若 verdict B** → 启 grid virtualization PR（benchmark v2 §9 #2）
4. **若 verdict C** → 启 server-side optimization PR（独立 server lane）
5. **若 verdict D** → 启 client algorithm optimization PR（独立 frontend lane）
6. **若 verdict A** → benchmark v2 §9 #2 取消，effort 转 #3 D3 permission matrix

---

## 10. PR scope sanity check

- ✅ 零 `apps/web/src/**` 改动（black-box only）
- ✅ 零 `packages/core-backend/src/**` 改动（Path A 默认）
- ✅ 零 K3 / integration-core / attendance 触碰
- ✅ workflow_dispatch only（不入标准 PR pipeline）
- ✅ secrets / vars 显式，never logged
- ✅ rollback 默认 true，FK cascade 干净
- ✅ harness 机械验证 6/6 项通过

---

## 11. Changelog

### v1 (2026-05-24) — Initial impl PR verification

- Path A reachable 确认（XLSX endpoint + chunked 50k）
- 锁定决策 8 项（Yjs off / 20 fields / Path A / 3-phase split / black-box / workflow_dispatch / threshold deferred / 5-class verdict）
- Harness 实现 3 件套（mjs 424 lines + spec 421 lines + 2 yml 343 lines = 4 files / 1188 lines）
- Mechanical validation 6/6 ✓
- Design deltas 6 项发现（D1-D6 候选 design v4 修订）
- Threshold + verdict propose scaffold（待首跑回填）
- Next-link 流程 6 步明确
