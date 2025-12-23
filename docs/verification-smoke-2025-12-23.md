# Smoke Verification (2025-12-23)

## Scope

- Comments smoke (API + UI)
- Editable demo smoke (Grid + Kanban drag/write-back)

## Environment

- Backend: http://127.0.0.1:7778 (core, `RBAC_BYPASS=true`)
- Vue Shell: http://127.0.0.1:8899

## Command

```bash
pnpm verify:smoke
```

Also validated via:

```bash
pnpm verify:smoke:all
```

## Results

### Comments (summary + UI)

```json
{
  "ok": true,
  "sheetId": "univer_demo_meta",
  "rowId": "comment_summary_1766469348148",
  "commentId": "cmt_1766469348194",
  "summary": {
    "before": { "total": 0, "open": 0 },
    "afterCreate": { "total": 1, "open": 1 },
    "afterResolve": { "total": 1, "open": 0 }
  }
}
```

```json
{
  "sheetId": "univer_demo_meta",
  "rowId": "rec_udm_1",
  "fieldId": "fld_udm_name",
  "grid": {
    "before": { "open": 0, "total": 6 },
    "afterCreate": { "open": 1, "total": 7 },
    "afterResolve": { "open": 0, "total": 7 },
    "screenshot": "artifacts/comments-ui-grid.png"
  },
  "kanban": {
    "before": { "open": 0, "total": 7 },
    "afterCreate": { "open": 1, "total": 8 },
    "afterResolve": { "open": 0, "total": 8 },
    "screenshot": "artifacts/comments-ui-kanban.png"
  }
}
```

### Editable Demo

```json
{
  "grid": { "cellValue": "Item A (UI)", "statusText": "Saved (1)" },
  "kanban": { "from": "P1", "to": "P0", "cardId": "rec_23e74970-15bb-4375-a8fa-5bd094499aa0", "moved": true, "statusText": "Saved (1)" }
}
```

## Artifacts

- `artifacts/comments-ui-grid.png`
- `artifacts/comments-ui-kanban.png`
- `artifacts/editable-demo-grid.png`
- `artifacts/editable-demo-kanban.png`
- `artifacts/editable-demo-ui-verification.json`
