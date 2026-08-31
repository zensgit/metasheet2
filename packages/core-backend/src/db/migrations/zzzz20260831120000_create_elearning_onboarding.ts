import { createHash } from 'node:crypto'

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { checkTableExists } from './_patterns'

export const ELEARNING_ONBOARDING_POLICIES_TABLE = 'elearning_onboarding_policies'
export const ELEARNING_ONBOARDING_ASSIGNMENT_EFFECTS_TABLE =
  'elearning_onboarding_assignment_effects'
export const ELEARNING_ONBOARDING_WEEKLY_REPORTS_TABLE =
  'elearning_onboarding_weekly_reports'
export const ELEARNING_ONBOARDING_DOWN_IN_USE = 'ELEARNING_ONBOARDING_DOWN_IN_USE'

const TABLES = [
  ELEARNING_ONBOARDING_POLICIES_TABLE,
  ELEARNING_ONBOARDING_ASSIGNMENT_EFFECTS_TABLE,
  ELEARNING_ONBOARDING_WEEKLY_REPORTS_TABLE,
] as const

type ColumnContract = {
  column: string
  type: string
  nullable: 'YES' | 'NO'
  default: string | null
}

const COLUMNS: Record<(typeof TABLES)[number], readonly ColumnContract[]> = {
  elearning_onboarding_policies: [
    { column: 'id', type: 'uuid', nullable: 'NO', default: 'gen_random_uuid()' },
    { column: 'org_id', type: 'text', nullable: 'NO', default: null },
    { column: 'request_id', type: 'uuid', nullable: 'NO', default: null },
    { column: 'request_hash', type: 'text', nullable: 'NO', default: null },
    { column: 'request_hash_version', type: 'integer', nullable: 'NO', default: null },
    { column: 'training_plan_id', type: 'uuid', nullable: 'NO', default: null },
    { column: 'match_rules', type: 'jsonb', nullable: 'NO', default: null },
    { column: 'hire_window_days', type: 'integer', nullable: 'NO', default: null },
    { column: 'deadline_days', type: 'integer', nullable: 'NO', default: null },
    { column: 'weekly_report_enabled', type: 'boolean', nullable: 'NO', default: null },
    { column: 'status', type: 'text', nullable: 'NO', default: "'active'::text" },
    { column: 'created_by', type: 'text', nullable: 'NO', default: null },
    { column: 'retired_at', type: 'timestamp with time zone', nullable: 'YES', default: null },
    { column: 'retired_by', type: 'text', nullable: 'YES', default: null },
    { column: 'created_at', type: 'timestamp with time zone', nullable: 'NO', default: 'now()' },
  ],
  elearning_onboarding_assignment_effects: [
    { column: 'id', type: 'uuid', nullable: 'NO', default: 'gen_random_uuid()' },
    { column: 'org_id', type: 'text', nullable: 'NO', default: null },
    { column: 'policy_id', type: 'uuid', nullable: 'NO', default: null },
    { column: 'user_id', type: 'text', nullable: 'NO', default: null },
    { column: 'hire_date', type: 'date', nullable: 'NO', default: null },
    { column: 'job_occurrence_key', type: 'text', nullable: 'NO', default: null },
    { column: 'source_key', type: 'text', nullable: 'NO', default: null },
    { column: 'training_plan_assignment_id', type: 'uuid', nullable: 'NO', default: null },
    { column: 'created_at', type: 'timestamp with time zone', nullable: 'NO', default: 'now()' },
  ],
  elearning_onboarding_weekly_reports: [
    { column: 'id', type: 'uuid', nullable: 'NO', default: 'gen_random_uuid()' },
    { column: 'org_id', type: 'text', nullable: 'NO', default: null },
    { column: 'policy_id', type: 'uuid', nullable: 'NO', default: null },
    { column: 'week_start', type: 'date', nullable: 'NO', default: null },
    { column: 'week_end', type: 'date', nullable: 'NO', default: null },
    { column: 'min_group_size', type: 'integer', nullable: 'NO', default: null },
    { column: 'suppressed', type: 'boolean', nullable: 'NO', default: null },
    { column: 'enqueued_count', type: 'integer', nullable: 'YES', default: null },
    { column: 'assigned_user_count', type: 'integer', nullable: 'YES', default: null },
    { column: 'failed_count', type: 'integer', nullable: 'YES', default: null },
    { column: 'dead_count', type: 'integer', nullable: 'YES', default: null },
    { column: 'created_at', type: 'timestamp with time zone', nullable: 'NO', default: 'now()' },
  ],
}

