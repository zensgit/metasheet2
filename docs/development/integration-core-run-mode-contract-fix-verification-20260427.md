# Integration-Core Run Mode Contract Fix Verification - 2026-04-27

## Commands

```bash
node -c plugins/plugin-integration-core/lib/http-routes.cjs
node -c plugins/plugin-integration-core/lib/pipeline-runner.cjs
node -c plugins/plugin-integration-core/lib/pipelines.cjs
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
node plugins/plugin-integration-core/__tests__/pipelines.test.cjs
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
node plugins/plugin-integration-core/__tests__/external-systems.test.cjs
node plugins/plugin-integration-core/__tests__/migration-sql.test.cjs
node plugins/plugin-integration-core/__tests__/runner-support.test.cjs
```

## Expected Coverage

- `/api/integration/pipelines/:id/run` accepts `manual`, `incremental`, and `full`.
- `/api/integration/pipelines/:id/run` rejects `replay`, `scheduled`, unknown, and incorrectly cased modes.
- Empty string remains treated as absent for backwards-compatible form submissions.
- `/api/integration/pipelines/:id/dry-run` still rejects internal-only `replay`.
- Existing pipeline registry, runner, external-system, migration SQL, and runner-support tests continue to pass.

## Results

Executed in `/tmp/ms2-runmode-contract-refresh` on branch `codex/integration-run-mode-contract-fix-20260427`, after merging `origin/main@fecbb787b`.

Syntax checks:

```text
node -c plugins/plugin-integration-core/lib/http-routes.cjs
node -c plugins/plugin-integration-core/lib/pipeline-runner.cjs
node -c plugins/plugin-integration-core/lib/pipelines.cjs
```

Focused tests:

```text
http-routes: REST auth/list/upsert/run/dry-run/replay tests passed
✓ pipelines: registry + endpoint + field-mapping + run-ledger + concurrent-guard + stale-run-cleanup tests passed
✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed
✓ external-systems: registry + credential boundary tests passed
✓ migration-sql: 057/058/059 integration migration structure passed
runner-support: idempotency/watermark/dead-letter/run-log tests passed
```

Full plugin integration-core regression:

```text
✓ adapter-contracts: registry + normalizer tests passed
✓ credential-store: 10 scenarios passed
✓ db.cjs: all CRUD + boundary + injection tests passed
✓ e2e-plm-k3wise-writeback: mock PLM → K3 WISE → feedback tests passed
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
