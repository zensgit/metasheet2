/**
 * Record-level submit-for-approval — the multitable side of multitable × approval phase 2.
 *
 * Design: docs/development/takeover-beiliao-20260821/
 * multitable-approval-phase2-record-submit-design-20260915.md §3/§4.
 *
 * THE THREE HARD CONSTRAINTS THIS MODULE IS SHAPED BY
 *
 *  1. `ApprovalProductService.createApproval` opens its OWN connection and its OWN transaction and does
 *     not accept an external client. So a submission CANNOT be "one route transaction". It is three
 *     steps against the pool, with the durable row leading:
 *         INSERT 'creating'  →  createApproval(...)  →  UPDATE 'pending' (+ instance id / request no)
 *     and on a createApproval throw: UPDATE 'failed' + a values-free error CODE. The `creating` row is
 *     what makes the in-flight uniqueness real — it exists BEFORE the approval instance does, so two
 *     concurrent submits collide on the index instead of both creating an instance.
 *  2. `createApproval` ends by taking `pg_advisory_xact_lock('record-link:row-auth:…')` on (sheet,
 *     record). We therefore hold NO advisory lock across it — in-flight uniqueness is a PARTIAL UNIQUE
 *     INDEX (`uniq_mt_record_approval_in_flight`), never a lock (design §2.5).
 *  3. `createApproval` re-checks `approvals:write` ITSELF, on the database, inside its transaction. The
 *     multitable-side `multitable:submit-approval` gate is a SECOND door, not a replacement: a caller
 *     needs both. A 403 from createApproval is surfaced as RECORD_APPROVAL_PERMISSION_DENIED.
 *
 * VALUES-FREE BY CONSTRUCTION. Nothing in this module logs, stores or returns a record VALUE:
 *   - the `error` column stores a sanitized upstream error CODE, never a driver/service message
 *     (messages routinely echo row values back);
 *   - the drift response carries FIELD IDS and a count, never a before/after value, and those ids are
 *     filtered through the caller's own field-permission read mask;
 *   - the completion notification message names the outcome only.
 * `record_snapshot` does persist the record's data (that is its purpose, design §3) — it is never
 * returned by any read path in this module.
 */

import { randomUUID } from 'node:crypto'

import type { ApprovalCompletionEventV1, ApprovalCompletionOutcome } from '../services/ApprovalCompletionEvent'
import { insertRecordSubscriptionNotifications } from './record-subscription-service'
import { publishMultitableSheetRealtime } from './realtime-publish'

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export const RECORD_APPROVAL_SUBMISSIONS_TABLE = 'multitable_record_approval_submissions'

/** The partial-unique index that enforces "one in-flight submission per (sheet, record, template)". */
export const RECORD_APPROVAL_IN_FLIGHT_INDEX = 'uniq_mt_record_approval_in_flight'

/**
 * The statuses the in-flight partial unique index covers. MIRRORS the migration's
 * `WHERE status IN ('creating','pending')` predicate — the unit spec asserts the two are byte-equal, so
 * adding a status here without widening the index (or vice versa) is a RED test, not a silent hole.
 */
export const RECORD_APPROVAL_IN_FLIGHT_STATUSES = ['creating', 'pending'] as const

export type RecordApprovalInFlightStatus = (typeof RECORD_APPROVAL_IN_FLIGHT_STATUSES)[number]

export type RecordApprovalSubmissionStatus =
  | RecordApprovalInFlightStatus
  | ApprovalCompletionOutcome
  | 'failed'

/** Terminal outcomes a completion event can carry (the four approval.* completion families). */
export const RECORD_APPROVAL_TERMINAL_OUTCOMES: readonly ApprovalCompletionOutcome[] = [
  'approved',
  'rejected',
  'revoked',
  'cancelled',
]

export interface RecordApprovalSubmissionRow {
  id: string
  sheetId: string
  recordId: string
  templateId: string
  approvalInstanceId: string | null
  approvalRequestNo: string | null
  status: RecordApprovalSubmissionStatus
  outcome: ApprovalCompletionOutcome | null
  submittedBy: string
  recordVersionAtSubmit: number
  error: string | null
  createdAt: string | null
  completedAt: string | null
}

