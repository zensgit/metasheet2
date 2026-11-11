/**
 * R-69 1b-iii — rule-editor support for the `run_integration_job` automation action (design baseline v2.3
 * §10.2.4 1b-iii row; ADR adr-automation-pipeline-bridge-20261103 §3.1, §7, PR 1b-iii). R-69 is OPEN: dry-run
 * only, default OFF, not for merge until the owner rules.
 *
 * PURE MODULE: no runtime import (no Vue, no store, no labels module). That is load-bearing: the server/client
 * parity test (packages/core-backend/tests/unit/automation-run-integration-job-web-parity.test.ts) imports THIS
 * file live next to the server's save validator and asserts byte-identical answers on a case table, so a drift on
 * either side goes red.
 *
 * Three parts:
 *   1. The SAVE-VALIDATION MIRROR of packages/core-backend/src/multitable/automation-run-integration-job.ts
 *      (`validateRunIntegrationJobConfig`, `validateRunIntegrationJobTriggerCoupling`, the timeout constants of
 *      automation-job-lease.ts). Same branch order, same strings. The editor only authors the dry-run shape;
 *      the mirror exists so a refusal is an inline "why can't I save" line, not an opaque 400.
 *      1b (R-69 I6d) adds the count half of the server's rule-sheet guard: EXACTLY ONE project per rule
 *      (RUN_INTEGRATION_JOB_EDITOR_MAX_PROJECTS) — the editor's project limit; the mirror's 20 is not.
 *      1c (R-69 I6d fix round 2, F2) mirrors the server's validateRunIntegrationJobSoleAction: the job is its rule's
 *      ONLY action.
 *   2. Draft <-> config helpers for the editor (project list text, timeout in minutes).
 *   3. The VALUES-FREE step-result view: the executor's `output.outcome` / `output.reason` vocabulary
 *      (automation-executor.ts runIntegrationJobStep / runIntegrationJobUnit, plugin lib/integration-run-port.cjs)
 *      as sentences; `scopeKey` (it carries the tenant id) and any raw JSON are never rendered.
 */

export const RUN_INTEGRATION_JOB_ACTION_TYPE = 'run_integration_job'

// ── 1. Save-validation mirror (server: automation-run-integration-job.ts + automation-job-lease.ts) ───────────

/**
 * The PURE validator's cap, equal to the server's by the parity test. NOT the editor's project limit: the server's
 * rule-sheet guard then requires exactly one project — see RUN_INTEGRATION_JOB_EDITOR_MAX_PROJECTS (part 1b).
 */
export const RUN_INTEGRATION_JOB_MAX_PROJECTS = 20
export const RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS = 1_000
export const RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS = 55 * 60_000
export const RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS = 30 * 60_000
/** Closed job kinds (ADR §3.6). `pipeline` is part of the vocabulary but refused at save in this slice. */
export const RUN_INTEGRATION_JOB_KINDS: readonly string[] = Object.freeze(['stock_prep_pull', 'pipeline'])
/** Closed apply modes. Only `dry_run_only` is accepted; `apply_when_ready` is refused whatever any switch says. */
export const RUN_INTEGRATION_JOB_APPLY_MODES: readonly string[] = Object.freeze(['dry_run_only', 'apply_when_ready'])
/** The only kind / apply mode the editor authors. */
export const RUN_INTEGRATION_JOB_AUTHORABLE_KIND = 'stock_prep_pull'
export const RUN_INTEGRATION_JOB_AUTHORABLE_APPLY_MODE = 'dry_run_only'
/** The only trigger a rule carrying this action may use. */
export const RUN_INTEGRATION_JOB_TRIGGER_TYPE = 'schedule.cron'

