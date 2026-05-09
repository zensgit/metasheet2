# Formula Unary Expression Verification

Date: 2026-05-05
Branch: `codex/formula-unary-expression-20260505`

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
- 111 tests passed.

Build:

- `@metasheet/core-backend` TypeScript build passed.

Diff hygiene:

- `git diff --check` passed.

## New Coverage

Added regression coverage for:

- `=-(1 + 2)`;
- `=+(1 + 2)`;
- `=5 * -(1 + 2)`;
- `=--(1 + 2)`;
- `=-SUM(1, 2)`;
- `=+SUM(1, 2)`;
- `=-({fld_price}+{fld_fee})*{fld_qty}`;
- `=-SUM({fld_price},{fld_fee})`.

## First Failure Captured

The first implementation parsed unary expressions before binary operators. That
made `-3+5` parse as `-(3+5)` and returned `-8`. The final implementation scans
binary operators first, then parses unary signs at operand boundaries.

## Non-Failing Noise

The formula test suite logs an expected error for the existing invalid-function
case. The test asserts that invalid functions return `#ERROR!`; this is not a
regression from this slice.

`pnpm install` updated plugin and CLI `node_modules` symlink metadata in the
temporary worktree. Those generated dependency changes were reverted before
commit.
