# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260110_175338

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8901/plm
- API: http://127.0.0.1:7779
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260110_1737.json

## Data
- Search query: UI-CMP-A-1768037866
- Product ID: 0a62c82e-9712-4f22-a086-15212becf5d8
- Where-used child ID: ff339e8c-0c45-4d3f-8a51-99d9bac82b39
- Where-used expect: R1,R2
- BOM compare left/right: 0a62c82e-9712-4f22-a086-15212becf5d8 / c162fecc-6948-4a30-82ce-b8dc0f5fcf0b
- BOM compare expect: UI Child Z
- Substitute BOM line: d2cfb1fb-6bc8-42ed-b046-a7d7eaeab703
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260110_175338.png
