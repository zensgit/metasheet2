# DingTalk P4 Final Evidence Hardening Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Result: pass

## Targeted Verification

```bash
node --test \
  scripts/ops/dingtalk-p4-evidence-record.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
```

- Result: pass, 61 tests.

## Covered Cases

- Evidence recorder rejects negative `--before-record-count` / `--after-record-count`.
- Evidence recorder rejects fractional `--record-insert-delta`.
- Strict evidence compile rejects invalid unauthorized-denial counters with `record_count_non_negative_integer_required`.
- Packet exporter clears stale `evidence/` directories when reusing an existing DingTalk packet output.
- Packet exporter clears stale evidence after gated rerun failures, not just `manifest.json` and `README.md`.
- Packet validator rejects unregistered `evidence/<name>` entries that are not present in `manifest.includedEvidence`.
- Existing generated packet acceptance, final gated packet acceptance, traversal rejection, and secret-like evidence scans still pass.

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

- Result: pass, 132 tests.

## Notes

- Verification was local and offline.
- No real 142 staging, DingTalk tenant, robot webhook, admin token, or user token was used.
- Real staging closeout still requires operator-provided `DINGTALK_P4_*` values in the private env file and final manual evidence artifacts.
