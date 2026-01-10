# Verification: PLM CAD UI (Metadata Panel) - 20260110_1946

## Goal
Verify the CAD metadata panel against Yuantus PLM using real CAD files.

## Environment
- UI: http://127.0.0.1:8901/plm
- API: http://127.0.0.1:7779
- PLM: http://127.0.0.1:7910
- Tenant/org: tenant-1 / org-1

## Test Data
- CAD file A (DWG): /Users/huazhou/Downloads/训练图纸/训练图纸/J2824002-06上封头组件v2.dwg
- CAD file B (STEP): /Users/huazhou/Downloads/4000例CAD及三维机械零件练习图纸/机械CAD图纸/三维出二维图/CNC.stp
- CAD file A ID: c1fb5877-5316-459e-8f4c-14dd2a2fca26
- CAD file B ID: e8c28e22-0220-4238-950f-42455010c2fe

## Steps
1. Upload two CAD files to PLM.
2. Patch CAD properties/view-state/review for file A; patch properties for file B.
3. Open `/plm`, enter file IDs in the CAD panel, click "刷新 CAD".
4. Validate properties, view-state, review, history, then load diff.

## Results
- CAD properties loaded (AL-6061 vs AL-7075).
- CAD view state loaded (notes include "check fit").
- CAD review loaded (approved).
- CAD history loaded (cad_properties_update entry).
- CAD diff loaded (material/weight changes shown).
- Mesh stats: empty (expected unless CAD metadata extraction is enabled).
- Screenshot: artifacts/plm-cad-ui-20260110_1946.png
