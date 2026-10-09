// A1 「提示与实际状态」(Codex review reply 20261008 §四, memo R1) — pure status module for the two scheduled
// features whose org-side switch the admin UI lets an org save: the report-digest subscription ("digest push")
// and the monthly annual-leave auto-accrual ("scheduled grant"). NO fetch, NO DOM, NO Vue reactivity.
//
// Each feature runs only when BOTH halves are true:
//   (a) the org-side policy saved in settings (this is what 「已配置」 reports), AND
//   (b) the process-level env gates owned by ops (this is what 「当前是否可运行」 reports).
//       `runtimeGates` is the switch snapshot of the ONE process that answered the request (当前响应进程的
//       开关快照); another instance may be configured differently. The open-state hints say so explicitly. The
//       closed-state copy (e.g. 「已保存，但当前不会发送」) predates this and still reads that one snapshot as the
//       answer; the closed-state copy is now bounded the same way (reviewer finding, 2026-10-09).
// Missing (b) is a byte-exact no-op at base 9d65b8318f - digest producer: plugins/plugin-attendance/index.cjs:16548-16550
// read by runAttendanceReportDigestOnce (:17423); accrual: :19791-19793 read by
// runAnnualLeaveAccrualScheduledTriggerOnce (:19893); the scheduler gate is packages/core-backend/src/services/
// AttendanceScheduler.ts:311 and the delivery worker gate is :400. Before this
// module the admin cards said (for the accrual) "no admin click required", which describes only half (a).
//
// Honesty rules this module encodes (see the A1 report for the evidence):
//   1. Configured state is derived from the SAVED settings the server last returned - never from a live,
//      unsaved checkbox - so toggling a box cannot flip the status before anything is saved.
//   2. The env half is bounded to the answering process on purpose: a closed gate means "this process will not run
//      it" (another instance may differ); an OPEN gate only means "not
//      blocked by these gates" - never "running"/"in effect". Org policy, engine prerequisites and channel
//      configuration are separate, and the settings read is cached up to 60 s per process
//      (index.cjs:348 SETTINGS_CACHE_TTL_MS, :14970-14977 getSettings; a save refreshes only the writing
//      process's slot, :14986-14997), so a saved change is not claimed to be picked up immediately.
//   3. A missing or malformed gate report is "unknown" and is treated as "do not assume it runs" (fail-closed),
//      never as "open".
//
// The server (GET /api/attendance/settings, sibling `runtimeGates`) sends symbolic gate ids and booleans only -
// no env variable name. The env names below are static UI copy for the ops person who has to flip them.

export type TranslateFn = (en: string, zh: string) => string

export type AttendanceScheduledFeatureKey = 'reportDigest' | 'annualLeaveAccrualScheduled'

export interface AttendanceRuntimeGateEntry {
  /** True when none of this feature's env gates is closed. NOT "running". */
  gatesOpen: boolean
  /** Symbolic ids of the gates that are closed, in the server's order. */
  closedGates: string[]
}

export interface AttendanceRuntimeGates {
  reportDigest: AttendanceRuntimeGateEntry | null
  annualLeaveAccrualScheduled: AttendanceRuntimeGateEntry | null
}

export type AttendanceConfiguredState = 'configured' | 'incomplete' | 'not_configured' | 'unknown'
export type AttendanceRunnableState = 'open' | 'closed' | 'unknown'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseGateEntry(raw: unknown): AttendanceRuntimeGateEntry | null {
  if (!isRecord(raw)) return null
  if (typeof raw.gatesOpen !== 'boolean' || !Array.isArray(raw.closedGates)) return null
  if (!raw.closedGates.every((id) => typeof id === 'string')) return null
  const closedGates = raw.closedGates as string[]
  // "open" while listing a closed gate (or "closed" listing none) is a malformed report, not an answer.
  if (raw.gatesOpen !== (closedGates.length === 0)) return null
  return { gatesOpen: raw.gatesOpen, closedGates: [...closedGates] }
}

/**
 * Strict, fail-closed parse of the `runtimeGates` sibling. `null` when the server sent nothing usable (older
 * server, malformed body); a feature entry is `null` when ITS report is malformed.
 */
export function parseAttendanceRuntimeGates(raw: unknown): AttendanceRuntimeGates | null {
  if (!isRecord(raw)) return null
  return {
    reportDigest: parseGateEntry(raw.reportDigest),
    annualLeaveAccrualScheduled: parseGateEntry(raw.annualLeaveAccrualScheduled),
  }
}

