# PLM UI Full Failure Bundle (2026-01-20)

## Summary
- Full regression now produces a failure bundle archive when either BOM seed or UI regression fails.
- Bundle includes logs, reports, and regression artifacts (including the regression bundle if present).

## Changes
- `scripts/verify-plm-ui-full.sh`
  - Captures BOM/UI status and writes them to the full report.
  - On failure, creates `artifacts/plm-ui-full-<stamp>-bundle.tgz` with key artifacts.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_204129.md`
    - `docs/verification-plm-ui-full-20260120_204129.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_204129.png`
    - `artifacts/plm-bom-tools-20260120_204129.json`
    - `artifacts/plm-bom-tools-20260120_204129.md`
