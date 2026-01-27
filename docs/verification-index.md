# Verification Index

This index groups the most-used verification commands and the corresponding reports/artifacts.

Entry points:
- README: `README.md` (Documentation Quick Links)
- Docs Index: `docs/INDEX.md` (测试和验证)

## Daily / Pre-PR

- Verification summary (latest):
  - Report: `docs/verification-summary-2026-01-18.md`
  - Previous: `docs/verification-summary-2026-01-17.md`

- Univer POC runtime start (core mode):
  - Report: `docs/verification-univer-poc-runtime-20260106_1207.md`
  - Report: `docs/verification-univer-poc-runtime-20260106_1217.md`

- Migrations + typecheck:
  - Report: `docs/verification-migrations-typecheck-20260106_1217.md`

- Smoke verification:
  - Report: `docs/verification-smoke-20260106_2041.md`
  - Artifact: `artifacts/smoke/smoke-report-20260106_2041.json`

- Core backend typecheck + runtime attempt:
  - Report: `docs/verification-core-backend-typecheck-20260105_1553.md`

- Comments smoke (API + UI):
  - Run: `pnpm verify:comments`
  - Reports: `docs/verification-comments-api-2025-12-22.md`, `docs/verification-comments-ui-2025-12-22.md`
  - Artifacts: `artifacts/comments-ui-grid.png`, `artifacts/comments-ui-kanban.png`

- Comments RBAC enforcement:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Comments RBAC"`
  - Report: `docs/verification-comments-rbac-2025-12-23.md`

- Labs/POC gating (UI):
  - Run: `pnpm verify:labs-gating`
  - Output: `artifacts/labs-gating-verification.json`
  - Report: `docs/verification-labs-gating-2025-12-27.md`

- Real systems adapter probe:
  - Run: `bash scripts/adapter-probe.sh` + `bash scripts/test-real-systems.sh`
  - Report: `docs/verification-real-systems-2025-12-28.md`

- PLM real system verification:
  - Report: `docs/verification-plm-2025-12-28.md`

- Yuantus PLM verification:
  - Script: `scripts/verify-yuantus-plm.sh`
  - Run: `pnpm verify:yuantus`
  - Report: `docs/verification-yuantus-plm-20251231_1507.md`
  - Connection notes: `docs/yuantus-plm-connection.md`
  - External env checklist: `docs/PLM_EXTERNAL_ENV_CHECKLIST.md`
  - Report: `docs/verification-plm-yuantus-20260108_132652.md`
  - Report: `docs/verification-plm-yuantus-20260108_134341.md`

- PLM product detail mapping:
  - Report: `docs/verification-plm-product-detail-20260104_1132.md`
- PLM product detail mapping (item number fallback):
  - Report: `docs/verification-plm-product-detail-item-number-20260115_204327.md`
- PLM adapter mapping (product/docs/approvals):
  - Report: `docs/verification-plm-adapter-mapping-20260104_1559.md`
- PLM field mapping API verification:
  - Script: `scripts/verify-plm-field-mapping.sh`
  - Report: `docs/verification-plm-field-mapping-api-20260105_150732.md`
  - Report: `docs/verification-plm-field-mapping-api-20260105_062050.md`
  - Report: `docs/verification-plm-field-mapping-api-20260105_062646.md`
  - Artifact: `artifacts/plm-field-mapping-api-20260105_150732.json`
  - Artifact: `artifacts/plm-field-mapping-api-20260105_062032.json`
  - Artifact: `artifacts/plm-field-mapping-api-20260105_062646.json`

- PLM documents/approvals backend mapping:
  - Report: `docs/verification-plm-docs-approvals-backend-20260101_0201.md`

- PLM documents/approvals UI:
  - Report: `docs/verification-plm-docs-approvals-ui-20260101_0203.md`

- PLM documents/approvals federation:
  - Script: `scripts/verify-plm-docs-approvals.sh`
  - Report: `docs/verification-plm-docs-approvals-federation-20260101_1301.md`
  - Report: `docs/verification-plm-docs-approvals-federation-20260106_2049.md`
  - Report: `docs/verification-plm-docs-approvals-federation-20260106_2101.md`

- PLM (Yuantus) direct API verification:
  - Report: `docs/verification-plm-yuantus-20260106_2049.md`
  - Report: `docs/verification-plm-yuantus-20260106_2101.md`
  - Artifact: `artifacts/verification-plm-yuantus-20260106_2049.log`
  - Artifact: `artifacts/verification-plm-yuantus-20260106_2101.log`
  - Report: `docs/verification-plm-docs-approvals-federation-20260105_062050.md`

- PLM CAD batch import:
  - Script: `scripts/import-plm-cad-files.sh`
  - Report: `docs/verification-plm-cad-import-20260101_1212.md`
  - Artifact: `artifacts/plm-cad-import-20260101_1210.json`

- PLM CAD duplicate cleanup:
  - Script: `scripts/cleanup-plm-duplicate-parts.py`
  - Report: `docs/verification-plm-cad-duplicate-cleanup-20260101_1257.md`
  - Artifact: `artifacts/plm-cad-duplicate-cleanup-20260101_1256.json`

- PLM CAD conversion (preview + geometry):
  - Script: `scripts/verify-plm-cad-conversion.sh`
  - Report: `docs/verification-plm-cad-conversion-20260101_1319.md`
  - Artifact: `artifacts/plm-cad-conversion-20260101_1319.json`

- PLM CADGF 2D pipeline (DWG/DXF):
  - Report: `docs/verification-plm-cadgf-2d-conversion-20260101_1325.md`

- PLM UI integration:
  - Report: `docs/verification-plm-ui-20251231_1540.md`
  - Notes: includes substitutes verification and token retry behavior (query/select/insert/update/delete)
