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
 *     TWO CONSEQUENCES THE FIRST CUT GOT WRONG (adversarial review 2026-09-15), both fixed here:
 *       (a) the instance can be TERMINAL by the time step 3 runs (auto-approval policy completes inside
 *           `createApproval` and emits the completion event before it returns, against a row whose
 *           approval_instance_id is still NULL → that delivery matches nothing and is ACKed). Step 3 is
 *           therefore terminal-aware, and when it writes 'pending' it probes the instance ONCE more
 *           (`loadApprovalStatus`) to catch a terminal transition that landed in the same window. That
 *           terminal promote and the requester's notification share ONE transaction (the same
 *           `runInTransaction` dep the completion sink uses), because nothing will ever re-deliver that
 *           already-ACKed completion: a committed terminal row with a failed bell would be permanent.
 *           BUT the transaction alone is not enough here, and that asymmetry is the point (second review
 *           round): the CONSUMER path may safely roll back because its delivery is RETRIED — this path is
 *           retried by nobody, so a bare rollback would leave the row `creating`, the terminal instance
 *           unlinked FOREVER (the instance-keyed UPDATE only matches `pending`) and the TTL reclaim would
 *           later stamp it `failed` while the approval center says approved. So a rolled-back terminal
 *           write is COMPENSATED: the promote is replayed alone, stamped with the values-free row code
 *           `notificationFailed`. Worst case is then the PRE-CHANGE outcome (correct terminal row, missing
 *           bell) plus a visible marker — never a lost binding.
 *       (b) `creating` must not be an ABSORBING state: every follow-up UPDATE can fail and nothing else
 *           in the system ever clears such a row (no revoke endpoint, no sweeper), so a stale claim is
 *           reclaimable after RECORD_APPROVAL_CREATING_CLAIM_TTL_MS, and a 5xx/unknown createApproval
 *           throw KEEPS the claim (an instance may exist) instead of freeing the slot for a duplicate.
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

import { Logger } from '../core/logger'
import type { ApprovalCompletionEventV1, ApprovalCompletionOutcome } from '../services/ApprovalCompletionEvent'
import { loadReadableApprovalTemplateNames } from './automation-approval-template-access'
import { insertRecordSubscriptionNotifications } from './record-subscription-service'
import { publishMultitableSheetRealtime } from './realtime-publish'

/** Values-free by policy: every log line below carries IDS ONLY (submission id / instance id / codes). */
const logger = new Logger('RecordApprovalSubmission')

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
  /**
   * `approval_templates.name` for `templateId`, or null when the template is GONE (deleted after the
   * submission) — the client then falls back to the id it already has. Directory data, not a record value.
   */
  templateName: string | null
  /** The submitter's display name (see `recordApprovalDisplayName`), or null when the user row is gone. */
  submittedByName: string | null
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

/**
 * Codes stamped on the submission row's `error` column (values-free identifiers, never HTTP codes):
 *   - `unverified` — `createApproval` threw with a 5xx/unknown status. It COMMITs its instance and only
 *     THEN runs post-commit work that can still throw (task-created emit, the read-model projection, the
 *     viewer-scoped read-back that raises 500 APPROVAL_CREATE_FAILED on a miss). So a 5xx throw does NOT
 *     prove "no approval exists": the claim is KEPT (see releaseOrKeepClaim) so the next submit cannot
 *     silently create a SECOND live approval for the same record.
 *   - `claimExpired` — a `creating` claim older than the TTL was reclaimed by a later submit.
 *   - `notificationFailed` — an auto-approved submission whose terminal write is CORRECT but whose
 *     requester bell could not be written (the atomic attempt rolled back and was compensated, see step
 *     3). The row is the truth; the marker says "this one owes a notification" so a missing bell is
 *     visible instead of silent.
 */
export const RECORD_APPROVAL_ROW_ERROR_CODES = {
  unverified: 'RECORD_APPROVAL_CREATE_UNVERIFIED',
  claimExpired: 'RECORD_APPROVAL_CLAIM_EXPIRED',
  notificationFailed: 'RECORD_APPROVAL_NOTIFICATION_FAILED',
} as const

