import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * E-learning V0.1 named-pilot — watch-progress persistence.
 *
 * Six org-scoped SoR tables for the unparked watch-verification loop
 * (explicit assignment → member fact → session → heartbeat events →
 * progress rollup → append-only completion evidence).
 *
 * This is the ratified dual-basis completion model restricted to the
 * assignment-only named pilot: evidence.assignment_member_id is NOT NULL
 * and there is no scope foreign key. A later migration may extend evidence
 * when scope is unparked. Do not invent a scope FK here.
 *
 * Out of scope: scopes, self-study, department rules, bulk import, nudges,
 * anti-idle challenges, jobs, credits, certificates, API/UI.
 *
 * Discipline:
 *   - org_id TEXT NOT NULL with no database default
 *   - UUID primary keys
 *   - UNIQUE(org_id, id) on every referenced parent
 *   - child FKs are same-org (and same-version / same-user where listed),
 *     ON DELETE RESTRICT, named
 *   - assignment members are point-in-time facts (identity/source/assigned_at
 *     immutable; DELETE forbidden; INSERT with a populated revoke triplet is
 *     refused; only a clean insert followed by one null→complete revoke)
 *   - new assignments lock the exact same-org course version FOR SHARE and
 *     accept only status=published; draft/retired new assignments fail;
 *     an existing assignment remains valid after that version is retired
 *   - deadline expiry does not revoke
 *   - client events are start|heartbeat only (no completed kind)
 *   - progress events pin the parent session identity (same org/session/
 *     version/item/user), ON DELETE RESTRICT
 *   - V0.1 required_at_completion must be true
 *   - completion evidence is append-only
 *
 * Actor columns (assigned_by / user_id / revoked_by) are TEXT. They are not
 * foreign keys to users.id.
 */

export const ELEARNING_V01_WATCH_TABLES = [
  'elearning_assignments',
  'elearning_assignment_members',
  'elearning_learning_sessions',
  'elearning_progress_events',
  'elearning_progress',
  'elearning_completion_evidence',
] as const

export const ASSIGNMENT_MEMBERS_PIT_FN = 'elearning_assignment_members_point_in_time'
export const ASSIGNMENT_MEMBERS_PIT_TRIGGER = 'trg_elearning_assignment_members_point_in_time'
export const ASSIGNMENTS_PUBLISHED_VERSION_FN = 'elearning_assignments_published_version'
export const ASSIGNMENTS_PUBLISHED_VERSION_TRIGGER = 'trg_elearning_assignments_published_version'
export const COMPLETION_EVIDENCE_DENY_FN = 'elearning_completion_evidence_deny_mutation'
export const COMPLETION_EVIDENCE_DENY_TRIGGER = 'trg_elearning_completion_evidence_deny_mutation'
export const LEARNING_SESSIONS_ONE_ACTIVE_INDEX =
  'idx_elearning_learning_sessions_one_active_per_user_item'

