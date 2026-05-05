# Formula Concatenation Operator Verification Notes

Date: 2026-05-05
Branch: `codex/formula-concat-operator-20260505`

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
Tests       121 passed (121)
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

- `="Hello" & " " & "World"` returns `Hello World`;
- `="Total: " & SUM(1, 2)` returns `Total: 3`;
- `=("A" & "B") = "AB"` returns `true`;
- `&` keeps lower precedence than arithmetic, so `="Total: " & 1 + 2`
  returns `Total: 3`.

## Expected Noise

The targeted formula run logs existing suite noise:

- Vite CJS API deprecation warning;
- `DATABASE_URL not set` warning from backend pool initialization;
- expected invalid-function error log from the `NONEXISTENT(...)` test.