/**
 * How long a `creating` claim may hold the in-flight slot before a LATER submit may reclaim it.
 *
 * `creating` must never be an ABSORBING state. The row is written before `createApproval` and is cleared
 * by one of two follow-up UPDATEs — both of which can themselves fail (connection reset, statement
 * timeout, process death between the two statements). Without a bounded lifetime such a row keeps the
 * partial unique index closed over (sheet, record, template) FOREVER, and there is no revoke/delete
 * endpoint and no sweeper to open it (design ships neither). The repo already ratified this law for the
 * analogous bridge table (`zzzz20260717120000_approval_bridge_lease.ts`: "no stuck absorbing state").
 * Reclaim is opportunistic (it happens on the NEXT submit, not on a timer) and the staleness predicate is
 * evaluated by the DATABASE clock, never the caller's.
 *
 * KNOWN RESIDUAL (named, not hidden): a claim parked by an AMBIGUOUS createApproval throw may correspond
 * to a live approval instance we never got to bind. Reclaiming it after the TTL therefore permits a second
 * instance for that (record, template). There is no oracle to do better — `createApproval` exposes no
 * correlation key the caller can set (`business_key` is not settable) — so the trade is: block duplicates
 * for the TTL window (fail-closed while the truth is unknown), then prefer an unblocked record over a
 * permanently bricked one. Widening this window is cheap (one constant); shrinking it is not free.
 */
export const RECORD_APPROVAL_CREATING_CLAIM_TTL_MS = 5 * 60 * 1000

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

/**
 * The approval instance's status as a TERMINAL outcome, or null when it is still running.
 * Same predicate the automation bridge applies to `createApproval`'s DTO (`isTerminalApprovalStatus`).
 */
export function terminalOutcomeOf(status: unknown): ApprovalCompletionOutcome | null {
  return typeof status === 'string' && (RECORD_APPROVAL_TERMINAL_OUTCOMES as readonly string[]).includes(status)
    ? (status as ApprovalCompletionOutcome)
    : null
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
  /**
   * The instance's status AS RETURNED BY `createApproval` (its `UnifiedApprovalDTO` carries it).
   *
   * LOAD-BEARING, not decoration. A template with an auto-approval policy makes the instance TERMINAL
   * inside `createApproval` (`applyAutoApprovalCascade`) and emits its completion event BEFORE it returns
   * (ApprovalProductService: the `emitApprovalCompletionEvent(completionEvent)` call sits between COMMIT
   * and `return approval`; with the durable flag ON the same event is enqueued in-txn and a worker can
   * dispatch it just as early). At that instant THIS submission row is still
   * ('creating', approval_instance_id = NULL), so the instance-keyed completion UPDATE matches ZERO rows
   * and is ACKed — that delivery is gone. Promoting the row to 'pending' afterwards would strand it
   * pending forever (the instance can never emit again; there is no revoke endpoint and no sweeper) and
   * the in-flight partial unique index would refuse every future submission of that (record, template)
   * pair with 409. So step 3 promotes straight to the terminal state when this says terminal — the same
   * read the automation bridge makes on the same DTO (`isTerminalApprovalStatus`).
   */
  status?: string | null
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
  /**
   * Read an approval instance's CURRENT status by id. Optional; supplied by the route.
   *
   * It closes the residual half of the race the DTO status cannot: an instance that goes terminal AFTER
   * `createApproval` committed but BEFORE step 3 bound the instance id (another user's approve landing in
   * that window). That completion is also delivered against an unbound row and ACKed. Called ONCE, only
   * when the promote wrote 'pending'. Any completion that lands AFTER the promote finds a bound `pending`
   * row and applies normally, so promote-then-reconcile leaves no window at all.
   */
  loadApprovalStatus?: (instanceId: string) => Promise<string | null>
  /** Notification / realtime / transaction wiring used when submit itself discovers a terminal state. */
  completion?: RecordApprovalCompletionDeps
}

