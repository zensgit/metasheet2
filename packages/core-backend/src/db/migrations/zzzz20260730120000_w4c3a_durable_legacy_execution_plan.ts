/**
 * W4C-3a (#4556) -- durable legacy execution-plan storage.
 *
 * Authority: docs/development/attendance-issue-4556-w4c3a-durable-legacy-plan-amendment-20260729.md
 * at RATIFIED SHA e6c536fe7a201ca0466b2dc776b15fbdb23aa890.
 *
 * This is deliberately a database boundary. It creates no caller, worker, parser, or plugin
 * wiring: pre-cutover null-version jobs remain valid, while every new V1 job is admitted only
 * through the transaction-marked durable-plan enqueue seam and cannot be rewritten, reopened,
 * or truncated.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export const LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK = 500

const BRANCHES = [
  'strict_targeted',
  'operational_only_idempotent_replay',
  'operational_only_no_target',
  'operational_only_batch_limit',
] as const

const PLAN_FAILURE_REASONS = [
  'ATTENDANCE_IMPORT_LEGACY_PLAN_MISSING',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_VERSION_UNSUPPORTED',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_IDENTITY_MISMATCH',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED',
] as const

const MANIFEST_ROOT_KEYS = [
  'schemaVersion', 'orgId', 'jobId', 'batchId', 'sourceKind', 'sourceRef', 'createdBy',
  'actorId', 'actorPosture', 'tokenSubjectUserId', 'acceptedWritePosture',
  'identityProofVectorDigest', 'commandFingerprint', 'legacyInputFingerprint',
  'operationalBranch', 'legacyRowSourceKind', 'sourceRowCount', 'sourceOrdinalDigest',
  'rawEvidenceDigest',
  'w4ItemCount', 'w4DistinctTargetCount', 'w4ItemSequenceFingerprint',
  'w4ItemSetFingerprint', 'legacySourceRowLimit', 'groupRevision', 'groupStateFingerprint',
  'chunkVectorDigest', 'batch', 'artifactCleanup',
] as const

const SHA256 = '^[0-9a-f]{64}$'
const EMPTY_ITEM_SEQUENCE_FINGERPRINT = '94809bfff965ac75c18c3f0fb4f01081090a535d5de8dca93d7126e1267b6993'
const EMPTY_ITEM_SET_FINGERPRINT = 'b1fd18b44303a9d854528cd0acf09a6c9947d6893fff761b0713617a06faad69'
const EMPTY_CANONICAL_ARRAY_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'

function quoted(values: readonly string[]): string {
  return values.map((value) => "'" + value + "'").join(', ')
}

async function rejectExistingV1(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::integer AS count
    FROM attendance_import_jobs
    WHERE w4_contract_version = 1
  `.execute(db)
  if ((result.rows[0]?.count ?? 0) > 0) {
    throw new Error('W4C3A_UP_REFUSED_PREEXISTING_V1_IMPORT_JOB')
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // This must precede every DDL statement.  Inferring a closed plan from historical payload or
  // current state would silently violate the restart-freeze contract.
  await rejectExistingV1(db)

  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  for (const column of [
    'w4_legacy_plan_digest text',
    'w4_distinct_target_count integer',
    'w4_operational_branch text',
    'w4_legacy_input_fingerprint text',
  ]) {
    await sql.raw(`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS ${column}`).execute(db)
  }

  // Replace the predecessor's strictly-nonempty V1 proof shape as one atomic database contract.
  await sql`DROP TRIGGER IF EXISTS trg_aij_w4_guard ON attendance_import_jobs`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4_import_jobs_w4_guard()`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_shape`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_item_count`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_proof_vector`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_exec_reason`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_plan_columns`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4_job_proof_vector_valid(text, uuid, jsonb, integer)`.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_exact_object_keys(value jsonb, expected text[])
    RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $fn$
      SELECT jsonb_typeof(value) = 'object'
        AND (SELECT count(*) FROM jsonb_object_keys(value)) = cardinality(expected)
        AND value ?& expected
    $fn$
  `.execute(db)

  // OD-W4C-58=(a) + OD-W4C-60=(a): nested closed leaves enforced at the DB boundary.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_uuid_text(value text)
    RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $fn$
      SELECT value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_group_effect_valid(effect jsonb)
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $fn$
    BEGIN
      IF jsonb_typeof(effect) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      IF effect ->> 'kind' = 'ensure_group' THEN
        RETURN attendance_w4c3a_exact_object_keys(
            effect,
            ARRAY['kind', 'groupId', 'normalizedName', 'displayName', 'code',
              'timezone', 'ruleSetId', 'groupExistedAtPrepare']
          )
          AND attendance_w4c3a_uuid_text(effect ->> 'groupId')
          AND jsonb_typeof(effect -> 'normalizedName') = 'string'
          AND length(effect ->> 'normalizedName') > 0
          AND jsonb_typeof(effect -> 'displayName') = 'string'
          AND length(effect ->> 'displayName') > 0
          AND jsonb_typeof(effect -> 'groupExistedAtPrepare') = 'boolean'
          AND (effect -> 'code' IS NULL OR jsonb_typeof(effect -> 'code') IN ('string', 'null'))
          AND jsonb_typeof(effect -> 'timezone') = 'string'
          AND (
            effect -> 'ruleSetId' IS NULL
            OR jsonb_typeof(effect -> 'ruleSetId') = 'null'
            OR attendance_w4c3a_uuid_text(effect ->> 'ruleSetId')
          );
      END IF;
      IF effect ->> 'kind' = 'ensure_member' THEN
        RETURN attendance_w4c3a_exact_object_keys(
            effect,
            ARRAY['kind', 'memberId', 'groupRef', 'userId', 'membershipExistedAtPrepare']
          )
          AND attendance_w4c3a_uuid_text(effect ->> 'memberId')
          AND attendance_w4c3a_uuid_text(effect ->> 'groupRef')
          AND jsonb_typeof(effect -> 'userId') = 'string'
          AND length(effect ->> 'userId') > 0
          AND jsonb_typeof(effect -> 'membershipExistedAtPrepare') = 'boolean';
      END IF;
      RETURN false;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_batch_plan_valid(batch jsonb)
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $fn$
    DECLARE
      item_return jsonb;
      skipped jsonb;
      slots jsonb;
      lim numeric;
    BEGIN
      IF jsonb_typeof(batch) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      IF batch ->> 'kind' = 'idempotent_replay' THEN
        RETURN true;
      END IF;
      IF batch ->> 'kind' IS DISTINCT FROM 'normal' THEN RETURN false; END IF;
      item_return := batch -> 'itemReturnPolicy';
      skipped := batch -> 'skippedSamplePolicy';
      slots := batch -> 'resultSlots';
      IF NOT attendance_w4c3a_exact_object_keys(item_return, ARRAY['returnItems', 'itemsLimit']) OR
         jsonb_typeof(item_return -> 'returnItems') IS DISTINCT FROM 'boolean' OR
         (item_return ->> 'returnItems') IS DISTINCT FROM 'false' OR
         jsonb_typeof(item_return -> 'itemsLimit') IS DISTINCT FROM 'null' THEN
        RETURN false;
      END IF;
      IF NOT attendance_w4c3a_exact_object_keys(skipped, ARRAY['limit']) OR
         jsonb_typeof(skipped -> 'limit') IS DISTINCT FROM 'number' OR
         (skipped ->> 'limit') !~ '^(0|[1-9][0-9]*)$' THEN
        RETURN false;
      END IF;
      lim := (skipped ->> 'limit')::numeric;
      IF lim < 0 OR lim > 500 OR lim <> trunc(lim) THEN RETURN false; END IF;
      IF NOT attendance_w4c3a_exact_object_keys(slots, ARRAY['groupCreated', 'groupMembersAdded']) OR
         slots ->> 'groupCreated' IS DISTINCT FROM 'ensure_group_returned_row_count' OR
         slots ->> 'groupMembersAdded' IS DISTINCT FROM 'ensure_member_inserted_row_count' THEN
        RETURN false;
      END IF;
      RETURN true;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_record_write_slots_valid(record_write jsonb)
    RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $fn$
      SELECT jsonb_typeof(record_write) = 'object'
        AND record_write ? 'resultSlots'
        AND attendance_w4c3a_exact_object_keys(record_write -> 'resultSlots', ARRAY[]::text[])
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_presence_valid(
      value jsonb,
      allowed_value_types text[],
      non_negative_integer boolean DEFAULT false
    )
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $fn$
    DECLARE
      value_type text;
      numeric_value numeric;
    BEGIN
      IF NOT attendance_w4c3a_exact_object_keys(value, ARRAY['present', 'value']) OR
         jsonb_typeof(value -> 'present') IS DISTINCT FROM 'boolean' THEN
        RETURN false;
      END IF;
      IF (value ->> 'present') = 'false' THEN
        RETURN jsonb_typeof(value -> 'value') = 'null';
      END IF;
      value_type := jsonb_typeof(value -> 'value');
      IF value_type IS NULL OR NOT (value_type = ANY(allowed_value_types)) THEN
        RETURN false;
      END IF;
      IF non_negative_integer AND value_type = 'number' THEN
        numeric_value := (value ->> 'value')::numeric;
        IF numeric_value < 0 OR numeric_value <> trunc(numeric_value) OR numeric_value > 2147483647 THEN
          RETURN false;
        END IF;
      END IF;
      RETURN true;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_raw_import_evidence_valid(value jsonb)
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $fn$
    DECLARE
      fields jsonb;
      metrics jsonb;
      provenance jsonb;
      punch jsonb;
      transport text;
      check_in_count integer := 0;
      check_out_count integer := 0;
      check_in_ordinal integer := 0;
      check_out_ordinal integer := 0;
      punch_ordinal integer := 0;
    BEGIN
      IF NOT attendance_w4c3a_exact_object_keys(
        value,
        ARRAY['schemaVersion', 'sourceOrdinal', 'punches', 'fields', 'metrics', 'provenance']
      ) OR value ->> 'schemaVersion' IS DISTINCT FROM '1' OR
         jsonb_typeof(value -> 'sourceOrdinal') IS DISTINCT FROM 'number' OR
         (value ->> 'sourceOrdinal') !~ '^(0|[1-9][0-9]*)$' OR
         (value ->> 'sourceOrdinal')::numeric > 2147483647 OR
         jsonb_typeof(value -> 'punches') IS DISTINCT FROM 'array' OR
         jsonb_array_length(value -> 'punches') > 2 THEN
        RETURN false;
      END IF;

      fields := value -> 'fields';
      metrics := value -> 'metrics';
      provenance := value -> 'provenance';
      IF NOT attendance_w4c3a_exact_object_keys(
        fields,
        ARRAY['userId', 'workDate', 'timezone', 'firstInAt', 'lastOutAt', 'status', 'isWorkday']
      ) OR NOT attendance_w4c3a_exact_object_keys(
        metrics,
        ARRAY['workMinutes', 'lateMinutes', 'earlyLeaveMinutes']
      ) THEN
        RETURN false;
      END IF;
      IF NOT attendance_w4c3a_presence_valid(fields -> 'userId', ARRAY['string', 'null']) OR
         NOT attendance_w4c3a_presence_valid(fields -> 'workDate', ARRAY['string', 'null']) OR
         NOT attendance_w4c3a_presence_valid(fields -> 'timezone', ARRAY['string', 'null']) OR
         NOT attendance_w4c3a_presence_valid(fields -> 'firstInAt', ARRAY['string', 'null']) OR
         NOT attendance_w4c3a_presence_valid(fields -> 'lastOutAt', ARRAY['string', 'null']) OR
         NOT attendance_w4c3a_presence_valid(fields -> 'status', ARRAY['string', 'null']) OR
         NOT attendance_w4c3a_presence_valid(fields -> 'isWorkday', ARRAY['boolean', 'null']) OR
         NOT attendance_w4c3a_presence_valid(metrics -> 'workMinutes', ARRAY['number', 'null'], true) OR
         NOT attendance_w4c3a_presence_valid(metrics -> 'lateMinutes', ARRAY['number', 'null'], true) OR
         NOT attendance_w4c3a_presence_valid(metrics -> 'earlyLeaveMinutes', ARRAY['number', 'null'], true) THEN
        RETURN false;
      END IF;
      IF (jsonb_typeof(fields -> 'firstInAt' -> 'value') = 'string' AND
          (fields -> 'firstInAt' ->> 'value') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$') OR
         (jsonb_typeof(fields -> 'lastOutAt' -> 'value') = 'string' AND
          (fields -> 'lastOutAt' ->> 'value') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$') THEN
        RETURN false;
      END IF;

      IF NOT attendance_w4c3a_exact_object_keys(
        provenance,
        ARRAY['transport', 'sourceRef', 'artifactSha256', 'normalizedCsvSha256', 'convertedSheetName']
      ) OR jsonb_typeof(provenance -> 'transport') IS DISTINCT FROM 'string' OR
         jsonb_typeof(provenance -> 'sourceRef') IS DISTINCT FROM 'string' OR
         length(provenance ->> 'sourceRef') = 0 THEN
        RETURN false;
      END IF;
      transport := provenance ->> 'transport';
      IF transport NOT IN ('live_event', 'rows', 'csv_text', 'csv_upload', 'xlsx_client_converted_csv',
        'integration_sync', 'approved_request', 'scheduled_job', 'recompute', 'approval_reversal',
        'import_rollback', 'operator_retirement', 'legacy_baseline_capture') THEN
        RETURN false;
      END IF;
      IF transport IN ('csv_upload', 'xlsx_client_converted_csv') THEN
        IF (provenance ->> 'artifactSha256') !~ '${sql.raw(SHA256)}' THEN RETURN false; END IF;
      ELSIF jsonb_typeof(provenance -> 'artifactSha256') IS DISTINCT FROM 'null' THEN
        RETURN false;
      END IF;
      IF transport IN ('csv_text', 'csv_upload', 'xlsx_client_converted_csv') THEN
        IF (provenance ->> 'normalizedCsvSha256') !~ '${sql.raw(SHA256)}' THEN RETURN false; END IF;
      ELSIF jsonb_typeof(provenance -> 'normalizedCsvSha256') IS DISTINCT FROM 'null' THEN
        RETURN false;
      END IF;
      IF transport = 'xlsx_client_converted_csv' THEN
        IF jsonb_typeof(provenance -> 'convertedSheetName') IS DISTINCT FROM 'string' OR
           length(provenance ->> 'convertedSheetName') = 0 THEN RETURN false; END IF;
      ELSIF jsonb_typeof(provenance -> 'convertedSheetName') IS DISTINCT FROM 'null' THEN
        RETURN false;
      END IF;

      FOR punch, punch_ordinal IN
        SELECT entry.value, entry.ordinality::integer
          FROM jsonb_array_elements(value -> 'punches') WITH ORDINALITY AS entry(value, ordinality)
      LOOP
        IF NOT attendance_w4c3a_exact_object_keys(punch, ARRAY['direction', 'occurredAt']) OR
           punch ->> 'direction' NOT IN ('check_in', 'check_out') OR
           (punch ->> 'occurredAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' THEN
          RETURN false;
        END IF;
        IF punch ->> 'direction' = 'check_in' THEN
          check_in_count := check_in_count + 1;
          IF check_in_count > 1 THEN RETURN false; END IF;
          IF punch ->> 'occurredAt' IS DISTINCT FROM fields -> 'firstInAt' ->> 'value' THEN RETURN false; END IF;
          check_in_ordinal := punch_ordinal;
        ELSE
          check_out_count := check_out_count + 1;
          IF check_out_count > 1 THEN RETURN false; END IF;
          IF punch ->> 'occurredAt' IS DISTINCT FROM fields -> 'lastOutAt' ->> 'value' THEN RETURN false; END IF;
          check_out_ordinal := punch_ordinal;
        END IF;
      END LOOP;
      IF check_in_count IS DISTINCT FROM (CASE WHEN fields -> 'firstInAt' ->> 'present' = 'true' AND jsonb_typeof(fields -> 'firstInAt' -> 'value') = 'string' THEN 1 ELSE 0 END) OR
         check_out_count IS DISTINCT FROM (CASE WHEN fields -> 'lastOutAt' ->> 'present' = 'true' AND jsonb_typeof(fields -> 'lastOutAt' -> 'value') = 'string' THEN 1 ELSE 0 END) OR
         (check_in_count = 1 AND check_out_count = 1 AND check_in_ordinal >= check_out_ordinal) THEN
        RETURN false;
      END IF;
      RETURN true;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_chunk_body_valid(chunk jsonb)
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $fn$
    DECLARE
      effect jsonb;
      record_write jsonb;
      item jsonb;
    BEGIN
      IF NOT attendance_w4c3a_exact_object_keys(chunk, ARRAY['items', 'recordWrites', 'groupEffects']) THEN
        RETURN false;
      END IF;
      IF jsonb_typeof(chunk -> 'groupEffects') IS DISTINCT FROM 'array' OR
         jsonb_typeof(chunk -> 'recordWrites') IS DISTINCT FROM 'array' OR
         jsonb_typeof(chunk -> 'items') IS DISTINCT FROM 'array' THEN
        RETURN false;
      END IF;
      FOR effect IN SELECT value FROM jsonb_array_elements(chunk -> 'groupEffects') AS t(value)
      LOOP
        IF NOT attendance_w4c3a_group_effect_valid(effect) THEN RETURN false; END IF;
      END LOOP;
      FOR record_write IN SELECT value FROM jsonb_array_elements(chunk -> 'recordWrites') AS t(value)
      LOOP
        IF NOT attendance_w4c3a_record_write_slots_valid(record_write) THEN RETURN false; END IF;
      END LOOP;
      FOR item IN SELECT value FROM jsonb_array_elements(chunk -> 'items') AS t(value)
      LOOP
        IF item ->> 'kind' = 'apply' THEN
          IF NOT attendance_w4c3a_exact_object_keys(
            item,
            ARRAY['kind', 'ordinal', 'semanticOrdinal', 'itemId', 'targetRef',
              'previewSnapshot', 'recordWriteRef', 'rawEvidence']
          ) THEN RETURN false; END IF;
        ELSIF item ->> 'kind' = 'skip' THEN
          IF NOT attendance_w4c3a_exact_object_keys(
            item,
            ARRAY['kind', 'ordinal', 'semanticOrdinal', 'itemId', 'resolvedUserId',
              'resolvedWorkDate', 'reasonCode', 'warnings', 'previewSnapshot', 'rawEvidence']
          ) THEN RETURN false; END IF;
        ELSE
          RETURN false;
        END IF;
        IF NOT attendance_w4c3a_raw_import_evidence_valid(item -> 'rawEvidence') OR
           item ->> 'ordinal' IS DISTINCT FROM item -> 'rawEvidence' ->> 'sourceOrdinal' THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_async_job_summary_valid(value jsonb)
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT
    AS $fn$
    DECLARE
      summary jsonb;
    BEGIN
      IF NOT attendance_w4c3a_exact_object_keys(
        value,
        ARRAY['__jobType', 'idempotencyKey', '__importEngine',
          'recordUpsertStrategy', 'itemsInsertStrategy', 'summary']
      ) OR value ->> '__jobType' IS DISTINCT FROM 'commit' OR
        jsonb_typeof(value -> 'idempotencyKey') NOT IN ('null', 'string') OR
        value ->> '__importEngine' NOT IN ('standard', 'bulk') OR
        value ->> 'recordUpsertStrategy' NOT IN ('values', 'unnest', 'staging') OR
        value ->> 'itemsInsertStrategy' NOT IN ('values', 'unnest', 'staging') THEN
        RETURN false;
      END IF;
      summary := value -> 'summary';
      IF jsonb_typeof(summary) IS DISTINCT FROM 'object' OR
        NOT (summary ?& ARRAY['chunkConfig', 'elapsedMs', 'failedRows', 'processedRows']) OR
        EXISTS (
          SELECT 1 FROM jsonb_object_keys(summary) AS key
          WHERE key NOT IN ('chunkConfig', 'elapsedMs', 'failedRows',
            'processedRows', 'skippedCount', 'skippedRows')
        ) THEN
        RETURN false;
      END IF;
      IF jsonb_typeof(summary -> 'processedRows') IS DISTINCT FROM 'number' OR
        (summary ->> 'processedRows') !~ '^(0|[1-9][0-9]*)$' OR
        (summary ->> 'processedRows')::numeric > 2147483647 OR
        jsonb_typeof(summary -> 'failedRows') IS DISTINCT FROM 'number' OR
        (summary ->> 'failedRows') !~ '^(0|[1-9][0-9]*)$' OR
        (summary ->> 'failedRows')::numeric > 2147483647 OR
        jsonb_typeof(summary -> 'elapsedMs') IS DISTINCT FROM 'number' OR
        (summary ->> 'elapsedMs') !~ '^(0|[1-9][0-9]*)$' OR
        (summary ->> 'elapsedMs')::numeric > 2147483647 THEN
        RETURN false;
      END IF;
      IF summary ? 'skippedCount' AND (
        jsonb_typeof(summary -> 'skippedCount') IS DISTINCT FROM 'number' OR
        (summary ->> 'skippedCount') !~ '^[1-9][0-9]*$' OR
        (summary ->> 'skippedCount')::numeric > 2147483647
      ) THEN
        RETURN false;
      END IF;
      IF summary ? 'skippedRows' AND (
        jsonb_typeof(summary -> 'skippedRows') IS DISTINCT FROM 'array' OR
        jsonb_array_length(summary -> 'skippedRows') < 1
      ) THEN
        RETURN false;
      END IF;
      RETURN true;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_job_proof_vector_valid(
      source_kind text,
      root uuid,
      vector jsonb,
      item_count integer,
      operational_branch text,
      distinct_target_count integer
    ) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $fn$
    DECLARE
      namespace_id uuid;
      i integer;
      entry jsonb;
    BEGIN
      IF source_kind = 'import_batch' THEN
        namespace_id := '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'::uuid;
      ELSIF source_kind = 'integration_batch' THEN
        namespace_id := '46501375-c273-459f-a5af-f926859f6411'::uuid;
      ELSE
        RETURN false;
      END IF;
      IF root IS NULL OR vector IS NULL OR item_count IS NULL OR distinct_target_count IS NULL OR
         jsonb_typeof(vector) IS DISTINCT FROM 'array' THEN
        RETURN false;
      END IF;
      IF operational_branch IN ('operational_only_idempotent_replay', 'operational_only_no_target') THEN
        RETURN item_count = 0 AND distinct_target_count = 0 AND vector = '[]'::jsonb;
      END IF;
      IF operational_branch = 'operational_only_batch_limit' THEN
        RETURN item_count >= 1 AND distinct_target_count >= 1 AND distinct_target_count <= item_count AND
          (item_count > 5000 OR distinct_target_count > 5000) AND vector = '[]'::jsonb;
      END IF;
      IF operational_branch IS DISTINCT FROM 'strict_targeted' OR item_count < 1 OR item_count > 5000 OR
         distinct_target_count < 1 OR distinct_target_count > 5000 OR distinct_target_count > item_count OR
         jsonb_array_length(vector) <> item_count THEN
        RETURN false;
      END IF;
      FOR i IN 0..item_count - 1 LOOP
        entry := vector -> i;
        IF NOT attendance_w4c3a_exact_object_keys(entry, ARRAY['ordinal', 'semanticFingerprint', 'derivedOperationId', 'commandFingerprint']) OR
           jsonb_typeof(entry -> 'ordinal') IS DISTINCT FROM 'number' OR (entry ->> 'ordinal') IS DISTINCT FROM i::text OR
           jsonb_typeof(entry -> 'semanticFingerprint') IS DISTINCT FROM 'string' OR
           jsonb_typeof(entry -> 'derivedOperationId') IS DISTINCT FROM 'string' OR
           jsonb_typeof(entry -> 'commandFingerprint') IS DISTINCT FROM 'string' OR
           (entry ->> 'semanticFingerprint') !~ '${sql.raw(SHA256)}' OR
           (entry ->> 'commandFingerprint') !~ '${sql.raw(SHA256)}' OR
           (entry ->> 'derivedOperationId') IS DISTINCT FROM attendance_w4_uuidv5(
             namespace_id, attendance_w4_item_name_bytes(root, i, entry ->> 'semanticFingerprint')
           )::text THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_import_legacy_execution_plans (
      job_id uuid PRIMARY KEY REFERENCES attendance_import_jobs(id) ON DELETE RESTRICT,
      org_id text NOT NULL,
      batch_id uuid NOT NULL,
      plan_version integer NOT NULL CHECK (plan_version = 1),
      plan_digest text NOT NULL CHECK (plan_digest ~ '${sql.raw(SHA256)}'),
      chunk_vector_digest text NOT NULL CHECK (chunk_vector_digest ~ '${sql.raw(SHA256)}'),
      source_kind text NOT NULL CHECK (source_kind = 'import_batch'),
      source_ref text NOT NULL,
      created_by text NOT NULL,
      actor_id text NOT NULL,
      actor_posture text NOT NULL,
      token_subject_user_id text,
      accepted_write_posture text NOT NULL CHECK (accepted_write_posture IN ('legacy_projection_only', 'shadow', 'authoritative')),
      identity_proof_vector_digest text NOT NULL CHECK (identity_proof_vector_digest ~ '${sql.raw(SHA256)}'),
      command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '${sql.raw(SHA256)}'),
      legacy_input_fingerprint text NOT NULL CHECK (legacy_input_fingerprint ~ '${sql.raw(SHA256)}'),
      operational_branch text NOT NULL CHECK (operational_branch IN (${sql.raw(quoted(BRANCHES))})),
      legacy_row_source_kind text,
      legacy_source_row_limit bigint,
      source_row_count integer NOT NULL CHECK (source_row_count >= 0),
      source_ordinal_digest text NOT NULL CHECK (source_ordinal_digest ~ '${sql.raw(SHA256)}'),
      w4_item_count integer NOT NULL CHECK (w4_item_count >= 0),
      w4_distinct_target_count integer NOT NULL CHECK (w4_distinct_target_count >= 0 AND w4_distinct_target_count <= w4_item_count),
      CHECK (w4_item_count <= source_row_count),
      w4_item_sequence_fingerprint text NOT NULL CHECK (w4_item_sequence_fingerprint ~ '${sql.raw(SHA256)}'),
      w4_item_set_fingerprint text NOT NULL CHECK (w4_item_set_fingerprint ~ '${sql.raw(SHA256)}'),
      group_revision bigint,
      group_state_fingerprint text,
      chunk_count integer NOT NULL CHECK (chunk_count >= 0),
      manifest jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (group_revision IS NULL OR group_revision >= 0),
      CHECK (
        (operational_branch = 'operational_only_idempotent_replay' AND source_row_count = 0 AND chunk_count = 0) OR
        (operational_branch <> 'operational_only_idempotent_replay' AND source_row_count > 0 AND chunk_count > 0)
      ),
      CHECK (
        (legacy_row_source_kind IN ('uploaded_csv', 'inline_csv') AND legacy_source_row_limit > 0) OR
        (legacy_row_source_kind IN ('direct_rows', 'entries', 'dingtalk_tabular') AND legacy_source_row_limit IS NULL) OR
        (legacy_row_source_kind IS NULL AND operational_branch = 'operational_only_idempotent_replay')
      ),
      CHECK ((group_revision IS NULL) = (group_state_fingerprint IS NULL)),
      CHECK (group_state_fingerprint IS NULL OR group_state_fingerprint ~ '${sql.raw(SHA256)}')
    )
  `.execute(db)
  // OD-W4C-60=(a): batch policy/result-slot leaves are validated IMMEDIATELY on
  // plan INSERT/UPDATE under ordinary role — not only on deferred commit congruence.
  await sql`
    ALTER TABLE attendance_import_legacy_execution_plans
      DROP CONSTRAINT IF EXISTS chk_ailep_manifest_keys
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_legacy_execution_plans
      DROP CONSTRAINT IF EXISTS chk_ailep_manifest_batch_slots
  `.execute(db)
  await sql`
    DO $body$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'attendance_import_legacy_execution_plans'
           AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) ILIKE '%exact_object_keys%manifest%'
      LOOP
        EXECUTE format(
          'ALTER TABLE attendance_import_legacy_execution_plans DROP CONSTRAINT %I',
          r.conname
        );
      END LOOP;
    END
    $body$
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_legacy_execution_plans
      ADD CONSTRAINT chk_ailep_manifest_keys
      CHECK (
        attendance_w4c3a_exact_object_keys(
          manifest,
          ARRAY[${sql.raw(MANIFEST_ROOT_KEYS.map((key) => "'" + key + "'").join(', '))}]
        )
      )
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_legacy_execution_plans
      ADD CONSTRAINT chk_ailep_manifest_batch_slots
      CHECK (attendance_w4c3a_batch_plan_valid(manifest -> 'batch'))
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_import_legacy_execution_plan_chunks (
      job_id uuid NOT NULL REFERENCES attendance_import_legacy_execution_plans(job_id) ON DELETE RESTRICT,
      chunk_index integer NOT NULL CHECK (chunk_index >= 0),
      first_source_ordinal integer NOT NULL CHECK (first_source_ordinal >= 0),
      source_row_count integer NOT NULL CHECK (source_row_count BETWEEN 1 AND ${sql.lit(LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK)}),
      chunk_digest text NOT NULL CHECK (chunk_digest ~ '${sql.raw(SHA256)}'),
      chunk jsonb NOT NULL,
      PRIMARY KEY (job_id, chunk_index)
    )
  `.execute(db)
  // OD-W4C-58/60: re-bind nested chunk validation even when the table already
  // existed from an earlier W4C-3a migration revision.
  await sql`
    DO $body$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'attendance_import_legacy_execution_plan_chunks'
           AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) ILIKE '%chunk%'
           AND pg_get_constraintdef(c.oid) ILIKE '%exact_object_keys%'
      LOOP
        EXECUTE format(
          'ALTER TABLE attendance_import_legacy_execution_plan_chunks DROP CONSTRAINT %I',
          r.conname
        );
      END LOOP;
    END
    $body$
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_legacy_execution_plan_chunks
      DROP CONSTRAINT IF EXISTS chk_ailepc_chunk_body
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_legacy_execution_plan_chunks
      ADD CONSTRAINT chk_ailepc_chunk_body
      CHECK (attendance_w4c3a_chunk_body_valid(chunk))
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_import_legacy_terminal_responses (
      job_id uuid PRIMARY KEY REFERENCES attendance_import_jobs(id) ON DELETE RESTRICT,
      org_id text NOT NULL,
      response_variant text NOT NULL CHECK (response_variant IN ('first_execution', 'idempotent_early', 'idempotent_in_transaction')),
      response_digest text NOT NULL CHECK (response_digest ~ '${sql.raw(SHA256)}'),
      response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_ailtr_response_shape CHECK (
        attendance_w4c3a_async_job_summary_valid(response)
      )
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_import_upload_cleanup_commands (
      job_id uuid PRIMARY KEY REFERENCES attendance_import_jobs(id) ON DELETE RESTRICT,
      org_id text NOT NULL,
      file_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed_retryable')),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      claim_token uuid,
      lease_expires_at timestamptz,
      last_error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((status = 'processing') = (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
      CHECK (status <> 'failed_retryable' OR last_error_code IS NOT NULL),
      CHECK (status = 'failed_retryable' OR last_error_code IS NULL),
      CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,127}$')
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_record_target_revisions (
      org_id text NOT NULL,
      user_id text NOT NULL,
      work_date date NOT NULL,
      revision bigint NOT NULL CHECK (revision >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, user_id, work_date)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_group_effect_revisions (
      org_id text PRIMARY KEY,
      revision bigint NOT NULL CHECK (revision >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  // Physical history is append-only.  Cleanup is deliberately the sole exception and uses a
  // narrow claim/complete/retry CAS machine below.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_reject_w4_import_history_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'W4C3A_HISTORY_IMMUTABLE: % on % is not permitted', TG_OP, TG_TABLE_NAME;
    END
    $fn$
  `.execute(db)
  for (const table of [
    'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_execution_plan_chunks',
    'attendance_import_legacy_terminal_responses',
  ]) {
    await sql.raw(`DROP TRIGGER IF EXISTS trg_${table}_immutable ON ${table}`).execute(db)
    await sql.raw(`CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION attendance_reject_w4_import_history_mutation()`).execute(db)
  }

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_cleanup_cas_guard()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'W4C3A_CLEANUP_DELETE_DENIED';
      END IF;
      IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR
         NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'W4C3A_CLEANUP_IDENTITY_IMMUTABLE';
      END IF;
      IF coalesce(current_setting('attendance.w4c3a_cleanup_claim_token', true), '') = '' THEN
        RAISE EXCEPTION 'W4C3A_CLEANUP_DIRECT_UPDATE_DENIED';
      END IF;
      IF (
        OLD.status IN ('pending', 'failed_retryable') AND NEW.status = 'processing' AND
        NEW.attempt_count = OLD.attempt_count + 1 AND NEW.claim_token IS NOT NULL AND NEW.lease_expires_at IS NOT NULL AND
        NEW.last_error_code IS NULL AND NEW.claim_token::text = current_setting('attendance.w4c3a_cleanup_claim_token', true)
      ) OR (
        OLD.status = 'processing' AND OLD.lease_expires_at <= now() AND NEW.status = 'processing' AND
        NEW.attempt_count = OLD.attempt_count + 1 AND NEW.claim_token IS NOT NULL AND NEW.claim_token IS DISTINCT FROM OLD.claim_token AND
        NEW.lease_expires_at IS NOT NULL AND NEW.last_error_code IS NULL AND
        NEW.claim_token::text = current_setting('attendance.w4c3a_cleanup_claim_token', true)
      ) OR (
        OLD.status = 'processing' AND NEW.status = 'completed' AND NEW.claim_token IS NULL AND NEW.lease_expires_at IS NULL AND
        NEW.last_error_code IS NULL AND OLD.claim_token::text = current_setting('attendance.w4c3a_cleanup_claim_token', true)
      ) OR (
        OLD.status = 'processing' AND NEW.status = 'failed_retryable' AND NEW.claim_token IS NULL AND NEW.lease_expires_at IS NULL AND
        NEW.last_error_code IS NOT NULL AND OLD.claim_token::text = current_setting('attendance.w4c3a_cleanup_claim_token', true)
      ) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'W4C3A_CLEANUP_CAS_DENIED';
    END
    $fn$
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_aiucc_cas ON attendance_import_upload_cleanup_commands`.execute(db)
  await sql`
    CREATE TRIGGER trg_aiucc_cas
      BEFORE UPDATE OR DELETE ON attendance_import_upload_cleanup_commands
      FOR EACH ROW EXECUTE FUNCTION attendance_w4c3a_cleanup_cas_guard()
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_claim_import_upload_cleanup_command(
      p_job_id uuid, p_claim_token uuid, p_lease_expires_at timestamptz
    ) RETURNS boolean LANGUAGE plpgsql AS $fn$
    DECLARE command attendance_import_upload_cleanup_commands%ROWTYPE;
    BEGIN
      IF p_claim_token IS NULL OR p_lease_expires_at IS NULL OR p_lease_expires_at <= now() THEN
        RAISE EXCEPTION 'W4C3A_CLEANUP_CLAIM_ARGUMENT_DENIED';
      END IF;
      SELECT * INTO command FROM attendance_import_upload_cleanup_commands
      WHERE job_id = p_job_id AND (status IN ('pending', 'failed_retryable') OR (status = 'processing' AND lease_expires_at <= now()))
      FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN RETURN false; END IF;
      PERFORM set_config('attendance.w4c3a_cleanup_claim_token', p_claim_token::text, true);
      UPDATE attendance_import_upload_cleanup_commands
      SET status = 'processing', attempt_count = command.attempt_count + 1, claim_token = p_claim_token,
          lease_expires_at = p_lease_expires_at, last_error_code = NULL, updated_at = now()
      WHERE job_id = p_job_id;
      RETURN true;
    END
    $fn$
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_finish_import_upload_cleanup_command(
      p_job_id uuid, p_claim_token uuid, p_status text, p_last_error_code text DEFAULT NULL
    ) RETURNS boolean LANGUAGE plpgsql AS $fn$
    BEGIN
      IF p_status NOT IN ('completed', 'failed_retryable') OR p_claim_token IS NULL OR
         (p_status = 'completed' AND p_last_error_code IS NOT NULL) OR
         (p_status = 'failed_retryable' AND (p_last_error_code IS NULL OR p_last_error_code !~ '^[A-Z][A-Z0-9_]{0,127}$')) THEN
        RAISE EXCEPTION 'W4C3A_CLEANUP_FINISH_ARGUMENT_DENIED';
      END IF;
      PERFORM set_config('attendance.w4c3a_cleanup_claim_token', p_claim_token::text, true);
      UPDATE attendance_import_upload_cleanup_commands
      SET status = p_status, claim_token = NULL, lease_expires_at = NULL, last_error_code = p_last_error_code, updated_at = now()
      WHERE job_id = p_job_id AND status = 'processing' AND claim_token = p_claim_token;
      RETURN FOUND;
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_revision_row_guard()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.revision = 0 THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'W4C3A_REVISION_DIRECT_MUTATION_DENIED';
      END IF;
      IF TG_OP IN ('UPDATE', 'DELETE') AND pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'W4C3A_REVISION_DIRECT_MUTATION_DENIED';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_bump_record_target_revision()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE target_org text; target_user text; target_date date;
    BEGIN
      IF TG_OP = 'UPDATE' AND (NEW.org_id, NEW.user_id, NEW.work_date) IS DISTINCT FROM (OLD.org_id, OLD.user_id, OLD.work_date) THEN
        RAISE EXCEPTION 'W4C3A_RECORD_TARGET_MOVE_DENIED';
      END IF;
      target_org := COALESCE(NEW.org_id, OLD.org_id);
      target_user := COALESCE(NEW.user_id, OLD.user_id);
      target_date := COALESCE(NEW.work_date, OLD.work_date);
      INSERT INTO attendance_record_target_revisions (org_id, user_id, work_date, revision)
      VALUES (target_org, target_user, target_date, 0)
      ON CONFLICT (org_id, user_id, work_date) DO NOTHING;
      UPDATE attendance_record_target_revisions
      SET revision = revision + 1, updated_at = now()
      WHERE org_id = target_org AND user_id = target_user AND work_date = target_date;
      RETURN COALESCE(NEW, OLD);
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_bump_group_effect_revision()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE target_org text;
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.org_id IS DISTINCT FROM OLD.org_id THEN
        RAISE EXCEPTION 'W4C3A_GROUP_ORG_MOVE_DENIED';
      END IF;
      target_org := COALESCE(NEW.org_id, OLD.org_id);
      INSERT INTO attendance_group_effect_revisions (org_id, revision) VALUES (target_org, 0)
      ON CONFLICT (org_id) DO NOTHING;
      UPDATE attendance_group_effect_revisions SET revision = revision + 1, updated_at = now() WHERE org_id = target_org;
      RETURN COALESCE(NEW, OLD);
    END
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_deny_truncate()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'W4C3A_TRUNCATE_DENIED: %', TG_TABLE_NAME;
    END
    $fn$
  `.execute(db)

  // Backfill occurs before guards are installed, so a historic row begins at one rather than
  // receiving an artificial mutation increment.
  await sql`
    INSERT INTO attendance_record_target_revisions (org_id, user_id, work_date, revision)
    SELECT org_id, user_id, work_date, 1 FROM attendance_records
    ON CONFLICT (org_id, user_id, work_date) DO NOTHING
  `.execute(db)
  await sql`
    INSERT INTO attendance_group_effect_revisions (org_id, revision)
    SELECT org_id, 1 FROM (
      SELECT DISTINCT org_id FROM attendance_groups
      UNION
      SELECT DISTINCT org_id FROM attendance_group_members
    ) group_orgs
    ON CONFLICT (org_id) DO NOTHING
  `.execute(db)

  for (const table of ['attendance_record_target_revisions', 'attendance_group_effect_revisions']) {
    await sql.raw(`DROP TRIGGER IF EXISTS trg_${table}_direct_guard ON ${table}`).execute(db)
    await sql.raw(`CREATE TRIGGER trg_${table}_direct_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION attendance_w4c3a_revision_row_guard()`).execute(db)
  }
  for (const table of ['attendance_records', 'attendance_groups', 'attendance_group_members']) {
    const functionName = table === 'attendance_records' ? 'attendance_bump_record_target_revision' : 'attendance_bump_group_effect_revision'
    await sql.raw(`DROP TRIGGER IF EXISTS trg_${table}_w4c3a_revision ON ${table}`).execute(db)
    await sql.raw(`CREATE TRIGGER trg_${table}_w4c3a_revision BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${functionName}()`).execute(db)
  }
  for (const table of [
    'attendance_import_jobs',
    'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_execution_plan_chunks',
    'attendance_import_legacy_terminal_responses',
    'attendance_import_upload_cleanup_commands',
    'attendance_records', 'attendance_groups', 'attendance_group_members',
    'attendance_record_target_revisions', 'attendance_group_effect_revisions',
  ]) {
    await sql.raw(`DROP TRIGGER IF EXISTS trg_${table}_w4c3a_truncate ON ${table}`).execute(db)
    await sql.raw(`CREATE TRIGGER trg_${table}_w4c3a_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION attendance_w4c3a_deny_truncate()`).execute(db)
  }

  await sql`
    CREATE OR REPLACE FUNCTION attendance_validate_import_legacy_plan_v1(job_id uuid)
    RETURNS void LANGUAGE plpgsql AS $fn$
    DECLARE job attendance_import_jobs%ROWTYPE; plan attendance_import_legacy_execution_plans%ROWTYPE;
      terminal attendance_import_legacy_terminal_responses%ROWTYPE;
      cleanup attendance_import_upload_cleanup_commands%ROWTYPE;
      chunk_rows integer; source_rows integer; expected_index integer;
      replay_selector text; cleanup_kind text; expected_variant text; cleanup_required boolean;
    BEGIN
      SELECT * INTO job FROM attendance_import_jobs WHERE id = $1;
      IF NOT FOUND THEN RETURN; END IF;
      IF job.w4_contract_version IS NULL THEN
        IF EXISTS (SELECT 1 FROM attendance_import_legacy_execution_plans p WHERE p.job_id = $1) OR
           EXISTS (SELECT 1 FROM attendance_import_legacy_execution_plan_chunks c WHERE c.job_id = $1) OR
           EXISTS (SELECT 1 FROM attendance_import_legacy_terminal_responses t WHERE t.job_id = $1) OR
           EXISTS (SELECT 1 FROM attendance_import_upload_cleanup_commands u WHERE u.job_id = $1) THEN
          RAISE EXCEPTION 'W4C3A_NON_V1_HISTORY_DENIED';
        END IF;
        RETURN;
      END IF;
      IF job.w4_contract_version <> 1 THEN RAISE EXCEPTION 'W4C3A_V1_VERSION_UNSUPPORTED'; END IF;
      IF job.w4_legacy_plan_digest IS NULL THEN
        IF EXISTS (SELECT 1 FROM attendance_import_legacy_execution_plans p WHERE p.job_id = $1) OR
           EXISTS (SELECT 1 FROM attendance_import_legacy_execution_plan_chunks c WHERE c.job_id = $1) OR
           EXISTS (SELECT 1 FROM attendance_import_legacy_terminal_responses t WHERE t.job_id = $1) OR
           EXISTS (SELECT 1 FROM attendance_import_upload_cleanup_commands u WHERE u.job_id = $1) THEN
          RAISE EXCEPTION 'W4C3A_PREDECESSOR_V1_HISTORY_DENIED';
        END IF;
        RETURN;
      END IF;
      SELECT * INTO plan FROM attendance_import_legacy_execution_plans WHERE attendance_import_legacy_execution_plans.job_id = $1;
      IF NOT FOUND THEN
        IF job.status = 'failed' AND job.w4_execution_reason_code IN ('ATTENDANCE_IMPORT_LEGACY_PLAN_MISSING', 'ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING') THEN RETURN; END IF;
        RAISE EXCEPTION 'W4C3A_PLAN_MISSING';
      END IF;
      IF plan.org_id IS DISTINCT FROM job.org_id OR plan.batch_id IS DISTINCT FROM job.batch_id OR
         plan.batch_id IS DISTINCT FROM job.w4_batch_command_id OR plan.plan_version <> 1 OR
         plan.plan_digest IS DISTINCT FROM job.w4_legacy_plan_digest OR plan.source_kind IS DISTINCT FROM job.w4_source_kind OR
         plan.source_ref IS DISTINCT FROM job.w4_source_ref OR plan.created_by IS DISTINCT FROM job.created_by OR
         plan.actor_id IS DISTINCT FROM job.w4_actor_id OR plan.actor_posture IS DISTINCT FROM job.w4_actor_posture OR
         plan.token_subject_user_id IS DISTINCT FROM job.w4_token_subject_user_id OR
         plan.accepted_write_posture IS DISTINCT FROM job.w4_accepted_write_posture OR
         plan.operational_branch IS DISTINCT FROM job.w4_operational_branch OR
         plan.command_fingerprint IS DISTINCT FROM job.w4_command_fingerprint OR
         plan.legacy_input_fingerprint IS DISTINCT FROM job.w4_legacy_input_fingerprint OR
         plan.w4_item_count IS DISTINCT FROM job.w4_item_count OR
         plan.w4_distinct_target_count IS DISTINCT FROM job.w4_distinct_target_count OR
         plan.w4_item_sequence_fingerprint IS DISTINCT FROM job.w4_item_sequence_fingerprint OR
         plan.w4_item_set_fingerprint IS DISTINCT FROM job.w4_item_set_fingerprint OR
         plan.manifest -> 'batch' ->> 'idempotencyKey' IS DISTINCT FROM job.idempotency_key OR
         plan.identity_proof_vector_digest IS DISTINCT FROM encode(digest(convert_to(job.w4_identity_proof_vector::jsonb::text, 'UTF8'), 'sha256'), 'hex') THEN
        RAISE EXCEPTION 'W4C3A_PLAN_JOB_CONGRUENCE_DENIED';
      END IF;
      IF NOT attendance_w4c3a_exact_object_keys(plan.manifest, ARRAY[${sql.raw(MANIFEST_ROOT_KEYS.map((key) => "'" + key + "'").join(', '))}]) OR
         plan.manifest ->> 'schemaVersion' IS DISTINCT FROM '1' OR plan.manifest ->> 'orgId' IS DISTINCT FROM plan.org_id OR
         plan.manifest ->> 'jobId' IS DISTINCT FROM plan.job_id::text OR plan.manifest ->> 'batchId' IS DISTINCT FROM plan.batch_id::text OR
         plan.manifest ->> 'sourceKind' IS DISTINCT FROM plan.source_kind OR plan.manifest ->> 'sourceRef' IS DISTINCT FROM plan.source_ref OR
         plan.manifest ->> 'createdBy' IS DISTINCT FROM plan.created_by OR plan.manifest ->> 'actorId' IS DISTINCT FROM plan.actor_id OR
         plan.manifest ->> 'actorPosture' IS DISTINCT FROM plan.actor_posture OR
         plan.manifest ->> 'tokenSubjectUserId' IS DISTINCT FROM plan.token_subject_user_id OR
         plan.manifest ->> 'acceptedWritePosture' IS DISTINCT FROM plan.accepted_write_posture OR
         plan.manifest ->> 'identityProofVectorDigest' IS DISTINCT FROM plan.identity_proof_vector_digest OR
         plan.manifest ->> 'commandFingerprint' IS DISTINCT FROM plan.command_fingerprint OR
         plan.manifest ->> 'legacyInputFingerprint' IS DISTINCT FROM plan.legacy_input_fingerprint OR
         plan.manifest ->> 'operationalBranch' IS DISTINCT FROM plan.operational_branch OR
         plan.manifest ->> 'legacyRowSourceKind' IS DISTINCT FROM plan.legacy_row_source_kind OR
         plan.manifest ->> 'sourceRowCount' IS DISTINCT FROM plan.source_row_count::text OR
         plan.manifest ->> 'sourceOrdinalDigest' IS DISTINCT FROM plan.source_ordinal_digest OR
         (plan.manifest ->> 'rawEvidenceDigest') !~ '${sql.raw(SHA256)}' OR
         plan.manifest ->> 'w4ItemCount' IS DISTINCT FROM plan.w4_item_count::text OR
         plan.manifest ->> 'w4DistinctTargetCount' IS DISTINCT FROM plan.w4_distinct_target_count::text OR
         plan.manifest ->> 'w4ItemSequenceFingerprint' IS DISTINCT FROM plan.w4_item_sequence_fingerprint OR
         plan.manifest ->> 'w4ItemSetFingerprint' IS DISTINCT FROM plan.w4_item_set_fingerprint OR
         plan.manifest ->> 'legacySourceRowLimit' IS DISTINCT FROM plan.legacy_source_row_limit::text OR
         plan.manifest ->> 'groupRevision' IS DISTINCT FROM plan.group_revision::text OR
         plan.manifest ->> 'groupStateFingerprint' IS DISTINCT FROM plan.group_state_fingerprint OR
         plan.manifest ->> 'chunkVectorDigest' IS DISTINCT FROM plan.chunk_vector_digest OR
         NOT attendance_w4c3a_batch_plan_valid(plan.manifest -> 'batch') THEN
        RAISE EXCEPTION 'W4C3A_PLAN_MANIFEST_CONGRUENCE_DENIED';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM attendance_import_legacy_execution_plan_chunks c
         WHERE c.job_id = $1
           AND NOT attendance_w4c3a_chunk_body_valid(c.chunk)
      ) THEN
        RAISE EXCEPTION 'W4C3A_PLAN_CHUNK_BODY_DENIED';
      END IF;
      SELECT count(*)::integer, coalesce(sum(source_row_count), 0)::integer INTO chunk_rows, source_rows
      FROM attendance_import_legacy_execution_plan_chunks WHERE attendance_import_legacy_execution_plan_chunks.job_id = $1;
      IF chunk_rows <> plan.chunk_count OR source_rows <> plan.source_row_count THEN RAISE EXCEPTION 'W4C3A_PLAN_CHUNK_CONGRUENCE_DENIED'; END IF;
      IF plan.chunk_count > 0 THEN
        SELECT coalesce(min(chunk_index), -1) INTO expected_index FROM attendance_import_legacy_execution_plan_chunks WHERE attendance_import_legacy_execution_plan_chunks.job_id = $1;
        IF expected_index <> 0 OR EXISTS (
          SELECT 1 FROM (
            SELECT chunk_index, first_source_ordinal, source_row_count,
              lag(chunk_index) OVER (ORDER BY chunk_index) AS prior_index,
              lag(first_source_ordinal + source_row_count) OVER (ORDER BY chunk_index) AS prior_end
            FROM attendance_import_legacy_execution_plan_chunks WHERE attendance_import_legacy_execution_plan_chunks.job_id = $1
          ) chunks WHERE (prior_index IS NOT NULL AND chunk_index <> prior_index + 1) OR (prior_end IS NOT NULL AND first_source_ordinal <> prior_end)
        ) THEN RAISE EXCEPTION 'W4C3A_PLAN_CHUNK_ORDER_DENIED'; END IF;
      END IF;
      IF plan.legacy_row_source_kind IN ('uploaded_csv', 'inline_csv') AND plan.source_row_count > plan.legacy_source_row_limit THEN
        RAISE EXCEPTION 'W4C3A_PLAN_CSV_LIMIT_DENIED';
      END IF;
      IF (plan.group_revision IS NULL) IS DISTINCT FROM (plan.group_state_fingerprint IS NULL) THEN
        RAISE EXCEPTION 'W4C3A_PLAN_GROUP_PRECONDITION_DENIED';
      END IF;
      IF plan.operational_branch = 'strict_targeted' THEN
        IF plan.w4_item_count NOT BETWEEN 1 AND 5000 OR plan.w4_distinct_target_count NOT BETWEEN 1 AND 5000 OR
           plan.manifest -> 'batch' ->> 'kind' IS DISTINCT FROM 'normal' THEN RAISE EXCEPTION 'W4C3A_PLAN_BRANCH_DENIED'; END IF;
      ELSIF plan.operational_branch = 'operational_only_idempotent_replay' THEN
        replay_selector := plan.manifest -> 'batch' ->> 'replaySelector';
        IF plan.w4_item_count <> 0 OR plan.w4_distinct_target_count <> 0 OR plan.source_row_count <> 0 OR plan.chunk_count <> 0 OR
           job.total <= 0 OR job.w4_identity_proof_vector <> '[]'::jsonb OR
           plan.w4_item_sequence_fingerprint <> '${sql.raw(EMPTY_ITEM_SEQUENCE_FINGERPRINT)}' OR
           plan.w4_item_set_fingerprint <> '${sql.raw(EMPTY_ITEM_SET_FINGERPRINT)}' OR
           plan.source_ordinal_digest <> '${sql.raw(EMPTY_CANONICAL_ARRAY_DIGEST)}' OR
           plan.manifest ->> 'rawEvidenceDigest' <> '${sql.raw(EMPTY_CANONICAL_ARRAY_DIGEST)}' OR
           plan.chunk_vector_digest <> '${sql.raw(EMPTY_CANONICAL_ARRAY_DIGEST)}' OR
           plan.manifest -> 'batch' ->> 'kind' IS DISTINCT FROM 'idempotent_replay' OR
           replay_selector NOT IN ('precheck_hit', 'locked_race') OR
           plan.manifest -> 'batch' ->> 'totalRowCount' IS DISTINCT FROM job.total::text THEN
          RAISE EXCEPTION 'W4C3A_PLAN_REPLAY_BRANCH_DENIED';
        END IF;
        IF replay_selector = 'precheck_hit' AND (plan.legacy_row_source_kind IS NOT NULL OR plan.legacy_source_row_limit IS NOT NULL OR plan.manifest -> 'artifactCleanup' ->> 'kind' IS DISTINCT FROM 'none') THEN
          RAISE EXCEPTION 'W4C3A_PLAN_REPLAY_PRECHECK_SHAPE_DENIED';
        END IF;
        IF replay_selector = 'locked_race' AND (plan.legacy_row_source_kind IS NULL OR
          (plan.legacy_row_source_kind = 'uploaded_csv' AND plan.manifest -> 'artifactCleanup' ->> 'kind' IS DISTINCT FROM 'uploaded_import_file') OR
          (plan.legacy_row_source_kind <> 'uploaded_csv' AND plan.manifest -> 'artifactCleanup' ->> 'kind' IS DISTINCT FROM 'none')) THEN
          RAISE EXCEPTION 'W4C3A_PLAN_REPLAY_LOCKED_RACE_SHAPE_DENIED';
        END IF;
      ELSIF plan.operational_branch = 'operational_only_no_target' THEN
        IF plan.w4_item_count <> 0 OR plan.w4_distinct_target_count <> 0 OR job.w4_identity_proof_vector <> '[]'::jsonb OR
           plan.w4_item_sequence_fingerprint <> '${sql.raw(EMPTY_ITEM_SEQUENCE_FINGERPRINT)}' OR
           plan.w4_item_set_fingerprint <> '${sql.raw(EMPTY_ITEM_SET_FINGERPRINT)}' OR plan.manifest -> 'batch' ->> 'kind' IS DISTINCT FROM 'normal' OR
           EXISTS (SELECT 1 FROM attendance_import_legacy_execution_plan_chunks c, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.chunk -> 'items') = 'array' THEN c.chunk -> 'items' ELSE '[]'::jsonb END) item WHERE c.job_id = $1 AND item ->> 'kind' IS DISTINCT FROM 'skip') OR
           EXISTS (SELECT 1 FROM attendance_import_legacy_execution_plan_chunks c WHERE c.job_id = $1 AND (jsonb_typeof(c.chunk -> 'items') IS DISTINCT FROM 'array' OR jsonb_array_length(c.chunk -> 'items') <> c.source_row_count)) THEN
          RAISE EXCEPTION 'W4C3A_PLAN_NO_TARGET_BRANCH_DENIED';
        END IF;
      ELSIF plan.operational_branch = 'operational_only_batch_limit' THEN
        IF plan.w4_item_count < 1 OR plan.w4_distinct_target_count < 1 OR
           NOT (plan.w4_item_count > 5000 OR plan.w4_distinct_target_count > 5000) OR job.w4_identity_proof_vector <> '[]'::jsonb OR
           plan.accepted_write_posture NOT IN ('legacy_projection_only', 'shadow') OR plan.manifest -> 'batch' ->> 'kind' IS DISTINCT FROM 'normal' THEN
          RAISE EXCEPTION 'W4C3A_PLAN_BATCH_LIMIT_BRANCH_DENIED';
        END IF;
      ELSE RAISE EXCEPTION 'W4C3A_PLAN_BRANCH_DENIED';
      END IF;
      IF plan.operational_branch <> 'operational_only_idempotent_replay' AND job.total <> plan.source_row_count THEN
        RAISE EXCEPTION 'W4C3A_PLAN_JOB_TOTAL_DENIED';
      END IF;
      SELECT * INTO terminal FROM attendance_import_legacy_terminal_responses WHERE attendance_import_legacy_terminal_responses.job_id = $1;
      IF (job.status = 'completed') IS DISTINCT FROM FOUND THEN
        RAISE EXCEPTION 'W4C3A_PLAN_TERMINAL_CONGRUENCE_DENIED';
      END IF;
      IF job.status = 'completed' THEN
        expected_variant := CASE WHEN plan.operational_branch = 'operational_only_idempotent_replay' AND replay_selector = 'precheck_hit' THEN 'idempotent_early'
          WHEN plan.operational_branch = 'operational_only_idempotent_replay' THEN 'idempotent_in_transaction' ELSE 'first_execution' END;
        IF terminal.org_id IS DISTINCT FROM plan.org_id OR
           terminal.response_variant IS DISTINCT FROM expected_variant OR
           terminal.response -> 'idempotencyKey' IS DISTINCT FROM
             coalesce(to_jsonb(job.idempotency_key), 'null'::jsonb) OR
           terminal.response ->> '__importEngine' IS DISTINCT FROM
             plan.manifest -> 'batch' ->> 'engine' OR
           terminal.response ->> 'recordUpsertStrategy' IS DISTINCT FROM
             plan.manifest -> 'batch' ->> 'recordUpsertStrategy' THEN
          RAISE EXCEPTION 'W4C3A_PLAN_TERMINAL_SHAPE_DENIED';
        END IF;
      END IF;
      cleanup_kind := plan.manifest -> 'artifactCleanup' ->> 'kind';
      cleanup_required := job.status = 'completed' AND cleanup_kind = 'uploaded_import_file';
      SELECT * INTO cleanup FROM attendance_import_upload_cleanup_commands WHERE attendance_import_upload_cleanup_commands.job_id = $1;
      IF cleanup_required IS DISTINCT FROM FOUND THEN RAISE EXCEPTION 'W4C3A_PLAN_CLEANUP_CONGRUENCE_DENIED'; END IF;
      IF cleanup_required AND (cleanup.org_id IS DISTINCT FROM plan.org_id OR cleanup.file_id::text IS DISTINCT FROM plan.manifest -> 'artifactCleanup' ->> 'fileId') THEN
        RAISE EXCEPTION 'W4C3A_PLAN_CLEANUP_IDENTITY_DENIED';
      END IF;
    END
    $fn$
  `.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_validate_import_legacy_plan_v1_trigger()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE target_job_id uuid; row_json jsonb;
    BEGIN
      row_json := COALESCE(to_jsonb(NEW), to_jsonb(OLD));
      IF TG_TABLE_NAME = 'attendance_import_jobs' THEN
        target_job_id := (row_json ->> 'id')::uuid;
      ELSE
        target_job_id := (row_json ->> 'job_id')::uuid;
      END IF;
      PERFORM attendance_validate_import_legacy_plan_v1(target_job_id);
      RETURN NULL;
    END
    $fn$
  `.execute(db)
  for (const table of [
    'attendance_import_jobs', 'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_execution_plan_chunks', 'attendance_import_legacy_terminal_responses',
    'attendance_import_upload_cleanup_commands',
  ]) {
    await sql.raw(`DROP TRIGGER IF EXISTS trg_${table}_w4c3a_deferred_validator ON ${table}`).execute(db)
    await sql.raw(`CREATE CONSTRAINT TRIGGER trg_${table}_w4c3a_deferred_validator AFTER INSERT OR UPDATE OR DELETE ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION attendance_validate_import_legacy_plan_v1_trigger()`).execute(db)
  }

  await sql`
    ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_shape CHECK (
      (w4_contract_version IS NULL AND w4_entrypoint IS NULL AND w4_batch_command_id IS NULL AND w4_source_kind IS NULL AND
       w4_source_ref IS NULL AND w4_actor_id IS NULL AND w4_actor_posture IS NULL AND w4_token_subject_user_id IS NULL AND
       w4_command_fingerprint IS NULL AND w4_accepted_write_posture IS NULL AND w4_item_count IS NULL AND
       w4_item_sequence_fingerprint IS NULL AND w4_item_set_fingerprint IS NULL AND w4_identity_proof_vector IS NULL AND
       w4_execution_reason_code IS NULL AND w4_legacy_plan_digest IS NULL AND w4_distinct_target_count IS NULL AND
       w4_operational_branch IS NULL AND w4_legacy_input_fingerprint IS NULL)
      OR
      (w4_contract_version = 1 AND w4_entrypoint IS NOT NULL AND w4_batch_command_id IS NOT NULL AND w4_source_kind IS NOT NULL AND
       w4_source_ref IS NOT NULL AND w4_actor_id IS NOT NULL AND w4_actor_posture IS NOT NULL AND w4_command_fingerprint IS NOT NULL AND
       w4_accepted_write_posture IS NOT NULL AND w4_item_count IS NOT NULL AND w4_item_sequence_fingerprint IS NOT NULL AND
       w4_item_set_fingerprint IS NOT NULL AND w4_identity_proof_vector IS NOT NULL AND
       w4_legacy_plan_digest IS NOT NULL AND w4_distinct_target_count IS NOT NULL AND
       w4_operational_branch IS NOT NULL AND w4_legacy_input_fingerprint IS NOT NULL)
    )
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_item_count CHECK (
      w4_item_count IS NULL OR
      (w4_legacy_plan_digest IS NOT NULL AND w4_item_count >= 0)
    )
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_proof_vector CHECK (
      w4_identity_proof_vector IS NULL OR (
        w4_legacy_plan_digest IS NOT NULL AND attendance_w4_job_proof_vector_valid(
          w4_source_kind, w4_batch_command_id, w4_identity_proof_vector, w4_item_count,
          w4_operational_branch, w4_distinct_target_count
        )
      )
    )
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_exec_reason CHECK (
      w4_execution_reason_code IS NULL OR
      (w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED' AND status = 'queued') OR
      (w4_execution_reason_code = 'ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT' AND status = 'failed') OR
      (
        w4_execution_reason_code IN (${sql.raw(quoted(PLAN_FAILURE_REASONS))}) AND
        status = 'failed' AND
        error IS NULL
      )
    )
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_plan_columns CHECK (
      w4_legacy_plan_digest IS NULL OR (
        w4_legacy_plan_digest ~ '${sql.raw(SHA256)}' AND w4_legacy_input_fingerprint ~ '${sql.raw(SHA256)}' AND
        w4_operational_branch IN (${sql.raw(quoted(BRANCHES))}) AND w4_distinct_target_count >= 0 AND
        w4_distinct_target_count <= w4_item_count
      )
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_import_jobs_w4_guard()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE new_reason_is_plan boolean; old_reason_is_plan boolean;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.w4_contract_version = 1 THEN RAISE EXCEPTION 'W4C3A_V1_JOB_DELETE_DENIED'; END IF;
        RETURN OLD;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.w4_contract_version = 1 AND NEW.status = 'failed' THEN RAISE EXCEPTION 'W4C3A_V1_FAILED_INSERT_DENIED'; END IF;
        IF NEW.w4_contract_version = 1 AND
           current_setting('attendance.w4c3a_enqueue_job_id', true) IS DISTINCT FROM NEW.id::text THEN
          RAISE EXCEPTION 'W4C3A_V1_PLAN_ENQUEUE_SEAM_REQUIRED';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.w4_contract_version IS DISTINCT FROM OLD.w4_contract_version OR NEW.w4_entrypoint IS DISTINCT FROM OLD.w4_entrypoint OR
         NEW.w4_batch_command_id IS DISTINCT FROM OLD.w4_batch_command_id OR NEW.w4_source_kind IS DISTINCT FROM OLD.w4_source_kind OR
         NEW.w4_source_ref IS DISTINCT FROM OLD.w4_source_ref OR NEW.w4_actor_id IS DISTINCT FROM OLD.w4_actor_id OR
         NEW.w4_actor_posture IS DISTINCT FROM OLD.w4_actor_posture OR NEW.w4_token_subject_user_id IS DISTINCT FROM OLD.w4_token_subject_user_id OR
         NEW.w4_command_fingerprint IS DISTINCT FROM OLD.w4_command_fingerprint OR NEW.w4_accepted_write_posture IS DISTINCT FROM OLD.w4_accepted_write_posture OR
         NEW.w4_item_count IS DISTINCT FROM OLD.w4_item_count OR NEW.w4_item_sequence_fingerprint IS DISTINCT FROM OLD.w4_item_sequence_fingerprint OR
         NEW.w4_item_set_fingerprint IS DISTINCT FROM OLD.w4_item_set_fingerprint OR NEW.w4_identity_proof_vector IS DISTINCT FROM OLD.w4_identity_proof_vector OR
         NEW.w4_legacy_plan_digest IS DISTINCT FROM OLD.w4_legacy_plan_digest OR NEW.w4_distinct_target_count IS DISTINCT FROM OLD.w4_distinct_target_count OR
         NEW.w4_operational_branch IS DISTINCT FROM OLD.w4_operational_branch OR NEW.w4_legacy_input_fingerprint IS DISTINCT FROM OLD.w4_legacy_input_fingerprint OR
         (OLD.w4_contract_version = 1 AND NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key) OR
         (OLD.w4_contract_version = 1 AND NEW.payload IS DISTINCT FROM OLD.payload) THEN
        RAISE EXCEPTION 'W4C3A_V1_JOB_FROZEN';
      END IF;
      IF OLD.w4_contract_version = 1 AND OLD.status IN ('completed', 'failed') AND
         (NEW.status IS DISTINCT FROM OLD.status OR NEW.progress IS DISTINCT FROM OLD.progress OR NEW.total IS DISTINCT FROM OLD.total OR
          NEW.error IS DISTINCT FROM OLD.error OR NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
        RAISE EXCEPTION 'W4C3A_V1_TERMINAL_IMMUTABLE';
      END IF;
      new_reason_is_plan := NEW.w4_execution_reason_code IN (${sql.raw(quoted(PLAN_FAILURE_REASONS))});
      old_reason_is_plan := OLD.w4_execution_reason_code IN (${sql.raw(quoted(PLAN_FAILURE_REASONS))});
      IF OLD.w4_contract_version = 1 AND (
        (new_reason_is_plan AND NOT (OLD.status IN ('queued', 'running') AND OLD.w4_execution_reason_code IS NULL AND NEW.status = 'failed')) OR
        (old_reason_is_plan AND NEW.w4_execution_reason_code IS DISTINCT FROM OLD.w4_execution_reason_code) OR
        (OLD.status = 'failed' AND NEW.status IN ('queued', 'running'))
      ) THEN RAISE EXCEPTION 'W4C3A_V1_REASON_TRANSITION_DENIED'; END IF;
      RETURN NEW;
    END
    $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_aij_w4_guard BEFORE INSERT OR UPDATE OR DELETE ON attendance_import_jobs
    FOR EACH ROW EXECUTE FUNCTION attendance_w4_import_jobs_w4_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const checks = [
    'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_execution_plan_chunks',
    'attendance_import_legacy_terminal_responses',
    'attendance_import_upload_cleanup_commands',
  ]
  for (const table of checks) {
    const result = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM ${sql.table(table)}`.execute(db)
    if ((result.rows[0]?.count ?? 0) > 0) throw new Error('W4C3A_DOWN_REFUSED_POPULATED_HISTORY')
  }
  const jobs = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM attendance_import_jobs WHERE w4_contract_version = 1`.execute(db)
  if ((jobs.rows[0]?.count ?? 0) > 0) throw new Error('W4C3A_DOWN_REFUSED_V1_JOB')

  for (const table of [
    'attendance_import_upload_cleanup_commands', 'attendance_import_legacy_terminal_responses',
    'attendance_import_legacy_execution_plan_chunks', 'attendance_import_legacy_execution_plans',
    'attendance_records', 'attendance_groups', 'attendance_group_members',
    'attendance_record_target_revisions', 'attendance_group_effect_revisions', 'attendance_import_jobs',
  ]) {
    await sql.raw(`DROP TRIGGER IF EXISTS trg_${table}_w4c3a_deferred_validator ON ${table}`).execute(db)
    await sql.raw(`DROP TRIGGER IF EXISTS trg_${table}_w4c3a_truncate ON ${table}`).execute(db)
  }
  await sql`DROP TRIGGER IF EXISTS trg_aij_w4_guard ON attendance_import_jobs`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4_import_jobs_w4_guard()`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_plan_columns`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_shape`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_item_count`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_proof_vector`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS chk_aij_w4_exec_reason`.execute(db)
  for (const column of ['w4_legacy_plan_digest', 'w4_distinct_target_count', 'w4_operational_branch', 'w4_legacy_input_fingerprint']) {
    await sql.raw(`ALTER TABLE attendance_import_jobs DROP COLUMN IF EXISTS ${column}`).execute(db)
  }
  for (const table of ['attendance_records', 'attendance_groups', 'attendance_group_members']) {
    await sql.raw(`DROP TRIGGER IF EXISTS trg_${table}_w4c3a_revision ON ${table}`).execute(db)
  }
  for (const table of ['attendance_record_target_revisions', 'attendance_group_effect_revisions']) {
    await sql.raw(`DROP TRIGGER IF EXISTS trg_${table}_direct_guard ON ${table}`).execute(db)
  }
  await sql`DROP TABLE IF EXISTS attendance_import_upload_cleanup_commands`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_import_legacy_terminal_responses`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_import_legacy_execution_plan_chunks`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_import_legacy_execution_plans`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_record_target_revisions`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_group_effect_revisions`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_validate_import_legacy_plan_v1_trigger()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_validate_import_legacy_plan_v1(uuid)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_cleanup_cas_guard()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_claim_import_upload_cleanup_command(uuid, uuid, timestamptz)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_finish_import_upload_cleanup_command(uuid, uuid, text, text)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_reject_w4_import_history_mutation()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_bump_record_target_revision()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_bump_group_effect_revision()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_revision_row_guard()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_deny_truncate()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4_job_proof_vector_valid(text, uuid, jsonb, integer, text, integer)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_async_job_summary_valid(jsonb)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_chunk_body_valid(jsonb)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_raw_import_evidence_valid(jsonb)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_presence_valid(jsonb, text[], boolean)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_record_write_slots_valid(jsonb)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_batch_plan_valid(jsonb)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_group_effect_valid(jsonb)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_uuid_text(text)`.execute(db)

  // Restore precisely the predecessor's four-argument V1 proof shape and its immutable guard.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_job_proof_vector_valid(source_kind text, root uuid, vector jsonb, item_count integer)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
    DECLARE ns uuid; i integer; entry jsonb;
    BEGIN
      IF source_kind = 'import_batch' THEN ns := '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'::uuid;
      ELSIF source_kind = 'integration_batch' THEN ns := '46501375-c273-459f-a5af-f926859f6411'::uuid; ELSE RETURN false; END IF;
      IF root IS NULL OR vector IS NULL OR item_count IS NULL OR jsonb_typeof(vector) IS DISTINCT FROM 'array' OR jsonb_array_length(vector) <> item_count OR item_count < 1 THEN RETURN false; END IF;
      FOR i IN 0..item_count - 1 LOOP
        entry := vector -> i;
        IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(entry)) <> 4 OR NOT (entry ?& ARRAY['ordinal', 'semanticFingerprint', 'derivedOperationId', 'commandFingerprint']) OR
           jsonb_typeof(entry -> 'ordinal') IS DISTINCT FROM 'number' OR (entry ->> 'ordinal') IS DISTINCT FROM i::text OR
           jsonb_typeof(entry -> 'semanticFingerprint') IS DISTINCT FROM 'string' OR jsonb_typeof(entry -> 'derivedOperationId') IS DISTINCT FROM 'string' OR
           jsonb_typeof(entry -> 'commandFingerprint') IS DISTINCT FROM 'string' OR (entry ->> 'semanticFingerprint') !~ '${sql.raw(SHA256)}' OR
           (entry ->> 'commandFingerprint') !~ '${sql.raw(SHA256)}' OR (entry ->> 'derivedOperationId') IS DISTINCT FROM attendance_w4_uuidv5(ns, attendance_w4_item_name_bytes(root, i, entry ->> 'semanticFingerprint'))::text THEN RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    END $fn$
  `.execute(db)
  await sql`
    ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_shape CHECK (
      (w4_contract_version IS NULL AND w4_entrypoint IS NULL AND w4_batch_command_id IS NULL AND w4_source_kind IS NULL AND w4_source_ref IS NULL AND w4_actor_id IS NULL AND w4_actor_posture IS NULL AND w4_token_subject_user_id IS NULL AND w4_command_fingerprint IS NULL AND w4_accepted_write_posture IS NULL AND w4_item_count IS NULL AND w4_item_sequence_fingerprint IS NULL AND w4_item_set_fingerprint IS NULL AND w4_identity_proof_vector IS NULL AND w4_execution_reason_code IS NULL)
      OR (w4_contract_version = 1 AND w4_entrypoint IS NOT NULL AND w4_batch_command_id IS NOT NULL AND w4_source_kind IS NOT NULL AND w4_source_ref IS NOT NULL AND w4_actor_id IS NOT NULL AND w4_actor_posture IS NOT NULL AND w4_command_fingerprint IS NOT NULL AND w4_accepted_write_posture IS NOT NULL AND w4_item_count IS NOT NULL AND w4_item_sequence_fingerprint IS NOT NULL AND w4_item_set_fingerprint IS NOT NULL AND w4_identity_proof_vector IS NOT NULL)
    )
  `.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_item_count CHECK (w4_item_count IS NULL OR w4_item_count >= 1)`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_proof_vector CHECK (w4_identity_proof_vector IS NULL OR attendance_w4_job_proof_vector_valid(w4_source_kind, w4_batch_command_id, w4_identity_proof_vector, w4_item_count))`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_exec_reason CHECK (w4_execution_reason_code IS NULL OR (w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED' AND status = 'queued') OR (w4_execution_reason_code = 'ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT' AND status = 'failed'))`.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_import_jobs_w4_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.w4_contract_version IS DISTINCT FROM OLD.w4_contract_version OR NEW.w4_entrypoint IS DISTINCT FROM OLD.w4_entrypoint OR NEW.w4_batch_command_id IS DISTINCT FROM OLD.w4_batch_command_id OR NEW.w4_source_kind IS DISTINCT FROM OLD.w4_source_kind OR NEW.w4_source_ref IS DISTINCT FROM OLD.w4_source_ref OR NEW.w4_actor_id IS DISTINCT FROM OLD.w4_actor_id OR NEW.w4_actor_posture IS DISTINCT FROM OLD.w4_actor_posture OR NEW.w4_token_subject_user_id IS DISTINCT FROM OLD.w4_token_subject_user_id OR NEW.w4_command_fingerprint IS DISTINCT FROM OLD.w4_command_fingerprint OR NEW.w4_accepted_write_posture IS DISTINCT FROM OLD.w4_accepted_write_posture OR NEW.w4_item_count IS DISTINCT FROM OLD.w4_item_count OR NEW.w4_item_sequence_fingerprint IS DISTINCT FROM OLD.w4_item_sequence_fingerprint OR NEW.w4_item_set_fingerprint IS DISTINCT FROM OLD.w4_item_set_fingerprint OR NEW.w4_identity_proof_vector IS DISTINCT FROM OLD.w4_identity_proof_vector THEN RAISE EXCEPTION 'W4C0_JOB_FROZEN'; END IF;
      RETURN NEW;
    END $fn$
  `.execute(db)
  await sql`CREATE TRIGGER trg_aij_w4_guard BEFORE UPDATE ON attendance_import_jobs FOR EACH ROW EXECUTE FUNCTION attendance_w4_import_jobs_w4_guard()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_exact_object_keys(jsonb, text[])`.execute(db)
}
