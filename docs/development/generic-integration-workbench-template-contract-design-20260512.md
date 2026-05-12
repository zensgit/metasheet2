# Generic Integration Workbench Template Contract Design - 2026-05-12

## Purpose

Close the custom target template contract gap for `integration_external_systems.config.documentTemplates[]`.

The first discovery slice accepted template-like objects with fallbacks such as `object || targetObject || name` and `label || object`. That was useful during bootstrap, but it made customer template configs ambiguous. This slice makes v1 template discovery explicit:

- `id` is required;
- `label` is required;
- `object` is required;
- `targetObject` and `name` no longer satisfy the required object field.

## Behavior

Discovery still normalizes safe template metadata for UI use:

- `bodyKey` defaults to `Data`;
- `endpointPath`, `savePath`, or `path` must be relative and safe when present;
- `operations` defaults to `['upsert']`;
- `schema[].name` remains required;
- secret-like template values are still redacted before response.

## Why Strict

The Workbench stores target-template intent into pipeline options and uses object/schema discovery to seed mapping UI. Fallback IDs and labels make later review/audit harder because the displayed template may not match the implementer-authored config. Requiring the three identity fields makes templates stable and reviewable.

## Non-Goals

- No new template table.
- No template authoring UI.
- No adapter write behavior change.
- No change to `POST /api/integration/templates/preview`; preview remains a pure calculation endpoint.
