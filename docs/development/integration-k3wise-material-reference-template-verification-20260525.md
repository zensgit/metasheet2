# K3 WISE Material reference template verification - 2026-05-25

## Local Verification Plan

Commands:

```bash
node --check plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs
node --check plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs
node --check plugins/plugin-integration-core/lib/http-routes.cjs
node --check plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
pnpm --dir plugins/plugin-integration-core test:k3-wise-adapters
pnpm --dir plugins/plugin-integration-core test:http-routes
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
git diff --check
```

Result:

- syntax checks: PASS;
- `pnpm --dir plugins/plugin-integration-core test:k3-wise-adapters`: PASS;
- `pnpm --dir plugins/plugin-integration-core test:http-routes`: PASS;
- `pnpm --dir plugins/plugin-integration-core test`: PASS;
- `pnpm verify:integration-k3wise:poc`: PASS;
- `vitest run tests/k3WiseSetup.spec.ts --watch=false`: 43/43 PASS;
- `vue-tsc --noEmit`: PASS;
- `git diff --check`: PASS.

Note: the isolated worktree did not have its own installed frontend
`node_modules`, so the frontend commands were run using the already-installed
workspace binaries from the main checkout. Temporary symlinks were removed
before staging.

## Expected Assertions

Backend adapter:

- Material schema still exposes required `FNumber` and `FName`.
- Optional K3 reference fields are available in schema.
- Preview/upsert preserves a full object reference value.
- Preview/upsert wraps scalar reference values using the configured identifier
  field, for example `FBaseUnitID: "PCS"` becomes
  `FBaseUnitID: { FNumber: "PCS" }`.
- Existing minimal `FNumber` / `FName` Material calls remain valid.
- #1813 business-success evidence behavior remains unchanged.

Frontend/K3 setup:

- Material JSON preview no longer shows unit reference fields as flat strings.
- The generated preview remains secret-free and does not include internal
  `sourceId`, `revision`, token, authorityCode, or password fields.

## Deployment Impact

- No migration.
- No configuration change required for existing minimal pipelines.
- Existing mappings keep working; reference wrapping only changes fields that are
  declared as K3 reference fields and actually present in the target record.
- The change is packaged in plugin runtime and web preview code.

## GATE Status

This PR does not unblock full customer GATE by itself. Positive Material Save
still requires customer-confirmed reference values or a known-good redacted
Material Save JSON for the target K3 WISE account.

Do not expand to more Save-only records, BOM, Submit, or Audit based solely on
this PR.
