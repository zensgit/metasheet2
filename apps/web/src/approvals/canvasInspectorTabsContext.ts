import type { ComputedRef, InjectionKey, Ref } from 'vue'

/**
 * Lock-0 L0-1 — shared context between `ApprovalCanvasNodeInspector.vue` (owns the tab strip UI +
 * tab membership, derived from the L0-2 capability registry) and `ApprovalGraphNodeConfigEditor.vue`
 * (owns the tab CONTENT — it shows only the active tab's section when tabbed).
 *
 * `provide()`d unconditionally by the shell (every canvas-inspector mount, regardless of the
 * selected node's type) so a single persisting inspector instance stays correct as selection moves
 * between node types; `active` is what actually gates tabbed vs. flat rendering for the currently
 * selected node. `inject()`ed with a `undefined` default by the config editor, so the SAME editor
 * component, when rendered outside the canvas inspector (the operator-only flag-off structured
 * renderer, which never wraps it in the shell), falls back to its original flat, un-tabbed
 * rendering.
 */
export type ApprovalCanvasInspectorTabId = 'assignee' | 'fieldPermissions' | 'operations'

export interface ApprovalCanvasInspectorTabDescriptor {
  id: ApprovalCanvasInspectorTabId
  label: string
}

export interface ApprovalCanvasInspectorTabsApi {
  /** True only when the CURRENTLY selected node renders as tabs (an `approval` node with editable
   *  config). False for every other node type/state — the config editor renders flat then, exactly
   *  as before this slice. */
  active: ComputedRef<boolean>
  tabs: ComputedRef<ApprovalCanvasInspectorTabDescriptor[]>
  activeTab: Ref<ApprovalCanvasInspectorTabId>
}

export const APPROVAL_CANVAS_INSPECTOR_TABS_KEY: InjectionKey<ApprovalCanvasInspectorTabsApi> =
  Symbol('approvalCanvasInspectorTabs')
