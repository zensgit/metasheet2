# Wave M-Feishu-3: Long Text Field Design

Date: 2026-04-29
Branch: `codex/mfeishu3-longtext-field-20260429`

## Scope

Add a first-class multitable `longText` field type aligned with Feishu-style multiline text cells.

This slice covers:

- Backend field type recognition and API contract exposure.
- Shared REST/Yjs-authoritative record write validation through `RecordWriteService`.
- Legacy `RecordService` create/patch validation.
- Grid cell renderer/editor, record drawer editor, and form view textarea support.
- Field manager creation/configuration with text validation rules.
- Filter operator reuse from normal text fields.

Out of scope:

- Character-level Yjs collaboration for long text.
- Rich text, markdown rendering, mentions, attachments inside text, or per-paragraph formatting.
- Data migration. Existing `string` fields are not converted automatically.

## Backend Design

`longText` is stored in `meta_fields.type` and record JSONB data as a plain string. Empty values are normalized to `null` by the validation helper; non-string values are rejected.

Key decisions:

- `field-codecs.mapFieldType()` recognizes `longText`, `long_text`, `long-text`, `textarea`, `multi_line_text`, and `multiline`.
- `validateLongTextValue()` preserves newline and whitespace content exactly. It intentionally does not `trim()` user text.
- `field-validation-engine.getDefaultValidationRules()` treats `longText` like `string` and applies the existing default `maxLength: 10000`.
- `RecordWriteService.validateChanges()` wraps long-text coercion failures as `RecordValidationError`, preserving the service error contract.
- `RecordService.createRecord()` and `RecordService.patchRecord()` use the same helper so legacy paths and shared write paths stay consistent.
- `univer-meta` field create/update schemas and OpenAPI field enums now accept `longText`.

## Frontend Design

`longText` is a separate `MetaFieldType` and intentionally uses textarea surfaces:

- Grid cell editor: multiline `<textarea>`, `Ctrl/Cmd+Enter` commits, `Enter` inserts a newline.
- Cell renderer: preserves newlines via `white-space: pre-wrap`.
- Record drawer: editable multiline textarea and read-only newline-preserving display.
- Form view/public form reuse: textarea input, submit payload preserves newlines.
- Field manager: `longText` appears after `string`, reuses text validation panel rules (`required`, `minLength`, `maxLength`, `pattern`).
- Grid filters: reuses string operators (`is`, `is not`, `contains`, `does not contain`, empty checks).

Yjs eligibility remains limited to normal `string` fields. This is deliberate: long text editing can involve larger replace/paste operations and IME/composition behavior that should be validated in a separate collaboration slice.

## Files

- `packages/core-backend/src/multitable/field-codecs.ts`
- `packages/core-backend/src/multitable/field-validation-engine.ts`
- `packages/core-backend/src/multitable/record-service.ts`
- `packages/core-backend/src/multitable/record-write-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/src/multitable/contracts.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/multitable.yml`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/components/MetaFieldManager.vue`
- `apps/web/src/multitable/components/MetaFormView.vue`
- `apps/web/src/multitable/components/MetaRecordDrawer.vue`
- `apps/web/src/multitable/components/cells/MetaCellEditor.vue`
- `apps/web/src/multitable/components/cells/MetaCellRenderer.vue`
- `apps/web/src/multitable/composables/useMultitableGrid.ts`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`

## Follow-ups

- Consider long-text Yjs opt-in only after textarea composition/IME and large paste behavior are tested.
- Consider richer preview/collapse controls for dense grid cells.
- Existing MF2 route/OpenAPI enum drift remains outside this slice and should be handled in a separate contract cleanup if needed.
