# PLM UI Integration Report - 2026-01-20

## Goal
Validate the MetaSheet PLM UI integration against Yuantus PLM so that product detail, where-used, BOM compare, and substitutes render end-to-end through the federation API.

## Scope
- MetaSheet core-backend launched with `PLM_API_MODE=yuantus` and Yuantus auth context.
- UI regression flow exercised: search -> product detail -> BOM -> where-used -> BOM compare -> substitutes -> documents -> approvals.
- Data seeded via PLM BOM tools before UI regression.

## Configuration
- `PLM_BASE_URL=http://127.0.0.1:7910`
- `PLM_TENANT_ID=tenant-1`
- `PLM_ORG_ID=org-1`
- `PLM_USERNAME=<redacted>`
- `PLM_PASSWORD=<redacted>`
- `PLM_API_MODE=yuantus` (set by the regression runner)

## Reproduction
```sh
PLM_API_MODE=yuantus PLM_BASE_URL=http://127.0.0.1:7910 \
PLM_TENANT_ID=tenant-1 PLM_ORG_ID=org-1 \
PLM_USERNAME=<user> PLM_PASSWORD=<password> \
bash scripts/verify-plm-ui-full.sh
```

## Outputs
- Full regression report: `docs/verification-plm-ui-full-20260120_235839.md`
- UI regression report: `docs/verification-plm-ui-regression-20260120_235839.md`
- UI screenshot: `artifacts/plm-ui-regression-20260120_235839.png`
- BOM tools seed report: `artifacts/plm-bom-tools-20260120_235839.md`

## Notes
- No code changes required; the existing PLM adapter + federation routes already expose Yuantus where-used, BOM compare, and substitutes to the UI.
- If cleanup is desired, re-run the verification with `PLM_CLEANUP=true` to remove seeded PLM fixtures.
