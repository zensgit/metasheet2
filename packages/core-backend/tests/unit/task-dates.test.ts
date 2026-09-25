import { describe, expect, it } from 'vitest'
import {
  computeDueAt,
  isOverdue,
  isOverdueOrToday,
  resolveViewerTimeZone,
  validateViewerTimeZoneHeader,
  viewerNextMidnight,
  viewerToday,
  type TaskDueShape,
} from '../../src/tasks/task-dates'
// Only used to build the fallback-mutant's validity check below (same check the source uses) — the
// mutant changes ONLY the fallback literal ('UTC' instead of the task tz), nothing else.
import { isValidIanaTimeZone } from '../../src/multitable/automation-timezone'

// Gate 8 "A-branch" fixture (design §2.3, lock §12 门 8, verbatim numbers):
//   now = 2026-09-15T12:30Z, task time_zone = Asia/Shanghai, due_at = 2026-09-15T18:00:00Z.
const NOW = new Date('2026-09-15T12:30:00.000Z')
const TASK_TZ = 'Asia/Shanghai'
const DUE_AT = new Date('2026-09-15T18:00:00.000Z')

describe('task-dates', () => {
  describe('viewerNextMidnight / viewerToday — gate 8 A-branch guard values', () => {
    it('NM(Asia/Shanghai) = 2026-09-15T16:00Z', () => {
      expect(viewerNextMidnight(NOW, 'Asia/Shanghai').toISOString()).toBe('2026-09-15T16:00:00.000Z')
    })

    it('NM(UTC) = 2026-09-16T00:00Z', () => {
      expect(viewerNextMidnight(NOW, 'UTC').toISOString()).toBe('2026-09-16T00:00:00.000Z')
    })

    it('guard: NM(Asia/Shanghai) <= due_at < NM(UTC)', () => {
      const nmSh = viewerNextMidnight(NOW, 'Asia/Shanghai').getTime()
      const nmUtc = viewerNextMidnight(NOW, 'UTC').getTime()
      expect(nmSh <= DUE_AT.getTime()).toBe(true)
      expect(DUE_AT.getTime() < nmUtc).toBe(true)
    })

    it('viewerToday(Asia/Shanghai) and viewerToday(UTC) are both 2026-09-15 for this fixture', () => {
      expect(viewerToday(NOW, 'Asia/Shanghai')).toBe('2026-09-15')
      expect(viewerToday(NOW, 'UTC')).toBe('2026-09-15')
    })
  })

  describe('gate 8 boundary six-cell grid', () => {
    // Rule 1 (scheduled overdue): due_at < now.
    it('rule 1: due_at=12:29:59Z is overdue (true) against now=12:30:00Z', () => {
      const task: TaskDueShape = {
        dueAt: new Date('2026-09-15T12:29:59.000Z'),
        dueDate: null,
        dueTime: '00:00',
        timeZone: TASK_TZ,
      }
      expect(isOverdue(task, NOW)).toBe(true)
    })

    it('rule 1: due_at=12:30:00Z is NOT overdue (false) against now=12:30:00Z', () => {
      const task: TaskDueShape = {
        dueAt: new Date('2026-09-15T12:30:00.000Z'),
        dueDate: null,
        dueTime: '00:00',
        timeZone: TASK_TZ,
      }
      expect(isOverdue(task, NOW)).toBe(false)
    })

    // Rule 2 (scheduled overdue_or_today): due_at < viewerNextMidnight(now, Asia/Shanghai)=16:00Z.
    it('rule 2: due_at=15:59:59Z is overdue-or-today (true) against NM=16:00Z', () => {
      const task: TaskDueShape = {
        dueAt: new Date('2026-09-15T15:59:59.000Z'),
        dueDate: null,
        dueTime: '00:00',
        timeZone: TASK_TZ,
      }
      expect(isOverdueOrToday(task, NOW, 'Asia/Shanghai')).toBe(true)
    })

    it('rule 2: due_at=16:00:00Z is NOT overdue-or-today (false) against NM=16:00Z', () => {
      const task: TaskDueShape = {
        dueAt: new Date('2026-09-15T16:00:00.000Z'),
        dueDate: null,
        dueTime: '00:00',
        timeZone: TASK_TZ,
      }
      expect(isOverdueOrToday(task, NOW, 'Asia/Shanghai')).toBe(false)
    })

    // Rule 3 (all-day): overdue = due_date < viewerToday; overdue_or_today = due_date <= viewerToday.
    it('rule 3: due_date=2026-09-14 is overdue AND overdue-or-today', () => {
      const task: TaskDueShape = { dueAt: null, dueDate: '2026-09-14', dueTime: null, timeZone: TASK_TZ }
      expect(isOverdue(task, NOW)).toBe(true)
      expect(isOverdueOrToday(task, NOW, 'Asia/Shanghai')).toBe(true)
    })

    it('rule 3: due_date=2026-09-15 is NOT overdue but IS overdue-or-today', () => {
      const task: TaskDueShape = { dueAt: null, dueDate: '2026-09-15', dueTime: null, timeZone: TASK_TZ }
      expect(isOverdue(task, NOW)).toBe(false)
      expect(isOverdueOrToday(task, NOW, 'Asia/Shanghai')).toBe(true)
    })

    it('rule 3: due_date=2026-09-16 is neither overdue nor overdue-or-today', () => {
      const task: TaskDueShape = { dueAt: null, dueDate: '2026-09-16', dueTime: null, timeZone: TASK_TZ }
      expect(isOverdue(task, NOW)).toBe(false)
      expect(isOverdueOrToday(task, NOW, 'Asia/Shanghai')).toBe(false)
    })
  })

  describe('resolveViewerTimeZone — positive/negative controls (甲/乙 + fallback), lock `:558`', () => {
    // The pinned gate-8 fixture task: due_at=18:00Z, Asia/Shanghai. Sits strictly between
    // NM(Asia/Shanghai)=16:00Z and NM(UTC)=next-day 00:00Z, so the "overdue-or-today" verdict
    // genuinely flips between the real (task-tz) fallback and a wrong UTC fallback.
    const fixtureTask: TaskDueShape = { dueAt: DUE_AT, dueDate: null, dueTime: '00:00', timeZone: TASK_TZ }
    const explicitPredicate = isOverdueOrToday(fixtureTask, NOW, 'Asia/Shanghai')

    /**
     * 甲 = header 'Not/AZone' (invalid), 乙 = header missing. Each entry is true iff routing that
     * header through `resolve` reproduces the SAME predicate verdict as passing the task tz
     * explicitly — i.e. the fallback actually landed on the task's own zone.
     */
    function controls(resolve: (headerValue: unknown, taskTimeZone: string) => string): [boolean, boolean] {
      const jiaTz = resolve('Not/AZone', TASK_TZ)
      const yiTz = resolve(undefined, TASK_TZ)
      return [
        isOverdueOrToday(fixtureTask, NOW, jiaTz) === explicitPredicate,
        isOverdueOrToday(fixtureTask, NOW, yiTz) === explicitPredicate,
      ]
    }

    it('positive controls 甲/乙: the real resolver reproduces the explicit-tz predicate byte-for-byte for both an invalid and a missing header', () => {
      expect(controls(resolveViewerTimeZone)).toEqual([true, true])
    })

    it('mutation probe: a fallback hard-coded to UTC reds BOTH gate-8 boundary cells (lock `:558` "负控:fallback 改 \'UTC\' 后两格必红")', () => {
      // Locally re-declared mutant — SAME signature and SAME validity check as the source; the only
      // change is the fallback literal ('UTC' instead of the task's own timeZone). Not the source
      // function.
      const mutantResolveViewerTimeZone = (headerValue: unknown, _taskTimeZone: string): string => {
        if (typeof headerValue === 'string') {
          const trimmed = headerValue.trim()
          if (trimmed.length > 0 && isValidIanaTimeZone(trimmed)) return trimmed
        }
        return 'UTC'
      }
      expect(controls(mutantResolveViewerTimeZone)).toEqual([false, false])
    })

    it('an explicit valid header value wins over the task tz', () => {
      expect(resolveViewerTimeZone('America/New_York', TASK_TZ)).toBe('America/New_York')
    })

    it('an invalid IANA zone written explicitly (not via header) is rejected by resolveViewerTimeZone the same way', () => {
      expect(resolveViewerTimeZone('bogus-zone', TASK_TZ)).toBe(TASK_TZ)
    })
  })

  describe('门 5 — computeDueAt cross-timezone byte identity (all-day due_at never depends on viewer tz)', () => {
    const ALL_DAY_TASK = { dueDate: '2026-09-15', dueTime: null, timeZone: 'Asia/Shanghai' } as const

    it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago'] as const)(
      'viewer tz %s is itself a valid IANA zone (sanity, not a task-tz substitute)',
      (viewerTz) => {
        expect(resolveViewerTimeZone(viewerTz, 'Asia/Shanghai')).toBe(viewerTz)
      },
    )

    it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago'] as const)(
      'the SAME all-day Asia/Shanghai task computes a BYTE-IDENTICAL due_at whether the viewer is at %s or any other zone',
      (viewerTz) => {
        // computeDueAt takes no viewer-tz parameter at all: `viewerTz` here is deliberately unused
        // by the call below, which is the whole point — the +14/-11 extremes cannot reach in.
        void viewerTz
        expect(computeDueAt(ALL_DAY_TASK).toISOString()).toBe('2026-09-15T15:59:59.999Z')
      },
    )
  })

  describe('computeDueAt has no viewer-tz parameter (contrast with 门 5, not part of its evidence)', () => {
    it('passing Kiritimati/Pago_Pago as the TASK tz (not a viewer tz) correctly changes the task, and the two differ from each other', () => {
      const asKiritimatiTask = computeDueAt({
        dueDate: '2026-09-15',
        dueTime: null,
        timeZone: 'Pacific/Kiritimati',
      }).toISOString()
      const asPagoPagoTask = computeDueAt({
        dueDate: '2026-09-15',
        dueTime: null,
        timeZone: 'Pacific/Pago_Pago',
      }).toISOString()
      expect(asKiritimatiTask).toBe('2026-09-15T09:59:59.999Z')
      expect(asPagoPagoTask).toBe('2026-09-16T10:59:59.999Z')
      expect(asKiritimatiTask).not.toBe(asPagoPagoTask)
    })
  })

  describe('computeDueAt — scheduled vs all-day', () => {
    it('all-day: dueDate at local 23:59:59.999 in the task tz', () => {
      expect(computeDueAt({ dueDate: '2026-09-15', dueTime: null, timeZone: 'Asia/Shanghai' }).toISOString()).toBe(
        '2026-09-15T15:59:59.999Z',
      )
    })

    it('scheduled: (dueDate, dueTime) instant in the task tz', () => {
      expect(
        computeDueAt({ dueDate: '2026-09-15', dueTime: '10:00', timeZone: 'Asia/Shanghai' }).toISOString(),
      ).toBe('2026-09-15T02:00:00.000Z')
    })

    it('scheduled: HH:MM:SS form is accepted', () => {
      expect(
        computeDueAt({ dueDate: '2026-09-15', dueTime: '10:00:30', timeZone: 'Asia/Shanghai' }).toISOString(),
      ).toBe('2026-09-15T02:00:30.000Z')
    })

    it('rejects a malformed dueDate', () => {
      expect(() => computeDueAt({ dueDate: '2026/09/15', dueTime: null, timeZone: 'UTC' })).toThrow()
    })

    it('rejects a malformed dueTime', () => {
      expect(() => computeDueAt({ dueDate: '2026-09-15', dueTime: '10am', timeZone: 'UTC' })).toThrow()
    })
  })

  describe('DST boundaries — America/New_York — viewerNextMidnight (not just computeDueAt)', () => {
    // `now` rows straddling both 2026 DST edges, and their pinned NM(America/New_York) — verified
    // against `taskb-r1/oracle_dates.py`'s independent Python zoneinfo computation.
    const NOW_TO_NM: Array<[string, string]> = [
      ['2026-03-08T06:00:00.000Z', '2026-03-09T04:00:00.000Z'],
      ['2026-03-08T12:00:00.000Z', '2026-03-09T04:00:00.000Z'],
      ['2026-11-01T05:00:00.000Z', '2026-11-02T05:00:00.000Z'],
      ['2026-11-01T05:30:00.000Z', '2026-11-02T05:00:00.000Z'],
      ['2026-11-01T06:30:00.000Z', '2026-11-02T05:00:00.000Z'],
      ['2026-11-01T12:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ]

    it.each(NOW_TO_NM)('viewerNextMidnight(%s, America/New_York) = %s', (nowIso, expectedNmIso) => {
      expect(viewerNextMidnight(new Date(nowIso), 'America/New_York').toISOString()).toBe(expectedNmIso)
    })

    it('mutation probe: freezing the DST offset AT "now" (instead of re-probing it at the target midnight) reds two of the six cells above', () => {
      // Locally re-declared mutant — computes the UTC offset ONCE at `now` and reuses it for the
      // next-midnight instant, instead of re-probing the offset at the target local midnight (which
      // may sit on the OTHER side of a DST transition from `now`). Not the source function.
      function offsetMinutesAt(utcMs: number, timeZone: string): number {
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
        const parts = fmt.formatToParts(utcMs)
        const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
        let hour = get('hour')
        if (hour === 24) hour = 0
        const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
        return (asUtc - utcMs) / 60000
      }
      function mutantViewerNextMidnight(now: Date, viewerTz: string): Date {
        const offset = offsetMinutesAt(now.getTime(), viewerTz) // frozen here — the bug
        const localNow = new Date(now.getTime() + offset * 60000)
        const nextLocalMidnightNaive = Date.UTC(
          localNow.getUTCFullYear(),
          localNow.getUTCMonth(),
          localNow.getUTCDate() + 1,
          0,
          0,
          0,
          0,
        )
        return new Date(nextLocalMidnightNaive - offset * 60000)
      }

      // Row 1 (spring-forward: `now` is EST-side, the target midnight is EDT-side) diverges.
      const real1 = viewerNextMidnight(new Date('2026-03-08T06:00:00.000Z'), 'America/New_York')
      const mutant1 = mutantViewerNextMidnight(new Date('2026-03-08T06:00:00.000Z'), 'America/New_York')
      expect(mutant1.toISOString()).not.toBe(real1.toISOString())
      expect(real1.toISOString()).toBe('2026-03-09T04:00:00.000Z')
      expect(mutant1.toISOString()).toBe('2026-03-09T05:00:00.000Z')

      // Row 3 (fall-back: `now` is EDT-side, the target midnight is EST-side) diverges the other way.
      const real2 = viewerNextMidnight(new Date('2026-11-01T05:00:00.000Z'), 'America/New_York')
      const mutant2 = mutantViewerNextMidnight(new Date('2026-11-01T05:00:00.000Z'), 'America/New_York')
      expect(mutant2.toISOString()).not.toBe(real2.toISOString())
      expect(real2.toISOString()).toBe('2026-11-02T05:00:00.000Z')
      expect(mutant2.toISOString()).toBe('2026-11-02T04:00:00.000Z')
    })
  })

  describe('DST boundaries — Asia/Beirut (EAST-of-UTC spring-forward gap)', () => {
    // 2026-03-29 00:00 local is inside Beirut's skipped hour (clocks jump 00:00 -> 01:00). This is
    // the case a naive single-pass guess+correct gets WRONG for an east-of-UTC zone (see the
    // task-dates.ts module docblock, correction 2) — verified against
    // `taskb-r1/oracle_dates.py`'s independent zoneinfo computation.
    it('viewerNextMidnight lands on the post-transition instant, not an hour early', () => {
      expect(viewerNextMidnight(new Date('2026-03-28T12:00:00.000Z'), 'Asia/Beirut').toISOString()).toBe(
        '2026-03-28T22:00:00.000Z',
      )
    })

    it('computeDueAt for a scheduled 00:00 due time on the skipped day resolves the same way', () => {
      expect(
        computeDueAt({ dueDate: '2026-03-29', dueTime: '00:00', timeZone: 'Asia/Beirut' }).toISOString(),
      ).toBe('2026-03-28T22:00:00.000Z')
    })
  })

  describe('DST boundaries — America/New_York', () => {
    it('spring-forward gap: 2026-03-08 02:30 local (inside the skipped hour) resolves to the post-transition instant', () => {
      expect(
        computeDueAt({ dueDate: '2026-03-08', dueTime: '02:30', timeZone: 'America/New_York' }).toISOString(),
      ).toBe('2026-03-08T07:30:00.000Z')
    })

    // PINNED VALUE CHANGED (P2 finding, task-dates.ts §"correction 3"): the old two-probe
    // resolution was SIGN-DEPENDENT — for this WEST-of-UTC zone it happened to return the EARLIER
    // of the two valid instants (05:30Z) by probe-order accident, not by any stated rule. PG's own
    // `AT TIME ZONE` (the lock's SQL) deterministically returns the LATER instant for a fall-back
    // overlap; this module now matches that unconditionally (see the Europe/Berlin cell right below,
    // an EAST-of-UTC zone, for the same rule applied from the other side).
    it('fall-back overlap: 2026-11-01 01:30 local (occurs twice) resolves to the LATER of the two valid UTC instants (PG\'s rule)', () => {
      expect(
        computeDueAt({ dueDate: '2026-11-01', dueTime: '01:30', timeZone: 'America/New_York' }).toISOString(),
      ).toBe('2026-11-01T06:30:00.000Z')
    })

    it('is deterministic across repeated calls at both DST edges (no hidden clock/state)', () => {
      const gap1 = computeDueAt({ dueDate: '2026-03-08', dueTime: '02:30', timeZone: 'America/New_York' })
      const gap2 = computeDueAt({ dueDate: '2026-03-08', dueTime: '02:30', timeZone: 'America/New_York' })
      expect(gap1.toISOString()).toBe(gap2.toISOString())
      const fold1 = computeDueAt({ dueDate: '2026-11-01', dueTime: '01:30', timeZone: 'America/New_York' })
      const fold2 = computeDueAt({ dueDate: '2026-11-01', dueTime: '01:30', timeZone: 'America/New_York' })
      expect(fold1.toISOString()).toBe(fold2.toISOString())
    })
  })

  // -----------------------------------------------------------------------------------------------
  // DST fold regression cells (P2 finding "correction 3"): the OLD two-probe resolution was
  // SIGN-DEPENDENT — for a WEST-of-UTC zone's fall-back overlap it returned the EARLIER instant by
  // probe-order accident; for an EAST-of-UTC zone (Europe/Berlin) it happened to already return the
  // LATER one, matching PG. These cells were independently verified against `Intl.DateTimeFormat`
  // round-trip checks for each zone (see the finding evidence) — live-PG parity is M2 work.
  // -----------------------------------------------------------------------------------------------
  describe('DST fold — WEST-of-UTC zones now match PG\'s "later instant" rule (previously sign-flipped)', () => {
    it('America/Havana: viewerNextMidnight at an overlap resolves to the LATER instant', () => {
      // now = 2026-10-31T12:00Z; target midnight = 2026-11-01T00:00 local Havana, which is an
      // ambiguous fall-back overlap (both 04:00Z and 05:00Z round-trip to that exact civil time).
      expect(viewerNextMidnight(new Date('2026-10-31T12:00:00.000Z'), 'America/Havana').toISOString()).toBe(
        '2026-11-01T05:00:00.000Z',
      )
    })

    it('America/Havana rule-2 counterexample: due_at strictly between the two overlap candidates is now overdue-or-today', () => {
      // Before the fix, viewerNextMidnight(Havana) returned the EARLIER candidate (04:00Z), so a
      // due_at of 04:30Z was NOT "overdue or today". PG's later-instant rule (05:00Z) makes it true.
      const task: TaskDueShape = {
        dueAt: new Date('2026-11-01T04:30:00.000Z'),
        dueDate: null,
        dueTime: '00:00',
        timeZone: 'America/Havana',
      }
      expect(isOverdueOrToday(task, new Date('2026-10-31T20:00:00.000Z'), 'America/Havana')).toBe(true)
    })

    it('Atlantic/Azores: viewerNextMidnight at an overlap resolves to the LATER instant', () => {
      // now = 2026-10-24T12:00Z is daytime on 2026-10-24 in Azores (offset 0 that day) — confirm the
      // target day first, then check the overlap resolution for the midnight that begins the next.
      const now = new Date('2026-10-24T12:00:00.000Z')
      expect(viewerToday(now, 'Atlantic/Azores')).toBe('2026-10-24')
      expect(viewerNextMidnight(now, 'Atlantic/Azores').toISOString()).toBe('2026-10-25T01:00:00.000Z')
    })

    it('America/Santiago: an all-day computeDueAt at an overlap resolves to the LATER instant', () => {
      // 2026-04-04 23:59:59.999 local Santiago occurs twice (02:59:59.999Z and 03:59:59.999Z UTC).
      expect(
        computeDueAt({ dueDate: '2026-04-04', dueTime: null, timeZone: 'America/Santiago' }).toISOString(),
      ).toBe('2026-04-05T03:59:59.999Z')
    })
  })

  describe('DST fold — Europe/Berlin (EAST-of-UTC; already matched the later-instant rule before this fix)', () => {
    it('a scheduled computeDueAt at an overlap resolves to the LATER instant', () => {
      // 2026-10-25 02:30 local Berlin occurs twice (00:30Z and 01:30Z UTC).
      expect(
        computeDueAt({ dueDate: '2026-10-25', dueTime: '02:30', timeZone: 'Europe/Berlin' }).toISOString(),
      ).toBe('2026-10-25T01:30:00.000Z')
    })
  })

  // -----------------------------------------------------------------------------------------------
  // P2 finding "isOverdue cannot honour the viewer tz" — literal cells reproducing the finding's own
  // counterexamples, now that `isOverdue` takes an optional third `viewerTz` parameter.
  // -----------------------------------------------------------------------------------------------
  describe('isOverdue — viewer-tz parameter (P2 finding regression cells)', () => {
    it('all-day 09-15 Shanghai task, viewer America/Los_Angeles, now 17:00Z: overdue = false', () => {
      const task: TaskDueShape = { dueAt: null, dueDate: '2026-09-15', dueTime: null, timeZone: 'Asia/Shanghai' }
      expect(isOverdue(task, new Date('2026-09-15T17:00:00.000Z'), 'America/Los_Angeles')).toBe(false)
    })

    it('all-day 09-16 Shanghai task, viewer UTC, gate-8 now: overdue_or_today = false (TS already agreed with PG here)', () => {
      const task: TaskDueShape = { dueAt: null, dueDate: '2026-09-16', dueTime: null, timeZone: 'Asia/Shanghai' }
      expect(isOverdueOrToday(task, NOW, 'UTC')).toBe(false)
    })

    it('all-day 09-15 Kiritimati task, viewer Pacific/Pago_Pago, now 10:30Z: overdue = false AND overdue_or_today = false', () => {
      // Before the fix, `isOverdue` defaulted to the TASK's own tz (Kiritimati, +14) as the implicit
      // viewer, giving overdue=true — breaking `isOverdue ⇒ isOverdueOrToday` against the (already
      // viewer-tz-aware) `isOverdueOrToday`, which correctly said false. Passing the real viewer tz
      // now makes both agree, matching PG/lock rule 3.
      const task: TaskDueShape = {
        dueAt: null,
        dueDate: '2026-09-15',
        dueTime: null,
        timeZone: 'Pacific/Kiritimati',
      }
      const now = new Date('2026-09-15T10:30:00.000Z')
      expect(isOverdue(task, now, 'Pacific/Pago_Pago')).toBe(false)
      expect(isOverdueOrToday(task, now, 'Pacific/Pago_Pago')).toBe(false)
    })

    it('property: isOverdue(task, now, viewerTz) ⇒ isOverdueOrToday(task, now, viewerTz) over a small zone × date × now grid', () => {
      const zones = ['Asia/Shanghai', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']
      const dueDates = ['2026-09-14', '2026-09-15', '2026-09-16']
      const nows = [
        new Date('2026-09-15T00:30:00.000Z'),
        new Date('2026-09-15T12:30:00.000Z'),
        new Date('2026-09-15T23:30:00.000Z'),
      ]
      let checked = 0
      for (const dueDate of dueDates) {
        for (const taskTz of zones) {
          for (const viewerTz of zones) {
            for (const now of nows) {
              const task: TaskDueShape = { dueAt: null, dueDate, dueTime: null, timeZone: taskTz }
              if (isOverdue(task, now, viewerTz)) {
                expect(isOverdueOrToday(task, now, viewerTz)).toBe(true)
              }
              checked += 1
            }
          }
        }
      }
      expect(checked).toBe(dueDates.length * zones.length * zones.length * nows.length)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // P2 finding "viewer-tz resolver forwards caller-supplied spellings verbatim" — offset-form
  // rejection + canonicalization. Full class-level detail and the cache-growth reproduction stay in
  // the scratchpad per the finding's own [SECURITY-SENSITIVE] note; these are the closing checks.
  // -----------------------------------------------------------------------------------------------
  describe('validateViewerTimeZoneHeader — offset-form rejection + canonicalization', () => {
    it('rejects a bare UTC-offset string even though Intl accepts it as a `timeZone` without throwing', () => {
      expect(validateViewerTimeZoneHeader('+05:30')).toBeNull()
      expect(validateViewerTimeZoneHeader('-08:00')).toBeNull()
      expect(validateViewerTimeZoneHeader('+5')).toBeNull()
      expect(validateViewerTimeZoneHeader('Z')).toBeNull()
    })

    it('accepts a real named zone that happens to encode an offset in its own name (not a bare offset form)', () => {
      expect(validateViewerTimeZoneHeader('Etc/GMT+5')).toBe('Etc/GMT+5')
    })

    it('a bare-offset header still falls back to the task tz through resolveViewerTimeZone', () => {
      expect(resolveViewerTimeZone('+05:30', 'Asia/Shanghai')).toBe('Asia/Shanghai')
    })

    it('canonicalizes a non-canonical spelling of a valid zone', () => {
      expect(validateViewerTimeZoneHeader('US/Eastern')).toBe('America/New_York')
    })

    it('accepts UTC itself', () => {
      expect(validateViewerTimeZoneHeader('UTC')).toBe('UTC')
    })

    it('rejects missing/blank/invalid headers, same as before', () => {
      expect(validateViewerTimeZoneHeader(undefined)).toBeNull()
      expect(validateViewerTimeZoneHeader('')).toBeNull()
      expect(validateViewerTimeZoneHeader('   ')).toBeNull()
      expect(validateViewerTimeZoneHeader('Not/AZone')).toBeNull()
    })
  })

  describe('writes with an illegal IANA time_zone', () => {
    it('computeDueAt throws for an unknown IANA zone rather than silently guessing an offset', () => {
      expect(() => computeDueAt({ dueDate: '2026-09-15', dueTime: null, timeZone: 'Not/AZone' })).toThrow()
    })
  })
})
