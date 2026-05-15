# Approval Phase 1 Baseline 2026-05-15

## Context

Baseline captured before starting PR1 `version-freeze-hardening` on branch:

- `flow/version-freeze-hardening-20260515`

Worktree:

- `/Users/chouhua/Downloads/Github/metasheet2-flow-version-freeze-hardening-20260515`

Base commit:

- `bcdb4b4eb docs(research): add yida workflow phase1 plan`

## Commands

```bash
pnpm --filter @metasheet/core-backend test:unit
pnpm --filter @metasheet/core-backend test:integration
pnpm install --frozen-lockfile --offline
pnpm install --frozen-lockfile
```

## Result

Initial test commands failed before entering Vitest because dependencies were not installed in this new worktree. An offline install also failed because the local pnpm store was missing `bcryptjs-3.0.3`.

`pnpm install --frozen-lockfile` was then run successfully. It reused the local store and completed dependency installation.

```text
Done in 3.8s using pnpm v10.33.0
```

After dependencies were installed:

- Unit baseline: passed.
- Integration baseline: failed in existing environment.

### Unit

Command:

```bash
pnpm --filter @metasheet/core-backend test:unit
```

Result:

```text
Test Files  165 passed (165)
Tests       2136 passed (2136)
Duration    10.12s
```

### Integration

Command:

```bash
pnpm --filter @metasheet/core-backend test:integration
```

Result:

```text
Test Files  11 failed | 20 passed | 11 skipped (42)
Tests       13 failed | 423 passed | 50 skipped (554)
Errors      4 errors
Duration    45.16s
Exit status 1
```

Primary failure classes:

- Missing integration database configuration:
  - `DATABASE_URL is required for after-sales plugin install integration tests`
  - `database "chouhua" does not exist`
- Hook or test timeouts caused by missing DB-backed services:
  - `admin-users.api.test.ts`
  - `kanban-plugin.test.ts`
  - `kanban.mvp.api.test.ts`
  - `snapshot-protection.test.ts`
- Existing mocked-SQL expectation mismatches in multitable and spreadsheet integration suites:
  - `multitable-attachments.api.test.ts`
  - `multitable-record-form.api.test.ts`
  - `multitable-sheet-realtime.api.test.ts`
  - `spreadsheet-integration.test.ts`

Failed suites/tests observed:

```text
after-sales-plugin.install.test.ts
approval-pack1a-lifecycle.api.test.ts
comments.api.test.ts
kanban-plugin.test.ts
kanban.mvp.api.test.ts
snapshot-protection.test.ts
admin-users.api.test.ts
multitable-attachments.api.test.ts
multitable-record-form.api.test.ts
multitable-sheet-realtime.api.test.ts
spreadsheet-integration.test.ts
```

## Initial Dependency Blocker

The first test attempts failed before Vitest because `node_modules` was absent:

```text
sh: vitest: command not found
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @metasheet/core-backend@2.5.0 test:unit
WARN Local package.json exists, but node_modules missing, did you mean to install?
```

The offline install attempt failed because the local store missed one tarball:

```text
ERR_PNPM_NO_OFFLINE_TARBALL
missing package: https://registry.npmjs.org/bcryptjs/-/bcryptjs-3.0.3.tgz
```

## Interpretation

PR1 starts from a clean branch with dependencies installed and a known baseline:

- Unit suite is green.
- Full integration suite is not green in this local environment before PR1 code changes.
- The main integration blockers are DB environment/configuration and existing mocked-SQL expectation drift, not approval version-freeze code.

PR1 verification should therefore include:

- The full unit suite.
- Targeted approval unit/integration tests added or changed by PR1.
- Full integration suite only after a valid local `DATABASE_URL` and scratch DB are available.
- Any remaining full-integration failures must be compared against this baseline.
