import { sql, type Kysely } from 'kysely'

export const ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE =
  'elearning_watch_challenge_schedules' as const
export const ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE =
  'elearning_watch_challenge_events' as const
export const ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE =
  'elearning_watch_challenge_requests' as const

const TABLES = [
  ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
  ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE,
  ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE,
] as const

const ITEM_COLUMNS = new Map([
  ['watch_challenge_policy_revision', 'text:YES'],
  ['watch_challenge_count', 'smallint:YES'],
  ['watch_challenge_min_duration_ms', 'bigint:YES'],
  ['watch_challenge_response_window_ms', 'bigint:YES'],
])

const EXPECTED_COLUMNS = new Map<string, Map<string, string>>([
  [ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE, new Map([
    ['id', 'uuid:NO'], ['org_id', 'text:NO'], ['session_id', 'uuid:NO'],
    ['course_version_id', 'uuid:NO'],
    ['course_version_item_id', 'uuid:NO'], ['user_id', 'text:NO'], ['mode', 'text:NO'],
    ['policy_revision', 'text:NO'], ['response_window_ms', 'bigint:NO'],
    ['video_duration_ms', 'bigint:NO'], ['checkpoints', 'jsonb:NO'],
    ['issued_count', 'smallint:NO'], ['status', 'text:NO'],
    ['active_challenge_id', 'uuid:YES'], ['active_ordinal', 'smallint:YES'],
    ['active_issued_at', 'timestamp with time zone:YES'],
    ['active_deadline_at', 'timestamp with time zone:YES'],
    ['challenge_base_max_position_ms', 'bigint:YES'], ['provisional_ms', 'bigint:NO'],
    ['created_at', 'timestamp with time zone:NO'], ['updated_at', 'timestamp with time zone:NO'],
  ])],
  [ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE, new Map([
    ['id', 'uuid:NO'], ['org_id', 'text:NO'], ['schedule_id', 'uuid:NO'],
    ['session_id', 'uuid:NO'], ['course_version_id', 'uuid:NO'],
    ['course_version_item_id', 'uuid:NO'], ['user_id', 'text:NO'],
    ['challenge_id', 'uuid:NO'], ['ordinal', 'smallint:NO'], ['kind', 'text:NO'],
    ['policy_revision', 'text:NO'], ['credited_ms', 'bigint:NO'],
    ['discarded_ms', 'bigint:NO'], ['prompt_version', 'text:YES'],
    ['prompt_option_ids', 'ARRAY:YES'], ['prompt_option_labels', 'ARRAY:YES'],
    ['expected_selection', 'ARRAY:YES'], ['occurred_at', 'timestamp with time zone:NO'],
  ])],
  [ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE, new Map([
    ['id', 'uuid:NO'], ['org_id', 'text:NO'], ['user_id', 'text:NO'],
    ['request_id', 'uuid:NO'], ['request_hash', 'text:NO'],
    ['request_hash_version', 'integer:NO'], ['schedule_id', 'uuid:NO'],
    ['session_id', 'uuid:NO'], ['course_version_id', 'uuid:NO'],
    ['course_version_item_id', 'uuid:NO'],
    ['challenge_id', 'uuid:NO'], ['result', 'jsonb:YES'],
    ['created_at', 'timestamp with time zone:NO'],
  ])],
])

