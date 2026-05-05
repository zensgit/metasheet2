# Formula Function Expression Verification Notes

Date: 2026-05-05
Branch: `codex/formula-next-hardening-20260505`

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/formula-engine.test.ts \
  tests/unit/multitable-formula-engine.test.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend build
git diff --check
```

## Results

Focused formula regression:

```text
Test Files  2 passed (2)
Tests       118 passed (118)
```

Backend build:

```text
EXIT 0
```

Diff whitespace check:

```text
EXIT 0
```

## New Coverage

Added formula-engine coverage for:

- function calls on both sides of arithmetic: `SUM(...) + SUM(...)`;
- function calls inside division: `SUM(...) / SUM(...)`;
- function calls inside parenthesized arithmetic groups;
- function calls on both sides of comparison operators.

The existing malformed quoted function literal regression stayed green after the
helper was changed to return `#ERROR!` for unclosed function-like expressions.

## Expected Noise

The targeted formula run logs:

- Vite CJS API deprecation warning from the existing test stack;
- `DATABASE_URL not set` warning from backend pool initialization;
- expected invalid-function error log from the existing `NONEXISTENT(...)`
  test.

Those are pre-existing test-suite noises and do not indicate this slice failed.
