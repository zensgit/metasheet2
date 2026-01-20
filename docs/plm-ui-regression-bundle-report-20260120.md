# PLM UI Regression Failure Bundle (2026-01-20)

## Summary
- On regression failure, the script now creates a bundle archive with logs and key artifacts.
- Bundle includes backend/web logs, error screenshot, error response snapshot, run report, and BOM tools artifacts when present.

## Changes
- `scripts/verify-plm-ui-regression.sh`
  - Adds `Failure bundle` path to the report.
  - On failure, creates `artifacts/plm-ui-regression-<stamp>-bundle.tgz` with available artifacts.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_202035.md`
    - `docs/verification-plm-ui-full-20260120_202035.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_202035.png`
    - `artifacts/plm-bom-tools-20260120_202035.json`
    - `artifacts/plm-bom-tools-20260120_202035.md`
