# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260115_222941

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7790
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260115_2229.json

## Data
- Search query: UI-CMP-A-1768487371
- Product ID: 2821019e-11f9-454b-90ad-dd3dba82fdb1
- Where-used child ID: 61d33aa8-9890-4eca-8241-58623dcc23ff
- Where-used expect: R1,R2
- BOM compare left/right: 2821019e-11f9-454b-90ad-dd3dba82fdb1 / b22453b2-0014-408f-99d8-410d49b10a7e
- BOM compare expect: UI Child Z
- Substitute BOM line: d101bdfb-7822-4bb8-afa7-2b812173b48e
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768487371.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768487371
- Approval product number: UI-CMP-A-1768487371
- Item number-only load: UI-CMP-A-1768487371

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata.
- Approvals table loads with expected approval record.
- Screenshot: artifacts/plm-ui-regression-20260115_222941.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260115_222941.json
