# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_111536

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_111536.json

## Data
- Search query: UI-CMP-A-1768878939
- Product ID: dfeeebe6-07d6-403b-af68-387122b28c07
- Where-used child ID: 5ff1fc32-6c49-4365-8a6b-62a9f211268b
- Where-used expect: R1,R2
- BOM child ID: 5ff1fc32-6c49-4365-8a6b-62a9f211268b
- BOM find #: 010
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-20T11:15
- BOM filter: 010
- BOM compare left/right: dfeeebe6-07d6-403b-af68-387122b28c07 / b3ee8129-5585-40dd-a454-2b8490d2707b
- BOM compare expect: UI Child Z
- Substitute BOM line: 540ffacc-a9db-4cfd-b9f3-b718ac5986aa
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768878939.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768878939
- Approval product number: UI-CMP-A-1768878939
- Item number-only load: UI-CMP-A-1768878939

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
- Screenshot: artifacts/plm-ui-regression-20260120_111536.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_111536.json
