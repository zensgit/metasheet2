import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const requireCjs = createRequire(import.meta.url)
type Evidence = Readonly<{ contains(candidate: unknown, instant: unknown): boolean | null }>
const {
  candidateSegmentSelectionKeyV1: selectionKey,
  createCanonicalSegmentWindowEvidenceV1: createEvidence,
} = requireCjs('../../../../plugins/plugin-attendance/lib/attendance-segment-window-selection.cjs') as {
  candidateSegmentSelectionKeyV1(candidate: unknown): string | null
  createCanonicalSegmentWindowEvidenceV1(entries: unknown, options?: unknown): Evidence | null
}

const workDate = '2026-10-27'
const at = (time: string, date = workDate) => new Date(date + 'T' + time + ':00.000Z')
const resolveInstant = (date: string, time: string, _timezone: string) => at(time, date)
function addDaysToDateKey(date: string, days: number) {
  const result = at('00:00', date)
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}
const dependencies = { resolveInstant, addDaysToDateKey }
function segment(index: number, startTime: string, endTime: string, endDayOffset = 0) {
  return { index, startTime, endTime, startDayOffset: 0, endDayOffset }
}
function entry(segments = [segment(0, '08:00', '09:00'), segment(1, '16:00', '17:00')]) {
  const first = segments[0]
  const last = segments[segments.length - 1]
  const candidate = {
    orgId: 'org-a', userId: 'user-a', workDate, source: 'shift',
    assignmentId: 'assignment-a', shiftId: 'shift-a', timezone: 'UTC',
    absoluteWindow: {
      startAt: at(first.startTime),
      endAt: at(last.endTime, addDaysToDateKey(workDate, last.endDayOffset)),
    },
  }
  const definition = {
    orgId: candidate.orgId, userId: candidate.userId, workDate,
    shiftId: candidate.shiftId, timezone: candidate.timezone, segments,
  }
  return { candidate, definition }
}

describe('candidateSegmentSelectionKeyV1', () => {
  it('uses primitive identity rather than object identity, property order or window values', () => {
    const { candidate } = entry()
    const copy = { ...candidate, absoluteWindow: { ...candidate.absoluteWindow }, ignored: true }
    expect(selectionKey(copy)).toBe(selectionKey(candidate))
    expect(selectionKey({ ...candidate, timezone: 'Asia/Taipei' })).toBe(selectionKey(candidate))
    expect(selectionKey(candidate)).toBe(JSON.stringify([
      'org-a', 'user-a', workDate, 'shift', 'assignment-a', 'shift-a',
    ]))
  })

  it.each([
    ['orgId', 'org-b'], ['userId', 'user-b'], ['workDate', '2026-10-28'],
    ['source', 'rotation'], ['assignmentId', 'assignment-b'], ['shiftId', 'shift-b'],
  ])('includes %s in the identity', (field, value) => {
    const { candidate } = entry()
    expect(selectionKey({ ...candidate, [field]: value })).not.toBe(selectionKey(candidate))
  })

  it('does not collide when identifiers contain separators', () => {
    const { candidate } = entry()
    expect(selectionKey({ ...candidate, orgId: 'a|b', userId: 'c' }))
      .not.toBe(selectionKey({ ...candidate, orgId: 'a', userId: 'b|c' }))
  })

  it.each([
    ['orgId', ''], ['userId', ' user-a'], ['assignmentId', 1], ['shiftId', {}],
    ['shiftId', null], ['source', 'unknown'], ['source', null],
    ['workDate', '2026-02-30'], ['workDate', '2026-13-01'], ['workDate', '2026-1-01'],
  ])('rejects invalid %s without coercing it', (field, value) => {
    expect(selectionKey({ ...entry().candidate, [field]: value })).toBeNull()
  })

  it('rejects missing identity and accepts a real leap date', () => {
    for (const value of [null, undefined, {}, [], 'candidate']) expect(selectionKey(value)).toBeNull()
    expect(selectionKey({ ...entry().candidate, workDate: '2028-02-29' })).not.toBeNull()
  })
})

