/**
 * Migration: `meta_automation_event_fires` — S6 upgrade from terminal TOMBSTONE to a per-`rule_id` LEASE.
 *
 * Design lock (approval-form-writeback-fwb0-designlock-20260712, §Layer-1 window-2 + item 5): the existing
 * `claimEventDelivery` writes a bare `(rule_id, dedup_key)` "came-through" row BEFORE `executeRule`. If the
 * process crashes after the claim but before the rule finishes, the row already exists, so redelivery is
 * skipped — the work is PERMANENTLY LOST, not retried. The fix upgrades the tombstone into a reclaimable
 * lease: `status` (pending|in_progress|done|dead_letter) + `lease_expires_at` + `attempts`, so a crash mid-
 * execution leaves the row reclaimable (lease expires → the next scan reclaims it).
 *
 * BACKFILL (design lock item 5, "迁移回填 — 关键"): every PRE-EXISTING row in a deployed environment is a
 * historical, already-completed delivery. It MUST be backfilled to `status='done'`, else on the day of
 * deploy those rows are read as "never done" under the new schema and RE-FIRED. `ADD COLUMN status ...
 * DEFAULT 'done'` does exactly that at ALTER time for every existing row. (This must be tested via the real
 * UPGRADE path — old-schema rows written BEFORE this migration then this migration applied — not fresh-DB,
 * which would create rows already-backfilled and never exercise the backfill statement.)
 *
 * State machine (design lock §Layer-1, lines 353-355): `pending` | `in_progress` | and the FOUR
 * resolve-permitting terminals `done` | `outcome_unknown` | `failed` | `dead_letter` (success; external-send
 * ambiguity; deterministic permanent failure after bounded attempts). The `status`/lease CHECKs mirror
 * `meta_automation_outbox_consumer`: a BICONDITIONAL ties `lease_expires_at IS NOT NULL` to
 * `status='in_progress'` in BOTH directions, so every terminal (done/outcome_unknown/failed/dead_letter) and
 * pending is lease-NULL — no stale ownership — and an in_progress row is always reclaimable.
 *
 * FENCE (design lock round-5, lines 49-50 + 59 — a UNIVERSAL rule covering EVERY reclaimable lease row): a
 * monotonic `fence` self-incremented on claim/reclaim; writes to persistent state MUST be fence-CAS
 * (`WHERE fence = <claimed>`), so a reclaimed "zombie" (alive but lease-expired holder) that tries to write
 * with its stale fence hits 0 rows and aborts → persistent state is SINGLE-WRITER. `bigint` (not int): fence
 * values can exceed 2^31, and must round-trip as a STRING at the driver seam (a JS number loses precision
 * past 2^53).
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // status DEFAULT 'done' BACKFILLS every pre-existing tombstone row to done at ALTER time (item 5).
  await sql`
    ALTER TABLE meta_automation_event_fires
      ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'done'
        CONSTRAINT automation_event_fires_status_valid
        CHECK (status IN ('pending','in_progress','done','outcome_unknown','failed','dead_letter'))
  `.execute(db)
  await sql`ALTER TABLE meta_automation_event_fires ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz`.execute(db)
  await sql`
    ALTER TABLE meta_automation_event_fires
      ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0
        CONSTRAINT automation_event_fires_attempts_nonneg CHECK (attempts >= 0)
  `.execute(db)
  // FENCE — monotonic single-writer token, incremented on claim/reclaim; persistent-state writes are fence-CAS.
  await sql`
    ALTER TABLE meta_automation_event_fires
      ADD COLUMN IF NOT EXISTS fence bigint NOT NULL DEFAULT 0
        CONSTRAINT automation_event_fires_fence_nonneg CHECK (fence >= 0)
  `.execute(db)
  // BICONDITIONAL: a lease exists IFF the row is in_progress (mirrors outbox_consumer). in_progress ⇒ leased
  // (reclaimable); every terminal + pending ⇒ NO lease (no stale ownership).
  await sql`
    ALTER TABLE meta_automation_event_fires
      ADD CONSTRAINT automation_event_fires_lease_iff_in_progress
        CHECK ((status = 'in_progress') = (lease_expires_at IS NOT NULL))
  `.execute(db)
  // reclaim scan reads (status='in_progress' AND lease_expires_at < now()); index it.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_event_fires_reclaim
    ON meta_automation_event_fires (status, lease_expires_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_automation_event_fires_reclaim`.execute(db)
  await sql`ALTER TABLE meta_automation_event_fires DROP CONSTRAINT IF EXISTS automation_event_fires_lease_iff_in_progress`.execute(db)
  await sql`ALTER TABLE meta_automation_event_fires DROP COLUMN IF EXISTS fence`.execute(db)
  await sql`ALTER TABLE meta_automation_event_fires DROP COLUMN IF EXISTS attempts`.execute(db)
  await sql`ALTER TABLE meta_automation_event_fires DROP COLUMN IF EXISTS lease_expires_at`.execute(db)
  await sql`ALTER TABLE meta_automation_event_fires DROP COLUMN IF EXISTS status`.execute(db)
}
