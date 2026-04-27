# Integration-Core Replay Mark Guard Verification - 2026-04-27

## Scope

This verifies that `replayDeadLetter()` preserves successful replay results when `markReplayed()` fails after the ERP write.

## Local Commands

```bash
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f"; done
```

## Expected Coverage

- target write succeeds even when `markReplayed()` throws
- replay result includes `warning.code = MARK_REPLAYED_FAILED`
- warning message carries the original mark failure
- returned dead letter remains `open`, making the inconsistent bookkeeping visible
- PR #1191 non-open replay guard still passes in the merged test file

## Results

Local tests passed in `/private/tmp/ms2-replay-mark-guard` after resolving the merge conflict with current `origin/main`.

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
