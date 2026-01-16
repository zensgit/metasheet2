# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260116_135254

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260116_1352.json

## Data
- Search query: UI-CMP-A-1768542747
- Product ID: 10352210-f0ec-4165-8fa1-ebdf5fbca7fc
- Where-used child ID: d66faff1-2ae3-4160-b622-87d8d2dafa66
- Where-used expect: R1,R2
- BOM child ID: d66faff1-2ae3-4160-b622-87d8d2dafa66
- BOM compare left/right: 10352210-f0ec-4165-8fa1-ebdf5fbca7fc / 458a8329-fb41-4285-8d9c-a5044dbd06c6
- BOM compare expect: UI Child Z
- Substitute BOM line: 29dbf8a9-2e2b-41ed-9efe-ca78abf5ed55
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768542747.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768542747
- Approval product number: UI-CMP-A-1768542747
- Item number-only load: UI-CMP-A-1768542747

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- BOM child actions executed (copy + switch).
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata.
- Approvals table loads with expected approval record.
- Screenshot: artifacts/plm-ui-regression-20260116_135254.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260116_135254.json
