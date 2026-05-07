# Integration ERP/PLM Deploy Readiness Verification - 2026-05-07

## Verification Plan

1. Run deterministic unit tests for the readiness evaluator.
2. Run the live GitHub readiness command.
3. Render a markdown readiness report into `artifacts/`.

## Commands

```bash
node --test scripts/ops/integration-erp-plm-deploy-readiness.test.mjs
pnpm run verify:integration-erp-plm:deploy-readiness -- --format text
pnpm run verify:integration-erp-plm:deploy-readiness -- --format markdown --output artifacts/integration-erp-plm-deploy-readiness.md
```

## Expected Result

- Unit tests pass.
- Live readiness command returns pass when the required PRs are clean.
- Markdown report includes mainline hardening, K3 WISE UI stack, and local gates.

## Result

Completed locally on 2026-05-07.

- `node --test scripts/ops/integration-erp-plm-deploy-readiness.test.mjs` passed: 8 tests.
- `pnpm run verify:integration-erp-plm:deploy-readiness -- --format text` returned FAIL by design against live GitHub state because several required PRs are `BEHIND`.
- `pnpm run verify:integration-erp-plm:deploy-readiness -- --format markdown --output artifacts/integration-erp-plm-deploy-readiness.md` rendered a markdown report.

Live readiness result at verification time:

- Mainline PASS: `#1391`, `#1390`, `#1389`, `#1388`.
- Mainline blocked by stale base: `#1387`, `#1386`, `#1385`, `#1383`, `#1382`, `#1381`, `#1380`.
- UI stack blocked by stale base: `#1305`.
- UI stack continuity PASS: `#1364`, `#1392`.

This means internal staging is not yet candidate-ready until stale PR bases are updated/re-run or a composed staging branch is built and verified with the listed local gates.
