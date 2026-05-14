# Data Factory Cleansed Export Development - 2026-05-14

## Summary

This slice completes the remaining DF-M4 work after the Data Factory workbench
conversion. The workbench now lets an operator export the cleansed dry-run
preview as CSV or Excel without adding backend routes, migrations, or direct
database reads.

The important product boundary remains unchanged:

- multitable is the business cleansing surface
- dry-run is the safety gate before export or Save-only push
- export uses the already-sanitized dry-run preview returned by the integration
  runner
- public API data-service publishing stays out of scope for this stage

## Files Changed

- `apps/web/src/views/IntegrationWorkbenchView.vue`
  - Adds the `导出清洗结果` area in the Pipeline execution panel.
  - Supports CSV and Excel (`.xlsx`) export formats.
  - Builds export rows from `preview.records[*].source`,
    `preview.records[*].transformed`, `preview.records[*].targetPayload`, and
    `preview.records[*].targetRequest`.
  - Redacts secret-like keys and token-like strings at export time as a second
    safety layer.
  - Adds the `发布 API 数据服务暂不开放` placeholder.
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
  - Covers the dry-run export path.
  - Verifies cleaned/payload columns are present.
  - Verifies source/query secrets are redacted from the generated CSV.
- `docs/development/data-factory-workbench-todo-20260514.md`
  - Marks DF-M4 export and data-service placeholder items complete.
- `scripts/ops/multitable-onprem-package-build.sh`
  - Requires this development note in the on-prem delivery package.
- `scripts/ops/multitable-onprem-package-verify.sh`
  - Verifies this development note and the export UI copy are present.

## Export Behavior

The export button is disabled until a dry-run result contains preview records.
After dry-run succeeds, the workbench builds a flat table:

- `source.*` columns keep source evidence for operator review
- `cleaned.*` columns represent transformed / cleansed fields
- `payload.*` columns show target payload preview
- `request.*` columns show sanitized target request metadata

CSV is generated with standard quoting. Excel export uses the existing
`buildXlsxBuffer()` helper and the workspace `xlsx` dependency.

## Guardrails

- No new table, migration, or backend endpoint.
- No raw SQL export path.
- No export before dry-run preview exists.
- No Submit / Audit change.
- Save-only remains explicitly gated.
- Data-service publishing is shown only as a later-stage placeholder.
