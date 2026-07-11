# IU-2c: Workbench section extraction, round 2 — object-template/preview/connection, zero behavior change — dev verification (2026-07-07)

Scope: design-lock `docs/development/integration-ux-workbench-redesign-design-lock-20260706.md`
(RATIFIED, #3739) §2 IU-2 stage C — the tractable sections IU-2b (#3794) deferred. Base = origin/main
including IU-2a (#3770, PageShell/PageHeader/rail/el-card sections/tokenization) and IU-2b (#3794,
`IntegrationMonitoringSection.vue` / `IntegrationCleaningDatasetSection.vue` /
`IntegrationMappingRulesSection.vue` + `integrationWorkbenchSectionTypes.ts`).

**Zero-behavior-change discipline**: no state or service-call logic was moved anywhere — the view
keeps every `ref`/`computed`/`function`/service import it had before this slice. This is a pure
template/markup extraction: three more of the view's `<section>` blocks now render through a child
component instead of inline, and each child receives every value/handler it needs as a prop (the
exact same identifiers the inline template used to reference directly). `apps/web/tests/
IntegrationWorkbenchView.spec.ts` — the file carrying the pre-existing 50 tests — is **not touched
at all** in this PR (`git diff` shows zero changes to it); that absence of a diff is itself the
strongest form of the "unchanged assertions" proof.

## What changed

### 1. Three new child components under `apps/web/src/components/integration/`

Picked per the task's own candidate list (IU-2b's own "deferred to IU-2c" section named these
exact three, plus reasons for each):

#### `IntegrationObjectTemplateSection.vue` (section `int-sec-object-template`, was ~175 template lines)

