#!/usr/bin/env node

/**
 * Read-only database-schema containment check for the Time Machine recovery line.
 *
 * The helper intentionally reports only object counts, deterministic fingerprints, verdicts, and —
 * on failure — schema-metadata identifiers (e.g. an offending constraint name and its ON DELETE
 * action letter). It never prints DATABASE_URL, query results, row data, or raw database errors.
 * Run it inside the backend container so it observes the same DATABASE_URL as the running service.
 *
 * Invariant guarded alongside the trigger/function fingerprints: `meta_links.foreign_record_id`
 * must carry NO foreign-key constraint at all — any pg_constraint `contype = 'f'` row on meta_links
 * whose conkey covers that column fails the check, regardless of constraint name, referenced
 * table/column, validation state, or ON DELETE action.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromBackend = createRequire(
  new URL('../../packages/core-backend/package.json', import.meta.url),
)

const AUTHORITY_TRIGGER_FUNCTIONS = [
  'metasheet_recovery_authority_subject_trigger',
  'metasheet_recovery_authority_user_trigger',
  'metasheet_recovery_role_permission_trigger',
]

const AUTHORITY_FUNCTION_NAMES = [
  'metasheet_try_recovery_authority_group',
  'metasheet_try_recovery_authority_role',
  'metasheet_try_recovery_authority_user',
  ...AUTHORITY_TRIGGER_FUNCTIONS,
]

function triggerArgsHex(...args) {
  return Buffer.from(args.map((arg) => `${arg}\0`).join('')).toString('hex')
}

const EXPECTED_AUTHORITY_TRIGGERS = [
  {
    schemaName: 'public',
    tableName: 'field_permissions',
    triggerName: 'trg_field_permissions_recovery_authority_lock',
    enabled: 'D',
    triggerType: 31,
    functionSchema: 'public',
    functionName: 'metasheet_recovery_authority_subject_trigger',
    argumentHex: triggerArgsHex('subject_type', 'subject_id'),
    whenClause: '',
    updateColumns: [],
  },
  {
    schemaName: 'public',
    tableName: 'platform_member_group_members',
    triggerName: 'trg_member_group_members_recovery_authority_lock',
    enabled: 'D',
    triggerType: 31,
    functionSchema: 'public',
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('user_id'),
    whenClause: '',
    updateColumns: [],
  },
  {
    schemaName: 'public',
    tableName: 'record_permissions',
    triggerName: 'trg_record_permissions_recovery_authority_lock',
    enabled: 'D',
    triggerType: 31,
    functionSchema: 'public',
    functionName: 'metasheet_recovery_authority_subject_trigger',
    argumentHex: triggerArgsHex('subject_type', 'subject_id'),
    whenClause: '',
    updateColumns: [],
  },
  {
    schemaName: 'public',
    tableName: 'role_permissions',
    triggerName: 'trg_role_permissions_recovery_authority_lock',
    enabled: 'D',
    triggerType: 31,
    functionSchema: 'public',
    functionName: 'metasheet_recovery_role_permission_trigger',
    argumentHex: '',
    whenClause: '',
    updateColumns: [],
  },
  {
    schemaName: 'public',
    tableName: 'spreadsheet_permissions',
    triggerName: 'trg_spreadsheet_permissions_recovery_authority_lock',
    enabled: 'D',
    triggerType: 31,
    functionSchema: 'public',
    functionName: 'metasheet_recovery_authority_subject_trigger',
    argumentHex: triggerArgsHex('subject_type', 'subject_id'),
    whenClause: '',
    updateColumns: [],
  },
  {
    schemaName: 'public',
    tableName: 'user_permissions',
    triggerName: 'trg_user_permissions_recovery_authority_lock',
    enabled: 'D',
    triggerType: 31,
    functionSchema: 'public',
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('user_id'),
    whenClause: '',
    updateColumns: [],
  },
  {
    schemaName: 'public',
    tableName: 'user_roles',
    triggerName: 'trg_user_roles_recovery_authority_lock',
    enabled: 'D',
    triggerType: 31,
    functionSchema: 'public',
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('user_id'),
    whenClause: '',
    updateColumns: [],
  },
  {
    schemaName: 'public',
    tableName: 'users',
    triggerName: 'trg_users_recovery_authority_lock_lifecycle',
    enabled: 'D',
    triggerType: 15,
    functionSchema: 'public',
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('id'),
    whenClause: '',
    updateColumns: [],
  },
  {
    schemaName: 'public',
    tableName: 'users',
    triggerName: 'trg_users_recovery_authority_lock_update',
    enabled: 'D',
    triggerType: 19,
    functionSchema: 'public',
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('id'),
    whenClause: '',
    updateColumns: ['role', 'permissions', 'is_active'],
  },
]

const TRY_LOCK_USER_BODY = `
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
`

const TRY_LOCK_ROLE_BODY = `
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
`

const TRY_LOCK_GROUP_BODY = `
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
`

const USER_TRIGGER_BODY = `
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
`

const ROLE_PERMISSION_TRIGGER_BODY = `
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
`

const SUBJECT_TRIGGER_BODY = `
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
`

const EXPECTED_AUTHORITY_FUNCTIONS = [
  {
    schemaName: 'public',
    functionName: 'metasheet_try_recovery_authority_group',
    identityArguments: 'authority_group_id text, exclusive boolean',
    resultType: 'boolean',
    language: 'plpgsql',
    securityDefiner: false,
    volatility: 'v',
    body: TRY_LOCK_GROUP_BODY,
  },
  {
    schemaName: 'public',
    functionName: 'metasheet_try_recovery_authority_role',
    identityArguments: 'authority_role_id text, exclusive boolean',
    resultType: 'boolean',
    language: 'plpgsql',
    securityDefiner: false,
    volatility: 'v',
    body: TRY_LOCK_ROLE_BODY,
  },
  {
    schemaName: 'public',
    functionName: 'metasheet_try_recovery_authority_user',
    identityArguments: 'authority_user_id text, exclusive boolean',
    resultType: 'boolean',
    language: 'plpgsql',
    securityDefiner: false,
    volatility: 'v',
    body: TRY_LOCK_USER_BODY,
  },
  {
    schemaName: 'public',
    functionName: 'metasheet_recovery_authority_subject_trigger',
    identityArguments: '',
    resultType: 'trigger',
    language: 'plpgsql',
    securityDefiner: false,
    volatility: 'v',
    body: SUBJECT_TRIGGER_BODY,
  },
  {
    schemaName: 'public',
    functionName: 'metasheet_recovery_authority_user_trigger',
    identityArguments: '',
    resultType: 'trigger',
    language: 'plpgsql',
    securityDefiner: false,
    volatility: 'v',
    body: USER_TRIGGER_BODY,
  },
  {
    schemaName: 'public',
    functionName: 'metasheet_recovery_role_permission_trigger',
    identityArguments: '',
    resultType: 'trigger',
    language: 'plpgsql',
    securityDefiner: false,
    volatility: 'v',
    body: ROLE_PERMISSION_TRIGGER_BODY,
  },
]

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function canonicalTrigger(row) {
  return {
    schemaName: String(row.schemaName ?? row.schema_name ?? ''),
    tableName: String(row.tableName ?? row.table_name ?? ''),
    triggerName: String(row.triggerName ?? row.trigger_name ?? ''),
    enabled: String(row.enabled ?? ''),
    triggerType: Number(row.triggerType ?? row.trigger_type ?? -1),
    functionSchema: String(row.functionSchema ?? row.function_schema ?? ''),
    functionName: String(row.functionName ?? row.function_name ?? ''),
    argumentHex: String(row.argumentHex ?? row.argument_hex ?? ''),
    whenClause: String(row.whenClause ?? row.when_clause ?? ''),
    updateColumns: [...(row.updateColumns ?? row.update_columns ?? [])].map(
      String,
    ),
  }
}

function canonicalFunction(row) {
  return {
    schemaName: String(row.schemaName ?? row.schema_name ?? ''),
    functionName: String(row.functionName ?? row.function_name ?? ''),
    identityArguments: String(
      row.identityArguments ?? row.identity_arguments ?? '',
    ),
    resultType: String(row.resultType ?? row.result_type ?? ''),
    language: String(row.language ?? ''),
    securityDefiner: Boolean(row.securityDefiner ?? row.security_definer),
    volatility: String(row.volatility ?? ''),
    body: normalizeWhitespace(row.body),
  }
}

function canonicalMetaLinksForeignRecordFk(row) {
  return {
    constraintName: String(row.constraintName ?? row.constraint_name ?? ''),
    onDeleteAction: String(row.onDeleteAction ?? row.on_delete_action ?? ''),
  }
}

/**
 * The authority-trigger catalogue SELECT — the SINGLE query of record for the canonical trigger
 * identity (`$1` = expected trigger names, `$2` = authority trigger function names). Exported so
 * the L1 battery's posture preflight observes the SAME columns this module canonicalizes rather
 * than re-hardcoding a narrower field list of its own; a column added here reaches both readers.
 * Deliberately NOT schema-filtered: an authority-named trigger parked in another schema must show
 * up as an observation, not vanish from the snapshot.
 *
 * `when_clause` (pg_trigger.tgqual) is part of the identity for the same reason table_name is: a
 * trigger can match the census in every OTHER field — right table, function, events, args, update
 * columns, tgenabled — and still never fire, because a WHEN predicate that is never true gates it.
 * Verified behaviourally on a real database: with such a predicate an EXCLUSIVE
 * recovery-authority lease no longer refuses the platform write at all. Every authority trigger is
 * declared without a WHEN clause, so the expected value is the empty string.
 */
