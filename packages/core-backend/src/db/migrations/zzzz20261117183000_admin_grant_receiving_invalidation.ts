import { sql, type Kysely } from 'kysely'

const MIGRATION_LOCK_TIMEOUT = '5s'
const MIGRATION_STATEMENT_TIMEOUT = '5min'
const BINDING_REVISION_MAX = '9223372036854775807'
const EVIDENCE_GENERATION_MAX = '9223372036854775807'

export const ADMIN_GRANT_INVALIDATION_DOWN_BLOCKED_CODE = 'ADMIN_GRANT_INVALIDATION_DOWN_BLOCKED'
export const ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_TRANSACTION_CODE = 'ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_TRANSACTION'
export const ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_READ_COMMITTED_CODE = 'ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_READ_COMMITTED'
export const ADMIN_GRANT_INVALIDATION_PREREQUISITE_CODE = 'ADMIN_GRANT_INVALIDATION_PREREQUISITE_MISSING'

const RELATIONS = [
  'directory_integrations',
  'directory_integration_capabilities',
  'user_external_identities',
  'directory_connection_application_pins',
  'user_external_identity_binding_pins',
  'user_external_identity_evidence',
] as const

type MigrationTimeouts = { lock_timeout: string; statement_timeout: string }
type ForeignKeyShape = {
  constraint: string
  table: string
  fromColumn: string
  target: string
  deleteAction: string
}

const FOREIGN_KEYS: readonly ForeignKeyShape[] = [
  {
    constraint: 'user_external_identity_binding_pins_identity_fk',
    table: 'user_external_identity_binding_pins',
    fromColumn: 'identity_id',
    target: 'user_external_identities',
    deleteAction: 'c',
  },
  {
    constraint: 'directory_connection_application_pins_connection_fk',
    table: 'directory_connection_application_pins',
    fromColumn: 'connection_id',
    target: 'directory_integrations',
    deleteAction: 'r',
  },
  {
    constraint: 'user_external_identity_evidence_live_identity_fk',
    table: 'user_external_identity_evidence',
    fromColumn: 'live_identity_id',
    target: 'user_external_identities',
    deleteAction: 'r',
  },
  {
    constraint: 'user_external_identity_evidence_connection_fk',
    table: 'user_external_identity_evidence',
    fromColumn: 'connection_id',
    target: 'directory_integrations',
    deleteAction: 'r',
  },
]

function fail(code: string, message: string): never {
  const error = new Error(`${code}: ${message}`)
  ;(error as Error & { code?: string }).code = code
  throw error
}

function isRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === ADMIN_GRANT_INVALIDATION_PREREQUISITE_CODE
    || code === ADMIN_GRANT_INVALIDATION_DOWN_BLOCKED_CODE
    || code === ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_TRANSACTION_CODE
    || code === ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_READ_COMMITTED_CODE
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function qualified(schemaName: string, identifier: string): string {
  return `${quoteIdent(schemaName)}.${quoteIdent(identifier)}`
}

async function exec(db: Kysely<unknown>, statement: string): Promise<void> {
  await sql.raw(statement).execute(db)
}

async function readMigrationTimeouts(db: Kysely<unknown>): Promise<MigrationTimeouts> {
  const result = await sql<MigrationTimeouts>`
    SELECT
      current_setting('lock_timeout') AS lock_timeout,
      current_setting('statement_timeout') AS statement_timeout
  `.execute(db)
  return result.rows[0] ?? { lock_timeout: '0', statement_timeout: '0' }
}

async function applyMigrationTimeouts(db: Kysely<unknown>): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${MIGRATION_LOCK_TIMEOUT}, true),
      set_config('statement_timeout', ${MIGRATION_STATEMENT_TIMEOUT}, true)
  `.execute(db)
}

async function restoreMigrationTimeouts(db: Kysely<unknown>, previous: MigrationTimeouts): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${previous.lock_timeout}, true),
      set_config('statement_timeout', ${previous.statement_timeout}, true)
  `.execute(db)
}

