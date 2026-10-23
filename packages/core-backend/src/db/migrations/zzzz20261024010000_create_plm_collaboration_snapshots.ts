import { sql, type Kysely } from 'kysely'
import {
  ECO_COLLABORATION_ECO_FIELDS,
  ECO_COLLABORATION_LOCAL_FIELDS,
} from '../../multitable/plm-collaboration-snapshot-wire'

// ECO-only admission. source_kind may name readiness, and every readiness insert is refused
// until a qualified Native map is accepted. An INSERT into meta_plm_collaboration_syncs is not a
// privilege boundary: a database role allowed to write that table can forge accepted evidence.

const SOURCE_KEY_SQL = ECO_COLLABORATION_ECO_FIELDS.map((key) => `'${key}'`).join(', ')
const LOCAL_KEY_SQL = ECO_COLLABORATION_LOCAL_FIELDS.map((field) => `'${field.key}'`).join(', ')
const LOCAL_TYPE_CASE = ECO_COLLABORATION_LOCAL_FIELDS
  .map((field) => `WHEN '${field.key}' THEN '${field.type}'`)
  .join('\n            ')
const NEW_RELATIONS = [
  'meta_plm_collaboration_previews',
  'meta_plm_collaboration_bindings',
  'meta_plm_collaboration_rows',
  'meta_plm_collaboration_syncs',
] as const
const REQUIRED_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ['meta_bases', 'id', 'text'],
  ['meta_bases', 'owner_id', 'text'],
  ['meta_bases', 'workspace_id', 'text'],
  ['meta_bases', 'deleted_at', 'timestamptz'],
  ['meta_sheets', 'id', 'text'],
  ['meta_sheets', 'base_id', 'text'],
  ['meta_sheets', 'deleted_at', 'timestamptz'],
  ['meta_views', 'id', 'text'],
  ['meta_views', 'sheet_id', 'text'],
  ['meta_views', 'deleted_at', 'timestamptz'],
  ['meta_fields', 'id', 'text'],
  ['meta_fields', 'sheet_id', 'text'],
  ['meta_fields', 'type', 'text'],
  ['meta_fields', 'property', 'jsonb'],
  ['meta_records', 'id', 'text'],
  ['meta_records', 'sheet_id', 'text'],
  ['meta_records', 'data', 'jsonb'],
  ['meta_records', 'version', 'int4'],
  ['meta_records', 'created_by', 'text'],
  ['meta_records', 'modified_by', 'text'],
  ['meta_records', 'created_at', 'timestamptz'],
  ['meta_records', 'updated_at', 'timestamptz'],
  ['meta_records', 'locked', 'bool'],
  ['meta_records', 'locked_by', 'text'],
  ['meta_records', 'locked_at', 'timestamptz'],
]

type ServingSchema = { name: string; ident: string }

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function assertSchemaName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('plm_collaboration_serving_schema_invalid')
  }
}

async function servingSchema(db: Kysely<unknown>): Promise<ServingSchema> {
  const found = await sql<{ name: string | null; ident: string | null }>`
    SELECT current_schema() AS name, quote_ident(current_schema()) AS ident
  `.execute(db)
  const name = found.rows[0]?.name
  const ident = found.rows[0]?.ident
  if (!name || !ident) {
    await sql.raw(`
      DO $schema$ BEGIN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'plm_collaboration_serving_schema_invalid',
          CONSTRAINT = 'meta_plm_collaboration_predecessor_guard';
      END $schema$
    `).execute(db)
    throw new Error('plm_collaboration_serving_schema_invalid')
  }
  assertSchemaName(name)
  return { name, ident }
}

function preflightSql(schema: ServingSchema): string {
  const values = REQUIRED_COLUMNS
    .map(([rel, col, typ]) => `(${quoteLiteral(rel)}, ${quoteLiteral(col)}, ${quoteLiteral(typ)})`)
    .join(', ')
  const relations = NEW_RELATIONS.map((name) => quoteLiteral(name)).join(', ')
  return `
DO $preflight$
BEGIN
  IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'plm_collaboration_predecessors_absent',
      CONSTRAINT = 'meta_plm_collaboration_predecessor_guard';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND relation.relkind = 'r'
      AND relation.relname IN (${relations})
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc proc
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = ${quoteLiteral(schema.name)}
      AND proc.proname LIKE 'meta_plm_collaboration\\_%' ESCAPE '\\'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'plm_collaboration_relation_present',
      CONSTRAINT = 'meta_plm_collaboration_predecessor_guard';
  END IF;
  IF (
    SELECT count(*)
    FROM (VALUES ${values}) AS required(rel, col, typ)
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute attribute
      JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_type type ON type.oid = attribute.atttypid
      WHERE namespace.nspname = ${quoteLiteral(schema.name)}
        AND relation.relname = required.rel
        AND relation.relkind = 'r'
        AND attribute.attname = required.col
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND type.typname = required.typ
    )
  ) <> ${REQUIRED_COLUMNS.length} THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'plm_collaboration_predecessors_absent',
      CONSTRAINT = 'meta_plm_collaboration_predecessor_guard';
  END IF;
END
$preflight$`
}

