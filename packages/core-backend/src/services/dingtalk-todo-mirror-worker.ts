/**
 * DingTalk approval-todo ONE-WAY mirror — the DELIVERY half (design
 * docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §4/§5).
 *
 * Shape is deliberately the PROVEN `AttendanceNotificationDeliveryWorker` shape, not a new one:
 *   - claim due rows with `FOR UPDATE SKIP LOCKED` + a short LEASE (crash ⇒ the lease expires and the
 *     row is reclaimed; two workers never hold the same row);
 *   - every terminal write is a CAS on (id, claimed status, claim_worker_id, attempt_count) — a worker
 *     whose lease was stolen while it was sending writes NOTHING ("lost-lease"), so a reclaiming
 *     worker's state is never overwritten by a zombie;
 *   - backoff 1m / 5m / 15m / 60m / 6h, at most 5 attempts;
 *   - `outcome_unknown` is a DISTINCT TERMINAL state that is never claimed again and never requeued:
 *     the request may have created the todo, and a resend on ambiguity is a duplicate-todo hazard;
 *   - `redelivery_safe` is set ONLY on a DEFINITE non-delivery, and the operator requeue gate requires
 *     it, so an ambiguous row can never be resent by anyone.
 *
 * TWO PHASES ON ONE LEDGER. A claimed `pending` row becomes `sending` (create the todo); a claimed
 * `completing` row keeps its status (mark the todo done) and its lease columns carry the in-flight
 * marker. The claim query therefore takes "due work" (pending/completing with no live lease) plus
 * "abandoned sends" (sending with an expired lease).
 *
 * VALUES-FREE BY CONSTRUCTION (design §7): `last_error` is only ever one of the fixed codes below —
 * never a DingTalk response message, never a subject, a name or a unionId. Logs carry ids/counters.
 *
 * FLAG: the worker is only ever constructed/started by `index.ts` when DINGTALK_TODO_MIRROR_ENABLED is
 * exactly 'true'. It has no flag check of its own on purpose — a worker that ran with the flag OFF
 * would find nothing to do anyway (the consumer writes no rows), and duplicating the gate would hide
 * which one is load-bearing.
 */
import { randomBytes } from 'crypto'
import { query as defaultQuery } from '../db/pg'
import { Logger } from '../core/logger'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  createDingTalkTodoTask,
  completeDingTalkTodoTask,
  fetchDingTalkAppAccessToken,
  isDingTalkOutcomeUnknown,
  type DingTalkMessageConfig,
  type DingTalkTodoTaskInput,
  type DingTalkTodoTaskResult,
} from '../integrations/dingtalk/client'
import { readDingTalkMessageConfigFromRuntime } from '../integrations/dingtalk/work-notification-settings'
import { resolveDingTalkTodoOperatorUnionId } from '../integrations/dingtalk/todo-operator-config'
import { DINGTALK_TODO_MIRRORS_TABLE, type TodoMirrorCompleteReason } from './dingtalk-todo-mirror-service'

export type TodoMirrorWorkerQuery = <T = unknown>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>

const DEFAULT_BATCH_SIZE = 25
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 5
const MIN_BATCH_SIZE = 1
const MAX_BATCH_SIZE = 200
const MIN_LEASE_MS = 5_000
const MAX_LEASE_MS = 10 * 60_000

/** The fixed `last_error` vocabulary — values-free by construction (design §7). */
export const TODO_MIRROR_ERROR_CODES = {
  recipientNotBound: 'todo_recipient_not_bound',
  recipientAmbiguous: 'todo_recipient_ambiguous',
  orgIntegrationInactive: 'todo_org_integration_inactive',
  operatorMissing: 'todo_operator_union_id_missing',
  configUnavailable: 'todo_config_unavailable',
  missingTaskId: 'todo_missing_task_id',
  createFailed: 'todo_create_failed',
  createOutcomeUnknown: 'todo_create_outcome_unknown',
  /** A lease-expired `sending` row whose create request HAD already been issued (see `deliver`). */
  createReclaimAmbiguous: 'todo_create_reclaim_ambiguous',
  completeFailed: 'todo_complete_failed',
  completeOutcomeUnknown: 'todo_complete_outcome_unknown',
} as const

export function clampTodoMirrorBatchSize(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.floor(n)))
}

export function clampTodoMirrorLeaseMs(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LEASE_MS
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.floor(n)))
}

/** Identical ladder to the attendance worker (design §5: "租约、退避与 CAS 与 attendance worker 完全一致"). */
export function computeTodoMirrorBackoffMs(attemptCount: number): number {
  if (attemptCount <= 1) return 60_000
  if (attemptCount === 2) return 5 * 60_000
  if (attemptCount === 3) return 15 * 60_000
  if (attemptCount === 4) return 60 * 60_000
  return 6 * 60 * 60_000
}

export function resolveTodoMirrorAppBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.PUBLIC_APP_URL?.trim() || env.APP_BASE_URL?.trim() || ''
}

/** Deep link back to the platform approval detail. Empty base ⇒ no detailUrl (the todo still sends). */
export function buildTodoMirrorDetailUrl(baseUrl: string, instanceId: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const id = instanceId.trim()
  if (!base || !id) return ''
  return `${base}/approvals/${encodeURIComponent(id)}`
}

/**
 * The todo title. Built from the template NAME and the request no only — never from form values, and
 * never from a person's name (design §7 values-free fence: the subject is the ONE string that reaches
 * DingTalk, so it is assembled here and nowhere else).
 */
