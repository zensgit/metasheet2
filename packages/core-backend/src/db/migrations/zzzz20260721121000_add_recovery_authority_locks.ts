import { sql, type Kysely } from 'kysely'

/**
 * Transaction-scoped, per-user authority fence for exact-anchor recovery.
 *
 * Recovery locks the actor plus every person-field target user before its final authorization read.
 * These triggers make every authority mutation acquire the matching user or role key. Recovery
 * locks the actor, reads their role ids, locks those role ids, then re-reads the effective grants.
 * This avoids both process-wide table locks and role-permission fan-out across every role member.
 */
export const AUTHORITY_LOCK_FUNCTION = 'metasheet_lock_recovery_authority_user'
export const AUTHORITY_ROLE_LOCK_FUNCTION = 'metasheet_lock_recovery_authority_role'
export const AUTHORITY_GROUP_LOCK_FUNCTION = 'metasheet_lock_recovery_authority_group'
export const AUTHORITY_USER_TRIGGER_FUNCTION = 'metasheet_recovery_authority_user_trigger'
export const AUTHORITY_ROLE_PERMISSION_TRIGGER_FUNCTION = 'metasheet_recovery_role_permission_trigger'
export const AUTHORITY_SUBJECT_TRIGGER_FUNCTION = 'metasheet_recovery_authority_subject_trigger'

