/**
 * R-69 1c — Bridge 2: the `integration.run_finished` summary event and its PUBLISH port (ADR
 * adr-automation-pipeline-bridge-20261103 §4 / Q6; design baseline v2.3 §10.2 "两座桥" and §10.2.4 1c rows).
 * R-69 is OPEN: dry-run only, default OFF, not for merge until the owner rules.
 *
 * WHAT AN EVENT IS: exactly one VALUES-FREE summary per job (one project of a stock-prep pull, one pipeline run),
 * emitted once, after the final attempt, with a deterministic id. The key set is CLOSED at every level and every
 * string has a bounded identifier shape, so the payload cannot carry a row, a field value, a URL, a credential,
 * an error message body, a tenant id or a lease scope key (that key embeds the tenant id) — a publish with any
 * extra key is REFUSED, never trimmed.
 *
 * WHO PUBLISHES (ADR §4.2):
 *   - origin `plugin` — plugin-integration-core, after its pipeline runner's `finishRun` for runs triggered by
 *     `api` / `manual` / `replay` (eventId = the run id). The plugin may NOT publish `triggeredBy: 'automation'`:
 *     an automation-originated run is summarized by the core action layer only, so core refuses the duplicate
 *     here as well as the plugin not sending it (`AUTOMATION_ORIGIN_RESERVED`).
 *   - origin `automation` — the run_integration_job step (automation-executor.ts), once per project unit after
 *     the step's final result, eventId = sha256(JSON [rootExecutionId, executionId, actionKey, projectNo]).
 *
 * THE SWITCH `INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED` (exact literal 'true') is read at all three points the
 * ADR names: the plugin before it publishes, the action layer before it emits, and HERE on receipt — off ⇒
 * nothing is published or received; rules can be saved but never fire.
 *
 * ROUTING CONTEXT: the run's tenant travels BESIDE the event (`route.tenantId`), never inside it. The sink uses it
 * only to select the rules whose server-stamped binding tenant matches; it is never handed to a rule.
 *
 * REGISTRY: one process-wide sink, owner-tracked inside this module (the pattern of core/integration-run-port.ts and
 * core/workday-calendar-port.ts — no server field). The host binds AutomationService's handler at startup; an
 * absent sink is a quiet `SINK_INACTIVE` (fail closed: nothing fires).
 */
import { createHash } from 'node:crypto'

import {
  INTEGRATION_RUN_FINISHED_JOB_KINDS,
  INTEGRATION_RUN_FINISHED_REASONS,
  INTEGRATION_RUN_FINISHED_STATUSES,
  INTEGRATION_RUN_JOB_ID_SHAPE,
  type IntegrationRunFinishedJobKind,
  type IntegrationRunFinishedStatus,
} from '../multitable/automation-triggers'

export const INTEGRATION_RUN_FINISHED_EVENT_TYPE = 'integration.run_finished'

/** Bridge 2's switch. Exact literal only — never trimmed, never case-folded (ADR §7). */
export function isIntegrationAutomationRunEventEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED === 'true'
}

export const INTEGRATION_RUN_TRIGGERED_BY = Object.freeze(['automation', 'api', 'manual', 'replay'] as const)
export type IntegrationRunTriggeredBy = typeof INTEGRATION_RUN_TRIGGERED_BY[number]

export interface IntegrationRunFinishedJob {
  kind: IntegrationRunFinishedJobKind
  pipelineId?: string
  actionId?: string
  projectNo?: string
}

export interface IntegrationRunFinishedCounts {
  read: number
  cleaned: number
  written: number
  failed: number
}

/** ADR §4.1, closed. */
export interface IntegrationRunFinishedEvent {
  eventId: string
  occurredAt: string
  job: IntegrationRunFinishedJob
  runId?: string
  status: IntegrationRunFinishedStatus
  counts: IntegrationRunFinishedCounts
  durationMs: number
  attempts: number
  triggeredBy: IntegrationRunTriggeredBy
  errorClass?: string
  reason?: string
  _automationDepth: number
}

export interface IntegrationRunEventRoute {
  tenantId: string
}

export type IntegrationRunEventOrigin = 'plugin' | 'automation'