const EXPECTED_CONSTRAINTS = new Map<string, { table: string; definition: string }>([
  ['elearning_course_version_items_watch_challenge_chk', {
    table: 'elearning_course_version_items',
    definition: "CHECK (watch_challenge_policy_revision IS NULL AND watch_challenge_count IS NULL AND watch_challenge_min_duration_ms IS NULL AND watch_challenge_response_window_ms IS NULL OR item_type = 'video'::text AND watch_challenge_policy_revision IS NOT NULL AND btrim(watch_challenge_policy_revision) <> ''::text AND watch_challenge_count >= 1 AND watch_challenge_count <= 10 AND watch_challenge_min_duration_ms > 0 AND watch_challenge_response_window_ms >= 1 AND watch_challenge_response_window_ms <= 120000)",
  }],
  ['elearning_watch_challenge_events_kind_chk', {
    table: ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE,
    definition: "CHECK ((kind = ANY (ARRAY['issue'::text, 'ack'::text, 'timeout'::text])) AND ordinal >= 1 AND ordinal <= 10 AND credited_ms >= 0 AND discarded_ms >= 0)",
  }],
  ['elearning_watch_challenge_events_prompt_chk', {
    table: ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE,
    definition: "CHECK (kind = 'issue'::text AND prompt_version = 'raster-position-v2'::text AND prompt_option_ids IS NOT NULL AND cardinality(prompt_option_ids) = 6 AND array_position(prompt_option_ids, NULL::uuid) IS NULL AND (prompt_option_ids[1] <> ALL (prompt_option_ids[2:6])) AND (prompt_option_ids[2] <> ALL (prompt_option_ids[3:6])) AND (prompt_option_ids[3] <> ALL (prompt_option_ids[4:6])) AND (prompt_option_ids[4] <> ALL (prompt_option_ids[5:6])) AND prompt_option_ids[5] <> prompt_option_ids[6] AND prompt_option_labels IS NOT NULL AND cardinality(prompt_option_labels) = 6 AND array_position(prompt_option_labels, NULL::text) IS NULL AND btrim(prompt_option_labels[1]) <> ''::text AND btrim(prompt_option_labels[2]) <> ''::text AND btrim(prompt_option_labels[3]) <> ''::text AND btrim(prompt_option_labels[4]) <> ''::text AND btrim(prompt_option_labels[5]) <> ''::text AND btrim(prompt_option_labels[6]) <> ''::text AND (prompt_option_labels[1] <> ALL (prompt_option_labels[2:6])) AND (prompt_option_labels[2] <> ALL (prompt_option_labels[3:6])) AND (prompt_option_labels[3] <> ALL (prompt_option_labels[4:6])) AND (prompt_option_labels[4] <> ALL (prompt_option_labels[5:6])) AND prompt_option_labels[5] <> prompt_option_labels[6] AND expected_selection IS NOT NULL AND cardinality(expected_selection) = 2 AND array_position(expected_selection, NULL::uuid) IS NULL AND expected_selection[1] <> expected_selection[2] AND expected_selection <@ prompt_option_ids OR kind <> 'issue'::text AND prompt_version IS NULL AND prompt_option_ids IS NULL AND prompt_option_labels IS NULL AND expected_selection IS NULL)",
  }],
  ['elearning_watch_challenge_events_kind_uniq', {
    table: ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE,
    definition: 'UNIQUE (org_id, schedule_id, challenge_id, kind)',
  }],
  ['elearning_watch_challenge_events_pkey', {
    table: ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE,
    definition: 'PRIMARY KEY (id)',
  }],
  ['elearning_watch_challenge_events_schedule_fk', {
    table: ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE,
    definition: 'FOREIGN KEY (org_id, schedule_id, session_id, course_version_id, course_version_item_id, user_id) REFERENCES elearning_watch_challenge_schedules(org_id, id, session_id, course_version_id, course_version_item_id, user_id) ON DELETE RESTRICT',
  }],
  ['elearning_watch_challenge_requests_hash_chk', {
    table: ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE,
    definition: "CHECK (request_hash ~ '^[0-9a-f]{64}$'::text AND request_hash_version = 2 AND (result IS NULL OR jsonb_typeof(result) = 'object'::text))",
  }],
  ['elearning_watch_challenge_requests_pkey', {
    table: ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE,
    definition: 'PRIMARY KEY (id)',
  }],
  ['elearning_watch_challenge_requests_request_uniq', {
    table: ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE,
    definition: 'UNIQUE (org_id, user_id, request_id)',
  }],
  ['elearning_watch_challenge_requests_schedule_fk', {
    table: ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE,
    definition: 'FOREIGN KEY (org_id, schedule_id, session_id, course_version_id, course_version_item_id, user_id) REFERENCES elearning_watch_challenge_schedules(org_id, id, session_id, course_version_id, course_version_item_id, user_id) ON DELETE RESTRICT',
  }],
  ['elearning_watch_challenge_schedules_active_shape_chk', {
    table: ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
    definition: "CHECK ((status = ANY (ARRAY['watching'::text, 'completed'::text])) AND active_challenge_id IS NULL AND active_ordinal IS NULL AND active_issued_at IS NULL AND active_deadline_at IS NULL AND challenge_base_max_position_ms IS NULL AND provisional_ms = 0 OR (status = ANY (ARRAY['challenged'::text, 'paused'::text])) AND active_challenge_id IS NOT NULL AND active_ordinal >= 1 AND active_ordinal <= 10 AND active_issued_at IS NOT NULL AND active_deadline_at > active_issued_at AND challenge_base_max_position_ms >= 0 AND provisional_ms >= 0)",
  }],
  ['elearning_watch_challenge_schedules_item_fk', {
    table: ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
    definition: 'FOREIGN KEY (org_id, course_version_item_id) REFERENCES elearning_course_version_items(org_id, id) ON DELETE RESTRICT',
  }],
  ['elearning_watch_challenge_schedules_org_id_id_uniq', {
    table: ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
    definition: 'UNIQUE (org_id, id)',
  }],
  ['elearning_watch_challenge_schedules_identity_uniq', {
    table: ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
    definition: 'UNIQUE (org_id, id, session_id, course_version_id, course_version_item_id, user_id)',
  }],
  ['elearning_watch_challenge_schedules_pkey', {
    table: ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
    definition: 'PRIMARY KEY (id)',
  }],
  ['elearning_watch_challenge_schedules_session_fk', {
    table: ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
    definition: 'FOREIGN KEY (org_id, session_id, course_version_id, course_version_item_id, user_id) REFERENCES elearning_learning_sessions(org_id, id, course_version_id, course_version_item_id, user_id) ON DELETE RESTRICT',
  }],
  ['elearning_watch_challenge_schedules_session_uniq', {
    table: ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
    definition: 'UNIQUE (org_id, session_id)',
  }],
  ['elearning_watch_challenge_schedules_snapshot_chk', {
    table: ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
    definition: "CHECK ((mode = ANY (ARRAY['disabled'::text, 'scheduled'::text, 'short_video_exempt'::text])) AND btrim(org_id) <> ''::text AND org_id = btrim(org_id) AND btrim(user_id) <> ''::text AND user_id = btrim(user_id) AND btrim(policy_revision) <> ''::text AND policy_revision = btrim(policy_revision) AND response_window_ms >= 1 AND response_window_ms <= 120000 AND video_duration_ms > 0 AND jsonb_typeof(checkpoints) = 'array'::text AND issued_count >= 0 AND issued_count <= 10 AND provisional_ms >= 0)",
  }],
])

