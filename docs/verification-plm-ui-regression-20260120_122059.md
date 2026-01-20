# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_122059

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_122059.json

## Data
- Search query: UI-CMP-A-1768882864
- Product ID: 8ac9dab2-5a83-47b1-a6a1-67500d23278e
- Where-used child ID: a2b6f877-e7f9-4109-8058-a30c6a654c74
- Where-used expect: R1,R2
- BOM child ID: a2b6f877-e7f9-4109-8058-a30c6a654c74
- BOM find #: 010
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-20T12:21
- BOM filter: 010
- BOM compare left/right: 8ac9dab2-5a83-47b1-a6a1-67500d23278e / 67df9a89-0448-4c5b-8abb-0d16ea627cce
- BOM compare expect: UI Child Z
- Substitute BOM line: 41d65ad1-8ec1-415b-ba30-b0261e3c25d7
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768882864.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768882864
- Approval product number: UI-CMP-A-1768882864
- Item number-only load: UI-CMP-A-1768882864

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
- Screenshot: artifacts/plm-ui-regression-20260120_122059.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_122059.json
