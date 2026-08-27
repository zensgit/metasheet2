import { sql, type Kysely } from 'kysely'

/**
 * Phase D2 prerequisite: normalized archive-key reference authority.
 *
 * This migration is deliberately inert. It creates no key, calls no provider, and exposes no
 * lifecycle worker. D3 still owns retirement/destruction orchestration. The table exists here so
 * D2 can take the ratified fence -> key row -> writer block -> generation lock order honestly.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      source_mismatch_count integer;
      owned_object_count integer;
    BEGIN
      SELECT count(*)::integer
        INTO source_mismatch_count
        FROM (
          VALUES
            ('generation_id', 'uuid', true),
            ('key_id', 'text', true)
        ) AS expected(column_name, type_name, is_not_null)
        LEFT JOIN pg_catalog.pg_class relation
          ON relation.oid = pg_catalog.to_regclass('public.meta_recovery_archives')
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

      IF source_mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_key_registry_source_mismatch';
      END IF;

      -- No key identity may be inferred from an existing generation. An operator must provision
      -- the normalized authority first, then create new references under its row lock.
      IF EXISTS (SELECT 1 FROM public.meta_recovery_archives LIMIT 1) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_key_registry_backfill_required';
      END IF;

      SELECT count(*)::integer
        INTO owned_object_count
        FROM (
          SELECT pg_catalog.to_regclass('public.meta_recovery_archive_keys') AS object_oid
        ) owned_relations
       WHERE owned_relations.object_oid IS NOT NULL;

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_constraint constraint_row
         WHERE constraint_row.conname = 'fk_meta_recovery_archives_key'
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_recovery_archive_key_guard_row',
             'meta_recovery_archive_key_guard_truncate',
             'meta_recovery_archive_key_reference_guard_row'
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
             'trg_meta_recovery_archive_key_guard_row',
             'trg_meta_recovery_archive_key_guard_truncate',
             'trg_meta_recovery_archive_key_reference_guard_row'
           )
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_key_registry_object_conflict';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_keys (
      key_id text COLLATE "C" NOT NULL,
      state text NOT NULL DEFAULT 'active',
      row_version bigint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_recovery_archive_keys PRIMARY KEY (key_id),
      CONSTRAINT chk_meta_recovery_archive_keys_key_id CHECK (
        key_id = btrim(key_id) AND
        length(key_id) BETWEEN 1 AND 255 AND
        key_id !~ '[[:cntrl:]]'
      ),
      CONSTRAINT chk_meta_recovery_archive_keys_state CHECK (
        state IN ('active', 'retiring', 'destroyed')
      ),
      CONSTRAINT chk_meta_recovery_archive_keys_row_version CHECK (row_version >= 1)
    )
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_key_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_key_delete_not_authorized';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.key_id IS NULL
           OR NEW.key_id <> btrim(NEW.key_id)
           OR length(NEW.key_id) NOT BETWEEN 1 AND 255
           OR NEW.key_id ~ '[[:cntrl:]]'
           OR NEW.created_at IS NULL
           OR NEW.updated_at IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_key_shape_invalid';
        END IF;

        IF NEW.state <> 'active' OR NEW.row_version <> 1 THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_key_initial_posture_invalid';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.key_id IS DISTINCT FROM OLD.key_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_key_identity_immutable';
      END IF;

      -- D2 can close reference admission by moving active -> retiring. It cannot prove the D3
      -- provider receipt/reference census needed for destroyed, or the provider non-deletion proof
      -- needed to cancel retiring. D3 must replace this guard when those authorities exist.
      IF NEW.row_version <> OLD.row_version + 1 OR NOT (
        OLD.state = 'active' AND NEW.state = 'retiring'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_key_transition_invalid';
      END IF;

      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_key_guard_truncate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'recovery_archive_key_truncate_not_authorized';
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_key_reference_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      PERFORM 1
        FROM public.meta_recovery_archive_keys key_row
       WHERE key_row.key_id = NEW.key_id
         AND key_row.state = 'active'
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_key_reference_unavailable';
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_key_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_keys
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_key_guard_row()
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_key_guard_truncate
    BEFORE TRUNCATE ON public.meta_recovery_archive_keys
    FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_key_guard_truncate()
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_recovery_archives
      ADD CONSTRAINT fk_meta_recovery_archives_key
      FOREIGN KEY (key_id)
      REFERENCES public.meta_recovery_archive_keys(key_id)
      ON UPDATE RESTRICT
      ON DELETE RESTRICT
      NOT DEFERRABLE
  `.execute(db)

  // Staging rows already lock and require the exact parent generation key in
  // meta_recovery_archive_staging_object_guard_row(). The parent FK above therefore
  // carries registry admission transitively; a second staging FK would be redundant.

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_key_reference_guard_row
    BEFORE INSERT ON public.meta_recovery_archives
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_key_reference_guard_row()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.meta_recovery_archives LIMIT 1)
         OR EXISTS (SELECT 1 FROM public.meta_recovery_archive_keys LIMIT 1) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_key_registry_nonempty';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DROP TRIGGER trg_meta_recovery_archive_key_reference_guard_row
      ON public.meta_recovery_archives
  `.execute(db)
  await sql`
    ALTER TABLE public.meta_recovery_archives
      DROP CONSTRAINT fk_meta_recovery_archives_key
  `.execute(db)
  await sql`
    DROP TRIGGER trg_meta_recovery_archive_key_guard_truncate
      ON public.meta_recovery_archive_keys
  `.execute(db)
  await sql`
    DROP TRIGGER trg_meta_recovery_archive_key_guard_row
      ON public.meta_recovery_archive_keys
  `.execute(db)
  await sql`DROP TABLE public.meta_recovery_archive_keys`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_key_reference_guard_row()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_key_guard_truncate()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_key_guard_row()`.execute(db)
}
