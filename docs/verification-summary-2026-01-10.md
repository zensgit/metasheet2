# Verification Summary - 2026-01-10

## Completed
- PLM UI itemNumber fallback (Yuantus): `docs/verification-plm-ui-item-number-20260110_1451.md`
- PLM UI itemNumber regression script: `docs/verification-plm-ui-itemnumber-20260110_150452.md`
- Frontend type check: `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- PLM BOM tools seed data: `artifacts/plm-bom-tools-20260110_1521.md`
- PLM UI regression: `docs/verification-plm-ui-regression-20260110_152243.md`
- PLM BOM tools seed data (post-auth fix): `artifacts/plm-bom-tools-20260110_160733.md`
- PLM UI regression (post-auth fix): `docs/verification-plm-ui-regression-20260110_160733.md`
- PLM UI full regression wrapper: `docs/verification-plm-ui-full-20260110_160733.md`
- PLM BOM tools seed data (identity DB fix): `artifacts/plm-bom-tools-20260110_170622.md`
- PLM UI regression (identity DB fix): `docs/verification-plm-ui-regression-20260110_170622.md`
- PLM UI full regression wrapper (identity DB fix): `docs/verification-plm-ui-full-20260110_170622.md`
- PLM BOM tools seed data (post-restart): `artifacts/plm-bom-tools-20260110_200411.md`
- PLM UI regression (post-restart): `docs/verification-plm-ui-regression-20260110_200411.md`
- PLM UI full regression wrapper (post-restart): `docs/verification-plm-ui-full-20260110_200411.md`
- PLM BOM tools seed data (post-script restore): `artifacts/plm-bom-tools-20260110_205054.md`
- PLM UI regression (post-script restore): `docs/verification-plm-ui-regression-20260110_205054.md`
- PLM UI full regression wrapper (post-script restore): `docs/verification-plm-ui-full-20260110_205054.md`
- PLM BOM tools seed data (post-script restore rerun): `artifacts/plm-bom-tools-20260110_205738.md`
- PLM UI regression (post-script restore rerun): `docs/verification-plm-ui-regression-20260110_205738.md`
- PLM UI full regression wrapper (post-script restore rerun): `docs/verification-plm-ui-full-20260110_205738.md`
- PLM BOM tools seed data (cleanup disabled): `artifacts/plm-bom-tools-20260110_212458.md`
- PLM UI regression (cleanup disabled): `docs/verification-plm-ui-regression-20260110_212458.md`
- PLM UI full regression wrapper (cleanup disabled): `docs/verification-plm-ui-full-20260110_212458.md`
- PLM UI regression (read-only): `docs/verification-plm-ui-regression-20260110_212915.md`
- PLM UI full regression wrapper (read-only): `docs/verification-plm-ui-full-20260110_212915.md`
- PLM UI regression (read-only rerun): `docs/verification-plm-ui-regression-20260110_220120.md`
- PLM UI full regression wrapper (read-only rerun): `docs/verification-plm-ui-full-20260110_220120.md`
- PLM UI regression (readonly smoke): `docs/verification-plm-ui-regression-20260110_223640.md`
- PLM UI full regression wrapper (readonly smoke): `docs/verification-plm-ui-full-20260110_223640.md`

## Environment Notes
- Backend restarted with Yuantus PLM env vars and `RBAC_BYPASS=true` for verification.
- Yuantus identity DB moved to Postgres + admin seeded (`yuantus db upgrade`, `yuantus seed-identity`).
