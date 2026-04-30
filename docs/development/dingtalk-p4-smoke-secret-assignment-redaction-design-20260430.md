# DingTalk P4 Smoke Secret Assignment Redaction Design

## Goal

Extend the existing DingTalk P4 secret-redaction coverage so the smoke tooling also masks secret assignments written with surrounding spaces, not only `key=value` forms.

## Scope

- `scripts/ops/dingtalk-p4-remote-smoke.mjs`
- `scripts/ops/dingtalk-p4-smoke-session.mjs`
- matching regression tests for API-error and env-file failure paths

## Change Summary

Both smoke scripts now redact these assignment shapes before printing errors:

- `client_secret = raw-value`
- `DINGTALK_CLIENT_SECRET = raw-value`
- `DINGTALK_STATE_SECRET = raw-value`

The regex keeps the original left-hand side and replaces only the secret payload with `<redacted>`, including when operators paste values with spaces around `=`.

## Why This Slice

Earlier evidence-packet tooling already blocked spaced secret assignments. The smoke scripts still had a narrower `key=value` matcher, which left a small but real chance of leaking copied env snippets through CLI error output. This slice closes that gap on the smoke/bootstrap path.

## Regression Coverage

- Remote smoke: inject a server-side API error containing `DINGTALK_CLIENT_SECRET = ...` and assert stderr is redacted.
- Smoke session: pass an unknown CLI argument containing `DINGTALK_CLIENT_SECRET = ...` and assert stderr is redacted.
