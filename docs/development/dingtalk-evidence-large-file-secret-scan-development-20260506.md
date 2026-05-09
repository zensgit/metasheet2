# DingTalk Evidence Large-File Secret Scan Development - 2026-05-06

## Context

`scripts/ops/validate-dingtalk-staging-evidence-packet.mjs` previously skipped secret scanning for files larger than 2 MiB. That avoided loading large screenshots into memory, but it also allowed oversized text logs to carry raw `access_token`, bearer token, or similar evidence secrets without being reported.

The fix keeps binary evidence safe to include while closing the oversized-text gap.

## Design

- Keep the existing 2 MiB threshold as the in-memory scan limit for small files.
- For files larger than 2 MiB, sample the first 8 KiB to decide whether the file is likely text.
- If the file looks binary, skip secret scanning as before.
- If the file looks textual, scan it in 2 MiB chunks.
- Keep a 4 KiB overlap between chunks so secrets split across a chunk boundary are still detected.
- Reuse the existing redacted finding preview path so raw token values are never written to stderr or the JSON report.

## Files Changed

- `scripts/ops/validate-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs`

## Behavior

- Oversized text evidence containing query-string access tokens is rejected.
- Oversized text evidence containing bearer tokens split across the chunk boundary is rejected.
- Oversized binary evidence remains allowed.
- Existing small-file secret detection behavior is unchanged.

