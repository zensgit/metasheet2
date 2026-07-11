# IU-2b: Workbench section extraction — child components, zero behavior change — dev verification (2026-07-07)

Scope: design-lock `docs/development/integration-ux-workbench-redesign-design-lock-20260706.md`
(RATIFIED, #3739) §2 IU-2 stage B ("per-section component extraction... zero behavior change").
Base = origin/main including IU-2a #3770 (PageShell/PageHeader/rail/el-card sections/tokenization,
`IntegrationWorkbenchRail.vue`), IU-1 #3743, and IU-6 #3750.

**Zero-behavior-change discipline**: no state or service-call logic was moved anywhere — the view
keeps every `ref`/`computed`/`function`/service import it had before this slice. This is a pure
template/markup extraction: three of the view's ten `<section>` blocks now render through a child
component instead of inline, and the child receives every value/handler it needs as a prop (the
exact same identifiers the inline template used to reference directly). `apps/web/tests/
IntegrationWorkbenchView.spec.ts` — the file carrying the pre-existing 50 tests (49 landed by IU-2a
+ 1 added since) — is **not touched at all** in this PR (`git diff` shows zero changes to it); that
absence of a diff is itself the strongest form of the "unchanged assertions" proof.

## What changed

### 1. Three new child components under `apps/web/src/components/integration/`

Picked by reading all ten sections and choosing the ones with the cleanest, most literal
prop/emit boundary (per the task's own candidate list: connection-management, monitoring,
run-push, object-template/cleansing-mapping) — see "Deferred to IU-2c" below for why the other
named candidates were *not* picked this round.

#### `IntegrationMonitoringSection.vue` (section `int-sec-monitoring`, was ~172 template lines)

Read-heavy display of recent pipeline runs + open dead letters + per-row cross-run provenance,
with a handful of user actions (refresh / expand-collapse / replay / provenance toggle). Single
concern, one direction of data flow (props down, the exact same function references invoked back
up), the cleanest of the four named candidates.

- **Data props**: `observationSummary`, `observingPipeline`, `pipelineRuns`
  (`IntegrationPipelineRun[]`), `deadLetters` (`IntegrationDeadLetter[]`),
  `confirmReplayDeadLetterId`, `replayingDeadLetterId`.
- **Derivation function props** (called inline per row, same as before extraction):
  `bi`, `runRowSummaries`, `isRunExpanded`, `deadLetterErrorLabel`, `deadLetterErrorHint`,
  `isDeadLetterReplayable`, `canViewRowProvenance`, `isRowProvenanceExpanded`,
  `isRowProvenanceLoading`, `rowProvenanceError`, `rowProvenanceTimeline`,
  `rowProvenanceAttrsSummary`.
- **Action function props**: `refreshPipelineObservation`, `toggleRunSummaries`, `requestReplay`,
  `cancelReplay`, `replayDeadLetter`, `toggleDeadLetterProvenance`.
- No emits — every prop is either data or a function reference owned and defined by the parent;
  the child calls them exactly where the inline template used to (e.g.
  `@click="refreshPipelineObservation(false)"` is now `@click="refreshPipelineObservation(false)"`
  resolving `refreshPipelineObservation` from props via Vue 3.5's reactive-props-destructure,
  identical call site).

#### `IntegrationCleaningDatasetSection.vue` (section `int-sec-cleaning-dataset`, was ~146 lines)

Dataset cards (source/staging/target summary) + staging-table install/link management.

- **Data props**: `sourceDatasetTitle`, `sourceDatasetDescription`, `sourceSchema`
  (`IntegrationObjectSchema`), `sourceConnectionLabel`, `selectedStagingDescriptor`
  (`IntegrationStagingDescriptor | null`), `stagingDescriptors`, `targetDatasetTitle`,
  `targetDatasetDescription`, `targetSchema`, `requiredTargetFieldCount`, `stagingDatasetCards`,
  `installingStaging`, `stagingProjectId`, `stagingProjectIdScopeStatus`,
  `stagingProjectIdScopeWarning`, `stagingInstallResultText`.
- **Derivation function prop**: `getStagingAreaLabel`.
- **Action function props**: `installStagingTables`, `useStagingAsSource`, `useStagingAsTarget`,
  `focusStagingInstall`, `onStagingProjectIdInput`, `normalizeStagingProjectIdToScope`.
- **One `defineModel`**: `stagingBaseId` — the single native-`v-model`-bound primitive in this
  section, so the parent binds `v-model:staging-base-id="stagingBaseId"` instead of a plain prop +
  manual input handler (same net effect, idiomatic Vue 3.4+, and the only field in this section
  that needed two-way binding rather than a one-shot event handler).

