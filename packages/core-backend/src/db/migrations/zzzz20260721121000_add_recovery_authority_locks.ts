import { sql, type Kysely } from 'kysely'

export const AUTHORITY_LOCK_FUNCTION = 'metasheet_try_recovery_authority_user'
export const AUTHORITY_ROLE_LOCK_FUNCTION = 'metasheet_try_recovery_authority_role'
export const AUTHORITY_GROUP_LOCK_FUNCTION = 'metasheet_try_recovery_authority_group'
export const AUTHORITY_USER_TRIGGER_FUNCTION = 'metasheet_recovery_authority_user_trigger'
export const AUTHORITY_ROLE_PERMISSION_TRIGGER_FUNCTION = 'metasheet_recovery_role_permission_trigger'
export const AUTHORITY_SUBJECT_TRIGGER_FUNCTION = 'metasheet_recovery_authority_subject_trigger'
export const AUTHORITY_BUSY_MARKER = 'METASHEET_RECOVERY_AUTHORITY_BUSY'

export const RECOVERY_AUTHORITY_TRIGGERS = [
  ['record_permissions', 'trg_record_permissions_recovery_authority_lock'],
  ['field_permissions', 'trg_field_permissions_recovery_authority_lock'],
  ['spreadsheet_permissions', 'trg_spreadsheet_permissions_recovery_authority_lock'],
  ['role_permissions', 'trg_role_permissions_recovery_authority_lock'],
  ['platform_member_group_members', 'trg_member_group_members_recovery_authority_lock'],
  ['user_roles', 'trg_user_roles_recovery_authority_lock'],
  ['user_permissions', 'trg_user_permissions_recovery_authority_lock'],
  ['users', 'trg_users_recovery_authority_lock_update'],
  ['users', 'trg_users_recovery_authority_lock_lifecycle'],
] as const

const USER_TRIGGERS = [
  ['user_permissions', 'trg_user_permissions_recovery_authority_lock', 'user_id'],
  ['user_roles', 'trg_user_roles_recovery_authority_lock', 'user_id'],
  ['platform_member_group_members', 'trg_member_group_members_recovery_authority_lock', 'user_id'],
] as const

export async function dropRecoveryAuthorityTriggers(db: Kysely<unknown>): Promise<void> {
  for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(trigger)} ON ${sql.raw(table)}`.execute(db)
  }
  await sql`DROP TRIGGER IF EXISTS trg_users_recovery_authority_lock ON users`.execute(db)

  for (const fn of [
    AUTHORITY_SUBJECT_TRIGGER_FUNCTION,
    AUTHORITY_ROLE_PERMISSION_TRIGGER_FUNCTION,
    AUTHORITY_USER_TRIGGER_FUNCTION,
  ]) {
    await sql`DROP FUNCTION IF EXISTS ${sql.raw(fn)}()`.execute(db)
  }
  for (const fn of [
    AUTHORITY_GROUP_LOCK_FUNCTION,
    AUTHORITY_ROLE_LOCK_FUNCTION,
    AUTHORITY_LOCK_FUNCTION,
  ]) {
    await sql`DROP FUNCTION IF EXISTS ${sql.raw(fn)}(text, boolean)`.execute(db)
  }

  // Remove the superseded blocking-lock overloads from the first design.
  for (const fn of [
    'metasheet_lock_recovery_authority_group',
    'metasheet_lock_recovery_authority_role',
    'metasheet_lock_recovery_authority_user',
  ]) {
    await sql`DROP FUNCTION IF EXISTS ${sql.raw(fn)}(text)`.execute(db)
  }
}

async function createTryLockFunction(
  db: Kysely<unknown>,
  functionName: string,
  argumentName: string,
  keyPrefix: string,
): Promise<void> {
  await sql`
    CREATE FUNCTION ${sql.raw(functionName)}(${sql.raw(argumentName)} text, exclusive boolean)
    RETURNS boolean AS $$
    DECLARE
      lock_key bigint;
    BEGIN
      IF ${sql.raw(argumentName)} IS NULL OR btrim(${sql.raw(argumentName)}) = '' THEN
        RETURN TRUE;
      END IF;
      lock_key := hashtextextended(
        ${sql.lit(keyPrefix)} || btrim(${sql.raw(argumentName)}),
        0
      );
      IF exclusive THEN
        RETURN pg_try_advisory_xact_lock(lock_key);
      END IF;
      RETURN pg_try_advisory_xact_lock_shared(lock_key);
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)
}

