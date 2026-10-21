import { sql, type Kysely } from 'kysely'

/**
 * Root-fix for the CVE-2018-1058-shaped shadowing hole in the recovery-authority lease functions.
 *
 * The functions installed by `zzzz20260721121000_add_recovery_authority_locks.ts` (and its
 * corrective replay `zzzz20260728120000_correct_recovery_authority_locks.ts`) call the lease
 * helpers by BARE name and carry NO fixed `SET search_path`. A SECURITY-INVOKER plpgsql function
 * with no `SET search_path` resolves called functions through the CALLER's search_path, whose
 * default is `"$user", public`. A same-signature `metasheet_try_recovery_authority_*(text, boolean)`
 * planted in a schema named after the connecting role therefore wins over the real helper in
 * `public`, and an EXCLUSIVE recovery-authority lease silently stops refusing platform writes.
 *
 * Those functions are ALREADY APPLIED on prod/staging (triggers DISABLED), so their original
 * migration cannot be edited. This migration `CREATE OR REPLACE`s the six functions IN PLACE with
 * BOTH hardenings, and nothing else:
 *
 *   (a) every internal call to another `public` function is SCHEMA-QUALIFIED
 *       (`public.metasheet_try_recovery_authority_user(...)`), so name resolution is explicit and
 *       immune to any search_path; and
 *   (b) a fixed `SET search_path = pg_catalog, public` on every function, so even a bare reference
 *       resolves through an attacker-EXCLUDED path.
 *
 * `pg_catalog` is chosen (over `= ''`) deliberately: PostgreSQL ALWAYS searches `pg_catalog`
 * implicitly-first whether or not it is named, and it requires superuser to pollute, so built-in
 * functions/operators (`btrim`, `hashtextextended`, `unnest`, `to_jsonb`, `pg_try_advisory_xact_lock*`,
 * `||`, `<>`) resolve safely either way. Naming `pg_catalog, public` is the lower-brittleness belt
 * that still excludes the attacker's role-named schema; the schema-qualified calls are the suspenders.
 * Both (a) and (b) are independently sufficient to defeat the shadow (proven by the mutation matrix in
 * `tests/integration/recovery-authority-search-path.db.test.ts`); they are shipped together as
 * defense-in-depth.
 *
 * OBSERVABLE BEHAVIOR IS UNCHANGED. Only NAME RESOLUTION is hardened:
 *   - identical lock semantics (same advisory keys, shared/exclusive branches);
 *   - identical `40001 / METASHEET_RECOVERY_AUTHORITY_BUSY` raise;
 *   - the six function OIDs are preserved (CREATE OR REPLACE), so the nine triggers keep pointing at
 *     them and their DISABLED posture is untouched — this migration issues NO trigger DDL.
 *
 * The `prosrc` (body) of the three trigger functions changes only by the `public.` qualifier; the
 * three try-lock helper bodies do not change at all (they call only pg_catalog built-ins). The
 * `SET search_path` lands in `pg_proc.proconfig`, not `prosrc`. The containment helper
 * (`scripts/ops/multitable-recovery-schema-containment.mjs`) is updated in the same change to
 * fingerprint BOTH `prosrc` and `proconfig`, so the whole hardening is drift-protected.
 */

const SEARCH_PATH = sql.raw('SET search_path = pg_catalog, public')

