import { describe, expect, it } from 'vitest'
import {
  annualAccrualSwitchHint,
  attendanceAnnualAccrualConfiguredState,
  attendanceReportDigestConfiguredState,
  attendanceRunnableState,
  describeScheduledFeatureStatus,
  parseAttendanceRuntimeGates,
  scheduledFeatureSaveNotice,
  withScheduledFeatureSaveNotice,
  type AttendanceConfiguredState,
  type AttendanceRuntimeGateEntry,
  type AttendanceScheduledFeatureKey,
  type TranslateFn,
} from '../src/views/attendance/attendanceScheduledFeatureStatus'

// A1 「提示与实际状态」 - the report-digest subscription and the monthly annual-leave auto-accrual need BOTH an
// org-side switch (saved in settings => 「已配置」) AND ops-owned env gates (=> 「当前是否可运行」). These specs pin
// the derivation and the honesty rules: configured comes from saved settings; a closed gate means "will not run";
// an open gate NEVER reads as running/in effect; a missing report is fail-closed.

const enTr: TranslateFn = (en) => en
const zhTr: TranslateFn = (_en, zh) => zh
const CJK = /[㐀-鿿]/

const OPEN: AttendanceRuntimeGateEntry = { gatesOpen: true, closedGates: [] }
const CLOSED_DIGEST: AttendanceRuntimeGateEntry = {
  gatesOpen: false,
  closedGates: ['digestProducer', 'scheduler', 'deliveryWorker'],
}
const CLOSED_ACCRUAL: AttendanceRuntimeGateEntry = {
  gatesOpen: false,
  closedGates: ['accrualTrigger', 'scheduler'],
}
const features: AttendanceScheduledFeatureKey[] = ['reportDigest', 'annualLeaveAccrualScheduled']
const configuredStates: AttendanceConfiguredState[] = ['configured', 'incomplete', 'not_configured', 'unknown']

describe('parseAttendanceRuntimeGates (strict, fail-closed)', () => {
  it('accepts the server shape (symbolic ids + booleans)', () => {
    expect(parseAttendanceRuntimeGates({
      reportDigest: { gatesOpen: false, closedGates: ['digestProducer', 'scheduler'] },
      annualLeaveAccrualScheduled: { gatesOpen: true, closedGates: [] },
    })).toEqual({
      reportDigest: { gatesOpen: false, closedGates: ['digestProducer', 'scheduler'] },
      annualLeaveAccrualScheduled: { gatesOpen: true, closedGates: [] },
    })
  })

  it('returns null when the server reported nothing usable (older server / malformed body)', () => {
    for (const bad of [undefined, null, 'x', 7, [], true]) {
      expect(parseAttendanceRuntimeGates(bad)).toBeNull()
    }
  })

  it('nulls only the malformed feature entry and keeps the other', () => {
    const parsed = parseAttendanceRuntimeGates({
      reportDigest: { gatesOpen: 'yes', closedGates: [] },
      annualLeaveAccrualScheduled: OPEN,
    })
    expect(parsed?.reportDigest).toBeNull()
    expect(parsed?.annualLeaveAccrualScheduled).toEqual(OPEN)
  })

  it('treats an inconsistent report as unknown - "open" while listing a closed gate, or "closed" listing none', () => {
    const parsed = parseAttendanceRuntimeGates({
      reportDigest: { gatesOpen: true, closedGates: ['scheduler'] },
      annualLeaveAccrualScheduled: { gatesOpen: false, closedGates: [] },
    })
    expect(parsed?.reportDigest).toBeNull()
    expect(parsed?.annualLeaveAccrualScheduled).toBeNull()
  })

  it('rejects non-string gate ids', () => {
    const parsed = parseAttendanceRuntimeGates({
      reportDigest: { gatesOpen: false, closedGates: [1] },
      annualLeaveAccrualScheduled: { gatesOpen: false, closedGates: 'scheduler' },
    })
    expect(parsed?.reportDigest).toBeNull()
    expect(parsed?.annualLeaveAccrualScheduled).toBeNull()
  })

  it('attendanceRunnableState: null is unknown, never open', () => {
    expect(attendanceRunnableState(null)).toBe('unknown')
    expect(attendanceRunnableState(OPEN)).toBe('open')
    expect(attendanceRunnableState(CLOSED_DIGEST)).toBe('closed')
  })
})