#### `IntegrationMappingRulesSection.vue` (section `int-sec-cleaning-rules`, was ~77 lines)

The smallest and cleanest of the three: a list editor for `EditableMapping` rows.

- **Data prop**: `mappings` (`EditableMapping[]`) — the parent's own `ref<EditableMapping[]>`
  array is passed down by reference; the child's `v-model="mapping.sourceField"` (etc., pulled
  from a `v-for` over the prop) mutates the *same* object the parent's ref points at, identical to
  the pre-extraction behavior where this array was rendered inline. This file is not in
  `apps/web/package.json`'s `lint` file list (an explicit named list, not a glob), so this
  nested-prop-mutation pattern carries no ESLint (`vue/no-mutating-props`) gate risk either.
- **Derivation function props**: `hasSourceFieldOptions` (data, not a function),
  `sourceFieldOptionsForMapping`, `sourceFieldOptionText`, `transformOptions`, `mappingSummary`,
  `mappingDetail`.
- **Action function props**: `addMapping`, `removeMapping`.

#### Shared types: `integrationWorkbenchSectionTypes.ts` (new)

`EditableMapping`, `SourceFieldOption`, `StagingDatasetCard`, `TransformFn` — duplicated (not
imported) from the view's local (non-exported) `<script setup>` type declarations. Rationale: this
slice is a pure template move; touching the view's script block (even just adding `export` to a
type) was avoidable, so the small, stable shapes are copied into a new file both child components
import, and the view's script is untouched byte-for-byte except for the three new import lines and
the three template replacements. All other types used by the new components
(`IntegrationPipelineRun`, `IntegrationDeadLetter`, `IntegrationTargetWriteSummary`,
`IntegrationProvenanceTimelineEntry`, `IntegrationObjectSchema`, `IntegrationStagingDescriptor`)
were already exported from `services/integration/workbench.ts` and are imported directly from
there — no duplication needed.

### 2. CSS: verbatim duplication, not relocation

Each child component's `<style scoped>` block contains a **verbatim copy** of every rule in
`IntegrationWorkbenchView.vue`'s `<style scoped>` block whose selector targets a class name used
in that section's markup — copied, not moved; the parent's `<style>` block is byte-for-byte
unchanged (confirmed via `git diff`, which touches only the `<template>` and `<script setup>`
import list).

This is required, not optional: Vue's scoped CSS only reaches a component's *own* rendered
template, not a child component's inner DOM. Since IU-2a's ten sections share a lot of "utility"
classes (`__button`, `__hint`, `__panel`, `__empty`, `__actions`, `__grid`, generic `input`/
`select`/`textarea`/`label`/`h2`/`h3`/`pre`/`code` element rules scoped under `.integration-
workbench`) across sections that remain inline in the parent, those rules must stay in the parent
*and* get a copy in each child — removing them from the parent would silently break the seven
sections that are still inline.

This still renders pixel-identical because of how Vue's scoped-CSS compiler works: it appends the
`[data-v-hash]` scope attribute only to the **rightmost** compound selector in a rule (e.g.
`.integration-workbench input { }` compiles to `.integration-workbench input[data-v-CHILDHASH]`),
never to ancestor parts. The ancestor class (`.integration-workbench`, `.integration-
workbench__panel`) still matches against the real DOM regardless of which component rendered that
ancestor element, so a rule copied verbatim into a child's own `<style scoped>` block matches
exactly the same elements it did when the whole section lived inline in the parent. Verified
empirically too: all 50 pre-existing tests plus the new structural tests pass, and the production
build succeeds with the same visual class/selector set.

### 3. Parent view: three `<section>` blocks replaced with component invocations