- PLM UI update (updatedAt fallback):
  - Report: `docs/verification-plm-ui-20260104_1220.md`
- PLM UI verification (product + docs):
  - Report: `docs/verification-plm-ui-20260105_174643.md`
  - Artifact: `artifacts/plm-ui-product-docs-20260105_174643.png`
- PLM UI empty states:
  - Report: `docs/verification-plm-ui-empty-states-20260105_175520.md`
  - Artifact: `artifacts/plm-ui-empty-hints-20260105_180232.png`
- PLM UI BOM compare field mapping:
  - Report: `docs/verification-plm-ui-bom-compare-fieldmap-20260115_1759.md`
  - Artifact: `artifacts/plm-bom-compare-schema-20260115_1759.json`
- PLM UI field mapping (product/doc/approval):
  - Report: `docs/verification-plm-ui-field-mapping-20260104_1520.md`
  - Artifact: `artifacts/plm-ui-field-mapping-20260104_1520.png`
- PLM UI where-used path view:
  - Report: `docs/verification-plm-ui-where-used-path-20260104_1314.md`
  - Artifacts: `artifacts/where-used-path-20260104_1314.json`, `artifacts/plm-ui-where-used-path-20260104_1330.png`
- PLM UI multi-select copy (BOM + Where-Used):
  - Report: `docs/PLM_UI_MULTISELECT_COPY_REPORT.md`
- PLM UI BOM compare detail:
  - Report: `docs/PLM_UI_BOM_COMPARE_DETAIL_REPORT.md`
- PLM UI BOM compare linking:
  - Report: `docs/PLM_UI_BOM_COMPARE_LINK_REPORT.md`
- PLM UI filter presets:
  - Report: `docs/PLM_UI_FILTER_PRESETS_REPORT.md`

- PLM BOM tools federation:
  - Script: `scripts/verify-plm-bom-tools.sh`
  - Report: `docs/verification-plm-bom-tools-20260102_0011.md`
  - Artifact: `artifacts/plm-bom-tools-20260102_0011.json`
  - Report: `docs/verification-plm-bom-tools-20260105_0835.md`
  - Artifact: `artifacts/plm-bom-tools-20260105_0835.json`
  - JSON mirror: `docs/verification-plm-bom-tools-20260105_0835.json`
  - Report: `artifacts/plm-bom-tools-20260108_1300.md`
  - Artifact: `artifacts/plm-bom-tools-20260108_1300.json`
  - Report: `artifacts/plm-bom-tools-20260108_1342.md`
  - Artifact: `artifacts/plm-bom-tools-20260108_1342.json`
  - Report: `artifacts/plm-bom-tools-20260108_150410.md`
  - Artifact: `artifacts/plm-bom-tools-20260108_150410.json`
  - Report: `artifacts/plm-bom-tools-20260108_151809.md`
  - Artifact: `artifacts/plm-bom-tools-20260108_151809.json`
  - Report: `artifacts/plm-bom-tools-20260108_152816.md`
  - Artifact: `artifacts/plm-bom-tools-20260108_152816.json`
  - Report: `artifacts/plm-bom-tools-20260110_1521.md`
  - Artifact: `artifacts/plm-bom-tools-20260110_1521.json`
  - Report: `artifacts/plm-bom-tools-20260110_160733.md`
  - Artifact: `artifacts/plm-bom-tools-20260110_160733.json`
  - Report: `artifacts/plm-bom-tools-20260110_170622.md`
  - Artifact: `artifacts/plm-bom-tools-20260110_170622.json`
  - Report: `artifacts/plm-bom-tools-20260115_2201.md`
  - Artifact: `artifacts/plm-bom-tools-20260115_2201.json`
  - Report: `artifacts/plm-bom-tools-20260115_2229.md`
  - Artifact: `artifacts/plm-bom-tools-20260115_2229.json`
  - Report: `artifacts/plm-bom-tools-20260116_101817.md`
  - Artifact: `artifacts/plm-bom-tools-20260116_101817.json`
  - Report: `artifacts/plm-bom-tools-20260116_1352.md`
  - Artifact: `artifacts/plm-bom-tools-20260116_1352.json`
  - Report: `artifacts/plm-bom-tools-20260116_143745.md`
  - Artifact: `artifacts/plm-bom-tools-20260116_143745.json`
  - Report: `artifacts/plm-bom-tools-20260116_160002.md`
  - Artifact: `artifacts/plm-bom-tools-20260116_160002.json`
  - Report: `artifacts/plm-bom-tools-20260116_164234.md`
  - Artifact: `artifacts/plm-bom-tools-20260116_164234.json`
  - Report: `artifacts/plm-bom-tools-20260116_214533.md`
  - Artifact: `artifacts/plm-bom-tools-20260116_214533.json`
  - Report: `artifacts/plm-bom-tools-20260117_004806.md`
  - Artifact: `artifacts/plm-bom-tools-20260117_004806.json`
  - Report: `artifacts/plm-bom-tools-20260117_164857.md`
  - Artifact: `artifacts/plm-bom-tools-20260117_164857.json`
  - Report: `artifacts/plm-bom-tools-20260117_203043.md`
  - Artifact: `artifacts/plm-bom-tools-20260117_203043.json`
  - Report: `artifacts/plm-bom-tools-20260117_205457.md`
  - Artifact: `artifacts/plm-bom-tools-20260117_205457.json`
  - Report: `artifacts/plm-bom-tools-20260117_224348.md`
  - Artifact: `artifacts/plm-bom-tools-20260117_224348.json`
