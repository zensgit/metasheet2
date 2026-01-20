# PLM UI Full Bundle Always (2026-01-20)

## Summary
- Added `FULL_BUNDLE_ALWAYS` flag to always create a bundle archive after full regression runs.
- Useful for sharing artifacts with integration teams even on success.

## Changes
- `scripts/verify-plm-ui-full.sh`
  - `FULL_BUNDLE_ALWAYS=true` forces creation of `artifacts/plm-ui-full-<stamp>-bundle.tgz`.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 FULL_BUNDLE_ALWAYS=true bash scripts/verify-plm-ui-full.sh`
  - Reports:
    - `docs/verification-plm-ui-regression-20260120_204826.md`
    - `docs/verification-plm-ui-full-20260120_204826.md`
  - Artifacts:
    - `artifacts/plm-ui-regression-20260120_204826.png`
    - `artifacts/plm-bom-tools-20260120_204826.json`
    - `artifacts/plm-bom-tools-20260120_204826.md`
    - `artifacts/plm-ui-full-20260120_204826-bundle.tgz`