export interface RecordApprovalDrift {
  /** True iff the record has been written since the submission (version is the anchor, design §4.1). */
  changed: boolean
  /** Field IDS only, already masked by the caller's field-permission read set. NEVER values. */
  changedFieldIds: string[]
}

export interface RecordApprovalSubmissionView extends RecordApprovalSubmissionRow {
  drift: RecordApprovalDrift
}

/** Values-free refusal. `code` is an identifier; `message` is a fixed string, never driver text. */
export class RecordApprovalError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'RecordApprovalError'
  }
}

export const RECORD_APPROVAL_ERROR_CODES = {
  inFlight: 'RECORD_APPROVAL_IN_FLIGHT',
  templateNotPublished: 'RECORD_APPROVAL_TEMPLATE_NOT_PUBLISHED',
  templateForbidden: 'RECORD_APPROVAL_TEMPLATE_FORBIDDEN',
  permissionDenied: 'RECORD_APPROVAL_PERMISSION_DENIED',
  recordNotFound: 'RECORD_APPROVAL_RECORD_NOT_FOUND',
  createFailed: 'RECORD_APPROVAL_CREATE_FAILED',
} as const

// ── helpers ────────────────────────────────────────────────────────────────────

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecordObject(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return isRecordObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Accept an upstream error CODE for storage / transport, or refuse it.
 *
 * REFUSE, never rewrite. An earlier shape replaced non-identifier characters with `_`, which turned a
 * message-shaped "code" ("record value: <name> <phone>") into `RECORD_VALUE_____13800000000` — the digits
 * survived, i.e. a value leak wearing an identifier costume. The only safe rule is: the value must
 * ALREADY be an identifier, or it is dropped and the caller falls back to a fixed code.
 */
export function sanitizeErrorCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : null
}

function statusCodeOf(error: unknown): number | null {
  if (error && typeof error === 'object') {
    const raw = (error as { statusCode?: unknown; status?: unknown }).statusCode
      ?? (error as { status?: unknown }).status
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  }
  return null
}

function isUniqueViolation(error: unknown, indexName: string): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code !== '23505') return false
  const constraint = (error as { constraint?: unknown }).constraint
  if (typeof constraint === 'string' && constraint.length > 0) return constraint === indexName
  // Some drivers/proxies drop `constraint`; the index name is still named in the message. This branch
  // NEVER widens the 23505 test — it only disambiguates WHICH unique index was hit.
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.includes(indexName)
}

/**
 * Map a `createApproval` throw onto a values-free record-side refusal (design §4.4):
 *   403 → RECORD_APPROVAL_PERMISSION_DENIED (missing `approvals:write` on the approval side)
 *   other 4xx → the upstream CODE, passed through verbatim after sanitization (e.g. VALIDATION_ERROR,
 *               APPROVAL_ORG_UNRESOLVED — identifiers, never messages)
 *   anything else (5xx / unknown / network) → 502 RECORD_APPROVAL_CREATE_FAILED
 */
export function mapCreateApprovalFailure(error: unknown): RecordApprovalError {
  const status = statusCodeOf(error)
  if (status === 403) {
    return new RecordApprovalError(
      403,
      RECORD_APPROVAL_ERROR_CODES.permissionDenied,
      'Approval creation refused: the requester lacks approval-product write permission',
    )
  }
  if (status !== null && status >= 400 && status < 500) {
    const code = sanitizeErrorCode((error as { code?: unknown }).code)
    return new RecordApprovalError(
      status,
      code ?? RECORD_APPROVAL_ERROR_CODES.createFailed,
      'Approval creation was rejected',
    )
  }
  return new RecordApprovalError(
    502,
    RECORD_APPROVAL_ERROR_CODES.createFailed,
    'Approval creation failed',
  )
}

