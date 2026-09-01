import { sql, type Kysely } from 'kysely'

const EVENTS = 'elearning_offline_registration_events'
const REQUESTS = 'elearning_offline_registration_requests'
const REJECT_CHANGE_BODY = `
BEGIN
  RAISE EXCEPTION 'elearning offline authoritative row is immutable' USING ERRCODE = '23514';
END
`

const EXPECTED_COLUMNS = new Map<string, readonly string[]>([
  [EVENTS, [
    'id', 'org_id', 'training_id', 'revision_id', 'user_id', 'actor_id',
    'sequence', 'action', 'changed_at',
  ]],
  [REQUESTS, [
    'org_id', 'user_id', 'request_id', 'request_hash', 'request_hash_version',
    'event_id', 'created_at',
  ]],
])

const EXPECTED_COLUMN_AUTHORITY = new Map<string, {
  dataType: string
  nullable: 'NO' | 'YES'
  defaultValue: string | null
}>([
  [`${EVENTS}.id`, { dataType: 'uuid', nullable: 'NO', defaultValue: null }],
  [`${EVENTS}.org_id`, { dataType: 'text', nullable: 'NO', defaultValue: null }],
  [`${EVENTS}.training_id`, { dataType: 'uuid', nullable: 'NO', defaultValue: null }],
  [`${EVENTS}.revision_id`, { dataType: 'uuid', nullable: 'NO', defaultValue: null }],
  [`${EVENTS}.user_id`, { dataType: 'text', nullable: 'NO', defaultValue: null }],
  [`${EVENTS}.actor_id`, { dataType: 'text', nullable: 'NO', defaultValue: null }],
  [`${EVENTS}.sequence`, { dataType: 'integer', nullable: 'NO', defaultValue: null }],
  [`${EVENTS}.action`, { dataType: 'text', nullable: 'NO', defaultValue: null }],
  [`${EVENTS}.changed_at`, {
    dataType: 'timestamp with time zone',
    nullable: 'NO',
    defaultValue: 'transaction_timestamp()',
  }],
  [`${REQUESTS}.org_id`, { dataType: 'text', nullable: 'NO', defaultValue: null }],
  [`${REQUESTS}.user_id`, { dataType: 'text', nullable: 'NO', defaultValue: null }],
  [`${REQUESTS}.request_id`, { dataType: 'uuid', nullable: 'NO', defaultValue: null }],
  [`${REQUESTS}.request_hash`, { dataType: 'text', nullable: 'NO', defaultValue: null }],
  [`${REQUESTS}.request_hash_version`, { dataType: 'integer', nullable: 'NO', defaultValue: null }],
  [`${REQUESTS}.event_id`, { dataType: 'uuid', nullable: 'NO', defaultValue: null }],
  [`${REQUESTS}.created_at`, {
    dataType: 'timestamp with time zone',
    nullable: 'NO',
    defaultValue: 'now()',
  }],
])

const EXPECTED_CONSTRAINTS = new Map<string, string>([
  ['elearning_offline_registration_events_action_chk',
    `CHECK (action = ANY (ARRAY['register'::text, 'cancel'::text]))`],
  ['elearning_offline_registration_events_actor_self_chk', 'CHECK (actor_id = user_id)'],
  ['elearning_offline_registration_events_actor_fk',
    'FOREIGN KEY (actor_id, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_offline_registration_events_member_fk',
    'FOREIGN KEY (org_id, revision_id, user_id) REFERENCES elearning_offline_training_members(org_id, revision_id, user_id) ON DELETE RESTRICT'],
  ['elearning_offline_registration_events_org_user_id_uniq', 'UNIQUE (org_id, user_id, id)'],
  ['elearning_offline_registration_events_pkey', 'PRIMARY KEY (id)'],
  ['elearning_offline_registration_events_revision_fk',
    'FOREIGN KEY (org_id, training_id, revision_id) REFERENCES elearning_offline_training_revisions(org_id, training_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_registration_events_sequence_chk', 'CHECK (sequence >= 1)'],
  ['elearning_offline_registration_events_sequence_uniq',
    'UNIQUE (org_id, revision_id, user_id, sequence)'],
  ['elearning_offline_registration_events_training_fk',
    'FOREIGN KEY (org_id, training_id) REFERENCES elearning_offline_trainings(org_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_registration_requests_event_fk',
    'FOREIGN KEY (org_id, user_id, event_id) REFERENCES elearning_offline_registration_events(org_id, user_id, id) ON DELETE RESTRICT'],
  ['elearning_offline_registration_requests_hash_chk',
    `CHECK (request_hash ~ '^[0-9a-f]{64}$'::text)`],
  ['elearning_offline_registration_requests_hash_version_chk', 'CHECK (request_hash_version = 1)'],
  ['elearning_offline_registration_requests_pkey', 'PRIMARY KEY (org_id, user_id, request_id)'],
])

