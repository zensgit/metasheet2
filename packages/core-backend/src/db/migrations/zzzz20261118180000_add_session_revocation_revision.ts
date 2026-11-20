import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE user_session_revocations ADD COLUMN revision uuid NOT NULL DEFAULT gen_random_uuid()`.execute(db)
  await sql`CREATE FUNCTION rotate_user_session_revocation_revision() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        NEW.revoked_after := GREATEST(OLD.revoked_after, NEW.revoked_after);
      END IF;
      NEW.revision := gen_random_uuid();
      RETURN NEW;
    END;
    $$`.execute(db)
  await sql`CREATE TRIGGER rotate_user_session_revocation_revision BEFORE INSERT OR UPDATE ON user_session_revocations
    FOR EACH ROW EXECUTE FUNCTION rotate_user_session_revocation_revision()`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER rotate_user_session_revocation_revision ON user_session_revocations`.execute(db)
  await sql`DROP FUNCTION rotate_user_session_revocation_revision()`.execute(db)
  await sql`ALTER TABLE user_session_revocations DROP COLUMN revision`.execute(db)
}
