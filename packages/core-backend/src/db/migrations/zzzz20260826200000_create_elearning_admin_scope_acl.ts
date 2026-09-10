import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import { ensureCanonicalUserOrgsTable } from './_ensure-user-orgs'

/**
 * E-learning L2 delegated administration foundation.
 *
 * Admin scopes and object collaboration grants are historical facts. Active
 * rows may only transition once to a complete revocation triplet; deletes and
 * identity edits are refused. Directory ownership is proven through existing
 * composite directory keys instead of trusting a denormalized org_id.
 */
export const ELEARNING_ADMIN_SCOPES_TABLE = 'elearning_admin_scopes'
export const ELEARNING_OBJECT_ACL_TABLE = 'elearning_object_acl'
export const ELEARNING_ADMIN_SCOPE_STATE_FN = 'elearning_admin_scope_state_guard'
export const ELEARNING_ADMIN_SCOPE_STATE_TRIGGER = 'trg_elearning_admin_scope_state_guard'
export const ELEARNING_OBJECT_ACL_STATE_FN = 'elearning_object_acl_state_guard'
export const ELEARNING_OBJECT_ACL_STATE_TRIGGER = 'trg_elearning_object_acl_state_guard'
export const ELEARNING_ADMIN_SCOPE_ACTIVE_UNIQ = 'elearning_admin_scopes_active_uniq'
export const ELEARNING_OBJECT_ACL_COURSE_ACTIVE_UNIQ =
  'elearning_object_acl_course_active_uniq'
export const ELEARNING_OBJECT_ACL_PLAN_ACTIVE_UNIQ =
  'elearning_object_acl_plan_active_uniq'
export const ELEARNING_ADMIN_SCOPE_ACL_DOWN_IN_USE =
  'ELEARNING_ADMIN_SCOPE_ACL_DOWN_IN_USE'

