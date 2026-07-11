# Integration lane F: K3 WISE setup view — full tokenization + errorSummary sanitization — dev verification (2026-07-07)

Scope: design-lock `docs/development/integration-ux-workbench-redesign-design-lock-20260706.md`
§3 hard locks — **token-only** (UF-1 `apps/web/src/styles/tokens.css` header: new hardcoded hex in
views = DEFECTS) and **values-free 展示纪律** (ratified P2 clause: labels layer consumes the exact
registered closed vocabulary only; **raw errorMessage 永不显示** — any layer, including collapsed).
Display-only slice: zero route/service-wire/permission/backend changes; all existing spec
assertions pass UNCHANGED (none pinned the raw errorSummary text).

## 1. Tokenization — hex/rgb() count 107 → 0

`apps/web/src/views/IntegrationK3WiseSetupView.vue` `<style scoped>` block:

| Metric | Before | After |
|---|---|---|
| hex/rgb() literals in `<style>` | **107** (32 distinct values) | **0** |
| `var(--ms-*)` consumptions | 0 | 77 |
| `var(--el-*)` consumptions | 0 | 30 |
| static `style="…"` attrs | 0 | 0 (nothing to purge) |

Mapping follows the UF-6 (46303349b) / IU-2a (3e5570b47) patterns — semantic repaint onto the
UF-1 palette, not色号複製:

- Slate text scale `#111827/#172033` → `--ms-text-1`; `#334155/#475569/#526072/#64748b` → `--ms-text-2`.
- Neutral chrome `#d9e1ec/#e2e8f0` borders → `--ms-border-light`; `#cbd5e1` → `--ms-border`;
  `#fff` → `--ms-bg-card`; `#f6f8fb/#f8fafc` → `--ms-bg-page`; chip/badge neutral bg `#e2e8f0` →
  `--el-fill-color-dark`; code-line bg `#f1f5f9` → `--el-fill-color-light`.
- Old teal accent (`#0f766e` primary button, `#99f6e4` primary-section border, `#ccfbf1/#f0fdfa/#115e59`
  open-target card) → primary family (`--ms-color-primary`, `--el-color-primary-light-7/-8/-9`,
  `--el-color-primary-dark-2`) — the same teal→site-primary repaint IU-2a applied.
- Status semantics keep their families: success (`#99f6e4/#f0fdfa/#115e59/#ccfbf1` in status/badge
  success context → `--el-color-success-light-7/-8/-9/-dark-2`), warning (`#facc15/#fefce8/#744600/`
  `#92400e/#9a3412/#fef3c7/#fed7aa/#fff7ed` → `--el-color-warning-light-3/-7/-8/-9/-dark-2`), danger
  (`#fecaca/#fff1f2/#9f1239/#ffe4e6` → `--el-color-danger-light-7/-8/-9/-dark-2`).
- Dark expert JSON panels `#0f172a` bg + `#e2e8f0` text → `background: var(--ms-text-1)` +
  `color: var(--el-color-primary-light-9)` — byte-for-byte the IU-2a Workbench `pre` recipe.
- Copy-button hover border `#94a3b8` → `--ms-color-primary` (Workbench hover precedent).

CI enforcement: file added to `apps/web/tests/ui-foundation-style-guard.spec.ts` `TARGET_FILES`
(hex/rgb-literal count pinned to 0, static-style= pinned to 0) and to both
`.github/workflows/approval-web-guard.yml` path-filter lists (pull_request + push) so future edits
to the view re-trigger the guard. Mutation-proof: re-adding a single `color: #ffffff` to the style
block turns `ui-foundation-style-guard` RED (run recorded below), then reverted.

## 2. errorSummary leak-hole closure + full error-render audit

The IU-1 verification MD (`integration-iu1-error-code-labels-dev-verification-20260706.md`) had
explicitly flagged `run.errorSummary` (~line 376) as the remaining raw-render gap. Per the ratified
P2 clause, display of backend error text in this view is now limited to exactly two forms:
(a) the humanized label of an **exactly registered** errorCode (`integrationErrorCodeLabels`
closed vocabulary, exact-key lookup), or (b) **fixed values-free copy**. Raw strings stay in
component state (regex safe-reason tests, programmatic use) — they never reach the DOM, including
collapsed `<details>`.