`IntegrationWorkbenchView.vue`'s `<script setup>` gained three import lines (`IntegrationMonitoring
Section`, `IntegrationCleaningDatasetSection`, `IntegrationMappingRulesSection`); nothing else in
the script changed. The rail's anchor-scroll and `IntersectionObserver` logic
(`document.getElementById(id)` lookups keyed by the same ten stable section ids) needed **zero**
changes — DOM `id` lookups don't care which component rendered the element, and Vue mounts child
components before the parent's `onMounted` fires, so the observer setup still finds all ten ids on
first mount, exactly as before.

## Line count

| File | Before | After |
|---|---|---|
| `apps/web/src/views/IntegrationWorkbenchView.vue` | 6195 | 5863 (**-332**, ~5.4%) |
| `apps/web/src/components/integration/IntegrationMonitoringSection.vue` | — | 492 (new) |
| `apps/web/src/components/integration/IntegrationCleaningDatasetSection.vue` | — | 423 (new) |
| `apps/web/src/components/integration/IntegrationMappingRulesSection.vue` | — | 261 (new) |
| `apps/web/src/components/integration/integrationWorkbenchSectionTypes.ts` | — | 41 (new) |

(The new files are larger than the template chunks they replace because each carries its own
duplicated `<style scoped>` block per §2 above — the monolith's *template* shrank by the full
~395 lines the three sections occupied; the parent's `<style>` block itself is unchanged.)

## The "50 unchanged" proof

`apps/web/tests/IntegrationWorkbenchView.spec.ts` has **zero diff** in this PR (`git diff --stat`
does not list it). Additionally, re-ran the exact same spec on the pristine pre-slice tree (`git
stash` / run / `git stash pop`) and diffed the two runs' full test-name lists (Vitest verbose
output, timings stripped): **identical set, 50/50**, both runs green:

```
pnpm exec vitest run IntegrationWorkbenchView --reporter=verbose
# before this slice (git stash):  50 passed (50) — 50 test names captured
# after this slice:               50 passed (50) — 50 test names captured
diff before-notime.txt after-notime.txt && echo "IDENTICAL TEST NAME SET (50/50)"
# → IDENTICAL TEST NAME SET (50/50)
```

Confirmed on **both** runtimes:

```
# Node 25.9.0 (default)
✓ tests/IntegrationWorkbenchView.spec.ts  (50 tests)
Test Files  1 passed (1) · Tests  50 passed (50)

# Node 20.20.2 (via nvm)
✓ tests/IntegrationWorkbenchView.spec.ts  (50 tests)
Test Files  1 passed (1) · Tests  50 passed (50)
```

## New structural tests (small, optional per the task — added since cheap)

One spec per extracted component, each a light isolation mount (own `ElCard` stub, same pattern
as the existing specs) proving the section's key testid(s) render and that a representative click
forwards to the exact prop-function reference passed in:

- `tests/IntegrationMonitoringSection.spec.ts` (2 tests): empty states render; a pipeline run row
  renders and clicking refresh calls `refreshPipelineObservation(false)`.
- `tests/IntegrationCleaningDatasetSection.spec.ts` (2 tests): dataset cards + staging-empty state
  render; clicking install-staging calls `installStagingTables()`.
- `tests/IntegrationMappingRulesSection.spec.ts` (2 tests): a mapping row renders with the right
  summary text; add/remove clicks call `addMapping()` / `removeMapping(0)`.

## Full integration-guard list — both runtimes

```
pnpm --filter @metasheet/web exec vitest run composition-vocab-mirror multitable-resolver-vocab-mirror \
  integrationErrorCodeLabels fieldHints IntegrationReadSourceConfigPanel \
  IntegrationReadSourceCompositionPanel IntegrationReadSourceCompositionAuthoringPanel \
  readSourceCompositions.service IntegrationWorkbenchView IntegrationWorkbenchRail \
  IntegrationMonitoringSection IntegrationCleaningDatasetSection IntegrationMappingRulesSection \
  IntegrationK3WiseSetupView IntegrationHelpView --reporter=dot

