// Loaded only by vitest.attendance-date-matrix.config.ts, after setup.integration.ts
// (which sets NODE_ENV=test, required by both clock seams).
//
// Before each batch file runs, prove that the run day reaches the injectable clocks:
// pin both seams to the run-day instant, read them back through the plugin's own
// getters, then release them (null) so the file's own hooks start from the normal
// state. Any mismatch fails the whole file loudly. One values-free proof line per
// file process is appended to ATTENDANCE_DATE_MATRIX_PROOF_FILE when it is set.
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll } from 'vitest'
import { attendanceTestRunDateOverride, attendanceTestRunNow } from './utils/attendance-test-run-date'

type ClockModule = { [name: string]: unknown }
const requireCjs = createRequire(import.meta.url)
const punchClock = requireCjs('../../../plugins/plugin-attendance/lib/attendance-online-punch-clock.cjs') as ClockModule
const tripClock = requireCjs('../../../plugins/plugin-attendance/lib/attendance-business-trip.cjs') as ClockModule

function seam(module: ClockModule, setter: string, getter: string) {
  const set = module[setter], get = module[getter]
  if (typeof set !== 'function' || typeof get !== 'function') throw new Error('ATTENDANCE_TEST_RUN_DATE_SEAM_MISSING')
  return { set: set as (value: Date | null) => void, get: get as () => Date }
}

beforeAll(() => {
  const override = attendanceTestRunDateOverride()
  const runNow = attendanceTestRunNow()
  const realDate = new Date().toISOString().slice(0, 10)
  const expectedDate = override ?? runNow.toISOString().slice(0, 10)
  const punch = seam(punchClock, 'setOnlinePunchInstantForTests', 'getOnlinePunchServerInstant')
  const trip = seam(tripClock, 'setBusinessTripInstantForTests', 'getBusinessTripServerInstant')
  let punchDate = '', tripDate = ''
  try {
    punch.set(runNow)
    trip.set(runNow)
    punchDate = punch.get().toISOString().slice(0, 10)
    tripDate = trip.get().toISOString().slice(0, 10)
  } finally {
    punch.set(null)
    trip.set(null)
  }
  const effective = runNow.toISOString().slice(0, 10) === expectedDate && punchDate === expectedDate && tripDate === expectedDate
  const proofFile = process.env.ATTENDANCE_DATE_MATRIX_PROOF_FILE
  if (proofFile) {
    appendFileSync(proofFile, JSON.stringify({
      overridden: override !== null, expectedDate, helperDate: runNow.toISOString().slice(0, 10),
      punchClockDate: punchDate, tripClockDate: tripDate, realProcessDate: realDate, effective,
    }) + '\n')
  }
  if (!effective) throw new Error('ATTENDANCE_TEST_RUN_DATE_NOT_EFFECTIVE')
})
