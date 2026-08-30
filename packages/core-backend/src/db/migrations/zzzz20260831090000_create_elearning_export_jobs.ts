import { sql, type Kysely } from 'kysely'

export const ELEARNING_EXPORT_JOBS_TABLE = 'elearning_export_jobs' as const

const TABLE = ELEARNING_EXPORT_JOBS_TABLE
const AUTHORITY_FUNCTION = 'elearning_export_jobs_authority'
const AUTHORITY_TRIGGER = 'trg_elearning_export_jobs_authority'
const TRUNCATE_TRIGGER = 'trg_elearning_export_jobs_truncate_authority'
const REQUEST_INDEX = 'elearning_export_jobs_request_uniq'
const DUE_INDEX = 'idx_elearning_export_jobs_status_expiry'

const EXPECTED_COLUMNS = new Map<string, string>([
  ['id', 'uuid:NO'],
  ['org_id', 'text:NO'],
  ['actor_id', 'text:NO'],
  ['request_id', 'uuid:NO'],
  ['request_hash', 'text:NO'],
  ['request_hash_version', 'integer:NO'],
  ['directory_integration_id', 'uuid:NO'],
  ['directory_provider', 'text:NO'],
  ['department_id', 'uuid:NO'],
  ['period_start', 'timestamp with time zone:NO'],
  ['period_end', 'timestamp with time zone:NO'],
  ['scope_snapshot', 'jsonb:NO'],
  ['query_snapshot', 'jsonb:NO'],
  ['status', 'text:NO'],
  ['storage_key', 'text:YES'],
  ['file_sha256', 'text:YES'],
  ['file_size_bytes', 'bigint:YES'],
  ['error_code', 'text:YES'],
  ['expires_at', 'timestamp with time zone:NO'],
  ['completed_at', 'timestamp with time zone:YES'],
  ['expired_at', 'timestamp with time zone:YES'],
  ['created_at', 'timestamp with time zone:NO'],
  ['updated_at', 'timestamp with time zone:NO'],
])

const EXPECTED_CONSTRAINTS = new Map<string, string>([
  ['elearning_export_jobs_actor_fk',
    'FOREIGN KEY (actor_id, org_id) REFERENCES user_orgs(user_id, org_id) ON DELETE RESTRICT'],
  ['elearning_export_jobs_department_fk',
    'FOREIGN KEY (department_id, directory_integration_id, directory_provider) REFERENCES directory_departments(id, integration_id, provider) ON DELETE RESTRICT'],
  ['elearning_export_jobs_file_triplet_chk',
    `CHECK (storage_key IS NULL AND file_sha256 IS NULL AND file_size_bytes IS NULL OR storage_key IS NOT NULL AND btrim(storage_key) <> ''::text AND file_sha256 ~ '^[0-9a-f]{64}$'::text AND file_size_bytes IS NOT NULL AND file_size_bytes > 0)`],
  ['elearning_export_jobs_integration_org_fk',
    'FOREIGN KEY (directory_integration_id, org_id) REFERENCES directory_integrations(id, org_id) ON DELETE RESTRICT'],
  ['elearning_export_jobs_integration_provider_fk',
    'FOREIGN KEY (directory_integration_id, directory_provider) REFERENCES directory_integrations(id, provider) ON DELETE RESTRICT'],
  ['elearning_export_jobs_org_id_id_uniq', 'UNIQUE (org_id, id)'],
  ['elearning_export_jobs_period_chk',
    'CHECK (period_start < period_end AND created_at < expires_at)'],
  ['elearning_export_jobs_pkey', 'PRIMARY KEY (id)'],
  ['elearning_export_jobs_request_hash_chk',
    `CHECK (request_hash ~ '^[0-9a-f]{64}$'::text)`],
  ['elearning_export_jobs_request_hash_version_chk',
    'CHECK (request_hash_version = 1)'],
  ['elearning_export_jobs_snapshot_chk',
    `CHECK (jsonb_typeof(scope_snapshot) = 'object'::text AND jsonb_typeof(query_snapshot) = 'object'::text)`],
  ['elearning_export_jobs_status_chk',
    `CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'expired'::text]))`],
  ['elearning_export_jobs_status_shape_chk',
    `CHECK (status = 'pending'::text AND storage_key IS NULL AND completed_at IS NULL AND expired_at IS NULL AND error_code IS NULL OR status = 'running'::text AND storage_key IS NOT NULL AND completed_at IS NULL AND expired_at IS NULL AND error_code IS NULL OR status = 'succeeded'::text AND storage_key IS NOT NULL AND completed_at IS NOT NULL AND expired_at IS NULL AND error_code IS NULL OR status = 'failed'::text AND storage_key IS NOT NULL AND completed_at IS NULL AND expired_at IS NULL AND error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'::text OR status = 'expired'::text AND expired_at IS NOT NULL)`],
  ['elearning_export_jobs_text_chk',
    `CHECK (btrim(org_id) <> ''::text AND org_id = btrim(org_id) AND btrim(actor_id) <> ''::text AND actor_id = btrim(actor_id) AND btrim(directory_provider) <> ''::text AND directory_provider = btrim(directory_provider))`],
])

