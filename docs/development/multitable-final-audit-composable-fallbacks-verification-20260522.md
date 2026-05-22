# Multitable final audit composable fallbacks verification (2026-05-22)

## 1. Scope

Final-audit residual fallback slice for multitable composables and import helpers.

Changed surfaces:

- `useMultitableWorkbench.ts`
- `useMultitableGrid.ts`
- `useMultitableComments.ts`
- `useMultitableCommentInbox.ts`
- `useMultitableCommentInboxSummary.ts`
- `useMultitableCommentPresence.ts`
- `useMultitableRecordPermissions.ts`
- `import/delimited.ts`
- `import/bulk-import.ts`
- Existing multitable label modules and targeted specs.

No backend, contract, migration, attendance, or K3 files are in scope.

## 2. Preflight grep

Command used:

```bash
grep -R -n "Failed to load sheets\|Failed to load sheet metadata\|Failed to load base metadata\|Failed to load view data\|Record editing is not allowed for this row\.\|Record deletion is not allowed for this row\.\|sheetId or viewId is required\|Failed to create record\|Failed to delete record\|This cell was updated elsewhere\|Failed to patch cell\|Patch failed\|latest record version\|Failed to load comments\|Failed to add comment\|Failed to resolve comment\|Failed to update comment\|Failed to delete comment\|Failed to load comment inbox\|Failed to load unread comment count\|Failed to mark comment as read\|Failed to load mention summary\|Failed to load comment presence\|Failed to load record permissions\|Failed to grant record permission\|Failed to revoke record permission\|No import resolver is configured\|Unable to resolve people value\|Unable to resolve linked value\|Import cancelled\|Skipped duplicate row because" apps/web/src/multitable --include='*.ts' --include='*.vue'
```

Post-implementation result: matches are contained in label modules or pre-existing Workbench toast labels. No composable/import helper call-site keeps these fallback literals inline.

Permission reuse reachability:

```bash
grep -n "'record\\.error" apps/web/src/multitable/utils/meta-permission-labels.ts
```

Result:

```text
39:  | 'record.error.grant'
40:  | 'record.error.loadCandidates'
41:  | 'record.error.loadPermissions'
42:  | 'record.error.remove'
43:  | 'record.error.update'
143:  'record.error.grant': { en: 'Failed to grant permission', zh: '授予权限失败' },
145:  'record.error.loadPermissions': { en: 'Failed to load record permissions', zh: '加载记录权限失败' },
146:  'record.error.remove': { en: 'Failed to remove permission', zh: '移除权限失败' },
```

## 3. Raw boundary evidence

Tests assert:

- Backend comment error message `backend raw` wins over zh fallback.
- Workbench backend error message `backend raw` wins over zh fallback.
- Record permission backend grant error `backend grant raw` wins over zh fallback.
- Import field names and raw values pass through localized helper text unchanged.
- Duplicate row value `alpha` passes through localized helper text unchanged.

## 4. Targeted test pass

Command:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/multitable-workbench.spec.ts tests/multitable-grid.spec.ts tests/multitable-comments.spec.ts tests/multitable-comment-inbox.spec.ts tests/multitable-mention-inbox.spec.ts tests/multitable-comment-presence.spec.ts tests/multitable-import.spec.ts tests/multitable-record-permissions-composable.spec.ts tests/multitable-workbench-i18n.spec.ts tests/multitable-core-i18n.spec.ts tests/meta-comment-labels.spec.ts
```

Result:

```text
Test Files  11 passed (11)
Tests       155 passed (155)
```

## 5. Worktree dependency note

This clean `/private/tmp` worktree did not have local dependency links, so verification used temporary untracked symlinks:

- `node_modules -> /Users/chouhua/Downloads/Github/metasheet2/node_modules`
- `apps/web/node_modules -> /Users/chouhua/Downloads/Github/metasheet2/apps/web/node_modules`

These symlinks are not intended PR files and must not be staged.

## 6. Type/build/diff gates

Commands:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

Result:

```text
vue-tsc --noEmit: PASS
frontend build: PASS (vite built in 5.95s)
git diff --check origin/main..HEAD: PASS
```
