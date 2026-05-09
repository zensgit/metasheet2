# DingTalk Evidence Large-File Secret Scan Verification - 2026-05-06

## Commands

```bash
node --check scripts/ops/validate-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs
git diff --check
```

## Result

- `validate-dingtalk-staging-evidence-packet.test.mjs`: 17/17 passed.
- Exporter + validator combined test run: 35/35 passed.
- `git diff --check`: passed.

## Coverage Added

- Reject oversized text logs with `access_token` evidence after the old 2 MiB cutoff.
- Reject bearer tokens split across the 2 MiB chunk boundary.
- Allow oversized binary evidence files.

## Residual Risk

This keeps the existing text/binary heuristic: a file containing NUL bytes is treated as binary and skipped. That is appropriate for screenshots and binary artifacts, but intentionally malformed binary/text hybrid files may still need future special handling if they become part of the evidence format.