async function tableExists(db: Kysely<unknown>): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT to_regclass(current_schema() || '.${sql.raw(TABLE)}') IS NOT NULL AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

async function assertCanonical(db: Kysely<unknown>): Promise<void> {
  const columns = await sql<{
    column_name: string
    data_type: string
    is_nullable: string
  }>`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${TABLE}
    ORDER BY ordinal_position
  `.execute(db)
  if (
    columns.rows.length !== EXPECTED_COLUMNS.size
    || columns.rows.some((row) => (
      EXPECTED_COLUMNS.get(row.column_name) !== `${row.data_type}:${row.is_nullable}`
    ))
  ) throw new Error('elearning export migration drift: columns')

  const constraints = await sql<{
    conname: string
    definition: string
    validated: boolean
  }>`
    SELECT constraint_row.conname,
           pg_get_constraintdef(constraint_row.oid, true) AS definition,
           constraint_row.convalidated AS validated
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = current_schema() AND table_row.relname = ${TABLE}
  `.execute(db)
  if (
    constraints.rows.length !== EXPECTED_CONSTRAINTS.size
    || constraints.rows.some((row) => (
      row.validated !== true
      || EXPECTED_CONSTRAINTS.get(row.conname) !== row.definition
    ))
  ) throw new Error('elearning export migration drift: constraints')

  const indexes = await sql<{
    index_name: string
    unique: boolean
    valid: boolean
    ready: boolean
    columns: string[]
    predicate: string | null
  }>`
    SELECT index_relation.relname AS index_name,
           index_row.indisunique AS unique,
           index_row.indisvalid AS valid,
           index_row.indisready AS ready,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(index_row.indkey) WITH ORDINALITY AS key(attnum, position)
             JOIN pg_attribute attribute
               ON attribute.attrelid = index_row.indrelid
              AND attribute.attnum = key.attnum
             WHERE key.position <= index_row.indnkeyatts
             ORDER BY key.position
           )::text[] AS columns,
           pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
    FROM pg_index index_row
    JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_relation.relnamespace
    WHERE namespace_row.nspname = current_schema()
      AND table_relation.relname = ${TABLE}
      AND index_relation.relname = ANY(${sql.val([REQUEST_INDEX, DUE_INDEX])}::text[])
    ORDER BY index_relation.relname
  `.execute(db)
  const expectedIndexes = new Map([
    [REQUEST_INDEX, { columns: ['org_id', 'actor_id', 'request_id'], unique: true }],
    [DUE_INDEX, { columns: ['org_id', 'status', 'expires_at', 'id'], unique: false }],
  ])
  if (
    indexes.rows.length !== expectedIndexes.size
    || indexes.rows.some((row) => {
      const expected = expectedIndexes.get(row.index_name)
      return !expected
        || row.unique !== expected.unique
        || !row.valid
        || !row.ready
        || row.predicate !== null
        || row.columns.join('\0') !== expected.columns.join('\0')
    })
  ) {
    throw new Error('elearning export migration drift: indexes')
  }

  const authority = await sql<{
    function_oid: string
    canonical_function_oid: string | null
    language_name: string
    security_definer: boolean
    source_digest: string
  }>`
    SELECT function_row.oid::text AS function_oid,
           to_regprocedure(format('%I.${sql.raw(AUTHORITY_FUNCTION)}()', current_schema()))::oid::text
             AS canonical_function_oid,
           language_row.lanname AS language_name,
           function_row.prosecdef AS security_definer,
           md5(function_row.prosrc) AS source_digest
    FROM pg_proc function_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
    JOIN pg_language language_row ON language_row.oid = function_row.prolang
    WHERE namespace_row.nspname = current_schema()
      AND function_row.proname = ${AUTHORITY_FUNCTION}
      AND function_row.pronargs = 0
  `.execute(db)
  const expectedDigest = await sql<{ digest: string }>`
    SELECT md5($fn$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'elearning export jobs are immutable';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'invalid export initial state'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.id IS DISTINCT FROM OLD.id
         OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
         OR NEW.request_id IS DISTINCT FROM OLD.request_id
         OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
         OR NEW.request_hash_version IS DISTINCT FROM OLD.request_hash_version
         OR NEW.directory_integration_id IS DISTINCT FROM OLD.directory_integration_id
         OR NEW.directory_provider IS DISTINCT FROM OLD.directory_provider
         OR NEW.department_id IS DISTINCT FROM OLD.department_id
         OR NEW.period_start IS DISTINCT FROM OLD.period_start
         OR NEW.period_end IS DISTINCT FROM OLD.period_end
         OR NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot
         OR NEW.query_snapshot IS DISTINCT FROM OLD.query_snapshot
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning export identity is immutable';
      END IF;
      IF OLD.storage_key IS NOT NULL
         AND (NEW.storage_key IS DISTINCT FROM OLD.storage_key
           OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256
           OR NEW.file_size_bytes IS DISTINCT FROM OLD.file_size_bytes) THEN
        RAISE EXCEPTION 'elearning export effect claim is immutable';
      END IF;
      IF (OLD.status = 'pending' AND NEW.status NOT IN ('running', 'expired'))
         OR (OLD.status = 'running' AND NEW.status NOT IN ('running', 'succeeded', 'failed', 'expired'))
         OR (OLD.status = 'failed' AND NEW.status NOT IN ('running', 'expired'))
         OR (OLD.status = 'succeeded' AND NEW.status <> 'expired')
         OR OLD.status = 'expired' THEN
        RAISE EXCEPTION 'invalid export state transition';
      END IF;
      RETURN NEW;
    END
    $fn$) AS digest
  `.execute(db)
  const authorityRow = authority.rows[0]
  if (
    authority.rows.length !== 1
    || !authorityRow
    || authorityRow.function_oid !== authorityRow.canonical_function_oid
    || authorityRow.language_name !== 'plpgsql'
    || authorityRow.security_definer
    || authorityRow.source_digest !== expectedDigest.rows[0]?.digest
  ) throw new Error('elearning export migration drift: function')

  const trigger = await sql<{
    tgname: string
    tgtype: number
    tgenabled: string
    tgqual: unknown
    tgattr: string
    function_oid: string
    canonical_function_oid: string | null
  }>`
    SELECT trigger_row.tgname, trigger_row.tgtype, trigger_row.tgenabled,
           trigger_row.tgqual, trigger_row.tgattr::text,
           trigger_row.tgfoid::text AS function_oid,
           to_regprocedure(format('%I.${sql.raw(AUTHORITY_FUNCTION)}()', current_schema()))::oid::text
             AS canonical_function_oid
    FROM pg_trigger trigger_row
    JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = current_schema()
      AND table_row.relname = ${TABLE}
      AND NOT trigger_row.tgisinternal
  `.execute(db)
  const expectedTriggers = new Map([
    [AUTHORITY_TRIGGER, 31],
    [TRUNCATE_TRIGGER, 34],
  ])
  if (
    trigger.rows.length !== expectedTriggers.size
    || trigger.rows.some((row) => (
      expectedTriggers.get(row.tgname) !== row.tgtype
      || row.tgenabled !== 'O'
      || row.tgqual !== null
      || row.tgattr !== ''
      || row.function_oid !== row.canonical_function_oid
    ))
  ) throw new Error('elearning export migration drift: trigger')
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (await tableExists(db)) {
    await assertCanonical(db)
    return
  }
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
  await sql`
    CREATE TABLE elearning_export_jobs (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      actor_id text NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      directory_integration_id uuid NOT NULL,
      directory_provider text NOT NULL,
      department_id uuid NOT NULL,
      period_start timestamptz NOT NULL,
      period_end timestamptz NOT NULL,
      scope_snapshot jsonb NOT NULL,
      query_snapshot jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      storage_key text,
      file_sha256 text,
      file_size_bytes bigint,
      error_code text,
      expires_at timestamptz NOT NULL,
      completed_at timestamptz,
      expired_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_export_jobs_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_export_jobs_status_chk
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'expired')),
      CONSTRAINT elearning_export_jobs_text_chk CHECK (
        btrim(org_id) <> '' AND org_id = btrim(org_id)
        AND btrim(actor_id) <> '' AND actor_id = btrim(actor_id)
        AND btrim(directory_provider) <> '' AND directory_provider = btrim(directory_provider)
      ),
      CONSTRAINT elearning_export_jobs_request_hash_chk
        CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT elearning_export_jobs_request_hash_version_chk
        CHECK (request_hash_version = 1),
      CONSTRAINT elearning_export_jobs_period_chk CHECK (
        period_start < period_end AND created_at < expires_at
      ),
      CONSTRAINT elearning_export_jobs_snapshot_chk CHECK (
        jsonb_typeof(scope_snapshot) = 'object'
        AND jsonb_typeof(query_snapshot) = 'object'
      ),
      CONSTRAINT elearning_export_jobs_file_triplet_chk CHECK (
        (storage_key IS NULL AND file_sha256 IS NULL AND file_size_bytes IS NULL)
        OR (
          storage_key IS NOT NULL AND btrim(storage_key) <> ''
          AND file_sha256 ~ '^[0-9a-f]{64}$'
          AND file_size_bytes IS NOT NULL AND file_size_bytes > 0
        )
      ),
      CONSTRAINT elearning_export_jobs_status_shape_chk CHECK (
        (status = 'pending' AND storage_key IS NULL AND completed_at IS NULL
          AND expired_at IS NULL AND error_code IS NULL)
        OR (status = 'running' AND storage_key IS NOT NULL AND completed_at IS NULL
          AND expired_at IS NULL AND error_code IS NULL)
        OR (status = 'succeeded' AND storage_key IS NOT NULL AND completed_at IS NOT NULL
          AND expired_at IS NULL AND error_code IS NULL)
        OR (status = 'failed' AND storage_key IS NOT NULL AND completed_at IS NULL
          AND expired_at IS NULL AND error_code ~ '^[A-Z][A-Z0-9_]{1,63}$')
        OR (status = 'expired' AND expired_at IS NOT NULL)
      ),
      CONSTRAINT elearning_export_jobs_actor_fk FOREIGN KEY (actor_id, org_id)
        REFERENCES user_orgs (user_id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_export_jobs_integration_org_fk
        FOREIGN KEY (directory_integration_id, org_id)
        REFERENCES directory_integrations (id, org_id) ON DELETE RESTRICT,
      CONSTRAINT elearning_export_jobs_integration_provider_fk
        FOREIGN KEY (directory_integration_id, directory_provider)
        REFERENCES directory_integrations (id, provider) ON DELETE RESTRICT,
      CONSTRAINT elearning_export_jobs_department_fk
        FOREIGN KEY (department_id, directory_integration_id, directory_provider)
        REFERENCES directory_departments (id, integration_id, provider) ON DELETE RESTRICT
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX elearning_export_jobs_request_uniq
      ON elearning_export_jobs (org_id, actor_id, request_id)
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_export_jobs_status_expiry
      ON elearning_export_jobs (org_id, status, expires_at, id)
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION elearning_export_jobs_authority()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'elearning export jobs are immutable';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'invalid export initial state'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.id IS DISTINCT FROM OLD.id
         OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
         OR NEW.request_id IS DISTINCT FROM OLD.request_id
         OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
         OR NEW.request_hash_version IS DISTINCT FROM OLD.request_hash_version
         OR NEW.directory_integration_id IS DISTINCT FROM OLD.directory_integration_id
         OR NEW.directory_provider IS DISTINCT FROM OLD.directory_provider
         OR NEW.department_id IS DISTINCT FROM OLD.department_id
         OR NEW.period_start IS DISTINCT FROM OLD.period_start
         OR NEW.period_end IS DISTINCT FROM OLD.period_end
         OR NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot
         OR NEW.query_snapshot IS DISTINCT FROM OLD.query_snapshot
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning export identity is immutable';
      END IF;
      IF OLD.storage_key IS NOT NULL
         AND (NEW.storage_key IS DISTINCT FROM OLD.storage_key
           OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256
           OR NEW.file_size_bytes IS DISTINCT FROM OLD.file_size_bytes) THEN
        RAISE EXCEPTION 'elearning export effect claim is immutable';
      END IF;
      IF (OLD.status = 'pending' AND NEW.status NOT IN ('running', 'expired'))
         OR (OLD.status = 'running' AND NEW.status NOT IN ('running', 'succeeded', 'failed', 'expired'))
         OR (OLD.status = 'failed' AND NEW.status NOT IN ('running', 'expired'))
         OR (OLD.status = 'succeeded' AND NEW.status <> 'expired')
         OR OLD.status = 'expired' THEN
        RAISE EXCEPTION 'invalid export state transition';
      END IF;
      RETURN NEW;
    END
    $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_export_jobs_authority
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_export_jobs
      FOR EACH ROW EXECUTE FUNCTION elearning_export_jobs_authority()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_export_jobs_truncate_authority
      BEFORE TRUNCATE ON elearning_export_jobs
      FOR EACH STATEMENT EXECUTE FUNCTION elearning_export_jobs_authority()
  `.execute(db)
  await assertCanonical(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExists(db))) return
  const count = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM elearning_export_jobs
  `.execute(db)
  if (count.rows[0]?.count !== '0') {
    throw new Error('elearning export down refused: authoritative rows exist')
  }
  await sql`DROP TABLE elearning_export_jobs`.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_export_jobs_authority()`.execute(db)
}