export function attendanceRunnableState(entry: AttendanceRuntimeGateEntry | null): AttendanceRunnableState {
  if (!entry) return 'unknown'
  return entry.gatesOpen ? 'open' : 'closed'
}

const DIGEST_CADENCE_KEYS = ['daily', 'weekly', 'monthly'] as const

/**
 * Report-digest subscription, from the SAVED settings document. `incomplete` = the subscription is on but no
 * cadence is enabled: dueDigestCadences() (index.cjs:14228) only yields cadences with enabled === true, so it
 * returns nothing and no row is ever produced.
 * `null`/`undefined` settings (not loaded, or the read failed) is `unknown`, never `not_configured`.
 */
export function attendanceReportDigestConfiguredState(
  settings: { attendanceReportDigestPolicy?: unknown } | null | undefined,
): AttendanceConfiguredState {
  if (!settings) return 'unknown'
  const policy = settings.attendanceReportDigestPolicy
  if (!isRecord(policy) || policy.enabled !== true) return 'not_configured'
  const cadences = isRecord(policy.cadences) ? policy.cadences : {}
  const anyCadence = DIGEST_CADENCE_KEYS.some((key) => {
    const cadence = cadences[key]
    return isRecord(cadence) && cadence.enabled === true
  })
  return anyCadence ? 'configured' : 'incomplete'
}

export interface AttendanceAnnualPolicySaved {
  /** annualLeavePolicy.enabled - the engine. runAnnualLeaveAccrualScheduledTriggerForOrg returns policy_not_ready without it. */
  engineEnabled: boolean
  /** annualLeavePolicy.scheduledTrigger.enabled - the org-side half of the double gate. */
  scheduledTriggerEnabled: boolean
}

/** Monthly auto-accrual, from the SAVED annual policy. `incomplete` = switched on while the engine is off. */
export function attendanceAnnualAccrualConfiguredState(
  saved: AttendanceAnnualPolicySaved | null | undefined,
): AttendanceConfiguredState {
  if (!saved) return 'unknown'
  if (saved.scheduledTriggerEnabled !== true) return 'not_configured'
  return saved.engineEnabled === true ? 'configured' : 'incomplete'
}

// Static ops-facing names. The env names live here (UI copy), not in the API response.
const GATE_COPY: Record<string, { en: string; zh: string; env: string }> = {
  digestProducer: { en: 'digest producer switch', zh: '统计通知生成开关', env: 'ATTENDANCE_REPORT_DIGEST_ENABLED' },
  accrualTrigger: { en: 'monthly auto-accrual switch', zh: '每月自动计提开关', env: 'ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED' },
  scheduler: { en: 'attendance scheduler', zh: '考勤调度器', env: 'ATTENDANCE_SCHEDULER_ENABLED' },
  deliveryWorker: { en: 'notification delivery worker', zh: '通知投递任务', env: 'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED' },
}

function closedGateLabels(tr: TranslateFn, ids: readonly string[]): string[] {
  return ids.map((id) => {
    const copy = GATE_COPY[id]
    return copy ? `${tr(copy.en, copy.zh)} (${copy.env})` : tr('another server switch', '其他服务端开关')
  })
}

export interface AttendanceScheduledFeatureStatusInput {
  feature: AttendanceScheduledFeatureKey
  configured: AttendanceConfiguredState
  gate: AttendanceRuntimeGateEntry | null
}

export interface AttendanceScheduledFeatureStatusView {
  configured: AttendanceConfiguredState
  runnable: AttendanceRunnableState
  configLabel: string
  configuredLabel: string
  runLabel: string
  runnableLabel: string
  /** The closed gates, human-readable with the env name in parentheses (empty unless runnable === 'closed'). */
  closedGateLabels: string[]
  detail: string
  /** True for "configured/incomplete but not (known to be) runnable" - the case the admin must not misread. */
  warn: boolean
}

function configuredLabelOf(tr: TranslateFn, state: AttendanceConfiguredState): string {
  switch (state) {
    case 'configured': return tr('Configured', '已配置')
    case 'incomplete': return tr('Incomplete', '配置不完整')
    case 'not_configured': return tr('Not configured', '未配置')
    default: return tr('Not loaded', '尚未加载')
  }
}