describe('configured state comes from the SAVED settings', () => {
  it('digest: unknown until settings are loaded - a failed or missing read is never "not configured"', () => {
    expect(attendanceReportDigestConfiguredState(null)).toBe('unknown')
    expect(attendanceReportDigestConfiguredState(undefined)).toBe('unknown')
  })

  it('digest: off or absent policy is not_configured', () => {
    expect(attendanceReportDigestConfiguredState({})).toBe('not_configured')
    expect(attendanceReportDigestConfiguredState({ attendanceReportDigestPolicy: { enabled: false } })).toBe('not_configured')
    expect(attendanceReportDigestConfiguredState({ attendanceReportDigestPolicy: { enabled: 'true' } })).toBe('not_configured')
  })

  it('digest: on with no enabled cadence is incomplete (nothing would ever be produced)', () => {
    expect(attendanceReportDigestConfiguredState({
      attendanceReportDigestPolicy: { enabled: true, cadences: { daily: { enabled: false }, weekly: {}, monthly: { enabled: false } } },
    })).toBe('incomplete')
    expect(attendanceReportDigestConfiguredState({ attendanceReportDigestPolicy: { enabled: true } })).toBe('incomplete')
  })

  it('digest: on with at least one enabled cadence is configured', () => {
    for (const key of ['daily', 'weekly', 'monthly']) {
      expect(attendanceReportDigestConfiguredState({
        attendanceReportDigestPolicy: { enabled: true, cadences: { [key]: { enabled: true } } },
      })).toBe('configured')
    }
  })

  it('annual: unknown until a policy was returned', () => {
    expect(attendanceAnnualAccrualConfiguredState(null)).toBe('unknown')
    expect(attendanceAnnualAccrualConfiguredState(undefined)).toBe('unknown')
  })

  it('annual: scheduled trigger off is not_configured; on with the engine off is incomplete; both on is configured', () => {
    expect(attendanceAnnualAccrualConfiguredState({ engineEnabled: true, scheduledTriggerEnabled: false })).toBe('not_configured')
    expect(attendanceAnnualAccrualConfiguredState({ engineEnabled: false, scheduledTriggerEnabled: true })).toBe('incomplete')
    expect(attendanceAnnualAccrualConfiguredState({ engineEnabled: true, scheduledTriggerEnabled: true })).toBe('configured')
  })
})

