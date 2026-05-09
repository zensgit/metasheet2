# DingTalk P4 Packet Secret Assignment Scan Development

- Date: 2026-04-29
- Branch: `codex/dingtalk-packet-secret-assignment-scan-20260429`
- Base: `origin/main` at `54b08b3b6`
- Scope: harden staging evidence packet publish validation against raw token/password assignment leaks

## Goal

The staging evidence packet validator already rejects common webhook, bearer, JWT, `SEC...`, DingTalk client-secret, and public form token leaks. This slice extends the same publish-time safety gate to catch copied environment/admin notes that expose raw auth token or password assignments.

## Changes

- Added `auth_token_assignment` secret pattern for raw `DINGTALK_P4_AUTH_TOKEN`, `ADMIN_TOKEN`, and `AUTH_TOKEN` assignments.
- Added `password_assignment` secret pattern for raw `password`, `temp_password`, `temporary_password`, and `temporary password` assignments.
- Kept placeholders and safe redacted forms allowed, including `<redacted>`, `replace-me`, `changeme`, `example`, `$ENV_VAR`, `{...}`, and `<...>` values.
- Added regression coverage that writes raw token/password assignments into a packet artifact and verifies the validator fails.
- Preserved report safety by asserting `publish-check.json` contains redacted previews only.

## Compatibility

- Generated exporter packets still pass.
- Existing mobile signoff packet validation remains covered.
- No network, 142 server, DingTalk, browser, or database call is added.
- Existing `secretFindings[]` schema is unchanged; only new `pattern` names can appear.

## Security Boundary

- This is a preventive publish gate. It does not prove every possible secret string is absent.
- The validator continues to skip large files over the existing scan byte limit and binary-looking files.
- Human review is still required before sharing raw screenshots or evidence externally.
