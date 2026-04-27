# Integration-Core FinishRun Error Guard Verification - 2026-04-27

## Scope

This verifies PR #1193 after rebasing onto current `origin/main`, including the conflict resolution with PR #1191.

## Local Commands

```bash
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f"; done
```

## Expected Coverage

- `pipeline-runner.test.cjs` preserves the original source-read failure when `finishRun()` throws a secondary database-style error.
- The merged test file still covers PR #1191's non-open dead-letter replay guard.
- The full integration-core CJS suite should pass, including migration-sql checks for 057/058/059.

## Results

Local tests passed in `/private/tmp/ms2-finishrun-guard` after resolving the merge conflict with PR #1191.

```text
✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed
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
