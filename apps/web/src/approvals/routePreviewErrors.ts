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

// R-43 follow-up (a) — the server validates a 试运行 sample against the WHOLE form, the same way a
// real submit does (`assembleCreationContext` → `validateApprovalFormData`). A visible required field
// the author left empty therefore fails with 400 `VALIDATION_ERROR` and the English message
// "Approval form data is invalid", which the panel used to show verbatim. That same code also covers
// type / length / option / linked-record failures and the route's own missing-body 400, so the code
// alone cannot tell them apart: only `details.errors` entries of the server's exact
// `<fieldId> is required` / `<detailId>[i].<columnId> is required` shape select the localized hint.
// Every other failure keeps its current text. Field NAMES only — never a value, never a raw id.

/** `<fieldId> is required`, or a detail cell `<detailId>[<row>].<columnId> is required` (group 1 = base id). */
const REQUIRED_ENTRY = /^([^\s[]+)(?:\[\d+\]\.\S+)? is required$/

export interface RoutePreviewErrorOptions {
  /** Field id → display name. A null / empty result is left out (the raw id is never shown). */
  fieldLabel?: (fieldId: string) => string | null | undefined
  /** Defaults to true, like `routePreviewController`. */
  isZh?: boolean
}

export const ROUTE_PREVIEW_REQUIRED_COPY_ZH = {
  withNames: (names: string) => `样例里有必填字段未填写：${names}。试运行和真实提交一样按完整表单校验，请先在上方补全后再试运行。`,
  withoutNames: '样例里有必填字段未填写。试运行和真实提交一样按完整表单校验，请先在上方补全后再试运行。',
  cannotFillHint: '明细、附件、部门、关联记录、日期区间、多选人员等字段无法在试运行里填写（多选人员在这里只能选一人）；这类字段为必填时，可在模板发布后到发起页用「按当前表单预览路径」按完整表单预览（发起页按已发布的版本计算）。',
  nameSeparator: '、',
  quote: (label: string) => `「${label}」`,
  joiner: '',
}

export const ROUTE_PREVIEW_REQUIRED_COPY_EN: typeof ROUTE_PREVIEW_REQUIRED_COPY_ZH = {
  withNames: (names: string) => `Some required fields in the sample are empty: ${names}. Try-run validates the whole form, the same as a real submission. Fill them in above and run it again.`,
  withoutNames: 'Some required fields in the sample are empty. Try-run validates the whole form, the same as a real submission. Fill them in above and run it again.',
  cannotFillHint: 'Detail, attachment, department, linked-record, date-range and multi-person fields cannot be filled in here (a multi-person field only takes one person here). If one of them is required, publish the template and use "Preview the route for this form" on the submit page to preview with the whole form (the submit page uses the published version).',
  nameSeparator: ', ',
  quote: (label: string) => `"${label}"`,
  joiner: ' ',
}

/**
 * The BASE ids of the required fields the server reported empty (deduplicated, first occurrence
 * first), or null when `error` is not that kind of failure: it must be an `ApprovalApiError` with
 * code `VALIDATION_ERROR` whose `details.errors` holds at least one string entry of the exact
 * required-field shape. Non-string entries are ignored.
 */
export function routePreviewMissingRequiredFieldIds(error: unknown): string[] | null {
  if (!(error instanceof ApprovalApiError) || error.code !== 'VALIDATION_ERROR') return null
  const entries = error.details?.errors
  if (!Array.isArray(entries)) return null
  const ids: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const match = REQUIRED_ENTRY.exec(entry)
    if (match && !ids.includes(match[1]!)) ids.push(match[1]!)
  }
  return ids.length > 0 ? ids : null
}

function describeMissingRequired(ids: readonly string[], options: RoutePreviewErrorOptions): string {
  const copy = options.isZh === false ? ROUTE_PREVIEW_REQUIRED_COPY_EN : ROUTE_PREVIEW_REQUIRED_COPY_ZH
  const names: string[] = []
  for (const id of ids) {
    const name = options.fieldLabel?.(id)?.trim()
    if (name) names.push(copy.quote(name))
  }
  const lead = names.length > 0 ? copy.withNames(names.join(copy.nameSeparator)) : copy.withoutNames
  return `${lead}${copy.joiner}${copy.cannotFillHint}`
}

/**
 * Maps a failed `previewTemplateRoute` call to a display string. Narrows `error` to
 * `ApprovalApiError` internally (rather than taking a bare `code` param) so the
 * instanceof-and-extract glue itself sits under this function's unit tests instead of being
 * untested view wiring. Order: the wedge codes above (unchanged) → a missing-required-field
 * validation failure (localized hint) → the error's own message → `fallback`.
 */
export function describeRoutePreviewError(
  error: unknown,
  fallback = '试运行失败',
  options: RoutePreviewErrorOptions = {},
): string {
  const code = error instanceof ApprovalApiError ? error.code : undefined
  if (code && ROUTE_PREVIEW_WEDGE_MESSAGES[code]) return ROUTE_PREVIEW_WEDGE_MESSAGES[code]
  const missingRequired = routePreviewMissingRequiredFieldIds(error)
  if (missingRequired) return describeMissingRequired(missingRequired, options)
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}