- PLM UI BOM tools:
  - Report: `docs/verification-plm-ui-bom-tools-20260105_175018.md`
  - Artifact: `artifacts/plm-ui-bom-tools-20260105_175018.png`
- PLM UI regression (search → detail → BOM tools):
  - Script: `scripts/verify-plm-ui-regression.sh`
  - Report: `docs/verification-plm-ui-regression-20260105_175324.md`
  - Artifact: `artifacts/plm-ui-regression-20260105_175324.png`
  - Report: `docs/verification-plm-ui-regression-20260105_181443.md`
  - Artifact: `artifacts/plm-ui-regression-20260105_181443.png`
  - Report: `docs/verification-plm-ui-regression-20260105_212131.md`
  - Artifact: `artifacts/smoke/plm-ui-regression-20260105_212131.png`
  - Report: `docs/verification-plm-ui-regression-20260106_232444.md`
  - Artifact: `artifacts/plm-ui-regression-20260106_232444.png`
  - Report: `docs/verification-plm-ui-regression-20260106_233239.md`
  - Artifact: `artifacts/plm-ui-regression-20260106_233239.png`
  - Report: `docs/verification-plm-ui-regression-20260106_234159.md`
  - Artifact: `artifacts/plm-ui-regression-20260106_234159.png`
  - Report: `docs/verification-plm-ui-regression-20260107_081948.md`
  - Artifact: `artifacts/plm-ui-regression-20260107_081948.png`
  - Report: `docs/verification-plm-ui-regression-20260107_083647.md`
  - Artifact: `artifacts/plm-ui-regression-20260107_083647.png`
  - Report: `docs/verification-plm-ui-regression-20260107_095120.md`
  - Artifact: `artifacts/plm-ui-regression-20260107_095120.png`
  - Report: `docs/verification-plm-ui-regression-20260107_114729.md`
  - Artifact: `artifacts/plm-ui-regression-20260107_114729.png`
  - Report: `docs/verification-plm-ui-regression-20260107_121733.md`
  - Artifact: `artifacts/plm-ui-regression-20260107_121733.png`
  - Report: `docs/verification-plm-ui-regression-20260107_134716.md`
  - Artifact: `artifacts/plm-ui-regression-20260107_134716.png`
  - Report: `docs/verification-plm-ui-regression-20260107_135236.md`
  - Artifact: `artifacts/plm-ui-regression-20260107_135236.png`
  - Report: `docs/verification-plm-ui-regression-20260107_140207.md`
  - Artifact: `artifacts/plm-ui-regression-20260107_140207.png`
  - Report: `docs/verification-plm-ui-regression-20260107_140512.md`
  - Artifact: `artifacts/plm-ui-regression-20260107_140512.png`
  - Report: `docs/verification-plm-ui-regression-20260108_082156.md`
  - Artifact: `artifacts/plm-ui-regression-20260108_082156.png`
  - Report: `docs/verification-plm-ui-regression-20260108_082656.md`
  - Artifact: `artifacts/plm-ui-regression-20260108_082656.png`
  - Report: `docs/verification-plm-ui-regression-20260108_083007.md`
  - Artifact: `artifacts/plm-ui-regression-20260108_083007.png`
  - Report: `docs/verification-plm-ui-regression-20260108_084135.md`
  - Artifact: `artifacts/plm-ui-regression-20260108_084135.png`
  - Report: `docs/verification-plm-ui-regression-20260108_085551.md`
  - Artifact: `artifacts/plm-ui-regression-20260108_085551.png`
  - Report: `docs/verification-plm-ui-regression-20260108_130225.md`
  - Artifact: `artifacts/plm-ui-regression-20260108_130225.png`
  - Report: `docs/verification-plm-ui-regression-20260108_134247.md`
  - Artifact: `artifacts/plm-ui-regression-20260108_134247.png`
  - Report: `docs/verification-plm-ui-regression-20260108_141810.md`
  - Artifact: `artifacts/plm-ui-regression-20260108_141810.png`
  - Report: `docs/verification-plm-ui-regression-20260110_170622.md`
  - Artifact: `artifacts/plm-ui-regression-20260110_170622.png`
  - Report: `docs/verification-plm-ui-regression-20260110_175338.md`
  - Artifact: `artifacts/plm-ui-regression-20260110_175338.png`
  - Report: `docs/verification-plm-ui-regression-20260110_181245.md`
  - Artifact: `artifacts/plm-ui-regression-20260110_181245.png`
  - Report: `docs/verification-plm-ui-regression-20260110_191218.md`
  - Artifact: `artifacts/plm-ui-regression-20260110_191218.png`
  - Report: `docs/verification-plm-ui-regression-20260114_132755.md`
  - Artifact: `artifacts/plm-ui-regression-20260114_132755.png`
  - Report: `docs/verification-plm-ui-regression-20260114_132810.md`
  - Artifact: `artifacts/plm-ui-regression-20260114_132810.png`
  - Report: `docs/verification-plm-ui-regression-20260114_133500.md`
  - Artifact: `artifacts/plm-ui-regression-20260114_133500.png`
  - Report: `docs/verification-plm-ui-regression-20260114_221321.md`
  - Artifact: `artifacts/plm-ui-regression-20260114_221321.png`
  - Report: `docs/verification-plm-ui-regression-20260115_084812.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_084812.png`
  - Report: `docs/verification-plm-ui-regression-20260115_100152.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_100152.png`
  - Report: `docs/verification-plm-ui-regression-20260115_142128.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_142128.png`
  - Report: `docs/verification-plm-ui-regression-20260115_144649.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_144649.png`
  - Report: `docs/verification-plm-ui-regression-20260115_144649.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_144649.png`
  - Report: `docs/verification-plm-ui-regression-20260115_164310.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_164310.png`
  - Report: `docs/verification-plm-ui-regression-20260115_173732.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_173732.png`
  - Report: `docs/verification-plm-ui-regression-20260115_212143.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_212143.png`
  - Report: `docs/verification-plm-ui-regression-20260115_220146.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_220146.png`
  - Report: `docs/verification-plm-ui-regression-20260115_222941.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_222941.png`
  - Report: `docs/verification-plm-ui-regression-20260115_230030.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_230030.png`
  - Report: `docs/verification-plm-ui-regression-20260115_231459.md`
  - Artifact: `artifacts/plm-ui-regression-20260115_231459.png`
  - Artifact: `artifacts/plm-ui-regression-item-number-20260115_231459.json`
  - Report: `docs/verification-plm-ui-regression-20260116_101817.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_101817.png`
  - Report: `docs/verification-plm-ui-regression-20260116_113652.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_113652.png`
  - Report: `docs/verification-plm-ui-regression-20260116_113652.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_113652.png`
  - Report: `docs/verification-plm-ui-regression-20260116_122014.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_122014.png`
  - Artifact: `artifacts/plm-ui-regression-item-number-20260116_122014.json`
  - Report: `docs/verification-plm-ui-regression-20260116_132934.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_132934.png`
  - Artifact: `artifacts/plm-ui-regression-item-number-20260116_132934.json`
  - Report: `docs/verification-plm-ui-regression-20260116_135254.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_135254.png`
  - Artifact: `artifacts/plm-ui-regression-item-number-20260116_135254.json`
  - Report: `docs/verification-plm-ui-regression-20260116_141451.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_141451.png`
  - Artifact: `artifacts/plm-ui-regression-item-number-20260116_141451.json`
  - Report: `docs/verification-plm-ui-regression-20260116_141451.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_141451.png`
  - Report: `docs/verification-plm-ui-regression-20260116_143745.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_143745.png`
  - Artifact: `artifacts/plm-ui-regression-item-number-20260116_143745.json`
  - Report: `docs/verification-plm-ui-regression-20260116_150725.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_150725.png`
  - Report: `docs/verification-plm-ui-regression-20260116_151519.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_151519.png`
  - Report: `docs/verification-plm-ui-regression-20260116_160002.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_160002.png`
  - Report: `docs/verification-plm-ui-regression-20260116_164234.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_164234.png`
  - Report: `docs/verification-plm-ui-regression-20260116_214533.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_214533.png`
  - Report: `docs/verification-plm-ui-regression-20260116_160002.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_160002.png`
  - Report: `docs/verification-plm-ui-regression-20260116_164234.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_164234.png`
  - Report: `docs/verification-plm-ui-regression-20260116_214533.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_214533.png`
  - Report: `docs/verification-plm-ui-regression-20260116_220926.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_220926.png`
  - Report: `docs/verification-plm-ui-regression-20260116_222036.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_222036.png`
  - Report: `docs/verification-plm-ui-regression-20260116_222236.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_222236.png`
  - Report: `docs/verification-plm-ui-regression-20260116_223428.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_223428.png`
  - Report: `docs/verification-plm-ui-regression-20260116_224234.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_224234.png`
  - Report: `docs/verification-plm-ui-regression-20260116_224702.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_224702.png`
  - Report: `docs/verification-plm-ui-regression-20260116_230221.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_230221.png`
  - Report: `docs/verification-plm-ui-regression-20260116_222036.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_222036.png`
  - Report: `docs/verification-plm-ui-regression-20260116_222236.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_222236.png`
  - Report: `docs/verification-plm-ui-regression-20260116_223428.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_223428.png`
  - Report: `docs/verification-plm-ui-regression-20260116_224234.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_224234.png`
  - Report: `docs/verification-plm-ui-regression-20260116_224702.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_224702.png`
  - Report: `docs/verification-plm-ui-regression-20260116_230221.md`
  - Artifact: `artifacts/plm-ui-regression-20260116_230221.png`
  - Report: `docs/verification-plm-ui-regression-20260117_000120.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_000120.png`
  - Report: `docs/verification-plm-ui-regression-20260117_003616.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_003616.png`
  - Report: `docs/verification-plm-ui-regression-20260117_151709.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_151709.png`
  - Report: `docs/verification-plm-ui-regression-20260117_164626.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_164626.png`
  - Report: `docs/verification-plm-ui-regression-20260117_164857.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_164857.png`
  - Report: `docs/verification-plm-ui-regression-20260117_170038.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_170038.png`
  - Report: `docs/verification-plm-ui-regression-20260117_174520.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_174520.png`
  - Report: `docs/verification-plm-ui-regression-20260117_203043.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_203043.png`
  - Report: `docs/verification-plm-ui-regression-20260117_204803.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_204803.png`
  - Report: `docs/verification-plm-ui-regression-20260117_205457.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_205457.png`
  - Report: `docs/verification-plm-ui-regression-20260117_165415.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_165415.png`
  - Report: `docs/verification-plm-ui-regression-20260117_004806.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_004806.png`
  - Report: `docs/verification-plm-ui-regression-20260117_004806.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_004806.png`
  - Report: `docs/verification-plm-ui-regression-20260117_151709.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_151709.png`
  - Report: `docs/verification-plm-ui-regression-20260117_164626.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_164626.png`
  - Report: `docs/verification-plm-ui-regression-20260117_164857.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_164857.png`
  - Report: `docs/verification-plm-ui-regression-20260117_165415.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_165415.png`
  - Report: `docs/verification-plm-ui-regression-20260117_170038.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_170038.png`
  - Report: `docs/verification-plm-ui-regression-20260117_174520.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_174520.png`
  - Report: `docs/verification-plm-ui-regression-20260117_203043.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_203043.png`
  - Report: `docs/verification-plm-ui-regression-20260117_204803.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_204803.png`
  - Report: `docs/verification-plm-ui-regression-20260117_205457.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_205457.png`
  - Report: `docs/verification-plm-ui-regression-20260117_211911.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_211911.png`
  - Report: `docs/verification-plm-ui-regression-20260117_221425.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_221425.png`
  - Report: `docs/verification-plm-ui-regression-20260117_224348.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_224348.png`
  - Report: `docs/verification-plm-ui-regression-20260117_221425.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_221425.png`
  - Report: `docs/verification-plm-ui-regression-20260117_224348.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_224348.png`
  - Report: `docs/verification-plm-ui-regression-20260117_230222.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_230222.png`
  - Report: `docs/verification-plm-ui-regression-20260117_233428.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_233428.png`
  - Report: `docs/verification-plm-ui-regression-20260117_234818.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_234818.png`
  - Report: `docs/verification-plm-ui-regression-20260118_000708.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_000708.png`
  - Report: `docs/verification-plm-ui-regression-20260118_004053.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_004053.png`
  - Report: `docs/verification-plm-ui-regression-20260118_012736.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_012736.png`
  - Report: `docs/verification-plm-ui-regression-20260117_234818.md`
  - Artifact: `artifacts/plm-ui-regression-20260117_234818.png`
  - Report: `docs/verification-plm-ui-regression-20260118_000708.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_000708.png`
  - Report: `docs/verification-plm-ui-regression-20260118_004053.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_004053.png`
  - Report: `docs/verification-plm-ui-regression-20260118_012736.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_012736.png`
  - Report: `docs/verification-plm-ui-regression-20260118_021730.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_021730.png`
  - Report: `docs/verification-plm-ui-regression-20260118_031232.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_031232.png`
  - Report: `docs/verification-plm-ui-regression-20260118_034546.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_034546.png`
  - Report: `docs/verification-plm-ui-regression-20260118_042733.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_042733.png`
  - Report: `docs/verification-plm-ui-regression-20260118_043002.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_043002.png`
  - Report: `docs/verification-plm-ui-regression-20260118_121019.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_121019.png`
  - Report: `docs/verification-plm-ui-regression-20260118_125754.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_125754.png`
  - Report: `docs/verification-plm-ui-regression-20260118_172926.md`
  - Artifact: `artifacts/plm-ui-regression-20260118_172926.png`
  - Report: `docs/verification-plm-ui-regression-20260122_164425.md`
  - Artifact: `artifacts/plm-ui-regression-20260122_164425.png`
  - Report: `docs/verification-plm-ui-regression-20260122_222956.md`
  - Artifact: `artifacts/plm-ui-regression-20260122_222956.png`
