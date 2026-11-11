/**
 * R-69 1b-ii — `run_integration_job`: switches, config vocabulary and the SAVE-TIME validator (design baseline
 * v2.3 §10.2.2 ②, §10.2.4 1b-ii rows; ADR adr-automation-pipeline-bridge-20261103 §3.1, §3.5, §3.6, §6.1, §7).
 * R-69 is OPEN: dry-run only, default OFF, not for merge until the owner rules.
 *
 * FOUR SWITCHES (ADR §7), all registered in scripts/ops/global-history-flag-manifest.mjs, all default OFF and
 * exact-literal `'true'`:
 *   - INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED — READ here (save) and by the executor (every trigger). Off:
 *     saving a rule that carries the action is refused with RUN_ACTION_DISABLED; an existing rule's trigger
 *     records `skipped(action_disabled)`, never a silent success.
 *   - INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED — Bridge 2 (1c). Not read in 1b-ii; READ by 1c at its three
 *     points (core/integration-run-events.ts: the action layer before it emits and core on receipt; the plugin
 *     before it publishes).
 *   - INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED — unattended apply (owner layer, ADR Q12a). NOT READ in 1b-ii:
 *     `applyMode: 'apply_when_ready'` is a 400 at save whatever the switch says.
 *   - INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED — unattended non-dry pipeline runs (ADR Q12b). NOT READ
 *     in 1b-ii: the `pipeline` kind itself is refused at save in this slice.
 * The three unread names exist so an early switch flip can never create a saveable-but-unimplemented rule
 * (ADR §3.1): the switch is registered, the path is absent, and the save validator says so.
 *
 * THE VALIDATOR is pure (no DB): closed key set, closed `job.kind`, projectNos ≤ 20 distinct non-blank, applyMode
 * only `dry_run_only`, timeoutMs ≤ 55 min (default 30 min), `retry` reserved, client `binding` dropped. The
 * service stamps `binding` from `created_by` + its single active `user_orgs` row and enforces the trigger
 * coupling (schedule.cron only, IANA timezone REQUIRED) — see AutomationService.assertRunIntegrationJobAtSave.
 */
import { randomUUID } from 'node:crypto'

import type { AutomationAction } from './automation-actions'
import { RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS, RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS } from './automation-job-lease'
import { isValidIanaTimeZone } from './automation-timezone'

export const RUN_INTEGRATION_JOB_ACTION_TYPE = 'run_integration_job'

/** The ONE switch 1b-ii reads. Exact literal only — mirrors isClassBOutboundEnabled. */
export function isIntegrationAutomationRunActionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED === 'true'
}

/**
 * Registered in the flag manifest, NOT read by any 1b-ii code path (ADR §7). Listed here by name so the
 * manifest's source scan sees the registration is deliberate; a read point for any of them is a later slice.
 * R-69 1c: INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED left this list — it is READ now (core/integration-run-events.ts
 * isIntegrationAutomationRunEventEnabled, the plugin's lib/integration-run-events.cjs before publish).
 */
export const INTEGRATION_AUTOMATION_RUN_FLAGS_NOT_READ_IN_1B_II = Object.freeze([
  'INTEGRATION_AUTOMATION_RUN_APPLY_ENABLED',
  'INTEGRATION_AUTOMATION_RUN_PIPELINE_WRITE_ENABLED',
] as const)