export function buildTodoMirrorSubject(input: { templateName?: string | null; requestNo?: string | null }): string {
  const templateName = (input.templateName ?? '').trim()
  const requestNo = (input.requestNo ?? '').trim()
  const tail = [templateName, requestNo].filter(Boolean).join(' ')
  return tail ? `审批待处理：${tail}` : '审批待处理'
}

export interface TodoMirrorRow {
  id: string
  org_id: string
  instance_id: string
  request_no: string | null
  template_id: string | null
  node_key: string
  entry_epoch: number | null
  recipient_user_id: string
  recipient_union_id: string | null
  integration_id: string | null
  source_key: string
  dingtalk_task_id: string | null
  status: string
  attempt_count: number | string
  /**
   * The status the row had BEFORE this claim bumped it (returned from the claim CTE's snapshot).
   * `'sending'` means this claim RE-took an abandoned in-flight send — see `deliver`.
   */
  prior_status?: string | null
  /** Set by `markSendIssued` immediately before a create request leaves the process. */
  send_issued_at?: string | null
}

export interface TodoMirrorRunResult {
  claimed: number
  created: number
  completed: number
  retrying: number
  failed: number
  skipped: number
  outcomeUnknown: number
  lostLease: number
}

export type TodoMirrorDeliverOutcome =
  | 'created'
  | 'completed'
  | 'retrying'
  | 'failed'
  | 'skipped'
  | 'outcome_unknown'
  | 'lost-lease'

export interface DingTalkTodoMirrorWorkerOptions {
  query?: TodoMirrorWorkerQuery
  batchSize?: number
  leaseMs?: number
  maxAttempts?: number
  workerId?: string
  now?: () => Date
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>
  env?: NodeJS.ProcessEnv
  /** DI seams — the unit suite injects fakes so nothing ever reaches the network. */
  readConfig?: (integrationId?: string) => Promise<DingTalkMessageConfig>
  fetchAccessToken?: (config: DingTalkMessageConfig) => Promise<string>
  resolveOperatorUnionId?: (integrationId: string, orgId: string) => Promise<string>
  createTodoTask?: (
    accessToken: string,
    operatorUnionId: string,
    input: DingTalkTodoTaskInput,
    config?: { openApiBaseUrl?: string },
  ) => Promise<DingTalkTodoTaskResult>
  completeTodoTask?: (
    accessToken: string,
    operatorUnionId: string,
    taskId: string,
    config?: { openApiBaseUrl?: string },
  ) => Promise<DingTalkTodoTaskResult>
}

type RecipientResolution =
  | { ok: true; unionId: string; integrationId: string }
  /**
   * `outcome` separates the two NON-retryable results on purpose: "this person has no DingTalk
   * identity" is a structural gap (`skipped`, nothing for an operator to do here), while "two
   * candidate identities" is a directory DATA ANOMALY that must stay visible in the failure bucket
   * (`failed`) — collapsing both into `skipped` would hide the anomaly forever.
   */
  | { ok: false; outcome: 'retry'; code: string }
  | { ok: false; outcome: 'skipped'; code: string }
  | { ok: false; outcome: 'failed'; code: string }

/**
 * A DingTalk answer that means "that todo is not there any more". The solid signal is HTTP 404; the
 * string probes are a best-effort supplement for endpoints that answer 200/4xx with a business code
 * (the API's exact code is an owner-verification item, design §6). Treated as ALREADY CLEANED UP:
 * the mirror's whole job for that row is that no live todo remains.
 */
export function isDingTalkTodoTaskMissing(error: unknown): boolean {
  if (error instanceof DingTalkRequestError) return error.statusCode === 404
  if (error instanceof DingTalkBusinessError) {
    const body = error.responseBody ?? {}
    const code = String(body.code ?? body.errcode ?? '')
    return /not.?exist|not.?found/i.test(code)
  }
  return false
}

export class DingTalkTodoMirrorWorker {
  private readonly query: TodoMirrorWorkerQuery
  private readonly batchSize: number
  private readonly leaseMs: number
  private readonly maxAttempts: number
  private readonly workerId: string
  private readonly now: () => Date
  private readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>
  private readonly env: NodeJS.ProcessEnv
  private readonly readConfig: (integrationId?: string) => Promise<DingTalkMessageConfig>
  private readonly fetchAccessToken: (config: DingTalkMessageConfig) => Promise<string>
  private readonly resolveOperatorUnionId: (integrationId: string, orgId: string) => Promise<string>
  private readonly createTodoTask: NonNullable<DingTalkTodoMirrorWorkerOptions['createTodoTask']>
  private readonly completeTodoTask: NonNullable<DingTalkTodoMirrorWorkerOptions['completeTodoTask']>
  private running = false

