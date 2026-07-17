import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Canonical Org MVP — B5-a (routing policy schema), #4215 §6 + B5/B6 design lock
 * (`canonical-org-b5-b6-routing-core-design-lock-20260717.md`, Lock 1).
 *
 * `org_directory_routing_policy` stores the owner-ruled explicit `(org, purpose)` routing policy:
 * when an org has MORE THAN ONE directory integration (possible since B1 introduced
 * `provider='local'` alongside DingTalk), the canonical source for each purpose is chosen by THIS
 * stored policy — never by array position / "latest active integration wins" guessing (§6 owner
 * ruling, Wave 3 2026-07-12). A missing policy row means "legacy behavior, byte-identical"
 * (design-lock Q1 recommendation: staged opt-in — zero behavior change until a policy is set);
 * a PRESENT policy is authoritative and fail-closed (resolver work is B5-b, not this migration).
 *
 * Schema locks carried over from B4's rigor:
 *   - `UNIQUE (org_id, purpose)` — one policy per purpose per org.
 *   - `purpose` CHECK against the §6 CLOSED set (extending the set = a new migration, on purpose).
 *   - CROSS-ORG POLICY IS FK-IMPOSSIBLE: `(canonical_integration_id, org_id)` →
 *     `directory_integrations (id, org_id)` (reuses B4's `uq_directory_integrations_id_org` parent
 *     UNIQUE), and the same chain for a non-NULL fallback. A policy row can never point at another
 *     org's integration — there is no satisfying org_id. All FK-participating columns are NOT NULL
 *     except `fallback_integration_id`, whose NULL means "no fallback" (under MATCH SIMPLE a NULL
 *     fallback simply skips that FK — the correct semantics here, not a bypass: org integrity for
 *     the row is still carried by the canonical FK on the same org_id column).
 *   - ON DELETE **RESTRICT** on BOTH FKs (design-lock amendment: the draft said SET NULL for
 *     fallback, but on a composite FK `SET NULL` nulls ALL referencing columns — including org_id,
 *     which is NOT NULL — so it would fail confusingly at integration-delete time anyway; PG15's
 *     column-list `SET NULL (col)` is not available on the supported PG14 floor). RESTRICT is the
 *     intended posture regardless: deleting an integration a policy still references must be a LOUD
 *     error that forces an explicit policy edit — a routing policy silently losing its target is
 *     exactly the mass-misrouting hazard §6 exists to prevent.
 *   - No `mode` column (design-lock Q3 recommendation): §6's sketch carried `mode`
 *     (`dingtalk`/`local`), but it is fully derivable from the canonical integration's own
 *     `provider` — a second copy is redundant state that can drift. Single source of truth wins;
 *     if the owner rules to keep it, it comes back with a three-column provider FK (B4 pattern).
 *
 * `directory_integrations` is created by a zzzz migration, so this MUST also be zzzz-prefixed.
 * The table is `CREATE TABLE IF NOT EXISTS` (atomic with its inline constraints) — idempotent on
 * replay. `uq_directory_integrations_id_org` already exists (B4); no parent work is needed here.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS org_directory_routing_policy (
      id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
      org_id                    text        NOT NULL,
      purpose                   text        NOT NULL,
      canonical_integration_id  uuid        NOT NULL,
      fallback_integration_id   uuid        NULL,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT org_directory_routing_policy_pkey PRIMARY KEY (id),

      -- one policy per purpose per org
      CONSTRAINT orp_org_purpose_uniq UNIQUE (org_id, purpose),

      -- §6 closed purpose set — extending it is a deliberate migration, not a free-text write
      CONSTRAINT orp_purpose_chk CHECK (purpose IN (
        'approval_routing',
        'permission_scope',
        'attendance_expansion',
        'member_group_projection',
        'automation_recipient_resolution'
      )),

      -- same-org chain (B4 pattern): the canonical integration must live in THIS org
      CONSTRAINT orp_canonical_int_org_fk FOREIGN KEY (canonical_integration_id, org_id)
        REFERENCES directory_integrations (id, org_id) ON DELETE RESTRICT,

      -- a non-NULL fallback must live in this org too (NULL = no fallback; v1 keeps fallback INERT
      -- — the resolver never auto-falls-back, design-lock Q2)
      CONSTRAINT orp_fallback_int_org_fk FOREIGN KEY (fallback_integration_id, org_id)
        REFERENCES directory_integrations (id, org_id) ON DELETE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_orp_org ON org_directory_routing_policy (org_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS org_directory_routing_policy`.execute(db)
}