function runnableLabelOf(tr: TranslateFn, state: AttendanceRunnableState): string {
  switch (state) {
    case 'open': return tr('Server run switches are on', '服务端运行开关已开启')
    case 'closed': return tr('No — the answering process reports server run switches off', '否：应答进程的服务端运行开关未全部开启')
    default: return tr('Unknown — server run switches not reported', '未知：未取得服务端运行开关状态')
  }
}

function incompleteDetail(tr: TranslateFn, feature: AttendanceScheduledFeatureKey): string {
  return feature === 'reportDigest'
    ? tr(
      'The subscription is on, but no send cadence is enabled, so nothing will be produced.',
      '订阅已启用，但没有开启任何发送周期，不会产生通知。',
    )
    : tr(
      'Auto-accrual is switched on, but the annual leave engine above is not enabled, so it will not run.',
      '已开启每月自动计提，但上方年假引擎未启用，不会运行。',
    )
}

function openDetail(tr: TranslateFn, feature: AttendanceScheduledFeatureKey): string {
  return feature === 'reportDigest'
    ? tr(
      'The server run switches are on in the process that answered this request. A saved change is picked up when each instance next re-reads its settings after its cache expires, so it may lag. The selected channel still needs its own server configuration.',
      '当前响应进程的服务端运行开关已开启。已保存的改动会在各实例缓存到期后的下次读取时刷新，可能有延迟；所选渠道仍需各自的服务端配置。',
    )
    : tr(
      'The server run switches are on in the process that answered this request. A saved change is picked up when each instance next re-reads its settings after its cache expires, so it may lag. The annual leave engine above must also stay enabled.',
      '当前响应进程的服务端运行开关已开启。已保存的改动会在各实例缓存到期后的下次读取时刷新，可能有延迟；上方年假引擎也需保持启用。',
    )
}

/**
 * The explanation under the annual card's 「每月自动运行计提」 switch. It replaces the previous text ("runs
 * automatically once a month per org ... no admin click required"), which described only the org-side half of
 * the double gate. The manual run does not read the env gates (POST /api/attendance/annual-leave-accrual/run and
 * runAnnualLeaveAccrual read none), which is why the text can say so.
 */
export function annualAccrualSwitchHint(tr: TranslateFn): string {
  return tr(
    'Turning this on and saving only records the setting; whether accrual really runs automatically every month also depends on the server run switches shown below. With it off (default), accrual runs only when an admin triggers it manually, and the manual run does not depend on those switches.',
    '开启并保存只是记录该设置；是否真的每月自动运行，还取决于下方显示的服务端运行开关。关闭（默认）时，计提只在管理员手工触发时运行；手工运行不依赖这些开关。',
  )
}

function closedDetail(
  tr: TranslateFn,
  feature: AttendanceScheduledFeatureKey,
  configured: AttendanceConfiguredState,
  list: string,
): string {
  if (configured === 'not_configured') {
    return feature === 'reportDigest'
      ? tr(
        `Not configured. Even once switched on, the answering process reports ${list} off; this snapshot cannot confirm other instances or task execution.`,
        `未配置。即使开启，应答进程的 ${list} 也未开启；此快照不能确认其他实例或任务执行状态。`,
      )
      : tr(
        `Not configured. Even once switched on, the answering process reports ${list} off; this snapshot cannot confirm other instances or task execution.`,
        `未配置。即使开启，应答进程的 ${list} 也未开启；此快照不能确认其他实例或任务执行状态。`,
      )
  }
  return feature === 'reportDigest'
    ? tr(
      `Saved. At the last settings read the answering process reported ${list} off; this snapshot cannot confirm other instances or task execution.`,
      `已保存。最近一次读取时，应答进程的 ${list} 未开启；此快照不能确认其他实例或任务执行状态。`,
    )
    : tr(
      `Saved. At the last settings read the answering process reported ${list} off; this snapshot cannot confirm other instances or task execution. The manual run is not affected.`,
      `已保存。最近一次读取时，应答进程的 ${list} 未开启；此快照不能确认其他实例或任务执行状态。手工运行不受影响。`,
    )
}

