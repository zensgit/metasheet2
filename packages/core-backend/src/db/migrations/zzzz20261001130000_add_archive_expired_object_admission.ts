import { sql, type Kysely } from 'kysely'

/** Inert D-L REQUEST/READY authority. No provider worker or reference release. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE public.meta_recovery_archive_object_deletions (
      id uuid PRIMARY KEY,
      generation_id uuid NOT NULL,
      object_id text NOT NULL,
      state text NOT NULL DEFAULT 'requested',
      owner_request_id uuid NOT NULL,
      provider_operation_key text NOT NULL,
      worker_owner_id text,
      worker_fence bigint NOT NULL DEFAULT 0,
      lease_until timestamptz,
      attempt_count bigint NOT NULL DEFAULT 0,
      provider_receipt_sha256 text,
      row_version bigint NOT NULL DEFAULT 1,
      requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      ready_at timestamptz,
      cancelled_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uq_archive_object_deletion_identity UNIQUE (generation_id, object_id),
      FOREIGN KEY (generation_id, object_id)
        REFERENCES public.meta_recovery_archive_objects(generation_id, object_id) ON DELETE RESTRICT,
      CHECK (state IN ('requested', 'ready', 'deleting', 'deleted', 'failed_retryable', 'cancelled')),
      CHECK (provider_operation_key ~ '^[0-9a-f]{64}$'),
      CHECK (row_version >= 1 AND worker_fence >= 0 AND attempt_count >= 0),
      CHECK (provider_receipt_sha256 IS NULL OR provider_receipt_sha256 ~ '^[0-9a-f]{64}$')
    )
  `.execute(db)

  // All completeness evidence is normalized catalog/receipt data, never a caller boolean.
  await sql`
    CREATE FUNCTION public.meta_recovery_archive_deletion_complete(expected_generation uuid)
    RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.meta_recovery_archives archive
        WHERE archive.generation_id = expected_generation
          AND archive.state IN ('verified', 'expired')
          AND archive.build_status = 'finalized' AND archive.coverage_status = 'complete'
          AND archive.root_hash IS NOT NULL AND archive.manifest_mac IS NOT NULL
          AND archive.coverage_row_count = (
            SELECT count(*) FROM public.meta_recovery_archive_coverage_items coverage
            WHERE coverage.generation_id = archive.generation_id
          )
          AND (SELECT count(*) FROM public.meta_recovery_archive_objects object_row
               WHERE object_row.generation_id = archive.generation_id
                 AND object_row.object_class = 'section' AND object_row.state = 'verified') = 10
          AND (SELECT count(*) FROM public.meta_recovery_archive_objects object_row
               WHERE object_row.generation_id = archive.generation_id
                 AND object_row.object_class = 'manifest' AND object_row.state = 'verified') = 1
          AND NOT EXISTS (
            SELECT 1 FROM public.meta_recovery_archive_objects object_row
            WHERE object_row.generation_id = archive.generation_id
              AND (object_row.state <> 'verified' OR object_row.key_id <> archive.key_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.meta_recovery_archive_attachment_refs reference_row
            WHERE reference_row.generation_id = archive.generation_id
              AND (reference_row.reference_class <> 'archive_object'
                   OR reference_row.reference_state <> 'verified'
                   OR reference_row.availability <> 'available'
                   OR NOT EXISTS (
                     SELECT 1 FROM public.meta_recovery_archive_objects object_row
                     WHERE object_row.generation_id = archive.generation_id
                       AND object_row.object_class = 'attachment'
                       AND object_row.attachment_id = reference_row.attachment_id
                       AND object_row.plaintext_sha256 = reference_row.content_sha256
                       AND object_row.provider_version = reference_row.immutable_version
                       AND object_row.state = 'verified'
                   ))
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.meta_recovery_archive_objects object_row
            WHERE object_row.generation_id = archive.generation_id
              AND object_row.object_class = 'attachment'
              AND NOT EXISTS (
                SELECT 1 FROM public.meta_recovery_archive_attachment_refs reference_row
                WHERE reference_row.generation_id = archive.generation_id
                  AND reference_row.attachment_id = object_row.attachment_id
                  AND reference_row.content_sha256 = object_row.plaintext_sha256
                  AND reference_row.immutable_version = object_row.provider_version
                  AND reference_row.reference_class = 'archive_object'
                  AND reference_row.reference_state = 'verified'
                  AND reference_row.availability = 'available'
              )
          )
      )
    $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_object_deletion_check(
      expected_generation_id uuid, expected_object_id text, expected_workspace_id text,
      expected_base_id text, expected_sheet_id text, expected_anchor_operation_id uuid,
      expected_anchor_seq bigint, expected_checkpoint_id text
    ) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      target public.meta_recovery_archives%ROWTYPE;
      identities uuid[];
      keys text[];
      database_now timestamptz;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('meta:auto-number:sheet:' || expected_sheet_id));
      SELECT array_agg(archive.generation_id ORDER BY archive.generation_id),
             array_agg(DISTINCT archive.key_id COLLATE "C" ORDER BY archive.key_id COLLATE "C")
        INTO identities, keys FROM public.meta_recovery_archives archive
       WHERE archive.workspace_id = expected_workspace_id AND archive.base_id = expected_base_id
         AND archive.sheet_id = expected_sheet_id AND archive.anchor_operation_id = expected_anchor_operation_id
         AND archive.anchor_seq = expected_anchor_seq AND archive.checkpoint_id = expected_checkpoint_id;
      PERFORM 1 FROM public.meta_recovery_archive_keys key_row
       WHERE key_row.key_id = ANY(keys) ORDER BY key_row.key_id COLLATE "C" FOR UPDATE;
      PERFORM 1 FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = ANY(identities) ORDER BY archive.generation_id FOR UPDATE;
      SELECT * INTO target FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = expected_generation_id AND archive.generation_id = ANY(identities);
      database_now := clock_timestamp();
      IF NOT FOUND OR target.state <> 'expired' OR target.expires_at > database_now
         OR NOT EXISTS (SELECT 1 FROM public.meta_recovery_archive_keys key_row
                        WHERE key_row.key_id = target.key_id AND key_row.state = 'active') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_archive_refused';
      END IF;
      PERFORM 1 FROM public.meta_recovery_archive_jobs job
       WHERE job.archive_generation_id = ANY(identities) ORDER BY job.id FOR UPDATE;
      PERFORM 1 FROM public.meta_recovery_archive_restore_plans plan
       WHERE plan.archive_generation_id = ANY(identities) ORDER BY plan.token_sha256 COLLATE "C" FOR UPDATE;
      PERFORM 1 FROM public.meta_recovery_archive_legal_holds hold_row
       WHERE hold_row.generation_id = ANY(identities) AND hold_row.state = 'active'
       ORDER BY hold_row.id FOR UPDATE;
      PERFORM 1 FROM public.meta_recovery_archive_objects object_row
       WHERE object_row.generation_id = ANY(identities)
       ORDER BY object_row.generation_id, object_row.object_id COLLATE "C" FOR UPDATE;
      PERFORM 1 FROM public.meta_recovery_archive_attachment_refs reference_row
       WHERE reference_row.generation_id = ANY(identities)
       ORDER BY reference_row.generation_id, reference_row.attachment_id COLLATE "C" FOR UPDATE;
      PERFORM 1 FROM public.meta_recovery_archive_coverage_items coverage
       WHERE coverage.generation_id = ANY(identities)
       ORDER BY coverage.generation_id, coverage.source_kind COLLATE "C", coverage.source_id COLLATE "C" FOR UPDATE;
      database_now := clock_timestamp();
      IF EXISTS (SELECT 1 FROM public.meta_recovery_archive_legal_holds hold_row
                 WHERE hold_row.generation_id = target.generation_id AND hold_row.state = 'active') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_held';
      END IF;
      IF EXISTS (SELECT 1 FROM public.meta_recovery_archive_jobs job
                 WHERE job.archive_generation_id = target.generation_id
                   AND job.state NOT IN ('done', 'abandoned_partial', 'cancelled_zero_write'))
         OR EXISTS (SELECT 1 FROM public.meta_recovery_archive_restore_plans plan
                    WHERE plan.archive_generation_id = target.generation_id AND plan.state = 'prepared') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_job_bound';
      END IF;
      IF public.meta_recovery_archive_deletion_complete(target.generation_id) IS DISTINCT FROM true
         OR NOT EXISTS (SELECT 1 FROM public.meta_recovery_archive_objects object_row
                        WHERE object_row.generation_id = target.generation_id
                          AND object_row.object_id = expected_object_id AND object_row.state = 'verified'
                          AND object_row.key_id = target.key_id) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_object_refused';
      END IF;
      IF EXISTS (SELECT 1 FROM public.meta_recovery_archives point
                 WHERE point.generation_id = ANY(identities) AND point.expires_at > database_now)
         AND NOT EXISTS (
           SELECT 1 FROM public.meta_recovery_archives replacement
           JOIN public.meta_recovery_archive_keys key_row ON key_row.key_id = replacement.key_id
           WHERE replacement.generation_id = ANY(identities)
             AND replacement.generation_id <> target.generation_id
             AND replacement.state = 'verified' AND replacement.expires_at > database_now
             AND key_row.state = 'active'
             AND public.meta_recovery_archive_deletion_complete(replacement.generation_id) IS TRUE
         ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_sole_cover';
      END IF;
      IF target.superseded_by_generation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.meta_recovery_archives replacement
        JOIN public.meta_recovery_archive_keys key_row ON key_row.key_id = replacement.key_id
        WHERE replacement.generation_id = target.superseded_by_generation_id
          AND replacement.generation_id = ANY(identities)
          AND replacement.state = 'verified' AND replacement.expires_at > database_now
          AND key_row.state = 'active'
          AND public.meta_recovery_archive_deletion_complete(replacement.generation_id) IS TRUE
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_rotation_refused';
      END IF;
    END $$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_object_deletion_guard()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_not_authorized';
      END IF;
      IF NEW.state NOT IN ('requested', 'ready', 'cancelled')
         OR NEW.provider_receipt_sha256 IS NOT NULL
         OR (NEW.state <> 'cancelled' AND (NEW.worker_owner_id IS NOT NULL OR NEW.worker_fence <> 0
           OR NEW.lease_until IS NOT NULL OR NEW.attempt_count <> 0)) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_worker_unavailable';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'requested' OR NEW.row_version <> 1
           OR NEW.ready_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_shape_invalid';
        END IF;
      ELSE
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
           OR NEW.object_id IS DISTINCT FROM OLD.object_id
           OR NEW.owner_request_id IS DISTINCT FROM OLD.owner_request_id
           OR NEW.provider_operation_key IS DISTINCT FROM OLD.provider_operation_key
           OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
           OR NEW.worker_owner_id IS DISTINCT FROM OLD.worker_owner_id
           OR NEW.worker_fence IS DISTINCT FROM OLD.worker_fence
           OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
           OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
           OR NEW.row_version <> OLD.row_version + 1
           OR OLD.state NOT IN ('requested', 'ready', 'failed_retryable')
           OR (NEW.state = 'ready' AND (OLD.state <> 'requested' OR NEW.ready_at IS NULL))
           OR (NEW.state = 'cancelled' AND (NEW.cancelled_at IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.meta_recovery_archive_legal_holds hold_row
             WHERE hold_row.generation_id = OLD.generation_id AND hold_row.state = 'active'
           ))) THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_transition_invalid';
        END IF;
      END IF;
      RETURN NEW;
    END $$
  `.execute(db)
  await sql`CREATE TRIGGER trg_archive_object_deletion_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archive_object_deletions
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_object_deletion_guard()`.execute(db)
  await sql`CREATE TRIGGER trg_archive_object_deletion_truncate_guard
    BEFORE TRUNCATE ON public.meta_recovery_archive_object_deletions
    FOR EACH STATEMENT EXECUTE FUNCTION public.meta_recovery_archive_object_deletion_guard()`.execute(db)

  // The only runtime entrypoint is an explicitly granted non-owner-role definer function.
  await sql`
    CREATE FUNCTION public.meta_recovery_archive_object_deletion_command(
      expected_id uuid, expected_generation_id uuid, expected_object_id text,
      expected_owner_request_id uuid, expected_provider_operation_key text,
      expected_workspace_id text, expected_base_id text, expected_sheet_id text,
      expected_anchor_operation_id uuid, expected_anchor_seq bigint, expected_checkpoint_id text,
      expected_command text, expected_row_version bigint
    ) RETURNS TABLE (
      id uuid, generation_id uuid, object_id text, owner_request_id uuid, provider_operation_key text,
      workspace_id text, base_id text, sheet_id text, anchor_operation_id uuid, anchor_seq bigint,
      checkpoint_id text, state text, row_version bigint
    ) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      intent public.meta_recovery_archive_object_deletions%ROWTYPE;
      database_now timestamptz;
    BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_isolation_refused';
      END IF;
      IF expected_command IS NULL OR expected_command NOT IN ('request', 'prepare')
         OR expected_id IS NULL OR expected_generation_id IS NULL OR expected_object_id IS NULL
         OR expected_object_id !~ '^[0-9a-f]{64}$' OR expected_owner_request_id IS NULL
         OR expected_provider_operation_key IS NULL OR expected_provider_operation_key !~ '^[0-9a-f]{64}$'
         OR expected_workspace_id IS NULL OR expected_base_id IS NULL OR expected_sheet_id IS NULL
         OR expected_anchor_operation_id IS NULL OR expected_anchor_seq IS NULL OR expected_anchor_seq < 1
         OR expected_checkpoint_id IS NULL
         OR (expected_command = 'request' AND expected_row_version IS NOT NULL)
         OR (expected_command = 'prepare' AND (expected_row_version IS NULL OR expected_row_version < 1)) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_input_invalid';
      END IF;
      PERFORM public.meta_recovery_archive_object_deletion_check(
        expected_generation_id, expected_object_id, expected_workspace_id, expected_base_id, expected_sheet_id,
        expected_anchor_operation_id, expected_anchor_seq, expected_checkpoint_id
      );
      database_now := clock_timestamp();
      IF expected_command = 'request' THEN
        INSERT INTO public.meta_recovery_archive_object_deletions (
          id, generation_id, object_id, owner_request_id, provider_operation_key
        ) VALUES (expected_id, expected_generation_id, expected_object_id, expected_owner_request_id, expected_provider_operation_key)
        ON CONFLICT ON CONSTRAINT uq_archive_object_deletion_identity DO NOTHING RETURNING * INTO intent;
      ELSE
        UPDATE public.meta_recovery_archive_object_deletions deletion
           SET state = 'ready', ready_at = database_now, updated_at = database_now, row_version = deletion.row_version + 1
         WHERE deletion.id = expected_id AND deletion.generation_id = expected_generation_id AND deletion.object_id = expected_object_id
           AND deletion.owner_request_id = expected_owner_request_id AND deletion.provider_operation_key = expected_provider_operation_key
           AND deletion.state = 'requested' AND deletion.row_version = expected_row_version
         RETURNING * INTO intent;
      END IF;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_stale';
      END IF;
      RETURN QUERY SELECT intent.id, intent.generation_id, intent.object_id, intent.owner_request_id,
        intent.provider_operation_key, expected_workspace_id, expected_base_id, expected_sheet_id,
        expected_anchor_operation_id, expected_anchor_seq, expected_checkpoint_id, intent.state, intent.row_version;
    END $$
  `.execute(db)
  await sql`
    CREATE FUNCTION public.meta_recovery_archive_object_deletion_hold_cancel()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      PERFORM 1 FROM public.meta_recovery_archive_object_deletions intent
       WHERE intent.generation_id = NEW.generation_id ORDER BY intent.id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM public.meta_recovery_archive_object_deletions intent
                 WHERE intent.generation_id = NEW.generation_id AND intent.state IN ('deleting', 'deleted')) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_hold_too_late';
      END IF;
      UPDATE public.meta_recovery_archive_object_deletions
         SET state = 'cancelled', cancelled_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
       WHERE generation_id = NEW.generation_id AND state IN ('requested', 'ready', 'failed_retryable');
      RETURN NEW;
    END $$
  `.execute(db)
  await sql`CREATE TRIGGER trg_archive_object_deletion_hold_cancel
    AFTER INSERT ON public.meta_recovery_archive_legal_holds
    FOR EACH ROW EXECUTE FUNCTION public.meta_recovery_archive_object_deletion_hold_cancel()`.execute(db)
  await sql`REVOKE ALL ON public.meta_recovery_archive_object_deletions FROM PUBLIC`.execute(db)
  await sql`REVOKE ALL ON FUNCTION public.meta_recovery_archive_deletion_complete(uuid) FROM PUBLIC`.execute(db)
  await sql`REVOKE ALL ON FUNCTION public.meta_recovery_archive_object_deletion_check(uuid, text, text, text, text, uuid, bigint, text) FROM PUBLIC`.execute(db)
  await sql`REVOKE ALL ON FUNCTION public.meta_recovery_archive_object_deletion_guard() FROM PUBLIC`.execute(db)
  await sql`REVOKE ALL ON FUNCTION public.meta_recovery_archive_object_deletion_hold_cancel() FROM PUBLIC`.execute(db)
  await sql`REVOKE ALL ON FUNCTION public.meta_recovery_archive_object_deletion_command(uuid, uuid, text, uuid, text, text, text, text, uuid, bigint, text, text, bigint) FROM PUBLIC`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$ BEGIN
      LOCK TABLE public.meta_recovery_archive_object_deletions IN ACCESS EXCLUSIVE MODE NOWAIT;
      IF EXISTS (SELECT 1 FROM public.meta_recovery_archive_object_deletions) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_deletion_nonempty';
      END IF;
    END $$
  `.execute(db)
  await sql`DROP TRIGGER trg_archive_object_deletion_hold_cancel ON public.meta_recovery_archive_legal_holds`.execute(db)
  await sql`DROP TABLE public.meta_recovery_archive_object_deletions`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_object_deletion_hold_cancel()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_object_deletion_command(uuid, uuid, text, uuid, text, text, text, text, uuid, bigint, text, text, bigint)`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_object_deletion_guard()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_object_deletion_check(uuid, text, text, text, text, uuid, bigint, text)`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_deletion_complete(uuid)`.execute(db)
}
