# DingTalk Public Form Mobile Signoff Recorder Verification - 2026-04-29

## Scope

This document verifies the `--record` mode added to the DingTalk public-form
mobile signoff tool.

Changed files:

- `scripts/ops/dingtalk-public-form-mobile-signoff.mjs`
- `scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs`
- `docs/development/dingtalk-public-form-mobile-signoff-recorder-design-20260429.md`
- `docs/development/dingtalk-public-form-mobile-signoff-recorder-verification-20260429.md`

## Commands

```bash
node --test scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs

KIT=$(mktemp -d -t dingtalk-mobile-signoff-recorder-kit)
OUT=$(mktemp -d -t dingtalk-mobile-signoff-recorder-compiled)
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs --init-kit "$KIT"
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --record "$KIT/mobile-signoff.json" \
  --check-id public-anonymous-submit \
  --status pass \
  --source server-observation \
  --operator qa \
  --summary "Anonymous public form inserted one record." \
  --record-insert-delta 1
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --record "$KIT/mobile-signoff.json" \
  --check-id selected-unlisted-bound-rejected \
  --status pass \
  --source manual-client \
  --operator qa \
  --summary "The unlisted bound user was blocked before insert." \
  --submit-blocked \
  --record-insert-delta 0 \
  --blocked-reason "Not in selected user or group allowlist."
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --input "$KIT/mobile-signoff.json" \
  --output-dir "$OUT"
node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify({status:s.status, errors:s.errors.length, recorded:s.requiredChecks.filter(c=>c.status==='pass').length}))" "$OUT/summary.json"

git diff --check
git diff --cached -- scripts/ops/dingtalk-public-form-mobile-signoff.mjs scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs docs/development/dingtalk-public-form-mobile-signoff-recorder-design-20260429.md docs/development/dingtalk-public-form-mobile-signoff-recorder-verification-20260429.md \
  | rg -v "git diff --cached -- scripts/ops/dingtalk-public-form-mobile-signoff" \
  | rg -v "rg -n" \
  | rg -n "(access_token=[A-Za-z0-9]|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]{20,}|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET|publicToken=[A-Za-z0-9._~+/=-]{12,})" || true
```

## Results

- Node test: passed, 8 tests.
- Manual recorder flow: passed.
- Partial non-strict compile after two recorded checks: `{"status":"pass","errors":0,"recorded":2}`.
- `git diff --check`: passed.
- Diff secret scan: no matches for DingTalk webhook/token/JWT/public-token patterns.

## Regression Coverage

The new Node tests cover:

- Recording an allowed submit check with a positive insert delta.
- Recording a denied submit check with `submitBlocked=true` and zero insert
  proof.
- Dry-running a render check without mutating `mobile-signoff.json`.
- Rejecting secret-like record updates before write.

Existing tests still cover:

- Kit initialization.
- Strict compile with screenshot-free structured evidence.
- Rejection of denied-submit checks without zero-insert proof.
- Rejection of secret-like evidence text during compile.

## Remaining Manual Step

A real DingTalk mobile client still has to execute each access-matrix scenario.
This slice removes the need to hand-edit the JSON packet; it does not remove the
need for the real client run.
