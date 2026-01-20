# Verification: PLM UI Full Regression - 20260120_204826

## Goal
Run BOM tools seed + PLM UI regression in a single workflow.

## Environment
- PLM base: http://127.0.0.1:7910
- Tenant/org: tenant-1 / org-1
- BOM find_num: 010
- Status: pass
- BOM status: pass
- UI status: pass
- Failure bundle: artifacts/plm-ui-full-20260120_204826-bundle.tgz

## Steps
1. BOM tools seed
   - Report: artifacts/plm-bom-tools-20260120_204826.md
   - JSON: artifacts/plm-bom-tools-20260120_204826.json
2. UI regression
   - Report: docs/verification-plm-ui-regression-20260120_204826.md
   - Screenshot: artifacts/plm-ui-regression-20260120_204826.png

## Cleanup
- PLM_CLEANUP: false
- Status: skipped