const AUTHORITY_TRIGGER_SNAPSHOT_QUERY = `SELECT
         ns.nspname AS schema_name,
         cls.relname AS table_name,
         trg.tgname AS trigger_name,
         trg.tgenabled AS enabled,
         trg.tgtype::int AS trigger_type,
         pns.nspname AS function_schema,
         proc.proname AS function_name,
         encode(trg.tgargs, 'hex') AS argument_hex,
         -- The WHEN clause (see the note above the export for why it is part of the identity).
         COALESCE(pg_catalog.pg_get_expr(trg.tgqual, trg.tgrelid), '') AS when_clause,
         COALESCE(
           ARRAY(
             SELECT attr.attname::text
               FROM unnest(trg.tgattr::smallint[]) WITH ORDINALITY AS selected(attnum, position)
               JOIN pg_catalog.pg_attribute attr
                 ON attr.attrelid = trg.tgrelid
                AND attr.attnum = selected.attnum
              ORDER BY selected.position
           ),
           ARRAY[]::text[]
         ) AS update_columns
       FROM pg_catalog.pg_trigger trg
       JOIN pg_catalog.pg_class cls ON cls.oid = trg.tgrelid
       JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
       JOIN pg_catalog.pg_proc proc ON proc.oid = trg.tgfoid
       JOIN pg_catalog.pg_namespace pns ON pns.oid = proc.pronamespace
      WHERE NOT trg.tgisinternal
        AND (
          trg.tgname = ANY($1::text[])
          OR proc.proname = ANY($2::text[])
        )
      ORDER BY ns.nspname, cls.relname, trg.tgname`

