# Verification: PLM UI Full Regression - 20260112_160557

## Goal
Run BOM tools seed + PLM UI regression in a single workflow.

## Environment
- PLM base: http://127.0.0.1:7910
- Tenant/org: tenant-1 / org-1

## Steps
1. BOM tools seed
   - Report: /Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-bom-tools-latest.md
   - JSON: /Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-bom-tools-latest.json
2. UI regression
   - Report: docs/verification-plm-ui-regression-20260112_160557.md
   - Screenshot: artifacts/smoke/plm-ui-regression-20260112_160557.png

## Cleanup
- VERIFY_READONLY: true
- PLM_CLEANUP: false
- Status: skipped (readonly)
