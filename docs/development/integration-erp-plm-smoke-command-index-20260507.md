# Integration ERP/PLM Smoke Command Index - 2026-05-07

This page keeps the K3 WISE / PLM test commands in one place so internal staging and customer PoC are not mixed up.

## Internal Readiness

| Command | Writes Files | Calls Customer PLM/K3 | PASS Means |
|---|---:|---:|---|
| `pnpm run verify:integration-erp-plm:deploy-readiness` | no, unless `--output` is set | no | Required PRs are clean enough to compose an internal staging candidate |
| `pnpm run verify:integration-k3wise:poc` | no | no | Offline preflight/evidence/mock K3 chain is healthy |
| `pnpm -F plugin-integration-core test` | no | no | Plugin runtime, adapters, runner, dead-letter, feedback, and migration structure pass |
| `pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false` | no | no | K3 setup helper payloads and GATE JSON helpers pass |
| `pnpm --filter @metasheet/web build` | `apps/web/dist` | no | Frontend compiles with the K3 setup UI |

## Live PoC Packet Preparation

| Command | Writes Files | Calls Customer PLM/K3 | PASS Means |
|---|---:|---:|---|
| `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input <gate.json> --out-dir artifacts/integration-live-poc` | yes | no | Customer GATE answers are complete, non-production, Save-only, and redaction-safe |
| `node scripts/ops/integration-k3wise-live-poc-evidence.mjs --packet <packet.json> --evidence <evidence.json> --out-dir artifacts/integration-live-poc/evidence` | yes | no | Filled live evidence is PASS/PARTIAL/FAIL with secret checks |

## Postdeploy Smoke

| Command | Writes Files | Calls Customer PLM/K3 | PASS Means |
|---|---:|---:|---|
| `node scripts/ops/integration-k3wise-postdeploy-smoke.mjs --base-url "$METASHEET_BASE_URL" --token-file "$METASHEET_AUTH_TOKEN_FILE" --tenant-id "$METASHEET_TENANT_ID" --require-auth --out-dir <dir>` | yes | no | Deployed MetaSheet can serve health, auth, integration control-plane, K3 setup route, and staging descriptor contract |
| `node scripts/ops/integration-k3wise-postdeploy-summary.mjs --input <smoke.json> --require-auth-signoff` | yes | no | Converts smoke JSON into an internal-trial signoff summary |

## Customer Live Boundary

None of the commands above proves customer PLM/K3 connectivity until the customer provides:

- K3 WISE version and test account set.
- K3 WebAPI/K3API URL and network route.
- PLM access method and sample material/BOM data.
- Field mapping list for material and BOM.
- SQL Server access scope and middle-table/stored-procedure decision.
- Save/Submit/Audit policy.
- Rollback owner and test-data cleanup SOP.

Until then, the correct status is: internal staging can be prepared, customer live is blocked.