export async function submitRecordApproval(
  query: QueryFn,
  input: SubmitRecordApprovalInput,
  actor: SubmitRecordApprovalActor,
  deps: SubmitRecordApprovalDeps,
): Promise<RecordApprovalSubmissionRow> {
  const submissionId = randomUUID()
  const completionDeps = deps.completion ?? {}

  // STEP 1 — the durable `creating` row. This is the in-flight claim: it races on the partial unique
  // index BEFORE any approval instance exists, so a duplicate submit costs nothing but a 409.
  const insertClaim = async (): Promise<boolean> => {
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
      return true
    } catch (error) {
      if (isUniqueViolation(error, RECORD_APPROVAL_IN_FLIGHT_INDEX)) return false
      throw error
    }
  }

  if (!(await insertClaim())) {
    const existing = await loadInFlightSubmission(query, input.sheetId, input.recordId, input.templateId)
    // A `creating` claim older than the TTL is ABANDONED (the process that made it died, or the UPDATE
    // that should have cleared it failed). Reclaim it instead of refusing forever — `creating` is not an
    // absorbing state (see RECORD_APPROVAL_CREATING_CLAIM_TTL_MS). The staleness predicate runs on the
    // DATABASE clock and is guarded on `status = 'creating'`, so a live claim (or a racing reclaimer)
    // updates zero rows and we fall through to the honest 409.
    let reclaimed = false
    if (existing && existing.status === 'creating') {
      const reaped = await query(
        `UPDATE ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
            SET status = 'failed', error = COALESCE(error, $2), completed_at = NOW()
          WHERE id = $1 AND status = 'creating'
            AND created_at < NOW() - ($3::double precision * INTERVAL '1 millisecond')`,
        [existing.id, RECORD_APPROVAL_ROW_ERROR_CODES.claimExpired, RECORD_APPROVAL_CREATING_CLAIM_TTL_MS],
      )
      if ((reaped.rowCount ?? 0) > 0) reclaimed = await insertClaim()
    }
    if (!reclaimed) {
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
              // A values-free CODE (or null). A claim stuck without an instance link is otherwise
              // indistinguishable from a healthy in-flight approval on the client.
              error: existing.error,
            }
          : undefined,
      )
    }
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
    await releaseOrKeepClaim(query, submissionId, mapped)
    throw mapped
  }

  // STEP 3 — bind the instance and promote. TERMINAL-AWARE (see CreatedApprovalRef.status): an approval
  // that was already terminal when it was created is written terminal HERE, because its completion event
  // was delivered against an unbound row and dropped.
  const createdOutcome = terminalOutcomeOf(approval.status)

  /**
   * The bind + promote. `errorCode` is NULL on every normal call (`COALESCE($6::text, error)` then leaves
   * the column exactly as it was) and carries a values-free row code only on the compensating replay.
   */
  const promote = async (q: QueryFn, errorCode: string | null = null): Promise<Record<string, unknown> | null> => {
    const promoted = await q(
      `UPDATE ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
        SET status = $4, outcome = $5, approval_instance_id = $2, approval_request_no = $3,
            error = COALESCE($6::text, error),
            completed_at = CASE WHEN $5::text IS NULL THEN completed_at ELSE NOW() END
      WHERE id = $1 AND status = 'creating'
      RETURNING id, sheet_id, record_id, template_id, approval_instance_id, approval_request_no,
                status, outcome, submitted_by, record_version_at_submit, error, created_at, completed_at`,
      [submissionId, approval.id, approval.requestNo ?? null, createdOutcome ?? 'pending', createdOutcome, errorCode],
    )
    return (promoted.rows[0] ?? null) as Record<string, unknown> | null
  }

  /**
   * AUTO-APPROVED AT CREATE — the terminal promote and the requester's bell are ONE write.
   *
   * This is the same pair the completion consumer makes atomic (`applyRecordApprovalTerminalByInstance`
   * + RecordApprovalCompletionDeps.runInTransaction), and it is MORE load-bearing here, not less: the
   * instance's own completion event was already delivered against an unbound row and ACKed, so nothing
   * will ever re-deliver it. If the promote committed alone and the notification INSERT then threw, the
   * row would sit terminal with NO bell forever — an unrecoverable half-write. Inside one transaction the
   * failure rolls BOTH back, so the happy path can never commit half of the pair.
   *
   * THE ROLLBACK IS NOT THE END STATE (second review round). The consumer path can stop at "rolled back,
   * the row stays pending" only because its delivery is RETRIED; on THIS path nobody retries, so leaving
   * the row `creating` would be worse than the bug it fixes: the instance is already terminal, the
   * instance-keyed UPDATE only ever matches `pending`, so the binding would be lost forever, the TTL
   * reclaim would stamp the row `failed` for an APPROVED approval, and the next submit would create a
   * SECOND instance. The catch below therefore COMPENSATES: replay the promote alone (bell-free) and stamp
   * `notificationFailed`. Ordering is what buys the improvement — atomic first (no half-write when the
   * bell merely deadlocks and the replay can still win), degraded second, refusal only if the replay fails
   * too (claim kept, nothing invented).
   *
   * Non-terminal ('pending') submissions are untouched by this: they write one statement, exactly as
   * before, and their notification arrives with the real completion event.
   */
  const promoteTerminal = async (q: QueryFn): Promise<Record<string, unknown> | null> => {
    const promotedRow = await promote(q)
    if (promotedRow && createdOutcome) {
      await notifyRecordApprovalTerminal(q, promotedRow, createdOutcome, null, completionDeps)
    }
    return promotedRow
  }

  let row: Record<string, unknown> | null = null
  try {
    if (createdOutcome && completionDeps.runInTransaction) {
      row = await completionDeps.runInTransaction(promoteTerminal)
    } else if (createdOutcome) {
      // NO RUNNER (unit fakes, or a boot site that wired none): there is no transaction to roll back, so
      // the promote has already committed on its own and the bell stays BEST-EFFORT — failing the submit
      // here would report "could not be linked" about a row that IS linked. Production always supplies the
      // runner (the route passes `createPoolTransactionRunner(pool)`), so this branch is the fallback, not
      // the contract.
      row = await promote(query)
      if (row) {
        try {
          await notifyRecordApprovalTerminal(query, row, createdOutcome, null, completionDeps)
        } catch (error) {
          logger.warn(
            `[multitable.record.approval] submission ${submissionId} notification for an auto-approved instance failed (${error instanceof Error ? error.name : 'unknown'})`,
          )
        }
      }
    } else {
      row = await promote(query)
    }
  } catch (error) {
    const atomicTerminalRolledBack = Boolean(createdOutcome && completionDeps.runInTransaction)
    if (atomicTerminalRolledBack) {
      // COMPENSATE the rolled-back terminal write (see promoteTerminal): the instance is terminal and
      // NOTHING will re-deliver its completion, so the binding must be replayed here or it is lost. The
      // replay writes the SAME guarded statement (`status = 'creating'`), bell-free, plus a values-free
      // marker saying this row still owes its notification.
      try {
        row = await promote(query, RECORD_APPROVAL_ROW_ERROR_CODES.notificationFailed)
        logger.warn(
          `[multitable.record.approval] submission ${submissionId} instance ${approval.id} landed terminal WITHOUT its requester notification (compensated after a rolled-back atomic write)`,
        )
      } catch (compensationError) {
        // Both the atomic write and its replay failed: there is nothing honest left to write. Fall through
        // to the refusal with the claim KEPT.
        logger.error(
          `[multitable.record.approval] submission ${submissionId} compensating promote for instance ${approval.id} failed; claim kept until the ${RECORD_APPROVAL_CREATING_CLAIM_TTL_MS}ms TTL reclaim`,
          compensationError instanceof Error ? new Error(compensationError.name) : undefined,
        )
        throw new RecordApprovalError(
          502,
          RECORD_APPROVAL_ERROR_CODES.createFailed,
          'The approval was created but could not be linked to the record',
        )
      }
    } else {
      // The approval instance EXISTS but the submission could not be promoted (the bind UPDATE failed).
      // Marking the row 'failed' here would be both a lie and a hole (it would free the in-flight slot for
      // a duplicate live approval). Keep the claim, log IDS ONLY, and let the TTL reclaim release it.
      logger.error(
        `[multitable.record.approval] submission ${submissionId} could not bind approval instance ${approval.id}; claim kept until the ${RECORD_APPROVAL_CREATING_CLAIM_TTL_MS}ms TTL reclaim`,
        error instanceof Error ? new Error(error.name) : undefined,
      )
      throw new RecordApprovalError(
        502,
        RECORD_APPROVAL_ERROR_CODES.createFailed,
        'The approval was created but could not be linked to the record',
      )
    }
  }

  if (row && createdOutcome) return mapRow(row)

  if (row && deps.loadApprovalStatus) {
    const observed = await deps.loadApprovalStatus(approval.id).catch((error) => {
      logger.warn(
        `[multitable.record.approval] submission ${submissionId} post-promote status probe failed (${error instanceof Error ? error.name : 'unknown'})`,
      )
      return null
    })
    const reconciled = terminalOutcomeOf(observed)
    if (reconciled) {
      // It went terminal in the window between createApproval's COMMIT and the promote above, so its
      // completion was delivered against an unbound row. Apply it now; the write is the SAME guarded
      // statement the completion consumer uses, so a racing live delivery and this reconcile cannot both
      // notify.
      const applied = await applyRecordApprovalTerminalByInstance(query, approval.id, reconciled, null, completionDeps)
      if (applied.row) return mapRow(applied.row)
    }
  }

  if (row) return mapRow(row)

  // The row moved under us. Re-read: the caller must see the CURRENT state, never a fabricated 'pending'.
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