  constructor(options: DingTalkTodoMirrorWorkerOptions = {}) {
    this.query = options.query ?? (defaultQuery as unknown as TodoMirrorWorkerQuery)
    this.batchSize = clampTodoMirrorBatchSize(options.batchSize)
    this.leaseMs = clampTodoMirrorLeaseMs(options.leaseMs)
    this.maxAttempts = Number.isFinite(Number(options.maxAttempts)) && Number(options.maxAttempts) > 0
      ? Math.floor(Number(options.maxAttempts))
      : DEFAULT_MAX_ATTEMPTS
    this.workerId = options.workerId ?? `dingtalk-todo-mirror:${process.pid}:${randomBytes(4).toString('hex')}`
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? new Logger('DingTalkTodoMirrorWorker')
    this.env = options.env ?? process.env
    this.readConfig = options.readConfig ?? readDingTalkMessageConfigFromRuntime
    this.fetchAccessToken = options.fetchAccessToken ?? fetchDingTalkAppAccessToken
    this.resolveOperatorUnionId = options.resolveOperatorUnionId
      ?? ((integrationId: string, orgId: string) => resolveDingTalkTodoOperatorUnionId(integrationId, orgId))
    this.createTodoTask = options.createTodoTask ?? createDingTalkTodoTask
    this.completeTodoTask = options.completeTodoTask ?? completeDingTalkTodoTask
  }

  /**
   * Claim due work under a lease. Terminal rows (`completed`, `superseded`, `failed`, `skipped`,
   * `outcome_unknown`) match NO branch of this predicate — that is the structural half of "an
   * outcome_unknown row is never resent"; the operator requeue gate is the other half.
   */
  async claimDueRows(): Promise<TodoMirrorRow[]> {
    const asOf = this.now().toISOString()
    const { rows } = await this.query<TodoMirrorRow>(
      `WITH claim AS (
         SELECT id, status AS prior_status
           FROM ${DINGTALK_TODO_MIRRORS_TABLE}
          WHERE (
                  status IN ('pending', 'completing')
              AND next_attempt_at <= $1::timestamptz
              AND (claim_expires_at IS NULL OR claim_expires_at <= $1::timestamptz)
            )
             OR (
                  status = 'sending'
              AND claim_expires_at <= $1::timestamptz
            )
          ORDER BY COALESCE(next_attempt_at, claim_expires_at) ASC, created_at ASC
          LIMIT $2::int
          FOR UPDATE SKIP LOCKED
       ),
       claimed AS (
         UPDATE ${DINGTALK_TODO_MIRRORS_TABLE} d
            SET status = CASE WHEN d.status = 'completing' THEN 'completing' ELSE 'sending' END,
                attempt_count = d.attempt_count + 1,
                last_attempt_at = $1::timestamptz,
                claimed_at = $1::timestamptz,
                claim_expires_at = $1::timestamptz + ($3::int * interval '1 millisecond'),
                claim_worker_id = $4,
                updated_at = $1::timestamptz
           FROM claim
          WHERE d.id = claim.id
          RETURNING d.id::text AS id,
                    d.org_id,
                    d.instance_id,
                    d.request_no,
                    d.template_id,
                    d.node_key,
                    d.entry_epoch,
                    d.recipient_user_id,
                    d.recipient_union_id,
                    d.integration_id::text AS integration_id,
                    d.source_key,
                    d.dingtalk_task_id,
                    d.status,
                    d.attempt_count,
                    d.send_issued_at,
                    claim.prior_status
       )
       SELECT * FROM claimed ORDER BY id`,
      [asOf, this.batchSize, this.leaseMs, this.workerId],
    )
    return rows
  }

  async runBatch(): Promise<TodoMirrorRunResult> {
    const result: TodoMirrorRunResult = {
      claimed: 0, created: 0, completed: 0, retrying: 0, failed: 0, skipped: 0, outcomeUnknown: 0, lostLease: 0,
    }
    if (this.running) return result
    this.running = true
    try {
      const rows = await this.claimDueRows()
      result.claimed = rows.length
      for (const row of rows) {
        const outcome = await this.deliver(row)
        if (outcome === 'created') result.created += 1
        else if (outcome === 'completed') result.completed += 1
        else if (outcome === 'retrying') result.retrying += 1
        else if (outcome === 'failed') result.failed += 1
        else if (outcome === 'skipped') result.skipped += 1
        else if (outcome === 'outcome_unknown') result.outcomeUnknown += 1
        else result.lostLease += 1
      }
      if (result.claimed > 0) {
        this.logger.info(
          `DingTalk todo mirror claimed=${result.claimed} created=${result.created} completed=${result.completed} retrying=${result.retrying} failed=${result.failed} skipped=${result.skipped} outcomeUnknown=${result.outcomeUnknown} lostLease=${result.lostLease}`,
        )
      }
      return result
    } finally {
      this.running = false
    }
  }

  /**
   * Q19 fix (re-claimed in-flight send). The claim predicate deliberately re-takes a `sending` row whose
   * lease expired (a crashed/restarted worker). Re-running the create for such a row is the ONE place the
   * ledger could resend an AMBIGUOUS request — a second todo for the same task, whose first task id is
   * lost (the first attempt's CAS fails as `lost-lease`). That is exactly what the design forbids
   * ("outcome_unknown … 永不重发"), and it was handled one way for an in-process timeout and the opposite
   * way for a crash.
   *
   * `send_issued_at` is the discriminator, and it is EVIDENCE, not a guess:
   *   - stamped ⇒ a create request left this process and we never saw its answer ⇒ TERMINAL
   *     `outcome_unknown`, redelivery_safe=false (no operator gate can resend it either);
   *   - NULL ⇒ the lease died BEFORE anything was issued (recipient resolve / config / token stage),
   *     so sending now cannot duplicate anything ⇒ fall through to a normal create attempt.
   * A `completing` re-claim needs no such care: marking an already-done todo done again is idempotent
   * (and a vanished todo is `isDingTalkTodoTaskMissing` ⇒ completed).
   */
  private async deliver(row: TodoMirrorRow): Promise<TodoMirrorDeliverOutcome> {
    if (row.status !== 'completing' && String(row.prior_status ?? '') === 'sending' && row.send_issued_at) {
      const ok = await this.markTerminal(
        row.id,
        'outcome_unknown',
        Number(row.attempt_count),
        TODO_MIRROR_ERROR_CODES.createReclaimAmbiguous,
        false,
      )
      return ok ? 'outcome_unknown' : 'lost-lease'
    }
    return row.status === 'completing' ? this.deliverCompletion(row) : this.deliverCreate(row)
  }

