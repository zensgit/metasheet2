# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260117_234818

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260117_2333.json

## Data
- Search query: UI-CMP-A-1768664036
- Product ID: aad358c7-d1df-4126-8744-d34609803911
- Where-used child ID: 09fbcd16-c026-435d-92aa-437a7619a4ce
- Where-used expect: R-A1
- BOM child ID: 09fbcd16-c026-435d-92aa-437a7619a4ce
- BOM find #: 010
- BOM refdes: R-A1
- BOM depth: 1
- BOM effective at: 2026-01-17T23:48
- BOM filter: 010
- BOM compare left/right: aad358c7-d1df-4126-8744-d34609803911 / 9ddc4f5e-6b95-45a2-9dbe-8017b39d1ffc
- BOM compare expect: UI Child Z
- Substitute BOM line: 3ea45ee2-80db-4638-b33a-255f064745a8
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768664036.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768664036
- Approval product number: UI-CMP-A-1768664036
- Item number-only load: UI-CMP-A-1768664036

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Product detail copy actions executed.
- BOM child actions executed (copy + switch).
- BOM detail validation executed (find_num/refdes + depth/effective + filter).
- BOM tree view renders with expandable nodes.
- BOM expand-to-depth button is enabled.
- BOM tree export button is enabled.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata and extended columns.
- Approvals table loads with expected approval metadata and extended columns.
- Screenshot: artifacts/plm-ui-regression-20260117_234818.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260117_234818.json
