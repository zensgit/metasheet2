/**
 * S6 — `meta_automation_event_fires` LEASE claim/reclaim primitives (durable-delivery flag ON path).
 *
 * Extracted from AutomationService so the load-bearing lease semantics are directly real-DB testable (mirrors
 * automation-execution-ledger.ts / automation-action-idempotency.ts). The schema is the #4413 tombstone→lease
 * upgrade: `status` (pending|in_progress|done|outcome_unknown|failed|dead_letter) + `lease_expires_at` +
 * `attempts` + monotonic `fence`, with the biconditional lease-iff-in_progress CHECK.
 *
 * Window-2 fix (design lock §Layer-1): the legacy path wrote a permanent tombstone BEFORE executeRule, so a
 * crash between the two dropped the work forever. Here the claim is a reclaimable lease: a crash before
 * `markEventFiresDone` leaves an EXPIRED in_progress row that the next `claimEventFiresLease` reclaims.
 */
import { sql, type Kysely } from 'kysely'

/** `{ fence }` when THIS caller owns the (rule, dedup) claim; `'skip'` when it is already done or live-leased. */
// schema-agnostic query helper: Kysely<T> is invariant so we accept any schema (repo precedent:
// record-subscription-service.ts, several migrations). Only raw `sql` is used, never typed query builders.
export async function claimEventFiresLease(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  ruleId: string,
  dedupKey: string,
  leaseMs: number,
): Promise<{ fence: string } | 'skip'> {
  const ms = Math.max(1, Math.floor(leaseMs))
  // Fresh claim: in_progress + lease + fence 1. ON CONFLICT DO NOTHING → an existing row falls through.
  const fresh = await sql<{ fence: string }>`
    INSERT INTO meta_automation_event_fires (rule_id, dedup_key, status, lease_expires_at, fence, attempts)
    VALUES (${ruleId}, ${dedupKey}, 'in_progress', now() + ${ms} * interval '1 millisecond', 1, 1)
    ON CONFLICT (rule_id, dedup_key) DO NOTHING
    RETURNING fence::text AS fence
  `.execute(db)
  if (fresh.rows.length > 0) return { fence: fresh.rows[0].fence }
  // Row exists: RECLAIM iff it is an EXPIRED in_progress lease (crashed/zombie worker). A `done` row or a LIVE
  // in_progress lease is untouched → 'skip'. Concurrent reclaimers race: exactly one UPDATE matches
  // (status='in_progress' AND lease_expires_at < now()); the losers see the bumped fence → 0 rows → 'skip'.
  const reclaim = await sql<{ fence: string }>`
    UPDATE meta_automation_event_fires
    SET fence = fence + 1, attempts = attempts + 1, lease_expires_at = now() + ${ms} * interval '1 millisecond'
    WHERE rule_id = ${ruleId} AND dedup_key = ${dedupKey}
      AND status = 'in_progress' AND lease_expires_at < now()
    RETURNING fence::text AS fence
  `.execute(db)
  return reclaim.rows.length > 0 ? { fence: reclaim.rows[0].fence } : 'skip'
}

/** fence-CAS the leased row to terminal `done` (clears the lease atomically). A stale-fence zombie hits 0 rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function markEventFiresDone(db: Kysely<any>, ruleId: string, dedupKey: string, fence: string): Promise<boolean> {
  const res = await sql`
    UPDATE meta_automation_event_fires
    SET status = 'done', lease_expires_at = NULL
    WHERE rule_id = ${ruleId} AND dedup_key = ${dedupKey} AND fence = ${fence}::bigint AND status = 'in_progress'
  `.execute(db)
  return Number(res.numAffectedRows ?? 0) === 1
}