- PLM CAD UI (metadata panel):
  - Report: `docs/verification-plm-cad-ui-20260110_1941.md`
  - Artifact: `artifacts/plm-cad-ui-20260110_1941.png`
  - Report: `docs/verification-plm-cad-ui-20260110_1946.md`
  - Artifact: `artifacts/plm-cad-ui-20260110_1946.png`
- PLM UI full regression (BOM tools + UI regression):
  - Script: `scripts/verify-plm-ui-full.sh`
  - Report: `docs/verification-plm-ui-full-20260110_170622.md`
  - Report: `docs/verification-plm-ui-full-20260110_181245.md`
  - Report: `docs/verification-plm-ui-full-20260110_191218.md`
  - Report: `docs/verification-plm-ui-full-20260115_142128.md`
  - Report: `docs/verification-plm-ui-full-20260115_144649.md`
  - Report: `docs/verification-plm-ui-full-20260115_164310.md`
  - Report: `docs/verification-plm-ui-full-20260115_173732.md`
  - Report: `docs/verification-plm-ui-full-20260116_101817.md`
  - Report: `docs/verification-plm-ui-full-20260116_143745.md`
  - Report: `docs/verification-plm-ui-full-20260116_160002.md`
  - Report: `docs/verification-plm-ui-full-20260116_164234.md`
  - Report: `docs/verification-plm-ui-full-20260116_214533.md`
  - Report: `docs/verification-plm-ui-full-20260117_004806.md`
  - Report: `docs/verification-plm-ui-full-20260117_164857.md`
  - Report: `docs/verification-plm-ui-full-20260117_203043.md`
  - Report: `docs/verification-plm-ui-full-20260117_205457.md`
  - Report: `docs/verification-plm-ui-full-20260117_224348.md`
  - Report: `docs/verification-plm-ui-full-20260116_220926.md`
  - Report: `docs/verification-plm-ui-full-20260116_222036.md`
  - Report: `docs/verification-plm-ui-full-20260116_222236.md`
  - Report: `docs/verification-plm-ui-full-20260116_223428.md`
  - Report: `docs/verification-plm-ui-full-20260116_224234.md`
  - Report: `docs/verification-plm-ui-full-20260116_224702.md`
  - Report: `docs/verification-plm-ui-full-20260116_230221.md`
  - Report: `docs/verification-plm-ui-full-20260117_000120.md`
