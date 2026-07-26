import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const ACCOUNT_LEGACY_INDEX = 'idx_directory_accounts_provider_external_key'
const ACCOUNT_CORP_INDEX = 'idx_directory_accounts_provider_corp_external_key'
const ACCOUNT_NULL_CORP_INDEX = 'idx_directory_accounts_provider_null_corp_external_key'
const IDENTITY_CORP_UNION_INDEX = 'idx_user_external_identities_provider_corp_union'
const IDENTITY_NULL_CORP_UNION_INDEX = 'idx_user_external_identities_provider_null_corp_union'
const IDENTITY_CORP_OPEN_INDEX = 'idx_user_external_identities_provider_corp_open'
const IDENTITY_NULL_CORP_OPEN_INDEX = 'idx_user_external_identities_provider_null_corp_open'
const INTEGRATION_CORP_SHAPE_CHECK = 'directory_integrations_corp_id_canonical'
const ACCOUNT_CORP_SHAPE_CHECK = 'directory_accounts_corp_id_canonical'
const IDENTITY_CORP_SHAPE_CHECK = 'user_external_identities_corp_id_canonical'
const REQUIRED_CORP_SHAPE_DEFINITION = "CHECK ((corp_id ~ '^[!-~]+$'))"
const OPTIONAL_CORP_SHAPE_DEFINITION =
  "CHECK (((corp_id IS NULL) OR (corp_id ~ '^[!-~]+$')))"
const MIGRATION_LOCK_TIMEOUT = '5s'
const MIGRATION_STATEMENT_TIMEOUT = '5min'

type IndexShape = {
  name: string
  table: string
  columns: string[]
  predicate: string | null
}

const ACCOUNT_LEGACY_SHAPE: IndexShape = {
  name: ACCOUNT_LEGACY_INDEX,
  table: 'directory_accounts',
  columns: ['provider', 'external_key'],
  predicate: null,
}
const INDEX_SHAPES: IndexShape[] = [
  {
    name: ACCOUNT_CORP_INDEX,
    table: 'directory_accounts',
    columns: ['provider', 'corp_id', 'external_key'],
    predicate: '(corp_id is not null)',
  },
  {
    name: ACCOUNT_NULL_CORP_INDEX,
    table: 'directory_accounts',
    columns: ['provider', 'external_key'],
    predicate: '(corp_id is null)',
  },
  {
    name: IDENTITY_CORP_UNION_INDEX,
    table: 'user_external_identities',
    columns: ['provider', 'corp_id', 'provider_union_id'],
    predicate: '((corp_id is not null) and (provider_union_id is not null))',
  },
  {
    name: IDENTITY_NULL_CORP_UNION_INDEX,
    table: 'user_external_identities',
    columns: ['provider', 'provider_union_id'],
    predicate: '((corp_id is null) and (provider_union_id is not null))',
  },
  {
    name: IDENTITY_CORP_OPEN_INDEX,
    table: 'user_external_identities',
    columns: ['provider', 'corp_id', 'provider_open_id'],
    predicate: '((corp_id is not null) and (provider_open_id is not null))',
  },
  {
    name: IDENTITY_NULL_CORP_OPEN_INDEX,
    table: 'user_external_identities',
    columns: ['provider', 'provider_open_id'],
    predicate: '((corp_id is null) and (provider_open_id is not null))',
  },
]

type IndexCatalogRow = {
  is_unique: boolean
  is_valid: boolean
  key_attribute_count: number
  total_attribute_count: number
  has_expressions: boolean
  columns: string[]
  predicate: string | null
}