export const RUN_INTEGRATION_JOB_MAX_PROJECTS = 20
export const RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS = 1_000
/** ADR §7 / §3.6 closed vocabularies. */
export const RUN_INTEGRATION_JOB_KINDS: ReadonlySet<string> = new Set(['stock_prep_pull', 'pipeline'])
export const RUN_INTEGRATION_JOB_APPLY_MODES: ReadonlySet<string> = new Set(['dry_run_only', 'apply_when_ready'])
const CONFIG_KEYS: ReadonlySet<string> = new Set(['job', 'timeoutMs', 'binding', 'retry'])
const STOCK_PREP_JOB_KEYS: ReadonlySet<string> = new Set(['kind', 'projectNos', 'applyMode', 'actionId'])
const PIPELINE_JOB_KEYS: ReadonlySet<string> = new Set(['kind', 'pipelineId', 'dryRun', 'mode', 'pipelineFingerprint'])
const PROJECT_NO_SHAPE = /^[!-~]{1,128}$/
/**
 * R-69 1c (fix-I5): the job identifier shape — byte-identical to automation-triggers.ts INTEGRATION_RUN_JOB_ID_SHAPE
 * (pinned by tests/unit/automation-integration-run-finished.test.ts). The action's `actionId` rides in every
 * integration.run_finished summary, whose port refuses any other shape: a wider id here would have been accepted
 * at save and then dropped every summary of the job.
 */
export const RUN_INTEGRATION_JOB_ACTION_ID_SHAPE = /^[A-Za-z0-9_:.-]{1,128}$/

export interface RunIntegrationJobBinding {
  principalId: string
  tenantId: string
}

export interface NormalizedRunIntegrationJobConfig {
  job: { kind: 'stock_prep_pull'; projectNos: string[]; applyMode: 'dry_run_only'; actionId?: string }
  timeoutMs: number
  binding: RunIntegrationJobBinding
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pure config validation (ADR §3.1). Returns an error string (the save answers 400 with it) or null. `binding`
 * is ignored here on purpose: the service stamps it, whatever the client sent.
 */
export function validateRunIntegrationJobConfig(config: unknown, path: string): string | null {
  if (!isRecord(config)) return `${path} must be an object`
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) return `${path}.${key} is not an accepted key (accepted: job, timeoutMs)`
  }
  if (config.retry !== undefined) {
    return `${path}.retry is reserved: bounded retry (ADR §5) is not delivered in this slice; omit it`
  }
  const job = config.job
  if (!isRecord(job)) return `${path}.job is required`
  if (typeof job.kind !== 'string' || !RUN_INTEGRATION_JOB_KINDS.has(job.kind)) {
    return `${path}.job.kind must be one of stock_prep_pull, pipeline`
  }
  if (job.kind === 'pipeline') {
    for (const key of Object.keys(job)) {
      if (!PIPELINE_JOB_KEYS.has(key)) return `${path}.job.${key} is not an accepted key for kind pipeline`
    }
    if (job.dryRun !== true) return `${path}.job.dryRun must be true (non-dry pipeline runs are not deliverable here; ADR Q12b)`
    return `${path}.job.kind 'pipeline' is not deliverable in this slice (its server-recomputed pipelineFingerprint cannot be derived yet); only stock_prep_pull is accepted`
  }
  for (const key of Object.keys(job)) {
    if (!STOCK_PREP_JOB_KEYS.has(key)) return `${path}.job.${key} is not an accepted key for kind stock_prep_pull`
  }
  if (typeof job.applyMode !== 'string' || !RUN_INTEGRATION_JOB_APPLY_MODES.has(job.applyMode)) {
    return `${path}.job.applyMode must be dry_run_only`
  }
  if (job.applyMode !== 'dry_run_only') {
    return `${path}.job.applyMode 'apply_when_ready' is not accepted (unattended apply is an owner decision; ADR Q12a) — only dry_run_only`
  }
  if (!Array.isArray(job.projectNos) || job.projectNos.length === 0) return `${path}.job.projectNos must be a non-empty array`
  if (job.projectNos.length > RUN_INTEGRATION_JOB_MAX_PROJECTS) {
    return `${path}.job.projectNos must list at most ${RUN_INTEGRATION_JOB_MAX_PROJECTS} projects`
  }
  const seen = new Set<string>()
  for (const projectNo of job.projectNos) {
    if (typeof projectNo !== 'string' || !PROJECT_NO_SHAPE.test(projectNo)) {
      return `${path}.job.projectNos entries must be non-blank strings (1..128 visible ASCII characters)`
    }
    // R-69 1c (I5 ruling N2): the run summary refuses a projectNo containing '://' (core/integration-run-events.ts),
    // so a number saved with one would run and then drop its summary — refuse it here, as the actionId shape is.
    if (projectNo.includes('://')) return `${path}.job.projectNos entries must not contain "://" (a project number is never a URL)`
    if (seen.has(projectNo)) return `${path}.job.projectNos must not repeat a project`
    seen.add(projectNo)
  }
  if (job.actionId !== undefined && (typeof job.actionId !== 'string' || !RUN_INTEGRATION_JOB_ACTION_ID_SHAPE.test(job.actionId))) {
    return `${path}.job.actionId must be an identifier when present (1..128 of A-Z a-z 0-9 _ : . -)`
  }
  if (config.timeoutMs !== undefined) {
    const timeoutMs = config.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) return `${path}.timeoutMs must be an integer number of milliseconds`
    if (timeoutMs < RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS) return `${path}.timeoutMs must be at least ${RUN_INTEGRATION_JOB_TIMEOUT_MIN_MS}`
    if (timeoutMs > RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS) {
      return `${path}.timeoutMs must be at most ${RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS} (55 minutes; the intent lease is capped at 1 hour)`
    }
  }
  return null
}

