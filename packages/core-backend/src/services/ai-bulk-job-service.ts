/**
 * AI bulk-fill async job service (B-4 Slice 1).
 *
 * Design lock: docs/development/multitable-ai-bulk-fill-b4-async-job-designlock-20260622.md
 * (BJ-1…BJ-10). Lifts the v1 inline 200-row cap by running a whole-column AI fill
 * as an async, resumable workflow job — generate the column in the background,
 * suspend for review, then resume to commit the confirmed subset.
 *
 * Reuse, do not reinvent (BJ-1): the job carries the SAME workflow-job-contract
 * status vocabulary (queued | running | suspended | resolved | failed | …; no
 * new enum), the SAME reserve-then-settle generation core (`runShortcutCore` in
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
 * SCOPE (Slice 1): crash coverage is the IN-PROCESS exception path — runJob wraps the
 * worker body after the claim and maps any unexpected throw to `errored` (see runJob). A
 * HARD process restart is NOT auto-reconciled here: the in-memory queue + plan registry are
 * gone, so runJob is never re-invoked, and a job left `queued`/`running` stays active until
 * reconciled. That startup/poll reconciliation (stale `queued`/`running` → `errored`) is a
 * B-4 follow-up, not implemented in Slice 1.
 */

import { randomUUID, createHash } from 'crypto'

import { AiProviderClient } from './ai-provider-client'
import { runShortcutCore, type PoolLike, type ShortcutRequestContext } from './ai-bulk-shared'
import type { AiUsageQueryFn } from './ai-usage-ledger'
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
 * Per-row state (BJ-1). A SUPERSET of the inline cache's confirmable outputs:
 *  - pending               — seeded, not yet generated.
 *  - generated             — provider-called + charged; has proposed_value (confirmable).
 *  - skipped               — gated out (not writable) BEFORE generation; UNCHARGED.
 *  - failure               — CHARGED but no usable output (provider error w/ usage); NOT confirmable.
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
  status: WorkflowJobStatus
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
 * BJ-7: the active job (queued/running/suspended) for (actor, sheet, field), if
 * any. Read BEFORE the expensive scope resolution so a matching-fingerprint
 * start short-circuits and a different one 409s.
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
        AND status IN ('queued', 'running', 'suspended')
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
    status: String(row.status) as WorkflowJobStatus,
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