/**
 * The authority-function catalogue SELECT — the SINGLE query of record for the function body
 * fingerprint (`$1` = authority function names). Shared with the L1 battery for the same reason
 * as the trigger query above.
 */
const AUTHORITY_FUNCTION_SNAPSHOT_QUERY = `SELECT
         ns.nspname AS schema_name,
         proc.proname AS function_name,
         pg_catalog.pg_get_function_identity_arguments(proc.oid) AS identity_arguments,
         pg_catalog.pg_get_function_result(proc.oid) AS result_type,
         lang.lanname AS language,
         proc.prosecdef AS security_definer,
         proc.provolatile AS volatility,
         proc.prosrc AS body
       FROM pg_catalog.pg_proc proc
       JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
       JOIN pg_catalog.pg_language lang ON lang.oid = proc.prolang
      WHERE ns.nspname = 'public'
        AND proc.proname = ANY($1::text[])
      ORDER BY ns.nspname, proc.proname, pg_catalog.pg_get_function_identity_arguments(proc.oid)`

/**
 * SHADOW-FUNCTION census (`$1` = authority function names). Returns every authority-named function
 * that lives OUTSIDE `public`, in any other schema.
 *
 * Why this is a posture question and not housekeeping: the authority trigger functions call the
 * lease helpers by BARE NAME and carry no `SET search_path`, so resolution follows the CALLER's
 * search_path — whose default is `"$user", public`. A same-signature helper in a schema named after
 * the connecting role therefore wins over the real one in `public` (the CVE-2018-1058 shape).
 * Verified behaviourally on a real database: with such a shadow present, an EXCLUSIVE
 * recovery-authority lease no longer refuses the platform write, while every `public` catalogue row
 * — all nine triggers, all six function fingerprints — still matches the census exactly.
 *
 * `AUTHORITY_FUNCTION_SNAPSHOT_QUERY` is schema-filtered to `public` and so cannot see this; that
 * filter is deliberate (its rows are compared field-by-field against the `public` census). This is
 * the complementary observation, kept separate so the containment module's own verdict shape is
 * unchanged. NOTE: the root cause is the migration's functions lacking `SET search_path` — this
 * query lets a reader REFUSE such a database, it does not harden it.
 */