  private async deliverCreate(row: TodoMirrorRow): Promise<TodoMirrorDeliverOutcome> {
    const attemptCount = Number(row.attempt_count)
    const recipient = await this.resolveRecipient(row)
    if (recipient.ok === false) {
      if (recipient.outcome === 'retry') return this.retryOrFail(row, attemptCount, recipient.code, true)
      // Terminal, and retrying cannot help: either no DingTalk identity for this person (structural
      // `skipped`; the fix is a directory sync / linking action outside this worker) or an ambiguous
      // binding (`failed`, so it shows up in the operator's dead-letter bucket). Nothing was sent in
      // either case, so the ambiguous row is redelivery-safe once the duplicate links are cleaned up.
      const redeliverySafe = recipient.outcome === 'failed'
      return await this.markTerminal(row.id, recipient.outcome, attemptCount, recipient.code, redeliverySafe)
        ? recipient.outcome
        : 'lost-lease'
    }

    const operatorUnionId = await this.resolveOperatorUnionId(recipient.integrationId, row.org_id)
    if (!operatorUnionId) {
      // Owner prerequisite §8.2 not satisfied yet — retryable so the row self-heals once it is filled in.
      return this.retryOrFail(row, attemptCount, TODO_MIRROR_ERROR_CODES.operatorMissing, true)
    }

    let config: DingTalkMessageConfig
    try {
      config = await this.readConfig(recipient.integrationId)
    } catch {
      return this.retryOrFail(row, attemptCount, TODO_MIRROR_ERROR_CODES.configUnavailable, true)
    }

    const subject = buildTodoMirrorSubject({
      templateName: await this.readTemplateName(row.template_id),
      requestNo: row.request_no,
    })
    const detailUrl = buildTodoMirrorDetailUrl(resolveTodoMirrorAppBaseUrl(this.env), row.instance_id)

    // EVIDENCE BEFORE THE SEND (and a free lease check): if this CAS matches 0 rows our lease was
    // stolen, so we must NOT send at all — the holder will. See `deliver` for why the stamp matters.
    if (!await this.markSendIssued(row.id, attemptCount)) return 'lost-lease'

    try {
      const accessToken = await this.fetchAccessToken(config)
      const sent = await this.createTodoTask(
        accessToken,
        operatorUnionId,
        {
          sourceId: row.source_key,
          subject,
          creatorUnionId: operatorUnionId,
          executorUnionIds: [recipient.unionId],
          ...(detailUrl ? { detailUrl } : {}),
        },
        {},
      )
      const ok = await this.markCreated(row.id, attemptCount, {
        taskId: sent.taskId ?? null,
        unionId: recipient.unionId,
        integrationId: recipient.integrationId,
      })
      if (!ok) return 'lost-lease'
      // The seat may have died WHILE we were sending. The consumer's sweeps skip `sending` rows (the
      // lease is ours), and a terminal event that already ran will never come back — so the row would
      // settle into `created` and keep a live todo for a finished approval forever. Close the window
      // here, on the same liveness predicate the consumer uses.
      await this.retireCreatedSeatIfGone(row)
      return 'created'
    } catch (error) {
      if (isDingTalkOutcomeUnknown(error)) {
        // TERMINAL and never resent: DingTalk may have created the todo. Reconciliation is manual.
        return await this.markTerminal(row.id, 'outcome_unknown', attemptCount, TODO_MIRROR_ERROR_CODES.createOutcomeUnknown, false)
          ? 'outcome_unknown'
          : 'lost-lease'
      }
      const definite = isDefiniteDingTalkRejection(error)
      return this.retryOrFail(row, attemptCount, TODO_MIRROR_ERROR_CODES.createFailed, !definite)
    }
  }

