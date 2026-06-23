/**
 * #5 report tiering (design-lock #3055) — severe-late / absence-late as first-class self-calc.
 * Unit-level (no DB): (1) the pure tier math `computeLateTierCounts`, and (2) the WIRING — the pure
 * `computeAttendanceRecordUpsertValues` writes the tiers into the record `meta` the report fields read,
 * derived from the (post-override) lateMinutes + the per-group rule thresholds. The report-field read of
 * that meta is unchanged existing behavior; the real-DB end-to-end (upsert→export) is the integration test.
 */
import { describe, it, expect } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const { computeLateTierCounts, computeAttendanceRecordUpsertValues, mapRuleRow } =
  attendancePlugin.__attendanceReportFieldCatalogForTests as {
    computeLateTierCounts: (lateMinutes: number, rule: Record<string, unknown>) => { severeLateCount: number; severeLateMinutes: number; absenceLateCount: number }
    computeAttendanceRecordUpsertValues: (options: Record<string, unknown>) => { lateMinutes: number; metaJson: string }
    mapRuleRow: (row: Record<string, unknown>) => { severeLateThresholdMinutes: number; absenceLateThresholdMinutes: number; lateGraceMinutes: number }
  }

describe('computeLateTierCounts (#5 tier math)', () => {
  it('defaults to severe 30 / absence 60 when the rule omits thresholds', () => {
    expect(computeLateTierCounts(35, {})).toEqual({ severeLateCount: 1, severeLateMinutes: 35, absenceLateCount: 0 })
    expect(computeLateTierCounts(20, {})).toEqual({ severeLateCount: 0, severeLateMinutes: 0, absenceLateCount: 0 })
    expect(computeLateTierCounts(0, {})).toEqual({ severeLateCount: 0, severeLateMinutes: 0, absenceLateCount: 0 })
  })

  it('tiers are NESTED — past the absence threshold a record is also severe-late', () => {
    expect(computeLateTierCounts(70, {})).toEqual({ severeLateCount: 1, severeLateMinutes: 70, absenceLateCount: 1 })
    expect(computeLateTierCounts(60, { severeLateThresholdMinutes: 30, absenceLateThresholdMinutes: 60 }))
      .toEqual({ severeLateCount: 1, severeLateMinutes: 60, absenceLateCount: 1 })
  })

  it('honours per-group rule overrides', () => {
    expect(computeLateTierCounts(20, { severeLateThresholdMinutes: 15, absenceLateThresholdMinutes: 40 }))
      .toEqual({ severeLateCount: 1, severeLateMinutes: 20, absenceLateCount: 0 })
  })

  it('a threshold of 0 DISABLES that tier (never counts)', () => {
    expect(computeLateTierCounts(120, { severeLateThresholdMinutes: 0, absenceLateThresholdMinutes: 0 }))
      .toEqual({ severeLateCount: 0, severeLateMinutes: 0, absenceLateCount: 0 })
    // severe enabled, absence disabled (0): severe still fires, absence never does.
    expect(computeLateTierCounts(120, { severeLateThresholdMinutes: 30, absenceLateThresholdMinutes: 0 }))
      .toEqual({ severeLateCount: 1, severeLateMinutes: 120, absenceLateCount: 0 })
  })

  it('ENFORCES nesting against incoherent config (absence < severe) — never absence-without-severe', () => {
    // absence(20) < severe(50): a 30-min record must NOT count as absence while not severe.
    expect(computeLateTierCounts(30, { severeLateThresholdMinutes: 50, absenceLateThresholdMinutes: 20 }))
      .toEqual({ severeLateCount: 0, severeLateMinutes: 0, absenceLateCount: 0 })
    // past the (higher) severe threshold, both fire — effectiveAbsence is lifted to severe.
    expect(computeLateTierCounts(60, { severeLateThresholdMinutes: 50, absenceLateThresholdMinutes: 20 }))
      .toEqual({ severeLateCount: 1, severeLateMinutes: 60, absenceLateCount: 1 })
  })

  it('floors fractional / coerces non-numeric lateMinutes', () => {
    expect(computeLateTierCounts(30.9, {}).severeLateCount).toBe(1)
    expect(computeLateTierCounts('not a number' as unknown as number, {}).severeLateCount).toBe(0)
  })
})

