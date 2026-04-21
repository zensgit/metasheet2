# PR Queue Closure and Validation - 2026-04-21

## Scope

This note records the 2026-04-21 PR queue closure pass after the DingTalk and multitable rollout work.

The goals were:

- Update stale rollout documentation PR branches to the latest `main`.
- Merge green documentation PRs that had no code changes.
- Validate and merge the multitable member-group ACL template PR.
- Validate and merge the active DingTalk stacked frontend follow-ups into their stack base branches.
- Keep the dirty primary worktree untouched.

## Mainline PRs Merged

| PR | Title | Result | Merge commit |
| --- | --- | --- | --- |
| #934 | `docs(dingtalk): add status and synced-user guides` | Merged to `main` | `e1e494d44a956d88c2af70706b8c987541a12848` |
| #938 | `docs(dingtalk): record #935/#936 production rollout` | Merged to `main` | `7e0587abbbb9904be5bc095408db595d6aaa5ce8` |
| #953 | `docs(dingtalk): add dynamic recipient deploy notes` | Merged to `main` | `f79ddfdada4550c9d99cc0b7170aec33a93bfd36` |
| #956 | `docs(dingtalk): add rollout notes for #954 and #955` | Merged to `main` | `29732a493d0190861a4e4675e5ca71a2f871856a` |
| #966 | `docs(dingtalk): add rollout notes for #965` | Merged to `main` | `c16c7778961b2e2d2a5f13f8287a56480fd70923` |
| #917 | `feat(multitable): copy member-group acl templates across groups` | Merged to `main` | `5875248e3ad5ed2debdc6718e2a7ca4d90b4065d` |

Latest `origin/main` after this pass:

```text
5875248e3 feat(multitable): copy member-group acl templates across groups
```

## Stacked PRs Merged To Base Branches

These PRs were not merged directly to `main`; they were merged into their stack base branches for later stack promotion.

| PR | Title | Result | Merge commit |
| --- | --- | --- | --- |
| #995 | `refactor(dingtalk): share person recipient warnings` | Merged to `codex/dingtalk-person-recipient-warning-utils-base-20260421` | `7bb22b2697396c0bf1f6edb6a4b96fd8cc04f310` |
| #996 | `fix(dingtalk): require parsed person recipient paths` | Merged to `codex/dingtalk-person-recipient-can-save-base-20260421` | `a9198b44a1c460c52c46e0cab689701d83cb64ea` |

## Verification

### GitHub Checks

After branch updates, the following PRs reported green GitHub checks:

- #934: `pr-validate`, `contracts (openapi)`, `contracts (strict)`, `contracts (dashboard)`, `test (18.x)`, `test (20.x)`, `after-sales integration`, `coverage`.
- #938: same required plugin and contract checks passed.
- #953: same required plugin and contract checks passed.
- #956: same required plugin and contract checks passed.
- #966: same required plugin and contract checks passed.
- #917: same required plugin and contract checks passed; `e2e` passed; `Observability Strict` was skipped as expected for that workflow configuration.

### Local Focused Tests

For #917:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-sheet-permission-manager.spec.ts --watch=false
```

Result:

```text
Test Files  1 passed (1)
Tests       15 passed (15)
```

```bash
pnpm --filter @metasheet/web build
```

Result: passed. Vite emitted existing chunk-size and mixed dynamic/static import warnings.

For #995:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/dingtalk-recipient-field-warnings.spec.ts \
  tests/multitable-automation-rule-editor.spec.ts \
  tests/multitable-automation-manager.spec.ts \
  --watch=false
```

Result:

```text
Test Files  3 passed (3)
Tests       116 passed (116)
```

```bash
pnpm --filter @metasheet/web build
```

Result: passed. Vite emitted existing chunk-size and mixed dynamic/static import warnings.

For #996:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-automation-rule-editor.spec.ts \
  tests/multitable-automation-manager.spec.ts \
  --watch=false
```

Result:

```text
Test Files  2 passed (2)
Tests       111 passed (111)
```

```bash
pnpm --filter @metasheet/web build
```

Result: passed. Vite emitted existing chunk-size and mixed dynamic/static import warnings.

## Remaining Queue

Open PRs after this pass:

- #837: `docs(approvals): recheck wave1 blockers and plan wave2 pack1`; still draft and behind `main`.

Remote admin-gated staging checks are still blocked by missing valid credentials:

- The local shared-dev env has stale or mismatched credentials for `http://142.171.239.56:8081`.
- SSH to `mainuser@142.171.239.56` is not available from this environment.
- Therefore admin-token-gated Yjs status, retention health, and rollout report checks were not re-run in this pass.

## Notes

- The primary local worktree remained dirty on the old Yjs branch and was not used for edits.
- Work was done through isolated worktrees and GitHub PR operations.
- Documentation-only PRs were merged only after their refreshed branch checks were green.
