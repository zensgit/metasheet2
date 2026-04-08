# This branch is FROZEN as of 2026-04-08

**Do not start new work here.**

This branch (`codex/plm-workbench-collab-20260312`) is 384 commits ahead
of `origin/main` and has been frozen pending a proper merge review.

## Why

The Pact-First integration safety net (Wave 1 + 1.5) was completed on the
mainline branch (`codex/approval-bridge-plm-phase1-20260404`). All 6 P0
consumer pact interactions pass end-to-end. The consumer pact source of
truth is the mainline branch, not this workbench branch.

## What to do instead

- New PLM workbench features should be developed on mainline.
- The changes unique to this branch (notably version-aware approve/reject
  for optimistic locking) should be merged back to mainline via a
  dedicated, reviewed PR — not cherry-picked.
- See `Yuantus/docs/WORKBENCH_BRANCH_FREEZE_20260408.md` for the full
  diff analysis and recommended merge path.
