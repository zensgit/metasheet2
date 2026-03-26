# Multitable Mainline Consolidation

Date: 2026-03-26

## Goal

Consolidate the clean multitable mainline worktree into committed, reviewable history after the large functional port from the old multitable worktree.

## What Was Consolidated

Two grouped commits were created in the clean mainline worktree:

1. `ec1235d75 feat(multitable): restore runtime and workbench flows`
2. `82f6d203f feat(multitable): restore pilot and onprem tooling`

The split is intentional:

- commit 1 contains the runtime, frontend workbench, import, field/view manager, non-grid view, backend route, migrations, integration tests, and development verification docs
- commit 2 contains the executable pilot/on-prem/profile/live-smoke surface, deployment templates, issue template, and root package entrypoints

## Verification

### Repository State

Clean mainline worktree:

- `git status --short` => clean

Old multitable reference worktree:

- `git status --short` => clean

### Branch State

Compared:

- `codex/multitable-fields-views-linkage-automation-20260312`
- `codex/multitable-next`

Result:

```text
48    201
```

Interpretation:

- old branch still has 48 commits not present in the new branch history
- new branch has 201 commits not present in the old branch history

This means the old worktree still has branch-history value, but the clean mainline now contains the functional multitable surface that matters for current development and execution.

## Deletion Guidance For Old Worktree

The old worktree directory can now be removed safely if the goal is only to stop using it as a checked-out workspace, because:

- both worktrees are clean
- the high-value multitable functionality and executable assets have already been brought into the clean mainline
- the old branch reference still exists in git even if the old directory is removed

Recommended removal command:

```bash
git -C /Users/huazhou/Downloads/Github/metasheet2 worktree remove /Users/huazhou/Downloads/Github/metasheet2-multitable
```

Keep in mind:

- removing the worktree directory does not delete the old branch
- if branch-history archaeology is still needed later, the branch can still be inspected without keeping the old directory around

## Conclusion

The clean mainline worktree is now the correct active multitable development directory.

Current directory of record:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`