Source/target system + object/schema pickers (IU-2b flagged this as "reasonably clean on its
own... a good IU-2c candidate"). Confirmed clean on full read: two symmetric system columns, no
cross-cutting concerns beyond the pre-existing `PlmBomReviewPanel` sub-panel (already delegated to,
so the extraction boundary was already established).

- **Data props**: `sourceSystems`, `sourceSelectorExplanation`, `selectedPlmApprovalCapabilityEntry`
  (`PlmApprovalCapabilityEntry | null`), `selectedPlmBomMultitableCapabilityEntry`
  (`PlmBomCapabilityEntry | null`), `selectedSourcePlmDataSourceId`, `hasRunnableSourceSystem`,
  `sourceRuntimeBlocker`, `k3WebApiReadGateNotice`, `sqlChannelDisabledHint`,
  `sourceConnectionStatus`, `sourceConnectionLabel`, `sourceObjects`, `sourceSchema`,
  `targetSystems`, `targetSelectorExplanation`, `targetConnectionStatus`, `targetConnectionLabel`,
  `targetObjects`, `targetSchema`, `sameSystemNotice`, `protocolSplitNotice`,
  `stagingTargetMismatchNotice`, `recommendedStagingSourceObject`, `stagingDatasetCopy`.
- **Derivation/action function props**: `isSourceOptionDisabled`, `handleSourceSystemChange`,
  `showStagingSetup`, `showSqlSetup`, `testSystem` (`(side: WorkbenchSide) => Promise<void>`),
  `loadObjects`, `handleSourceObjectChange`, `loadSchema`, `useRecommendedStagingSource`.
- **Four `defineModel`s**: `sourceSystemId`, `sourceObjectName`, `targetSystemId`,
  `targetObjectName` — the four native `v-model`-bound `<select>`s in this section, same pattern
  as IU-2b's `stagingBaseId`. Each keeps its pre-existing `@change` handler alongside the
  `defineModel` (Vue attaches both listeners to the same native `change` event without conflict).
- `PLM_APPROVAL_AUTOMATION_FEATURE_KEY` / `PLM_BOM_MULTITABLE_FEATURE_KEY` (plain literal string
  constants, display-only) are duplicated locally rather than passed as props — same rationale as
  IU-2b's duplicated shared types.
- Imports `PlmBomReviewPanel.vue` directly (unchanged real component, not stubbed).

#### `IntegrationPayloadPreviewSection.vue` (section `int-sec-preview`, was ~96 template lines)

Sample record / target-template JSON / reference-mapping picker / derive-draft button / embedded
`MetaIntegrationFieldRuleAuthoring` / payload preview + provenance display. IU-2b flagged this as a
"good candidate" but deferred it pending IU-5's say on JSON-textarea shape; extracting the current
markup verbatim now does not foreclose that later restructuring — IU-5 is still gated on IU-2
landing per the design-lock's own ladder, and this extraction makes no assumption about the
textareas' eventual shape.

- **Data props**: `referenceMappingDomains`, `referenceMappingBindings` (read-only —
  the section only reads `referenceMappingBindings[domain]?.systemId/.object`, all mutation goes
  through the two action props below, unchanged from before extraction), `stagingSystems`,
  `derivingDraft`, `deriveError`, `authoredGatedFields`, `sourceReadOnlyBoundaryNotice`,
  `previewText`, `previewProvenance` (`IntegrationFieldProvenanceSummary | null`, already exported
  from `services/integration/workbench.ts` — no duplication needed).
- **Action/derivation function props**: `onRefMappingSystemChange`, `onRefMappingObjectChange`,
  `deriveTemplateDraft`, `previewPayload`, `provenanceSourceLabel`.
- **Three `defineModel`s**: `sampleRecordText`, `payloadTemplateText` (plain textareas), and
  `authoredFieldRules` (forwarded as-is to `MetaIntegrationFieldRuleAuthoring`'s own `v-model`,
  identical to the pre-extraction wiring).

#### `IntegrationConnectionSection.vue` (section `int-sec-connection`, was ~234 template lines)

One of the task's original four named candidates. IU-2b deferred it as "not as clean as it first
looks" — a `connectionDraft` object with 8 two-way-bound fields, a data-source-bridge sub-form, an
adapter/staging inventory, and ~15 action handlers. Re-read in full for this slice: the complexity
is real but tractable — every field/handler maps 1:1 onto a prop, and the `connectionDraft` /
`scope` two-way-bind problem has a clean precedent already in this codebase (see below).

- **Data props**: `inventorySummary`, `systems`, `deletingConnectionId`, `adapters`,
  `stagingDatasetCards`, `visibleAdapters`, `hiddenAdvancedSystemCount`, `connectionDraftTitle`,
  `connectionDraft` (`ConnectionDraft`), `connectionDraftAdapterOptions`, `isDataSourceBridgeKind`,
  `bridgeDataSources`, `bridgeDataSourceObjectsLoading`, `bridgeDataSourceObjectOptions`,
  `bridgeDataSourceObjectsError`, `selectedBridgeObjectSummary`, `bridgeDataSourcesError`,
  `connectionDraftDuplicateWarning`, `connectionDraftRoleWarning`, `connectionDraftJsonError`,
  `savingConnectionDraft`, `canSaveConnectionDraft`, `scope` (`IntegrationScopeState`), `bi`.
- **Action function props**: `refreshBootstrap`, `showConnectionGuide`, `showSqlSetup`,
  `connectionStatusLabel`, `runtimeBlockerForSystem`, `editConnection`, `copyConnection`,
  `deactivateConnection`, `activateConnection`, `deleteConnection`, `onBridgeDataSourceChange`,
  `saveConnectionDraft`, `resetConnectionDraft`.
- **Three `defineModel`s**: `inventoryExpanded`, `showAdvancedConnectors` (both plain booleans,
  one of which — `inventoryExpanded` — is toggled via a direct `inventoryExpanded = !inventoryExpanded`
  assignment in the click handler; `defineModel` returns a writable ref, so this assignment works
  identically post-extraction), and `workspaceInput` — notably a **writable `computed`** in the
  parent (`get: () => scope.workspaceId || ''`, `set: (value) => { scope.workspaceId = value.trim()
  || null }`), not a plain `ref`. Vue's `v-model` binds to any ref-like target, so
  `v-model:workspace-input="workspaceInput"` at the call site works identically whether the parent
  hands over a `ref` or a writable `computed` — verified empirically by the passing spec.
- **Two nested-object data props mutated via nested `v-model`**: `connectionDraft` and `scope` are
  both `reactive(...)` objects the parent owns; the child receives the *same reactive proxy* as a
  plain prop and mutates nested fields directly (`v-model="connectionDraft.name"`,
  `v-model="scope.tenantId"`) — the exact same nested-prop-mutation pattern IU-2b already
  established for `IntegrationMappingRulesSection`'s `mappings: EditableMapping[]` array. Since
  `reactive()` returns a stable proxy, passing it down and mutating a nested field mutates the
  identical object the parent reads from — no different from the pre-extraction inline behavior,
  and (like `mappings`) this file is not part of `apps/web/package.json`'s `lint` file list, so the
  nested-prop-mutation pattern carries no `vue/no-mutating-props` ESLint-gate risk. This resolved
  the "8 two-way-bound fields" concern IU-2b raised without needing 8 separate `defineModel`s.

### 2. Shared types: `integrationWorkbenchSectionTypes.ts` extended (not replaced)

Added (duplicated from the view's local, non-exported `<script setup>` declarations, same
rationale as IU-2b's original four types): `WorkbenchSide`, `PlmApprovalCapabilityEntry`,
`PlmBomCapabilityEntry`, `ConnectionDraftRole`/`ConnectionDraftStatus` (type aliases of
`WorkbenchExternalSystem['role']`/`['status']`, so this file now has one type-only import of
`WorkbenchExternalSystem` from `services/integration/workbench.ts`), `ConnectionDraft`,
`BridgeDataSourceObjectOption`, `IntegrationScopeState`. All other types used by the new components
(`IntegrationObjectSchema`, `IntegrationSystemObject`, `WorkbenchExternalSystem`,
`IntegrationFieldRule`, `IntegrationFieldProvenanceSummary`, `IntegrationAdapterMetadata`) were
already exported from `services/integration/workbench.ts` and are imported directly from there —
no duplication needed. `DataSourceListItem` is imported directly from `../../data-sources/types`
(already exported, used unmodified by the parent too).

### 3. CSS: verbatim duplication, not relocation (same as IU-2b)

Each child component's `<style scoped>` block contains a verbatim copy of every rule in
`IntegrationWorkbenchView.vue`'s `<style scoped>` block whose selector targets a class name used in
that section's markup — copied, not moved; the parent's `<style>` block is byte-for-byte unchanged.
Media-query blocks are copied selectively (only the selector lines relevant to that component),
matching the precedent in `IntegrationMappingRulesSection.vue`'s style block rather than copying the
entire shared responsive block. The parent's `<style scoped>` block was not touched by this PR.

### 4. Parent view: three more `<section>` blocks replaced with component invocations

`IntegrationWorkbenchView.vue`'s `<script setup>` gained three import lines
(`IntegrationObjectTemplateSection`, `IntegrationPayloadPreviewSection`,
`IntegrationConnectionSection`); nothing else in the script changed. The rail's anchor-scroll and
`IntersectionObserver` logic needed zero changes for the same reason as IU-2b: DOM `id` lookups
don't care which component rendered the element.

## Line count

| File | Before (IU-2b landed) | After |
|---|---|---|
| `apps/web/src/views/IntegrationWorkbenchView.vue` | 5863 | 5460 (**-403**, ~6.9%) |
| `apps/web/src/components/integration/IntegrationObjectTemplateSection.vue` | — | 496 (new) |
| `apps/web/src/components/integration/IntegrationPayloadPreviewSection.vue` | — | 312 (new) |
| `apps/web/src/components/integration/IntegrationConnectionSection.vue` | — | 640 (new) |
| `apps/web/src/components/integration/integrationWorkbenchSectionTypes.ts` | 41 | 101 (+60, new shared types) |

(As with IU-2b, the new files are larger than the template chunks they replace because each carries
its own duplicated `<style scoped>` block — the monolith's *template* shrank by the full ~505 lines
the three sections occupied; the parent's `<style>` block itself is unchanged.)

Cumulative across IU-2a→IU-2c: `IntegrationWorkbenchView.vue` went from 6195 lines (IU-2a base) →
5460 lines, six of its ten sections now extracted (`int-sec-monitoring`, `int-sec-cleaning-dataset`,
`int-sec-cleaning-rules`, `int-sec-object-template`, `int-sec-preview`, `int-sec-connection`); three
are thin wrapper sections around already-self-contained panels (`int-sec-read-source`,
`int-sec-combination-config`, `int-sec-combination-run`, out of scope by construction, per IU-2b);
one (`int-sec-run-push`) remains inline, deliberately (see below).

## The "50 unchanged" proof

`apps/web/tests/IntegrationWorkbenchView.spec.ts` has **zero diff** in this PR (`git diff --stat`
against origin/main does not list it). Additionally, ran the exact same spec on a **separate,
pristine `git worktree` checked out to `origin/main`** (rather than `git stash`, since this slice's
real work was committed before running the comparison, per this repo's own discipline against
mutating a dirty tree) and diffed the two runs' full test-name lists (Vitest verbose output, timings
stripped):

```
pnpm exec vitest run IntegrationWorkbenchView --reporter=verbose
# baseline worktree (origin/main, IU-2b landed):  50 passed (50) — 50 test names captured
# this branch (after IU-2c):                       50 passed (50) — 50 test names captured
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

`pnpm exec vue-tsc -b` is clean (exit 0) on both runtimes throughout.

## New structural tests (one spec per extracted component, 10 tests total)

- `tests/IntegrationObjectTemplateSection.spec.ts` (3 tests): section id + source-empty-state
  render when there is no runnable source system; clicking `test-source-system` forwards
  `testSystem('source')`; a `source-system-option-<id>` renders and a `<select>` change forwards
  `update:sourceSystemId` with the selected value (proves the `defineModel` wiring, not just a
  static render).
- `tests/IntegrationPayloadPreviewSection.spec.ts` (3 tests): section id + initial preview text
  render (and the reference-mapping picker is absent when there are no domains); clicking
  `preview-payload` forwards to the prop function; a `ref-mapping-object-<domain>` input's `input`
  event forwards `onRefMappingObjectChange(domain, value)`.
- `tests/IntegrationConnectionSection.spec.ts` (4 tests): section id + connections-empty-state
  render, **with the IU-6 guided empty-state sub-testids (`connections-empty-what` /
  `connections-empty-first-step`) explicitly asserted non-empty** — pinning them here the same way
  IU-2b's monitoring spec did, since the parent view spec doesn't assert them directly and without
  this a future edit could silently drop the guidance copy and stay green; clicking
  `refresh-systems` forwards to the prop function; clicking `toggle-inventory-overview` forwards
  `update:inventoryExpanded(true)`; typing into `connection-draft-name` mutates the
  `connectionDraft` prop object's `.name` field directly (proves the nested-reactive-object
  mutation pattern actually propagates, not just that the input renders).

## Full integration-guard list — both runtimes

```
pnpm --filter @metasheet/web exec vitest run composition-vocab-mirror multitable-resolver-vocab-mirror \
  integrationErrorCodeLabels fieldHints IntegrationReadSourceConfigPanel \
  IntegrationReadSourceCompositionPanel IntegrationReadSourceCompositionAuthoringPanel \
  readSourceCompositions.service IntegrationWorkbenchView IntegrationWorkbenchRail \
  IntegrationMonitoringSection IntegrationCleaningDatasetSection IntegrationMappingRulesSection \
  IntegrationObjectTemplateSection IntegrationPayloadPreviewSection IntegrationConnectionSection \
  IntegrationK3WiseSetupView IntegrationHelpView --reporter=dot

Test Files  18 passed (18) · Tests  204 passed (204)   [Node 20.20.2 AND Node 25.9.0]
```

(Was 15 files / 194 tests after IU-2b; +3 files / +10 tests for the three new structural specs.)

Also ran:
- `apps/web/tests/ui-foundation-style-guard.spec.ts` — 65 passed (was 59 after IU-2b; +6 for the
  three new files × 2 axes, all zero hex/rgb and zero static `style=`, since their CSS is copied
  verbatim from the already-token-only parent).
- The full `approval-web-guard.yml` vitest filter list — 535 passed (29 files; the same 29 files as
  before, +6 tests from the `ui-foundation-style-guard` name match picking up the new
  `TARGET_FILES` entries — no new file matched this filter's own name list, same as IU-2b's finding).
- `pnpm exec vue-tsc -b` — clean (exit 0), both Node 20.20.2 and default Node 25.9.0.
- `pnpm --filter @metasheet/web build` — succeeds (pre-existing >500kB chunk-size warning, unrelated
  to this slice, same as noted in IU-2b's verification).

## CI wiring

- `.github/workflows/integration-guard.yml`: added the three new component files (+ their path in
  the already-modified `integrationWorkbenchSectionTypes.ts` diff) to both `pull_request`/`push`
  path triggers, added the three new spec files to the path triggers, and added the three new spec
  names to the `vitest run` filter.
- `.github/workflows/approval-web-guard.yml`: added the three new component files to the same
  path-trigger block IU-2a/IU-2b already extended (the block gating
  `ui-foundation-style-guard.spec.ts` coverage).
- `apps/web/tests/ui-foundation-style-guard.spec.ts`: `TARGET_FILES` +3 (the three new components).

## `int-sec-run-push` — NOT extracted this slice (decomposition-deferral, restated)

Per this slice's own scope instructions and IU-2b's prior finding (both independently confirmed by
re-reading the section in this slice): `int-sec-run-push` (~506 lines, the single largest section)
bundles **five materially distinct sub-features** behind one `<section>` — pipeline
save/mode/watermark config, a `stock-preparation` S1 admin panel, an "external write C6"
dry-run/apply panel, a generic "parameterized table action" panel with its own duplicate-policy
sub-editor, a field-option-sync panel, and a CSV/Excel export control — each admin-gated
differently (`integration:admin` checks appear twice) and each with its own 10-20-binding
sub-contract. Single-extracting this into one component would just relocate a monolith rather than
fix the underlying structure. **This slice deliberately left it inline.** A future slice should
decompose it into several focused components (one per sub-feature: pipeline-config,
stock-prep-admin, external-write-c6, table-actions, field-option-sync, export), not move it as one
unit — that is a distinct piece of design work (identifying the right sub-boundaries), not a
mechanical extraction, and is out of scope for IU-2c.

## Sections not touched (already thin wrappers, unchanged from IU-2b's own finding)

`int-sec-read-source`, `int-sec-combination-config`, `int-sec-combination-run` — thin wrapper
sections (~13 lines each) around already-self-contained child components
(`IntegrationReadSourceConfigPanel`, `IntegrationReadSourceCompositionAuthoringPanel`,
`IntegrationReadSourceCompositionPanel`); nothing to extract, out of scope by construction.

## Files touched

- `apps/web/src/views/IntegrationWorkbenchView.vue` (three `<section>` blocks replaced with
  component invocations; three new import lines; zero other script/style changes)
- `apps/web/src/components/integration/IntegrationObjectTemplateSection.vue` (new)
- `apps/web/src/components/integration/IntegrationPayloadPreviewSection.vue` (new)
- `apps/web/src/components/integration/IntegrationConnectionSection.vue` (new)
- `apps/web/src/components/integration/integrationWorkbenchSectionTypes.ts` (extended)
- `apps/web/tests/IntegrationObjectTemplateSection.spec.ts` (new)
- `apps/web/tests/IntegrationPayloadPreviewSection.spec.ts` (new)
- `apps/web/tests/IntegrationConnectionSection.spec.ts` (new)
- `apps/web/tests/ui-foundation-style-guard.spec.ts` (`TARGET_FILES` +3)
- `.github/workflows/integration-guard.yml` (path triggers + vitest run list, +3 components +3 specs)
- `.github/workflows/approval-web-guard.yml` (path triggers, +3 components)
- `docs/development/integration-iu2c-section-extraction-dev-verification-20260707.md` (this file)

Not touched: `apps/web/tests/IntegrationWorkbenchView.spec.ts` (zero diff — the proof itself), any
`services/integration/*.ts` file, `IntegrationWorkbenchRail.vue`, `PageShell.vue`/`PageHeader.vue`,
routing, `int-sec-run-push` (deliberately deferred, see above), or any backend/plugin file.
