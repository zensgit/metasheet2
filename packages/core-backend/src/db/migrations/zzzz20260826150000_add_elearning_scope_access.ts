import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * L1 visibility foundation.
 *
 * Scope rules are immutable revision rows. Runtime access reads only the
 * active revision; assignment access remains independent. Session/progress
 * rows carry the current access basis, while immutable completion evidence
 * freezes exactly one basis through database-enforced same-org foreign keys.
 */

export const ELEARNING_SCOPES_TABLE = 'elearning_scopes'
export const ELEARNING_SCOPE_REVISIONS_TABLE = 'elearning_scope_revisions'
export const ELEARNING_SCOPE_REVISION_RULES_TABLE = 'elearning_scope_revision_rules'
export const SCOPE_RULES_NULL_IDENTITY_INDEX =
  'uq_elearning_scope_revision_rules_null_identity'
export const SCOPE_RULES_REF_IDENTITY_INDEX =
  'uq_elearning_scope_revision_rules_ref_identity'

export const SCOPE_REVISIONS_DENY_MUTATION_FN =
  'elearning_scope_revisions_deny_mutation'
export const SCOPE_REVISIONS_DENY_MUTATION_TRIGGER =
  'trg_elearning_scope_revisions_deny_mutation'
export const SCOPE_RULES_DENY_MUTATION_FN =
  'elearning_scope_revision_rules_deny_mutation'
export const SCOPE_RULES_DENY_MUTATION_TRIGGER =
  'trg_elearning_scope_revision_rules_deny_mutation'
export const COURSE_SCOPE_IDENTITY_FN = 'elearning_courses_scope_identity_guard'
export const COURSE_SCOPE_IDENTITY_TRIGGER = 'trg_elearning_courses_scope_identity_guard'

const BASIS_TABLES = [
  'elearning_learning_sessions',
  'elearning_progress',
  'elearning_completion_evidence',
] as const

