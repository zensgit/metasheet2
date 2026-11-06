import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attendance_import_jobs
      ADD COLUMN punch_preview_version smallint,
      ADD COLUMN punch_preview_request_fingerprint text,
      ADD COLUMN punch_preview_snapshot_digest text,
      ADD COLUMN punch_preview_actor_posture text,
      ADD COLUMN punch_preview_token_subject_user_id text,
      ADD CONSTRAINT chk_aij_punch_preview_shape CHECK (
        (punch_preview_version IS NULL AND punch_preview_request_fingerprint IS NULL AND punch_preview_snapshot_digest IS NULL
          AND punch_preview_actor_posture IS NULL AND punch_preview_token_subject_user_id IS NULL)
        OR (punch_preview_version IS NOT NULL AND punch_preview_version = 1 AND w4_contract_version IS NULL
          AND punch_preview_request_fingerprint IS NOT NULL AND punch_preview_request_fingerprint ~ '^[0-9a-f]{64}$'
          AND punch_preview_snapshot_digest IS NOT NULL AND punch_preview_snapshot_digest ~ '^[0-9a-f]{64}$'
          AND punch_preview_actor_posture IS NOT NULL AND punch_preview_actor_posture IN
            ('self', 'platform_admin', 'attendance_admin', 'delegated_import', 'scheduler', 'approval_system', 'operator')
          AND (punch_preview_token_subject_user_id IS NULL OR
            (length(punch_preview_token_subject_user_id) BETWEEN 1 AND 200
              AND btrim(punch_preview_token_subject_user_id) = punch_preview_token_subject_user_id))
          AND org_id IS NOT NULL AND created_by IS NOT NULL AND batch_id IS NOT NULL
          AND payload = '{"__jobType":"preview"}'::jsonb
          AND status IN ('queued', 'running', 'completed', 'failed')))
  `.execute(db)
  await sql`
    CREATE TABLE attendance_import_punch_preview_records (
      job_id uuid PRIMARY KEY REFERENCES attendance_import_jobs(id) DEFERRABLE INITIALLY DEFERRED,
      org_id text NOT NULL,
      created_by text NOT NULL,
      batch_id uuid NOT NULL,
      request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
      snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
      snapshot jsonb NOT NULL,
      CONSTRAINT chk_punch_preview_record_shape CHECK ((
        attendance_w4c3a_exact_object_keys(snapshot, ARRAY[
          'schemaVersion', 'kind', 'jobId', 'batchId', 'scope', 'envelope',
          'previewLimit', 'frozenTarget', 'requestFingerprint', 'preview'])
        AND snapshot->'schemaVersion' = '1'::jsonb
        AND snapshot->>'kind' = 'punch_events_preview_v1'
        AND snapshot->>'jobId' = job_id::text AND snapshot->>'batchId' = batch_id::text
        AND snapshot->>'requestFingerprint' = request_fingerprint
        AND attendance_w4c3a_exact_object_keys(snapshot->'scope', ARRAY[
          'orgId', 'actorId', 'actorPosture', 'tokenSubjectUserId'])
        AND snapshot#>>'{scope,orgId}' = org_id AND snapshot#>>'{scope,actorId}' = created_by
        AND jsonb_typeof(snapshot#>'{scope,tokenSubjectUserId}') IN ('string', 'null')
      ) IS TRUE)
    )
  `.execute(db)
  await sql`
    CREATE FUNCTION attendance_punch_preview_record_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'ATTENDANCE_PUNCH_PREVIEW_RECORD_IMMUTABLE';
    END
    $fn$;
    CREATE TRIGGER trg_punch_preview_record_immutable BEFORE UPDATE OR DELETE
      ON attendance_import_punch_preview_records FOR EACH ROW EXECUTE FUNCTION attendance_punch_preview_record_guard();
    CREATE TRIGGER trg_punch_preview_record_truncate BEFORE TRUNCATE
      ON attendance_import_punch_preview_records FOR EACH STATEMENT EXECUTE FUNCTION attendance_punch_preview_record_guard()
  `.execute(db)
  await sql`
    CREATE FUNCTION attendance_punch_preview_job_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.punch_preview_version IS NOT NULL THEN RAISE EXCEPTION 'ATTENDANCE_PUNCH_PREVIEW_JOB_IMMUTABLE'; END IF;
        RETURN OLD;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.punch_preview_version IS NOT NULL AND NEW.status <> 'queued' THEN
          RAISE EXCEPTION 'ATTENDANCE_PUNCH_PREVIEW_INITIAL_STATUS';
        END IF;
        RETURN NEW;
      END IF;
      IF ROW(NEW.punch_preview_version, NEW.punch_preview_request_fingerprint, NEW.punch_preview_snapshot_digest,
             NEW.punch_preview_actor_posture, NEW.punch_preview_token_subject_user_id)
         IS DISTINCT FROM ROW(OLD.punch_preview_version, OLD.punch_preview_request_fingerprint, OLD.punch_preview_snapshot_digest,
             OLD.punch_preview_actor_posture, OLD.punch_preview_token_subject_user_id)
         OR (OLD.punch_preview_version IS NOT NULL AND
           ROW(NEW.id, NEW.org_id, NEW.created_by, NEW.batch_id, NEW.idempotency_key, NEW.payload)
           IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.created_by, OLD.batch_id, OLD.idempotency_key, OLD.payload)) THEN
        RAISE EXCEPTION 'ATTENDANCE_PUNCH_PREVIEW_JOB_IMMUTABLE';
      END IF;
      IF OLD.punch_preview_version IS NOT NULL AND OLD.status IN ('completed', 'failed') AND
         ROW(NEW.status, NEW.progress, NEW.total, NEW.error, NEW.started_at, NEW.finished_at)
         IS DISTINCT FROM ROW(OLD.status, OLD.progress, OLD.total, OLD.error, OLD.started_at, OLD.finished_at) THEN
        RAISE EXCEPTION 'ATTENDANCE_PUNCH_PREVIEW_TERMINAL_IMMUTABLE';
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER trg_punch_preview_job_guard BEFORE INSERT OR UPDATE OR DELETE ON attendance_import_jobs
      FOR EACH ROW EXECUTE FUNCTION attendance_punch_preview_job_guard()
  `.execute(db)
  await sql`
    CREATE FUNCTION attendance_punch_preview_validate_binding() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE target_id uuid; job attendance_import_jobs%ROWTYPE; record attendance_import_punch_preview_records%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME = 'attendance_import_jobs' THEN
        target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
      ELSE
        target_id := NEW.job_id;
      END IF;
      SELECT * INTO job FROM attendance_import_jobs WHERE id = target_id;
      SELECT * INTO record FROM attendance_import_punch_preview_records WHERE job_id = target_id;
      IF job.punch_preview_version IS NULL AND record.job_id IS NULL THEN RETURN NULL; END IF;
      IF job.punch_preview_version IS DISTINCT FROM 1 OR record.job_id IS NULL OR
         ROW(job.org_id, job.created_by, job.batch_id, job.punch_preview_request_fingerprint, job.punch_preview_snapshot_digest,
             job.punch_preview_actor_posture, job.punch_preview_token_subject_user_id)
         IS DISTINCT FROM ROW(record.org_id, record.created_by, record.batch_id, record.request_fingerprint, record.snapshot_digest,
             record.snapshot#>>'{scope,actorPosture}', record.snapshot#>>'{scope,tokenSubjectUserId}') THEN
        RAISE EXCEPTION 'ATTENDANCE_PUNCH_PREVIEW_BINDING_MISMATCH';
      END IF;
      RETURN NULL;
    END
    $fn$;
    CREATE CONSTRAINT TRIGGER trg_punch_preview_job_binding AFTER INSERT OR UPDATE OR DELETE ON attendance_import_jobs
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION attendance_punch_preview_validate_binding();
    CREATE CONSTRAINT TRIGGER trg_punch_preview_record_binding AFTER INSERT ON attendance_import_punch_preview_records
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION attendance_punch_preview_validate_binding()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // An older repeatable-read snapshot can miss history committed before our lock.
  const isolation = await sql<{ isolation: string }>`SELECT current_setting('transaction_isolation') AS isolation`.execute(db)
  if (isolation.rows[0]?.isolation !== 'read committed') throw new Error('ATTENDANCE_PUNCH_PREVIEW_DOWN_ISOLATION_REQUIRED')
  // The migration runner owns the transaction; lock before checking retained history.
  await sql`LOCK TABLE attendance_import_jobs, attendance_import_punch_preview_records IN ACCESS EXCLUSIVE MODE`.execute(db)
  const result = await sql<{ retained: boolean }>`SELECT
    EXISTS (SELECT 1 FROM attendance_import_punch_preview_records)
    OR EXISTS (SELECT 1 FROM attendance_import_jobs WHERE punch_preview_version IS NOT NULL) AS retained`.execute(db)
  if (result.rows[0]?.retained !== false) throw new Error('ATTENDANCE_PUNCH_PREVIEW_DOWN_RETAINED_HISTORY')
  await sql`
    DROP TRIGGER trg_punch_preview_job_binding ON attendance_import_jobs;
    DROP TRIGGER trg_punch_preview_record_binding ON attendance_import_punch_preview_records;
    DROP TRIGGER trg_punch_preview_job_guard ON attendance_import_jobs;
    DROP FUNCTION attendance_punch_preview_validate_binding();
    DROP FUNCTION attendance_punch_preview_job_guard();
    DROP TABLE attendance_import_punch_preview_records;
    DROP FUNCTION attendance_punch_preview_record_guard();
    ALTER TABLE attendance_import_jobs DROP CONSTRAINT chk_aij_punch_preview_shape,
      DROP COLUMN punch_preview_version, DROP COLUMN punch_preview_request_fingerprint, DROP COLUMN punch_preview_snapshot_digest,
      DROP COLUMN punch_preview_actor_posture, DROP COLUMN punch_preview_token_subject_user_id
  `.execute(db)
}
