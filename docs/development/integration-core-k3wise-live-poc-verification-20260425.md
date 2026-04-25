# Integration Core K3 WISE Live PoC Verification - 2026-04-25

## 1. Status

Current status: backend mock MVP is merged, live customer-system verification is not yet executed.

Local development verification for the preflight slice has passed: the packet generator unit test is 6/6, `plugin-integration-core` tests pass, plugin manifest validation reports 13/13 valid with 0 errors, and `git diff --check` is clean.

Merged backend scope:

- #1147 external system registry hardening.
- #1148 adapter contract and HTTP adapter.
- #1149 pipeline registry.
- #1150 pipeline runner and support modules.
- #1151 integration REST API.
- #1152 K3 WISE adapters.
- #1153 ERP feedback writeback.
- #1154 Yuantus PLM wrapper and mock PLM to K3 WISE E2E.
- #1155 PLM/K3 WISE MVP runbook.

Live verification is blocked until the M2 GATE answers are archived: K3 WISE version, K3API/WebAPI URL, test `acctId`, PLM read method, field lists, Submit/Audit policy, SQL Server permissions, middle database policy, and rollback SOP.

## 2. Pre-Live Verification

Run these before touching a customer test system.

| Check | Command | Expected result | Status |
|---|---|---|---|
| GATE preflight packet | `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input /tmp/k3wise-live-gate.json --out-dir artifacts/integration-live-poc/customer-test` | Generates redacted JSON/MD packet; blocks production, Submit/Audit, and unsafe SQL writes. | TODO |
| Plugin tests | `pnpm -F plugin-integration-core test` | All plugin tests pass. | TODO |
| Plugin manifest validation | `node --import tsx scripts/validate-plugin-manifests.ts` | `plugin-integration-core` is valid. | TODO |
| Backend tests if available | `pnpm --filter @metasheet/core-backend test:unit` | No regression in plugin runtime or API tests. | TODO |
| API process health | `curl -fsS "$METASHEET_API_URL/api/integration/health"` | Integration health returns success. | TODO |
| Adapter registry | `curl -fsS "$METASHEET_API_URL/api/integration/status" > /tmp/integration-status.json && jq '.data.adapters' /tmp/integration-status.json` | Includes `plm:yuantus-wrapper`, `erp:k3-wise-webapi`, `erp:k3-wise-sqlserver`, and `http`. | TODO |
| Migration state | `pnpm --filter @metasheet/core-backend migrate` or CI migration replay | `integration_*` tables exist and migrations replay cleanly. | TODO |

If the local checkout is not fast-forwarded to latest `main`, use a clean worktree before running live verification. Do not run live tests from an older branch that lacks #1150-#1155.

## 3. GATE Evidence

| Evidence item | Required value | Status | Notes |
|---|---|---|---|
| K3 WISE version and patch | Exact version | BLOCKED | Waiting for customer. |
| K3 WebAPI/K3API URL | Redacted URL and network route | BLOCKED | Waiting for customer. |
| Test account | `acctId`, organization/account-set scope | BLOCKED | Waiting for customer. |
| K3 test credentials | User and permission summary, no password in MD | BLOCKED | Waiting for customer. |
| PLM read method | API/table/view and auth method | BLOCKED | Waiting for customer. |
| Material field list | K3 field code mapping | BLOCKED | Waiting for customer. |
| BOM field list | Header and child field mapping | BLOCKED | Waiting for customer. |
| Submit/Audit policy | Save-only or explicit automation approval | BLOCKED | Default is Save-only. |
| SQL Server permission | Read-only, middle-table writable, or disabled | BLOCKED | Waiting for customer. |
| Rollback SOP | Delete/disable/retain test records | BLOCKED | Required before live write. |

## 4. Live Connectivity Checklist

| Check | How to verify | Expected result | Status |
|---|---|---|---|
| PLM external system created | Create `plm:yuantus-wrapper` or approved source adapter with redacted credentials. | Record exists; credentials are not returned in plaintext. | TODO |
| K3 WISE external system created | Create `erp:k3-wise-webapi` with test `acctId`. | Record exists; `autoSubmit=false`, `autoAudit=false`. | TODO |
| Optional SQL channel created | Create `erp:k3-wise-sqlserver` only if approved. | Mode is `readonly` or restricted middle-table mode. | TODO |
| PLM testConnection | Call external-system test endpoint. | Business success; error details redacted if failure. | TODO |
| K3 WebAPI testConnection | Call external-system test endpoint. | Login/session smoke succeeds against test account. | TODO |
| SQL Server testConnection | Call only if approved. | Read-only or middle-table connection succeeds. | TODO |

