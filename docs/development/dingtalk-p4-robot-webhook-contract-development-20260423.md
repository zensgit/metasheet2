# DingTalk P4 Robot Webhook Contract Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: make DingTalk P4 staging robot webhook validation consistent across readiness, preflight, and remote smoke execution

## Problem

The P4 tooling previously validated DingTalk robot webhook inputs at different strictness levels:

- env readiness required HTTPS, DingTalk host, and `access_token`, but did not require the robot send path;
- preflight accepted any HTTP(S) URL with `access_token`;
- remote smoke accepted any HTTP(S) URL before creating group destinations.

That left room for a malformed or non-DingTalk webhook to pass local gates and fail later during staging setup.

## Contract

All P4 robot webhook inputs now share the same local URL-shape contract:

- protocol must be `https:`;
- host must be `oapi.dingtalk.com`;
- path must be `/robot/send`;
- query must include a non-empty `access_token`.

Extra DingTalk signing parameters such as `timestamp` and `sign` remain valid. Reports continue to redact `access_token` and never call DingTalk during local shape checks.

## Changes

- Tightened `scripts/ops/dingtalk-p4-env-bootstrap.mjs` readiness checks to require `/robot/send` and a non-empty trimmed `access_token`.
- Tightened `scripts/ops/dingtalk-p4-smoke-preflight.mjs` so invalid scheme, host, path, or missing token fails the preflight gate with redacted output.
- Tightened `scripts/ops/dingtalk-p4-remote-smoke.mjs` so invalid robot URLs fail before any API request is made.
- Updated CLI help and private env template comments to show the canonical robot URL shape.
- Updated `docs/dingtalk-remote-smoke-checklist-20260422.md` to clarify local-only webhook shape validation and switch examples to plural env names:
  - `DINGTALK_P4_ALLOWED_USER_IDS`
  - `DINGTALK_P4_PERSON_USER_IDS`
- Updated `docs/development/dingtalk-final-development-plan-and-todo-20260423.md` with the canonical webhook contract.

## Out Of Scope

- No real 142/staging smoke was executed.
- No DingTalk webhook, admin bearer token, SEC signing secret, cookie, temporary password, or raw public form token was added to tracked files.