/**
 * The persisted shape: validated config + server-stamped `binding` + defaulted `timeoutMs`. Client-supplied
 * `binding` is DROPPED (ADR §6.2: the same posture as `dataSourceOwnerId`). Call after validation passed.
 */
export function stampRunIntegrationJobConfig(config: Record<string, unknown>, binding: RunIntegrationJobBinding): NormalizedRunIntegrationJobConfig {
  const job = config.job as Record<string, unknown>
  const projectNos = [...(job.projectNos as string[])]
  const normalizedJob: NormalizedRunIntegrationJobConfig['job'] = { kind: 'stock_prep_pull', projectNos, applyMode: 'dry_run_only' }
  if (typeof job.actionId === 'string') normalizedJob.actionId = job.actionId
  return {
    job: normalizedJob,
    timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS,
    binding: { principalId: binding.principalId, tenantId: binding.tenantId },
  }
}

/**
 * Execute-time re-parse of the PERSISTED config (the executor trusts nothing it did not validate): the stamped
 * shape, with the binding present. Returns null on any drift — the step fails closed as `config_invalid`.
 */
export function parsePersistedRunIntegrationJobConfig(config: unknown): NormalizedRunIntegrationJobConfig | null {
  if (!isRecord(config)) return null
  if (validateRunIntegrationJobConfig({ job: config.job, ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}) }, 'config') !== null) return null
  const binding = config.binding
  if (!isRecord(binding) || typeof binding.principalId !== 'string' || !PROJECT_NO_SHAPE.test(binding.principalId)
    || typeof binding.tenantId !== 'string' || !PROJECT_NO_SHAPE.test(binding.tenantId)) return null
  return stampRunIntegrationJobConfig(config, { principalId: binding.principalId, tenantId: binding.tenantId })
}

/**
 * Trigger coupling (ADR §2 ⑦, Q9; baseline §10.2.2 ②): a rule carrying the action must be `schedule.cron` with a
 * PRESENT, valid IANA timezone (validateCronTriggerAtSave accepts an absent timezone for every other rule — the
 * cron would then fire in UTC, and 06:00 UTC is not the business-day 06:00). Pure.
 */
export function validateRunIntegrationJobTriggerCoupling(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
): string | null {
  if (triggerType !== 'schedule.cron') {
    return `run_integration_job (stock_prep_pull) is only allowed on a schedule.cron trigger (got ${triggerType})`
  }
  const timezone = isRecord(triggerConfig) && typeof triggerConfig.timezone === 'string' ? triggerConfig.timezone.trim() : ''
  if (!timezone) return 'run_integration_job rules must declare triggerConfig.timezone (an IANA timezone; the cron runs in it)'
  if (!isValidIanaTimeZone(timezone)) return `run_integration_job rules need a valid IANA triggerConfig.timezone (got ${timezone})`
  return null
}