/** The closed key sets (exported so tests and the plugin side can pin them). */
export const INTEGRATION_RUN_FINISHED_EVENT_KEYS = Object.freeze([
  'eventId', 'occurredAt', 'job', 'runId', 'status', 'counts', 'durationMs', 'attempts', 'triggeredBy', 'errorClass', 'reason', '_automationDepth',
] as const)
const REQUIRED_EVENT_KEYS = Object.freeze(['eventId', 'occurredAt', 'job', 'status', 'counts', 'durationMs', 'attempts', 'triggeredBy', '_automationDepth'] as const)
export const INTEGRATION_RUN_FINISHED_JOB_KEYS = Object.freeze(['kind', 'pipelineId', 'actionId', 'projectNo'] as const)
export const INTEGRATION_RUN_FINISHED_COUNT_KEYS = Object.freeze(['read', 'cleaned', 'written', 'failed'] as const)
const ROUTE_KEYS = Object.freeze(['tenantId'] as const)

const ERROR_CLASS_SHAPE = /^[A-Za-z0-9_:.-]{1,80}$/
/** run_integration_job's PROJECT_NO_SHAPE (visible ASCII, 1..128) — a configuration identifier, never a row value. */
const PROJECT_NO_SHAPE = /^[!-~]{1,128}$/
const TENANT_ID_SHAPE = /^[!-~]{1,128}$/
const OCCURRED_AT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
/** Larger than any legitimate chain (MAX_AUTOMATION_DEPTH = 3); the dispatcher's depth guard drops ≥ 3. */
const MAX_EVENT_DEPTH = 16
const MAX_ATTEMPTS = 10

export type IntegrationRunEventRefusal =
  | 'EVENT_NOT_OBJECT'
  | 'EVENT_KEY_NOT_ACCEPTED'
  | 'EVENT_KEY_MISSING'
  | 'EVENT_FIELD_INVALID'
  | 'AUTOMATION_ORIGIN_RESERVED'
  | 'ROUTE_INVALID'

