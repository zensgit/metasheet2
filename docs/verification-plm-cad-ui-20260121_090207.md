# Verification: PLM CAD UI (Real Samples) - 20260121_090207

## Goal
Validate PLM CAD metadata UI against real DWG/STEP samples (properties, view state, review, diff), and record current mesh-stats behavior.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- Tenant/Org: tenant-1 / org-1
- MetaSheet token: dev/test token (admin, federation:read/write)

## Fixtures
- Fixture JSON: `artifacts/plm-cad-ui-fixtures-20260121_084404.json`
- CAD file A (DWG): `<local-path>/J2824002-06上封头组件v2.dwg`
  - file_id: `630a312a-628f-40b7-b5cc-5f317536aa5e`
  - properties: material=AL-6061, weight_kg=1.2, finish=anodized
  - view_state notes: check fit, verify clearance
  - review: approved, note=dimensions ok
- CAD file B (STEP): `<local-path>/CNC.stp`
  - file_id: `fe94aaec-ddab-4bfd-af5f-5f991056bad1`
  - properties: material=AL-7075, weight_kg=1.4, finish=etched

## Steps
1. Open PLM page and load CAD panel.
2. Fill CAD File ID (A) and Compare File ID (B).
3. Click “刷新 CAD”.
4. Validate properties/view state/review inputs populate with expected values.
5. Click “差异 → 加载” and confirm diff reflects AL-6061 → AL-7075.

## Results
- cad_properties: material AL-6061 shown in properties draft.
- cad_view_state: notes include “check fit”.
- cad_review: state=approved, note=dimensions ok.
- cad_diff: material change to AL-7075 confirmed.
- cad_mesh_stats: upstream returns 404; UI shows “网格统计: Request failed with status code 404” (expected until mesh stats are supported).
- Screenshot: `artifacts/plm-cad-ui-20260121_090207.png`

## Notes
- PLM cad_history and cad_mesh_stats are requested in parallel; only mesh_stats is missing upstream.
