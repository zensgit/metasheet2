# MIGRATION_EXCLUDE Tracking

## Overview

This document tracks database migrations that are currently excluded from automated replay testing. These migrations require manual review and fixing before they can be re-enabled.

**Current Exclude Count**: 4 files (union across occurrences)

**Default Exclude in CI**: `008_plugin_infrastructure.sql, 048_create_event_bus_tables.sql, 049_create_bpmn_workflow_tables.sql`; observability/safety/replay also exclude `zzzz20260114110000_create_user_orgs_table.ts`

**Last Updated**: 2026-07-14 (#4162 closure — see both re-enable sections below; T8 docs-only
pass 2026-07-12 added the cross-list context without changing any exclude value)

---

## #4162 closure (2026-07-14): final 3 items RE-ENABLED across all workflow lists

The remaining view-table cluster tail is no longer excluded:

- `042a_core_model_views.sql` now reaches `SUPERSEDED_LEGACY_SQL_MIGRATIONS` and records its
  audited no-op history marker. Its redundant CI-level drop was not protecting any live body.
- `20250924140000_create_gantt_tables.ts` now executes after the UUID `views` migration and
  creates all four Gantt tables, indexes, triggers, and constraints.
- `20250925_create_view_tables.sql` now executes in the five per-PR gate occurrences that still
  excluded it. Its owner-id FK type guard was fixed by #3627 and had already run green in
  `migration-replay.yml` since #3632.

Proofs on current `main`: a fresh no-exclude migration, an exact old-plugin-list database upgraded
to the new list, and a second tracked-skip migrate all exited 0. The upgrade applied all three
previously absent names; the four `gantt_*` tables plus `chk_no_self_dependency` and
`chk_valid_date_range` were present. The workflow lists, guard baseline/fixtures, provider comments,
and this ledger were updated together so a removed item cannot remain silently documented as live.

---

## #4162 follow-up (2026-07-13): 4 items RE-ENABLED across all five workflow lists

`20250924120000_create_views_view_states.ts`, `20251117000001_add_snapshot_labels.ts`,
`20251117000002_create_protection_rules.ts`, and `20251201000001_create_change_management_tables.ts`
were removed from **every** `MIGRATION_EXCLUDE` occurrence at once (plugin-tests.yml ×2,
observability-e2e.yml, observability-strict.yml, safety-guard-e2e.yml, migration-replay.yml ×2) —
deliberately all-lists-at-once, to avoid recreating the #3627→#3632 single-file-sync drift this doc
records for `20250925_create_view_tables.sql`.

Why: `snapshot-protection.test.ts` (the GHSA-h8mf "Snapshot Protection System E2E") needs
`snapshots.tags`, `protection_rules`, and the change-management tables — and `SnapshotService` also
queries `views` / `view_states` — so a CI test-DB without these migrations cannot run that suite at
all (it failed with `column "tags" of relation "snapshots" does not exist` when first wired in
PR #4218). The old per-item exclusion reasons were re-tested and found stale — the same class of
staleness later closed for `20250925`. Proof carried by the re-enable PR: fresh-DB full migrate,
second-pass **tracked-skip replay** (a second `migrateToLatest()` skips already-applied items via
the migration history — it does NOT re-run the four `up()` bodies), a **separate upgrade proof**
(old-list DB → new-list migrate, which is what actually re-executes the newly-enabled `up()`
bodies on an existing schema), the 5 target
tables/columns present, `snapshot-protection.test.ts` 21/21, and Node 18.x/20.x real-DB CI jobs
green with the new lists.

---

## T8 update (2026-07-12): this is ONE of THREE independent exclusion/skip mechanisms

This repo has three separate lists that all sound like "migration exclusions" but do different
things and are **not required to converge** — forcing them into one shared list would break the
workflows/jobs that depend on each one's specific shape. Full detail:
`docs/development/migration-legacy-sql-skip-design-20260512.md` (design decision) and
`docs/development/superseded-legacy-migrations-gap-audit-20260710.md` (2026-07-10 gap/zombie audit).

1. **The CI per-PR gate's `MIGRATION_EXCLUDE`** (this doc's subject) — lives in
   `.github/workflows/plugin-tests.yml` (2 occurrences), `observability-strict.yml`,
   `observability-e2e.yml`, `safety-guard-e2e.yml`. Drops a migration entirely (no history
   marker) so CI's schema-build order can succeed despite that migration's known conflicts.