- PLM UI deep-link autoload:
  - Script: `scripts/verify-plm-ui-deeplink.sh`
  - Report: `docs/verification-plm-ui-deeplink-20260108_131533.md`
  - Artifact: `artifacts/plm-ui-deeplink-20260108_131533.png`
  - Report: `docs/verification-plm-ui-deeplink-20260108_134303.md`
  - Artifact: `artifacts/plm-ui-deeplink-20260108_134303.png`
  - Report: `docs/verification-plm-ui-deeplink-20260108_141834.md`
  - Artifact: `artifacts/plm-ui-deeplink-20260108_141834.png`

- PLM substitutes mutation:
  - Script: `scripts/verify-plm-substitutes-mutation.sh`
  - Report: `docs/verification-plm-substitutes-mutation-20260108_141750.md`
  - Artifact: `artifacts/plm-substitutes-mutation-20260108_141750.json`
  - Report: `docs/verification-plm-substitutes-mutation-20260108_150410.md`
  - Artifact: `artifacts/plm-substitutes-mutation-20260108_150410.json`
  - Report: `docs/verification-plm-substitutes-mutation-20260108_151809.md`
  - Artifact: `artifacts/plm-substitutes-mutation-20260108_151809.json`
  - Report: `docs/verification-plm-substitutes-mutation-20260108_152816.md`
  - Artifact: `artifacts/plm-substitutes-mutation-20260108_152816.json`