function createStatements(ident: string): string[] {
  const s = ident
  return [
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_refuse(constraint_name text, message text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = message, CONSTRAINT = constraint_name;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_native_timestamp(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  year int; month int; day int; hour int; minute int; second int; leap boolean; dim int;
BEGIN
  IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$' THEN
    RETURN false;
  END IF;
  year := substring(value from 1 for 4)::int;
  month := substring(value from 6 for 2)::int;
  day := substring(value from 9 for 2)::int;
  hour := substring(value from 12 for 2)::int;
  minute := substring(value from 15 for 2)::int;
  second := substring(value from 18 for 2)::int;
  IF year < 1 OR month < 1 OR month > 12 OR hour > 23 OR minute > 59 OR second > 59 THEN
    RETURN false;
  END IF;
  leap := year % 4 = 0 AND (year % 100 <> 0 OR year % 400 = 0);
  dim := (ARRAY[31, CASE WHEN leap THEN 29 ELSE 28 END, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])[month];
  RETURN day >= 1 AND day <= dim;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_eco_row_key(
  row_key jsonb, data_source_id text, native_tenant_id text, native_org_id text
) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  slot int; elem jsonb; eco_id text;
BEGIN
  IF jsonb_typeof(row_key) IS DISTINCT FROM 'array' OR jsonb_array_length(row_key) <> 4 THEN
    RETURN NULL;
  END IF;
  FOR slot IN 0..3 LOOP
    elem := row_key -> slot;
    IF jsonb_typeof(elem) IS DISTINCT FROM 'string' THEN
      RETURN NULL;
    END IF;
  END LOOP;
  IF (row_key ->> 0) IS DISTINCT FROM data_source_id
     OR (row_key ->> 1) IS DISTINCT FROM native_tenant_id
     OR (row_key ->> 2) IS DISTINCT FROM native_org_id THEN
    RETURN NULL;
  END IF;
  eco_id := row_key ->> 3;
  IF eco_id IS NULL OR char_length(eco_id) < 1 OR char_length(eco_id) > 128 OR eco_id <> btrim(eco_id) THEN
    RETURN NULL;
  END IF;
  RETURN eco_id;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_source_value_ok(
  logical_key text, item_id text, eco_id text, value jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  text_value text;
BEGIN
  IF value IS NULL THEN
    RETURN false;
  END IF;
  IF logical_key IN ('source_version_id', 'target_version_id', 'stage_id', 'state', 'kanban_state', 'priority', 'updated_at')
     AND jsonb_typeof(value) = 'null' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  text_value := value #>> '{}';
  IF logical_key = 'id' THEN
    RETURN text_value = eco_id AND char_length(text_value) BETWEEN 1 AND 128 AND text_value = btrim(text_value);
  ELSIF logical_key = 'name' THEN
    RETURN char_length(text_value) <= 100;
  ELSIF logical_key = 'eco_type' THEN
    RETURN char_length(text_value) <= 20;
  ELSIF logical_key = 'product_id' THEN
    RETURN text_value = item_id AND char_length(text_value) BETWEEN 1 AND 128 AND text_value = btrim(text_value);
  ELSIF logical_key IN ('source_version_id', 'target_version_id', 'stage_id') THEN
    RETURN true;
  ELSIF logical_key IN ('state', 'kanban_state') THEN
    RETURN char_length(text_value) <= 20;
  ELSIF logical_key = 'priority' THEN
    RETURN char_length(text_value) <= 10;
  ELSIF logical_key = 'updated_at' THEN
    RETURN ${s}.meta_plm_collaboration_native_timestamp(text_value);
  END IF;
  RETURN false;
END
$fn$`,
    `
CREATE TABLE ${s}.meta_plm_collaboration_bindings (
  id uuid PRIMARY KEY,
  creator_id text NOT NULL,
  data_source_id text NOT NULL,
  source_kind text NOT NULL,
  native_tenant_id text NOT NULL,
  native_org_id text NOT NULL,
  item_id text NOT NULL,
  current_version_id text,
  source_fingerprint text NOT NULL,
  base_id text NOT NULL,
  sheet_id text NOT NULL,
  view_id text NOT NULL,
  name text NOT NULL,
  source_fields jsonb NOT NULL,
  local_fields jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_failure_code text,
  last_failure_at timestamptz,
  CONSTRAINT meta_plm_collaboration_bindings_sheet_id_key UNIQUE (sheet_id),
  CONSTRAINT meta_plm_collaboration_bindings_collection_key
    UNIQUE (base_id, data_source_id, native_tenant_id, native_org_id, item_id, source_kind),
  CONSTRAINT meta_plm_collaboration_bindings_base_id_fkey
    FOREIGN KEY (base_id) REFERENCES ${s}.meta_bases(id) ON DELETE RESTRICT,
  CONSTRAINT meta_plm_collaboration_bindings_sheet_id_fkey
    FOREIGN KEY (sheet_id) REFERENCES ${s}.meta_sheets(id) ON DELETE RESTRICT,
  CONSTRAINT meta_plm_collaboration_bindings_view_id_fkey
    FOREIGN KEY (view_id) REFERENCES ${s}.meta_views(id) ON DELETE RESTRICT,
  CONSTRAINT meta_plm_collaboration_bindings_kind_check
    CHECK ((source_kind IN ('eco', 'readiness')) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_version_check
    CHECK ((version BETWEEN 1 AND 9007199254740991) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_status_check
    CHECK ((status IN ('active', 'stale', 'disabled')) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_creator_check
    CHECK ((char_length(creator_id) >= 1 AND creator_id = btrim(creator_id)) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_datasource_check
    CHECK ((char_length(data_source_id) BETWEEN 1 AND 128 AND data_source_id = btrim(data_source_id) AND pg_catalog.strpos(data_source_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(data_source_id, pg_catalog.chr(13)) = 0) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_tenant_check
    CHECK ((char_length(native_tenant_id) BETWEEN 1 AND 64 AND native_tenant_id = btrim(native_tenant_id) AND pg_catalog.strpos(native_tenant_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(native_tenant_id, pg_catalog.chr(13)) = 0) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_org_check
    CHECK ((char_length(native_org_id) BETWEEN 1 AND 64 AND native_org_id = btrim(native_org_id) AND pg_catalog.strpos(native_org_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(native_org_id, pg_catalog.chr(13)) = 0) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_item_check
    CHECK ((char_length(item_id) BETWEEN 1 AND 128 AND item_id = btrim(item_id) AND pg_catalog.strpos(item_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(item_id, pg_catalog.chr(13)) = 0) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_current_version_check
    CHECK ((current_version_id IS NULL OR (char_length(current_version_id) BETWEEN 1 AND 128 AND current_version_id = btrim(current_version_id) AND pg_catalog.strpos(current_version_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(current_version_id, pg_catalog.chr(13)) = 0)) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_name_check
    CHECK ((char_length(name) >= 1 AND name = btrim(name)) IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_fingerprint_check
    CHECK ((source_fingerprint ~ '^[0-9a-f]{64}$') IS TRUE),
  CONSTRAINT meta_plm_collaboration_bindings_maps_check
    CHECK ((
      jsonb_typeof(source_fields) = 'object'
      AND jsonb_typeof(local_fields) = 'object'
      AND (
        source_kind <> 'eco'
        OR (
          source_fields - ARRAY[${SOURCE_KEY_SQL}] = '{}'::jsonb
          AND source_fields ?& ARRAY[${SOURCE_KEY_SQL}]
          AND local_fields - ARRAY[${LOCAL_KEY_SQL}] = '{}'::jsonb
          AND local_fields ?& ARRAY[${LOCAL_KEY_SQL}]
        )
      )
    ) IS TRUE)
)`,
    `
CREATE TABLE ${s}.meta_plm_collaboration_previews (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  data_source_id text NOT NULL,
  source_kind text NOT NULL,
  native_tenant_id text NOT NULL,
  native_org_id text NOT NULL,
  item_id text NOT NULL,
  current_version_id text,
  base_id text NOT NULL,
  name text NOT NULL,
  row_key jsonb NOT NULL,
  source_fingerprint text NOT NULL,
  business_hash text NOT NULL,
  captured_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid,
  binding_id uuid,
  consumed_at timestamptz,
  CONSTRAINT meta_plm_collaboration_previews_request_id_key UNIQUE (request_id),
  CONSTRAINT meta_plm_collaboration_previews_binding_id_fkey
    FOREIGN KEY (binding_id) REFERENCES ${s}.meta_plm_collaboration_bindings(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT meta_plm_collaboration_previews_kind_check
    CHECK ((source_kind IN ('eco', 'readiness')) IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_actor_check
    CHECK ((char_length(actor_id) >= 1 AND actor_id = btrim(actor_id)) IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_datasource_check
    CHECK ((char_length(data_source_id) BETWEEN 1 AND 128 AND data_source_id = btrim(data_source_id) AND pg_catalog.strpos(data_source_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(data_source_id, pg_catalog.chr(13)) = 0) IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_tenant_check
    CHECK ((char_length(native_tenant_id) BETWEEN 1 AND 64 AND native_tenant_id = btrim(native_tenant_id) AND pg_catalog.strpos(native_tenant_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(native_tenant_id, pg_catalog.chr(13)) = 0) IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_org_check
    CHECK ((char_length(native_org_id) BETWEEN 1 AND 64 AND native_org_id = btrim(native_org_id) AND pg_catalog.strpos(native_org_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(native_org_id, pg_catalog.chr(13)) = 0) IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_item_check
    CHECK ((char_length(item_id) BETWEEN 1 AND 128 AND item_id = btrim(item_id) AND pg_catalog.strpos(item_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(item_id, pg_catalog.chr(13)) = 0) IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_current_version_check
    CHECK ((current_version_id IS NULL OR (char_length(current_version_id) BETWEEN 1 AND 128 AND current_version_id = btrim(current_version_id) AND pg_catalog.strpos(current_version_id, pg_catalog.chr(10)) = 0 AND pg_catalog.strpos(current_version_id, pg_catalog.chr(13)) = 0)) IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_name_check
    CHECK ((char_length(name) >= 1 AND name = btrim(name)) IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_fingerprint_check
    CHECK ((source_fingerprint ~ '^[0-9a-f]{64}$') IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_hash_check
    CHECK ((business_hash ~ '^[0-9a-f]{64}$') IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_row_key_check
    CHECK ((jsonb_typeof(row_key) = 'array') IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_expiry_check
    CHECK ((expires_at > created_at) IS TRUE),
  CONSTRAINT meta_plm_collaboration_previews_receipt_check
    CHECK ((
      (request_id IS NULL AND binding_id IS NULL AND consumed_at IS NULL)
      OR (request_id IS NOT NULL AND binding_id IS NOT NULL AND consumed_at IS NOT NULL)
    ) IS TRUE)
)`,
    `
CREATE TABLE ${s}.meta_plm_collaboration_rows (
  binding_id uuid NOT NULL,
  row_key jsonb NOT NULL,
  record_id text NOT NULL,
  business_hash text NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meta_plm_collaboration_rows_pkey PRIMARY KEY (binding_id, row_key),
  CONSTRAINT meta_plm_collaboration_rows_record_id_key UNIQUE (record_id),
  CONSTRAINT meta_plm_collaboration_rows_binding_id_fkey
    FOREIGN KEY (binding_id) REFERENCES ${s}.meta_plm_collaboration_bindings(id) ON DELETE RESTRICT,
  CONSTRAINT meta_plm_collaboration_rows_record_id_fkey
    FOREIGN KEY (record_id) REFERENCES ${s}.meta_records(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT meta_plm_collaboration_rows_hash_check
    CHECK ((business_hash ~ '^[0-9a-f]{64}$') IS TRUE),
  CONSTRAINT meta_plm_collaboration_rows_key_check
    CHECK ((jsonb_typeof(row_key) = 'array') IS TRUE)
)`,
    `
CREATE TABLE ${s}.meta_plm_collaboration_syncs (
  id uuid PRIMARY KEY,
  binding_id uuid NOT NULL,
  actor_id text NOT NULL,
  binding_version bigint NOT NULL,
  patches jsonb NOT NULL,
  accepted_txid text NOT NULL DEFAULT pg_catalog.pg_current_xact_id()::text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meta_plm_collaboration_syncs_binding_id_fkey
    FOREIGN KEY (binding_id) REFERENCES ${s}.meta_plm_collaboration_bindings(id) ON DELETE RESTRICT,
  CONSTRAINT meta_plm_collaboration_syncs_actor_check
    CHECK ((char_length(actor_id) >= 1 AND actor_id = btrim(actor_id)) IS TRUE),
  CONSTRAINT meta_plm_collaboration_syncs_version_check
    CHECK ((binding_version BETWEEN 1 AND 9007199254740991) IS TRUE),
  CONSTRAINT meta_plm_collaboration_syncs_patches_check
    CHECK ((jsonb_typeof(patches) = 'object' AND patches <> '{}'::jsonb) IS TRUE)
)`,
    `
CREATE INDEX meta_plm_collaboration_syncs_binding_created_idx
  ON ${s}.meta_plm_collaboration_syncs (binding_id, created_at, id)`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_accepted_sync(record_id text, binding_id uuid)
RETURNS TABLE (actor_id text, patch jsonb)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  sync_id text;
BEGIN
  sync_id := pg_catalog.current_setting('metasheet.plm_collaboration_sync', true);
  IF sync_id IS NULL OR sync_id = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT accepted.actor_id, accepted.patches -> record_id
  FROM ${s}.meta_plm_collaboration_syncs accepted
  JOIN ${s}.meta_plm_collaboration_bindings anchor ON anchor.id = accepted.binding_id
  WHERE accepted.id::text = sync_id
    AND accepted.binding_id = meta_plm_collaboration_accepted_sync.binding_id
    AND accepted.accepted_txid = pg_catalog.pg_current_xact_id()::text
    AND accepted.binding_version = anchor.version
    AND anchor.status = 'active'
    AND anchor.source_kind = 'eco';
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_preview_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  eco_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
  END IF;
  IF NEW.source_kind IS DISTINCT FROM 'eco' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse(
      'meta_plm_collaboration_preview_guard',
      CASE WHEN NEW.source_kind = 'readiness' THEN 'plm_collaboration_readiness_unadmitted' ELSE 'plm_collaboration_source_protected' END
    );
  END IF;
  eco_id := ${s}.meta_plm_collaboration_eco_row_key(NEW.row_key, NEW.data_source_id, NEW.native_tenant_id, NEW.native_org_id);
  IF eco_id IS NULL THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['request_id', 'binding_id', 'consumed_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['request_id', 'binding_id', 'consumed_at']) THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
  END IF;
  IF OLD.request_id IS NULL AND OLD.binding_id IS NULL AND OLD.consumed_at IS NULL
     AND NEW.request_id IS NOT NULL AND NEW.binding_id IS NOT NULL AND NEW.consumed_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM ${s}.meta_plm_collaboration_bindings anchor
       WHERE anchor.id = NEW.binding_id
         AND anchor.data_source_id = NEW.data_source_id
         AND anchor.source_kind = NEW.source_kind
         AND anchor.native_tenant_id = NEW.native_tenant_id
         AND anchor.native_org_id = NEW.native_org_id
         AND anchor.item_id = NEW.item_id
         AND anchor.current_version_id IS NOT DISTINCT FROM NEW.current_version_id
         AND anchor.base_id = NEW.base_id
         AND anchor.source_fingerprint = NEW.source_fingerprint
     ) THEN
    RETURN NEW;
  END IF;
  PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_preview_guard', 'plm_collaboration_source_protected');
  RETURN NULL;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  pair record;
  field record;
  base_row record;
  sheet_row record;
  view_row record;
  expected_type text;
  mutable text[] := ARRAY['version', 'status', 'updated_at', 'last_failure_code', 'last_failure_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  IF NEW.source_kind IS DISTINCT FROM 'eco' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse(
      'meta_plm_collaboration_binding_guard',
      CASE WHEN NEW.source_kind = 'readiness' THEN 'plm_collaboration_readiness_unadmitted' ELSE 'plm_collaboration_source_protected' END
    );
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable)
       OR (OLD.status = 'disabled' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
       OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'active' AND NEW.status IN ('stale', 'disabled'))
         OR (OLD.status = 'stale' AND NEW.status = 'disabled')
       ))
       OR (NEW.version <> OLD.version AND NEW.version <> OLD.version + 1) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> 1 OR NEW.status <> 'active' OR NEW.last_failure_code IS NOT NULL OR NEW.last_failure_at IS NOT NULL THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  IF (
    SELECT count(*) FROM (
      SELECT value FROM jsonb_each_text(NEW.source_fields)
      UNION ALL
      SELECT value FROM jsonb_each_text(NEW.local_fields)
    ) ids
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT value) FROM (
      SELECT value FROM jsonb_each_text(NEW.source_fields)
      UNION ALL
      SELECT value FROM jsonb_each_text(NEW.local_fields)
    ) ids
  ) THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  -- NO KEY UPDATE blocks a concurrent container UPDATE and does not wait on a child FK KEY SHARE.
  SELECT * INTO base_row FROM ${s}.meta_bases WHERE id = NEW.base_id FOR NO KEY UPDATE;
  IF NOT FOUND OR base_row.deleted_at IS NOT NULL THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT * INTO sheet_row FROM ${s}.meta_sheets WHERE id = NEW.sheet_id FOR NO KEY UPDATE;
  IF NOT FOUND OR sheet_row.base_id IS DISTINCT FROM NEW.base_id OR sheet_row.deleted_at IS NOT NULL THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT * INTO view_row FROM ${s}.meta_views WHERE id = NEW.view_id FOR NO KEY UPDATE;
  IF NOT FOUND OR view_row.sheet_id IS DISTINCT FROM NEW.sheet_id OR view_row.deleted_at IS NOT NULL THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
  END IF;
  FOR pair IN
    SELECT mapped.key, mapped.value, mapped.kind
    FROM (
      SELECT key, value, 'source'::text AS kind FROM jsonb_each_text(NEW.source_fields)
      UNION ALL
      SELECT key, value, 'local'::text AS kind FROM jsonb_each_text(NEW.local_fields)
    ) mapped
    ORDER BY mapped.value
  LOOP
    IF pair.value IS NULL OR char_length(pair.value) < 1 OR pair.value <> btrim(pair.value) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
    END IF;
    SELECT id, sheet_id, type, property INTO field FROM ${s}.meta_fields WHERE id = pair.value FOR UPDATE;
    IF NOT FOUND OR field.sheet_id IS DISTINCT FROM NEW.sheet_id THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
    END IF;
    IF pair.kind = 'source' THEN
      IF field.type IS DISTINCT FROM 'string'
         OR field.property -> 'readOnly' IS DISTINCT FROM 'true'::jsonb
         OR ((field.property ? 'readonly') AND field.property -> 'readonly' IS DISTINCT FROM 'true'::jsonb)
         OR field.property -> 'plmCollaborationSnapshot' IS DISTINCT FROM jsonb_build_object('source', true, 'key', pair.key) THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
      END IF;
    ELSE
      expected_type := CASE pair.key
        ${LOCAL_TYPE_CASE}
        ELSE NULL
      END;
      IF field.type IS DISTINCT FROM expected_type
         OR field.property -> 'readOnly' = 'true'::jsonb
         OR field.property -> 'readonly' = 'true'::jsonb
         OR field.property #> '{plmCollaborationSnapshot,source}' = 'true'::jsonb THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
      END IF;
    END IF;
  END LOOP;
  IF to_regclass(${quoteLiteral(`${s}.meta_plm_bom_review_bindings`)}) IS NOT NULL THEN
    PERFORM 1 FROM ${s}.meta_plm_bom_review_bindings WHERE sheet_id = NEW.sheet_id;
    IF FOUND THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_binding_guard', 'plm_collaboration_source_protected');
    END IF;
  END IF;
  RETURN NEW;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_sync_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  anchor record;
  entry record;
  pair record;
  eco_id text;
  physical_ids text[];
  captured timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
  END IF;
  IF NEW.accepted_txid IS DISTINCT FROM pg_catalog.pg_current_xact_id()::text THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT * INTO anchor FROM ${s}.meta_plm_collaboration_bindings WHERE id = NEW.binding_id;
  IF NOT FOUND OR anchor.status <> 'active' OR anchor.source_kind <> 'eco' OR anchor.version <> NEW.binding_version THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT array_agg(value) INTO physical_ids FROM jsonb_each_text(anchor.source_fields);
  FOR entry IN SELECT key, value FROM jsonb_each(NEW.patches) LOOP
    IF char_length(entry.key) < 1 OR entry.key <> btrim(entry.key)
       OR jsonb_typeof(entry.value) IS DISTINCT FROM 'object'
       OR entry.value - ARRAY['row_key', 'data', 'business_hash', 'captured_at'] <> '{}'::jsonb
       OR NOT (entry.value ?& ARRAY['row_key', 'data', 'business_hash', 'captured_at'])
       OR entry.value ->> 'business_hash' !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(entry.value -> 'captured_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(entry.value -> 'data') IS DISTINCT FROM 'object' THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END IF;
    BEGIN
      captured := (entry.value ->> 'captured_at')::timestamptz;
    EXCEPTION
      WHEN invalid_datetime_format OR datetime_field_overflow THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END;
    IF captured IS NULL THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END IF;
    eco_id := ${s}.meta_plm_collaboration_eco_row_key(entry.value -> 'row_key', anchor.data_source_id, anchor.native_tenant_id, anchor.native_org_id);
    IF eco_id IS NULL
       OR (entry.value -> 'data') - physical_ids <> '{}'::jsonb
       OR NOT ((entry.value -> 'data') ?& physical_ids) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
    END IF;
    FOR pair IN SELECT key, value FROM jsonb_each_text(anchor.source_fields) LOOP
      IF NOT ${s}.meta_plm_collaboration_source_value_ok(pair.key, anchor.item_id, eco_id, entry.value -> 'data' -> pair.value) THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_sync_guard', 'plm_collaboration_source_protected');
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  accepted record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_row_guard', 'plm_collaboration_source_protected');
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.binding_id IS DISTINCT FROM OLD.binding_id
       OR NEW.row_key IS DISTINCT FROM OLD.row_key
       OR NEW.record_id IS DISTINCT FROM OLD.record_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_row_guard', 'plm_collaboration_source_protected');
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.business_hash IS NOT DISTINCT FROM OLD.business_hash
     AND NEW.captured_at IS NOT DISTINCT FROM OLD.captured_at THEN
    RETURN NEW;
  END IF;
  SELECT * INTO accepted FROM ${s}.meta_plm_collaboration_accepted_sync(NEW.record_id, NEW.binding_id);
  IF NOT FOUND OR accepted.patch IS NULL
     OR NEW.row_key IS DISTINCT FROM accepted.patch -> 'row_key'
     OR NEW.business_hash IS DISTINCT FROM accepted.patch ->> 'business_hash'
     OR NEW.captured_at IS DISTINCT FROM (accepted.patch ->> 'captured_at')::timestamptz THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_row_guard', 'plm_collaboration_source_protected');
  END IF;
  RETURN NEW;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_record_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  old_binding uuid;
  new_binding uuid;
  anchor record;
  accepted record;
  source_ids text[] := ARRAY[]::text[];
  local_ids text[] := ARRAY[]::text[];
  new_source jsonb := '{}'::jsonb;
  old_source jsonb := '{}'::jsonb;
  new_local jsonb := '{}'::jsonb;
  old_local jsonb := '{}'::jsonb;
  extras jsonb := '{}'::jsonb;
  mapped_key jsonb;
  sync_intent text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings WHERE sheet_id = OLD.sheet_id)
       OR EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_rows WHERE record_id = OLD.id) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
    END IF;
    RETURN OLD;
  END IF;
  SELECT id INTO new_binding FROM ${s}.meta_plm_collaboration_bindings WHERE sheet_id = NEW.sheet_id;
  IF TG_OP = 'UPDATE' THEN
    SELECT id INTO old_binding FROM ${s}.meta_plm_collaboration_bindings WHERE sheet_id = OLD.sheet_id;
  END IF;
  IF new_binding IS NULL AND old_binding IS NULL THEN
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_rows WHERE record_id = OLD.id) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (old_binding IS DISTINCT FROM new_binding OR NEW.id IS DISTINCT FROM OLD.id) THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT * INTO anchor FROM ${s}.meta_plm_collaboration_bindings WHERE id = new_binding;
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO source_ids FROM jsonb_each_text(anchor.source_fields);
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO local_ids FROM jsonb_each_text(anchor.local_fields);
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO new_source
    FROM jsonb_each(NEW.data) WHERE key = ANY(source_ids);
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO extras
    FROM jsonb_each(NEW.data) WHERE NOT (key = ANY(source_ids) OR key = ANY(local_ids));
  IF extras <> '{}'::jsonb THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO old_source
      FROM jsonb_each(OLD.data) WHERE key = ANY(source_ids);
    SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO new_local
      FROM jsonb_each(NEW.data) WHERE key = ANY(local_ids);
    SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO old_local
      FROM jsonb_each(OLD.data) WHERE key = ANY(local_ids);
    sync_intent := pg_catalog.current_setting('metasheet.plm_collaboration_sync', true);
    -- Exact native lock/unlock only, and only with no explicit sync intent.
    -- A nonempty metasheet.plm_collaboration_sync must not take this branch.
    IF (to_jsonb(NEW) - ARRAY['locked', 'locked_by', 'locked_at', 'version', 'updated_at'])
       IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['locked', 'locked_by', 'locked_at', 'version', 'updated_at'])
       AND NEW.version IS NOT DISTINCT FROM OLD.version + 1
       AND (
         (NEW.locked IS TRUE AND NEW.locked_by IS NOT NULL AND char_length(btrim(NEW.locked_by)) >= 1 AND NEW.locked_at IS NOT NULL)
         OR (NEW.locked IS FALSE AND NEW.locked_by IS NULL AND NEW.locked_at IS NULL)
       )
       AND (sync_intent IS NULL OR sync_intent = '')
       AND EXISTS (
         SELECT 1 FROM ${s}.meta_plm_collaboration_rows
         WHERE binding_id = anchor.id AND record_id = NEW.id
       ) THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['data', 'version', 'modified_by', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['data', 'version', 'modified_by', 'updated_at'])
       OR (NEW.version IS DISTINCT FROM OLD.version AND NEW.version IS DISTINCT FROM OLD.version + 1) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
    END IF;
    IF new_local IS DISTINCT FROM old_local AND NEW.version IS DISTINCT FROM OLD.version + 1 THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
    END IF;
  END IF;
  SELECT row_key INTO mapped_key
  FROM ${s}.meta_plm_collaboration_rows
  WHERE binding_id = anchor.id AND record_id = NEW.id;
  IF NOT FOUND THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
  END IF;
  -- Nonempty family sync intent validates the receipt even when the source postimage is unchanged.
  IF TG_OP = 'INSERT' OR new_source IS DISTINCT FROM old_source
     OR (sync_intent IS NOT NULL AND sync_intent <> '') THEN
    SELECT * INTO accepted FROM ${s}.meta_plm_collaboration_accepted_sync(NEW.id, anchor.id);
    IF NOT FOUND OR accepted.patch IS NULL
       OR new_source IS DISTINCT FROM (accepted.patch -> 'data')
       OR (accepted.patch -> 'row_key') IS DISTINCT FROM mapped_key THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.version IS DISTINCT FROM 1
         OR NEW.created_by IS DISTINCT FROM accepted.actor_id
         OR NEW.modified_by IS DISTINCT FROM accepted.actor_id
         OR COALESCE(NEW.locked, false)
         OR NEW.locked_by IS NOT NULL
         OR EXISTS (SELECT 1 FROM jsonb_each(NEW.data) cell WHERE cell.key = ANY(local_ids)) THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
      END IF;
    ELSE
      IF new_local IS DISTINCT FROM old_local
         OR NEW.modified_by IS DISTINCT FROM accepted.actor_id
         OR NEW.version IS DISTINCT FROM OLD.version + 1
         OR NEW.locked IS DISTINCT FROM OLD.locked
         OR NEW.locked_by IS DISTINCT FROM OLD.locked_by
         OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_record_guard', 'plm_collaboration_source_protected');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_field_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  probed text[] := CASE WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.id] ELSE ARRAY[OLD.id, NEW.id] END;
  anchor record;
  logical_key text;
  local_key text;
  expected_type text;
  sheet_bound boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings WHERE sheet_id = NEW.sheet_id) INTO sheet_bound;
    IF sheet_bound THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_field_guard', 'plm_collaboration_source_protected');
    END IF;
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM ${s}.meta_plm_collaboration_bindings
    WHERE sheet_id = OLD.sheet_id OR (TG_OP = 'UPDATE' AND sheet_id = NEW.sheet_id)
  ) INTO sheet_bound;
  SELECT id, sheet_id, source_fields, local_fields INTO anchor
  FROM ${s}.meta_plm_collaboration_bindings binding
  WHERE EXISTS (SELECT 1 FROM jsonb_each_text(binding.source_fields) field WHERE field.value = ANY(probed))
     OR EXISTS (SELECT 1 FROM jsonb_each_text(binding.local_fields) field WHERE field.value = ANY(probed))
  LIMIT 1;
  IF NOT FOUND THEN
    IF sheet_bound THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_field_guard', 'plm_collaboration_source_protected');
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_field_guard', 'plm_collaboration_source_protected');
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR NEW.type IS DISTINCT FROM OLD.type THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_field_guard', 'plm_collaboration_source_protected');
  END IF;
  SELECT key INTO logical_key FROM jsonb_each_text(anchor.source_fields) field WHERE field.value = OLD.id;
  IF FOUND THEN
    IF NEW.type IS DISTINCT FROM 'string'
       OR NEW.property -> 'readOnly' IS DISTINCT FROM 'true'::jsonb
       OR ((NEW.property ? 'readonly') AND NEW.property -> 'readonly' IS DISTINCT FROM 'true'::jsonb)
       OR NEW.property -> 'plmCollaborationSnapshot' IS DISTINCT FROM jsonb_build_object('source', true, 'key', logical_key) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_field_guard', 'plm_collaboration_source_protected');
    END IF;
    RETURN NEW;
  END IF;
  SELECT key INTO local_key FROM jsonb_each_text(anchor.local_fields) field WHERE field.value = OLD.id;
  expected_type := CASE local_key
    ${LOCAL_TYPE_CASE}
    ELSE NULL
  END;
  IF NEW.type IS DISTINCT FROM expected_type
     OR NEW.property -> 'readOnly' = 'true'::jsonb
     OR NEW.property -> 'readonly' = 'true'::jsonb
     OR NEW.property #> '{plmCollaborationSnapshot,source}' = 'true'::jsonb THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_field_guard', 'plm_collaboration_source_protected');
  END IF;
  RETURN NEW;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_container_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'meta_sheets' THEN
    IF TG_OP = 'DELETE' THEN
      IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings WHERE sheet_id = OLD.id) THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_container_guard', 'plm_collaboration_source_protected');
      END IF;
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings WHERE sheet_id IN (OLD.id, NEW.id))
       AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.base_id IS DISTINCT FROM OLD.base_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_container_guard', 'plm_collaboration_source_protected');
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'meta_bases' THEN
    IF TG_OP = 'DELETE' THEN
      IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings WHERE base_id = OLD.id) THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_container_guard', 'plm_collaboration_source_protected');
      END IF;
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings WHERE base_id IN (OLD.id, NEW.id))
       AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
         OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_container_guard', 'plm_collaboration_source_protected');
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'meta_views' THEN
    IF TG_OP = 'DELETE' THEN
      IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings WHERE view_id = OLD.id) THEN
        PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_container_guard', 'plm_collaboration_source_protected');
      END IF;
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings WHERE view_id IN (OLD.id, NEW.id))
       AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_container_guard', 'plm_collaboration_source_protected');
    END IF;
    RETURN NEW;
  END IF;
  PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_container_guard', 'plm_collaboration_source_protected');
  RETURN NULL;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_truncate_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_TABLE_NAME IN ('meta_records', 'meta_fields', 'meta_sheets', 'meta_bases', 'meta_views') THEN
    IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_truncate_guard', 'plm_collaboration_source_protected');
    END IF;
  ELSIF TG_TABLE_NAME = 'meta_plm_collaboration_previews' THEN
    IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_previews) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_truncate_guard', 'plm_collaboration_source_protected');
    END IF;
  ELSIF TG_TABLE_NAME = 'meta_plm_collaboration_bindings' THEN
    IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_bindings) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_truncate_guard', 'plm_collaboration_source_protected');
    END IF;
  ELSIF TG_TABLE_NAME = 'meta_plm_collaboration_rows' THEN
    IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_rows) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_truncate_guard', 'plm_collaboration_source_protected');
    END IF;
  ELSIF TG_TABLE_NAME = 'meta_plm_collaboration_syncs' THEN
    IF EXISTS (SELECT 1 FROM ${s}.meta_plm_collaboration_syncs) THEN
      PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_truncate_guard', 'plm_collaboration_source_protected');
    END IF;
  END IF;
  RETURN NULL;
END
$fn$`,
    `
CREATE FUNCTION ${s}.meta_plm_collaboration_commit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  record_sheet text;
  binding_sheet text;
BEGIN
  SELECT sheet_id INTO record_sheet FROM ${s}.meta_records WHERE id = NEW.record_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT sheet_id INTO binding_sheet FROM ${s}.meta_plm_collaboration_bindings WHERE id = NEW.binding_id;
  IF record_sheet IS DISTINCT FROM binding_sheet THEN
    PERFORM ${s}.meta_plm_collaboration_refuse('meta_plm_collaboration_commit_guard', 'plm_collaboration_source_protected');
  END IF;
  RETURN NULL;
END
$fn$`,
    `CREATE TRIGGER meta_plm_collaboration_preview_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.meta_plm_collaboration_previews FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_preview_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.meta_plm_collaboration_bindings FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_binding_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_sync_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.meta_plm_collaboration_syncs FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_sync_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_row_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.meta_plm_collaboration_rows FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_row_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_record_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.meta_records FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_record_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_field_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.meta_fields FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_field_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_sheets_guard BEFORE UPDATE OR DELETE ON ${s}.meta_sheets FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_container_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_bases_guard BEFORE UPDATE OR DELETE ON ${s}.meta_bases FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_container_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_views_guard BEFORE UPDATE OR DELETE ON ${s}.meta_views FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_container_guard()`,
    `
CREATE CONSTRAINT TRIGGER meta_plm_collaboration_commit_guard
  AFTER INSERT OR UPDATE ON ${s}.meta_plm_collaboration_rows
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ${s}.meta_plm_collaboration_commit_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_records_truncate BEFORE TRUNCATE ON ${s}.meta_records FOR EACH STATEMENT EXECUTE FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_fields_truncate BEFORE TRUNCATE ON ${s}.meta_fields FOR EACH STATEMENT EXECUTE FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_sheets_truncate BEFORE TRUNCATE ON ${s}.meta_sheets FOR EACH STATEMENT EXECUTE FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_bases_truncate BEFORE TRUNCATE ON ${s}.meta_bases FOR EACH STATEMENT EXECUTE FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_views_truncate BEFORE TRUNCATE ON ${s}.meta_views FOR EACH STATEMENT EXECUTE FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_previews_truncate BEFORE TRUNCATE ON ${s}.meta_plm_collaboration_previews FOR EACH STATEMENT EXECUTE FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_bindings_truncate BEFORE TRUNCATE ON ${s}.meta_plm_collaboration_bindings FOR EACH STATEMENT EXECUTE FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_rows_truncate BEFORE TRUNCATE ON ${s}.meta_plm_collaboration_rows FOR EACH STATEMENT EXECUTE FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
    `CREATE TRIGGER meta_plm_collaboration_syncs_truncate BEFORE TRUNCATE ON ${s}.meta_plm_collaboration_syncs FOR EACH STATEMENT EXECUTE FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
  ]
}

function dropStatements(ident: string): string[] {
  const s = ident
  const shared = [
    ['meta_plm_collaboration_record_guard', 'meta_records'],
    ['meta_plm_collaboration_records_truncate', 'meta_records'],
    ['meta_plm_collaboration_field_guard', 'meta_fields'],
    ['meta_plm_collaboration_fields_truncate', 'meta_fields'],
    ['meta_plm_collaboration_sheets_guard', 'meta_sheets'],
    ['meta_plm_collaboration_sheets_truncate', 'meta_sheets'],
    ['meta_plm_collaboration_bases_guard', 'meta_bases'],
    ['meta_plm_collaboration_bases_truncate', 'meta_bases'],
    ['meta_plm_collaboration_views_guard', 'meta_views'],
    ['meta_plm_collaboration_views_truncate', 'meta_views'],
  ]
  return [
    ...shared.map(([trigger, table]) => `DROP TRIGGER ${trigger} ON ${s}.${table}`),
    `DROP TABLE ${s}.meta_plm_collaboration_syncs`,
    `DROP TABLE ${s}.meta_plm_collaboration_rows`,
    `DROP TABLE ${s}.meta_plm_collaboration_previews`,
    `DROP TABLE ${s}.meta_plm_collaboration_bindings`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_preview_guard()`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_binding_guard()`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_sync_guard()`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_row_guard()`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_record_guard()`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_field_guard()`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_container_guard()`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_truncate_guard()`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_commit_guard()`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_accepted_sync(text, uuid)`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_source_value_ok(text, text, text, jsonb)`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_eco_row_key(jsonb, text, text, text)`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_native_timestamp(text)`,
    `DROP FUNCTION ${s}.meta_plm_collaboration_refuse(text, text)`,
  ]
}

// Kysely 0.28.8 throws if transaction() is called on a Transaction. The migrator and an
// outer test transaction already own one; a plain Kysely opens one so DDL stays atomic.
async function withOwnedTransaction(
  db: Kysely<unknown>,
  run: (trx: Kysely<unknown>) => Promise<void>,
): Promise<void> {
  if (db.isTransaction) {
    await run(db)
    return
  }
  await db.transaction().execute(run)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await withOwnedTransaction(db, async (trx) => {
    const schema = await servingSchema(trx)
    await sql.raw(preflightSql(schema)).execute(trx)
    for (const statement of createStatements(schema.ident)) {
      await sql.raw(statement).execute(trx)
    }
  })
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withOwnedTransaction(db, async (trx) => {
    const schema = await servingSchema(trx)
    await sql.raw(`
      DO $absent$
      BEGIN
        IF (
          SELECT count(*)
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = ${quoteLiteral(schema.name)}
            AND relation.relkind = 'r'
            AND relation.relname IN (${NEW_RELATIONS.map((name) => quoteLiteral(name)).join(', ')})
        ) <> 4 THEN
          RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'plm_collaboration_relations_absent',
            CONSTRAINT = 'meta_plm_collaboration_predecessor_guard';
        END IF;
      END
      $absent$
    `).execute(trx)
    await sql.raw(`
      DO $iso$
      DECLARE
        iso text;
      BEGIN
        SHOW transaction_isolation INTO iso;
        IF iso IS DISTINCT FROM 'read committed' THEN
          RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'plm_collaboration_snapshot_stale',
            CONSTRAINT = 'meta_plm_collaboration_snapshot_guard';
        END IF;
      END
      $iso$
    `).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_plm_collaboration_previews IN ACCESS EXCLUSIVE MODE`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_plm_collaboration_bindings IN ACCESS EXCLUSIVE MODE`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_plm_collaboration_rows IN ACCESS EXCLUSIVE MODE`).execute(trx)
    await sql.raw(`LOCK TABLE ${schema.ident}.meta_plm_collaboration_syncs IN ACCESS EXCLUSIVE MODE`).execute(trx)
    await sql.raw(`
      DO $evidence$
      BEGIN
        IF EXISTS (SELECT 1 FROM ${schema.ident}.meta_plm_collaboration_previews)
           OR EXISTS (SELECT 1 FROM ${schema.ident}.meta_plm_collaboration_bindings)
           OR EXISTS (SELECT 1 FROM ${schema.ident}.meta_plm_collaboration_rows)
           OR EXISTS (SELECT 1 FROM ${schema.ident}.meta_plm_collaboration_syncs) THEN
          RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'plm_collaboration_source_evidence_present',
            CONSTRAINT = 'meta_plm_collaboration_evidence_guard';
        END IF;
      END
      $evidence$
    `).execute(trx)
    for (const statement of dropStatements(schema.ident)) {
      await sql.raw(statement).execute(trx)
    }
  })
}
