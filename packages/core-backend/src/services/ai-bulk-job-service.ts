/**
 * AI bulk-fill async job service (B-4 Slice 1).
 *
 * Design lock: docs/development/multitable-ai-bulk-fill-b4-async-job-designlock-20260622.md
 * (BJ-1…BJ-10). Lifts the v1 inline 200-row cap by running a whole-column AI fill
 * as an async, resumable workflow job — generate the column in the background,
 * suspend for review, then resume to commit the confirmed subset.
 *
 * Reuse, do not reinvent (BJ-1): the job carries the workflow-job-contract
 * status vocabulary (queued | running | suspended | resolved | failed | …) plus the ONE
 * bulk-job-only phase status `committing` (#5842, see {@link BulkJobStatus}), the SAME
 * reserve-then-settle generation core (`runShortcutCore` in
 * ai-bulk-shared.ts — identical to the inline path), and the SAME per-record
 * write discipline (`commitOneRecord` in the route). It persists to TWO new
 * tables (header + durable per-row state) so review / progress / commit survive
 * crash, cancel, and quota-pause (BJ-9, the keystone).
 *
 * Worker primitive: `QueueService` (in-process). `runJob(jobId)` IS the worker
 * body and is invokable directly (tests drive it deterministically); production
 * enqueues it. A claim guard (queued→running, no-op if already claimed) makes it
 * idempotent and prevents a double-run (the memory queue's auto-processing +
 * a direct test call cannot double-charge).
 *
 * Charge accounting (BJ-2): per-row reserve-then-settle into the existing
 * multitable_ai_usage_ledger (charge-on-generation, NEVER released). The whole-
 * run pre-check does NOT apply at job scale; the job generates until the per-
 * tenant quota is hit, then STOPS and suspends for review with quota_paused — the
 * ungenerated remainder rows are `pending_not_generated` (UNCHARGED, not
 * committable). v1 does NOT auto-resume generation (BJ-5).
 *
 * Scope resolution + gating are owned by the ROUTE (which must run the full
 * per-row gate to make the cap decision anyway). The route seeds job-rows as
 * `pending` (+ ordinal + current_value) and enqueues; the worker generates from
 * the seeded pending rows, supplied the un-persistable (taint) prompt inputs via
 * an in-process plan registry keyed by jobId. If runJob runs with NO registered plan
 * (an in-process plan loss) it marks the header `errored`, leaving the persisted partial
 * committable (BJ-5).
 *
 * CANCEL vs COMMIT (#5842): the commit phase has its OWN status, `committing` — it no longer
 * re-uses `running`, which is the GENERATE phase and the only status the worker generates in.
 * Before the fix, a commit issued right after a cancel flipped the header `rejected` → `running`,
 * so the worker's next-row check saw "still running" and kept sending (and billing) rows the user
 * had cancelled; the worker's wrap-up then flipped the commit's `running` → `suspended`, letting a
 * SECOND commit be claimed. The commit claim is a single conditional UPDATE … RETURNING (see
 * {@link claimBulkJobCommit}), so it can be taken exactly once; the worker also re-reads each row's
 * own state before sending it and only marks a row `generated` while it is still `pending`.
 *
 * SHEET LIVENESS (#5832): the plan's prompts carry the sheet's record content, so the worker
 * re-checks the job's own sheet (multitable/sheet-liveness.ts) before EVERY provider call and stops
 * — remainder `pending_not_generated`, header `errored` — once the sheet is soft-deleted, gone, or
 * the lookup fails. The commit route refuses a non-live sheet on its own (route-level liveness 404,
 * plus requireRecordReadable's per-row liveness refusal inside commitOneRecord).
 *
 * SCOPE (Slice 1): crash coverage is the IN-PROCESS exception path — runJob wraps the
 * worker body after the claim and maps any unexpected throw to `errored` (see runJob). A
 * HARD process restart is NOT auto-reconciled in-process: the in-memory queue + plan registry
 * are gone, so runJob is never re-invoked, and a job left `queued`/`running` would stay active
 * until reconciled. That reconciliation is implemented (B-4 follow-up, `reconcileOrphanedBulkJobs`
 * below) and wired to run once at boot (see packages/core-backend/src/index.ts, ~:3758-3768).
 * Residual gap: only the STARTUP sweep exists — there is no periodic sweep, so a long-lived
 * instance never re-sweeps between restarts; a job orphaned mid-uptime stays stuck until the
 * next process restart.
 */

import { randomUUID, createHash } from 'crypto'

import { AiProviderClient } from './ai-provider-client'
import { runShortcutCore, type PoolLike, type ShortcutRequestContext } from './ai-bulk-shared'
import type { AiUsageQueryFn } from './ai-usage-ledger'
import { describeLivenessLookupError, loadSheetLiveness, type SheetLiveness } from '../multitable/sheet-liveness'
import type { WorkflowJobStatus, WorkflowJobSuspendReason } from '../multitable/workflow-job-contract'
import type { QueueService } from '../types/plugin'

export const AI_BULK_JOB_TABLE = 'multitable_ai_bulk_job'
export const AI_BULK_JOB_ROWS_TABLE = 'multitable_ai_bulk_job_rows'

/** Default job TTL (ms) — a short window GC's abandoned jobs cheaply (BJ-1 expires_at). */
export const AI_BULK_JOB_TTL_MS = 24 * 60 * 60_000

/** Queue + processor name used to enqueue the generate phase. */
export const AI_BULK_JOB_QUEUE = 'multitable-ai-bulk-fill'
export const AI_BULK_JOB_PROCESSOR = 'generate'

/**
 * Bulk-job header status (#5842). The workflow-job-contract vocabulary PLUS the one
 * bulk-job-only phase status `committing`. The contract enum
 * (multitable/workflow-job-contract.ts) is NOT widened: `committing` is a phase of THIS
 * job type, not of the converged engine's contract.
 *
 * The full set a bulk job can hold, and the ONLY transitions that write it:
 *
 *   status       | meaning                                   | entered by                                   | leaves to
 *   -------------|-------------------------------------------|----------------------------------------------|----------------------------
 *   queued       | seeded + enqueued, worker not started     | insertBulkJobHeader                          | running, rejected, errored
 *   running      | GENERATE phase (the ONLY generating one)  | runJob claim (WHERE status='queued')         | suspended, errored, rejected
 *   suspended    | generation done/paused, awaiting review   | suspendIfRunning (WHERE status='running')    | committing, rejected
 *   rejected     | cancelled (BJ-4)                          | cancelBulkJob (queued/running/suspended, or a STALE committing) | committing
 *   errored      | crash / plan loss / sheet not live / orphan | markErroredIfRunning, reconcileOrphanedBulkJobs, releaseBulkJobCommitClaim | committing
 *   committing   | a commit claim is IN FLIGHT (no worker)   | claimBulkJobCommit (suspended/errored/rejected, or a STALE committing) | resolved, errored, rejected
 *   resolved     | committed (terminal)                      | finishBulkJobCommit (committing + our own claim id) | —
 *
 * `failed` / `skipped` exist in the contract enum but are never written by this job type.
 *
 * Invariants the transitions above encode:
 *  · the worker generates ONLY in `running` ({@link isGeneratingBulkJobStatus}); a commit no longer
 *    puts a cancelled/errored job back into a generating status (that was #5842);
 *  · a LIVE `committing` is NOT committable, so a commit can be claimed exactly once;
 *  · `committing` holds the BJ-7 active-job slot (the partial unique index covers it), so no new
 *    job for the same (actor, sheet, field) can start while a commit is writing;
 *  · `committing` is never a DEAD END: a commit request that dies without releasing its claim
 *    stops heartbeating, and after {@link BULK_JOB_COMMIT_CLAIM_STALE_MS} the next commit
 *    ({@link claimBulkJobCommit}) or the user's cancel ({@link cancelBulkJob}) reclaims it —
 *    no restart required;
 *  · every write that ADVANCES a claim carries the claimant's `commit_claim_id`, so a request
 *    whose claim was reclaimed cannot resolve, release or heartbeat someone else's claim;
 *  · `resolved` is terminal — nothing re-claims it.
 */
