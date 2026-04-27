# Integration-Core Run Mode Guard Verification - 2026-04-27

## Scope

This verifies that the integration REST API rejects internal-only or unknown run modes before calling the pipeline runner.

## Local Commands

```bash
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f"; done
```

## Expected Coverage

- `/api/integration/pipelines/:id/run` rejects `mode = replay`
- `/api/integration/pipelines/:id/run` rejects unknown or incorrectly cased modes
- empty string is treated as absent and remains accepted
- `/api/integration/pipelines/:id/dry-run` also rejects `mode = replay`
- the list-limit cap from PR #1192 still passes in the merged test file

## Results

Local tests passed in `/private/tmp/ms2-run-mode-guard` after resolving the merge conflict with current `origin/main`. The same commands were repeated after merging the PR #1195 mainline update into this branch.

```text
http-routes: REST auth/list/upsert/run/dry-run/replay tests passed
✓ adapter-contracts: registry + normalizer tests passed
✓ credential-store: 10 scenarios passed
✓ db.cjs: all CRUD + boundary + injection tests passed
✓ e2e-plm-k3wise-writeback: mock PLM -> K3 WISE -> feedback tests passed
✓ erp-feedback: normalize + writer tests passed
✓ external-systems: registry + credential boundary tests passed
✓ http-adapter: config-driven read/upsert tests passed
http-routes: REST auth/list/upsert/run/dry-run/replay tests passed
✓ k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed
✓ migration-sql: 057/058/059 integration migration structure passed
✓ payload-redaction: sensitive key redaction tests passed
✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed
✓ pipelines: registry + endpoint + field-mapping + run-ledger + concurrent-guard + stale-run-cleanup tests passed
✓ plm-yuantus-wrapper: source facade tests passed
✓ plugin-runtime-smoke: all assertions passed
runner-support: idempotency/watermark/dead-letter/run-log tests passed
✓ staging-installer: all 7 assertions passed
[pass] transform-validator: transform engine + validator tests passed
```

GitHub CI is pending after push.
