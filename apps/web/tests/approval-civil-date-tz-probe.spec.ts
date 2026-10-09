import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Test report 2026-10-08 T4a-E2, gate r1 P2-1: the host-timezone-independent guard for the civil-date
 * rendering that approval-detail-field.test.ts covers in-process.
 *
 * A `date` value (and each endpoint of a `date_range` with `dateType: 'date'`) is a floating civil
 * date, stored as the strict `YYYY-MM-DD` string. `formatCivilDate` (approvals/detailField.ts) renders
 * it as a UTC calendar day formatted in UTC, so every viewer sees the day that was entered. The web
 * lanes run on UTC hosts with no `TZ` set, and at offset 0 that rendering cannot fail in either
 * direction:
 *   - dropping `timeZone: 'UTC'` breaks only viewers WEST of UTC (they see the previous day);
 *   - building the day at LOCAL midnight breaks only viewers EAST of UTC (the previous day again —
 *     the tester's own zone).
 * Both regressions stayed green under `TZ=UTC` in the gate's mutation runs.
 *
 * So this spec spawns REAL child processes (tsx, tests/helpers/approvalCivilDateTzProbe.ts) with an
 * explicit `TZ` — Node reads it once at startup, which is the only reliable way to move the zone (see
 * attendance-date-only-format-tz-probe.spec.ts) — one zone on each side of UTC plus UTC itself. Each
 * run also reports a negative control computed independently of the module under test, proving the
 * probe really sees the defect in that zone rather than passing vacuously.
 */

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TESTS_DIR, '../../..')
const TSX_BIN = path.resolve(REPO_ROOT, 'node_modules/.bin/tsx')
const PROBE_SCRIPT = path.resolve(TESTS_DIR, 'helpers/approvalCivilDateTzProbe.ts')

// A tsx spawn can take a few seconds on a loaded runner; the spawn itself is bounded below.
const PROBE_TEST_TIMEOUT_MS = 60_000

interface Rendering {
  date: string
  range: string
}

interface ProbeResult {
  tzEnv: string | null
  resolvedTimeZone: string
  offsetMinutes: number
  expected: { zh: Rendering; en: Rendering }
  actual: { zh: Rendering; en: Rendering }
  negativeControls: { oldInstantPathEn: string; localMidnightReadInUtcEn: string }
}

function runProbe(tz: string): ProbeResult {
  // Bounded, as in the attendance probe (GATE-5047 P3-5): a hung tsx child must fail this required
  // lane fast instead of blocking it.
  const stdout = execFileSync(TSX_BIN, [PROBE_SCRIPT, '2026-10-08', '2026-10-09'], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    timeout: 50_000,
  })
  return JSON.parse(stdout) as ProbeResult
}

function expectEnteredDay(r: ProbeResult): void {
  // The expected labels carry no time of day and name the entered day in both shell locales.
  expect(r.expected.zh).toEqual({ date: '2026/10/8', range: '2026/10/8 ~ 2026/10/9' })
  expect(r.expected.en).toEqual({ date: '10/8/2026', range: '10/8/2026 ~ 10/9/2026' })
  expect(r.actual.zh).toEqual(r.expected.zh)
  expect(r.actual.en).toEqual(r.expected.en)
}

describe('approval civil dates (date, date_range dateType "date") — out-of-process host-timezone probe', () => {
  it('UTC (the CI host zone): the date field and both date_range endpoints show the entered day', () => {
    const r = runProbe('UTC')
    expect(r.resolvedTimeZone).toBe('UTC')
    expect(r.offsetMinutes).toBe(0)
    expectEnteredDay(r)
  }, PROBE_TEST_TIMEOUT_MS)

  it('WEST of UTC (America/New_York): still the entered day — and the old instant path, computed independently, shows the previous day there', () => {
    const r = runProbe('America/New_York')
    // A zone the ICU data does not know would fall back to UTC and pass vacuously.
    expect(r.resolvedTimeZone).toBe('America/New_York')
    expect(r.offsetMinutes).toBeGreaterThan(0)
    expectEnteredDay(r)
    // Negative control: the probe sees the west-of-UTC defect (a UTC-midnight reading of the string).
    expect(r.negativeControls.oldInstantPathEn).toBe('10/7/2026')
    expect(r.negativeControls.oldInstantPathEn).not.toBe(r.expected.en.date)
  }, PROBE_TEST_TIMEOUT_MS)

  it('EAST of UTC (Asia/Shanghai): still the entered day — and a local-midnight day read in UTC, computed independently, shows the previous day there', () => {
    const r = runProbe('Asia/Shanghai')
    expect(r.resolvedTimeZone).toBe('Asia/Shanghai')
    expect(r.offsetMinutes).toBeLessThan(0)
    expectEnteredDay(r)
    // Negative control: the probe sees the east-of-UTC defect (a calendar day built at local midnight).
    expect(r.negativeControls.localMidnightReadInUtcEn).toBe('10/7/2026')
    expect(r.negativeControls.localMidnightReadInUtcEn).not.toBe(r.expected.en.date)
  }, PROBE_TEST_TIMEOUT_MS)
})
