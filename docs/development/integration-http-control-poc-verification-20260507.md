# Integration HTTP Control PoC Verification

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:http-routes-plm-k3wise-poc
pnpm --dir plugins/plugin-integration-core run test:http-routes
pnpm --dir plugins/plugin-integration-core run test:e2e-plm-k3wise-writeback
pnpm -F plugin-integration-core test
git diff --check
```

## Expected Result

- The new route-level PoC passes with mocked PLM and K3 WISE services.
- Existing HTTP route unit coverage still passes.
- Existing direct runner PLM to K3 WISE writeback coverage still passes.
- The full `plugin-integration-core` test chain includes the new route-level PoC.
- The diff has no whitespace errors.

## Environment Note

The isolated worktree needs workspace dependencies linked before the full chain
can resolve `tsx` for `host-loader-smoke.test.mjs`:

```bash
pnpm install --frozen-lockfile --offline
```

Without that setup, the full plugin test command fails before reaching product
tests with `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`.

## Assertions Added

The route-level PoC specifically verifies:

- external-system create responses do not leak credentials
- PLM and K3 WISE connection-test responses do not leak credentials
- staging install returns the expected staging object sheet IDs
- dry-run reads and cleans two PLM material records, previews both, writes none,
  and creates no dead letters or ERP feedback writes
- live run writes two K3 WISE save requests, produces one success and one
  business failure, and avoids submit/audit calls
- ERP feedback writeback records one synced row and one failed row
- run listing exposes both the dry-run `succeeded` row and the live `partial`
  row
- non-admin dead-letter listing redacts payloads
- admin dead-letter listing can include sanitized payloads without exposing
  sensitive PLM `rawPayload`

## Customer Impact

This does not remove the customer GATE requirement. Customer-provided K3 WISE
version, WebAPI URL, account set, submit/audit policy, SQL Server permission
scope, and mapping details are still needed before a live customer PoC.

It does mean the internal REST control-plane chain is ready to exercise those
customer settings once they arrive.
