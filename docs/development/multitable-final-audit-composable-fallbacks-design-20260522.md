# Multitable final audit composable fallbacks design (2026-05-22)

## 1. Decision summary

This slice closes the final-audit residual frontend-owned fallback strings in multitable composables and import helpers.

- Reuse existing label modules instead of adding a broad catch-all module.
- Preserve raw backend and user-data messages: `e.message` and import resolver errors always win.
- Keep pure import helpers locale-optional with `isZh = false`; Vue-bound callers pass `isZh.value`.
- Leave `useYjsDocument.ts` technical diagnostics and the unreachable MetaCellEditor linked-record fallback out of scope.

## 2. Files in scope

- `apps/web/src/multitable/composables/useMultitableWorkbench.ts`
- `apps/web/src/multitable/composables/useMultitableGrid.ts`
- `apps/web/src/multitable/composables/useMultitableComments.ts`
- `apps/web/src/multitable/composables/useMultitableCommentInbox.ts`
- `apps/web/src/multitable/composables/useMultitableCommentInboxSummary.ts`
- `apps/web/src/multitable/composables/useMultitableCommentPresence.ts`
- `apps/web/src/multitable/composables/useMultitableRecordPermissions.ts`
- `apps/web/src/multitable/import/delimited.ts`
- `apps/web/src/multitable/import/bulk-import.ts`
- Existing label modules: `workbench-labels.ts`, `meta-core-labels.ts`, `meta-comment-labels.ts`, `meta-import-labels.ts`
- Caller wiring: `MetaImportModal.vue`, `MultitableWorkbench.vue`

Out of scope:

- `useYjsDocument.ts` auth/invalidation diagnostics.
- `MetaCellEditor.vue` unreachable `Choose linked records...` defensive branch.
- Backend/API contract changes.

## 3. Label ownership

| Surface | Module | Notes |
| --- | --- | --- |
| Workbench context loads | `workbench-labels.ts` | Adds `error.loadSheets`, `error.loadSheetMetadata`, `error.loadBaseMetadata`. |
| Grid composable | `meta-core-labels.ts` | Grid-state fallbacks stay with core grid chrome. |
| Comment composables | `meta-comment-labels.ts` | Comment/inbox/mention/presence fallbacks share the comment domain. |
| Record permission composable | `meta-permission-labels.ts` | Reuses existing `record.error.*` keys; no new permission keys. |
| Import helpers | `meta-import-labels.ts` | Adds import resolver/abort/duplicate dynamic helpers. |

## 4. Raw boundary

Raw values stay raw:

- Backend `e.message`.
- Import resolver thrown `error.message`.
- Field names in import failures.
- Raw imported cell values.
- Duplicate primary field values.
- Record/field IDs and technical codes.

Only frontend-owned fallback text is localized.

## 5. Implementation notes

Vue composables call `useLocale()` inside the composable function and read `isZh.value` at catch time. This matches earlier composable-level i18n precedent while keeping error messages event-time: once written into `error.value`, they do not retranslate after a locale toggle.

Pure import helpers accept optional `isZh = false` because they are not Vue-bound. Existing direct unit tests and old call sites remain English by default.

## 6. Test plan

- Label helper coverage:
  - `multitable-workbench-i18n.spec.ts`
  - `multitable-core-i18n.spec.ts`
  - `meta-comment-labels.spec.ts`
  - `multitable-import.spec.ts`
- Composable fallback coverage:
  - `multitable-workbench.spec.ts`
  - `multitable-grid.spec.ts`
  - `multitable-comments.spec.ts`
  - `multitable-comment-inbox.spec.ts`
  - `multitable-mention-inbox.spec.ts`
  - `multitable-comment-presence.spec.ts`
  - `multitable-record-permissions-composable.spec.ts`

## 7. Acceptance

- Targeted specs pass.
- `vue-tsc`, frontend build, and diff-check pass.
- Grep confirms scoped hardcoded fallback strings only remain inside label modules or intentionally out-of-scope diagnostics.
- No backend/contract/migration/attendance/K3 changes.