- PLM substitutes fixture seed:
  - Script: `scripts/seed-plm-substitutes-fixture.sh`
  - Report: `docs/verification-plm-substitutes-fixture-20260108_150410.md`
  - Artifact: `artifacts/plm-substitutes-fixture.json`
  - Report: `docs/verification-plm-substitutes-fixture-20260108_151809.md`
  - Report: `docs/verification-plm-substitutes-fixture-20260108_152816.md`
- PLM UI substitutes mutation:
  - Script: `scripts/verify-plm-ui-substitutes-mutation.sh`
  - Report: `docs/verification-plm-ui-substitutes-mutation-20260108_144845.md`
  - Artifact: `artifacts/plm-ui-substitutes-mutation-20260108_144845.png`
  - Report: `docs/verification-plm-ui-substitutes-mutation-20260108_150410.md`
  - Artifact: `artifacts/plm-ui-substitutes-mutation-20260108_150410.png`
  - Report: `docs/verification-plm-ui-substitutes-mutation-20260108_151809.md`
  - Artifact: `artifacts/plm-ui-substitutes-mutation-20260108_151809.png`
  - Report: `docs/verification-plm-ui-substitutes-mutation-20260108_152816.md`
  - Artifact: `artifacts/plm-ui-substitutes-mutation-20260108_152816.png`
- PLM regression:
  - Script: `scripts/verify-plm-regression.sh`
  - Report: `docs/verification-plm-regression-20260108_150410.md`
  - Report: `docs/verification-plm-regression-20260108_151809.md`
  - Report: `docs/verification-plm-regression-20260108_152816.md`

- Univer POC build (deps restored):
  - Report: `docs/verification-univer-poc-20251231_2233.md`

- Univer POC verify (mock mode):
  - Report: `docs/verification-univer-poc-20251231_2246.md`
  - Artifact: `artifacts/univer-poc/verify-univer-all.json`

- Univer POC verify (core mode):
  - Report: `docs/verification-univer-poc-20251231_2251.md`
  - Artifact: `artifacts/univer-poc/verify-univer-all.json`

- Univer POC verify (core mode, fresh DB):
  - Report: `docs/verification-univer-poc-20251231_2310.md`
  - Artifact: `artifacts/univer-poc/verify-univer-all.json`

- Univer POC UI routes (dev-only):
  - Report: `docs/verification-univer-poc-ui-20251231_2348.md`
- Univer POC UI + PLM (Yuantus) verification:
  - Report: `docs/verification-univer-poc-ui-20260104_1134.md`

- Univer UI smoke (manual):
  - Report: `docs/verification-univer-ui-smoke-20260101_0104.md`

- Univer UI smoke (Playwright):
  - Run: `pnpm verify:univer-ui-smoke`
  - Script: `scripts/verify-univer-ui-smoke.mjs`
  - Report: `docs/verification-univer-ui-smoke-20260101_0122.md`
  - Report: `docs/verification-univer-ui-smoke-20260106_2045.md`

- Univer POC UI backend connectivity:
  - Report: `docs/verification-univer-poc-ui-20260101_0004.md`

- UI dev proxy smoke (backend + web):
  - Report: `docs/verification-ui-dev-proxy-20260101_1259.md`

- Univer dev proxy fallback:
  - Report: `docs/verification-univer-dev-proxy-20260101_0055.md`
  - Script: `scripts/verify-univer-proxy.sh`
  - Report: `docs/verification-univer-proxy-20260101_0057.md`

- Federation config persistence (PLM/Athena):
  - Script: `scripts/verify_federation_config.sh`
  - Report: `docs/verification-federation-config-20251231_1446.md`
- Federation live verification (PLM + Athena):
  - Report: `docs/verification-federation-plm-athena-20260104_0847.md`

- Workflow minimal (deploy/list/start/instances):
  - Script: `scripts/verify_workflow_minimal.sh`
  - Report: `docs/verification-workflow-minimal-20251231.md`

- Workflow tasks panel auto-refresh (frontend):
  - Report: `docs/verification-workflow-tasks-panel-20260106_2336.md`
  - Report: `docs/verification-workflow-tasks-panel-20260107_0825.md`
- Workflow tasks pagination (backend + frontend):
  - Report: `docs/verification-workflow-tasks-pagination-20260107_0835.md`
- Workflow tasks status/error handling (frontend):
  - Report: `docs/verification-workflow-tasks-status-20260107_0950.md`
- Workflow tasks labels/badges (frontend):
  - Report: `docs/verification-workflow-tasks-labels-20260107_1039.md`
- Workflow tasks filter persistence + tooltips (frontend):
  - Report: `docs/verification-workflow-tasks-filters-persist-20260107_1102.md`
- Workflow tasks empty state + click copy (frontend):
  - Report: `docs/verification-workflow-tasks-empty-click-20260107_1125.md`