  private async deliverCompletion(row: TodoMirrorRow): Promise<TodoMirrorDeliverOutcome> {
    const attemptCount = Number(row.attempt_count)
    const taskId = (row.dingtalk_task_id ?? '').trim()
    const integrationId = (row.integration_id ?? '').trim()
    if (!taskId || !integrationId) {
      // Data anomaly (a `created` row always carries both). Definite non-delivery, but NOT
      // redelivery-safe: a requeue has nothing to act on and an operator must look at the row.
      return await this.markTerminal(row.id, 'failed', attemptCount, TODO_MIRROR_ERROR_CODES.missingTaskId, false)
        ? 'failed'
        : 'lost-lease'
    }

    const operatorUnionId = await this.resolveOperatorUnionId(integrationId, row.org_id)
    if (!operatorUnionId) {
      return this.retryOrFail(row, attemptCount, TODO_MIRROR_ERROR_CODES.operatorMissing, true)
    }

    let config: DingTalkMessageConfig
    try {
      config = await this.readConfig(integrationId)
    } catch {
      return this.retryOrFail(row, attemptCount, TODO_MIRROR_ERROR_CODES.configUnavailable, true)
    }

    try {
      const accessToken = await this.fetchAccessToken(config)
      await this.completeTodoTask(accessToken, operatorUnionId, taskId, {})
      return await this.markTerminal(row.id, 'completed', attemptCount, null, false) ? 'completed' : 'lost-lease'
    } catch (error) {
      if (isDingTalkTodoTaskMissing(error)) {
        // Already gone on DingTalk's side ⇒ the goal state is reached.
        return await this.markTerminal(row.id, 'completed', attemptCount, null, false) ? 'completed' : 'lost-lease'
      }
      if (isDingTalkOutcomeUnknown(error)) {
        return await this.markTerminal(row.id, 'outcome_unknown', attemptCount, TODO_MIRROR_ERROR_CODES.completeOutcomeUnknown, false)
          ? 'outcome_unknown'
          : 'lost-lease'
      }
      const definite = isDefiniteDingTalkRejection(error)
      return this.retryOrFail(row, attemptCount, TODO_MIRROR_ERROR_CODES.completeFailed, !definite)
    }
  }

  /**
   * One place decides retry-vs-dead-letter. `redeliverySafe` is TRUE only for a DEFINITE non-delivery
   * (a rejection we received an answer for, or a pre-send failure that never touched DingTalk) — an
   * ambiguous result never reaches here (it terminates as `outcome_unknown` above).
   */
  private async retryOrFail(
    row: TodoMirrorRow,
    attemptCount: number,
    code: string,
    retryable: boolean,
  ): Promise<TodoMirrorDeliverOutcome> {
    if (!retryable || attemptCount >= this.maxAttempts) {
      return await this.markTerminal(row.id, 'failed', attemptCount, code, true) ? 'failed' : 'lost-lease'
    }
    return await this.markRetrying(row, attemptCount, code) ? 'retrying' : 'lost-lease'
  }

