# Lookup/Rollup Chain Verification (2025-12-24)

## Scope
- Validate lookup + rollup computation across linked sheets.
- Verify cross-sheet updates return `relatedRecords` and update rollup values.

## Setup
- Backend: `@metasheet/core-backend` (dev mode)
- DB: `postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet`
- Auth: `/api/auth/dev-token`

## Script
- `scripts/verify-lookup-rollup-chain.mjs`

## Run
```bash
node scripts/verify-lookup-rollup-chain.mjs > artifacts/lookup-rollup-chain.json
```

## Results
- API base: `http://127.0.0.1:7778`
- Foreign sheet: `lookup_foreign_20251224093856995`
- Source sheet: `lookup_source_20251224093856995`
- Foreign fields:
  - name: `fld_foreign_name_20251224093856995`
  - amount: `fld_foreign_amount_20251224093856995`
- Source fields:
  - name: `fld_source_name_20251224093856995`
  - link: `fld_source_link_20251224093856995`
  - lookup: `fld_source_lookup_20251224093856995`
  - rollup: `fld_source_rollup_20251224093856995`
- Checks:
  - Source record exists after creation ✅
  - Lookup returns names from linked sheet ✅
  - Rollup sum = 300 before update ✅
  - Patch returns `relatedRecords` for source sheet ✅
  - Related rollup = 500 after foreign update ✅
  - Source rollup = 500 after refresh ✅

## Artifacts
- `artifacts/lookup-rollup-chain.json`
