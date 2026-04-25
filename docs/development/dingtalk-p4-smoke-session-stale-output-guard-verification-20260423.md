# DingTalk P4 Smoke Session Stale Output Guard Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Result: pass

## Targeted Verification

```bash
node --test scripts/ops/dingtalk-p4-smoke-session.test.mjs
```

- Result: pass, 9 tests.

## Covered Cases

- Bootstrap preflight failure clears stale `workspace/` and `compiled/` outputs before writing the new failure summary.
- Final strict compile failure overwrites stale passing `compiled/summary.json` with the latest failing strict result.
- Finalized session next commands include a session-specific packet output directory.
- Packet export next command includes `--output-dir`.
- Final handoff next command includes `--output-dir`.
- Final closeout next command uses the same session-specific packet output directory.
- External artifact allowance is preserved when final closeout is suggested.
- Generated final commands do not hardcode `artifacts/dingtalk-staging-evidence-packet/142-final`.

## P4 Tooling Regression

```bash
node --test \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs \
  scripts/ops/dingtalk-p4-offline-handoff.test.mjs \
  scripts/ops/dingtalk-p4-final-handoff.test.mjs \
  scripts/ops/dingtalk-p4-final-closeout.test.mjs \
  scripts/ops/dingtalk-p4-final-docs.test.mjs \
  scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-smoke-status.test.mjs \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-evidence-record.test.mjs \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-regression-gate.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

- Result: pass, 135 tests.

## Notes

- Verification was local and offline.
- No real 142 staging smoke, DingTalk tenant, robot webhook, admin token, or user token was used.
- Real final smoke still requires operator-provided private env values and manual DingTalk client/admin evidence artifacts.