export function describeScheduledFeatureStatus(
  tr: TranslateFn,
  input: AttendanceScheduledFeatureStatusInput,
): AttendanceScheduledFeatureStatusView {
  const { feature, configured, gate } = input
  const runnable = attendanceRunnableState(gate)
  const labels = runnable === 'closed' && gate ? closedGateLabels(tr, gate.closedGates) : []
  const list = labels.join(tr(', ', '、'))

  let detail: string
  if (configured === 'unknown') {
    detail = tr('The saved configuration has not been loaded yet.', '尚未加载已保存的配置。')
  } else if (configured === 'incomplete') {
    detail = incompleteDetail(tr, feature)
  } else if (runnable === 'closed') {
    detail = closedDetail(tr, feature, configured, list)
  } else if (configured === 'not_configured') {
    detail = runnable === 'open'
      ? tr('Not configured. The server run switches are on.', '未配置。服务端运行开关已开启。')
      : tr('Not configured. The server run switches could not be read.', '未配置。未能读取服务端运行开关。')
  } else if (runnable === 'unknown') {
    detail = tr(
      'Saved, but the server run switches could not be read, so do not treat it as running.',
      '已保存，但未能读取服务端运行开关，请勿视为已运行。',
    )
  } else {
    detail = openDetail(tr, feature)
  }

  return {
    configured,
    runnable,
    configLabel: tr('Configuration', '配置状态'),
    configuredLabel: configuredLabelOf(tr, configured),
    runLabel: tr('Can it run now?', '当前是否可运行'),
    runnableLabel: runnableLabelOf(tr, runnable),
    closedGateLabels: labels,
    detail,
    warn: configured === 'incomplete' || (configured === 'configured' && runnable !== 'open'),
  }
}

/**
 * The sentence appended to the save status after a successful save. '' when there is nothing to add (not
 * configured, or configuration not known): the base message then stands alone, exactly as before.
 * A saved + open feature never says "now running": it names the switch report as the snapshot of the process that
 * answered the last settings read, and says the change is picked up at each instance's next re-read after its
 * cache expires (no numeric window is promised).
 */
export function scheduledFeatureSaveNotice(
  tr: TranslateFn,
  input: AttendanceScheduledFeatureStatusInput,
): string {
  const { feature, configured, gate } = input
  if (configured !== 'configured' && configured !== 'incomplete') return ''
  if (configured === 'incomplete') return incompleteDetail(tr, feature)
  const runnable = attendanceRunnableState(gate)
  if (runnable === 'closed' && gate) {
    const list = closedGateLabels(tr, gate.closedGates).join(tr(', ', '、'))
    return feature === 'reportDigest'
      ? tr(`Note: at the last settings read the answering process reported ${list} off; this snapshot cannot confirm other instances or task execution.`, `提示：最近一次读取时，应答进程的 ${list} 未开启；此快照不能确认其他实例或任务执行状态。`)
      : tr(`Note: at the last settings read the answering process reported ${list} off; this snapshot cannot confirm other instances or task execution. The manual run is not affected.`, `提示：最近一次读取时，应答进程的 ${list} 未开启；此快照不能确认其他实例或任务执行状态。手工运行不受影响。`)
  }
  if (runnable === 'unknown') {
    return tr(
      'Note: the server run switches could not be read, so do not treat it as running.',
      '提示：未能读取服务端运行开关，请勿视为已运行。',
    )
  }
  return feature === 'reportDigest'
    ? tr(
      'The server run switches were on in the process that answered the last settings read; a saved change is picked up when each instance next re-reads its settings after its cache expires, so it may lag. The selected channel still needs its own server configuration.',
      '最近一次读取时应答进程的服务端运行开关已开启；已保存的改动会在各实例缓存到期后的下次读取时刷新，可能有延迟。所选渠道仍需各自的服务端配置。',
    )
    : tr(
      'The server run switches were on in the process that answered the last settings read; a saved change is picked up when each instance next re-reads its settings after its cache expires, so it may lag. The annual leave engine must also stay enabled.',
      '最近一次读取时应答进程的服务端运行开关已开启；已保存的改动会在各实例缓存到期后的下次读取时刷新，可能有延迟。年假引擎也需保持启用。',
    )
}

/** `baseMessage` plus the notice, separated by a single space; `baseMessage` alone when there is no notice. */
export function withScheduledFeatureSaveNotice(
  tr: TranslateFn,
  input: AttendanceScheduledFeatureStatusInput,
  baseMessage: string,
): string {
  const notice = scheduledFeatureSaveNotice(tr, input)
  return notice ? `${baseMessage} ${notice}` : baseMessage
}
