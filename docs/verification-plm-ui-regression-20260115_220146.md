# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260115_220146

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7788
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260115_2201.json

## Data
- Search query: UI-CMP-A-1768485688
- Product ID: 9bd2dde5-8178-418d-9202-4355f7e31bb1
- Where-used child ID: f4e7c0d8-8c64-49b4-a891-8d0a1d21d456
- Where-used expect: R1,R2
- BOM compare left/right: 9bd2dde5-8178-418d-9202-4355f7e31bb1 / fe0b4f4a-8947-453c-99f2-195faf4fedf9
- BOM compare expect: UI Child Z
- Substitute BOM line: 983e3fca-bcdc-4010-b1ab-2c1d93ff4280
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768485688.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768485688
- Approval product number: UI-CMP-A-1768485688
- Item number-only load: UI-CMP-A-1768485688

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata.
- Approvals table loads with expected approval record.
- Screenshot: artifacts/plm-ui-regression-20260115_220146.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260115_220146.json
