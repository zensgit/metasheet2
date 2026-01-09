# Verification: PLM Substitutes Mutation - 20260108_152816

## Goal
Verify adding/removing BOM substitutes through federation mutation endpoints.

## Environment
- MetaSheet API: http://localhost:7788
- PLM Base URL: http://127.0.0.1:7910
- Tenant/Org: tenant-1/org-1

## Data
- BOM line id: ebf13471-9f6c-42ea-8ac9-2894de1b4c34
- Substitute part id: 792d44b0-1497-4589-afcf-89f4bd3128cd
- Substitute relationship id: 50168a3f-f521-45b5-b36a-8b2a1833f317

## Results
- Add substitute: OK
- List substitutes (after add): non-empty
- Remove substitute: OK
- List substitutes (after remove): removed

## Artifacts
- JSON: artifacts/plm-substitutes-mutation-20260108_152816.json
