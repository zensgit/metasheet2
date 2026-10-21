/**
 * Out-of-process TZ probe for the date-only rendering fix (GATE-5047 P2-1).
 *
 * Why out-of-process: mutating `process.env.TZ` mid-test does not reliably re-derive
 * Node/ICU's resolved timezone inside an already-running worker (verified empirically —
 * see attendance-date-only-format.spec.ts's own note). Setting `TZ` on a freshly spawned
 * process's environment DOES work — Node reads it once at startup — so this script is
 * meant to be run as its own process (via `tsx`, spawned with an explicit `env.TZ`), not
 * imported into a running vitest worker.
 *
 * Prints one JSON line to stdout: the environment TZ actually observed by this process,
 * plus BOTH the fixed module's output (`formatCalendarDate`, the NEW path) and the OLD
 * buggy behaviour it replaced (`new Date(value).toLocaleDateString(locale)`, computed
 * independently here — not by calling into the module — so the negative control does not
 * depend on the module under test at all).
 */
import { formatCalendarDate } from '../../src/views/attendance/dateOnlyFormat'

const INPUT = process.argv[2] || '2026-08-19'
const LOCALE = 'en-US'

const newPathResult = formatCalendarDate(INPUT, LOCALE)
const oldPathResult = new Date(INPUT).toLocaleDateString(LOCALE)
const [year, month, day] = INPUT.split('-').map(Number)

process.stdout.write(
  JSON.stringify({
    tzEnv: process.env.TZ ?? null,
    resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: new Date(year, month - 1, day).getTimezoneOffset(),
    input: INPUT,
    expectedLabel: `${month}/${day}/${year}`,
    newPathResult,
    oldPathResult,
  }),
)
