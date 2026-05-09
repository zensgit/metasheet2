# Formula Percent Operator Verification Notes

Date: 2026-05-05
Branch: `codex/formula-percent-operator-20260505`

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
Tests       125 passed (125)
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

The added tests verify:

- `=50%` returns `0.5`;
- `=200 * 10%` returns `20`;
- `=1 + 10%` returns `1.1`;
- `=-50%` returns `-0.5`;
- `=2^3%` returns approximately `1.021012`;
- `=(50%)^2` returns `0.25`;
- `="50%"` remains the string `50%`.

## Expected Noise

The targeted formula run logs existing suite noise:

- Vite CJS API deprecation warning;
- `DATABASE_URL not set` warning from backend pool initialization;
- expected invalid-function error log from the `NONEXISTENT(...)` test.
