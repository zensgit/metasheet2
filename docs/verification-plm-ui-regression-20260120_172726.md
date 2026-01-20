# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_172726

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_172726.json
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260120_172726-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260120_172726.json

## Data
- Search query: UI-CMP-A-1768901251
- Product ID: 69f55e3a-e2b7-4cfb-b2aa-2cbaecc4d50e
- Where-used child ID: 66158606-1cc6-48ae-841e-e6ba6f456be8
- Where-used expect: R0
- BOM child ID: 66158606-1cc6-48ae-841e-e6ba6f456be8
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T17:27
- BOM filter: 010
- BOM compare left/right: 69f55e3a-e2b7-4cfb-b2aa-2cbaecc4d50e / a51fac5c-94ad-4eb3-a68b-c72663d37b79
- BOM compare expect: UI Child Z
- Substitute BOM line: 5c6fae32-1124-4467-a3c1-df37be5cd70c
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768901251.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768901251
- Approval product number: UI-CMP-A-1768901251
- Item number-only load: UI-CMP-A-1768901251

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
- Screenshot: artifacts/plm-ui-regression-20260120_172726.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_172726.json