async function markRowGenerated(query: AiUsageQueryFn, jobId: string, recordId: string, u: GeneratedRowUpdate): Promise<void> {
  await query(
    `UPDATE ${AI_BULK_JOB_ROWS_TABLE}
        SET state = 'generated', preview_version = $3, proposed_value = $4, masked = $5,
            usage_tokens = $6, cost_usd = $7, updated_at = NOW()
      WHERE job_id = $1 AND record_id = $2`,
    [jobId, recordId, Math.max(0, Math.round(u.previewVersion)), u.proposedValue, u.masked, Math.max(0, Math.round(u.usageTokens)), u.costUsd],
  )
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

/** Persist the durable commit aggregate on the header (BJ-10). Clears suspend_reason for a non-suspended status. */
export async function setHeaderAggregate(query: AiUsageQueryFn, jobId: string, aggregate: unknown, status: WorkflowJobStatus): Promise<void> {
  const suspendReason: WorkflowJobSuspendReason | null = status === 'suspended' ? 'manual_task' : null
  await query(
    `UPDATE ${AI_BULK_JOB_TABLE} SET aggregate = $2::jsonb, status = $3, suspend_reason = $4, updated_at = NOW() WHERE job_id = $1`,
    [jobId, JSON.stringify(aggregate), status, suspendReason],
  )
}

/**
 * Flip a COMMITTABLE job into the commit phase (`running`), GUARDED. The committable
 * set is the worker-no-longer-mutating states — `suspended` (awaiting review),
 * `errored` (BJ-5: crashed mid-generate, partial committable), and `rejected`
 * (BJ-4: cancelled, generated rows still committable). Returns false if the job is
 * NOT committable (queued/running = worker active; resolved = already committed; or
 * another commit already claimed it) so two commits can never both proceed.
 */
export async function setHeaderRunning(query: AiUsageQueryFn, jobId: string): Promise<boolean> {
  const res = await query(
    `UPDATE ${AI_BULK_JOB_TABLE} SET status = 'running', suspend_reason = NULL, updated_at = NOW()
      WHERE job_id = $1 AND status IN ('suspended', 'errored', 'rejected')`,
    [jobId],
  )
  return (res.rowCount ?? 0) > 0
}

/** Read just the job's current status — the worker's per-row cancel check (BJ-4). */
export async function readJobStatus(query: AiUsageQueryFn, jobId: string): Promise<WorkflowJobStatus | null> {
  const res = await query(`SELECT status FROM ${AI_BULK_JOB_TABLE} WHERE job_id = $1`, [jobId])
  const row = res.rows[0] as { status?: string } | undefined
  return (row?.status as WorkflowJobStatus | undefined) ?? null
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
 * commit committable set). Used for the plan-absent case (an in-process plan loss) and any
 * unexpected worker crash after the queued→running claim. (Does NOT cover a hard process
 * restart — runJob is never re-invoked then; that reconciliation is a B-4 follow-up.)
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
 * worker and can never progress — yet it stays "active" (the BJ-7 partial unique
 * index counts queued/running/suspended), blocking a fresh start for its
 * (actor, sheet, field) until expires_at GC. Flip those orphans to `errored`
 * (header-only, mirroring markErroredIfRunning; already-`generated` rows stay
 * committable).
 *
 * `suspended` jobs are EXCLUDED — they are intentionally paused awaiting review,
 * not orphaned. The `staleAfterMs` age guard avoids racing a just-claimed job in a
 * multi-instance deploy: only jobs whose `updated_at` has been quiet longer than
 * the guard are reconciled (a live worker advances `updated_at` per row). Run at
 * startup and/or on a periodic sweep. Returns the number of jobs reconciled.
 */
export async function reconcileOrphanedBulkJobs(
  query: AiUsageQueryFn,
  opts: { staleAfterMs?: number } = {},
): Promise<number> {
  const staleAfterSeconds = Math.max(0, Math.round((opts.staleAfterMs ?? DEFAULT_BULK_JOB_RECONCILE_STALE_MS) / 1000))
  const res = await query(
    `UPDATE ${AI_BULK_JOB_TABLE}
        SET status = 'errored', suspend_reason = NULL, updated_at = NOW()
      WHERE status IN ('queued', 'running')
        AND updated_at < NOW() - ($1::int * INTERVAL '1 second')
      RETURNING job_id`,
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
 */
export async function cancelBulkJob(query: AiUsageQueryFn, jobId: string): Promise<boolean> {
  const res = await query(
    `UPDATE ${AI_BULK_JOB_TABLE} SET status = 'rejected', suspend_reason = NULL, updated_at = NOW()
      WHERE job_id = $1 AND status IN ('queued', 'running', 'suspended')`,
    [jobId],
  )
  if ((res.rowCount ?? 0) === 0) return false
  await markRemainingPendingNotGenerated(query, jobId)
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
   * provider-error / blocked / complete) suspend the header and return normally; an
   * UNHANDLED throw propagates to runJob, which marks the header errored without touching
   * the already-generated rows. Plan cleanup is owned by runJob's `finally`.
   */
  private async runGeneratePhase(query: AiUsageQueryFn, jobId: string): Promise<void> {
    const plan = this.plans.get(jobId)
    if (!plan) {
      // runJob was invoked with NO registered plan (an in-process plan loss) → mark errored;
      // the persisted partial (any seeded/generated rows) stays committable (BJ-5). NOTE: this
      // does NOT fire on a hard process restart — the queue is empty then, so runJob is never
      // re-invoked; reconciling stale queued/running jobs is a B-4 follow-up (startup/poll sweep).
      await markErroredIfRunning(query, jobId)
      return
    }

    let generated = 0
    let settledCost = 0

    for (const row of plan.rows) {
      // BJ-4: honor a cancel at the next row boundary. Re-read the live status; if the
      // job is no longer `running` (a concurrent cancel set it `rejected`), STOP — do not
      // generate further and do NOT overwrite the terminal status. Rows already generated
      // stay `generated` (charged); the still-`pending` remainder was flipped to
      // `pending_not_generated` by the cancel.
      if ((await readJobStatus(query, jobId)) !== 'running') {
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
        await markRowGenerated(query, jobId, row.recordId, {
          previewVersion: row.version,
          proposedValue: outcome.result.text ?? '',
          masked: row.masked,
          usageTokens,
          costUsd: outcome.result.estimatedCostUsd,
        })
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