describe('createCanonicalSegmentWindowEvidenceV1', () => {
  it('returns only a frozen contains surface, including for an empty candidate set', () => {
    const evidence = createEvidence([], dependencies)!
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(Reflect.ownKeys(evidence)).toEqual(['contains'])
    expect(evidence.contains(entry().candidate, at('08:00'))).toBeNull()
  })

  it.each([
    [null], [undefined], [{}], [[null]], [[{}]],
  ])('rejects malformed entries: %j', entries => {
    expect(createEvidence(entries, dependencies)).toBeNull()
  })

  it.each([undefined, null, {}, { resolveInstant }, { addDaysToDateKey }])(
    'requires both injected functions: %j', options => {
      expect(createEvidence([entry()], options)).toBeNull()
    },
  )

  it('accepts a frozen served definition without changing its envelope', () => {
    const original = entry()
    original.definition.segments.forEach(Object.freeze)
    Object.freeze(original.definition.segments)
    Object.freeze(original.definition)
    const start = original.candidate.absoluteWindow.startAt
    const end = original.candidate.absoluteWindow.endAt
    const evidence = createEvidence([original], dependencies)!
    expect(evidence.contains(original.candidate, at('08:00'))).toBe(true)
    expect(original.candidate.absoluteWindow).toEqual({ startAt: at('08:00'), endAt: at('17:00') })
    expect(original.candidate.absoluteWindow.startAt).toBe(start)
    expect(original.candidate.absoluteWindow.endAt).toBe(end)
  })

  it('rejects absent candidate or definition and one bad entry among good ones', () => {
    const good = entry()
    expect(createEvidence([{ ...good, candidate: null }], dependencies)).toBeNull()
    expect(createEvidence([{ ...good, definition: null }], dependencies)).toBeNull()
    expect(createEvidence([good, { candidate: { ...good.candidate, shiftId: 'shift-b' } }], dependencies))
      .toBeNull()
  })

  it.each(['orgId', 'userId', 'workDate', 'shiftId', 'timezone'])(
    'rejects a foreign or missing definition %s', field => {
      const original = entry()
      for (const value of ['foreign', undefined]) {
        expect(createEvidence([{
          ...original, definition: { ...original.definition, [field]: value },
        }], dependencies)).toBeNull()
      }
    },
  )

  it('rejects a duplicate key even for cloned candidates or conflicting definitions', () => {
    const original = entry()
    expect(createEvidence([original, {
      candidate: { ...original.candidate }, definition: { ...original.definition },
    }], dependencies)).toBeNull()
    expect(createEvidence([original, entry([segment(0, '10:00', '11:00')])], dependencies)).toBeNull()
  })

  it.each([
    {}, { startAt: at('08:00') }, { startAt: '2026-10-27T08:00:00Z', endAt: at('17:00') },
    { startAt: new Date(NaN), endAt: at('17:00') },
    { startAt: at('08:00'), endAt: new Date(NaN) },
    { startAt: at('08:00'), endAt: at('08:00') },
    { startAt: at('17:00'), endAt: at('08:00') },
    { startAt: at('08:01'), endAt: at('17:00') },
    { startAt: at('08:00'), endAt: at('16:59') },
  ])('rejects invalid, overflowing or inconsistent full envelopes: %j', absoluteWindow => {
    const original = entry()
    expect(createEvidence([{
      ...original, candidate: { ...original.candidate, absoluteWindow },
    }], dependencies)).toBeNull()
  })

  it.each([
    { startAt: at('07:59'), endAt: at('17:00') },
    { startAt: at('08:00'), endAt: at('17:01') },
  ])('retains a containing full envelope without requiring planned endpoints to touch it: %j', absoluteWindow => {
    const original = entry()
    const candidate = { ...original.candidate, absoluteWindow }
    const evidence = createEvidence([{ ...original, candidate }], dependencies)
    expect(evidence).not.toBeNull()
    expect(evidence?.contains(candidate, at('08:00'))).toBe(true)
    expect(evidence?.contains(candidate, at('07:59'))).toBe(false)
    expect(evidence?.contains(candidate, at('17:00'))).toBe(true)
    expect(evidence?.contains(candidate, at('17:01'))).toBe(false)
  })

  it.each(['', ' UTC', 'No/Such_Zone', null])('rejects invalid timezone %j even when equal', timezone => {
    const original = entry()
    expect(createEvidence([{
      candidate: { ...original.candidate, timezone },
      definition: { ...original.definition, timezone },
    }], dependencies)).toBeNull()
  })

  it.each([
    [segment(0, '08:00', '17:00')],
    [segment(0, '08:00', '09:00'), segment(1, '16:00', '17:00')],
    [segment(0, '08:00', '09:00'), segment(1, '12:00', '13:00'), segment(2, '16:00', '17:00')],
  ])('accepts one through three contiguous segments: %j', (...segments) => {
    const original = entry(segments)
    const evidence = createEvidence([original], dependencies)!
    expect(evidence.contains(original.candidate, at('08:00'))).toBe(true)
    expect(evidence.contains(original.candidate, at('17:00'))).toBe(true)
  })

  it.each([
    [], [segment(0, '08:00', '09:00'), segment(2, '16:00', '17:00')],
    [segment(0, '08:00', '09:00'), segment(0, '16:00', '17:00')],
    [segment(0, '08:00', '09:00'), segment(1, '10:00', '11:00'),
      segment(2, '12:00', '13:00'), segment(3, '16:00', '17:00')],
    [segment(0, '08:00', '08:00')], [segment(0, '09:00', '08:00')],
    [segment(0, '08:00', '13:00'), segment(1, '12:00', '17:00')],
    [segment(0, '16:00', '17:00'), segment(1, '08:00', '09:00')],
    [segment(0, '22:00', '02:00', 1), segment(1, '23:00', '03:00', 1)],
  ])('rejects counts, indexes, nonpositive, overlapping or unordered segments: %j', (...segments) => {
    const original = entry()
    expect(createEvidence([{
      ...original, definition: { ...original.definition, segments },
    }], dependencies)).toBeNull()
  })

  it.each([
    ['index', '0'], ['startDayOffset', 1], ['startDayOffset', undefined],
    ['endDayOffset', 2], ['endDayOffset', '1'], ['endDayOffset', undefined],
    ['startTime', '8:00'], ['startTime', '24:00'], ['startTime', '08:60'],
    ['endTime', '17:00:00'], ['endTime', null],
  ])('rejects malformed segment %s', (field, value) => {
    const original = entry([segment(0, '08:00', '17:00')])
    expect(createEvidence([{
      ...original, definition: {
        ...original.definition, segments: [{ ...original.definition.segments[0], [field]: value }],
      },
    }], dependencies)).toBeNull()
  })

  it('uses actual segments, preserves gaps and adds no per-segment or post-shift tail', () => {
    const original = entry()
    const evidence = createEvidence([original], dependencies)!
    for (const time of ['07:59', '09:01', '10:00', '13:00', '15:59', '17:01', '19:00']) {
      expect(evidence.contains(original.candidate, at(time))).toBe(false)
    }
    for (const time of ['08:00', '09:00', '16:00', '17:00']) {
      expect(evidence.contains({ ...original.candidate }, at(time))).toBe(true)
    }
  })

  it('keeps the later slot as the sole containing candidate regardless of entry order', () => {
    const split = entry()
    const later = entry([segment(0, '13:00', '15:00')])
    later.candidate.assignmentId = 'assignment-b'
    later.candidate.shiftId = later.definition.shiftId = 'shift-b'
    for (const entries of [[split, later], [later, split]]) {
      const evidence = createEvidence(entries, dependencies)!
      expect(entries.filter(item => evidence.contains(item.candidate, at('13:00')) === true)
        .map(item => item.candidate.shiftId)).toEqual(['shift-b'])
    }
  })

  it('counts adjacent segments as one candidate and retains actual cross-candidate overlap', () => {
    const adjacent = entry([segment(0, '08:00', '12:00'), segment(1, '12:00', '17:00')])
    const other = entry([segment(0, '12:00', '13:00')])
    other.candidate.assignmentId = 'assignment-b'
    other.candidate.source = 'rotation'
    const evidence = createEvidence([adjacent, other], dependencies)!
    expect(evidence.contains(adjacent.candidate, at('12:00'))).toBe(true)
    expect([adjacent].filter(item => evidence.contains(item.candidate, at('12:00')) === true))
      .toHaveLength(1)
    expect([adjacent, other].filter(item => evidence.contains(item.candidate, at('12:00')) === true))
      .toHaveLength(2)
  })

  it('uses addDaysToDateKey only for an overnight end and includes both endpoints', () => {
    const original = entry([segment(0, '22:00', '02:00', 1)])
    const addDays = vi.fn(addDaysToDateKey)
    const converter = vi.fn(resolveInstant)
    const evidence = createEvidence([original], { resolveInstant: converter, addDaysToDateKey: addDays })!
    expect(addDays.mock.calls).toEqual([[workDate, 1]])
    expect(converter.mock.calls).toEqual([
      [workDate, '22:00', 'UTC'], ['2026-10-28', '02:00', 'UTC'],
    ])
    expect(evidence.contains(original.candidate, at('22:00'))).toBe(true)
    expect(evidence.contains(original.candidate, at('02:00', '2026-10-28'))).toBe(true)
    expect(evidence.contains(original.candidate, at('02:01', '2026-10-28'))).toBe(false)
    addDays.mockClear()
    createEvidence([entry()], { resolveInstant, addDaysToDateKey: addDays })
    expect(addDays.mock.calls).toEqual([])
  })

  it.each(['orgId', 'userId', 'workDate', 'source', 'assignmentId', 'shiftId'])(
    'returns null for a foreign %s and for invalid identity', field => {
      const original = entry()
      const evidence = createEvidence([original], dependencies)!
      const foreign = field === 'workDate' ? '2026-10-28' : field === 'source' ? 'rotation' : 'foreign'
      expect(evidence.contains({ ...original.candidate, [field]: foreign }, at('08:00'))).toBeNull()
      expect(evidence.contains({ ...original.candidate, [field]: null }, at('08:00'))).toBeNull()
    },
  )

  it('returns null for malformed instants, candidate windows or changed timezone', () => {
    const original = entry()
    const evidence = createEvidence([original], dependencies)!
    for (const instant of [null, undefined, new Date(NaN), '2026-10-27T08:00:00Z', 1793088000000]) {
      expect(evidence.contains(original.candidate, instant)).toBeNull()
    }
    for (const candidate of [null, {}, { ...original.candidate, timezone: 'Asia/Taipei' },
      { ...original.candidate, absoluteWindow: null },
      { ...original.candidate, absoluteWindow: { startAt: at('08:00'), endAt: at('18:00') } }]) {
      expect(evidence.contains(candidate, at('13:00'))).toBeNull()
    }
  })

  it('snapshots scope and primitive bounds without freezing or retaining source objects', () => {
    const original = entry()
    const copy = { ...original.candidate, absoluteWindow: {
      startAt: new Date(original.candidate.absoluteWindow.startAt.getTime()),
      endAt: new Date(original.candidate.absoluteWindow.endAt.getTime()),
    } }
    const entries = [original]
    const before = JSON.stringify(entries)
    const evidence = createEvidence(entries, dependencies)!
    expect(JSON.stringify(entries)).toBe(before)
    expect(Object.isFrozen(original.candidate)).toBe(false)
    original.candidate.orgId = 'foreign'
    original.candidate.timezone = 'Asia/Taipei'
    original.candidate.absoluteWindow.startAt.setTime(0)
    original.candidate.absoluteWindow.endAt.setTime(0)
    original.definition.orgId = 'foreign'
    original.definition.timezone = 'Asia/Taipei'
    original.definition.segments[0].endTime = '16:00'
    original.definition.segments.splice(1)
    entries.length = 0
    expect(evidence.contains(copy, at('08:00'))).toBe(true)
    expect(evidence.contains(copy, at('13:00'))).toBe(false)
    expect(evidence.contains(copy, at('17:00'))).toBe(true)
    expect(evidence.contains(original.candidate, at('08:00'))).toBeNull()
  })

  it('captures each converted bound even when the converter reuses a Date', () => {
    const original = entry()
    const shared = new Date(0)
    const evidence = createEvidence([original], {
      ...dependencies,
      resolveInstant(date: string, time: string, timezone: string) {
        shared.setTime(resolveInstant(date, time, timezone).getTime())
        return shared
      },
    })!
    shared.setTime(0)
    expect(evidence.contains(original.candidate, at('08:30'))).toBe(true)
    expect(evidence.contains(original.candidate, at('13:00'))).toBe(false)
  })

  it('returns null for invalid converter results and invalid or overflowing end dates', () => {
    for (const result of [null, '08:00', new Date(NaN)]) {
      expect(createEvidence([entry()], { ...dependencies, resolveInstant: () => result })).toBeNull()
    }
    for (const endDate of ['2026-02-30', '2026-10-29']) {
      expect(createEvidence([entry([segment(0, '22:00', '02:00', 1)])], {
        ...dependencies, addDaysToDateKey: () => endDate,
      })).toBeNull()
    }
  })

  it('propagates the exact strict conversion or source error without converting it to absence', () => {
    const failure = new Error('STRICT_WALL_TIME_REJECTED')
    const reject = () => { throw failure }
    for (const options of [
      { ...dependencies, resolveInstant: reject },
      { ...dependencies, addDaysToDateKey: reject },
    ]) {
      let caught: unknown
      try {
        createEvidence([entry([segment(0, '22:00', '02:00', 1)])], options)
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(failure)
    }
  })
})
