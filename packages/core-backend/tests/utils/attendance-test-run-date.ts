// Date-matrix run day for the attendance real-DB timezone batch (#6721 verification).
//
// ATTENDANCE_TEST_RUN_DATE=YYYY-MM-DD moves only the run day that a test derives for
// the injectable attendance clocks (the trusted online-punch clock and the
// business-trip instant). It keeps the real UTC time of day, so it is a whole-day
// shift. The process clock, JWT issue/expiry, the network and the database clock stay
// real: nothing here fakes Date or touches the plugin's clock fallbacks.
// Unset or empty: the real current instant, exactly as `new Date()`.
export const ATTENDANCE_TEST_RUN_DATE_ENV = 'ATTENDANCE_TEST_RUN_DATE'

const DAY_MS = 86_400_000

export function attendanceTestRunDateOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[ATTENDANCE_TEST_RUN_DATE_ENV]
  if (raw === undefined || raw === '') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('ATTENDANCE_TEST_RUN_DATE_INVALID')
  const midnight = Date.parse(raw + 'T00:00:00.000Z')
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== raw) {
    throw new Error('ATTENDANCE_TEST_RUN_DATE_INVALID')
  }
  return raw
}

export function attendanceTestRunNow(env: NodeJS.ProcessEnv = process.env, realNow: number = Date.now()): Date {
  const override = attendanceTestRunDateOverride(env)
  if (override === null) return new Date(realNow)
  return new Date(Date.parse(override + 'T00:00:00.000Z') + (((realNow % DAY_MS) + DAY_MS) % DAY_MS))
}