2. **`migration-replay.yml`'s own `MIGRATION_EXCLUDE` subset** — a narrower, independently
   evolving list for a different job (run `db:migrate` twice against a fresh db, assert the
   second pass is a clean tracked-skip replay). Its list is not identical to #1's (4-item
   union as of 2026-07-14) today.
3. **`SUPERSEDED_LEGACY_SQL_MIGRATIONS`** in `packages/core-backend/src/db/migration-provider.ts`
   — a disjoint-purpose list of ~29 legacy numeric SQL migrations turned into no-op history
   markers (name stays, body doesn't run) rather than dropped. Overlaps #1 on exactly two
   items (`048_create_event_bus_tables`, `049_create_bpmn_workflow_tables`) — confirmed
   intentional/harmless double-listing. `042a_core_model_views` remains a superseded no-op but
   is no longer redundantly dropped by CI.

**Known, verified divergences between the 7 occurrences of #1/#2** (git-blame-checked, not
guessed):

| Item | Present in | Absent from | Why |
|---|---|---|---|
| `zzzz20260114110000_create_user_orgs_table.ts` | observability-strict/e2e.yml, safety-guard-e2e.yml, migration-replay.yml | plugin-tests.yml (both jobs) | Removed from plugin-tests.yml's `test` job in commit `b1fc1e19d1` ("ci(attendance): run integration gate against postgres") because attendance auto-absence needs the `user_orgs` table applied in that job. The **same commit** also removed it from the `after-sales-integration` job in the same file, which does not obviously touch attendance/user_orgs — that second removal may be an unverified side-effect of a file-wide edit rather than a deliberate per-job decision. Flagged, not resolved here. |

**Known asymmetry this doc does not close**: production and on-prem `db:migrate` runs use **no**
`MIGRATION_EXCLUDE` at all — every migration listed above runs in a real deploy. Only CI's per-PR
gate trims the list. **Since the two #4162 re-enable tranches, views/view_states, gantt, 20250925,
and the snapshot/protection/change-management cluster get per-PR CI runs.** The asymmetry now covers
only 008/048/049 and `user_orgs` outside plugin-tests.