function mapRow(raw: Record<string, unknown>): RecordApprovalSubmissionRow {
  return {
    id: String(raw.id ?? ''),
    sheetId: String(raw.sheet_id ?? ''),
    recordId: String(raw.record_id ?? ''),
    templateId: String(raw.template_id ?? ''),
    approvalInstanceId: nullableString(raw.approval_instance_id),
    approvalRequestNo: nullableString(raw.approval_request_no),
    status: String(raw.status ?? '') as RecordApprovalSubmissionStatus,
    outcome: (nullableString(raw.outcome) as ApprovalCompletionOutcome | null),
    submittedBy: String(raw.submitted_by ?? ''),
    recordVersionAtSubmit: Number(raw.record_version_at_submit ?? 0),
    error: nullableString(raw.error),
    createdAt: isoOrNull(raw.created_at),
    completedAt: isoOrNull(raw.completed_at),
  }
}

// ── drift ──────────────────────────────────────────────────────────────────────

/** Order-insensitive structural comparison key. Values never leave this function. */
function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (input === undefined) return null
    if (Array.isArray(input)) return input.map(normalize)
    if (isRecordObject(input)) {
      return Object.keys(input)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = normalize(input[key])
          return acc
        }, {})
    }
    return input
  }
  return JSON.stringify(normalize(value))
}

/**
 * Drift between the submit-time snapshot and the record's CURRENT data.
 *
 * `changed` is anchored on the record VERSION (design §4.1): a write bumps `meta_records.version`, so a
 * write-then-revert still reports "data changed since submit" — deliberate, it is a warning, not a diff.
 * `changedFieldIds` is the per-key structural diff, filtered through `readableFieldIds` — the caller's
 * own field-permission read mask. A field the caller may not read NEVER appears, not even as an id, and
 * no value is returned in any case. `readableFieldIds` is REQUIRED (not optional): a caller that forgot
 * to resolve the mask is a compile error, never a silent unmasked answer.
 */
export function computeRecordApprovalDrift(input: {
  snapshot: unknown
  current: unknown
  recordVersion: number
  recordVersionAtSubmit: number
  readableFieldIds: ReadonlySet<string>
}): RecordApprovalDrift {
  const changed = Number(input.recordVersion) > Number(input.recordVersionAtSubmit)
  if (!changed) return { changed: false, changedFieldIds: [] }

  const snapshot = parseJsonObject(input.snapshot)
  const current = parseJsonObject(input.current)
  const keys = new Set<string>([...Object.keys(snapshot), ...Object.keys(current)])
  const changedFieldIds: string[] = []
  for (const key of keys) {
    if (!input.readableFieldIds.has(key)) continue
    if (canonical(snapshot[key]) !== canonical(current[key])) changedFieldIds.push(key)
  }
  changedFieldIds.sort()
  return { changed: true, changedFieldIds }
}

// ── submit (the three steps) ───────────────────────────────────────────────────

export interface SubmitRecordApprovalActor {
  userId: string
  userName?: string
  email?: string
  roles?: string[]
  permissions?: string[]
}

export interface SubmitRecordApprovalInput {
  sheetId: string
  recordId: string
  templateId: string
  formData: Record<string, unknown>
  submittedBy: string
  recordVersion: number
  recordSnapshot: Record<string, unknown>
}

export interface CreatedApprovalRef {
  id: string
  requestNo?: string | null
}

export interface SubmitRecordApprovalDeps {
  /**
   * `ApprovalProductService.createApproval` bound by the caller. Injected (not imported) so this module
   * stays unit-testable and so the approval product's own transaction boundary is unmistakably NOT ours.
   */
  createApproval: (
    request: { templateId: string; formData: Record<string, unknown> },
    actor: SubmitRecordApprovalActor,
  ) => Promise<CreatedApprovalRef>
}

