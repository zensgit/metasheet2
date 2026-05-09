# Formula Parenthesized Expressions Verification

Date: 2026-05-05
Branch: `codex/formula-parenthesized-expressions-20260505`

## Commands Run

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/formula-engine.test.ts tests/unit/multitable-formula-engine.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend build
```

## Results

Targeted unit tests:

```text
Test Files  2 passed (2)
Tests       107 passed (107)
```

Backend build:

```text
@metasheet/core-backend build
tsc
```

The formula unit run logs one existing expected error-path message for the
`NONEXISTENT(...)` invalid-function test and one `DATABASE_URL not set` warning
from the test bootstrap. Both are pre-existing test behavior; the suite exits
successfully.

## Rebase Note

This branch was rebased after PR #1301 (`fix(formula): respect operator
precedence`) merged into `main`. The final parser keeps #1301's
lowest-to-highest precedence scan and adds the grouped-expression unwrap before
that scan.

## Cleanup

`pnpm install --frozen-lockfile` recreated local workspace dependency symlinks in
the temporary worktree. Those generated `node_modules` changes were restored and
are not part of the patch.
