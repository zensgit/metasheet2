# Approval OpenAPI Contracts Verification - 2026-04-24

## Commands

The normal `pnpm exec tsx ...` form is blocked in the current sandbox because `tsx` tries to create an IPC pipe and receives `listen EPERM`. The equivalent Node loader form was used:

```bash
node --import tsx packages/openapi/tools/build.ts
```

Result: passed. OpenAPI dist files rebuilt from all path parts.

```bash
pnpm --dir packages/openapi/dist-sdk build
```

Result: passed. `openapi-typescript` regenerated `packages/openapi/dist-sdk/index.d.ts`.

```bash
node --import tsx packages/openapi/tools/validate.ts
```

Result: passed.

```text
OpenAPI security validation passed
```

```bash
pnpm --dir packages/openapi/dist-sdk exec vitest run \
  tests/approval-paths.test.ts \
  tests/plm-workbench-paths.test.ts \
  tests/client.test.ts \
  --reporter=dot
```

Result: passed.

- Test files: 3 passed.
- Tests: 19 passed.

## What The Tests Lock

`approval-paths.test.ts` checks that the generated SDK exposes:

- approval inbox list/pending/pending-count paths
- PLM sync path
- approval action/read/remind paths
- direct `UnifiedApprovalDTO` response shapes
- direct approval template response shapes

The existing PLM and client SDK tests also passed after adding the missing shared baseline schemas.

## Notes

This is contract-level verification. It does not replace staging HTTP verification against a running backend.

The final verification also covers the history DTO required-field correction: platform history rows may expose deprecated snake_case fields such as `to_status` and omit camelCase `toStatus`/`metadata`, so the schema now only requires `id` and `action`.
