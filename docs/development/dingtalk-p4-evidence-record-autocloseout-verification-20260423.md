# DingTalk P4 Evidence Record Auto Closeout Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Result: pass

## Commands Run

```bash
node --test scripts/ops/dingtalk-p4-evidence-record.test.mjs
```

- Result: pass, 22 tests.

```bash
node --test \
  scripts/ops/dingtalk-p4-evidence-record.test.mjs \
  scripts/ops/dingtalk-p4-smoke-status.test.mjs \
  scripts/ops/dingtalk-p4-final-closeout.test.mjs \
  scripts/ops/dingtalk-p4-offline-handoff.test.mjs
```

- Result: pass, 36 tests.

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

- Result: pass, 100 tests.

## Covered Cases

- Recorder does not auto-finalize or auto-closeout while smoke status is still `manual_pending`.
- Recorder still supports `--finalize-when-ready` for the lower-level debug path.
- Recorder runs final closeout after status refresh reaches `finalize_pending`.
- Closeout forwarding passes session dir, packet output dir, docs output dir, date, and `--skip-docs`.
- Recorder rejects conflicting `--closeout-when-ready` and `--finalize-when-ready`.
- Existing summary/artifact secret detection tests still pass, including `client_secret` forms.

## Remaining External Blockers

The auto-closeout path still requires the real remote smoke session to have complete manual evidence:

- populated private 142/staging env file;
- real DingTalk group/client/admin artifacts;
- human review of raw packet artifacts before external release handoff.