### Closed sites (raw backend text could reach the DOM)

| # | Site (template/script) | Before | Disposition |
|---|---|---|---|
| 1 | `{{ run.errorSummary }}` (最近运行 list) | raw backend free text (`pipeline-runner.cjs` writes `error.message` into it) | **CLOSED** — `runErrorDisplay(run)`: registered `errorCode` on the run object/details → humanized label via `integrationErrorCodeDisplayLabel`; otherwise fixed fallback copy zh 「运行失败，详情见服务端日志/诊断。」/ en "Run failed — see server logs/diagnostics." `v-if` stays keyed on `errorSummary` presence (boolean use only). New testid `k3-run-error-<id>`. |
| 2 | `{{ system.lastError }}` (已保存系统 list) | raw persisted backend text | **CLOSED** — `savedSystemErrorDisplay`: executor-missing pattern → pre-existing fixed safe-reason copy (raw is pattern-TESTED only, never echoed); otherwise fixed connection-failure fallback copy (zh+en). New testid `k3-saved-system-error-<id>`. |
| 3 | `webApiConnectionStatus.message` failed branches (embedded `webApiLastTest.lastError` / `system.lastError`) | raw tail after 「上次连接测试失败：」 | **CLOSED** — both branches return the fixed connection-failure fallback copy. |
| 4 | `testResultSummary` — `summarizeConnectionTestResult` generic failure branch embedded `message \|\| lastError \|\| code`; catch branches embedded `formatError(error)` | raw backend text | **CLOSED** — generic branch → fixed 「…测试失败：服务端错误详情已按 values-free 纪律收起，见服务端日志。」; catch branches → fixed copy. The SQLSERVER_EXECUTOR_MISSING safe-reason branch (already fixed copy, spec-pinned) kept byte-identical. |
| 5 | `<pre>{{ testResult }}</pre>` (collapsed diagnostics JSON) | raw envelope incl. `message`/`system.lastError` free text | **CLOSED** — `stringifyForDisplay` deep-scrubs values of the free-text error keys `message`/`errorMessage`/`lastError`/`errorSummary` to a fixed placeholder before stringify. JSON structure, codes, status flags, diagnostics keys preserved (design-lock 专家能力不降级 — 折叠≠删除); state keeps the raw envelope. |
| 6 | `<pre>{{ pipelineRunResult }}</pre>` (run envelope may carry `errorSummary`, row errors, dead-letter messages) | raw in expert JSON | **CLOSED** — same `stringifyForDisplay` scrub. |
| 7 | `<pre>{{ stagingResult }}</pre>` (install envelope) | no error-text keys today | **CLOSED defensively** — same scrub applied (`warnings` key deliberately NOT scrubbed: server-composed operator guidance vocabulary, not an error free-text channel). |
| 8 | `{{ statusMessage }}` catch paths ×9 (`loadSystems`/`saveConfiguration`/`testWebApi`/`testSqlServer`/`loadStagingDescriptors`/`installStagingTables`/`createPipelineTemplates`/`refreshPipelineObservation`/`executePipeline`) | `setStatus(formatError(error))` — `parseIntegrationResponse` throws `new Error(payload?.error?.message …)`, i.e. the server envelope's free text reached the DOM | **CLOSED** — each catch now sets a fixed, operation-scoped zh copy (「…失败，详情见服务端日志。」), matching the view's existing zh-hardcoded statusMessage style. |
| 9 | `{{ statusMessage }}` clipboard catch paths ×2 (`copyGateDraft`/`copyGateCommand`) | browser-generated `Error.message` (not backend text) | **CLOSED for uniformity** — fixed 「复制失败，请手动选择文本复制。」 keeps the "Error.message never reaches the DOM" invariant absolute across the view. |

### Audited and RETAINED (no backend free text can flow)

