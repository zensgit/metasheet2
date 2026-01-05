# Verification: PLM UI BOM Tools - 2026-01-05 17:50

## Goal
Verify PLM UI renders where-used, BOM compare, and substitutes results for Yuantus.

## Environment
- UI: http://localhost:8899/plm
- Core backend: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1

## Data
- Product ID (detail): 0d285b2e-07d6-46c9-a013-e5aea4e5d516 (UI Compare A)
- Where-used child ID: b6f4ebe9-41bf-483a-a956-c8aecd08b573
- BOM compare left/right: 0d285b2e-07d6-46c9-a013-e5aea4e5d516 / 40d6fbbd-6217-48fd-ad8e-06a995ca58b6
- Substitute BOM line: e988e9ad-7c22-443b-bbd3-f768cd0094a9

## Steps
1. Start core-backend + web dev server.
2. Open `/plm`, set dev auth token in localStorage.
3. Load product detail.
4. Query where-used, BOM compare, substitutes.

## Results
- Where-used shows parent entries (includes refdes `R1,R2`).
- BOM compare shows added/removed/changed entries (includes `UI Child Z`).
- Substitutes panel shows `UI Substitute` entry.
- Screenshot: `artifacts/plm-ui-bom-tools-20260105_175018.png`.
