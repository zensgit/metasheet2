import { createRequire } from 'node:module'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCoreBackendRepoRoot } from '../../src/util/resolve-plugin-attendance-lib'

/**
 * W6-R4 — the fixed-schedule producer key has exactly one implementation.
 *
 * The producer key is FSER's join key for deciding which managed rows are
 * "ours" versus `differentKeyRows`. `plugins/plugin-attendance/index.cjs`
 * (the plugin's own FSER instance) and `packages/core-backend`'s
 * `/effective-policy` route (its own FSER instance) both inject the same
 * function from `plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs`,
 * so this suite proves the two call sites really do run identical code,
 * including on inputs where a naive reimplementation is most likely to
 * disagree (unpadded dates, empty strings, full ISO timestamps).
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

/** Inputs a normalising and a non-normalising implementation of the
 * producer key would disagree on, plus a few that any implementation
 * agrees on — kept in the same table so the suite is discriminating. */
const INPUT_TABLE: ReadonlyArray<{ label: string; endDate: string | null }> = [
  { label: 'canonical YYYY-MM-DD', endDate: '2026-08-31' },
  { label: 'null', endDate: null },
  { label: 'not-a-date', endDate: 'not-a-date' },
  { label: 'empty string', endDate: '' },
  { label: 'unpadded 2026-8-1', endDate: '2026-8-1' },
  { label: 'full ISO timestamp', endDate: '2026-08-31T00:00:00.000Z' },
]

describe('W6-R4 producer key — single source across the plugin and the backend route', () => {
  it('plugins/plugin-attendance/index.cjs produces byte-identical keys to the lib module on every input', () => {
    const canonical = pluginEntry.__attendanceGroupFixedScheduleForTests.buildAttendanceGroupFixedScheduleProducerKey
    // Non-vacuity: both sides must actually be callable functions.
    expect(typeof canonical).toBe('function')
    expect(typeof producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey).toBe('function')

    for (const { label, endDate } of INPUT_TABLE) {
      const input: ProducerKeyInput = { groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate }
      expect(producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey(input), label).toBe(canonical(input))
    }
  })

  it('the edge-case inputs really do normalise (so the table above is discriminating, not decorative)', () => {
    const build = producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey
    const prefix = `attendance_group_fixed_schedule:${GROUP}:${SHIFT}:2026-08-01:`
    expect(build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '' })).toBe(`${prefix}null`)
    expect(build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '2026-8-1' })).toBe(`${prefix}2026-08-01`)
    expect(
      build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '2026-08-31T00:00:00.000Z' }),
    ).toBe(`${prefix}2026-08-31`)
    // Negative controls: an unnormalised join would have produced these
    // instead, so a regression away from normalisation reds here.
    expect(build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '' })).not.toBe(`${prefix}`)
    expect(build({ groupId: GROUP, shiftId: SHIFT, startDate: '2026-08-01', endDate: '2026-8-1' })).not.toBe(`${prefix}2026-8-1`)
  })

  it("the lib's date normaliser and index.cjs's general-purpose normalizeDateOnly agree", () => {
    // Scope, stated narrowly: what is single-source is the producer-key path.
    // `index.cjs` keeps its own `normalizeDateOnly` for its other call sites,
    // so the lib carries an independent copy of the same normalisation —
    // proven equal here by execution, not by comment.
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
    // normaliser actually changes its input, or "they agree" proves nothing.
    expect(producerKeyLib.normalizeDateOnly('2026-8-1')).toBe('2026-08-01')
  })

  it('the backend route injects the lib builder into its FSER instance (not a locally defined function)', () => {
    // A source-level assertion paired with the behavioural ones above: it
    // catches a future local reimplementation at the injection seam, which
    // byte-equality of two libs cannot see.
    const routeSource = req('node:fs').readFileSync(
      path.join(repoRoot, 'packages/core-backend/src/routes/attendance-admin.ts'),
      'utf8',
    ) as string
    expect(routeSource).toContain(
      'buildAttendanceGroupFixedScheduleProducerKey:\n      attendanceGroupFixedScheduleProducerKeyLib.buildAttendanceGroupFixedScheduleProducerKey',
    )
    // And the aggregate module must hold no producer-key implementation. The
    // needle is the producer-type literal a reintroduced copy would have to
    // join in — `attendance_group_fixed_schedule` followed by a quote or a
    // join separator, not the `attendance_group_fixed_schedule_configs` table
    // name the module legitimately reads.
    const aggregateSource = req('node:fs').readFileSync(
      path.join(repoRoot, 'packages/core-backend/src/attendance/w6-group-effective-policy-aggregate.ts'),
      'utf8',
    ) as string
    expect(aggregateSource).not.toMatch(/['"`]attendance_group_fixed_schedule['"`:]/)
    // Positive control on that regex: it does match the canonical literal.
    expect("['attendance_group_fixed_schedule', input.groupId].join(':')").toMatch(
      /['"`]attendance_group_fixed_schedule['"`:]/,
    )
  })
})
