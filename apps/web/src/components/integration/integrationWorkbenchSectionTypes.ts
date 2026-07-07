// IU-2b (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage B — per-section component extraction): shared prop types for the Workbench section
// child components under this directory.
//
// These are intentionally *duplicated* shapes of local (non-exported) types declared inside
// `../../views/IntegrationWorkbenchView.vue`'s `<script setup>` (`EditableMapping`,
// `SourceFieldOption`, `StagingDatasetCard`, `TransformFn`) rather than imported from the view.
// Rationale: IU-2b is a pure template/markup move — the view keeps 100% of its state and
// script logic untouched, including these type declarations. Duplicating the (small, stable)
// shapes here avoids a cross-file type import from a `.vue` SFC and avoids touching the view's
// script block at all. If either the view's shape or this file's shape drifts, TypeScript will
// fail the prop-type check at the call site in the view (structural typing), so drift cannot go
// unnoticed silently.
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