const EXPECTED_DEFAULTS = new Map<string, string>([
  [`${ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE}.occurred_at`, 'now()'],
  [`${ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE}.created_at`, 'now()'],
  [`${ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE}.issued_count`, '0'],
  [`${ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE}.status`, "'watching'::text"],
  [`${ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE}.provisional_ms`, '0'],
  [`${ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE}.created_at`, 'now()'],
  [`${ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE}.updated_at`, 'now()'],
])

const EXPECTED_FUNCTION_DIGESTS = new Map<string, string>([
  ['elearning_watch_challenge_deny_mutation', 'c744df6580a005e5d2656687e09398ea'],
  ['elearning_watch_challenge_schedule_authority', 'de589898ab2790a3ffc870f8642036d8'],
])

async function tableExists(db: Kysely<unknown>, table: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT to_regclass(current_schema() || '.' || ${table}) IS NOT NULL AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

async function columnsOf(
  db: Kysely<unknown>,
  table: string,
  names?: readonly string[],
): Promise<Map<string, string>> {
  const result = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ${table}
       ${names ? sql`AND column_name = ANY(${sql.val(names)}::text[])` : sql``}
     ORDER BY ordinal_position
  `.execute(db)
  return new Map(result.rows.map((row) => [
    row.column_name,
    `${row.data_type}:${row.is_nullable}`,
  ]))
}

function equalMaps(actual: Map<string, string>, expected: Map<string, string>): boolean {
  return actual.size === expected.size
    && [...expected].every(([name, shape]) => actual.get(name) === shape)
}

async function assertCanonical(db: Kysely<unknown>): Promise<void> {
  const itemColumns = await columnsOf(db, 'elearning_course_version_items', [...ITEM_COLUMNS.keys()])
  if (!equalMaps(itemColumns, ITEM_COLUMNS)) {
    throw new Error('elearning watch challenge migration drift: item columns')
  }
  const itemDefaults = await sql<{ column_name: string }>`
    SELECT attribute.attname AS column_name
      FROM pg_attrdef default_row
      JOIN pg_attribute attribute
        ON attribute.attrelid = default_row.adrelid
       AND attribute.attnum = default_row.adnum
      JOIN pg_class table_row ON table_row.oid = default_row.adrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
     WHERE namespace_row.nspname = current_schema()
       AND table_row.relname = 'elearning_course_version_items'
       AND attribute.attname = ANY(${sql.val([...ITEM_COLUMNS.keys()])}::text[])
  `.execute(db)
  if (itemDefaults.rows.length !== 0) {
    throw new Error('elearning watch challenge migration drift: item defaults')
  }
  for (const [table, expected] of EXPECTED_COLUMNS) {
    const actual = await columnsOf(db, table)
    if (!equalMaps(actual, expected)) {
      throw new Error('elearning watch challenge migration drift: table columns')
    }
  }

  const constraints = await sql<{
    table_name: string
    conname: string
    validated: boolean
    definition: string
  }>`
    SELECT table_row.relname AS table_name, constraint_row.conname,
           constraint_row.convalidated AS validated,
           pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
     WHERE namespace_row.nspname = current_schema()
       AND (
         (table_row.relname = 'elearning_course_version_items'
           AND constraint_row.conname = 'elearning_course_version_items_watch_challenge_chk')
         OR table_row.relname = ANY(${sql.val(TABLES)}::text[])
       )
       AND constraint_row.conname = ANY(${sql.val([...EXPECTED_CONSTRAINTS.keys()])}::text[])
     ORDER BY table_row.relname, constraint_row.conname
  `.execute(db)
  if (
    constraints.rows.length !== EXPECTED_CONSTRAINTS.size
    || constraints.rows.some((row) => {
      const expected = EXPECTED_CONSTRAINTS.get(row.conname)
      return !expected || row.table_name !== expected.table || !row.validated
        || row.definition !== expected.definition
    })
  ) throw new Error('elearning watch challenge migration drift: constraints')

  const defaults = await sql<{ table_name: string; column_name: string; expression: string }>`
    SELECT table_row.relname AS table_name, attribute.attname AS column_name,
           pg_get_expr(default_row.adbin, default_row.adrelid) AS expression
      FROM pg_attrdef default_row
      JOIN pg_attribute attribute
        ON attribute.attrelid = default_row.adrelid
       AND attribute.attnum = default_row.adnum
      JOIN pg_class table_row ON table_row.oid = default_row.adrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
     WHERE namespace_row.nspname = current_schema()
       AND table_row.relname = ANY(${sql.val(TABLES)}::text[])
  `.execute(db)
  if (
    defaults.rows.length !== EXPECTED_DEFAULTS.size
    || defaults.rows.some((row) => (
      EXPECTED_DEFAULTS.get(`${row.table_name}.${row.column_name}`) !== row.expression
    ))
  ) throw new Error('elearning watch challenge migration drift: defaults')

  const functions = await sql<{
    function_name: string
    source_digest: string
    language: string
    result_type: string
    security_definer: boolean
    argument_count: number
  }>`
    SELECT proc.proname AS function_name, md5(proc.prosrc) AS source_digest,
           language_row.lanname AS language, proc.prorettype::regtype::text AS result_type,
           proc.prosecdef AS security_definer, proc.pronargs AS argument_count
      FROM pg_proc proc
      JOIN pg_namespace namespace_row ON namespace_row.oid = proc.pronamespace
      JOIN pg_language language_row ON language_row.oid = proc.prolang
     WHERE namespace_row.nspname = current_schema()
       AND proc.proname = ANY(${sql.val([...EXPECTED_FUNCTION_DIGESTS.keys()])}::text[])
  `.execute(db)
  if (
    functions.rows.length !== EXPECTED_FUNCTION_DIGESTS.size
    || functions.rows.some((row) => (
      EXPECTED_FUNCTION_DIGESTS.get(row.function_name) !== row.source_digest
      || row.language !== 'plpgsql'
      || row.result_type !== 'trigger'
      || row.security_definer
      || row.argument_count !== 0
    ))
  ) throw new Error('elearning watch challenge migration drift: functions')

  const triggers = await sql<{
    table_name: string
    trigger_name: string
    tgtype: number
    enabled: string
    qualifier: unknown
    attributes: string
    function_oid: string
    canonical_oid: string | null
  }>`
    SELECT table_row.relname AS table_name, trigger_row.tgname AS trigger_name,
           trigger_row.tgtype, trigger_row.tgenabled AS enabled,
           trigger_row.tgqual AS qualifier, trigger_row.tgattr::text AS attributes,
           trigger_row.tgfoid::text AS function_oid,
           CASE WHEN table_row.relname = 'elearning_watch_challenge_schedules'
             THEN to_regprocedure(format('%I.elearning_watch_challenge_schedule_authority()', current_schema()))::oid::text
             ELSE to_regprocedure(format('%I.elearning_watch_challenge_deny_mutation()', current_schema()))::oid::text
           END AS canonical_oid
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
     WHERE namespace_row.nspname = current_schema()
       AND table_row.relname = ANY(${sql.val([
         ELEARNING_WATCH_CHALLENGE_SCHEDULES_TABLE,
         ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE,
         ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE,
       ])}::text[])
       AND NOT trigger_row.tgisinternal
     ORDER BY table_row.relname, trigger_row.tgname
  `.execute(db)
  if (
    triggers.rows.length !== 6
    || triggers.rows.some((row) => (
      ![
        'trg_elearning_watch_challenge_schedules_authority',
        'trg_elearning_watch_challenge_schedules_deny_truncate',
        'trg_elearning_watch_challenge_events_deny_mutation',
        'trg_elearning_watch_challenge_events_deny_truncate',
        'trg_elearning_watch_challenge_requests_deny_mutation',
        'trg_elearning_watch_challenge_requests_deny_truncate',
      ].includes(row.trigger_name)
      || (row.trigger_name.endsWith('truncate') ? row.tgtype !== 34 : row.tgtype !== 27)
      || row.enabled !== 'O'
      || row.qualifier !== null
      || row.attributes !== ''
      || row.function_oid !== row.canonical_oid
    ))
  ) throw new Error('elearning watch challenge migration drift: triggers')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await Promise.all(TABLES.map((table) => tableExists(db, table)))
  if (existing.some(Boolean)) {
    if (!existing.every(Boolean)) {
      throw new Error('elearning watch challenge migration drift: partial tables')
    }
    await assertCanonical(db)
    return
  }
  const partialItemColumns = await columnsOf(
    db,
    'elearning_course_version_items',
    [...ITEM_COLUMNS.keys()],
  )
  if (partialItemColumns.size !== 0) {
    throw new Error('elearning watch challenge migration drift: partial item columns')
  }

  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`
    ALTER TABLE elearning_course_version_items
      ADD COLUMN watch_challenge_policy_revision text,
      ADD COLUMN watch_challenge_count smallint,
      ADD COLUMN watch_challenge_min_duration_ms bigint,
      ADD COLUMN watch_challenge_response_window_ms bigint,
      ADD CONSTRAINT elearning_course_version_items_watch_challenge_chk CHECK (
        (
          watch_challenge_policy_revision IS NULL
          AND watch_challenge_count IS NULL
          AND watch_challenge_min_duration_ms IS NULL
          AND watch_challenge_response_window_ms IS NULL
        )
        OR (
          item_type = 'video'
          AND watch_challenge_policy_revision IS NOT NULL
          AND btrim(watch_challenge_policy_revision) <> ''
          AND watch_challenge_count BETWEEN 1 AND 10
          AND watch_challenge_min_duration_ms > 0
          AND watch_challenge_response_window_ms BETWEEN 1 AND 120000
        )
      )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_watch_challenge_schedules (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      session_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      user_id text NOT NULL,
      mode text NOT NULL,
      policy_revision text NOT NULL,
      response_window_ms bigint NOT NULL,
      video_duration_ms bigint NOT NULL,
      checkpoints jsonb NOT NULL,
      issued_count smallint NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'watching',
      active_challenge_id uuid,
      active_ordinal smallint,
      active_issued_at timestamptz,
      active_deadline_at timestamptz,
      challenge_base_max_position_ms bigint,
      provisional_ms bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_watch_challenge_schedules_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_watch_challenge_schedules_identity_uniq
        UNIQUE (org_id, id, session_id, course_version_id, course_version_item_id, user_id),
      CONSTRAINT elearning_watch_challenge_schedules_session_uniq UNIQUE (org_id, session_id),
      CONSTRAINT elearning_watch_challenge_schedules_snapshot_chk CHECK (
        mode IN ('disabled', 'scheduled', 'short_video_exempt')
        AND btrim(org_id) <> '' AND org_id = btrim(org_id)
        AND btrim(user_id) <> '' AND user_id = btrim(user_id)
        AND btrim(policy_revision) <> '' AND policy_revision = btrim(policy_revision)
        AND response_window_ms BETWEEN 1 AND 120000
        AND video_duration_ms > 0
        AND jsonb_typeof(checkpoints) = 'array'
        AND issued_count BETWEEN 0 AND 10
        AND provisional_ms >= 0
      ),
      CONSTRAINT elearning_watch_challenge_schedules_active_shape_chk CHECK (
        (
          status IN ('watching', 'completed')
          AND active_challenge_id IS NULL AND active_ordinal IS NULL
          AND active_issued_at IS NULL AND active_deadline_at IS NULL
          AND challenge_base_max_position_ms IS NULL AND provisional_ms = 0
        )
        OR (
          status IN ('challenged', 'paused')
          AND active_challenge_id IS NOT NULL AND active_ordinal BETWEEN 1 AND 10
          AND active_issued_at IS NOT NULL AND active_deadline_at > active_issued_at
          AND challenge_base_max_position_ms >= 0 AND provisional_ms >= 0
        )
      ),
      CONSTRAINT elearning_watch_challenge_schedules_session_fk
        FOREIGN KEY (
          org_id, session_id, course_version_id, course_version_item_id, user_id
        ) REFERENCES elearning_learning_sessions (
          org_id, id, course_version_id, course_version_item_id, user_id
        ) ON DELETE RESTRICT,
      CONSTRAINT elearning_watch_challenge_schedules_item_fk
        FOREIGN KEY (org_id, course_version_item_id)
        REFERENCES elearning_course_version_items (org_id, id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_watch_challenge_events (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      schedule_id uuid NOT NULL,
      session_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      user_id text NOT NULL,
      challenge_id uuid NOT NULL,
      ordinal smallint NOT NULL,
      kind text NOT NULL,
      policy_revision text NOT NULL,
      credited_ms bigint NOT NULL,
      discarded_ms bigint NOT NULL,
      prompt_version text,
      prompt_option_ids uuid[],
      prompt_option_labels text[],
      expected_selection uuid[],
      occurred_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_watch_challenge_events_kind_uniq
        UNIQUE (org_id, schedule_id, challenge_id, kind),
      CONSTRAINT elearning_watch_challenge_events_kind_chk CHECK (
        kind IN ('issue', 'ack', 'timeout')
        AND ordinal BETWEEN 1 AND 10
        AND credited_ms >= 0 AND discarded_ms >= 0
      ),
      CONSTRAINT elearning_watch_challenge_events_prompt_chk CHECK (
        (
          kind = 'issue'
          AND prompt_version = 'raster-position-v2'
          AND prompt_option_ids IS NOT NULL AND cardinality(prompt_option_ids) = 6
          AND array_position(prompt_option_ids, NULL) IS NULL
          AND prompt_option_ids[1] <> ALL(prompt_option_ids[2:6])
          AND prompt_option_ids[2] <> ALL(prompt_option_ids[3:6])
          AND prompt_option_ids[3] <> ALL(prompt_option_ids[4:6])
          AND prompt_option_ids[4] <> ALL(prompt_option_ids[5:6])
          AND prompt_option_ids[5] <> prompt_option_ids[6]
          AND prompt_option_labels IS NOT NULL AND cardinality(prompt_option_labels) = 6
          AND array_position(prompt_option_labels, NULL) IS NULL
          AND btrim(prompt_option_labels[1]) <> ''
          AND btrim(prompt_option_labels[2]) <> ''
          AND btrim(prompt_option_labels[3]) <> ''
          AND btrim(prompt_option_labels[4]) <> ''
          AND btrim(prompt_option_labels[5]) <> ''
          AND btrim(prompt_option_labels[6]) <> ''
          AND prompt_option_labels[1] <> ALL(prompt_option_labels[2:6])
          AND prompt_option_labels[2] <> ALL(prompt_option_labels[3:6])
          AND prompt_option_labels[3] <> ALL(prompt_option_labels[4:6])
          AND prompt_option_labels[4] <> ALL(prompt_option_labels[5:6])
          AND prompt_option_labels[5] <> prompt_option_labels[6]
          AND expected_selection IS NOT NULL AND cardinality(expected_selection) = 2
          AND array_position(expected_selection, NULL) IS NULL
          AND expected_selection[1] <> expected_selection[2]
          AND expected_selection <@ prompt_option_ids
        )
        OR (
          kind <> 'issue'
          AND prompt_version IS NULL
          AND prompt_option_ids IS NULL
          AND prompt_option_labels IS NULL
          AND expected_selection IS NULL
        )
      ),
      CONSTRAINT elearning_watch_challenge_events_schedule_fk
        FOREIGN KEY (
          org_id, schedule_id, session_id, course_version_id, course_version_item_id, user_id
        ) REFERENCES elearning_watch_challenge_schedules (
          org_id, id, session_id, course_version_id, course_version_item_id, user_id
        ) ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_watch_challenge_requests (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      schedule_id uuid NOT NULL,
      session_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      challenge_id uuid NOT NULL,
      result jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_watch_challenge_requests_request_uniq
        UNIQUE (org_id, user_id, request_id),
      CONSTRAINT elearning_watch_challenge_requests_hash_chk CHECK (
        request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version = 2
        AND (result IS NULL OR jsonb_typeof(result) = 'object')
      ),
      CONSTRAINT elearning_watch_challenge_requests_schedule_fk
        FOREIGN KEY (
          org_id, schedule_id, session_id, course_version_id, course_version_item_id, user_id
        ) REFERENCES elearning_watch_challenge_schedules (
          org_id, id, session_id, course_version_id, course_version_item_id, user_id
        ) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_watch_challenge_schedule_authority()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'elearning watch challenge schedule cannot be removed';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.session_id IS DISTINCT FROM OLD.session_id
         OR NEW.course_version_id IS DISTINCT FROM OLD.course_version_id
         OR NEW.course_version_item_id IS DISTINCT FROM OLD.course_version_item_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.mode IS DISTINCT FROM OLD.mode
         OR NEW.policy_revision IS DISTINCT FROM OLD.policy_revision
         OR NEW.response_window_ms IS DISTINCT FROM OLD.response_window_ms
         OR NEW.video_duration_ms IS DISTINCT FROM OLD.video_duration_ms
         OR NEW.checkpoints IS DISTINCT FROM OLD.checkpoints
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.issued_count < OLD.issued_count THEN
        RAISE EXCEPTION 'elearning watch challenge snapshot is immutable';
      END IF;
      RETURN NEW;
    END
    $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_watch_challenge_schedules_authority
      BEFORE UPDATE OR DELETE ON elearning_watch_challenge_schedules
      FOR EACH ROW EXECUTE FUNCTION elearning_watch_challenge_schedule_authority()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_watch_challenge_schedules_deny_truncate
      BEFORE TRUNCATE ON elearning_watch_challenge_schedules
      FOR EACH STATEMENT EXECUTE FUNCTION elearning_watch_challenge_schedule_authority()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_watch_challenge_deny_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'elearning watch challenge ledger is append-only';
    END
    $fn$
  `.execute(db)
  for (const table of [
    ELEARNING_WATCH_CHALLENGE_EVENTS_TABLE,
    ELEARNING_WATCH_CHALLENGE_REQUESTS_TABLE,
  ]) {
    await sql.raw(`
      CREATE TRIGGER trg_${table}_deny_mutation
        BEFORE UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION elearning_watch_challenge_deny_mutation()
    `).execute(db)
    await sql.raw(`
      CREATE TRIGGER trg_${table}_deny_truncate
        BEFORE TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION elearning_watch_challenge_deny_mutation()
    `).execute(db)
  }
  await assertCanonical(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const existing = await Promise.all(TABLES.map((table) => tableExists(db, table)))
  if (!existing.some(Boolean)) return
  if (!existing.every(Boolean)) {
    throw new Error('elearning watch challenge down refused: partial authority')
  }
  const counts = await sql<{ schedules: string; events: string; requests: string }>`
    SELECT
      (SELECT count(*)::text FROM elearning_watch_challenge_schedules) AS schedules,
      (SELECT count(*)::text FROM elearning_watch_challenge_events) AS events,
      (SELECT count(*)::text FROM elearning_watch_challenge_requests) AS requests
  `.execute(db)
  const row = counts.rows[0]
  if (!row || row.schedules !== '0' || row.events !== '0' || row.requests !== '0') {
    throw new Error('elearning watch challenge down refused: authoritative rows exist')
  }
  await sql`DROP TABLE elearning_watch_challenge_requests`.execute(db)
  await sql`DROP TABLE elearning_watch_challenge_events`.execute(db)
  await sql`DROP TABLE elearning_watch_challenge_schedules`.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_watch_challenge_schedule_authority()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_watch_challenge_deny_mutation()`.execute(db)
  await sql`
    ALTER TABLE elearning_course_version_items
      DROP CONSTRAINT elearning_course_version_items_watch_challenge_chk,
      DROP COLUMN watch_challenge_response_window_ms,
      DROP COLUMN watch_challenge_min_duration_ms,
      DROP COLUMN watch_challenge_count,
      DROP COLUMN watch_challenge_policy_revision
  `.execute(db)
}
