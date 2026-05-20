# T3C - Import Modal i18n Verification

- **Date**: 2026-05-20
- **Scope**: `MetaImportModal.vue` import modal chrome.
- **Design packet**: `docs/development/multitable-t3c-import-modal-i18n-design-20260520.md`
- **Status**: implemented and locally verified.

## Implementation Summary

- Added `meta-import-labels.ts` with English/zh-CN static labels and interpolation helpers.
- Rewired `MetaImportModal.vue` to use `useLocale().isZh`, `importLabel`, and helper functions.
- Passed `isZh.value` into `linkActionLabel` for import repair picker buttons.
- Updated the link helper compatibility spec wording so legacy English default coverage no longer claims the import modal omits locale.

## Boundary Check

| Area | Result |
|---|---|
| Backend/API/OpenAPI | Not touched |
| Migrations / `attendance_*` | Not touched |
| Direct `meta_*` writes | Not touched |
| Import parser / record builder | Not changed |
| Link picker API calls | Not changed |
| User-authored data | Preserved raw |

## Test Coverage Added

| File | Coverage |
|---|---|
| `apps/web/tests/multitable-import-modal.spec.ts` | Adds zh-CN paste/preview assertions, raw header/cell/field-name preservation, zh-CN repair-result chrome, and raw backend failure preservation. |
| `apps/web/tests/link-fields-i18n.spec.ts` | Keeps helper default-English regression coverage while reflecting that the import modal now opts into locale. |

## Verification Commands

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-import-modal.spec.ts \
  tests/link-fields-i18n.spec.ts --watch=false
```

Result: PASS, 24 tests across 2 files.

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-import-modal.spec.ts \
  tests/link-fields-i18n.spec.ts \
  tests/meta-link-picker-i18n.spec.ts \
  tests/meta-link-picker-labels.spec.ts --watch=false
```

Result: PASS, 30 tests across 4 files.

```bash
pnpm --filter @metasheet/web type-check
```

Result: PASS.

```bash
pnpm --filter @metasheet/web build
```

Result: PASS. Vite emitted the existing dynamic-import and large-chunk warnings only.

```bash
git diff --check
```

Result: PASS.

## Acceptance Notes

- The slice is intentionally additive: no new client-side validator, import adapter, or API behavior was introduced.
- `MetaLinkPicker` remains localized by T3B3; this slice only localizes the import modal's button that opens it.
- Backend/import failure messages remain raw by design because they may contain source-specific diagnostics or user data.
