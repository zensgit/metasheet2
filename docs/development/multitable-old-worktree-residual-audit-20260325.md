# Multitable Old Worktree Residual Audit

## Goal

Decide whether the old multitable worktree still contains meaningful functional value, or whether it has largely become historical reference.

## Audit Method

Compared:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

Checked:

- multitable source files
- multitable frontend tests
- backend multitable integration tests
- smoke/runtime scripts
- old-only test files that previously remained unported

## Findings

### 1. Source-level functional delta is now small

At file-presence level, the old worktree no longer contains major multitable source files that are missing from the clean mainline worktree.

The last still-useful functional slices identified by the audit were:

- grid inline attachment maintenance
- grid/workbench conflict recovery UI

Both have now been ported into the clean mainline worktree.

### 2. Remaining old-only signal is mostly tests, docs, and history

Old-only multitable test files were:

- `multitable-attachment-list.spec.ts`
- `multitable-conflict-ux.spec.ts`
- `multitable-grid-link-renderer.spec.ts`
- `multitable-record-drawer.spec.ts`

These did not point to new functional gaps after the latest port work; they mostly represented missing coverage in the clean mainline worktree.

Those tests are now also ported.

### 3. Branch history is still not fully merged

Branch-count check still reports:

```bash
git -C /Users/huazhou/Downloads/Github/metasheet2 rev-list --left-right --count codex/multitable-fields-views-linkage-automation-20260312...codex/multitable-next
```

Current result:

- left-only: `48`
- right-only: `199`

This means the old branch still contains commits that are not literally merged into the new branch history.

That does **not** automatically mean there are still missing user-path features, but it does mean the old worktree is still useful as an audit/history source.

## Verification

Commands run:

```bash
comm -23 <(cd /Users/huazhou/Downloads/Github/metasheet2-multitable && rg --files apps/web/src/multitable apps/web/tests packages/core-backend/src/routes packages/core-backend/tests/integration scripts docs/development | sort) <(cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next && rg --files apps/web/src/multitable apps/web/tests packages/core-backend/src/routes packages/core-backend/tests/integration scripts docs/development | sort)

git -C /Users/huazhou/Downloads/Github/metasheet2 rev-list --left-right --count codex/multitable-fields-views-linkage-automation-20260312...codex/multitable-next

cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec vitest run tests/multitable-attachment-list.spec.ts tests/multitable-grid-link-renderer.spec.ts tests/multitable-record-drawer.spec.ts tests/multitable-conflict-ux.spec.ts --reporter=dot
```

## Recommendation

Short version:

- from a **functional main-path** perspective, the clean mainline worktree is now very close to fully catching up
- from a **history/audit** perspective, the old worktree should still be kept a bit longer

So the recommendation remains:

- do **not** delete the old worktree yet
- but the reason is now mostly branch-history confidence, not obvious missing multitable functionality
