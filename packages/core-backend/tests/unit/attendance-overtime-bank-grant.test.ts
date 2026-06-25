import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceOvertimeBankForTests as {
  resolveOvertimeBankSourceMinutes: (segments: unknown) => { workday: number; restday: number; statutory_holiday: number }
  partitionOvertimeBankGrantLots: (input: {
    requestId: string; totalMinutes: number; segments?: unknown
    overtimeBankPolicy?: { enabled?: boolean; pooledSources?: string[] }
  }) => { lots: Array<{ source: string | null; sourceKey: string; minutes: number }>; perSource: Array<{ source: string; minutes: number }> }
}

const segs = (w: number, r: number, h: number) => ({ workdayMinutes: w, restdayMinutes: r, holidayMinutes: h })
const sum = (xs: Array<{ minutes: number }>) => xs.reduce((s, x) => s + x.minutes, 0)

describe('#加班银行 v1-1b — partitionOvertimeBankGrantLots (dormant byte-identical / enabled per-source)', () => {
  const part = helpers.partitionOvertimeBankGrantLots

  it('DORMANT (no policy / enabled=false): a single NULL-source lot of the whole total — byte-identical', () => {
    expect(part({ requestId: 'r1', totalMinutes: 120, segments: segs(60, 60, 0), overtimeBankPolicy: undefined }))
      .toEqual({ lots: [{ source: null, sourceKey: 'overtime_conversion:r1', minutes: 120 }], perSource: [] })
    expect(part({ requestId: 'r1', totalMinutes: 120, segments: segs(60, 60, 0), overtimeBankPolicy: { enabled: false, pooledSources: ['workday', 'restday'] } }).lots)
      .toEqual([{ source: null, sourceKey: 'overtime_conversion:r1', minutes: 120 }])
  })

  it('DORMANT zero total → no lots', () => {
    expect(part({ requestId: 'r1', totalMinutes: 0, segments: segs(0, 0, 0) }).lots).toEqual([])
  })

  it('ENABLED: partition by source weights, pooled lots keyed per-source; Σ perSource === total (conservation)', () => {
    const r = part({ requestId: 'r2', totalMinutes: 120, segments: segs(60, 60, 0), overtimeBankPolicy: { enabled: true, pooledSources: ['workday', 'restday'] } })
    expect(r.perSource).toEqual([{ source: 'workday', minutes: 60 }, { source: 'restday', minutes: 60 }, { source: 'statutory_holiday', minutes: 0 }])
    expect(sum(r.perSource)).toBe(120)
    expect(r.lots).toEqual([
      { source: 'workday', sourceKey: 'overtime_conversion:r2:workday', minutes: 60 },
      { source: 'restday', sourceKey: 'overtime_conversion:r2:restday', minutes: 60 },
    ])
  })

  it('ENABLED rule-normalized total ≠ raw segment sum: partition the TOTAL (rule applied ONCE upstream), not segments', () => {
    // raw segments 60/60 (sum 120) but the rule-normalized comp-time total = 90 → partition 90 by 60/60 → 45/45.
    const r = part({ requestId: 'r3', totalMinutes: 90, segments: segs(60, 60, 0), overtimeBankPolicy: { enabled: true, pooledSources: ['workday', 'restday'] } })
    expect(sum(r.perSource)).toBe(90)
    expect(r.lots.map((l) => l.minutes)).toEqual([45, 45])
  })

  it('COMPLIANCE: holiday OT → statutory_holiday, attributed but NEVER banked (must-pay); only workday/restday lots', () => {
    const r = part({ requestId: 'r4', totalMinutes: 180, segments: segs(60, 60, 60), overtimeBankPolicy: { enabled: true, pooledSources: ['workday', 'restday'] } })
    expect(r.perSource).toEqual([{ source: 'workday', minutes: 60 }, { source: 'restday', minutes: 60 }, { source: 'statutory_holiday', minutes: 60 }])
    expect(sum(r.perSource)).toBe(180)
    expect(r.lots.map((l) => l.source)).toEqual(['workday', 'restday']) // statutory_holiday not banked
  })

  it('odd total: the LAST NON-ZERO source absorbs the remainder; a 0-weight source gets exactly 0 (no mis-attribution)', () => {
    const r = part({ requestId: 'r5', totalMinutes: 121, segments: segs(60, 60, 0), overtimeBankPolicy: { enabled: true, pooledSources: ['workday', 'restday'] } })
    expect(r.perSource).toEqual([{ source: 'workday', minutes: 60 }, { source: 'restday', minutes: 61 }, { source: 'statutory_holiday', minutes: 0 }])
    expect(sum(r.perSource)).toBe(121)
  })

  it('per-source sourceKey is deterministic (replay ON CONFLICT idempotency holds)', () => {
    const a = part({ requestId: 'rX', totalMinutes: 120, segments: segs(60, 60, 0), overtimeBankPolicy: { enabled: true, pooledSources: ['workday', 'restday'] } })
    const b = part({ requestId: 'rX', totalMinutes: 120, segments: segs(60, 60, 0), overtimeBankPolicy: { enabled: true, pooledSources: ['workday', 'restday'] } })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.lots.map((l) => l.sourceKey)).toEqual(['overtime_conversion:rX:workday', 'overtime_conversion:rX:restday'])
  })

  it('§P1 ENABLED but NO source breakdown (segments null / all-zero) → FAIL CLOSED: pool NOTHING (must-pay)', () => {
    // the NULL-source whole-lot fallback would bypass the §6 floor + pooledSources — so the enabled path pools
    // nothing when the source is unresolvable (the OT is must-pay, not banked). NULL fallback is dormant-only.
    expect(part({ requestId: 'r6', totalMinutes: 90, segments: null, overtimeBankPolicy: { enabled: true, pooledSources: ['workday', 'restday'] } }))
      .toEqual({ lots: [], perSource: [] })
    expect(part({ requestId: 'r6', totalMinutes: 90, segments: segs(0, 0, 0), overtimeBankPolicy: { enabled: true, pooledSources: ['workday', 'restday'] } }))
      .toEqual({ lots: [], perSource: [] })
  })
})