describe('describeScheduledFeatureStatus', () => {
  it('always renders BOTH rows - 已配置 and 当前是否可运行 - for every feature x state x gate', () => {
    for (const feature of features) {
      for (const configured of configuredStates) {
        for (const gate of [null, OPEN, feature === 'reportDigest' ? CLOSED_DIGEST : CLOSED_ACCRUAL]) {
          const zh = describeScheduledFeatureStatus(zhTr, { feature, configured, gate })
          expect(zh.configLabel).toBe('配置状态')
          expect(zh.runLabel).toBe('当前是否可运行')
          expect(zh.configuredLabel.length).toBeGreaterThan(0)
          expect(zh.runnableLabel.length).toBeGreaterThan(0)
          expect(zh.detail.length).toBeGreaterThan(0)
          const en = describeScheduledFeatureStatus(enTr, { feature, configured, gate })
          expect(en.runLabel).toBe('Can it run now?')
          expect(CJK.test(`${en.configLabel}${en.configuredLabel}${en.runLabel}${en.runnableLabel}${en.detail}`)).toBe(false)
        }
      }
    }
  })

  it('uses the literal labels 已配置 / 未配置 for the configured row', () => {
    const input = { feature: 'reportDigest' as const, gate: OPEN }
    expect(describeScheduledFeatureStatus(zhTr, { ...input, configured: 'configured' }).configuredLabel).toBe('已配置')
    expect(describeScheduledFeatureStatus(zhTr, { ...input, configured: 'not_configured' }).configuredLabel).toBe('未配置')
    expect(describeScheduledFeatureStatus(enTr, { ...input, configured: 'configured' }).configuredLabel).toBe('Configured')
  })

  it('zh copy carries no stray English: the only Latin text anywhere is the env variable names (gate r1 NIT-1)', () => {
    const ENV_NAME = /ATTENDANCE_[A-Z_]+/g
    for (const feature of features) {
      for (const configured of configuredStates) {
        for (const gate of [null, OPEN, feature === 'reportDigest' ? CLOSED_DIGEST : CLOSED_ACCRUAL]) {
          const view = describeScheduledFeatureStatus(zhTr, { feature, configured, gate })
          const notice = scheduledFeatureSaveNotice(zhTr, { feature, configured, gate })
          const texts = [view.configLabel, view.configuredLabel, view.runLabel, view.runnableLabel, view.detail, notice, ...view.closedGateLabels]
          for (const text of texts) {
            expect(text.replace(ENV_NAME, '')).not.toMatch(/[A-Za-z]/)
          }
        }
      }
    }
    expect(annualAccrualSwitchHint(zhTr)).not.toMatch(/[A-Za-z]/)
  })

  it('zh names the notification-delivery gate 通知投递任务, not "worker" (gate r1 NIT-1)', () => {
    const view = describeScheduledFeatureStatus(zhTr, { feature: 'reportDigest', configured: 'configured', gate: CLOSED_DIGEST })
    expect(view.closedGateLabels).toContain('通知投递任务 (ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED)')
    expect(view.detail).toContain('通知投递任务')
    expect(view.detail.replace(/ATTENDANCE_[A-Z_]+/g, '')).not.toMatch(/worker/i) // the env name itself says WORKER
  })

  it('digest configured + gates closed: says it will not send and names every closed gate with its env name', () => {
    const zh = describeScheduledFeatureStatus(zhTr, { feature: 'reportDigest', configured: 'configured', gate: CLOSED_DIGEST })
    expect(zh.runnable).toBe('closed')
    expect(zh.warn).toBe(true)
    expect(zh.runnableLabel).toBe('否：服务端运行开关未开启')
    expect(zh.detail).toContain('已保存，但当前不会发送')
    expect(zh.closedGateLabels).toHaveLength(3)
    for (const env of ['ATTENDANCE_REPORT_DIGEST_ENABLED', 'ATTENDANCE_SCHEDULER_ENABLED', 'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED']) {
      expect(zh.detail).toContain(env)
    }
    const en = describeScheduledFeatureStatus(enTr, { feature: 'reportDigest', configured: 'configured', gate: CLOSED_DIGEST })
    expect(en.detail).toContain('Saved, but it will not send')
  })

  it('accrual configured + gates closed: says it will not run automatically, names only the closed gates, and keeps the manual run out of it', () => {
    const closed: AttendanceRuntimeGateEntry = { gatesOpen: false, closedGates: ['scheduler'] }
    const zh = describeScheduledFeatureStatus(zhTr, { feature: 'annualLeaveAccrualScheduled', configured: 'configured', gate: closed })
    expect(zh.detail).toContain('已保存，但当前不会自动运行')
    expect(zh.detail).toContain('ATTENDANCE_SCHEDULER_ENABLED')
    expect(zh.detail).not.toContain('ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED')
    expect(zh.detail).toContain('手工运行不受影响')
  })

  it('an OPEN gate is "on", never "running"/"in effect"/已生效 - and the copy carries the 60-second settings-cache window', () => {
    for (const feature of features) {
      const zh = describeScheduledFeatureStatus(zhTr, { feature, configured: 'configured', gate: OPEN })
      const en = describeScheduledFeatureStatus(enTr, { feature, configured: 'configured', gate: OPEN })
      expect(zh.runnableLabel).toBe('服务端运行开关已开启')
      expect(zh.warn).toBe(false)
      for (const text of [zh.runnableLabel, zh.detail, en.runnableLabel, en.detail]) {
        expect(text).not.toContain('已生效')
        expect(text).not.toContain('运行中')
        expect(text).not.toContain('正在运行')
        expect(text).not.toMatch(/\bis running\b/i)
        expect(text).not.toMatch(/\bin effect\b/i)
        expect(text).not.toMatch(/\bnow running\b/i)
      }
      expect(zh.detail).toContain('下次读取时刷新')
      expect(zh.detail).not.toMatch(/\d+ ?秒/)
      expect(en.detail).toContain('60 seconds')
    }
  })

  it('digest, open: states the channel still needs its own server configuration; accrual, open: the engine must stay enabled', () => {
    expect(describeScheduledFeatureStatus(zhTr, { feature: 'reportDigest', configured: 'configured', gate: OPEN }).detail)
      .toContain('所选渠道仍需各自的服务端配置')
    expect(describeScheduledFeatureStatus(zhTr, { feature: 'annualLeaveAccrualScheduled', configured: 'configured', gate: OPEN }).detail)
      .toContain('年假引擎也需保持启用')
  })

  it('a missing gate report is unknown and fail-closed: it never reads as open, and a saved config is told not to be trusted as running', () => {
    for (const feature of features) {
      const view = describeScheduledFeatureStatus(zhTr, { feature, configured: 'configured', gate: null })
      expect(view.runnable).toBe('unknown')
      expect(view.warn).toBe(true)
      expect(view.runnableLabel).toBe('未知：未取得服务端运行开关状态')
      expect(view.detail).toContain('请勿视为已运行')
    }
  })

  it('incomplete configuration is a warning in its own right, whatever the gates say', () => {
    const digest = describeScheduledFeatureStatus(zhTr, { feature: 'reportDigest', configured: 'incomplete', gate: OPEN })
    expect(digest.warn).toBe(true)
    expect(digest.detail).toContain('没有开启任何发送周期')
    const accrual = describeScheduledFeatureStatus(zhTr, { feature: 'annualLeaveAccrualScheduled', configured: 'incomplete', gate: OPEN })
    expect(accrual.warn).toBe(true)
    expect(accrual.detail).toContain('年假引擎未启用')
  })

  it('not configured: shown as such; with closed gates it warns that switching on is not enough, but is not itself a warning', () => {
    const view = describeScheduledFeatureStatus(zhTr, { feature: 'reportDigest', configured: 'not_configured', gate: CLOSED_DIGEST })
    expect(view.configuredLabel).toBe('未配置')
    expect(view.warn).toBe(false)
    expect(view.detail).toContain('即使开启，也要等运维开启')
  })

  it('unknown configuration says it has not been loaded and never claims "not configured"', () => {
    const view = describeScheduledFeatureStatus(zhTr, { feature: 'reportDigest', configured: 'unknown', gate: OPEN })
    expect(view.configuredLabel).toBe('尚未加载')
    expect(view.detail).toBe('尚未加载已保存的配置。')
  })

  it('an unrecognised gate id from a newer server degrades to a generic label instead of leaking the raw id', () => {
    const view = describeScheduledFeatureStatus(enTr, {
      feature: 'reportDigest',
      configured: 'configured',
      gate: { gatesOpen: false, closedGates: ['somethingNew'] },
    })
    expect(view.closedGateLabels).toEqual(['another server switch'])
    expect(view.detail).not.toContain('somethingNew')
  })
})