export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureCanonicalUserOrgsTable(db)
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE elearning_admin_scopes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      user_id text NOT NULL,
      directory_integration_id uuid NOT NULL,
      directory_provider text NOT NULL,
      directory_department_id uuid NOT NULL,
      include_children boolean NOT NULL,
      granted_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      revoked_by text,
      revocation_reason text,
      CONSTRAINT elearning_admin_scopes_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_admin_scopes_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_admin_scopes_user_id_chk
        CHECK (btrim(user_id) <> '' AND user_id = btrim(user_id)),
      CONSTRAINT elearning_admin_scopes_provider_chk
        CHECK (
          btrim(directory_provider) <> ''
          AND directory_provider = btrim(directory_provider)
        ),
      CONSTRAINT elearning_admin_scopes_granted_by_chk
        CHECK (btrim(granted_by) <> '' AND granted_by = btrim(granted_by)),
      CONSTRAINT elearning_admin_scopes_revoke_triplet_chk
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
            AND char_length(revocation_reason) <= 500
          )
        ),
      CONSTRAINT elearning_admin_scopes_user_org_fk
        FOREIGN KEY (user_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_admin_scopes_granter_org_fk
        FOREIGN KEY (granted_by, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_admin_scopes_revoker_org_fk
        FOREIGN KEY (revoked_by, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_admin_scopes_integration_org_fk
        FOREIGN KEY (directory_integration_id, org_id)
        REFERENCES directory_integrations (id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_admin_scopes_integration_provider_fk
        FOREIGN KEY (directory_integration_id, directory_provider)
        REFERENCES directory_integrations (id, provider)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_admin_scopes_department_fk
        FOREIGN KEY (
          directory_department_id,
          directory_integration_id,
          directory_provider
        )
        REFERENCES directory_departments (id, integration_id, provider)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX elearning_admin_scopes_active_uniq
      ON elearning_admin_scopes (
        org_id,
        user_id,
        directory_department_id
      )
      WHERE revoked_at IS NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_admin_scopes_active_user
      ON elearning_admin_scopes (org_id, user_id, directory_department_id)
      WHERE revoked_at IS NULL
  `.execute(db)

  await sql`
    CREATE TABLE elearning_object_acl (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      course_id uuid,
      training_plan_id uuid,
      grantee_user_id text NOT NULL,
      action text NOT NULL,
      granted_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      revoked_by text,
      revocation_reason text,
      CONSTRAINT elearning_object_acl_org_id_id_uniq UNIQUE (org_id, id),
      CONSTRAINT elearning_object_acl_org_id_chk
        CHECK (btrim(org_id) <> '' AND org_id = btrim(org_id)),
      CONSTRAINT elearning_object_acl_object_xor_chk
        CHECK (
          (course_id IS NOT NULL)::integer
          + (training_plan_id IS NOT NULL)::integer = 1
        ),
      CONSTRAINT elearning_object_acl_grantee_chk
        CHECK (
          btrim(grantee_user_id) <> ''
          AND grantee_user_id = btrim(grantee_user_id)
        ),
      CONSTRAINT elearning_object_acl_action_chk
        CHECK (action IN ('assign', 'scope', 'track')),
      CONSTRAINT elearning_object_acl_granted_by_chk
        CHECK (btrim(granted_by) <> '' AND granted_by = btrim(granted_by)),
      CONSTRAINT elearning_object_acl_revoke_triplet_chk
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
            AND char_length(revocation_reason) <= 500
          )
        ),
      CONSTRAINT elearning_object_acl_course_fk
        FOREIGN KEY (org_id, course_id)
        REFERENCES elearning_courses (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_object_acl_training_plan_fk
        FOREIGN KEY (org_id, training_plan_id)
        REFERENCES elearning_training_plans (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_object_acl_grantee_org_fk
        FOREIGN KEY (grantee_user_id, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_object_acl_granter_org_fk
        FOREIGN KEY (granted_by, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON DELETE RESTRICT,
      CONSTRAINT elearning_object_acl_revoker_org_fk
        FOREIGN KEY (revoked_by, org_id)
        REFERENCES user_orgs (user_id, org_id)
        ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX elearning_object_acl_course_active_uniq
      ON elearning_object_acl (org_id, course_id, grantee_user_id, action)
      WHERE course_id IS NOT NULL AND revoked_at IS NULL
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX elearning_object_acl_plan_active_uniq
      ON elearning_object_acl (
        org_id,
        training_plan_id,
        grantee_user_id,
        action
      )
      WHERE training_plan_id IS NOT NULL AND revoked_at IS NULL
  `.execute(db)
  await sql`
    CREATE INDEX idx_elearning_object_acl_active_grantee
      ON elearning_object_acl (org_id, grantee_user_id, action)
      WHERE revoked_at IS NULL
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_admin_scope_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'elearning admin scopes are historical facts';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.revoked_at IS NOT NULL
           OR NEW.revoked_by IS NOT NULL
           OR NEW.revocation_reason IS NOT NULL THEN
          RAISE EXCEPTION 'elearning admin scopes cannot start revoked';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.directory_integration_id IS DISTINCT FROM OLD.directory_integration_id
         OR NEW.directory_provider IS DISTINCT FROM OLD.directory_provider
         OR NEW.directory_department_id IS DISTINCT FROM OLD.directory_department_id
         OR NEW.include_children IS DISTINCT FROM OLD.include_children
         OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning admin scope identity is immutable';
      END IF;
      IF OLD.revoked_at IS NOT NULL
         OR NEW.revoked_at IS NULL
         OR NEW.revoked_by IS NULL
         OR btrim(NEW.revoked_by) = ''
         OR NEW.revocation_reason IS NULL
         OR btrim(NEW.revocation_reason) = ''
         OR char_length(NEW.revocation_reason) > 500 THEN
        RAISE EXCEPTION 'elearning admin scope revocation is one-way';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_admin_scope_state_guard
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_admin_scopes
      FOR EACH ROW
      EXECUTE FUNCTION elearning_admin_scope_state_guard()
  `.execute(db)

  await sql`
    CREATE FUNCTION elearning_object_acl_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'elearning object ACL rows are historical facts';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.revoked_at IS NOT NULL
           OR NEW.revoked_by IS NOT NULL
           OR NEW.revocation_reason IS NOT NULL THEN
          RAISE EXCEPTION 'elearning object ACL rows cannot start revoked';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.course_id IS DISTINCT FROM OLD.course_id
         OR NEW.training_plan_id IS DISTINCT FROM OLD.training_plan_id
         OR NEW.grantee_user_id IS DISTINCT FROM OLD.grantee_user_id
         OR NEW.action IS DISTINCT FROM OLD.action
         OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'elearning object ACL identity is immutable';
      END IF;
      IF OLD.revoked_at IS NOT NULL
         OR NEW.revoked_at IS NULL
         OR NEW.revoked_by IS NULL
         OR btrim(NEW.revoked_by) = ''
         OR NEW.revocation_reason IS NULL
         OR btrim(NEW.revocation_reason) = ''
         OR char_length(NEW.revocation_reason) > 500 THEN
        RAISE EXCEPTION 'elearning object ACL revocation is one-way';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_elearning_object_acl_state_guard
      BEFORE INSERT OR UPDATE OR DELETE ON elearning_object_acl
      FOR EACH ROW
      EXECUTE FUNCTION elearning_object_acl_state_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    LOCK TABLE elearning_admin_scopes, elearning_object_acl
      IN SHARE ROW EXCLUSIVE MODE
  `.execute(db)
  await sql`
    DO $fn$
    BEGIN
      IF EXISTS (SELECT 1 FROM elearning_admin_scopes)
         OR EXISTS (SELECT 1 FROM elearning_object_acl) THEN
        RAISE EXCEPTION 'ELEARNING_ADMIN_SCOPE_ACL_DOWN_IN_USE';
      END IF;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER trg_elearning_object_acl_state_guard ON elearning_object_acl
  `.execute(db)
  await sql`DROP FUNCTION elearning_object_acl_state_guard()`.execute(db)
  await sql`
    DROP TRIGGER trg_elearning_admin_scope_state_guard ON elearning_admin_scopes
  `.execute(db)
  await sql`DROP FUNCTION elearning_admin_scope_state_guard()`.execute(db)
  await sql`DROP TABLE elearning_object_acl`.execute(db)
  await sql`DROP TABLE elearning_admin_scopes`.execute(db)
}