export type BulkJobStatus = WorkflowJobStatus | 'committing'

/**
 * The statuses in which the WORKER may still call the provider. Exactly one: the generate
 * phase. Everything else (cancelled, suspended-for-review, committing, terminal) means STOP.
 */
const BULK_JOB_GENERATING_STATUSES: ReadonlySet<string> = new Set<BulkJobStatus>(['running'])

/**
 * The COMMITTABLE set (BJ-4 / BJ-5): the statuses in which the worker is no longer mutating the
 * job and a commit may be claimed. `suspended` = generated & awaiting review; `errored` = crashed
 * mid-generate (the persisted partial is still committable); `rejected` = cancelled (the rows that
 * were already generated and charged stay committable). NOT `queued`/`running` (the worker is
 * still generating), NOT `committing` (a commit is already in flight), NOT `resolved` (done).
 */
export const BULK_JOB_COMMITTABLE_STATUSES = ['suspended', 'errored', 'rejected'] as const

/** SQL list literal for the committable set — one source for the route's 409 and the claim. */
const COMMITTABLE_SQL_LIST = BULK_JOB_COMMITTABLE_STATUSES.map((s) => `'${s}'`).join(', ')

/** true when the worker may still generate in this status (#5842). */
export function isGeneratingBulkJobStatus(status: BulkJobStatus | null | undefined): boolean {
  return status != null && BULK_JOB_GENERATING_STATUSES.has(status)
}

/** true when a commit MAY be claimed on this status (the route's 409 pre-check reads this). */
export function isCommittableBulkJobStatus(status: BulkJobStatus | null | undefined): boolean {
  return status != null && (BULK_JOB_COMMITTABLE_STATUSES as readonly string[]).includes(status)
}

/**
 * Per-row state (BJ-1). A SUPERSET of the inline cache's confirmable outputs:
 *  - pending               — seeded, not yet generated.
 *  - generated             — provider-called + charged; has proposed_value (confirmable).
 *  - skipped               — gated out (not writable) BEFORE generation; UNCHARGED.
 *  - failure               — CHARGED but no usable output OFFERED; NOT confirmable. Two reasons:
 *                            `provider_error_charged` (provider errored with usage) and, since #5842,
 *                            `cancelled_after_charge` (the row was at the provider when the cancel
 *                            landed: the money is real, the output is NOT offered for commit).
 *  - committed             — written at commit (terminal success).
 *  - pending_not_generated — quota hit before this row was reached; UNCHARGED, no proposal, NOT committable.
 */
export type BulkJobRowState =
  | 'pending'
  | 'generated'
  | 'skipped'
  | 'failure'
  | 'committed'
  | 'pending_not_generated'

/** Inline (synchronous) row cap — UNCHANGED from v1. Over it → a job. */
export function resolveBulkInlineMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MULTITABLE_AI_BULK_MAX_ROWS)
  return Number.isInteger(raw) && raw > 0 ? raw : 200
}

/** Async job row cap (BJ-6, default 5000, aligned to the server view-load clamp). Over it → 400. */
export function resolveBulkJobMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MULTITABLE_AI_BULK_JOB_MAX_ROWS)
  return Number.isInteger(raw) && raw > 0 ? raw : 5000
}

/**
 * BJ-7 scope fingerprint: a STABLE hash of the resolved scope so a re-start with
 * the same intent resumes the same job (idempotent), and a DIFFERENT scope is a
 * distinct intent (→ 409). `scope:view` keys on the view id + its persisted
 * filter signature; `scope:selection` keys on the SORTED record-id set.
 */
export function computeScopeFingerprint(input: {
  scope: 'view' | 'sheet'
  viewId?: string | null
  filterSignature?: string | null
  recordIds?: string[] | null
}): string {
  const parts: string[] = [input.scope]
  if (input.scope === 'view') {
    parts.push(`view:${input.viewId ?? ''}`)
    parts.push(`filter:${input.filterSignature ?? ''}`)
  } else {
    parts.push('sheet')
  }
  if (input.recordIds && input.recordIds.length > 0) {
    parts.push(`ids:${[...input.recordIds].sort().join(',')}`)
  }
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

/** A header view returned by reads (BJ-3 poll, BJ-7 409 metadata). */
export interface BulkJobHeader {
  jobId: string
  actorId: string
  sheetId: string
  fieldId: string
  scopeFingerprint: string
  status: BulkJobStatus
  total: number
  generated: number
  settledCost: number
  quotaPaused: boolean
  aggregate: unknown
  suspendReason: WorkflowJobSuspendReason | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

/** One seed row the route hands to the job (gated provider-bound OR skipped_no_perm). */
export interface BulkJobRowSeed {
  recordId: string
  ordinal: number
  /** 'pending' for a generatable row; 'skipped' for a not-writable row (counted in total? no — see startJob). */
  state: Extract<BulkJobRowState, 'pending' | 'skipped'>
  currentValue: string | null
  reason?: string | null
}

/** A persisted per-row view (BJ-9 paginated review). */
export interface BulkJobRowView {
  recordId: string
  ordinal: number
  state: BulkJobRowState
  currentValue: string | null
  previewVersion: number | null
  proposedValue: string | null
  masked: boolean
  reason: string | null
  usageTokens: number
  costUsd: number
}

const toIso = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString()
  return String(v ?? '')
}

// ── Header data-access ──────────────────────────────────────────────────────

/**
 * BJ-7: the active job (queued/running/suspended/committing) for (actor, sheet, field), if
 * any. Read BEFORE the expensive scope resolution so a matching-fingerprint
 * start short-circuits and a different one 409s. `committing` is in the set (#5842) — it is the
 * commit phase, so the target is still busy — and the partial unique index
 * (uq_mt_ai_bulk_job_active) covers the SAME four statuses, so this read and the index agree.
 */
export async function findActiveBulkJob(
  query: AiUsageQueryFn,
  actorId: string,
  sheetId: string,
  fieldId: string,
): Promise<BulkJobHeader | null> {
  const res = await query(
    `SELECT * FROM ${AI_BULK_JOB_TABLE}
      WHERE actor_id = $1 AND sheet_id = $2 AND field_id = $3
        AND status IN ('queued', 'running', 'suspended', 'committing')
      ORDER BY created_at DESC
      LIMIT 1`,
    [actorId, sheetId, fieldId],
  )
  const row = res.rows[0] as Record<string, unknown> | undefined
  return row ? mapHeaderRow(row) : null
}

export async function readBulkJobHeader(query: AiUsageQueryFn, jobId: string): Promise<BulkJobHeader | null> {
  const res = await query(`SELECT * FROM ${AI_BULK_JOB_TABLE} WHERE job_id = $1`, [jobId])
  const row = res.rows[0] as Record<string, unknown> | undefined
  return row ? mapHeaderRow(row) : null
}

function mapHeaderRow(row: Record<string, unknown>): BulkJobHeader {
  return {
    jobId: String(row.job_id),
    actorId: String(row.actor_id),
    sheetId: String(row.sheet_id),
    fieldId: String(row.field_id),
    scopeFingerprint: String(row.scope_fingerprint),
    status: String(row.status) as BulkJobStatus,
    total: Number(row.total ?? 0),
    generated: Number(row.generated ?? 0),
    settledCost: Number(row.settled_cost ?? 0),
    quotaPaused: row.quota_paused === true || row.quota_paused === 't',
    aggregate: typeof row.aggregate === 'string' ? JSON.parse(row.aggregate) : (row.aggregate ?? null),
    suspendReason: (row.suspend_reason as WorkflowJobSuspendReason) ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: toIso(row.expires_at),
  }
}

export interface InsertBulkJobHeaderInput {
  jobId: string
  actorId: string
  sheetId: string
  fieldId: string
  scopeFingerprint: string
  total: number
  expiresAt?: Date
}

/**
 * Insert the header in `queued` status. The partial UNIQUE index
 * (uq_mt_ai_bulk_job_active) enforces BJ-7 — a concurrent double-start raises a
 * unique-violation the caller catches + resolves to the existing job.
 */
export async function insertBulkJobHeader(query: AiUsageQueryFn, input: InsertBulkJobHeaderInput): Promise<void> {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + AI_BULK_JOB_TTL_MS)
  await query(
    `INSERT INTO ${AI_BULK_JOB_TABLE}
       (job_id, actor_id, sheet_id, field_id, scope_fingerprint, status, total, generated, settled_cost, quota_paused, expires_at)
     VALUES ($1,$2,$3,$4,$5,'queued',$6,0,0,false,$7)`,
    [input.jobId, input.actorId, input.sheetId, input.fieldId, input.scopeFingerprint, Math.max(0, Math.round(input.total)), expiresAt.toISOString()],
  )
}

