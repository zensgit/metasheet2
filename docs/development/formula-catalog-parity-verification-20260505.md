# Formula Catalog Parity Verification

Date: 2026-05-05
Branch: `codex/formula-catalog-parity-20260505`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-formula-editor.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check
```

## Expected Coverage

The targeted test suite covers:

- formula reference search and categorized catalog behavior;
- stable `{fld_xxx}` field-token insertion;
- backend-compatible operator reference docs;
- formula config panel rendering;
- unknown field reference blocking;
- new backend function parity guard across all 46 registered built-ins.

## Results

All local gates passed.

```text
pnpm --filter @metasheet/web exec vitest run tests/multitable-formula-editor.spec.ts --reporter=dot
Test Files  1 passed (1)
Tests       8 passed (8)

pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
Exit code   0

git diff --check
Exit code   0
```

## Notes

`pnpm install --frozen-lockfile` was required in the clean `/tmp` worktree to
link workspace executables before running web tests. The install produced the
known plugin/tool `node_modules` symlink noise; those paths were reverted before
commit with:

```bash
git checkout -- plugins tools
```
