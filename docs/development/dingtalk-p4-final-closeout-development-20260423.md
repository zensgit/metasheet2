# DingTalk P4 Final Closeout Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Base: `origin/main` at `8d2d3e1b0`
- Scope: collapse the local post-evidence closeout chain into one command

## Problem

After all remote-smoke manual evidence is recorded, the operator previously still had to run several local commands in sequence:

- strict finalize the session;
- export and validate the final handoff packet;
- rerun release-ready smoke status with the handoff summary;
- generate the final remote-smoke development and verification docs.

Each command already existed and had tests, but the release closeout path still required manual command sequencing.

## Changes

- Added `scripts/ops/dingtalk-p4-final-closeout.mjs`.
- The closeout wrapper runs, in order:
  - `dingtalk-p4-smoke-session.mjs --finalize <session-dir>`
  - `dingtalk-p4-final-handoff.mjs --session-dir <session-dir> --output-dir <packet-output-dir>`
  - `dingtalk-p4-smoke-status.mjs --session-dir <session-dir> --handoff-summary <handoff-summary.json> --require-release-ready`
  - `dingtalk-p4-final-docs.mjs --session-dir <session-dir> --handoff-summary <handoff-summary.json> --require-release-ready`
- Added closeout outputs:
  - `closeout-summary.json`
  - `closeout-summary.md`
- Added `--skip-docs` for cases where release-ready gating should run but final docs should be generated later.
- Added `--allow-external-artifact-refs` passthrough for finalize parity with the lower-level session command.
- Preserved redaction for bearer tokens, DingTalk webhook tokens, SEC secrets, JWTs, public form tokens, timestamps, and signatures.
- Updated the final plan/TODO and remote smoke checklist to recommend the closeout wrapper after manual evidence is complete.
- Integrated the closeout wrapper into `dingtalk-p4-smoke-session.mjs` next commands so both bootstrap and finalized session summaries point to the one-command closeout path.
- Integrated the closeout wrapper into `dingtalk-p4-smoke-status.mjs` next commands for `manual_pending`, `finalize_pending`, and `handoff_pending` states.
- Added `dingtalk-p4-final-docs.mjs` and `dingtalk-p4-final-closeout.mjs` to the exported staging evidence packet, including README order guidance.

## Operator Flow

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --docs-output-dir docs/development \
  --date 20260423
```

Expected high-level outputs:

- `artifacts/dingtalk-staging-evidence-packet/142-final/closeout-summary.json`
- `artifacts/dingtalk-staging-evidence-packet/142-final/closeout-summary.md`
- `artifacts/dingtalk-staging-evidence-packet/142-final/handoff-summary.json`
- `artifacts/dingtalk-staging-evidence-packet/142-final/publish-check.json`
- `docs/development/dingtalk-final-remote-smoke-development-20260423.md`
- `docs/development/dingtalk-final-remote-smoke-verification-20260423.md`

## Out Of Scope

- No real 142/staging smoke was executed in this slice.
- No admin token, DingTalk webhook, SEC secret, or manual screenshot artifact was added.
- The wrapper does not replace human review of raw screenshots and release evidence before external sharing.
