# Verification: PLM UI Full Regression - 20260122_133548

## Goal
Run BOM tools seed + PLM UI regression in a single workflow.

## Environment
- PLM base: http://127.0.0.1:7910
- Tenant/org: tenant-1 / org-1
- BOM find_num: 010
- Status: pass
- BOM status: pass
- UI status: pass
- Failure bundle: n/a
- FULL_BUNDLE_ALWAYS: false

## Steps
1. BOM tools seed
   - Report: artifacts/plm-bom-tools-20260122_133548.md
   - JSON: artifacts/plm-bom-tools-20260122_133548.json
2. UI regression
   - Report: docs/verification-plm-ui-regression-20260122_133548.md
   - Screenshot: artifacts/plm-ui-regression-20260122_133548.png

## Cleanup
- PLM_CLEANUP: false
- Status: skipped
