# PLM Health URL Overrides (2026-01-20)

## Summary
- Added `PLM_HEALTH_URLS` to override the health endpoints checked before BOM seed.
- Supports absolute URLs or relative paths (auto-prefixed with `PLM_BASE_URL`).

## Changes
- `scripts/verify-plm-ui-full.sh`
  - New env: `PLM_HEALTH_URLS` (default `/api/v1/health,/health`).
  - Health check now iterates over configured URLs.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_HEALTH_RETRY=1 PLM_HEALTH_INTERVAL=1 PLM_HEALTH_URLS=/api/v1/health,/health bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_193428.md`
    - `docs/verification-plm-ui-full-20260120_193428.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_193428.png`
    - `artifacts/plm-bom-tools-20260120_193428.json`
    - `artifacts/plm-bom-tools-20260120_193428.md`
