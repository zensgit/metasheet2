# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_120059

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_120059.json

## Data
- Search query: UI-CMP-A-1768881665
- Product ID: ff89aae3-123f-4129-8d39-60e4f1f06acf
- Where-used child ID: 43c55160-666c-4900-b350-b4c3af87b0d7
- Where-used expect: R1,R2
- BOM child ID: 43c55160-666c-4900-b350-b4c3af87b0d7
- BOM find #: 010
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-20T12:01
- BOM filter: 010
- BOM compare left/right: ff89aae3-123f-4129-8d39-60e4f1f06acf / e8485374-033c-4a38-a7f4-49de27a6b1e6
- BOM compare expect: UI Child Z
- Substitute BOM line: 5e163d57-4880-409e-a2a0-5c90e25a2d06
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768881665.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768881665
- Approval product number: UI-CMP-A-1768881665
- Item number-only load: UI-CMP-A-1768881665

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
- Screenshot: artifacts/plm-ui-regression-20260120_120059.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_120059.json
