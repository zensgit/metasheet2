# Generic Integration Workbench Observation Design - 2026-05-12

## Purpose

This slice adds the missing operator feedback loop to the generic integration workbench:

1. choose the staging multitable object that represents the cleansing surface;
2. save that staging object into the pipeline as `stagingSheetId`;
3. refresh recent pipeline runs;
4. refresh open dead letters.

The goal is not to build a full monitoring console. It is to keep the first reusable CRM/PLM/ERP/SRM cleansing flow operable from one page: configure, preview, save, dry-run, run Save-only, then inspect failures.

## API Usage

The frontend reuses existing integration-core routes:

- `GET /api/integration/staging/descriptors`;
- `GET /api/integration/runs`;
- `GET /api/integration/dead-letters`.

No backend route, migration, or table is added in this slice.

## Staging Selector

`IntegrationWorkbenchView.vue` loads staging descriptors during bootstrap and defaults to `standard_materials` when available.

The selected descriptor id is sent as:

```json
{
  "stagingSheetId": "standard_materials"
}
```

This keeps the workbench aligned with the product principle: business users clean data in multitable fields, while JSON remains only a payload/template preview.

## Observation Panel

The new `运行观察` panel shows:

- the latest 5 pipeline runs;
- open dead letters for the saved pipeline;
- a compact count summary.

The panel refreshes in two paths:

- automatically after dry-run or Save-only run;
- manually via `刷新观察`.

Dead-letter payloads are not requested with `includePayload=true`, so source/transformed payloads stay redacted by the backend default response.

## Boundaries

- No dead-letter replay button yet.
- No dead-letter full payload view.
- No run pagination.
- No global pipeline list.
- No staging object installation flow; this page only selects descriptors already known to the plugin.