export const ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS = [
  {
    table: 'elearning_completion_evidence',
    name: COMPLETION_EVIDENCE_DENY_TRIGGER,
    fn: COMPLETION_EVIDENCE_DENY_FN,
  },
  {
    table: 'elearning_assignment_members',
    name: ASSIGNMENT_MEMBERS_PIT_TRIGGER,
    fn: ASSIGNMENT_MEMBERS_PIT_FN,
  },
  {
    table: 'elearning_assignments',
    name: ASSIGNMENTS_PUBLISHED_VERSION_TRIGGER,
    fn: ASSIGNMENTS_PUBLISHED_VERSION_FN,
  },
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      course_version_id uuid NOT NULL,
      source_key text NOT NULL,
      request_hash text NOT NULL,
      request_hash_version integer NOT NULL,
      deadline timestamptz,
      assigned_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_assignments_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_assignments_org_source_key_uniq UNIQUE (org_id, source_key),
      CONSTRAINT elearning_assignments_org_id_course_version_uniq
        UNIQUE (org_id, id, course_version_id),
      CONSTRAINT elearning_assignments_source_key_nonempty_chk
        CHECK (btrim(source_key) <> ''),
      CONSTRAINT elearning_assignments_request_hash_nonempty_chk
        CHECK (btrim(request_hash) <> ''),
      CONSTRAINT elearning_assignments_request_hash_version_chk
        CHECK (request_hash_version >= 1),
      CONSTRAINT elearning_assignments_assigned_by_nonempty_chk
        CHECK (btrim(assigned_by) <> ''),
      CONSTRAINT elearning_assignments_version_fk
        FOREIGN KEY (org_id, course_version_id)
        REFERENCES elearning_course_versions (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_assignments_published_version()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      version_status text;
    BEGIN
      IF TG_OP = 'UPDATE'
         AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
         AND NEW.course_version_id IS NOT DISTINCT FROM OLD.course_version_id THEN
        RETURN NEW;
      END IF;

      SELECT status INTO version_status
        FROM elearning_course_versions
       WHERE org_id = NEW.org_id
         AND id = NEW.course_version_id
       FOR SHARE;

      IF NOT FOUND THEN
        RETURN NEW;
      END IF;

      IF version_status IS DISTINCT FROM 'published' THEN
        RAISE EXCEPTION 'elearning_assignments.course_version_id must reference a published course version';
      END IF;

      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_assignments_published_version
      ON elearning_assignments
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_assignments_published_version
      BEFORE INSERT OR UPDATE ON elearning_assignments
      FOR EACH ROW
      EXECUTE FUNCTION elearning_assignments_published_version()
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_assignment_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      assignment_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      user_id text NOT NULL,
      source text NOT NULL,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      revoked_by text,
      revocation_reason text,
      CONSTRAINT elearning_assignment_members_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_assignment_members_org_id_version_user_uniq
        UNIQUE (org_id, id, course_version_id, user_id),
      CONSTRAINT elearning_assignment_members_org_assignment_user_uniq
        UNIQUE (org_id, assignment_id, user_id),
      CONSTRAINT elearning_assignment_members_source_chk
        CHECK (source IN ('manual', 'rule', 'import')),
      CONSTRAINT elearning_assignment_members_user_id_nonempty_chk
        CHECK (btrim(user_id) <> ''),
      CONSTRAINT elearning_assignment_members_revoke_triplet_chk
        CHECK (
          (
            revoked_at IS NULL
            AND revoked_by IS NULL
            AND revocation_reason IS NULL
          )
          OR
          (
            revoked_at IS NOT NULL
            AND revoked_by IS NOT NULL
            AND btrim(revoked_by) <> ''
            AND revocation_reason IS NOT NULL
            AND btrim(revocation_reason) <> ''
          )
        ),
      CONSTRAINT elearning_assignment_members_assignment_version_fk
        FOREIGN KEY (org_id, assignment_id, course_version_id)
        REFERENCES elearning_assignments (org_id, id, course_version_id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_assignment_members_point_in_time()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'elearning_assignment_members is a point-in-time fact: DELETE is not permitted';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.revoked_at IS NOT NULL
           OR NEW.revoked_by IS NOT NULL
           OR NEW.revocation_reason IS NOT NULL THEN
          RAISE EXCEPTION 'elearning_assignment_members cannot be inserted already revoked';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
         OR NEW.course_version_id IS DISTINCT FROM OLD.course_version_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.source IS DISTINCT FROM OLD.source
         OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
        RAISE EXCEPTION 'elearning_assignment_members identity/source/assigned_at are immutable';
      END IF;

      IF OLD.revoked_at IS NOT NULL THEN
        IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
           OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
           OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason THEN
          RAISE EXCEPTION 'elearning_assignment_members revoke fields cannot be changed after revoke';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_assignment_members_point_in_time
      ON elearning_assignment_members
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_assignment_members_point_in_time
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_assignment_members
      FOR EACH ROW
      EXECUTE FUNCTION elearning_assignment_members_point_in_time()
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_learning_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      assignment_member_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      user_id text NOT NULL,
      status text NOT NULL,
      last_sequence integer NOT NULL,
      last_client_position_ms bigint NOT NULL,
      effective_ms bigint NOT NULL,
      max_position_ms bigint NOT NULL,
      rolling_event_digest text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      last_event_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz,
      CONSTRAINT elearning_learning_sessions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_learning_sessions_org_id_id_version_item_user_uniq
        UNIQUE (org_id, id, course_version_id, course_version_item_id, user_id),
      CONSTRAINT elearning_learning_sessions_status_chk
        CHECK (status IN ('active', 'completed', 'closed')),
      CONSTRAINT elearning_learning_sessions_active_closed_chk
        CHECK (
          (status = 'active' AND closed_at IS NULL)
          OR
          (status IN ('completed', 'closed') AND closed_at IS NOT NULL)
        ),
      CONSTRAINT elearning_learning_sessions_last_sequence_nonneg_chk
        CHECK (last_sequence >= 0),
      CONSTRAINT elearning_learning_sessions_last_client_position_ms_nonneg_chk
        CHECK (last_client_position_ms >= 0),
      CONSTRAINT elearning_learning_sessions_effective_ms_nonneg_chk
        CHECK (effective_ms >= 0),
      CONSTRAINT elearning_learning_sessions_max_position_ms_nonneg_chk
        CHECK (max_position_ms >= 0),
      CONSTRAINT elearning_learning_sessions_rolling_event_digest_nonempty_chk
        CHECK (btrim(rolling_event_digest) <> ''),
      CONSTRAINT elearning_learning_sessions_user_id_nonempty_chk
        CHECK (btrim(user_id) <> ''),
      CONSTRAINT elearning_learning_sessions_member_identity_fk
        FOREIGN KEY (org_id, assignment_member_id, course_version_id, user_id)
        REFERENCES elearning_assignment_members (org_id, id, course_version_id, user_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_learning_sessions_item_version_fk
        FOREIGN KEY (org_id, course_version_id, course_version_item_id)
        REFERENCES elearning_course_version_items (org_id, course_version_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_elearning_learning_sessions_one_active_per_user_item
      ON elearning_learning_sessions (org_id, user_id, course_version_item_id)
      WHERE status = 'active'
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_progress_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      session_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      user_id text NOT NULL,
      sequence integer NOT NULL,
      kind text NOT NULL,
      reported_position_ms bigint NOT NULL,
      playing boolean NOT NULL,
      credited_ms bigint NOT NULL,
      event_digest text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_progress_events_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_progress_events_org_session_sequence_uniq
        UNIQUE (org_id, session_id, sequence),
      CONSTRAINT elearning_progress_events_kind_chk
        CHECK (kind IN ('start', 'heartbeat')),
      CONSTRAINT elearning_progress_events_sequence_nonneg_chk
        CHECK (sequence >= 0),
      CONSTRAINT elearning_progress_events_reported_position_ms_nonneg_chk
        CHECK (reported_position_ms >= 0),
      CONSTRAINT elearning_progress_events_credited_ms_nonneg_chk
        CHECK (credited_ms >= 0),
      CONSTRAINT elearning_progress_events_event_digest_nonempty_chk
        CHECK (btrim(event_digest) <> ''),
      CONSTRAINT elearning_progress_events_user_id_nonempty_chk
        CHECK (btrim(user_id) <> ''),
      CONSTRAINT elearning_progress_events_session_identity_fk
        FOREIGN KEY (org_id, session_id, course_version_id, course_version_item_id, user_id)
        REFERENCES elearning_learning_sessions (org_id, id, course_version_id, course_version_item_id, user_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_progress_events_item_version_fk
        FOREIGN KEY (org_id, course_version_id, course_version_item_id)
        REFERENCES elearning_course_version_items (org_id, course_version_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_progress (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      assignment_member_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      user_id text NOT NULL,
      status text NOT NULL,
      effective_ms bigint NOT NULL,
      max_position_ms bigint NOT NULL,
      completed_at timestamptz,
      required_at_completion boolean NOT NULL,
      CONSTRAINT elearning_progress_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_progress_org_user_item_uniq
        UNIQUE (org_id, user_id, course_version_item_id),
      CONSTRAINT elearning_progress_status_chk
        CHECK (status IN ('in_progress', 'completed')),
      CONSTRAINT elearning_progress_completed_iff_chk
        CHECK (
          (status = 'completed' AND completed_at IS NOT NULL)
          OR
          (status = 'in_progress' AND completed_at IS NULL)
        ),
      CONSTRAINT elearning_progress_required_at_completion_chk
        CHECK (required_at_completion IS TRUE),
      CONSTRAINT elearning_progress_effective_ms_nonneg_chk
        CHECK (effective_ms >= 0),
      CONSTRAINT elearning_progress_max_position_ms_nonneg_chk
        CHECK (max_position_ms >= 0),
      CONSTRAINT elearning_progress_user_id_nonempty_chk
        CHECK (btrim(user_id) <> ''),
      CONSTRAINT elearning_progress_member_identity_fk
        FOREIGN KEY (org_id, assignment_member_id, course_version_id, user_id)
        REFERENCES elearning_assignment_members (org_id, id, course_version_id, user_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_progress_item_version_fk
        FOREIGN KEY (org_id, course_version_id, course_version_item_id)
        REFERENCES elearning_course_version_items (org_id, course_version_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS elearning_completion_evidence (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      assignment_member_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      user_id text NOT NULL,
      completion_policy_version text NOT NULL,
      completion_threshold_bps integer NOT NULL,
      media_duration_ms bigint NOT NULL,
      effective_ms bigint NOT NULL,
      max_position_ms bigint NOT NULL,
      event_digest text NOT NULL,
      evaluator_version text NOT NULL,
      completed_at timestamptz NOT NULL,
      CONSTRAINT elearning_completion_evidence_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_completion_evidence_org_user_item_uniq
        UNIQUE (org_id, user_id, course_version_item_id),
      CONSTRAINT elearning_completion_evidence_policy_version_nonempty_chk
        CHECK (btrim(completion_policy_version) <> ''),
      CONSTRAINT elearning_completion_evidence_threshold_bps_chk
        CHECK (completion_threshold_bps >= 1 AND completion_threshold_bps <= 10000),
      CONSTRAINT elearning_completion_evidence_media_duration_ms_nonneg_chk
        CHECK (media_duration_ms >= 0),
      CONSTRAINT elearning_completion_evidence_effective_ms_nonneg_chk
        CHECK (effective_ms >= 0),
      CONSTRAINT elearning_completion_evidence_max_position_ms_nonneg_chk
        CHECK (max_position_ms >= 0),
      CONSTRAINT elearning_completion_evidence_event_digest_nonempty_chk
        CHECK (btrim(event_digest) <> ''),
      CONSTRAINT elearning_completion_evidence_evaluator_version_nonempty_chk
        CHECK (btrim(evaluator_version) <> ''),
      CONSTRAINT elearning_completion_evidence_user_id_nonempty_chk
        CHECK (btrim(user_id) <> ''),
      CONSTRAINT elearning_completion_evidence_member_identity_fk
        FOREIGN KEY (org_id, assignment_member_id, course_version_id, user_id)
        REFERENCES elearning_assignment_members (org_id, id, course_version_id, user_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_completion_evidence_item_version_fk
        FOREIGN KEY (org_id, course_version_id, course_version_item_id)
        REFERENCES elearning_course_version_items (org_id, course_version_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_completion_evidence_deny_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'elearning_completion_evidence is append-only: % is not permitted', TG_OP;
    END;
    $$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_completion_evidence_deny_mutation
      ON elearning_completion_evidence
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_completion_evidence_deny_mutation
      BEFORE UPDATE OR DELETE ON elearning_completion_evidence
      FOR EACH ROW
      EXECUTE FUNCTION elearning_completion_evidence_deny_mutation()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_completion_evidence_deny_mutation
      ON elearning_completion_evidence
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_completion_evidence_deny_mutation()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_completion_evidence`.execute(db)

  await sql`DROP TABLE IF EXISTS elearning_progress`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_progress_events`.execute(db)

  await sql`
    DROP INDEX IF EXISTS idx_elearning_learning_sessions_one_active_per_user_item
  `.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_learning_sessions`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_assignment_members_point_in_time
      ON elearning_assignment_members
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_assignment_members_point_in_time()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_assignment_members`.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_elearning_assignments_published_version
      ON elearning_assignments
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS elearning_assignments_published_version()`.execute(db)
  await sql`DROP TABLE IF EXISTS elearning_assignments`.execute(db)
}