export async function submitRecordApproval(
  query: QueryFn,
  input: SubmitRecordApprovalInput,
  actor: SubmitRecordApprovalActor,
  deps: SubmitRecordApprovalDeps,
): Promise<RecordApprovalSubmissionRow> {
  const submissionId = randomUUID()

  // STEP 1 — the durable `creating` row. This is the in-flight claim: it races on the partial unique
  // index BEFORE any approval instance exists, so a duplicate submit costs nothing but a 409.
  try {
    await query(
      `INSERT INTO ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
         (id, sheet_id, record_id, template_id, status, submitted_by, record_version_at_submit, record_snapshot)
       VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7::jsonb)`,
      [
        submissionId,
        input.sheetId,
        input.recordId,
        input.templateId,
        input.submittedBy,
        Math.trunc(Number(input.recordVersion) || 0),
        JSON.stringify(input.recordSnapshot ?? {}),
      ],
    )
  } catch (error) {
    if (isUniqueViolation(error, RECORD_APPROVAL_IN_FLIGHT_INDEX)) {
      const existing = await loadInFlightSubmission(query, input.sheetId, input.recordId, input.templateId)
      throw new RecordApprovalError(
        409,
        RECORD_APPROVAL_ERROR_CODES.inFlight,
        'This record already has an in-flight approval for this template',
        existing
          ? {
              submissionId: existing.id,
              approvalInstanceId: existing.approvalInstanceId,
              requestNo: existing.approvalRequestNo,
              status: existing.status,
            }
          : undefined,
      )
    }
    throw error
  }

  // STEP 2 — the approval product's own connection + transaction. We hold no lock across this call.
  let approval: CreatedApprovalRef
  try {
    approval = await deps.createApproval(
      { templateId: input.templateId, formData: input.formData },
      actor,
    )
  } catch (error) {
    const mapped = mapCreateApprovalFailure(error)
    // Values-free: the stored `error` is the refusal CODE, never the upstream message.
    await query(
      `UPDATE ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
          SET status = 'failed', error = $2, completed_at = NOW()
        WHERE id = $1 AND status = 'creating'`,
      [submissionId, mapped.code],
    ).catch(() => undefined)
    throw mapped
  }

  // STEP 3 — promote to `pending` and bind the instance. Guarded on `status = 'creating'` so a
  // completion that already landed (auto-approval at create time) cannot be overwritten backwards.
  const updated = await query(
    `UPDATE ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
        SET status = 'pending', approval_instance_id = $2, approval_request_no = $3
      WHERE id = $1 AND status = 'creating'
      RETURNING id, sheet_id, record_id, template_id, approval_instance_id, approval_request_no,
                status, outcome, submitted_by, record_version_at_submit, error, created_at, completed_at`,
    [submissionId, approval.id, approval.requestNo ?? null],
  )
  const row = (updated.rows[0] ?? null) as Record<string, unknown> | null
  if (row) return mapRow(row)

  // The row moved under us (a same-transaction auto-approval completed it first). Re-read: the caller
  // must see the CURRENT state, never a fabricated 'pending'.
  const reread = await query(
    `SELECT id, sheet_id, record_id, template_id, approval_instance_id, approval_request_no,
            status, outcome, submitted_by, record_version_at_submit, error, created_at, completed_at
       FROM ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
      WHERE id = $1`,
    [submissionId],
  )
  const rereadRow = (reread.rows[0] ?? null) as Record<string, unknown> | null
  if (rereadRow) return mapRow(rereadRow)
  throw new RecordApprovalError(
    502,
    RECORD_APPROVAL_ERROR_CODES.createFailed,
    'Approval was created but its submission row could not be read back',
  )
}

async function loadInFlightSubmission(
  query: QueryFn,
  sheetId: string,
  recordId: string,
  templateId: string,
): Promise<RecordApprovalSubmissionRow | null> {
  const result = await query(
    `SELECT id, sheet_id, record_id, template_id, approval_instance_id, approval_request_no,
            status, outcome, submitted_by, record_version_at_submit, error, created_at, completed_at
       FROM ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
      WHERE sheet_id = $1 AND record_id = $2 AND template_id = $3
        AND status = ANY($4::text[])
      ORDER BY created_at DESC
      LIMIT 1`,
    [sheetId, recordId, templateId, [...RECORD_APPROVAL_IN_FLIGHT_STATUSES]],
  )
  const row = (result.rows[0] ?? null) as Record<string, unknown> | null
  return row ? mapRow(row) : null
}

// ── list + drift ───────────────────────────────────────────────────────────────

export const RECORD_APPROVAL_LIST_DEFAULT_LIMIT = 20
export const RECORD_APPROVAL_LIST_MAX_LIMIT = 100

export interface ListRecordApprovalsInput {
  sheetId: string
  recordId: string
  /** The caller's field-permission read mask (REQUIRED — see computeRecordApprovalDrift). */
  readableFieldIds: ReadonlySet<string>
  limit?: number
}

