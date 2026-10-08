// Employee overview task-first design-lock (2026-07-16, RATIFIED 2026-07-21):
// docs/development/attendance-employee-overview-task-first-design-lock-20260716.md
// §4.2 (attention priority table) / §9.1 (verification gates).
//
// Pure first-match "Needs attention" builder for the overview band. It
// consumes the SAME facts `AttendanceView.vue` already derives from
// `activeWorkbenchRecord` / `anomalies` / `requests` / the shared status
// banner (`statusMessage`/`statusKind`/`statusMeta`) — it fetches no new
// data and reinterprets no backend status/error code. Its only job is to
// pick ONE canonical attention item so the overview never renders the old
// focus-list + recommended-action callout as two competing copies (lock §1,
// §4.2 opening paragraph).
//
// Row order is first-match-wins and MUST NOT be reordered without a lock
// amendment — see the §4.2 table for the authoritative priority text.

export type TranslateFn = (en: string, zh: string) => string

export type AttendanceOverviewAttentionKey =
  | 'punch_failure'
  | 'anomaly'
  | 'request_rejected'
  | 'request_pending'
  | 'record_review'
  | 'setup_needed'
  | 'all_clear'
  | 'unknown_status'

export type AttendanceOverviewAttentionAction =
  | 'missing-punch'
  | 'leave'
  | 'overtime'
  | 'shift_swap'
  | 'records'
  | 'request-report'
  | null

export interface AttendanceOverviewAttentionItem {
  key: AttendanceOverviewAttentionKey
  title: string
  detail: string
  action: AttendanceOverviewAttentionAction
  actionLabel: string | null
  /**
   * True only for `punch_failure`. The shared status banner (directly below
   * the daily workspace, lock §4.1) already renders this item's message,
   * code, hint, and any real retry control — the attention band must render
   * no SECOND actionable control for it (lock §9.2: "exactly one primary
   * recommended action is rendered").
   */
  presentedByStatusBanner: boolean
}

// The record-status enum the backend actually emits, mirrored from
// `AttendanceView.vue`'s `describeAttendanceStatus` / status-chip classes.
// Any status outside these two sets is unrecognized and must fail closed to
// `unknown_status`, never silently read as `all_clear` (lock §9.1).
const RECORD_STATUS_NEEDS_REVIEW = new Set(['late', 'early_leave', 'late_early', 'partial', 'absent'])
const RECORD_STATUS_ALL_CLEAR = new Set(['normal', 'adjusted', 'off'])

export interface AttendanceOverviewAttentionFacts {
  /**
   * True while the status banner currently shows a punch-triggered error
   * (outdoor note required OR any other punch failure) — never a refresh,
   * admin, save-settings, or import error unrelated to punching. The caller
   * is responsible for scoping this (e.g. a dedicated status-source marker),
   * since the shared banner is reused by many non-punch flows.
   */
  punchFailureActive: boolean
  /** Mirrors `statusMessage` while `punchFailureActive` is true. */
  punchFailureMessage: string
  /** Current focus-date anomaly count, already scoped like
   * `activeWorkbenchAttentionCount` (0 when there is none). */
  anomalyCount: number
  /** Human-readable focus date, or null when there is no focus record. */
  focusDateLabel: string | null
  /**
   * Status of the most-recently-submitted request (same sort order as
   * `selfServiceSortedRequests`), or null when there are no requests at all.
   */
  latestRequestStatus: string | null
  pendingRequestCount: number
  /** `activeWorkbenchRecord?.status ?? null` — raw backend value, untouched. */
  focusRecordStatus: string | null
  /** Localized label for `focusRecordStatus` (e.g. via `formatStatus`). */
  focusRecordStatusLabel: string | null
  /** Localized date for `focusRecordStatus`'s work_date, if any. */
  focusRecordDateLabel: string | null
  /** Same gate `selfServiceNeedsSetupHint` already computes. */
  needsSetup: boolean
  /** Same copy `selfServiceSetupFollowupHint` already computes. */
  setupHint: string
}

