# After-Sales M1 — Installer C-min Through multitable/provisioning.ts (Verification)

> Document type: Verification record
> Date: 2026-04-22
> Worktree: `.worktrees/after-sales-m1`
> Branch: `codex/after-sales-m1-installer-provisioning-20260422`
> Baseline commit: `27a9b9de1`
> Postgres: `postgresql://chouhua@127.0.0.1:5432/postgres`

## 1. Baseline confirmation

```
$ git log --oneline -3
27a9b9de1 feat(approval): add sourceSystem filter for unified inbox
b2c3545e5 refactor(multitable): absorb route helpers into M0 modules
213062cb7 test(approval): serialize approval schema bootstrap
```

HEAD matches the expected baseline `27a9b9de1`.

## 2. Commands and results

All commands run from `.worktrees/after-sales-m1`.

### 2.1 Type check

```
$ pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
$ echo $?
0
```

Result: **pass** (exit 0, no diagnostics printed).

### 2.2 Installer unit tests + M0 provisioning unit tests

```
$ pnpm --filter @metasheet/core-backend exec vitest run \
    tests/unit/after-sales-installer.test.ts \
    tests/unit/multitable-provisioning.test.ts --reporter=dot

 ✓ tests/unit/multitable-provisioning.test.ts  (7 tests) 3ms
 ✓ tests/unit/after-sales-installer.test.ts  (41 tests) 14ms

 Test Files  2 passed (2)
      Tests  48 passed (48)
```

Result: **48 passed / 0 failed** (same as baseline).

### 2.3 New integration test (production adapter + real Postgres)

```
$ DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
  PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec \
    vitest --config vitest.integration.config.ts run \
    tests/integration/after-sales-installer-provisioning.api.test.ts \
    --reporter=dot

 ✓ tests/integration/after-sales-installer-provisioning.api.test.ts  (3 tests) 42ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Result: **3 passed / 0 failed**.

Breakdown:

- provisions installedAsset sheet via ensureLegacyBase + ensureSheet + ensureFields (C-min direct seam)
- provisions installedAsset via ensureObject with the C-min minimum descriptor
- routes the after-sales installer runInstall through the multitable provisioning seam for installedAsset C-min

## 3. Scope deviations

None. M1 delivered exactly the narrow delta the roadmap §5.2 calls for:

- No changes to `plugins/plugin-after-sales/lib/installer.cjs` (already wired
  through `context.api.multitable.provisioning` at baseline).
- No changes to `plugins/plugin-after-sales/lib/blueprint.cjs` (C-min floor
  `assetCode` + `serialNo` already present; extra fields belong to C-full and
  are intentionally preserved — see development MD §2 for the rationale).
- No changes to `packages/core-backend/src/multitable/provisioning.ts` or to
  the production context in `packages/core-backend/src/index.ts`.
- One new integration test file + two MDs.

## 4. Known pre-existing infrastructure note

`pnpm --filter @metasheet/core-backend run migrate` fails during
`20250924120000_create_views_view_states.ts` on the `kanban_configs.view_id`
foreign key against `views.id` (uuid vs text mismatch). This failure is
pre-existing on the baseline commit and unrelated to M1. To keep the new
integration test resilient and narrowly scoped to the seam, it provisions
only the four tables it actually touches (`meta_bases`, `meta_sheets`,
`meta_fields`, `plugin_after_sales_template_installs`) with schema
definitions that mirror the source migrations. The end-to-end test
`after-sales-plugin.install.test.ts` still relies on the full migration
stack and is therefore not run as part of M1 verification.

## 5. Summary

- Baseline `27a9b9de1` confirmed.
- `tsc --noEmit`: pass.
- Installer unit tests: 41/41 pass.
- M0 provisioning unit tests: 7/7 pass.
- New integration test: 3/3 pass.
- No scope deviations.
