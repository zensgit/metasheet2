/**
 * Employee overview: which deep-link / footer entries must open the
 * request/makeup disclosure after that card became collapsed-by-default.
 *
 * `attendance-overview-requests` is still the Summary card id. Historical
 * "我的申请" entries keep that query section; they must reveal the request
 * tools instead of leaving the form hidden.
 */
export const ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID = 'attendance-overview-requests'
export const ATTENDANCE_OVERVIEW_ANOMALIES_SECTION_ID = 'attendance-overview-anomalies'
export const ATTENDANCE_OVERVIEW_REQUEST_REPORT_SECTION_ID = 'attendance-overview-request-report'

export function shouldRevealOverviewRequestTools(
  sectionId: string | null | undefined,
  requestId: string | null | undefined = '',
): boolean {
  if (String(requestId ?? '').trim()) return true
  const section = String(sectionId ?? '').trim()
  return (
    section === ATTENDANCE_OVERVIEW_REQUESTS_SECTION_ID
    || section === ATTENDANCE_OVERVIEW_ANOMALIES_SECTION_ID
    || section === ATTENDANCE_OVERVIEW_REQUEST_REPORT_SECTION_ID
  )
}