const CONFIG_KEYS: readonly string[] = ['job', 'timeoutMs', 'binding', 'retry']
const STOCK_PREP_JOB_KEYS: readonly string[] = ['kind', 'projectNos', 'applyMode', 'actionId']
const PIPELINE_JOB_KEYS: readonly string[] = ['kind', 'pipelineId', 'dryRun', 'mode', 'pipelineFingerprint']
const PROJECT_NO_SHAPE = /^[!-~]{1,128}$/
/** Mirror of the server's RUN_INTEGRATION_JOB_ACTION_ID_SHAPE (R-69 1c: the shape every run summary carries). */
const ACTION_ID_SHAPE = /^[A-Za-z0-9_:.-]{1,128}$/

/** Closed codes for the editor's localized save-block line; the `message` is the server's string. */
export type RunIntegrationJobConfigErrorCode =
  | 'not_object'
  | 'unknown_key'
  | 'retry_reserved'
  | 'job_required'
  | 'kind'
  | 'pipeline_key'
  | 'pipeline_dry_run'
  | 'pipeline_not_deliverable'
  | 'stock_prep_key'
  | 'apply_mode'
  | 'apply_when_ready'
  | 'projects_empty'
  | 'projects_too_many'
  | 'project_shape'
  | 'project_repeat'
  | 'action_id'
  | 'timeout_integer'
  | 'timeout_min'
  | 'timeout_max'

export type RunIntegrationJobCouplingErrorCode = 'trigger_not_cron' | 'timezone_required' | 'timezone_invalid'

export interface RunIntegrationJobCheck<C extends string> {
  code: C
  /** Byte-identical to the server's 400 message for the same input and `path`. */
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structured mirror of the server's validateRunIntegrationJobConfig: the first failing check, or null. */
export function checkRunIntegrationJobConfig(config: unknown, path: string): RunIntegrationJobCheck<RunIntegrationJobConfigErrorCode> | null {
  const fail = (code: RunIntegrationJobConfigErrorCode, message: string) => ({ code, message })
  if (!isRecord(config)) return fail('not_object', `${path} must be an object`)
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(key)) return fail('unknown_key', `${path}.${key} is not an accepted key (accepted: job, timeoutMs)`)
  }
  if (config.retry !== undefined) {
    return fail('retry_reserved', `${path}.retry is reserved: bounded retry (ADR §5) is not delivered in this slice; omit it`)
  }
  const job = config.job
  if (!isRecord(job)) return fail('job_required', `${path}.job is required`)
  if (typeof job.kind !== 'string' || !RUN_INTEGRATION_JOB_KINDS.includes(job.kind)) {
    return fail('kind', `${path}.job.kind must be one of stock_prep_pull, pipeline`)
  }
  if (job.kind === 'pipeline') {
    for (const key of Object.keys(job)) {
      if (!PIPELINE_JOB_KEYS.includes(key)) return fail('pipeline_key', `${path}.job.${key} is not an accepted key for kind pipeline`)
    }
    if (job.dryRun !== true) return fail('pipeline_dry_run', `${path}.job.dryRun must be true (non-dry pipeline runs are not deliverable here; ADR Q12b)`)
    return fail('pipeline_not_deliverable', `${path}.job.kind 'pipeline' is not deliverable in this slice (its server-recomputed pipelineFingerprint cannot be derived yet); only stock_prep_pull is accepted`)
  }
  for (const key of Object.keys(job)) {
    if (!STOCK_PREP_JOB_KEYS.includes(key)) return fail('stock_prep_key', `${path}.job.${key} is not an accepted key for kind stock_prep_pull`)
  }
  if (typeof job.applyMode !== 'string' || !RUN_INTEGRATION_JOB_APPLY_MODES.includes(job.applyMode)) {
    return fail('apply_mode', `${path}.job.applyMode must be dry_run_only`)
  }
  if (job.applyMode !== 'dry_run_only') {
    return fail('apply_when_ready', `${path}.job.applyMode 'apply_when_ready' is not accepted (unattended apply is an owner decision; ADR Q12a) — only dry_run_only`)
  }
  if (!Array.isArray(job.projectNos) || job.projectNos.length === 0) return fail('projects_empty', `${path}.job.projectNos must be a non-empty array`)
  if (job.projectNos.length > RUN_INTEGRATION_JOB_MAX_PROJECTS) {
    return fail('projects_too_many', `${path}.job.projectNos must list at most ${RUN_INTEGRATION_JOB_MAX_PROJECTS} projects`)
  }
  const seen = new Set<string>()
  for (const projectNo of job.projectNos) {
    if (typeof projectNo !== 'string' || !PROJECT_NO_SHAPE.test(projectNo)) {
      return fail('project_shape', `${path}.job.projectNos entries must be non-blank strings (1..128 visible ASCII characters)`)
    }
    // Mirror of the server (R-69 1c, I5 ruling N2): the run summary refuses a projectNo containing '://'.
    if (projectNo.includes('://')) return fail('project_shape', `${path}.job.projectNos entries must not contain "://" (a project number is never a URL)`)
    if (seen.has(projectNo)) return fail('project_repeat', `${path}.job.projectNos must not repeat a project`)
    seen.add(projectNo)
  }
  if (job.actionId !== undefined && (typeof job.actionId !== 'string' || !ACTION_ID_SHAPE.test(job.actionId))) {
    return fail('action_id', `${path}.job.actionId must be an identifier when present (1..128 of A-Z a-z 0-9 _ : . -)`)
  }
  if (config.timeoutMs !== undefined) {
    const timeoutMs = config.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) return fail('timeout_integer', `${path}.timeoutMs must be an integer number of milliseconds`)
    if (timeoutMs < RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS) return fail('timeout_min', `${path}.timeoutMs must be at least ${RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS}`)
    if (timeoutMs > RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS) {
      return fail('timeout_max', `${path}.timeoutMs must be at most ${RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS} (55 minutes; the intent lease is capped at 1 hour)`)
    }
  }
  return null
}

