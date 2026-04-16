# Yjs Rollout Stack Promote Verification

Date: 2026-04-16

## Commands

```bash
node scripts/ops/advance-yjs-rollout-stack.mjs --help
node --check scripts/ops/advance-yjs-rollout-stack.mjs
node scripts/ops/advance-yjs-rollout-stack.mjs
node scripts/ops/advance-yjs-rollout-stack.mjs --json
claude -p "Return exactly: CLAUDE_CLI_OK"
```

## Result

- help output: passed
- syntax check: passed
- dry-run text output: passed
- dry-run JSON output: passed
- Claude Code CLI: `CLAUDE_CLI_OK`

## Notes

- This verification stays in dry-run mode because `#888` is still open.
- At verification time the script correctly reported:
  - `#888` as the root blocker
  - `#889-#894` as waiting on their parent PRs
