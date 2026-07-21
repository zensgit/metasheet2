import { describe, expect, it } from 'vitest'
import {
  resolveAttendanceOverviewAttention,
  type AttendanceOverviewAttentionFacts,
} from '../src/views/attendance/attendanceOverviewPriority'

// Employee overview task-first design-lock (RATIFIED 2026-07-21):
// docs/development/attendance-employee-overview-task-first-design-lock-20260716.md
// §4.2 (attention priority table) / §9.1 (pure priority matrix gates).

const tr = (en: string, _zh: string) => en

const BASE_FACTS: AttendanceOverviewAttentionFacts = {
  punchFailureActive: false,
  punchFailureMessage: '',
  anomalyCount: 0,
  focusDateLabel: null,
  latestRequestStatus: null,
  pendingRequestCount: 0,
  focusRecordStatus: null,
  focusRecordStatusLabel: null,
  focusRecordDateLabel: null,
  needsSetup: false,
  setupHint: '',
}

function facts(overrides: Partial<AttendanceOverviewAttentionFacts>): AttendanceOverviewAttentionFacts {
  return { ...BASE_FACTS, ...overrides }
}

describe('resolveAttendanceOverviewAttention (pure priority matrix)', () => {
  it('priority 1: an actionable punch failure outranks anomaly and pending/rejected requests', () => {
    const item = resolveAttendanceOverviewAttention(
      facts({
        punchFailureActive: true,
        punchFailureMessage: 'Punch interval is too short. Try again shortly.',
        anomalyCount: 3,
        latestRequestStatus: 'rejected',
        pendingRequestCount: 2,
      }),
      tr,
    )
    expect(item.key).toBe('punch_failure')
    expect(item.detail).toBe('Punch interval is too short. Try again shortly.')
    // The status banner already renders message/code/hint/retry — the
    // attention band must not fabricate a second actionable control.
    expect(item.action).toBeNull()
    expect(item.actionLabel).toBeNull()
    expect(item.presentedByStatusBanner).toBe(true)
  })

  it('priority 2: anomaly outranks rejected and pending requests (mutation target A)', () => {
    const item = resolveAttendanceOverviewAttention(
      facts({
        anomalyCount: 2,
        focusDateLabel: '2026-04-15',
        latestRequestStatus: 'rejected',
        pendingRequestCount: 4,
      }),
      tr,
    )
    expect(item.key).toBe('anomaly')
    expect(item.action).toBe('missing-punch')
    expect(item.detail).toContain('2 anomaly reminders')
    expect(item.detail).toContain('2026-04-15')
  })

  it('priority 2 singular copy: exactly one anomaly reminder does not pluralize', () => {
    const item = resolveAttendanceOverviewAttention(facts({ anomalyCount: 1 }), tr)
    expect(item.key).toBe('anomaly')
    expect(item.detail).toContain('1 anomaly reminder ')
    expect(item.detail).not.toContain('reminders')
  })

  it('priority 3: a rejected latest request is not lost behind an all-clear record', () => {
    const item = resolveAttendanceOverviewAttention(
      facts({ latestRequestStatus: 'rejected', focusRecordStatus: 'normal' }),
      tr,
    )
    expect(item.key).toBe('request_rejected')
    expect(item.action).toBe('request-report')
    expect(item.detail.toLowerCase()).not.toContain('pending')
  })

  it('priority 3 does not fire when the latest request is merely pending (falls to priority 4 instead)', () => {
    const item = resolveAttendanceOverviewAttention(
      facts({ latestRequestStatus: 'pending', pendingRequestCount: 1 }),
      tr,
    )
    expect(item.key).toBe('request_pending')
  })

  it('priority 4: a pending request never exposes approval actions or approve/reject wording', () => {
    const item = resolveAttendanceOverviewAttention(
      facts({ latestRequestStatus: 'pending', pendingRequestCount: 3 }),
      tr,
    )
    expect(item.key).toBe('request_pending')
    expect(item.action).toBe('request-report')
    expect(item.title.toLowerCase()).not.toContain('approve')
    expect(item.title.toLowerCase()).not.toContain('reject')
    expect(item.detail.toLowerCase()).not.toContain('approve')
    expect(item.detail).toContain('3 requests still waiting for approval')
  })

  it.each(['late', 'early_leave', 'late_early', 'partial', 'absent'])(
    'priority 5: focus record status "%s" maps to record_review',
    (status) => {
      const item = resolveAttendanceOverviewAttention(
        facts({ focusRecordStatus: status, focusRecordStatusLabel: status, focusRecordDateLabel: '2026-04-15' }),
        tr,
      )
      expect(item.key).toBe('record_review')
      expect(item.action).toBe('records')
      expect(item.detail).toContain('2026-04-15')
    },
  )

  it('priority 6: no record/request/anomaly signal produces the setup guidance with no fabricated CTA', () => {
    const item = resolveAttendanceOverviewAttention(
      facts({ needsSetup: true, setupHint: 'Ask an attendance admin to confirm your group and shift setup.' }),
      tr,
    )
    expect(item.key).toBe('setup_needed')
    expect(item.detail).toBe('Ask an attendance admin to confirm your group and shift setup.')
    expect(item.action).toBeNull()
    expect(item.actionLabel).toBeNull()
  })

  it.each([null, 'normal', 'adjusted', 'off'])(
    'priority 7: focus record status %s is an explicit all-clear with no fabricated blocking task',
    (status) => {
      const item = resolveAttendanceOverviewAttention(facts({ focusRecordStatus: status }), tr)
      expect(item.key).toBe('all_clear')
      expect(item.action).toBeNull()
      expect(item.actionLabel).toBeNull()
    },
  )

  it('fail-closed: an unrecognized record status never reads as all_clear (mutation target B)', () => {
    const item = resolveAttendanceOverviewAttention(
      facts({ focusRecordStatus: 'some_future_backend_status' }),
      tr,
    )
    expect(item.key).toBe('unknown_status')
    expect(item.key).not.toBe('all_clear')
    expect(item.action).toBe('records')
  })

  it('first-match order (OD-O1): higher priority facts always dominate regardless of lower-priority facts', () => {
    const everythingOn = resolveAttendanceOverviewAttention(
      facts({
        punchFailureActive: true,
        punchFailureMessage: 'boom',
        anomalyCount: 1,
        latestRequestStatus: 'rejected',
        pendingRequestCount: 1,
        focusRecordStatus: 'late',
        focusRecordStatusLabel: 'Late',
        needsSetup: false,
      }),
      tr,
    )
    expect(everythingOn.key).toBe('punch_failure')

    const withoutPunchFailure = resolveAttendanceOverviewAttention(
      facts({
        anomalyCount: 1,
        latestRequestStatus: 'rejected',
        pendingRequestCount: 1,
        focusRecordStatus: 'late',
        focusRecordStatusLabel: 'Late',
      }),
      tr,
    )
    expect(withoutPunchFailure.key).toBe('anomaly')

    const withoutAnomaly = resolveAttendanceOverviewAttention(
      facts({ latestRequestStatus: 'rejected', pendingRequestCount: 1, focusRecordStatus: 'late', focusRecordStatusLabel: 'Late' }),
      tr,
    )
    expect(withoutAnomaly.key).toBe('request_rejected')

    const withoutRejected = resolveAttendanceOverviewAttention(
      facts({ pendingRequestCount: 1, focusRecordStatus: 'late', focusRecordStatusLabel: 'Late' }),
      tr,
    )
    expect(withoutRejected.key).toBe('request_pending')

    const withoutPending = resolveAttendanceOverviewAttention(
      facts({ focusRecordStatus: 'late', focusRecordStatusLabel: 'Late' }),
      tr,
    )
    expect(withoutPending.key).toBe('record_review')
  })

  it('always returns exactly one item shape (no dual-copy fields)', () => {
    const item = resolveAttendanceOverviewAttention(facts({}), tr)
    expect(Object.keys(item).sort()).toEqual(
      ['action', 'actionLabel', 'detail', 'key', 'presentedByStatusBanner', 'title'].sort(),
    )
  })
})
