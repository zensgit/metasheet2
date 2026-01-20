# PLM Health Retry for Full Regression (2026-01-20)

## Summary
- Added optional PLM health retry in `verify-plm-ui-full.sh` for cold-start environments.
- Configurable with `PLM_HEALTH_RETRY` and `PLM_HEALTH_INTERVAL`.

## Changes
- `scripts/verify-plm-ui-full.sh`
  - Adds `check_plm_health` before BOM seed.
  - Env vars:
    - `PLM_HEALTH_RETRY` (default 0)
    - `PLM_HEALTH_INTERVAL` (seconds, default 2)

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 PLM_HEALTH_RETRY=3 PLM_HEALTH_INTERVAL=2 bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_172726.md`
    - `docs/verification-plm-ui-full-20260120_172726.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_172726.png`
    - `artifacts/plm-bom-tools-20260120_172726.json`
    - `artifacts/plm-bom-tools-20260120_172726.md`
