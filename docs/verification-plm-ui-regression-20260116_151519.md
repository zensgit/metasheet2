# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260116_151519

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260116_143745.json

## Data
- Search query: UI-CMP-A-1768545467
- Product ID: dfd8c53a-92eb-4925-b047-fea7711ab17e
- Where-used child ID: e2d059ab-94fb-4fe9-a8a4-a5fec477c9da
- Where-used expect: R1,R2
- BOM child ID: e2d059ab-94fb-4fe9-a8a4-a5fec477c9da
- BOM compare left/right: dfd8c53a-92eb-4925-b047-fea7711ab17e / 37b7152b-3253-4600-8b66-8ff7fc9afa4f
- BOM compare expect: UI Child Z
- Substitute BOM line: e3278e2c-40f9-4f14-ab58-daed732b0a54
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768545467.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768545467
- Approval product number: UI-CMP-A-1768545467
- Item number-only load: UI-CMP-A-1768545467

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Product detail copy actions executed.
- BOM child actions executed (copy + switch).
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata.
- Approvals table loads with expected approval record.
- Screenshot: artifacts/plm-ui-regression-20260116_151519.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260116_151519.json
