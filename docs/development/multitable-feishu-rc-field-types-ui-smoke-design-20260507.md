# Multitable Feishu RC Field Types UI Smoke Design - 2026-05-07

## Scope

This slice closes the executable Feishu RC staging-smoke gap for broad field-type rendering and reload:

- `Smoke test field types: currency, percent, rating, url, email, phone, longText, multiSelect.`

The change is runner-only. It does not change production frontend or backend behavior.

## Design

The existing `scripts/verify-multitable-live-smoke.mjs` provisions a pilot sheet, imports records, patches field values through the authoritative `/api/multitable/patch` path, verifies UI hydration, and performs best-effort cleanup. This slice extends that flow after the imported record already has attachments and a linked person, before later view-manager mutations can affect grid rendering.

### Temporary Field Matrix

The runner now creates eight temporary fields with stable, safe values:

| Field type | Property | Patched value | UI assertion |
| --- | --- | --- | --- |
| `currency` | `{ code: "CNY", decimals: 2 }` | `1234.56` | `¥1,234.56` |
| `percent` | `{ decimals: 1 }` | `37.5` | `37.5%` |
| `rating` | `{ max: 5 }` | `4` | `★★★★☆` |
| `url` | none | `https://example.com/multitable-rc` | link text and `href` |
| `email` | none | `rc-field-types@example.com` | link text and `mailto:` href |
| `phone` | none | `+86 138 0000 0000` | link text and sanitized `tel:` href |
| `longText` | none | two-line string | both lines visible |
| `multiSelect` | `Alpha`, `Beta`, `Gamma` options | `["Alpha", "Gamma"]` | two rendered chips, ordered |

All temporary fields are added to the existing cleanup set and are deleted after the smoke run.

### API Normalization Check

`verifyFieldTypesReloadReplay()` first fetches the patched record through the API and asserts that each field value is normalized to the expected persisted shape:

- scalar values remain exact for currency, percent, rating, url, email, phone, and longText;
- multi-select remains an ordered string array.

This catches backend value coercion or validation regressions before testing frontend rendering.

### UI Reload Replay Check

After API validation, the runner opens the grid view, searches the imported row, and checks each field cell by `aria-label` field name. It then reloads the page and repeats the same assertions.

The check records:

- `api.field-types.value-normalization`
- `ui.field-types.reload-replay`

The screenshot `field-types-reloaded.png` is written to the run output directory for manual review when needed.

### Runner Hardening

The phone href expectation is derived from the smoke value with the same digit sanitization used by the renderer. This avoids brittle hand-written `tel:` constants.

The import mapping reconcile setup actively maps the target field with `ensureImportFieldMappedByColumnIndex()` before mutating field metadata. This keeps the existing reconcile smoke stable when the import preview field list grows with temporary field-type columns.

## Non-Goals

- No editor interaction coverage for these fields.
- No invalid-value negative-path coverage.
- No formula editor, Gantt, hierarchy, public form, or automation smoke expansion.
- No product runtime changes.
