# Formula Power Operator Verification Notes

Date: 2026-05-05
Branch: `codex/formula-power-operator-20260505`

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
Tests       123 passed (123)
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

- `=2 ^ 3` returns `8`;
- `=2^3^2` returns `512`;
- `=2 * 3^2` returns `18`;
- `=2^-3` returns `0.125`;
- `=-2^2` returns `-4`;
- `=(-2)^2` returns `4`;
- `=--2^2` returns `4`.

## Expected Noise

The targeted formula run logs existing suite noise:

- Vite CJS API deprecation warning;
- `DATABASE_URL not set` warning from backend pool initialization;
- expected invalid-function error log from the `NONEXISTENT(...)` test.