/**
 * A `createApproval` throw is only SOMETIMES proof that no approval exists.
 *
 *   4xx   → the refusal happened BEFORE the approval product's transaction committed (permission,
 *           validation and org resolution all run ahead of its BEGIN). RELEASE the claim ('failed') so the
 *           requester can fix the input and re-submit immediately — design §4.1's rule.
 *   other → AMBIGUOUS (5xx / driver / network). `createApproval` COMMITs and then does post-commit work
 *           that can still throw, so an instance may well exist. Releasing the claim would let the very
 *           next submit create a SECOND live approval for the same record while the first one is still
 *           running — the exact invariant §3 promises. KEEP the claim, stamp the values-free code, and let
 *           the TTL reclaim release it.
 *
 * Neither UPDATE is silently swallowed: a failure is LOGGED with ids only, so a stuck claim is visible.
 */
async function releaseOrKeepClaim(
  query: QueryFn,
  submissionId: string,
  mapped: RecordApprovalError,
): Promise<void> {
  const preCommitRefusal = mapped.statusCode >= 400 && mapped.statusCode < 500
  try {
    if (preCommitRefusal) {
      // Values-free: the stored `error` is the refusal CODE, never the upstream message.
      await query(
        `UPDATE ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
          SET status = 'failed', error = $2, completed_at = NOW()
        WHERE id = $1 AND status = 'creating'`,
        [submissionId, mapped.code],
      )
    } else {
      await query(
        `UPDATE ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
          SET error = $2
        WHERE id = $1 AND status = 'creating'`,
        [submissionId, RECORD_APPROVAL_ROW_ERROR_CODES.unverified],
      )
    }
  } catch (error) {
    logger.error(
      `[multitable.record.approval] submission ${submissionId} claim could not be ${preCommitRefusal ? 'released' : 'stamped'}; it holds the in-flight slot until the ${RECORD_APPROVAL_CREATING_CLAIM_TTL_MS}ms TTL reclaim`,
      error instanceof Error ? new Error(error.name) : undefined,
    )
  }
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

/**
 * `?limit=` is CALLER INPUT, so the bound lives HERE (the service), not in the route: every caller gets
 * the same clamp and a future second caller cannot forget it.
 *   - absent / BLANK / non-numeric → RECORD_APPROVAL_LIST_DEFAULT_LIMIT
 *   - 0, negatives, fractions      → clamped UP to 1 (a zero-row page is never what a drawer asked for)
 *   - anything over the max        → clamped DOWN to RECORD_APPROVAL_LIST_MAX_LIMIT (one request must not
 *                                    be able to read the whole table for a hot record)
 *
 * BLANK IS ABSENT, not zero (review round 2): Express hands `?limit=` to the handler as `''` (and a
 * repeated `?limit=&limit=` as an array), and `Number('')` is 0 — finite, so the clamp would raise it to
 * 1 and answer a ONE-row page where the caller asked for the default. An empty value is a caller that
 * said nothing, so it gets what saying nothing gets.
 */
export function clampRecordApprovalListLimit(value: unknown): number {
  const blank = value == null
    || (typeof value === 'string' && value.trim().length === 0)
    || (Array.isArray(value) && value.length === 0)
  const raw = Number(blank ? RECORD_APPROVAL_LIST_DEFAULT_LIMIT : value)
  if (!Number.isFinite(raw)) return RECORD_APPROVAL_LIST_DEFAULT_LIMIT
  return Math.min(Math.max(Math.trunc(raw), 1), RECORD_APPROVAL_LIST_MAX_LIMIT)
}

export interface ListRecordApprovalsInput {
  sheetId: string
  recordId: string
  /** The caller's field-permission read mask (REQUIRED — see computeRecordApprovalDrift). */
  readableFieldIds: ReadonlySet<string>
  /**
   * The CALLER's user id — REQUIRED, because template names are gated on it (`approvals:read` + the
   * template's visibility_scope, see loadApprovalTemplateNames). It is not optional so a future caller
   * cannot silently opt out of the gate by forgetting a field; an empty string resolves no names at all.
   */
  viewerUserId: string
  limit?: number
}

export interface ListRecordApprovalsResult {
  submissions: RecordApprovalSubmissionView[]
  /**
   * True iff this record has MORE submissions than the page returned. Derived from a `limit + 1` fetch
   * whose extra row is NEVER returned — a `COUNT(*)` would be a second scan and could disagree with the
   * page (rows are inserted concurrently), and the drawer only needs "is there another page".
   */
  hasMore: boolean
}

/**
 * The submitter's display name: `name` → `username` → the email LOCAL PART.
 *
 * The local part, never the whole address: it identifies the person to a reader who is already looking at
 * that person's submission, without turning this list into an email-harvesting endpoint. Returns null when
 * the row carries none of the three, so the client keeps showing the raw user id instead of an empty cell.
 *
 * WHY THIS IS NOT `user-display.ts`'s RULE (deliberate divergence, review round 2): that module's two
 * resolvers are `name → email` / `name → email → raw id` and both hand out the FULL address; this endpoint
 * must not, so the chain is strictly narrower (and adds `username`, which the grid's person summaries have
 * no column for). Same directory, stricter output — not a second opinion about who someone is. Consequence
 * accepted: `users.is_active` is not carried here, so this panel does not mark a deactivated submitter the
 * way person FIELDS do; the panel renders the actor of a past submission, not an assignable person.
 */
export function recordApprovalDisplayName(raw: Record<string, unknown>): string | null {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name) return name
  const username = typeof raw.username === 'string' ? raw.username.trim() : ''
  if (username) return username
  const email = typeof raw.email === 'string' ? raw.email.trim() : ''
  const at = email.indexOf('@')
  const local = (at >= 0 ? email.slice(0, at) : email).trim()
  return local.length > 0 ? local : null
}

