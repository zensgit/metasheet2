# Staging migration backlog disposition — the seven pending migrations (2026-08-22)

> **Scope**: read-only static analysis of `metasheet2`, evaluated against `origin/main` @
> `46669e7ebf` (2026-08-22T01:01:15Z). No staging host, DB, or CI was touched to produce this
> report. Nothing in the repo was modified.
> **Given premise**: staging's last `migrate --list` (CI run `32479275398`, 2026-08-21, predates
> `#5081`) showed **6** pending migrations; `#5081` (`d3289945e1`) added a **7th**
> (`zzzz20260821120000_recovery_authority_functions_fix_search_path`). This report analyzes
> those seven, exactly as scoped. **A staleness finding that changes what "the seven" means in
> practice is reported in §3, before the batch-application answer — read it before dispatching
> anything.**
> **Method**: every migration's `up()`/`down()` was read in full (not grepped-only). The
> migration-alignment scanner (`scripts/ops/staging-migration-alignment-report.mjs`) was run
> **verbatim, unmodified**, against an isolated local harness containing the real script plus the
> real migration files checked out from `origin/main` blobs, fed a synthetic `migrate --list`
| fixture — not hand-simulated. Every risk/flag value below is the scanner's actual JSON output,
> not a manual guess.

## 1. Per-migration table

| # | Migration | Owning line | DDL/DML summary | Scanner risk (actual) | Real risk | Idempotent? | Lock/availability impact | Blast radius on 8 platform-auth tables / `meta_links` / `meta_record*` |
|---|---|---|---|---|---|---|---|---|
| 1 | `zzzz20260817120000_add_handle_action_to_approval_records` | Approval | Widens `approval_records_action_check` 14→15 members (adds `handle`) | **high** | False positive — idempotent CHECK swap | Yes (`DROP CONSTRAINT IF EXISTS` + deterministic re-`ADD`) | `ACCESS EXCLUSIVE` briefly, validating scan (no `NOT VALID`); superset of old CHECK so cannot fail on existing rows | Zero — ALTERs only `approval_records`, no new FK |
| 2 | `zzzz20260817130000_create_approval_form_field_revisions` | Approval | New table `approval_form_field_revisions` (10 cols, BIGSERIAL PK) + 1 index | low | Low | Yes (`CREATE TABLE/INDEX IF NOT EXISTS`) | Negligible — new empty table | Zero — no FK anywhere in the table |
| 3 | `zzzz20260818090000_add_policy_denied_action_to_approval_records` | Approval | Widens `approval_records_action_check` 15→16 members (adds `policy_denied`) | **high** | False positive — same idiom as #1 | Yes | Same as #1 | Zero — same table as #1, no new FK |
| 4 | `zzzz20260818120000_create_approval_usable_member_groups` | Approval | New table `approval_usable_member_groups` (org_id, group_id, created_by, created_at) + conditional composite PK + 1 index; guarded no-op if `platform_member_groups` absent | low | Low | Yes (`checkTableExists` + `.ifNotExists()` + `pg_constraint` guard before `ADD PRIMARY KEY`) | Negligible — new/near-empty table | **Two outward FKs**: `group_id → platform_member_groups.id` (adjacent to, but not one of, the 8 named tables) and `created_by → users.id` (one of the 8) |
| 5 | `zzzz20260821090000_create_attendance_org_resolution_shadow` | Attendance | `CREATE EXTENSION IF NOT EXISTS pgcrypto` (no-op — already applied 90+ times) + new table (12 cols, UUID PK) | low | Low | Yes | Negligible — new empty table | Zero — no FK, `user_id` is plain text |
| 6 | `zzzz20260821091000_add_attendance_org_resolution_shadow_indexes` | Attendance | 2 non-concurrent `CREATE INDEX IF NOT EXISTS` on the table from #5 | low | Low | Yes | Negligible — table has 0 rows when this runs in the same batch as #5 | Zero |
| 7 | `zzzz20260821120000_recovery_authority_functions_fix_search_path` | Time Machine | `CREATE OR REPLACE` on 6 existing functions (3 try-lock helpers unchanged body, 3 trigger functions schema-qualified + fixed `SET search_path=pg_catalog,public`); **zero trigger DDL** | low (see §2 mechanism note) | Low for replay; the migration's real significance is security-fingerprint, not schema | Yes (idempotent `CREATE OR REPLACE`); `down()` is a genuine body restore | Negligible — no table lock at all, catalog-only; 9 downstream triggers stay DISABLED throughout | Zero DDL on the 8 tables/`meta_links`/`meta_record*`, but the 6 functions **are** the code body behind the (currently disabled) trigger layer attached to those tables |

