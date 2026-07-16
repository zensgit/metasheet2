import { sql, type Kysely } from 'kysely'

/**
 * W0-1 (v3.7, owner-ratified #4331 §3 —
 * docs/development/multitable-w0-1-v37-exact-anchor-trust-design-lock-20260715.md §3 "L5 trust checkpoint
 * and system identity") — Lane L5: the TRUST-CHECKPOINT schema.
 *
 * The trust floor: history at/after a checkpoint's `trusted_since_seq` is trustworthy for destructive
 * recovery; everything before it is display/order assistance only. This migration lands SCHEMA + the two
 * separate tables the lock requires; the in-fence ACTIVATION wiring (cutover under the L4 canonical sheet
 * fence) is a LATER lane (L5-wire, deferred until L4's fence lands — see `activateCheckpoint` in
 * `multitable/history-trust-checkpoint.ts`, which is written to RECEIVE a fenced txn). No recovery flag is
 * enabled by this migration; it changes schema only, no runtime behavior (design lock §9: "Ratification
 * authorizes default-off implementation slices only").
 *
 * ── meta_history_trust_checkpoints ────────────────────────────────────────────────────────────────────────
 * The `building → active` state machine (a prior `active` is moved to `superseded` at cutover, never two
 * `active` at once). The **partial unique index** `uq_meta_history_trust_checkpoints_one_active` enforces AT
 * MOST ONE `state='active'` per `sheet_id`: the atomic building→active flip trips it if two activations race,
 * so a concurrent double-cutover loses one at the DB level (see the state-machine goldens).
 *   - `trusted_since_seq BIGINT NOT NULL` — allocated from the shared `meta_record_chain_seq` sequence UNDER
 *     the fence at activation, so the checkpoint occupies a real position in the one causal seq domain
 *     (design lock §3): every post-cutover write has `seq > trusted_since_seq`. Kept as a decimal STRING
 *     end-to-end in TS (§1.1: `Number`/`parseInt`/unary `+`/subtraction forbidden for seq). `CHECK > 0`.
 *   - `trusted_from_at TIMESTAMPTZ` — display/ops metadata (NOT the recovery authority; selection is
 *     seq-based). Set with `clock_timestamp()` AT ACTIVATION TIME under the fence (never `now()`, which is
 *     txn-start) — see `activateCheckpoint`.
 *   - `system_kind TEXT` — server-owned, non-forgeable (design lock §3 / §6 G-SYSTEM-KIND). Denormalized from
 *     the sheet's own `meta_sheets.system_kind` at activation; a client/request can never set it (the
 *     activation function derives it server-side and never reads a caller value).
 *   - `pruned_at TIMESTAMPTZ` — retention tombstone; NULL = retained. Retention must never prune below the
 *     ANCHOR-COVERING checkpoint `max(trusted_since_seq <= oldestLegalAnchorSeq)` — the checkpoint the oldest
 *     still-legal recovery anchor resolves to — NOT merely the active checkpoint (P1-c) — see
 *     `pruneRetainedCheckpoints`.
 *
 * ── meta_history_baselines ────────────────────────────────────────────────────────────────────────────────
 * A SEPARATE table (design lock §3: "Checkpoint and baselines stay in separate tables; no synthetic history
 * action"). One row per record captured at cutover — all live rows plus recoverable-trash rows — recording
 * the snapshot the checkpoint represents. Reconstruction at anchor B = baseline ⊕ events where
 * `trusted_since_seq < seq <= B`; the baseline stands in for everything at/below `trusted_since_seq`.
 *
 * ── meta_sheets.system_kind ───────────────────────────────────────────────────────────────────────────────
 * Design lock §3/§8 (P1-a): the previous `isSystemSheet` predicate trusted a USER-WRITABLE People-sheet
 * description sentinel (and the base_id), which a client could spoof to exclude its own sheet from the
 * contiguity/strict trust checks. `system_kind` is the required server-owned hardening and is now the ONLY
 * trust signal — the description/base_id disjuncts have been REMOVED from `isSystemSheet`. This migration adds
 * the column ONLY; it deliberately performs NO backfill (owner P1, 2026-07-16): the previously-planned
 * sentinel backfill (description / base_id) would have let a sheet forged BEFORE the migration launder a
 * permanent trusted identity. Going forward, provisioning (People preset + approval `ensureFamilySheet`)
 * stamps `system_kind` server-side at INSERT and the client sheet-create route never accepts it (see the
 * G-SYSTEM-KIND non-forgeable golden); pre-existing sheets stay NULL and are strict-checked like any
 * ordinary sheet (fail-closed — no exclusion is ever granted from user-writable data).
 *
 * zzzz-timestamped ([[feedback_migration_zzzz_ordering]]): FKs `meta_history_trust_checkpoints.sheet_id` and
 * alters `meta_sheets` (both zzz/zzzz-created), and references `meta_record_chain_seq` (the L3 zzzz migration
 * `zzzz20260715160000`) at RUNTIME only — no dependency on its ordering here. Timestamp `...180000` is
 * distinct from L4's reserved `...170000`. Proven on a FRESH-DB full migrate + down + replay.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ── meta_history_trust_checkpoints ────────────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS meta_history_trust_checkpoints (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
      state text NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'active', 'superseded')),
      trusted_since_seq bigint NOT NULL CHECK (trusted_since_seq > 0),
      trusted_from_at timestamptz,
      system_kind text,
      pruned_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      activated_at timestamptz
    )
  `.execute(db)

  // At most ONE active checkpoint per sheet — the load-bearing state-machine guard (the building→active flip
  // trips this if two activations race). Partial index so 'building'/'superseded' rows are unconstrained.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_history_trust_checkpoints_one_active
    ON meta_history_trust_checkpoints (sheet_id)
    WHERE state = 'active'
  `.execute(db)

  // Selection index: latest retained checkpoint with trusted_since_seq <= anchorSeq (seq-based, exact).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_history_trust_checkpoints_sheet_seq
    ON meta_history_trust_checkpoints (sheet_id, trusted_since_seq)
  `.execute(db)

  // ── meta_history_baselines (SEPARATE table — design lock §3) ──────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS meta_history_baselines (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      checkpoint_id text NOT NULL REFERENCES meta_history_trust_checkpoints(id) ON DELETE CASCADE,
      sheet_id text NOT NULL,
      record_id text NOT NULL,
      data jsonb NOT NULL,
      version integer NOT NULL,
      is_trashed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (checkpoint_id, record_id)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_history_baselines_checkpoint
    ON meta_history_baselines (checkpoint_id)
  `.execute(db)

  // ── meta_sheets.system_kind (server-owned, non-forgeable) ─────────────────────────────────────────────
  await sql`ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS system_kind text`.execute(db)
  // NO sentinel backfill (owner P1, 2026-07-16). An earlier draft backfilled from the People-sheet
  // `description` sentinel and the approval-projection `base_id` — but BOTH are user-writable at sheet
  // create, so a sheet forged BEFORE this migration runs would be laundered into a permanent trusted
  // identity that bypasses the strict checks. `system_kind` may therefore only ever be written by the
  // server-side provisioning paths (People preset + approval `ensureFamilySheet`, which stamp it at
  // INSERT). Pre-existing sheets whose identity cannot be proven from a non-user-writable source stay
  // NULL and are treated as ordinary sheets by the strict path — fail-closed: they get strict-checked,
  // they never gain an exclusion. If a provable internal registry for legacy system sheets is
  // identified, migrating from it belongs in a NEW migration with its own review, not here.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_history_baselines`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_history_trust_checkpoints`.execute(db)
  // Dropping the column also drops the backfilled values (forward-only backfill, no data to restore).
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS system_kind`.execute(db)
}