/** Where the action appears in a rule: the legacy single-action pair and/or the top-level `actions` array. */
export interface RunIntegrationJobOccurrence {
  path: string
  config: Record<string, unknown>
}

const RUN_INTEGRATION_JOB_NESTED_ERROR = 'run_integration_job must be a top-level action (not inside a condition_branch / parallel_branch)'

/** The 400 message (code VALIDATION_ERROR, as the nested refusal) for a rule that carries the job AND anything else. Fixed text, values-free. */
export const RUN_INTEGRATION_JOB_NOT_SOLE_ERROR = 'run_integration_job must be the only action of its rule (no other action before it, after it or beside it)'

/**
 * R-69 I6d fix round 2 (F2; T-layer default) — THE JOB IS ITS RULE'S ONLY ACTION. A rule that carries
 * run_integration_job at the top level is stored in one of exactly two shapes:
 *   (A) the legacy pair is the job, and `actions` is absent, null or empty;
 *   (B) the legacy pair is the job, and `actions` is exactly `[the job]` — the rule editor's shape (it posts the
 *       action list and mirrors `actions[0]` into the pair).
 * Everything else that carries the job is refused: the job after or before another action, two jobs, the job in
 * `actions` under a pair that is another action, the job in the pair beside an `actions` list that holds anything
 * else. Judged on the RAW list length — an entry that is not an action is still an entry beside the job.
 *
 * Why (round-1 judge, F2): the executor stops a rule at its first failed step and marks the rest skipped at the
 * EXECUTION level — a job behind a failed step never reaches the step that emits its summary, so nothing alerts; and
 * a job behind a step that suspends (wait_for_callback, start_approval) would run when the execution is resumed,
 * at a time that is not the cron's. With the job alone, neither of those rules can be saved. The pair is required to
 * be the job too, so `action_type = 'run_integration_job'` names every job rule this gate lets a save store, and a
 * PATCH that re-types only the pair is refused instead of leaving a rule that still runs the job from `actions`.
 *
 * Pure; mirrored by the web editor (apps/web/src/multitable/runIntegrationJobAuthoring.ts
 * validateRunIntegrationJobSoleAction, byte parity pinned by tests/unit/automation-run-integration-job-web-parity.test.ts).
 * Returns the refusal, or null (also for a rule that does not carry the job at the top level at all).
 */
export function validateRunIntegrationJobSoleAction(actionType: string, actions: readonly unknown[] | null | undefined): string | null {
  const list = Array.isArray(actions) ? actions : []
  const pairIsJob = actionType === RUN_INTEGRATION_JOB_ACTION_TYPE
  const jobsInList = list.filter((action) => isRecord(action) && action.type === RUN_INTEGRATION_JOB_ACTION_TYPE).length
  if (!pairIsJob && jobsInList === 0) return null
  if (pairIsJob && list.length === 0) return null
  if (pairIsJob && list.length === 1 && jobsInList === 1) return null
  return RUN_INTEGRATION_JOB_NOT_SOLE_ERROR
}

/**
 * R-69 I6d — is the action carried inside a BRANCH LIST of this action config, at any depth? The branch lists are
 * `branches[*].actions[*]` and `defaultBranch.actions[*]`: the two lists the executor dispatches branch steps from
 * (automation-executor.ts executeConditionBranch / executeParallelBranch). Decided by POSITION only — the object's
 * identity says nothing (the service validates copies). Iterative, each object visited once: no recursion depth to
 * exhaust, and a config that is not an object, a list that is not a list or an entry that is not an action holds
 * nothing the executor could run.
 */