## 2. Detail per migration

### #1 `zzzz20260817120000_add_handle_action_to_approval_records`
`up()`: `ALTER TABLE approval_records DROP CONSTRAINT IF EXISTS approval_records_action_check` then `ADD CONSTRAINT approval_records_action_check CHECK (action IN (...15 values...))`. No column change, no data migration. Comment (in-file) states this is Lock-3 §2.1's third of three sites for the `handle` verb.

**Scanner-actual flags** (from the real script, run against this file): `hasDropStatement=true` (matches `\bDROP\s+CONSTRAINT\b`), `hasCreateTableWithoutIfNotExists=false`, `hasKyselyCreateTableWithoutIfNotExists=false` → `risk=high`, reason string `"Migration up path contains non-idempotent-looking CREATE TABLE or DROP statement."` The heuristic's `DROP` regex does not special-case `DROP CONSTRAINT IF EXISTS` followed by a same-name `ADD CONSTRAINT` — it flags any `DROP CONSTRAINT` token regardless. **This is the same false-positive shape the 2026-08-20 disposition note found for its own first migration** (`add_handle_action_to_approval_records` is in fact the identical migration — the 2026-08-20 note and this report cover the same file).

Real risk: the new CHECK is a strict superset of the old one (only adds `handle`), so the mandatory validation scan that `ADD CONSTRAINT ... CHECK` (no `NOT VALID`) performs cannot fail against any pre-existing row. The `DROP`→`ADD` pair executes inside kysely's one-transaction-per-migration wrapper, so `ACCESS EXCLUSIVE` is held continuously — there is no window where the constraint is absent and a session could insert a value outside either CHECK.

`down()`: drops the widened CHECK and re-adds the 14-member form `NOT VALID`. `NOT VALID` means Postgres does not re-scan existing rows, but **does** enforce the narrower CHECK going forward — so a rollback does not delete any `handle` rows already written, but a fresh `handle` write after rollback would be rejected (`23514`). This is a real, working rollback of the constraint shape, not a no-op; it does not purge history, by explicit design (comment: "any `handle` rows written while the widened constraint was live are left in place").