| Site | Reason |
|---|---|
| `{{ deadLetterErrorLabel/Hint }}` + `errorCode: {{ deadLetter.errorCode }}` | IU-1 label layer (closed vocab); raw errorCode is a registered closed set — safe per the P2 clause itself. Unchanged. |
| `importGateJson` catch → `setStatus(formatError(error))` | `applyK3WiseGateJsonToForm` is fully CLIENT-side; throws only our own fixed validation copy about the user's own paste ('GATE JSON must be valid JSON' etc.). Values-free and useful; inline comment added. |
| `setStatus(issues[0].message)` ×5 + `stagingIssues`/`pipelineIssues`/`materialRunIssues`/`bomRunIssues`/`gateIssues` `<li>` lists | client-side validator copy from `k3WiseSetup.ts` (fixed strings). |
| `deployGateChecklist` `item.message`/`item.status` | client-computed (`buildK3WiseDeployGateChecklist`). |
| `gateImportWarnings` `<li>` list | client-generated by `applyK3WiseGateJsonToForm`. |
| `{{ gateDraftText }}`, `{{ gateEnvTemplate }}`, gate command strings, `{{ templatePreviewJson }}` | client-built from the form (export path already uses placeholders for secrets). |
| `referenceCompletenessPreview.error` / `entry.reason` / summary counts | client-side sample parsing of the user's own pasted JSON. |
| `system.name/kind/status`, `run.id/status`, `deadLetter.id/status/retryCount`, descriptor `id/name/fields` | identifiers + closed enums + own-tenant config data — values-free machine vocab or user's own data, not error free-text channels (same treatment as Workbench/IU-1). |
| `statusMessage` success/info paths (incl. `已载入 ${system.name}`, `Project ID 已规范化为 ${normalized}`) | fixed copy + own-input echo. |

## 3. Tests

`apps/web/tests/IntegrationK3WiseSetupView.spec.ts` (7 → 10 tests), all mounted-DOM:

1. **run.errorSummary sentinel** — plants `SENTINEL-RAW-🙅 secret=hunter2` in `errorSummary`;
   asserts sentinel absent from `container.textContent` AND `container.innerHTML`; fixed fallback
   copy renders (en default); a run carrying registered `errorCode: 'VALIDATION_FAILED'` renders
   the humanized label ("Data validation failed."), not the code, not the summary; then
   `useLocale().setLocale('zh-CN')` → zh fallback 「运行失败，详情见服务端日志/诊断。」+ zh label
   「数据校验未通过」 (locale restored in `afterEach`).
2. **saved-system lastError sentinel** — generic backend `lastError` → fixed fallback copy;
   executor-missing `lastError` → fixed safe-reason copy without echoing the raw tail; WebAPI
   status line failed branch shows fixed copy; sentinel absent from text and innerHTML.
3. **connection-test failure** — `ok:false` envelope with sentinel `message`/`system.lastError`:
   prominent summary shows the fixed values-free failure copy; collapsed diagnostics JSON retains
   the code (`K3_WISE_TEST_FAILED`) but shows the scrub placeholder in place of free text; sentinel
   absent from the entire DOM.

Existing 7 tests (incl. the IU-1 dead-letter sentinel test and the spec-pinned
SQLSERVER_EXECUTOR_MISSING summary assertions) pass **unchanged** — no assertion pinned the raw
`errorSummary` text, so none needed updating.

### Runs

- Default Node **v25.9.0**: full integration-guard web list (18 files / 207 tests) ✅ +
  `ui-foundation-style-guard` (67 tests incl. new target file) ✅ + `pnpm --filter
  plugin-integration-core test` (full CJS chain) ✅.
- **Node v20.20.2** (nvm, CI runtime): same guard list + style guard = 19 files / 274 tests ✅ +
  plugin CJS chain ✅.
- `vue-tsc -b` clean; `pnpm --filter @metasheet/web run build` succeeds.
- Mutation proofs (run after the real commit, then reverted):
  1. style guard: re-added `color: #ffffff` to the view's style block → `ui-foundation-style-guard`
     RED on `src/views/IntegrationK3WiseSetupView.vue` (expected 0, got 1);
  2. sentinel: restored `{{ run.errorSummary }}` raw interpolation → lane-F run-sentinel test RED.

## 4. Out of scope (unchanged)

Routes, `services/integration/*.ts` wire shapes, permission gates, backend/plugin code, the
Workbench view (IU-2 lanes), ReadSourceConfigPanel/wizard/bridge files (sibling PRs #3821/#3822/
#3824 — zero file overlap with this slice), markup/behavior beyond the two sanitized `<small>`
render sites and their new testids.