## 5. Material Dry-Run Checklist

| Check | Expected result | Status |
|---|---|---|
| Staging sheets installed | Materials, BOM, exceptions/dead letters, and run log surfaces are available. | TODO |
| Pipeline created | Source is PLM, target is K3 WISE test account, mode is manual. | TODO |
| Sample source rows | 1-3 real PLM material rows selected and approved by customer. | TODO |
| Transform output | Codes are trimmed/normalized; units and groups mapped through dictionaries. | TODO |
| Validation output | Required fields, enums, patterns, and numeric fields pass or produce clear errors. | TODO |
| Dry-run protection | No K3 write is performed. | TODO |
| Preview evidence | Cleaned row preview is captured with sensitive values redacted. | TODO |

## 6. Material Save-Only Checklist

| Check | Expected result | Status |
|---|---|---|
| Save-only config | `autoSubmit=false`, `autoAudit=false`, write mode Save-only. | TODO |
| Live write size | 1-3 material rows only. | TODO |
| K3 response | K3 returns success status or a documented business error. | TODO |
| ERP feedback | Staging row records `erpSyncStatus`, `erpExternalId`, `erpBillNo`, `erpResponseCode`, `erpResponseMessage`, and `lastSyncedAt` where available. | TODO |
| Idempotency | Re-running the same batch does not duplicate successful target writes. | TODO |
| Run log | Rows read, cleaned, written, failed, duration, status, and summary are recorded. | TODO |
| Watermark | Successful rows can advance watermark; failed rows do not. | TODO |
| Customer confirmation | Evidence owner confirms the K3 test-account record. | TODO |

## 7. Failure, Dead Letter, and Replay Checklist

| Scenario | Expected result | Status |
|---|---|---|
| Invalid required field | Row is rejected before K3 write and enters dead letter. | TODO |
| Dictionary miss | Row enters dead letter with a clear error code/message. | TODO |
| K3 business error | Error response is stored without exposing credentials or session tokens. | TODO |
| Replay after correction | Corrected mapping or dictionary replay succeeds. | TODO |
| Watermark safety | Failed rows do not cause watermark advance. | TODO |
| Audit trail | Original run ID, replay run ID, retry count, and user are visible. | TODO |

## 8. Simple BOM PoC Checklist

| Check | Expected result | Status |
|---|---|---|
| Product scope | `productId` comes from PLM external system `config.defaultProductId` or direct adapter `filters.productId`. | TODO |
| Legacy config avoided | `pipeline.options.source.productId` is not used. | TODO |
| Parent material exists | Parent material was created or confirmed in K3 test account. | TODO |
| Child rows exist | One or two child rows are selected and mapped. | TODO |
| Save-only BOM write | K3 accepts the simple BOM or returns a documented business error. | TODO |
| Feedback | BOM response is written back to staging/run log. | TODO |

## 9. Rollback and Cleanup Checklist

| Check | Expected result | Status |
|---|---|---|
| Test records identified | Source IDs, K3 material codes, bill numbers, and run IDs captured. | TODO |
| Customer cleanup action | Records deleted, disabled, or retained according to rollback SOP. | TODO |
| Watermark reset decision | Repeat-test strategy documented. | TODO |
| Credentials removed or rotated | Temporary credentials revoked if required. | TODO |
| Evidence package archived | This MD updated with final results and redacted logs/screenshots. | TODO |

## 10. Not Covered by This Verification

- Production account writes.
- Automatic Submit/Audit.
- High-concurrency or scheduled sync.
- Multi-account, multi-organization, or multi-tenant production rollout.
- Replacement materials, alternate BOM lines, effectivity dates, or complex BOM engineering rules.
- Direct K3 SQL Server core-table writes.

## 11. Result Template

Use this section after the live PoC runs.

| Area | Result | Evidence |
|---|---|---|
| GATE complete | TODO | Link or archive path. |
| PLM connection | TODO | Redacted request ID or log line. |
| K3 connection | TODO | Redacted request ID or log line. |
| Material dry-run | TODO | Run ID. |
| Material Save-only | TODO | Run ID and K3 test bill/material ID. |
| Dead letter and replay | TODO | Original run ID and replay run ID. |
| BOM PoC | TODO | Run ID and K3 response. |
| Cleanup | TODO | Customer confirmation. |

Final decision:

- `PASS`: M3 UI can start.
- `PARTIAL`: M2 adapter hardening required before M3.
- `FAIL`: Stop live work and revisit GATE assumptions, connectivity, or K3 payload contract.
