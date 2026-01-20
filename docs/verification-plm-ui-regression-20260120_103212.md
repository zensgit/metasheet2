# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_103212

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_103212.json

## Data
- Search query: UI-CMP-A-1768876333
- Product ID: 58ec1889-1063-4f37-b094-2b13a5160e3e
- Where-used child ID: 6747b898-df5d-4a68-a20c-bbf67d8bafdd
- Where-used expect: R1,R2
- BOM child ID: 6747b898-df5d-4a68-a20c-bbf67d8bafdd
- BOM find #: 10
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-20T10:32
- BOM filter: 10
- BOM compare left/right: 58ec1889-1063-4f37-b094-2b13a5160e3e / 02b54f6c-2f50-4009-bb88-0539687d8d3e
- BOM compare expect: UI Child Z
- Substitute BOM line: 212ec3b2-79c8-4659-9775-1fcb1a6bbd49
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768876333.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768876333
- Approval product number: UI-CMP-A-1768876333
- Item number-only load: UI-CMP-A-1768876333

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
- Screenshot: artifacts/plm-ui-regression-20260120_103212.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_103212.json
