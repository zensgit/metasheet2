# DingTalk Screenshot Archive Verification

## Summary

This document records validation for the DingTalk screenshot archive helper added on 2026-05-11.

## Automated Verification

```bash
node --test scripts/ops/dingtalk-screenshot-archive.test.mjs
```

Result: PASS

- 5 tests passed.
- Covered nested screenshot copy, non-image warnings, redaction of token-like source labels, empty archive failure behavior, explicit `--allow-empty`, and output/input overlap rejection.

```bash
git diff --check
```

Result: PASS

```bash
git diff --cached \
  | rg -n 'access_token=[A-Za-z0-9]|SEC[A-Za-z0-9+/=_-]{16,}|Bearer [A-Za-z0-9._~+/=-]{16,}|eyJ[A-Za-z0-9._-]{20,}|https://oapi\.dingtalk\.com/robot/send\?' \
  | rg -v '<redacted>|robot-secret|archive-secret|secret-token|SECabcdef1234567890' || true
```

Result: PASS, no matches after excluding intentional synthetic test fixtures and `<redacted>` literals.

## Manual Review

- Confirmed archive output uses stable names under `screenshots/screenshot-NNN.<ext>`.
- Confirmed manifest/README record redacted source labels, byte sizes, and SHA-256 hashes.
- Confirmed raw screenshots are intentionally treated as restricted artifacts because pixels may still contain personal or operational data.

## Result

PASS. The helper is ready to use for DingTalk live-acceptance screenshot evidence packaging.
