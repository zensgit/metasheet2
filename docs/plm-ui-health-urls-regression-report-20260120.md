# PLM Health URLs in Regression (2026-01-20)

## Summary
- Added `PLM_HEALTH_URLS` to PLM UI regression script to match full regression behavior.
- Health checks now accept absolute URLs or relative paths (auto-prefixed with `PLM_BASE_URL`).

## Changes
- `scripts/verify-plm-ui-regression.sh`
  - Added `PLM_HEALTH_URLS` env (default `/api/v1/health,/health`).
  - Health check iterates configured endpoints.
  - Regression report records `PLM_HEALTH_URLS`.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_HEALTH_URLS=/api/v1/health,/health bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_200741.md`
    - `docs/verification-plm-ui-full-20260120_200741.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_200741.png`
    - `artifacts/plm-bom-tools-20260120_200741.json`
    - `artifacts/plm-bom-tools-20260120_200741.md`
