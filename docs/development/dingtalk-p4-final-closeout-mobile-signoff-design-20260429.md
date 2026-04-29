# DingTalk P4 Final Closeout Mobile Signoff Design - 2026-04-29

## Goal

Make the final DingTalk P4 release closeout command include the strict mobile
public-form signoff gate directly.

The evidence packet exporter already supports `--include-mobile-signoff` and
`--require-mobile-signoff-pass`. Before this slice, operators using the higher
level `dingtalk-p4-final-handoff.mjs` or `dingtalk-p4-final-closeout.mjs`
wrappers still had to run a second manual packet export to include mobile
signoff. That left a last-mile gap in the recommended one-command closeout path.

## Scope

Updated scripts:

- `scripts/ops/dingtalk-p4-final-handoff.mjs`
- `scripts/ops/dingtalk-p4-final-closeout.mjs`

Updated tests:

- `scripts/ops/dingtalk-p4-final-handoff.test.mjs`
- `scripts/ops/dingtalk-p4-final-closeout.test.mjs`

Updated runbook:

- `docs/dingtalk-remote-smoke-checklist-20260422.md`

Added docs:

- `docs/development/dingtalk-p4-final-closeout-mobile-signoff-design-20260429.md`
- `docs/development/dingtalk-p4-final-closeout-mobile-signoff-verification-20260429.md`

## CLI Contract

Final handoff now accepts:

```bash
node scripts/ops/dingtalk-p4-final-handoff.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --include-mobile-signoff output/dingtalk-public-form-mobile-signoff/142-compiled \
  --require-mobile-signoff-pass
```

Final closeout now forwards the same mobile gate options into the final handoff
step:

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --include-mobile-signoff output/dingtalk-public-form-mobile-signoff/142-compiled \
  --require-mobile-signoff-pass
```

`--include-mobile-signoff` can be repeated. Each path is passed to the packet
exporter, which performs the strict signoff validation before copy.

`--require-mobile-signoff-pass` requires at least one included mobile signoff
directory. The wrapper rejects the missing-input case before running the final
handoff export, and closeout rejects it before finalizing the session.

## Summary Output

`dingtalk-p4-final-handoff.mjs` now records:

- whether the mobile signoff gate was required;
- how many mobile signoff directories the publish validator accepted;
- the source directories passed to the wrapper.

`dingtalk-p4-final-closeout.mjs` now records:

- `final.mobileSignoffRequired`;
- `final.mobileSignoffCount`;
- the forwarded final-handoff command containing the mobile gate options.

The Markdown summaries also show the mobile gate state and accepted signoff
count so release reviewers can confirm the one-command closeout covered both P4
remote-smoke evidence and mobile public-form signoff.

## Secret Handling

This slice does not change the underlying redaction model:

- raw mobile `mobile-signoff.json` kit directories are still rejected by the
  packet exporter;
- only strict compiled and redacted mobile signoff output should be included;
- handoff and closeout summaries still redact DingTalk webhooks, signing
  secrets, JWTs, bearer tokens, public form tokens, timestamps, and signatures;
- docs contain placeholder paths only.

## Non-goals

- This does not execute DingTalk mobile login or form submission.
- This does not generate or store real mobile signoff evidence.
- This does not change P4 smoke finalization rules.
- This does not replace human review of the final redacted packet before
  external release handoff.