/** Seed the per-row state table (BJ-1). PK (job_id, record_id); ordinal is the stable review cursor. */
export async function insertBulkJobRowsPending(query: AiUsageQueryFn, jobId: string, seeds: BulkJobRowSeed[]): Promise<void> {
  for (const seed of seeds) {
    await query(
      `INSERT INTO ${AI_BULK_JOB_ROWS_TABLE}
         (job_id, record_id, ordinal, state, current_value, masked, reason, usage_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,false,$6,0,0)
       ON CONFLICT (job_id, record_id) DO NOTHING`,
      [jobId, seed.recordId, seed.ordinal, seed.state, seed.currentValue, seed.reason ?? null],
    )
  }
}

// ── Row reads (BJ-9 paginated review / BJ-3 counts) ─────────────────────────

/** Read a page of rows ordered by ordinal (BJ-9). `cursor` = the last ordinal seen. */
export async function readBulkJobRows(
  query: AiUsageQueryFn,
  jobId: string,
  cursor: number | null,
  limit: number,
): Promise<BulkJobRowView[]> {
  const res = await query(
    `SELECT record_id, ordinal, state, current_value, preview_version, proposed_value, masked, reason, usage_tokens, cost_usd
       FROM ${AI_BULK_JOB_ROWS_TABLE}
      WHERE job_id = $1 AND ordinal > $2
      ORDER BY ordinal ASC
      LIMIT $3`,
    [jobId, cursor ?? -1, Math.max(1, Math.min(1000, limit))],
  )
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    recordId: String(r.record_id),
    ordinal: Number(r.ordinal ?? 0),
    state: String(r.state) as BulkJobRowState,
    currentValue: r.current_value == null ? null : String(r.current_value),
    previewVersion: r.preview_version == null ? null : Number(r.preview_version),
    proposedValue: r.proposed_value == null ? null : String(r.proposed_value),
    masked: r.masked === true || r.masked === 't',
    reason: r.reason == null ? null : String(r.reason),
    usageTokens: Number(r.usage_tokens ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
  }))
}

/** Count rows by state for the poll summary (BJ-3). */
export async function countBulkJobRowsByState(query: AiUsageQueryFn, jobId: string): Promise<Record<BulkJobRowState, number>> {
  const res = await query(
    `SELECT state, COUNT(*)::int AS n FROM ${AI_BULK_JOB_ROWS_TABLE} WHERE job_id = $1 GROUP BY state`,
    [jobId],
  )
  const counts: Record<BulkJobRowState, number> = {
    pending: 0,
    generated: 0,
    skipped: 0,
    failure: 0,
    committed: 0,
    pending_not_generated: 0,
  }
  for (const r of res.rows as Array<{ state: string; n: number }>) {
    if (r.state in counts) counts[r.state as BulkJobRowState] = Number(r.n)
  }
  return counts
}

/** Read all `generated` rows for the commit phase (value + version source). */
export async function readGeneratedRows(query: AiUsageQueryFn, jobId: string): Promise<BulkJobRowView[]> {
  const res = await query(
    `SELECT record_id, ordinal, state, current_value, preview_version, proposed_value, masked, reason, usage_tokens, cost_usd
       FROM ${AI_BULK_JOB_ROWS_TABLE}
      WHERE job_id = $1 AND state = 'generated'
      ORDER BY ordinal ASC`,
    [jobId],
  )
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    recordId: String(r.record_id),
    ordinal: Number(r.ordinal ?? 0),
    state: 'generated',
    currentValue: r.current_value == null ? null : String(r.current_value),
    previewVersion: r.preview_version == null ? null : Number(r.preview_version),
    proposedValue: r.proposed_value == null ? null : String(r.proposed_value),
    masked: r.masked === true || r.masked === 't',
    reason: r.reason == null ? null : String(r.reason),
    usageTokens: Number(r.usage_tokens ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
  }))
}

// ── Row writers (durable, per-row as it resolves — BJ-5) ────────────────────

interface GeneratedRowUpdate {
  previewVersion: number
  proposedValue: string
  masked: boolean
  usageTokens: number
  costUsd: number
}

/**
 * Record a generated row — CONDITIONAL on the row still being `pending` (#5842).
 *
 * The provider call happens outside any lock, so a cancel can land while THIS row is at the
 * provider; the cancel flips every still-`pending` row (including this one) to
 * `pending_not_generated`. An UNCONDITIONAL update would then resurrect the row as `generated`
 * — committable — after the user cancelled it. The `state = 'pending'` predicate makes the
 * cancel win the race; the caller reads the returned flag and books the (real, already settled)
 * charge on the row instead, via {@link markRowChargedAfterCancel}, so the money stays visible.
 *
 * Returns true when the row WAS still pending and is now `generated`.
 */