const AUTHORITY_FUNCTION_SHADOW_QUERY = `SELECT
         ns.nspname AS schema_name,
         proc.proname AS function_name,
         pg_catalog.pg_get_function_identity_arguments(proc.oid) AS identity_arguments
       FROM pg_catalog.pg_proc proc
       JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
      WHERE ns.nspname <> 'public'
        AND proc.proname = ANY($1::text[])
      ORDER BY ns.nspname, proc.proname, pg_catalog.pg_get_function_identity_arguments(proc.oid)`

function sortByJson(rows) {
  return [...rows].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  )
}

function canonicalSnapshot(snapshot) {
  return {
    authorityTriggers: sortByJson(
      (snapshot.authorityTriggers ?? []).map(canonicalTrigger),
    ),
    authorityFunctions: sortByJson(
      (snapshot.authorityFunctions ?? []).map(canonicalFunction),
    ),
    metaLinksForeignRecordFks: sortByJson(
      (snapshot.metaLinksForeignRecordFks ?? []).map(
        canonicalMetaLinksForeignRecordFk,
      ),
    ),
  }
}

function expectedSchemaSnapshot() {
  return canonicalSnapshot({
    authorityTriggers: EXPECTED_AUTHORITY_TRIGGERS,
    authorityFunctions: EXPECTED_AUTHORITY_FUNCTIONS,
  })
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function assessSchemaSnapshot(snapshot) {
  const actual = canonicalSnapshot(snapshot)
  const expected = expectedSchemaSnapshot()
  const checks = [
    {
      id: 'recovery-authority-triggers',
      actual: actual.authorityTriggers,
      expected: expected.authorityTriggers,
    },
    {
      id: 'recovery-authority-functions',
      actual: actual.authorityFunctions,
      expected: expected.authorityFunctions,
    },
    {
      // The invariant is column-scoped and absolute: NO foreign-key constraint may cover
      // meta_links.foreign_record_id — any hit fails regardless of constraint name, referenced
      // table/column, validation state, or ON DELETE action. Expected is therefore always [].
      id: 'meta-links-foreign-record-id-fk-absence',
      actual: actual.metaLinksForeignRecordFks,
      expected: expected.metaLinksForeignRecordFks,
      diagnostics: actual.metaLinksForeignRecordFks.map(
        (fk) =>
          `forbidden foreign key covers meta_links.foreign_record_id: constraint="${fk.constraintName}" on_delete_action='${fk.onDeleteAction}' — drop it; no FK is allowed on this column`,
      ),
    },
  ].map((check) => ({
    id: check.id,
    ok: JSON.stringify(check.actual) === JSON.stringify(check.expected),
    actualCount: check.actual.length,
    expectedCount: check.expected.length,
    actualFingerprint: fingerprint(check.actual),
    expectedFingerprint: fingerprint(check.expected),
    diagnostics: check.diagnostics ?? [],
  }))

  return {
    ok: checks.every((check) => check.ok),
    checks,
  }
}

function renderAssessment(assessment) {
  const lines = ['Time Machine recovery schema containment']
  for (const check of assessment.checks) {
    const verdict = check.ok ? 'PASS' : 'FAIL'
    lines.push(
      `${check.id}: ${verdict} count=${check.actualCount}/${check.expectedCount} fingerprint=${check.actualFingerprint} expected=${check.expectedFingerprint}`,
    )
    if (!check.ok) {
      for (const diagnostic of check.diagnostics ?? []) {
        lines.push(`  ${diagnostic}`)
      }
    }
  }
  lines.push(
    assessment.ok
      ? 'VERDICT: PASS - recovery authority triggers/functions match the expected default-inert schema posture and no foreign_record_id FK exists on meta_links'
      : 'VERDICT: FAIL - recovery schema posture is missing, unexpectedly enabled, fingerprint-drifted, or meta_links.foreign_record_id carries a foreign key',
  )
  return lines.join('\n')
}

async function queryRecoverySchemaSnapshot(databaseUrl) {
  const pg = requireFromBackend('pg')
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    application_name: 'metasheet-recovery-schema-containment',
  })
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '10s'")

    const triggerNames = EXPECTED_AUTHORITY_TRIGGERS.map(
      (trigger) => trigger.triggerName,
    )
    const triggers = await client.query(AUTHORITY_TRIGGER_SNAPSHOT_QUERY, [
      triggerNames,
      AUTHORITY_TRIGGER_FUNCTIONS,
    ])

    const functions = await client.query(AUTHORITY_FUNCTION_SNAPSHOT_QUERY, [
      AUTHORITY_FUNCTION_NAMES,
    ])

    // Column-scoped FK absence: every pg_constraint FK on meta_links whose conkey (constrained
    // column attnum array) covers the attnum of meta_links.foreign_record_id. Constraint name,
    // referenced table/column, validation state (NOT VALID included), and ON DELETE action are
    // deliberately NOT filtered on — a column hit alone is a violation.
    const metaLinksFks = await client.query(
      `SELECT
         con.conname AS constraint_name,
         con.confdeltype AS on_delete_action
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_attribute attr
         ON attr.attrelid = con.conrelid
        AND attr.attname = 'foreign_record_id'
        AND NOT attr.attisdropped
      WHERE con.contype = 'f'
        AND con.conrelid = 'public.meta_links'::regclass
        AND attr.attnum = ANY (con.conkey)
      ORDER BY con.conname`,
    )

    await client.query('COMMIT')
    return {
      authorityTriggers: triggers.rows,
      authorityFunctions: functions.rows,
      metaLinksForeignRecordFks: metaLinksFks.rows,
    }
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client?.release()
    await pool.end()
  }
}

