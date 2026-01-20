# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_155920

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_155920.json

## Data
- Search query: UI-CMP-A-1768895965
- Product ID: 1dfb3481-cde3-41aa-940a-f266e58267b4
- Where-used child ID: fcd79f97-b250-494a-aa06-9dfb0a2d4cbc
- Where-used expect: R1,R2
- BOM child ID: fcd79f97-b250-494a-aa06-9dfb0a2d4cbc
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T15:59
- BOM filter: 010
- BOM compare left/right: 1dfb3481-cde3-41aa-940a-f266e58267b4 / 997bd837-117e-41e9-9ead-2413e0743e5a
- BOM compare expect: UI Child Z
- Substitute BOM line: bd95b171-c688-441b-a34b-fc0b402c3aca
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768895965.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768895965
- Approval product number: UI-CMP-A-1768895965
- Item number-only load: UI-CMP-A-1768895965

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
- Screenshot: artifacts/plm-ui-regression-20260120_155920.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_155920.json
