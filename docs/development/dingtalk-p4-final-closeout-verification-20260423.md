# DingTalk P4 Final Closeout Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Base: `origin/main` at `8d2d3e1b0`
- Result: pass for local final closeout orchestration; real closeout still requires a live 142/staging session with human DingTalk evidence

## Commands Run

```bash
node --test scripts/ops/dingtalk-p4-final-closeout.test.mjs
```

- Result: pass, 4 tests.

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
  scripts/ops/dingtalk-p4-smoke-status.test.mjs \
  scripts/ops/dingtalk-p4-final-handoff.test.mjs \
  scripts/ops/dingtalk-p4-final-docs.test.mjs \
  scripts/ops/dingtalk-p4-final-closeout.test.mjs \
  scripts/ops/dingtalk-p4-offline-handoff.test.mjs
```

- Result: pass, 58 tests.

```bash
git diff --check
```

- Result: pass.

## Covered Cases

- Closeout finalizes a ready local session, exports the handoff packet, gates release readiness, and writes final docs.
- `--skip-docs` stops after release-ready status while still writing closeout summaries.
- Finalize failure stops the chain early and writes a failed closeout summary.
- Overlapping packet output and session paths are rejected.
- Smoke-session summaries now include `dingtalk-p4-final-closeout.mjs` in next commands.
- Smoke-status summaries now recommend `dingtalk-p4-final-closeout.mjs` before the lower-level handoff/finalize commands.
- Exported staging evidence packets include `dingtalk-p4-final-docs.mjs` and `dingtalk-p4-final-closeout.mjs`.
- The generated closeout summary preserves final status fields and does not leak secret-shaped values.

## Remaining External Blockers

The closeout wrapper is ready, but it still needs a real completed session. The following remain outside local code:

- populate `$HOME/.config/yuantus/dingtalk-p4-staging.env` with real private 142/staging values;
- run real remote smoke;
- capture and record real DingTalk client/admin artifacts;
- run closeout against the real session;
- human-review raw packet artifacts before external release handoff.
