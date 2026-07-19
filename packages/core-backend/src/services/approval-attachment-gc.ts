/**
 * Approval attachments — slice ③: durable-purge GC worker + unbound-TTL sweep (#4195 §3/§7/O2).
 *
 *   - `sweepUnboundAttachments(db, ttlHours)` — rows still `unbound` past the ratified TTL (O2 = 168 h)
 *     transition to `deleted` AND write their purge intent in the SAME statement-transaction (CTE), so the
 *     blob can never be orphaned by a crash between the row transition and the intent write (§7 bind↔GC
 *     symmetry by construction). Bound rows are NEVER swept.
 *   - `drainPurgeIntents(db, deleteBlob, opts)` — claims pending intents and calls the injected blob
 *     deleter. Blob-delete SUCCEEDS → intent `done`. Blob-delete THROWS → intent stays `pending` for the
 *     next drain (at-least-once purge; the blob store treats delete as idempotent / missing-is-ok, so
 *     double-delete is harmless). A missing blob (`false` from the deleter) also completes the intent —
 *     purge is about convergence, not bookkeeping.
 *   - Safety invariant enforced here (defense in depth): an intent is NEVER drained while a NON-deleted
 *     `approval_attachments` row still references its storage_key — a still-referenced blob is skipped and
 *     surfaced via the result for the reconciler to inspect (never silently deleted).
 *
 * Wired by `startApprovalAttachmentLifecycle` when `APPROVAL_ATTACHMENTS_ENABLED=true`.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'

export const UNBOUND_ATTACHMENT_TTL_HOURS = 168 // ratified O2

export interface UnboundSweepResult {
  swept: number
}

/** TTL-sweep unbound rows → deleted + purge intent, one atomic statement (CTE). */
export async function sweepUnboundAttachments(db: Queryable, ttlHours: number = UNBOUND_ATTACHMENT_TTL_HOURS): Promise<UnboundSweepResult> {
  if (!Number.isSafeInteger(ttlHours) || ttlHours < 1 || ttlHours > 8760) {
    throw new RangeError(`ttlHours must be a safe integer in [1, 8760] (got ${ttlHours})`)
  }
  const res = await db.query(
    `WITH expired AS (
       SELECT id, storage_key FROM approval_attachments
        WHERE status = 'unbound' AND created_at <= now() - ($1::int * interval '1 hour')
        FOR UPDATE SKIP LOCKED
     ),
     flipped AS (
       UPDATE approval_attachments a SET status = 'deleted'
         FROM expired e WHERE a.id = e.id
       RETURNING e.id, e.storage_key
     )
     INSERT INTO approval_attachment_purge_intents (id, storage_key, reason)
     SELECT 'pi_' || f.id, f.storage_key, 'unbound_ttl' FROM flipped f
     ON CONFLICT (id) DO NOTHING`,
    [ttlHours],
  )
  return { swept: Number(res.rowCount ?? 0) }
}

/** Bounded attempt cap before a persistently-failing intent moves to terminal `dead_letter` (§3-bis). */
export const PURGE_MAX_ATTEMPTS = 5
/** Worker lease duration; an `in_progress` intent whose lease has expired is reclaimable by a later drain. */
export const PURGE_LEASE_MS = 5 * 60 * 1000

export interface PurgeDrainResult {
  purged: number
  /** intents whose storage_key is STILL referenced by a live row — never claimed, surfaced for the reconciler. */
  skippedStillReferenced: string[]
  /** deleter threw and attempts remain — intent released back to pending for a later drain. */
  failed: number
  /** deleter threw past the attempts cap — intent moved to terminal dead_letter (alert seam fired). */
  deadLettered: number
}

/** Values-free error token for `last_error` — never the raw message (no secrets / arbitrary text). */
function safeErrCode(err: unknown): string {
  const raw = (err as { code?: unknown; name?: unknown } | null | undefined)?.code
    ?? (err as { name?: unknown } | null | undefined)?.name
  return typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'unknown' : 'unknown'
}

/**
 * Drain purge intents through the injected blob deleter (§3-bis state machine). Never throws for a
 * single blob's failure. The claim is a SINGLE atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
 * LOCKED)` — the row lock and the state transition commit together, so it is a REAL claim even on an
 * autocommit pool (the prior separate SELECT…FOR UPDATE then UPDATE released the lock at statement end
 * = vacuous). `attempts`/`fence` are bumped AT the claim, so an always-crash-after-claim poison still
 * reaches `dead_letter`; every terminal write is a fence-CAS so a reclaimed zombie's late write is a
 * no-op. Still-referenced intents are EXCLUDED from the claim (never consume a batch slot), so a
 * permanently-stuck intent can never starve younger ones (head-of-queue starvation break).
 */
