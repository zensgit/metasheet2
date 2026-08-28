import { sql, type Kysely } from 'kysely'

/**
 * Bounded D3 D-L storage authority for normalized archive legal holds.
 *
 * This slice has no route, authorization adapter, production caller, deletion intent, object
 * deletion worker, or KMS/provider operation. In particular, it does not close the future
 * hold-placement-versus-`deleting` race because that deletion state machine does not exist yet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      source_mismatch_count integer;
      predecessor_function_count integer;
      claim_anchor_function_count integer;
      claim_anchor_function_total_count integer;
      claim_anchor_trigger_count integer;
      claim_anchor_trigger_total_count integer;
      legacy_parent_trigger_count integer;
      archive_operation_fk_count integer;
      key_reference_function_count integer;
      key_reference_trigger_count integer;
      key_reference_constraint_count integer;
      owned_object_count integer;
    BEGIN
      WITH expected(relation_name, column_name, type_name, is_not_null) AS (
        VALUES
          ('meta_recovery_archives', 'generation_id', 'uuid', true),
          ('meta_recovery_archives', 'workspace_id', 'text', true),
          ('meta_recovery_archives', 'base_id', 'text', true),
          ('meta_recovery_archives', 'sheet_id', 'text', true),
          ('meta_recovery_archives', 'key_id', 'text', true),
          ('meta_recovery_archives', 'state', 'text', true),
          ('meta_recovery_archive_keys', 'key_id', 'text', true),
          ('meta_recovery_archive_keys', 'state', 'text', true)
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
        INTO predecessor_function_count
        FROM pg_catalog.pg_proc procedure_row
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure_row.proname = 'meta_recovery_archives_guard_row'
         AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
         AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND procedure_row.provolatile = 'v'
         AND NOT procedure_row.prosecdef
         AND procedure_row.prokind = 'f'
         AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
         AND pg_catalog.md5(procedure_row.prosrc) = '3700d86df374ad924cc4b6af265d146a';

      WITH expected(function_name, body_md5) AS (
        VALUES
          ('meta_recovery_archives_claim_anchor_guard_row', 'b6e6b71be4d9ed95d8480568f44b6716'),
          ('meta_recovery_archives_claim_anchor_reservation_guard', 'a0bd46293194e845c2b853926f35f9c5'),
          ('meta_recovery_archives_claim_anchor_operation_delete_guard', 'd141905b7a84fc0438b4fdd2aaf22f40')
      )
      SELECT count(*)::integer
        INTO claim_anchor_function_count
        FROM expected
        JOIN pg_catalog.pg_proc procedure_row
          ON procedure_row.proname = expected.function_name
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
         AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND procedure_row.provolatile = 'v'
         AND NOT procedure_row.prosecdef
         AND procedure_row.prokind = 'f'
         AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
         AND pg_catalog.md5(procedure_row.prosrc) = expected.body_md5;

      SELECT count(*)::integer
        INTO claim_anchor_function_total_count
        FROM pg_catalog.pg_proc procedure_row
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure_row.proname IN (
           'meta_recovery_archives_claim_anchor_guard_row',
           'meta_recovery_archives_claim_anchor_reservation_guard',
           'meta_recovery_archives_claim_anchor_operation_delete_guard'
         );

      WITH expected(
        relation_name,
        trigger_name,
        function_name,
        trigger_type,
        is_constraint,
        is_deferrable,
        is_initially_deferred
      ) AS (
        VALUES
          (
            'meta_recovery_archives',
            'trg_meta_recovery_archives_claim_anchor_guard_row',
            'meta_recovery_archives_claim_anchor_guard_row',
            31,
            false,
            false,
            false
          ),
          (
            'meta_recovery_archives',
            'trg_meta_recovery_archives_claim_anchor_reservation_guard',
            'meta_recovery_archives_claim_anchor_reservation_guard',
            21,
            true,
            true,
            true
          ),
          (
            'meta_record_history_operations',
            'trg_mrho_claim_anchor_delete_guard',
            'meta_recovery_archives_claim_anchor_operation_delete_guard',
            11,
            false,
            false,
            false
          )
      )
      SELECT count(*)::integer
        INTO claim_anchor_trigger_count
        FROM expected
        JOIN pg_catalog.pg_class relation ON relation.relname = expected.relation_name
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_trigger trigger_row
          ON trigger_row.tgrelid = relation.oid
         AND trigger_row.tgname = expected.trigger_name
        JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
        JOIN pg_catalog.pg_namespace procedure_namespace
          ON procedure_namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure_namespace.nspname = 'public'
         AND procedure_row.proname = expected.function_name
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = expected.trigger_type
         AND (trigger_row.tgconstraint <> 0) = expected.is_constraint
         AND trigger_row.tgdeferrable = expected.is_deferrable
         AND trigger_row.tginitdeferred = expected.is_initially_deferred
         AND trigger_row.tgqual IS NULL;

      SELECT count(*)::integer
        INTO claim_anchor_trigger_total_count
        FROM pg_catalog.pg_trigger trigger_row
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgname IN (
           'trg_meta_recovery_archives_claim_anchor_guard_row',
           'trg_meta_recovery_archives_claim_anchor_reservation_guard',
           'trg_mrho_claim_anchor_delete_guard'
         );

      SELECT count(*)::integer
        INTO legacy_parent_trigger_count
        FROM pg_catalog.pg_trigger trigger_row
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archives'
         AND trigger_row.tgname = 'trg_meta_recovery_archives_guard_row'
         AND NOT trigger_row.tgisinternal;

      SELECT count(*)::integer
        INTO archive_operation_fk_count
        FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'public.meta_recovery_archives'::pg_catalog.regclass
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid =
             'public.meta_record_history_operations'::pg_catalog.regclass;

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

      IF source_mismatch_count <> 0
         OR predecessor_function_count <> 1
         OR claim_anchor_function_count <> 3
         OR claim_anchor_function_total_count <> 3
         OR claim_anchor_trigger_count <> 3
         OR claim_anchor_trigger_total_count <> 3
         OR legacy_parent_trigger_count <> 0
         OR archive_operation_fk_count <> 0
         OR key_reference_function_count <> 1
         OR key_reference_trigger_count <> 1
         OR key_reference_constraint_count <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_source_schema_mismatch';
      END IF;

      SELECT (
        (SELECT count(*) FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname IN (
             'meta_recovery_archive_legal_holds',
             'idx_meta_recovery_archive_legal_holds_active_generation',
             'idx_meta_recovery_archive_legal_holds_binding'
           )) +
        (SELECT count(*) FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_recovery_archive_legal_hold_guard_row',
             'meta_recovery_archive_legal_hold_guard_truncate',
             'meta_recovery_archive_legal_hold_expiry_guard_row',
             'meta_recovery_archive_expiry_authorize',
             'meta_recovery_archive_legal_hold_release_authorize'
           )) +
        (SELECT count(*) FROM pg_catalog.pg_trigger trigger_row
         WHERE trigger_row.tgname IN (
           'trg_meta_recovery_archive_legal_hold_guard_row',
           'trg_meta_recovery_archive_legal_hold_guard_truncate',
           'trg_meta_recovery_archives_legal_hold_expiry_guard_row'
         ) AND NOT trigger_row.tgisinternal)
      )::integer INTO owned_object_count;

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_object_conflict';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_legal_holds (
      id uuid NOT NULL,
      workspace_id text NOT NULL,
      base_id text NOT NULL,
      sheet_id text NOT NULL,
      generation_id uuid NOT NULL,
      state text NOT NULL DEFAULT 'active',
      reason_code text NOT NULL,
      placed_by_actor_id text NOT NULL,
      placed_at timestamptz NOT NULL DEFAULT now(),
      released_by_actor_id text,
      released_at timestamptz,
      row_version bigint NOT NULL DEFAULT 1,
      CONSTRAINT pk_meta_recovery_archive_legal_holds PRIMARY KEY (id),
      CONSTRAINT fk_meta_recovery_archive_legal_holds_generation
        FOREIGN KEY (generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_legal_holds_base
        FOREIGN KEY (base_id) REFERENCES public.meta_bases(id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_legal_holds_sheet
        FOREIGN KEY (sheet_id) REFERENCES public.meta_sheets(id) ON DELETE RESTRICT,
      CONSTRAINT chk_meta_recovery_archive_legal_holds_binding CHECK (
        length(btrim(workspace_id)) > 0 AND length(workspace_id) <= 512 AND
        length(btrim(base_id)) > 0 AND length(base_id) <= 512 AND
        length(btrim(sheet_id)) > 0 AND length(sheet_id) <= 512
      ),
      CONSTRAINT chk_meta_recovery_archive_legal_holds_state
        CHECK (state IN ('active', 'released')),
      CONSTRAINT chk_meta_recovery_archive_legal_holds_reason
        CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
      CONSTRAINT chk_meta_recovery_archive_legal_holds_actors CHECK (
        length(btrim(placed_by_actor_id)) > 0 AND length(placed_by_actor_id) <= 512 AND
        (
          released_by_actor_id IS NULL OR
          (length(btrim(released_by_actor_id)) > 0 AND length(released_by_actor_id) <= 512)
        )
      ),
      CONSTRAINT chk_meta_recovery_archive_legal_holds_row_version
        CHECK (row_version IN (1, 2)),
      CONSTRAINT chk_meta_recovery_archive_legal_holds_posture CHECK (
        (
          state = 'active' AND
          released_by_actor_id IS NULL AND
          released_at IS NULL AND
          row_version = 1
        ) OR (
          state = 'released' AND
          released_by_actor_id IS NOT NULL AND
          released_at IS NOT NULL AND
          row_version = 2
        )
      )
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX idx_meta_recovery_archive_legal_holds_active_generation
      ON public.meta_recovery_archive_legal_holds(generation_id)
      WHERE state = 'active'
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_recovery_archive_legal_holds_binding
      ON public.meta_recovery_archive_legal_holds(
        workspace_id, base_id, sheet_id, generation_id, state, id
      )
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_legal_hold_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      resolved_workspace_id text;
      resolved_base_id text;
      resolved_sheet_id text;
      resolved_key_id text;
      resolved_state text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_delete_not_authorized';
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
           OR NEW.base_id IS DISTINCT FROM OLD.base_id
           OR NEW.sheet_id IS DISTINCT FROM OLD.sheet_id
           OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
           OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
           OR NEW.placed_by_actor_id IS DISTINCT FROM OLD.placed_by_actor_id
           OR NEW.placed_at IS DISTINCT FROM OLD.placed_at THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_legal_hold_immutable';
        END IF;

        IF OLD.state <> 'active'
           OR OLD.row_version <> 1
           OR NEW.state <> 'released'
           OR NEW.row_version <> OLD.row_version + 1
           OR NEW.released_by_actor_id IS NULL
           OR length(btrim(NEW.released_by_actor_id)) = 0
           OR length(NEW.released_by_actor_id) > 512
           OR NEW.released_at IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_legal_hold_transition_invalid';
        END IF;

        IF current_setting('metasheet.recovery_archive_legal_hold_release_hold', true)
             IS DISTINCT FROM OLD.id::text
           OR current_setting('metasheet.recovery_archive_legal_hold_release_generation', true)
             IS DISTINCT FROM OLD.generation_id::text THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_legal_hold_release_not_authorized';
        END IF;

        RETURN NEW;
      END IF;

      IF NEW.id IS NULL
         OR NEW.workspace_id IS NULL
         OR length(btrim(NEW.workspace_id)) = 0
         OR length(NEW.workspace_id) > 512
         OR NEW.base_id IS NULL
         OR length(btrim(NEW.base_id)) = 0
         OR length(NEW.base_id) > 512
         OR NEW.sheet_id IS NULL
         OR length(btrim(NEW.sheet_id)) = 0
         OR length(NEW.sheet_id) > 512
         OR NEW.generation_id IS NULL
         OR NEW.state IS NULL
         OR NEW.state <> 'active'
         OR NEW.reason_code IS NULL
         OR NEW.reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
         OR NEW.placed_by_actor_id IS NULL
         OR length(btrim(NEW.placed_by_actor_id)) = 0
         OR length(NEW.placed_by_actor_id) > 512
         OR NEW.placed_at IS NULL
         OR NEW.released_by_actor_id IS NOT NULL
         OR NEW.released_at IS NOT NULL
         OR NEW.row_version IS NULL
         OR NEW.row_version <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_legal_hold_shape_invalid';
      END IF;

      SELECT archive.workspace_id,
             archive.base_id,
             archive.sheet_id,
             archive.key_id,
             archive.state
        INTO resolved_workspace_id,
             resolved_base_id,
             resolved_sheet_id,
             resolved_key_id,
             resolved_state
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id;

      IF NOT FOUND
         OR resolved_workspace_id IS DISTINCT FROM NEW.workspace_id
         OR resolved_base_id IS DISTINCT FROM NEW.base_id
         OR resolved_sheet_id IS DISTINCT FROM NEW.sheet_id
         OR resolved_state NOT IN ('verified', 'expired') THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_binding_invalid';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('meta:auto-number:sheet:' || resolved_sheet_id)
      );

      PERFORM 1
        FROM public.meta_recovery_archive_keys key_row
       WHERE key_row.key_id = resolved_key_id
         AND key_row.state = 'active'
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_key_unavailable';
      END IF;

      PERFORM 1
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id
         AND archive.workspace_id = resolved_workspace_id
         AND archive.base_id = resolved_base_id
         AND archive.sheet_id = resolved_sheet_id
         AND archive.key_id = resolved_key_id
         AND archive.state IN ('verified', 'expired')
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_binding_invalid';
      END IF;

      PERFORM 1
        FROM public.meta_recovery_archive_legal_holds hold_row
       WHERE hold_row.generation_id = NEW.generation_id
         AND hold_row.state = 'active'
       ORDER BY hold_row.id
       FOR UPDATE;

      IF FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_active_exists';
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_legal_hold_release_authorize(
      expected_hold_id uuid,
      expected_generation_id uuid,
      expected_workspace_id text,
      expected_base_id text,
      expected_sheet_id text,
      expected_row_version bigint
    )
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      resolved_workspace_id text;
      resolved_base_id text;
      resolved_sheet_id text;
      resolved_key_id text;
    BEGIN
      SELECT archive.workspace_id,
             archive.base_id,
             archive.sheet_id,
             archive.key_id
        INTO resolved_workspace_id,
             resolved_base_id,
             resolved_sheet_id,
             resolved_key_id
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = expected_generation_id;

      IF NOT FOUND
         OR resolved_workspace_id IS DISTINCT FROM expected_workspace_id
         OR resolved_base_id IS DISTINCT FROM expected_base_id
         OR resolved_sheet_id IS DISTINCT FROM expected_sheet_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_release_binding_invalid';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('meta:auto-number:sheet:' || resolved_sheet_id)
      );

      PERFORM 1
        FROM public.meta_recovery_archive_keys key_row
       WHERE key_row.key_id = resolved_key_id
         AND key_row.state = 'active'
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_release_key_unavailable';
      END IF;

      PERFORM 1
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = expected_generation_id
         AND archive.workspace_id = expected_workspace_id
         AND archive.base_id = expected_base_id
         AND archive.sheet_id = expected_sheet_id
         AND archive.key_id = resolved_key_id
         AND archive.state IN ('verified', 'expired')
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_release_binding_invalid';
      END IF;

      PERFORM 1
        FROM public.meta_recovery_archive_legal_holds hold_row
       WHERE hold_row.id = expected_hold_id
         AND hold_row.generation_id = expected_generation_id
         AND hold_row.workspace_id = expected_workspace_id
         AND hold_row.base_id = expected_base_id
         AND hold_row.sheet_id = expected_sheet_id
         AND hold_row.state = 'active'
         AND hold_row.row_version = expected_row_version
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_release_stale';
      END IF;

      PERFORM set_config(
        'metasheet.recovery_archive_legal_hold_release_hold',
        expected_hold_id::text,
        true
      );
      PERFORM set_config(
        'metasheet.recovery_archive_legal_hold_release_generation',
        expected_generation_id::text,
        true
      );
    END $$;
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_legal_hold_guard_truncate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'recovery_archive_legal_hold_delete_not_authorized';
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_legal_hold_expiry_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF OLD.state = 'verified' AND NEW.state = 'expired' THEN
        IF current_setting('metasheet.recovery_archive_expiry_generation', true)
             IS DISTINCT FROM OLD.generation_id::text THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_expiry_not_authorized';
        END IF;

        IF OLD.expires_at IS NULL OR OLD.expires_at > clock_timestamp() THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_expiry_not_due';
        END IF;

        PERFORM 1
          FROM public.meta_recovery_archive_legal_holds hold_row
         WHERE hold_row.generation_id = OLD.generation_id
           AND hold_row.state = 'active'
         ORDER BY hold_row.id
         FOR UPDATE;

        IF FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_expiry_held';
        END IF;
      END IF;

      RETURN NEW;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_expiry_authorize(
      expected_generation_id uuid,
      expected_workspace_id text,
      expected_base_id text,
      expected_sheet_id text
    )
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      resolved_workspace_id text;
      resolved_base_id text;
      resolved_sheet_id text;
      resolved_key_id text;
      resolved_expires_at timestamptz;
    BEGIN
      SELECT archive.workspace_id,
             archive.base_id,
             archive.sheet_id,
             archive.key_id
        INTO resolved_workspace_id,
             resolved_base_id,
             resolved_sheet_id,
             resolved_key_id
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = expected_generation_id;

      IF NOT FOUND
         OR resolved_workspace_id IS DISTINCT FROM expected_workspace_id
         OR resolved_base_id IS DISTINCT FROM expected_base_id
         OR resolved_sheet_id IS DISTINCT FROM expected_sheet_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_expiry_binding_invalid';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('meta:auto-number:sheet:' || resolved_sheet_id)
      );

      PERFORM 1
        FROM public.meta_recovery_archive_keys key_row
       WHERE key_row.key_id = resolved_key_id
         AND key_row.state = 'active'
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_expiry_key_unavailable';
      END IF;

      SELECT archive.expires_at
        INTO resolved_expires_at
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = expected_generation_id
         AND archive.workspace_id = expected_workspace_id
         AND archive.base_id = expected_base_id
         AND archive.sheet_id = expected_sheet_id
         AND archive.key_id = resolved_key_id
         AND archive.state = 'verified'
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_expiry_binding_invalid';
      END IF;

      IF resolved_expires_at IS NULL OR resolved_expires_at > clock_timestamp() THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_expiry_not_due';
      END IF;

      PERFORM 1
        FROM public.meta_recovery_archive_legal_holds hold_row
       WHERE hold_row.generation_id = expected_generation_id
         AND hold_row.state = 'active'
       ORDER BY hold_row.id
       FOR UPDATE;

      IF FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_expiry_held';
      END IF;

      PERFORM set_config(
        'metasheet.recovery_archive_expiry_generation',
        expected_generation_id::text,
        true
      );
    END $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_legal_hold_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_legal_holds
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_legal_hold_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_legal_hold_guard_truncate
    BEFORE TRUNCATE ON public.meta_recovery_archive_legal_holds
    FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_legal_hold_guard_truncate()
  `.execute(db)
  // The existing archive state-machine trigger remains untouched and fires first by name.
  await sql`
    CREATE TRIGGER trg_meta_recovery_archives_legal_hold_expiry_guard_row
    BEFORE UPDATE ON public.meta_recovery_archives
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_legal_hold_expiry_guard_row()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      hold_count bigint;
      owned_column_shape_count integer;
      owned_constraint_shape_count integer;
      owned_index_shape_count integer;
      owned_function_shape_count integer;
      owned_trigger_shape_count integer;
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_legal_holds') IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_schema_mismatch';
      END IF;

      BEGIN
        LOCK TABLE public.meta_recovery_archive_legal_holds, public.meta_recovery_archives
          IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING
          ERRCODE = '55P03',
          MESSAGE = 'recovery_archive_legal_hold_busy';
      END;

      SELECT count(*)::bigint
        INTO hold_count
        FROM public.meta_recovery_archive_legal_holds;

      IF hold_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_nonempty';
      END IF;

      SELECT CASE
        WHEN count(*) = 12 AND pg_catalog.md5(
          string_agg(
            attribute.attname || '|' ||
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
            attribute.attnotnull::text || '|' ||
            coalesce(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), ''),
            E'\n' ORDER BY attribute.attnum
          )
        ) = 'fcb1838e7559a7b090709497d7ddb197' THEN 1
        ELSE 0
      END
        INTO owned_column_shape_count
        FROM pg_catalog.pg_attribute attribute
        LEFT JOIN pg_catalog.pg_attrdef default_row
          ON default_row.adrelid = attribute.attrelid
         AND default_row.adnum = attribute.attnum
       WHERE attribute.attrelid = 'public.meta_recovery_archive_legal_holds'::pg_catalog.regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped;

      SELECT CASE
        WHEN count(*) = 10 AND pg_catalog.md5(
          string_agg(
            constraint_row.conname || '=' ||
            pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
            E'\n' ORDER BY constraint_row.conname
          )
        ) = '5ff805efb7317979c94ff3e732d078ca' THEN 1
        ELSE 0
      END
        INTO owned_constraint_shape_count
        FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'public.meta_recovery_archive_legal_holds'::pg_catalog.regclass;

      SELECT CASE
        WHEN count(*) = 2 AND pg_catalog.md5(
          string_agg(
            relation.relname || '=' || pg_catalog.pg_get_indexdef(index_row.indexrelid),
            E'\n' ORDER BY relation.relname
          )
        ) = 'd59375f44cf0054a035a3c10c3f988a8' THEN 1
        ELSE 0
      END
        INTO owned_index_shape_count
        FROM pg_catalog.pg_index index_row
        JOIN pg_catalog.pg_class relation ON relation.oid = index_row.indexrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE index_row.indrelid = 'public.meta_recovery_archive_legal_holds'::pg_catalog.regclass
         AND namespace.nspname = 'public'
         AND relation.relname IN (
           'idx_meta_recovery_archive_legal_holds_active_generation',
           'idx_meta_recovery_archive_legal_holds_binding'
         );

      SELECT CASE
        WHEN count(*) = 5 AND pg_catalog.md5(
          string_agg(
            procedure_row.proname || '|' ||
            pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) || '|' ||
            procedure_row.prorettype::pg_catalog.regtype::text || '|' ||
            procedure_row.provolatile::text || '|' ||
            procedure_row.prosecdef::text || '|' ||
            procedure_row.prokind::text || '|' ||
            coalesce(pg_catalog.array_to_string(procedure_row.proconfig, ','), '') || '|' ||
            pg_catalog.md5(procedure_row.prosrc),
            E'\n' ORDER BY procedure_row.proname
          )
        ) = 'fb803ecd9cfd0c6528462ed616411135' THEN 1
        ELSE 0
      END
        INTO owned_function_shape_count
        FROM pg_catalog.pg_proc procedure_row
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure_row.proname IN (
           'meta_recovery_archive_legal_hold_guard_row',
           'meta_recovery_archive_legal_hold_guard_truncate',
           'meta_recovery_archive_legal_hold_expiry_guard_row',
           'meta_recovery_archive_expiry_authorize',
           'meta_recovery_archive_legal_hold_release_authorize'
         );

      SELECT CASE
        WHEN count(*) = 3 AND pg_catalog.md5(
          string_agg(
            trigger_row.tgname || '|' || relation.relname || '|' ||
            trigger_row.tgtype::text || '|' || trigger_row.tgenabled::text || '|' ||
            trigger_row.tgconstraint::text || '|' || trigger_row.tgdeferrable::text || '|' ||
            trigger_row.tginitdeferred::text || '|' || procedure_row.proname || '|' ||
            pg_catalog.pg_get_function_identity_arguments(procedure_row.oid),
            E'\n' ORDER BY trigger_row.tgname
          )
        ) = '8d17daed417f3ae097c52e0b88c683ef' THEN 1
        ELSE 0
      END
        INTO owned_trigger_shape_count
        FROM pg_catalog.pg_trigger trigger_row
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
        JOIN pg_catalog.pg_namespace procedure_namespace ON procedure_namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure_namespace.nspname = 'public'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgname IN (
           'trg_meta_recovery_archive_legal_hold_guard_row',
           'trg_meta_recovery_archive_legal_hold_guard_truncate',
           'trg_meta_recovery_archives_legal_hold_expiry_guard_row'
         );

      IF owned_column_shape_count <> 1
         OR owned_constraint_shape_count <> 1
         OR owned_index_shape_count <> 1
         OR owned_function_shape_count <> 1
         OR owned_trigger_shape_count <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_legal_hold_schema_mismatch';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DROP TRIGGER trg_meta_recovery_archives_legal_hold_expiry_guard_row
      ON public.meta_recovery_archives
  `.execute(db)
  await sql`
    DROP TRIGGER trg_meta_recovery_archive_legal_hold_guard_truncate
      ON public.meta_recovery_archive_legal_holds
  `.execute(db)
  await sql`
    DROP TRIGGER trg_meta_recovery_archive_legal_hold_guard_row
      ON public.meta_recovery_archive_legal_holds
  `.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_legal_hold_expiry_guard_row()`.execute(db)
  await sql`
    DROP FUNCTION public.meta_recovery_archive_legal_hold_release_authorize(uuid, uuid, text, text, text, bigint)
  `.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_expiry_authorize(uuid, text, text, text)`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_legal_hold_guard_truncate()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_legal_hold_guard_row()`.execute(db)
  await sql`DROP TABLE public.meta_recovery_archive_legal_holds`.execute(db)
}
