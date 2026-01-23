# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260122_164425

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260122_1641.json

## Data
- Search query: UI-CMP-A-1769071305
- Product ID: 27a96336-8142-4658-a126-99fb56d3c2d4
- Where-used child ID: 21b03165-b71c-492e-9011-f294087afb64
- Where-used expect: R1,R2
- BOM child ID: 21b03165-b71c-492e-9011-f294087afb64
- BOM find #: 010
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-22T16:44
- BOM filter: 010
- BOM compare left/right: 27a96336-8142-4658-a126-99fb56d3c2d4 / 84dc5760-77bb-4300-af3d-dbe8feeb0c7d
- BOM compare expect: UI Child Z
- Substitute BOM line: 136787e8-70dc-429b-b243-a4eef0783de4
- Substitute expect: UI Substitute
- Document name: UI-DOC-1769071305.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1769071305
- Approval product number: UI-CMP-A-1769071305
- Item number-only load: UI-CMP-A-1769071305

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
- Screenshot: artifacts/plm-ui-regression-20260122_164425.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260122_164425.json
