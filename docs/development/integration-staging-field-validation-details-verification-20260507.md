# Integration Staging Field Validation Details Verification

Date: 2026-05-07

## Scope

Files verified:

- `plugins/plugin-integration-core/lib/staging-installer.cjs`
- `plugins/plugin-integration-core/__tests__/staging-installer.test.cjs`

## Checks

Run from repository root:

```bash
node plugins/plugin-integration-core/__tests__/staging-installer.test.cjs
pnpm -F plugin-integration-core test
git diff --check
```

## Results

- `node plugins/plugin-integration-core/__tests__/staging-installer.test.cjs`: pass.
- `pnpm -F plugin-integration-core test`: pass after `pnpm install --frozen-lockfile` in the isolated worktree made `tsx` available.
- `git diff --check`: pass.

## Acceptance

- `fieldDetails` now exposes `property.validation` for required staging fields.
- Top-level `required` remains absent from materialized descriptors and
  descriptor summaries.
- The returned `property.validation` array is copied defensively so callers
  cannot mutate global descriptor state.
- Existing staging install assertions still pass.