const EXPECTED_TRIGGERS = new Map<string, { table: string; type: number }>([
  ['trg_elearning_offline_registration_events_immutable', { table: EVENTS, type: 27 }],
  ['trg_elearning_offline_registration_events_truncate', { table: EVENTS, type: 34 }],
  ['trg_elearning_offline_registration_requests_immutable', { table: REQUESTS, type: 27 }],
  ['trg_elearning_offline_registration_requests_truncate', { table: REQUESTS, type: 34 }],
])

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index])
}

async function relationState(db: Kysely<unknown>): Promise<{
  column: boolean
  events: boolean
  requests: boolean
}> {
  const result = await sql<{
    registration_enabled: string | null
    events: string | null
    requests: string | null
  }>`
    SELECT
      (SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'elearning_offline_training_revisions'
         AND column_name = 'registration_enabled') AS registration_enabled,
      to_regclass(current_schema() || '.${sql.raw(EVENTS)}')::text AS events,
      to_regclass(current_schema() || '.${sql.raw(REQUESTS)}')::text AS requests
  `.execute(db)
  const row = result.rows[0]
  return {
    column: row?.registration_enabled === 'registration_enabled',
    events: row?.events === EVENTS,
    requests: row?.requests === REQUESTS,
  }
}

async function assertCanonical(db: Kysely<unknown>): Promise<void> {
  const registrationColumn = await sql<{
    data_type: string
    is_nullable: string
    column_default: string | null
  }>`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'elearning_offline_training_revisions'
      AND column_name = 'registration_enabled'
  `.execute(db)
  const column = registrationColumn.rows[0]
  if (
    registrationColumn.rows.length !== 1
    || column?.data_type !== 'boolean'
    || column.is_nullable !== 'NO'
    || normalized(column.column_default ?? '') !== 'false'
  ) throw new Error('e-learning offline registration schema drift')

  const columns = await sql<{
    table_name: string
    column_name: string
    data_type: string
    is_nullable: 'NO' | 'YES'
    column_default: string | null
  }>`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY(${sql.val([...EXPECTED_COLUMNS.keys()])}::text[])
    ORDER BY table_name, ordinal_position
  `.execute(db)
  for (const [table, expected] of EXPECTED_COLUMNS) {
    const actual = columns.rows
      .filter((row) => row.table_name === table)
      .map((row) => row.column_name)
    if (!sameSet(actual, expected)) throw new Error('e-learning offline registration schema drift')
  }
  if (columns.rows.some((row) => {
    const expected = EXPECTED_COLUMN_AUTHORITY.get(`${row.table_name}.${row.column_name}`)
    return !expected
      || row.data_type !== expected.dataType
      || row.is_nullable !== expected.nullable
      || row.column_default !== expected.defaultValue
  })) throw new Error('e-learning offline registration schema drift')

  const constraints = await sql<{ name: string; definition: string }>`
    SELECT constraint_row.conname AS name,
           pg_get_constraintdef(constraint_row.oid, true) AS definition
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = current_schema()
      AND table_row.relname = ANY(${sql.val([...EXPECTED_COLUMNS.keys()])}::text[])
    ORDER BY constraint_row.conname
  `.execute(db)
  const actualConstraints = new Map(
    constraints.rows.map((row) => [row.name, normalized(row.definition)]),
  )
  if (!sameSet([...actualConstraints.keys()], [...EXPECTED_CONSTRAINTS.keys()])) {
    throw new Error('e-learning offline registration schema drift')
  }
  for (const [name, definition] of EXPECTED_CONSTRAINTS) {
    if (actualConstraints.get(name) !== normalized(definition)) {
      throw new Error('e-learning offline registration schema drift')
    }
  }

  const triggers = await sql<{
    name: string
    table_name: string
    trigger_type: number
    enabled: string
    condition: unknown
    attributes: string
    function_name: string
    function_source: string
    function_oid: string
    canonical_function_oid: string | null
  }>`
    SELECT trigger_row.tgname AS name,
           table_row.relname AS table_name,
           trigger_row.tgtype::integer AS trigger_type,
           trigger_row.tgenabled AS enabled,
           trigger_row.tgqual AS condition,
           trigger_row.tgattr::text AS attributes,
           function_row.proname AS function_name,
           function_row.prosrc AS function_source,
           function_row.oid::text AS function_oid,
           to_regprocedure(format('%I.%I()', current_schema(), function_row.proname))::oid::text
             AS canonical_function_oid
    FROM pg_trigger trigger_row
    JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
    WHERE namespace_row.nspname = current_schema()
      AND NOT trigger_row.tgisinternal
      AND table_row.relname = ANY(${sql.val([...EXPECTED_COLUMNS.keys()])}::text[])
    ORDER BY trigger_row.tgname
  `.execute(db)
  if (!sameSet(triggers.rows.map((row) => row.name), [...EXPECTED_TRIGGERS.keys()])) {
    throw new Error('e-learning offline registration schema drift')
  }
  for (const row of triggers.rows) {
    const expected = EXPECTED_TRIGGERS.get(row.name)
    if (
      !expected
      || row.table_name !== expected.table
      || row.trigger_type !== expected.type
      || row.enabled !== 'O'
      || row.condition !== null
      || row.attributes !== ''
      || row.function_name !== 'elearning_offline_reject_change'
      || row.function_source !== REJECT_CHANGE_BODY
      || row.function_oid !== row.canonical_function_oid
    ) throw new Error('e-learning offline registration schema drift')
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const state = await relationState(db)
  if (state.column || state.events || state.requests) {
    if (!state.column || !state.events || !state.requests) {
      throw new Error('e-learning offline registration partial schema drift')
    }
    await assertCanonical(db)
    return
  }

  await sql`
    ALTER TABLE elearning_offline_training_revisions
    ADD COLUMN registration_enabled boolean NOT NULL DEFAULT false
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_registration_events (
      id uuid NOT NULL,
      org_id text NOT NULL,
      training_id uuid NOT NULL,
      revision_id uuid NOT NULL,
      user_id text NOT NULL,
      actor_id text NOT NULL,
      sequence integer NOT NULL,
      action text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT elearning_offline_registration_events_pkey PRIMARY KEY (id),
      CONSTRAINT elearning_offline_registration_events_org_user_id_uniq
        UNIQUE (org_id, user_id, id),
      CONSTRAINT elearning_offline_registration_events_sequence_uniq
        UNIQUE (org_id, revision_id, user_id, sequence),
      CONSTRAINT elearning_offline_registration_events_training_fk
        FOREIGN KEY (org_id, training_id)
        REFERENCES elearning_offline_trainings(org_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_registration_events_revision_fk
        FOREIGN KEY (org_id, training_id, revision_id)
        REFERENCES elearning_offline_training_revisions(org_id, training_id, id) ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_registration_events_member_fk
        FOREIGN KEY (org_id, revision_id, user_id)
        REFERENCES elearning_offline_training_members(org_id, revision_id, user_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_registration_events_actor_fk
        FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_offline_registration_events_actor_self_chk CHECK (actor_id = user_id),
      CONSTRAINT elearning_offline_registration_events_sequence_chk CHECK (sequence >= 1),
      CONSTRAINT elearning_offline_registration_events_action_chk CHECK (action IN ('register', 'cancel'))
    )
  `.execute(db)
  await sql`
    CREATE TABLE elearning_offline_registration_requests (
      org_id text NOT NULL,
      user_id text NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      event_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_offline_registration_requests_pkey
        PRIMARY KEY (org_id, user_id, request_id),
      CONSTRAINT elearning_offline_registration_requests_hash_version_chk
        CHECK (request_hash_version = 1),
      CONSTRAINT elearning_offline_registration_requests_hash_chk
        CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT elearning_offline_registration_requests_event_fk
        FOREIGN KEY (org_id, user_id, event_id)
        REFERENCES elearning_offline_registration_events(org_id, user_id, id) ON DELETE RESTRICT
    )
  `.execute(db)
  for (const [table, updateTrigger, truncateTrigger] of [
    [EVENTS, 'trg_elearning_offline_registration_events_immutable',
      'trg_elearning_offline_registration_events_truncate'],
    [REQUESTS, 'trg_elearning_offline_registration_requests_immutable',
      'trg_elearning_offline_registration_requests_truncate'],
  ] as const) {
    await sql.raw(`CREATE TRIGGER ${updateTrigger} BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION elearning_offline_reject_change()`).execute(db)
    await sql.raw(`CREATE TRIGGER ${truncateTrigger} BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION elearning_offline_reject_change()`).execute(db)
  }
  await assertCanonical(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const state = await relationState(db)
  if (!state.column && !state.events && !state.requests) return
  if (!state.column || !state.events || !state.requests) {
    throw new Error('e-learning offline registration partial schema drift')
  }
  await assertCanonical(db)
  const occupied = await sql<{ occupied: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM elearning_offline_registration_events
      UNION ALL SELECT 1 FROM elearning_offline_registration_requests
      UNION ALL SELECT 1 FROM elearning_offline_training_revisions WHERE registration_enabled = true
    ) AS occupied
  `.execute(db)
  if (occupied.rows[0]?.occupied) {
    throw new Error('e-learning offline registration rollback refused: authoritative rows exist')
  }
  await sql`DROP TABLE elearning_offline_registration_requests`.execute(db)
  await sql`DROP TABLE elearning_offline_registration_events`.execute(db)
  await sql`
    ALTER TABLE elearning_offline_training_revisions DROP COLUMN registration_enabled
  `.execute(db)
}
