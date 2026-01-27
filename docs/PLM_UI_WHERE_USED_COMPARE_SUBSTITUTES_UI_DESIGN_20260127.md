# PLM UI Where-Used / BOM Compare / Substitutes UI Design (2026-01-27)

## Scope
Validate PLM UI panels for:
- Where-Used
- BOM Compare
- Substitutes

## UI Entry
- Route: `/plm`
- Vite dev server: `http://127.0.0.1:8899/plm`

## Auth Strategy (UI)
- UI requests use `Authorization: Bearer <token>` from localStorage keys: `auth_token` / `jwt` / `devToken`.
- Use core-backend dev token endpoint in non-prod:
  - `GET /api/auth/dev-token?userId=dev-plm&roles=admin`
- For dev-only flows set `RBAC_TOKEN_TRUST=true` in core-backend env.

## Data Dependencies (Yuantus)
Seeded Parts and BOM:
- Parents: P1, P2
- Children: C1, C2
- Substitutes: S1, S2
- BOM Lines:
  - P1 -> C1 (bom_line_id)
  - P1 -> C2
  - P2 -> C1

## UI Behavior Checklist

### Where-Used Panel
- Input: item_id (C1)
- Options: recursive=true, maxLevels=3
- Expected:
  - count=2
  - parents include P1 + P2
- CSV export: `plm-where-used-<timestamp>.csv`

### BOM Compare Panel
- Inputs:
  - leftId=P1
  - rightId=P2
  - includeSubstitutes=true
  - includeEffectivity=true
- Expected:
  - schema loaded (line_fields > 0)
  - summary shows removed=1, changed=1
- CSV export:
  - list: `plm-bom-compare-<timestamp>.csv`
  - detail: `plm-bom-compare-detail-<timestamp>.csv`

### Substitutes Panel
- Input: bom_line_id for P1 -> C1
- Actions:
  - load list
  - add substitute (S2 + rank/note)
  - remove the newly added substitute
- Expected:
  - count increments (1 -> 2)
  - delete returns ok
- CSV export: `plm-substitutes-<timestamp>.csv`

## Deep Link + Presets
- Use deep link copy buttons for each panel
- Filter presets (where-used / BOM) should save + export + import JSON

## Environment
- core-backend: 7778
- web: 8899
- PLM (Yuantus): 7910
