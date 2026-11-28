/** E1-A schema only: no old-table FK, public function, trigger or producer. */
import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!db.isTransaction) throw new Error('E1_MIGRATION_TRANSACTION_REQUIRED')
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await sql`
    CREATE TABLE public.security_events (
      id uuid PRIMARY KEY,
      schema_version smallint NOT NULL DEFAULT 1,
      scope_kind text NOT NULL,
      org_id text,
      producer text NOT NULL,
      event_type text NOT NULL,
      severity text NOT NULL,
      outcome text NOT NULL,
      reason_code text,
      actor_kind text NOT NULL,
      actor_user_id text,
      subject_user_id text,
      target_kind text,
      target_id text,
      source_kind text NOT NULL,
      source_id text NOT NULL,
      source_step text NOT NULL,
      record_origin text NOT NULL,
      occurred_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      facts jsonb NOT NULL DEFAULT '{}'::jsonb,
      expires_at timestamptz NOT NULL,
      delivery_planned_at timestamptz,
      CONSTRAINT se_version CHECK (schema_version = 1),
      CONSTRAINT se_scope CHECK (scope_kind IN ('organization', 'system')),
      CONSTRAINT se_org CHECK (CASE WHEN scope_kind = 'organization' THEN org_id IS NOT NULL AND char_length(org_id) BETWEEN 1 AND 128 ELSE org_id IS NULL END),
      CONSTRAINT se_producer CHECK (producer IN ('directory', 'auth', 'security_action', 'authorization', 'admin_grant', 'deprovision', 'platform')),
      CONSTRAINT se_type CHECK (char_length(event_type) BETWEEN 1 AND 96 AND event_type ~ '^[a-z_]+[.][a-z_]+$'),
      CONSTRAINT se_severity CHECK (severity IN ('info', 'warning', 'error', 'critical')),
      CONSTRAINT se_outcome CHECK (outcome IN ('succeeded', 'denied', 'failed', 'observed')),
      CONSTRAINT se_reason CHECK (reason_code IN ('sync_failed', 'refusal_window', 'startup_tail_unverified', 'aggregation_overflow', 'source_missing', 'event_store_unavailable', 'scan_interrupted', 'empty_directory_fetch', 'batch_exceeds_max', 'redirect_refused')),
      CONSTRAINT se_actor_kind CHECK (actor_kind IN ('user', 'system', 'anonymous')),
      CONSTRAINT se_actor CHECK (CASE WHEN actor_kind = 'user' THEN actor_user_id IS NOT NULL AND char_length(actor_user_id) BETWEEN 1 AND 128 ELSE actor_user_id IS NULL END),
      CONSTRAINT se_subject CHECK (subject_user_id IS NULL OR char_length(subject_user_id) BETWEEN 1 AND 128),
      CONSTRAINT se_target_kind CHECK (target_kind IN ('integration', 'user', 'membership', 'grant', 'operation', 'run', 'component')),
      CONSTRAINT se_target CHECK (CASE WHEN target_kind IS NULL THEN target_id IS NULL ELSE target_id IS NOT NULL AND char_length(target_id) BETWEEN 1 AND 128 END),
      CONSTRAINT se_source_kind CHECK (source_kind IN ('sync_run', 'deprovision_effect', 'auth_operation', 'admin_grant_command', 'request', 'runtime_probe', 'request_window')),
      CONSTRAINT se_source_id CHECK (char_length(source_id) BETWEEN 1 AND 512 AND octet_length(source_id) <= 2048),
      CONSTRAINT se_source_step CHECK (char_length(source_step) BETWEEN 1 AND 64 AND source_step ~ '^[a-z_]+$'),
      CONSTRAINT se_origin CHECK (record_origin IN ('live', 'backfill', 'reconcile')),
      CONSTRAINT se_times CHECK (isfinite(occurred_at) AND isfinite(recorded_at) AND isfinite(expires_at) AND expires_at > recorded_at AND (delivery_planned_at IS NULL OR isfinite(delivery_planned_at))),
      CONSTRAINT se_facts CHECK (jsonb_typeof(facts) = 'object' AND octet_length(facts::text) <= 2048 AND (facts - ARRAY['affected_count', 'failed_count', 'pending_count', 'attempt_count', 'threshold_days', 'duration_ms', 'membership_changed', 'grant_revoked', 'user_deactivated', 'source_missing', 'count_unknown', 'sampled', 'truncated']::text[]) = '{}'::jsonb),
      CONSTRAINT se_fact_affected_count CHECK (CASE WHEN facts ? 'affected_count' THEN jsonb_typeof(facts->'affected_count') = 'number' AND (facts->>'affected_count')::numeric BETWEEN 0 AND 2147483647 AND trunc((facts->>'affected_count')::numeric) = (facts->>'affected_count')::numeric ELSE true END),
      CONSTRAINT se_fact_failed_count CHECK (CASE WHEN facts ? 'failed_count' THEN jsonb_typeof(facts->'failed_count') = 'number' AND (facts->>'failed_count')::numeric BETWEEN 0 AND 2147483647 AND trunc((facts->>'failed_count')::numeric) = (facts->>'failed_count')::numeric ELSE true END),
      CONSTRAINT se_fact_pending_count CHECK (CASE WHEN facts ? 'pending_count' THEN jsonb_typeof(facts->'pending_count') = 'number' AND (facts->>'pending_count')::numeric BETWEEN 0 AND 2147483647 AND trunc((facts->>'pending_count')::numeric) = (facts->>'pending_count')::numeric ELSE true END),
      CONSTRAINT se_fact_attempt_count CHECK (CASE WHEN facts ? 'attempt_count' THEN jsonb_typeof(facts->'attempt_count') = 'number' AND (facts->>'attempt_count')::numeric BETWEEN 0 AND 2147483647 AND trunc((facts->>'attempt_count')::numeric) = (facts->>'attempt_count')::numeric ELSE true END),
      CONSTRAINT se_fact_threshold_days CHECK (CASE WHEN facts ? 'threshold_days' THEN jsonb_typeof(facts->'threshold_days') = 'number' AND (facts->>'threshold_days')::numeric BETWEEN 0 AND 2147483647 AND trunc((facts->>'threshold_days')::numeric) = (facts->>'threshold_days')::numeric ELSE true END),
      CONSTRAINT se_fact_duration_ms CHECK (CASE WHEN facts ? 'duration_ms' THEN jsonb_typeof(facts->'duration_ms') = 'number' AND (facts->>'duration_ms')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((facts->>'duration_ms')::numeric) = (facts->>'duration_ms')::numeric ELSE true END),
      CONSTRAINT se_fact_membership_changed CHECK (CASE WHEN facts ? 'membership_changed' THEN jsonb_typeof(facts->'membership_changed') = 'boolean' ELSE true END),
      CONSTRAINT se_fact_grant_revoked CHECK (CASE WHEN facts ? 'grant_revoked' THEN jsonb_typeof(facts->'grant_revoked') = 'boolean' ELSE true END),
      CONSTRAINT se_fact_user_deactivated CHECK (CASE WHEN facts ? 'user_deactivated' THEN jsonb_typeof(facts->'user_deactivated') = 'boolean' ELSE true END),
      CONSTRAINT se_fact_source_missing CHECK (CASE WHEN facts ? 'source_missing' THEN jsonb_typeof(facts->'source_missing') = 'boolean' ELSE true END),
      CONSTRAINT se_fact_count_unknown CHECK (CASE WHEN facts ? 'count_unknown' THEN jsonb_typeof(facts->'count_unknown') = 'boolean' ELSE true END),
      CONSTRAINT se_fact_sampled CHECK (CASE WHEN facts ? 'sampled' THEN jsonb_typeof(facts->'sampled') = 'boolean' ELSE true END),
      CONSTRAINT se_fact_truncated CHECK (CASE WHEN facts ? 'truncated' THEN jsonb_typeof(facts->'truncated') = 'boolean' ELSE true END),
      CONSTRAINT se_source_unique UNIQUE (producer, source_kind, source_id, source_step, event_type)
    )
  `.execute(db)
  await sql`CREATE INDEX se_org_time ON public.security_events (org_id, recorded_at DESC, id DESC) WHERE scope_kind = 'organization'`.execute(db)
  await sql`CREATE INDEX se_system_time ON public.security_events (recorded_at DESC, id DESC) WHERE scope_kind = 'system'`.execute(db)
  await sql`CREATE INDEX se_org_type_time ON public.security_events (org_id, event_type, recorded_at DESC, id DESC) WHERE scope_kind = 'organization'`.execute(db)
  await sql`CREATE INDEX se_system_type_time ON public.security_events (event_type, recorded_at DESC, id DESC) WHERE scope_kind = 'system'`.execute(db)
  await sql`CREATE INDEX se_expiry ON public.security_events (expires_at, id)`.execute(db)
  await sql`
    CREATE TABLE public.security_event_deliveries (
      id uuid PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES public.security_events(id) ON DELETE RESTRICT,
      channel text NOT NULL,
      route_ref text NOT NULL,
      attempt_no integer NOT NULL,
      status text NOT NULL,
      result_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      due_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz,
      lease_id uuid,
      lease_until timestamptz,
      retry_safety text NOT NULL,
      next_attempt_at timestamptz,
      expires_at timestamptz NOT NULL,
      CONSTRAINT sed_channel CHECK (channel IN ('none', 'legacy_directory_webhook', 'group_extension')),
      CONSTRAINT sed_channel_shape CHECK (CASE WHEN channel = 'none' THEN route_ref = 'none' AND status = 'skipped' WHEN channel = 'legacy_directory_webhook' THEN route_ref = 'legacy.directory_sync' AND attempt_no <= 1 AND status <> 'queued' ELSE true END),
      CONSTRAINT sed_route CHECK (char_length(route_ref) BETWEEN 1 AND 128 AND route_ref ~ '^[a-z_]+([.][a-z_]+)*$'),
      CONSTRAINT sed_attempt CHECK (attempt_no BETWEEN 0 AND 5),
      CONSTRAINT sed_status CHECK (status IN ('queued', 'sending', 'succeeded', 'failed', 'unknown', 'skipped')),
      CONSTRAINT sed_result CHECK (result_code IN ('channel_unconfigured', 'plugin_unavailable', 'source_not_eligible', 'transport_not_started', 'provider_rejected', 'send_outcome_unknown', 'legacy_sent_observed', 'legacy_outcome_unknown', 'attempt_limit', 'delivered')),
      CONSTRAINT sed_retry CHECK (retry_safety IN ('not_started', 'definitive_failure', 'unknown', 'not_applicable')),
      CONSTRAINT sed_times CHECK (isfinite(created_at) AND isfinite(due_at) AND isfinite(expires_at) AND expires_at > created_at AND due_at >= created_at AND (started_at IS NULL OR isfinite(started_at)) AND (finished_at IS NULL OR isfinite(finished_at)) AND (lease_until IS NULL OR isfinite(lease_until)) AND (next_attempt_at IS NULL OR isfinite(next_attempt_at))),
      CONSTRAINT sed_finish CHECK (CASE WHEN status IN ('queued', 'sending') THEN finished_at IS NULL AND result_code IS NULL ELSE finished_at IS NOT NULL AND finished_at >= created_at AND result_code IS NOT NULL END),
      CONSTRAINT sed_zero CHECK (CASE WHEN attempt_no = 0 THEN status = 'skipped' AND started_at IS NULL AND lease_id IS NULL AND lease_until IS NULL AND retry_safety = 'not_applicable' ELSE status <> 'skipped' OR started_at IS NULL END),
      CONSTRAINT sed_lease CHECK ((lease_id IS NULL) = (lease_until IS NULL) AND (lease_id IS NULL OR (started_at IS NOT NULL AND lease_until > started_at))),
      CONSTRAINT sed_sending CHECK (CASE WHEN status = 'sending' THEN attempt_no > 0 AND started_at IS NOT NULL AND lease_id IS NOT NULL AND lease_until > started_at AND retry_safety = 'unknown' ELSE true END),
      CONSTRAINT sed_queued CHECK (CASE WHEN status = 'queued' THEN attempt_no > 0 AND started_at IS NULL AND lease_id IS NULL AND retry_safety = 'not_started' ELSE true END),
      CONSTRAINT sed_success CHECK (CASE WHEN status = 'succeeded' THEN attempt_no > 0 AND started_at IS NOT NULL AND lease_id IS NOT NULL AND retry_safety = 'not_applicable' AND result_code = 'delivered' ELSE true END),
      CONSTRAINT sed_unknown CHECK (CASE WHEN status = 'unknown' THEN attempt_no > 0 AND started_at IS NOT NULL AND lease_id IS NOT NULL AND retry_safety = 'unknown' AND result_code = 'send_outcome_unknown' ELSE true END),
      CONSTRAINT sed_skipped CHECK (CASE WHEN status = 'skipped' THEN started_at IS NULL AND lease_id IS NULL AND retry_safety = 'not_applicable' AND result_code IN ('channel_unconfigured', 'plugin_unavailable', 'source_not_eligible', 'legacy_sent_observed', 'legacy_outcome_unknown', 'attempt_limit') ELSE true END),
      CONSTRAINT sed_failed CHECK (CASE WHEN status = 'failed' THEN attempt_no > 0 AND CASE WHEN retry_safety = 'not_started' THEN started_at IS NULL AND lease_id IS NULL AND result_code = 'transport_not_started' WHEN retry_safety = 'definitive_failure' THEN started_at IS NOT NULL AND lease_id IS NOT NULL AND result_code = 'provider_rejected' ELSE false END ELSE true END),
      CONSTRAINT sed_next CHECK (next_attempt_at IS NULL OR (status = 'failed' AND retry_safety IN ('not_started', 'definitive_failure') AND attempt_no < 5 AND next_attempt_at >= finished_at)),
      CONSTRAINT sed_order CHECK (started_at IS NULL OR (started_at >= created_at AND (finished_at IS NULL OR finished_at >= started_at))),
      CONSTRAINT sed_unique UNIQUE (event_id, channel, route_ref, attempt_no)
    )
  `.execute(db)
  await sql`CREATE UNIQUE INDEX sed_active ON public.security_event_deliveries (event_id, channel, route_ref) WHERE status IN ('queued', 'sending')`.execute(db)
  await sql`CREATE INDEX sed_queue ON public.security_event_deliveries (status, due_at)`.execute(db)
  await sql`CREATE INDEX sed_event_time ON public.security_event_deliveries (event_id, created_at, id)`.execute(db)
  await sql`CREATE INDEX sed_expiry ON public.security_event_deliveries (expires_at, id)`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!db.isTransaction) throw new Error('E1_MIGRATION_TRANSACTION_REQUIRED')
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  // The provider owns the maintenance gate and history. Locks close the empty-check race.
  await sql`LOCK TABLE public.security_events, public.security_event_deliveries IN ACCESS EXCLUSIVE MODE`.execute(db)
  const result = await sql<{ present: boolean }>`SELECT EXISTS (SELECT 1 FROM public.security_events) OR EXISTS (SELECT 1 FROM public.security_event_deliveries) AS present`.execute(db)
  if (result.rows[0]?.present !== false) {
    throw new Error('E1_DOWN_BLOCKED: retain schema; roll application forward or back using a verified compatible image containing this migration')
  }
  await sql`DROP TABLE public.security_event_deliveries`.execute(db)
  await sql`DROP TABLE public.security_events`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}
