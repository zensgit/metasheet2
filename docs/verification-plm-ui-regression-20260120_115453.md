# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_115453

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_115453.json

## Data
- Search query: UI-CMP-A-1768881298
- Product ID: 3950d345-053a-4a58-90c4-e72f608a390c
- Where-used child ID: fae0a348-4eb6-44e1-9dff-c3ed3efa04f3
- Where-used expect: R1,R2
- BOM child ID: fae0a348-4eb6-44e1-9dff-c3ed3efa04f3
- BOM find #: 010
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-20T11:54
- BOM filter: 010
- BOM compare left/right: 3950d345-053a-4a58-90c4-e72f608a390c / 7d9ab4e9-b2a3-4713-8de9-896e431785a0
- BOM compare expect: UI Child Z
- Substitute BOM line: 41c6ea14-2652-47fa-80b9-ca914c80f9a4
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768881298.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768881298
- Approval product number: UI-CMP-A-1768881298
- Item number-only load: UI-CMP-A-1768881298

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
- Screenshot: artifacts/plm-ui-regression-20260120_115453.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_115453.json