  /**
   * Back to the phase the row came from (`sending` ⇒ `pending`, `completing` ⇒ `completing`) with the
   * next attempt scheduled. Retrying a completion must NEVER land on `pending`: that would create a
   * SECOND todo for a task whose todo already exists.
   */
  private async markRetrying(row: TodoMirrorRow, attemptCount: number, code: string): Promise<boolean> {
    const now = this.now()
    const next = new Date(now.getTime() + computeTodoMirrorBackoffMs(attemptCount)).toISOString()
    const claimedStatus = row.status
    const nextStatus = claimedStatus === 'completing' ? 'completing' : 'pending'
    const result = await this.query(
      `UPDATE ${DINGTALK_TODO_MIRRORS_TABLE}
          SET status = $7,
              next_attempt_at = $2::timestamptz,
              last_error = $3,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              send_issued_at = NULL,
              updated_at = $4::timestamptz
        WHERE id = $1::uuid
          AND status = $8
          AND claim_worker_id = $5
          AND attempt_count = $6::int`,
      [row.id, next, code, now.toISOString(), this.workerId, attemptCount, nextStatus, claimedStatus],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  /**
   * Stamp `send_issued_at` under the lease CAS, immediately before the create request is issued.
   * Returns false when the lease is no longer ours (nothing is sent in that case).
   */
  private async markSendIssued(id: string, attemptCount: number): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE ${DINGTALK_TODO_MIRRORS_TABLE}
          SET send_issued_at = $2::timestamptz,
              updated_at = $2::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $3
          AND attempt_count = $4::int`,
      [id, now, this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  /**
   * Post-create liveness re-check (Q19 finding "terminal event during `sending`"). If the seat this row
   * mirrors is no longer an ACTIVE `approval_assignments` row, the just-created todo must be taken back
   * immediately: move `created` → `completing` so the very next tick marks it done. The instance status
   * only picks the `complete_reason`; the RETIREMENT decision is the seat, so a plain node advance during
   * the send window is covered too.
   *
   * Best-effort by construction: a probe failure leaves the row `created` (today's behaviour), it never
   * turns a delivered todo into an error. The CAS `status = 'created'` makes it a no-op when a terminal
   * event got there first.
   */
  private async retireCreatedSeatIfGone(row: TodoMirrorRow): Promise<boolean> {
    try {
      const probe = await this.query<{ seat_live: boolean; instance_status: string | null }>(
        `SELECT EXISTS (
           SELECT 1 FROM approval_assignments a
            WHERE a.instance_id = $1
              AND a.node_key = $2
              AND a.assignee_id = $3
              AND a.entry_epoch IS NOT DISTINCT FROM $4::int
              AND a.is_active = TRUE
         ) AS seat_live,
         (SELECT i.status FROM approval_instances i WHERE i.id = $1) AS instance_status`,
        [row.instance_id, row.node_key, row.recipient_user_id, row.entry_epoch],
      )
      const probed = probe.rows[0]
      if (!probed || probed.seat_live !== false) return false
      const reason = todoMirrorReasonFromInstanceStatus(probed.instance_status)
      const now = this.now().toISOString()
      const updated = await this.query(
        `UPDATE ${DINGTALK_TODO_MIRRORS_TABLE}
            SET status = 'completing',
                complete_reason = $2,
                attempt_count = 0,
                next_attempt_at = $3::timestamptz,
                last_error = NULL,
                claim_worker_id = NULL,
                claim_expires_at = NULL,
                updated_at = $3::timestamptz
          WHERE id = $1::uuid
            AND status = 'created'`,
        [row.id, reason, now],
      )
      const flipped = Number(updated.rowCount ?? 0) === 1
      if (flipped) {
        this.logger.info(
          `DingTalk todo mirror: seat gone mid-send, retiring instance=${row.instance_id} node=${row.node_key} reason=${reason}`,
        )
      }
      return flipped
    } catch {
      return false
    }
  }

  private async markCreated(
    id: string,
    attemptCount: number,
    input: { taskId: string | null; unionId: string; integrationId: string },
  ): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE ${DINGTALK_TODO_MIRRORS_TABLE}
          SET status = 'created',
              dingtalk_task_id = $5,
              recipient_union_id = $6,
              integration_id = $7::uuid,
              last_error = NULL,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $2::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $3
          AND attempt_count = $4::int`,
      [id, now, this.workerId, attemptCount, input.taskId, input.unionId, input.integrationId],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  /**
   * Terminal CAS write. Only the lease holder, on the matching attempt, may terminate a row — exactly
   * the attendance worker's guard. `redeliverySafe` is written by the caller's classification and is
   * the operator requeue gate's second predicate.
   */
  private async markTerminal(
    id: string,
    status: 'completed' | 'failed' | 'skipped' | 'outcome_unknown',
    attemptCount: number,
    code: string | null,
    redeliverySafe: boolean,
  ): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE ${DINGTALK_TODO_MIRRORS_TABLE}
          SET status = $5,
              last_error = $6,
              redelivery_safe = $7,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $2::timestamptz
        WHERE id = $1::uuid
          AND status IN ('sending', 'completing')
          AND claim_worker_id = $3
          AND attempt_count = $4::int`,
      [id, now, this.workerId, attemptCount, status, code, redeliverySafe],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  /**
   * unionId + credentials for ONE recipient, scoped to the mirror row's org.
   *
   * PRIMARY: the directory binding (`directory_account_links.link_status='linked'` →
   * `directory_accounts.is_active` → `directory_integrations.status='active' AND org_id = row.org_id`)
   * — the exact join `AttendanceNotificationDeliveryWorker.resolveRecipient` uses, reading `union_id`
   * instead of `external_user_id`. Cross-org never resolves (design §7).
   *
   * FALLBACK: `user_external_identities.provider_union_id` (written by the OAuth/免登 path, which
   * populates no directory row). It is joined to an ACTIVE integration of THIS org via `corp_id`, so
   * the fallback can neither resolve a foreign corp's unionId nor leave us without credentials — a
   * bare "any unionId on the user" fallback would have done both.
   *
   * >1 candidate is a directory data anomaly, NOT an onboarding gap: guessing could create the todo on
   * the wrong corp account, so it fails instead (same posture as the attendance worker).
   */
  private async resolveRecipient(row: TodoMirrorRow): Promise<RecipientResolution> {
    const linked = await this.query<{ integration_id: string; union_id: string | null }>(
      `SELECT i.id::text AS integration_id,
              a.union_id
         FROM directory_account_links l
         JOIN directory_accounts a
           ON a.id = l.directory_account_id
          AND a.provider = 'dingtalk'
          AND a.is_active = true
         JOIN directory_integrations i
           ON i.id = a.integration_id
          AND i.provider = 'dingtalk'
          AND i.status = 'active'
          AND i.org_id = $2
        WHERE l.local_user_id = $1
          AND l.link_status = 'linked'
          AND a.union_id IS NOT NULL
          AND length(btrim(a.union_id)) > 0
        ORDER BY i.updated_at DESC, a.updated_at DESC, a.id ASC
        LIMIT 2`,
      [row.recipient_user_id, row.org_id],
    )
    if (linked.rows.length > 1) {
      return { ok: false, outcome: 'failed', code: TODO_MIRROR_ERROR_CODES.recipientAmbiguous }
    }
    if (linked.rows.length === 1) {
      const unionId = String(linked.rows[0].union_id ?? '').trim()
      if (unionId) {
        return { ok: true, unionId, integrationId: String(linked.rows[0].integration_id) }
      }
    }

    const fallback = await this.query<{ integration_id: string; provider_union_id: string | null }>(
      `SELECT i.id::text AS integration_id,
              e.provider_union_id
         FROM user_external_identities e
         JOIN directory_integrations i
           ON i.corp_id = e.corp_id
          AND i.provider = 'dingtalk'
          AND i.status = 'active'
          AND i.org_id = $2
        WHERE e.local_user_id = $1
          AND e.provider = 'dingtalk'
          AND e.provider_union_id IS NOT NULL
          AND length(btrim(e.provider_union_id)) > 0
        ORDER BY i.updated_at DESC, e.updated_at DESC
        LIMIT 2`,
      [row.recipient_user_id, row.org_id],
    )
    if (fallback.rows.length > 1) {
      return { ok: false, outcome: 'failed', code: TODO_MIRROR_ERROR_CODES.recipientAmbiguous }
    }
    if (fallback.rows.length === 1) {
      const unionId = String(fallback.rows[0].provider_union_id ?? '').trim()
      if (unionId) {
        return { ok: true, unionId, integrationId: String(fallback.rows[0].integration_id) }
      }
    }

    // Nothing resolved. Disambiguate "this org has no active DingTalk integration at all" (an org-level,
    // recoverable outage ⇒ keep retrying) from "this person is not onboarded" (structural ⇒ skip), the
    // same split the attendance worker makes.
    const orgProbe = await this.query<{ has_active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM directory_integrations
          WHERE org_id = $1 AND provider = 'dingtalk' AND status = 'active'
       ) AS has_active`,
      [row.org_id],
    )
    if (!orgProbe.rows[0]?.has_active) {
      return { ok: false, outcome: 'retry', code: TODO_MIRROR_ERROR_CODES.orgIntegrationInactive }
    }
    return { ok: false, outcome: 'skipped', code: TODO_MIRROR_ERROR_CODES.recipientNotBound }
  }

