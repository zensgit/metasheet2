import { sql, type Kysely } from 'kysely'

/**
 * Phase D5: default-inert durable archive restore jobs and token-burn provenance.
 *
 * This migration installs authority only. It does not enable a flag, start a worker, or expose a
 * route. Existing provenance-free burns remain valid legacy rows and are deliberately unprunable.
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
          ('meta_recovery_archives', 'workspace_id', 'text', true),
          ('meta_recovery_archives', 'base_id', 'text', true),
          ('meta_recovery_archives', 'sheet_id', 'text', true),
          ('meta_recovery_archives', 'state', 'text', true),
          ('meta_recovery_archives', 'build_status', 'text', true),
          ('meta_recovery_archives', 'coverage_status', 'text', true),
          ('meta_recovery_archives', 'root_hash', 'text', false),
          ('meta_recovery_archives', 'source_vector_hash', 'text', true),
          ('meta_recovery_archives', 'key_id', 'text', true),
          ('meta_recovery_archives', 'expires_at', 'timestamp with time zone', true),
          ('meta_sheets', 'id', 'text', true),
          ('meta_sheets', 'recovery_writer_state', 'text', false),
          ('meta_sheets', 'recovery_writer_owner_kind', 'text', false),
          ('meta_sheets', 'recovery_writer_owner_id', 'text', false),
          ('meta_sheets', 'recovery_writer_owner_fence', 'bigint', false),
          ('meta_sheets', 'recovery_writer_lease_until', 'timestamp with time zone', false),
          ('meta_sheets', 'recovery_writer_updated_at', 'timestamp with time zone', false),
          ('meta_recovery_token_burns', 'token_sha256', 'text', true),
          ('meta_recovery_token_burns', 'sheet_id', 'text', true),
          ('meta_recovery_token_burns', 'actor_id', 'text', false),
          ('meta_recovery_token_burns', 'burned_at', 'timestamp with time zone', true),
          ('meta_record_history_operations', 'sheet_id', 'text', true),
          ('meta_record_history_operations', 'operation_id', 'uuid', true),
          ('meta_record_history_operations', 'operation_kind', 'text', true),
          ('meta_record_history_operations', 'event_contract_version', 'integer', true),
          ('meta_record_history_operation_members', 'parent_operation_id', 'uuid', true),
          ('meta_recovery_archive_legal_holds', 'generation_id', 'uuid', true),
          ('meta_recovery_archive_legal_holds', 'state', 'text', true)
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
          MESSAGE = 'recovery_archive_restore_job_source_schema_mismatch';
      END IF;

      SELECT count(*)::integer
        INTO owned_object_count
        FROM (
          SELECT pg_catalog.to_regclass(name) AS object_oid
            FROM unnest(ARRAY[
              'public.meta_recovery_archive_jobs',
              'public.meta_recovery_archive_job_chunks',
              'public.meta_recovery_archive_restore_plans',
              'public.meta_recovery_archive_sync_receipts',
              'public.meta_recovery_token_burn_delete_requests',
              'public.idx_meta_recovery_archive_jobs_claimable',
              'public.idx_meta_recovery_archive_jobs_sheet_state',
              'public.idx_meta_recovery_archive_job_chunks_pending',
              'public.idx_meta_recovery_token_burns_d5_prunable'
            ]::text[]) AS names(name)
        ) owned_relations
       WHERE owned_relations.object_oid IS NOT NULL;

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_recovery_archive_job_guard_row',
             'meta_recovery_archive_job_chunk_guard_row',
             'meta_recovery_archive_restore_plan_guard_row',
             'meta_recovery_archive_job_consistency_guard',
             'meta_recovery_archive_nonterminal_job_guard_row',
             'meta_recovery_archive_sync_receipt_guard_row',
             'meta_recovery_token_burn_d5_guard_row',
             'meta_recovery_token_burn_d5_consistency_guard',
             'meta_recovery_archive_d5_reject_truncate',
             'meta_recovery_token_burn_delete_request_row',
             'meta_recovery_token_burn_delete_authorize'
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
             'trg_meta_recovery_archive_jobs_guard_row',
             'trg_meta_recovery_archive_job_chunks_guard_row',
             'trg_meta_recovery_archive_restore_plans_guard_row',
             'trg_meta_recovery_archive_jobs_consistency',
             'trg_meta_recovery_archive_job_chunks_consistency',
             'trg_meta_recovery_archive_jobs_burn_consistency',
             'trg_meta_recovery_archives_nonterminal_job_guard_row',
             'trg_meta_recovery_token_burns_d5_guard_row',
             'trg_meta_recovery_token_burns_d5_consistency',
             'trg_meta_recovery_archive_sync_receipts_guard_row',
             'trg_meta_recovery_archive_sync_receipts_consistency',
             'trg_meta_recovery_token_burn_delete_request_row',
             'trg_meta_recovery_archive_jobs_reject_truncate',
             'trg_meta_recovery_archive_job_chunks_reject_truncate',
             'trg_meta_recovery_archive_restore_plans_reject_truncate',
             'trg_meta_recovery_archive_sync_receipts_reject_truncate'
           )
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_attribute attribute
         WHERE attribute.attrelid = 'public.meta_recovery_token_burns'::pg_catalog.regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND attribute.attname IN (
             'burn_kind',
             'job_id',
             'sync_operation_id',
             'archive_generation_id',
             'archive_root_hash',
             'source_vector_hash',
             'token_expires_at',
             'retain_until',
             'terminal_at',
             'row_version'
           )
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_restore_job_object_conflict';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_jobs (
      id uuid NOT NULL,
      workspace_id text NOT NULL,
      base_id text NOT NULL,
      sheet_id text NOT NULL,
      actor_id text NOT NULL,
      token_sha256 text NOT NULL,
      recovery_mode text NOT NULL,
      scope_kind text NOT NULL,
      scope_hash text NOT NULL,
      archive_generation_id uuid NOT NULL,
      archive_root_hash text NOT NULL,
      source_vector_hash text NOT NULL,
      key_id text COLLATE "C" NOT NULL,
      plan_hash text NOT NULL,
      plan_object_id text NOT NULL,
      plan_object_version text NOT NULL,
      plan_object_sha256 text NOT NULL,
      plan_object_size bigint NOT NULL,
      plan_object_expires_at timestamptz NOT NULL,
      state text NOT NULL DEFAULT 'planned',
      total_count bigint NOT NULL,
      completed_count bigint NOT NULL DEFAULT 0,
      block_fence bigint NOT NULL,
      worker_owner_id text,
      worker_fence bigint NOT NULL DEFAULT 0,
      lease_until timestamptz,
      resume_deadline timestamptz NOT NULL,
      terminal_operation_id uuid,
      terminal_at timestamptz,
      row_version bigint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_recovery_archive_jobs PRIMARY KEY (id),
      CONSTRAINT uq_meta_recovery_archive_jobs_token UNIQUE (token_sha256),
      CONSTRAINT uq_meta_recovery_archive_jobs_id_sheet UNIQUE (id, sheet_id),
      CONSTRAINT fk_meta_recovery_archive_jobs_base
        FOREIGN KEY (base_id) REFERENCES public.meta_bases(id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_jobs_sheet
        FOREIGN KEY (sheet_id) REFERENCES public.meta_sheets(id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_jobs_generation
        FOREIGN KEY (archive_generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_jobs_key
        FOREIGN KEY (key_id)
        REFERENCES public.meta_recovery_archive_keys(key_id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_jobs_terminal_operation
        FOREIGN KEY (sheet_id, terminal_operation_id)
        REFERENCES public.meta_record_history_operations(sheet_id, operation_id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT chk_meta_recovery_archive_jobs_token_sha
        CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_meta_recovery_archive_jobs_recovery_mode
        CHECK (recovery_mode IN ('revert', 'reset')),
      CONSTRAINT chk_meta_recovery_archive_jobs_scope_kind
        CHECK (scope_kind IN ('whole_sheet', 'selected_records', 'selected_fields')),
      CONSTRAINT chk_meta_recovery_archive_jobs_hashes CHECK (
        scope_hash ~ '^[0-9a-f]{64}$' AND
        archive_root_hash ~ '^[0-9a-f]{64}$' AND
        source_vector_hash ~ '^[0-9a-f]{64}$' AND
        plan_hash ~ '^[0-9a-f]{64}$' AND
        plan_object_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT chk_meta_recovery_archive_jobs_opaque_ids CHECK (
        length(btrim(workspace_id)) > 0 AND
        length(btrim(actor_id)) > 0 AND
        length(btrim(plan_object_id)) > 0 AND
        length(btrim(plan_object_version)) > 0
      ),
      CONSTRAINT chk_meta_recovery_archive_jobs_plan_object CHECK (
        plan_object_size > 0 AND plan_object_expires_at >= resume_deadline
      ),
      CONSTRAINT chk_meta_recovery_archive_jobs_state CHECK (
        state IN (
          'planned',
          'applying',
          'paused_retryable',
          'done',
          'abandoned_partial',
          'cancelled_zero_write'
        )
      ),
      CONSTRAINT chk_meta_recovery_archive_jobs_counts CHECK (
        total_count > 5000 AND
        completed_count >= 0 AND
        completed_count <= total_count
      ),
      CONSTRAINT chk_meta_recovery_archive_jobs_fences CHECK (
        block_fence >= 1 AND worker_fence >= 0 AND row_version >= 1
      ),
      CONSTRAINT chk_meta_recovery_archive_jobs_worker_tuple CHECK (
        (state = 'applying' AND worker_owner_id IS NOT NULL AND
          length(btrim(worker_owner_id)) > 0 AND lease_until IS NOT NULL) OR
        (state <> 'applying' AND worker_owner_id IS NULL AND lease_until IS NULL)
      ),
      CONSTRAINT chk_meta_recovery_archive_jobs_terminal_shape CHECK (
        (state = 'done' AND completed_count = total_count AND
          terminal_operation_id IS NOT NULL AND terminal_at IS NOT NULL) OR
        (state IN ('abandoned_partial', 'cancelled_zero_write') AND
          terminal_operation_id IS NULL AND terminal_at IS NOT NULL) OR
        (state IN ('planned', 'applying', 'paused_retryable') AND
          terminal_operation_id IS NULL AND terminal_at IS NULL)
      ),
      CONSTRAINT chk_meta_recovery_archive_jobs_cancelled_zero CHECK (
        state <> 'cancelled_zero_write' OR completed_count = 0
      ),
      CONSTRAINT chk_meta_recovery_archive_jobs_resume_deadline CHECK (
        resume_deadline > created_at
      )
    )
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_job_chunks (
      job_id uuid NOT NULL,
      sheet_id text NOT NULL,
      chunk_index integer NOT NULL,
      chunk_hash text NOT NULL,
      chunk_object_id text NOT NULL,
      chunk_object_version text NOT NULL,
      chunk_object_sha256 text NOT NULL,
      chunk_object_size bigint NOT NULL,
      chunk_object_expires_at timestamptz NOT NULL,
      record_count bigint NOT NULL,
      state text NOT NULL DEFAULT 'pending',
      operation_id uuid,
      endpoint_seq bigint,
      committed_count bigint,
      committed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_recovery_archive_job_chunks PRIMARY KEY (job_id, chunk_index),
      CONSTRAINT uq_meta_recovery_archive_job_chunks_operation UNIQUE (operation_id),
      CONSTRAINT fk_meta_recovery_archive_job_chunks_job
        FOREIGN KEY (job_id, sheet_id)
        REFERENCES public.meta_recovery_archive_jobs(id, sheet_id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_job_chunks_operation
        FOREIGN KEY (sheet_id, operation_id)
        REFERENCES public.meta_record_history_operations(sheet_id, operation_id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT chk_meta_recovery_archive_job_chunks_index CHECK (chunk_index >= 0),
      CONSTRAINT chk_meta_recovery_archive_job_chunks_hashes CHECK (
        chunk_hash ~ '^[0-9a-f]{64}$' AND
        chunk_object_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT chk_meta_recovery_archive_job_chunks_object CHECK (
        length(btrim(chunk_object_id)) > 0 AND
        length(btrim(chunk_object_version)) > 0 AND
        chunk_object_size > 0 AND
        chunk_object_expires_at > created_at
      ),
      CONSTRAINT chk_meta_recovery_archive_job_chunks_record_count
        CHECK (record_count BETWEEN 1 AND 5000),
      CONSTRAINT chk_meta_recovery_archive_job_chunks_state
        CHECK (state IN ('pending', 'committed')),
      CONSTRAINT chk_meta_recovery_archive_job_chunks_receipt CHECK (
        (state = 'pending' AND operation_id IS NULL AND endpoint_seq IS NULL AND
          committed_count IS NULL AND committed_at IS NULL) OR
        (state = 'committed' AND operation_id IS NOT NULL AND endpoint_seq >= 1 AND
          committed_count = record_count AND committed_at IS NOT NULL)
      )
    )
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_restore_plans (
      token_sha256 text NOT NULL,
      workspace_id text NOT NULL,
      base_id text NOT NULL,
      sheet_id text NOT NULL,
      actor_id text NOT NULL,
      archive_generation_id uuid NOT NULL,
      archive_root_hash text NOT NULL,
      source_vector_hash text NOT NULL,
      key_id text COLLATE "C" NOT NULL,
      plan_hash text NOT NULL,
      plan_object_id text NOT NULL,
      plan_object_version text NOT NULL,
      plan_object_sha256 text NOT NULL,
      plan_object_size bigint NOT NULL,
      plan_object_expires_at timestamptz NOT NULL,
      token_expires_at timestamptz NOT NULL,
      state text NOT NULL DEFAULT 'prepared',
      accepted_job_id uuid,
      row_version bigint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      accepted_at timestamptz,
      CONSTRAINT pk_meta_recovery_archive_restore_plans PRIMARY KEY (token_sha256),
      CONSTRAINT uq_meta_recovery_archive_restore_plans_job UNIQUE (accepted_job_id),
      CONSTRAINT fk_meta_recovery_archive_restore_plans_base
        FOREIGN KEY (base_id) REFERENCES public.meta_bases(id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_restore_plans_sheet
        FOREIGN KEY (sheet_id) REFERENCES public.meta_sheets(id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_restore_plans_generation
        FOREIGN KEY (archive_generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_restore_plans_key
        FOREIGN KEY (key_id)
        REFERENCES public.meta_recovery_archive_keys(key_id) ON DELETE RESTRICT,
      CONSTRAINT fk_meta_recovery_archive_restore_plans_job
        FOREIGN KEY (accepted_job_id)
        REFERENCES public.meta_recovery_archive_jobs(id) ON DELETE RESTRICT,
      CONSTRAINT chk_meta_recovery_archive_restore_plans_hashes CHECK (
        token_sha256 ~ '^[0-9a-f]{64}$' AND
        archive_root_hash ~ '^[0-9a-f]{64}$' AND
        source_vector_hash ~ '^[0-9a-f]{64}$' AND
        plan_hash ~ '^[0-9a-f]{64}$' AND
        plan_object_id ~ '^[0-9a-f]{64}$' AND
        plan_object_sha256 ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT chk_meta_recovery_archive_restore_plans_opaque CHECK (
        length(btrim(workspace_id)) > 0 AND
        length(btrim(actor_id)) > 0 AND
        length(btrim(plan_object_version)) > 0
      ),
      CONSTRAINT chk_meta_recovery_archive_restore_plans_object CHECK (
        plan_object_size > 0 AND
        plan_object_expires_at >= token_expires_at AND
        token_expires_at > created_at
      ),
      CONSTRAINT chk_meta_recovery_archive_restore_plans_state CHECK (
        state IN ('prepared', 'accepted', 'expired')
      ),
      CONSTRAINT chk_meta_recovery_archive_restore_plans_shape CHECK (
        (state = 'prepared' AND accepted_job_id IS NULL AND accepted_at IS NULL) OR
        (state = 'accepted' AND accepted_job_id IS NOT NULL AND accepted_at IS NOT NULL) OR
        (state = 'expired' AND accepted_job_id IS NULL AND accepted_at IS NULL)
      ),
      CONSTRAINT chk_meta_recovery_archive_restore_plans_row_version CHECK (row_version >= 1)
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_meta_recovery_archive_jobs_claimable
      ON public.meta_recovery_archive_jobs(state, lease_until, resume_deadline, created_at)
      WHERE state IN ('planned', 'applying', 'paused_retryable')
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_recovery_archive_jobs_sheet_state
      ON public.meta_recovery_archive_jobs(sheet_id, state, created_at)
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_recovery_archive_job_chunks_pending
      ON public.meta_recovery_archive_job_chunks(job_id, state, chunk_index)
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_recovery_token_burns
      ADD COLUMN burn_kind text,
      ADD COLUMN job_id uuid,
      ADD COLUMN sync_operation_id uuid,
      ADD COLUMN archive_generation_id uuid,
      ADD COLUMN archive_root_hash text,
      ADD COLUMN source_vector_hash text,
      ADD COLUMN token_expires_at timestamptz,
      ADD COLUMN retain_until timestamptz,
      ADD COLUMN terminal_at timestamptz,
      ADD COLUMN row_version bigint
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_recovery_token_burns
      ADD CONSTRAINT uq_meta_recovery_token_burns_job UNIQUE (job_id),
      ADD CONSTRAINT uq_meta_recovery_token_burns_sync_operation UNIQUE (sync_operation_id),
      ADD CONSTRAINT fk_meta_recovery_token_burns_job
        FOREIGN KEY (job_id) REFERENCES public.meta_recovery_archive_jobs(id)
        DEFERRABLE INITIALLY DEFERRED,
      ADD CONSTRAINT fk_meta_recovery_token_burns_sync_operation
        FOREIGN KEY (sheet_id, sync_operation_id)
        REFERENCES public.meta_record_history_operations(sheet_id, operation_id)
        DEFERRABLE INITIALLY DEFERRED,
      ADD CONSTRAINT fk_meta_recovery_token_burns_generation
        FOREIGN KEY (archive_generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      ADD CONSTRAINT chk_meta_recovery_token_burns_d5_shape CHECK (
        (
          burn_kind IS NULL AND job_id IS NULL AND sync_operation_id IS NULL AND
          archive_generation_id IS NULL AND archive_root_hash IS NULL AND
          source_vector_hash IS NULL AND token_expires_at IS NULL AND
          retain_until IS NULL AND terminal_at IS NULL AND row_version IS NULL
        ) OR (
          burn_kind = 'sync' AND job_id IS NULL AND sync_operation_id IS NOT NULL AND
          archive_generation_id IS NOT NULL AND archive_root_hash ~ '^[0-9a-f]{64}$' AND
          source_vector_hash ~ '^[0-9a-f]{64}$' AND token_expires_at IS NOT NULL AND
          retain_until IS NOT NULL AND terminal_at IS NOT NULL AND row_version >= 1
        ) OR (
          burn_kind = 'async' AND job_id IS NOT NULL AND sync_operation_id IS NULL AND
          archive_generation_id IS NOT NULL AND archive_root_hash ~ '^[0-9a-f]{64}$' AND
          source_vector_hash ~ '^[0-9a-f]{64}$' AND token_expires_at IS NOT NULL AND
          retain_until IS NOT NULL AND row_version >= 1
        )
      ),
      ADD CONSTRAINT chk_meta_recovery_token_burns_d5_retention CHECK (
        burn_kind IS NULL OR (
          token_expires_at >= burned_at AND
          retain_until >= token_expires_at AND
          (terminal_at IS NULL OR retain_until >= terminal_at)
        )
      )
  `.execute(db)

  await sql`
    CREATE INDEX idx_meta_recovery_token_burns_d5_prunable
      ON public.meta_recovery_token_burns(retain_until, token_sha256)
      WHERE burn_kind IN ('sync', 'async') AND terminal_at IS NOT NULL
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_recovery_archive_sync_receipts (
      token_sha256 text NOT NULL,
      sheet_id text NOT NULL,
      operation_id uuid NOT NULL,
      archive_generation_id uuid NOT NULL,
      archive_root_hash text NOT NULL,
      source_vector_hash text NOT NULL,
      plan_hash text NOT NULL,
      applied_count bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_recovery_archive_sync_receipts PRIMARY KEY (token_sha256),
      CONSTRAINT uq_meta_recovery_archive_sync_receipts_operation UNIQUE (operation_id),
      CONSTRAINT fk_meta_recovery_archive_sync_receipts_operation
        FOREIGN KEY (sheet_id, operation_id)
        REFERENCES public.meta_record_history_operations(sheet_id, operation_id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT fk_meta_recovery_archive_sync_receipts_generation
        FOREIGN KEY (archive_generation_id)
        REFERENCES public.meta_recovery_archives(generation_id) ON DELETE RESTRICT,
      CONSTRAINT chk_meta_recovery_archive_sync_receipts_hashes CHECK (
        token_sha256 ~ '^[0-9a-f]{64}$' AND
        archive_root_hash ~ '^[0-9a-f]{64}$' AND
        source_vector_hash ~ '^[0-9a-f]{64}$' AND
        plan_hash ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT chk_meta_recovery_archive_sync_receipts_count CHECK (applied_count >= 0)
    )
  `.execute(db)

  await sql`
    CREATE VIEW public.meta_recovery_token_burn_delete_requests AS
      SELECT NULL::text AS token_sha256,
             NULL::bigint AS row_version,
             false::boolean AS deleted
       WHERE false
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_job_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      archive_match_count integer;
      block_match_count integer;
      receipt_count integer;
      receipt_sum numeric;
      membership_mismatch_count integer;
      terminal_row record;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_delete_not_authorized';
      END IF;

      SELECT count(*)::integer
        INTO archive_match_count
        FROM public.meta_recovery_archives archive_row
        JOIN public.meta_recovery_archive_keys key_row ON key_row.key_id = archive_row.key_id
       WHERE archive_row.generation_id = NEW.archive_generation_id
         AND archive_row.workspace_id = NEW.workspace_id
         AND archive_row.base_id = NEW.base_id
         AND archive_row.sheet_id = NEW.sheet_id
         AND archive_row.state = 'verified'
         AND archive_row.build_status = 'finalized'
         AND archive_row.coverage_status = 'complete'
         AND archive_row.root_hash = NEW.archive_root_hash
         AND archive_row.source_vector_hash = NEW.source_vector_hash
         AND archive_row.key_id = NEW.key_id
         AND archive_row.expires_at >= NEW.resume_deadline
         AND (
           NEW.state IN ('done', 'abandoned_partial', 'cancelled_zero_write') OR
           archive_row.expires_at > clock_timestamp()
         )
         AND key_row.state = CASE WHEN TG_OP = 'INSERT' THEN 'active' ELSE key_row.state END
         AND key_row.state IN ('active', 'retiring');
      IF archive_match_count <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_archive_binding_invalid';
      END IF;

      SELECT count(*)::integer
        INTO block_match_count
        FROM public.meta_sheets sheet_row
       WHERE sheet_row.id = NEW.sheet_id
         AND sheet_row.recovery_writer_state = 'archiving'
         AND sheet_row.recovery_writer_owner_kind = 'restore_job'
         AND sheet_row.recovery_writer_owner_id = NEW.id::text
         AND sheet_row.recovery_writer_owner_fence = NEW.block_fence;
      IF NEW.state NOT IN ('abandoned_partial', 'cancelled_zero_write') AND
         block_match_count <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_writer_block_invalid';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'planned' OR NEW.completed_count <> 0 OR NEW.worker_fence <> 0 OR
           NEW.worker_owner_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR
           NEW.terminal_operation_id IS NOT NULL OR NEW.terminal_at IS NOT NULL OR
           NEW.row_version <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_initial_posture_invalid';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id OR
         NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
         NEW.base_id IS DISTINCT FROM OLD.base_id OR
         NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR
         NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
         NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR
         NEW.recovery_mode IS DISTINCT FROM OLD.recovery_mode OR
         NEW.scope_kind IS DISTINCT FROM OLD.scope_kind OR
         NEW.scope_hash IS DISTINCT FROM OLD.scope_hash OR
         NEW.archive_generation_id IS DISTINCT FROM OLD.archive_generation_id OR
         NEW.archive_root_hash IS DISTINCT FROM OLD.archive_root_hash OR
         NEW.source_vector_hash IS DISTINCT FROM OLD.source_vector_hash OR
         NEW.key_id IS DISTINCT FROM OLD.key_id OR
         NEW.plan_hash IS DISTINCT FROM OLD.plan_hash OR
         NEW.plan_object_id IS DISTINCT FROM OLD.plan_object_id OR
         NEW.plan_object_version IS DISTINCT FROM OLD.plan_object_version OR
         NEW.plan_object_sha256 IS DISTINCT FROM OLD.plan_object_sha256 OR
         NEW.plan_object_size IS DISTINCT FROM OLD.plan_object_size OR
         NEW.plan_object_expires_at IS DISTINCT FROM OLD.plan_object_expires_at OR
         NEW.total_count IS DISTINCT FROM OLD.total_count OR
         NEW.block_fence IS DISTINCT FROM OLD.block_fence OR
         NEW.resume_deadline IS DISTINCT FROM OLD.resume_deadline OR
         NEW.created_at IS DISTINCT FROM OLD.created_at OR
         NEW.completed_count < OLD.completed_count OR
         NEW.worker_fence < OLD.worker_fence OR
         NEW.row_version <> OLD.row_version + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_immutable_or_cas_invalid';
      END IF;

      IF NOT (
        (OLD.state = 'planned' AND NEW.state IN (
          'applying', 'abandoned_partial', 'cancelled_zero_write'
        )) OR
        (OLD.state = 'applying' AND NEW.state IN (
          'applying', 'paused_retryable', 'done', 'abandoned_partial', 'cancelled_zero_write'
        )) OR
        (OLD.state = 'paused_retryable' AND NEW.state IN (
          'planned', 'abandoned_partial', 'cancelled_zero_write'
        ))
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_transition_invalid';
      END IF;

      IF NEW.state = 'done' THEN
        SELECT operation_kind, event_contract_version, component_count, endpoint_seq, event_count
          INTO terminal_row
          FROM public.meta_record_history_operations
         WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.terminal_operation_id;
        IF terminal_row.operation_kind IS DISTINCT FROM 'restore_aggregate' OR
           terminal_row.event_contract_version IS DISTINCT FROM 2 THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_terminal_invalid';
        END IF;

        SELECT count(*)::integer, COALESCE(sum(committed_count), 0)
          INTO receipt_count, receipt_sum
          FROM public.meta_recovery_archive_job_chunks
         WHERE job_id = NEW.id AND state = 'committed';
        IF receipt_count < 1 OR receipt_sum IS DISTINCT FROM NEW.total_count OR
           terminal_row.component_count IS DISTINCT FROM receipt_count THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_terminal_receipts_invalid';
        END IF;

        SELECT count(*)::integer
          INTO membership_mismatch_count
          FROM public.meta_recovery_archive_job_chunks chunk_row
          FULL JOIN public.meta_record_history_operation_members member_row
            ON member_row.sheet_id = chunk_row.sheet_id
           AND member_row.parent_operation_id = NEW.terminal_operation_id
           AND member_row.ordinal = chunk_row.chunk_index + 1
           AND member_row.child_operation_id = chunk_row.operation_id
           AND member_row.child_endpoint_seq = chunk_row.endpoint_seq
         WHERE (chunk_row.job_id = NEW.id AND chunk_row.state = 'committed')
            OR (member_row.sheet_id = NEW.sheet_id AND
                member_row.parent_operation_id = NEW.terminal_operation_id)
        HAVING count(*) FILTER (
          WHERE chunk_row.job_id IS NULL OR member_row.parent_operation_id IS NULL
        ) > 0;
        IF membership_mismatch_count IS NOT NULL THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_terminal_membership_invalid';
        END IF;
      END IF;

      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_restore_plan_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      archive_match_count integer;
      job_match_count integer;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_plan_delete_not_authorized';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'prepared' OR NEW.accepted_job_id IS NOT NULL OR
           NEW.accepted_at IS NOT NULL OR NEW.row_version <> 1 OR
           NEW.token_expires_at <= clock_timestamp() THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_plan_initial_posture_invalid';
        END IF;
        SELECT count(*)::integer
          INTO archive_match_count
          FROM public.meta_recovery_archives archive_row
          JOIN public.meta_recovery_archive_keys key_row ON key_row.key_id = archive_row.key_id
         WHERE archive_row.generation_id = NEW.archive_generation_id
           AND archive_row.workspace_id = NEW.workspace_id
           AND archive_row.base_id = NEW.base_id
           AND archive_row.sheet_id = NEW.sheet_id
           AND archive_row.state = 'verified'
           AND archive_row.build_status = 'finalized'
           AND archive_row.coverage_status = 'complete'
           AND archive_row.root_hash = NEW.archive_root_hash
           AND archive_row.source_vector_hash = NEW.source_vector_hash
           AND archive_row.key_id = NEW.key_id
           AND archive_row.expires_at >= NEW.plan_object_expires_at
           AND NOT EXISTS (
             SELECT 1
               FROM public.meta_recovery_archive_legal_holds hold_row
              WHERE hold_row.generation_id = archive_row.generation_id
                AND hold_row.state = 'active'
           )
           AND key_row.state = 'active';
        IF archive_match_count <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_plan_archive_binding_invalid';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR
         NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
         NEW.base_id IS DISTINCT FROM OLD.base_id OR
         NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR
         NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
         NEW.archive_generation_id IS DISTINCT FROM OLD.archive_generation_id OR
         NEW.archive_root_hash IS DISTINCT FROM OLD.archive_root_hash OR
         NEW.source_vector_hash IS DISTINCT FROM OLD.source_vector_hash OR
         NEW.key_id IS DISTINCT FROM OLD.key_id OR
         NEW.plan_hash IS DISTINCT FROM OLD.plan_hash OR
         NEW.plan_object_id IS DISTINCT FROM OLD.plan_object_id OR
         NEW.plan_object_version IS DISTINCT FROM OLD.plan_object_version OR
         NEW.plan_object_sha256 IS DISTINCT FROM OLD.plan_object_sha256 OR
         NEW.plan_object_size IS DISTINCT FROM OLD.plan_object_size OR
         NEW.plan_object_expires_at IS DISTINCT FROM OLD.plan_object_expires_at OR
         NEW.token_expires_at IS DISTINCT FROM OLD.token_expires_at OR
         NEW.created_at IS DISTINCT FROM OLD.created_at OR
         NEW.row_version <> OLD.row_version + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_plan_immutable_or_cas_invalid';
      END IF;

      IF OLD.state = 'prepared' AND NEW.state = 'accepted' THEN
        IF OLD.token_expires_at <= clock_timestamp() THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_plan_expired';
        END IF;
        SELECT count(*)::integer
          INTO archive_match_count
          FROM public.meta_recovery_archives archive_row
          JOIN public.meta_recovery_archive_keys key_row ON key_row.key_id = archive_row.key_id
         WHERE archive_row.generation_id = NEW.archive_generation_id
           AND archive_row.workspace_id = NEW.workspace_id
           AND archive_row.base_id = NEW.base_id
           AND archive_row.sheet_id = NEW.sheet_id
           AND archive_row.state = 'verified'
           AND archive_row.build_status = 'finalized'
           AND archive_row.coverage_status = 'complete'
           AND archive_row.root_hash = NEW.archive_root_hash
           AND archive_row.source_vector_hash = NEW.source_vector_hash
           AND archive_row.key_id = NEW.key_id
           AND archive_row.expires_at >= NEW.plan_object_expires_at
           AND NOT EXISTS (
             SELECT 1
               FROM public.meta_recovery_archive_legal_holds hold_row
              WHERE hold_row.generation_id = archive_row.generation_id
                AND hold_row.state = 'active'
           )
           AND key_row.state IN ('active', 'retiring');
        IF archive_match_count <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_plan_archive_binding_invalid';
        END IF;
        SELECT count(*)::integer
          INTO job_match_count
          FROM public.meta_recovery_archive_jobs job_row
         WHERE job_row.id = NEW.accepted_job_id
           AND job_row.token_sha256 = NEW.token_sha256
           AND job_row.workspace_id = NEW.workspace_id
           AND job_row.base_id = NEW.base_id
           AND job_row.sheet_id = NEW.sheet_id
           AND job_row.actor_id = NEW.actor_id
           AND job_row.archive_generation_id = NEW.archive_generation_id
           AND job_row.archive_root_hash = NEW.archive_root_hash
           AND job_row.source_vector_hash = NEW.source_vector_hash
           AND job_row.key_id = NEW.key_id
           AND job_row.plan_hash = NEW.plan_hash
           AND job_row.plan_object_id = NEW.plan_object_id
           AND job_row.plan_object_version = NEW.plan_object_version
           AND job_row.plan_object_sha256 = NEW.plan_object_sha256
           AND job_row.plan_object_size = NEW.plan_object_size
           AND job_row.plan_object_expires_at = NEW.plan_object_expires_at;
        IF job_match_count <> 1 OR NEW.accepted_at IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_plan_job_binding_invalid';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.state = 'prepared' AND NEW.state = 'expired' AND
         OLD.token_expires_at <= clock_timestamp() AND
         NEW.accepted_job_id IS NULL AND NEW.accepted_at IS NULL THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_plan_transition_invalid';
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_nonterminal_job_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF EXISTS (
          SELECT 1
            FROM public.meta_recovery_archive_jobs job_row
           WHERE job_row.archive_generation_id = OLD.generation_id
             AND job_row.state IN ('planned', 'applying', 'paused_retryable')
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_nonterminal_restore_job';
        END IF;
        IF EXISTS (
          SELECT 1
            FROM public.meta_recovery_archive_restore_plans plan_row
           WHERE plan_row.archive_generation_id = OLD.generation_id
             AND plan_row.state = 'prepared'
             AND plan_row.token_expires_at > clock_timestamp()
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_prepared_restore_plan';
        END IF;
        RETURN OLD;
      END IF;

      IF EXISTS (
        SELECT 1
          FROM public.meta_recovery_archive_jobs job_row
         WHERE job_row.archive_generation_id = OLD.generation_id
           AND job_row.state IN ('planned', 'applying', 'paused_retryable')
           AND (
             NEW.state IS DISTINCT FROM 'verified' OR
             NEW.expires_at < job_row.resume_deadline
           )
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_nonterminal_restore_job';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM public.meta_recovery_archive_restore_plans plan_row
         WHERE plan_row.archive_generation_id = OLD.generation_id
           AND plan_row.state = 'prepared'
           AND plan_row.token_expires_at > clock_timestamp()
           AND (
             NEW.state IS DISTINCT FROM 'verified' OR
             NEW.expires_at < plan_row.plan_object_expires_at
           )
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_prepared_restore_plan';
      END IF;
      RETURN NEW;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_sync_receipt_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_sync_receipt_immutable';
      RETURN NULL;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_job_chunk_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      operation_match_count integer;
      job_state text;
      job_resume_deadline timestamptz;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_chunk_delete_not_authorized';
      END IF;

      SELECT state, resume_deadline INTO job_state, job_resume_deadline
        FROM public.meta_recovery_archive_jobs
       WHERE id = NEW.job_id AND sheet_id = NEW.sheet_id;
      IF job_state IS NULL OR job_state IN ('done', 'abandoned_partial', 'cancelled_zero_write') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_chunk_job_invalid';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'pending' OR NEW.operation_id IS NOT NULL OR NEW.endpoint_seq IS NOT NULL OR
           NEW.committed_count IS NOT NULL OR NEW.committed_at IS NOT NULL OR
           NEW.chunk_object_expires_at < job_resume_deadline THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_chunk_initial_posture_invalid';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.state <> 'pending' OR NEW.state <> 'committed' OR
         NEW.job_id IS DISTINCT FROM OLD.job_id OR
         NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR
         NEW.chunk_index IS DISTINCT FROM OLD.chunk_index OR
         NEW.chunk_hash IS DISTINCT FROM OLD.chunk_hash OR
         NEW.chunk_object_id IS DISTINCT FROM OLD.chunk_object_id OR
         NEW.chunk_object_version IS DISTINCT FROM OLD.chunk_object_version OR
         NEW.chunk_object_sha256 IS DISTINCT FROM OLD.chunk_object_sha256 OR
         NEW.chunk_object_size IS DISTINCT FROM OLD.chunk_object_size OR
         NEW.chunk_object_expires_at IS DISTINCT FROM OLD.chunk_object_expires_at OR
         NEW.record_count IS DISTINCT FROM OLD.record_count OR
         NEW.created_at IS DISTINCT FROM OLD.created_at OR
         job_state <> 'applying' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_chunk_transition_invalid';
      END IF;

      SELECT count(*)::integer
        INTO operation_match_count
        FROM public.meta_record_history_operations operation_row
       WHERE operation_row.sheet_id = NEW.sheet_id
         AND operation_row.operation_id = NEW.operation_id
         AND operation_row.operation_kind = 'restore_chunk'
         AND operation_row.event_contract_version = 2
         AND operation_row.endpoint_seq = NEW.endpoint_seq;
      IF operation_match_count <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_chunk_operation_invalid';
      END IF;
      RETURN NEW;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_job_consistency_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      target_job_id uuid;
      target_total bigint;
      target_completed bigint;
      chunk_total numeric;
      committed_total numeric;
      chunk_count integer;
      min_index integer;
      max_index integer;
    BEGIN
      target_job_id := COALESCE(
        NULLIF(to_jsonb(NEW)->>'job_id', '')::uuid,
        NULLIF(to_jsonb(NEW)->>'id', '')::uuid,
        NULLIF(to_jsonb(OLD)->>'job_id', '')::uuid,
        NULLIF(to_jsonb(OLD)->>'id', '')::uuid
      );
      SELECT total_count, completed_count
        INTO target_total, target_completed
        FROM public.meta_recovery_archive_jobs
       WHERE id = target_job_id;
      IF NOT FOUND THEN RETURN NULL; END IF;

      SELECT COALESCE(sum(record_count), 0),
             COALESCE(sum(committed_count) FILTER (WHERE state = 'committed'), 0),
             count(*)::integer, min(chunk_index), max(chunk_index)
        INTO chunk_total, committed_total, chunk_count, min_index, max_index
        FROM public.meta_recovery_archive_job_chunks
       WHERE job_id = target_job_id;
      IF chunk_count < 2 OR min_index IS DISTINCT FROM 0 OR
         max_index IS DISTINCT FROM chunk_count - 1 OR
         chunk_total IS DISTINCT FROM target_total OR
         committed_total IS DISTINCT FROM target_completed THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_job_chunk_set_invalid';
      END IF;
      RETURN NULL;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_token_burn_d5_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() <> 2 OR NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_locks held_lock
           WHERE held_lock.locktype = 'advisory'
             AND held_lock.pid = pg_catalog.pg_backend_pid()
             AND held_lock.mode = 'ExclusiveLock'
             AND held_lock.granted
             AND held_lock.objsubid = 1
             AND held_lock.classid::bigint = (
               (hashtext('meta:auto-number:sheet:' || OLD.sheet_id)::bigint >> 32) & 4294967295
             )
             AND held_lock.objid::bigint = (
               hashtext('meta:auto-number:sheet:' || OLD.sheet_id)::bigint & 4294967295
             )
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_token_burn_delete_not_authorized';
        END IF;
        RETURN OLD;
      END IF;

      IF NEW.burn_kind IS NULL THEN
        IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_token_burn_legacy_immutable';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.row_version <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_token_burn_initial_posture_invalid';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR
         NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR
         NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
         NEW.burned_at IS DISTINCT FROM OLD.burned_at OR
         NEW.burn_kind IS DISTINCT FROM OLD.burn_kind OR
         NEW.job_id IS DISTINCT FROM OLD.job_id OR
         NEW.sync_operation_id IS DISTINCT FROM OLD.sync_operation_id OR
         NEW.archive_generation_id IS DISTINCT FROM OLD.archive_generation_id OR
         NEW.archive_root_hash IS DISTINCT FROM OLD.archive_root_hash OR
         NEW.source_vector_hash IS DISTINCT FROM OLD.source_vector_hash OR
         NEW.token_expires_at IS DISTINCT FROM OLD.token_expires_at OR
         NEW.retain_until < OLD.retain_until OR
         NEW.row_version <> OLD.row_version + 1 OR
         OLD.terminal_at IS NOT NULL OR NEW.terminal_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_token_burn_transition_invalid';
      END IF;
      RETURN NEW;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_token_burn_d5_consistency_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      target_token text;
      burn_row record;
      job_row record;
      receipt_count integer;
    BEGIN
      target_token := COALESCE(NEW.token_sha256, OLD.token_sha256);
      SELECT * INTO burn_row
        FROM public.meta_recovery_token_burns
       WHERE token_sha256 = target_token;
      IF NOT FOUND OR burn_row.burn_kind IS NULL THEN RETURN NULL; END IF;

      IF burn_row.burn_kind = 'sync' THEN
        SELECT count(*)::integer INTO receipt_count
          FROM public.meta_recovery_archive_sync_receipts receipt_row
          JOIN public.meta_record_history_operations operation_row
            ON operation_row.sheet_id = receipt_row.sheet_id
           AND operation_row.operation_id = receipt_row.operation_id
         WHERE receipt_row.token_sha256 = target_token
           AND receipt_row.sheet_id = burn_row.sheet_id
           AND receipt_row.operation_id = burn_row.sync_operation_id
           AND receipt_row.archive_generation_id = burn_row.archive_generation_id
           AND receipt_row.archive_root_hash = burn_row.archive_root_hash
           AND receipt_row.source_vector_hash = burn_row.source_vector_hash
           AND operation_row.operation_kind IN ('ordinary', 'restore_chunk')
           AND operation_row.event_contract_version = 2;
        IF receipt_count <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_token_burn_sync_receipt_invalid';
        END IF;
        RETURN NULL;
      END IF;

      SELECT state, terminal_at, archive_generation_id, archive_root_hash, source_vector_hash,
             token_sha256, sheet_id, actor_id
        INTO job_row
        FROM public.meta_recovery_archive_jobs
       WHERE id = burn_row.job_id;
      IF job_row.token_sha256 IS DISTINCT FROM burn_row.token_sha256 OR
         job_row.sheet_id IS DISTINCT FROM burn_row.sheet_id OR
         job_row.actor_id IS DISTINCT FROM burn_row.actor_id OR
         job_row.archive_generation_id IS DISTINCT FROM burn_row.archive_generation_id OR
         job_row.archive_root_hash IS DISTINCT FROM burn_row.archive_root_hash OR
         job_row.source_vector_hash IS DISTINCT FROM burn_row.source_vector_hash OR
         (job_row.state IN ('done', 'abandoned_partial', 'cancelled_zero_write') AND
           burn_row.terminal_at IS DISTINCT FROM job_row.terminal_at) OR
         (job_row.state IN ('planned', 'applying', 'paused_retryable') AND
           burn_row.terminal_at IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_token_burn_async_job_invalid';
      END IF;
      RETURN NULL;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_d5_reject_truncate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_d5_truncate_not_authorized';
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_token_burn_delete_request_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      burn_row record;
      candidate_generation_id uuid;
      candidate_sheet_id text;
      candidate_key_id text;
      valid_reference boolean := false;
      deleted_count integer := 0;
    BEGIN
      NEW.deleted := false;
      SELECT candidate_burn.archive_generation_id, candidate_burn.sheet_id, archive_row.key_id
        INTO candidate_generation_id, candidate_sheet_id, candidate_key_id
        FROM public.meta_recovery_token_burns candidate_burn
        JOIN public.meta_recovery_archives archive_row
          ON archive_row.generation_id = candidate_burn.archive_generation_id
       WHERE candidate_burn.token_sha256 = NEW.token_sha256
         AND candidate_burn.row_version = NEW.row_version;
      IF NOT FOUND THEN RETURN NEW; END IF;

      PERFORM pg_advisory_xact_lock(
        hashtext('meta:auto-number:sheet:' || candidate_sheet_id)
      );
      PERFORM 1
        FROM public.meta_recovery_archive_keys key_row
       WHERE key_row.key_id = candidate_key_id
       FOR UPDATE;
      IF NOT FOUND THEN RETURN NEW; END IF;
      PERFORM 1
        FROM public.meta_recovery_archives archive_row
       WHERE archive_row.generation_id = candidate_generation_id
         AND archive_row.sheet_id = candidate_sheet_id
         AND archive_row.key_id = candidate_key_id
       FOR UPDATE;
      IF NOT FOUND THEN RETURN NEW; END IF;

      SELECT * INTO burn_row
        FROM public.meta_recovery_token_burns
       WHERE token_sha256 = NEW.token_sha256
         AND row_version = NEW.row_version
       FOR UPDATE;
      IF NOT FOUND OR burn_row.burn_kind IS NULL OR burn_row.terminal_at IS NULL OR
         clock_timestamp() < burn_row.retain_until OR EXISTS (
           SELECT 1 FROM public.meta_recovery_archive_legal_holds hold_row
            WHERE hold_row.generation_id = burn_row.archive_generation_id
              AND hold_row.state = 'active'
         ) THEN
        RETURN NEW;
      END IF;

      IF burn_row.burn_kind = 'sync' THEN
        SELECT EXISTS (
          SELECT 1
            FROM public.meta_recovery_archive_sync_receipts receipt_row
            JOIN public.meta_record_history_operations operation_row
              ON operation_row.sheet_id = receipt_row.sheet_id
             AND operation_row.operation_id = receipt_row.operation_id
           WHERE receipt_row.token_sha256 = burn_row.token_sha256
             AND receipt_row.sheet_id = burn_row.sheet_id
             AND receipt_row.operation_id = burn_row.sync_operation_id
             AND receipt_row.archive_generation_id = burn_row.archive_generation_id
             AND receipt_row.archive_root_hash = burn_row.archive_root_hash
             AND receipt_row.source_vector_hash = burn_row.source_vector_hash
             AND operation_row.operation_kind IN ('ordinary', 'restore_chunk')
             AND operation_row.event_contract_version = 2
        ) INTO valid_reference;
      ELSE
        SELECT EXISTS (
          SELECT 1 FROM public.meta_recovery_archive_jobs job_row
           WHERE job_row.id = burn_row.job_id
             AND job_row.state IN ('done', 'abandoned_partial', 'cancelled_zero_write')
             AND job_row.terminal_at = burn_row.terminal_at
             AND job_row.token_sha256 = burn_row.token_sha256
             AND job_row.sheet_id = burn_row.sheet_id
             AND job_row.actor_id IS NOT DISTINCT FROM burn_row.actor_id
             AND job_row.archive_generation_id = burn_row.archive_generation_id
             AND job_row.archive_root_hash = burn_row.archive_root_hash
           AND job_row.source_vector_hash = burn_row.source_vector_hash
        ) INTO valid_reference;
      END IF;
      IF NOT valid_reference THEN RETURN NEW; END IF;

      DELETE FROM public.meta_recovery_token_burns
       WHERE token_sha256 = NEW.token_sha256 AND row_version = NEW.row_version;
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      NEW.deleted := deleted_count = 1;
      RETURN NEW;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_token_burn_delete_authorize(
      p_token_sha256 text,
      p_row_version bigint
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      delete_result boolean := false;
    BEGIN
      INSERT INTO public.meta_recovery_token_burn_delete_requests (
        token_sha256,
        row_version
      ) VALUES (
        p_token_sha256,
        p_row_version
      )
      RETURNING deleted INTO delete_result;
      RETURN COALESCE(delete_result, false);
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archives_nonterminal_job_guard_row
      BEFORE UPDATE OR DELETE ON public.meta_recovery_archives
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_nonterminal_job_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_jobs_guard_row
      BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_jobs
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_job_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_job_chunks_guard_row
      BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_job_chunks
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_job_chunk_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_restore_plans_guard_row
      BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_restore_plans
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_restore_plan_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_token_burn_delete_request_row
      INSTEAD OF INSERT ON public.meta_recovery_token_burn_delete_requests
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_token_burn_delete_request_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_token_burns_d5_guard_row
      BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_token_burns
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_token_burn_d5_guard_row()
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_sync_receipts_guard_row
      BEFORE UPDATE OR DELETE ON public.meta_recovery_archive_sync_receipts
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_sync_receipt_guard_row()
  `.execute(db)

  await sql`
    CREATE CONSTRAINT TRIGGER trg_meta_recovery_archive_jobs_consistency
      AFTER INSERT OR UPDATE ON public.meta_recovery_archive_jobs
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_job_consistency_guard()
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_meta_recovery_archive_job_chunks_consistency
      AFTER INSERT OR UPDATE ON public.meta_recovery_archive_job_chunks
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_job_consistency_guard()
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_meta_recovery_archive_jobs_burn_consistency
      AFTER INSERT OR UPDATE ON public.meta_recovery_archive_jobs
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_token_burn_d5_consistency_guard()
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_meta_recovery_token_burns_d5_consistency
      AFTER INSERT OR UPDATE ON public.meta_recovery_token_burns
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_token_burn_d5_consistency_guard()
  `.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_meta_recovery_archive_sync_receipts_consistency
      AFTER INSERT OR UPDATE ON public.meta_recovery_archive_sync_receipts
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_token_burn_d5_consistency_guard()
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_jobs_reject_truncate
      BEFORE TRUNCATE ON public.meta_recovery_archive_jobs
      FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_d5_reject_truncate()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_job_chunks_reject_truncate
      BEFORE TRUNCATE ON public.meta_recovery_archive_job_chunks
      FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_d5_reject_truncate()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_restore_plans_reject_truncate
      BEFORE TRUNCATE ON public.meta_recovery_archive_restore_plans
      FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_d5_reject_truncate()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_meta_recovery_archive_sync_receipts_reject_truncate
      BEFORE TRUNCATE ON public.meta_recovery_archive_sync_receipts
      FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_d5_reject_truncate()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_jobs') IS NULL OR
         pg_catalog.to_regclass('public.meta_recovery_archive_job_chunks') IS NULL OR
         pg_catalog.to_regclass('public.meta_recovery_archive_restore_plans') IS NULL OR
         pg_catalog.to_regclass('public.meta_recovery_archive_sync_receipts') IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_job_schema_missing';
      END IF;

      LOCK TABLE public.meta_recovery_archive_jobs,
                 public.meta_recovery_archive_job_chunks,
                 public.meta_recovery_archive_restore_plans,
                 public.meta_recovery_archive_sync_receipts,
                 public.meta_recovery_token_burns,
                 public.meta_recovery_archives,
                 public.meta_sheets,
                 public.meta_record_history_operations,
                 public.meta_record_history_operation_members
        IN ACCESS EXCLUSIVE MODE;

      IF EXISTS (SELECT 1 FROM public.meta_recovery_archive_jobs LIMIT 1) OR
         EXISTS (SELECT 1 FROM public.meta_recovery_archive_job_chunks LIMIT 1) OR
         EXISTS (SELECT 1 FROM public.meta_recovery_archive_restore_plans LIMIT 1) OR
         EXISTS (SELECT 1 FROM public.meta_recovery_archive_sync_receipts LIMIT 1) OR
         EXISTS (SELECT 1 FROM public.meta_recovery_token_burns WHERE burn_kind IS NOT NULL LIMIT 1) OR
         EXISTS (
           SELECT 1 FROM public.meta_sheets
            WHERE recovery_writer_owner_kind = 'restore_job' LIMIT 1
         ) OR EXISTS (
           SELECT 1 FROM public.meta_record_history_operations
            WHERE operation_kind IN ('restore_chunk', 'restore_aggregate') LIMIT 1
         ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_restore_job_down_nonempty';
      END IF;
    END $$;
  `.execute(db)

  await sql`DROP TRIGGER trg_meta_recovery_archive_sync_receipts_reject_truncate ON public.meta_recovery_archive_sync_receipts`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_restore_plans_reject_truncate ON public.meta_recovery_archive_restore_plans`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_job_chunks_reject_truncate ON public.meta_recovery_archive_job_chunks`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_jobs_reject_truncate ON public.meta_recovery_archive_jobs`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_sync_receipts_consistency ON public.meta_recovery_archive_sync_receipts`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_sync_receipts_guard_row ON public.meta_recovery_archive_sync_receipts`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_token_burns_d5_consistency ON public.meta_recovery_token_burns`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_jobs_burn_consistency ON public.meta_recovery_archive_jobs`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_job_chunks_consistency ON public.meta_recovery_archive_job_chunks`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_jobs_consistency ON public.meta_recovery_archive_jobs`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_token_burns_d5_guard_row ON public.meta_recovery_token_burns`.execute(db)
  await sql`DROP INDEX public.idx_meta_recovery_token_burns_d5_prunable`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_job_chunks_guard_row ON public.meta_recovery_archive_job_chunks`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_restore_plans_guard_row ON public.meta_recovery_archive_restore_plans`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archive_jobs_guard_row ON public.meta_recovery_archive_jobs`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_archives_nonterminal_job_guard_row ON public.meta_recovery_archives`.execute(db)

  await sql`DROP FUNCTION public.meta_recovery_token_burn_delete_authorize(text, bigint)`.execute(db)
  await sql`DROP TRIGGER trg_meta_recovery_token_burn_delete_request_row ON public.meta_recovery_token_burn_delete_requests`.execute(db)
  await sql`DROP VIEW public.meta_recovery_token_burn_delete_requests`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_token_burn_delete_request_row()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_d5_reject_truncate()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_token_burn_d5_consistency_guard()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_token_burn_d5_guard_row()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_sync_receipt_guard_row()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_restore_plan_guard_row()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_nonterminal_job_guard_row()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_job_consistency_guard()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_job_chunk_guard_row()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_job_guard_row()`.execute(db)

  await sql`DROP TABLE public.meta_recovery_archive_sync_receipts`.execute(db)
  await sql`DROP TABLE public.meta_recovery_archive_restore_plans`.execute(db)
  await sql`
    ALTER TABLE public.meta_recovery_token_burns
      DROP CONSTRAINT chk_meta_recovery_token_burns_d5_retention,
      DROP CONSTRAINT chk_meta_recovery_token_burns_d5_shape,
      DROP CONSTRAINT fk_meta_recovery_token_burns_generation,
      DROP CONSTRAINT fk_meta_recovery_token_burns_sync_operation,
      DROP CONSTRAINT fk_meta_recovery_token_burns_job,
      DROP CONSTRAINT uq_meta_recovery_token_burns_sync_operation,
      DROP CONSTRAINT uq_meta_recovery_token_burns_job,
      DROP COLUMN row_version,
      DROP COLUMN terminal_at,
      DROP COLUMN retain_until,
      DROP COLUMN token_expires_at,
      DROP COLUMN source_vector_hash,
      DROP COLUMN archive_root_hash,
      DROP COLUMN archive_generation_id,
      DROP COLUMN sync_operation_id,
      DROP COLUMN job_id,
      DROP COLUMN burn_kind
  `.execute(db)
  await sql`DROP TABLE public.meta_recovery_archive_job_chunks`.execute(db)
  await sql`DROP TABLE public.meta_recovery_archive_jobs`.execute(db)
}
