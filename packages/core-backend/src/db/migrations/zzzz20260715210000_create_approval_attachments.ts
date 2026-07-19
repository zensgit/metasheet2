/**
 * Migration: `approval_attachments` + `approval_attachment_purge_intents` — attachment pipeline slice ②
 * (#4195 lock: dedicated table, initiator-upload, bind↔GC symmetry, durable blob-purge intent).
 *
 *   - `approval_attachments` — one row per uploaded blob. Lifecycle `status`: `unbound` (uploaded, not yet
 *     attached to a submitted instance; TTL-swept after the ratified 168 h) → `bound` (form submitted;
 *     frozen) → `deleted` (row-level tombstone). Non-blank identities; ratified per-file cap enforced at
 *     the DB too (<= 20 MB); MIME must be one of the v1 five (defense in depth under the route validator).
 *   - `approval_attachment_purge_intents` — the DURABLE blob-purge intent, written in the SAME transaction
 *     as (and gated on) the `approval_attachments` row transition that orphans the blob. The GC worker
 *     drains intents (delete blob → mark done); a crash between row-delete and blob-delete can never leak
 *     an unreferenced blob NOR delete a still-referenced one (§7 bind↔GC symmetry by construction).
 *
 * Additive only; nothing reads/writes these tables until the storage provider + routes slices land behind
 * the attachment flag (default OFF — the field stays honestly disabled).
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS approval_attachments (
      id             text PRIMARY KEY,
      org_id         text NOT NULL
                       CONSTRAINT approval_att_org_nonblank CHECK (org_id ~ '[!-~]'),
      uploader_id    text NOT NULL
                       CONSTRAINT approval_att_uploader_nonblank CHECK (uploader_id ~ '[!-~]'),
      -- bound rows reference their instance; ON DELETE CASCADE drops the ROWS on instance deletion
      -- (the object-store blobs are enqueued for purge by the row-delete trigger below — §3-bis).
      instance_id    text
                       CONSTRAINT approval_att_instance_fk REFERENCES approval_instances(id) ON DELETE CASCADE,
      field_id       text NOT NULL
                       CONSTRAINT approval_att_field_nonblank CHECK (field_id ~ '[!-~]'),
      storage_key    text NOT NULL
                       CONSTRAINT approval_att_key_nonblank CHECK (storage_key ~ '[!-~]'),
      file_name      text NOT NULL,
      mime_type      text NOT NULL
                       CONSTRAINT approval_att_mime_v1 CHECK (mime_type IN
                         ('application/pdf','image/jpeg','image/png','text/plain','text/csv')),
      size_bytes     bigint NOT NULL
                       CONSTRAINT approval_att_size_bounds CHECK (size_bytes > 0 AND size_bytes <= 20971520),
      status         text NOT NULL DEFAULT 'unbound'
                       CONSTRAINT approval_att_status_valid CHECK (status IN ('unbound','bound','deleted')),
      -- §6 scan seam: default unscanned (pass-through); infected never binds/downloads.
      scan_state     text NOT NULL DEFAULT 'unscanned'
                       CONSTRAINT approval_att_scan_state_valid CHECK (scan_state IN ('unscanned','clean','infected')),
      created_at     timestamptz NOT NULL DEFAULT now(),
      bound_at       timestamptz,
      -- bound rows must reference their instance; unbound/deleted rows may not dangle a fake binding.
      CONSTRAINT approval_att_bound_needs_instance
        CHECK (status <> 'bound' OR instance_id IS NOT NULL)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_att_unbound_sweep
    ON approval_attachments (status, created_at)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS approval_attachment_purge_intents (
      id               text PRIMARY KEY,
      storage_key      text NOT NULL
                         CONSTRAINT approval_purge_key_nonblank CHECK (storage_key ~ '[!-~]'),
      reason           text NOT NULL
                         CONSTRAINT approval_purge_reason_valid CHECK (reason IN ('unbound_ttl','row_deleted','reconciler_orphan','unbound_delete')),
      -- §3-bis full state machine: pending → in_progress (claimed under a live lease) → done | dead_letter.
      status           text NOT NULL DEFAULT 'pending'
                         CONSTRAINT approval_purge_status_valid CHECK (status IN ('pending','in_progress','done','dead_letter')),
      attempts         int NOT NULL DEFAULT 0,         -- incremented ATOMICALLY at claim (so an always-crash-after-claim poison still reaches dead_letter)
      lease_expires_at timestamptz,                    -- short worker lease; an expired in_progress lease is reclaimable
      fence            bigint NOT NULL DEFAULT 0,       -- monotonic, bumped on every claim; fences a zombie worker's late write
      last_error       text,                            -- values-free error code (e.g. EACCES) recorded on dead-letter; never raw text
      created_at       timestamptz NOT NULL DEFAULT now(),
      purged_at        timestamptz
    )
  `.execute(db)
  // Idempotent convergence for any environment that already created the earlier ('pending'|'done')-only
  // shape: add the new columns and widen the status CHECK so a replay lands the full state machine.
  await sql`ALTER TABLE approval_attachment_purge_intents ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0`.execute(db)
  await sql`ALTER TABLE approval_attachment_purge_intents ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz`.execute(db)
  await sql`ALTER TABLE approval_attachment_purge_intents ADD COLUMN IF NOT EXISTS fence bigint NOT NULL DEFAULT 0`.execute(db)
  await sql`ALTER TABLE approval_attachment_purge_intents ADD COLUMN IF NOT EXISTS last_error text`.execute(db)
  await sql`ALTER TABLE approval_attachment_purge_intents DROP CONSTRAINT IF EXISTS approval_purge_status_valid`.execute(db)
  await sql`ALTER TABLE approval_attachment_purge_intents ADD CONSTRAINT approval_purge_status_valid CHECK (status IN ('pending','in_progress','done','dead_letter'))`.execute(db)
  // Explicit unbound DELETE endpoint reason (uploader-only doom path) — widen CHECK idempotently.
  await sql`ALTER TABLE approval_attachment_purge_intents DROP CONSTRAINT IF EXISTS approval_purge_reason_valid`.execute(db)
  await sql`ALTER TABLE approval_attachment_purge_intents ADD CONSTRAINT approval_purge_reason_valid CHECK (reason IN ('unbound_ttl','row_deleted','reconciler_orphan','unbound_delete'))`.execute(db)

  // §6 scan_state column — additive for environments that created the table before the seam landed.
  await sql`ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS scan_state text NOT NULL DEFAULT 'unscanned'`.execute(db)
  await sql`ALTER TABLE approval_attachments DROP CONSTRAINT IF EXISTS approval_att_scan_state_valid`.execute(db)
  await sql`ALTER TABLE approval_attachments ADD CONSTRAINT approval_att_scan_state_valid CHECK (scan_state IN ('unscanned','clean','infected'))`.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_purge_pending
    ON approval_attachment_purge_intents (status, created_at)
  `.execute(db)

  // Idempotent FK convergence for an environment that already created approval_attachments without the
  // instance FK. NOT VALID skips the initial full-table scan (avoids failing a replay on pre-existing
  // rows) while still enforcing the constraint + ON DELETE CASCADE for all new/changed rows.
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_att_instance_fk') THEN
        ALTER TABLE approval_attachments
          ADD CONSTRAINT approval_att_instance_fk
          FOREIGN KEY (instance_id) REFERENCES approval_instances(id) ON DELETE CASCADE NOT VALID;
      END IF;
    END $$;
  `.execute(db)

  // §3-bis row-delete trigger: a DB cascade (or admin purge / retention hard-delete / test cleanup)
  // deletes the ROWS but can never reach the object store to delete the BLOBS. This trigger enqueues a
  // 'row_deleted' purge intent for EVERY DELETE-statement path (cascade included) so the idempotent
  // worker (approval-attachment-gc) is the sole blob-deleter and no orphan blob is left in the bucket.
  await sql`
    CREATE OR REPLACE FUNCTION approval_attachment_enqueue_purge_on_delete() RETURNS trigger AS $$
    BEGIN
      INSERT INTO approval_attachment_purge_intents (id, storage_key, reason)
      VALUES ('pi_trg_' || md5(OLD.storage_key), OLD.storage_key, 'row_deleted')
      ON CONFLICT (id) DO NOTHING;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS approval_attachment_purge_on_delete ON approval_attachments`.execute(db)
  await sql`
    CREATE TRIGGER approval_attachment_purge_on_delete
    AFTER DELETE ON approval_attachments
    FOR EACH ROW EXECUTE FUNCTION approval_attachment_enqueue_purge_on_delete()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS approval_attachment_purge_on_delete ON approval_attachments`.execute(db)
  await sql`DROP FUNCTION IF EXISTS approval_attachment_enqueue_purge_on_delete()`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_attachment_purge_intents`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_attachments`.execute(db)
}
