# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260116_132934

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260116_101817.json

## Data
- Search query: UI-CMP-A-1768529898
- Product ID: 8ed15f65-da7f-4bfa-b263-47118ab05a9c
- Where-used child ID: a84574fc-4162-41e6-8ad3-4c3d729d2c4a
- Where-used expect: R1,R2
- BOM child ID: 91ca21bb-0509-4fb1-b1bd-6b452183a987
- BOM compare left/right: 8ed15f65-da7f-4bfa-b263-47118ab05a9c / 1e6b3a90-8e42-40d5-99df-1d595bceb9c6
- BOM compare expect: UI Child Z
- Substitute BOM line: 7d0849dc-e1d8-4b14-9f28-91469293c4dc
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768529898.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768529898
- Approval product number: UI-CMP-A-1768529898
- Item number-only load: UI-CMP-A-1768529898

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- BOM child actions executed (copy + switch).
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata.
- Approvals table loads with expected approval record.
- Screenshot: artifacts/plm-ui-regression-20260116_132934.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260116_132934.json
