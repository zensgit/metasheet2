# PLM UI Integration Verification

Date: 2026-01-06

## Environment
- Web UI: http://127.0.0.1:8899/plm
- Core backend: http://127.0.0.1:7778
- PLM backend: http://127.0.0.1:7910
- PLM API mode: yuantus
- Tenant/Org: tenant-1 / org-1

## Test Data
- Parent item id: d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a
- Child item id: fdd72a36-be6e-4967-b697-13069e93f59f
- BOM line id: 027384a6-aea1-4b54-ae1b-0ada996ab9ca

## Steps
1. Open /plm page and refresh auth token.
2. Search products and confirm list renders.
3. Load product detail using parent item id.
4. Load BOM for parent item.
5. Load documents and approvals.
6. Query where-used using child item id.
7. Compare BOM using parent vs child item ids.
8. Query substitutes using BOM line id.

## Results
- Search: Total 550, list rendered.
- Product detail: Part A (Test) loaded.
- BOM: 1 line rendered (component Part B, qty 1, unit EA).
- Documents: empty list (expected).
- Approvals: empty list (UI view), API returns data.
- Where-used: count 1 (parent item shown).
- BOM compare: Removed 1, Added 0, Changed 0.
- Substitutes: 0 entries, "No substitutes found" displayed.

## Artifacts
- Screenshot capture via chrome-devtools timed out; no image saved.
