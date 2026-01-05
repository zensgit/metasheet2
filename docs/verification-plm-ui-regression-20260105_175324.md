# Verification: PLM UI Regression (Search → Detail → BOM Tools) - 2026-01-05 17:53

## Goal
Verify the end-to-end PLM UI flow: search → select → load product → where-used → BOM compare → substitutes.

## Environment
- UI: http://localhost:8899/plm
- Core backend: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1

## Data
- Search query: UI-CMP-A-1767573354
- Where-used child ID: b6f4ebe9-41bf-483a-a956-c8aecd08b573
- BOM compare left/right: 0d285b2e-07d6-46c9-a013-e5aea4e5d516 / 40d6fbbd-6217-48fd-ad8e-06a995ca58b6
- Substitute BOM line: e988e9ad-7c22-443b-bbd3-f768cd0094a9

## Steps
1. Open `/plm` and set dev auth token.
2. Search by item number and click `使用` on UI Compare A.
3. Query where-used (expect refdes `R1,R2`).
4. Run BOM compare (expect `UI Child Z` entry).
5. Query substitutes (expect `UI Substitute`).

## Results
- Search returns UI Compare A and selection loads product detail.
- Where-used shows entries with refdes `R1,R2`.
- BOM compare shows added/removed/changed entries (UI Child Z visible).
- Substitutes panel lists `UI Substitute`.
- Screenshot: `artifacts/plm-ui-regression-20260105_175324.png`.
