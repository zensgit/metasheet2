/**
 * A1 — History Field-Audit Permission: the governed grant store.
 *
 * Design-lock: docs/development/multitable-history-field-audit-permission-design-lock-20260620.md (#2973).
 * A grant is the ONLY thing that can later (A2) lift the history field mask for a subject on a base. It is
 * issued ONLY by a holder of the `multitable:history-field-audit:grant` platform capability (never base-admin;
 * issuer != grantee), is default-finite (D5), and carries the issue `reason` (L8). This migration adds the
 * store only; A1 does NOT wire any reveal into the history mask (the resolver returns no-reveal).
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS meta_history_audit_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id text NOT NULL,
      subject_type text NOT NULL CHECK (subject_type IN ('user', 'role', 'member-group')),
      subject_id text NOT NULL,
      granted_by text NOT NULL,
      reason text,
      ticket text,
      -- D5: default-finite. expires_at NULL is allowed ONLY when is_standing = true (an explicit choice,
      -- marked here and in the audit trail); the issue route applies a finite default otherwise.
      expires_at timestamptz,
      is_standing boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      revoked_by text,
      CONSTRAINT meta_history_audit_grants_standing_or_finite
        CHECK (is_standing = true OR expires_at IS NOT NULL)
    )
  `.execute(db)

  // One ACTIVE grant per (base, subject); revoked rows are retained for in-table lineage but do not block a
  // fresh grant. A2's resolver reads only active, non-expired rows.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_history_audit_grants_active
      ON meta_history_audit_grants (base_id, subject_type, subject_id)
      WHERE revoked_at IS NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_history_audit_grants_lookup
      ON meta_history_audit_grants (base_id, subject_type, subject_id, revoked_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_history_audit_grants CASCADE`.execute(db)
}
