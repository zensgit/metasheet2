/**
 * DingTalk approval-todo ONE-WAY mirror — the CONSUMER half (design
 * docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §4/§5).
 *
 * Approval events in, ledger rows out. Nothing here talks to DingTalk: the send is the worker's job
 * (`dingtalk-todo-mirror-worker.ts`), so this module stays a pure SQL state machine that a unit test
 * can drive with a fake query function.
 *
 * TWO LEGS, ONE SINK — exactly like `multitable-record-approval`:
 *   - durable: consumer_key `dingtalk-todo-mirror` in routing manifest v3;
 *   - eventBus: `approval.task_created` + `approval.{approved,rejected,revoked,cancelled}`.
 * Which leg delivers is decided on the PRODUCE side by AUTOMATION_DURABLE_DELIVERY_ENABLED (the legacy
 * emitters return early when it is ON), so both stay wired and every write below is idempotent.
 *
 * THE FLAG (DINGTALK_TODO_MIRROR_ENABLED, default OFF) IS CHECKED FIRST AND WRITES NOTHING WHEN OFF.
 * That is the design's §2.5 rule and it is deliberately an ACK, not a refusal: a consumer that threw
 * (or that never ACKed) would pile `meta_automation_outbox_consumer` rows up forever for a feature
 * nobody enabled, and a consumer that wrote rows would build a shadow ledger whose todos are never
 * sent. OFF => `handled: false`, ZERO queries.
 *
 * IDEMPOTENCY is the ledger's UNIQUE (org_id, source_key) plus `ON CONFLICT DO NOTHING`: `source_key`
 * IS the task_created eventId, so an at-least-once redelivery of the same pending task collapses onto
 * the one row (and therefore onto at most one DingTalk todo). Remove either half and a redelivery
 * duplicates a person's todo — that is what the duplicate-event test pins.
 *
 * TENANCY: the event payload carries NO org_id, so every write re-reads `approval_instances.org_id`
 * and scopes on it. A NULL org (historical instances predating the column) is `skipped_no_org`: we
 * never guess 'default', because that would file another tenant's task under the wrong org and hand
 * it that org's DingTalk credentials at send time.
 *
 * VALUES-FREE LOGS: ids, node keys, statuses and counts only — never a subject, a person's name or a
 * unionId (design §7).
 */
import { Logger } from '../core/logger'
import type { ApprovalCompletionEventV1 } from './ApprovalCompletionEvent'
import type { ApprovalTaskCreatedEventV1 } from './ApprovalTaskCreatedEvent'
import { isDingTalkTodoMirrorEnabled } from '../integrations/dingtalk/todo-mirror-flag'

export type TodoMirrorQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** Mirrored in the migration (`DINGTALK_TODO_MIRRORS_TABLE`); cross-checked by the migration spec. */
export const DINGTALK_TODO_MIRRORS_TABLE = 'dingtalk_todo_mirrors'

/** The four completion families this consumer listens to (identical to the manifest's approval set). */
export const TODO_MIRROR_COMPLETION_EVENT_TYPES = [
  'approval.approved',
  'approval.rejected',
  'approval.revoked',
  'approval.cancelled',
] as const

export const TODO_MIRROR_TASK_CREATED_EVENT_TYPE = 'approval.task_created' as const

/** `complete_reason` vocabulary — mirrored by the migration's CHECK constraint. */
export const TODO_MIRROR_COMPLETE_REASONS = ['next_node', 'approved', 'rejected', 'revoked', 'cancelled'] as const
export type TodoMirrorCompleteReason = (typeof TODO_MIRROR_COMPLETE_REASONS)[number]

export type TodoMirrorSkipReason = 'flag_off' | 'no_org' | 'malformed_event'

export interface TodoMirrorApplyResult {
  handled: boolean
  skippedReason?: TodoMirrorSkipReason
  /** Rows moved out of {pending, created} by the supersede / terminal sweep. */
  supersededRows?: number
  /** 1 when the task_created UPSERT inserted a NEW row, 0 when the idempotency key collapsed it. */
  insertedRows?: number
}

export interface DingTalkTodoMirrorDeps {
  env?: NodeJS.ProcessEnv
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>
}

const defaultLogger = new Logger('DingTalkTodoMirror')