- Workflow tasks clear filters (frontend):
  - Report: `docs/verification-workflow-tasks-clear-filters-20260107_1129.md`
- Workflow tasks only-mine + instance copy (frontend/backend):
  - Report: `docs/verification-workflow-tasks-my-filter-20260107_1138.md`
- Workflow tasks details drawer + only-mine OR (frontend/backend):
  - Report: `docs/verification-workflow-tasks-details-20260107_1353.md`
- Workflow tasks card meta + top clear filters (frontend):
  - Report: `docs/verification-workflow-tasks-card-meta-20260107_1400.md`
- Workflow tasks summary bar + drawer JSON (frontend):
  - Report: `docs/verification-workflow-tasks-summary-20260107_1407.md`
- Workflow tasks stats from backend (frontend/backend):
  - Report: `docs/verification-workflow-tasks-stats-20260108_0821.md`
- Workflow tasks JSON search/depth (frontend):
  - Report: `docs/verification-workflow-tasks-json-search-20260108_0825.md`
- Workflow tasks JSON highlight (frontend):
  - Report: `docs/verification-workflow-tasks-json-highlight-20260108_0835.md`
- Workflow tasks stats scope toggle (frontend):
  - Report: `docs/verification-workflow-tasks-stats-toggle-20260108_0855.md`
- Workflow tasks stats scope all + JSON prev (frontend/backend):
  - Report: `docs/verification-workflow-tasks-stats-all-20260108_0914.md`
- Workflow tasks stats mine + JSON clear (frontend/backend):
  - Report: `docs/verification-workflow-tasks-stats-mine-20260108_0932.md`
- Workflow tasks stats mine guard (frontend):
  - Report: `docs/verification-workflow-tasks-stats-mine-20260108_1340.md`
- Workflow tasks stats scope select (frontend):
  - Report: `docs/verification-workflow-tasks-stats-select-20260108_1410.md`
- Workflow tasks JSON match navigator (frontend):
  - Report: `docs/verification-workflow-tasks-json-nav-20260108_1440.md`
- Workflow tasks filters copy + F3 (frontend):
  - Report: `docs/verification-workflow-tasks-filters-copy-20260108_1446.md`
- Workflow tasks JSON enter + copy (frontend):
  - Report: `docs/verification-workflow-tasks-json-copy-20260108_1451.md`
- Workflow tasks summary copy + tooltip (frontend):
  - Report: `docs/verification-workflow-tasks-summary-copy-20260108_1454.md`
- Workflow tasks case-sensitive JSON + summary format (frontend + tests):
  - Report: `docs/verification-workflow-tasks-case-sensitive-summary-format-20260108_1504.md`
- Workflow tasks UI persisted state smoke:
  - Report: `docs/verification-workflow-tasks-ui-case-sensitive-20260108_1630.md`
- Workflow tasks auth headers:
  - Report: `docs/verification-workflow-tasks-auth-header-20260108_1634.md`
- Workflow tasks UI seed cleanup:
  - Report: `docs/verification-workflow-tasks-ui-seed-cleanup-20260109_1356.md`
- Workflow tasks search highlight:
  - Report: `docs/verification-workflow-tasks-ui-search-highlight-20260109_1405.md`
- Workflow tasks search cleanup:
  - Report: `docs/verification-workflow-tasks-ui-search-cleanup-20260109_1410.md`

- UI federation (Dashboard):
  - Report: `docs/verification-ui-federation-20251229_1810.md`

- Token auto-refresh (Athena + PLM):
  - Report: `docs/verification-token-refresh-20251229_1827.md`

- Athena Keycloak auth smoke:
  - Report: `docs/verification-athena-keycloak-20251231_1740.md`

- Athena real API verification:
  - Report: `docs/verification-athena-real-20251231_1810.md`
- Athena real API verification (2026-01-04):
  - Report: `docs/verification-athena-real-20260104_0836.md`
- Athena upload + federation verification:
  - Report: `docs/verification-athena-upload-federation-20260104_0855.md`
- Athena UI verification (Swagger UI):
  - Report: `docs/verification-athena-ui-20260104_0923.md`
- Athena ECM (Keycloak + ECM endpoints):
  - Script: `scripts/verify-athena-ecm.sh`
  - Report: `docs/verification-athena-ecm-20260106_2109.md`
  - Report: `docs/verification-athena-ecm-20260106_2126.md`

- PLM (Yuantus) real API verification:
  - Report: `docs/verification-plm-yuantus-real-20260101_1253.md`

- PLM (Yuantus) AML + BOM verification:
  - Report: `docs/verification-plm-yuantus-aml-bom-20260101_2252.md`

- PLM (Yuantus) federation query verification:
  - Report: `docs/verification-plm-yuantus-federation-20260101_2312.md`

- PLM (Yuantus) BOM non-empty verification:
  - Report: `docs/verification-plm-yuantus-bom-nonempty-20260101_2332.md`
- PLM (Yuantus) BOM non-empty verification (local instance):
  - Report: `docs/verification-plm-yuantus-bom-nonempty-20260104_0825.md`
- PLM (Yuantus) BOM compare + where-used (federation):
  - Report: `docs/verification-plm-yuantus-bom-compare-whereused-20260104_0855.md`

- UI verification via MCP:
  - Report: `docs/verification-ui-mcp-access-20260101_2353.md`

- PLM UI API verification:
  - Report: `docs/verification-plm-ui-api-20260104_1216.md`
- PLM UI federation verification:
  - Report: `docs/verification-plm-ui-federation-20260104_0855.md`
- PLM UI a11y (form ids):
  - Report: `docs/verification-plm-ui-a11y-20260104_1144.md`