async function applyHardenedFunctions(db: Kysely<unknown>): Promise<void> {
  // Try-lock helpers: bodies are byte-identical to the original (they call only pg_catalog
  // built-ins, nothing to qualify). The ONLY change is the fixed search_path in proconfig.
  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_try_recovery_authority_user(authority_user_id text, exclusive boolean)
    RETURNS boolean
    LANGUAGE plpgsql
    ${SEARCH_PATH}
    AS $$
    DECLARE
      lock_key bigint;
    BEGIN
      IF authority_user_id IS NULL OR btrim(authority_user_id) = '' THEN
        RETURN TRUE;
      END IF;
      lock_key := hashtextextended(
        'metasheet:recovery-authority:user:' || btrim(authority_user_id),
        0
      );
      IF exclusive THEN
        RETURN pg_try_advisory_xact_lock(lock_key);
      END IF;
      RETURN pg_try_advisory_xact_lock_shared(lock_key);
    END;
    $$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_try_recovery_authority_role(authority_role_id text, exclusive boolean)
    RETURNS boolean
    LANGUAGE plpgsql
    ${SEARCH_PATH}
    AS $$
    DECLARE
      lock_key bigint;
    BEGIN
      IF authority_role_id IS NULL OR btrim(authority_role_id) = '' THEN
        RETURN TRUE;
      END IF;
      lock_key := hashtextextended(
        'metasheet:recovery-authority:role:' || btrim(authority_role_id),
        0
      );
      IF exclusive THEN
        RETURN pg_try_advisory_xact_lock(lock_key);
      END IF;
      RETURN pg_try_advisory_xact_lock_shared(lock_key);
    END;
    $$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_try_recovery_authority_group(authority_group_id text, exclusive boolean)
    RETURNS boolean
    LANGUAGE plpgsql
    ${SEARCH_PATH}
    AS $$
    DECLARE
      lock_key bigint;
    BEGIN
      IF authority_group_id IS NULL OR btrim(authority_group_id) = '' THEN
        RETURN TRUE;
      END IF;
      lock_key := hashtextextended(
        'metasheet:recovery-authority:group:' || btrim(authority_group_id),
        0
      );
      IF exclusive THEN
        RETURN pg_try_advisory_xact_lock(lock_key);
      END IF;
      RETURN pg_try_advisory_xact_lock_shared(lock_key);
    END;
    $$
  `.execute(db)

  // Trigger functions: the bare `metasheet_try_recovery_authority_*` calls are schema-qualified to
  // `public.` (this is the load-bearing per-call fix) AND a fixed search_path is set.
  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_recovery_authority_user_trigger()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    ${SEARCH_PATH}
    AS $$
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
        IF NOT public.metasheet_try_recovery_authority_user(authority_user_id, FALSE) THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'METASHEET_RECOVERY_AUTHORITY_BUSY';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_recovery_role_permission_trigger()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    ${SEARCH_PATH}
    AS $$
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
        IF NOT public.metasheet_try_recovery_authority_role(affected_role_id, FALSE) THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'METASHEET_RECOVERY_AUTHORITY_BUSY';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_recovery_authority_subject_trigger()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    ${SEARCH_PATH}
    AS $$
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
          acquired := public.metasheet_try_recovery_authority_user(affected_subject_id, FALSE);
        ELSIF affected_subject_type = 'role' THEN
          acquired := public.metasheet_try_recovery_authority_role(affected_subject_id, FALSE);
        ELSE
          acquired := public.metasheet_try_recovery_authority_group(affected_subject_id, FALSE);
        END IF;
        IF NOT acquired THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'METASHEET_RECOVERY_AUTHORITY_BUSY';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)
}

/**
 * Restore the pre-fix bodies: bare-name helper calls and NO fixed search_path (`RESET search_path`
 * clears the proconfig entry that `up` planted). Behaviorally identical to the state installed by
 * `zzzz20260721121000` / `zzzz20260728120000`. Trigger OIDs and DISABLED posture are untouched.
 */
async function restoreUnhardenedFunctions(db: Kysely<unknown>): Promise<void> {
  const reset = sql.raw('RESET search_path')

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_try_recovery_authority_user(authority_user_id text, exclusive boolean)
    RETURNS boolean
    LANGUAGE plpgsql
    ${reset}
    AS $$
    DECLARE
      lock_key bigint;
    BEGIN
      IF authority_user_id IS NULL OR btrim(authority_user_id) = '' THEN
        RETURN TRUE;
      END IF;
      lock_key := hashtextextended(
        'metasheet:recovery-authority:user:' || btrim(authority_user_id),
        0
      );
      IF exclusive THEN
        RETURN pg_try_advisory_xact_lock(lock_key);
      END IF;
      RETURN pg_try_advisory_xact_lock_shared(lock_key);
    END;
    $$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_try_recovery_authority_role(authority_role_id text, exclusive boolean)
    RETURNS boolean
    LANGUAGE plpgsql
    ${reset}
    AS $$
    DECLARE
      lock_key bigint;
    BEGIN
      IF authority_role_id IS NULL OR btrim(authority_role_id) = '' THEN
        RETURN TRUE;
      END IF;
      lock_key := hashtextextended(
        'metasheet:recovery-authority:role:' || btrim(authority_role_id),
        0
      );
      IF exclusive THEN
        RETURN pg_try_advisory_xact_lock(lock_key);
      END IF;
      RETURN pg_try_advisory_xact_lock_shared(lock_key);
    END;
    $$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_try_recovery_authority_group(authority_group_id text, exclusive boolean)
    RETURNS boolean
    LANGUAGE plpgsql
    ${reset}
    AS $$
    DECLARE
      lock_key bigint;
    BEGIN
      IF authority_group_id IS NULL OR btrim(authority_group_id) = '' THEN
        RETURN TRUE;
      END IF;
      lock_key := hashtextextended(
        'metasheet:recovery-authority:group:' || btrim(authority_group_id),
        0
      );
      IF exclusive THEN
        RETURN pg_try_advisory_xact_lock(lock_key);
      END IF;
      RETURN pg_try_advisory_xact_lock_shared(lock_key);
    END;
    $$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_recovery_authority_user_trigger()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    ${reset}
    AS $$
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
        IF NOT metasheet_try_recovery_authority_user(authority_user_id, FALSE) THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'METASHEET_RECOVERY_AUTHORITY_BUSY';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_recovery_role_permission_trigger()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    ${reset}
    AS $$
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
        IF NOT metasheet_try_recovery_authority_role(affected_role_id, FALSE) THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'METASHEET_RECOVERY_AUTHORITY_BUSY';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.metasheet_recovery_authority_subject_trigger()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    ${reset}
    AS $$
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
          acquired := metasheet_try_recovery_authority_user(affected_subject_id, FALSE);
        ELSIF affected_subject_type = 'role' THEN
          acquired := metasheet_try_recovery_authority_role(affected_subject_id, FALSE);
        ELSE
          acquired := metasheet_try_recovery_authority_group(affected_subject_id, FALSE);
        END IF;
        IF NOT acquired THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'METASHEET_RECOVERY_AUTHORITY_BUSY';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await applyHardenedFunctions(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await restoreUnhardenedFunctions(db)
}