function branchListsCarryRunIntegrationJob(config: unknown): boolean {
  const pending: unknown[] = [config]
  const visited = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!isRecord(current) || visited.has(current)) continue
    visited.add(current)
    const lists: unknown[] = []
    if (Array.isArray(current.branches)) {
      for (const branch of current.branches) if (isRecord(branch)) lists.push(branch.actions)
    }
    if (isRecord(current.defaultBranch)) lists.push(current.defaultBranch.actions)
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const nested of list) {
        if (!isRecord(nested)) continue
        if (nested.type === RUN_INTEGRATION_JOB_ACTION_TYPE) return true
        pending.push(nested.config)
      }
    }
  }
  return false
}

/**
 * Every TOP-LEVEL occurrence of the action — the legacy pair (`actionConfig`) and each entry of the rule's `actions`
 * list (`actions[i].config`) — the refusal of every NESTED one and, fix round 2 (F2), the refusal of a rule in which
 * the job is not the ONLY action (validateRunIntegrationJobSoleAction). A nested occurrence answers the nested
 * message first.
 *
 * Top-level only, because the save gate's binding stamp and per-occurrence checks (closed config, the rule-sheet
 * guard) cover exactly those positions, and the job's lifecycle (lease, heartbeat, shutdown drain) is wired for
 * top-level steps. A nested occurrence would run with whatever `binding` its author wrote, and that binding's tenant
 * also routes the step's integration.run_finished summaries.
 *
 * R-69 I6d: NESTED is decided by POSITION, two independent ways, either one refusing:
 *   1. the walk — the action sits in a branch list (`branches[*].actions[*]` / `defaultBranch.actions[*]`, any depth)
 *      of the pair's config or of any `actions[i].config`, whatever that action's type (a superset of what the
 *      executor dispatches from: over-refusal is the fail-closed side);
 *   2. the flattening count — `allActions`, when given, is the service's own flattening of the same rule
 *      (collectNestedAutomationActions: every `actions[i]` plus every action it found nested). More occurrences
 *      there than at the top level of `actions` means the service knows a nesting this walk does not.
 * It was decided by object identity against `allActions` before, and the service always hands in COPIES — so every
 * `actions[]` occurrence, the shape the rule editor sends, was refused as nested. `allActions` null ⇒ only the walk.
 */
export function collectRunIntegrationJobOccurrences(
  actionType: string,
  actionConfig: Record<string, unknown> | null | undefined,
  actions: AutomationAction[] | null | undefined,
  allActions: AutomationAction[] | null | undefined,
): { occurrences: RunIntegrationJobOccurrence[]; error: string | null } {
  const occurrences: RunIntegrationJobOccurrence[] = []
  let nested = branchListsCarryRunIntegrationJob(actionConfig)
  if (actionType === RUN_INTEGRATION_JOB_ACTION_TYPE) {
    occurrences.push({ path: 'actionConfig', config: isRecord(actionConfig) ? actionConfig : {} })
  }
  let topLevelInActions = 0
  for (const [index, action] of (actions ?? []).entries()) {
    if (!action) continue
    if (action.type === RUN_INTEGRATION_JOB_ACTION_TYPE) {
      topLevelInActions += 1
      occurrences.push({ path: `actions[${index}].config`, config: isRecord(action.config) ? action.config : {} })
    }
    if (branchListsCarryRunIntegrationJob(action.config)) nested = true
  }
  if (Array.isArray(allActions)) {
    const flattened = allActions.filter((action) => action && action.type === RUN_INTEGRATION_JOB_ACTION_TYPE).length
    if (flattened > topLevelInActions) nested = true
  }
  // F2: a nested occurrence answers first (its message names the fix); otherwise the job must be the only action.
  return { occurrences, error: nested ? RUN_INTEGRATION_JOB_NESTED_ERROR : validateRunIntegrationJobSoleAction(actionType, actions) }
}

/** A fresh, opaque holder id for a job-lease claim (the executor uses the execution id + a suffix). */
export function jobLeaseHolderId(executionId: string): string {
  return `${executionId}:${randomUUID().slice(0, 8)}`
}