- PLM UI search selector:
  - Report: `docs/verification-plm-ui-search-20260104_1210.md`
- PLM UI auth status banner:
  - Report: `docs/verification-plm-ui-auth-status-20260105_0842.md`

- PLM (Yuantus) BOM rollback verification:
  - Report: `docs/verification-plm-yuantus-bom-rollback-20260102_0018.md`
- PLM (Yuantus) auth mismatch verification:
  - Report: `docs/verification-plm-yuantus-auth-mismatch-20260102_0034.md`
- PLM (Yuantus) auth recovery verification:
  - Report: `docs/verification-plm-yuantus-auth-recovered-20260102_1148.md`

- Real systems env + UI:
  - Report: `docs/verification-env-real-systems-20251229_1836.md`

- Dashboard default Athena query:
  - Report: `docs/verification-dashboard-athena-default-query-20251229_1859.md`

- Approvals + workflow auth guards:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow auth guards"`
  - Report: `docs/verification-approvals-workflow-auth-2025-12-23.md`

- Approvals + workflow RBAC:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow RBAC"`
  - Report: `docs/verification-approvals-workflow-rbac-2025-12-23.md`

- Approvals history route cleanup:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow auth guards"`
  - Report: `docs/verification-approvals-history-route-2025-12-23.md`

- Integration suite (core-backend):
  - Run: `pnpm --filter @metasheet/core-backend test:integration`
  - Report: `docs/verification-integration-2025-12-28.md`

- Plugin integration (Kanban):
  - Run: `SKIP_PLUGINS=false pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/kanban-plugin.test.ts tests/integration/kanban.mvp.api.test.ts tests/integration/plugins-api.contract.test.ts --reporter=dot`
  - Report: `docs/verification-kanban-plugins-2025-12-28.md`

- Plugin scan suppression (non-plugin tests):
  - Run: `SKIP_PLUGINS=false pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/rooms.basic.test.ts tests/integration/snapshot-protection.test.ts tests/integration/kanban-plugin.test.ts tests/integration/kanban.mvp.api.test.ts tests/integration/plugins-api.contract.test.ts --reporter=dot`
  - Report: `docs/verification-plugin-scan-suppression-2025-12-28.md`

- Editable demo smoke (Grid + Kanban drag/write-back):
  - Run: `pnpm verify:editable-demo`
  - Report: `docs/editable-demo-ui-verification-2025-12-23.md`
  - Artifacts: `artifacts/editable-demo-grid.png`, `artifacts/editable-demo-kanban.png`,
    `artifacts/editable-demo-ui-verification.json`

- Combined smoke:
  - Run: `pnpm verify:smoke`
  - Latest report: `docs/verification-smoke-20260105_212131.md`
  - Previous report: `docs/verification-smoke-20260101_0126.md`
  - Full local runner: `pnpm verify:smoke:all`
  - Notes: `verify:smoke:all` runs Univer UI smoke; set `RUN_UNIVER_UI_SMOKE=false` to skip. Output: `artifacts/smoke/verify-univer-ui-smoke.json`.
- Smoke verify (local runner update):
  - Run: `scripts/verify-smoke.sh` (uses `scripts/verify-smoke-core.mjs`)
  - Report: `docs/smoke-verify-run-2025-12-23.md`
  - Notes: `web.home` accepts `MetaSheet` or `#app`; adds `univer-meta` checks (`sheets/fields/views/records-summary`)

- Labs/POC gating + production safeguard:
  - Report: `docs/local-smoke-verification.md`
  - Smoke UI check: `artifacts/labs-gating-verification.json`

## Full Regression

- Univer full suite:
  - Run: `bash scripts/verify-univer-all.sh`
  - Outputs under `artifacts/univer-poc/` (see `verification-*.md/json` files)
  - Latest report: `docs/verification-univer-all-20260101_0103.md`
  - Report: `docs/verification-univer-all-2025-12-27.md`
  - Core mode attempt (blocked in automation): `docs/verification-univer-all-core-2025-12-27.md`
  - Core mode + windowing: `docs/verification-univer-all-core-windowing-2025-12-27.md`
  - Optional flags:
    - `BACKEND_MODE=core` (use Meta(DB))
    - `RUN_WINDOWING=true`
    - `RUN_EDITABLE_DEMO=false` (skip editable demo)

## CI / Nightly

- Comments nightly smoke: `.github/workflows/comments-nightly.yml`
  - Runs `pnpm verify:comments` + `pnpm verify:editable-demo`
  - Set `RUN_EDITABLE_DEMO_SMOKE=false` to skip editable demo
- Smoke verify (manual): `.github/workflows/smoke-verify.yml`
  - Runs `pnpm verify:smoke:all` with Playwright + Postgres service
  - CI trigger template: `docs/verification-ci-smoke-trigger-template.md`

## Troubleshooting

- Playwright not found:
  - Run `pnpm install` in `apps/web-react`
  - Use `NODE_PATH=apps/web-react/node_modules`

- Editable demo missing:
  - The script auto-initializes via `scripts/setup-editable-demo.sh`
  - To skip setup: `SKIP_SETUP=true pnpm verify:editable-demo`

- WebSocket/metrics noise:
  - Ensure `.env.local` contains `VITE_API_URL=http://127.0.0.1:7778`
  - Admin realtime metrics uses Socket.IO via `/socket.io`

## Recent Smoke Updates

- Local smoke runner now uses `scripts/verify-smoke-core.mjs` with `web.home` tolerant of `MetaSheet` or `#app`.
- `univer-meta` smoke checks added: `sheets`, `fields`, `views`, `records-summary`.
- Latest report: `docs/smoke-verify-run-2025-12-23.md`.
