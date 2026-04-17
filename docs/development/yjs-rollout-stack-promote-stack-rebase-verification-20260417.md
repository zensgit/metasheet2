# Yjs Rollout Stack Promote Stack Rebase Verification

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
- The post-rebase branch range is now only:
  - `f210fb443` `feat(collab): add yjs rollout stack promote mode`
- `node --check scripts/ops/advance-yjs-rollout-stack.mjs` passed
- `node scripts/ops/advance-yjs-rollout-stack.mjs --help` passed

## Notes

- This step intentionally removed all already-upstream parent layers from the branch history
- No rollout runtime semantics changed; this was stack cleanup plus script verification
