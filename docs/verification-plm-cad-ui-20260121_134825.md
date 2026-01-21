# Verification: PLM CAD UI (Mesh-Stats Fallback) - 20260121_134825

## Goal
Validate CAD metadata panel after mesh-stats fallback change (no error banner, values load, diff works).

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- Tenant/Org: tenant-1 / org-1

## Fixtures
- CAD file A (DWG): `630a312a-628f-40b7-b5cc-5f317536aa5e`
- CAD file B (STEP): `fe94aaec-ddab-4bfd-af5f-5f991056bad1`

## Checks
- cad_properties: material AL-6061 shown
- cad_view_state: note "check fit"
- cad_review: state=approved, note=dimensions ok
- cad_mesh_stats: response OK (no error banner)
- cad_diff: material change to AL-7075

## Artifacts
- Screenshot: `artifacts/plm-cad-ui-20260121_134825.png`
