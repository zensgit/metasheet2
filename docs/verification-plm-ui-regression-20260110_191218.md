# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260110_191218

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8901/plm
- API: http://127.0.0.1:7779
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260110_191218.json

## Data
- Search query: UI-CMP-A-1768043541
- Product ID: 2615d1d7-ef16-4e60-ace4-653eba850d3d
- Where-used child ID: bada15c7-d80d-4dbb-9952-ad31c86d9c68
- Where-used expect: R1,R2
- BOM compare left/right: 2615d1d7-ef16-4e60-ace4-653eba850d3d / 461b3e95-7ab8-44bd-83a0-87425ebc1b99
- BOM compare expect: UI Child Z
- Substitute BOM line: 2765234d-f86b-482c-9f07-b0d5eadf4789
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260110_191218.png
