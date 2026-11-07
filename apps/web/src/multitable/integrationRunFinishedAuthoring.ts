/**
 * R-69 1c — rule-editor support for the `integration.run_finished` trigger (Bridge 2) and its alert template
 * (ADR adr-automation-pipeline-bridge-20261103 §4.2 / §4.3; design baseline v2.3 §10.2.4 1c rows). Dry run only,
 * default OFF, R-69 OPEN.
 *
 *   1. OFFER: the trigger is offered for a NEW rule only while the session feature `integrationAutomationRunEvent`
 *      (the server's INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED) is on; a loaded rule of this type always stays
 *      listed (never silently dropped).
 *   2. THE CLIENT MIRROR of the server save gate (packages/core-backend/src/multitable/automation-triggers.ts
 *      validateIntegrationRunFinishedTriggerConfig + AutomationService.assertIntegrationRunFinishedRuleAtSave):
 *      closed job kind, pipelineId required for `pipeline`, optional actionId for `stock_prep_pull`, closed
 *      non-empty statuses without repeats, no conditions, record-less side-effect actions only. The server stays
 *      the authority (it also stamps the binding and checks the creator live).
 *   3. THE ALERT TEMPLATE (ADR §4.3): DingTalk group message whose title / body use ONLY `run.*` variables —
 *      status, reason, canApply, counts, job, duration, attempts, error class. Nothing else exists in the event.
 *      The I5 ruling on verifier F7 (baseline v2.3 §10.2.2 ③) widened the event: `run.canApply` (boolean) and the
 *      stock-prep planner's five decision counts `run.counts.add` / `update` / `skip` / `inactive` /
 *      `manual_confirm` (the names the scheduled-pull script logs; 0 for a pipeline run).
 */

export const INTEGRATION_RUN_FINISHED_TRIGGER_TYPE = 'integration.run_finished'

/** The closed status set, byte-identical to the server (and to I4's RUN_INTEGRATION_JOB_STEP_OUTCOMES). */
export const INTEGRATION_RUN_FINISHED_STATUS_OPTIONS: readonly string[] = Object.freeze([
  'succeeded', 'partial', 'failed', 'held', 'skipped', 'not_started', 'outcome_unknown',
])

/** The server's default alert set when a rule names none: skipped alerts, held stays quiet. */
export const INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES: readonly string[] = Object.freeze([
  'failed', 'partial', 'skipped', 'outcome_unknown', 'not_started',
])

export const INTEGRATION_RUN_FINISHED_JOB_KINDS: readonly string[] = Object.freeze(['stock_prep_pull', 'pipeline'])

/** The record-less side-effect actions the server admits on this trigger (no record write, no run_integration_job). */
export const INTEGRATION_RUN_FINISHED_ALLOWED_ACTION_TYPES: ReadonlySet<string> = new Set([
  'send_notification',
  'send_webhook',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
])

const JOB_ID_SHAPE = /^[A-Za-z0-9_:.-]{1,128}$/
const CONFIG_KEYS: ReadonlySet<string> = new Set(['job', 'statuses', 'binding'])
const JOB_KEYS: ReadonlySet<string> = new Set(['kind', 'pipelineId', 'actionId'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Offered for a NEW selection only while the switch is on; a loaded rule of this type always stays listed. */
export function isIntegrationRunFinishedTriggerSelectable(eventEnabled: boolean, currentTriggerType: string): boolean {
  return eventEnabled || currentTriggerType === INTEGRATION_RUN_FINISHED_TRIGGER_TYPE
}

/**
 * The pure config mirror of the server's validateIntegrationRunFinishedTriggerConfig (`binding` is the server's:
 * ignored here, dropped on save). Returns '' or a localized reason.
 */
export function integrationRunFinishedConfigError(config: unknown, isZh: boolean): string {
  if (!isRecord(config)) return isZh ? '触发器配置无效。' : 'The trigger configuration is invalid.'
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) return isZh ? `触发器配置不支持字段「${key}」。` : `The trigger configuration does not accept "${key}".`
  }
  const job = config.job
  if (!isRecord(job)) return isZh ? '请选择作业种类。' : 'Select a job kind.'
  for (const key of Object.keys(job)) {
    if (!JOB_KEYS.has(key)) return isZh ? `作业配置不支持字段「${key}」。` : `The job does not accept "${key}".`
  }
  if (typeof job.kind !== 'string' || !INTEGRATION_RUN_FINISHED_JOB_KINDS.includes(job.kind)) {
    return isZh ? '请选择作业种类（备料拉取或管道）。' : 'Select a job kind (stock-prep pull or pipeline).'
  }
  if (job.kind === 'pipeline') {
    if (job.actionId !== undefined) return isZh ? '管道作业不使用动作 ID。' : 'A pipeline job takes no action id.'
    if (typeof job.pipelineId !== 'string' || !JOB_ID_SHAPE.test(job.pipelineId)) {
      return isZh ? '管道作业需要管道 ID（字母、数字及 _ : . -）。' : 'A pipeline job needs its pipeline id (letters, digits, _ : . -).'
    }
  } else {
    if (job.pipelineId !== undefined) return isZh ? '备料拉取作业不使用管道 ID。' : 'A stock-prep pull job takes no pipeline id.'
    if (job.actionId !== undefined && (typeof job.actionId !== 'string' || !JOB_ID_SHAPE.test(job.actionId))) {
      return isZh ? '动作 ID 只能由字母、数字及 _ : . - 组成。' : 'The action id may only contain letters, digits, _ : . -.'
    }
  }
  if (config.statuses !== undefined) {
    if (!Array.isArray(config.statuses) || config.statuses.length === 0) {
      return isZh ? '请至少选择一个告警状态。' : 'Select at least one status to alert on.'
    }
    const seen = new Set<string>()
    for (const status of config.statuses) {
      if (typeof status !== 'string' || !INTEGRATION_RUN_FINISHED_STATUS_OPTIONS.includes(status)) {
        return isZh ? '告警状态不在允许范围内。' : 'A selected status is not allowed.'
      }
      if (seen.has(status)) return isZh ? '告警状态不能重复。' : 'A status is selected twice.'
      seen.add(status)
    }
  }
  return ''
}

