# Legacy Cells Conflict Smoke

- Overall: **PASS**
- API base: `http://142.171.239.56:8081/api`
- Spreadsheet ID: `34cfa156-50c6-4d34-bedf-58f0e73e51fa`
- Sheet ID: `706e0710-f3cc-4cf1-88cd-ab9cdfb6c51f`
- Auth source: `token`
- Cleanup attempted: `true`
- Cleanup ok: `true`
- Started at: `2026-04-23T02:23:21.278Z`
- Finished at: `2026-04-23T02:23:24.453Z`
- JSON report: `output/legacy-cells-conflict-smoke/142-8081-dbadmin-20260423-102321/report.json`
- Markdown report: `output/legacy-cells-conflict-smoke/142-8081-dbadmin-20260423-102321/report.md`

## Checks

- Total checks: `12`
- Failing checks: none

## Check Results

- `config.valid`: **PASS**
- `auth.token`: **PASS**
- `spreadsheet.create`: **PASS**
- `cell.seed`: **PASS**
- `cell.session-a-read`: **PASS**
- `cell.session-b-read`: **PASS**
- `cell.session-a-update`: **PASS**
- `cell.session-b-conflict`: **PASS**
- `cell.conflict-version-payload`: **PASS**
- `cell.final-value-preserved`: **PASS**
- `cell.final-version-current`: **PASS**
- `spreadsheet.cleanup`: **PASS**

## Conflict Payload

```json
{
  "code": "VERSION_CONFLICT",
  "message": "Cell version conflict for 706e0710-f3cc-4cf1-88cd-ab9cdfb6c51f row=0 col=0: expected 1, server has 2",
  "sheetId": "706e0710-f3cc-4cf1-88cd-ab9cdfb6c51f",
  "row": 0,
  "col": 0,
  "serverVersion": 2,
  "expectedVersion": 1
}
```

## Final Cell

```json
{
  "id": "f297a918-f201-417b-a96d-cb05da445dc9",
  "sheet_id": "706e0710-f3cc-4cf1-88cd-ab9cdfb6c51f",
  "row_index": 0,
  "column_index": 0,
  "value": {
    "value": "session-a"
  },
  "data_type": null,
  "formula": null,
  "computed_value": null,
  "created_at": "2026-04-23T02:22:19.563Z",
  "updated_at": "2026-04-23T02:22:20.281Z",
  "version": 2
}
```
