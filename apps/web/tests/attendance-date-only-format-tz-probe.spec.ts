import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * CI-discriminating companion to attendance-date-only-format.spec.ts (GATE-5047 P2-1).
 *
 * This repo's CI runs `vitest run` on UTC-hosted GitHub runners with no `TZ` env set
 * (`grep -n TZ` on both web-tests.yml and attendance-web-guard.yml finds nothing), and the
 * west-of-UTC UTC-midnight-parse bug is invisible at offset 0 — the buggy
 * `new Date('YYYY-MM-DD')` path and the fixed local-construction path produce the exact
 * same epoch there. A spec that only asserts TZ-invariant properties (true everywhere, by
 * construction) would therefore stay green even if the fix were silently reverted, as long
 * as CI keeps running at UTC.
 *
 * To make the guard discriminate regardless of the CI host's timezone, this spec spawns
 * REAL child processes (via `tsx`, see tests/helpers/dateOnlyTzProbe.ts) with an explicit
 * non-UTC `TZ` in their environment — Node reads `TZ` once at process startup, so setting
 * it at spawn time (unlike mutating `process.env.TZ` mid-test in an already-running
 * worker) reliably changes the resolved timezone. Each probe run reports BOTH the fixed
 * module's output and an INDEPENDENTLY computed old-path result (`new Date(value)
 * .toLocaleDateString()`, not routed through the module under test) — the negative control
 * that proves this probe methodology can actually see the bug.
 */

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TESTS_DIR, '../../..')
const TSX_BIN = path.resolve(REPO_ROOT, 'node_modules/.bin/tsx')
const PROBE_SCRIPT = path.resolve(TESTS_DIR, 'helpers/dateOnlyTzProbe.ts')

interface ProbeResult {
  tzEnv: string | null
  resolvedTimeZone: string
  offsetMinutes: number
  input: string
  expectedLabel: string
  newPathResult: string
  oldPathResult: string
}

function runProbe(tz: string, input = '2026-08-19'): ProbeResult {
  // GATE-5047 P3-5: bound the spawn — a hung tsx child (e.g. a broken install) would
  // otherwise block this required job indefinitely instead of failing fast.
  const stdout = execFileSync(TSX_BIN, [PROBE_SCRIPT, input], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return JSON.parse(stdout) as ProbeResult
}

describe('formatCalendarDate — out-of-process TZ probe', () => {
  it('renders the correct calendar date under UTC (the actual CI host timezone)', () => {
    const r = runProbe('UTC')
    expect(r.resolvedTimeZone).toBe('UTC')
    expect(r.offsetMinutes).toBe(0)
    expect(r.newPathResult).toBe(r.expectedLabel)
  })

  it('renders the correct calendar date under a west-of-UTC timezone — the exact regime the bug reproduces in', () => {
    const r = runProbe('America/Los_Angeles', '2026-08-19')
    expect(r.resolvedTimeZone).toBe('America/Los_Angeles')
    expect(r.offsetMinutes).toBeGreaterThan(0) // west of UTC: getTimezoneOffset() is positive
    expect(r.newPathResult).toBe(r.expectedLabel) // '8/19/2026' — the fix holds regardless of host TZ
  })

  it('negative control: the OLD un-fixed path (independently computed, not routed through the module) DOES diverge under the same west-of-UTC timezone — proving the probe can see the bug', () => {
    const r = runProbe('America/Los_Angeles', '2026-08-19')
    expect(r.oldPathResult).not.toBe(r.expectedLabel)
    expect(r.oldPathResult).not.toBe(r.newPathResult)
    expect(r.oldPathResult).toBe('8/18/2026') // the previous calendar day — the exact reported bug
  })

  it('renders the correct calendar date under a far east-of-UTC timezone too (no divergence in either path at a positive offset)', () => {
    const r = runProbe('Pacific/Kiritimati', '2026-08-19')
    expect(r.offsetMinutes).toBeLessThan(0) // east of UTC: getTimezoneOffset() is negative
    expect(r.newPathResult).toBe(r.expectedLabel)
    expect(r.oldPathResult).toBe(r.expectedLabel) // positive offsets never lose a day here
  })
})
