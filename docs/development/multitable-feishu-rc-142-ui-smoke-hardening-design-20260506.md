# Multitable Feishu RC 142 UI Smoke Hardening Design - 2026-05-06

## Context

The 142 staging API smoke was already green, but the browser-only multitable staging smoke had not been closed. This slice ran the existing Playwright staging smoke against `http://142.171.239.56:8081` with a redacted admin JWT loaded from the local token file, then fixed the real blockers exposed by that run.

Root checkout remained untouched because it contains unrelated DingTalk/public-form dirty files. All work was done in a clean temporary worktree based on `origin/main@e5f02a3de`.

## Findings

### 1. Import retry mapping was implicit

`importRecordsViaGridWithRetry()` uploaded a CSV with a `Title` header and immediately waited for `Import 2 record(s)` to become enabled. Other import paths already select field mappings explicitly after preview, but the retry path relied on auto-mapping.

On 142 the import button stayed disabled with no warning text:

```text
grid retry import button enable timed out:
{"ok":false,"visible":true,"disabled":true,"warningText":"","fixesVisible":false}
```

The fix is to explicitly map CSV column 0 to the runtime `titleFieldId` before waiting for the import button.

### 2. Form attachment field locator was substring-based

The form attachment helpers selected fields with:

```js
page.locator('.meta-form-view__field').filter({ hasText: attachmentFieldName }).first()
```

This is unstable once the smoke creates temporary fields such as `Temp Files ...`; `Files` becomes a substring match rather than an exact field match. The fix adds `formFieldByLabel()` and matches the `.meta-form-view__label` text exactly.

### 3. Record comment button selector was global

The smoke used `page.getByRole('button', { name: '💬' })`. After Comment Inbox wiring, the page has both the inbox button and the record comment button, so Playwright strict mode failed. The fix scopes this to the record drawer comment button:

```js
.meta-record-drawer__btn--comment[title="Comments"]
```

### 4. Comment create failed on upgraded DB scope columns

After selector hardening, the browser smoke reached comment submission but the new comment never appeared. A direct 142 API probe showed the underlying backend failure:

```text
createComment 500 false null INTERNAL_ERROR Failed to create comment
```

`zzzz20260318123000_formalize_meta_comments` added `target_id` and `container_id` as non-null columns on upgraded databases. `CommentService.createComment()` still inserted only the legacy columns. Fresh databases created by the formalized table definition can have defaults, but upgraded databases can reject inserts without explicit formal scope values.

The fix writes both legacy and canonical scope columns:

- `spreadsheet_id` and `row_id`
- `field_id`
- `target_type='meta_record'`
- `target_id=rowId`
- `target_field_id=fieldId`
- `container_type='meta_sheet'`
- `container_id=spreadsheetId`

## Code Changes

- `scripts/verify-multitable-live-smoke.mjs`
  - Add exact `formFieldByLabel()`.
  - Add scoped `recordCommentsButton()`.
  - Add scoped `addAndResolveRecordComment()`.
  - Explicitly map the retry import title column.
- `packages/core-backend/src/services/CommentService.ts`
  - Insert formalized comment scope columns on create.
- `packages/core-backend/src/db/types.ts`
  - Add formalized `meta_comments` columns to the Kysely table type.
- `packages/core-backend/tests/unit/comment-service-formal-scope.test.ts`
  - Lock the insert payload so future comment changes cannot regress upgraded DB compatibility.

## Rollout Note

This patch fixes local code. The 142 UI smoke cannot pass until this branch is merged, deployed to 142, and the smoke is rerun against the updated backend.
