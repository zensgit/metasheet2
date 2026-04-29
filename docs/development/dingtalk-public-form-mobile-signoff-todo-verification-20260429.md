# DingTalk Public Form Mobile Signoff TODO And Autocompile Verification - 2026-04-29

## Scope

This document verifies the remaining-check TODO report and record-time
autocompile flow for DingTalk public-form mobile signoff.

Changed files:

- `scripts/ops/dingtalk-public-form-mobile-signoff.mjs`
- `scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs`
- `docs/development/dingtalk-public-form-mobile-signoff-todo-design-20260429.md`
- `docs/development/dingtalk-public-form-mobile-signoff-todo-verification-20260429.md`

## Commands

```bash
node --test scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs

KIT=$(mktemp -d -t dingtalk-mobile-signoff-todo-kit)
TODO_OUT=$(mktemp -d -t dingtalk-mobile-signoff-todo-report)
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs --init-kit "$KIT"
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs --todo "$KIT/mobile-signoff.json" --output-dir "$TODO_OUT/initial"
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --record "$KIT/mobile-signoff.json" \
  --check-id public-anonymous-submit \
  --status pass \
  --source server-observation \
  --operator qa \
  --summary "Anonymous public form inserted one record." \
  --record-insert-delta 1 \
  --output-dir "$KIT/compiled" \
  --compile-when-ready
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --record "$KIT/mobile-signoff.json" \
  --check-id selected-unlisted-bound-rejected \
  --status pass \
  --source manual-client \
  --operator qa \
  --summary "The unlisted bound user was blocked before insert." \
  --submit-blocked \
  --record-insert-delta 0 \
  --blocked-reason "Not in selected user or group allowlist." \
  --output-dir "$KIT/compiled" \
  --compile-when-ready
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs --todo "$KIT/mobile-signoff.json" --output-dir "$TODO_OUT/partial"
node -e "const fs=require('fs');for (const label of ['initial','partial']) { const r=JSON.parse(fs.readFileSync(process.argv[1]+'/'+label+'/todo.json','utf8')); console.log(label+': '+JSON.stringify({strictReady:r.strictReady, remaining:r.remainingChecks.length, pass:r.counts.pass||0, pending:r.counts.pending||0, errors:r.errors.length})) }" "$TODO_OUT"

git diff --check
git diff -- scripts/ops/dingtalk-public-form-mobile-signoff.mjs scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs docs/development/dingtalk-public-form-mobile-signoff-todo-design-20260429.md docs/development/dingtalk-public-form-mobile-signoff-todo-verification-20260429.md \
  | rg -v "rg -n" \
  | rg -n "(access_token=[A-Za-z0-9]|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]{20,}|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET|publicToken=[A-Za-z0-9._~+/=-]{12,})" || true
```

## Results

- Node test: passed, 15 tests.
- Initial TODO report: `strictReady=false`, `remaining=9`, `pass=0`, `pending=9`, `errors=0`.
- Partial TODO report after two records: `strictReady=false`, `remaining=7`, `pass=2`, `pending=7`, `errors=0`.
- `--compile-when-ready` did not write strict output while checks remained pending.
- Final-record autocompile path is covered by the Node test suite and writes `summary.json`, `summary.md`, and `mobile-signoff.redacted.json`.
- `git diff --check`: passed.
- Diff secret scan: no matches for DingTalk webhook/token/JWT/public-token patterns.

## Regression Coverage

New Node tests cover:

- File-based TODO report generation with remaining counts and command templates.
- Stdout TODO report generation.
- Secret-like TODO input detection with redacted source output.
- `--compile-when-ready` remaining-check reporting.
- `--compile-when-ready` strict output on the final passing record.
- Rejection of `--compile-when-ready --dry-run`.
- Rejection of secret-like record updates before autocompile output.

Existing tests still cover:

- Kit initialization.
- Single-check record updates.
- Dry-run record behavior.
- Strict compile with screenshot-free structured evidence.
- Secret-like compile input rejection.

## Remaining Manual Step

A real DingTalk mobile client still has to execute each scenario. The tool now
handles the surrounding operator mechanics: list remaining checks, provide safe
record commands, and write the strict packet automatically when the final check
passes.
