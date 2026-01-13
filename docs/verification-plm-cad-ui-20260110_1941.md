# Verification: PLM CAD UI (Metadata Panel) - 20260110_1941

## Goal
Verify the CAD metadata panel against a real Yuantus PLM instance.

## Environment
- UI: http://127.0.0.1:8901/plm
- API: http://127.0.0.1:7779
- PLM: http://127.0.0.1:7910
- Tenant/org: tenant-1 / org-1

## Test Data
- CAD file A: 0cd20901-f3f8-42bd-922a-b74e900a8552
- CAD file B: 72c53083-50ac-4e62-a61b-1aecaedcb431

## Steps
1. Upload two sample files to PLM and patch CAD properties/view-state/review on file A.
2. Open `/plm`, set CAD File ID and Compare File ID.
3. Click “刷新 CAD” and validate properties/view-state/review/history loaded.
4. Click “加载” in the diff panel and validate diff payload.

## Results
- CAD properties loaded (material AL-6061, weight_kg 1.2).
- CAD view state loaded (notes include "check fit").
- CAD review loaded (state approved).
- CAD history loaded (cad_properties_update entry present).
- CAD diff loaded (material changed to AL-7075, weight_kg changed).
- Mesh stats: empty (expected for text uploads without CAD metadata).
- Screenshot: artifacts/plm-cad-ui-20260110_1941.png