function readOutcomeReason(eventType: string): TodoMirrorCompleteReason | null {
  switch (eventType) {
    case 'approval.approved': return 'approved'
    case 'approval.rejected': return 'rejected'
    case 'approval.revoked': return 'revoked'
    case 'approval.cancelled': return 'cancelled'
    default: return null
  }
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeEpoch(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Re-read the instance's org. Returns '' when the instance is gone or its `org_id` is NULL — both are
 * "do not write" (see the header's tenancy note), never "use a default".
 */
async function readInstanceOrgId(query: TodoMirrorQueryFn, instanceId: string): Promise<string> {
  const result = await query(
    'SELECT org_id FROM approval_instances WHERE id = $1 LIMIT 1',
    [instanceId],
  )
  const row = (result.rows[0] ?? null) as { org_id?: unknown } | null
  if (!row) return ''
  return normalizeId(row.org_id)
}

/**
 * (1) of design §4: every OTHER live seat of this instance is retired when a new task seat opens.
 *
 * `pending` rows were never sent, so they terminate as `superseded` outright. `created` rows have a
 * live DingTalk todo, so they move to `completing` (the worker will mark that todo done) with their
 * retry budget reset — a superseded row that inherited an exhausted `attempt_count` would be
 * dead-lettered on its first completion attempt.
 *
 * Rows in `sending` are NOT touched: the worker holds a lease on them and its terminal write is a CAS
 * on (status='sending', worker id, attempt_count). Stealing such a row would either lose that write or
 * resurrect the row; the next terminal event picks it up once it has settled into `created`.
 */
async function supersedeOtherSeats(
  query: TodoMirrorQueryFn,
  input: { instanceId: string; orgId: string; nodeKey: string; entryEpoch: number | null },
): Promise<number> {
  const result = await query(
    `UPDATE ${DINGTALK_TODO_MIRRORS_TABLE}
        SET status = CASE WHEN status = 'created' THEN 'completing' ELSE 'superseded' END,
            complete_reason = 'next_node',
            attempt_count = CASE WHEN status = 'created' THEN 0 ELSE attempt_count END,
            next_attempt_at = CASE WHEN status = 'created' THEN NOW() ELSE next_attempt_at END,
            last_error = NULL,
            claim_worker_id = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
      WHERE instance_id = $1
        AND org_id = $2
        AND status IN ('pending', 'created')
        AND NOT (node_key = $3 AND entry_epoch IS NOT DISTINCT FROM $4::int)`,
    [input.instanceId, input.orgId, input.nodeKey, input.entryEpoch],
  )
  return Number(result.rowCount ?? 0)
}

/**
 * (2) of design §4: the idempotent UPSERT. `ON CONFLICT (org_id, source_key) DO NOTHING` + the ledger's
 * UNIQUE index IS the at-least-once contract — a redelivered task_created inserts nothing and the
 * consumer ACKs. `recipient_union_id` / `integration_id` stay NULL here on purpose: identity is
 * resolved at SEND time by the worker, so a directory link that lands between the event and the send
 * still works (and a stale link can never be cached into the ledger).
 */
async function insertPendingSeat(
  query: TodoMirrorQueryFn,
  input: {
    orgId: string
    instanceId: string
    requestNo: string | null
    templateId: string | null
    nodeKey: string
    entryEpoch: number | null
    recipientUserId: string
    sourceKey: string
  },
): Promise<number> {
  const result = await query(
    `INSERT INTO ${DINGTALK_TODO_MIRRORS_TABLE}
       (org_id, instance_id, request_no, template_id, node_key, entry_epoch, recipient_user_id, source_key, status)
     VALUES ($1, $2, $3, $4, $5, $6::int, $7, $8, 'pending')
     ON CONFLICT (org_id, source_key) DO NOTHING`,
    [
      input.orgId,
      input.instanceId,
      input.requestNo,
      input.templateId,
      input.nodeKey,
      input.entryEpoch,
      input.recipientUserId,
      input.sourceKey,
    ],
  )
  return Number(result.rowCount ?? 0)
}

/**
 * The instance reached a terminal state: nothing on it is actionable any more. `pending` rows were
 * never sent => `skipped` (we do NOT create a todo for a task that is already over); `created` rows
 * have a live todo => `completing`.
 */
async function retireInstanceSeats(
  query: TodoMirrorQueryFn,
  input: { instanceId: string; orgId: string; reason: TodoMirrorCompleteReason },
): Promise<number> {
  const result = await query(
    `UPDATE ${DINGTALK_TODO_MIRRORS_TABLE}
        SET status = CASE WHEN status = 'created' THEN 'completing' ELSE 'skipped' END,
            complete_reason = $3,
            attempt_count = CASE WHEN status = 'created' THEN 0 ELSE attempt_count END,
            next_attempt_at = CASE WHEN status = 'created' THEN NOW() ELSE next_attempt_at END,
            last_error = NULL,
            claim_worker_id = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
      WHERE instance_id = $1
        AND org_id = $2
        AND status IN ('pending', 'created')`,
    [input.instanceId, input.orgId, input.reason],
  )
  return Number(result.rowCount ?? 0)
}

export async function applyTodoMirrorTaskCreated(
  query: TodoMirrorQueryFn,
  event: ApprovalTaskCreatedEventV1,
  deps: DingTalkTodoMirrorDeps = {},
): Promise<TodoMirrorApplyResult> {
  const logger = deps.logger ?? defaultLogger
  // FLAG FIRST — before any query. OFF => ACK with zero rows touched (design §2.5).
  if (!isDingTalkTodoMirrorEnabled(deps.env)) return { handled: false, skippedReason: 'flag_off' }

  const instanceId = normalizeId(event?.approval?.instanceId)
  const nodeKey = normalizeId(event?.task?.nodeKey)
  const recipientUserId = normalizeId(event?.task?.assigneeUserId)
  const sourceKey = normalizeId(event?.eventId)
  if (!instanceId || !nodeKey || !recipientUserId || !sourceKey) {
    // A malformed producer payload: nothing identifies the seat. ACK (a retry would never fix it).
    logger.warn(`DingTalk todo mirror: malformed task_created payload (instance=${instanceId || 'none'})`)
    return { handled: false, skippedReason: 'malformed_event' }
  }

  const orgId = await readInstanceOrgId(query, instanceId)
  if (!orgId) {
    logger.info(`DingTalk todo mirror: skipped_no_org instance=${instanceId} node=${nodeKey}`)
    return { handled: false, skippedReason: 'no_org' }
  }

  const entryEpoch = normalizeEpoch(event.task?.entryEpoch)
  const supersededRows = await supersedeOtherSeats(query, { instanceId, orgId, nodeKey, entryEpoch })
  const insertedRows = await insertPendingSeat(query, {
    orgId,
    instanceId,
    requestNo: event.approval?.requestNo ?? null,
    templateId: event.approval?.templateId ?? null,
    nodeKey,
    entryEpoch,
    recipientUserId,
    sourceKey,
  })
  logger.info(
    `DingTalk todo mirror: task_created instance=${instanceId} node=${nodeKey} epoch=${entryEpoch ?? 'null'} inserted=${insertedRows} superseded=${supersededRows}`,
  )
  return { handled: true, supersededRows, insertedRows }
}

export async function applyTodoMirrorCompletion(
  query: TodoMirrorQueryFn,
  event: ApprovalCompletionEventV1,
  deps: DingTalkTodoMirrorDeps = {},
): Promise<TodoMirrorApplyResult> {
  const logger = deps.logger ?? defaultLogger
  if (!isDingTalkTodoMirrorEnabled(deps.env)) return { handled: false, skippedReason: 'flag_off' }

  const instanceId = normalizeId(event?.approval?.instanceId)
  const reason = readOutcomeReason(String(event?.eventType ?? ''))
  if (!instanceId || !reason) {
    logger.warn(`DingTalk todo mirror: malformed completion payload (type=${String(event?.eventType ?? 'none')})`)
    return { handled: false, skippedReason: 'malformed_event' }
  }

  const orgId = await readInstanceOrgId(query, instanceId)
  if (!orgId) {
    logger.info(`DingTalk todo mirror: skipped_no_org instance=${instanceId} reason=${reason}`)
    return { handled: false, skippedReason: 'no_org' }
  }

  const supersededRows = await retireInstanceSeats(query, { instanceId, orgId, reason })
  logger.info(`DingTalk todo mirror: terminal instance=${instanceId} reason=${reason} retired=${supersededRows}`)
  return { handled: true, supersededRows }
}

/** The sink both legs share (durable adapter + eventBus subscriptions). */
export interface DingTalkTodoMirrorSink {
  handleApprovalTaskCreated(event: ApprovalTaskCreatedEventV1): Promise<void>
  handleApprovalCompletion(event: ApprovalCompletionEventV1): Promise<void>
}

export function createDingTalkTodoMirrorSink(
  query: TodoMirrorQueryFn,
  deps: DingTalkTodoMirrorDeps = {},
): DingTalkTodoMirrorSink {
  return {
    async handleApprovalTaskCreated(event: ApprovalTaskCreatedEventV1): Promise<void> {
      await applyTodoMirrorTaskCreated(query, event, deps)
    },
    async handleApprovalCompletion(event: ApprovalCompletionEventV1): Promise<void> {
      await applyTodoMirrorCompletion(query, event, deps)
    },
  }
}

type TodoMirrorEventBus = {
  subscribe<T>(eventType: string, handler: (payload: T) => void | Promise<void>, plugin?: string): string
}

/**
 * Wire the eventBus (legacy) leg. Returns the subscription ids. Failures are handed to `onError` and
 * never thrown into the bus — a todo that cannot be mirrored must not break the other subscribers.
 */
export function subscribeDingTalkTodoMirrorBus(
  eventBus: TodoMirrorEventBus,
  sink: DingTalkTodoMirrorSink,
  onError: (eventType: string, error: unknown) => void = () => undefined,
): string[] {
  const ids: string[] = []
  ids.push(
    eventBus.subscribe<ApprovalTaskCreatedEventV1>(TODO_MIRROR_TASK_CREATED_EVENT_TYPE, (payload) => {
      sink.handleApprovalTaskCreated(payload).catch((error) => onError(TODO_MIRROR_TASK_CREATED_EVENT_TYPE, error))
    }),
  )
  for (const eventType of TODO_MIRROR_COMPLETION_EVENT_TYPES) {
    ids.push(
      eventBus.subscribe<ApprovalCompletionEventV1>(eventType, (payload) => {
        sink.handleApprovalCompletion(payload).catch((error) => onError(eventType, error))
      }),
    )
  }
  return ids
}
