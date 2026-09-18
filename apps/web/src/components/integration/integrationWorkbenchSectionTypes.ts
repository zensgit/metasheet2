// IU-2b/IU-2c (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2
// IU-2, stage B/C — per-section component extraction): shared prop types for the Workbench
// section child components under this directory.
//
// These are intentionally *duplicated* shapes of local (non-exported) types declared inside
// `../../views/IntegrationWorkbenchView.vue`'s `<script setup>` (`EditableMapping`,
// `SourceFieldOption`, `StagingDatasetCard`, `TransformFn`, `WorkbenchSide`, `ConnectionDraft`
// (+ its role/status aliases), `BridgeDataSourceObjectOption`, `PlmApprovalCapabilityEntry`,
// `PlmBomCapabilityEntry`, `IntegrationScopeState`) rather than imported from the view.
// Rationale: IU-2b/IU-2c are pure template/markup moves — the view keeps 100% of its state and
// script logic untouched, including these type declarations. Duplicating the (small, stable)
// shapes here avoids a cross-file type import from a `.vue` SFC and avoids touching the view's
// script block at all. If either the view's shape or this file's shape drifts, TypeScript will
// fail the prop-type check at the call site in the view (structural typing), so drift cannot go
// unnoticed silently.
import type { WorkbenchExternalSystem } from '../../services/integration/workbench'

// G27 (docs/development/integration-mapping-transform-ui-parity-design-20260910.md): the UI
// transform list is the FULL engine whitelist — `SUPPORTED_TRANSFORMS` in
// plugins/plugin-integration-core/lib/transform-engine.cjs:10-19. The parity is enforced by
// apps/web/tests/integrationMappingTransformParity.spec.ts, which `require`s that Set directly
// (same anti-drift discipline as k3-endpoint-vocab-mirror.spec.ts) — adding an engine transform
// without adding it here (or vice versa) is a RED, never a silent half-exposed engine.
export type TransformFn = '' | 'trim' | 'upper' | 'lower' | 'toNumber' | 'toDate' | 'defaultValue' | 'concat' | 'dictMap'

// G27: `toDate` takes exactly ONE meaningful argument shape — the engine branches on
// `args.format === 'date'` (date-only ISO slice) and treats every other value as "full ISO
// timestamp" (transform-engine.cjs:158-168). It is NOT a strftime-style pattern, so the UI offers
// the two reachable outcomes instead of a free-text box that would silently mean "iso".
export type MappingDateFormat = 'iso' | 'date'

// G27: the per-step argument draft. One flat object per step keeps the editor state serializable
// and lets `buildTransformStepPayload` stay a pure function of (fn, dictMapText, args).
export interface MappingTransformArgs {
  dateFormat: MappingDateFormat
  defaultValueText: string
  concatFields: string[]
  concatSeparator: string
}

// G27: steps 2..n of a transform CHAIN. Step 1 stays on `EditableMapping.transformFn` /
// `.dictMapText` / `.transformArgs` so that a single-step row keeps producing the exact legacy
// payload (`{ fn }` / `{ fn: 'dictMap', map }`) byte-for-byte.
export interface MappingTransformStep {
  id: string
  fn: TransformFn
  dictMapText: string
  args: MappingTransformArgs
}

export interface EditableMapping {
  id: string
  sourceField: string
  targetField: string
  transformFn: TransformFn
  dictMapText: string
  transformArgs: MappingTransformArgs
  extraSteps: MappingTransformStep[]
  required: boolean
  minValueText: string
  maxValueText: string
  patternText: string
  enumText: string
  defaultValueText: string
  // Set by `editableMappingFromPayload` when a loaded payload carried something this editor cannot
  // represent (see the KNOWN LOSS block in integrationMappingTransform.ts). Optional because rows
  // authored in the UI never have one; it is editor-only state and is never sent to the server.
  loadWarnings?: string[]
}

export interface SourceFieldOption {
  value: string
  label: string
  type: string
  stale: boolean
}

export interface StagingDatasetCard {
  id: string
  name: string
  area: string
  description: string
  fieldCount: number
  openLink: string
}

// IU-2c additions below (object-template / preview / connection sections).

export type WorkbenchSide = 'source' | 'target'

// P3-C: approval-automation capability entry rendered in the object-template section's source
// column (badge/title/detail + optional apiVersion/actionStatus).
export interface PlmApprovalCapabilityEntry {
  state: 'enabled' | 'upgrade' | 'loading'
  badge: string
  title: string
  detail: string
  apiVersion: string
  actionStatus: string
}

// P3-C: BOM review is a READ surface (no actions), so its capability entry mirrors the
// approval one minus actionStatus.
export interface PlmBomCapabilityEntry {
  state: 'enabled' | 'upgrade' | 'loading'
  badge: string
  title: string
  detail: string
  apiVersion: string
}

export type ConnectionDraftRole = WorkbenchExternalSystem['role']
export type ConnectionDraftStatus = WorkbenchExternalSystem['status']

export interface ConnectionDraft {
  id: string
  name: string
  kind: string
  role: ConnectionDraftRole
  status: ConnectionDraftStatus
  configText: string
  capabilitiesText: string
  // PR-1 canonical binding for data-source:sql-readonly. Physical credentials
  // stay in /data-sources and the Binding stores only this opaque reference.
  connectionId: string
  dataSourceObject: string
}

export interface BridgeDataSourceObjectOption {
  value: string
  label: string
  kind: 'table' | 'view'
  columnCount: number | null
}

// Plain `reactive({ tenantId, workspaceId })` shape used by the connection section's Tenant
// ID / Workspace ID fields.
export interface IntegrationScopeState {
  tenantId: string
  workspaceId: string | null
}

// IU-2d additions below (run-push decomposition: pipeline-run / stock-prep / external-write /
// table-actions / field-option-sync panels).

export type WatermarkType = 'updated_at' | 'monotonic_id'

// Shape of each entry in `dryRunReadinessItems`/`savePipelineReadinessItems` (anonymous array
// literals in the view) — one readiness checklist row.
export interface ReadinessItem {
  id: string
  label: string
  ready: boolean
  detail: string
}

// Shape returned by the view's local `metricRowsFromCounts(...)` helper and the several
// `*Metrics` computeds that build the same `{ id, label, value }` rows by hand
// (`stockPreparationTargetMetrics`, `tableActionBoundedPreviewMetrics`, etc.).
export interface MetricRow {
  id: string
  label: string
  value: string
}

// One expanded duplicate-key group row rendered by the table-actions panel's
// conflict-policy sub-editor.
export interface DuplicateExpandedGroupView {
  ordinal: string
  fingerprint: string
  rowCount: string
  parentShape: string
  quantityShape: string
  attributeShape: string
  stableDiscriminator: string
  currentPolicy: string
  currentScope: string
  draftPolicy: string
  resolutionLabel: string
}
