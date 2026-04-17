# Yjs Rollout Stack Promote Mainline Rebase Verification

Date: 2026-04-17

## Commands

```bash
git rebase origin/main
node --check scripts/ops/advance-yjs-rollout-stack.mjs
node scripts/ops/advance-yjs-rollout-stack.mjs --help
git log --oneline --reverse origin/main..HEAD
```

## Results

- Rebase onto `origin/main` completed successfully
- The post-rebase branch range is now:
  - `3a8441754` `feat(collab): add yjs rollout stack promote mode`
  - `87b688c37` `docs: record yjs rollout stack promote rebase`
  - `17f2501d5` `docs: record yjs rollout stack promote gate rebase`
- `node --check scripts/ops/advance-yjs-rollout-stack.mjs` passed
- `node scripts/ops/advance-yjs-rollout-stack.mjs --help` passed

## Notes

- The rebased branch intentionally dropped all already-merged `#894` parent commits
- This step changed branch topology only; no rollout runtime semantics changed
