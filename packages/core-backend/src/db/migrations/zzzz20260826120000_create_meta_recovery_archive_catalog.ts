import { sql, type Kysely } from 'kysely'

/**
 * Phase D2a: inert recovery-archive catalog substrate.
 *
 * This migration creates catalog constraints only. It does not register a flag, add a runtime
 * writer/reader, or authorize archive verification, pruning, retention, or object deletion.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Fail before creating anything when either the source schema or an owned object name drifted.
  // The migration intentionally avoids IF NOT EXISTS/CREATE OR REPLACE in up(): a same-name object
  // must never make a partial or wrong catalog look successfully installed.
  await sql`
    DO $$
    DECLARE
      source_mismatch_count integer;
      owned_object_count integer;
    BEGIN
      WITH expected(relation_name, column_name, type_name, is_not_null) AS (
        VALUES
          ('meta_bases', 'id', 'text', true),
          ('meta_bases', 'workspace_id', 'text', false),
          ('meta_sheets', 'id', 'text', true),
          ('meta_sheets', 'base_id', 'text', false),
          ('meta_sheets', 'system_kind', 'text', false),
          ('meta_record_history_operations', 'sheet_id', 'text', true),
          ('meta_record_history_operations', 'operation_id', 'uuid', true),
          ('meta_record_history_operations', 'endpoint_seq', 'bigint', true),
          ('meta_history_trust_checkpoints', 'id', 'text', true),
          ('meta_history_trust_checkpoints', 'sheet_id', 'text', true),
          ('meta_history_trust_checkpoints', 'state', 'text', true),
          ('meta_history_trust_checkpoints', 'trusted_since_seq', 'bigint', true),
          ('meta_history_trust_checkpoints', 'pruned_at', 'timestamp with time zone', false)
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

      IF source_mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_source_schema_mismatch';
      END IF;

      SELECT count(*)::integer
        INTO owned_object_count
        FROM (
          SELECT pg_catalog.to_regclass(name) AS object_oid
            FROM unnest(ARRAY[
              'public.meta_recovery_archives',
              'public.meta_recovery_archive_coverage_items',
              'public.meta_recovery_archive_attachment_refs',
              'public.idx_meta_recovery_archives_sheet_state',
              'public.idx_meta_recovery_archives_anchor',
              'public.idx_meta_recovery_archive_coverage_source',
              'public.idx_meta_recovery_archive_attachment_lookup'
            ]::text[]) AS names(name)
        ) owned_relations
       WHERE owned_relations.object_oid IS NOT NULL;

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_recovery_archives_guard_row',
             'meta_recovery_archive_coverage_guard_row',
             'meta_recovery_archive_attachment_ref_guard_row'
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
             'trg_meta_recovery_archives_guard_row',
             'trg_meta_recovery_archive_coverage_guard_row',
             'trg_meta_recovery_archive_attachment_ref_guard_row'
           )
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_catalog_object_conflict';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archives (
      generation_id uuid NOT NULL,
      workspace_id text NOT NULL,
      base_id text NOT NULL,
      sheet_id text NOT NULL,
      anchor_operation_id uuid NOT NULL,
      anchor_seq bigint NOT NULL,
      checkpoint_id text NOT NULL,
      format_version integer NOT NULL DEFAULT 1,
      state text NOT NULL DEFAULT 'building',
      build_status text NOT NULL DEFAULT 'active',
      coverage_status text NOT NULL DEFAULT 'incomplete',
      source_vector_hash text NOT NULL,
      key_id text NOT NULL,
      root_hash text,
      coverage_section_hash text,
      coverage_row_count bigint,
      manifest_mac bytea,
      owner_kind text NOT NULL,
      owner_id text NOT NULL,
      owner_fence bigint NOT NULL,
      lease_expires_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      superseded_by_generation_id uuid,
      CONSTRAINT pk_meta_recovery_archives PRIMARY KEY (generation_id),
      CONSTRAINT fk_meta_recovery_archives_base
        FOREIGN KEY (base_id) REFERENCES public.meta_bases(id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archives_sheet
        FOREIGN KEY (sheet_id) REFERENCES public.meta_sheets(id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archives_anchor
        FOREIGN KEY (sheet_id, anchor_operation_id)
        REFERENCES public.meta_record_history_operations(sheet_id, operation_id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archives_checkpoint
        FOREIGN KEY (checkpoint_id)
        REFERENCES public.meta_history_trust_checkpoints(id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archives_superseded_by
        FOREIGN KEY (superseded_by_generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT chk_meta_recovery_archives_anchor_seq CHECK (anchor_seq >= 1),
      CONSTRAINT chk_meta_recovery_archives_format_version CHECK (format_version = 1),
      CONSTRAINT chk_meta_recovery_archives_state
        CHECK (state IN ('building', 'verified', 'expired')),
      CONSTRAINT chk_meta_recovery_archives_build_status
        CHECK (build_status IN ('active', 'finalized', 'abandoned')),
      CONSTRAINT chk_meta_recovery_archives_coverage_status
        CHECK (coverage_status IN ('incomplete', 'complete')),
      CONSTRAINT chk_meta_recovery_archives_posture CHECK (
        (state = 'building' AND build_status = 'active' AND coverage_status = 'incomplete') OR
        (state = 'building' AND build_status = 'abandoned' AND coverage_status = 'incomplete') OR
        (state = 'verified' AND build_status = 'finalized' AND coverage_status = 'complete') OR
        (state = 'expired' AND build_status = 'finalized' AND coverage_status = 'complete')
      ),
      CONSTRAINT chk_meta_recovery_archives_source_vector_hash
        CHECK (source_vector_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archives_root_hash
        CHECK (root_hash IS NULL OR root_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archives_coverage_section_hash
        CHECK (coverage_section_hash IS NULL OR coverage_section_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archives_coverage_row_count
        CHECK (coverage_row_count IS NULL OR coverage_row_count >= 0),
      CONSTRAINT chk_meta_recovery_archives_manifest_mac
        CHECK (manifest_mac IS NULL OR octet_length(manifest_mac) > 0),
      CONSTRAINT chk_meta_recovery_archives_finalized_fields CHECK (
        state = 'building' OR (
          root_hash IS NOT NULL AND
          coverage_section_hash IS NOT NULL AND
          coverage_row_count IS NOT NULL AND
          manifest_mac IS NOT NULL
        )
      ),
      CONSTRAINT chk_meta_recovery_archives_owner_kind CHECK (length(btrim(owner_kind)) > 0),
      CONSTRAINT chk_meta_recovery_archives_owner_id CHECK (length(btrim(owner_id)) > 0),
      CONSTRAINT chk_meta_recovery_archives_key_id CHECK (length(btrim(key_id)) > 0),
      CONSTRAINT chk_meta_recovery_archives_owner_fence CHECK (owner_fence >= 1),
      CONSTRAINT chk_meta_recovery_archives_not_self_superseded
        CHECK (superseded_by_generation_id IS NULL OR superseded_by_generation_id <> generation_id)
    )
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_coverage_items (
      generation_id uuid NOT NULL,
      source_kind text NOT NULL,
      source_id text NOT NULL,
      source_seq bigint,
      source_sha256 text NOT NULL,
      bound_section text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_recovery_archive_coverage_items
        PRIMARY KEY (generation_id, source_kind, source_id),
      CONSTRAINT fk_meta_recovery_archive_coverage_generation
        FOREIGN KEY (generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT chk_meta_recovery_archive_coverage_source_kind CHECK (
        source_kind IN (
          'record_revision',
          'marker',
          'section_revision',
          'config_revision',
          'field_tombstone',
          'link_tombstone',
          'checkpoint_baseline',
          'sealed_operation_endpoint',
          'snapshot_membership',
          'aggregate_membership'
        )
      ),
      CONSTRAINT chk_meta_recovery_archive_coverage_source_id
        CHECK (length(btrim(source_id)) > 0),
      CONSTRAINT chk_meta_recovery_archive_coverage_source_seq
        CHECK (source_seq IS NULL OR source_seq >= 1),
      CONSTRAINT chk_meta_recovery_archive_coverage_source_sha256
        CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
      -- coverage_index is deliberately absent: D1 defines it as derived and never self-covering.
      CONSTRAINT chk_meta_recovery_archive_coverage_bound_section CHECK (
        bound_section IN (
          'schema',
          'records',
          'links',
          'field_value_tombstones',
          'link_tombstones',
          'auto_number',
          'attachments_index',
          'permission_evidence',
          'views_config'
        )
      )
    )
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_attachment_refs (
      generation_id uuid NOT NULL,
      attachment_id text NOT NULL,
      reference_class text NOT NULL,
      reference_state text NOT NULL,
      availability text NOT NULL,
      content_sha256 text,
      source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_recovery_archive_attachment_refs
        PRIMARY KEY (generation_id, attachment_id, reference_class),
      CONSTRAINT fk_meta_recovery_archive_attachment_generation
        FOREIGN KEY (generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT chk_meta_recovery_archive_attachment_reference_class
        CHECK (reference_class IN ('source', 'archive_object')),
      CONSTRAINT chk_meta_recovery_archive_attachment_reference_state
        CHECK (reference_state IN ('building', 'verified')),
      CONSTRAINT chk_meta_recovery_archive_attachment_reference_pair CHECK (
        (reference_class = 'source' AND reference_state = 'building') OR
        (reference_class = 'archive_object' AND reference_state = 'verified')
      ),
      CONSTRAINT chk_meta_recovery_archive_attachment_availability
        CHECK (availability IN ('available', 'missing', 'mutable', 'drifted')),
      CONSTRAINT chk_meta_recovery_archive_attachment_id
        CHECK (length(btrim(attachment_id)) > 0),
      CONSTRAINT chk_meta_recovery_archive_attachment_content_sha256
        CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archive_attachment_source_metadata
        CHECK (jsonb_typeof(source_metadata) = 'object'),
      CONSTRAINT chk_meta_recovery_archive_attachment_verified_shape CHECK (
        reference_class <> 'archive_object' OR
        (availability = 'available' AND content_sha256 IS NOT NULL)
      )
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_meta_recovery_archives_sheet_state
      ON public.meta_recovery_archives(sheet_id, state, coverage_status, expires_at)
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_recovery_archives_anchor
      ON public.meta_recovery_archives(sheet_id, anchor_operation_id, anchor_seq)
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_recovery_archive_coverage_source
      ON public.meta_recovery_archive_coverage_items(source_kind, source_id, generation_id)
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_recovery_archive_attachment_lookup
      ON public.meta_recovery_archive_attachment_refs(
        attachment_id, reference_class, reference_state, generation_id
      )
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archives_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      coverage_count bigint;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_delete_not_authorized';
      END IF;

      IF TG_OP = 'UPDATE' AND (
        NEW.generation_id IS DISTINCT FROM OLD.generation_id OR
        NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
        NEW.base_id IS DISTINCT FROM OLD.base_id OR
        NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR
        NEW.anchor_operation_id IS DISTINCT FROM OLD.anchor_operation_id OR
        NEW.anchor_seq IS DISTINCT FROM OLD.anchor_seq OR
        NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id OR
        NEW.format_version IS DISTINCT FROM OLD.format_version OR
        NEW.source_vector_hash IS DISTINCT FROM OLD.source_vector_hash OR
        NEW.key_id IS DISTINCT FROM OLD.key_id OR
        NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
        NEW.created_at IS DISTINCT FROM OLD.created_at
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_identity_immutable';
      END IF;

      IF NEW.workspace_id IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_binding_invalid';
      END IF;

      IF NEW.generation_id IS NULL
         OR NEW.base_id IS NULL
         OR NEW.sheet_id IS NULL
         OR NEW.anchor_operation_id IS NULL
         OR NEW.anchor_seq IS NULL
         OR NEW.anchor_seq < 1
         OR NEW.checkpoint_id IS NULL
         OR NEW.format_version IS NULL
         OR NEW.format_version <> 1
         OR NEW.state IS NULL
         OR NEW.build_status IS NULL
         OR NEW.coverage_status IS NULL
         OR NEW.source_vector_hash IS NULL
         OR NEW.source_vector_hash !~ '^[0-9a-f]{64}$'
         OR NEW.key_id IS NULL
         OR length(btrim(NEW.key_id)) = 0
         OR (NEW.root_hash IS NOT NULL AND NEW.root_hash !~ '^[0-9a-f]{64}$')
         OR (
           NEW.coverage_section_hash IS NOT NULL AND
           NEW.coverage_section_hash !~ '^[0-9a-f]{64}$'
         )
         OR (NEW.coverage_row_count IS NOT NULL AND NEW.coverage_row_count < 0)
         OR (NEW.manifest_mac IS NOT NULL AND octet_length(NEW.manifest_mac) = 0)
         OR NEW.owner_kind IS NULL
         OR length(btrim(NEW.owner_kind)) = 0
         OR NEW.owner_id IS NULL
         OR length(btrim(NEW.owner_id)) = 0
         OR NEW.owner_fence IS NULL
         OR NEW.owner_fence < 1
         OR NEW.lease_expires_at IS NULL
         OR NEW.expires_at IS NULL
         OR NEW.created_at IS NULL
         OR NEW.updated_at IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_catalog_shape_invalid';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
          SELECT 1
            FROM public.meta_sheets sheet
            JOIN public.meta_bases base ON base.id = sheet.base_id
            JOIN public.meta_record_history_operations operation
              ON operation.sheet_id = sheet.id
             AND operation.operation_id = NEW.anchor_operation_id
             AND operation.endpoint_seq = NEW.anchor_seq
            JOIN public.meta_history_trust_checkpoints checkpoint
              ON checkpoint.id = NEW.checkpoint_id
             AND checkpoint.sheet_id = sheet.id
             AND checkpoint.state IN ('active', 'superseded')
             AND checkpoint.pruned_at IS NULL
             AND checkpoint.trusted_since_seq <= NEW.anchor_seq
           WHERE sheet.id = NEW.sheet_id
             AND sheet.base_id = NEW.base_id
             AND base.id = NEW.base_id
             AND base.workspace_id IS NOT NULL
             AND base.workspace_id = NEW.workspace_id
             AND sheet.system_kind IS NULL
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_binding_invalid';
        END IF;

        IF NEW.state <> 'building'
           OR NEW.build_status <> 'active'
           OR NEW.coverage_status <> 'incomplete' THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_initial_posture_invalid';
        END IF;

        IF NEW.superseded_by_generation_id IS NOT NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_supersession_invalid';
        END IF;

        RETURN NEW;
      END IF;

      IF NEW.state IS DISTINCT FROM OLD.state
         OR NEW.build_status IS DISTINCT FROM OLD.build_status
         OR NEW.coverage_status IS DISTINCT FROM OLD.coverage_status THEN
        IF NOT (
          (
            OLD.state = 'building' AND
            OLD.build_status = 'active' AND
            OLD.coverage_status = 'incomplete' AND
            NEW.state = 'verified' AND
            NEW.build_status = 'finalized' AND
            NEW.coverage_status = 'complete'
          ) OR (
            OLD.state = 'building' AND
            OLD.build_status = 'active' AND
            OLD.coverage_status = 'incomplete' AND
            NEW.state = 'building' AND
            NEW.build_status = 'abandoned' AND
            NEW.coverage_status = 'incomplete'
          ) OR (
            OLD.state = 'verified' AND
            OLD.build_status = 'finalized' AND
            OLD.coverage_status = 'complete' AND
            NEW.state = 'expired' AND
            NEW.build_status = 'finalized' AND
            NEW.coverage_status = 'complete'
          )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_transition_invalid';
        END IF;
      END IF;

      IF OLD.state IN ('verified', 'expired') AND (
        NEW.root_hash IS DISTINCT FROM OLD.root_hash OR
        NEW.coverage_section_hash IS DISTINCT FROM OLD.coverage_section_hash OR
        NEW.coverage_row_count IS DISTINCT FROM OLD.coverage_row_count OR
        NEW.manifest_mac IS DISTINCT FROM OLD.manifest_mac
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_payload_immutable';
      END IF;

      IF OLD.superseded_by_generation_id IS NOT NULL
         AND NEW.superseded_by_generation_id IS DISTINCT FROM OLD.superseded_by_generation_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_supersession_immutable';
      END IF;

      IF OLD.superseded_by_generation_id IS NULL
         AND NEW.superseded_by_generation_id IS NOT NULL THEN
        IF OLD.state NOT IN ('verified', 'expired') OR NOT EXISTS (
          SELECT 1
            FROM public.meta_recovery_archives replacement
           WHERE replacement.generation_id = NEW.superseded_by_generation_id
             AND replacement.generation_id <> NEW.generation_id
             AND replacement.workspace_id = NEW.workspace_id
             AND replacement.base_id = NEW.base_id
             AND replacement.sheet_id = NEW.sheet_id
             AND replacement.anchor_operation_id = NEW.anchor_operation_id
             AND replacement.anchor_seq = NEW.anchor_seq
             AND replacement.checkpoint_id = NEW.checkpoint_id
             AND replacement.format_version = NEW.format_version
             AND replacement.state = 'verified'
             AND replacement.build_status = 'finalized'
             AND replacement.coverage_status = 'complete'
             AND replacement.superseded_by_generation_id IS DISTINCT FROM NEW.generation_id
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_supersession_invalid';
        END IF;
      END IF;

      IF OLD.state = 'building' AND NEW.state = 'verified' THEN
        IF NEW.root_hash IS NULL
           OR NEW.coverage_section_hash IS NULL
           OR NEW.coverage_row_count IS NULL
           OR NEW.manifest_mac IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_finalized_fields_missing';
        END IF;

        SELECT count(*)::bigint
          INTO coverage_count
          FROM public.meta_recovery_archive_coverage_items coverage
         WHERE coverage.generation_id = NEW.generation_id;

        IF NEW.coverage_row_count <> coverage_count THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_coverage_count_mismatch';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM public.meta_recovery_archive_attachment_refs attachment_ref
           WHERE attachment_ref.generation_id = NEW.generation_id
             AND attachment_ref.reference_class = 'source'
             AND attachment_ref.reference_state = 'building'
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_posture_invalid';
        END IF;
      END IF;

      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_coverage_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_coverage_immutable';
      END IF;

      PERFORM 1
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id
         AND archive.state = 'building'
         AND archive.build_status = 'active'
         AND archive.coverage_status = 'incomplete'
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_coverage_parent_posture_invalid';
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_attachment_ref_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      parent_state text;
      parent_build_status text;
      parent_coverage_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.reference_class = 'archive_object' AND OLD.reference_state = 'verified' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_ref_immutable';
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
        NEW.updated_at := clock_timestamp();
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
          parent_state IN ('verified', 'expired') AND
          parent_build_status = 'finalized' AND
          parent_coverage_status = 'complete'
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
    CREATE TRIGGER trg_meta_recovery_archives_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archives
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archives_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_coverage_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_coverage_items
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_coverage_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_attachment_ref_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_attachment_refs
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_attachment_ref_guard_row()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Development-only rollback. Inspect all three relations before dropping any object; the static
  // refusal is deliberately values-free and never reports a catalog identity.
  await sql`
    DO $$
    DECLARE
      catalog_nonempty boolean := false;
      relation_nonempty boolean;
      relation_name text;
    BEGIN
      FOREACH relation_name IN ARRAY ARRAY[
        'meta_recovery_archives',
        'meta_recovery_archive_coverage_items',
        'meta_recovery_archive_attachment_refs'
      ]::text[] LOOP
        IF pg_catalog.to_regclass('public.' || relation_name) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)',
            relation_name
          ) INTO relation_nonempty;
          catalog_nonempty := catalog_nonempty OR relation_nonempty;
        END IF;
      END LOOP;

      IF catalog_nonempty THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_catalog_nonempty';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_attachment_refs') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_recovery_archive_attachment_ref_guard_row
          ON public.meta_recovery_archive_attachment_refs;
      END IF;
      IF pg_catalog.to_regclass('public.meta_recovery_archive_coverage_items') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_recovery_archive_coverage_guard_row
          ON public.meta_recovery_archive_coverage_items;
      END IF;
      IF pg_catalog.to_regclass('public.meta_recovery_archives') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_recovery_archives_guard_row
          ON public.meta_recovery_archives;
      END IF;
    END $$;
  `.execute(db)

  await sql`DROP INDEX IF EXISTS public.idx_meta_recovery_archive_attachment_lookup`.execute(db)
  await sql`DROP INDEX IF EXISTS public.idx_meta_recovery_archive_coverage_source`.execute(db)
  await sql`DROP INDEX IF EXISTS public.idx_meta_recovery_archives_anchor`.execute(db)
  await sql`DROP INDEX IF EXISTS public.idx_meta_recovery_archives_sheet_state`.execute(db)

  await sql`DROP TABLE IF EXISTS public.meta_recovery_archive_attachment_refs`.execute(db)
  await sql`DROP TABLE IF EXISTS public.meta_recovery_archive_coverage_items`.execute(db)
  await sql`DROP TABLE IF EXISTS public.meta_recovery_archives`.execute(db)

  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_attachment_ref_guard_row()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archive_coverage_guard_row()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archives_guard_row()`.execute(db)
}
