# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_165510

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_165510.json
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260120_165510-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260120_165510.json

## Data
- Search query: UI-CMP-A-1768899316
- Product ID: fa4c462e-d241-47fb-b28f-19d4127e5233
- Where-used child ID: 7bd1ea3b-9cef-4105-bd2b-a468a2278f85
- Where-used expect: R0
- BOM child ID: 7bd1ea3b-9cef-4105-bd2b-a468a2278f85
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T16:55
- BOM filter: 010
- BOM compare left/right: fa4c462e-d241-47fb-b28f-19d4127e5233 / 0ed22f03-d653-411a-a7d4-445ebc4e01a4
- BOM compare expect: UI Child Z
- Substitute BOM line: a0a9c3d2-5e7b-4a03-96e2-28167793b845
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768899316.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768899316
- Approval product number: UI-CMP-A-1768899316
- Item number-only load: UI-CMP-A-1768899316

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
- Screenshot: artifacts/plm-ui-regression-20260120_165510.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_165510.json
