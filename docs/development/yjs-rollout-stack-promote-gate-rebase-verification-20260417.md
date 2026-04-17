# Yjs Rollout Stack Promote Gate Rebase Verification

Date: 2026-04-17

## Commands

```bash
git rebase origin/codex/yjs-rollout-gate-20260416
node --check scripts/ops/advance-yjs-rollout-stack.mjs
node scripts/ops/advance-yjs-rollout-stack.mjs --help
git log --oneline --reverse origin/codex/yjs-rollout-gate-20260416..HEAD
```

## Results

- Rebase completed successfully
- The post-rebase branch range is now:
  - `99517fc87` `feat(collab): add yjs rollout stack promote mode`
  - `b505d1508` `docs: record yjs rollout stack promote rebase`
- `node --check scripts/ops/advance-yjs-rollout-stack.mjs` passed
- `node scripts/ops/advance-yjs-rollout-stack.mjs --help` passed

## Notes

- The rebased branch intentionally dropped all already-upstream `#893` parent commits
- This step changed branch topology only; no rollout runtime semantics changed
