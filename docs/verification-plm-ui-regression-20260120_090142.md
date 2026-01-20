# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_090142

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_090142.json

## Data
- Search query: UI-CMP-A-1768870904
- Product ID: 1d143e86-bfcc-43c3-943b-98bf832aa0fb
- Where-used child ID: 4036147a-d3d3-4203-89c6-d9ca76b46496
- Where-used expect: R0
- BOM child ID: 4036147a-d3d3-4203-89c6-d9ca76b46496
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T09:01
- BOM filter: 010
- BOM compare left/right: 1d143e86-bfcc-43c3-943b-98bf832aa0fb / 54c5ce42-bd11-4ce2-a014-e4b10b760841
- BOM compare expect: UI Child Z
- Substitute BOM line: 20b1313b-5720-4bd8-954b-716af355d3d6
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768870904.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768870904
- Approval product number: UI-CMP-A-1768870904
- Item number-only load: UI-CMP-A-1768870904

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
- Screenshot: artifacts/plm-ui-regression-20260120_090142.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_090142.json
