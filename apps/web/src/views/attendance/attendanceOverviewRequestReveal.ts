/**
 * Employee overview: which deep links must open the collapsed request/makeup
 * disclosure.
 *
 * `attendance-overview-requests` is the Summary card id. Historical 「我的申请」
 * entries keep that query section and must reveal the request tools.
 *
 * `attendance-overview-anomalies` is the anomalies list. Landing there must
 * not open the makeup disclosure (task-home 「异常」 scrolls to the list).
 * `attendance-overview-request-report` is the reports-mode request report and
 * is absent on overview, so it must not open the makeup disclosure either.
 */
export const ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID = 'attendance-overview-requests'
export const ATTENDANCE_OVERVIEW_ANOMALIES_SECTION_ID = 'attendance-overview-anomalies'
export const ATTENDANCE_OVERVIEW_REQUEST_REPORT_SECTION_ID = 'attendance-overview-request-report'

export function shouldRevealOverviewRequestTools(
  sectionId: string | null | undefined,
  requestId: string | null | undefined = '',
): boolean {
  if (String(requestId ?? '').trim()) return true
  return String(sectionId ?? '').trim() === ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID
}
