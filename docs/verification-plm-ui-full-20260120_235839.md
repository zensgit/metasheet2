# Verification: PLM UI Full Regression - 20260120_235839

## Goal
Run BOM tools seed + PLM UI regression in a single workflow.

## Environment
- PLM base: http://127.0.0.1:7910
- Tenant/org: tenant-1 / org-1
- BOM find_num: 010
- Status: pass

## Steps
1. BOM tools seed
   - Report: artifacts/plm-bom-tools-20260120_235839.md
   - JSON: artifacts/plm-bom-tools-20260120_235839.json
2. UI regression
   - Report: docs/verification-plm-ui-regression-20260120_235839.md
   - Screenshot: artifacts/plm-ui-regression-20260120_235839.png

## Cleanup
- PLM_CLEANUP: false
- Status: skipped