Test Files  15 passed (15) · Tests  194 passed (194)   [Node 20.20.2 AND Node 25.9.0]
```

Also ran:
- `apps/web/tests/ui-foundation-style-guard.spec.ts` — 59 passed (was 53 after IU-2a; +6 for the
  three new files × 2 axes, all zero hex/rgb and zero static `style=`, since their CSS is copied
  verbatim from the already-token-only parent).
- The full `approval-web-guard.yml` vitest filter list — 529 passed (29 files; the same 29 files
  as before, +6 tests from the `ui-foundation-style-guard` name match picking up the new
  `TARGET_FILES` entries — no new file matched this filter's name list).
- `pnpm exec vue-tsc -b` — clean (exit 0), both Node 20.20.2 and default Node 25.9.0.
- `pnpm --filter @metasheet/web build` — succeeds (pre-existing >500kB chunk-size warning,
  unrelated to this slice).

## CI wiring

- `.github/workflows/integration-guard.yml`: added the three new component files (+ the shared
  types file) to both `pull_request`/`push` path triggers, added the three new spec files to the
  path triggers, and added the three new spec names to the `vitest run` filter.
- `.github/workflows/approval-web-guard.yml`: added the three new component files to the same
  path-trigger block IU-2a added `IntegrationWorkbenchView.vue`/`IntegrationWorkbenchRail.vue` to
  (the block gating `ui-foundation-style-guard.spec.ts` coverage).
- `apps/web/tests/ui-foundation-style-guard.spec.ts`: `TARGET_FILES` +3 (the three new components).

## IU-2c remainder (explicitly NOT in this slice, with reasons)

- **`int-sec-connection`** (was ~234 lines) — one of the task's four named candidates, but reading
  it in full showed it is not as clean as it first looks: a single `connectionDraft` object with
  8 two-way-bound fields, a separate data-source-bridge sub-form (dataSourceId/dataSourceObject
  pickers with their own loading/error state), an adapter list, a staging-card list shared with
  the cleaning-dataset section, and ~15 distinct action handlers spanning connect/edit/copy/
  deactivate/activate/delete. Extracting it cleanly would need either several `defineModel`s or a
  bundled-object-prop approach for `connectionDraft` — doable, but a meaningfully bigger unit of
  work than the three picked this round, and not obviously "the cleanest boundary" once read in
  full. Deferred to IU-2c rather than forced in under time pressure.
- **`int-sec-run-push`** (was ~506 lines, the single largest section) — read in full and confirmed
  *not* a clean single concern: it bundles five materially distinct sub-features (pipeline
  save/mode/watermark config, a `stock-preparation` S1 admin panel, an "external write C6" dry-
  run/apply panel, a generic "parameterized table action" panel with its own duplicate-policy
  sub-editor, a field-option-sync panel, and a CSV/Excel export control) behind one `<section>`,
  each admin-gated differently (`integration:admin` checks appear twice) and each with its own
  10-20-binding sub-contract. This is the textbook "don't force a messy one" case from the task
  brief — a future IU-2c slice should split it into its own several components (one per
  sub-feature) rather than one monolithic prop bag.
- **`int-sec-object-template`** (~174 lines, source/target system+object pickers) — reasonably
  clean on its own, but not picked this round simply to keep this slice to three components; a
  good IU-2c candidate (it already delegates to `PlmBomReviewPanel` for one sub-panel, so the
  extraction boundary is partly established).
- **`int-sec-preview`** (~95 lines, sample record / target-template JSON / reference-mapping /
  payload preview, embeds `MetaIntegrationFieldRuleAuthoring` via its own `v-model`) — mixed
  concerns (raw JSON editing + a field-rule-authoring child + a read-only provenance display);
  candidate for a future slice once IU-5 (JSON-textarea structuring) has a say in its shape, per
  the design-lock's own slice ladder (IU-5 is gated on IU-2 landing).
- **`int-sec-read-source`, `int-sec-combination-config`, `int-sec-combination-run`** — already
  thin wrapper sections (~13 lines each) that just render an existing self-contained child
  component (`IntegrationReadSourceConfigPanel`, `IntegrationReadSourceCompositionAuthoringPanel`,
  `IntegrationReadSourceCompositionPanel`); nothing to extract, out of scope by construction.

## Files touched

- `apps/web/src/views/IntegrationWorkbenchView.vue` (three `<section>` blocks replaced with
  component invocations; three new import lines; zero other script/style changes)
- `apps/web/src/components/integration/IntegrationMonitoringSection.vue` (new)
- `apps/web/src/components/integration/IntegrationCleaningDatasetSection.vue` (new)
- `apps/web/src/components/integration/IntegrationMappingRulesSection.vue` (new)
- `apps/web/src/components/integration/integrationWorkbenchSectionTypes.ts` (new)
- `apps/web/tests/IntegrationMonitoringSection.spec.ts` (new)
- `apps/web/tests/IntegrationCleaningDatasetSection.spec.ts` (new)
- `apps/web/tests/IntegrationMappingRulesSection.spec.ts` (new)
- `apps/web/tests/ui-foundation-style-guard.spec.ts` (`TARGET_FILES` +3)
- `.github/workflows/integration-guard.yml` (path triggers + vitest run list, +3 components +3 specs)
- `.github/workflows/approval-web-guard.yml` (path triggers, +3 components)
- `docs/development/integration-iu2b-section-extraction-dev-verification-20260707.md` (this file)

Not touched: `apps/web/tests/IntegrationWorkbenchView.spec.ts` (zero diff — the proof itself), any
`services/integration/*.ts` file, `IntegrationWorkbenchRail.vue`, `PageShell.vue`/`PageHeader.vue`,
routing, or any backend/plugin file.