  /** Display name for the subject. Best-effort: a missing/unreadable template just shortens the title. */
  private async readTemplateName(templateId: string | null): Promise<string | null> {
    const id = (templateId ?? '').trim()
    if (!id) return null
    try {
      const result = await this.query<{ name: string | null }>(
        'SELECT name FROM approval_templates WHERE lower(id::text) = lower($1) LIMIT 1',
        [id],
      )
      const name = result.rows[0]?.name
      return typeof name === 'string' && name.trim() ? name.trim() : null
    } catch {
      return null
    }
  }
}

/**
 * A DingTalk answer we DID receive AND that no retry can change: the request was definitely rejected and
 * nothing was created. `true` here dead-letters the row on attempt #1 (retryOrFail is called with
 * `retryable = !definite`), so the set must stay exactly the answers that are permanent.
 *
 * Q19 fix: 429 (flow control) and 408 (gateway timeout) are TRANSIENT. The transport hands a send-tier
 * 429 back as a plain `DingTalkRequestError` with `outcomeUnknown: false` precisely so the LEDGER
 * decides (transport.ts:540-544), and treating every 4xx as permanent dead-lettered every mirror row in
 * a rate-limited window on its first attempt — the 1m/5m/15m/60m/6h ladder never ran. This is the same
 * set the attendance worker retries (`isRetryableDingTalkErrorCode`,
 * AttendanceNotificationDeliveryWorker.ts:1155-1157). 5xx is defence in depth: a send-tier 5xx normally
 * arrives pre-marked outcome-unknown and terminates above, and if it ever arrives bare it is not a
 * permanent rejection either.
 *
 * `DingTalkBusinessError` is UNREACHABLE for the three todo endpoints (`envelope: 'none'`; the transport
 * only raises it for `envelope: 'oapi'`, transport.ts:398-404). It is kept as a definite rejection for
 * the shape's own sake, but no todo-path test may claim coverage through it.
 */
function isDefiniteDingTalkRejection(error: unknown): boolean {
  if (isDingTalkOutcomeUnknown(error)) return false
  if (error instanceof DingTalkBusinessError) return true
  if (error instanceof DingTalkRequestError) {
    if (error.statusCode === 408 || error.statusCode === 429) return false
    if (error.statusCode >= 500) return false
    return error.statusCode >= 400
  }
  return false
}

/** Instance status ⇒ `complete_reason`. Anything non-terminal (or unknown) is a plain node advance. */
export function todoMirrorReasonFromInstanceStatus(status: string | null | undefined): TodoMirrorCompleteReason {
  switch (String(status ?? '').trim().toLowerCase()) {
    case 'approved': return 'approved'
    case 'rejected': return 'rejected'
    case 'revoked': return 'revoked'
    case 'cancelled':
    case 'canceled': return 'cancelled'
    default: return 'next_node'
  }
}

export type TodoMirrorRequeueOutcome =
  | 'requeued'
  | 'already_delivered'
  | 'refused_outcome_unknown'
  /** The gate's two status predicates passed, but the approval seat is no longer live (Q19 fix). */
  | 'refused_seat_gone'
  | 'not_eligible'
  | 'not_found'

export interface TodoMirrorRequeueResult {
  outcome: TodoMirrorRequeueOutcome
  id: string
  status: string | null
  previousStatus: string | null
  orgId: string | null
}

type RequeueQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * OPERATOR-INITIATED requeue of ONE failed mirror row. Nothing in the background calls this: the
 * worker only ever claims pending/completing (and a lease-expired `sending`, which it now terminates
 * as ambiguous instead of resending), so the ONLY failed → live transition in the system is this
 * explicit request. Its production entry point is the operator CLI
 * `packages/core-backend/scripts/dingtalk-todo-mirror-requeue.ts` (see `runDingTalkTodoMirrorRequeueCli`
 * below) — deliberately a CLI and not an HTTP route: this is an on-prem owner action on ONE row, and a
 * route would need a new permission code plus a tenant-scoped surface for a feature that ships OFF.
 *
 * THREE load-bearing gate predicates (each pinned by a mutation test), plus an explicit org scope:
 *   org_id = $2                — the caller must name the tenant; a row of another org is `not_found`,
 *                                never silently requeued and never described back to the caller;
 *   status = 'failed'          — a terminal failure is the only candidate;
 *   redelivery_safe = true     — set by the worker ONLY for a DEFINITE non-delivery. `outcome_unknown`
 *                                rows never get it (and are excluded by the status predicate anyway),
 *                                so an ambiguous send can never be resent.
 *
 * AND (Q19 fix) a row with NO DingTalk task id may only go back to `pending` when its approval SEAT is
 * still live: requeueing a create for an approval that has since finished would mint a todo nobody will
 * ever close (no further approval event is coming for that instance). Rows that DO carry a task id are
 * requeued unconditionally — their pending work is "mark that todo done", which is always safe.
 *
 * AND the phase is RESTORED, not reset: a row that already has a `dingtalk_task_id` goes back to
 * `completing`, never to `pending`. Sending it back to `pending` would create a SECOND todo for a task
 * whose todo already exists — the duplicate the whole ledger exists to prevent.
 */
