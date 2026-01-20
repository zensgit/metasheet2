# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_131712

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_131712.json

## Data
- Search query: UI-CMP-A-1768886238
- Product ID: d7091d91-2484-42b4-aa97-267b2a047c9b
- Where-used child ID: 235d7793-25a7-4e65-b6df-03f570caef5d
- Where-used expect: R1,R2
- BOM child ID: 235d7793-25a7-4e65-b6df-03f570caef5d
- BOM find #: 010
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-20T13:17
- BOM filter: 010
- BOM compare left/right: d7091d91-2484-42b4-aa97-267b2a047c9b / cb1d414f-f45c-4175-bc38-28039742c0b7
- BOM compare expect: UI Child Z
- Substitute BOM line: 5f6347e5-0de5-4aa1-b2f5-b1413d16221b
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768886238.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768886238
- Approval product number: UI-CMP-A-1768886238
- Item number-only load: UI-CMP-A-1768886238

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
- Screenshot: artifacts/plm-ui-regression-20260120_131712.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_131712.json
