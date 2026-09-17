import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 1 DDL.
 *
 * Two tables, `approval_templates` unchanged (no new column on it):
 *
 *   - `approval_template_groups` — an ORG-scoped, ordered, renameable/archivable entity that
 *     upgrades today's free-text `approval_templates.category` into a managed grouping. `org_id`
 *     is always `req.authenticatedTenantId` (never a caller-supplied value) — see the route layer.
 *     `sort_order` is nullable and paired with `archived_at` by a CHECK (active rows always carry
 *     a sort position; archived rows never do); the uniqueness of that pair is DEFERRABLE so a
 *     multi-row reorder can pass through a transient duplicate state and only the COMMIT-time
 *     check is load-bearing (§2 DEFERRABLE side effects, ratified). Same-org active-name
 *     uniqueness is a PARTIAL index (a table-level `UNIQUE (...) WHERE ...` constraint does not
 *     compile) so an archived group's name can be reused by a new active one.
 *
 *   - `approval_template_group_links` — an org-scoped association `(org_id, template_id) →
 *     group_id`, primary-keyed so one organization can put one template in at most one group
 *     while a globally-visible template can sit in DIFFERENT groups for DIFFERENT organizations
 *     (no cross-org column collision, unlike `approval_templates.key`). `group_id` is nullable so
 *     "unlink" can be a plain UPDATE that keeps the row (and its `linked_at` history) instead of a
 *     DELETE — the CHECK ties `group_id IS NULL` to `unlinked_at IS NOT NULL` so the three legal
 *     states (first link / unlinked / re-link) are exactly the ones the CHECK allows. The same-org
 *     invariant is enforced by a COMPOSITE foreign key onto the groups table's own composite
 *     unique constraint (`atg_org_id_uni`) — never `SET NULL`/`CASCADE` on archive, because
 *     archiving is not deletion and a composite `SET NULL` would blank `org_id` too (violates the
 *     primary key's NOT NULL half, 23502).
 *
 * Additive only. Nothing reads/writes these tables until the route layer (same PR) is deployed;
 * `approval_templates.category` is untouched and keeps serving as the migration-period fallback
 * display for templates that have never had a group-link row in a given org (I2′ / I4).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS approval_template_groups (
      id           text PRIMARY KEY,
      org_id       text NOT NULL
                     CONSTRAINT atg_org_nonblank CHECK (org_id ~ '[!-~]'),
      name         text NOT NULL
                     CONSTRAINT atg_name_nonblank CHECK (name ~ '[!-~]'),
      -- Nullable: archived groups carry no sort position (paired CHECK below). Assigned by the
      -- route layer inside the org-level advisory lock (COALESCE(MAX(sort_order), 0) + 1).
      sort_order   int,
      created_by   text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      archived_at  timestamptz,
      -- Referenced side of the group_links composite FK — a partial unique index cannot be an FK
      -- target (42830), so this plain composite UNIQUE exists purely to be pointed at.
      CONSTRAINT atg_org_id_uni UNIQUE (org_id, id),
      -- DEFERRABLE: a multi-row reorder transaction may pass through a transient duplicate
      -- sort_order; only the value set at COMMIT is checked. NULL values (archived rows) do not
      -- participate, so archived groups are exempt by construction. The route layer maps a COMMIT-
      -- time violation of this exact constraint to 500 GROUP_SORT_CONFLICT — it must not treat
      -- COMMIT as a step that cannot fail.
      CONSTRAINT atg_sort_unique UNIQUE (org_id, sort_order) DEFERRABLE INITIALLY DEFERRED,
      -- Active groups always have a sort position; archived groups never do. This is what makes
      -- "archive clears sort_order" and "unarchive assigns a fresh one" checkable invariants
      -- instead of a convention the route layer alone remembers.
      CONSTRAINT atg_sort_archived_pair CHECK ((archived_at IS NULL) = (sort_order IS NOT NULL))
    )
  `.execute(db)

  // Partial unique index — same-org active-name uniqueness. Archived groups are excluded so a
  // new active group may reuse a name that only an ARCHIVED group in the same org still holds.
  // (A partial `UNIQUE (...) WHERE ...` table constraint does not compile in PostgreSQL; only the
  // index form does.) No separate `idx_atg_org_sort` — `atg_sort_unique` already materializes a
  // covering index on (org_id, sort_order).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_atg_org_name_active
    ON approval_template_groups (org_id, name)
    WHERE archived_at IS NULL
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS approval_template_group_links (
      org_id       text NOT NULL
                     CONSTRAINT atgl_org_nonblank CHECK (org_id ~ '[!-~]'),
      template_id  uuid NOT NULL
                     CONSTRAINT atgl_template_fk REFERENCES approval_templates(id) ON DELETE CASCADE,
      -- Nullable on purpose: an "unlinked" row keeps existing (I2′) with group_id cleared rather
      -- than being deleted, so "this org used to have this template grouped, then removed it" is
      -- distinguishable from "this org never grouped this template at all" (the category-fallback
      -- boundary, I2′/I4).
      group_id     text,
      linked_by    text NOT NULL,
      linked_at    timestamptz NOT NULL,
      unlinked_at  timestamptz,
      PRIMARY KEY (org_id, template_id),
      -- Composite FK onto the groups table's own (org_id, id) unique constraint — this is the ONLY
      -- mechanism that enforces "a link's group must belong to the same org as the link". Under
      -- PostgreSQL's default MATCH SIMPLE, a row with group_id IS NULL does not participate in this
      -- check at all, which is exactly what makes "unlink keeps the row" legal. ON DELETE/UPDATE
      -- NO ACTION deliberately — archiving a group only ever sets its archived_at (a transactional
      -- UPDATE elsewhere clears the links first); this FK is never expected to fire on a live path.
      CONSTRAINT atgl_group_fk FOREIGN KEY (org_id, group_id)
        REFERENCES approval_template_groups (org_id, id)
        ON DELETE NO ACTION ON UPDATE NO ACTION,
      -- The three legal states: first link (false=false), unlinked (true=true), re-link
      -- (false=false). IS NULL never yields SQL UNKNOWN, so this CHECK cannot be satisfied by a
      -- NULL falling through — it is a real two-state equality gate.
      CONSTRAINT atgl_state_check CHECK ((group_id IS NULL) = (unlinked_at IS NOT NULL))
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS approval_template_group_links`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_atg_org_name_active`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_template_groups`.execute(db)
}
