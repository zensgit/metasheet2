# PLM Health Retry (CI Default) - 2026-01-20

## Summary
- CI runs now default to a PLM health retry window without changing local defaults.
- Local behavior remains `PLM_HEALTH_RETRY=0` unless explicitly set.

## Changes
- `scripts/verify-plm-ui-full.sh`
  - If `CI` is set and `PLM_HEALTH_RETRY`/`PLM_HEALTH_INTERVAL` are unset, defaults to 3 retries with 2s interval.
  - Local defaults remain unchanged when `CI` is not set.

## Verification
- `CI=1 AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_175542.md`
    - `docs/verification-plm-ui-full-20260120_175542.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_175542.png`
    - `artifacts/plm-bom-tools-20260120_175542.json`
    - `artifacts/plm-bom-tools-20260120_175542.md`
