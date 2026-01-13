# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260113_195117

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260113_1951.json

## Data
- Search query: UI-CMP-A-1768305063
- Product ID: a3d1594a-594c-425b-9a9a-9fdd0f7c5bf1
- Where-used child ID: 03e61db4-4fce-4751-b753-67307a26fa9b
- Where-used expect: R1,R2
- BOM compare left/right: a3d1594a-594c-425b-9a9a-9fdd0f7c5bf1 / b32e3780-8953-4d6f-9bea-5ff20b83d2f7
- BOM compare expect: UI Child Z
- Substitute BOM line: 1a6ec305-d438-461f-976c-77bfc3ea27af
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260113_195117.png