const USER_TRIGGERS = [
  ['user_permissions', 'trg_user_permissions_recovery_authority_lock', 'user_id'],
  ['user_roles', 'trg_user_roles_recovery_authority_lock', 'user_id'],
  ['platform_member_group_members', 'trg_member_group_members_recovery_authority_lock', 'user_id'],
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(AUTHORITY_LOCK_FUNCTION)}(authority_user_id text)
    RETURNS void AS $$
    BEGIN
      IF authority_user_id IS NULL OR btrim(authority_user_id) = '' THEN
        RETURN;
      END IF;
      PERFORM pg_advisory_xact_lock(
        hashtextextended('metasheet:recovery-authority:user:' || btrim(authority_user_id), 0)
      );
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(AUTHORITY_ROLE_LOCK_FUNCTION)}(authority_role_id text)
    RETURNS void AS $$
    BEGIN
      IF authority_role_id IS NULL OR btrim(authority_role_id) = '' THEN
        RETURN;
      END IF;
      PERFORM pg_advisory_xact_lock(
        hashtextextended('metasheet:recovery-authority:role:' || btrim(authority_role_id), 0)
      );
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(AUTHORITY_GROUP_LOCK_FUNCTION)}(authority_group_id text)
    RETURNS void AS $$
    BEGIN
      IF authority_group_id IS NULL OR btrim(authority_group_id) = '' THEN
        RETURN;
      END IF;
      PERFORM pg_advisory_xact_lock(
        hashtextextended('metasheet:recovery-authority:group:' || btrim(authority_group_id), 0)
      );
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(AUTHORITY_USER_TRIGGER_FUNCTION)}()
    RETURNS TRIGGER AS $$
    DECLARE
      authority_user_id text;
    BEGIN
      FOR authority_user_id IN
        SELECT DISTINCT btrim(candidate)
          FROM unnest(ARRAY[
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ->> TG_ARGV[0] END,
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ->> TG_ARGV[0] END
          ]) AS candidates(candidate)
         WHERE candidate IS NOT NULL AND btrim(candidate) <> ''
         ORDER BY 1
      LOOP
        PERFORM ${sql.raw(AUTHORITY_LOCK_FUNCTION)}(authority_user_id);
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(AUTHORITY_ROLE_PERMISSION_TRIGGER_FUNCTION)}()
    RETURNS TRIGGER AS $$
    DECLARE
      affected_role_id text;
    BEGIN
      FOR affected_role_id IN
        SELECT DISTINCT btrim(candidate)
          FROM unnest(ARRAY[
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.role_id::text END,
            CASE WHEN TG_OP <> 'INSERT' THEN OLD.role_id::text END
          ]) AS candidates(candidate)
         WHERE candidate IS NOT NULL AND btrim(candidate) <> ''
         ORDER BY 1
      LOOP
        PERFORM ${sql.raw(AUTHORITY_ROLE_LOCK_FUNCTION)}(affected_role_id);
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(AUTHORITY_SUBJECT_TRIGGER_FUNCTION)}()
    RETURNS TRIGGER AS $$
    DECLARE
      affected_subject_type text;
      affected_subject_id text;
    BEGIN
      FOR affected_subject_type, affected_subject_id IN
        SELECT subject_type, btrim(subject_id) AS subject_id
          FROM (
            SELECT
              CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ->> TG_ARGV[0] END AS subject_type,
              CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ->> TG_ARGV[1] END AS subject_id
            UNION ALL
            SELECT
              CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ->> TG_ARGV[0] END,
              CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ->> TG_ARGV[1] END
          ) AS subjects
         WHERE subject_type IN ('user', 'role', 'member-group')
           AND subject_id IS NOT NULL
           AND btrim(subject_id) <> ''
         GROUP BY subject_type, btrim(subject_id)
         ORDER BY
           CASE subject_type WHEN 'user' THEN 0 WHEN 'role' THEN 1 ELSE 2 END,
           btrim(subject_id)
      LOOP
        IF affected_subject_type = 'user' THEN
          PERFORM ${sql.raw(AUTHORITY_LOCK_FUNCTION)}(affected_subject_id);
        ELSIF affected_subject_type = 'role' THEN
          PERFORM ${sql.raw(AUTHORITY_ROLE_LOCK_FUNCTION)}(affected_subject_id);
        ELSE
          PERFORM ${sql.raw(AUTHORITY_GROUP_LOCK_FUNCTION)}(affected_subject_id);
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_users_recovery_authority_lock ON users`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_users_recovery_authority_lock_update ON users`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_users_recovery_authority_lock_lifecycle ON users`.execute(db)
  await sql`
    CREATE TRIGGER trg_users_recovery_authority_lock_update
      BEFORE UPDATE OF role, permissions, is_active ON users
      FOR EACH ROW EXECUTE FUNCTION ${sql.raw(AUTHORITY_USER_TRIGGER_FUNCTION)}('id')
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_users_recovery_authority_lock_lifecycle
      BEFORE INSERT OR DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION ${sql.raw(AUTHORITY_USER_TRIGGER_FUNCTION)}('id')
  `.execute(db)

  for (const [table, trigger, column] of USER_TRIGGERS) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(trigger)} ON ${sql.raw(table)}`.execute(db)
    await sql`
      CREATE TRIGGER ${sql.raw(trigger)}
        BEFORE INSERT OR UPDATE OR DELETE ON ${sql.raw(table)}
        FOR EACH ROW EXECUTE FUNCTION ${sql.raw(AUTHORITY_USER_TRIGGER_FUNCTION)}(${sql.lit(column)})
    `.execute(db)
  }

  await sql`DROP TRIGGER IF EXISTS trg_role_permissions_recovery_authority_lock ON role_permissions`.execute(db)
  await sql`
    CREATE TRIGGER trg_role_permissions_recovery_authority_lock
      BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
      FOR EACH ROW EXECUTE FUNCTION ${sql.raw(AUTHORITY_ROLE_PERMISSION_TRIGGER_FUNCTION)}()
  `.execute(db)

  for (const [table, trigger] of [
    ['spreadsheet_permissions', 'trg_spreadsheet_permissions_recovery_authority_lock'],
    ['field_permissions', 'trg_field_permissions_recovery_authority_lock'],
    ['record_permissions', 'trg_record_permissions_recovery_authority_lock'],
  ] as const) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(trigger)} ON ${sql.raw(table)}`.execute(db)
    await sql`
      CREATE TRIGGER ${sql.raw(trigger)}
        BEFORE INSERT OR UPDATE OR DELETE ON ${sql.raw(table)}
        FOR EACH ROW EXECUTE FUNCTION ${sql.raw(AUTHORITY_SUBJECT_TRIGGER_FUNCTION)}('subject_type', 'subject_id')
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [table, trigger] of [
    ['record_permissions', 'trg_record_permissions_recovery_authority_lock'],
    ['field_permissions', 'trg_field_permissions_recovery_authority_lock'],
    ['spreadsheet_permissions', 'trg_spreadsheet_permissions_recovery_authority_lock'],
  ] as const) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(trigger)} ON ${sql.raw(table)}`.execute(db)
  }
  await sql`DROP TRIGGER IF EXISTS trg_role_permissions_recovery_authority_lock ON role_permissions`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_users_recovery_authority_lock_update ON users`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_users_recovery_authority_lock_lifecycle ON users`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_users_recovery_authority_lock ON users`.execute(db)
  for (const [table, trigger] of [...USER_TRIGGERS].reverse()) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(trigger)} ON ${sql.raw(table)}`.execute(db)
  }
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(AUTHORITY_SUBJECT_TRIGGER_FUNCTION)}()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(AUTHORITY_ROLE_PERMISSION_TRIGGER_FUNCTION)}()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(AUTHORITY_USER_TRIGGER_FUNCTION)}()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(AUTHORITY_GROUP_LOCK_FUNCTION)}(text)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(AUTHORITY_ROLE_LOCK_FUNCTION)}(text)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS ${sql.raw(AUTHORITY_LOCK_FUNCTION)}(text)`.execute(db)
}
