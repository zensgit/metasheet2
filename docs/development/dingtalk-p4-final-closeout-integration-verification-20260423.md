# DingTalk P4 Final Closeout Integration Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Base: `origin/main` at `8d2d3e1b0`
- Result: pass for next-command integration and exported-packet inclusion

## Commands Run

```bash
node --test \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs \
  scripts/ops/dingtalk-p4-smoke-status.test.mjs \
  scripts/ops/dingtalk-p4-offline-handoff.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

- Result: pass, 28 tests.

```bash
node --test \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-evidence-record.test.mjs \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs \
  scripts/ops/dingtalk-p4-smoke-status.test.mjs \
  scripts/ops/dingtalk-p4-final-handoff.test.mjs \
  scripts/ops/dingtalk-p4-final-docs.test.mjs \
  scripts/ops/dingtalk-p4-final-closeout.test.mjs \
  scripts/ops/dingtalk-p4-offline-handoff.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
```

- Result: pass, 96 tests.

```bash
git diff --check
```

- Result: pass.

## Covered Cases

- Smoke-session bootstrap summaries include the final closeout command.
- Smoke-session finalized summaries include the final closeout command.
- Smoke-session failed finalize summaries still include the final closeout command for retry after fixing evidence.
- Smoke-status manual/finalize/handoff pending summaries include the final closeout command.
- Exported staging evidence packets copy `dingtalk-p4-final-docs.mjs` and `dingtalk-p4-final-closeout.mjs`.
- Exported packet README recommends final closeout before lower-level debug commands.

## Remaining External Blockers

The integrated closeout path still requires a real completed remote smoke session:

- private 142/staging env values;
- live remote smoke execution;
- real DingTalk client/admin artifacts;
- human review of raw packet artifacts before external handoff.