const CONSTRAINTS = new Map<string, string>([
  ['elearning_onboarding_policies_pkey', 'PRIMARY KEY (id)'],
  ['elearning_onboarding_policies_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_onboarding_policies_request_uniq', 'UNIQUE (org_id, request_id)'],
  ['elearning_onboarding_policies_org_id_chk', "CHECK (btrim(org_id) <> ''::text AND org_id = btrim(org_id))"],
  ['elearning_onboarding_policies_request_chk', "CHECK (request_hash ~ '^[0-9a-f]{64}$'::text AND request_hash_version = 1)"],
  ['elearning_onboarding_policies_match_rules_chk', 'CHECK (elearning_onboarding_match_rules_valid(match_rules))'],
  ['elearning_onboarding_policies_window_chk', 'CHECK (hire_window_days >= 0 AND hire_window_days <= 365 AND deadline_days >= 0 AND deadline_days <= 3650)'],
  ['elearning_onboarding_policies_status_chk', "CHECK (status = ANY (ARRAY['active'::text, 'retired'::text]))"],
  ['elearning_onboarding_policies_actor_chk', "CHECK (btrim(created_by) <> ''::text AND (retired_by IS NULL OR btrim(retired_by) <> ''::text))"],
  ['elearning_onboarding_policies_lifecycle_chk', "CHECK (status = 'active'::text AND retired_at IS NULL AND retired_by IS NULL OR status = 'retired'::text AND retired_at IS NOT NULL AND retired_by IS NOT NULL AND retired_at >= created_at)"],
  ['elearning_onboarding_policies_plan_fk', 'FOREIGN KEY (org_id, training_plan_id) REFERENCES elearning_training_plans(org_id, id) ON DELETE RESTRICT'],
  ['elearning_onboarding_policies_created_by_fk', 'FOREIGN KEY (created_by, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_onboarding_policies_retired_by_fk', 'FOREIGN KEY (retired_by, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_onboarding_assignment_effects_pkey', 'PRIMARY KEY (id)'],
  ['elearning_onboarding_assignment_effects_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_onboarding_assignment_effects_policy_user_uniq', 'UNIQUE (org_id, policy_id, user_id)'],
  ['elearning_onboarding_assignment_effects_job_uniq', 'UNIQUE (org_id, job_occurrence_key)'],
  ['elearning_onboarding_assignment_effects_source_uniq', 'UNIQUE (org_id, source_key)'],
  ['elearning_onboarding_assignment_effects_org_id_chk', "CHECK (btrim(org_id) <> ''::text AND org_id = btrim(org_id))"],
  ['elearning_onboarding_assignment_effects_text_chk', "CHECK (btrim(user_id) <> ''::text AND btrim(job_occurrence_key) <> ''::text AND char_length(job_occurrence_key) <= 512 AND btrim(source_key) <> ''::text AND char_length(source_key) <= 512)"],
  ['elearning_onboarding_assignment_effects_policy_fk', 'FOREIGN KEY (org_id, policy_id) REFERENCES elearning_onboarding_policies(org_id, id) ON DELETE RESTRICT'],
  ['elearning_onboarding_assignment_effects_member_fk', 'FOREIGN KEY (user_id, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_onboarding_assignment_effects_assignment_fk', 'FOREIGN KEY (org_id, training_plan_assignment_id) REFERENCES elearning_training_plan_assignments(org_id, id) ON DELETE RESTRICT'],
  ['elearning_onboarding_weekly_reports_pkey', 'PRIMARY KEY (id)'],
  ['elearning_onboarding_weekly_reports_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_onboarding_weekly_reports_policy_week_uniq', 'UNIQUE (org_id, policy_id, week_start)'],
  ['elearning_onboarding_weekly_reports_org_id_chk', "CHECK (btrim(org_id) <> ''::text AND org_id = btrim(org_id))"],
  ['elearning_onboarding_weekly_reports_week_chk', 'CHECK (week_end = (week_start + 7))'],
  ['elearning_onboarding_weekly_reports_suppression_chk', 'CHECK (min_group_size >= 5 AND (suppressed AND enqueued_count IS NULL AND assigned_user_count IS NULL AND failed_count IS NULL AND dead_count IS NULL OR NOT suppressed AND enqueued_count IS NOT NULL AND assigned_user_count IS NOT NULL AND failed_count IS NOT NULL AND dead_count IS NOT NULL AND enqueued_count >= min_group_size AND assigned_user_count >= 0 AND failed_count >= 0 AND dead_count >= 0 AND assigned_user_count <= enqueued_count AND (failed_count + dead_count) <= enqueued_count))'],
  ['elearning_onboarding_weekly_reports_policy_fk', 'FOREIGN KEY (org_id, policy_id) REFERENCES elearning_onboarding_policies(org_id, id) ON DELETE RESTRICT'],
])