/**
 * A directory TABLE that is not there (42P01 undefined_table — the minimal harnesses this repo runs the
 * no-DB lanes on) degrades to NO NAMES, never to a failed list: the names are decoration on top of ids the
 * caller already has. Every OTHER error RETHROWS, including 42703 undefined_column.
 *
 * 42703 USED TO BE TOLERATED HERE and is not any more (review round 2): every column these lookups read
 * exists by migration (`users.username`, `approval_templates.name NOT NULL`), so the only thing a 42703
 * tolerance can buy in practice is SILENCE when a later migration renames or drops one of them — every
 * name would quietly become null with no signal, the exact shape of the `roles.description` hole. This
 * also restores parity with the sibling posture in `resolvePersonDirectoryEntries` (42P01 only).
 */
function isMissingDirectoryTable(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === '42P01'
}

/**
 * ONE batched, GATED lookup for the whole response — never one per row (N+1 is the exact failure this
 * shape exists to prevent): the distinct template ids of the page go out in a single IN-query.
 *
 * THE GATE IS NOT OPTIONAL. `loadReadableApprovalTemplateNames` applies the SAME two conditions the POST
 * path applies before it will even submit to a template (`approvals:read` + the template's
 * `visibility_scope`), because the record read gate this list sits behind does NOT imply either of them:
 * a plain grid viewer has `multitable:read` and nothing approval-side. A caller that fails the gate gets
 * `templateName: null` and the template ID it already had — no refusal, no name.
 */
