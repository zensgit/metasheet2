import { sql, type Kysely } from 'kysely'

/**
 * Phase D2: durable PUT+HEAD receipt authority for generic archive objects.
 *
 * This table is deliberately separate from abandoned-build staging cleanup inventory and from
 * attachment source pins. It records no URI, provider response, nonce, or key material and has no
 * production writer in this slice.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      source_mismatch_count integer;
      owned_object_count integer;
      parent_trigger_count integer;
      attachment_trigger_count integer;
      key_reference_function_count integer;
      key_reference_trigger_count integer;
      key_reference_constraint_count integer;
      source_authority_function_count integer;
      source_authority_trigger_count integer;
      source_authority_constraint_count integer;
    BEGIN
      WITH expected(relation_name, column_name, type_name, is_not_null) AS (
        VALUES
          ('meta_recovery_archives', 'generation_id', 'uuid', true),
          ('meta_recovery_archives', 'state', 'text', true),
          ('meta_recovery_archives', 'build_status', 'text', true),
          ('meta_recovery_archives', 'coverage_status', 'text', true),
          ('meta_recovery_archives', 'key_id', 'text', true),
          ('meta_recovery_archives', 'owner_kind', 'text', true),
          ('meta_recovery_archives', 'owner_id', 'text', true),
          ('meta_recovery_archives', 'owner_fence', 'bigint', true),
          ('meta_recovery_archives', 'lease_expires_at', 'timestamp with time zone', true),
          ('meta_recovery_archive_attachment_refs', 'generation_id', 'uuid', true),
          ('meta_recovery_archive_attachment_refs', 'attachment_id', 'text', true),
          ('meta_recovery_archive_attachment_refs', 'reference_class', 'text', true),
          ('meta_recovery_archive_attachment_refs', 'reference_state', 'text', true),
          ('meta_recovery_archive_attachment_refs', 'availability', 'text', true),
          ('meta_recovery_archive_attachment_refs', 'content_sha256', 'text', false),
          ('meta_recovery_archive_attachment_refs', 'source_owner_kind', 'text', false),
          ('meta_recovery_archive_attachment_refs', 'source_owner_id', 'text', false),
          ('meta_recovery_archive_attachment_refs', 'source_owner_fence', 'bigint', false),
          ('meta_recovery_archive_attachment_refs', 'source_lease_until', 'timestamp with time zone', false),
          ('meta_recovery_archive_attachment_refs', 'immutable_version', 'text', false),
          ('meta_recovery_archive_attachment_refs', 'content_size_bytes', 'bigint', false)
      )
      SELECT count(*)::integer
        INTO source_mismatch_count
        FROM expected
        LEFT JOIN pg_catalog.pg_class relation
          ON relation.oid = pg_catalog.to_regclass('public.' || expected.relation_name)
         AND relation.relkind = 'r'
        LEFT JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
         AND namespace.nspname = 'public'
        LEFT JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attname = expected.column_name
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       WHERE namespace.oid IS NULL
          OR attribute.attnum IS NULL
          OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) <> expected.type_name
          OR attribute.attnotnull <> expected.is_not_null;

      SELECT count(*)::integer
        INTO parent_trigger_count
        FROM pg_catalog.pg_trigger trigger_row
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
        JOIN pg_catalog.pg_namespace procedure_namespace ON procedure_namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archives'
         AND trigger_row.tgname = 'trg_meta_recovery_archives_guard_row'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 31
         AND procedure_namespace.nspname = 'public'
         AND procedure_row.proname = 'meta_recovery_archives_guard_row'
         AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
         AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND procedure_row.provolatile = 'v'
         AND NOT procedure_row.prosecdef
         AND procedure_row.prokind = 'f'
         AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
         AND pg_catalog.md5(procedure_row.prosrc) = '3700d86df374ad924cc4b6af265d146a'
         AND trigger_row.tgconstraint = 0
         AND NOT trigger_row.tgdeferrable
         AND NOT trigger_row.tginitdeferred;

      SELECT count(*)::integer
        INTO key_reference_function_count
        FROM pg_catalog.pg_proc procedure_row
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure_row.proname = 'meta_recovery_archive_key_reference_guard_row'
         AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
         AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND procedure_row.provolatile = 'v'
         AND NOT procedure_row.prosecdef
         AND procedure_row.prokind = 'f'
         AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
         AND pg_catalog.md5(procedure_row.prosrc) = '4a3c9f836f9efe6036f96e67bb050a70';

      SELECT count(*)::integer
        INTO key_reference_trigger_count
        FROM pg_catalog.pg_trigger trigger_row
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
        JOIN pg_catalog.pg_namespace procedure_namespace ON procedure_namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archives'
         AND trigger_row.tgname = 'trg_meta_recovery_archive_key_reference_guard_row'
         AND trigger_row.tgtype = 7
         AND trigger_row.tgenabled = 'O'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgconstraint = 0
         AND NOT trigger_row.tgdeferrable
         AND NOT trigger_row.tginitdeferred
         AND procedure_namespace.nspname = 'public'
         AND procedure_row.proname = 'meta_recovery_archive_key_reference_guard_row';

      SELECT count(*)::integer
        INTO key_reference_constraint_count
        FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'public.meta_recovery_archives'::pg_catalog.regclass
         AND constraint_row.conname = 'fk_meta_recovery_archives_key'
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid = 'public.meta_recovery_archive_keys'::pg_catalog.regclass
         AND constraint_row.conkey = ARRAY[
           (SELECT attribute.attnum
              FROM pg_catalog.pg_attribute attribute
             WHERE attribute.attrelid = 'public.meta_recovery_archives'::pg_catalog.regclass
               AND attribute.attname = 'key_id'
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped)
         ]::smallint[]
         AND constraint_row.confkey = ARRAY[
           (SELECT attribute.attnum
              FROM pg_catalog.pg_attribute attribute
             WHERE attribute.attrelid = 'public.meta_recovery_archive_keys'::pg_catalog.regclass
               AND attribute.attname = 'key_id'
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped)
         ]::smallint[]
         AND constraint_row.confupdtype = 'r'
         AND constraint_row.confdeltype = 'r'
         AND NOT constraint_row.condeferrable
         AND NOT constraint_row.condeferred
         AND constraint_row.convalidated;

      SELECT count(*)::integer
        INTO attachment_trigger_count
        FROM pg_catalog.pg_trigger trigger_row
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
        JOIN pg_catalog.pg_namespace procedure_namespace ON procedure_namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archive_attachment_refs'
         AND trigger_row.tgname = 'trg_meta_recovery_archive_attachment_ref_guard_row'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 31
         AND procedure_namespace.nspname = 'public'
         AND procedure_row.proname = 'meta_recovery_archive_attachment_ref_cleanup_guard_row'
         AND procedure_row.pronargs = 0
         AND procedure_row.prorettype = 'trigger'::regtype;

      SELECT count(*)::integer
        INTO source_authority_function_count
        FROM pg_catalog.pg_proc procedure_row
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure_row.proname = 'meta_recovery_archive_attachment_authority_guard_row'
         AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
         AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND procedure_row.provolatile = 'v'
         AND NOT procedure_row.prosecdef
         AND procedure_row.prokind = 'f'
         AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
         AND pg_catalog.md5(procedure_row.prosrc) = '51f169ec069dd3f0c2fa4c112866e2e9';

      SELECT count(*)::integer
        INTO source_authority_trigger_count
        FROM pg_catalog.pg_trigger trigger_row
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archive_attachment_refs'
         AND trigger_row.tgname = 'trg_meta_recovery_archive_attachment_authority_guard_row'
         AND trigger_row.tgtype = 31
         AND trigger_row.tgenabled = 'O'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgconstraint = 0
         AND NOT trigger_row.tgdeferrable
         AND NOT trigger_row.tginitdeferred
         AND procedure_row.proname = 'meta_recovery_archive_attachment_authority_guard_row';

      SELECT CASE
        WHEN count(*) = 4 AND pg_catalog.md5(
          string_agg(
            constraint_row.conname || '=' ||
            pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
            E'\n' ORDER BY constraint_row.conname
          )
        ) = 'd4d33979c13a79e96c1a72e71e9fb15e' THEN 1
        ELSE 0
      END
        INTO source_authority_constraint_count
        FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'public.meta_recovery_archive_attachment_refs'::regclass
         AND constraint_row.conname IN (
           'chk_meta_recovery_archive_attachment_source_owner_tuple',
           'chk_meta_recovery_archive_attachment_immutable_version',
           'chk_meta_recovery_archive_attachment_content_size',
           'chk_meta_recovery_archive_attachment_authority_shape'
         );

      IF source_mismatch_count <> 0
         OR parent_trigger_count <> 1
         OR attachment_trigger_count <> 1
         OR key_reference_function_count <> 1
         OR key_reference_trigger_count <> 1
         OR key_reference_constraint_count <> 1
         OR source_authority_function_count <> 1
         OR source_authority_trigger_count <> 1
         OR source_authority_constraint_count <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_receipt_source_schema_mismatch';
      END IF;

      SELECT (
        (SELECT count(*) FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname IN (
             'meta_recovery_archive_objects',
             'uq_meta_recovery_archive_objects_idempotency',
             'idx_meta_recovery_archive_object_section_slot',
             'idx_meta_recovery_archive_object_attachment_slot',
             'idx_meta_recovery_archive_object_manifest_slot'
           )) +
        (SELECT count(*) FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_recovery_archive_object_guard_row',
             'meta_recovery_archive_object_finalize_guard_row',
             'meta_recovery_archive_object_parent_guard_row'
           )) +
        (SELECT count(*) FROM pg_catalog.pg_trigger trigger_row
         WHERE trigger_row.tgname IN (
           'trg_meta_recovery_archive_object_guard_row',
           'trg_meta_recovery_archive_object_finalize_guard_row',
           'trg_meta_recovery_archives_object_parent_guard_row'
         ) AND NOT trigger_row.tgisinternal)
      )::integer INTO owned_object_count;

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_receipt_object_conflict';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_objects (
      generation_id uuid NOT NULL,
      object_id text NOT NULL,
      object_class text NOT NULL,
      section_name text,
      attachment_id text,
      key_id text NOT NULL,
      provider_version text NOT NULL,
      plaintext_sha256 text NOT NULL,
      ciphertext_sha256 text NOT NULL,
      size_bytes bigint NOT NULL,
      idempotency_key text NOT NULL,
      put_receipt_sha256 text NOT NULL,
      head_receipt_sha256 text NOT NULL,
      owner_kind text NOT NULL,
      owner_id text NOT NULL,
      owner_fence bigint NOT NULL,
      state text NOT NULL DEFAULT 'uploaded',
      created_at timestamptz NOT NULL DEFAULT now(),
      verified_at timestamptz,
      CONSTRAINT pk_meta_recovery_archive_objects PRIMARY KEY (generation_id, object_id),
      CONSTRAINT uq_meta_recovery_archive_objects_idempotency
        UNIQUE (generation_id, idempotency_key),
      CONSTRAINT fk_meta_recovery_archive_objects_generation
        FOREIGN KEY (generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT chk_meta_recovery_archive_objects_object_id
        CHECK (object_id ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archive_objects_class
        CHECK (object_class IN ('section', 'attachment', 'manifest')),
      CONSTRAINT chk_meta_recovery_archive_objects_shape CHECK (
        (
          object_class = 'section' AND
          section_name IN (
            'schema',
            'records',
            'links',
            'field_value_tombstones',
            'link_tombstones',
            'auto_number',
            'attachments_index',
            'permission_evidence',
            'views_config',
            'coverage_index'
          ) AND
          attachment_id IS NULL
        ) OR (
          object_class = 'attachment' AND
          section_name IS NULL AND
          attachment_id IS NOT NULL AND
          length(btrim(attachment_id)) > 0
        ) OR (
          object_class = 'manifest' AND
          section_name IS NULL AND
          attachment_id IS NULL
        )
      ),
      CONSTRAINT chk_meta_recovery_archive_objects_key_id
        CHECK (length(btrim(key_id)) > 0 AND length(key_id) <= 512),
      CONSTRAINT chk_meta_recovery_archive_objects_provider_version
        CHECK (length(btrim(provider_version)) > 0 AND length(provider_version) <= 512),
      CONSTRAINT chk_meta_recovery_archive_objects_plaintext_sha256
        CHECK (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archive_objects_ciphertext_sha256
        CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archive_objects_size_bytes CHECK (size_bytes >= 0),
      CONSTRAINT chk_meta_recovery_archive_objects_idempotency_key
        CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archive_objects_put_receipt
        CHECK (put_receipt_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archive_objects_head_receipt
        CHECK (head_receipt_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archive_objects_owner
        CHECK (
          length(btrim(owner_kind)) > 0 AND length(owner_kind) <= 512 AND
          length(btrim(owner_id)) > 0 AND length(owner_id) <= 512 AND
          owner_fence >= 1
        ),
      CONSTRAINT chk_meta_recovery_archive_objects_state
        CHECK (state IN ('uploaded', 'verified')),
      CONSTRAINT chk_meta_recovery_archive_objects_state_shape CHECK (
        (state = 'uploaded' AND verified_at IS NULL) OR
        (state = 'verified' AND verified_at IS NOT NULL)
      )
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX idx_meta_recovery_archive_object_section_slot
      ON public.meta_recovery_archive_objects(generation_id, section_name)
      WHERE object_class = 'section'
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX idx_meta_recovery_archive_object_attachment_slot
      ON public.meta_recovery_archive_objects(generation_id, attachment_id)
      WHERE object_class = 'attachment'
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX idx_meta_recovery_archive_object_manifest_slot
      ON public.meta_recovery_archive_objects(generation_id)
      WHERE object_class = 'manifest'
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_object_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      parent_state text;
      parent_build_status text;
      parent_coverage_status text;
      parent_key_id text;
      parent_owner_kind text;
      parent_owner_id text;
      parent_owner_fence bigint;
      parent_lease_expires_at timestamptz;
      resolved_key_id text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_delete_not_authorized';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.state IS NULL OR NEW.state <> 'uploaded' OR NEW.verified_at IS NOT NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_object_initial_posture_invalid';
        END IF;

        IF NEW.generation_id IS NULL
           OR NEW.object_id IS NULL
           OR NEW.object_id !~ '^[0-9a-f]{64}$'
           OR NEW.object_class IS NULL
           OR NEW.object_class NOT IN ('section', 'attachment', 'manifest')
           OR (
             NEW.object_class = 'section' AND (
               NEW.section_name IS NULL
               OR NEW.section_name NOT IN (
                 'schema',
                 'records',
                 'links',
                 'field_value_tombstones',
                 'link_tombstones',
                 'auto_number',
                 'attachments_index',
                 'permission_evidence',
                 'views_config',
                 'coverage_index'
               )
               OR NEW.attachment_id IS NOT NULL
             )
           )
           OR (
             NEW.object_class = 'attachment' AND (
               NEW.section_name IS NOT NULL
               OR NEW.attachment_id IS NULL
               OR length(btrim(NEW.attachment_id)) = 0
             )
           )
           OR (
             NEW.object_class = 'manifest' AND (
               NEW.section_name IS NOT NULL
               OR NEW.attachment_id IS NOT NULL
             )
           )
           OR NEW.key_id IS NULL
           OR length(btrim(NEW.key_id)) = 0
           OR length(NEW.key_id) > 512
           OR NEW.provider_version IS NULL
           OR length(btrim(NEW.provider_version)) = 0
           OR length(NEW.provider_version) > 512
           OR NEW.plaintext_sha256 IS NULL
           OR NEW.plaintext_sha256 !~ '^[0-9a-f]{64}$'
           OR NEW.ciphertext_sha256 IS NULL
           OR NEW.ciphertext_sha256 !~ '^[0-9a-f]{64}$'
           OR NEW.size_bytes IS NULL
           OR NEW.size_bytes < 0
           OR NEW.idempotency_key IS NULL
           OR NEW.idempotency_key !~ '^[0-9a-f]{64}$'
           OR NEW.put_receipt_sha256 IS NULL
           OR NEW.put_receipt_sha256 !~ '^[0-9a-f]{64}$'
           OR NEW.head_receipt_sha256 IS NULL
           OR NEW.head_receipt_sha256 !~ '^[0-9a-f]{64}$'
           OR NEW.owner_kind IS NULL
           OR length(btrim(NEW.owner_kind)) = 0
           OR length(NEW.owner_kind) > 512
           OR NEW.owner_id IS NULL
           OR length(btrim(NEW.owner_id)) = 0
           OR length(NEW.owner_id) > 512
           OR NEW.owner_fence IS NULL
           OR NEW.owner_fence < 1
           OR NEW.created_at IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_object_shape_invalid';
        END IF;
      ELSE
        IF OLD.state = 'verified' OR
           NEW.generation_id IS DISTINCT FROM OLD.generation_id OR
           NEW.object_id IS DISTINCT FROM OLD.object_id OR
           NEW.object_class IS DISTINCT FROM OLD.object_class OR
           NEW.section_name IS DISTINCT FROM OLD.section_name OR
           NEW.attachment_id IS DISTINCT FROM OLD.attachment_id OR
           NEW.key_id IS DISTINCT FROM OLD.key_id OR
           NEW.provider_version IS DISTINCT FROM OLD.provider_version OR
           NEW.plaintext_sha256 IS DISTINCT FROM OLD.plaintext_sha256 OR
           NEW.ciphertext_sha256 IS DISTINCT FROM OLD.ciphertext_sha256 OR
           NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR
           NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
           NEW.put_receipt_sha256 IS DISTINCT FROM OLD.put_receipt_sha256 OR
           NEW.head_receipt_sha256 IS DISTINCT FROM OLD.head_receipt_sha256 OR
           NEW.owner_kind IS DISTINCT FROM OLD.owner_kind OR
           NEW.owner_id IS DISTINCT FROM OLD.owner_id OR
           NEW.owner_fence IS DISTINCT FROM OLD.owner_fence OR
           NEW.created_at IS DISTINCT FROM OLD.created_at OR
           OLD.state <> 'uploaded' OR
           NEW.state <> 'verified' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_object_immutable';
        END IF;
        NEW.verified_at := clock_timestamp();
      END IF;

      SELECT archive.key_id
        INTO resolved_key_id
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_parent_stale';
      END IF;

      PERFORM 1
        FROM public.meta_recovery_archive_keys key_row
       WHERE key_row.key_id = resolved_key_id
         AND key_row.state = 'active'
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_parent_stale';
      END IF;

      SELECT archive.state,
             archive.build_status,
             archive.coverage_status,
             archive.key_id,
             archive.owner_kind,
             archive.owner_id,
             archive.owner_fence,
             archive.lease_expires_at
        INTO parent_state,
             parent_build_status,
             parent_coverage_status,
             parent_key_id,
             parent_owner_kind,
             parent_owner_id,
             parent_owner_fence,
             parent_lease_expires_at
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id
       FOR UPDATE;

      IF NOT FOUND OR
         parent_state <> 'building' OR
         parent_build_status <> 'active' OR
         parent_coverage_status <> 'incomplete' OR
         parent_key_id IS DISTINCT FROM resolved_key_id OR
         parent_key_id IS DISTINCT FROM NEW.key_id OR
         parent_owner_kind IS DISTINCT FROM NEW.owner_kind OR
         parent_owner_id IS DISTINCT FROM NEW.owner_id OR
         parent_owner_fence IS DISTINCT FROM NEW.owner_fence OR
         parent_lease_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_parent_stale';
      END IF;

      IF NEW.object_class = 'attachment' AND NOT EXISTS (
        SELECT 1
          FROM public.meta_recovery_archive_attachment_refs source_ref
         WHERE source_ref.generation_id = NEW.generation_id
           AND source_ref.attachment_id = NEW.attachment_id
           AND source_ref.reference_class = 'source'
           AND source_ref.reference_state = 'building'
           AND source_ref.availability = 'available'
           AND source_ref.content_sha256 = NEW.plaintext_sha256
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_source_pin_invalid';
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_object_finalize_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM public.meta_recovery_archives archive
         WHERE archive.generation_id = NEW.generation_id
           AND archive.state = 'verified'
           AND archive.build_status = 'finalized'
           AND archive.coverage_status = 'complete'
           AND archive.key_id IS NOT DISTINCT FROM NEW.key_id
           AND archive.owner_kind IS NOT DISTINCT FROM NEW.owner_kind
           AND archive.owner_id IS NOT DISTINCT FROM NEW.owner_id
           AND archive.owner_fence IS NOT DISTINCT FROM NEW.owner_fence
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_finalize_transaction_required';
      END IF;

      RETURN NULL;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_object_parent_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      verified_section_count integer;
      verified_manifest_count integer;
    BEGIN
      IF OLD.state = 'building' AND NEW.state = 'verified' THEN
        IF OLD.lease_expires_at <= clock_timestamp() OR EXISTS (
          SELECT 1
            FROM public.meta_recovery_archive_objects archive_object
           WHERE archive_object.generation_id = NEW.generation_id
             AND (
               archive_object.state <> 'verified' OR
               archive_object.key_id IS DISTINCT FROM OLD.key_id OR
               archive_object.owner_kind IS DISTINCT FROM OLD.owner_kind OR
               archive_object.owner_id IS DISTINCT FROM OLD.owner_id OR
               archive_object.owner_fence IS DISTINCT FROM OLD.owner_fence
             )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_object_roster_invalid';
        END IF;

        SELECT count(*)::integer
          INTO verified_section_count
          FROM public.meta_recovery_archive_objects archive_object
         WHERE archive_object.generation_id = NEW.generation_id
           AND archive_object.object_class = 'section'
           AND archive_object.state = 'verified';

        SELECT count(*)::integer
          INTO verified_manifest_count
          FROM public.meta_recovery_archive_objects archive_object
         WHERE archive_object.generation_id = NEW.generation_id
           AND archive_object.object_class = 'manifest'
           AND archive_object.state = 'verified';

        IF verified_section_count <> 10 OR verified_manifest_count <> 1 THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_object_roster_invalid';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM public.meta_recovery_archive_objects archive_object
           WHERE archive_object.generation_id = NEW.generation_id
             AND archive_object.object_class = 'attachment'
             AND NOT EXISTS (
               SELECT 1
                 FROM public.meta_recovery_archive_attachment_refs attachment_ref
                WHERE attachment_ref.generation_id = archive_object.generation_id
                  AND attachment_ref.attachment_id = archive_object.attachment_id
                  AND attachment_ref.reference_class = 'archive_object'
                  AND attachment_ref.reference_state = 'verified'
                  AND attachment_ref.availability = 'available'
                  AND attachment_ref.content_sha256 = archive_object.plaintext_sha256
             )
        ) OR EXISTS (
          SELECT 1
            FROM public.meta_recovery_archive_attachment_refs attachment_ref
           WHERE attachment_ref.generation_id = NEW.generation_id
             AND attachment_ref.reference_class = 'archive_object'
             AND attachment_ref.reference_state = 'verified'
             AND NOT EXISTS (
               SELECT 1
                 FROM public.meta_recovery_archive_objects archive_object
                WHERE archive_object.generation_id = attachment_ref.generation_id
                  AND archive_object.object_class = 'attachment'
                  AND archive_object.attachment_id = attachment_ref.attachment_id
                  AND archive_object.state = 'verified'
                  AND archive_object.plaintext_sha256 = attachment_ref.content_sha256
             )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_object_attachment_roster_invalid';
        END IF;
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_object_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_objects
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_object_guard_row()
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_meta_recovery_archive_object_finalize_guard_row
    AFTER UPDATE ON public.meta_recovery_archive_objects
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD.state = 'uploaded' AND NEW.state = 'verified')
    EXECUTE FUNCTION public.meta_recovery_archive_object_finalize_guard_row()
  `.execute(db)
  // PostgreSQL fires same-kind triggers in name order. Keep the established parent state-machine
  // guard first so malformed parent transitions retain their existing values-free refusal code;
  // this later trigger adds the exact verified-object roster requirement to otherwise-valid moves.
  await sql`
    CREATE TRIGGER trg_meta_recovery_archives_object_parent_guard_row
    BEFORE UPDATE ON public.meta_recovery_archives
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_object_parent_guard_row()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      object_count bigint;
      object_shape_count integer;
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_objects') IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_receipt_schema_mismatch';
      END IF;

      BEGIN
        LOCK TABLE public.meta_recovery_archive_objects, public.meta_recovery_archives
          IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING
          ERRCODE = '55P03',
          MESSAGE = 'recovery_archive_object_receipt_busy';
      END;

      SELECT count(*)::bigint
        INTO object_count
        FROM public.meta_recovery_archive_objects;

      IF object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_receipt_nonempty';
      END IF;

      SELECT (
        (SELECT count(*) FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_recovery_archive_object_guard_row',
             'meta_recovery_archive_object_finalize_guard_row',
             'meta_recovery_archive_object_parent_guard_row'
           )
           AND procedure_row.pronargs = 0
           AND procedure_row.prorettype = 'trigger'::regtype) +
        (SELECT count(*) FROM pg_catalog.pg_trigger trigger_row
         WHERE trigger_row.tgname IN (
           'trg_meta_recovery_archive_object_guard_row',
           'trg_meta_recovery_archive_object_finalize_guard_row',
           'trg_meta_recovery_archives_object_parent_guard_row'
         ) AND NOT trigger_row.tgisinternal) +
        (SELECT count(*) FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname IN (
             'uq_meta_recovery_archive_objects_idempotency',
             'idx_meta_recovery_archive_object_section_slot',
             'idx_meta_recovery_archive_object_attachment_slot',
             'idx_meta_recovery_archive_object_manifest_slot'
           )
           AND relation.relkind = 'i')
      )::integer INTO object_shape_count;

      IF object_shape_count <> 10 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_object_receipt_schema_mismatch';
      END IF;

      EXECUTE 'DROP TRIGGER trg_meta_recovery_archives_object_parent_guard_row ON public.meta_recovery_archives';
      EXECUTE 'DROP TRIGGER trg_meta_recovery_archive_object_finalize_guard_row ON public.meta_recovery_archive_objects';
      EXECUTE 'DROP TRIGGER trg_meta_recovery_archive_object_guard_row ON public.meta_recovery_archive_objects';
      EXECUTE 'DROP INDEX public.idx_meta_recovery_archive_object_manifest_slot';
      EXECUTE 'DROP INDEX public.idx_meta_recovery_archive_object_attachment_slot';
      EXECUTE 'DROP INDEX public.idx_meta_recovery_archive_object_section_slot';
      EXECUTE 'DROP TABLE public.meta_recovery_archive_objects';
      EXECUTE 'DROP FUNCTION public.meta_recovery_archive_object_parent_guard_row()';
      EXECUTE 'DROP FUNCTION public.meta_recovery_archive_object_finalize_guard_row()';
      EXECUTE 'DROP FUNCTION public.meta_recovery_archive_object_guard_row()';
    END $$;
  `.execute(db)
}