export type IntegrationRunEventValidation =
  | { ok: true; event: IntegrationRunFinishedEvent }
  | { ok: false; code: IntegrationRunEventRefusal; field?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Closed-key check: every own key must be accepted. Returns the first offending key or null. */
function firstForeignKey(value: Record<string, unknown>, accepted: readonly string[]): string | null {
  for (const key of Object.keys(value)) if (!accepted.includes(key)) return key
  return null
}

/**
 * Validate (and return a FROZEN copy of) a summary event. The refusal carries a closed code and, at most, the
 * NAME of the offending key — never its value. `origin` decides who may say `triggeredBy: 'automation'`.
 */
export function validateIntegrationRunFinishedEvent(raw: unknown, origin: IntegrationRunEventOrigin): IntegrationRunEventValidation {
  if (!isRecord(raw)) return { ok: false, code: 'EVENT_NOT_OBJECT' }
  const foreign = firstForeignKey(raw, INTEGRATION_RUN_FINISHED_EVENT_KEYS)
  if (foreign !== null) return { ok: false, code: 'EVENT_KEY_NOT_ACCEPTED', field: foreign.slice(0, 64) }
  for (const key of REQUIRED_EVENT_KEYS) if (raw[key] === undefined) return { ok: false, code: 'EVENT_KEY_MISSING', field: key }
  const invalid = (field: string): IntegrationRunEventValidation => ({ ok: false, code: 'EVENT_FIELD_INVALID', field })

  if (typeof raw.eventId !== 'string' || !INTEGRATION_RUN_JOB_ID_SHAPE.test(raw.eventId)) return invalid('eventId')
  if (typeof raw.occurredAt !== 'string' || !OCCURRED_AT_SHAPE.test(raw.occurredAt) || !Number.isFinite(Date.parse(raw.occurredAt))) return invalid('occurredAt')

  const rawJob = raw.job
  if (!isRecord(rawJob)) return invalid('job')
  const foreignJob = firstForeignKey(rawJob, INTEGRATION_RUN_FINISHED_JOB_KEYS)
  if (foreignJob !== null) return { ok: false, code: 'EVENT_KEY_NOT_ACCEPTED', field: `job.${foreignJob.slice(0, 64)}` }
  if (typeof rawJob.kind !== 'string' || !(INTEGRATION_RUN_FINISHED_JOB_KINDS as readonly string[]).includes(rawJob.kind)) return invalid('job.kind')
  const job: IntegrationRunFinishedJob = { kind: rawJob.kind as IntegrationRunFinishedJobKind }
  if (rawJob.kind === 'pipeline') {
    if (typeof rawJob.pipelineId !== 'string' || !INTEGRATION_RUN_JOB_ID_SHAPE.test(rawJob.pipelineId)) return invalid('job.pipelineId')
    if (rawJob.actionId !== undefined) return invalid('job.actionId')
    if (rawJob.projectNo !== undefined) return invalid('job.projectNo')
    job.pipelineId = rawJob.pipelineId
  } else {
    if (rawJob.pipelineId !== undefined) return invalid('job.pipelineId')
    // A per-project job: the project number is required (it is the config identifier, ADR §4.1).
    if (typeof rawJob.projectNo !== 'string' || !PROJECT_NO_SHAPE.test(rawJob.projectNo) || rawJob.projectNo.includes('://')) return invalid('job.projectNo')
    job.projectNo = rawJob.projectNo
    if (rawJob.actionId !== undefined) {
      if (typeof rawJob.actionId !== 'string' || !INTEGRATION_RUN_JOB_ID_SHAPE.test(rawJob.actionId)) return invalid('job.actionId')
      job.actionId = rawJob.actionId
    }
  }

  if (typeof raw.status !== 'string' || !(INTEGRATION_RUN_FINISHED_STATUSES as readonly string[]).includes(raw.status)) return invalid('status')

  const rawCounts = raw.counts
  if (!isRecord(rawCounts)) return invalid('counts')
  const foreignCount = firstForeignKey(rawCounts, INTEGRATION_RUN_FINISHED_COUNT_KEYS)
  if (foreignCount !== null) return { ok: false, code: 'EVENT_KEY_NOT_ACCEPTED', field: `counts.${foreignCount.slice(0, 64)}` }
  for (const key of INTEGRATION_RUN_FINISHED_COUNT_KEYS) if (!nonNegativeInteger(rawCounts[key])) return invalid(`counts.${key}`)

  if (!nonNegativeInteger(raw.durationMs)) return invalid('durationMs')
  if (!nonNegativeInteger(raw.attempts) || raw.attempts < 1 || raw.attempts > MAX_ATTEMPTS) return invalid('attempts')
  if (typeof raw.triggeredBy !== 'string' || !(INTEGRATION_RUN_TRIGGERED_BY as readonly string[]).includes(raw.triggeredBy)) return invalid('triggeredBy')
  // Automation-originated runs are summarized by the action layer ONLY (ADR §4.2): the plugin may not publish
  // one, and the action layer may publish nothing else.
  if (origin === 'plugin' && raw.triggeredBy === 'automation') return { ok: false, code: 'AUTOMATION_ORIGIN_RESERVED' }
  if (origin === 'automation' && raw.triggeredBy !== 'automation') return invalid('triggeredBy')
  if (!nonNegativeInteger(raw._automationDepth) || raw._automationDepth > MAX_EVENT_DEPTH) return invalid('_automationDepth')
  if (origin === 'plugin' && raw._automationDepth !== 0) return invalid('_automationDepth')

  if (raw.runId !== undefined && (typeof raw.runId !== 'string' || !INTEGRATION_RUN_JOB_ID_SHAPE.test(raw.runId))) return invalid('runId')
  if (raw.errorClass !== undefined && (typeof raw.errorClass !== 'string' || !ERROR_CLASS_SHAPE.test(raw.errorClass))) return invalid('errorClass')
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || !INTEGRATION_RUN_FINISHED_REASONS.has(raw.reason))) return invalid('reason')

  const event: IntegrationRunFinishedEvent = {
    eventId: raw.eventId,
    occurredAt: raw.occurredAt,
    job: Object.freeze(job),
    ...(raw.runId !== undefined ? { runId: raw.runId as string } : {}),
    status: raw.status as IntegrationRunFinishedStatus,
    counts: Object.freeze({ read: rawCounts.read as number, cleaned: rawCounts.cleaned as number, written: rawCounts.written as number, failed: rawCounts.failed as number }),
    durationMs: raw.durationMs,
    attempts: raw.attempts,
    triggeredBy: raw.triggeredBy as IntegrationRunTriggeredBy,
    ...(raw.errorClass !== undefined ? { errorClass: raw.errorClass as string } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
    _automationDepth: raw._automationDepth,
  }
  return { ok: true, event: Object.freeze(event) }
}

