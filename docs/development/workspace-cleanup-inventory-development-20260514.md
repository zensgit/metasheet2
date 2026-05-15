# Workspace Cleanup Inventory Development 2026-05-14

## Summary

This document records the current local worktree inventory and the cleanup
strategy used after DingTalk closeout.

The root checkout at `<repo-root>` is intentionally
not modified by this package. It remains on
`codex/k3wise-workbench-release-publication-20260513`.

## Local Worktree Classification

The root checkout reported untracked paths in these buckets:

| Bucket | Count | Representative paths | Recommended action |
| --- | ---: | --- | --- |
| integration-core docs | 10 | `docs/development/integration-core-*` | Review as a separate integration-core docs PR or archive locally. |
| K3 / delivery artifacts | 4 buckets | `docs/development/integration-k3wise-*`, `output/delivery/multitable-onprem/`, `output/releases/` | Keep docs in a K3 PR; keep generated bundles ignored. |
| Feishu docs | 5 | `docs/development/multitable-feishu-*` | Some already exist on `origin/main`; refresh the working branch before acting. |
| ops / staging docs | 5 | `docs/operations/*`, `docs/development/staging-*` | Review as an ops-docs PR or archive. |
| DingTalk live acceptance output | 1 bucket, 16 files | `output/dingtalk-live-acceptance/20260510/*` | Keep as local operator evidence; do not track in Git. |
| local scratch state | 1 bucket | `.claude/` | Keep ignored. |

Four files that appear untracked in the root checkout already exist on
`origin/main`:

- `docs/development/k3wise-bridge-machine-codex-handoff-20260513.md`
- `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
- `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md`
- `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md`

That is branch-drift noise, not new work.

## Cleanup Strategy

This package does not delete or move local files. It only adds ignore rules for
generated artifacts so future `git status` output is easier to read.

Ignored generated artifact paths:

- `.claude/`
- `output/dingtalk-live-acceptance/`
- `output/delivery/multitable-onprem/`
- `output/releases/`

Suggested next manual cleanup order:

1. Refresh or rebase the root working branch onto `origin/main` only after
   preserving any real K3 work.
2. Split source/docs work by lane: K3, Feishu, integration-core, ops.
3. Keep generated archives and local acceptance evidence under ignored output
   directories.
4. Do not commit generated zips, tgz files, local scratch folders, or live
   acceptance JSON unless a release process explicitly asks for a sanitized
   artifact.

## Scope Guard

No tracked source code is changed. No runtime behavior changes. No database
changes. No generated artifact is deleted.
