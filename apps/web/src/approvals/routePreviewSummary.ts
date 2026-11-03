import type { ApprovalRoutePreviewNode } from './api'

/**
 * RP-2 (B3-05) — chip summary for one resolved route node.
 *
 * Honest-rendering rules (mirror the backend's honesty contract):
 * - a node the walk could not resolve (`resolveError`, e.g. EMPTY_ASSIGNEES) or that resolved
 *   to nobody renders 「（审批人待定）」 — never a fabricated guess, never a blank chip;
 * - role assignees are visibly marked 「角色:」 so a requester cannot mistake a role bucket
 *   for a concrete person;
 * - names come server-enriched with an honest id fallback, so this function never re-guesses.
 *
 * O-8 / F8-1: `isZh` follows the shell locale on ApprovalNewView. It defaults to zh-CN only for the
 * template-authoring try-run caller (TemplateAuthoringView.vue, slice F8-3), which is not converted
 * yet and keeps today's Chinese output.
 */
export function routePreviewAssigneeSummary(node: ApprovalRoutePreviewNode, isZh = true): string {
  if (node.resolveError) return isZh ? '（审批人待定）' : '(approver to be determined)'
  if (node.assignees.length === 0) return isZh ? '（审批人待定）' : '(approver to be determined)'
  return node.assignees
    .map((a) => (a.assignmentType === 'role' ? (isZh ? `角色:${a.name}` : `Role: ${a.name}`) : a.name))
    .join(isZh ? '、' : ', ')
}
