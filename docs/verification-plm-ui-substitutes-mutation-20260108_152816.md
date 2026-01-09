# Verification: PLM UI Substitutes Mutation - 20260108_152816

## Goal
Verify adding/removing BOM substitutes in the PLM UI.

## Environment
- UI: http://localhost:8898/plm
- API: http://localhost:7788
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1

## Data
- Product ID: 74b31641-d9ec-416d-85f9-920da2c43175
- Search query: MS-PLM-SUBS-local-PARENT
- BOM line ID: a5435929-379f-4065-b77d-5f159c7d9e18
- Substitute item ID: bc496f56-bd33-451d-8994-03b80b811a76

## Results
- Loaded substitutes panel.
- Added substitute entry via UI.
- Removed substitute entry via UI.
- Screenshot: artifacts/plm-ui-substitutes-mutation-20260108_152816.png