/**
 * Install the per-subject reader/writer authority lease in a default-inert posture.
 *
 * Permission writers use compatible shared try-locks. Exact-anchor recovery uses exclusive
 * try-locks over only the actor/person users and their assigned roles/groups. Neither side waits,
 * so an authority race becomes a retryable transaction refusal instead of an advisory ABBA.
 *
 * The nine triggers are deliberately DISABLED after migration. Enabling the whole set is a separate
 * operator action coupled to the recovery enablement ladder; partial enablement makes recovery fail
 * closed at runtime and in the containment helper.
 */
export async function installRecoveryAuthorityTriggers(db: Kysely<unknown>): Promise<void> {
  await dropRecoveryAuthorityTriggers(db)

  await createTryLockFunction(
    db,
    AUTHORITY_LOCK_FUNCTION,
    'authority_user_id',
    'metasheet:recovery-authority:user:',
  )
  await createTryLockFunction(
    db,
    AUTHORITY_ROLE_LOCK_FUNCTION,
    'authority_role_id',
    'metasheet:recovery-authority:role:',
  )
  await createTryLockFunction(
    db,
    AUTHORITY_GROUP_LOCK_FUNCTION,
    'authority_group_id',
    'metasheet:recovery-authority:group:',
  )

  await sql`
    CREATE FUNCTION ${sql.raw(AUTHORITY_USER_TRIGGER_FUNCTION)}()
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
        IF NOT ${sql.raw(AUTHORITY_LOCK_FUNCTION)}(authority_user_id, FALSE) THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = '${sql.raw(AUTHORITY_BUSY_MARKER)}';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    CREATE FUNCTION ${sql.raw(AUTHORITY_ROLE_PERMISSION_TRIGGER_FUNCTION)}()
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
        IF NOT ${sql.raw(AUTHORITY_ROLE_LOCK_FUNCTION)}(affected_role_id, FALSE) THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = '${sql.raw(AUTHORITY_BUSY_MARKER)}';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    CREATE FUNCTION ${sql.raw(AUTHORITY_SUBJECT_TRIGGER_FUNCTION)}()
    RETURNS TRIGGER AS $$
    DECLARE
      affected_subject_type text;
      affected_subject_id text;
      acquired boolean;
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
          acquired := ${sql.raw(AUTHORITY_LOCK_FUNCTION)}(affected_subject_id, FALSE);
        ELSIF affected_subject_type = 'role' THEN
          acquired := ${sql.raw(AUTHORITY_ROLE_LOCK_FUNCTION)}(affected_subject_id, FALSE);
        ELSE
          acquired := ${sql.raw(AUTHORITY_GROUP_LOCK_FUNCTION)}(affected_subject_id, FALSE);
        END IF;
        IF NOT acquired THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = '${sql.raw(AUTHORITY_BUSY_MARKER)}';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

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
    await sql`
      CREATE TRIGGER ${sql.raw(trigger)}
        BEFORE INSERT OR UPDATE OR DELETE ON ${sql.raw(table)}
        FOR EACH ROW EXECUTE FUNCTION ${sql.raw(AUTHORITY_USER_TRIGGER_FUNCTION)}(${sql.lit(column)})
    `.execute(db)
  }

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
    await sql`
      CREATE TRIGGER ${sql.raw(trigger)}
        BEFORE INSERT OR UPDATE OR DELETE ON ${sql.raw(table)}
        FOR EACH ROW EXECUTE FUNCTION ${sql.raw(AUTHORITY_SUBJECT_TRIGGER_FUNCTION)}('subject_type', 'subject_id')
    `.execute(db)
  }

  for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
    await sql`ALTER TABLE ${sql.raw(table)} DISABLE TRIGGER ${sql.raw(trigger)}`.execute(db)
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await installRecoveryAuthorityTriggers(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropRecoveryAuthorityTriggers(db)
}
