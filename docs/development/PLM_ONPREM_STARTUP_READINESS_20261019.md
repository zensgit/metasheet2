# On-prem API readiness before admin bootstrap

Status: source and actual local installed integration verified; exact-head CI and release qualification remain pending. Draft only; no merge, deployment, production enablement, customer data or frozen-baseline changes.

## Problem and repair

The existing on-prem deployment helper runs service bootstrap, then immediately provisions/verifies the administrator. Actual installed PM2 restart/save returned successfully while the restarted backend was not yet listening, so the admin login received 502. A diagnostic run subsequently observed actual API health200 and the restarted backend's listening event. This is not a passing installation; the two failures and their owned cleanup were preserved in the Yuantus runtime evidence.

Source `72f956c9092e1ba645e94109731932467624b050` adds a bounded readiness step after existing service/bootstrap and prebuilt-dist validation, before the administrator command. It polls the configured API health path for actual HTTP200, at most30 attempts with one-second curl connect/total limits and retry intervals. Redirects, errors and non200 results never count as ready. Exhaustion stops before administrator provisioning/login; earlier migrations and service bootstrap are not rolled back or falsely claimed absent. No fixed delay, new configuration flag, reduced final health check or alternate manager is introduced.

The existing final authenticated product-mode, plugin and process-manager checks still run. Readiness admission does not replace them. The source script SHA-256 is `be9722ddacac3bcffca07b860b95d84c9608bb541df53fcd84e480dcb495c60f`. CI wiring source `bb46403636` runs the focused Node20 shell/HTTP tests on relevant pull requests and main pushes; it starts no real environment and grants contents-read only.

## Independent validation

The actual complete deployment shell was executed against an owned loopback HTTP server and real curl. Companion bootstrap/admin/health scripts were controlled; sleep intervals alone were shortened. Cases cover immediate200, three503 responses followed by200, permanently unavailable503, redirect302 and refused transport. A file sentinel records administrator-command invocation independently of HTTP arrival, so closed transport cannot masquerade as no administrator attempt. **Before:0 passed/5 failed. After:5 passed/0 failed/0 skipped**, 5238.7845ms. Shellcheck, actionlint and diff checks passed.

The separate actual installed application profile composed only this exact reviewed script in a newly owned overlay alongside the untouched original Meta519 package. Native/Meta/PostgreSQL/Redis/Nginx/PM2/browser lifecycle then passed **69 checks, zero gaps**, at Yuantus runtime source `f46f51d6a5137189370458cd9b22e51511c78136`; installer exit0, authenticated product-mode checks, personal unified-entry BOM, restart, coupled database/files recovery and frozen revoke retry remained required. The PM2 adapter's stale transport environment and suppressed pid-output errors were independently reproduced/repaired in that Yuantus slice; they are not changes to this provider script. All owned application, browser, manager and temporary-resource cleanup passed.

The original upstream archive, verifiers, migration history, frozen ledger and Meta #6443 HOLD are preserved. A private verification overlay is not a newly approved or reproducibly rebuilt distribution. The new script must be included with correct provenance in a future qualified delivery; actual source/document-head CI and packaging gates remain necessary. Existing command logging can include fixture credentials; raw logs remain private/excluded and operator-log redaction is separate source work.

Run `node --test scripts/ops/multitable-onprem-startup-readiness.test.mjs` with Node20. Red evidence uses the unchanged parent script selected through the test-only source-path override. Compact proof: `artifacts/plm-onprem-startup-readiness-20261019/verification.json`. Full runtime design/proof is in the separate Yuantus `PLM_PACKAGE_OWNED_PM2_20261019.md` slice. No original master-goal or production/customer acceptance completion is inferred.
