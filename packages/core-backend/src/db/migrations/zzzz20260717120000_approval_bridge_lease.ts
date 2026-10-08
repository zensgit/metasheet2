/**
 * Migration: `multitable_automation_approval_bridges` — P2 durable-delivery P1 #1: upgrade the terminal-EARLY
 * completion claim into a reclaimable LEASE (mirrors the S6 `meta_automation_event_fires` lease).
 *
 * Problem (owner P1 #1): `claimCompletion` flips a bridge `pending → resumed` (TERMINAL) BEFORE the resume
 * continuation runs. A crash between that terminal write and the continuation finishing is permanently lost —
 * a redelivery finds the row not-`pending` and skips, so the tail (the automation's remaining actions) never
 * runs. This adds a reclaimable lease so a crash mid-continuation leaves the row RECLAIMABLE (lease expires →
 * the redelivered completion event reclaims it) and moves the terminal write to AFTER the continuation.
 *
 * KEY DIFFERENCE FROM S6 (verify, don't assume — the S6 `DEFAULT 'done'` backfill does NOT apply here):
 * `meta_automation_event_fires` rows were historical COMPLETED deliveries, so S6 backfilled them to `done`.
 * This table's `status` column already exists with LIVE semantics — a `pending` row is an IN-FLIGHT bridge
 * still waiting for its (external) approval-completion event. Those rows MUST stay `pending`. So this migration
 * does NOT touch any existing status value: it only ADDS the lease columns (`lease_expires_at` NULL,
 * `fence`/`attempts` DEFAULT 0) and WIDENS the CHECKs. Every pre-existing row is therefore never `in_progress`
 * and always lease-NULL, so the biconditional CHECK holds at ALTER time.
 *
 * New states (owner's state-machine laws — no stuck absorbing state; every terminal resolve-permitting):
 *   - `in_progress` — the completion event is claimed and the continuation is running; holds a lease + fence.
 *     Reclaimable: an EXPIRED in_progress lease (crashed worker) is reclaimed by the next redelivery (fence+1).
 *   - `dead_letter` — a continuation that crashed past the attempt ceiling; terminal (no infinite reclaim).
 * Terminals stay lease-NULL: `resumed` (continuation done — success OR deterministic failure, preserving the
 * legacy meaning "completion consumed"), `failed` (start_approval CREATION failure — unchanged), `dead_letter`.
 *
 * FENCE (universal rule for every reclaimable lease row): monotonic, self-incremented on claim/reclaim;
 * persistent-state writes are fence-CAS (`WHERE fence = <claimed>`), so a reclaimed zombie with a stale fence
 * hits 0 rows → single-writer. `bigint` (values can exceed 2^31) round-tripped as a STRING at the driver seam.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Lease column: NULL for every existing row (no lease held). Added BEFORE the biconditional CHECK so that
  // CHECK validates against lease-NULL existing rows.
  await sql`ALTER TABLE multitable_automation_approval_bridges ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz`.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
      ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0
        CONSTRAINT chk_mt_auto_approval_bridge_attempts_nonneg CHECK (attempts >= 0)
  `.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
      ADD COLUMN IF NOT EXISTS fence bigint NOT NULL DEFAULT 0
        CONSTRAINT chk_mt_auto_approval_bridge_fence_nonneg CHECK (fence >= 0)
  `.execute(db)

  // Widen the status set to include the two new lease states. DROP+ADD (replay-safe) — the original CHECK
  // name is reused so there is exactly one status CHECK.
  await sql`ALTER TABLE multitable_automation_approval_bridges DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_status`.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
      ADD CONSTRAINT chk_mt_auto_approval_bridge_status
      CHECK (status IN ('creating', 'pending', 'in_progress', 'resumed', 'failed', 'dead_letter'))
  `.execute(db)

  // BICONDITIONAL: a lease exists IFF the row is in_progress (mirrors event_fires / outbox_consumer). Every
  // pre-existing row is creating/pending/resumed/failed with lease=NULL ⇒ (false)=(false) ⇒ holds at ALTER.
  await sql`ALTER TABLE multitable_automation_approval_bridges DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_lease_iff_in_progress`.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
      ADD CONSTRAINT chk_mt_auto_approval_bridge_lease_iff_in_progress
      CHECK ((status = 'in_progress') = (lease_expires_at IS NOT NULL))
  `.execute(db)

  // Widen "claimable states must carry an approval_instance_id" to the new post-completion states (in_progress
  // and dead_letter are only reached via a completion event, which requires an instance). creating/failed can
  // still have a NULL instance (creation-time states), so they stay outside the IN-list.
  await sql`ALTER TABLE multitable_automation_approval_bridges DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_claimable_has_approval`.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
      ADD CONSTRAINT chk_mt_auto_approval_bridge_claimable_has_approval
      CHECK (status NOT IN ('pending', 'in_progress', 'resumed', 'dead_letter') OR approval_instance_id IS NOT NULL)
  `.execute(db)

  // The reclaim scan reads (status='in_progress' AND lease_expires_at < now()); index it (mirrors S6).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_mt_auto_approval_bridges_reclaim
    ON multitable_automation_approval_bridges (status, lease_expires_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_mt_auto_approval_bridges_reclaim`.execute(db)
  await sql`ALTER TABLE multitable_automation_approval_bridges DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_lease_iff_in_progress`.execute(db)
  await sql`ALTER TABLE multitable_automation_approval_bridges DROP COLUMN IF EXISTS fence`.execute(db)
  await sql`ALTER TABLE multitable_automation_approval_bridges DROP COLUMN IF EXISTS attempts`.execute(db)
  await sql`ALTER TABLE multitable_automation_approval_bridges DROP COLUMN IF EXISTS lease_expires_at`.execute(db)
  // restore the pre-lease status set + claimable CHECK
  await sql`ALTER TABLE multitable_automation_approval_bridges DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_status`.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
      ADD CONSTRAINT chk_mt_auto_approval_bridge_status
      CHECK (status IN ('creating', 'pending', 'resumed', 'failed'))
  `.execute(db)
  await sql`ALTER TABLE multitable_automation_approval_bridges DROP CONSTRAINT IF EXISTS chk_mt_auto_approval_bridge_claimable_has_approval`.execute(db)
  await sql`
    ALTER TABLE multitable_automation_approval_bridges
      ADD CONSTRAINT chk_mt_auto_approval_bridge_claimable_has_approval
      CHECK (status NOT IN ('pending', 'resumed') OR approval_instance_id IS NOT NULL)
  `.execute(db)
}