async function loadApprovalTemplateNames(
  query: QueryFn,
  templateIds: string[],
  viewerUserId: string,
): Promise<Map<string, string>> {
  try {
    return await loadReadableApprovalTemplateNames(query, templateIds, viewerUserId)
  } catch (error) {
    if (!isMissingDirectoryTable(error)) throw error
    return new Map<string, string>()
  }
}

/**
 * The submitter half of the same one-query-per-response rule. `users.id` is TEXT, so no cast games.
 *
 * NOT gated, and that asymmetry is deliberate: a user's display name is directory data the repo has
 * already ratified as non-permission-gated (`user-display.ts`, which resolves the actor of any action a
 * reader can see), whereas an approval TEMPLATE is a first-class permissioned object with its own
 * `visibility_scope`. The keys are TRIMMED on both sides — building the IN-list from trimmed ids and then
 * reading the map with the raw value silently lost the name of any id stored with padding.
 */
async function loadSubmitterDisplayNames(query: QueryFn, userIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const ids = [...new Set(userIds.map((id) => String(id ?? '').trim()).filter((id) => id.length > 0))]
  if (ids.length === 0) return names
  try {
    const result = await query('SELECT id, name, username, email FROM users WHERE id = ANY($1::text[])', [ids])
    for (const raw of result.rows as Array<Record<string, unknown>>) {
      const id = (typeof raw.id === 'string' ? raw.id : String(raw.id ?? '')).trim()
      const display = recordApprovalDisplayName(raw)
      if (id && display) names.set(id, display)
    }
  } catch (error) {
    if (!isMissingDirectoryTable(error)) throw error
  }
  return names
}