async function markRowGenerated(query: AiUsageQueryFn, jobId: string, recordId: string, u: GeneratedRowUpdate): Promise<boolean> {
  const res = await query(
    `UPDATE ${AI_BULK_JOB_ROWS_TABLE}
        SET state = 'generated', preview_version = $3, proposed_value = $4, masked = $5,
            usage_tokens = $6, cost_usd = $7, updated_at = NOW()
      WHERE job_id = $1 AND record_id = $2 AND state = 'pending'`,
    [jobId, recordId, Math.max(0, Math.round(u.previewVersion)), u.proposedValue, u.masked, Math.max(0, Math.round(u.usageTokens)), u.costUsd],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * Row `reason` for a row that was at the provider when the USER'S CANCEL landed (#5842) — the
 * header is `rejected`, so the provenance shown on the review page is "you cancelled this".
 */
export const BULK_ROW_CANCELLED_AFTER_CHARGE = 'cancelled_after_charge'

/**
 * Row `reason` for a row that was at the provider when something OTHER than a cancel moved it out
 * of `pending` — an orphan sweep (`reconcileOrphanedBulkJobs`), or any other reconcile. Same
 * money shape as {@link BULK_ROW_CANCELLED_AFTER_CHARGE} (charged, not offered), but the two are
 * NOT interchangeable: the reason is user-visible provenance for a real charge, so a row nobody
 * cancelled must not read as cancelled (#5842 refuter, race lens).
 */
export const BULK_ROW_INTERRUPTED_AFTER_CHARGE = 'interrupted_after_charge'

/** The two `failure` reasons that mean "charged while at the provider, nothing offered". */
export type BulkRowChargedNotOfferedReason =
  | typeof BULK_ROW_CANCELLED_AFTER_CHARGE
  | typeof BULK_ROW_INTERRUPTED_AFTER_CHARGE

/**
 * The row left `pending` while it was at the provider — book the charge TRUTHFULLY without making
 * the row committable (#5842).
 *
 * The spend is real (charge-on-generation, never released), so leaving the row
 * `pending_not_generated` — documented as UNCHARGED — would under-report what the user paid and
 * would break the keystone invariant "no row is charged yet shown pending_not_generated".
 * `failure` is the existing CHARGED-but-not-confirmable state; `reason` distinguishes it from a
 * provider error AND says WHICH transition took the row away (the caller re-reads the header to
 * decide — a cancel and an orphan sweep are not the same story to tell the user). Guarded on the
 * two states a racing cancel/reconcile can have left behind, so it can never overwrite
 * `generated` / `committed` / `skipped`. The proposed value is deliberately NOT stored: the row
 * is not offered for commit.
 */
async function markRowChargedAfterCancel(
  query: AiUsageQueryFn,
  jobId: string,
  recordId: string,
  u: { usageTokens: number; costUsd: number; reason: BulkRowChargedNotOfferedReason },
): Promise<void> {
  await query(
    `UPDATE ${AI_BULK_JOB_ROWS_TABLE}
        SET state = 'failure', reason = $5,
            usage_tokens = $3, cost_usd = $4, updated_at = NOW()
      WHERE job_id = $1 AND record_id = $2 AND state IN ('pending', 'pending_not_generated')`,
    [jobId, recordId, Math.max(0, Math.round(u.usageTokens)), u.costUsd, u.reason],
  )
}

/**
 * Read ONE row's durable state — the worker's per-row "is this row still mine to send?" check
 * (#5842), the row-level twin of the per-row cancel check on the header. Returns null when the
 * row is absent (nothing to send).
 */
async function readBulkJobRowState(query: AiUsageQueryFn, jobId: string, recordId: string): Promise<BulkJobRowState | null> {
  const res = await query(
    `SELECT state FROM ${AI_BULK_JOB_ROWS_TABLE} WHERE job_id = $1 AND record_id = $2`,
    [jobId, recordId],
  )
  const row = res.rows[0] as { state?: string } | undefined
  return (row?.state as BulkJobRowState | undefined) ?? null
}

async function markRowState(
  query: AiUsageQueryFn,
  jobId: string,
  recordId: string,
  state: BulkJobRowState,
  reason: string | null,
): Promise<void> {
  await query(
    `UPDATE ${AI_BULK_JOB_ROWS_TABLE} SET state = $3, reason = $4, updated_at = NOW() WHERE job_id = $1 AND record_id = $2`,
    [jobId, recordId, state, reason],
  )
}

/** Set ALL still-`pending` rows of a job to `pending_not_generated` (BJ-2 quota-pause / BJ-4 cancel). */
async function markRemainingPendingNotGenerated(query: AiUsageQueryFn, jobId: string): Promise<void> {
  await query(
    `UPDATE ${AI_BULK_JOB_ROWS_TABLE}
        SET state = 'pending_not_generated', updated_at = NOW()
      WHERE job_id = $1 AND state = 'pending'`,
    [jobId],
  )
}

async function setHeaderProgress(query: AiUsageQueryFn, jobId: string, generated: number, settledCost: number): Promise<void> {
  await query(
    `UPDATE ${AI_BULK_JOB_TABLE} SET generated = $2, settled_cost = $3, updated_at = NOW() WHERE job_id = $1`,
    [jobId, Math.max(0, Math.round(generated)), settledCost],
  )
}

/**
 * How long a `committing` header may go WITHOUT a heartbeat before it is treated as an abandoned
 * commit (#5842 refuter, race lens: "`committing` is a dead end").
 *
 * A commit is an in-REQUEST phase: a pod restart / OOM / SIGKILL between the claim and the finish
 * leaves nobody to release it, and `committing` is neither cancellable-while-live nor claimable,
 * so without a reclaim the job would hold its BJ-7 active slot until the next BOOT sweep (10 min
 * of staleness, and only on a restart). This window is what {@link claimBulkJobCommit} and
 * {@link cancelBulkJob} use to reclaim such a corpse, and {@link heartbeatBulkJobCommit} is what
 * keeps a LIVE commit outside it: the route beats once per BJ-10 chunk (≤ 200 rows), so a live
 * commit stays fresh unless a single chunk takes longer than this whole window.
 */
export const BULK_JOB_COMMIT_CLAIM_STALE_MS = 2 * 60 * 1000

/**
 * Staleness in whole seconds for the SQL interval, floored at 30s. The floor matters because both
 * users of this value are exported helpers: a caller that passed 0 would otherwise reclaim a
 * just-claimed, still-live commit.
 */
function commitStaleSeconds(staleAfterMs: number | undefined): number {
  return Math.max(30, Math.round((staleAfterMs ?? BULK_JOB_COMMIT_CLAIM_STALE_MS) / 1000))
}

/**
 * CLAIM the commit phase (#5842). Flips a COMMITTABLE job into `committing` — a status the
 * worker never generates in and no second commit can claim — and STAMPS the claimant's own id on
 * the header, so every later write by this request can prove it still holds the claim.
 *
 * CONCURRENCY GUARANTEE — exactly once, by ONE conditional `UPDATE … WHERE … RETURNING`, never
 * select-then-update. Under PostgreSQL READ COMMITTED two concurrent claims serialize on the
 * header row: the loser re-evaluates its WHERE against the winner's committed row, sees a FRESH
 * `committing`, matches nothing and returns zero rows. There is no window between the read and
 * the write for both to pass, and no advisory lock is needed.
 *
 * SECOND DISJUNCT — the lazy reclaim. A `committing` header whose `updated_at` has been quiet
 * longer than {@link BULK_JOB_COMMIT_CLAIM_STALE_MS} belongs to a commit request that died (the
 * live one heartbeats per chunk), so the next commit attempt HEALS the job instead of waiting for
 * a process restart. The reclaim overwrites `commit_claim_id`, which is exactly what makes the
 * zombie's later `finishBulkJobCommit` / `releaseBulkJobCommitClaim` no-ops.
 *
 * Returns false when the job is NOT committable (queued/running = the worker is still
 * generating; a FRESH `committing` = a commit is already in flight; resolved = already
 * committed). Before this fix the claim set `running`, which BOTH re-armed the worker on a job
 * the user had just cancelled AND let the worker's own wrap-up (`suspendIfRunning`) hand the job
 * back to a second commit.
 */
export async function claimBulkJobCommit(
  query: AiUsageQueryFn,
  jobId: string,
  claimId: string,
  opts: { staleAfterMs?: number } = {},
): Promise<boolean> {
  const res = await query(
    `UPDATE ${AI_BULK_JOB_TABLE}
        SET status = 'committing', commit_claim_id = $2, suspend_reason = NULL, updated_at = NOW()
      WHERE job_id = $1
        AND (status IN (${COMMITTABLE_SQL_LIST})
             OR (status = 'committing' AND updated_at < NOW() - ($3::int * INTERVAL '1 second')))
      RETURNING job_id`,
    [jobId, claimId, commitStaleSeconds(opts.staleAfterMs)],
  )
  return (res.rows?.length ?? 0) > 0
}

/**
 * KEEP a live commit claim fresh (#5842). Touches `updated_at` only, guarded on the claimant's own
 * id, so the staleness-based reclaims ({@link claimBulkJobCommit}'s second disjunct,
 * {@link cancelBulkJob}'s, {@link reconcileOrphanedBulkJobs}) can never reach a commit that is
 * still writing. Returns false once the claim is no longer ours — the caller may stop early
 * instead of writing on behalf of a claim someone else now holds.
 */
export async function heartbeatBulkJobCommit(query: AiUsageQueryFn, jobId: string, claimId: string): Promise<boolean> {
  const res = await query(
    `UPDATE ${AI_BULK_JOB_TABLE} SET updated_at = NOW()
      WHERE job_id = $1 AND status = 'committing' AND commit_claim_id = $2
      RETURNING job_id`,
    [jobId, claimId],
  )
  return (res.rows?.length ?? 0) > 0
}

/**
 * FINISH the commit phase (BJ-10): persist the durable aggregate and resolve the job — GUARDED on
 * `committing` AND on the caller's OWN claim id (#5842), so only the request that still holds the
 * claim can resolve it. Returns false if the claim was lost meanwhile (an orphan sweep or a
 * staleness reclaim took it); the caller reports the job's real status rather than claiming
 * `resolved`.
 */
export async function finishBulkJobCommit(
  query: AiUsageQueryFn,
  jobId: string,
  aggregate: unknown,
  claimId: string,
): Promise<boolean> {
  const res = await query(
    `UPDATE ${AI_BULK_JOB_TABLE}
        SET aggregate = $2::jsonb, status = 'resolved', suspend_reason = NULL,
            commit_claim_id = NULL, updated_at = NOW()
      WHERE job_id = $1 AND status = 'committing' AND commit_claim_id = $3
      RETURNING job_id`,
    [jobId, JSON.stringify(aggregate), claimId],
  )
  return (res.rows?.length ?? 0) > 0
}

/**
 * RELEASE a commit claim that failed (#5842): `committing` → `errored`, which is committable
 * again, so a commit that 500s does not strand the job's generated rows until the next process
 * restart. Rows already written in the failed attempt are `committed` and are not re-written by a
 * retry.
 *
 * Guarded on `committing` AND on the caller's OWN claim id. The id is NOT belt-and-braces: a
 * status-only guard can release a claim the caller does not hold — a sweep (or the staleness
 * reclaim above) can hand the job to a SECOND commit while the first is still running, and the
 * first request's catch would then flip the second one's live claim to `errored`, letting a third
 * commit start while the second is still writing. (That is the #5842 refuter's `C_release_steals_
 * a_claim_it_does_not_hold` probe; the doc here used to assert the opposite.) Returns false when
 * the claim was no longer ours — nothing was written.
 */
export async function releaseBulkJobCommitClaim(query: AiUsageQueryFn, jobId: string, claimId: string): Promise<boolean> {
  const res = await query(
    `UPDATE ${AI_BULK_JOB_TABLE}
        SET status = 'errored', suspend_reason = NULL, commit_claim_id = NULL, updated_at = NOW()
      WHERE job_id = $1 AND status = 'committing' AND commit_claim_id = $2
      RETURNING job_id`,
    [jobId, claimId],
  )
  return (res.rows?.length ?? 0) > 0
}

/** Read just the job's current status — the worker's per-row cancel check (BJ-4). */
export async function readJobStatus(query: AiUsageQueryFn, jobId: string): Promise<BulkJobStatus | null> {
  const res = await query(`SELECT status FROM ${AI_BULK_JOB_TABLE} WHERE job_id = $1`, [jobId])
  const row = res.rows[0] as { status?: string } | undefined
  return (row?.status as BulkJobStatus | undefined) ?? null
}

/**
 * Suspend the GENERATE phase for review — guarded on `running` so a concurrent cancel
 * (which set the header to `rejected`) is NEVER overwritten back to `suspended` (BJ-4).
 * The worker uses this for every suspend transition (completion / quota-pause / provider
 * error / blocked); a no-op if the job already left `running`.
 */
async function suspendIfRunning(query: AiUsageQueryFn, jobId: string, quotaPaused = false): Promise<void> {
  await query(
    `UPDATE ${AI_BULK_JOB_TABLE} SET status = 'suspended', suspend_reason = 'manual_task', quota_paused = $2, updated_at = NOW()
      WHERE job_id = $1 AND status = 'running'`,
    [jobId, quotaPaused],
  )
}

/**
 * Mark the job `errored` (BJ-5) — GUARDED on `running` so a concurrent cancel (→ rejected)
 * is never clobbered. Generated rows are untouched and stay committable (errored ∈ the
 * commit committable set). Three callers:
 *  · the plan-absent case (an in-process plan loss);
 *  · any unexpected worker crash after the queued→running claim — rows are left as the crash
 *    found them (typically the remainder still raw `pending`);
 *  · DELIBERATELY, the sheet-not-live stop in runGeneratePhase (#5832, `jobSheetIsLive`): the
 *    worker returns normally, and it has already flipped the remainder to
 *    `pending_not_generated` before this call.
 * So `errored` does not by itself mean "crashed".
 * (Does NOT cover a hard process restart — runJob is never re-invoked then; that
 * reconciliation is a B-4 follow-up.)
 */
async function markErroredIfRunning(query: AiUsageQueryFn, jobId: string): Promise<void> {
  await query(
    `UPDATE ${AI_BULK_JOB_TABLE} SET status = 'errored', suspend_reason = NULL, updated_at = NOW()
      WHERE job_id = $1 AND status = 'running'`,
    [jobId],
  )
}

/** Default quiet window before a `queued`/`running` job is treated as orphaned (ms). */
export const DEFAULT_BULK_JOB_RECONCILE_STALE_MS = 10 * 60 * 1000

/**
 * B-4 follow-up to BJ-5 — reconcile ORPHANED jobs (the hard-process-restart case
 * that markErroredIfRunning explicitly does NOT cover).
 *
 * `runJob` is an in-process worker (QueueService); a hard restart drops the queue
 * and the in-process plan registry, so any job still `queued`/`running` has no live
 * worker and can never progress — and a job left `committing` (#5842) has no live commit
 * REQUEST — yet each stays "active" (the BJ-7 partial unique index counts
 * queued/running/suspended/committing), blocking a fresh start for its
 * (actor, sheet, field) until expires_at GC. Flip those orphans to `errored` AND, in
 * the SAME atomic statement, convert their still-`pending` rows to
 * `pending_not_generated` so the header and its rows can never disagree. (Leaving rows
 * in raw `pending` would hide them from the review breakdown — the poll count + FE
 * buckets only surface `pending_not_generated`, not raw `pending` — violating
 * truthful-status.) Already-`generated` rows are untouched and stay committable.
 *
 * `suspended` jobs are EXCLUDED — they are intentionally paused awaiting review,
 * not orphaned. The `staleAfterMs` age guard avoids racing a just-claimed job in a
 * multi-instance deploy: only jobs whose `updated_at` has been quiet longer than
 * the guard are reconciled (a live worker advances `updated_at` per row). Wired to run at
 * startup (see packages/core-backend/src/index.ts, ~:3758-3768); there is no periodic sweep,
 * so a long-lived instance never re-sweeps between restarts. Returns the number of jobs
 * reconciled.
 */
export async function reconcileOrphanedBulkJobs(
  query: AiUsageQueryFn,
  opts: { staleAfterMs?: number } = {},
): Promise<number> {
  const staleMs = opts.staleAfterMs ?? DEFAULT_BULK_JOB_RECONCILE_STALE_MS
  // Floor at 30s: this is an exported helper, so guard against a misuse that passes
  // a tiny/zero window and would reconcile a just-claimed, still-live job.
  const staleAfterSeconds = Math.max(30, Math.round(staleMs / 1000))
  // ONE atomic statement: flip stale orphan HEADERS to `errored`, and in the same
  // statement convert those jobs' still-`pending` ROWS to `pending_not_generated`, so a
  // reconciled job's header and rows can never disagree. `generated` rows are untouched
  // (committable); other row states (skipped/failure) are left as-is; `suspended` jobs
  // are excluded by the header status filter.
  // `committing` is included (#5842): a commit is an in-REQUEST phase, so a restart leaves no one
  // to finish it, and without this the job would hold the active slot with no committable status
  // until expires_at. Reconciling it to `errored` re-opens the commit for the rows that were not
  // written (committed rows are terminal and are not re-written). The staleness window is what
  // keeps this off a live commit — a live commit heartbeats `updated_at` per chunk — and
  // clearing `commit_claim_id` is what stops a reconciled-but-still-running commit from later
  // finishing or releasing a claim that is no longer its own.
  const res = await query(
    `WITH reconciled AS (
       UPDATE ${AI_BULK_JOB_TABLE}
          SET status = 'errored', suspend_reason = NULL, commit_claim_id = NULL, updated_at = NOW()
        WHERE status IN ('queued', 'running', 'committing')
          AND updated_at < NOW() - ($1::int * INTERVAL '1 second')
        RETURNING job_id
     ), orphaned_rows AS (
       UPDATE ${AI_BULK_JOB_ROWS_TABLE}
          SET state = 'pending_not_generated', updated_at = NOW()
        WHERE job_id IN (SELECT job_id FROM reconciled)
          AND state = 'pending'
        RETURNING 1
     )
     SELECT job_id FROM reconciled`,
    [staleAfterSeconds],
  )
  return Array.isArray(res.rows) ? res.rows.length : 0
}

/** Write a per-row commit outcome back to job-rows (BJ-10). `committed` is terminal-success. */
export async function setRowCommitOutcome(
  query: AiUsageQueryFn,
  jobId: string,
  recordId: string,
  outcome: 'committed' | 'stale_reprev' | 'write_conflict' | 'skipped_no_perm',
): Promise<void> {
  if (outcome === 'committed') {
    await query(
      `UPDATE ${AI_BULK_JOB_ROWS_TABLE} SET state = 'committed', reason = NULL, updated_at = NOW() WHERE job_id = $1 AND record_id = $2`,
      [jobId, recordId],
    )
  } else {
    // A failed commit leaves the row `generated` (still committable / re-tryable) and
    // records the reason — never silently terminal. The aggregate carries the tally.
    await query(
      `UPDATE ${AI_BULK_JOB_ROWS_TABLE} SET reason = $3, updated_at = NOW() WHERE job_id = $1 AND record_id = $2`,
      [jobId, recordId, outcome],
    )
  }
}

/**
 * BJ-4 cancel: stop generating; rows already `generated` stay charged+committable;
 * still-`pending` rows → `pending_not_generated` (uncharged); job → `rejected`.
 * Only an ACTIVE (queued/running/suspended) job is cancellable.
 *
 * A LIVE `committing` job is deliberately NOT cancellable (#5842): a commit request is writing
 * records at that moment, and flipping the header to `rejected` under it would both misreport
 * what was written and hand a second commit the claim. The cancel returns false and the caller
 * sees the job's real status. (Before the fix the commit phase WAS `running`, so a cancel could
 * land in the middle of a commit.) A cancel racing a row that is already at the provider is
 * handled at the ROW level — see {@link markRowGenerated} / {@link markRowChargedAfterCancel}.
 *
 * A STALE `committing` job IS cancellable — that is the user's exit from a commit request that
 * died mid-write (#5842 refuter, race lens). Without it the header would sit in a status that is
 * neither cancellable nor claimable while still holding the BJ-7 active slot, so the user could
 * neither finish nor abandon nor re-start the fill until a process restart. `updated_at` is
 * heartbeaten per chunk by a live commit ({@link heartbeatBulkJobCommit}), so this disjunct can
 * only match a commit that has been silent for {@link BULK_JOB_COMMIT_CLAIM_STALE_MS}; clearing
 * `commit_claim_id` makes the zombie's own finish/release no-ops if it ever wakes up.
 */
export async function cancelBulkJob(
  query: AiUsageQueryFn,
  jobId: string,
  opts: { commitStaleAfterMs?: number } = {},
): Promise<boolean> {
  const res = await query(
    `UPDATE ${AI_BULK_JOB_TABLE}
        SET status = 'rejected', suspend_reason = NULL, commit_claim_id = NULL, updated_at = NOW()
      WHERE job_id = $1
        AND (status IN ('queued', 'running', 'suspended')
             OR (status = 'committing' AND updated_at < NOW() - ($2::int * INTERVAL '1 second')))`,
    [jobId, commitStaleSeconds(opts.commitStaleAfterMs)],
  )
  if ((res.rowCount ?? 0) === 0) return false
  await markRemainingPendingNotGenerated(query, jobId)
  return true
}

// ── Sheet liveness (soft delete, #5832) ─────────────────────────────────────

/**
 * SHEET LIVENESS for the generate loop (#5832). The plan holds prompts that were assembled from the
 * sheet's record content when the job started, so nothing downstream of this loop reads the sheet
 * again: a soft delete (or a hard one) does not stop those prompts from reaching the provider. The
 * loop therefore asks, before EVERY provider call, whether the JOB'S OWN sheet is still live — with
 * the one shared definition (multitable/sheet-liveness.ts `loadSheetLiveness`).
 *
 * Returns true ONLY on positive proof that the sheet is live:
 *  · `deleted` → false. The point of the fix.
 *  · `absent`  → false. Deliberately stricter than the automation lanes (which refuse exactly
 *    `deleted`): the job was created by a route that required a LIVE sheet, so `absent` here means the
 *    `meta_sheets` row disappeared mid-run, and the in-memory prompts would still go out — there is no
 *    record read downstream that a hard delete would make fail. Both non-live verdicts mean "no sheet
 *    here to act on".
 *  · lookup THROWS → false (FAIL-CLOSED). This is an egress path: a failed lookup is not proof the
 *    sheet is live, and the cost of stopping is small and recoverable — generated rows stay committable,
 *    the job leaves the active set, and the user can run AI fill again. (The approval-automation lanes
 *    in automation-service.ts chose fail-open because their completion events are one-shot and
 *    authorization gates downstream of them fail closed; neither holds here — this loop has no
 *    downstream gate, and a stopped job can simply be run again.) Logged values-free.
 */
async function jobSheetIsLive(query: AiUsageQueryFn, jobId: string, sheetId: string): Promise<boolean> {
  let liveness: SheetLiveness
  try {
    liveness = await loadSheetLiveness(query, sheetId)
  } catch (err) {
    console.error(
      `[ai-bulk-job] runJob ${jobId}: sheet liveness lookup failed; stopping generation before the next provider call (fail-closed, #5832)`,
      { reason: 'liveness_lookup_failed', ...describeLivenessLookupError(err) },
    )
    return false
  }
  if (liveness !== 'live') {
    console.warn(
      `[ai-bulk-job] runJob ${jobId}: the job's sheet is not live; stopping generation before the next provider call (#5832)`,
      { reason: liveness === 'deleted' ? 'sheet_deleted' : 'sheet_absent' },
    )
    return false
  }
  return true
}

// ── The worker ──────────────────────────────────────────────────────────────

/**
 * The route-resolved generation plan for ONE job — supplies the worker the
 * un-persistable (taint) prompt inputs. Held in an in-process registry keyed by
 * jobId; dropped at suspend/terminal (so ≤5000 rows' data is not retained through
 * a long review wait). If runJob runs with NO registered plan (an in-process plan
 * loss) the job is marked `errored` and the persisted partial stays committable
 * (BJ-5: no auto-resume of generation in v1). A HARD process restart is NOT covered
 * here — the queue + plans are gone, so runJob is never re-invoked; reconciling jobs
 * left `queued`/`running` after a restart is a B-4 follow-up (startup/poll sweep).
 */
export interface BulkJobGenerationPlan {
  actorId: string
  sheetId: string
  fieldId: string
  /** Per provider-bound row: the assembled prompt + the version captured at gating + masked flag. */
  rows: Array<{ recordId: string; prompt: string; version: number; masked: boolean }>
}

export interface BulkFillJobServiceDeps {
  pool: PoolLike
  /** SAME injected fetchFn the route uses (CI zero-real-call); omitted in prod = real fetch. */
  fetchFn?: typeof fetch
  /** Optional in-process queue; when present, startJob enqueues runJob. Tests omit it + drive runJob directly. */
  queue?: QueueService
}

export class BulkFillJobService {
  private readonly pool: PoolLike
  private readonly aiClient: AiProviderClient
  private readonly queue?: QueueService
  private readonly plans = new Map<string, BulkJobGenerationPlan>()

  constructor(deps: BulkFillJobServiceDeps) {
    this.pool = deps.pool
    this.aiClient = new AiProviderClient({ ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) })
    this.queue = deps.queue
    // Register the generate processor ONCE (production path). Tests construct
    // WITHOUT a queue and call runJob directly for determinism.
    if (this.queue) {
      this.queue.process<{ jobId: string }>(AI_BULK_JOB_QUEUE, AI_BULK_JOB_PROCESSOR, async (job) => {
        await this.runJob(job.data.jobId)
      })
    }
  }

  /** Register a plan (the route calls this right after seeding rows + inserting the header). */
  registerPlan(jobId: string, plan: BulkJobGenerationPlan): void {
    this.plans.set(jobId, plan)
  }

  /** Enqueue the generate phase (production). With no queue, the caller drives runJob directly. */
  async enqueue(jobId: string): Promise<void> {
    if (this.queue) {
      await this.queue.add(AI_BULK_JOB_QUEUE, AI_BULK_JOB_PROCESSOR, { jobId })
    }
  }

  /**
   * The worker body (BJ-2 / BJ-5). Claim (queued→running, no-op if already
   * claimed) → per `pending` row: generate via the SHARED reserve-then-settle
   * core → write proposed/state/usage to that job-row AS IT RESOLVES (durable) →
   * on quota: stop, remaining pending → pending_not_generated, suspend +
   * quota_paused → on completion: suspend(manual_task) awaiting review.
   *
   * Directly invokable (deterministic in tests); idempotent under the claim guard.
   */
  async runJob(jobId: string): Promise<void> {
    const query = this.pool.query.bind(this.pool) as AiUsageQueryFn

    // CLAIM GUARD (BJ-7 idempotency + double-run safety): atomically take the job
    // queued→running. rowCount 0 = already claimed/terminal → bail (no double-charge).
    const claim = await query(
      `UPDATE ${AI_BULK_JOB_TABLE} SET status = 'running', updated_at = NOW() WHERE job_id = $1 AND status = 'queued'`,
      [jobId],
    )
    if ((claim.rowCount ?? 0) === 0) return

    try {
      await this.runGeneratePhase(query, jobId)
    } catch (err) {
      // BJ-5: an unexpected failure AFTER the claim (DB / provider / worker exception) must
      // NOT leave the header stuck in `running` — commit rejects `running`, and the active-job
      // unique index would block a new same-target job, stranding the charged partial. Mark
      // errored (guarded on `running` so a concurrent cancel→rejected is not clobbered); the
      // generated rows are untouched and stay committable (errored ∈ the commit committable set).
      console.error(`[ai-bulk-job] runJob ${jobId} failed mid-generate; marking errored (BJ-5):`, err)
      try {
        await markErroredIfRunning(query, jobId)
      } catch (markErr) {
        console.error(`[ai-bulk-job] runJob ${jobId} could not be marked errored:`, markErr)
      }
    } finally {
      this.plans.delete(jobId)
    }
  }

  /**
   * The generate phase, extracted so `runJob` can wrap it in ONE try/catch and map any
   * unexpected failure to `errored` (BJ-5). The deliberate stop paths (cancel / quota /
   * provider-error / blocked / complete) suspend the header and return normally; the
   * sheet-not-live stop (#5832, see `jobSheetIsLive`) marks it `errored` and returns
   * normally; an UNHANDLED throw propagates to runJob, which marks the header errored
   * without touching the already-generated rows. Plan cleanup is owned by runJob's `finally`.
   */
  private async runGeneratePhase(query: AiUsageQueryFn, jobId: string): Promise<void> {
    const plan = this.plans.get(jobId)
    if (!plan) {
      // runJob was invoked with NO registered plan (an in-process plan loss) → mark errored;
      // the persisted partial (any seeded/generated rows) stays committable (BJ-5). NOTE: this
      // does NOT fire on a hard process restart — the queue is empty then, so runJob is never
      // re-invoked; reconciling stale queued/running jobs after a restart is instead handled by
      // reconcileOrphanedBulkJobs, wired at boot (B-4 follow-up, implemented — no periodic sweep).
      await markErroredIfRunning(query, jobId)
      return
    }

    let generated = 0
    let settledCost = 0

    for (const row of plan.rows) {
      // BJ-4: honor a cancel at the next row boundary. Re-read the live status; if the job is no
      // longer in a GENERATING status (a concurrent cancel set it `rejected`; a commit claimed it
      // into `committing`; it suspended or errored), STOP — do not generate further and do NOT
      // overwrite the terminal status. Rows already generated stay `generated` (charged); the
      // still-`pending` remainder was flipped to `pending_not_generated` by the cancel.
      // #5842: the generating set is `running` ALONE. The commit phase used to re-use `running`,
      // so a commit issued right after a cancel put the job back here and the worker resumed
      // sending — and billing — rows the user had already cancelled.
      if (!isGeneratingBulkJobStatus(await readJobStatus(query, jobId))) {
        return
      }

      // #5842 per-ROW twin of the check above: the header says "generate", but THIS row may have
      // already left `pending` (a cancel that landed between rows flipped it to
      // `pending_not_generated`; an orphan sweep did the same; a resumed plan may carry a row that
      // is already `generated`). Only a still-`pending` row may be sent to the provider — a row
      // the user cancelled must never be re-sent and re-charged. `continue`, not `return`: the
      // header-level checks above own STOPPING; this one owns SKIPPING one row.
      const liveRowState = await readBulkJobRowState(query, jobId, row.recordId)
      if (liveRowState !== 'pending') {
        // A row that is ALREADY `generated` (a re-driven plan) still counts toward the header's
        // `generated` figure: that counter is "how many of this plan's rows are offered for
        // commit", and it is written from this loop-local tally, so skipping the increment would
        // make the header under-report rows the DB really holds as generated. Every other
        // non-pending state (pending_not_generated / failure / skipped / committed) is NOT
        // offered, so it must NOT be counted.
        if (liveRowState === 'generated') {
          generated += 1
          await setHeaderProgress(query, jobId, generated, settledCost)
        }
        continue
      }

      // #5832: re-check the job's own sheet before EVERY provider call (after the cancel check, so a
      // cancel keeps its `rejected`). Not live, or the lookup failed → send nothing more: the remainder
      // becomes `pending_not_generated` (uncharged), and the job goes `errored`, a terminal state the
      // UI already shows, whose generated rows stay committable once the sheet is restored.
      // `markErroredIfRunning` is guarded on `running`, so a cancel landing meanwhile still wins.
      // RESIDUAL WINDOW: a delete that commits after this check answers live still lets THIS row out.
      // The window is not just check-to-send: it spans runShortcutCore's whole quota reservation
      // transaction, including the wait for the instance-wide advisory lock that serializes every AI
      // reservation, so it grows with concurrent AI use. Narrowing it does not need a lock held across
      // the provider call: re-checking liveness inside runShortcutCore after the reservation and right
      // before `aiClient.complete` would leave the lock wait outside the window (ai-bulk-shared.ts,
      // not changed here, so the residual window is the same on both lanes). The inline bulk-preview
      // loop now makes the same per-row check (#5838, routes/multitable-ai.ts `bulkPreviewSheetIsLive`).
      if (!(await jobSheetIsLive(query, jobId, plan.sheetId))) {
        await markRemainingPendingNotGenerated(query, jobId)
        await setHeaderProgress(query, jobId, generated, settledCost)
        await markErroredIfRunning(query, jobId)
        return
      }

      const ctx: ShortcutRequestContext = {
        pool: this.pool,
        sheetId: plan.sheetId,
        recordId: row.recordId,
        fieldId: plan.fieldId,
        action: 'preview',
        userId: plan.actorId,
      }
      const outcome = await runShortcutCore(this.aiClient, ctx, row.prompt)

      if (outcome.kind === 'charged') {
        settledCost += outcome.result.estimatedCostUsd
        if (!outcome.result.ok) {
          // provider_error WITH usage → CHARGED but no usable output → NOT confirmable.
          await markRowState(query, jobId, row.recordId, 'failure', 'provider_error_charged')
          // A provider erroring mid-batch must not keep spending — stop, suspend the
          // partial for review (NOT quota_paused; the remainder is genuinely un-generated).
          await markRemainingPendingNotGenerated(query, jobId)
          await setHeaderProgress(query, jobId, generated, settledCost)
          await suspendIfRunning(query, jobId)
          return
        }
        const usageTokens = outcome.usage.promptTokens + outcome.usage.completionTokens
        const recorded = await markRowGenerated(query, jobId, row.recordId, {
          previewVersion: row.version,
          proposedValue: outcome.result.text ?? '',
          masked: row.masked,
          usageTokens,
          costUsd: outcome.result.estimatedCostUsd,
        })
        if (!recorded) {
          // #5842: the row left `pending` WHILE it was at the provider. The charge is real and
          // already settled in the ledger, so book it on the row as CHARGED-but-not-confirmable
          // instead of resurrecting a row that is no longer the user's to commit. Not counted in
          // `generated` (nothing is offered for commit), but the cost IS carried into the header
          // below, so the user sees what could not be un-spent.
          //
          // WHICH transition took the row decides the reason: a user cancel leaves the header
          // `rejected`, anything else (an orphan sweep flipping still-pending rows) did not
          // cancel anything, and the reason is user-visible provenance for a real charge — so it
          // must not tell the user they cancelled a row they did not.
          const statusNow = await readJobStatus(query, jobId)
          await markRowChargedAfterCancel(query, jobId, row.recordId, {
            usageTokens,
            costUsd: outcome.result.estimatedCostUsd,
            reason: statusNow === 'rejected' ? BULK_ROW_CANCELLED_AFTER_CHARGE : BULK_ROW_INTERRUPTED_AFTER_CHARGE,
          })
          await setHeaderProgress(query, jobId, generated, settledCost)
          continue
        }
        generated += 1
        await setHeaderProgress(query, jobId, generated, settledCost)
        continue
      }

      if (outcome.kind === 'quota_exhausted' || outcome.kind === 'reserve_failed') {
        // BJ-2 quota-pause: STOP. The hitting row + all remaining pending →
        // pending_not_generated (UNCHARGED, no proposal). Suspend + quota_paused.
        await markRemainingPendingNotGenerated(query, jobId)
        await setHeaderProgress(query, jobId, generated, settledCost)
        await suspendIfRunning(query, jobId, true)
        return
      }

      if (outcome.kind === 'blocked' || outcome.kind === 'generation_failed_before_usage') {
        // Provider unavailable/failed with NO usage (UNCHARGED) → stop the batch,
        // remainder un-generated, suspend the partial for review.
        await markRemainingPendingNotGenerated(query, jobId)
        await setHeaderProgress(query, jobId, generated, settledCost)
        await suspendIfRunning(query, jobId)
        return
      }

      if (outcome.kind === 'unsafe_input') {
        // Secret-shaped prompt for THIS row — not sent, UNCHARGED. Skip the row but
        // do NOT stop (other rows may be clean).
        await markRowState(query, jobId, row.recordId, 'skipped', 'unsafe_input')
        continue
      }
    }

    // Generation complete → suspend(manual_task) awaiting review (BJ-1 lifecycle).
    // Guarded on `running` so a cancel landing during the final row is never overwritten.
    await setHeaderProgress(query, jobId, generated, settledCost)
    await suspendIfRunning(query, jobId)
  }
}
