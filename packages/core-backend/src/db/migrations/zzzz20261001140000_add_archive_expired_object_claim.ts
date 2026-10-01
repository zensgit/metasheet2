import { sql, type Kysely } from 'kysely'

/** Inert D-L worker claim only. No provider, receipt, reference release or runtime grant. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.meta_recovery_archive_object_deletions
    ADD COLUMN store_id uuid,
    ADD COLUMN staging_object_id uuid,
    ADD COLUMN key_id text,
    ADD COLUMN provider_version text,
    ADD COLUMN ciphertext_sha256 text,
    ADD COLUMN size_bytes bigint,
    ADD COLUMN object_expires_at timestamptz,
    ADD CONSTRAINT chk_archive_object_deletion_binding CHECK (
      (store_id IS NULL AND staging_object_id IS NULL AND key_id IS NULL AND provider_version IS NULL
        AND ciphertext_sha256 IS NULL AND size_bytes IS NULL AND object_expires_at IS NULL)
      OR (store_id IS NOT NULL AND staging_object_id IS NOT NULL AND key_id IS NOT NULL
        AND length(btrim(key_id)) BETWEEN 1 AND 255 AND provider_version IS NOT NULL
        AND length(btrim(provider_version)) BETWEEN 1 AND 512 AND ciphertext_sha256 IS NOT NULL
        AND ciphertext_sha256 ~ '^[0-9a-f]{64}$' AND size_bytes IS NOT NULL AND size_bytes >= 0
        AND object_expires_at IS NOT NULL AND isfinite(object_expires_at))
    )`.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_object_claim_guard()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.store_id IS NOT NULL OR NEW.staging_object_id IS NOT NULL OR NEW.key_id IS NOT NULL
           OR NEW.provider_version IS NOT NULL OR NEW.ciphertext_sha256 IS NOT NULL
           OR NEW.size_bytes IS NOT NULL OR NEW.object_expires_at IS NOT NULL THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_binding_invalid';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.state IS DISTINCT FROM 'deleting' THEN
        IF ROW(NEW.store_id, NEW.staging_object_id, NEW.key_id, NEW.provider_version,
          NEW.ciphertext_sha256, NEW.size_bytes, NEW.object_expires_at) IS DISTINCT FROM
          ROW(OLD.store_id, OLD.staging_object_id, OLD.key_id, OLD.provider_version,
          OLD.ciphertext_sha256, OLD.size_bytes, OLD.object_expires_at) THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_binding_immutable';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.state NOT IN ('ready', 'failed_retryable', 'deleting')
         OR NEW.id IS DISTINCT FROM OLD.id OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
         OR NEW.object_id IS DISTINCT FROM OLD.object_id OR NEW.owner_request_id IS DISTINCT FROM OLD.owner_request_id
         OR NEW.provider_operation_key IS DISTINCT FROM OLD.provider_operation_key
         OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
         OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancelled_at IS NOT NULL
         OR NEW.provider_receipt_sha256 IS NOT NULL OR OLD.provider_receipt_sha256 IS NOT NULL
         OR NEW.row_version <> OLD.row_version + 1 OR NEW.worker_fence <> OLD.worker_fence + 1
         OR NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.worker_owner_id IS NULL
         OR length(btrim(NEW.worker_owner_id)) NOT BETWEEN 1 AND 512 OR NEW.worker_owner_id ~ '[[:cntrl:]]'
         OR NEW.lease_until IS NULL OR NEW.lease_until <= clock_timestamp()
         OR NEW.lease_until > date_trunc('milliseconds', clock_timestamp()) + interval '60 seconds'
         OR NEW.store_id IS NULL OR NEW.staging_object_id IS NULL OR NEW.key_id IS NULL
         OR NEW.provider_version IS NULL OR NEW.ciphertext_sha256 IS NULL
         OR NEW.size_bytes IS NULL OR NEW.object_expires_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_transition_invalid';
      END IF;
      IF OLD.store_id IS NOT NULL AND ROW(NEW.store_id, NEW.staging_object_id, NEW.key_id, NEW.provider_version,
         NEW.ciphertext_sha256, NEW.size_bytes, NEW.object_expires_at) IS DISTINCT FROM
         ROW(OLD.store_id, OLD.staging_object_id, OLD.key_id, OLD.provider_version,
         OLD.ciphertext_sha256, OLD.size_bytes, OLD.object_expires_at) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_binding_immutable';
      END IF;
      IF OLD.state = 'deleting' AND (OLD.lease_until IS NULL OR OLD.lease_until >= clock_timestamp()
         OR OLD.worker_owner_id IS NULL OR OLD.worker_fence < 1 OR OLD.store_id IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_lease_active';
      END IF;
      -- The command already owns the prefix locks. This invariant read takes no backward locks.
      IF NOT EXISTS (
        SELECT 1 FROM public.meta_recovery_archive_abandoned_bindings binding
        JOIN public.meta_recovery_archive_staging_objects staging USING (generation_id, staging_object_id)
        JOIN public.meta_recovery_archive_objects object_row USING (generation_id, object_id)
        JOIN public.meta_recovery_archives archive USING (generation_id)
        WHERE binding.generation_id = NEW.generation_id AND binding.object_id = NEW.object_id
          AND binding.store_id = NEW.store_id AND binding.staging_object_id = NEW.staging_object_id
          AND binding.provider_version = NEW.provider_version AND object_row.provider_version = NEW.provider_version
          AND binding.ciphertext_sha256 = NEW.ciphertext_sha256 AND object_row.ciphertext_sha256 = NEW.ciphertext_sha256
          AND binding.size_bytes = NEW.size_bytes AND object_row.size_bytes = NEW.size_bytes
          AND binding.expires_at = NEW.object_expires_at
          AND binding.expires_at = date_trunc('milliseconds', archive.expires_at)
          AND staging.key_id = NEW.key_id AND object_row.key_id = NEW.key_id AND archive.key_id = NEW.key_id
          AND staging.object_class = object_row.object_class
          AND staging.attachment_id IS NOT DISTINCT FROM object_row.attachment_id
          AND staging.object_state = 'sealed' AND staging.terminal_receipt_sha256 IS NULL
          AND staging.cleanup_owner_kind IS NULL AND staging.cleanup_owner_id IS NULL AND staging.cleanup_owner_fence IS NULL
          AND binding.owner_kind = object_row.owner_kind AND binding.owner_id = object_row.owner_id
          AND binding.owner_fence = object_row.owner_fence AND object_row.owner_kind = archive.owner_kind
          AND object_row.owner_id = archive.owner_id AND object_row.owner_fence = archive.owner_fence
          AND object_row.state = 'verified' AND archive.state = 'expired'
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_binding_invalid';
      END IF;
      RETURN NEW;
    END $$
  `.execute(db)
  // Preserve the frozen admission guard function; only deleting updates use the new closed shape.
  await sql`DROP TRIGGER trg_archive_object_deletion_guard ON public.meta_recovery_archive_object_deletions`.execute(db)
  await sql`CREATE TRIGGER trg_archive_object_deletion_guard BEFORE INSERT OR DELETE
    ON public.meta_recovery_archive_object_deletions FOR EACH ROW
    EXECUTE FUNCTION public.meta_recovery_archive_object_deletion_guard()`.execute(db)
  await sql`CREATE TRIGGER trg_archive_object_deletion_admission_update_guard BEFORE UPDATE
    ON public.meta_recovery_archive_object_deletions FOR EACH ROW WHEN (NEW.state IS DISTINCT FROM 'deleting')
    EXECUTE FUNCTION public.meta_recovery_archive_object_deletion_guard()`.execute(db)
  await sql`CREATE TRIGGER trg_archive_object_claim_guard BEFORE INSERT OR UPDATE
    ON public.meta_recovery_archive_object_deletions FOR EACH ROW
    EXECUTE FUNCTION public.meta_recovery_archive_object_claim_guard()`.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archive_object_claim_command(
      expected_id uuid, expected_generation_id uuid, expected_object_id text,
      expected_owner_request_id uuid, expected_provider_operation_key text,
      expected_workspace_id text, expected_base_id text, expected_sheet_id text,
      expected_anchor_operation_id uuid, expected_anchor_seq bigint, expected_checkpoint_id text,
      expected_command text, expected_row_version bigint, next_worker_owner_id text,
      previous_worker_owner_id text, previous_worker_fence bigint, previous_lease_until timestamptz
    ) RETURNS TABLE (
      id uuid, generation_id uuid, object_id text, owner_request_id uuid, provider_operation_key text,
      state text, row_version bigint, worker_owner_id text, worker_fence bigint, lease_until timestamptz,
      attempt_count bigint, store_id uuid, staging_object_id uuid, key_id text, provider_version text,
      ciphertext_sha256 text, size_bytes bigint, object_expires_at timestamptz
    ) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      intent public.meta_recovery_archive_object_deletions%ROWTYPE;
      source_binding record;
      database_now timestamptz;
    BEGIN
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_isolation_refused';
      END IF;
      IF expected_command IS NULL OR expected_command NOT IN ('claim', 'takeover')
         OR expected_id IS NULL OR expected_generation_id IS NULL OR expected_object_id IS NULL
         OR expected_object_id !~ '^[0-9a-f]{64}$' OR expected_owner_request_id IS NULL
         OR expected_provider_operation_key IS NULL OR expected_provider_operation_key !~ '^[0-9a-f]{64}$'
         OR expected_workspace_id IS NULL OR expected_base_id IS NULL OR expected_sheet_id IS NULL
         OR expected_anchor_operation_id IS NULL OR expected_anchor_seq IS NULL OR expected_anchor_seq < 1
         OR expected_checkpoint_id IS NULL OR expected_row_version IS NULL OR expected_row_version < 1
         OR next_worker_owner_id IS NULL OR length(btrim(next_worker_owner_id)) NOT BETWEEN 1 AND 512
         OR next_worker_owner_id <> btrim(next_worker_owner_id) OR next_worker_owner_id ~ '[[:cntrl:]]'
         OR (expected_command = 'claim' AND (previous_worker_owner_id IS NOT NULL
           OR previous_worker_fence IS NOT NULL OR previous_lease_until IS NOT NULL))
         OR (expected_command = 'takeover' AND (previous_worker_owner_id IS NULL
           OR previous_worker_fence IS NULL OR previous_worker_fence < 1 OR previous_lease_until IS NULL
           OR NOT isfinite(previous_lease_until))) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_input_invalid';
      END IF;
      PERFORM public.meta_recovery_archive_object_deletion_check(expected_generation_id, expected_object_id,
        expected_workspace_id, expected_base_id, expected_sheet_id, expected_anchor_operation_id,
        expected_anchor_seq, expected_checkpoint_id);
      PERFORM 1 FROM public.meta_recovery_archive_staging_objects staging
        JOIN public.meta_recovery_archive_abandoned_bindings binding USING (generation_id, staging_object_id)
        WHERE binding.generation_id = expected_generation_id AND binding.object_id = expected_object_id
        ORDER BY staging.staging_object_id FOR UPDATE OF staging;
      PERFORM 1 FROM public.meta_recovery_archive_abandoned_bindings binding
        WHERE binding.generation_id = expected_generation_id AND binding.object_id = expected_object_id
        ORDER BY binding.staging_object_id FOR UPDATE;
      SELECT binding.store_id, binding.staging_object_id, binding.provider_version,
        binding.ciphertext_sha256, binding.size_bytes, binding.expires_at, staging.key_id
        INTO source_binding FROM public.meta_recovery_archive_abandoned_bindings binding
        JOIN public.meta_recovery_archive_staging_objects staging USING (generation_id, staging_object_id)
        WHERE binding.generation_id = expected_generation_id AND binding.object_id = expected_object_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_binding_missing';
      END IF;
      SELECT * INTO intent FROM public.meta_recovery_archive_object_deletions deletion
        WHERE deletion.id = expected_id AND deletion.generation_id = expected_generation_id
          AND deletion.object_id = expected_object_id AND deletion.owner_request_id = expected_owner_request_id
          AND deletion.provider_operation_key = expected_provider_operation_key FOR UPDATE;
      database_now := date_trunc('milliseconds', clock_timestamp());
      IF NOT FOUND OR intent.row_version <> expected_row_version
         OR (expected_command = 'claim' AND intent.state NOT IN ('ready', 'failed_retryable'))
         OR (expected_command = 'takeover' AND (intent.state <> 'deleting'
           OR intent.worker_owner_id IS DISTINCT FROM previous_worker_owner_id
           OR intent.worker_fence IS DISTINCT FROM previous_worker_fence
           OR intent.lease_until IS DISTINCT FROM previous_lease_until OR intent.lease_until >= database_now)) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_stale';
      END IF;
      UPDATE public.meta_recovery_archive_object_deletions deletion SET state = 'deleting',
        worker_owner_id = next_worker_owner_id, worker_fence = deletion.worker_fence + 1,
        attempt_count = deletion.attempt_count + 1, lease_until = database_now + interval '60 seconds',
        row_version = deletion.row_version + 1, updated_at = database_now,
        store_id = source_binding.store_id, staging_object_id = source_binding.staging_object_id,
        key_id = source_binding.key_id, provider_version = source_binding.provider_version,
        ciphertext_sha256 = source_binding.ciphertext_sha256, size_bytes = source_binding.size_bytes,
        object_expires_at = source_binding.expires_at
        WHERE deletion.id = expected_id AND deletion.row_version = expected_row_version
          AND deletion.state = intent.state AND deletion.worker_fence = intent.worker_fence
          AND deletion.worker_owner_id IS NOT DISTINCT FROM intent.worker_owner_id
          AND deletion.lease_until IS NOT DISTINCT FROM intent.lease_until RETURNING * INTO intent;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_object_claim_stale';
      END IF;
      RETURN QUERY SELECT intent.id, intent.generation_id, intent.object_id, intent.owner_request_id,
        intent.provider_operation_key, intent.state, intent.row_version, intent.worker_owner_id,
        intent.worker_fence, intent.lease_until, intent.attempt_count, intent.store_id,
        intent.staging_object_id, intent.key_id, intent.provider_version, intent.ciphertext_sha256,
        intent.size_bytes, intent.object_expires_at;
    END $$
  `.execute(db)
  await sql`REVOKE ALL ON public.meta_recovery_archive_object_deletions FROM PUBLIC`.execute(db)
  await sql`REVOKE ALL ON FUNCTION public.meta_recovery_archive_object_claim_guard() FROM PUBLIC`.execute(db)
  await sql`REVOKE ALL ON FUNCTION public.meta_recovery_archive_object_claim_command(uuid, uuid, text, uuid, text,
    text, text, text, uuid, bigint, text, text, bigint, text, text, bigint, timestamptz) FROM PUBLIC`.execute(db)
}

/** A worker claim or frozen binding is retained history; never erase it by development rollback. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE public.meta_recovery_archive_object_deletions IN ACCESS EXCLUSIVE MODE NOWAIT`.execute(db)
  const result = await sql<{ present: boolean }>`SELECT EXISTS (
    SELECT 1 FROM public.meta_recovery_archive_object_deletions
    WHERE store_id IS NOT NULL OR staging_object_id IS NOT NULL OR key_id IS NOT NULL
      OR provider_version IS NOT NULL OR ciphertext_sha256 IS NOT NULL OR size_bytes IS NOT NULL
      OR object_expires_at IS NOT NULL OR state IN ('deleting', 'deleted')
      OR worker_owner_id IS NOT NULL OR worker_fence <> 0 OR lease_until IS NOT NULL OR attempt_count <> 0
  ) AS present`.execute(db)
  if (result.rows[0]?.present !== false) throw new Error('recovery_archive_object_claim_retained')
  await sql`DROP TRIGGER trg_archive_object_claim_guard ON public.meta_recovery_archive_object_deletions`.execute(db)
  await sql`DROP TRIGGER trg_archive_object_deletion_admission_update_guard ON public.meta_recovery_archive_object_deletions`.execute(db)
  await sql`DROP TRIGGER trg_archive_object_deletion_guard ON public.meta_recovery_archive_object_deletions`.execute(db)
  await sql`CREATE TRIGGER trg_archive_object_deletion_guard BEFORE INSERT OR UPDATE OR DELETE
    ON public.meta_recovery_archive_object_deletions FOR EACH ROW
    EXECUTE FUNCTION public.meta_recovery_archive_object_deletion_guard()`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_object_claim_command(uuid, uuid, text, uuid, text,
    text, text, text, uuid, bigint, text, text, bigint, text, text, bigint, timestamptz)`.execute(db)
  await sql`DROP FUNCTION public.meta_recovery_archive_object_claim_guard()`.execute(db)
  await sql`ALTER TABLE public.meta_recovery_archive_object_deletions DROP CONSTRAINT chk_archive_object_deletion_binding,
    DROP COLUMN store_id, DROP COLUMN staging_object_id, DROP COLUMN key_id, DROP COLUMN provider_version,
    DROP COLUMN ciphertext_sha256, DROP COLUMN size_bytes, DROP COLUMN object_expires_at`.execute(db)
}