/**
 * The record drawer's page: newest first, drift computed per row, plus the two DIRECTORY NAMES the panel
 * shows instead of raw ids. A BOUNDED number of statements no matter how many rows come back — the record
 * probe, the page (limit + 1), then AT MOST one user IN-query and at most one template IN-query (the
 * latter behind three actor statements). An empty page issues neither lookup; a caller without
 * `approvals:read` issues the actor statements but no template query. Never one query per row.
 *
 * VALUES-FREE STILL HOLDS, and the two names have DIFFERENT warrants:
 *   - `templateName` is permissioned data: it is resolved only for templates this caller could read in the
 *     approval center itself (`approvals:read` + `visibility_scope`, enforced inside
 *     `loadReadableApprovalTemplateNames`), and is null otherwise;
 *   - `submittedByName` is directory data about the ACTOR of a submission the caller is already reading —
 *     the posture `user-display.ts` ratified — narrowed here to never emit a full email address.
 * Neither is ever logged, and nothing about the record's own data is exposed by them — `record_snapshot`
 * still never leaves this function.
 */
export async function listRecordApprovalSubmissions(
  query: QueryFn,
  input: ListRecordApprovalsInput,
): Promise<ListRecordApprovalsResult> {
  const limit = clampRecordApprovalListLimit(input.limit)
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
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    // limit + 1: the extra row is the hasMore PROBE and is sliced off below, never returned. `id DESC` is
    // the TIEBREAKER: `created_at` alone is not a total order (two submissions can share a timestamp), so
    // without it the row picked as the discarded probe is not deterministic — harmless while `hasMore` is
    // the only paging signal, a duplicate/skipped row the day a cursor page is added on top.
    [input.sheetId, input.recordId, limit + 1],
  )

  const fetched = result.rows as Array<Record<string, unknown>>
  const hasMore = fetched.length > limit
  const page = (hasMore ? fetched.slice(0, limit) : fetched).map((raw) => ({ raw, row: mapRow(raw) }))

  // One lookup per DIRECTORY for the whole page (sequential, so a failure in the first cannot leave the
  // second's rejection unhandled), never one per row.
  const templateNames = await loadApprovalTemplateNames(
    query,
    page.map(({ row }) => row.templateId),
    input.viewerUserId,
  )
  const submitterNames = await loadSubmitterDisplayNames(query, page.map(({ row }) => row.submittedBy))

  const submissions = page.map(({ raw, row }) => ({
    ...row,
    // Both maps are keyed exactly the way their IN-list was built (template: trimmed + lowercased,
    // submitter: trimmed), so a padded stored id resolves instead of silently reading null.
    templateName: templateNames.get(row.templateId.trim().toLowerCase()) ?? null,
    submittedByName: submitterNames.get(row.submittedBy.trim()) ?? null,
    drift: computeRecordApprovalDrift({
      snapshot: raw.record_snapshot,
      current: currentData,
      recordVersion,
      recordVersionAtSubmit: row.recordVersionAtSubmit,
      readableFieldIds: input.readableFieldIds,
    }),
  }))
  return { submissions, hasMore }
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
  /**
   * Run the terminal UPDATE and the requester's notification INSERT in ONE transaction.
   *
   * WHY IT EXISTS: without it the guarded UPDATE commits on its own, and a notification INSERT that then
   * throws is LOST FOREVER — the durable adapter maps the throw to a retryable adapter_error, but the
   * redelivery's UPDATE now matches zero rows (the row is already terminal) and ACKs, so nobody ever
   * retries the notification. Inside one transaction a failed INSERT rolls the terminal write back, the
   * row stays `pending`, and the retry redoes BOTH. Supplied by the boot site / the route
   * (`createPoolTransactionRunner`); when absent the two statements run sequentially (the pre-existing
   * behaviour, used by unit fakes).
   */
  runInTransaction?: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>
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
  const actorId = typeof event.actor?.id === 'string' ? event.actor.id : null

  const { row } = await applyRecordApprovalTerminalByInstance(query, instanceId, outcome, actorId, deps)
  if (!row) return { applied: false }
  return { applied: true, submissionId: String(row.id ?? '') }
}

/**
 * The ONE terminal write. Used by the completion consumer (both legs) and by submit's post-promote
 * reconcile, so "exactly one notification per submission" is decided by a single guarded statement no
 * matter who observes the terminal state first.
 *
 * The UPDATE is guarded on `status = 'pending'` AND keyed by approval_instance_id: a redelivery, a double
 * wiring, or a reconcile racing a live delivery all update ZERO rows and therefore notify nobody. The
 * notification INSERT rides in the SAME transaction when a runner is supplied (see
 * RecordApprovalCompletionDeps.runInTransaction). The realtime publish is deliberately OUTSIDE it: it is a
 * hint, and it must not be able to roll back a committed terminal state.
 */
