# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_193428

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_193428.json
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260120_193428-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260120_193428.json

## Data
- Search query: UI-CMP-A-1768908873
- Product ID: 8e127f59-520a-4ec9-81c3-96bc28a28484
- Where-used child ID: 381bd2d8-47fe-4b5b-906e-0fb86493d964
- Where-used expect: R0
- BOM child ID: 381bd2d8-47fe-4b5b-906e-0fb86493d964
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T19:34
- BOM filter: 010
- BOM compare left/right: 8e127f59-520a-4ec9-81c3-96bc28a28484 / 82c3cce6-2753-4ce0-8cec-e845a06cccbc
- BOM compare expect: UI Child Z
- Substitute BOM line: 3f88f490-fb95-43d0-909e-fa5f7e7a421d
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768908873.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768908873
- Approval product number: UI-CMP-A-1768908873
- Item number-only load: UI-CMP-A-1768908873

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
- Screenshot: artifacts/plm-ui-regression-20260120_193428.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_193428.json