async function requireCallerTransaction(db: Kysely<unknown>): Promise<void> {
  const first = await sql<{ xid: string }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const second = await sql<{ xid: string }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const firstXid = first.rows[0]?.xid
  const secondXid = second.rows[0]?.xid
  if (typeof firstXid !== 'string' || firstXid.length === 0 || firstXid !== secondXid) {
    fail(
      ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_TRANSACTION_CODE,
      'down() requires an open caller transaction so its ACCESS EXCLUSIVE locks stay held through the empty check and drop. A plain autocommit invocation changes nothing.',
    )
  }
  const isolation = await sql<{ isolation: string }>`
    SELECT current_setting('transaction_isolation') AS isolation
  `.execute(db)
  if (isolation.rows[0]?.isolation !== 'read committed') {
    fail(
      ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_READ_COMMITTED_CODE,
      'down() requires read committed before it locks, checks, or drops. Repeatable read, serializable, and every other isolation are refused and change nothing.',
    )
  }
}

async function resolveInstallSchema(db: Kysely<unknown>): Promise<string> {
  const path = await sql<{ schema_name: string | null }>`
    SELECT path.nspname AS schema_name
      FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS path(nspname, ordinality)
     ORDER BY path.ordinality
     LIMIT 1
  `.execute(db)
  const schemaName = path.rows[0]?.schema_name
  if (typeof schemaName !== 'string' || schemaName.length === 0) {
    fail(
      ADMIN_GRANT_INVALIDATION_PREREQUISITE_CODE,
      'admin grant invalidation prerequisites refused. Nothing was changed.',
    )
  }
  await assertInstallShape(db, schemaName)
  return schemaName
}

async function assertInstallShape(db: Kysely<unknown>, schemaName: string): Promise<void> {
  const present = await sql<{
    integrations: string | null
    capabilities: string | null
    identities: string | null
    application_pins: string | null
    binding_pins: string | null
    evidence: string | null
  }>`
    SELECT
      to_regclass(${qualified(schemaName, 'directory_integrations')})::text AS integrations,
      to_regclass(${qualified(schemaName, 'directory_integration_capabilities')})::text AS capabilities,
      to_regclass(${qualified(schemaName, 'user_external_identities')})::text AS identities,
      to_regclass(${qualified(schemaName, 'directory_connection_application_pins')})::text AS application_pins,
      to_regclass(${qualified(schemaName, 'user_external_identity_binding_pins')})::text AS binding_pins,
      to_regclass(${qualified(schemaName, 'user_external_identity_evidence')})::text AS evidence
  `.execute(db)
  const row = present.rows[0]
  if (!row
    || row.integrations === null
    || row.capabilities === null
    || row.identities === null
    || row.application_pins === null
    || row.binding_pins === null
    || row.evidence === null) {
    fail(
      ADMIN_GRANT_INVALIDATION_PREREQUISITE_CODE,
      'admin grant invalidation prerequisites refused. Nothing was changed.',
    )
  }
  for (const foreignKey of FOREIGN_KEYS) {
    const matched = await foreignKeyMatches(db, schemaName, foreignKey)
    if (!matched) {
      fail(
        ADMIN_GRANT_INVALIDATION_PREREQUISITE_CODE,
        'admin grant invalidation prerequisites refused. Nothing was changed.',
      )
    }
  }
}