export function resolveAttendanceOverviewAttention(
  facts: AttendanceOverviewAttentionFacts,
  tr: TranslateFn,
): AttendanceOverviewAttentionItem {
  // Priority 1 — outdoor note required or an actionable punch failure.
  if (facts.punchFailureActive) {
    return {
      key: 'punch_failure',
      title: tr('Resolve your punch first', '请先处理打卡问题'),
      detail: facts.punchFailureMessage,
      action: null,
      actionLabel: null,
      presentedByStatusBanner: true,
    }
  }

  // Priority 2 — current focus date has an anomaly.
  if (facts.anomalyCount > 0) {
    return {
      key: 'anomaly',
      title: tr('Resolve anomaly reminders', '优先处理异常提醒'),
      detail: facts.focusDateLabel
        ? tr(
          `${facts.anomalyCount} anomaly reminder${facts.anomalyCount === 1 ? '' : 's'} on ${facts.focusDateLabel}.`,
          `${facts.focusDateLabel} 仍有 ${facts.anomalyCount} 条异常提醒待处理。`,
        )
        : tr(
          `${facts.anomalyCount} anomaly reminder${facts.anomalyCount === 1 ? '' : 's'} need attention.`,
          `仍有 ${facts.anomalyCount} 条异常提醒待处理。`,
        ),
      action: 'missing-punch',
      actionLabel: tr('Fix missing punch', '处理缺卡'),
      presentedByStatusBanner: false,
    }
  }

  // Priority 3 — the latest request was rejected (state it plainly; never as pending).
  if (facts.latestRequestStatus === 'rejected') {
    return {
      key: 'request_rejected',
      title: tr('Needs attention', '需要关注'),
      detail: tr(
        'Your latest request was rejected and may need a new submission.',
        '你最近提交的申请已被驳回，可能需要重新提交。',
      ),
      action: 'request-report',
      actionLabel: tr('Review request history', '查看申请历史'),
      presentedByStatusBanner: false,
    }
  }

  // Priority 4 — one or more requests pending (never implies approval power).
  if (facts.pendingRequestCount > 0) {
    return {
      key: 'request_pending',
      title: tr('Track pending approvals', '跟进待审批申请'),
      detail: tr(
        `${facts.pendingRequestCount} request${facts.pendingRequestCount === 1 ? '' : 's'} still waiting for approval.`,
        `还有 ${facts.pendingRequestCount} 条申请正在等待审批。`,
      ),
      action: 'request-report',
      actionLabel: tr('Open request report', '打开申请报表'),
      presentedByStatusBanner: false,
    }
  }

  // Priority 5 — focus record is late / early / late+early / partial / absent.
  if (facts.focusRecordStatus && RECORD_STATUS_NEEDS_REVIEW.has(facts.focusRecordStatus)) {
    const statusLabel = facts.focusRecordStatusLabel ?? facts.focusRecordStatus
    return {
      key: 'record_review',
      title: tr('Review the focus workday', '查看关注工作日'),
      detail: facts.focusRecordDateLabel
        ? tr(`${statusLabel} was recorded for ${facts.focusRecordDateLabel}.`, `${facts.focusRecordDateLabel} 记录为${statusLabel}。`)
        : tr(`${statusLabel} was recorded for the focus workday.`, `关注工作日记录为${statusLabel}。`),
      action: 'records',
      actionLabel: tr('Review records', '查看记录'),
      presentedByStatusBanner: false,
    }
  }

  // Priority 6 — no record/request/anomaly signal exists at all.
  if (facts.needsSetup) {
    return {
      key: 'setup_needed',
      title: tr('Check attendance setup', '检查考勤配置'),
      detail: facts.setupHint,
      action: null,
      actionLabel: null,
      presentedByStatusBanner: false,
    }
  }

  // Priority 7 — normal / adjusted / off / otherwise caught up.
  if (facts.focusRecordStatus === null || RECORD_STATUS_ALL_CLEAR.has(facts.focusRecordStatus)) {
    return {
      key: 'all_clear',
      title: tr('You are caught up', '当前已处理完毕'),
      detail: tr(
        'No anomaly reminders or pending approvals are blocking your attendance follow-up.',
        '当前没有异常提醒或待审批事项阻塞你的考勤跟进。',
      ),
      action: null,
      actionLabel: null,
      presentedByStatusBanner: false,
    }
  }

  // Fail-closed: an unrecognized record status must never read as success.
  return {
    key: 'unknown_status',
    title: tr('Review your attendance record', '请查看你的考勤记录'),
    detail: tr(
      'This workday has a status this page does not recognize yet — review the records for details.',
      '该工作日的状态暂未被识别，请在记录中查看详情。',
    ),
    action: 'records',
    actionLabel: tr('Review records', '查看记录'),
    presentedByStatusBanner: false,
  }
}
