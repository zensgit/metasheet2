import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning L0 plugin-owned jobs table (design-lock §4.7 / §6.5).
 *
 * Claim-lease worker substrate only. No enqueue HTTP API, no effects, no
 * attendanceScheduler, no core bootstrap. org_id is NOT NULL with no database
 * default. Job identity is UNIQUE(org_id, kind, occurrence_key). Worker
 * semantics are at-least-once: expired leases may be reclaimed.
 *
 * CREATE TABLE / CREATE INDEX are not IF NOT EXISTS so a pre-existing
 * same-name object fails closed instead of masking drift.
 */

export const ELEARNING_JOBS_TABLE = 'elearning_jobs'
export const ELEARNING_JOBS_ORG_KIND_OCCURRENCE_UNIQ = 'elearning_jobs_org_kind_occurrence_uniq'
export const ELEARNING_JOBS_CLAIM_INDEX = 'idx_elearning_jobs_due_lease'
export const ELEARNING_JOBS_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'dead',
] as const
export const ELEARNING_JOBS_CLAIMABLE_STATUSES = ['pending', 'running', 'failed'] as const
export const ELEARNING_JOBS_LAST_ERROR_CODE_RE = '^[A-Z][A-Z0-9_]{1,63}$'

export const ELEARNING_JOBS_STATUS_CHK = 'elearning_jobs_status_chk'
export const ELEARNING_JOBS_ORG_ID_NONEMPTY_CHK = 'elearning_jobs_org_id_nonempty_chk'
export const ELEARNING_JOBS_KIND_NONEMPTY_CHK = 'elearning_jobs_kind_nonempty_chk'
export const ELEARNING_JOBS_OCCURRENCE_KEY_NONEMPTY_CHK = 'elearning_jobs_occurrence_key_nonempty_chk'
export const ELEARNING_JOBS_REF_NONEMPTY_CHK = 'elearning_jobs_ref_nonempty_chk'
export const ELEARNING_JOBS_PAYLOAD_OBJECT_CHK = 'elearning_jobs_payload_object_chk'
export const ELEARNING_JOBS_ATTEMPTS_CHK = 'elearning_jobs_attempts_chk'
export const ELEARNING_JOBS_LAST_ERROR_CODE_CHK = 'elearning_jobs_last_error_code_chk'
export const ELEARNING_JOBS_LEASE_STATE_CHK = 'elearning_jobs_lease_state_chk'
export const ELEARNING_JOBS_ERROR_STATUS_CHK = 'elearning_jobs_error_status_chk'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE elearning_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      kind text NOT NULL,
      occurrence_key text NOT NULL,
      ref text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      due_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      lease_until timestamptz,
      claim_worker_id text,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_jobs_org_kind_occurrence_uniq
        UNIQUE (org_id, kind, occurrence_key),
      CONSTRAINT elearning_jobs_status_chk
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
      CONSTRAINT elearning_jobs_org_id_nonempty_chk
        CHECK (org_id = btrim(org_id) AND org_id <> ''),
      CONSTRAINT elearning_jobs_kind_nonempty_chk
        CHECK (kind = btrim(kind) AND kind <> ''),
      CONSTRAINT elearning_jobs_occurrence_key_nonempty_chk
        CHECK (occurrence_key = btrim(occurrence_key) AND occurrence_key <> ''),
      CONSTRAINT elearning_jobs_ref_nonempty_chk
        CHECK (ref IS NULL OR (ref = btrim(ref) AND ref <> '')),
      CONSTRAINT elearning_jobs_payload_object_chk
        CHECK (jsonb_typeof(payload) = 'object'),
      CONSTRAINT elearning_jobs_attempts_chk
        CHECK (attempts >= 0),
      CONSTRAINT elearning_jobs_last_error_code_chk
        CHECK (
          last_error IS NULL
          OR last_error ~ '^[A-Z][A-Z0-9_]{1,63}$'
        ),
      CONSTRAINT elearning_jobs_lease_state_chk
        CHECK (
          (
            status = 'running'
            AND lease_until IS NOT NULL
            AND claim_worker_id IS NOT NULL
            AND claim_worker_id = btrim(claim_worker_id)
            AND claim_worker_id <> ''
          )
          OR (
            status <> 'running'
            AND lease_until IS NULL
            AND claim_worker_id IS NULL
          )
        ),
      CONSTRAINT elearning_jobs_error_status_chk
        CHECK (
          (status IN ('failed', 'dead') AND last_error IS NOT NULL)
          OR (status NOT IN ('failed', 'dead') AND last_error IS NULL)
        )
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_jobs_due_lease
      ON elearning_jobs (due_at, lease_until, id)
      WHERE status IN ('pending', 'running', 'failed')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_elearning_jobs_due_lease`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_jobs`.execute(db)
}