async function foreignKeyMatches(
  db: Kysely<unknown>,
  schemaName: string,
  foreignKey: ForeignKeyShape,
): Promise<boolean> {
  const result = await sql<{ matched: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class source ON source.oid = con.conrelid
        JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
        JOIN pg_catalog.pg_class target ON target.oid = con.confrelid
        JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
       WHERE con.contype = 'f'
         AND con.conname = ${foreignKey.constraint}
         AND source.relname = ${foreignKey.table}
         AND source_ns.nspname = ${schemaName}
         AND target.relname = ${foreignKey.target}
         AND target_ns.nspname = source_ns.nspname
         AND con.confdeltype = ${foreignKey.deleteAction}
         AND pg_catalog.cardinality(con.conkey) = 1
         AND pg_catalog.cardinality(con.confkey) = 1
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute att
            WHERE att.attrelid = con.conrelid
              AND att.attnum = con.conkey[1]
              AND att.attname = ${foreignKey.fromColumn}
         )
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute att
            WHERE att.attrelid = con.confrelid
              AND att.attnum = con.confkey[1]
              AND att.attname = 'id'
         )
    ) AS matched
  `.execute(db)
  return result.rows[0]?.matched === true
}

function requireSchema(relationSchema: string): string {
  return `
  IF ${relationSchema} IS NULL THEN
    RAISE EXCEPTION 'admin grant invalidation relation schema refused' USING ERRCODE = '55000';
  END IF;`
}

function evidenceLoop(column: 'connection_id' | 'live_identity_id'): string {
  return `
  FOR evidence_id IN EXECUTE format(
    'SELECT id FROM %I.%I WHERE ${column} = $1 AND revoked_at IS NULL ORDER BY id FOR UPDATE',
    relation_schema,
    'user_external_identity_evidence'
  ) USING target_id
  LOOP
    EXECUTE format(
      'SELECT revocation_generation FROM %I.%I WHERE id = $1',
      relation_schema,
      'user_external_identity_evidence'
    ) INTO old_generation USING evidence_id;
    IF old_generation = ${EVIDENCE_GENERATION_MAX} THEN
      RAISE EXCEPTION 'admin grant evidence generation overflow refused' USING ERRCODE = '55000';
    END IF;
    EXECUTE format(
      'UPDATE %I.%I SET revocation_generation = $1, live_identity_id = NULL WHERE id = $2',
      relation_schema,
      'user_external_identity_evidence'
    ) USING old_generation + 1, evidence_id;
  END LOOP;`
}

async function createFunction(
  db: Kysely<unknown>,
  schemaName: string,
  name: string,
  args: string,
  returns: string,
  body: string,
  volatility: 'IMMUTABLE' | null,
): Promise<void> {
  const volatilitySql = volatility ? ` ${volatility}` : ''
  await exec(
    db,
    `CREATE FUNCTION ${qualified(schemaName, name)}(${args}) RETURNS ${returns}
     LANGUAGE plpgsql${volatilitySql}
     SET search_path = pg_catalog
     AS $fn$
${body}
     $fn$`,
  )
}

async function createTrigger(
  db: Kysely<unknown>,
  schemaName: string,
  trigger: string,
  timing: 'BEFORE UPDATE' | 'BEFORE DELETE' | 'AFTER UPDATE',
  table: string,
  functionName: string,
): Promise<void> {
  await exec(
    db,
    `CREATE TRIGGER ${quoteIdent(trigger)}
       ${timing} ON ${qualified(schemaName, table)}
       FOR EACH ROW EXECUTE FUNCTION ${qualified(schemaName, functionName)}()`,
  )
}

async function applyUp(db: Kysely<unknown>, schemaName: string): Promise<void> {
  await createFunction(
    db,
    schemaName,
    'admin_grant_application_successor',
    'revision text',
    'text',
    `DECLARE
  index integer;
  digit text;
  carry boolean := true;
  built text := '';
BEGIN
  IF revision IS NULL OR revision !~ '^(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'admin grant application revision refused' USING ERRCODE = '55000';
  END IF;
  FOR index IN REVERSE char_length(revision)..1 LOOP
    digit := substring(revision FROM index FOR 1);
    IF carry THEN
      CASE digit
        WHEN '0' THEN built := '1' || built; carry := false;
        WHEN '1' THEN built := '2' || built; carry := false;
        WHEN '2' THEN built := '3' || built; carry := false;
        WHEN '3' THEN built := '4' || built; carry := false;
        WHEN '4' THEN built := '5' || built; carry := false;
        WHEN '5' THEN built := '6' || built; carry := false;
        WHEN '6' THEN built := '7' || built; carry := false;
        WHEN '7' THEN built := '8' || built; carry := false;
        WHEN '8' THEN built := '9' || built; carry := false;
        WHEN '9' THEN built := '0' || built;
        ELSE
          RAISE EXCEPTION 'admin grant application revision refused' USING ERRCODE = '55000';
      END CASE;
    ELSE
      built := digit || built;
    END IF;
  END LOOP;
  IF carry THEN
    built := '1' || built;
  END IF;
  RETURN built;
END`,
    'IMMUTABLE',
  )
  await createFunction(
    db,
    schemaName,
    'admin_grant_material_projection',
    'config jsonb',
    'jsonb',
    `DECLARE
  container text;
  keys text[] := ARRAY['appKey', 'appSecret', 'baseUrl', 'workNotificationAgentId'];
  key text;
  kind text;
  pairs jsonb := '[]'::jsonb;
  nullable boolean;
