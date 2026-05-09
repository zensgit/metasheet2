# Formula Operator Precedence Verification

Date: 2026-05-05
Branch: `codex/formula-left-associative-operators-20260505`

## Commands Run

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

Targeted formula tests:

- 2 files passed;
- 100 tests passed.

Build:

- `@metasheet/core-backend` TypeScript build passed.

## New Coverage

Added regression coverage for:

- `=5 - 3 - 1`;
- `=8 / 4 / 2`;
- `=5 + 3 - 1`;
- `=5 * 3 / 5`;
- `=1 + 2 > 2`;
- `=1 + 2 = 3`;
- `=10 / 2 <= 4 + 1`;
- `=2 * 3 <> 7 - 1`.

## First Failure Captured

The first implementation matched multi-character comparison operators but then
continued scanning inside the matched token. That let the internal `=` in `>=`
and `<=` overwrite the previous match. The final implementation skips over the
matched token body after a longest-token match.

## Non-Failing Noise

The formula test suite logs an expected error for the existing invalid-function
case. The test asserts that invalid functions return `#ERROR!`; this is not a
regression from this slice.
