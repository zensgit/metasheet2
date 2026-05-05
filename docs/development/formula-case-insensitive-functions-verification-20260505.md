# Formula Case-Insensitive Functions Verification

Date: 2026-05-05
Branch: `codex/formula-case-insensitive-functions-20260505`

## Commands Run

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec tsx -e "import { FormulaEngine } from './src/formula/engine'; void (async () => { const engine = new FormulaEngine({ db: undefined as any }); const context = { sheetId: 's', spreadsheetId: 'p', currentCell: { row: 0, col: 0 }, cache: new Map() }; console.log(await engine.calculate('=sum(1,2)', context as any)); console.log(await engine.calculate('=concat(\"a\",\"b\")', context as any)); })();"
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/formula-engine.test.ts tests/unit/multitable-formula-engine.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend build
```

## Results

Manual formula probe after the fix:

```text
3
ab
```

Targeted unit tests after rebasing onto `origin/main@cacc0aa6`:

```text
Test Files  2 passed (2)
Tests       114 passed (114)
```

Backend build:

```text
@metasheet/core-backend build
tsc
```

Diff hygiene:

```text
git diff --check
```

The targeted test run logs the existing invalid-function error-path message for
`NONEXISTENT(...)` and a `DATABASE_URL not set` bootstrap warning. Both are
pre-existing test behavior; the suite exits successfully.

## Pre-Fix Probe

The same manual probe was run before the code change. It returned literal text:

```text
sum(1,2)
concat("a","b")
```

That confirmed the parser was not treating lowercase function names as calls.

## Cleanup

`pnpm install --frozen-lockfile` recreated local workspace dependency symlinks in
the temporary worktree. Those generated `node_modules` changes were restored and
are not part of the patch.
