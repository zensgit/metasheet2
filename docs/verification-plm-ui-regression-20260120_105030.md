# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_105030

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_105030.json

## Data
- Search query: UI-CMP-A-1768877431
- Product ID: ce52ef4a-891c-48e8-b27f-aeca19a180a0
- Where-used child ID: 2f50aeb7-2113-4346-abb7-b8d52aa7f414
- Where-used expect: R1,R2
- BOM child ID: 2f50aeb7-2113-4346-abb7-b8d52aa7f414
- BOM find #: 010
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-20T10:50
- BOM filter: 010
- BOM compare left/right: ce52ef4a-891c-48e8-b27f-aeca19a180a0 / ea0355ef-3305-4f1f-bf1d-bbc27910acfd
- BOM compare expect: UI Child Z
- Substitute BOM line: 451d56bf-4a81-4912-98f4-2f4cdca247c9
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768877431.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768877431
- Approval product number: UI-CMP-A-1768877431
- Item number-only load: UI-CMP-A-1768877431

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
- Screenshot: artifacts/plm-ui-regression-20260120_105030.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_105030.json
