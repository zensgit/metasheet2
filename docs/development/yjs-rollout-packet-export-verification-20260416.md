# Yjs Rollout Packet Export Verification

Date: 2026-04-16

## Commands

```bash
node scripts/ops/export-yjs-rollout-packet.mjs --help
node --check scripts/ops/export-yjs-rollout-packet.mjs
rm -rf artifacts/yjs-rollout-packet
node scripts/ops/export-yjs-rollout-packet.mjs
test -f artifacts/yjs-rollout-packet/README.md
test -f artifacts/yjs-rollout-packet/scripts/ops/capture-yjs-rollout-report.mjs
claude -p "Return exactly: CLAUDE_CLI_OK"
```

## Result

- help output: passed
- syntax check: passed
- packet export: passed
- packet README exists: passed
- packet capture script exists: passed
- Claude Code CLI: `CLAUDE_CLI_OK`