function normalizeCatalogExpression(value: string | null): string | null {
  if (value === null) return null
  return value
    .toLowerCase()
    .replaceAll('"', '')
    .replaceAll('::text', '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function readIndexShape(db: Kysely<unknown>, shape: IndexShape): Promise<IndexCatalogRow | null> {
  const result = await sql<IndexCatalogRow>`
    SELECT
      idx.indisunique AS is_unique,
      idx.indisvalid AS is_valid,
      idx.indnkeyatts::int AS key_attribute_count,
      idx.indnatts::int AS total_attribute_count,
      (idx.indexprs IS NOT NULL) AS has_expressions,
      ARRAY(
        SELECT attr.attname
          FROM unnest(idx.indkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attr
            ON attr.attrelid = table_rel.oid
           AND attr.attnum = key.attnum
         WHERE key.position <= idx.indnkeyatts
         ORDER BY key.position
      )::text[] AS columns,
      pg_get_expr(idx.indpred, idx.indrelid) AS predicate
      FROM pg_class index_rel
      JOIN pg_index idx ON idx.indexrelid = index_rel.oid
      JOIN pg_class table_rel ON table_rel.oid = idx.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
     WHERE namespace.nspname = current_schema()
       AND index_rel.relname = ${shape.name}
       AND table_rel.relname = ${shape.table}
  `.execute(db)
  return result.rows[0] ?? null
}

async function assertIndexShape(db: Kysely<unknown>, shape: IndexShape): Promise<void> {
  const actual = await readIndexShape(db, shape)
  if (
    !actual
    || !actual.is_unique
    || !actual.is_valid
    || actual.has_expressions
    || actual.key_attribute_count !== shape.columns.length
    || actual.total_attribute_count !== shape.columns.length
    || actual.columns.join('\u0000') !== shape.columns.join('\u0000')
    || normalizeCatalogExpression(actual.predicate) !== normalizeCatalogExpression(shape.predicate)
  ) {
    throw new Error(`directory corp-scope migration index drift: ${shape.name}`)
  }
}

async function createIndexIfAbsent(db: Kysely<unknown>, shape: IndexShape): Promise<void> {
  const existing = await readIndexShape(db, shape)
  if (existing) {
    await assertIndexShape(db, shape)
    return
  }

  if (shape.name === ACCOUNT_CORP_INDEX) {
    await sql`CREATE UNIQUE INDEX ${sql.id(ACCOUNT_CORP_INDEX)}
      ON directory_accounts(provider, corp_id, external_key)
      WHERE corp_id IS NOT NULL`.execute(db)
  } else if (shape.name === ACCOUNT_NULL_CORP_INDEX) {
    await sql`CREATE UNIQUE INDEX ${sql.id(ACCOUNT_NULL_CORP_INDEX)}
      ON directory_accounts(provider, external_key)
      WHERE corp_id IS NULL`.execute(db)
  } else if (shape.name === IDENTITY_CORP_UNION_INDEX) {
    await sql`CREATE UNIQUE INDEX ${sql.id(IDENTITY_CORP_UNION_INDEX)}
      ON user_external_identities(provider, corp_id, provider_union_id)
      WHERE corp_id IS NOT NULL AND provider_union_id IS NOT NULL`.execute(db)
  } else if (shape.name === IDENTITY_NULL_CORP_UNION_INDEX) {
    await sql`CREATE UNIQUE INDEX ${sql.id(IDENTITY_NULL_CORP_UNION_INDEX)}
      ON user_external_identities(provider, provider_union_id)
      WHERE corp_id IS NULL AND provider_union_id IS NOT NULL`.execute(db)
  } else if (shape.name === IDENTITY_CORP_OPEN_INDEX) {
    await sql`CREATE UNIQUE INDEX ${sql.id(IDENTITY_CORP_OPEN_INDEX)}
      ON user_external_identities(provider, corp_id, provider_open_id)
      WHERE corp_id IS NOT NULL AND provider_open_id IS NOT NULL`.execute(db)
  } else if (shape.name === IDENTITY_NULL_CORP_OPEN_INDEX) {
    await sql`CREATE UNIQUE INDEX ${sql.id(IDENTITY_NULL_CORP_OPEN_INDEX)}
      ON user_external_identities(provider, provider_open_id)
      WHERE corp_id IS NULL AND provider_open_id IS NOT NULL`.execute(db)
  } else {
    throw new Error(`unsupported directory corp-scope index: ${shape.name}`)
  }
  await assertIndexShape(db, shape)
}

async function readCheckConstraint(
  db: Kysely<unknown>,
  table: string,
  name: string,
): Promise<{ is_valid: boolean; definition: string } | null> {
  const result = await sql<{ is_valid: boolean; definition: string }>`
    SELECT
      constraint_row.convalidated AS is_valid,
      pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class table_rel ON table_rel.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_rel.relname = ${table}
       AND constraint_row.contype = 'c'
       AND constraint_row.conname = ${name}
  `.execute(db)
  return result.rows[0] ?? null
}

async function ensureCorpShapeCheck(
  db: Kysely<unknown>,
  table: 'directory_integrations' | 'directory_accounts' | 'user_external_identities',
  name: string,
  required: boolean,
): Promise<void> {
  const existing = await readCheckConstraint(db, table, name)
  if (!existing) {
    if (table === 'directory_integrations') {
      await sql`ALTER TABLE directory_integrations
        ADD CONSTRAINT ${sql.id(name)}
        CHECK (corp_id ~ '^[!-~]+$')`.execute(db)
    } else if (table === 'directory_accounts') {
      await sql`ALTER TABLE directory_accounts
        ADD CONSTRAINT ${sql.id(name)}
        CHECK (corp_id IS NULL OR corp_id ~ '^[!-~]+$')`.execute(db)
    } else {
      await sql`ALTER TABLE user_external_identities
        ADD CONSTRAINT ${sql.id(name)}
        CHECK (corp_id IS NULL OR corp_id ~ '^[!-~]+$')`.execute(db)
    }
  }

  const actual = await readCheckConstraint(db, table, name)
  const expectedDefinition = required
    ? REQUIRED_CORP_SHAPE_DEFINITION
    : OPTIONAL_CORP_SHAPE_DEFINITION
  if (
    !actual
    || !actual.is_valid
    || normalizeCatalogExpression(actual.definition)
      !== normalizeCatalogExpression(expectedDefinition)
  ) {
    throw new Error(`directory corp-scope migration constraint drift: ${name}`)
  }
}

async function assertAuthoritativeDirectoryScope(db: Kysely<unknown>): Promise<void> {
  const invalidIntegrations = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count
      FROM directory_integrations
     WHERE corp_id !~ '^[!-~]+$'
        OR provider IS NULL
        OR provider = ''
  `.execute(db)
  if (invalidIntegrations.rows[0]?.count !== '0') {
    throw new Error('directory corp-scope migration blocked: integration scope is non-canonical')
  }

  const result = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count
      FROM directory_accounts account
      JOIN directory_integrations integration ON integration.id = account.integration_id
     WHERE account.provider IS DISTINCT FROM integration.provider
        OR integration.corp_id !~ '^[!-~]+$'
  `.execute(db)
  if (result.rows[0]?.count !== '0') {
    throw new Error('directory corp-scope migration blocked: account parent scope is inconsistent')
  }
}

async function canonicalizeCorpScope(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE directory_integrations
       SET corp_id = BTRIM(corp_id)
     WHERE corp_id IS DISTINCT FROM BTRIM(corp_id)
  `.execute(db)
  await assertAuthoritativeDirectoryScope(db)
  await sql`
    UPDATE directory_accounts account
       SET corp_id = integration.corp_id
      FROM directory_integrations integration
     WHERE integration.id = account.integration_id
       AND account.corp_id IS DISTINCT FROM integration.corp_id
  `.execute(db)
  await sql`
    UPDATE user_external_identities
       SET corp_id = NULLIF(BTRIM(corp_id), '')
     WHERE corp_id IS DISTINCT FROM NULLIF(BTRIM(corp_id), '')
  `.execute(db)
  const invalidIdentities = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count
      FROM user_external_identities
     WHERE corp_id IS NOT NULL
       AND corp_id !~ '^[!-~]+$'
  `.execute(db)
  if (invalidIdentities.rows[0]?.count !== '0') {
    throw new Error('directory corp-scope migration blocked: identity corp is non-canonical')
  }
}

async function createLegacyIndexIfAbsent(db: Kysely<unknown>): Promise<void> {
  const existing = await readIndexShape(db, ACCOUNT_LEGACY_SHAPE)
  if (existing) {
    await assertIndexShape(db, ACCOUNT_LEGACY_SHAPE)
    return
  }
  await sql`CREATE UNIQUE INDEX ${sql.id(ACCOUNT_LEGACY_INDEX)}
    ON directory_accounts(provider, external_key)`.execute(db)
  await assertIndexShape(db, ACCOUNT_LEGACY_SHAPE)
}

async function readMigrationTimeouts(
  db: Kysely<unknown>,
): Promise<{ lock_timeout: string; statement_timeout: string }> {
  const result = await sql<{ lock_timeout: string; statement_timeout: string }>`
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

async function restoreMigrationTimeouts(
  db: Kysely<unknown>,
  previous: { lock_timeout: string; statement_timeout: string },
): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${previous.lock_timeout}, true),
      set_config('statement_timeout', ${previous.statement_timeout}, true)
  `.execute(db)
}

async function applyUp(db: Kysely<unknown>): Promise<void> {
  await canonicalizeCorpScope(db)

  await ensureCorpShapeCheck(
    db,
    'directory_integrations',
    INTEGRATION_CORP_SHAPE_CHECK,
    true,
  )
  await ensureCorpShapeCheck(db, 'directory_accounts', ACCOUNT_CORP_SHAPE_CHECK, false)
  await ensureCorpShapeCheck(db, 'user_external_identities', IDENTITY_CORP_SHAPE_CHECK, false)

  const legacyIndex = await readIndexShape(db, ACCOUNT_LEGACY_SHAPE)
  if (!legacyIndex) {
    // Idempotent replay is legal only when every replacement is already present and valid.
    // A partially applied shape with no legacy guard remains an unknown rollout state.
    for (const shape of INDEX_SHAPES) await assertIndexShape(db, shape)
    return
  }

  // Phase B is eligible only while the Phase-A-compatible legacy guard is still present.
  // A same-name-but-drifted guard means rollout state is unknown, so abort.
  await assertIndexShape(db, ACCOUNT_LEGACY_SHAPE)

  for (const shape of INDEX_SHAPES) await createIndexIfAbsent(db, shape)

  // Remove legacy protection only after every replacement has been structurally verified.
  await sql`DROP INDEX ${sql.id(ACCOUNT_LEGACY_INDEX)}`.execute(db)
}

async function applyDown(db: Kysely<unknown>): Promise<void> {
  // Cross-corp account duplicates make this CREATE fail. The migrator transaction then preserves
  // every scoped index and check; rollback never silently deletes or rewrites directory data.
  await createLegacyIndexIfAbsent(db)

  for (const shape of INDEX_SHAPES) {
    const existing = await readIndexShape(db, shape)
    if (existing) {
      await assertIndexShape(db, shape)
      await sql`DROP INDEX ${sql.id(shape.name)}`.execute(db)
    }
  }
  await sql`ALTER TABLE directory_accounts
    DROP CONSTRAINT IF EXISTS ${sql.id(ACCOUNT_CORP_SHAPE_CHECK)}`.execute(db)
  await sql`ALTER TABLE user_external_identities
    DROP CONSTRAINT IF EXISTS ${sql.id(IDENTITY_CORP_SHAPE_CHECK)}`.execute(db)
  await sql`ALTER TABLE directory_integrations
    DROP CONSTRAINT IF EXISTS ${sql.id(INTEGRATION_CORP_SHAPE_CHECK)}`.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely 0.28 runs all pending PostgreSQL migrations in one transaction. Scope the lock and
  // statement bounds to this migration and restore them on success so later migrations do not
  // inherit the settings. On failure the enclosing transaction rolls back the settings too.
  const previousTimeouts = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await applyUp(db)
  await restoreMigrationTimeouts(db, previousTimeouts)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const previousTimeouts = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await applyDown(db)
  await restoreMigrationTimeouts(db, previousTimeouts)
}