export async function listRecordApprovalSubmissions(
  query: QueryFn,
  input: ListRecordApprovalsInput,
): Promise<RecordApprovalSubmissionView[]> {
  const limit = Math.min(
    Math.max(Number(input.limit ?? RECORD_APPROVAL_LIST_DEFAULT_LIMIT) || RECORD_APPROVAL_LIST_DEFAULT_LIMIT, 1),
    RECORD_APPROVAL_LIST_MAX_LIMIT,
  )
  const recordResult = await query(
    'SELECT version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
    [input.recordId, input.sheetId],
  )
  const recordRow = (recordResult.rows[0] ?? null) as { version?: unknown; data?: unknown } | null
  const recordVersion = Number(recordRow?.version ?? 0)
  const currentData = parseJsonObject(recordRow?.data)

  const result = await query(
    `SELECT id, sheet_id, record_id, template_id, approval_instance_id, approval_request_no,
            status, outcome, submitted_by, record_version_at_submit, error, created_at, completed_at,
            record_snapshot
       FROM ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
      WHERE sheet_id = $1 AND record_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [input.sheetId, input.recordId, limit],
  )

  return (result.rows as Array<Record<string, unknown>>).map((raw) => {
    const row = mapRow(raw)
    return {
      ...row,
      drift: computeRecordApprovalDrift({
        snapshot: raw.record_snapshot,
        current: currentData,
        recordVersion,
        recordVersionAtSubmit: row.recordVersionAtSubmit,
        readableFieldIds: input.readableFieldIds,
      }),
    }
  })
}

// ── completion (durable consumer + eventBus fallback share this) ───────────────

/** The terminal outcome an approval completion event carries, or null if it is not a completion. */
export function recordApprovalCompletionOutcome(
  event: Pick<ApprovalCompletionEventV1, 'eventType' | 'transition'> | null | undefined,
): ApprovalCompletionOutcome | null {
  const fromTransition = event?.transition?.toStatus
  if (fromTransition && (RECORD_APPROVAL_TERMINAL_OUTCOMES as readonly string[]).includes(fromTransition)) {
    return fromTransition as ApprovalCompletionOutcome
  }
  const eventType = event?.eventType
  if (typeof eventType === 'string' && eventType.startsWith('approval.')) {
    const suffix = eventType.slice('approval.'.length)
    if ((RECORD_APPROVAL_TERMINAL_OUTCOMES as readonly string[]).includes(suffix)) {
      return suffix as ApprovalCompletionOutcome
    }
  }
  return null
}

const OUTCOME_MESSAGE_ZH: Record<ApprovalCompletionOutcome, string> = {
  approved: '记录送审已通过',
  rejected: '记录送审已驳回',
  revoked: '记录送审已撤销',
  cancelled: '记录送审已取消',
}

export interface RecordApprovalCompletionDeps {
  insertNotifications?: typeof insertRecordSubscriptionNotifications
  publishRealtime?: (input: { sheetId: string; recordId: string; actorId?: string }) => void
}

export interface RecordApprovalCompletionResult {
  /** True iff THIS delivery moved a `pending` submission to its terminal state (exactly once). */
  applied: boolean
  submissionId?: string
}

/**
 * Terminal-state handler, shared by the durable consumer (`multitable-record-approval`) and the
 * eventBus fallback. IDEMPOTENT BY CONSTRUCTION: the UPDATE is guarded on `status = 'pending'`, so a
 * redelivery (durable retry, or bus + durable double-wiring) updates ZERO rows, sends NO second
 * notification and publishes NO second invalidation. An event for an instance with no submission row
 * (i.e. an approval that did not come from a record) is a no-op success — the durable adapter ACKs it.
 */
export async function applyRecordApprovalCompletion(
  query: QueryFn,
  event: ApprovalCompletionEventV1,
  deps: RecordApprovalCompletionDeps = {},
): Promise<RecordApprovalCompletionResult> {
  const instanceId = typeof event?.approval?.instanceId === 'string' ? event.approval.instanceId.trim() : ''
  if (!instanceId) return { applied: false }
  const outcome = recordApprovalCompletionOutcome(event)
  if (!outcome) return { applied: false }

  const updated = await query(
    `UPDATE ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
        SET status = $2, outcome = $2, completed_at = NOW()
      WHERE approval_instance_id = $1 AND status = 'pending'
      RETURNING id, sheet_id, record_id, submitted_by`,
    [instanceId, outcome],
  )
  const row = (updated.rows[0] ?? null) as
    | { id?: unknown; sheet_id?: unknown; record_id?: unknown; submitted_by?: unknown }
    | null
  if (!row) return { applied: false }

  const submissionId = String(row.id ?? '')
  const sheetId = String(row.sheet_id ?? '')
  const recordId = String(row.record_id ?? '')
  const submittedBy = String(row.submitted_by ?? '')

  const insertNotifications = deps.insertNotifications ?? insertRecordSubscriptionNotifications
  if (submittedBy) {
    await insertNotifications(query, {
      userIds: [submittedBy],
      sheetId,
      recordId,
      eventType: 'notification.sent',
      // Values-free: names the outcome, carries no field value.
      message: OUTCOME_MESSAGE_ZH[outcome],
      actorId: typeof event.actor?.id === 'string' ? event.actor.id : null,
    })
  }

  const publishRealtime = deps.publishRealtime ?? defaultPublishRecordRealtime
  try {
    publishRealtime({ sheetId, recordId })
  } catch {
    // Realtime is a hint, never the source of truth; the durable row is already committed.
  }

  return { applied: true, submissionId }
}

/** The four completion families this consumer listens to (identical to the manifest's approval set). */
export const RECORD_APPROVAL_COMPLETION_EVENT_TYPES = [
  'approval.approved',
  'approval.rejected',
  'approval.revoked',
  'approval.cancelled',
] as const

/**
 * The completion SINK both legs share.
 *
 * TWO LEGS, ONE HANDLER (design §4.3, mirroring AutomationService / ApprovalRecordProjectionService):
 *   - durable: consumer_key `multitable-record-approval` in routing manifest v2;
 *   - eventBus: `approval.{approved,rejected,revoked,cancelled}` subscriptions.
 * Which leg actually delivers is decided by `AUTOMATION_DURABLE_DELIVERY_ENABLED` on the PRODUCE side
 * (`emitApprovalCompletionEvent` returns early when the flag is ON), exactly as for the pre-existing
 * consumers — so both legs stay wired at all times and the idempotent `WHERE status = 'pending'` UPDATE
 * is what makes a double delivery harmless.
 */
export interface RecordApprovalCompletionSink {
  handleApprovalCompletion(event: ApprovalCompletionEventV1): Promise<void>
}

export function createRecordApprovalCompletionSink(
  query: QueryFn,
  deps: RecordApprovalCompletionDeps = {},
): RecordApprovalCompletionSink {
  return {
    async handleApprovalCompletion(event: ApprovalCompletionEventV1): Promise<void> {
      await applyRecordApprovalCompletion(query, event, deps)
    },
  }
}

type CompletionEventBus = {
  subscribe<T>(eventType: string, handler: (payload: T) => void | Promise<void>, plugin?: string): string
}

/**
 * Wire the eventBus leg. Returns the subscription ids (the boot site keeps them for teardown).
 * Failures are logged by the caller-supplied `onError` and never thrown into the bus — a completion that
 * cannot be recorded must not break the other subscribers (same posture as the bridge/projection legs).
 */
export function subscribeRecordApprovalCompletionBus(
  eventBus: CompletionEventBus,
  sink: RecordApprovalCompletionSink,
  onError: (eventType: string, error: unknown) => void = () => undefined,
): string[] {
  const ids: string[] = []
  for (const eventType of RECORD_APPROVAL_COMPLETION_EVENT_TYPES) {
    ids.push(
      eventBus.subscribe<ApprovalCompletionEventV1>(eventType, (payload) => {
        sink.handleApprovalCompletion(payload).catch((error) => onError(eventType, error))
      }),
    )
  }
  return ids
}

function defaultPublishRecordRealtime(input: { sheetId: string; recordId: string; actorId?: string }): void {
  publishMultitableSheetRealtime({
    spreadsheetId: input.sheetId,
    source: 'multitable',
    kind: 'record-updated',
    recordId: input.recordId,
    ...(input.actorId ? { actorId: input.actorId } : {}),
  })
}