BEGIN
  container := jsonb_typeof(config);
  IF container IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_array('invalid', container);
  END IF;
  FOREACH key IN ARRAY keys LOOP
    nullable := key = 'baseUrl' OR key = 'workNotificationAgentId';
    IF NOT (config ? key) THEN
      pairs := pairs || jsonb_build_array(jsonb_build_array('missing', ''));
    ELSE
      kind := jsonb_typeof(config -> key);
      IF kind = 'string' THEN
        pairs := pairs || jsonb_build_array(jsonb_build_array('string', (config -> key) #>> '{}'));
      ELSIF kind = 'null' AND nullable THEN
        pairs := pairs || jsonb_build_array(jsonb_build_array('null', ''));
      ELSE
        pairs := pairs || jsonb_build_array(jsonb_build_array('invalid', kind));
      END IF;
    END IF;
  END LOOP;
  RETURN pairs;
END`,
    'IMMUTABLE',
  )
  await createFunction(
    db,
    schemaName,
    'admin_grant_application_pin_update_guard',
    '',
    'trigger',
    `DECLARE
  relation_schema text;
  next_revision text;
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN
    RAISE EXCEPTION 'admin grant application pin rekey refused' USING ERRCODE = '55000';
  END IF;
  ${requireSchema('TG_TABLE_SCHEMA')}
  relation_schema := TG_TABLE_SCHEMA;
  EXECUTE format('SELECT %I.admin_grant_application_successor($1)', relation_schema)
    INTO next_revision USING OLD.application_revision;
  IF NEW.application_revision IS DISTINCT FROM next_revision THEN
    RAISE EXCEPTION 'admin grant application revision refused' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END`,
    null,
  )
  await createFunction(
    db,
    schemaName,
    'admin_grant_application_pin_delete_guard',
    '',
    'trigger',
    `BEGIN
  RAISE EXCEPTION 'admin grant application pin delete refused' USING ERRCODE = '55000';
END`,
    null,
  )
  await createFunction(
    db,
    schemaName,
    'admin_grant_binding_pin_update_guard',
    '',
    'trigger',
    `BEGIN
  IF NEW.identity_id IS DISTINCT FROM OLD.identity_id THEN
    RAISE EXCEPTION 'admin grant binding pin rekey refused' USING ERRCODE = '55000';
  END IF;
  IF OLD.binding_revision = ${BINDING_REVISION_MAX} THEN
    RAISE EXCEPTION 'admin grant binding revision overflow refused' USING ERRCODE = '55000';
  END IF;
  IF NEW.binding_revision IS DISTINCT FROM (OLD.binding_revision + 1) THEN
    RAISE EXCEPTION 'admin grant binding pin revision refused' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END`,
    null,
  )
  await createFunction(
    db,
    schemaName,
    'admin_grant_binding_pin_delete_guard',
    '',
    'trigger',
    `DECLARE
  relation_schema text;
  parent_visible boolean;
BEGIN
  ${requireSchema('TG_TABLE_SCHEMA')}
  relation_schema := TG_TABLE_SCHEMA;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE id = $1)',
    relation_schema,
    'user_external_identities'
  ) INTO parent_visible USING OLD.identity_id;
  IF parent_visible THEN
    RAISE EXCEPTION 'admin grant binding pin delete refused' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END`,
    null,
  )
  await createFunction(
    db,
    schemaName,
    'admin_grant_capability_delete_guard',
    '',
    'trigger',
    `DECLARE
  relation_schema text;
  blocked boolean;
BEGIN
  ${requireSchema('TG_TABLE_SCHEMA')}
  relation_schema := TG_TABLE_SCHEMA;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE connection_id = $1) OR EXISTS (SELECT 1 FROM %I.%I WHERE connection_id = $1)',
    relation_schema,
    'directory_connection_application_pins',
    relation_schema,
    'user_external_identity_evidence'
  ) INTO blocked USING OLD.integration_id;
  IF blocked THEN
    RAISE EXCEPTION 'admin grant capability delete refused' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END`,
    null,
  )
  await createFunction(
    db,
    schemaName,
    'admin_grant_integration_invalidate',
    '',
    'trigger',
    `DECLARE
  relation_schema text;
  old_projection jsonb;
  new_projection jsonb;
  old_revision text;
  next_revision text;
  evidence_id text;
  old_generation bigint;
  target_id uuid;
