# DingTalk P4 Remote Smoke Phase Contract Verification

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Result: partial pass, with sandbox-blocked local-listen tests noted below

## Static Checks

```bash
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
node --check scripts/ops/dingtalk-p4-smoke-status.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.mjs
node --check scripts/ops/dingtalk-p4-final-docs.mjs
node --check scripts/ops/dingtalk-p4-evidence-record.mjs
node --check scripts/ops/export-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/validate-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/dingtalk-p4-release-readiness.mjs
```

- Result: pass.

## Targeted Tests

```bash
node --test \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/dingtalk-p4-smoke-status.test.mjs
```

- Result: pass, 27 tests.
- Covered compile/status phase values: `bootstrap_pending`, `manual_pending`, `finalize_pending`, and `fail`.
- Covered status Markdown/TODO phase rendering.

```bash
node --test \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-final-docs.test.mjs
```

- Result: pass, 37 tests.
- Covered packet metadata export, validator enum rejection, release-readiness smoke-session phase display, and final docs phase gating.

```bash
node --test \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs \
  scripts/ops/dingtalk-p4-evidence-record.test.mjs
```

- Result: partial pass, 33 passed and 1 failed.
- Failure: `dingtalk-p4-smoke-session runs preflight, API runner, and non-strict compile` could not start the test fake API because the sandbox rejected `listen EPERM: operation not permitted 127.0.0.1`.
- Non-listening evidence recorder and smoke-session finalize tests in the same command passed, including phase print/summary assertions.

Additional sandbox-safe split checks:

```bash
node --test scripts/ops/dingtalk-p4-evidence-record.test.mjs
```

- Result: pass, 25 tests.

```bash
node --test --test-name-pattern "writes an editable env template|rejects non-canonical robot webhook|requires person user|stops after failed preflight|finalizes completed manual evidence|preserves external artifact allowance|finalize fails when strict evidence is incomplete|rejects finalize output-dir ambiguity" \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs
```

- Result: pass, 8 tests.

## Full P4 Regression Status

Full P4 regression was not re-run to completion after this change because the current sandbox blocks local fake API servers with `listen EPERM: operation not permitted 127.0.0.1`.

The broad P4 regression command excluding `dingtalk-p4-smoke-session.test.mjs` was run and still hit local-listen restrictions in the offline handoff, remote smoke, and preflight suites:

```bash
node --test \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs \
  scripts/ops/dingtalk-p4-offline-handoff.test.mjs \
  scripts/ops/dingtalk-p4-final-handoff.test.mjs \
  scripts/ops/dingtalk-p4-final-closeout.test.mjs \
  scripts/ops/dingtalk-p4-final-docs.test.mjs \
  scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-smoke-status.test.mjs \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-evidence-record.test.mjs \
  scripts/ops/dingtalk-p4-smoke-preflight.test.mjs \
  scripts/ops/dingtalk-p4-regression-gate.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

- Result: partial pass, 123 passed and 6 failed.
- Failed tests: one offline handoff, three remote smoke, and two preflight tests.
- Failure reason for all six: sandbox rejected fake API `127.0.0.1` listen with `EPERM`.

The full expected P4 gate once local loopback listening is available is:

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

## Notes

- Verification was local and offline.
- No real 142 staging smoke, DingTalk tenant, webhook, admin token, or user token was used.
- The remaining product work is the real remote-smoke evidence collection on staging, including the no-email DingTalk-synced local user create/bind check.