/** Same signature and answers as the server's validateRunIntegrationJobConfig. */
export function validateRunIntegrationJobConfig(config: unknown, path: string): string | null {
  return checkRunIntegrationJobConfig(config, path)?.message ?? null
}

/** Mirror of the server's isValidIanaTimeZone (automation-timezone.ts): the platform Intl decides. */
export function isValidIanaTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).format(0)
    return true
  } catch {
    return false
  }
}

/** Structured mirror of the server's validateRunIntegrationJobTriggerCoupling. */
export function checkRunIntegrationJobTriggerCoupling(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
): RunIntegrationJobCheck<RunIntegrationJobCouplingErrorCode> | null {
  if (triggerType !== 'schedule.cron') {
    return { code: 'trigger_not_cron', message: `run_integration_job (stock_prep_pull) is only allowed on a schedule.cron trigger (got ${triggerType})` }
  }
  const timezone = isRecord(triggerConfig) && typeof triggerConfig.timezone === 'string' ? triggerConfig.timezone.trim() : ''
  if (!timezone) return { code: 'timezone_required', message: 'run_integration_job rules must declare triggerConfig.timezone (an IANA timezone; the cron runs in it)' }
  if (!isValidIanaTimeZone(timezone)) return { code: 'timezone_invalid', message: `run_integration_job rules need a valid IANA triggerConfig.timezone (got ${timezone})` }
  return null
}

/** Same signature and answers as the server's validateRunIntegrationJobTriggerCoupling. */
export function validateRunIntegrationJobTriggerCoupling(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
): string | null {
  return checkRunIntegrationJobTriggerCoupling(triggerType, triggerConfig)?.message ?? null
}

// ── 1b. The rule-sheet guard's project-count half (server: automation-run-integration-job-rule-sheet.ts) ────────

