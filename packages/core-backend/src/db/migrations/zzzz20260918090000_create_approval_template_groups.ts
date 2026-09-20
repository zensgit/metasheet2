import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 1 DDL.
 *
 * ERRATUM 3 CANDIDATE (REDRAFT v2, PROPOSED 2026-09-19/20 — **NOT owner-ratified, NOT
 * authorized, NOT applied to any environment**). Exactly one line of this file departs from the
 * ratified §2 constraint list: `atg_name_nonblank`, whose predicate is written here as the
 * erratum's redrafted option (i) — an explicit-trim-set `btrim(...) <> ''` — instead of the
 * ratified `name ~ '[!-~]'`. Both `org_id` CHECKs (`atg_org_nonblank`, `atgl_org_nonblank`) are
 * byte-for-byte as ratified. The rationale, the refutation of the first candidate, and the
 * disclosed gap in the trim set all live in the block comment directly above that CONSTRAINT.
 * Source of the proposed wording: `lock-errata-proposed-grouping-v2.13-20260919.md`, section
 * "勘误 3(重拟)", option (i). Passing this branch's tests is TECHNICAL VERIFICATION of the
 * candidate only — it is not ratification, merge authorization, or permission to apply the
 * migration anywhere.
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
                     -- Erratum 3 CANDIDATE, REDRAFT v2 (PROPOSED 2026-09-19/20, pending owner
                     -- confirmation — see the lock's own '勘误 3' header entry and
                     -- lock-errata-proposed-grouping-v2.13-20260919.md, section
                     -- '勘误 3(重拟)' option (i), for the exact wording; NOT owner-ratified,
                     -- NOT authorized — this DDL edit is a candidate sitting on an
                     -- unmerged/unapplied branch, awaiting the owner's own word).
                     --
                     -- WHY NOT THE RATIFIED TEXT: the ratified predicate was '~ [!-~]',
                     -- printable-ASCII-only, copied from
                     -- zzzz20260715210000_create_approval_attachments.ts:24, which guards two
                     -- IDENTIFIER columns — applied here to a human-typed display name it
                     -- rejected every pure-CJK group name, including this product's OWN
                     -- placeholder text (TemplateAuthoringView.vue:221: "如 请假 / 采购 / 报销").
                     --
                     -- WHY NOT THE FIRST CANDIDATE: candidate v1 was a bare btrim(name) <> '',
                     -- described as "non-blank, any character". Gate round 8 (P2-1) refuted that
                     -- description empirically: PostgreSQL btrim/2's DEFAULT trim set is the
                     -- ASCII space ONLY, so a name made entirely of U+200B ZERO WIDTH SPACE (or
                     -- U+3000, TAB, LF, U+FEFF) passed that CHECK and landed a 201 row that is
                     -- invisible in every UI. Owner, same day: the earlier bare-btrim suggestion
                     -- does not cover pure-invisible names and must not be carried over as-is.
                     --
                     -- THIS PREDICATE: btrim with an EXPLICIT trim set = ASCII space/TAB/CR/LF,
                     -- U+3000 IDEOGRAPHIC SPACE, U+200B/200C/200D zero-width (non-)joiners,
                     -- U+2060 WORD JOINER, U+FEFF BOM. Deliberately locale-INDEPENDENT (no
                     -- iswspace/iswalnum, no [[:alnum:]]) so glibc-vs-musl collation behaviour
                     -- cannot change what it accepts — see finding_prod_pg15_never_tested.
                     -- KNOWN AND DISCLOSED GAP: the set is the owner's proposal verbatim, so it
                     -- does NOT include U+00A0 NBSP, U+1680, U+2000-U+200A, U+202F, U+205F,
                     -- U+2028/9. A direct SQL insert of an NBSP-only name therefore still
                     -- succeeds; the production route does not let one through because the
                     -- service layer's requireName strips a SUPERSET (JS backslash-s plus the four
                     -- zero-widths JS does not strip). Do not read this CHECK on its own as a
                     -- complete "non-blank" guarantee.
                     --
                     -- In the TypeScript source the escape-string literal below is written with
                     -- DOUBLED backslashes so that the text actually handed to PostgreSQL is the
                     -- proposal byte-for-byte. Same trap as the backtick note further down, and
                     -- it bit this very comment once: EVERY backslash in this block is inside the
                     -- sql-tagged template literal, so a single-backslash escape is consumed by
                     -- JS before PostgreSQL ever sees it. Writing the proposal text here with
                     -- single backslashes turned them into a real TAB/CR/LF, the CR/LF ENDED this
                     -- SQL line comment mid-sentence, and the rest of the sentence was parsed as
                     -- SQL (db:migrate: syntax error at or near the stray quote). Doubled
                     -- everywhere, including in prose.
                     --
                     -- atg_org_nonblank above / atgl_org_nonblank below are UNCHANGED by this
                     -- candidate — org_id stays a system/session-derived identifier column, same
                     -- footing as the precedent; the owner's single standing question is whether
                     -- to approve rewriting ONLY this name CHECK, leaving both org_id CHECKs
                     -- untouched. NOTE: no backtick characters anywhere in this comment block —
                     -- it lives inside the JS/TS sql-tagged template literal below (an outer pair
                     -- of backtick delimiters wraps this whole CREATE TABLE statement), where one
                     -- more literal backtick would terminate that template early. The file's own
                     -- top-of-file JSDoc block uses backticks freely because it sits OUTSIDE that
                     -- template.
                     CONSTRAINT atg_name_nonblank CHECK (
                       btrim(
                         name,
                         E' \\t\\r\\n' || chr(12288) || chr(8203) || chr(8204) || chr(8205)
                           || chr(8288) || chr(65279)
                       ) <> ''
                     ),
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
