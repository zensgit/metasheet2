# ERP/PLM Phase 2 Guard Closeout Verification - 2026-05-08

## Worktree

`/private/tmp/ms2-integration-phase2-guard-closeout`

## Branch

`codex/integration-phase2-guard-closeout-20260508`

## Baseline

`origin/main` at `b4e7f78a329d70b24a45e7b6667ba9f3d20a9904`.

## Merge Verification

Commands:

```bash
gh pr update-branch 1391 --repo zensgit/metasheet2
gh pr update-branch 1390 --repo zensgit/metasheet2
gh pr update-branch 1389 --repo zensgit/metasheet2
gh pr update-branch 1388 --repo zensgit/metasheet2

gh pr view <number> --repo zensgit/metasheet2 --json mergeable,statusCheckRollup
gh pr merge <number> --repo zensgit/metasheet2 --squash --admin --delete-branch
```

Results:

- #1389 merged at `37daeee98ff3e264f53c5ab824b057c62002b728`.
- #1388 merged at `6d47e70738d0b0ecfa7f5f76c8f42fbdbcc1188e`.
- #1390 merged at `5342c266d2038aabcfd2c3ac358784e61a407f2b`.
- #1391 merged at `b4e7f78a329d70b24a45e7b6667ba9f3d20a9904`.

All four merged PRs were `MERGEABLE` and had no failing or pending required
checks at merge time.

## Review Notes

Two read-only review passes were used before merge:

- #1389/#1388/#1390: suitable for backend runtime guard merge; file surfaces are
  independent (`db.cjs`, `external-systems.cjs`, `dead-letter.cjs`) and tests are
  colocated.
- #1391: suitable for merge; the import route gate is registered before the
  federation router and only changes PLM-disabled behavior.

#1392 was reviewed and intentionally excluded. Its current branch is stacked on
broader K3 setup UI/GATE work, and the review identified a follow-up risk around
preserving omitted metadata during inactive SQL-channel updates.

## Local Verification

The clean closeout worktree was prepared with dependencies:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Verification commands:

```bash
pnpm -F plugin-integration-core test
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-disable-routes.test.ts
git diff --check
```

Results:

- `pnpm -F plugin-integration-core test`: passed all plugin-integration-core
  suites, including DB boundary tests, external-system update tests, runner
  support/dead-letter tests, HTTP routes, PLM wrapper, K3 adapters, ERP feedback,
  E2E writeback, staging installer, and migration SQL.
- `plm-disable-routes.test.ts`: 3/3 passed, including the newly covered PLM
  import route disabled response.
- `git diff --check`: passed.

During the PLM route test, the local environment logged that database `chouhua`
does not exist while initializing workflow support. The test still passed; the
log is an environment-side startup warning, not a failure of the PLM disabled
route guard.

## Residual Risk

This closeout verifies backend guard behavior and route-level disabled handling.
It does not validate real customer PLM/K3 WISE connectivity or K3 SQL-channel UI
disable persistence. Those remain gated by the customer GATE packet and the
separate #1392/UI-config stack.
