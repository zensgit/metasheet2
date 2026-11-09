import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE directory_handovers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_integration_id uuid NOT NULL REFERENCES directory_integrations(id),
      target_integration_id uuid NOT NULL REFERENCES directory_integrations(id),
      state text NOT NULL CHECK (state IN ('applied', 'rolled_back', 'finalized')),
      before_state jsonb NOT NULL,
      after_digest text NOT NULL,
      created_by text NOT NULL,
      updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (source_integration_id <> target_integration_id)
    )
  `.execute(db)
  await sql`CREATE INDEX directory_handovers_source ON directory_handovers(source_integration_id)`.execute(
    db,
  )
  await sql`CREATE INDEX directory_handovers_target ON directory_handovers(target_integration_id)`.execute(
    db,
  )
  // Card creation shares sync's fence. An already prepared source job cannot insert a new
  // delivery after the transfer commits and then send against the retired configuration.
  await sql`CREATE FUNCTION guard_directory_handover_card_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.integration_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtext('directory:source-sync-freeze:' || NEW.integration_id::text));
        BEGIN
          PERFORM id FROM directory_integrations WHERE id=NEW.integration_id FOR SHARE;
        EXCEPTION WHEN serialization_failure THEN
          -- The old snapshot cannot certify the journal. Refuse before any send with
          -- the same typed guard, so the outbound intent can be retried safely.
          RAISE EXCEPTION 'directory handover blocks stale card writer'
            USING ERRCODE='55000', CONSTRAINT='directory_handover_card_insert';
        END;
        IF EXISTS (SELECT 1 FROM directory_handovers WHERE
          (source_integration_id=NEW.integration_id AND state IN ('applied','finalized')) OR
          (target_integration_id=NEW.integration_id AND state='applied')) THEN
          RAISE EXCEPTION 'directory handover blocks new card delivery' USING ERRCODE='55000', CONSTRAINT='directory_handover_card_insert';
        END IF;
      END IF;
      RETURN NEW;
    END $$`.execute(db)
  await sql`CREATE TRIGGER directory_handover_card_insert BEFORE INSERT ON dingtalk_approval_card_deliveries
    FOR EACH ROW EXECUTE FUNCTION guard_directory_handover_card_insert()`.execute(
    db,
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Removing a durable freeze/history while a handover exists is never an automatic rollback.
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM directory_handovers) THEN
      RAISE EXCEPTION 'directory handover history must be retained';
    END IF;
  END $$`.execute(db)
  await sql`DROP TRIGGER directory_handover_card_insert ON dingtalk_approval_card_deliveries`.execute(
    db,
  )
  await sql`DROP FUNCTION guard_directory_handover_card_insert()`.execute(db)
  await sql`DROP TABLE directory_handovers`.execute(db)
}
