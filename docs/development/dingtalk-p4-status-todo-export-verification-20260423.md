# DingTalk P4 Status TODO Export Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-status-todo-export-20260423`

## Commands

```bash
node --check scripts/ops/dingtalk-p4-smoke-status.mjs
node --check scripts/ops/dingtalk-p4-smoke-status.test.mjs
node --test scripts/ops/dingtalk-p4-smoke-status.test.mjs
node --test scripts/ops/dingtalk-p4-offline-handoff.test.mjs scripts/ops/dingtalk-p4-final-handoff.test.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
git diff --check
```

## Expected Results

- Status runs write `smoke-todo.md` by default.
- `--output-todo-md` writes the executable TODO report to a custom path.
- The TODO report includes per-check completion state and recorder command templates.
- Unauthorized-user TODO command includes the structured no-insert proof flags.
- Secret-like strings remain redacted in status and TODO outputs.

## Actual Results

- Syntax checks passed for the status reporter and status reporter test file.
- `node --test scripts/ops/dingtalk-p4-smoke-status.test.mjs` passed 8 tests with 0 failures.
- Adjacent handoff/packet regression passed 16 tests with 0 failures.
- `git diff --check` passed.