describe('scheduledFeatureSaveNotice / withScheduledFeatureSaveNotice', () => {
  it('adds nothing when the feature is not configured or the configuration is unknown (base message stands alone)', () => {
    for (const configured of ['not_configured', 'unknown'] as const) {
      expect(scheduledFeatureSaveNotice(enTr, { feature: 'reportDigest', configured, gate: CLOSED_DIGEST })).toBe('')
      expect(withScheduledFeatureSaveNotice(enTr, { feature: 'reportDigest', configured, gate: CLOSED_DIGEST }, 'Saved.')).toBe('Saved.')
    }
  })

  it('saved + gates closed: the notice says it will not send until ops turn the named gates on', () => {
    const message = withScheduledFeatureSaveNotice(
      zhTr,
      { feature: 'reportDigest', configured: 'configured', gate: CLOSED_DIGEST },
      '统计通知订阅已保存',
    )
    expect(message.startsWith('统计通知订阅已保存 ')).toBe(true)
    expect(message).toContain('之前不会发送')
    expect(message).toContain('ATTENDANCE_REPORT_DIGEST_ENABLED')
  })

  it('saved + gates open: never says it is running now; it says the change is picked up within about 60 seconds', () => {
    for (const feature of features) {
      const notice = scheduledFeatureSaveNotice(enTr, { feature, configured: 'configured', gate: OPEN })
      expect(notice).toContain('60 seconds')
      expect(notice).not.toMatch(/\brunning\b/i)
      expect(notice).not.toMatch(/\bin effect\b/i)
    }
  })

  it('saved + gate report missing: do not treat it as running', () => {
    expect(scheduledFeatureSaveNotice(zhTr, { feature: 'annualLeaveAccrualScheduled', configured: 'configured', gate: null }))
      .toBe('提示：未能读取服务端运行开关，请勿视为已运行。')
  })

  it('saved incomplete: repeats the incomplete explanation', () => {
    expect(scheduledFeatureSaveNotice(zhTr, { feature: 'annualLeaveAccrualScheduled', configured: 'incomplete', gate: OPEN }))
      .toContain('年假引擎未启用')
  })
})

describe('annualAccrualSwitchHint', () => {
  it('says the switch only records the setting and that the server run switches decide - in both languages', () => {
    const en = annualAccrualSwitchHint(enTr)
    const zh = annualAccrualSwitchHint(zhTr)
    expect(en).toContain('only records the setting')
    expect(en).toContain('server run switches')
    expect(zh).toContain('只是记录该设置')
    expect(zh).toContain('服务端运行开关')
    expect(CJK.test(en)).toBe(false)
    expect(CJK.test(zh)).toBe(true)
  })

  it('no longer carries the old over-claim, and keeps the manual run out of the gates', () => {
    for (const text of [annualAccrualSwitchHint(enTr), annualAccrualSwitchHint(zhTr)]) {
      expect(text).not.toContain('no admin click required')
      expect(text).not.toContain('无需管理员点击')
    }
    expect(annualAccrualSwitchHint(enTr)).toContain('the manual run does not depend on those switches')
    expect(annualAccrualSwitchHint(zhTr)).toContain('手工运行不依赖这些开关')
  })
})
