# Formula Cell Reference Case Verification

Date: 2026-05-05
Branch: `codex/formula-cell-reference-case-20260505`

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
- 116 tests passed.

Build:

- `@metasheet/core-backend` TypeScript build passed.

Diff hygiene:

- `git diff --check` passed.

## New Coverage

Added regression coverage for:

- `=aa1` resolving to the same column index as `AA1`;
- `=sum(a1:a3)` resolving lowercase range references.

## Non-Failing Noise

The formula test suite logs an expected error for the existing invalid-function
case. The test asserts that invalid functions return `#ERROR!`; this is not a
regression from this slice.

`pnpm install` updated plugin and CLI `node_modules` symlink metadata in the
temporary worktree. Those generated dependency changes were reverted before
commit.