describe('computeAttendanceRecordUpsertValues — tier WIRING into record meta (no DB)', () => {
  const rule = {
    orgId: 'default',
    timezone: 'UTC',
    workStartTime: '09:00',
    workEndTime: '18:00',
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    severeLateThresholdMinutes: 30,
    absenceLateThresholdMinutes: 60,
    roundingMinutes: 5,
    isOvernight: false,
  }
  const baseOptions = (firstIn: string) => ({
    existingRow: null,
    updateFirstInAt: new Date(firstIn),
    updateLastOutAt: new Date('2026-09-21T18:00:00Z'),
    workDate: '2026-09-21',
    mode: 'override',
    isWorkday: true,
    meta: {},
    rule,
    leaveMinutes: 0,
    overtimeMinutes: 0,
  })
  const metaOf = (firstIn: string) => {
    const values = computeAttendanceRecordUpsertValues(baseOptions(firstIn))
    return { lateMinutes: values.lateMinutes, meta: JSON.parse(values.metaJson) as Record<string, number> }
  }

  it('a severe-late punch (09:45 → 35 min late, ≥ severe 30) writes severe_late_count=1, absence=0', () => {
    const { lateMinutes, meta } = metaOf('2026-09-21T09:45:00Z')
    expect(lateMinutes).toBe(35)
    expect(meta.severe_late_count).toBe(1)
    expect(meta.severe_late_minutes).toBe(35)
    expect(meta.absence_late_count).toBe(0)
  })

  it('an absence-level punch (10:30 → 80 min late, ≥ absence 60) writes BOTH tiers', () => {
    const { lateMinutes, meta } = metaOf('2026-09-21T10:30:00Z')
    expect(lateMinutes).toBe(80)
    expect(meta.severe_late_count).toBe(1)
    expect(meta.absence_late_count).toBe(1)
  })

  it('an on-time / within-grace punch (09:05) writes zeros — the report reflects no tier', () => {
    const { lateMinutes, meta } = metaOf('2026-09-21T09:05:00Z')
    expect(lateMinutes).toBe(0)
    expect(meta.severe_late_count).toBe(0)
    expect(meta.severe_late_minutes).toBe(0)
    expect(meta.absence_late_count).toBe(0)
  })
})

describe('RT-1a — mapRuleRow reads the persisted per-group thresholds, feeding the tier compute (no DB)', () => {
  it('reads severe_late_threshold_minutes / absence_late_threshold_minutes off the row', () => {
    const rule = mapRuleRow({ id: 'r1', late_grace_minutes: 10, severe_late_threshold_minutes: 15, absence_late_threshold_minutes: 40 })
    expect(rule.severeLateThresholdMinutes).toBe(15)
    expect(rule.absenceLateThresholdMinutes).toBe(40)
    // the persisted custom threshold then drives the tier: 20 min late ≥ custom 15 → severe (would be 0 at the default 30).
    expect(computeLateTierCounts(20, rule)).toEqual({ severeLateCount: 1, severeLateMinutes: 20, absenceLateCount: 0 })
  })

  it('falls back to the RT-1 defaults (30 / 60) for a legacy row missing the columns', () => {
    const rule = mapRuleRow({ id: 'r2', late_grace_minutes: 10 })
    expect(rule.severeLateThresholdMinutes).toBe(30)
    expect(rule.absenceLateThresholdMinutes).toBe(60)
    expect(computeLateTierCounts(20, rule).severeLateCount).toBe(0) // 20 < default 30
  })
})