async function runSchemaContainment({
  env = process.env,
  querySnapshot = queryRecoverySchemaSnapshot,
} = {}) {
  const databaseUrl = String(env.DATABASE_URL ?? '').trim()
  if (!databaseUrl) {
    return {
      exitCode: 2,
      output:
        'VERDICT: FAIL - database schema observation unavailable (DATABASE_URL missing)',
    }
  }

  try {
    const snapshot = await querySnapshot(databaseUrl)
    const assessment = assessSchemaSnapshot(snapshot)
    return {
      exitCode: assessment.ok ? 0 : 1,
      output: renderAssessment(assessment),
    }
  } catch {
    return {
      exitCode: 2,
      output:
        'VERDICT: FAIL - database schema observation unavailable (connection, query, or catalog permission denied)',
    }
  }
}

async function main() {
  const result = await runSchemaContainment()
  const stream = result.exitCode === 0 ? process.stdout : process.stderr
  stream.write(`${result.output}\n`)
  process.exitCode = result.exitCode
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export {
  AUTHORITY_FUNCTION_NAMES,
  AUTHORITY_FUNCTION_SHADOW_QUERY,
  AUTHORITY_FUNCTION_SNAPSHOT_QUERY,
  AUTHORITY_TRIGGER_FUNCTIONS,
  AUTHORITY_TRIGGER_SNAPSHOT_QUERY,
  EXPECTED_AUTHORITY_FUNCTIONS,
  EXPECTED_AUTHORITY_TRIGGERS,
  assessSchemaSnapshot,
  canonicalFunction,
  canonicalSnapshot,
  canonicalTrigger,
  expectedSchemaSnapshot,
  fingerprint,
  queryRecoverySchemaSnapshot,
  renderAssessment,
  runSchemaContainment,
}