export function validateIntegrationRunEventRoute(raw: unknown): IntegrationRunEventRoute | null {
  if (!isRecord(raw) || firstForeignKey(raw, ROUTE_KEYS) !== null) return null
  if (typeof raw.tenantId !== 'string' || !TENANT_ID_SHAPE.test(raw.tenantId)) return null
  return Object.freeze({ tenantId: raw.tenantId })
}

/**
 * The action layer's deterministic event id (ADR §4.2): sha256 over the JSON array
 * [rootExecutionId, executionId, actionKey, projectNo ?? '']. A durable redelivery of the same step derives the
 * same id (and dedups per rule); a manual retryExecution is a new executionId and a new event, by design.
 */
export function deriveAutomationRunFinishedEventId(input: { rootExecutionId: string; executionId: string; actionKey: string; projectNo?: string | null }): string {
  return createHash('sha256')
    .update(JSON.stringify([input.rootExecutionId, input.executionId, input.actionKey, input.projectNo ?? '']))
    .digest('hex')
}

// ── Sink registry ─────────────────────────────────────────────────────────────────────────────────────────

export type IntegrationRunFinishedSink = (event: IntegrationRunFinishedEvent, route: IntegrationRunEventRoute) => Promise<void>

let boundSink: IntegrationRunFinishedSink | undefined
let boundOwner: string | null = null

/** Bind the process-wide sink for `owner`. Returns the unbind for THIS registration only. */
export function registerIntegrationRunFinishedSink(owner: string, sink: IntegrationRunFinishedSink): () => void {
  if (typeof owner !== 'string' || !owner.trim()) throw new TypeError('registerIntegrationRunFinishedSink: owner is required')
  if (typeof sink !== 'function') throw new TypeError('registerIntegrationRunFinishedSink: sink must be a function')
  boundSink = sink
  boundOwner = owner
  return () => {
    if (boundOwner === owner && boundSink === sink) {
      boundSink = undefined
      boundOwner = null
    }
  }
}

export function getIntegrationRunFinishedSinkOwner(): string | null {
  return boundOwner
}

/** Test isolation only. */
export function clearIntegrationRunFinishedSinkForTest(): void {
  boundSink = undefined
  boundOwner = null
}

export type IntegrationRunPublishResult =
  | { published: true }
  | { published: false; code: 'EVENT_DISABLED' | 'SINK_INACTIVE' | 'SINK_FAILED' | IntegrationRunEventRefusal; field?: string }

/**
 * THE publish port (both origins). Never throws: a refused or failed publish answers a closed code, so a
 * caller's run result is never changed by its summary. Order: switch → route → closed key set → sink.
 */
export async function publishIntegrationRunFinished(
  rawEvent: unknown,
  rawRoute: unknown,
  origin: IntegrationRunEventOrigin,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IntegrationRunPublishResult> {
  if (!isIntegrationAutomationRunEventEnabled(env)) return { published: false, code: 'EVENT_DISABLED' }
  const route = validateIntegrationRunEventRoute(rawRoute)
  if (!route) return { published: false, code: 'ROUTE_INVALID' }
  const validation = validateIntegrationRunFinishedEvent(rawEvent, origin)
  if (validation.ok === false) {
    return { published: false, code: validation.code, ...(validation.field ? { field: validation.field } : {}) }
  }
  const sink = boundSink
  if (!sink) return { published: false, code: 'SINK_INACTIVE' }
  try {
    await sink(validation.event, route)
    return { published: true }
  } catch {
    return { published: false, code: 'SINK_FAILED' }
  }
}
