# Integration Core K3 WISE Live PoC Evidence Verification - 2026-04-25

## Scope

This verifies the local K3 WISE live PoC evidence compiler.

It does not contact customer PLM, K3 WISE, SQL Server, or a running MetaSheet backend.

## Commands

```bash
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
node scripts/ops/integration-k3wise-live-poc-evidence.mjs --print-sample-evidence
git diff --check -- scripts/ops/integration-k3wise-live-poc-evidence.mjs scripts/ops/integration-k3wise-live-poc-evidence.test.mjs docs/development/integration-core-k3wise-live-poc-evidence-design-20260425.md docs/development/integration-core-k3wise-live-poc-evidence-verification-20260425.md
```

## Expected Test Coverage

| Case | Expected result |
|---|---|
| Complete Save-only evidence | Decision is `PASS`. |
| Missing required phase | Decision is `PARTIAL`. |
| Material Save-only writes more than 3 rows | Decision is `FAIL`. |
| Evidence shows `autoAudit=true` | Decision is `FAIL`. |
| Evidence contains unredacted secret-like field | Compiler rejects the input. |
| CLI report generation | JSON and Markdown reports are written and redacted. |

## Verification Result

| Check | Status | Evidence |
|---|---|---|
| Unit test | PASS | `node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs` passed 6/6. |
| Sample evidence generation | PASS | `node scripts/ops/integration-k3wise-live-poc-evidence.mjs --print-sample-evidence` output parsed as JSON. |
| Diff whitespace check | PASS | `git diff --check` exited 0 for the evidence script, test, and docs. |

Test output summary:

```text
tests 6
pass 6
fail 0
duration_ms 45.736375
```

Additional local regression:

```text
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
```

All passed. Manifest validation reported 13/13 valid and 0 errors.

## Boundary

Passing this verification proves only that the local evidence compiler works. It does not prove:

- real PLM connectivity;
- real K3 WISE connectivity;
- customer field mapping correctness;
- K3 business payload acceptance;
- rollback completion.

Those remain M2 live PoC execution gates.
