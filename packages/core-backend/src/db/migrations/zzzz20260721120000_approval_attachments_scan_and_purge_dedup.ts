/**
 * Forward migration: approval attachment scan_state + purge-intent storage_key uniqueness
 * (#4195 closeout — do NOT mutate the already-deployed create migration).
 *
 * Landed separately from `zzzz20260715210000_create_approval_attachments` so environments that
 * already applied the create migration keep a stable ledger entry and only apply the additive
 * evolution here:
 *   - `scan_state` on `approval_attachments` (unscanned|clean|infected; default unscanned)
 *   - unique `storage_key` on `approval_attachment_purge_intents` (one durable lifecycle per blob)
 *   - compatibility trigger canonicalizes ids from storage_key, so old workers using
 *     `ON CONFLICT (id)` and new workers using `ON CONFLICT (storage_key)` can coexist safely
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // §6 scan seam — additive column for environments that already created the table without it.
  await sql`ALTER TABLE approval_attachments ADD COLUMN IF NOT EXISTS scan_state text NOT NULL DEFAULT 'unscanned'`.execute(db)
  await sql`ALTER TABLE approval_attachments DROP CONSTRAINT IF EXISTS approval_att_scan_state_valid`.execute(db)
  await sql`ALTER TABLE approval_attachments ADD CONSTRAINT approval_att_scan_state_valid CHECK (scan_state IN ('unscanned','clean','infected'))`.execute(db)

  // Pre-unique-index cleanup: environments that already accumulated multiple purge intents for the
  // same storage_key (create migration only had PK on id) would fail CREATE UNIQUE INDEX. Keep the
  // single safest row per key so a terminal dead_letter cannot be discarded in favour of a fresh
  // pending that the reconciler would otherwise re-drive past the operator-visible terminal.
  // Rank: dead_letter → in_progress → pending → done; then attempts DESC, created_at ASC, id ASC.
  await sql`
    DELETE FROM approval_attachment_purge_intents
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY storage_key
                 ORDER BY
                   CASE status
                     WHEN 'dead_letter' THEN 0
                     WHEN 'in_progress' THEN 1
                     WHEN 'pending' THEN 2
                     WHEN 'done' THEN 3
                     ELSE 4
                   END,
                   attempts DESC,
                   created_at ASC,
                   id ASC
               ) AS rn
          FROM approval_attachment_purge_intents
      ) ranked
      WHERE rn > 1
    )
  `.execute(db)

  // Phase 1 rolling-deploy bridge: canonical ids make storage-key identity visible through the old
  // primary-key conflict target too. Keep this BEFORE INSERT trigger until every pre-migration worker
  // has been retired; a later owner-gated migration may remove it after that rollout proof.
  await sql`
    UPDATE approval_attachment_purge_intents
       SET id = 'pi_key_' || md5(storage_key)
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION approval_attachment_canonicalize_purge_intent_id() RETURNS trigger AS $$
    BEGIN
      NEW.id := 'pi_key_' || md5(NEW.storage_key);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS approval_attachment_canonicalize_purge_intent_id ON approval_attachment_purge_intents`.execute(db)
  await sql`
    CREATE TRIGGER approval_attachment_canonicalize_purge_intent_id
    BEFORE INSERT ON approval_attachment_purge_intents
    FOR EACH ROW EXECUTE FUNCTION approval_attachment_canonicalize_purge_intent_id()
  `.execute(db)

  // G15: one durable lifecycle per blob key. An operator-visible dead_letter must block the
  // reconciler from creating a second id for the same object and bypassing that terminal.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_purge_storage_key
    ON approval_attachment_purge_intents (storage_key)
  `.execute(db)

  // The DB trigger deliberately retains the legacy conflict target. The BEFORE INSERT bridge rewrites
  // its caller-supplied id to the canonical key id, proving the old SQL shape remains valid.
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
  // Restore the create-migration trigger body before removing the compatibility bridge/index.
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
  await sql`DROP INDEX IF EXISTS uq_approval_purge_storage_key`.execute(db)
  await sql`DROP TRIGGER IF EXISTS approval_attachment_canonicalize_purge_intent_id ON approval_attachment_purge_intents`.execute(db)
  await sql`DROP FUNCTION IF EXISTS approval_attachment_canonicalize_purge_intent_id()`.execute(db)
  await sql`ALTER TABLE approval_attachments DROP CONSTRAINT IF EXISTS approval_att_scan_state_valid`.execute(db)
  await sql`ALTER TABLE approval_attachments DROP COLUMN IF EXISTS scan_state`.execute(db)
}
