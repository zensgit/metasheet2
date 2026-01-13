# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260110_181245

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8901/plm
- API: http://127.0.0.1:7779
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260110_181245.json

## Data
- Search query: UI-CMP-A-1768039970
- Product ID: 145fed97-6e0d-4a07-a570-ffc384d64a88
- Where-used child ID: 5e043665-1ed1-4bad-b34f-2b183761a98b
- Where-used expect: R1,R2
- BOM compare left/right: 145fed97-6e0d-4a07-a570-ffc384d64a88 / c2b8ee10-fd0c-47a7-9d1c-6d98b80e8a9c
- BOM compare expect: UI Child Z
- Substitute BOM line: 7387c947-f093-4e6d-bf1e-70f2a72bc7cd
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260110_181245.png