### #2 `zzzz20260817130000_create_approval_form_field_revisions`
`up()`: `CREATE TABLE IF NOT EXISTS approval_form_field_revisions (id BIGSERIAL PK, instance_id TEXT NOT NULL, node_key TEXT NOT NULL, field_id TEXT NOT NULL, before_value JSONB, after_value JSONB, actor_id TEXT NOT NULL, node_entry_epoch INTEGER, audit_record_id BIGINT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())` + `CREATE INDEX IF NOT EXISTS idx_approval_form_field_revisions_instance ON (instance_id, id)`. No FK at all — `audit_record_id` is a plain BIGINT pointer into `approval_records.id`, deliberately with no FK (mirrored later by migration #10, see §3).

Scanner-actual: `hasCreateTableWithoutIfNotExists=false` (the `IF NOT EXISTS` clause is present and the regex's negative lookahead correctly excludes it), `hasDropStatement=false` in `up()` → `risk=low`.

`down()`: `DROP INDEX IF EXISTS` + `DROP TABLE IF EXISTS` — destructive of any accumulated revision rows (this is a genuinely different risk shape from #1/#3's down, which only narrows a CHECK; this one deletes data). On staging this table does not exist yet, so at the point of any near-term rollback there is nothing to lose — but the down statement itself is destructive, not merely narrowing.

### #3 `zzzz20260818090000_add_policy_denied_action_to_approval_records`
Byte-for-byte the same idiom as #1: `DROP CONSTRAINT IF EXISTS` + re-`ADD` widening `approval_records_action_check` 15→16 (adds `policy_denied`). Scanner-actual: `hasDropStatement=true` → `risk=high`, same reason string as #1. Same false-positive analysis applies verbatim: new CHECK is a strict superset, no `NOT VALID` but the superset relationship guarantees the validation scan cannot fail, single-transaction DROP→ADD leaves no bare window. `down()` mirrors #1's pattern (`NOT VALID`, forward-only narrowing, no history purge).

One sequencing note: #3's `up()` unconditionally rebuilds the CHECK from a fixed 16-member list (it does not read the current constraint state), so it does not structurally *require* #1 to have already run — but by filename order (`0817120000` < `0818090000`) it always will have.

### #4 `zzzz20260818120000_create_approval_usable_member_groups`
`up()`: guarded by `checkTableExists(db, 'platform_member_groups')` — returns immediately (no-op) if that table is absent. Then (if `approval_usable_member_groups` doesn't already exist) creates it via the kysely builder with `.ifNotExists()`: `org_id TEXT NOT NULL`, `group_id UUID NOT NULL REFERENCES platform_member_groups(id) ON DELETE CASCADE`, `created_by TEXT REFERENCES users(id) ON DELETE SET NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Then a `DO $$ ... END $$` block conditionally adds `PRIMARY KEY (org_id, group_id)` only if `pg_constraint` doesn't already show it, then `createIndexIfNotExists` on `group_id`.

Scanner-actual: `hasAlterTable=true` (the `DO $$` block's `ALTER TABLE ... ADD PRIMARY KEY` text matches `\bALTER\s+TABLE\b`), but `hasIfNotExists=true` (matches the kysely `.ifNotExists(`) and `hasCheckTableExistsGuard=true` (matches the `checkTableExists` calls) → the medium-risk `ALTER TABLE without a guard` branch is skipped → falls through to `risk=low`.

**Blast radius — the finding to update from the 2026-08-20 note**: that note recorded only `created_by → users.id` as the cross-cutting FK. Reading this migration in full surfaces a **second** outward FK: `group_id → platform_member_groups.id`. `platform_member_groups` is **not** one of the eight named platform-auth tables (the task's list names `platform_member_group_members`, the membership junction table — a sibling, distinct table; confirmed against `zzzz20260409154000_create_platform_member_groups_and_delegated_group_scopes.ts:8-20`, which creates `platform_member_groups` and `platform_member_group_members` as two separate tables). So this FK does not, by the letter of the eight-table list, hit the O-2 recovery-authority substrate — but it is adjacent: `platform_member_groups` itself carries `created_by`/`updated_by → users.id`, and is the parent of `platform_member_group_members`. `created_by → users.id` on this new table is confirmed to hit one of the eight; a write here takes a `KEY SHARE` lock on the referenced `users` row, same finding class as the 2026-08-20 note (which called out this exact shape as already covered by canary 3.5a / #5032's foreign-fence review — this report does not re-verify that canary coverage, only the DDL fact).

`down()`: `dropTable('approval_usable_member_groups').ifExists().cascade().execute()` — destructive; if this migration's feature has been used (admins have bound groups) before any rollback, that data is gone. Table is empty today.

Mechanical negative control: `git grep` for each of `user_roles`, `user_permissions`, `role_permissions`, `field_permissions`, `record_permissions`, `spreadsheet_permissions`, `platform_member_group_members`, `meta_links`, `meta_record` across all seven migration files returns **zero** hits; `users` returns exactly one hit, in this file.

### #5 `zzzz20260821090000_create_attendance_org_resolution_shadow`
`up()`: `CREATE EXTENSION IF NOT EXISTS pgcrypto` (already applied by 90+ prior migrations in this repo per `git grep -c "CREATE EXTENSION" packages/core-backend/src/db/migrations/` — confirmed no-op on any environment that has run any of those, which staging has) + `CREATE TABLE IF NOT EXISTS attendance_org_resolution_shadow` (12 columns: `id UUID PK DEFAULT gen_random_uuid()`, `created_at`, `user_id TEXT`, `route TEXT`, `org_legacy TEXT`, `org_claim TEXT`, `request_org_supplied BOOLEAN`, `membership_count INTEGER`, `non_default_membership_count INTEGER`, `org_chosen TEXT`, `agree BOOLEAN`, `rule TEXT`). No FK. Purpose per the file's own comment: a shadow audit table for `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1=shadow` on `POST /api/attendance/punch`; never read by the punch route, gates nothing.

Scanner-actual: `hasCreateTableWithoutIfNotExists=false`, `hasDropStatement=false` → `risk=low`.

`down()`: `dropTable(TABLE).ifExists().execute()` — destructive of any accumulated shadow rows, but table is new/empty on staging.

### #6 `zzzz20260821091000_add_attendance_org_resolution_shadow_indexes`
`up()`: two `CREATE INDEX IF NOT EXISTS` statements (`(created_at)`, `(user_id, created_at)`) on the table #5 creates. Deliberately split into its own migration — the file's comment explains why: once any environment has recorded `zzzz20260821090000` as executed, kysely never re-runs it, so folding the indexes back into that file would silently skip them on any DB that already ran #5 without the indexes.

**Real dependency**: this migration's `CREATE INDEX ... ON attendance_org_resolution_shadow` requires that table to exist — i.e., it structurally depends on #5. Filename order (`090000` < `091000`) guarantees #5 runs first in any single `migrate --latest` invocation; this is the **one genuine intra-batch ordering dependency** among the seven.

Scanner-actual: `risk=low`. Down: two `DROP INDEX IF EXISTS` — non-destructive, data (if any) is untouched.

### #7 `zzzz20260821120000_recovery_authority_functions_fix_search_path`
`up()` calls a helper, `applyHardenedFunctions(db)`, which issues six `CREATE OR REPLACE FUNCTION public....` statements: three try-lock helpers (`metasheet_try_recovery_authority_{user,role,group}` — body byte-identical to before, only `SET search_path=pg_catalog,public` added to `proconfig`) and three trigger functions (`metasheet_recovery_authority_user_trigger`, `metasheet_recovery_role_permission_trigger`, `metasheet_recovery_authority_subject_trigger` — internal calls schema-qualified to `public.`, plus the same fixed search_path). This is the CVE-2018-1058-shaped shadow fix: the trigger functions previously called the helpers by bare name with no fixed `search_path`, so a same-signature function planted in a schema matching the connecting role's name could shadow the real helper and silently defeat an EXCLUSIVE recovery-authority lease.

**Mechanically confirmed, not asserted**: `grep -ni "CREATE TRIGGER\|ALTER TRIGGER\|DROP TRIGGER\|ENABLE TRIGGER\|DISABLE TRIGGER"` against this file returns zero matches — independently verifying the file's own docstring claim of "no trigger DDL." OID preservation (so the 9 existing triggers keep pointing at the same function objects) is standard PostgreSQL `CREATE OR REPLACE FUNCTION` semantics when name+signature are unchanged — a property of the SQL operation used, not something this migration's code itself establishes.

**Scanner mechanism — corrected from an earlier draft of this analysis**: running the actual scanner against this file returns `hasCreateTableWithoutIfNotExists=false`, `hasDropStatement=false`, `hasAlterTable=false`, and **`schemaTargets` entirely empty** (`createTables: [], alterTables: [], addColumns: [], indexes: []`) → `risk=low`. The dominant reason is **not** "the scanner has no CREATE-FUNCTION regex" (true, but secondary). Instrumenting `extractUpSource()` directly against this file shows the up-source-slice regex (`/export\s+async\s+function\s+up\b/` through the next `function down\b`) matches the `up()` wrapper near the bottom of the file and extracts only:
```
export async function up(db: Kysely<unknown>): Promise<void> {
  await applyHardenedFunctions(db)
}
```
— **101 characters out of the file's 15,654** — because the six `CREATE OR REPLACE FUNCTION` statements live inside `applyHardenedFunctions`, a helper function *defined earlier in the file, outside the `up`...`down` span the extractor slices*. The scanner never sees them at all, for either the risk flags or the Schema Probe Plan extraction. This generalizes: **any migration that delegates its DDL to a helper defined before `up()` is scanned as if it were empty**, independent of whether that helper's statements would themselves trip any heuristic. This is worth flagging to whoever owns the scanner as a blind spot distinct from "add a FUNCTION regex."

Fingerprint consequence (already documented on `main`, not derived here): applying this migration moves the recovery-authority **functions** containment fingerprint from `14c180aa…` to `e4a78f6cc9c993ed5ed7d2c81dfc44b94d844c7fb046160d8d13077208fa2498` (confirmed in `docs/development/timemachine-owner-decision-sheet-20260821.md:20,77` and `docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md:20-21`); the **triggers** fingerprint `8c1be0b0…` and the 9/9 DISABLED posture are unchanged (no trigger DDL, confirmed above). `scripts/ops/multitable-recovery-schema-containment.mjs:307-421` reads `pg_proc.proconfig` verbatim and folds it into the fingerprint (`config: ['search_path=pg_catalog, public']` is now part of the expected value) — so a `postdeploy-full` run against staging **before** this migration is applied will legitimately report a mismatch on the `config` field for these six functions. That is the expected pre/post-migration difference, not schema drift, and is already documented as such in `timemachine-owner-decision-sheet-20260821.md:90-92` (prod already has this migration applied per `d3289945e1`; staging and the dual-host `postdeploy-full` evidence for the new fingerprint do not).

`down()` (`restoreUnhardenedFunctions`): re-issues the same six functions with bare-name calls and `RESET search_path` — a genuine, behaviorally-verified content rollback (not merely dropping something), and touches zero tables/rows, so it carries none of the data-destructive risk #2/#4/#5's downs do.

## 3. Staleness finding — read before answering "can the seven be applied as one batch"

**As scoped, the task's "seven" is accurate against the staging run (`32479275398`, 2026-08-21) plus `#5081`. It is no longer accurate against current `origin/main` (`46669e7ebf`, 2026-08-22).** Three more migrations merged to `main` after `#5081` (`d3289945e1`), all still in `packages/core-backend/src/db/migrations/`, none yet applied anywhere:

| Name | Timestamp slot | Merge commit | Sorts relative to the seven |
|---|---|---|---|
| `zzzz20260821100000_add_approval_instance_org_id` | 2026-08-21 10:00 | `9fcccd69c3` (#5070) | **Between #6 (09:10) and #7 (12:00)** |
| `zzzz20260822120000_create_approval_comments` | 2026-08-22 12:00 | `b2b4198e01` (#5087) | After #7 |
| `zzzz20260822130000_approval_attachments_process_binding` | 2026-08-22 13:00 | `f15b4252df` (#5089) | After #7 |

Running the real scanner against all ten (same harness, same unmodified script) gives:

- `zzzz20260821100000_add_approval_instance_org_id` → **risk=high** (`hasDropStatement=true`, from `DROP CONSTRAINT IF EXISTS approval_instance_org_nonblank` + re-`ADD`). Unlike #1/#3/#8's superficially-similar CHECK swap, **this migration also contains a set-based `UPDATE approval_instances ... FROM approval_attachments` backfill with a data-dependent `FAIL LOUD` abort** (`throw` if any instance's bound attachments disagree on `org_id` across more than one org). This is the **first migration in the full pending set whose success is not guaranteed by its own text alone — it can fail depending on what data staging actually holds.** None of the seven this report was scoped to have that property; all seven are pure-additive DDL or an idempotent constraint swap over a fixed literal set.
- `zzzz20260822120000_create_approval_comments` → risk=low (new table, real FK `instance_id → approval_instances` `ON DELETE CASCADE`, no FK to any of the 8 platform-auth tables).
- `zzzz20260822130000_approval_attachments_process_binding` → risk=high (`DROP CONSTRAINT IF EXISTS` + re-`ADD` on `approval_attachments`'s field_id CHECK, changing it from `NOT NULL + CHECK` to nullable + a three-valued-logic-safe CHECK — the file's own docstring discloses two deliberate deviations from the ratified migration text, both toward correctness).

**Consequence for the L1 precondition**: `#5039`'s L0 requirement is `staging pending migrations = 0`. `pending=0` can only be reached by applying *everything* `migrate --list` reports pending at the moment of the real deploy — not a frozen list from an earlier report. Whatever SHA is actually deployed to staging defines the true pending set; at `46669e7ebf` that set is **at least ten**, not seven, and it includes a migration with a data-dependent abort path that the seven analyzed above do not have an equivalent of. The existing `schema-probes.sql` artifact (from CI run `32321291505`, generated against the 4-migration pending list from the 2026-08-20 note) covers only four approval-table targets and predates all of #5–#10 — it is stale and cannot stand in for a fresh alignment-report run. **A fresh `migrate --list` + `staging-migration-alignment-report.mjs` run, taken at the exact moment/SHA the apply will happen against, is a prerequisite for the rehearsal below, not an optional refresh.**

## 4. Answering the two questions

### Q1 — Can the seven be applied as one batch, or must they be sequenced/split?

**Among themselves, yes — one batch, no manual sequencing.** `migrate.ts` runs a single `Migrator.migrateToLatest()` call; the custom migration provider returns pending migrations in name order, and the `zzzz<timestamp>` naming convention makes that lexicographic order identical to chronological order. The **one real dependency** in the set (#6's `CREATE INDEX` needs #5's table to already exist) is already satisfied by that ordering (`090000` < `091000`). #3's CHECK rebuild does not structurally require #1 to have run (it rewrites the full 16-member list unconditionally), so it is order-tolerant even though it will always run second. #7 is functionally independent of #1–#6 (different tables/functions entirely; its own prerequisite — the original, pre-fix trigger/lock functions — is already applied on both prod and staging per the migration's own docstring and the O-2 ladder documents, which record staging's pre-fix functions fingerprint `14c180aa…` from run `32321464042`, 2026-08-20). There is no requirement that #7 "go last" for correctness — it already sorts last among the seven, and nothing in #1–#6 touches anything #7 touches or vice versa (confirmed by the zero-hit `git grep` cross-check above).

**But "the seven" is not the real decision unit (§3).** Applying only the seven analyzed here would leave `zzzz20260821100000_add_approval_instance_org_id` and the two 2026-08-22 migrations pending, so `pending=0` would still not be reached and the L1 gate would still be blocked. Whoever executes the apply must run against the actual deployed SHA's `migrate --list`, not this report's fixed list — and if that list still contains `add_approval_instance_org_id`, the rehearsal must specifically exercise its `FAIL LOUD` abort path (i.e., the clone/rehearsal DB must have data shaped so the cross-class-conflict pre-flight check can be observed to pass or fail correctly, not just "the DDL applies"), which is a materially different rehearsal bar than any of the seven need on their own.

### Q2 — What does the runbook require, and what is the minimum satisfying rehearsal?

The task named `docs/development/staging-migration-alignment-runbook-verification-20260519.md`. Its exact closing text:

> "Then read `report.md`. If the decision is `do_not_run_full_migrate`, rehearse against a DB clone or backup before running migrations or editing `kysely_migration`."

That document is a **verification record** for the alignment-report tool (it records the checks that were run and their PASS results on 2026-05-19), not itself an operating procedure. The operative procedure it verifies is `docs/operations/staging-migration-alignment-runbook.md`, whose 2026-05-20 Safety Update carries the same requirement in stronger, more specific language:

> "Do **not** apply Option A or run full `migrate --latest` when the report says `do_not_run_full_migrate`. Use a cloned or backed-up rehearsal DB first."

**Minimum rehearsal that satisfies it already exists as tooling, not as something to invent**: `.github/workflows/attendance-staging-window-runner.yml` `action=migrate` (documented at the top of that workflow file, lines 12–17) does exactly this — pg_dump the real staging DB to a host file (only metadata goes in the CI artifact, never the dump itself), restore it into a throwaway rehearsal DB inside the same postgres container, run `migrate.js` against **only** the rehearsal DB, and touch the real staging DB **only once that rehearsal is fully green**. This is owner-dispatched via GitHub Actions, consistent with the repo-wide preference for CI dispatch over local/SSH access to the shared staging host. Given §3, the rehearsal for the actual apply must include the `add_approval_instance_org_id` cross-class-conflict check exercising real (or realistically-shaped) `approval_attachments`/`approval_instances` data — a clean/empty rehearsal DB would let that migration's `up()` pass trivially without ever exercising its abort branch, which would not be a meaningful rehearsal of that specific migration.

## 5. Bottom line

- The seven migrations named in the task are, on their own, low-actual-risk: two heuristic-high/false-positive idempotent CHECK widenings on `approval_records` (#1, #3), three brand-new empty tables with no cross-cutting FK (#2, #5, plus indexes in #6), one brand-new table with FKs into `users` (one of the 8 platform-auth tables) and `platform_member_groups` (adjacent to, but not one of, the 8) (#4), and one zero-table-lock, zero-trigger-DDL function-body hardening whose only externally observable effect is a documented, already-anticipated fingerprint change from `14c180aa…` to `e4a78f6c…` (#7). None of the seven ALTERs any of `user_roles`, `user_permissions`, `role_permissions`, `field_permissions`, `record_permissions`, `spreadsheet_permissions`, `platform_member_group_members`, `meta_links`, or `meta_record*`, and only #4 adds an FK reaching into one of the eight (`users`).
- **They cannot be dispatched as "the seven" and expect `pending=0`.** At current `main` there are at least three more pending migrations, one of which (`add_approval_instance_org_id`) is the first migration in the whole backlog that can genuinely fail against live data. Whoever runs the apply must regenerate the alignment report against the SHA actually being deployed, not reuse this report's or the 2026-08-20 note's fixed lists.
- **Who signs off**: the approval line owns #1–#4 (and, if included, #8/#9/#10); the attendance line owns #5–#6; the Time Machine line owns #7 and is the party who needs the resulting `postdeploy-full` evidence. None of the seven's blast-radius findings require Time Machine to block the approval/attendance four from proceeding, and #7 requires no sign-off from the other two lines since it touches none of their tables.
- **What's needed before an owner/ops apply**: (1) a fresh `migrate --list` + alignment-report run at the actual deploy SHA (§3); (2) the window-runner's `action=migrate` clone-rehearsal, run against a rehearsal DB whose data can actually exercise `add_approval_instance_org_id`'s abort path if that migration is still pending at apply time; (3) after a green rehearsal, apply for real via the same runner, then re-run `action=migrate`'s "touch staging only once rehearsal is green" step and a `postdeploy-full` (both-hosts) containment run to capture the `e4a78f6c…` evidence Time Machine needs. This report does not authorize or perform any of that — it is disposition input only.

---

## 6. 附录(2026-08-22 落盘时补):积压是**移动靶**,已增至约十条

本报告的"七条"框定取自 2026-08-21 11:53 那次 staging deploy 的 pending 清单 + 我们的 #5081。落盘前复核 `origin/main`,**那之后又落了四条**,其中两条是当天新落的:

| 迁移 | 载体 | 备注 |
|---|---|---|
| `zzzz20260821100000_add_approval_instance_org_id` | `9fcccd69c3` | ⚠️ **本批唯一含数据依赖 FAIL LOUD 的**——backfill 前预检,若同一 instance 绑定的附件 org_id 冲突即 `throw` 中止。**能否成功取决于 staging 的实际数据,静态不可判**;排序落在考勤两条与我们 F3 之间 |
| `zzzz20260821120000_recovery_authority_functions_fix_search_path` | `d3289945e1` | 本报告 #7(Time Machine F3) |
| `zzzz20260822120000_create_approval_comments` | `b2b4198e01` | 2026-08-22 新落 |
| `zzzz20260822130000_approval_attachments_process_binding` | `f15b4252df` | 2026-08-22 新落 |

**因此:重跑 staging deploy 时 pending 约为十条,且每天随他线合并继续增长。** 两个操作含义:

1. **执行者必须按当时钉住的 deploy SHA 重新生成对齐报告**,不能拿本报告的七条当作完整决策单元(§3 已就此警告,本附录给出实测数字)。
2. **越拖越贵**:积压增长的同时风险类别也在变——`add_approval_instance_org_id` 引入了前七条都没有的"数据依赖中止",它只能在**彩排库上用真实数据形状**验证,静态分析给不出结论。

### 扫描器盲点(落盘前坐实,值得单独记)

对齐扫描器的 `extractUpSource()` **只截取 `up()` 函数体**。任何把 DDL 委托给 `up()` 之前定义的 helper 的迁移,其真实 DDL **完全在截取范围之外**——本报告 #7(我们的 F3)正是这种形状:六条 `CREATE OR REPLACE FUNCTION` 全在 helper 里,扫描器只看到约百字符的包装器。

**含义:扫描器对这种形状系统性低报风险**,不能仅凭其分级下结论。这与"高风险多为 `DROP CONSTRAINT IF EXISTS` 启发式误报"是**相反方向**的偏差——一个高报、一个低报,两者都要记住。
