# DingTalk Directory Ops Mainline Merge Development - 2026-04-15

## Scope

This round resolves the `origin/main` merge conflict on top of [#876](https://github.com/zensgit/metasheet2/pull/876).

The branch already contained the DingTalk directory ops stack:

- manual review queue
- recommended binding guidance
- batch bind / batch unbind
- queue progress UI
- scheduler wiring
- schedule observability

After `origin/main` advanced, GitHub reported `mergeable = CONFLICTING`. The conflicts were limited to five files:

- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/directoryManagementView.spec.ts`
- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/tests/unit/admin-directory-routes.test.ts`

## Resolution Strategy

The branch version was treated as the functional base because it is the richer DingTalk directory ops slice.

Then the merge resolution reintroduced mainline semantics that should not regress:

- alert list responses now keep aggregate `counts`
- alert route accepts both `filter` and `ack` query semantics
- review queue route accepts both legacy and mainline queue/filter names
- batch bind / batch unbind responses now include `updatedCount`
- alert audit entries use the clearer `acknowledge` action
- schedule observation status now accepts both the older branch statuses and the newer mainline statuses

## Files Updated During Resolution

- [packages/core-backend/src/routes/admin-directory.ts](/tmp/metasheet2-dingtalk-directory-ops/packages/core-backend/src/routes/admin-directory.ts:1)
- [packages/core-backend/src/directory/directory-sync.ts](/tmp/metasheet2-dingtalk-directory-ops/packages/core-backend/src/directory/directory-sync.ts:1)
- [packages/core-backend/tests/unit/admin-directory-routes.test.ts](/tmp/metasheet2-dingtalk-directory-ops/packages/core-backend/tests/unit/admin-directory-routes.test.ts:1)
- [apps/web/src/views/DirectoryManagementView.vue](/tmp/metasheet2-dingtalk-directory-ops/apps/web/src/views/DirectoryManagementView.vue:1)

## Claude Code CLI

`Claude Code CLI` is callable in this environment.

Verified:

- `claude auth status`
- authenticated with `subscriptionType: max`

A narrow merge-blocker review prompt was also started during this round, but merge readiness is based on local test evidence rather than waiting indefinitely for CLI review output.
