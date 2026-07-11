import { ApprovalApiError } from './api'

/**
 * RP-3 (route-preview lock, B3-06 FE 试运行面板) — wedge-guard machine code → actionable Chinese
 * message, instead of surfacing a generic "请求失败" flash (or the server's English message
 * verbatim) when the sample requester the author picked can't be routed.
 *
 * The shared preview substrate (`assembleCreationContext`, RP-1) fails closed with one of two
 * shapes when the draft graph routes on a requester attribute:
 *   - a GENUINE row-level absence (the directory read succeeded but the attribute is unset on
 *     that user) → 422 `*_REQUIRED` — a real submit by this person would be rejected the same
 *     way, so the author should pick a different sample requester or complete that person's
 *     directory record.
 *   - a TRANSIENT read failure (the directory lookup itself threw) → 503 `*_UNRESOLVED` —
 *     retryable, not something the chosen sample requester did wrong.
 * This module keys off `error.code` alone, never HTTP status — honest even if a code's status
 * ever changes, and correct today even though 422 and 503 both appear in the matrix below.
 *
 * Pure (no Vue import) so it is unit-testable as a plain matrix without mounting the 2300+-line
 * TemplateAuthoringView.
 */
const ROUTE_PREVIEW_WEDGE_MESSAGES: Record<string, string> = {
  APPROVAL_REQUESTER_DEPARTMENT_REQUIRED:
    '此样例发起人缺少部门，真实提交会被拒绝。换一个样例发起人，或先补全其目录信息。',
  APPROVAL_REQUESTER_TITLE_REQUIRED:
    '此样例发起人缺少职位，真实提交会被拒绝。换一个样例发起人，或先补全其目录信息。',
  APPROVAL_REQUESTER_DEPARTMENT_UNRESOLVED:
    '未能读取此样例发起人的部门信息，请稍后重试。',
  APPROVAL_REQUESTER_TITLE_UNRESOLVED:
    '未能读取此样例发起人的职位信息，请稍后重试。',
  APPROVAL_REQUESTER_ROLE_UNRESOLVED:
    '未能读取此样例发起人的角色信息，请稍后重试。',
}

/**
 * Maps a failed `previewTemplateRoute` call to a display string. Narrows `error` to
 * `ApprovalApiError` internally (rather than taking a bare `code` param) so the
 * instanceof-and-extract glue itself sits under this function's unit tests instead of being
 * untested view wiring.
 */
export function describeRoutePreviewError(error: unknown, fallback = '试运行失败'): string {
  const code = error instanceof ApprovalApiError ? error.code : undefined
  if (code && ROUTE_PREVIEW_WEDGE_MESSAGES[code]) return ROUTE_PREVIEW_WEDGE_MESSAGES[code]
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}