/**
 * R-69 I6a / register R-90 (1): a stock_prep_pull rule lists EXACTLY ONE project — the project its own sheet is
 * registered to (the project-sheet registry has UNIQUE(sheet_id): one sheet is one project's). The server refuses
 * anything else at save in its rule-sheet guard (checkRunIntegrationJobRuleSheet: `projectNos.length !== 1` ⇒
 * project_mismatch), which runs AFTER the pure validator mirrored above. That validator's own cap stays
 * RUN_INTEGRATION_JOB_MAX_PROJECTS on both sides (byte parity is pinned, and the executor's re-parse of a stored
 * config reuses it), so THIS number — not that one — is the editor's project limit: with the mirror's "non-empty" it
 * is "exactly one". It is the half of the guard a client can decide without the registry; WHICH project the sheet is
 * registered to stays the server's answer. Pinned against the live server guard by the core-backend web-parity test.
 */
export const RUN_INTEGRATION_JOB_EDITOR_MAX_PROJECTS = 1

/** Byte-identical to the server's RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES.project_mismatch. */
export const RUN_INTEGRATION_JOB_PROJECT_MISMATCH_MESSAGE =
  "run_integration_job (stock_prep_pull) rules must list exactly one project, the sheet's registered project; the rule was not saved"

export type RunIntegrationJobRuleSheetErrorCode = 'projects_not_single'

/**
 * The count half of the server's rule-sheet guard, for a config the pure mirror accepted: null, or the refusal the
 * server answers for a rule that lists more than one project. (No project at all is the mirror's `projects_empty`.)
 */
export function checkRunIntegrationJobRuleSheetProjects(config: unknown): RunIntegrationJobCheck<RunIntegrationJobRuleSheetErrorCode> | null {
  const job = isRecord(config) && isRecord(config.job) ? config.job : null
  const projectNos = job && Array.isArray(job.projectNos) ? job.projectNos : []
  if (projectNos.length <= RUN_INTEGRATION_JOB_EDITOR_MAX_PROJECTS) return null
  return { code: 'projects_not_single', message: RUN_INTEGRATION_JOB_PROJECT_MISMATCH_MESSAGE }
}

// ── 1c. The job is its rule's only action (server: automation-run-integration-job.ts) ──────────────────────────

/** Byte-identical to the server's RUN_INTEGRATION_JOB_NOT_SOLE_ERROR. */
export const RUN_INTEGRATION_JOB_NOT_SOLE_MESSAGE =
  'run_integration_job must be the only action of its rule (no other action before it, after it or beside it)'

export type RunIntegrationJobSoleActionErrorCode = 'not_sole_action'

/**
 * R-69 I6d fix round 2 (F2) — structured mirror of the server's validateRunIntegrationJobSoleAction: a rule that
 * carries the job at the top level is one of exactly two shapes — (A) the legacy pair is the job and `actions` is
 * absent / null / empty, or (B) the pair is the job and `actions` is exactly `[the job]` (what this editor sends: the
 * action list, with `actions[0]` mirrored into the pair). Anything else that carries the job is refused; judged on
 * the raw list length. null for an accepted shape and for a rule that does not carry the job at the top level.
 * Same branch order as the server; byte parity pinned by the core-backend web-parity test.
 */
export function checkRunIntegrationJobSoleAction(
  actionType: string,
  actions: readonly unknown[] | null | undefined,
): RunIntegrationJobCheck<RunIntegrationJobSoleActionErrorCode> | null {
  const list = Array.isArray(actions) ? actions : []
  const pairIsJob = actionType === RUN_INTEGRATION_JOB_ACTION_TYPE
  const jobsInList = list.filter((action) => isRecord(action) && action.type === RUN_INTEGRATION_JOB_ACTION_TYPE).length
  if (!pairIsJob && jobsInList === 0) return null
  if (pairIsJob && list.length === 0) return null
  if (pairIsJob && list.length === 1 && jobsInList === 1) return null
  return { code: 'not_sole_action', message: RUN_INTEGRATION_JOB_NOT_SOLE_MESSAGE }
}

/** Same signature and answers as the server's validateRunIntegrationJobSoleAction. */
export function validateRunIntegrationJobSoleAction(actionType: string, actions: readonly unknown[] | null | undefined): string | null {
  return checkRunIntegrationJobSoleAction(actionType, actions)?.message ?? null
}