async function lockExistingTables(db: Kysely<unknown>): Promise<void> {
  // Matches the learning write path: course before session/progress/evidence.
  await sql`LOCK TABLE elearning_courses IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_learning_sessions IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_progress IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_completion_evidence IN ACCESS EXCLUSIVE MODE`.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE elearning_scopes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      active_revision_id uuid,
      latest_revision_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_scopes_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_scopes_created_by_nonempty_chk
        CHECK (btrim(created_by) <> '')
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_scope_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      scope_id uuid NOT NULL,
      revision integer NOT NULL,
      actor_id text NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_scope_revisions_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_scope_revisions_org_scope_id_id_uniq
        UNIQUE (org_id, scope_id, id),
      CONSTRAINT elearning_scope_revisions_org_scope_revision_uniq
        UNIQUE (org_id, scope_id, revision),
      CONSTRAINT elearning_scope_revisions_revision_chk CHECK (revision >= 1),
      CONSTRAINT elearning_scope_revisions_actor_nonempty_chk
        CHECK (btrim(actor_id) <> ''),
      CONSTRAINT elearning_scope_revisions_reason_nonempty_chk
        CHECK (btrim(reason) <> ''),
      CONSTRAINT elearning_scope_revisions_scope_fk
        FOREIGN KEY (org_id, scope_id)
        REFERENCES elearning_scopes (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE TABLE elearning_scope_revision_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      scope_revision_id uuid NOT NULL,
      subject_type text NOT NULL,
      subject_ref text,
      include_children boolean NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT elearning_scope_revision_rules_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_scope_revision_rules_subject_type_chk
        CHECK (subject_type IN ('all', 'department', 'position', 'role', 'user')),
      CONSTRAINT elearning_scope_revision_rules_subject_shape_chk
        CHECK (
          (subject_type = 'all' AND subject_ref IS NULL AND include_children IS FALSE)
          OR
          (
            subject_type <> 'all'
            AND subject_ref IS NOT NULL
            AND btrim(subject_ref) <> ''
          )
        ),
      CONSTRAINT elearning_scope_revision_rules_revision_fk
        FOREIGN KEY (org_id, scope_revision_id)
        REFERENCES elearning_scope_revisions (org_id, id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  // PostgreSQL 14 does not support UNIQUE NULLS NOT DISTINCT. Two partial
  // indexes preserve the same identity contract on every supported runtime.
  await sql`
    CREATE UNIQUE INDEX uq_elearning_scope_revision_rules_null_identity
      ON elearning_scope_revision_rules (
        org_id,
        scope_revision_id,
        subject_type,
        include_children
      )
      WHERE subject_ref IS NULL
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX uq_elearning_scope_revision_rules_ref_identity
      ON elearning_scope_revision_rules (
        org_id,
        scope_revision_id,
        subject_type,
        subject_ref,
        include_children
      )
      WHERE subject_ref IS NOT NULL
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_scope_revision_rules_lookup
      ON elearning_scope_revision_rules (
        org_id,
        scope_revision_id,
        subject_type,
        subject_ref
      )
  `.execute(db)

  await sql`
    ALTER TABLE elearning_scopes
      ADD CONSTRAINT elearning_scopes_active_revision_fk
      FOREIGN KEY (org_id, id, active_revision_id)
      REFERENCES elearning_scope_revisions (org_id, scope_id, id)
      ON DELETE RESTRICT
  `.execute(db)

  await sql`
    ALTER TABLE elearning_scopes
      ADD CONSTRAINT elearning_scopes_latest_revision_fk
      FOREIGN KEY (org_id, id, latest_revision_id)
      REFERENCES elearning_scope_revisions (org_id, scope_id, id)
      ON DELETE RESTRICT
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_scope_revisions_deny_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'elearning_scope_revisions is immutable: % is not permitted', TG_OP;
    END;
    $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_scope_revisions_deny_mutation
      BEFORE UPDATE OR DELETE ON elearning_scope_revisions
      FOR EACH ROW
      EXECUTE FUNCTION elearning_scope_revisions_deny_mutation()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_scope_revision_rules_deny_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'elearning_scope_revision_rules is immutable: % is not permitted', TG_OP;
    END;
    $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_scope_revision_rules_deny_mutation
      BEFORE UPDATE OR DELETE ON elearning_scope_revision_rules
      FOR EACH ROW
      EXECUTE FUNCTION elearning_scope_revision_rules_deny_mutation()
  `.execute(db)

  await lockExistingTables(db)

  await sql`ALTER TABLE elearning_courses ADD COLUMN scope_id uuid`.execute(db)
  await sql`
    ALTER TABLE elearning_courses
      ADD CONSTRAINT elearning_courses_scope_fk
      FOREIGN KEY (org_id, scope_id)
      REFERENCES elearning_scopes (org_id, id)
      ON DELETE RESTRICT
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION elearning_courses_scope_identity_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.scope_id IS NOT NULL AND NEW.scope_id IS DISTINCT FROM OLD.scope_id THEN
        RAISE EXCEPTION 'elearning_courses.scope_id is stable once assigned';
      END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_elearning_courses_scope_identity_guard
      BEFORE UPDATE OF scope_id ON elearning_courses
      FOR EACH ROW
      EXECUTE FUNCTION elearning_courses_scope_identity_guard()
  `.execute(db)

  for (const table of BASIS_TABLES) {
    await sql.raw(`ALTER TABLE ${table} ADD COLUMN scope_revision_rule_id uuid`).execute(db)
    await sql.raw(`ALTER TABLE ${table} ALTER COLUMN assignment_member_id DROP NOT NULL`).execute(db)
    await sql.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_scope_rule_fk
        FOREIGN KEY (org_id, scope_revision_rule_id)
        REFERENCES elearning_scope_revision_rules (org_id, id)
        ON DELETE RESTRICT
    `).execute(db)
    await sql.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_access_basis_xor_chk
        CHECK (
          ((assignment_member_id IS NOT NULL)::integer
            + (scope_revision_rule_id IS NOT NULL)::integer) = 1
        )
    `).execute(db)
  }

  await sql`
    ALTER TABLE elearning_progress
      DROP CONSTRAINT elearning_progress_required_at_completion_chk
  `.execute(db)
  await sql`
    ALTER TABLE elearning_progress
      ADD CONSTRAINT elearning_progress_required_access_basis_chk
      CHECK (required_at_completion = (assignment_member_id IS NOT NULL))
  `.execute(db)

  await sql`
    CREATE INDEX idx_elearning_learning_sessions_scope_rule
      ON elearning_learning_sessions (org_id, scope_revision_rule_id)
      WHERE scope_revision_rule_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_progress_scope_rule
      ON elearning_progress (org_id, scope_revision_rule_id)
      WHERE scope_revision_rule_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_completion_evidence_scope_rule
      ON elearning_completion_evidence (org_id, scope_revision_rule_id)
      WHERE scope_revision_rule_id IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await lockExistingTables(db)
  await sql`LOCK TABLE elearning_scopes IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_scope_revisions IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`LOCK TABLE elearning_scope_revision_rules IN ACCESS EXCLUSIVE MODE`.execute(db)

  const used = await sql<{
    scoped_courses: string
    scoped_sessions: string
    scoped_progress: string
    scoped_evidence: string
    non_required_progress: string
  }>`
    SELECT
      (SELECT count(*)::text FROM elearning_courses WHERE scope_id IS NOT NULL) AS scoped_courses,
      (SELECT count(*)::text FROM elearning_learning_sessions WHERE scope_revision_rule_id IS NOT NULL) AS scoped_sessions,
      (SELECT count(*)::text FROM elearning_progress WHERE scope_revision_rule_id IS NOT NULL) AS scoped_progress,
      (SELECT count(*)::text FROM elearning_completion_evidence WHERE scope_revision_rule_id IS NOT NULL) AS scoped_evidence,
      (SELECT count(*)::text FROM elearning_progress WHERE required_at_completion IS NOT TRUE) AS non_required_progress
  `.execute(db)
  const row = used.rows[0]
  if (
    !row
    || row.scoped_courses !== '0'
    || row.scoped_sessions !== '0'
    || row.scoped_progress !== '0'
    || row.scoped_evidence !== '0'
    || row.non_required_progress !== '0'
  ) {
    throw new Error('ELEARNING_SCOPE_ACCESS_DOWN_IN_USE')
  }

  await sql`DROP INDEX idx_elearning_completion_evidence_scope_rule`.execute(db)
  await sql`DROP INDEX idx_elearning_progress_scope_rule`.execute(db)
  await sql`DROP INDEX idx_elearning_learning_sessions_scope_rule`.execute(db)

  await sql`
    ALTER TABLE elearning_progress
      DROP CONSTRAINT elearning_progress_required_access_basis_chk
  `.execute(db)
  await sql`
    ALTER TABLE elearning_progress
      ADD CONSTRAINT elearning_progress_required_at_completion_chk
      CHECK (required_at_completion IS TRUE)
  `.execute(db)

  for (const table of [...BASIS_TABLES].reverse()) {
    await sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_access_basis_xor_chk`).execute(db)
    await sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_scope_rule_fk`).execute(db)
    await sql.raw(`ALTER TABLE ${table} DROP COLUMN scope_revision_rule_id`).execute(db)
    await sql.raw(`ALTER TABLE ${table} ALTER COLUMN assignment_member_id SET NOT NULL`).execute(db)
  }

  await sql`
    DROP TRIGGER trg_elearning_courses_scope_identity_guard ON elearning_courses
  `.execute(db)
  await sql`DROP FUNCTION elearning_courses_scope_identity_guard()`.execute(db)
  await sql`ALTER TABLE elearning_courses DROP CONSTRAINT elearning_courses_scope_fk`.execute(db)
  await sql`ALTER TABLE elearning_courses DROP COLUMN scope_id`.execute(db)

  await sql`
    DROP TRIGGER trg_elearning_scope_revision_rules_deny_mutation
      ON elearning_scope_revision_rules
  `.execute(db)
  await sql`DROP FUNCTION elearning_scope_revision_rules_deny_mutation()`.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_scope_revisions_deny_mutation
      ON elearning_scope_revisions
  `.execute(db)
  await sql`DROP FUNCTION elearning_scope_revisions_deny_mutation()`.execute(db)

  await sql`ALTER TABLE elearning_scopes DROP CONSTRAINT elearning_scopes_latest_revision_fk`.execute(db)
  await sql`ALTER TABLE elearning_scopes DROP CONSTRAINT elearning_scopes_active_revision_fk`.execute(db)
  await sql`DROP TABLE elearning_scope_revision_rules`.execute(db)
  await sql`DROP TABLE elearning_scope_revisions`.execute(db)
  await sql`DROP TABLE elearning_scopes`.execute(db)
}