export async function requeueFailedDingTalkTodoMirror(
  query: RequeueQueryFn,
  input: { id: string; orgId: string },
): Promise<TodoMirrorRequeueResult> {
  const trimmed = (input?.id ?? '').trim()
  const orgId = (input?.orgId ?? '').trim()
  if (trimmed.length === 0 || orgId.length === 0) {
    return { outcome: 'not_found', id: trimmed, status: null, previousStatus: null, orgId: null }
  }

  const updated = await query(
    `UPDATE ${DINGTALK_TODO_MIRRORS_TABLE}
        SET status = CASE WHEN dingtalk_task_id IS NOT NULL THEN 'completing' ELSE 'pending' END,
            attempt_count = 0,
            next_attempt_at = NOW(),
            last_error = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            claim_worker_id = NULL,
            send_issued_at = NULL,
            updated_at = NOW()
      WHERE id = $1::uuid
        AND org_id = $2
        AND status = 'failed'
        AND redelivery_safe = true
        AND (
          dingtalk_task_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM approval_assignments a
             WHERE a.instance_id = ${DINGTALK_TODO_MIRRORS_TABLE}.instance_id
               AND a.node_key = ${DINGTALK_TODO_MIRRORS_TABLE}.node_key
               AND a.assignee_id = ${DINGTALK_TODO_MIRRORS_TABLE}.recipient_user_id
               AND a.entry_epoch IS NOT DISTINCT FROM ${DINGTALK_TODO_MIRRORS_TABLE}.entry_epoch
               AND a.is_active = TRUE
          )
        )
      RETURNING org_id, status`,
    [trimmed, orgId],
  )
  if (Number(updated.rowCount ?? 0) === 1) {
    const row = updated.rows[0] as { org_id?: string; status?: string }
    return {
      outcome: 'requeued',
      id: trimmed,
      status: row.status ?? null,
      previousStatus: 'failed',
      orgId: row.org_id ?? null,
    }
  }

  const read = await query(
    `SELECT status, org_id, redelivery_safe FROM ${DINGTALK_TODO_MIRRORS_TABLE} WHERE id = $1::uuid AND org_id = $2`,
    [trimmed, orgId],
  )
  if (read.rows.length === 0) {
    return { outcome: 'not_found', id: trimmed, status: null, previousStatus: null, orgId: null }
  }
  const row = read.rows[0] as { status: string; org_id: string; redelivery_safe?: boolean }
  const status = String(row.status)
  const base = { id: trimmed, status, previousStatus: status, orgId: row.org_id ?? null }
  if (status === 'created' || status === 'completed') return { outcome: 'already_delivered', ...base }
  if (status === 'outcome_unknown') return { outcome: 'refused_outcome_unknown', ...base }
  // Both status predicates passed, so the ONLY remaining reason the UPDATE matched nothing is the
  // seat-liveness arm: this approval no longer has an active seat for the row.
  if (status === 'failed' && row.redelivery_safe === true) return { outcome: 'refused_seat_gone', ...base }
  return { outcome: 'not_eligible', ...base }
}

export interface TodoMirrorRequeueCliResult {
  exitCode: number
  report: Record<string, unknown>
}

/** `--id <uuid> --org <orgId>`; both are REQUIRED (the org scope is a gate, not a convenience). */
export function parseTodoMirrorRequeueArgv(argv: string[]): { id: string; orgId: string } | null {
  let id = ''
  let orgId = ''
  for (let i = 0; i < argv.length; i += 1) {
    const flag = String(argv[i] ?? '')
    const value = String(argv[i + 1] ?? '').trim()
    if (flag === '--id') { id = value; i += 1 }
    else if (flag === '--org') { orgId = value; i += 1 }
  }
  if (!id || !orgId) return null
  return { id, orgId }
}

/**
 * The operator CLI's whole body, kept in `src/` so it is type-checked and unit-tested; the script file
 * only supplies a pg pool. VALUES-FREE output: ids, statuses and the outcome word — never a subject, a
 * person's name or a unionId.
 */
export async function runDingTalkTodoMirrorRequeueCli(
  query: RequeueQueryFn,
  argv: string[],
): Promise<TodoMirrorRequeueCliResult> {
  const parsed = parseTodoMirrorRequeueArgv(argv)
  if (!parsed) {
    return {
      exitCode: 1,
      report: {
        operation: 'dingtalk_todo_mirror_requeue',
        version: 1,
        valuesFree: true,
        outcome: 'usage',
        usage: 'tsx scripts/dingtalk-todo-mirror-requeue.ts --id <mirror-row-uuid> --org <org-id>',
      },
    }
  }
  const result = await requeueFailedDingTalkTodoMirror(query, parsed)
  return {
    exitCode: result.outcome === 'requeued' ? 0 : 2,
    report: {
      operation: 'dingtalk_todo_mirror_requeue',
      version: 1,
      valuesFree: true,
      id: result.id,
      orgId: parsed.orgId,
      outcome: result.outcome,
      status: result.status,
      previousStatus: result.previousStatus,
    },
  }
}