// ── 2. Editor draft <-> config ───────────────────────────────────────────────────────────────────────────────

/** The editor's draft keys for this action (UI only; buildRunIntegrationJobConfig turns them into the config). */
export interface RunIntegrationJobDraft {
  rijKind: string
  /**
   * The project number. A saveable rule has exactly one (part 1b); a LOADED config with several is shown whole, one
   * per line (commas also separate) — never truncated — and blocks save until one is left.
   */
  rijProjectNosText: string
  /** Whole minutes as typed; the config carries milliseconds. */
  rijTimeoutMinutes: number | string | null
  /** Preserved from a loaded config; never authored. */
  rijActionId?: string
}

export const RUN_INTEGRATION_JOB_TIMEOUT_MAX_MINUTES = RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS / 60_000
export const RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MINUTES = RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS / 60_000

export function defaultRunIntegrationJobDraft(): RunIntegrationJobDraft {
  return {
    rijKind: RUN_INTEGRATION_JOB_AUTHORABLE_KIND,
    rijProjectNosText: '',
    rijTimeoutMinutes: RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MINUTES,
  }
}

/** A loaded config → draft. The stamped `binding` is not carried: the server re-stamps it on every save. */
export function runIntegrationJobDraftFromConfig(config: Record<string, unknown> | null | undefined): RunIntegrationJobDraft {
  const job = isRecord(config) && isRecord(config.job) ? config.job : {}
  const projectNos = Array.isArray(job.projectNos) ? job.projectNos.filter((entry): entry is string => typeof entry === 'string') : []
  const timeoutMs = isRecord(config) && typeof config.timeoutMs === 'number' ? config.timeoutMs : RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS
  const draft: RunIntegrationJobDraft = {
    rijKind: typeof job.kind === 'string' ? job.kind : RUN_INTEGRATION_JOB_AUTHORABLE_KIND,
    rijProjectNosText: projectNos.join('\n'),
    rijTimeoutMinutes: timeoutMs / 60_000,
  }
  if (typeof job.actionId === 'string') draft.rijActionId = job.actionId
  return draft
}

