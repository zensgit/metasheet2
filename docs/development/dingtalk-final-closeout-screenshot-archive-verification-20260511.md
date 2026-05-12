# DingTalk Final Closeout Screenshot Archive - Verification

- Date: 2026-05-11
- Scope: final closeout wrapper screenshot archive gate.
- Result: PASS.

## Commands

```bash
node --test scripts/ops/dingtalk-p4-final-closeout.test.mjs
node --test scripts/ops/dingtalk-p4-final-docs.test.mjs
node --test scripts/ops/dingtalk-p4-final-handoff.test.mjs
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
node --test \
  scripts/ops/dingtalk-p4-final-closeout.test.mjs \
  scripts/ops/dingtalk-p4-final-docs.test.mjs \
  scripts/ops/dingtalk-p4-final-handoff.test.mjs \
  scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs \
  scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
node scripts/ops/dingtalk-p4-final-closeout.mjs --help | rg -- '--include-screenshot-archive|--require-screenshot-archive-pass'
node scripts/ops/dingtalk-screenshot-archive.mjs \
  --input <operator-screenshot-file-1> \
  --input <operator-screenshot-file-2> \
  --input <operator-screenshot-file-3> \
  --input <operator-screenshot-file-4> \
  --input <operator-screenshot-file-5> \
  --input <operator-screenshot-file-6> \
  --input <operator-screenshot-file-7> \
  --output-dir /tmp/dingtalk-screenshot-archive-20260511
git diff --check
```

## Results

| Gate | Result |
| --- | --- |
| Final closeout tests | PASS, 9/9 |
| Final docs tests | PASS, 5/5 |
| Final handoff tests | PASS, 13/13 |
| Evidence packet exporter tests | PASS, 20/20 |
| Evidence packet validator tests | PASS, 20/20 |
| Combined affected ops suite | PASS, 67/67 |
| CLI help exposes screenshot archive flags | PASS |
| Operator screenshot archive smoke | PASS, 7 screenshots packaged |
| Whitespace diff check | PASS |

## Coverage Added

- `dingtalk-p4-final-closeout` forwards strict screenshot archive arguments into final handoff.
- Closeout summary records screenshot archive gate required/not-required status.
- Closeout summary records included screenshot archive count.
- Generated final development and verification docs include screenshot archive gate status.
- Release-ready final docs reject a required screenshot archive gate with zero included archives.

## Secret Review

The changed paths were scanned with diff checks and token-pattern grep. No real DingTalk webhook, `SEC`, JWT, bearer token, app secret, public form token, Agent ID, recipient id, or temporary password was added.

## Final Status

The final DingTalk closeout command now has parity with the lower-level handoff gate: screenshot archive evidence can be required from the top-level release command and is visible in the generated final documentation.