**Guard**: `scripts/ci/validate-migration-exclude.sh` cross-checks all of the above for
undocumented drift (warn-only; see that script's header for what it covers and does not cover).

---

## Pre-2026-07-12 content below is a historical snapshot

The "Current CI Exclusions" section right below reflected the workflow files as of 2026-05-12;
the four items marked RE-ENABLED were removed from all lists on 2026-07-13 (#4162, see above). Everything under **Pre-Existing Issues / Phase 2 Additions / Fix Strategy
/ History** further down, however, refers to migration **filenames that no longer exist** in this
repo (`008_add_indexes_to_workflows.sql`, `031_add_approval_templates.sql`,
`036_add_workflow_execution_logs.sql`, `037_add_notification_preferences.sql`,
`042_add_audit_logs.sql`, `048_create_bpmn_process_definitions.sql`,
`049_create_bpmn_process_instances.sql`) — that 2025-10-29 "fix each SQL file, then shrink
MIGRATION_EXCLUDE to empty" plan was superseded by the 2026-05-12
`SUPERSEDED_LEGACY_SQL_MIGRATIONS` no-op/twin-migration design (see
`docs/development/migration-legacy-sql-skip-design-20260512.md`): rather than hand-fixing 29
legacy SQL files for idempotency one at a time, they are treated as permanently-superseded
no-op history markers, with modern timestamp/`zzzz` migrations as their replacements. **Kept
below for historical record, not as a live plan** — do not resume the Phase 1/2/3 fix strategy
without re-reading that design doc first.

---

## Excluded Migrations

### Current CI Exclusions

#### `042a_core_model_views.sql`
**Status**: ✅ RE-ENABLED 2026-07-14 (#4162 closure)
**Disposition**: Still an audited `SUPERSEDED_LEGACY_SQL_MIGRATIONS` no-op history marker; the
redundant CI-level exclusion was removed.

#### `20250924120000_create_views_view_states.ts`
**Status**: ✅ RE-ENABLED 2026-07-13 (#4162 follow-up — see section above)
**Issue**: Creates view-state foreign keys against pre-fix `text` view ids, which fails once replay paths rebuild the newer UUID-based schema.

#### `20250924140000_create_gantt_tables.ts`
**Status**: ✅ RE-ENABLED 2026-07-14 (#4162 closure)
**Disposition**: Current `views.id` is UUID. Fresh and old-list upgrade migrations create all four
Gantt tables and their constraints successfully.

#### `20250925_create_view_tables.sql`
**Status**: ✅ RE-ENABLED 2026-07-14 (#4162 closure)
**Disposition**: #3627 added the owner-id FK type guard; #3632 proved replay, and #4162 aligned the
remaining workflow occurrences after fresh/upgrade verification.

#### `20251117000001_add_snapshot_labels.ts`
**Status**: ✅ RE-ENABLED 2026-07-13 (#4162 follow-up — see section above)
**Issue**: Re-applies the `chk_protection_level` constraint after replay paths have already created the newer snapshot schema, causing duplicate-constraint failures on `snapshots`.

#### `20251117000002_create_protection_rules.ts`
**Status**: ✅ RE-ENABLED 2026-07-13 (#4162 follow-up — see section above)
**Issue**: Re-creates the `protection_rules` table after replay paths have already applied the legacy protection-rule schema, causing duplicate-table failures.

#### `20251201000001_create_change_management_tables.ts`
**Status**: ✅ RE-ENABLED 2026-07-13 (#4162 follow-up — see section above)
**Issue**: Applies `snapshot_id` foreign keys against the newer `uuid snapshots.id` while replay paths still rebuild legacy `text` snapshot references, causing incompatible-FK failures.

#### `zzzz20260114110000_create_user_orgs_table.ts`
**Status**: ❌ Excluded
**Issue**: Rebuilds `user_orgs` against a replay path that still carries the legacy `is_active` reference shape, causing `column "is_active" does not exist` failures.

### Pre-Existing Issues (archived)

#### 1. `008_add_indexes_to_workflows.sql`
**Status**: ❌ Excluded
**Issue**: Syntax error - inline INDEX keyword
**Details**:
- Contains `INDEX idx_name` syntax inside CREATE TABLE
- PostgreSQL requires CREATE INDEX as separate statement

**Fix Required**:
```sql
-- ❌ Wrong (current)
CREATE TABLE workflows (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) INDEX idx_name  -- inline INDEX
);

-- ✅ Correct
CREATE TABLE workflows (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_name ON workflows(name);
```

**Estimated Effort**: 15 minutes
**Priority**: P1
**Assigned**: TBD

---

#### 2. `031_add_approval_templates.sql`
**Status**: ❌ Excluded
**Issue**: Missing IF NOT EXISTS, potential idempotency issues
**Details**:
- CREATE TABLE without IF NOT EXISTS
- Will fail on second run if table exists

**Fix Required**:
```sql
-- ❌ Wrong
CREATE TABLE approval_templates (...);

-- ✅ Correct
CREATE TABLE IF NOT EXISTS approval_templates (...);
```

**Estimated Effort**: 10 minutes
**Priority**: P1
**Assigned**: TBD

---

#### 3. `036_add_workflow_execution_logs.sql`
**Status**: ❌ Excluded
**Issue**: Trailing comma in column definition
**Details**:
- Has `,)` before closing parenthesis

**Fix Required**:
```sql
-- ❌ Wrong
CREATE TABLE logs (
  id SERIAL PRIMARY KEY,
  message TEXT,  -- trailing comma
);

-- ✅ Correct
CREATE TABLE logs (
  id SERIAL PRIMARY KEY,
  message TEXT
);
```

**Estimated Effort**: 5 minutes
**Priority**: P2
**Assigned**: TBD

---

#### 4. `037_add_notification_preferences.sql`
**Status**: ❌ Excluded
**Issue**: Mixed casing inconsistency
**Details**:
- Uses both `create table` and `CREATE TABLE`

**Fix Required**:
- Standardize to uppercase SQL keywords

**Estimated Effort**: 5 minutes
**Priority**: P3
**Assigned**: TBD

---

#### 5. `042_add_audit_logs.sql`
**Status**: ❌ Excluded
**Issue**: Complex foreign key constraints without proper error handling
**Details**:
- Multiple foreign keys added without existence checks

**Fix Required**:
- Add constraint existence checks before adding

**Estimated Effort**: 20 minutes
**Priority**: P1
**Assigned**: TBD

---

### Phase 2 Additions (archived)

#### 6. `048_create_bpmn_process_definitions.sql`
**Status**: ❌ Excluded (Phase 2)
**Issue**: Inline INDEX keyword
**Details**:
- Same issue as 008: inline INDEX in CREATE TABLE
- Added during Phase 2 microkernel architecture

**Fix Required**:
```sql
-- Current (broken)
CREATE TABLE bpmn_process_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL INDEX idx_name  -- inline INDEX
);

-- Fixed
CREATE TABLE bpmn_process_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_name ON bpmn_process_definitions(name);
```

**Estimated Effort**: 15 minutes
**Priority**: P0 (blocks Phase 2 completion)
**Assigned**: Phase 3 Team

---

#### 7. `049_create_bpmn_process_instances.sql`
**Status**: ❌ Excluded (Phase 2)
**Issue**: Inline INDEX keyword
**Details**:
- Same issue as 048
- Part of BPMN workflow system

**Fix Required**:
```sql
-- Current (broken)
CREATE TABLE bpmn_process_instances (
  id TEXT PRIMARY KEY,
  process_definition_id TEXT NOT NULL INDEX idx_def  -- inline INDEX
);

-- Fixed
CREATE TABLE bpmn_process_instances (
  id TEXT PRIMARY KEY,
  process_definition_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_def ON bpmn_process_instances(process_definition_id);
```

**Estimated Effort**: 15 minutes
**Priority**: P0 (blocks Phase 2 completion)
**Assigned**: Phase 3 Team

---

## Fix Strategy

### Phase 1: Critical Fixes (Week 1-2)
**Target**: P0 migrations (048, 049)

1. Fix inline INDEX issues in Phase 2 BPMN migrations
2. Run SQL linter: `bash scripts/ci/lint-sql-migrations.sh`
3. Test migration replay: `MIGRATION_EXCLUDE='' pnpm db:migrate`
4. Verify on clean database

**Success Criteria**:
- ✅ 048 & 049 pass migration replay
- ✅ SQL linter reports 0 issues for these files
- ✅ Tables created with proper indexes

---

### Phase 2: Pre-existing Fixes (Week 3-4)
**Target**: P1 migrations (008, 031, 042)

1. Fix syntax errors one by one
2. Test each migration individually
3. Remove from EXCLUDE list incrementally

**Success Criteria**:
- ✅ All P1 migrations pass replay
- ✅ EXCLUDE list reduced to 2 files (036, 037)

---

### Phase 3: Cleanup (Week 5-6)
**Target**: P2/P3 migrations (036, 037)

1. Fix remaining style issues
2. Final comprehensive migration replay test
3. Remove MIGRATION_EXCLUDE entirely

**Success Criteria**:
- ✅ EXCLUDE list empty
- ✅ All migrations pass replay on clean database
- ✅ CI Migration Replay check passes with zero exclusions

---

## Testing Protocol

### Per-Migration Testing
```bash
# 1. Reset database to before this migration
psql -d metasheet_v2 -c "DELETE FROM schema_migrations WHERE name='XXX_migration_name.sql';"

# 2. Run migration
MIGRATION_EXCLUDE='' pnpm db:migrate

# 3. Verify tables/indexes created
psql -d metasheet_v2 -c "\dt"
psql -d metasheet_v2 -c "\di"

# 4. Run replay (should be idempotent)
pnpm db:migrate

# 5. Check for errors
echo $?  # Should be 0
```

### Full Replay Testing
```bash
# 1. Drop and recreate database
dropdb metasheet_v2
createdb metasheet_v2

# 2. Run all migrations without EXCLUDE
MIGRATION_EXCLUDE='' pnpm db:migrate

# 3. Run replay
pnpm db:migrate

# 4. Verify
bash scripts/ci/lint-sql-migrations.sh
```

---

## Migration Best Practices

### ✅ DO

1. **Use IF NOT EXISTS**
   ```sql
   CREATE TABLE IF NOT EXISTS users (...);
   CREATE INDEX IF NOT EXISTS idx_name ON users(name);
   ```

2. **Separate INDEX statements**
   ```sql
   CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);
   CREATE INDEX IF NOT EXISTS idx_name ON users(name);
   ```

3. **Use hasTable/hasColumn checks (Kysely)**
   ```typescript
   const exists = await db.schema.hasTable('users').execute()
   if (exists) return
   ```

4. **Add semicolons**
   ```sql
   CREATE TABLE users (...);  -- Don't forget!
   ```

5. **Consistent casing**
   ```sql
   -- All uppercase keywords
   CREATE TABLE users (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL
   );
   ```

### ❌ DON'T

1. **Inline INDEX keyword**
   ```sql
   -- ❌ Wrong
   name TEXT NOT NULL INDEX idx_name
   ```

2. **Trailing commas**
   ```sql
   -- ❌ Wrong
   CREATE TABLE users (
     id SERIAL,
     name TEXT,  -- trailing comma
   );
   ```

3. **Missing IF NOT EXISTS**
   ```sql
   -- ❌ Wrong (not idempotent)
   CREATE TABLE users (...);
   ```

4. **Mixed casing**
   ```sql
   -- ❌ Wrong
   create TABLE users (ID serial PRIMARY key);
   ```

---

## PR Review Checklist

When reviewing migration PRs, check:

- [ ] All SQL files pass `bash scripts/ci/lint-sql-migrations.sh`
- [ ] CREATE TABLE uses IF NOT EXISTS
- [ ] CREATE INDEX uses IF NOT EXISTS
- [ ] No inline INDEX keywords
- [ ] No trailing commas
- [ ] Consistent uppercase SQL keywords
- [ ] All statements end with semicolon
- [ ] TypeScript migrations use hasTable/hasColumn checks
- [ ] Migration tested on clean database
- [ ] Migration replay tested (run twice)
- [ ] No new additions to MIGRATION_EXCLUDE without documented reason

---

## History

### 2025-10-29: Initial Tracking
- Documented 7 excluded migrations
- Created fix strategy and testing protocol
- Established P0/P1/P2 priorities

### Next Review: 2025-11-05
- Review P0 fix progress (048, 049)
- Update EXCLUDE list
- Adjust timeline if needed

---

## Related Documents

- [Phase 3 Kickoff Plan](../../claudedocs/PHASE3_KICKOFF_PLAN_20251029.md)
- [Phase 3 Optimization Roadmap](../../claudedocs/PHASE3_OPTIMIZATION_ROADMAP.md)
- [Migration Template](./src/db/migrations/_template.ts)
- [Migration Patterns](./src/db/migrations/_patterns.ts)
- [SQL Linter](../../scripts/ci/lint-sql-migrations.sh)
