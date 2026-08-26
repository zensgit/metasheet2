import { sql, type Kysely } from 'kysely'

/**
 * Phase D2b: inert staging inventory and owner/fence-safe abandoned source-pin cleanup.
 *
 * This migration adds only a database protocol. It has no scheduler, provider call, route,
 * physical source-object delete, or flag change.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      source_mismatch_count integer;
      owned_object_count integer;
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
          ('meta_recovery_archive_attachment_refs', 'reference_state', 'text', true)
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

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname = 'meta_recovery_archive_attachment_ref_guard_row'
           AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
           AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
           AND procedure_row.provolatile = 'v'
           AND NOT procedure_row.prosecdef
           AND procedure_row.prokind = 'f'
           AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
           AND pg_catalog.md5(procedure_row.prosrc) = '3ed8b59c18b149a176712cea282c06e2'
      );

      source_mismatch_count := source_mismatch_count + (
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
           AND procedure_row.proname = 'meta_recovery_archive_attachment_ref_guard_row'
      );

      IF source_mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_staging_cleanup_source_mismatch';
      END IF;

      SELECT count(*)::integer
        INTO owned_object_count
        FROM (
          SELECT pg_catalog.to_regclass(name) AS object_oid
            FROM unnest(ARRAY[
              'public.meta_recovery_archive_staging_objects',
              'public.idx_meta_recovery_archive_staging_generation_state'
            ]::text[]) AS names(name)
        ) owned_relations
       WHERE owned_relations.object_oid IS NOT NULL;

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'meta_recovery_archive_attachment_refs'
           AND column_name IN (
             'cleanup_owner_kind',
             'cleanup_owner_id',
             'cleanup_owner_fence'
           )
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_recovery_archive_abandoned_cleanup_claim_guard_row',
             'meta_recovery_archive_claim_abandoned_cleanup',
             'meta_recovery_archive_staging_object_guard_row',
             'meta_recovery_archive_staging_object_finalize_guard_row',
             'meta_recovery_archive_attachment_ref_cleanup_guard_row',
             'meta_recovery_archive_attachment_cleanup_finalize_guard_row',
             'meta_recovery_archive_release_abandoned_source_pin'
           )
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND NOT trigger_row.tgisinternal
           AND trigger_row.tgname IN (
             'trg_meta_recovery_archive_abandoned_cleanup_claim_guard_row',
             'trg_meta_recovery_archive_staging_object_guard_row',
             'trg_meta_recovery_archive_staging_object_finalize_guard_row',
             'trg_meta_recovery_archive_attachment_cleanup_finalize_guard_row'
           )
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_staging_cleanup_object_conflict';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_recovery_archive_attachment_refs
      ADD COLUMN cleanup_owner_kind text,
      ADD COLUMN cleanup_owner_id text,
      ADD COLUMN cleanup_owner_fence bigint,
      ADD CONSTRAINT chk_meta_recovery_archive_attachment_cleanup_owner_tuple CHECK (
        (
          cleanup_owner_kind IS NULL AND
          cleanup_owner_id IS NULL AND
          cleanup_owner_fence IS NULL
        ) OR (
          cleanup_owner_kind IS NOT NULL AND
          length(btrim(cleanup_owner_kind)) > 0 AND
          cleanup_owner_id IS NOT NULL AND
          length(btrim(cleanup_owner_id)) > 0 AND
          cleanup_owner_fence IS NOT NULL AND
          cleanup_owner_fence >= 1
        )
      ),
      ADD CONSTRAINT chk_meta_recovery_archive_attachment_cleanup_source_only CHECK (
        cleanup_owner_kind IS NULL OR (
          reference_class = 'source' AND reference_state = 'building'
        )
      )
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_staging_objects (
      generation_id uuid NOT NULL,
      staging_object_id uuid NOT NULL,
      object_class text NOT NULL,
      attachment_id text,
      object_state text NOT NULL DEFAULT 'pending',
      key_id text NOT NULL,
      terminal_receipt_sha256 text,
      cleanup_owner_kind text,
      cleanup_owner_id text,
      cleanup_owner_fence bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_recovery_archive_staging_objects
        PRIMARY KEY (generation_id, staging_object_id),
      CONSTRAINT fk_meta_recovery_archive_staging_generation
        FOREIGN KEY (generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT chk_meta_recovery_archive_staging_object_class CHECK (
        object_class IN ('section', 'attachment', 'manifest')
      ),
      CONSTRAINT chk_meta_recovery_archive_staging_attachment_binding CHECK (
        (object_class = 'attachment' AND attachment_id IS NOT NULL AND length(btrim(attachment_id)) > 0) OR
        (object_class <> 'attachment' AND attachment_id IS NULL)
      ),
      CONSTRAINT chk_meta_recovery_archive_staging_object_state CHECK (
        object_state IN ('pending', 'sealed', 'deleted', 'absent')
      ),
      CONSTRAINT chk_meta_recovery_archive_staging_key_id CHECK (length(btrim(key_id)) > 0),
      CONSTRAINT chk_meta_recovery_archive_staging_terminal_shape CHECK (
        (
          object_state IN ('pending', 'sealed') AND
          terminal_receipt_sha256 IS NULL AND
          cleanup_owner_kind IS NULL AND
          cleanup_owner_id IS NULL AND
          cleanup_owner_fence IS NULL
        ) OR (
          object_state IN ('deleted', 'absent') AND
          terminal_receipt_sha256 IS NOT NULL AND
          terminal_receipt_sha256 ~ '^[0-9a-f]{64}$' AND
          cleanup_owner_kind IS NOT NULL AND
          length(btrim(cleanup_owner_kind)) > 0 AND
          cleanup_owner_id IS NOT NULL AND
          length(btrim(cleanup_owner_id)) > 0 AND
          cleanup_owner_fence IS NOT NULL AND
          cleanup_owner_fence >= 1
        )
      )
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_meta_recovery_archive_staging_generation_state
      ON public.meta_recovery_archive_staging_objects(
        generation_id, object_state, object_class, attachment_id
      )
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_abandoned_cleanup_claim_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF OLD.build_status = 'abandoned' AND (
        NEW.owner_kind IS DISTINCT FROM OLD.owner_kind OR
        NEW.owner_id IS DISTINCT FROM OLD.owner_id OR
        NEW.owner_fence IS DISTINCT FROM OLD.owner_fence OR
        NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
      ) THEN
        IF OLD.state <> 'building'
           OR OLD.coverage_status <> 'incomplete'
           OR OLD.lease_expires_at > clock_timestamp()
           OR NEW.owner_kind IS NULL
           OR length(btrim(NEW.owner_kind)) = 0
           OR NEW.owner_id IS NULL
           OR length(btrim(NEW.owner_id)) = 0
           OR NEW.owner_fence <> OLD.owner_fence + 1
           OR NEW.lease_expires_at <= clock_timestamp() THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_abandoned_cleanup_claim_invalid';
        END IF;
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_claim_abandoned_cleanup(
      claimed_generation_id uuid,
      expected_owner_kind text,
      expected_owner_id text,
      expected_owner_fence bigint,
      new_owner_kind text,
      new_owner_id text,
      new_lease_expires_at timestamptz
    )
    RETURNS bigint
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      claimed_fence bigint;
    BEGIN
      IF claimed_generation_id IS NULL
         OR expected_owner_kind IS NULL
         OR length(btrim(expected_owner_kind)) = 0
         OR expected_owner_id IS NULL
         OR length(btrim(expected_owner_id)) = 0
         OR expected_owner_fence IS NULL
         OR expected_owner_fence < 1
         OR new_owner_kind IS NULL
         OR length(btrim(new_owner_kind)) = 0
         OR new_owner_id IS NULL
         OR length(btrim(new_owner_id)) = 0
         OR new_lease_expires_at IS NULL
         OR new_lease_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_abandoned_cleanup_claim_shape_invalid';
      END IF;

      UPDATE public.meta_recovery_archives archive
         SET owner_kind = new_owner_kind,
             owner_id = new_owner_id,
             owner_fence = archive.owner_fence + 1,
             lease_expires_at = new_lease_expires_at
       WHERE archive.generation_id = claimed_generation_id
         AND archive.state = 'building'
         AND archive.build_status = 'abandoned'
         AND archive.coverage_status = 'incomplete'
         AND archive.owner_kind = expected_owner_kind
         AND archive.owner_id = expected_owner_id
         AND archive.owner_fence = expected_owner_fence
         AND archive.lease_expires_at <= clock_timestamp()
      RETURNING archive.owner_fence INTO claimed_fence;

      IF claimed_fence IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_abandoned_cleanup_claim_refused';
      END IF;

      RETURN claimed_fence;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_staging_object_guard_row()
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
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_staging_receipt_immutable';
      END IF;

      IF TG_OP = 'UPDATE' AND (
        NEW.generation_id IS DISTINCT FROM OLD.generation_id OR
        NEW.staging_object_id IS DISTINCT FROM OLD.staging_object_id OR
        NEW.object_class IS DISTINCT FROM OLD.object_class OR
        NEW.attachment_id IS DISTINCT FROM OLD.attachment_id OR
        NEW.key_id IS DISTINCT FROM OLD.key_id OR
        NEW.created_at IS DISTINCT FROM OLD.created_at OR
        OLD.object_state IN ('deleted', 'absent')
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_staging_identity_immutable';
      END IF;

      IF NEW.generation_id IS NULL
         OR NEW.staging_object_id IS NULL
         OR NEW.object_class IS NULL
         OR NEW.object_class NOT IN ('section', 'attachment', 'manifest')
         OR (
           NEW.object_class = 'attachment' AND (
             NEW.attachment_id IS NULL OR length(btrim(NEW.attachment_id)) = 0
           )
         )
         OR (NEW.object_class <> 'attachment' AND NEW.attachment_id IS NOT NULL)
         OR NEW.object_state IS NULL
         OR NEW.object_state NOT IN ('pending', 'sealed', 'deleted', 'absent')
         OR NEW.key_id IS NULL
         OR length(btrim(NEW.key_id)) = 0
         OR (
           NEW.object_state IN ('pending', 'sealed') AND (
             NEW.terminal_receipt_sha256 IS NOT NULL OR
             NEW.cleanup_owner_kind IS NOT NULL OR
             NEW.cleanup_owner_id IS NOT NULL OR
             NEW.cleanup_owner_fence IS NOT NULL
           )
         )
         OR (
           NEW.object_state IN ('deleted', 'absent') AND (
             NEW.terminal_receipt_sha256 IS NULL OR
             NEW.terminal_receipt_sha256 !~ '^[0-9a-f]{64}$' OR
             NEW.cleanup_owner_kind IS NULL OR
             length(btrim(NEW.cleanup_owner_kind)) = 0 OR
             NEW.cleanup_owner_id IS NULL OR
             length(btrim(NEW.cleanup_owner_id)) = 0 OR
             NEW.cleanup_owner_fence IS NULL OR
             NEW.cleanup_owner_fence < 1
           )
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_staging_shape_invalid';
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

      IF NOT FOUND OR NEW.key_id IS DISTINCT FROM parent_key_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_staging_parent_invalid';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF parent_state <> 'building'
           OR parent_build_status <> 'active'
           OR parent_coverage_status <> 'incomplete'
           OR NEW.object_state <> 'pending'
           OR NEW.terminal_receipt_sha256 IS NOT NULL
           OR NEW.cleanup_owner_kind IS NOT NULL
           OR NEW.cleanup_owner_id IS NOT NULL
           OR NEW.cleanup_owner_fence IS NOT NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_staging_initial_posture_invalid';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.object_state IN ('pending', 'sealed') THEN
        IF parent_state <> 'building'
           OR parent_build_status <> 'active'
           OR parent_coverage_status <> 'incomplete'
           OR NOT (
             (OLD.object_state = 'pending' AND NEW.object_state IN ('pending', 'sealed')) OR
             (OLD.object_state = 'sealed' AND NEW.object_state = 'sealed')
           )
           OR NEW.terminal_receipt_sha256 IS NOT NULL
           OR NEW.cleanup_owner_kind IS NOT NULL
           OR NEW.cleanup_owner_id IS NOT NULL
           OR NEW.cleanup_owner_fence IS NOT NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_staging_transition_invalid';
        END IF;
      ELSE
        IF parent_state <> 'building'
           OR parent_build_status <> 'abandoned'
           OR parent_coverage_status <> 'incomplete'
           OR NOT (
             (OLD.object_state = 'pending' AND NEW.object_state = 'absent') OR
             (OLD.object_state = 'sealed' AND NEW.object_state IN ('deleted', 'absent'))
           )
           OR NEW.cleanup_owner_kind IS DISTINCT FROM parent_owner_kind
           OR NEW.cleanup_owner_id IS DISTINCT FROM parent_owner_id
           OR NEW.cleanup_owner_fence IS DISTINCT FROM parent_owner_fence
           OR parent_lease_expires_at <= clock_timestamp() THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_staging_cleanup_owner_invalid';
        END IF;
      END IF;

      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_staging_object_finalize_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF NEW.object_state NOT IN ('deleted', 'absent') THEN
        RETURN NEW;
      END IF;

      PERFORM 1
        FROM public.meta_recovery_archive_staging_objects staging_object
        JOIN public.meta_recovery_archives archive
          ON archive.generation_id = staging_object.generation_id
       WHERE staging_object.generation_id = NEW.generation_id
         AND staging_object.staging_object_id = NEW.staging_object_id
         AND staging_object.object_state IN ('deleted', 'absent')
         AND staging_object.cleanup_owner_kind = NEW.cleanup_owner_kind
         AND staging_object.cleanup_owner_id = NEW.cleanup_owner_id
         AND staging_object.cleanup_owner_fence = NEW.cleanup_owner_fence
         AND archive.state = 'building'
         AND archive.build_status = 'abandoned'
         AND archive.coverage_status = 'incomplete'
         AND archive.owner_kind = NEW.cleanup_owner_kind
         AND archive.owner_id = NEW.cleanup_owner_id
         AND archive.owner_fence = NEW.cleanup_owner_fence
         AND archive.lease_expires_at > clock_timestamp()
       FOR UPDATE OF archive;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_staging_cleanup_recheck_failed';
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_attachment_ref_cleanup_guard_row()
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
      cleanup_inventory_complete boolean;
    BEGIN
      IF TG_OP <> 'DELETE' AND NOT (
        (
          NEW.cleanup_owner_kind IS NULL AND
          NEW.cleanup_owner_id IS NULL AND
          NEW.cleanup_owner_fence IS NULL
        ) OR (
          NEW.cleanup_owner_kind IS NOT NULL AND
          length(btrim(NEW.cleanup_owner_kind)) > 0 AND
          NEW.cleanup_owner_id IS NOT NULL AND
          length(btrim(NEW.cleanup_owner_id)) > 0 AND
          NEW.cleanup_owner_fence IS NOT NULL AND
          NEW.cleanup_owner_fence >= 1 AND
          NEW.reference_class = 'source' AND
          NEW.reference_state = 'building'
        )
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_attachment_cleanup_shape_invalid';
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.reference_class = 'archive_object' AND OLD.reference_state = 'verified' THEN
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

        SELECT (
          EXISTS (
            SELECT 1
              FROM public.meta_recovery_archive_staging_objects staging_object
             WHERE staging_object.generation_id = OLD.generation_id
               AND staging_object.object_class = 'attachment'
               AND staging_object.attachment_id = OLD.attachment_id
               AND staging_object.object_state IN ('deleted', 'absent')
          ) AND NOT EXISTS (
            SELECT 1
              FROM public.meta_recovery_archive_staging_objects staging_object
             WHERE staging_object.generation_id = OLD.generation_id
               AND staging_object.object_state NOT IN ('deleted', 'absent')
          )
        ) INTO cleanup_inventory_complete;

        IF NOT FOUND OR NOT (
          (
            OLD.reference_class = 'source' AND
            OLD.reference_state = 'building' AND
            OLD.cleanup_owner_kind IS NULL AND
            parent_state = 'building' AND
            parent_build_status = 'active' AND
            parent_coverage_status = 'incomplete' AND
            EXISTS (
              SELECT 1
                FROM public.meta_recovery_archive_attachment_refs archive_ref
               WHERE archive_ref.generation_id = OLD.generation_id
                 AND archive_ref.attachment_id = OLD.attachment_id
                 AND archive_ref.reference_class = 'archive_object'
                 AND archive_ref.reference_state = 'verified'
                 AND OLD.availability = 'available'
                 AND OLD.content_sha256 IS NOT NULL
                 AND archive_ref.content_sha256 = OLD.content_sha256
            )
          ) OR (
            OLD.reference_class = 'source' AND
            OLD.reference_state = 'building' AND
            parent_state = 'building' AND
            parent_build_status = 'abandoned' AND
            parent_coverage_status = 'incomplete' AND
            OLD.cleanup_owner_kind IS NOT NULL AND
            OLD.cleanup_owner_kind = parent_owner_kind AND
            OLD.cleanup_owner_id = parent_owner_id AND
            OLD.cleanup_owner_fence = parent_owner_fence AND
            parent_lease_expires_at > clock_timestamp() AND
            cleanup_inventory_complete AND
            NOT EXISTS (
              SELECT 1
                FROM public.meta_recovery_archive_attachment_refs archive_ref
               WHERE archive_ref.generation_id = OLD.generation_id
                 AND archive_ref.attachment_id = OLD.attachment_id
                 AND archive_ref.reference_class = 'archive_object'
            )
          )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_posture_invalid';
        END IF;

        RETURN OLD;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF NEW.generation_id IS DISTINCT FROM OLD.generation_id
           OR NEW.attachment_id IS DISTINCT FROM OLD.attachment_id
           OR NEW.reference_class IS DISTINCT FROM OLD.reference_class
           OR NEW.reference_state IS DISTINCT FROM OLD.reference_state
           OR (
             OLD.reference_class = 'archive_object' AND
             OLD.reference_state = 'verified'
           ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_ref_immutable';
        END IF;

        IF OLD.cleanup_owner_kind IS NOT NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_cleanup_authorization_immutable';
        END IF;

        IF NEW.cleanup_owner_kind IS NOT NULL THEN
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

          SELECT (
            EXISTS (
              SELECT 1
                FROM public.meta_recovery_archive_staging_objects staging_object
               WHERE staging_object.generation_id = NEW.generation_id
                 AND staging_object.object_class = 'attachment'
                 AND staging_object.attachment_id = NEW.attachment_id
                 AND staging_object.object_state IN ('deleted', 'absent')
            ) AND NOT EXISTS (
              SELECT 1
                FROM public.meta_recovery_archive_staging_objects staging_object
               WHERE staging_object.generation_id = NEW.generation_id
                 AND staging_object.object_state NOT IN ('deleted', 'absent')
            )
          ) INTO cleanup_inventory_complete;

          IF NOT FOUND
             OR NEW.reference_class <> 'source'
             OR NEW.reference_state <> 'building'
             OR parent_state <> 'building'
             OR parent_build_status <> 'abandoned'
             OR parent_coverage_status <> 'incomplete'
             OR NEW.cleanup_owner_kind IS DISTINCT FROM parent_owner_kind
             OR NEW.cleanup_owner_id IS DISTINCT FROM parent_owner_id
             OR NEW.cleanup_owner_fence IS DISTINCT FROM parent_owner_fence
             OR parent_lease_expires_at <= clock_timestamp()
             OR NOT cleanup_inventory_complete
             OR EXISTS (
               SELECT 1
                 FROM public.meta_recovery_archive_attachment_refs archive_ref
                WHERE archive_ref.generation_id = NEW.generation_id
                  AND archive_ref.attachment_id = NEW.attachment_id
                  AND archive_ref.reference_class = 'archive_object'
             ) THEN
            RAISE EXCEPTION USING
              ERRCODE = '55000',
              MESSAGE = 'recovery_archive_attachment_cleanup_authorization_invalid';
          END IF;

          NEW.updated_at := clock_timestamp();
          RETURN NEW;
        END IF;

        NEW.updated_at := clock_timestamp();
      ELSIF NEW.cleanup_owner_kind IS NOT NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_attachment_cleanup_authorization_invalid';
      END IF;

      SELECT archive.state, archive.build_status, archive.coverage_status
        INTO parent_state, parent_build_status, parent_coverage_status
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id
       FOR UPDATE;

      IF NOT FOUND OR NOT (
        (
          NEW.reference_class = 'source' AND
          NEW.reference_state = 'building' AND
          parent_state = 'building' AND
          parent_build_status = 'active' AND
          parent_coverage_status = 'incomplete'
        ) OR (
          NEW.reference_class = 'archive_object' AND
          NEW.reference_state = 'verified' AND
          parent_state = 'building' AND
          parent_build_status = 'active' AND
          parent_coverage_status = 'incomplete' AND
          EXISTS (
            SELECT 1
              FROM public.meta_recovery_archive_attachment_refs source_ref
             WHERE source_ref.generation_id = NEW.generation_id
               AND source_ref.attachment_id = NEW.attachment_id
               AND source_ref.reference_class = 'source'
               AND source_ref.reference_state = 'building'
               AND source_ref.availability = 'available'
               AND source_ref.content_sha256 IS NOT NULL
               AND source_ref.content_sha256 = NEW.content_sha256
          )
        )
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_attachment_posture_invalid';
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_attachment_cleanup_finalize_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.cleanup_owner_kind IS NULL THEN
          RETURN NEW;
        END IF;

        PERFORM 1
          FROM public.meta_recovery_archive_attachment_refs attachment_ref
         WHERE attachment_ref.generation_id = NEW.generation_id
           AND attachment_ref.attachment_id = NEW.attachment_id
           AND attachment_ref.reference_class = NEW.reference_class
           AND attachment_ref.cleanup_owner_kind = NEW.cleanup_owner_kind
           AND attachment_ref.cleanup_owner_id = NEW.cleanup_owner_id
           AND attachment_ref.cleanup_owner_fence = NEW.cleanup_owner_fence;

        IF FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_cleanup_authorization_unconsumed';
        END IF;

        RETURN NEW;
      END IF;

      IF OLD.cleanup_owner_kind IS NULL THEN
        RETURN OLD;
      END IF;

      PERFORM 1
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = OLD.generation_id
         AND archive.state = 'building'
         AND archive.build_status = 'abandoned'
         AND archive.coverage_status = 'incomplete'
         AND archive.owner_kind = OLD.cleanup_owner_kind
         AND archive.owner_id = OLD.cleanup_owner_id
         AND archive.owner_fence = OLD.cleanup_owner_fence
         AND archive.lease_expires_at > clock_timestamp()
         AND EXISTS (
           SELECT 1
             FROM public.meta_recovery_archive_staging_objects staging_object
            WHERE staging_object.generation_id = OLD.generation_id
              AND staging_object.object_class = 'attachment'
              AND staging_object.attachment_id = OLD.attachment_id
              AND staging_object.object_state IN ('deleted', 'absent')
         )
         AND NOT EXISTS (
           SELECT 1
             FROM public.meta_recovery_archive_staging_objects staging_object
            WHERE staging_object.generation_id = OLD.generation_id
              AND staging_object.object_state NOT IN ('deleted', 'absent')
         )
         AND NOT EXISTS (
           SELECT 1
             FROM public.meta_recovery_archive_attachment_refs archive_ref
            WHERE archive_ref.generation_id = OLD.generation_id
              AND archive_ref.attachment_id = OLD.attachment_id
              AND archive_ref.reference_class = 'archive_object'
         )
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_attachment_cleanup_recheck_failed';
      END IF;

      RETURN OLD;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_release_abandoned_source_pin(
      cleanup_generation_id uuid,
      cleanup_attachment_id text,
      cleanup_owner_kind text,
      cleanup_owner_id text,
      cleanup_owner_fence bigint
    )
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      affected_count bigint;
    BEGIN
      IF cleanup_generation_id IS NULL
         OR cleanup_attachment_id IS NULL
         OR length(btrim(cleanup_attachment_id)) = 0
         OR cleanup_owner_kind IS NULL
         OR length(btrim(cleanup_owner_kind)) = 0
         OR cleanup_owner_id IS NULL
         OR length(btrim(cleanup_owner_id)) = 0
         OR cleanup_owner_fence IS NULL
         OR cleanup_owner_fence < 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_attachment_cleanup_shape_invalid';
      END IF;

      UPDATE public.meta_recovery_archive_attachment_refs attachment_ref
         SET cleanup_owner_kind = meta_recovery_archive_release_abandoned_source_pin.cleanup_owner_kind,
             cleanup_owner_id = meta_recovery_archive_release_abandoned_source_pin.cleanup_owner_id,
             cleanup_owner_fence = meta_recovery_archive_release_abandoned_source_pin.cleanup_owner_fence
       WHERE attachment_ref.generation_id = cleanup_generation_id
         AND attachment_ref.attachment_id = cleanup_attachment_id
         AND attachment_ref.reference_class = 'source'
         AND attachment_ref.reference_state = 'building'
         AND attachment_ref.cleanup_owner_kind IS NULL
         AND attachment_ref.cleanup_owner_id IS NULL
         AND attachment_ref.cleanup_owner_fence IS NULL;

      GET DIAGNOSTICS affected_count = ROW_COUNT;
      IF affected_count <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_attachment_cleanup_release_refused';
      END IF;

      DELETE FROM public.meta_recovery_archive_attachment_refs attachment_ref
       WHERE attachment_ref.generation_id = cleanup_generation_id
         AND attachment_ref.attachment_id = cleanup_attachment_id
         AND attachment_ref.reference_class = 'source'
         AND attachment_ref.reference_state = 'building'
         AND attachment_ref.cleanup_owner_kind = meta_recovery_archive_release_abandoned_source_pin.cleanup_owner_kind
         AND attachment_ref.cleanup_owner_id = meta_recovery_archive_release_abandoned_source_pin.cleanup_owner_id
         AND attachment_ref.cleanup_owner_fence = meta_recovery_archive_release_abandoned_source_pin.cleanup_owner_fence;

      GET DIAGNOSTICS affected_count = ROW_COUNT;
      IF affected_count <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_attachment_cleanup_release_refused';
      END IF;
    END $$
  `.execute(db)

  await sql`
    DROP TRIGGER trg_meta_recovery_archive_attachment_ref_guard_row
      ON public.meta_recovery_archive_attachment_refs
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_attachment_ref_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_attachment_refs
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_attachment_ref_cleanup_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_abandoned_cleanup_claim_guard_row
    BEFORE UPDATE OF owner_kind, owner_id, owner_fence, lease_expires_at
      ON public.meta_recovery_archives
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_abandoned_cleanup_claim_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_staging_object_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_staging_objects
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_staging_object_guard_row()
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_meta_recovery_archive_staging_object_finalize_guard_row
    AFTER INSERT OR UPDATE ON public.meta_recovery_archive_staging_objects
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_staging_object_finalize_guard_row()
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_meta_recovery_archive_attachment_cleanup_finalize_guard_row
    AFTER UPDATE OR DELETE ON public.meta_recovery_archive_attachment_refs
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_attachment_cleanup_finalize_guard_row()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      cleanup_state_present boolean := false;
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_staging_objects') IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM public.meta_recovery_archive_staging_objects LIMIT 1
        ) INTO cleanup_state_present;
      END IF;

      IF NOT cleanup_state_present
         AND pg_catalog.to_regclass('public.meta_recovery_archive_attachment_refs') IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1
            FROM public.meta_recovery_archive_attachment_refs
           WHERE cleanup_owner_kind IS NOT NULL
              OR cleanup_owner_id IS NOT NULL
              OR cleanup_owner_fence IS NOT NULL
           LIMIT 1
        ) INTO cleanup_state_present;
      END IF;

      IF cleanup_state_present THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_staging_cleanup_nonempty';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_attachment_refs') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_recovery_archive_attachment_cleanup_finalize_guard_row
          ON public.meta_recovery_archive_attachment_refs;
        DROP TRIGGER IF EXISTS trg_meta_recovery_archive_attachment_ref_guard_row
          ON public.meta_recovery_archive_attachment_refs;
        CREATE TRIGGER trg_meta_recovery_archive_attachment_ref_guard_row
          BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_attachment_refs
          FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_attachment_ref_guard_row();
      END IF;

      IF pg_catalog.to_regclass('public.meta_recovery_archive_staging_objects') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_recovery_archive_staging_object_finalize_guard_row
          ON public.meta_recovery_archive_staging_objects;
        DROP TRIGGER IF EXISTS trg_meta_recovery_archive_staging_object_guard_row
          ON public.meta_recovery_archive_staging_objects;
      END IF;

      IF pg_catalog.to_regclass('public.meta_recovery_archives') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_recovery_archive_abandoned_cleanup_claim_guard_row
          ON public.meta_recovery_archives;
      END IF;
    END $$;
  `.execute(db)

  await sql`DROP INDEX IF EXISTS public.idx_meta_recovery_archive_staging_generation_state`.execute(db)
  await sql`DROP TABLE IF EXISTS public.meta_recovery_archive_staging_objects`.execute(db)

  await sql`
    ALTER TABLE public.meta_recovery_archive_attachment_refs
      DROP CONSTRAINT chk_meta_recovery_archive_attachment_cleanup_source_only,
      DROP CONSTRAINT chk_meta_recovery_archive_attachment_cleanup_owner_tuple,
      DROP COLUMN cleanup_owner_fence,
      DROP COLUMN cleanup_owner_id,
      DROP COLUMN cleanup_owner_kind
  `.execute(db)

  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_attachment_cleanup_finalize_guard_row()`.execute(db)
  await sql`
    DROP FUNCTION IF EXISTS public.meta_recovery_archive_release_abandoned_source_pin(
      uuid, text, text, text, bigint
    )
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_attachment_ref_cleanup_guard_row()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_staging_object_finalize_guard_row()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_staging_object_guard_row()`.execute(db)
  await sql`
    DROP FUNCTION IF EXISTS public.meta_recovery_archive_claim_abandoned_cleanup(
      uuid, text, text, bigint, text, text, timestamptz
    )
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_abandoned_cleanup_claim_guard_row()`.execute(db)
}
