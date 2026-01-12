# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260110_220120

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260110_212458.json

## Data
- Search query: MS-BOM-A-1768051498
- Product ID: 9bdf38e7-ca76-4309-8d6b-e9c7b1e5e42b
- Where-used child ID: 3fc3b0d9-9726-4258-a0db-2fc8541f8c81
- Where-used expect: n/a
- BOM compare left/right: 9bdf38e7-ca76-4309-8d6b-e9c7b1e5e42b / 79dd90ff-d960-4241-94e7-94381c6d6d1a
- BOM compare expect: MetaSheet BOM Child Z 1768051498
- Substitute BOM line: 44d40eab-6a86-4613-916d-325bb9827ca4
- Substitute expect: MetaSheet BOM Substitute 1768051498

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260110_220120.png
