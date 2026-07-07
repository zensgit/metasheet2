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

export type TransformFn = '' | 'trim' | 'upper' | 'lower' | 'toNumber' | 'dictMap'

export interface EditableMapping {
  id: string
  sourceField: string
  targetField: string
  transformFn: TransformFn
  dictMapText: string
  required: boolean
  minValueText: string
  maxValueText: string
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
  // C2b: structured config for the read-only data-source bridge (kind 'data-source:sql-readonly').
  // The connection only ever references a data_sources id — credentials stay in /data-sources.
  dataSourceId: string
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