export async function drainPurgeIntents(
  db: Queryable,
  deleteBlob: (storageKey: string) => Promise<boolean>,
  opts: {
    batchSize?: number
    maxAttempts?: number
    leaseMs?: number
    /** alert seam fired once, values-free, when an intent reaches dead_letter (operator visibility). */
    onDeadLetter?: (intentId: string, storageKey: string, errCode: string) => void
  } = {},
): Promise<PurgeDrainResult> {
  const batchSize = opts.batchSize ?? 100
  const maxAttempts = opts.maxAttempts ?? PURGE_MAX_ATTEMPTS
  const leaseMs = opts.leaseMs ?? PURGE_LEASE_MS
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError(`batchSize must be a safe integer in [1, 10000] (got ${batchSize})`)
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1_000) {
    throw new RangeError(`maxAttempts must be a safe integer in [1, 1000] (got ${maxAttempts})`)
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
    throw new RangeError(`leaseMs must be a safe integer in [1000, 3600000] (got ${leaseMs})`)
  }
  // CLAIM: one atomic statement. Claims pending OR lease-expired in_progress intents whose blob is NOT
  // still-referenced by a live row, oldest first; bumps attempts + fence and stamps a fresh lease.
  const { rows: claimed } = await db.query(
    `UPDATE approval_attachment_purge_intents i
        SET status = 'in_progress',
            attempts = i.attempts + 1,
            fence = i.fence + 1,
            lease_expires_at = now() + ($2::bigint * interval '1 millisecond')
      WHERE i.id IN (
        SELECT c.id FROM approval_attachment_purge_intents c
         WHERE (c.status = 'pending' OR (c.status = 'in_progress' AND c.lease_expires_at < now()))
           AND NOT EXISTS (SELECT 1 FROM approval_attachments a
                            WHERE a.storage_key = c.storage_key AND a.status <> 'deleted')
         ORDER BY c.created_at ASC
         LIMIT $1::int
         FOR UPDATE SKIP LOCKED
      )
      RETURNING i.id, i.storage_key, i.attempts, i.fence`,
    [batchSize, leaseMs],
  )
  const result: PurgeDrainResult = { purged: 0, skippedStillReferenced: [], failed: 0, deadLettered: 0 }
  for (const r of claimed as Array<{ id: string; storage_key: string; attempts: number; fence: string | number }>) {
    try {
      // The store's delete is idempotent (missing-is-ok, returns false, never throws) — so not-found is
      // TERMINAL-SUCCESS by contract; only a real (permission/network) error THROWS.
      await deleteBlob(r.storage_key)
      await db.query(
        `UPDATE approval_attachment_purge_intents
            SET status='done', purged_at=now(), lease_expires_at=NULL
          WHERE id=$1 AND fence=$2 AND status='in_progress'`,
        [r.id, r.fence],
      )
      result.purged += 1
    } catch (err) {
      const errCode = safeErrCode(err)
      if (Number(r.attempts) >= maxAttempts) {
        // bounded attempts exhausted → terminal dead_letter (fence-CAS) + alert seam; no unbounded retry.
        const cas = await db.query(
          `UPDATE approval_attachment_purge_intents
              SET status='dead_letter', last_error=$3, lease_expires_at=NULL
            WHERE id=$1 AND fence=$2 AND status='in_progress'`,
          [r.id, r.fence, errCode],
        )
        if (Number(cas.rowCount ?? 0) > 0) {
          result.deadLettered += 1
          try {
            opts.onDeadLetter?.(r.id, r.storage_key, errCode)
          } catch {
            /* alert seam must never break the drain */
          }
        }
      } else {
        // attempts remain → release the lease back to pending (fence-CAS) for a later drain.
        await db.query(
          `UPDATE approval_attachment_purge_intents SET status='pending', lease_expires_at=NULL
            WHERE id=$1 AND fence=$2 AND status='in_progress'`,
          [r.id, r.fence],
        )
        result.failed += 1
      }
    }
  }
  // Surface still-referenced intents separately — they were EXCLUDED from the claim (never block younger
  // intents), never auto-deleted; a live row still points at their blob (the reconciler's concern).
  const { rows: refRows } = await db.query(
    `SELECT i.storage_key FROM approval_attachment_purge_intents i
      WHERE i.status IN ('pending','in_progress')
        AND EXISTS (SELECT 1 FROM approval_attachments a
                     WHERE a.storage_key = i.storage_key AND a.status <> 'deleted')`,
  )
  result.skippedStillReferenced = (refRows as Array<{ storage_key: string }>).map((r) => r.storage_key)
  return result
}
