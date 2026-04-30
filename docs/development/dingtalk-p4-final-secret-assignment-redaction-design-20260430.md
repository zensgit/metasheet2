# DingTalk P4 Final Secret Assignment Redaction Design

## Goal

Close the remaining DingTalk P4 finalization redaction gap for copied secret assignments that include spaces around `=`.

## Scope

- `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs`
- `scripts/ops/dingtalk-p4-final-handoff.mjs`
- `scripts/ops/dingtalk-p4-final-closeout.mjs`
- `scripts/ops/dingtalk-p4-final-docs.mjs`

## Change Summary

The final evidence, handoff, closeout, and docs tooling now redacts these forms consistently:

- `client_secret = <redacted>`
- `DINGTALK_CLIENT_SECRET = <redacted>`
- `DINGTALK_STATE_SECRET = <redacted>`

The matcher preserves the assignment key and spacing while replacing only the secret value. This keeps operator-facing diagnostics useful without allowing pasted env snippets or OAuth-style client secrets into generated summaries.

## Safety Notes

- `dingtalk-p4-final-docs.mjs` also treats unredacted DingTalk secret assignments as secret-like output and refuses to write final Markdown if one survives sanitization.
- `dingtalk-p4-final-handoff.mjs` and `compile-dingtalk-p4-smoke-evidence.mjs` now run top-level error messages through `redactString`, matching the safer behavior already present in the closeout and docs scripts.
- Existing webhook token, bearer token, SEC secret, JWT, public form token, timestamp, and sign redaction behavior is unchanged.

## Regression Coverage

- Final docs: redacts spaced client secret assignments embedded in handoff/status failure details.
- Evidence compiler: redacts spaced client secret assignments in sanitized evidence and top-level CLI errors.
- Final handoff: redacts spaced client secret assignments in top-level CLI errors.
- Final closeout: redacts spaced client secret assignments in top-level CLI errors.
