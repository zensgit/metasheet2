#!/usr/bin/env node

/**
 * Read-only database-schema containment check for the Time Machine recovery line.
 *
 * The helper intentionally reports only object counts, deterministic fingerprints, and verdicts.
 * It never prints DATABASE_URL, query results, row data, or raw database errors. Run it inside the
 * backend container so it observes the same DATABASE_URL as the running service.
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

const EXPECTED_META_LINKS_FOREIGN_KEY = [
  {
    sourceSchema: 'public',
    sourceTable: 'meta_links',
    constraintName: 'meta_links_foreign_record_id_fkey',
    constraintType: 'f',
    validated: false,
    deferrable: true,
    initiallyDeferred: false,
    updateAction: 'a',
    deleteAction: 'a',
    matchType: 's',
    targetSchema: 'public',
    targetTable: 'meta_records',
    sourceColumns: ['foreign_record_id'],
    targetColumns: ['id'],
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

function canonicalForeignKey(row) {
  return {
    sourceSchema: String(row.sourceSchema ?? row.source_schema ?? ''),
    sourceTable: String(row.sourceTable ?? row.source_table ?? ''),
    constraintName: String(row.constraintName ?? row.constraint_name ?? ''),
    constraintType: String(row.constraintType ?? row.constraint_type ?? ''),
    validated: Boolean(row.validated),
    deferrable: Boolean(row.deferrable),
    initiallyDeferred: Boolean(row.initiallyDeferred ?? row.initially_deferred),
    updateAction: String(row.updateAction ?? row.update_action ?? ''),
    deleteAction: String(row.deleteAction ?? row.delete_action ?? ''),
    matchType: String(row.matchType ?? row.match_type ?? ''),
    targetSchema: String(row.targetSchema ?? row.target_schema ?? ''),
    targetTable: String(row.targetTable ?? row.target_table ?? ''),
    sourceColumns: [...(row.sourceColumns ?? row.source_columns ?? [])].map(
      String,
    ),
    targetColumns: [...(row.targetColumns ?? row.target_columns ?? [])].map(
      String,
    ),
  }
}

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
    metaLinksForeignKey: sortByJson(
      (snapshot.metaLinksForeignKey ?? []).map(canonicalForeignKey),
    ),
  }
}

function expectedSchemaSnapshot() {
  return canonicalSnapshot({
    authorityTriggers: EXPECTED_AUTHORITY_TRIGGERS,
    authorityFunctions: EXPECTED_AUTHORITY_FUNCTIONS,
    metaLinksForeignKey: EXPECTED_META_LINKS_FOREIGN_KEY,
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
      id: 'meta-links-live-target-fk',
      actual: actual.metaLinksForeignKey,
      expected: expected.metaLinksForeignKey,
    },
  ].map((check) => ({
    id: check.id,
    ok: JSON.stringify(check.actual) === JSON.stringify(check.expected),
    actualCount: check.actual.length,
    expectedCount: check.expected.length,
    actualFingerprint: fingerprint(check.actual),
    expectedFingerprint: fingerprint(check.expected),
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
  }
  lines.push(
    assessment.ok
      ? 'VERDICT: PASS - recovery authority triggers/functions and meta_links FK match the expected default-inert schema posture'
      : 'VERDICT: FAIL - recovery schema posture is missing, unexpectedly enabled, or fingerprint-drifted',
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
    const triggers = await client.query(
      `SELECT
         ns.nspname AS schema_name,
         cls.relname AS table_name,
         trg.tgname AS trigger_name,
         trg.tgenabled AS enabled,
         trg.tgtype::int AS trigger_type,
         pns.nspname AS function_schema,
         proc.proname AS function_name,
         encode(trg.tgargs, 'hex') AS argument_hex,
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
      ORDER BY ns.nspname, cls.relname, trg.tgname`,
      [triggerNames, AUTHORITY_TRIGGER_FUNCTIONS],
    )

    const functions = await client.query(
      `SELECT
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
      ORDER BY ns.nspname, proc.proname, pg_catalog.pg_get_function_identity_arguments(proc.oid)`,
      [AUTHORITY_FUNCTION_NAMES],
    )

    const foreignKey = await client.query(
      `SELECT
         source_ns.nspname AS source_schema,
         source.relname AS source_table,
         con.conname AS constraint_name,
         con.contype AS constraint_type,
         con.convalidated AS validated,
         con.condeferrable AS deferrable,
         con.condeferred AS initially_deferred,
         con.confupdtype AS update_action,
         con.confdeltype AS delete_action,
         con.confmatchtype AS match_type,
         target_ns.nspname AS target_schema,
         target.relname AS target_table,
         ARRAY(
           SELECT attr.attname::text
             FROM unnest(con.conkey) WITH ORDINALITY AS selected(attnum, position)
             JOIN pg_catalog.pg_attribute attr
               ON attr.attrelid = con.conrelid
              AND attr.attnum = selected.attnum
            ORDER BY selected.position
         ) AS source_columns,
         ARRAY(
           SELECT attr.attname::text
             FROM unnest(con.confkey) WITH ORDINALITY AS selected(attnum, position)
             JOIN pg_catalog.pg_attribute attr
               ON attr.attrelid = con.confrelid
              AND attr.attnum = selected.attnum
            ORDER BY selected.position
         ) AS target_columns
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class source ON source.oid = con.conrelid
       JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
       JOIN pg_catalog.pg_class target ON target.oid = con.confrelid
       JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
      WHERE source_ns.nspname = 'public'
        AND source.relname = 'meta_links'
        AND con.conname = 'meta_links_foreign_record_id_fkey'
      ORDER BY source_ns.nspname, source.relname, con.conname`,
    )

    await client.query('COMMIT')
    return {
      authorityTriggers: triggers.rows,
      authorityFunctions: functions.rows,
      metaLinksForeignKey: foreignKey.rows,
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
  AUTHORITY_TRIGGER_FUNCTIONS,
  EXPECTED_AUTHORITY_FUNCTIONS,
  EXPECTED_AUTHORITY_TRIGGERS,
  EXPECTED_META_LINKS_FOREIGN_KEY,
  assessSchemaSnapshot,
  canonicalSnapshot,
  expectedSchemaSnapshot,
  fingerprint,
  queryRecoverySchemaSnapshot,
  renderAssessment,
  runSchemaContainment,
}
