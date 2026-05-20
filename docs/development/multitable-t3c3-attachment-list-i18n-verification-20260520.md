# T3C3 - Attachment List i18n Verification

- **Date**: 2026-05-20
- **Design**: `docs/development/multitable-t3c3-attachment-list-i18n-design-20260520.md`
- **Scope**: `MetaAttachmentList.vue` chrome i18n only.

## Changed Files

| File | Purpose |
|---|---|
| `apps/web/src/multitable/components/MetaAttachmentList.vue` | Reads locale and renders localized preview/remove/lightbox chrome. |
| `apps/web/src/multitable/utils/meta-attachment-labels.ts` | Small EN/ZH label helper module for attachment-list chrome. |
| `apps/web/tests/multitable-attachment-list.spec.ts` | Adds zh-CN coverage and pins English/default compatibility. |

## Verification Matrix

| Check | Command | Result |
|---|---|---|
| Focused attachment tests | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/multitable-attachment-list.spec.ts tests/multitable-attachment-editor.spec.ts tests/meta-record-drawer-i18n.spec.ts --watch=false` | PASS, 17 tests |
| Helper syntax check | `node --check apps/web/src/multitable/utils/meta-attachment-labels.ts` | PASS |
| Web type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Web build | `pnpm --filter @metasheet/web build` | PASS; existing Vite dynamic-import and large chunk warnings only |
| Whitespace | `git diff --check` | PASS |

## Assertions Covered

- English/default image preview title remains `Preview photo.png`.
- English/default lightbox link and close aria label remain `Open original` and `Close attachment preview`.
- zh-CN preview title, remove title, original-file link, and close aria label are localized.
- Attachment filename `diagram.png` remains raw in zh-CN titles and lightbox content.
- Existing remove event behavior remains covered.

## Staging Boundary

- Stage only this slice's files; exclude existing node_modules and scratch/output noise.
- No backend, API, migration, `attendance_*`, or direct `meta_*` writes are part of this slice.
