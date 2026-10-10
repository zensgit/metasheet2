import { afterEach, describe, expect, it } from 'vitest'

// #5976 / #5981 — the settings response must tell the admin whether the env half of each
// double-gate is actually on. Defaults stay off. The snapshot is not part of persisted settings.
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests as {
  buildAttendanceDualGateRuntimeStatus: () => {
    reportDigest: {
      producerEnabled: boolean
      schedulerEnabled: boolean
      deliveryWorkerEnabled: boolean
      live: boolean
      requiredEnv: string[]
      offEnv: string[]
    }
    annualLeaveAccrualScheduled: {
      accrualScheduledEnabled: boolean
      schedulerEnabled: boolean
      live: boolean
      requiredEnv: string[]
      offEnv: string[]
    }
  }
  mergeSettings: (base: Record<string, unknown>, update: Record<string, unknown>) => Record<string, unknown>
}

const DIGEST_ENV = 'ATTENDANCE_REPORT_DIGEST_ENABLED'
const SCHEDULER_ENV = 'ATTENDANCE_SCHEDULER_ENABLED'
const WORKER_ENV = 'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED'
const ACCRUAL_ENV = 'ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED'

function clearGates(): void {
  delete process.env[DIGEST_ENV]
  delete process.env[SCHEDULER_ENV]
  delete process.env[WORKER_ENV]
  delete process.env[ACCRUAL_ENV]
}

describe('#5976 #5981 attendance env dual-gate honesty', () => {
  afterEach(() => {
    clearGates()
  })

  it('defaults both features to dormant and names the env vars that keep them dormant', () => {
    clearGates()
    const status = helpers.buildAttendanceDualGateRuntimeStatus()
    expect(status.reportDigest).toEqual({
      producerEnabled: false,
      schedulerEnabled: false,
      deliveryWorkerEnabled: false,
      live: false,
      requiredEnv: [DIGEST_ENV, SCHEDULER_ENV, WORKER_ENV],
      offEnv: [DIGEST_ENV, SCHEDULER_ENV, WORKER_ENV],
    })
    expect(status.annualLeaveAccrualScheduled).toEqual({
      accrualScheduledEnabled: false,
      schedulerEnabled: false,
      live: false,
      requiredEnv: [ACCRUAL_ENV, SCHEDULER_ENV],
      offEnv: [ACCRUAL_ENV, SCHEDULER_ENV],
    })
  })

  it('digest is live only when the producer gate and both exact-true process gates are on', () => {
    process.env[DIGEST_ENV] = 'yes'
    process.env[SCHEDULER_ENV] = '1'
    process.env[WORKER_ENV] = 'TRUE'
    let status = helpers.buildAttendanceDualGateRuntimeStatus()
    expect(status.reportDigest.producerEnabled).toBe(true)
    expect(status.reportDigest.schedulerEnabled).toBe(false)
    expect(status.reportDigest.deliveryWorkerEnabled).toBe(false)
    expect(status.reportDigest.live).toBe(false)
    expect(status.reportDigest.offEnv).toEqual([SCHEDULER_ENV, WORKER_ENV])

    process.env[SCHEDULER_ENV] = 'true'
    process.env[WORKER_ENV] = 'true'
    status = helpers.buildAttendanceDualGateRuntimeStatus()
    expect(status.reportDigest.live).toBe(true)
    expect(status.reportDigest.offEnv).toEqual([])
    expect(status.reportDigest.schedulerEnabled).toBe(true)
    expect(status.reportDigest.deliveryWorkerEnabled).toBe(true)
  })

  it('monthly accrual is live only when its env gate and the exact-true scheduler gate are on', () => {
    process.env[ACCRUAL_ENV] = '1'
    process.env[SCHEDULER_ENV] = ' true'
    let status = helpers.buildAttendanceDualGateRuntimeStatus()
    expect(status.annualLeaveAccrualScheduled.accrualScheduledEnabled).toBe(true)
    expect(status.annualLeaveAccrualScheduled.schedulerEnabled).toBe(false)
    expect(status.annualLeaveAccrualScheduled.live).toBe(false)
    expect(status.annualLeaveAccrualScheduled.offEnv).toEqual([SCHEDULER_ENV])

    process.env[SCHEDULER_ENV] = 'true'
    status = helpers.buildAttendanceDualGateRuntimeStatus()
    expect(status.annualLeaveAccrualScheduled.live).toBe(true)
    expect(status.annualLeaveAccrualScheduled.offEnv).toEqual([])
  })

  it('a runtime snapshot stuffed into settings is dropped on merge and is not persisted', () => {
    const merged = helpers.mergeSettings(
      { runtimeGates: { reportDigest: { live: true } } },
      { attendanceReportDigestPolicy: { enabled: true } },
    )
    expect(merged).not.toHaveProperty('runtimeGates')
    expect(merged.attendanceReportDigestPolicy).toMatchObject({ enabled: true })
  })
})
