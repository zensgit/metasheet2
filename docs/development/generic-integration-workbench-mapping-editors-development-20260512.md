# Generic Integration Workbench Mapping Editors Development - 2026-05-12

## Scope

This slice closes the remaining M7 mapping-editor TODOs in `IntegrationWorkbenchView.vue`:

- Transform selector from a fixed whitelist.
- Dictionary mapping editor for `dictMap`.
- Validation rule editor for required, min, and max rules.

## Design

### Transform selector

The free-form transform text input was replaced by a whitelist selector:

- None
- `trim`
- `upper`
- `lower`
- `toNumber`
- `dictMap`

This keeps the Workbench aligned with the backend transform engine while avoiding user-script style free-form input.

### Dictionary mapping

When `dictMap` is selected, the row shows a compact textarea. It accepts:

- Line format: `source=target`
- JSON object format: `{ "EA": "Pcs" }`

The frontend converts this to:

```json
{
  "fn": "dictMap",
  "map": {
    "EA": "Pcs"
  }
}
```

Invalid or empty dictionaries fail before preview/save and show the existing Workbench status error path.

### Validation rules

Each mapping row now supports:

- Required checkbox.
- Optional `min`.
- Optional `max`.

The generated `validation` array preserves backend contract shape:

```json
[
  { "type": "required" },
  { "type": "min", "value": 0.000001 },
  { "type": "max", "value": 100 }
]
```

## Files

- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/generic-integration-workbench-mapping-editors-development-20260512.md`
- `docs/development/generic-integration-workbench-mapping-editors-verification-20260512.md`

## Non-Goals

- No user JavaScript transform support.
- No arbitrary transform-chain text editor.
- No backend transform or validator behavior changes.
