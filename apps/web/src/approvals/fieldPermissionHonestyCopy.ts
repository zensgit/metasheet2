/**
 * Lock-0 L0-6 — field-permission honesty copy, carried over CHARACTER-FOR-CHARACTER (including the
 * `（T1-4b）` marker) from the linear editor into the canvas presentation.
 *
 * Source of truth (byte-identical, do not paraphrase):
 *   apps/web/src/views/approval/TemplateAuthoringView.vue
 *     - readonly hint, testid `approval-step-field-readonly-hint`
 *     - routing hint,  testid `approval-step-field-routing-hint`
 *
 * docs/development/approval-lock0-d0-interaction-delta-20260817.md §1 L0-6: "a future slice
 * retiring [the T1-4b marker] must retire it in both surfaces in one change" — do not edit either
 * string here without editing TemplateAuthoringView.vue's copy in the SAME change.
 */
export const FIELD_PERMISSION_READONLY_HINT = '只读将在后续版本（T1-4b）生效，当前保存但暂不强制'

/**
 * §4 D5 — carries over under the SAME render condition as the linear editor: the field's access is
 * `hidden` AND the field is referenced by some node's `form_field_user` assignee source. The
 * cross-node ("some node", not just the currently selected one) half of that condition needs
 * graph-wide `approvalNodeEdits` data that is not reachable from this component without a change to
 * `TemplateAuthoringView.vue`'s `nodeConfigEditorApi` provide() object (out of scope for this
 * slice — see the P1-A PR description). The consuming code in `ApprovalGraphNodeConfigEditor.vue`
 * is wired and ready; it renders nothing until that one field is supplied.
 */
export const FIELD_PERMISSION_ROUTING_HINT = '该字段被审批人来源引用；隐藏仅影响回显，不影响审批人解析'
