/**
 * Lock-7 G-13 / Lock-0 L0-6 — the readonly "not-yet-enforced" honesty hint has been RETIRED (its
 * constant and both render sites are removed). Per-node `readonly` / `hidden` are now ENFORCED
 * server-side (Lock-7 P4-B: the write mask refuses a write to a masked field, and the detail read
 * carries the actor-scoped access map), so the disclosure it made is no longer true. L0-6's one-change
 * rule required the retiral to land in BOTH authoring surfaces (the linear TemplateAuthoringView and
 * the canvas ApprovalGraphNodeConfigEditor) in the SAME change — Lock-7 is the only lock that may
 * remove it, and this is that change.
 *
 * The routing hint below is NOT retired: under OD-L7-8(a) a routing driver may never be `editable` at
 * any node, so hiding a driver still affects only the echo and never approver resolution — the string
 * stays TRUE (Lock-7 G-13 arm-conditional: do not "correct" an accurate string).
 */

/**
 * §4 D5 — rendered under the SAME condition in both surfaces: the field's access is `hidden` AND the
 * field is referenced by some node's `form_field_user` assignee source. The cross-node ("some node",
 * not just the currently selected one) half is supplied graph-wide by `TemplateAuthoringView.vue`'s
 * `nodeConfigEditorApi.routingDriverFieldIds`; the canvas inspector consumes it (WIRED — it renders
 * whenever a hidden field is a driver). Accurate under OD-L7-8(a): a driver can never be `editable`,
 * so hiding it affects only the read echo, never approver resolution.
 */
export const FIELD_PERMISSION_ROUTING_HINT = '该字段被审批人来源引用；隐藏仅影响回显，不影响审批人解析'