/** Project list text → array: split on line breaks and commas, trim, drop blanks. Order kept, repeats kept. */
export function parseRunIntegrationJobProjectNos(text: unknown): string[] {
  if (typeof text !== 'string') return []
  return text.split(/[\r\n,，]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/** Minutes as typed → milliseconds (a non-number stays a non-number so the mirror refuses it). */
function minutesToMs(minutes: unknown): unknown {
  if (minutes === null || minutes === undefined || minutes === '') return RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS
  const value = typeof minutes === 'number' ? minutes : Number(String(minutes).trim())
  if (!Number.isFinite(value)) return String(minutes)
  return Math.round(value * 60_000 * 1000) / 1000
}

/**
 * The config the editor SENDS: `{ job: { kind, projectNos, applyMode: 'dry_run_only', actionId? }, timeoutMs }`.
 * No `binding` (server-stamped from the rule's creator) and no `retry` (reserved). The kind is whatever the draft
 * holds, so a loaded non-authorable kind still reaches the mirror and blocks save instead of being rewritten.
 */
export function buildRunIntegrationJobConfig(draft: Partial<RunIntegrationJobDraft> | Record<string, unknown>): Record<string, unknown> {
  const job: Record<string, unknown> = {
    kind: typeof draft.rijKind === 'string' && draft.rijKind ? draft.rijKind : RUN_INTEGRATION_JOB_AUTHORABLE_KIND,
    projectNos: parseRunIntegrationJobProjectNos(draft.rijProjectNosText),
    applyMode: RUN_INTEGRATION_JOB_AUTHORABLE_APPLY_MODE,
  }
  if (typeof draft.rijActionId === 'string') job.actionId = draft.rijActionId
  return { job, timeoutMs: minutesToMs(draft.rijTimeoutMinutes) }
}

/**
 * Whether the editor offers the action for a NEW selection. Same posture as the FWB action: a loaded action of
 * this type always stays in the option list (never silently dropped); a new one needs the server switch ON
 * (session feature `integrationAutomationRunAction`, from INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED) and a
 * schedule.cron trigger.
 * R-69 I6d fix round 2 (F2): the job is its rule's ONLY action, so a new selection also needs the rule to have
 * exactly one action row — the one being changed (`actionCount`, the rule's number of top-level actions).
 */
export function isRunIntegrationJobSelectable(switchOn: boolean, triggerType: string, currentType: string, actionCount = 1): boolean {
  if (currentType === RUN_INTEGRATION_JOB_ACTION_TYPE) return true
  return switchOn === true && triggerType === RUN_INTEGRATION_JOB_TRIGGER_TYPE && actionCount === 1
}

// ── 3. Values-free step-result view (executor output.outcome / output.reason) ─────────────────────────────

/** RunIntegrationJobOutcome (automation-executor.ts) = IntegrationRunStatus ∪ outcome_unknown. */
export const RUN_INTEGRATION_JOB_STEP_OUTCOMES: readonly string[] = Object.freeze([
  'succeeded', 'held', 'partial', 'skipped', 'not_started', 'failed', 'outcome_unknown',
])

const OUTCOME_LABELS: Record<string, { zh: string; en: string }> = {
  succeeded: { zh: '成功（仅预演）', en: 'Succeeded (dry run)' },
  held: { zh: '待人工处理', en: 'Held for a person' },
  partial: { zh: '部分完成', en: 'Partial' },
  skipped: { zh: '已跳过', en: 'Skipped' },
  not_started: { zh: '未开始', en: 'Not started' },
  failed: { zh: '失败', en: 'Failed' },
  outcome_unknown: { zh: '结果未知', en: 'Outcome unknown' },
}

/**
 * Every closed reason code the executor and the plugin port write (read from I3's code, byte-for-byte; pinned by
 * apps/web/tests/multitable-run-integration-job-editor.spec.ts against the source text). Bounded error classes
 * (`errorClass` from the port, an error code / name) are open by design and render as the code itself.
 */
export const RUN_INTEGRATION_JOB_REASON_LABELS: Readonly<Record<string, { zh: string; en: string }>> = Object.freeze({
  // executor, step level
  action_disabled: { zh: '动作开关未开启', en: 'the action switch is off' },
  config_invalid: { zh: '保存的配置无效', en: 'the saved configuration is invalid' },
  identity_required: { zh: '缺少执行身份', en: 'no execution identity' },
  principal_unauthorized: { zh: '绑定的身份无权运行', en: 'the bound principal is not authorized' },
  port_inactive: { zh: '集成插件未就绪', en: 'the integration plugin is not ready' },
  transaction_seam_required: { zh: '执行环境不完整', en: 'the execution environment is incomplete' },
  authority_unavailable: { zh: '暂时无法核验权限', en: 'authorization could not be checked' },
  no_units: { zh: '没有可运行的项目', en: 'no project to run' },
  // executor, per project
  already_applied: { zh: '此前已完成', en: 'already done earlier' },
  inflight_lease: { zh: '上一次运行仍在进行', en: 'a previous run is still in flight' },
  prior_outcome_unknown: { zh: '上一次运行结果未知', en: 'a previous run has an unknown outcome' },
  busy: { zh: '同一项目正被另一任务占用', en: 'another job holds this project' },
  lease_lost: { zh: '任务租约已丢失', en: 'the job lease was lost' },
  terminal_write_unconfirmed: { zh: '结果写入未确认', en: 'the result write was not confirmed' },
  timeout_unsettled: { zh: '超时且尚未结束', en: 'timed out and not yet settled' },
  timeout: { zh: '超时', en: 'timed out' },
  shutdown: { zh: '服务关闭', en: 'the server shut down' },
  aborted: { zh: '已中止', en: 'aborted' },
  // plugin port (lib/integration-run-port.cjs)
  ready: { zh: '预演就绪', en: 'dry run ready' },
  manual_confirm_required: { zh: '需人工确认', en: 'manual confirmation required' },
  suspended: { zh: '已暂停', en: 'suspended' },
  large_bom_bounded: { zh: 'BOM 过大，已限量', en: 'BOM too large, bounded' },
  review_pending: { zh: '变更待复核', en: 'a written change awaits review' },
  pull_batch_installing: { zh: '批次列安装中', en: 'batch columns are being installed' },
  not_found: { zh: '源系统中未找到该项目', en: 'project not found in the source' },
  project_absent: { zh: '项目不存在', en: 'project absent' },
  project_archived: { zh: '项目已归档', en: 'project archived' },
})

/** An open error class renders only when it has the bounded class shape; anything else is "other". */
const OPEN_CLASS_SHAPE = /^[A-Za-z0-9_:.-]{1,80}$/

function lang(isZh: boolean, label: { zh: string; en: string }): string {
  return isZh ? label.zh : label.en
}

export function runIntegrationJobOutcomeLabel(outcome: unknown, isZh: boolean): string {
  if (typeof outcome === 'string' && OUTCOME_LABELS[outcome]) return lang(isZh, OUTCOME_LABELS[outcome])
  return isZh ? '未知状态' : 'unknown status'
}

export function runIntegrationJobReasonLabel(reason: unknown, isZh: boolean): string {
  if (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(RUN_INTEGRATION_JOB_REASON_LABELS, reason)) {
    return lang(isZh, RUN_INTEGRATION_JOB_REASON_LABELS[reason])
  }
  if (typeof reason === 'string' && OPEN_CLASS_SHAPE.test(reason)) return reason
  return isZh ? '其他' : 'other'
}

/** "结果未知（超时且尚未结束）" / "Outcome unknown (timed out and not yet settled)". */
export function runIntegrationJobOutcomeText(outcome: unknown, reason: unknown, isZh: boolean): string {
  const head = runIntegrationJobOutcomeLabel(outcome, isZh)
  if (reason === undefined || reason === null || reason === '' || reason === outcome) return head
  return isZh ? `${head}（${runIntegrationJobReasonLabel(reason, isZh)}）` : `${head} (${runIntegrationJobReasonLabel(reason, isZh)})`
}

export interface RunIntegrationJobUnitView {
  /** The configured project number (rule configuration, not source data). */
  projectNo: string | null
  text: string
  /** Integer counts from the values-free summary, e.g. "read 12 · failed 0". */
  counts: string
}

export interface RunIntegrationJobStepView {
  /** One line for the step. */
  text: string
  units: RunIntegrationJobUnitView[]
}

function countsText(summary: unknown): string {
  if (!isRecord(summary) || !isRecord(summary.counts)) return ''
  return Object.entries(summary.counts)
    .filter(([key, value]) => typeof value === 'number' && Number.isInteger(value) && /^[A-Za-z0-9_:-]{1,64}$/.test(key))
    .map(([key, value]) => `${key} ${value}`)
    .join(' · ')
}

/**
 * The step's output as sentences. Reads only `outcome`, `reason`, and per unit `projectNo` / `outcome` /
 * `reason` / `summary.counts`. Never `scopeKey` (it carries the tenant id), never `runId`, never raw JSON.
 * Returns null when the output does not carry the executor's shape.
 */
export function runIntegrationJobStepView(output: unknown, isZh: boolean): RunIntegrationJobStepView | null {
  if (!isRecord(output) || typeof output.outcome !== 'string') return null
  const units = Array.isArray(output.units) ? output.units.filter(isRecord) : []
  return {
    text: runIntegrationJobOutcomeText(output.outcome, output.reason, isZh),
    units: units.map((unit) => ({
      projectNo: typeof unit.projectNo === 'string' && PROJECT_NO_SHAPE.test(unit.projectNo) ? unit.projectNo : null,
      text: runIntegrationJobOutcomeText(unit.outcome, unit.reason, isZh),
      counts: countsText(unit.summary),
    })),
  }
}
