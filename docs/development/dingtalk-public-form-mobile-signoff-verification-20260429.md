# DingTalk Public Form Mobile Signoff Verification - 2026-04-29

## Scope

This document verifies the screenshot-optional mobile signoff evidence tooling
for DingTalk public forms.

Changed files:

- `scripts/ops/dingtalk-public-form-mobile-signoff.mjs`
- `scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs`
- `docs/development/dingtalk-public-form-mobile-signoff-design-20260429.md`
- `docs/development/dingtalk-public-form-mobile-signoff-verification-20260429.md`

## Commands

```bash
node --test scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs --init-kit /tmp/dingtalk-mobile-signoff-kit-verify
git diff --check
git diff --cached -- scripts/ops/dingtalk-public-form-mobile-signoff.mjs scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs docs/development/dingtalk-public-form-mobile-signoff-design-20260429.md docs/development/dingtalk-public-form-mobile-signoff-verification-20260429.md \
  | rg -v "git diff --cached -- scripts/ops/dingtalk-public-form-mobile-signoff" \
  | rg -v "rg -n" \
  | rg -n "(access_token=[A-Za-z0-9]|SEC[0-9a-fA-F]{8,}|Authorization:|Bearer [A-Za-z0-9._-]{20,}|https://oapi\\.dingtalk\\.com/robot/send|JWT_SECRET|DINGTALK_APP_SECRET|publicToken=[A-Za-z0-9._~+/=-]{12,})" || true
```

## Results

- Node test: passed, 4 tests.
- Kit initialization command: passed and wrote `/tmp/dingtalk-mobile-signoff-kit-verify`.
- `git diff --check`: passed.
- Diff secret scan: no matches for DingTalk webhook/token/JWT/public-token patterns.

## Regression Coverage

The new Node test covers:

- Creating an editable signoff kit with template JSON, checklist, and artifact folders.
- Strict compile with screenshot-free structured evidence.
- Rejection of denied-submit checks that do not prove zero record inserts.
- Rejection of secret-like evidence text, including public form token leakage.

## Expected Operator Flow

1. Create a kit:

```bash
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --init-kit output/dingtalk-public-form-mobile-signoff/142-kit
```

2. Fill `output/dingtalk-public-form-mobile-signoff/142-kit/mobile-signoff.json`
   with real DingTalk mobile results.

3. Compile strictly:

```bash
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \
  --input output/dingtalk-public-form-mobile-signoff/142-kit/mobile-signoff.json \
  --output-dir output/dingtalk-public-form-mobile-signoff/142-compiled \
  --strict
```

## Remaining Manual Step

A real DingTalk client must still perform the actions. The difference after this
slice is that screenshots are optional; structured server-side counts and
blocked reasons are accepted as the auditable evidence.

## Secret Handling

No webhook URL, DingTalk signing secret, bearer token, JWT, public form token,
or raw `Authorization` header was added to source, tests, or docs.
