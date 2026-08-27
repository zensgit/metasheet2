import { sql, type Kysely } from 'kysely'

/**
 * Phase D-I0: immutable generation-bound identities for the one-time section bootstrap and its
 * archive-snapshot parent. This migration adds substrate only; no route or worker consumes it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      owned_object_count integer;
      prerequisite_count integer;
    BEGIN
      SELECT count(*)::integer
        INTO owned_object_count
        FROM (
          SELECT pg_catalog.to_regclass(name) AS object_oid
            FROM unnest(ARRAY[
              'public.meta_recovery_archive_snapshot_reservations',
              'public.uq_mrasr_parent_per_generation'
            ]::text[]) AS names(name)
        ) owned_relations
       WHERE owned_relations.object_oid IS NOT NULL;

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_recovery_archive_snapshot_reservation_guard_row',
             'meta_recovery_archive_snapshot_reservation_guard_set',
             'meta_recovery_archive_snapshot_reservation_guard_truncate'
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
             'trg_mrasr_guard_row',
             'trg_mrasr_guard_set',
             'trg_mrasr_guard_truncate'
           )
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_object_conflict';
      END IF;

      SELECT count(*)::integer
        INTO prerequisite_count
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'meta_recovery_archives' AND column_name = 'generation_id' AND udt_name = 'uuid' AND is_nullable = 'NO') OR
           (table_name = 'meta_recovery_archives' AND column_name = 'sheet_id' AND data_type = 'text' AND is_nullable = 'NO') OR
           (table_name = 'meta_recovery_archives' AND column_name = 'source_vector_hash' AND data_type = 'text' AND is_nullable = 'NO') OR
           (table_name = 'meta_recovery_archives' AND column_name = 'owner_kind' AND data_type = 'text' AND is_nullable = 'NO') OR
           (table_name = 'meta_recovery_archives' AND column_name = 'owner_id' AND data_type = 'text' AND is_nullable = 'NO') OR
           (table_name = 'meta_recovery_archives' AND column_name = 'owner_fence' AND data_type = 'bigint' AND is_nullable = 'NO') OR
           (table_name = 'meta_recovery_archives' AND column_name = 'state' AND data_type = 'text' AND is_nullable = 'NO') OR
           (table_name = 'meta_recovery_archives' AND column_name = 'build_status' AND data_type = 'text' AND is_nullable = 'NO') OR
           (table_name = 'meta_recovery_archives' AND column_name = 'coverage_status' AND data_type = 'text' AND is_nullable = 'NO')
         );

      IF prerequisite_count <> 9
         OR pg_catalog.to_regclass('public.meta_record_chain_seq') IS NULL
         OR pg_catalog.to_regclass('public.meta_record_history_operations') IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_source_schema_mismatch';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_snapshot_reservations (
      generation_id uuid NOT NULL,
      sheet_id text NOT NULL,
      source_vector_hash text NOT NULL,
      owner_kind text NOT NULL,
      owner_id text NOT NULL,
      owner_fence bigint NOT NULL,
      ordinal integer NOT NULL,
      reservation_kind text NOT NULL,
      section_kind text,
      operation_id uuid NOT NULL,
      endpoint_seq bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_recovery_archive_snapshot_reservations
        PRIMARY KEY (generation_id, ordinal),
      CONSTRAINT uq_mrasr_operation UNIQUE (operation_id),
      CONSTRAINT uq_mrasr_endpoint_seq UNIQUE (endpoint_seq),
      CONSTRAINT uq_mrasr_generation_section UNIQUE (generation_id, section_kind),
      CONSTRAINT fk_mrasr_generation
        FOREIGN KEY (generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT chk_mrasr_source_vector_hash
        CHECK (source_vector_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_mrasr_owner_kind CHECK (length(btrim(owner_kind)) > 0),
      CONSTRAINT chk_mrasr_owner_id CHECK (length(btrim(owner_id)) > 0),
      CONSTRAINT chk_mrasr_owner_fence CHECK (owner_fence >= 1),
      CONSTRAINT chk_mrasr_endpoint_seq CHECK (endpoint_seq >= 1),
      CONSTRAINT chk_mrasr_shape CHECK (
        (
          reservation_kind = 'section_bootstrap' AND
          ordinal BETWEEN 1 AND 9 AND
          section_kind IN (
            'schema', 'records', 'links', 'field_value_tombstones', 'link_tombstones',
            'auto_number', 'attachments_index', 'permission_evidence', 'views_config'
          )
        ) OR (
          reservation_kind = 'archive_snapshot' AND
          ordinal = 10 AND
          section_kind IS NULL
        )
      )
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX uq_mrasr_parent_per_generation
      ON public.meta_recovery_archive_snapshot_reservations(generation_id)
      WHERE reservation_kind = 'archive_snapshot'
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      parent_row record;
      expected_section text;
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_immutable';
      END IF;

      expected_section := (ARRAY[
        'schema', 'records', 'links', 'field_value_tombstones', 'link_tombstones',
        'auto_number', 'attachments_index', 'permission_evidence', 'views_config'
      ]::text[])[NEW.ordinal];

      IF NEW.generation_id IS NULL
         OR NEW.sheet_id IS NULL
         OR length(btrim(NEW.sheet_id)) = 0
         OR NEW.source_vector_hash IS NULL
         OR NEW.source_vector_hash !~ '^[0-9a-f]{64}$'
         OR NEW.owner_kind IS NULL
         OR length(btrim(NEW.owner_kind)) = 0
         OR NEW.owner_id IS NULL
         OR length(btrim(NEW.owner_id)) = 0
         OR NEW.owner_fence IS NULL
         OR NEW.owner_fence < 1
         OR NEW.operation_id IS NULL
         OR NEW.endpoint_seq IS NULL
         OR NEW.endpoint_seq < 1
         OR NEW.created_at IS NULL
         OR NOT (
           (
             NEW.reservation_kind = 'section_bootstrap' AND
             NEW.ordinal BETWEEN 1 AND 9 AND
             NEW.section_kind IS NOT DISTINCT FROM expected_section
           ) OR (
             NEW.reservation_kind = 'archive_snapshot' AND
             NEW.ordinal = 10 AND
             NEW.section_kind IS NULL
           )
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_snapshot_reservation_shape_invalid';
      END IF;

      SELECT archive.sheet_id, archive.source_vector_hash, archive.owner_kind, archive.owner_id,
             archive.owner_fence, archive.state, archive.build_status, archive.coverage_status
        INTO parent_row
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id
       FOR KEY SHARE;

      IF NOT FOUND
         OR parent_row.sheet_id IS DISTINCT FROM NEW.sheet_id
         OR parent_row.source_vector_hash IS DISTINCT FROM NEW.source_vector_hash
         OR parent_row.owner_kind IS DISTINCT FROM NEW.owner_kind
         OR parent_row.owner_id IS DISTINCT FROM NEW.owner_id
         OR parent_row.owner_fence IS DISTINCT FROM NEW.owner_fence
         OR parent_row.state IS DISTINCT FROM 'building'
         OR parent_row.build_status IS DISTINCT FROM 'active'
         OR parent_row.coverage_status IS DISTINCT FROM 'incomplete' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_parent_invalid';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM public.meta_record_history_operations operation_row
         WHERE operation_row.sheet_id = NEW.sheet_id
           AND operation_row.operation_id = NEW.operation_id
      ) OR EXISTS (
        SELECT 1
          FROM public.meta_record_history_operations operation_row
         WHERE operation_row.sheet_id = NEW.sheet_id
           AND operation_row.endpoint_seq = NEW.endpoint_seq
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_identity_conflict';
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_set()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      row_count integer;
      section_count integer;
      parent_count integer;
      max_section_seq bigint;
      parent_seq bigint;
    BEGIN
      SELECT count(*)::integer,
             count(*) FILTER (WHERE reservation_kind = 'section_bootstrap')::integer,
             count(*) FILTER (WHERE reservation_kind = 'archive_snapshot')::integer,
             max(endpoint_seq) FILTER (WHERE reservation_kind = 'section_bootstrap'),
             max(endpoint_seq) FILTER (WHERE reservation_kind = 'archive_snapshot')
        INTO row_count, section_count, parent_count, max_section_seq, parent_seq
        FROM public.meta_recovery_archive_snapshot_reservations
       WHERE generation_id = NEW.generation_id;

      IF row_count <> 10
         OR section_count <> 9
         OR parent_count <> 1
         OR max_section_seq IS NULL
         OR parent_seq IS NULL
         OR parent_seq <= max_section_seq THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_snapshot_reservation_set_invalid';
      END IF;

      RETURN NULL;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_truncate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations LIMIT 1
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_immutable';
      END IF;
      RETURN NULL;
    END $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_mrasr_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_snapshot_reservations
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_row()
  `.execute(db)

  await sql`
    CREATE CONSTRAINT TRIGGER trg_mrasr_guard_set
    AFTER INSERT ON public.meta_recovery_archive_snapshot_reservations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_set()
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_mrasr_guard_truncate
    BEFORE TRUNCATE ON public.meta_recovery_archive_snapshot_reservations
    FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_truncate()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_snapshot_reservations') IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations LIMIT 1) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_nonempty';
      END IF;
    END $$
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_snapshot_reservations') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_mrasr_guard_truncate
          ON public.meta_recovery_archive_snapshot_reservations;
        DROP TRIGGER IF EXISTS trg_mrasr_guard_set
          ON public.meta_recovery_archive_snapshot_reservations;
        DROP TRIGGER IF EXISTS trg_mrasr_guard_row
          ON public.meta_recovery_archive_snapshot_reservations;
      END IF;
    END $$
  `.execute(db)

  await sql`DROP TABLE IF EXISTS public.meta_recovery_archive_snapshot_reservations`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_snapshot_reservation_guard_truncate()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_snapshot_reservation_guard_set()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_snapshot_reservation_guard_row()`.execute(db)
}
