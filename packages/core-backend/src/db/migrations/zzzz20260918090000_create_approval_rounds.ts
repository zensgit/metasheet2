/**
 * ============================================================================================
 * ADDENDUM (2026-09-17) — the four attendance-lane census pins, run against this lane's changes
 * (`plugins/plugin-attendance/index.cjs`'s five writer edits, `w4c3b-central-approval-hooks.ts`'s
 * new `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY`/`isCancelRoundInstance`, this migration, and the
 * sibling `zzzz20260918110000_add_attendance_requests_approval_workflow_key.ts` migration).
 * Memory `feedback_attendance_new_file_census_trio.md` requires all four be checked before a
 * push touching attendance writers/new migrations; run here, retroactively, for the commits that
 * already landed this lane's writer/migration edits. Each is a NEGATIVE finding (not triggered /
 * already covered) — recorded with the evidence rather than left as an unstated assumption.
 *
 *   1. s6a hash (`sealed-export-package-provenance.cjs` PINNED_EVIDENCE_FILES, 32 entries):
 *      `grep -n "plugin-attendance\|db/migrations\|approval_rounds\|attendance_requests"
 *      plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs`
 *      -> zero matches. The one entry that WOULD apply, `.github/workflows/plugin-tests.yml`
 *      (id `pluginTestsWorkflow`), is untouched by this lane — `git diff --stat
 *      origin/main..HEAD -- .github/workflows/plugin-tests.yml` is empty (this lane's real-DB
 *      evidence lane is the standalone `approval-realdb-cancel-round.yml`, by design — see that
 *      file's own header). No re-pin needed.
 *   2. W7-R10 (`w7-w6r5-guard-root-set.ts`'s THREE WALKED ROOTS — a directory-root list, not a
 *      file list; per-checklist item 13, a basename grep proves nothing here, containment does):
 *      `plugins/plugin-attendance/index.cjs` falls under root 1
 *      (`plugins/plugin-attendance/**`, `presentAtW7Zero: true`) — already in the walked domain,
 *      no new root introduced. `w4c3b-central-approval-hooks.ts` falls under root 2
 *      (`packages/core-backend/src/attendance/**`) — likewise already walked. This migration and
 *      its sibling live under `packages/core-backend/src/db/migrations/**`, which is OUTSIDE all
 *      three roots — correctly: W7-R10 walks group-policy/frozen-context REFERENCE sites, not
 *      schema DDL, and `ApprovalProductService.ts`/`ApprovalBridgeService.ts`/`routes/approvals.ts`
 *      (also touched this lane) sit under `src/services/`/`src/routes/`, likewise outside all
 *      three roots for the same reason (they are approval-side, not attendance-side).
 *   3. CI corpus (`attendance-w4c2-ci-wiring.test.mjs`'s disk-derived attendance corpus, basename
 *      PREFIX match `attendance-` — `scripts/ops/attendance-w4c2-ci-wiring.test.mjs:161`,
 *      `base.startsWith(ATTENDANCE_BASENAME_PREFIX)`): this lane's three new suites
 *      (`approval-cancel-round-creation.db.test.ts`,
 *      `approval-cancel-round-lock-order-census.db.test.ts`,
 *      `approval-cancel-round-redemption.db.test.ts`) do not carry that prefix, so they are
 *      correctly outside this corpus (they are approval suites, not attendance ones, and run via
 *      the standalone `approval-realdb-cancel-round.yml` lane instead). The six EXISTING
 *      `attendance-*.db.test.ts` fixture files this lane edited (Q1c fixture-pairing) were
 *      already corpus members by basename before this lane touched their content — a content
 *      edit does not change corpus membership, which is derived from disk at CI time.
 *   4. DML table-classification (`scripts/attendance/w4c0-dml-inventory/`): `approval_rounds` is
 *      a brand-new table but is OUT OF SCOPE for this collector — its scope gate
 *      (`collector.cjs` `isAttendanceOwnedCandidate`) only tracks `attendance_*`-prefixed tables
 *      plus a named `SHARED_TABLE_NAMES` set of exactly `{approval_instances, approval_records,
 *      approval_assignments}` (`collector.cjs:882-891`) — `approval_rounds` is in neither, so its
 *      `CREATE TABLE` site is not reported and not counted as unclassified (by the collector's
 *      own documented scope-gate rule, not by omission). The sibling migration's backfill
 *      `UPDATE attendance_requests` IS in scope and is claimed by curated entry `X08`
 *      (`curated-debt-entries.cjs`, added this lane). `createCancelRoundInstance`'s own new
 *      `approval_instances`/`approval_assignments` writes (in `ApprovalProductService.ts`) fall
 *      under the existing broad `P26` entry, `claims: byPathPrefix('.../ApprovalProductService.ts')`
 *      (`curated-debt-entries.cjs:512`) — a whole-file claim already covering every DML site in
 *      that file, landed before this lane. Verified empirically, not just read: `node --test
 *      scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` -> `tests 60`, `pass 60`,
 *      `fail 0`, including `exact-head HEAD scan: zero new/unclassified/out-of-boundary
 *      attendance DML` and `W4C-3c hard zero-bypass: current-tree open-debt set is exactly
 *      empty`.
 * ---- end 2026-09-17 addendum ----
 * ============================================================================================
 *
 * Approval change-request design lock v5.9 §4 — first-slice DDL, table 1 of 3.
 *
 * `approval_rounds` tracks a cancel/amend ATTEMPT against a business document that already has
 * an `approval_instances` row (`document_id`). First slice only ever writes `kind = 'cancel'`
 * (amend is a later phase, §7). `engine_instance_id` is the id of the dedicated cancel-round
 * runtime instance this attempt drives (see `createCancelRoundInstance`, ApprovalProductService.ts) —
 * nullable because a future `kind` might not need an engine instance at all.
 *
 * The partial unique index `uq_approval_rounds_pending_document` is I3 (§5): at most one round in
 * flight per document. C-3 (§3) is the ONLY thing allowed to move a round's `outcome` off
 * `'pending'` — that release is what lets a new round be opened.
 *
 * `policy_snapshot_at_create` is NOT NULL (every round freezes the policy that governed its
 * creation); `policy_snapshot_at_decision` is written once, at final evaluation (deferred to the
 * second slice — this slice never populates it).
 *
 * Non-blank CHECKs use the repo's dominant unanchored form `col ~ '[!-~]'` (contains at least one
 * printable non-space character), matching e.g. `approval_att_org_nonblank`
 * (`zzzz20260715210000_create_approval_attachments.ts:24`) and
 * `automation_outbox_event_id_nonblank` (`zzzz20260715120000_create_automation_outbox.ts:78`) —
 * NOT the anchored `^[!-~]+$` form used by the (minority) directory corp-scope migration. The
 * anchored form additionally rejects any non-ASCII byte anywhere in the string, which would make a
 * directory-sourced `requested_by` unwritable if it ever carries a non-ASCII user id; the lock
 * (§4, lock:141) names the unanchored predicate verbatim.
 *
 * Lock §4 (lock:142) enumerates exactly one index: the partial unique index below. An earlier
 * draft of this migration also added two convenience indexes (engine-instance reverse lookup,
 * per-document history scan) that are NOT named in the lock. Nothing in the first slice's scope
 * (createCancelRoundInstance, the outlet guards, 判据 III) needs either — round lookups in this
 * slice are always by `id` (primary key) or by the partial unique index. Per the DDL-gate
 * discipline (DDL is owner-gated; the lock is read as an exhaustive DDL list until told
 * otherwise), they have been removed rather than carried as a source-comment disclosure. If a
 * later slice needs one of these access patterns, add it in that slice's own migration with its
 * own justification.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS approval_rounds (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES approval_instances(id),
    kind TEXT NOT NULL CHECK (kind IN ('cancel')),
    engine_instance_id TEXT NULL REFERENCES approval_instances(id),
    requested_by TEXT NOT NULL,
    reason TEXT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ NULL,
    outcome TEXT NOT NULL DEFAULT 'pending'
      CHECK (outcome IN ('pending', 'applied', 'rejected', 'withdrawn', 'expired', 'blocked')),
    block_reason TEXT NULL,
    policy_snapshot_at_create JSONB NOT NULL,
    policy_snapshot_at_decision JSONB NULL,
    CONSTRAINT chk_approval_rounds_id_nonblank CHECK (id ~ '[!-~]'),
    CONSTRAINT chk_approval_rounds_document_id_nonblank CHECK (document_id ~ '[!-~]'),
    CONSTRAINT chk_approval_rounds_requested_by_nonblank CHECK (requested_by ~ '[!-~]')
  )`.execute(db)

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_rounds_pending_document
    ON approval_rounds (document_id)
    WHERE outcome = 'pending'`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS approval_rounds CASCADE`.execute(db)
}
