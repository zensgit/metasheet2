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
 */
export function routePreviewAssigneeSummary(node: ApprovalRoutePreviewNode): string {
  if (node.resolveError) return '（审批人待定）'
  if (node.assignees.length === 0) return '（审批人待定）'
  return node.assignees.map((a) => (a.assignmentType === 'role' ? `角色:${a.name}` : a.name)).join('、')
}
