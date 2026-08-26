import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning L2 durable notification intent ledger.
 *
 * This slice is deliberately inert: it creates no producer, route, timer, or
 * external channel call. Identity fields are immutable after insert while
 * delivery-state fields remain available to the later claim-lease worker.
 * DELETE denial follows the ratified append-only contract; any retention or
 * erasure mechanism must be explicit before a producer makes this table live.
 */

export const ELEARNING_NOTIFICATION_DELIVERIES_TABLE =
  'elearning_notification_deliveries'
export const ELEARNING_NOTIFICATION_DELIVERIES_ORG_SOURCE_UNIQ =
  'elearning_notification_deliveries_org_source_uniq'
export const ELEARNING_NOTIFICATION_DELIVERIES_CLAIM_INDEX =
  'idx_elearning_notification_deliveries_claim'
export const ELEARNING_NOTIFICATION_DELIVERIES_MEMBER_INDEX =
  'idx_elearning_notification_deliveries_member'
export const ELEARNING_NOTIFICATION_DELIVERIES_IDENTITY_FN =
  'elearning_notification_deliveries_identity_guard'
export const ELEARNING_NOTIFICATION_DELIVERIES_IDENTITY_TRIGGER =
  'trg_elearning_notification_deliveries_identity_guard'

export const ELEARNING_NOTIFICATION_DELIVERY_STATUSES = [
  'pending',
  'sending',
  'sent',
  'retrying',
  'failed',
  'outcome_unknown',
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE elearning_notification_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      assignment_member_id uuid NOT NULL,
      kind text NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      recipient_role text NOT NULL,
      recipient_user_id text NOT NULL,
      channel text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      due_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL,
      last_attempt_at timestamptz,
      claimed_at timestamptz,
      claim_expires_at timestamptz,
      claim_worker_id text,
      delivered_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_notification_deliveries_org_id_id_uniq
        UNIQUE (org_id, id),
      CONSTRAINT elearning_notification_deliveries_org_source_uniq
        UNIQUE (org_id, source_key),
      CONSTRAINT elearning_notification_deliveries_org_id_nonempty_chk
        CHECK (org_id = btrim(org_id) AND org_id <> ''),
      CONSTRAINT elearning_notification_deliveries_kind_chk
        CHECK (kind = 'assignment_reminder'),
      CONSTRAINT elearning_notification_deliveries_source_key_nonempty_chk
        CHECK (source_key = btrim(source_key) AND source_key <> ''),
      CONSTRAINT elearning_notification_deliveries_request_hash_chk
        CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT elearning_notification_deliveries_hash_version_chk
        CHECK (request_hash_version = 1),
      CONSTRAINT elearning_notification_deliveries_recipient_role_chk
        CHECK (recipient_role = 'learner'),
      CONSTRAINT elearning_notification_deliveries_recipient_user_nonempty_chk
        CHECK (recipient_user_id = btrim(recipient_user_id) AND recipient_user_id <> ''),
      CONSTRAINT elearning_notification_deliveries_channel_chk
        CHECK (channel = 'platform'),
      CONSTRAINT elearning_notification_deliveries_payload_object_chk
        CHECK (jsonb_typeof(payload) = 'object'),
      CONSTRAINT elearning_notification_deliveries_status_chk
        CHECK (
          status IN (
            'pending', 'sending', 'sent', 'retrying', 'failed', 'outcome_unknown'
          )
        ),
      CONSTRAINT elearning_notification_deliveries_attempt_count_chk
        CHECK (attempt_count >= 0),
      CONSTRAINT elearning_notification_deliveries_lease_state_chk
        CHECK (
          (
            status = 'sending'
            AND claimed_at IS NOT NULL
            AND claim_expires_at IS NOT NULL
            AND claim_worker_id IS NOT NULL
            AND claim_worker_id = btrim(claim_worker_id)
            AND claim_worker_id <> ''
          )
          OR (
            status <> 'sending'
            AND claimed_at IS NULL
            AND claim_expires_at IS NULL
            AND claim_worker_id IS NULL
          )
        ),
      CONSTRAINT elearning_notification_deliveries_sent_state_chk
        CHECK (
          (status = 'sent' AND delivered_at IS NOT NULL)
          OR (status <> 'sent' AND delivered_at IS NULL)
        ),
      CONSTRAINT elearning_notification_deliveries_error_state_chk
        CHECK (
          (
            status IN ('retrying', 'failed', 'outcome_unknown')
            AND last_error IS NOT NULL
            AND last_error ~ '^[A-Z][A-Z0-9_]{1,63}$'
          )
          OR (
            status NOT IN ('retrying', 'failed', 'outcome_unknown')
            AND last_error IS NULL
          )
        ),
      CONSTRAINT elearning_notification_deliveries_updated_at_chk
        CHECK (updated_at >= created_at),
      CONSTRAINT elearning_notification_deliveries_assignment_member_fk
        FOREIGN KEY (org_id, assignment_member_id)
        REFERENCES elearning_assignment_members (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_notification_deliveries_claim
      ON elearning_notification_deliveries (next_attempt_at, claim_expires_at, id)
      WHERE status IN ('pending', 'sending', 'retrying')
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_notification_deliveries_member
      ON elearning_notification_deliveries (org_id, assignment_member_id, created_at)
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_notification_deliveries_identity_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'elearning_notification_deliveries DELETE is not permitted';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.assignment_member_id IS DISTINCT FROM OLD.assignment_member_id
         OR NEW.kind IS DISTINCT FROM OLD.kind
         OR NEW.source_key IS DISTINCT FROM OLD.source_key
         OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
         OR NEW.request_hash_version IS DISTINCT FROM OLD.request_hash_version
         OR NEW.recipient_role IS DISTINCT FROM OLD.recipient_role
         OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
         OR NEW.channel IS DISTINCT FROM OLD.channel
         OR NEW.payload IS DISTINCT FROM OLD.payload
         OR NEW.due_at IS DISTINCT FROM OLD.due_at
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning_notification_deliveries identity fields are immutable';
      END IF;

      RETURN NEW;
    END;
    $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_notification_deliveries_identity_guard
      BEFORE UPDATE OR DELETE ON elearning_notification_deliveries
      FOR EACH ROW
      EXECUTE FUNCTION elearning_notification_deliveries_identity_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_notification_deliveries_identity_guard
      ON elearning_notification_deliveries
  `.execute(db)
  await sql`
    DROP FUNCTION IF EXISTS elearning_notification_deliveries_identity_guard()
  `.execute(db)
  await sql`DROP INDEX IF EXISTS idx_elearning_notification_deliveries_member`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_elearning_notification_deliveries_claim`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_notification_deliveries`.execute(db)
}