const MATCH_RULES_BODY = `
  SELECT jsonb_typeof(rules) = 'array'
    AND jsonb_array_length(rules) BETWEEN 1 AND 100
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(rules) AS entry(value)
      WHERE jsonb_typeof(entry.value) <> 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(entry.value)) <> 3
         OR NOT entry.value ?& ARRAY['subjectType', 'subjectRef', 'includeChildren']
         OR entry.value ->> 'subjectType' NOT IN ('department', 'position')
         OR jsonb_typeof(entry.value -> 'subjectRef') <> 'string'
         OR btrim(entry.value ->> 'subjectRef') = ''
         OR entry.value ->> 'subjectRef' <> btrim(entry.value ->> 'subjectRef')
         OR jsonb_typeof(entry.value -> 'includeChildren') <> 'boolean'
         OR (
           entry.value ->> 'subjectType' = 'department'
           AND entry.value ->> 'subjectRef'
             !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         )
         OR (
           entry.value ->> 'subjectType' = 'position'
           AND (entry.value ->> 'includeChildren')::boolean
         )
    )
    AND rules = COALESCE((
      SELECT jsonb_agg(value ORDER BY value ->> 'subjectType', value ->> 'subjectRef')
      FROM (
        SELECT DISTINCT value
        FROM jsonb_array_elements(rules) AS entry(value)
      ) normalized
    ), '[]'::jsonb)
`

const POLICY_AUTHORITY_BODY = `
  BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
      RAISE EXCEPTION 'onboarding policies cannot be deleted';
    END IF;
    IF OLD.status <> 'active'
       OR NEW.status <> 'retired'
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.request_hash_version IS DISTINCT FROM OLD.request_hash_version
       OR NEW.training_plan_id IS DISTINCT FROM OLD.training_plan_id
       OR NEW.match_rules IS DISTINCT FROM OLD.match_rules
       OR NEW.hire_window_days IS DISTINCT FROM OLD.hire_window_days
       OR NEW.deadline_days IS DISTINCT FROM OLD.deadline_days
       OR NEW.weekly_report_enabled IS DISTINCT FROM OLD.weekly_report_enabled
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.retired_at IS NULL
       OR NEW.retired_by IS NULL THEN
      RAISE EXCEPTION 'onboarding policy payload is immutable and retirement is one-way';
    END IF;
    RETURN NEW;
  END
`

const EFFECT_AUTHORITY_BODY = `
  DECLARE
    policy_plan_id uuid;
    policy_status text;
    assignment_plan_id uuid;
    assignment_members text[];
    member_active boolean;
    job_matches boolean;
  BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
      RAISE EXCEPTION 'onboarding assignment effects are immutable';
    END IF;
    SELECT training_plan_id, status
      INTO policy_plan_id, policy_status
      FROM elearning_onboarding_policies
     WHERE org_id = NEW.org_id AND id = NEW.policy_id
     FOR SHARE;
    SELECT training_plan_id, member_ids
      INTO assignment_plan_id, assignment_members
      FROM elearning_training_plan_assignments
     WHERE org_id = NEW.org_id AND id = NEW.training_plan_assignment_id
     FOR SHARE;
    SELECT is_active
      INTO member_active
      FROM user_orgs
     WHERE user_id = NEW.user_id AND org_id = NEW.org_id
     FOR SHARE;
    SELECT true
      INTO job_matches
      FROM elearning_jobs job
     WHERE job.org_id = NEW.org_id
       AND job.kind = 'onboarding_assign'
       AND job.occurrence_key = NEW.job_occurrence_key
       AND job.ref = NEW.policy_id::text
       AND job.status = 'running'
       AND job.payload = jsonb_build_object(
         'policyId', NEW.policy_id::text,
         'userId', NEW.user_id,
         'hireDate', to_char(NEW.hire_date, 'YYYY-MM-DD')
       )
     FOR SHARE;
    IF policy_status IS DISTINCT FROM 'active'
       OR assignment_plan_id IS DISTINCT FROM policy_plan_id
       OR NOT (NEW.user_id = ANY(assignment_members))
       OR member_active IS DISTINCT FROM true
       OR job_matches IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'onboarding assignment effect authority mismatch';
    END IF;
    RETURN NEW;
  END
`

