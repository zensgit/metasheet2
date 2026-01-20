# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_175542

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_175542.json
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260120_175542-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260120_175542.json

## Data
- Search query: UI-CMP-A-1768902947
- Product ID: 6ce4447f-0b5a-40bf-8f6e-d01d0d7f1d56
- Where-used child ID: 2a01e538-4151-448f-abff-a7650fd44c65
- Where-used expect: R0
- BOM child ID: 2a01e538-4151-448f-abff-a7650fd44c65
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T17:55
- BOM filter: 010
- BOM compare left/right: 6ce4447f-0b5a-40bf-8f6e-d01d0d7f1d56 / 672b5bfc-d80b-4a33-a7b9-8866a232354c
- BOM compare expect: UI Child Z
- Substitute BOM line: 5e97f48f-2afb-43c8-82c0-8cb3511bad35
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768902947.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768902947
- Approval product number: UI-CMP-A-1768902947
- Item number-only load: UI-CMP-A-1768902947

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
- Screenshot: artifacts/plm-ui-regression-20260120_175542.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_175542.json
