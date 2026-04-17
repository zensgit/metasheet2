# Yjs Rollout Gate Mainline Rebase Verification

Date: 2026-04-17

## Commands

```bash
git rebase origin/main
node --check scripts/ops/run-yjs-rollout-gate.mjs
node scripts/ops/run-yjs-rollout-gate.mjs --help
git log --oneline --reverse origin/main..HEAD
```

## Results

- Rebase onto `origin/main` completed successfully
- The post-rebase branch range is now:
  - `9fd858c86` `feat(collab): add yjs rollout gate script`
  - `6a0bf72b5` `docs: record yjs rollout gate stack rebase`
- `node --check scripts/ops/run-yjs-rollout-gate.mjs` passed
- `node scripts/ops/run-yjs-rollout-gate.mjs --help` passed

## Notes

- The rebased branch intentionally dropped all already-merged `#893` parent commits
- This step changed branch topology only; no rollout runtime semantics changed
