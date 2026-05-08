# Integration Idempotency All Fields Verification

## Commands

```bash
node plugins/plugin-integration-core/__tests__/runner-support.test.cjs
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
pnpm install --frozen-lockfile --offline
pnpm -F plugin-integration-core test
git diff --check
```

## Expected Result

- Runner support tests pass.
- Pipeline runner tests pass.
- The full `plugin-integration-core` test chain passes.
- The diff has no whitespace errors.

## Added Assertions

`runner-support.test.cjs` now verifies:

- records with identical first two key fields but different additional
  dimensions produce different idempotency hashes
- the new key equals `computeIdempotencyKey()` with an explicit `dimensions`
  object
- blank additional dimensions are rejected with a field-specific error

`pipeline-runner.test.cjs` now verifies:

- two source records with the same `code + revision` but different `org` values
  both write to the target when `idempotencyKeyFields` includes `org`
- the target idempotency map receives two distinct keys instead of skipping the
  second row as a duplicate

## Compatibility Check

Existing one-field and two-field idempotency keys are intentionally unchanged.
The `dimensions` object is only emitted when a pipeline config provides a third
or later key field.

## Customer Impact

This reduces risk before live K3 WISE testing for customers whose material data
is unique by organization, account set, locale, plant, or another dimension in
addition to material code and revision.
