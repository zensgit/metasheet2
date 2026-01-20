# PLM UI BOM Tools Search Fix Report

## Goal
Ensure PLM UI regression can validate BOM find_num/refdes and product search results when using the BOM tools seed data.

## Changes
- `scripts/verify-plm-bom-tools.sh`
  - Seed parent A child line with explicit find_num/refdes.
  - Persist BOM find_num/refdes into the BOM JSON payload (`bom` + `fixtures`).
  - Trigger Yuantus search reindex so product search returns seeded items.

## Rationale
UI regression validates BOM `find_num`/`refdes` on the product BOM table and expects search results for the seeded item. The seed script previously recorded no BOM metadata and did not reindex search, so the UI workflow timed out or failed validation.

## Verification
- `AUTO_START=true PLM_BASE_URL=http://127.0.0.1:7910 bash scripts/verify-plm-ui-full.sh`
- Reports:
  - `docs/verification-plm-ui-regression-20260120_090142.md`
  - `docs/verification-plm-ui-full-20260120_090142.md`
- Artifacts:
  - `artifacts/plm-bom-tools-20260120_090142.json`
  - `artifacts/plm-bom-tools-20260120_090142.md`
  - `artifacts/plm-ui-regression-20260120_090142.png`

Status: PASS
