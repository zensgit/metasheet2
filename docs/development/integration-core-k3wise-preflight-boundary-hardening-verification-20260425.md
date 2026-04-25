# Integration Core K3 WISE Preflight Boundary Hardening Verification - 2026-04-25

## Scope

This verifies the G1 boundary hardening for
`scripts/ops/integration-k3wise-live-poc-preflight.mjs`.

The verification is local only. It does not contact PLM, K3 WISE, SQL Server,
MetaSheet backend, Redis, or Postgres.

## Commands

```bash
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample > /tmp/k3wise-preflight-sample.json
node -e "JSON.parse(require('fs').readFileSync('/tmp/k3wise-preflight-sample.json','utf8')); console.log('sample json ok')"
git diff --check -- scripts/ops/integration-k3wise-live-poc-preflight.mjs scripts/ops/integration-k3wise-live-poc-preflight.test.mjs docs/development/integration-core-k3wise-preflight-boundary-hardening-design-20260425.md docs/development/integration-core-k3wise-preflight-boundary-hardening-verification-20260425.md
```

## Boundary Matrix

| Case | Expected | Actual | Result |
|---|---:|---:|---:|
| Baseline sample GATE | PASS | PASS | PASS |
| K3 API URL with trailing slash | PASS | PASS | PASS |
| `k3Wise.baseUrl` fallback when `apiUrl` is absent | PASS | PASS | PASS |
| Upper-case `k3Wise.environment: "UAT"` | PASS, emit `uat` | PASS, emits `uat` | PASS |
| Chinese production environment text | FAIL | FAIL | PASS |
| `autoSubmit: "true"` | FAIL | FAIL | PASS |
| `autoAudit: "yes"` | FAIL | FAIL | PASS |
| `autoSubmit: "false"` and `autoAudit: "no"` | PASS | PASS | PASS |
| `sqlServer.mode: "READONLY"` with K3 core table list | PASS | PASS | PASS |
| Middle-table write to `T_ICITEM` | FAIL | FAIL | PASS |
| Middle-table write to ` t_ICItem ` | FAIL | FAIL | PASS |
| Middle-table write to `dbo.t_ICItem` | FAIL | FAIL | PASS |
| Middle-table write to `[dbo].[t_ICBomChild]` | FAIL | FAIL | PASS |
| Middle-table write to similar non-core `t_ICItem_stage` | PASS | PASS | PASS |
| Plaintext credential values in input | PASS, redacted output | PASS, redacted output | PASS |

## Unit Test Result

`node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`

```text
tests 9
pass 9
fail 0
duration_ms 46.013167
```

The test file now covers:

- Save-only packet generation.
- Production environment block.
- boolean Submit/Audit block.
- SQL Server K3 core-table write block.
- safe customer formatting normalization.
- truthy Submit/Audit string rejection.
- schema-qualified and quoted K3 core table rejection.
- BOM product scope requirement.
- secret redaction for JSON and Markdown output.

## Residual Risk

This hardening only validates local packet generation. The live PoC still needs
real customer GATE answers before we can verify:

- customer PLM read connectivity;
- K3 WISE WebAPI/K3API login and Save payload shape;
- SQL Server account permissions;
- real material and BOM field mappings;
- ERP feedback writeback;
- rollback SOP execution.
