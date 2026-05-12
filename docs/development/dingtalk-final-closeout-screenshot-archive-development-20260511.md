# DingTalk Final Closeout Screenshot Archive - Development

- Date: 2026-05-11
- Scope: final DingTalk P4 closeout wrapper and generated final docs.
- Goal: make screenshot archive evidence enforceable from the single `dingtalk-p4-final-closeout.mjs` command, not only from the lower-level handoff command.

## Background

The screenshot evidence archive helper and final handoff packet already supported strict screenshot archive validation. The remaining gap was the outer closeout wrapper:

- `dingtalk-p4-final-handoff.mjs` could accept `--include-screenshot-archive` and `--require-screenshot-archive-pass`.
- `dingtalk-p4-final-closeout.mjs` could not forward those flags.
- `dingtalk-p4-final-docs.mjs` did not surface screenshot archive gate status in generated development and verification markdown.

This made the final one-command closeout path weaker than the underlying packet gate.

## Changes

- Added `--include-screenshot-archive <dir>` to `scripts/ops/dingtalk-p4-final-closeout.mjs`.
- Added `--require-screenshot-archive-pass` to reject strict closeout runs that forgot to include screenshot evidence.
- Forwarded screenshot archive arguments from final closeout into `dingtalk-p4-final-handoff.mjs`.
- Added screenshot archive fields to closeout summary JSON and Markdown:
  - `screenshotArchiveRequired`
  - `screenshotArchiveCount`
- Updated `dingtalk-p4-final-docs.mjs` to record screenshot archive gate status and included archive count.
- Added a final-docs release-ready guard for the impossible state where screenshot archive is required but no archive is included.

## Operator Flow

```bash
node scripts/ops/dingtalk-screenshot-archive.mjs \
  --input <operator-screenshot-dir> \
  --output-dir artifacts/dingtalk-screenshot-archive/<run-id>

node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/<run-id> \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/<run-id>-final \
  --include-screenshot-archive artifacts/dingtalk-screenshot-archive/<run-id> \
  --require-screenshot-archive-pass \
  --docs-output-dir docs/development \
  --date <yyyymmdd>
```

## Security Notes

- The closeout summary and generated docs only record archive counts/status, not screenshot pixels.
- Raw screenshots still remain access-restricted release artifacts.
- No webhook, `SEC`, JWT, bearer token, app secret, Agent ID, recipient id, or temporary password is written to the docs.

## Non-Goals

- No runtime DingTalk behavior changed.
- No API or database schema changed.
- No OCR or screenshot content assertion was added; the archive gate validates packaging integrity only.