BEGIN
  ${requireSchema('TG_TABLE_SCHEMA')}
  relation_schema := TG_TABLE_SCHEMA;
  EXECUTE format('SELECT %I.admin_grant_material_projection($1)', relation_schema)
    INTO old_projection USING OLD.config;
  EXECUTE format('SELECT %I.admin_grant_material_projection($1)', relation_schema)
    INTO new_projection USING NEW.config;
  IF OLD.org_id IS NOT DISTINCT FROM NEW.org_id
     AND OLD.provider IS NOT DISTINCT FROM NEW.provider
     AND OLD.corp_id IS NOT DISTINCT FROM NEW.corp_id
     AND old_projection IS NOT DISTINCT FROM new_projection THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT application_revision FROM %I.%I WHERE connection_id = $1 FOR UPDATE',
    relation_schema,
    'directory_connection_application_pins'
  ) INTO old_revision USING NEW.id;
  IF old_revision IS NOT NULL THEN
    EXECUTE format('SELECT %I.admin_grant_application_successor($1)', relation_schema)
      INTO next_revision USING old_revision;
    EXECUTE format(
      'UPDATE %I.%I SET application_revision = $1 WHERE connection_id = $2',
      relation_schema,
      'directory_connection_application_pins'
    ) USING next_revision, NEW.id;
  END IF;
  target_id := NEW.id;
  ${evidenceLoop('connection_id')}
  RETURN NEW;
END`,
    null,
  )
  await createFunction(
    db,
    schemaName,
    'admin_grant_identity_invalidate',
    '',
    'trigger',
    `DECLARE
  relation_schema text;
  old_revision bigint;
  evidence_id text;
  old_generation bigint;
  target_id uuid;
BEGIN
  ${requireSchema('TG_TABLE_SCHEMA')}
  relation_schema := TG_TABLE_SCHEMA;
  IF OLD.provider IS NOT DISTINCT FROM NEW.provider
     AND OLD.local_user_id IS NOT DISTINCT FROM NEW.local_user_id
     AND OLD.external_key IS NOT DISTINCT FROM NEW.external_key
     AND OLD.corp_id IS NOT DISTINCT FROM NEW.corp_id
     AND OLD.provider_open_id IS NOT DISTINCT FROM NEW.provider_open_id
     AND OLD.provider_union_id IS NOT DISTINCT FROM NEW.provider_union_id THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT binding_revision FROM %I.%I WHERE identity_id = $1 FOR UPDATE',
    relation_schema,
    'user_external_identity_binding_pins'
  ) INTO old_revision USING NEW.id;
  IF old_revision IS NOT NULL THEN
    IF old_revision = ${BINDING_REVISION_MAX} THEN
      RAISE EXCEPTION 'admin grant binding revision overflow refused' USING ERRCODE = '55000';
    END IF;
    EXECUTE format(
      'UPDATE %I.%I
          SET binding_revision = $1,
              provider = $2,
              local_user_id = $3,
              external_key = $4,
              corp_id = $5,
              provider_open_id = $6,
              provider_union_id = $7
        WHERE identity_id = $8',
      relation_schema,
      'user_external_identity_binding_pins'
    ) USING old_revision + 1, NEW.provider, NEW.local_user_id, NEW.external_key, NEW.corp_id,
      NEW.provider_open_id, NEW.provider_union_id, NEW.id;
  END IF;
  target_id := NEW.id;
  ${evidenceLoop('live_identity_id')}
  RETURN NEW;
