# DingTalk Directory Stack Mainline Sync Verification

## Merge Verification

Mainline sync command:

```bash
git merge --no-edit origin/main
```

Result:

- merged successfully
- no conflicts reported

## Targeted Regression Checks

Backend:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync-bind-account.test.ts --reporter=dot
```

Result:

- `3` files passed
- `68` tests passed

Frontend:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --reporter=dot
```

Result:

- `2` files passed
- `16` tests passed

Frontend type check:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- passed

## Worktree Execution Notes

This isolated worktree required temporary `node_modules` symlinks for command execution:

- `/tmp/metasheet2-dingtalk-stack/node_modules`
- `/tmp/metasheet2-dingtalk-stack/apps/web/node_modules`
- `/tmp/metasheet2-dingtalk-stack/packages/core-backend/node_modules`

They are not meant to be committed.

## PR State Notes

Before pushing the merge commit, `gh pr view 873` still reported:

- `mergeStateStatus: BEHIND`

This is expected until the updated branch is pushed.

After pushing:

- `git push` succeeded for `codex/feishu-gap-rc-integration-202605`
- local comparison `git log --oneline --left-right --cherry-pick origin/main...HEAD` showed only right-side commits (`>`)

Interpretation:

- the branch locally contains `origin/main`
- if GitHub still reports `BEHIND`, that is most likely PR status refresh lag rather than a remaining missing merge

## Claude Code CLI

Verified callable with:

```bash
claude -p "Return exactly: CLAUDE_CLI_OK"
```

Result:

- `CLAUDE_CLI_OK`