/** The whole-rule mirror: the config, then no conditions, then side-effect actions only. */
export function integrationRunFinishedRuleBlockReason(input: {
  triggerType: string
  triggerConfig: unknown
  conditionsCount: number
  actionTypes: readonly string[]
  isZh: boolean
  actionLabel: (type: string) => string
}): string {
  if (input.triggerType !== INTEGRATION_RUN_FINISHED_TRIGGER_TYPE) return ''
  const configError = integrationRunFinishedConfigError(input.triggerConfig, input.isZh)
  if (configError) return configError
  if (input.conditionsCount > 0) {
    return input.isZh ? '集成作业完成触发器不支持触发条件，请先移除所有条件。' : 'The integration run trigger does not support conditions — remove them first.'
  }
  const disallowed = input.actionTypes.find((type) => !INTEGRATION_RUN_FINISHED_ALLOWED_ACTION_TYPES.has(type))
  if (disallowed) {
    const label = input.actionLabel(disallowed)
    return input.isZh
      ? `动作「${label}」不可用于集成作业完成触发器（仅支持通知类动作）。`
      : `Action "${label}" is not allowed on the integration run trigger (notification-family actions only).`
  }
  return ''
}

/** The persisted shape the editor sends: the closed job + statuses (when chosen). The server stamps the binding. */
export function normalizeIntegrationRunFinishedTriggerConfig(config: Record<string, unknown>): Record<string, unknown> {
  const job = isRecord(config.job) ? config.job : {}
  const kind = typeof job.kind === 'string' ? job.kind : ''
  const outJob: Record<string, unknown> = { kind }
  if (kind === 'pipeline') {
    outJob.pipelineId = typeof job.pipelineId === 'string' ? job.pipelineId.trim() : ''
  } else if (typeof job.actionId === 'string' && job.actionId.trim()) {
    outJob.actionId = job.actionId.trim()
  }
  const out: Record<string, unknown> = { job: outJob }
  if (Array.isArray(config.statuses) && config.statuses.length > 0) {
    out.statuses = INTEGRATION_RUN_FINISHED_STATUS_OPTIONS.filter((status) => (config.statuses as unknown[]).includes(status))
  }
  return out
}

/**
 * The ADR §4.3 alert template: a DingTalk group message whose title and body read ONLY `run.*` (the closed,
 * values-free event). The rule's group destination is still chosen by the author (bound per sheet + creator).
 */
export const INTEGRATION_RUN_FINISHED_ALERT_TEMPLATE = Object.freeze({
  actionType: 'send_dingtalk_group_message',
  titleTemplate: '集成作业 {{run.job.kind}} {{run.job.projectNo}}{{run.job.pipelineId}}：{{run.status}}',
  bodyTemplate: [
    '状态：{{run.status}}（{{run.reason}}{{run.errorClass}}）',
    '计数：读取 {{run.counts.read}} / 清洗 {{run.counts.cleaned}} / 写入 {{run.counts.written}} / 失败 {{run.counts.failed}}',
    '决策：新增 {{run.counts.add}} / 更新 {{run.counts.update}} / 跳过 {{run.counts.skip}} / 停用 {{run.counts.inactive}} / 待人工确认 {{run.counts.manual_confirm}}，可应用：{{run.canApply}}',
    '耗时：{{run.durationMs}} ms，尝试 {{run.attempts}} 次',
  ].join('\n'),
})

/** Every `{{…}}` variable the template uses — pinned to the `run.*` namespace by the web spec. */
export function integrationRunFinishedTemplateVariables(): string[] {
  const text = `${INTEGRATION_RUN_FINISHED_ALERT_TEMPLATE.titleTemplate}\n${INTEGRATION_RUN_FINISHED_ALERT_TEMPLATE.bodyTemplate}`
  return [...text.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1])
}