END`,
    null,
  )
  await createTrigger(db, schemaName, 'admin_grant_application_pin_update_guard', 'BEFORE UPDATE', 'directory_connection_application_pins', 'admin_grant_application_pin_update_guard')
  await createTrigger(db, schemaName, 'admin_grant_application_pin_delete_guard', 'BEFORE DELETE', 'directory_connection_application_pins', 'admin_grant_application_pin_delete_guard')
  await createTrigger(db, schemaName, 'admin_grant_binding_pin_update_guard', 'BEFORE UPDATE', 'user_external_identity_binding_pins', 'admin_grant_binding_pin_update_guard')
  await createTrigger(db, schemaName, 'admin_grant_binding_pin_delete_guard', 'BEFORE DELETE', 'user_external_identity_binding_pins', 'admin_grant_binding_pin_delete_guard')
  await createTrigger(db, schemaName, 'admin_grant_capability_delete_guard', 'BEFORE DELETE', 'directory_integration_capabilities', 'admin_grant_capability_delete_guard')
  await createTrigger(db, schemaName, 'admin_grant_integration_invalidate', 'AFTER UPDATE', 'directory_integrations', 'admin_grant_integration_invalidate')
  await createTrigger(db, schemaName, 'admin_grant_identity_invalidate', 'AFTER UPDATE', 'user_external_identities', 'admin_grant_identity_invalidate')
}

async function lockInstallRelations(db: Kysely<unknown>, schemaName: string): Promise<void> {
  for (const relation of RELATIONS) {
    await exec(db, `LOCK TABLE ${qualified(schemaName, relation)} IN ACCESS EXCLUSIVE MODE`)
  }
}

async function receivingHoldsRow(db: Kysely<unknown>, schemaName: string): Promise<boolean> {
  const applicationPins = qualified(schemaName, 'directory_connection_application_pins')
  const bindingPins = qualified(schemaName, 'user_external_identity_binding_pins')
  const evidence = qualified(schemaName, 'user_external_identity_evidence')
  const result = await sql<{ held: boolean }>`
    SELECT (
      EXISTS (SELECT 1 FROM ${sql.raw(applicationPins)})
      OR EXISTS (SELECT 1 FROM ${sql.raw(bindingPins)})
      OR EXISTS (SELECT 1 FROM ${sql.raw(evidence)})
    ) AS held
  `.execute(db)
  return result.rows[0]?.held === true
}

async function dropInvalidationObjects(db: Kysely<unknown>, schemaName: string): Promise<void> {
  const triggers: ReadonlyArray<{ trigger: string; table: string }> = [
    { trigger: 'admin_grant_integration_invalidate', table: 'directory_integrations' },
    { trigger: 'admin_grant_capability_delete_guard', table: 'directory_integration_capabilities' },
    { trigger: 'admin_grant_identity_invalidate', table: 'user_external_identities' },
    { trigger: 'admin_grant_application_pin_update_guard', table: 'directory_connection_application_pins' },
    { trigger: 'admin_grant_application_pin_delete_guard', table: 'directory_connection_application_pins' },
    { trigger: 'admin_grant_binding_pin_update_guard', table: 'user_external_identity_binding_pins' },
    { trigger: 'admin_grant_binding_pin_delete_guard', table: 'user_external_identity_binding_pins' },
  ]
  for (const item of triggers) {
    await exec(db, `DROP TRIGGER ${quoteIdent(item.trigger)} ON ${qualified(schemaName, item.table)}`)
  }
  for (const name of [
    'admin_grant_integration_invalidate',
    'admin_grant_identity_invalidate',
    'admin_grant_capability_delete_guard',
    'admin_grant_application_pin_update_guard',
    'admin_grant_application_pin_delete_guard',
    'admin_grant_binding_pin_update_guard',
    'admin_grant_binding_pin_delete_guard',
  ]) {
    await exec(db, `DROP FUNCTION ${qualified(schemaName, name)}()`)
  }
  await exec(db, `DROP FUNCTION ${qualified(schemaName, 'admin_grant_material_projection')}(jsonb)`)
  await exec(db, `DROP FUNCTION ${qualified(schemaName, 'admin_grant_application_successor')}(text)`)
}

async function withTimeouts(db: Kysely<unknown>, body: () => Promise<void>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  try {
    await body()
  } catch (error) {
    if (isRefusal(error)) await restoreMigrationTimeouts(db, previous)
    throw error
  }
  await restoreMigrationTimeouts(db, previous)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await withTimeouts(db, async () => {
    const schemaName = await resolveInstallSchema(db)
    await applyUp(db, schemaName)
  })
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await requireCallerTransaction(db)
  await withTimeouts(db, async () => {
    const schemaName = await resolveInstallSchema(db)
    await lockInstallRelations(db, schemaName)
    if (await receivingHoldsRow(db, schemaName)) {
      fail(
        ADMIN_GRANT_INVALIDATION_DOWN_BLOCKED_CODE,
        'down() refused while an admin grant receiving table holds a row. Nothing was changed.',
      )
    }
    await dropInvalidationObjects(db, schemaName)
  })
}
