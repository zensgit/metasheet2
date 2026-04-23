# DingTalk Full Stack Rebuild Development - 2026-04-23

## Scope

This records the operational rebuild of the open DingTalk PR stack after the P4-only repair.

No DingTalk business PR was merged into `main` as part of this work. The work rebuilt and pushed existing PR branches, then created a replacement PR for the closed-but-still-required middle node.

## Problem

The previous P4 substack was clean, but the full DingTalk queue still had three issues:

- #1052 was `DIRTY` against `main`.
- #1065 was based on `codex/dingtalk-group-route-and-empty-state-20260422`, but the only PR for that branch, #1064, was closed and could not be reopened.
- #1102 was `DIRTY` because it still included stale pre-repair P4 commits above #1100.

## Approach

An initial direct rebase of #1052 was stopped locally because #1052's historical base contained many already-merged DingTalk commits. Rebasing that history would repeatedly replay obsolete commits and create duplicate conflict work.

The safer approach was to reconstruct the stack from current `origin/main` by cherry-picking each PR's true incremental commit set:

- #1052 was rebuilt with only its own top commit.
- #1053 through #1062 were rebuilt one PR at a time.
- #1064 was rebuilt as a real intermediate branch, but GitHub would not reopen the closed PR.
- #1110 was opened as a replacement for #1064 using the same head branch and the correct base.
- #1065 through #1109 were rebuilt on top of the repaired parent chain.
- #1102 was rebuilt with only its secret-scan commit, eliminating the stale bundled P4 commits.

All branch updates used `git push --force-with-lease`.

## Final Stack

```text
#1052 -> #1053 -> #1054 -> #1055 -> #1056 -> #1057 -> #1058 -> #1059 -> #1060 -> #1061 -> #1062 -> #1110 -> #1065 -> #1070 -> #1071 -> #1073 -> #1076 -> #1078 -> #1082 -> #1083 -> #1085 -> #1086 -> #1087 -> #1089 -> #1090 -> #1093 -> #1094 -> #1095 -> #1097 -> #1099 -> #1100 -> #1102 -> #1104 -> #1105 -> #1106 -> #1107 -> #1109
```

## Branch Notes

Replacement PR:

```text
#1110 test(dingtalk): cover group routes and empty state
```

Reason:

```text
#1064 is closed and GitHub rejected reopen/update-base operations.
```

Current #1052 state:

```text
BLOCKED because REVIEW_REQUIRED
```

This is not a merge conflict state. Its CI checks are passing.

## Artifacts

Readiness report:

```text
output/pr-stack-readiness-dingtalk-full-after-rebuild-20260423.md
```

Delivery verification:

```text
output/delivery/dingtalk-full-stack-rebuild-20260423/TEST_AND_VERIFICATION.md
```
