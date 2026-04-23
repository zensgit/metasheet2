# DingTalk P4 Packet Stale Output Guard Development

- Date: 2026-04-23
- Scope: staging evidence packet failed-rerun safety
- Branch: `codex/dingtalk-p4-packet-stale-output-guard-20260423`

## What Changed

- The packet exporter now removes its generated `manifest.json` and `README.md` markers immediately after parsing `--output-dir` and before validating included evidence.
- A gated rerun that fails validation no longer leaves an older passing manifest or README in the same output directory.
- The `--require-dingtalk-p4-pass` empty-include check now runs after marker cleanup, so misuse of the final gate also clears stale generated markers for that output directory.
- Added a regression test that first writes a valid gated packet, then reruns the exporter against the same `--output-dir` with an invalid P4 session and verifies the old markers are gone.

## Why

The final-pass packet gate prevents bad evidence from being copied, but a failed rerun against an existing output directory could still leave an older successful `manifest.json` or `README.md`. Operators might read those files and mistake stale evidence for the latest failed run. Clearing generated markers before validation makes failed reruns visibly incomplete.

## Files

- `scripts/ops/export-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`
- `docs/development/dingtalk-feature-plan-and-todo-20260422.md`

## Operator Impact

Use the same final export command:

```bash
node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \
  --include-output output/dingtalk-p4-remote-smoke-session/142-session \
  --require-dingtalk-p4-pass \
  --output-dir artifacts/dingtalk-staging-evidence-packet/142-final
```

If validation fails, treat the output directory as not publishable until the command succeeds and writes a fresh `manifest.json`.
