# IU-2d: run-push 分区分解 — five focused sub-panels, zero behavior change — dev verification (2026-07-07)

Scope: design-lock `docs/development/integration-ux-workbench-redesign-design-lock-20260706.md`
(RATIFIED, #3739) §2 IU-2 stage D — the deliberate decomposition IU-2c (#3800) deferred with the
explicit instruction "decompose it into several focused components (one per sub-feature), not move
it as one unit". Base = origin/main including IU-2a (#3770), IU-2b (#3794), IU-2c (#3800).

**Zero-behavior-change discipline** (same as IU-2b/IU-2c): no state or service-call logic moved —
the view keeps every `ref`/`computed`/`function`/service import it had before this slice. This is a
pure template/markup decomposition: the body of the `int-sec-run-push` `<section>` now renders
through five child components instead of inline, each receiving every value/handler as a prop (the
exact same identifiers the inline template referenced). `apps/web/tests/IntegrationWorkbenchView.spec.ts`
is **not touched at all** (`git diff origin/main` shows zero changes to it).

## What changed

### 1. Five new child components under `apps/web/src/components/integration/`

The old ~506-line `int-sec-run-push` body bundled five materially distinct sub-features (IU-2c's
deferral note counted six by splitting out the export control; on full re-read the CSV/Excel export
block is 22 lines of markup wholly coupled to the pipeline dry-run result — it stays in the parent's
section shell alongside the `pipeline-result` `<pre>` and `data-service-placeholder`, see
"entanglement notes" below). The `<section id="int-sec-run-push">` element, its `<el-card>` chrome,
and the header (`h2` + `save-pipeline` button) all **stay in the parent** — the five children render
*inside* the section's existing card, so DOM order, nesting, and every ancestor selector are
byte-identical to before. This also means the rail's `IntersectionObserver`/anchor logic needed zero
changes (it observes `#int-sec-run-push`, still parent-owned).

#### `IntegrationPipelineRunSection.vue` (pipeline config + run trigger, ~140 template lines)

- **Data/function props**: `generatedPipelineName`, `showWatermarkConfig`, `hasSourceFieldOptions`,
  `sourceFieldOptionsForValue`, `sourceFieldOptionText`, `watermarkConfigError`,
  `stagingDescriptors`, `savePipelineBlockedSummary`, `dryRunBlockedSummary`,
  `dryRunReadinessItems`, `runningPipeline`, `canRunPipeline`, `dryRunEmptyPreviewNotice`,
  `useGeneratedPipelineName`, `executePipeline`.
- **Eleven `defineModel`s** (the section's native two-way binds, same pattern as IU-2b's
  `stagingBaseId`): `pipelineName`, `pipelineMode`, `watermarkType`, `watermarkField`,
  `watermarkTiebreaker`, `idempotencyFieldsText`, `stagingSheetId`, `savedPipelineId`,
  `pipelineRunMode`, `pipelineSampleLimit`, `allowSaveOnlyRun`.
- Covers testids: `pipeline-name(-hint)`, `use-generated-pipeline-name`, `pipeline-mode(-help)`,
  `watermark-config(-help/-error)`, `watermark-type/field/tiebreaker`, `idempotency-fields(-help)`,
  `staging-sheet`, `pipeline-id(-help)`, `pipeline-run-mode`, `sample-limit`, `run-push-explainer`,
  `allow-save-only-run`, `pipeline-readiness`, `save-readiness-summary`, `dry-run-readiness-summary`,
  `run-dry-run`, `run-save-only`, `dry-run-empty-preview-notice`.

#### `IntegrationStockPrepPanel.vue` (stock-preparation S1 admin panel, ~48 template lines)

- **Permission gate preserved on the component's own root `v-if`** exactly where the pre-extraction
  markup had it, driven by a `hasIntegrationAdmin` boolean prop; the parent passes the
  byte-identical expression (`:has-integration-admin="auth.hasPermission('integration:admin')"`).
  Unauthorized users get zero DOM for this panel — the exact
  `stock-preparation-s1-panel`-is-null assertion the parent view spec makes stays green through the
  real wiring, and the component spec adds a direct negative.
- **Data/function props**: `stockPreparationTargetRunning`, `stockPreparationTargetResult`,
  `stockPreparationTargetSummary`, `stockPreparationTargetMetrics` (`MetricRow[]`),
  `stockPreparationTargetEvidenceText`, `checkStockPreparationTargetReadiness`,
  `ensureStockPreparationTarget`.
- **One `defineModel`**: `stockPreparationTargetBaseId`.
- Covers testids: `stock-preparation-s1-panel/-base-id/-boundary/-readiness/-ensure/-result/
  -metrics/-token-state/-evidence`.

#### `IntegrationExternalWritePanel.vue` (external-write C6 dry-run/apply, ~55 template lines)

- `data-testid="external-write-panel"` is a documented **mount anchor** — it renders
  unconditionally at the same DOM position, pinned by its own structural spec. This panel never had
  a root permission `v-if` (its buttons gate through `externalWriteCanDryRun`/`externalWriteCanApply`
  computeds, which stay in the parent untouched).
- **Data/function props**: `externalWriteCanDryRun`, `runningExternalWrite`, `externalWriteCanApply`,
  `externalWriteDryRunResult`, `externalWriteReviewSummary`, `externalWriteDryRunMetrics`,
  `externalWriteDryRunToken`, `externalWriteEvidenceText`, `externalWriteApplyResult`,
  `externalWriteApplyMetrics`, `externalWriteApplyRunId`, `dryRunExternalWrite`, `applyExternalWrite`.
- **One `defineModel`**: `externalWriteAcceptReview`.
- Covers testids: `external-write-panel/-permission-note/-boundary/-dry-run/-apply/-review/
  -token-state/-accept-review/-evidence/-apply-result`.

#### `IntegrationTableActionsPanel.vue` (parameterized table actions + duplicate-policy sub-editor, ~170 template lines)

- The single largest sub-panel: dry-run-token flow, large-BOM bounded preview, duplicate-group
  conflict-policy editor, manual-confirm/duplicate-resolution accept checkboxes, evidence `<pre>`.
- **Inner admin gates** (the save/revoke table-scope policy buttons carried inline
  `v-if="auth.hasPermission('integration:admin')"`): the parent forwards exactly one function prop
  `:has-permission="auth.hasPermission"` and the child calls
  `hasPermission('integration:admin')` at the same two spots — same string, same callee (the
  method is a plain closure over the composable's scope, so detaching it is safe), verified by a
  structural test asserting `hasPermission` is called with `'integration:admin'` and that the
  buttons are absent when it returns false.
- **Data/function props** (all parent-owned, names unchanged): `tableActions`, `bi`,
  `tableActionOptionLabel`, `tableActionDisplayContextItems`, `tableActionCanDryRun`,
  `runningTableAction`, `tableActionCanApply`, `tableActionApplyCommandLabel`,
  `tableActionDryRunResult`, `tableActionReviewSummary`, `tableActionCounts`,
  `tableActionLargeBomBounded`, `tableActionBoundedPreviewMetrics`, `tableActionBoundedErrorTypes`,
  `tableActionDuplicateDiagnostics` (typed `unknown` — the template only truthiness-checks it, the
  real shape analysis lives in the parent's computeds), `tableActionDuplicateMetrics`,
  `tableActionDuplicatePolicies`, `tableActionStoredConflictPolicyCount`,
  `tableActionResolvedDuplicateGroupCount`, `tableActionHeldDuplicateGroupCount`,
  `tableActionHeldReasonMetrics`, `tableActionDuplicateGroups` (`DuplicateExpandedGroupView[]`),
  `tableActionConflictPolicySaving`, `tableActionDryRunToken`, `tableActionManualConfirmCount`,
  `tableActionApplyResult`, `tableActionEvidenceText`, `dryRunTableAction`, `applyTableAction`,
  `onDuplicatePolicyDraftChange`, `setDuplicateRunOnlyPolicy`, `saveDuplicateTableScopePolicy`,
  `revokeDuplicateTableScopePolicy`.
- **Four `defineModel`s**: `selectedTableActionId`, `tableActionProjectNo`,
  `tableActionAcceptManualConfirmHold`, `tableActionAcceptDuplicateResolution`.
- Covers testids: `table-action-panel/-permission-note/-empty(-what/-first-step)/-id/-project-no/
  -boundary/-display-context/-dry-run/-apply/-review/-large-bom-bounded/-duplicate-diagnostics/
  -duplicate-policy-scope/-held-reason-summary/-duplicate-policy-select/-duplicate-run-only/
  -duplicate-table-save/-duplicate-table-revoke/-token-state/-accept-manual-hold/
  -accept-duplicate-resolution/-apply-result/-evidence`.

#### `IntegrationFieldOptionSyncPanel.vue` (field-option sync, ~48 template lines)

- **Same root-`v-if` permission-gate treatment as the stock-prep panel** (`hasIntegrationAdmin`
  prop; parent passes `auth.hasPermission('integration:admin')` verbatim).
- **The raw `optionSets JSON` textarea (`data-testid="stock-option-sync-json"`) is kept AS-IS** —
  structuring it is IU-5's job (gated on IU-2 landing per the design-lock ladder); its structural
  spec pins `tagName === 'TEXTAREA'` so IU-5 has to consciously retire that assertion.
- **Data/function props**: `fieldOptionSyncPresets` (readonly — matches the parent's `as const`
  array; element shape duplicated as a local 2-field interface since the parent's literal type is
  anonymous), `stockPreparationOptionSyncPlaceholder`, `stockPreparationOptionSyncCanRun`,
  `syncingStockPreparationOptions`, `fieldOptionSyncPathNote`,
  `stockPreparationOptionSyncEvidenceText`, `syncFieldOptions`.
- **Two `defineModel`s**: `fieldOptionSyncPresetId`, `stockPreparationOptionSyncText`.
- Covers testids: `stock-option-sync-panel/-boundary/-json/-evidence`, `field-options-preset`,
  `field-options-sync-run`, `field-options-sync-path`.

### 2. Entanglement notes (what was NOT split, and why)

- **CSV/Excel export block + `data-service-placeholder` + `pipeline-result` `<pre>`** stay in the
  parent's section shell (~30 lines). The export block is not a fifth-and-a-half concern: it is the
  human-facing tail of the pipeline-run flow (its `canExportCleansedResult`/`cleansedExportSummary`
  computeds read the same `lastDryRunResult` the run buttons produce), and `pipeline-result` is the
  section-wide result sink that all five panels' flows report into. Extracting these three
  leftovers as a sixth micro-component would be an artificial split with no cohesion gain; they are
  plain markup with 5 bindings total.
- **No two of the five sub-panels were entangled with each other.** Each panel's bindings resolve
  to disjoint parent state families (`pipeline*`/`watermark*`, `stockPreparationTarget*`,
  `externalWrite*`, `tableAction*`, `fieldOptionSync*`/`stockPreparationOptionSync*`); the only
  shared symbols are `bi`, `auth.hasPermission`, and generic `MetricRow` shapes — all pass-through
  props. The clean prop-contract split the task hoped for was fully achievable; no forced merge was
  needed.

### 3. Permission gates — byte-identical in behavior (§3 hard lock)

| Gate (pre-extraction) | Post-extraction |
|---|---|
| `v-if="auth.hasPermission('integration:admin')"` on `stock-preparation-s1-panel` root div | same root div, `v-if="hasIntegrationAdmin"`; parent passes `:has-integration-admin="auth.hasPermission('integration:admin')"` (same expression, same per-render evaluation) |
| `v-if="auth.hasPermission('integration:admin')"` on `stock-option-sync-panel` root div | identical treatment |
| `v-if="auth.hasPermission('integration:admin')"` on duplicate-policy table-save / table-revoke buttons (×2) | `v-if="hasPermission('integration:admin')"` with `:has-permission="auth.hasPermission"` |
| `integration:write`/`integration:admin` checks inside `externalWriteCanApply` / `tableActionCanApply` / `stockPreparationOptionSyncCanRun` computeds | untouched — computeds never left the parent |

The parent view spec's permission tests (`stock-preparation-s1-panel` null without admin while
`external-write-panel` persists, apply-button disable states, FOS run gating) all pass unchanged —
through the real parent wiring, not stubs.

### 4. Shared types: `integrationWorkbenchSectionTypes.ts` extended (not replaced)

Added `WatermarkType`, `ReadinessItem`, `MetricRow`, `DuplicateExpandedGroupView` (duplicated from
the view's local non-exported declarations / anonymous literal shapes, same drift-safe rationale as
IU-2b/IU-2c: structural typing fails the parent's call-site prop-check if either side drifts). All
service-layer types (`IntegrationPipelineMode`, `IntegrationStagingDescriptor`,
`IntegrationStockPreparationTargetReadinessResult`, `IntegrationExternalWrite*Result`,
`IntegrationTableAction*`) import directly from `services/integration/workbench.ts` — no duplication.

### 5. CSS: verbatim duplication, not relocation (same as IU-2b/IU-2c)

Each child's `<style scoped>` carries verbatim copies of the parent rules its markup uses (media
queries copied selectively, per the `IntegrationMappingRulesSection` precedent). The parent's
`<style scoped>` block is **byte-for-byte unchanged** (diff hunks touch only the template body and
the import block). All five files pass `ui-foundation-style-guard` with zero hex / zero static
`style=` — CSS is copied from the already-token-only parent.

## Line count

| File | Before | After |
|---|---|---|
| `apps/web/src/views/IntegrationWorkbenchView.vue` | 5460 | 5115 (**-345**, template body of `int-sec-run-push` -461/+117) |
| `IntegrationPipelineRunSection.vue` | — | 379 (new) |
| `IntegrationStockPrepPanel.vue` | — | 227 (new) |
| `IntegrationExternalWritePanel.vue` | — | 225 (new) |
| `IntegrationTableActionsPanel.vue` | — | 473 (new) |
| `IntegrationFieldOptionSyncPanel.vue` | — | 209 (new) |
| `integrationWorkbenchSectionTypes.ts` | 101 | 140 (+39, new shared types) |

Cumulative IU-2a→IU-2d: `IntegrationWorkbenchView.vue` 6195 → 5115. Every big inline section is now
extracted; the remaining template is the PageShell/rail/header chrome, three thin wrapper sections
(`int-sec-read-source`, `int-sec-combination-config`, `int-sec-combination-run` — already
self-contained child panels, out of scope by construction since IU-2b), the run-push section shell
(header + export/result tail), and eleven component invocations.

## The "50 unchanged" proof

`apps/web/tests/IntegrationWorkbenchView.spec.ts` has **zero diff** vs origin/main. Additionally,
ran the exact spec on a pristine detached worktree at origin/main (`/private/tmp/ms2-iu2d-baseline`,
4bb668fa5) and on this branch, and diffed the verbose test-name lists (timings stripped):

```
pnpm exec vitest run IntegrationWorkbenchView --reporter=verbose
# baseline worktree (origin/main): 50 passed (50)
# this branch (after IU-2d):       50 passed (50)
diff before-notime.txt after-notime.txt → IDENTICAL TEST NAME SET (50/50)
# repeated on Node 20.20.2 → NODE20: IDENTICAL TEST NAME SET (50/50)
```

No stub additions to the spec's `createApp` instances were needed — the five new components use no
`el-*` elements of their own (they render inside the parent's existing `el-card`).

## New structural tests (one spec per component, 18 tests total)

- `IntegrationPipelineRunSection.spec.ts` (3): config grid + readiness + run buttons render and
  watermark-config only appears in incremental mode; `run-dry-run` forwards `executePipeline(true)`
  while save-only stays gated on `allowSaveOnlyRun`; `pipeline-name` input forwards
  `update:pipelineName` (defineModel proof).
- `IntegrationStockPrepPanel.spec.ts` (4): renders panel + boundary + both actions with admin;
  **permission-gate negative** — `hasIntegrationAdmin: false` renders NOTHING (panel/buttons/input
  all null); readiness/ensure clicks forward; base-id defineModel forwards.
- `IntegrationExternalWritePanel.spec.ts` (3): the `external-write-panel` mount anchor +
  boundary/permission-note always render (review block absent without a dry-run result); dry-run
  click forwards + can-dry-run disable gate honoured (apply stays disabled); accept-review checkbox
  forwards `update:externalWriteAcceptReview`.
- `IntegrationTableActionsPanel.spec.ts` (4): **IU-6 guided empty state pinned**
  (`table-action-empty-what` / `table-action-empty-first-step` non-empty — the parent view spec
  doesn't assert these sub-testids directly, same rationale as IU-2b/IU-2c pinning); action form +
  dry-run forward; **admin-gate negative + positive** for duplicate-policy table-save/table-revoke
  buttons incl. exact-permission-string assertion; project-no defineModel forwards.
- `IntegrationFieldOptionSyncPanel.spec.ts` (4): preset picker + **raw textarea pinned as
  `TEXTAREA`** (IU-5 boundary); **permission-gate negative** renders nothing; can-run disable gate +
  sync click forward; textarea defineModel forwards.

## Full guard runs — both runtimes

```
pnpm --filter @metasheet/web exec vitest run composition-vocab-mirror multitable-resolver-vocab-mirror \
  integrationErrorCodeLabels fieldHints IntegrationReadSourceConfigPanel \
  IntegrationReadSourceCompositionPanel IntegrationReadSourceCompositionAuthoringPanel \
  readSourceCompositions.service IntegrationWorkbenchView IntegrationWorkbenchRail \
  IntegrationMonitoringSection IntegrationCleaningDatasetSection IntegrationMappingRulesSection \
  IntegrationObjectTemplateSection IntegrationPayloadPreviewSection IntegrationConnectionSection \
  IntegrationPipelineRunSection IntegrationStockPrepPanel IntegrationExternalWritePanel \
  IntegrationTableActionsPanel IntegrationFieldOptionSyncPanel \
  IntegrationK3WiseSetupView IntegrationHelpView --reporter=dot

Test Files  23 passed (23) · Tests  222 passed (222)   [Node 20.20.2 AND Node 25.9.0]
```

(Was 18 files / 204 tests after IU-2c; +5 files / +18 tests.)

Also ran:
- `ui-foundation-style-guard.spec.ts` — 75 passed (was 65; +10 = five new files × 2 axes, all zero
  hex / zero static `style=`).
- The full `approval-web-guard.yml` vitest filter list — 550 passed (+10 from the style-guard name
  match picking up the new `TARGET_FILES` entries; no new file matches that filter's own name list).
- `pnpm exec vue-tsc -b` — clean (exit 0), Node 20.20.2 and 25.9.0.
- `pnpm --filter @metasheet/web build` — succeeds (pre-existing >500kB chunk-size warning, unrelated,
  same as noted in IU-2b/IU-2c).

## Mutation sanity check (gate guard bites)

Temporarily removing `v-if="hasIntegrationAdmin"` from `IntegrationStockPrepPanel.vue`'s root div
makes `IntegrationStockPrepPanel.spec.ts`'s permission-gate negative fail (panel renders for
non-admin) — then restored. Recorded in the PR discussion; the committed tree carries the guard.

## CI wiring

- `.github/workflows/integration-guard.yml`: five new component files + five new spec files added to
  both `pull_request`/`push` path triggers; five new spec names added to the `vitest run` filter.
- `.github/workflows/approval-web-guard.yml`: five new component files added to the same two
  path-trigger blocks IU-2a/IU-2b/IU-2c already extended (gating `ui-foundation-style-guard`
  coverage).
- `apps/web/tests/ui-foundation-style-guard.spec.ts`: `TARGET_FILES` +5.

## Files touched

- `apps/web/src/views/IntegrationWorkbenchView.vue` (run-push section body → five component
  invocations; five import lines; zero other script/style changes)
- `apps/web/src/components/integration/IntegrationPipelineRunSection.vue` (new)
- `apps/web/src/components/integration/IntegrationStockPrepPanel.vue` (new)
- `apps/web/src/components/integration/IntegrationExternalWritePanel.vue` (new)
- `apps/web/src/components/integration/IntegrationTableActionsPanel.vue` (new)
- `apps/web/src/components/integration/IntegrationFieldOptionSyncPanel.vue` (new)
- `apps/web/src/components/integration/integrationWorkbenchSectionTypes.ts` (extended)
- `apps/web/tests/IntegrationPipelineRunSection.spec.ts` (new)
- `apps/web/tests/IntegrationStockPrepPanel.spec.ts` (new)
- `apps/web/tests/IntegrationExternalWritePanel.spec.ts` (new)
- `apps/web/tests/IntegrationTableActionsPanel.spec.ts` (new)
- `apps/web/tests/IntegrationFieldOptionSyncPanel.spec.ts` (new)
- `apps/web/tests/ui-foundation-style-guard.spec.ts` (`TARGET_FILES` +5)
- `.github/workflows/integration-guard.yml` (path triggers + vitest run list)
- `.github/workflows/approval-web-guard.yml` (path triggers)
- `docs/development/integration-iu2d-runpush-decomposition-dev-verification-20260707.md` (this file)

Not touched: `apps/web/tests/IntegrationWorkbenchView.spec.ts` (zero diff — the proof itself), any
`services/integration/*.ts` file, `IntegrationWorkbenchRail.vue`, `PageShell.vue`/`PageHeader.vue`,
routing, or any backend/plugin file.
