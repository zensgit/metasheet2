# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260308_130820

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260308_0101.json
- PLM_HEALTH_URLS: /api/v1/health,/health
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260308_130820-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260308_130820.json
- Failure bundle: n/a

## Data
- Search query: UI-CMP-A-1772902939
- Product ID: 57b6f32d-9792-4e30-94ab-57ad2b55c235
- Where-used child ID: 16db87be-e800-4c30-a1d1-cd6a3d4b1971
- Where-used expect: R0
- BOM child ID: 16db87be-e800-4c30-a1d1-cd6a3d4b1971
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-03-08T13:08
- BOM filter: 010
- BOM compare left/right: 57b6f32d-9792-4e30-94ab-57ad2b55c235 / eef9756f-3132-4d71-8dca-ca8b4372a890
- BOM compare expect: UI Child Z
- Substitute BOM line: 25714e8b-5232-4392-a0cf-4809c9312e7f
- Substitute expect: UI Substitute
- Document name: UI-DOC-1772902939.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1772902939
- Approval product number: UI-CMP-A-1772902939
- Item number-only load: UI-CMP-A-1772902939

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Product detail copy actions executed.
- BOM child actions executed (copy + switch).
- BOM detail validation executed (find_num/refdes + depth/effective + filter).
- BOM/Where-Used filter presets import/export/share/group/clear/conflict dialogs validated.
- BOM tree view renders with expandable nodes.
- BOM expand-to-depth button is enabled.
- BOM tree export button is enabled.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata and extended columns.
- Approvals table loads with expected approval metadata and extended columns.
- Approval action controls visible (approve 1, reject 1).
- Approval history panel loaded with no table.
- Screenshot: artifacts/plm-ui-regression-20260308_130820.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260308_130820.json
