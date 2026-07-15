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
      instance_id    text,
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
      id           text PRIMARY KEY,
      storage_key  text NOT NULL
                     CONSTRAINT approval_purge_key_nonblank CHECK (storage_key ~ '[!-~]'),
      reason       text NOT NULL
                     CONSTRAINT approval_purge_reason_valid CHECK (reason IN ('unbound_ttl','row_deleted','reconciler_orphan')),
      status       text NOT NULL DEFAULT 'pending'
                     CONSTRAINT approval_purge_status_valid CHECK (status IN ('pending','done')),
      created_at   timestamptz NOT NULL DEFAULT now(),
      purged_at    timestamptz
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_purge_pending
    ON approval_attachment_purge_intents (status, created_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS approval_attachment_purge_intents`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_attachments`.execute(db)
}
