import { createRequire } from 'node:module'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCoreBackendRepoRoot } from '../../src/util/resolve-plugin-attendance-lib'

/**
 * W6-R4 — the fixed-schedule producer key has exactly ONE implementation.
 *
 * Before the rebuild there were two: the canonical one inside
 * `plugins/plugin-attendance/index.cjs` (injected into the plugin's own FSER
 * instance) and a REIMPLEMENTATION in `packages/core-backend/src/attendance/`
 * (injected into the FSER instance the `/effective-policy` route builds). The
 * producer key is FSER's join key for deciding which managed rows are "ours"
 * versus `differentKeyRows`, so two implementations means two derivations with
 * an unenforced equivalence argument between them.
 *
 * They genuinely disagreed on 3 of the 6 probe inputs below — the copy joined
 * the raw `endDate` with only `?? 'null'` while the canonical one normalised
 * first. The disagreement was not reachable through today's producer (pg hands
 * back a JS `Date` for `date` columns, so FSER's `formatDateOnly` always emits
 * canonical `YYYY-MM-DD`), and NOTHING in the tree enforced that: the only
 * guard was a pinned-literal test comparing the copy against a hand-typed
 * string, never against the canonical function.
 *
 * The copy is deleted. This suite proves the remaining single source really is
 * single, over a table that INCLUDES the three formerly-divergent inputs.
 */

const repoRoot = resolveCoreBackendRepoRoot(__dirname)
const req = createRequire(path.join(repoRoot, 'noop.cjs'))

type ProducerKeyInput = { groupId: string; shiftId: string; startDate: string; endDate: string | null }
type ProducerKeyLib = {
  buildAttendanceGroupFixedScheduleProducerKey: (input: ProducerKeyInput) => string
  normalizeDateOnly: (value: unknown) => string | null
}

const producerKeyLib = req(
  path.join(repoRoot, 'plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs'),
) as ProducerKeyLib

const pluginEntry = req(path.join(repoRoot, 'plugins/plugin-attendance/index.cjs')) as {
  __attendanceGroupFixedScheduleForTests: {
    buildAttendanceGroupFixedScheduleProducerKey: (input: ProducerKeyInput) => string
    normalizeDateOnly: (value: unknown) => string | null
  }
}

const GROUP = 'a4556006-000b-4000-8000-000000000001'
const SHIFT = 'a4556006-000b-4000-8000-000000000101'

/** The three inputs on which the deleted copy and the canonical builder
 * DISAGREED, plus the three on which they agreed. Divergence-by-construction:
 * if the two sides were ever allowed to drift again, at least three of these
 * rows would differ. */
const INPUT_TABLE: ReadonlyArray<{ label: string; endDate: string | null }> = [
  { label: 'canonical YYYY-MM-DD (agreed before)', endDate: '2026-08-31' },
  { label: 'null (agreed before)', endDate: null },
  { label: 'not-a-date (agreed before)', endDate: 'not-a-date' },
  { label: 'empty string (DIVERGED: copy emitted a trailing empty field)', endDate: '' },
  { label: 'unpadded 2026-8-1 (DIVERGED: copy skipped padding)', endDate: '2026-8-1' },
  { label: 'full ISO timestamp (DIVERGED: copy kept the time part)', endDate: '2026-08-31T00:00:00.000Z' },
]

describe('W6-R4 producer key — single source across the plugin and the backend route', () => {
  it("plugins/plugin-attendance/index.cjs produces byte-identical keys to the lib module on EVERY input, including the three that used to diverge", () => {
    const canonical = pluginEntry.__attendanceGroupFixedScheduleForTests.buildAttendanceGroupFixedScheduleProducerKey
    // Non-vacuity: both sides must actually be callable functions.
    expect(typeof canonical).toBe('function')
    expect(typeof producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey).toBe('function')

    for (const { label, endDate } of INPUT_TABLE) {
      const input: ProducerKeyInput = { groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate }
      expect(producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey(input), label).toBe(canonical(input))
    }
  })

  it('the three formerly-divergent inputs really do normalise (so the table above is discriminating, not decorative)', () => {
    const build = producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey
    const prefix = `attendance_group_fixed_schedule:${GROUP}:${SHIFT}:2026-08-01:`
    expect(build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '' })).toBe(`${prefix}null`)
    expect(build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '2026-8-1' })).toBe(`${prefix}2026-08-01`)
    expect(
      build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '2026-08-31T00:00:00.000Z' }),
    ).toBe(`${prefix}2026-08-31`)
    // The unnormalised join the deleted copy performed would have produced
    // these instead — asserted as NEGATIVES so a regression to it reds here.
    expect(build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '' })).not.toBe(`${prefix}`)
    expect(build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '2026-8-1' })).not.toBe(`${prefix}2026-8-1`)
  })

  it("the lib's date normaliser and index.cjs's general-purpose normalizeDateOnly agree (the one body this module had to carry)", () => {
    // SCOPE, stated narrowly: what is single-source is the PRODUCER-KEY PATH.
    // `index.cjs` keeps its own `normalizeDateOnly` for ~160 other call sites,
    // so the lib carries the same normalisation. That is a real duplication —
    // closed here by execution rather than by a comment claiming parity.
    const canonicalNormalize = pluginEntry.__attendanceGroupFixedScheduleForTests.normalizeDateOnly
    expect(typeof canonicalNormalize).toBe('function')
    const values: unknown[] = [
      null,
      undefined,
      '',
      '   ',
      '2026-08-31',
      '2026-8-1',
      '26-8-1',
      '2026-08-31T12:34:56.000Z',
      '2026-08-31 12:34:56',
      'not-a-date',
      '1767225600',
      '1767225600000',
      new Date(Date.UTC(2026, 7, 31, 12, 0, 0)),
    ]
    for (const value of values) {
      expect(producerKeyLib.normalizeDateOnly(value), String(value)).toEqual(canonicalNormalize(value))
    }
    // Non-vacuity: the table must contain at least one value where the
    // normaliser actually CHANGES its input, or "they agree" proves nothing.
    expect(producerKeyLib.normalizeDateOnly('2026-8-1')).toBe('2026-08-01')
  })

  it('the backend route injects the LIB builder into its FSER instance (not a locally defined function)', () => {
    // A source-level assertion deliberately paired with the behavioural ones
    // above: it is what catches a future re-introduction of a local copy at
    // the injection seam, which byte-equality of two libs cannot see.
    const routeSource = req('node:fs').readFileSync(
      path.join(repoRoot, 'packages/core-backend/src/routes/attendance-admin.ts'),
      'utf8',
    ) as string
    expect(routeSource).toContain(
      'buildAttendanceGroupFixedScheduleProducerKey:\n      attendanceGroupFixedScheduleProducerKeyLib.buildAttendanceGroupFixedScheduleProducerKey',
    )
    // And the aggregate module must hold NO producer-key implementation. The
    // needle is the PRODUCER-TYPE LITERAL a re-introduced copy would have to
    // join in — `attendance_group_fixed_schedule` followed by a quote or a
    // join separator, not the `attendance_group_fixed_schedule_configs` TABLE
    // NAME the module legitimately reads.
    const aggregateSource = req('node:fs').readFileSync(
      path.join(repoRoot, 'packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts'),
      'utf8',
    ) as string
    expect(aggregateSource).not.toMatch(/['"`]attendance_group_fixed_schedule['"`:]/)
    // Positive control on that regex: it DOES match the canonical literal.
    expect("['attendance_group_fixed_schedule', input.groupId].join(':')").toMatch(
      /['"`]attendance_group_fixed_schedule['"`:]/,
    )
  })
})