const REPORT_IMMUTABLE_BODY = `
  BEGIN
    RAISE EXCEPTION 'onboarding weekly reports are immutable';
  END
`

const FUNCTION_BODIES = new Map<string, string>([
  ['elearning_onboarding_match_rules_valid', MATCH_RULES_BODY],
  ['elearning_onboarding_policy_authority', POLICY_AUTHORITY_BODY],
  ['elearning_onboarding_assignment_effect_authority', EFFECT_AUTHORITY_BODY],
  ['elearning_onboarding_weekly_report_immutable', REPORT_IMMUTABLE_BODY],
])

const FUNCTION_DIGESTS = new Map(
  [...FUNCTION_BODIES].map(([name, body]) => [
    name,
    createHash('md5').update(body).digest('hex'),
  ]),
)

function normalizeDefinition(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

async function assertCanonical(db: Kysely<unknown>): Promise<void> {
  const columns = await sql<{
    table_name: string
    column_name: string
    data_type: string
    is_nullable: 'YES' | 'NO'
    column_default: string | null
  }>`
    SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY(${sql.val([...TABLES])}::text[])
     ORDER BY table_name, ordinal_position
  `.execute(db)
  for (const table of TABLES) {
    const actual = columns.rows
      .filter((row) => row.table_name === table)
      .map((row) => ({
        column: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable,
        default: row.column_default,
      }))
    if (JSON.stringify(actual) !== JSON.stringify(COLUMNS[table])) {
      throw new Error('elearning onboarding migration drift: columns')
    }
  }

  const constraints = await sql<{ conname: string; definition: string }>`
    SELECT constraint_row.conname,
           pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
     WHERE namespace_row.nspname = current_schema()
       AND table_row.relname = ANY(${sql.val([...TABLES])}::text[])
  `.execute(db)
  if (constraints.rows.length !== CONSTRAINTS.size) {
    throw new Error('elearning onboarding migration drift: constraint set')
  }
  for (const row of constraints.rows) {
    const expected = CONSTRAINTS.get(row.conname)
    if (!expected || normalizeDefinition(row.definition) !== normalizeDefinition(expected)) {
      throw new Error(`elearning onboarding migration drift: constraint definition:${row.conname}`)
    }
  }

  const indexes = await sql<{
    index_name: string
    table_name: string
    unique_index: boolean
    valid_index: boolean
    ready_index: boolean
    columns: string[]
    predicate: string | null
  }>`
    SELECT index_row.relname AS index_name,
           table_row.relname AS table_name,
           index_info.indisunique AS unique_index,
           index_info.indisvalid AS valid_index,
           index_info.indisready AS ready_index,
           array_agg(attribute_row.attname ORDER BY key_row.ordinality)::text[] AS columns,
           pg_get_expr(index_info.indpred, index_info.indrelid, true) AS predicate
      FROM pg_class index_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = index_row.relnamespace
      JOIN pg_index index_info ON index_info.indexrelid = index_row.oid
      JOIN pg_class table_row ON table_row.oid = index_info.indrelid
      JOIN LATERAL unnest(index_info.indkey) WITH ORDINALITY
        AS key_row(attnum, ordinality) ON key_row.attnum > 0
      JOIN pg_attribute attribute_row
        ON attribute_row.attrelid = table_row.oid
       AND attribute_row.attnum = key_row.attnum
     WHERE namespace_row.nspname = current_schema()
       AND index_row.relname = ANY(${sql.val([
         'idx_elearning_onboarding_policies_active',
         'idx_elearning_onboarding_assignment_effects_user',
         'idx_elearning_onboarding_weekly_reports_week',
       ])}::text[])
     GROUP BY index_row.relname, table_row.relname, index_info.indisunique,
              index_info.indisvalid, index_info.indisready,
              index_info.indpred, index_info.indrelid
  `.execute(db)
  const expectedIndexes = new Map<string, {
    table: string
    unique: boolean
    columns: string[]
    predicate: string | null
  }>([
    ['idx_elearning_onboarding_policies_active', {
      table: ELEARNING_ONBOARDING_POLICIES_TABLE,
      unique: false,
      columns: ['org_id', 'training_plan_id'],
      predicate: "status = 'active'::text",
    }],
    ['idx_elearning_onboarding_assignment_effects_user', {
      table: ELEARNING_ONBOARDING_ASSIGNMENT_EFFECTS_TABLE,
      unique: false,
      columns: ['org_id', 'user_id', 'created_at', 'id'],
      predicate: null,
    }],
    ['idx_elearning_onboarding_weekly_reports_week', {
      table: ELEARNING_ONBOARDING_WEEKLY_REPORTS_TABLE,
      unique: false,
      columns: ['org_id', 'week_start', 'id'],
      predicate: null,
    }],
  ])
  if (indexes.rows.length !== expectedIndexes.size || indexes.rows.some((row) => {
    const expected = expectedIndexes.get(row.index_name)
    return !expected
      || row.table_name !== expected.table
      || row.unique_index !== expected.unique
      || !row.valid_index
      || !row.ready_index
      || JSON.stringify(row.columns) !== JSON.stringify(expected.columns)
      || row.predicate !== expected.predicate
  })) {
    throw new Error('elearning onboarding migration drift: index definition')
  }

  const functions = await sql<{
    function_name: string
    source_digest: string
    language_name: string
    argument_types: string
    result_type: string
    function_kind: string
    volatility: string
    strict_function: boolean
    security_definer: boolean
  }>`
    SELECT function_row.proname AS function_name,
           md5(function_row.prosrc) AS source_digest,
           language_row.lanname AS language_name,
           oidvectortypes(function_row.proargtypes) AS argument_types,
           format_type(function_row.prorettype, NULL) AS result_type,
           function_row.prokind::text AS function_kind,
           function_row.provolatile::text AS volatility,
           function_row.proisstrict AS strict_function,
           function_row.prosecdef AS security_definer
      FROM pg_proc function_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
      JOIN pg_language language_row ON language_row.oid = function_row.prolang
     WHERE namespace_row.nspname = current_schema()
       AND function_row.proname = ANY(${sql.val([...FUNCTION_DIGESTS.keys()])}::text[])
  `.execute(db)
  if (functions.rows.length !== FUNCTION_DIGESTS.size || functions.rows.some((row) => {
    const matchRules = row.function_name === 'elearning_onboarding_match_rules_valid'
    return FUNCTION_DIGESTS.get(row.function_name) !== row.source_digest
      || row.language_name !== (matchRules ? 'sql' : 'plpgsql')
      || row.argument_types !== (matchRules ? 'jsonb' : '')
      || row.result_type !== (matchRules ? 'boolean' : 'trigger')
      || row.function_kind !== 'f'
      || row.volatility !== (matchRules ? 'i' : 'v')
      || row.strict_function !== matchRules
      || row.security_definer
  })) {
    throw new Error('elearning onboarding migration drift: function definition')
  }

  const triggers = await sql<{
    trigger_name: string
    table_name: string
    trigger_type: number
    enabled: string
    qualifier: unknown
    attributes: string
    function_name: string
    function_oid: string
    canonical_function_oid: string | null
  }>`
    SELECT trigger_row.tgname AS trigger_name,
           table_row.relname AS table_name,
           trigger_row.tgtype AS trigger_type,
           trigger_row.tgenabled AS enabled,
           trigger_row.tgqual AS qualifier,
           trigger_row.tgattr::text AS attributes,
           function_row.proname AS function_name,
           function_row.oid::text AS function_oid,
           to_regprocedure(format('%I.%I()', current_schema(), function_row.proname))::oid::text
             AS canonical_function_oid
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
     WHERE namespace_row.nspname = current_schema()
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgname = ANY(${sql.val([
         'trg_elearning_onboarding_policy_authority',
         'trg_elearning_onboarding_policy_truncate',
         'trg_elearning_onboarding_assignment_effect_authority',
         'trg_elearning_onboarding_assignment_effect_truncate',
         'trg_elearning_onboarding_weekly_report_immutable',
         'trg_elearning_onboarding_weekly_report_truncate',
       ])}::text[])
  `.execute(db)
  const expectedTriggers = new Map<string, { table: string; type: number; fn: string }>([
    ['trg_elearning_onboarding_policy_authority', {
      table: ELEARNING_ONBOARDING_POLICIES_TABLE,
      type: 27,
      fn: 'elearning_onboarding_policy_authority',
    }],
    ['trg_elearning_onboarding_policy_truncate', {
      table: ELEARNING_ONBOARDING_POLICIES_TABLE,
      type: 34,
      fn: 'elearning_onboarding_policy_authority',
    }],
    ['trg_elearning_onboarding_assignment_effect_authority', {
      table: ELEARNING_ONBOARDING_ASSIGNMENT_EFFECTS_TABLE,
      type: 31,
      fn: 'elearning_onboarding_assignment_effect_authority',
    }],
    ['trg_elearning_onboarding_assignment_effect_truncate', {
      table: ELEARNING_ONBOARDING_ASSIGNMENT_EFFECTS_TABLE,
      type: 34,
      fn: 'elearning_onboarding_assignment_effect_authority',
    }],
    ['trg_elearning_onboarding_weekly_report_immutable', {
      table: ELEARNING_ONBOARDING_WEEKLY_REPORTS_TABLE,
      type: 27,
      fn: 'elearning_onboarding_weekly_report_immutable',
    }],
    ['trg_elearning_onboarding_weekly_report_truncate', {
      table: ELEARNING_ONBOARDING_WEEKLY_REPORTS_TABLE,
      type: 34,
      fn: 'elearning_onboarding_weekly_report_immutable',
    }],
  ])
  if (triggers.rows.length !== expectedTriggers.size || triggers.rows.some((row) => {
    const expected = expectedTriggers.get(row.trigger_name)
    return !expected
      || row.table_name !== expected.table
      || row.trigger_type !== expected.type
      || row.enabled !== 'O'
      || row.qualifier !== null
      || row.attributes !== ''
      || row.function_name !== expected.fn
      || row.function_oid !== row.canonical_function_oid
  })) {
    throw new Error('elearning onboarding migration drift: trigger definition')
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await Promise.all(TABLES.map((table) => checkTableExists(db, table)))
  if (existing.some(Boolean)) {
    if (!existing.every(Boolean)) {
      throw new Error('elearning onboarding migration drift: partial table set')
    }
    await assertCanonical(db)
    return
  }

  const orphanedObjects = await sql<{ count: string }>`
    SELECT (
      (SELECT count(*) FROM pg_proc function_row
        JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = current_schema()
         AND function_row.proname = ANY(${sql.val([...FUNCTION_DIGESTS.keys()])}::text[]))
      +
      (SELECT count(*) FROM pg_class object_row
        JOIN pg_namespace namespace_row ON namespace_row.oid = object_row.relnamespace
       WHERE namespace_row.nspname = current_schema()
         AND object_row.relname = ANY(${sql.val([
           'idx_elearning_onboarding_policies_active',
           'idx_elearning_onboarding_assignment_effects_user',
           'idx_elearning_onboarding_weekly_reports_week',
         ])}::text[]))
    )::text AS count
  `.execute(db)
  if (orphanedObjects.rows[0]?.count !== '0') {
    throw new Error('elearning onboarding migration drift: orphaned object')
  }

  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`
    CREATE FUNCTION elearning_onboarding_match_rules_valid(rules jsonb)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $fn$${sql.raw(MATCH_RULES_BODY)}$fn$
  `.execute(db)

  await sql`
    CREATE TABLE elearning_onboarding_policies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      training_plan_id uuid NOT NULL,
      match_rules jsonb NOT NULL,
      hire_window_days integer NOT NULL,
      deadline_days integer NOT NULL,
      weekly_report_enabled boolean NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_by text NOT NULL,
      retired_at timestamptz,
      retired_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_onboarding_policies_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_onboarding_policies_request_uniq UNIQUE (org_id, request_id),
      CONSTRAINT elearning_onboarding_policies_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_onboarding_policies_request_chk
        CHECK (
          request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version = 1
        ),
      CONSTRAINT elearning_onboarding_policies_match_rules_chk
        CHECK (elearning_onboarding_match_rules_valid(match_rules)),
      CONSTRAINT elearning_onboarding_policies_window_chk
        CHECK (
          hire_window_days BETWEEN 0 AND 365
          AND deadline_days BETWEEN 0 AND 3650
        ),
      CONSTRAINT elearning_onboarding_policies_status_chk
        CHECK (status IN ('active', 'retired')),
      CONSTRAINT elearning_onboarding_policies_actor_chk
        CHECK (
          btrim(created_by) <> ''
          AND (retired_by IS NULL OR btrim(retired_by) <> '')
        ),
      CONSTRAINT elearning_onboarding_policies_lifecycle_chk
        CHECK (
          (
            status = 'active'
            AND retired_at IS NULL
            AND retired_by IS NULL
          )
          OR
          (
            status = 'retired'
            AND retired_at IS NOT NULL
            AND retired_by IS NOT NULL
            AND retired_at >= created_at
          )
        ),
      CONSTRAINT elearning_onboarding_policies_plan_fk
        FOREIGN KEY (org_id, training_plan_id)
        REFERENCES elearning_training_plans (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_onboarding_policies_created_by_fk
        FOREIGN KEY (created_by, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_onboarding_policies_retired_by_fk
        FOREIGN KEY (retired_by, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_onboarding_policy_authority()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$${sql.raw(POLICY_AUTHORITY_BODY)}$fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_onboarding_policy_authority
      BEFORE UPDATE OR DELETE ON elearning_onboarding_policies
      FOR EACH ROW EXECUTE FUNCTION elearning_onboarding_policy_authority()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_onboarding_policy_truncate
      BEFORE TRUNCATE ON elearning_onboarding_policies
      FOR EACH STATEMENT EXECUTE FUNCTION elearning_onboarding_policy_authority()
  `.execute(db)

  await sql`
    CREATE TABLE elearning_onboarding_assignment_effects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      policy_id uuid NOT NULL,
      user_id text NOT NULL,
      hire_date date NOT NULL,
      job_occurrence_key text NOT NULL,
      source_key text NOT NULL,
      training_plan_assignment_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_onboarding_assignment_effects_org_id_id_uniq
        UNIQUE (org_id, id),
      CONSTRAINT elearning_onboarding_assignment_effects_policy_user_uniq
        UNIQUE (org_id, policy_id, user_id),
      CONSTRAINT elearning_onboarding_assignment_effects_job_uniq
        UNIQUE (org_id, job_occurrence_key),
      CONSTRAINT elearning_onboarding_assignment_effects_source_uniq
        UNIQUE (org_id, source_key),
      CONSTRAINT elearning_onboarding_assignment_effects_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_onboarding_assignment_effects_text_chk
        CHECK (
          btrim(user_id) <> ''
          AND btrim(job_occurrence_key) <> ''
          AND char_length(job_occurrence_key) <= 512
          AND btrim(source_key) <> ''
          AND char_length(source_key) <= 512
        ),
      CONSTRAINT elearning_onboarding_assignment_effects_policy_fk
        FOREIGN KEY (org_id, policy_id)
        REFERENCES elearning_onboarding_policies (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_onboarding_assignment_effects_member_fk
        FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_onboarding_assignment_effects_assignment_fk
        FOREIGN KEY (org_id, training_plan_assignment_id)
        REFERENCES elearning_training_plan_assignments (org_id, id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_onboarding_assignment_effect_authority()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$${sql.raw(EFFECT_AUTHORITY_BODY)}$fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_onboarding_assignment_effect_authority
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_onboarding_assignment_effects
      FOR EACH ROW EXECUTE FUNCTION elearning_onboarding_assignment_effect_authority()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_onboarding_assignment_effect_truncate
      BEFORE TRUNCATE ON elearning_onboarding_assignment_effects
      FOR EACH STATEMENT EXECUTE FUNCTION elearning_onboarding_assignment_effect_authority()
  `.execute(db)

  await sql`
    CREATE TABLE elearning_onboarding_weekly_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      policy_id uuid NOT NULL,
      week_start date NOT NULL,
      week_end date NOT NULL,
      min_group_size integer NOT NULL,
      suppressed boolean NOT NULL,
      enqueued_count integer,
      assigned_user_count integer,
      failed_count integer,
      dead_count integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_onboarding_weekly_reports_org_id_id_uniq
        UNIQUE (org_id, id),
      CONSTRAINT elearning_onboarding_weekly_reports_policy_week_uniq
        UNIQUE (org_id, policy_id, week_start),
      CONSTRAINT elearning_onboarding_weekly_reports_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_onboarding_weekly_reports_week_chk
        CHECK (week_end = week_start + 7),
      CONSTRAINT elearning_onboarding_weekly_reports_suppression_chk
        CHECK (
          min_group_size >= 5
          AND (
            (
              suppressed
              AND enqueued_count IS NULL
              AND assigned_user_count IS NULL
              AND failed_count IS NULL
              AND dead_count IS NULL
            )
            OR
            (
              NOT suppressed
              AND enqueued_count IS NOT NULL
              AND assigned_user_count IS NOT NULL
              AND failed_count IS NOT NULL
              AND dead_count IS NOT NULL
              AND enqueued_count >= min_group_size
              AND assigned_user_count >= 0
              AND failed_count >= 0
              AND dead_count >= 0
              AND assigned_user_count <= enqueued_count
              AND failed_count + dead_count <= enqueued_count
            )
          )
        ),
      CONSTRAINT elearning_onboarding_weekly_reports_policy_fk
        FOREIGN KEY (org_id, policy_id)
        REFERENCES elearning_onboarding_policies (org_id, id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_onboarding_weekly_report_immutable()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$${sql.raw(REPORT_IMMUTABLE_BODY)}$fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_onboarding_weekly_report_immutable
      BEFORE UPDATE OR DELETE ON elearning_onboarding_weekly_reports
      FOR EACH ROW EXECUTE FUNCTION elearning_onboarding_weekly_report_immutable()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_onboarding_weekly_report_truncate
      BEFORE TRUNCATE ON elearning_onboarding_weekly_reports
      FOR EACH STATEMENT EXECUTE FUNCTION elearning_onboarding_weekly_report_immutable()
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_onboarding_policies_active
      ON elearning_onboarding_policies (org_id, training_plan_id)
      WHERE status = 'active'
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_onboarding_assignment_effects_user
      ON elearning_onboarding_assignment_effects (org_id, user_id, created_at, id)
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_onboarding_weekly_reports_week
      ON elearning_onboarding_weekly_reports (org_id, week_start, id)
  `.execute(db)

  await assertCanonical(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const existing = await Promise.all(TABLES.map((table) => checkTableExists(db, table)))
  if (!existing.some(Boolean)) return
  if (!existing.every(Boolean)) {
    throw new Error('elearning onboarding migration drift: partial table set')
  }

  const rows = await sql<{ occupied: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM elearning_onboarding_policies
      UNION ALL
      SELECT 1 FROM elearning_onboarding_assignment_effects
      UNION ALL
      SELECT 1 FROM elearning_onboarding_weekly_reports
    ) AS occupied
  `.execute(db)
  if (rows.rows[0]?.occupied) throw new Error(ELEARNING_ONBOARDING_DOWN_IN_USE)

  await sql`DROP TRIGGER trg_elearning_onboarding_weekly_report_truncate ON elearning_onboarding_weekly_reports`.execute(db)
  await sql`DROP TRIGGER trg_elearning_onboarding_weekly_report_immutable ON elearning_onboarding_weekly_reports`.execute(db)
  await sql`DROP TRIGGER trg_elearning_onboarding_assignment_effect_truncate ON elearning_onboarding_assignment_effects`.execute(db)
  await sql`DROP TRIGGER trg_elearning_onboarding_assignment_effect_authority ON elearning_onboarding_assignment_effects`.execute(db)
  await sql`DROP TRIGGER trg_elearning_onboarding_policy_truncate ON elearning_onboarding_policies`.execute(db)
  await sql`DROP TRIGGER trg_elearning_onboarding_policy_authority ON elearning_onboarding_policies`.execute(db)
  await sql`DROP TABLE elearning_onboarding_weekly_reports`.execute(db)
  await sql`DROP TABLE elearning_onboarding_assignment_effects`.execute(db)
  await sql`DROP TABLE elearning_onboarding_policies`.execute(db)
  await sql`DROP FUNCTION elearning_onboarding_weekly_report_immutable()`.execute(db)
  await sql`DROP FUNCTION elearning_onboarding_assignment_effect_authority()`.execute(db)
  await sql`DROP FUNCTION elearning_onboarding_policy_authority()`.execute(db)
  await sql`DROP FUNCTION elearning_onboarding_match_rules_valid(jsonb)`.execute(db)
}