async function applyRecordApprovalTerminalByInstance(
  query: QueryFn,
  instanceId: string,
  outcome: ApprovalCompletionOutcome,
  actorId: string | null,
  deps: RecordApprovalCompletionDeps,
): Promise<{ row: Record<string, unknown> | null }> {
  const run = async (q: QueryFn): Promise<Record<string, unknown> | null> => {
    const updated = await q(
      `UPDATE ${RECORD_APPROVAL_SUBMISSIONS_TABLE}
        SET status = $2, outcome = $2, completed_at = NOW()
      WHERE approval_instance_id = $1 AND status = 'pending'
      RETURNING id, sheet_id, record_id, template_id, approval_instance_id, approval_request_no,
                status, outcome, submitted_by, record_version_at_submit, error, created_at, completed_at`,
      [instanceId, outcome],
    )
    const row = (updated.rows[0] ?? null) as Record<string, unknown> | null
    if (!row) return null
    await notifyRecordApprovalTerminal(q, row, outcome, actorId, deps)
    return row
  }

  const row = deps.runInTransaction ? await deps.runInTransaction(run) : await run(query)
  if (!row) return { row: null }

  const publishRealtime = deps.publishRealtime ?? defaultPublishRecordRealtime
  try {
    publishRealtime({ sheetId: String(row.sheet_id ?? ''), recordId: String(row.record_id ?? '') })
  } catch {
    // Realtime is a hint, never the source of truth; the durable row is already committed.
  }
  return { row }
}

/** The requester's single values-free bell. Writes nothing when the row has no submitter. */
async function notifyRecordApprovalTerminal(
  query: QueryFn,
  row: Record<string, unknown>,
  outcome: ApprovalCompletionOutcome,
  actorId: string | null,
  deps: RecordApprovalCompletionDeps,
): Promise<void> {
  const submittedBy = String(row.submitted_by ?? '')
  if (!submittedBy) return
  const insertNotifications = deps.insertNotifications ?? insertRecordSubscriptionNotifications
  await insertNotifications(query, {
    userIds: [submittedBy],
    sheetId: String(row.sheet_id ?? ''),
    recordId: String(row.record_id ?? ''),
    eventType: 'notification.sent',
    // Values-free: names the outcome, carries no field value.
    message: OUTCOME_MESSAGE_ZH[outcome],
    actorId,
  })
}

/**
 * Minimal structural view of the repo's `ConnectionPool` — only its `transaction()` helper is needed.
 * Structural (not the class) so this module stays free of the connection-pool import graph and testable
 * with a fake.
 */
export interface TransactionCapablePool {
  transaction<T>(
    handler: (client: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
    }) => Promise<T>,
  ): Promise<T>
}

/**
 * Build the `runInTransaction` dep from the pool. Delegates to the pool's OWN `transaction()` helper
 * (BEGIN → work → COMMIT, ROLLBACK on any throw, release in `finally`, plus the transaction-depth context
 * the in-transaction guards probe) rather than hand-rolling a second BEGIN/COMMIT dialect. This is what
 * makes "terminal UPDATE + notification INSERT" atomic at the production call sites.
 */
export function createPoolTransactionRunner(
  pool: TransactionCapablePool,
): <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T> {
  return async function runInTransaction<T>(fn: (query: QueryFn) => Promise<T>): Promise<T> {
    return pool.transaction(async (client) =>
      fn(((sql: string, params?: unknown[]) => client.query(sql, params)) as QueryFn),
    )
  }
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
  unsubscribe(id: string): boolean
}

export interface RecordApprovalCompletionSubscription {
  readonly ids: readonly string[]
  detach(): void
  drain(): Promise<void>
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
): RecordApprovalCompletionSubscription {
  const ids: string[] = []
  const inFlight = new Set<Promise<void>>()
  let detached = false
  const detach = (): void => {
    if (detached) return
    detached = true
    for (const id of ids) eventBus.unsubscribe(id)
  }
  try {
    for (const eventType of RECORD_APPROVAL_COMPLETION_EVENT_TYPES) {
      ids.push(
        eventBus.subscribe<ApprovalCompletionEventV1>(eventType, (payload) => {
          const task = sink.handleApprovalCompletion(payload).catch((error) => onError(eventType, error))
          inFlight.add(task)
          void task.then(
            () => inFlight.delete(task),
            () => inFlight.delete(task),
          )
        }),
      )
    }
  } catch (error) {
    detach()
    throw error
  }
  return {
    ids: Object.freeze([...ids]),
    detach,
    async drain(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight])
      }
    },
  }
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
