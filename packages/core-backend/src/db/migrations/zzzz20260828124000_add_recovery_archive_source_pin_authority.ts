import { sql, type Kysely } from 'kysely'

/**
 * Phase D2: inert attachment source-pin authority.
 *
 * The existing attachment-ref relation remains the single authority for both source pins and
 * verified archive copies. This migration adds no caller, provider operation, scheduler, route,
 * flag, or retention authorization.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      mismatch_count integer := 0;
      owned_object_count integer := 0;
      attachment_ref_count bigint := 0;
    BEGIN
      WITH expected(column_name, type_name, is_not_null) AS (
        VALUES
          ('generation_id', 'uuid', true),
          ('attachment_id', 'text', true),
          ('reference_class', 'text', true),
          ('reference_state', 'text', true),
          ('availability', 'text', true),
          ('content_sha256', 'text', false),
          ('cleanup_owner_kind', 'text', false),
          ('cleanup_owner_id', 'text', false),
          ('cleanup_owner_fence', 'bigint', false),
          ('created_at', 'timestamp with time zone', true),
          ('updated_at', 'timestamp with time zone', true)
      )
      SELECT count(*)::integer
        INTO mismatch_count
        FROM expected
        LEFT JOIN pg_catalog.pg_class relation
          ON relation.oid = pg_catalog.to_regclass('public.meta_recovery_archive_attachment_refs')
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

      mismatch_count := mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname = 'meta_recovery_archive_attachment_ref_cleanup_guard_row'
           AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
           AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
           AND procedure_row.provolatile = 'v'
           AND NOT procedure_row.prosecdef
           AND procedure_row.prokind = 'f'
           AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
           AND pg_catalog.md5(procedure_row.prosrc) = '5bf9b5091c189c2754a2b3994f23f9a9'
      );

      mismatch_count := mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_recovery_archive_attachment_refs'
           AND trigger_row.tgname = 'trg_meta_recovery_archive_attachment_ref_guard_row'
           AND trigger_row.tgtype = 31
           AND trigger_row.tgenabled = 'O'
           AND NOT trigger_row.tgisinternal
           AND trigger_row.tgconstraint = 0
           AND NOT trigger_row.tgdeferrable
           AND NOT trigger_row.tginitdeferred
           AND procedure_row.proname = 'meta_recovery_archive_attachment_ref_cleanup_guard_row'
      );

      mismatch_count := mismatch_count + (
        SELECT CASE
          WHEN count(*) = 13 AND pg_catalog.md5(
            string_agg(
              constraint_row.conname || '=' ||
              pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
              E'\n' ORDER BY constraint_row.conname
            )
          ) = 'f901509ad12f2e6d2f986f905071f9a2' THEN 0
          ELSE 1
        END
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_recovery_archive_attachment_refs'
      );

      IF mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_source_pin_source_mismatch';
      END IF;

      SELECT count(*)::integer
        INTO owned_object_count
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'meta_recovery_archive_attachment_refs'
         AND column_name IN (
           'source_owner_kind',
           'source_owner_id',
           'source_owner_fence',
           'source_lease_until',
           'immutable_version',
           'content_size_bytes'
         );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname = 'meta_recovery_archive_attachment_authority_guard_row'
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_recovery_archive_attachment_refs'
           AND trigger_row.tgname = 'trg_meta_recovery_archive_attachment_authority_guard_row'
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_recovery_archive_attachment_refs'
           AND constraint_row.conname IN (
             'chk_meta_recovery_archive_attachment_source_owner_tuple',
             'chk_meta_recovery_archive_attachment_immutable_version',
             'chk_meta_recovery_archive_attachment_content_size',
             'chk_meta_recovery_archive_attachment_authority_shape'
           )
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_source_pin_object_conflict';
      END IF;

      SELECT count(*)::bigint
        INTO attachment_ref_count
        FROM public.meta_recovery_archive_attachment_refs;
      IF attachment_ref_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_source_pin_backfill_required';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_recovery_archive_attachment_refs
      ADD COLUMN source_owner_kind text,
      ADD COLUMN source_owner_id text,
      ADD COLUMN source_owner_fence bigint,
      ADD COLUMN source_lease_until timestamptz,
      ADD COLUMN immutable_version text,
      ADD COLUMN content_size_bytes bigint,
      ADD CONSTRAINT chk_meta_recovery_archive_attachment_source_owner_tuple CHECK (
        (
          source_owner_kind IS NULL AND
          source_owner_id IS NULL AND
          source_owner_fence IS NULL AND
          source_lease_until IS NULL
        ) OR (
          source_owner_kind IS NOT NULL AND
          length(btrim(source_owner_kind)) > 0 AND
          source_owner_id IS NOT NULL AND
          length(btrim(source_owner_id)) > 0 AND
          source_owner_fence IS NOT NULL AND
          source_owner_fence >= 1 AND
          source_lease_until IS NOT NULL
        )
      ),
      ADD CONSTRAINT chk_meta_recovery_archive_attachment_immutable_version CHECK (
        immutable_version IS NULL OR length(btrim(immutable_version)) > 0
      ),
      ADD CONSTRAINT chk_meta_recovery_archive_attachment_content_size CHECK (
        content_size_bytes IS NULL OR content_size_bytes >= 0
      ),
      ADD CONSTRAINT chk_meta_recovery_archive_attachment_authority_shape CHECK (
        (
          reference_class = 'source' AND
          reference_state = 'building' AND
          source_owner_kind IS NOT NULL AND
          source_owner_id IS NOT NULL AND
          source_owner_fence IS NOT NULL AND
          source_lease_until IS NOT NULL AND
          (
            availability <> 'available' OR (
              immutable_version IS NOT NULL AND
              content_sha256 IS NOT NULL AND
              content_size_bytes IS NOT NULL
            )
          )
        ) OR (
          reference_class = 'archive_object' AND
          reference_state = 'verified' AND
          availability = 'available' AND
          source_owner_kind IS NULL AND
          source_owner_id IS NULL AND
          source_owner_fence IS NULL AND
          source_lease_until IS NULL AND
          immutable_version IS NOT NULL AND
          content_sha256 IS NOT NULL AND
          content_size_bytes IS NOT NULL AND
          cleanup_owner_kind IS NULL AND
          cleanup_owner_id IS NULL AND
          cleanup_owner_fence IS NULL
        )
      )
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_attachment_authority_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      parent_state text;
      parent_build_status text;
      parent_coverage_status text;
      parent_owner_kind text;
      parent_owner_id text;
      parent_owner_fence bigint;
      parent_lease_expires_at timestamptz;
      authority_changed boolean;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.reference_class = 'archive_object' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_ref_immutable';
        END IF;

        SELECT archive.state,
               archive.build_status,
               archive.coverage_status,
               archive.owner_kind,
               archive.owner_id,
               archive.owner_fence,
               archive.lease_expires_at
          INTO parent_state,
               parent_build_status,
               parent_coverage_status,
               parent_owner_kind,
               parent_owner_id,
               parent_owner_fence,
               parent_lease_expires_at
          FROM public.meta_recovery_archives archive
         WHERE archive.generation_id = OLD.generation_id
         FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_source_pin_parent_invalid';
        END IF;

        IF parent_build_status = 'active' AND (
          parent_state <> 'building' OR
          parent_coverage_status <> 'incomplete' OR
          OLD.source_owner_kind IS DISTINCT FROM parent_owner_kind OR
          OLD.source_owner_id IS DISTINCT FROM parent_owner_id OR
          OLD.source_owner_fence IS DISTINCT FROM parent_owner_fence OR
          OLD.source_lease_until IS DISTINCT FROM parent_lease_expires_at OR
          parent_lease_expires_at <= clock_timestamp()
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_source_pin_owner_invalid';
        END IF;

        RETURN OLD;
      END IF;

      IF NEW.reference_class = 'source' THEN
        IF NEW.source_owner_kind IS NULL
           OR length(btrim(NEW.source_owner_kind)) = 0
           OR NEW.source_owner_id IS NULL
           OR length(btrim(NEW.source_owner_id)) = 0
           OR NEW.source_owner_fence IS NULL
           OR NEW.source_owner_fence < 1
           OR NEW.source_lease_until IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_source_pin_shape_invalid';
        END IF;
      ELSIF NEW.reference_class = 'archive_object' THEN
        IF NEW.source_owner_kind IS NOT NULL
           OR NEW.source_owner_id IS NOT NULL
           OR NEW.source_owner_fence IS NOT NULL
           OR NEW.source_lease_until IS NOT NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_archive_object_shape_invalid';
        END IF;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF OLD.reference_class = 'archive_object' AND OLD.reference_state = 'verified' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_ref_immutable';
        END IF;

        IF OLD.reference_class = 'source'
           AND OLD.reference_state = 'building'
           AND OLD.availability = 'available'
           AND (
             NEW.availability IS DISTINCT FROM OLD.availability OR
             NEW.immutable_version IS DISTINCT FROM OLD.immutable_version OR
             NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR
             NEW.content_size_bytes IS DISTINCT FROM OLD.content_size_bytes
           ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_source_pin_verified_immutable';
        END IF;

        IF NEW.source_owner_kind IS DISTINCT FROM OLD.source_owner_kind
           OR NEW.source_owner_id IS DISTINCT FROM OLD.source_owner_id
           OR NEW.source_owner_fence IS DISTINCT FROM OLD.source_owner_fence THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_source_pin_owner_immutable';
        END IF;
      END IF;

      authority_changed := TG_OP = 'INSERT' OR (
        NEW.availability IS DISTINCT FROM OLD.availability OR
        NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR
        NEW.immutable_version IS DISTINCT FROM OLD.immutable_version OR
        NEW.content_size_bytes IS DISTINCT FROM OLD.content_size_bytes OR
        NEW.source_lease_until IS DISTINCT FROM OLD.source_lease_until
      );

      SELECT archive.state,
             archive.build_status,
             archive.coverage_status,
             archive.owner_kind,
             archive.owner_id,
             archive.owner_fence,
             archive.lease_expires_at
        INTO parent_state,
             parent_build_status,
             parent_coverage_status,
             parent_owner_kind,
             parent_owner_id,
             parent_owner_fence,
             parent_lease_expires_at
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_source_pin_parent_invalid';
      END IF;

      IF NEW.reference_class = 'source' AND authority_changed THEN
        IF parent_state <> 'building'
           OR parent_build_status <> 'active'
           OR parent_coverage_status <> 'incomplete' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_posture_invalid';
        END IF;

        IF NEW.source_owner_kind IS DISTINCT FROM parent_owner_kind
           OR NEW.source_owner_id IS DISTINCT FROM parent_owner_id
           OR NEW.source_owner_fence IS DISTINCT FROM parent_owner_fence
           OR NEW.source_lease_until IS DISTINCT FROM parent_lease_expires_at THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_source_pin_owner_invalid';
        END IF;

        IF TG_OP = 'INSERT' AND (
          NEW.availability <> 'mutable' OR
          NEW.content_sha256 IS NOT NULL OR
          NEW.immutable_version IS NOT NULL OR
          NEW.content_size_bytes IS NOT NULL
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_source_pin_intent_invalid';
        END IF;

        IF parent_lease_expires_at <= clock_timestamp() THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_source_pin_lease_expired';
        END IF;
      ELSIF NEW.reference_class = 'archive_object' THEN
        IF parent_state <> 'building'
           OR parent_build_status <> 'active'
           OR parent_coverage_status <> 'incomplete'
           OR parent_lease_expires_at <= clock_timestamp()
           OR NOT EXISTS (
             SELECT 1
               FROM public.meta_recovery_archive_attachment_refs source_ref
              WHERE source_ref.generation_id = NEW.generation_id
                AND source_ref.attachment_id = NEW.attachment_id
                AND source_ref.reference_class = 'source'
                AND source_ref.reference_state = 'building'
                AND source_ref.availability = 'available'
                AND source_ref.immutable_version IS NOT NULL
                AND source_ref.content_sha256 = NEW.content_sha256
                AND source_ref.content_size_bytes = NEW.content_size_bytes
           ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_posture_invalid';
        END IF;
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_attachment_authority_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_attachment_refs
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_attachment_authority_guard_row()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_attachment_refs') IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_source_pin_surface_missing';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM public.meta_recovery_archive_attachment_refs
         LIMIT 1
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_source_pin_authority_nonempty';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DROP TRIGGER trg_meta_recovery_archive_attachment_authority_guard_row
      ON public.meta_recovery_archive_attachment_refs
  `.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_attachment_authority_guard_row()`.execute(db)
  await sql`
    ALTER TABLE public.meta_recovery_archive_attachment_refs
      DROP CONSTRAINT chk_meta_recovery_archive_attachment_authority_shape,
      DROP CONSTRAINT chk_meta_recovery_archive_attachment_content_size,
      DROP CONSTRAINT chk_meta_recovery_archive_attachment_immutable_version,
      DROP CONSTRAINT chk_meta_recovery_archive_attachment_source_owner_tuple,
      DROP COLUMN content_size_bytes,
      DROP COLUMN immutable_version,
      DROP COLUMN source_lease_until,
      DROP COLUMN source_owner_fence,
      DROP COLUMN source_owner_id,
      DROP COLUMN source_owner_kind
  `.execute(db)
}
