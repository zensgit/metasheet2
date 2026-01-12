# Verification: PLM UI Full Regression - 20260110_223640

## Goal
Run BOM tools seed + PLM UI regression in a single workflow.

## Environment
- PLM base: http://127.0.0.1:7910
- Tenant/org: tenant-1 / org-1

## Steps
1. BOM tools seed
   - Report: artifacts/plm-bom-tools-20260110_212458.md
   - JSON: artifacts/plm-bom-tools-20260110_212458.json
2. UI regression
   - Report: docs/verification-plm-ui-regression-20260110_223640.md
   - Screenshot: artifacts/smoke/plm-ui-regression-20260110_223640.png

## Cleanup
- VERIFY_READONLY: true
- PLM_CLEANUP: false
- Status: skipped (readonly)
