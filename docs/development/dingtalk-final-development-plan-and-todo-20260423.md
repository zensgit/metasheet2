# DingTalk Final Development Plan And TODO

- Date: 2026-04-23
- Goal: finish DingTalk group/person/form-access workflow through remote smoke and release evidence handoff
- Current base branch: `codex/dingtalk-p4-no-email-admin-evidence-helper-20260423`
- Current base commit: `154fafd5d`
- Remaining work type: remote smoke execution, evidence collection, final handoff, and final verification notes

## Current State

- [x] Multiple DingTalk groups per table
- [x] Group robot binding UI/API
- [x] Organization-scoped DingTalk group destination catalog v1
- [x] Group automation with form links
- [x] Form access modes: `public`, `dingtalk`, and `dingtalk_granted`
- [x] Local user/member-group allowlist for DingTalk-protected forms
- [x] Person messaging recipients: users, member groups, and dynamic fields
- [x] Directory sync account list
- [x] No-email local user create-and-bind
- [x] Delivery history for group/person sends
- [x] P4 smoke session, evidence recorder, status TODO, strict finalization, handoff packet, and publish validation
- [x] P4 local regression gate runner with redacted JSON/MD output for ops/product verification evidence

## PR Stack To Confirm

- [ ] Confirm #1104 CI success: unauthorized denial evidence contract
- [ ] Confirm #1105 CI success: remote smoke TODO export
- [ ] Confirm #1106 CI success: session status autorefresh
- [ ] Confirm #1107 CI success: no-email admin evidence helper
- [ ] Merge or promote the stack in order after earlier base PRs are merged
- [ ] Re-run targeted local checks after any promotion or rebase

## Remote Smoke Inputs

- [ ] Staging backend base URL
- [ ] Staging web base URL
- [ ] Admin/table-owner bearer token, supplied outside git and not pasted into docs
- [ ] DingTalk group robot webhook A
- [ ] DingTalk group robot webhook B
- [ ] Optional DingTalk group robot signing secrets
- [ ] Authorized local user ID bound to DingTalk
- [ ] Unauthorized DingTalk-bound local user for denial check
- [ ] Optional allowed member group ID
- [ ] Optional person-message local user ID
- [ ] Synced DingTalk account without matched local user for no-email admin check
- [x] Tooling records manual target identities in preflight/session/evidence outputs:
  - `DINGTALK_P4_AUTHORIZED_USER_ID`
  - `DINGTALK_P4_UNAUTHORIZED_USER_ID`
  - `DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID`

## Remote Smoke Execution

- [ ] Create env template:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --init-env-template output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env
```

- [ ] Fill the env file outside git.
- [ ] Run the session:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --require-manual-targets \
  --output-dir output/dingtalk-p4-remote-smoke-session/142-session
```

- [ ] Confirm generated files:
  - `workspace/evidence.json`
  - `workspace/manual-evidence-checklist.md`
  - `compiled/summary.json`
  - `session-summary.json`
  - `smoke-status.json`
  - `smoke-status.md`
  - `smoke-todo.md`
  - manual targets are present in `preflight/preflight-summary.json`, `workspace/evidence.json`, and `session-summary.json`

- [ ] Confirm API/bootstrap checks pass:
  - `create-table-form`
  - `bind-two-dingtalk-groups`
  - `set-form-dingtalk-granted`
  - `delivery-history-group-person` when person input is provided

## Manual Evidence

- [ ] `send-group-message-form-link`: capture DingTalk group message with protected form link.
- [ ] `authorized-user-submit`: authorized DingTalk-bound user opens and submits form; confirm record inserted.
- [ ] `unauthorized-user-denied`: unauthorized DingTalk-bound user is blocked; confirm no record inserted.
- [ ] `no-email-user-create-bind`: admin creates local user from synced DingTalk account with no email; confirm binding after refresh.
- [ ] Store artifacts only under `workspace/artifacts/<check-id>/`.
- [ ] Do not include full webhooks, signing secrets, bearer tokens, public form tokens, temporary passwords, or cookies in artifacts.

## Evidence Recorder Commands

Authorized submit:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id authorized-user-submit \
  --status pass \
  --source manual-client \
  --operator <operator> \
  --summary "<summary>" \
  --artifact artifacts/authorized-user-submit/<file>
```

Unauthorized denied:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id unauthorized-user-denied \
  --status pass \
  --source manual-client \
  --operator <operator> \
  --summary "Unauthorized DingTalk-bound user was blocked and no record was inserted." \
  --artifact artifacts/unauthorized-user-denied/<file> \
  --submit-blocked \
  --record-insert-delta 0 \
  --blocked-reason "<visible denial reason>"
```

No-email admin create-and-bind:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id no-email-user-create-bind \
  --status pass \
  --source manual-admin \
  --operator <operator> \
  --summary "Admin created and bound a no-email DingTalk-synced local user; temporary password is redacted." \
  --artifact artifacts/no-email-user-create-bind/admin-create-bind-result.png \
  --artifact artifacts/no-email-user-create-bind/account-linked-after-refresh.png
```

## Finalization

- [ ] Run final strict compile:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --finalize output/dingtalk-p4-remote-smoke-session/142-session
```

- [ ] Confirm:
  - `session-summary.json` has `sessionPhase: "finalize"`
  - `overallStatus: "pass"`
  - `finalStrictStatus: "pass"`
  - no pending checks
  - `smoke-todo.md` shows all checks complete

## Final Handoff

- [ ] Export and validate final packet:

```bash
node scripts/ops/dingtalk-p4-final-handoff.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --output-dir artifacts/dingtalk-staging-evidence-packet/142-final
```

- [ ] Confirm:
  - `handoff-summary.json` has `status: "pass"`
  - publish check status is `pass`
  - no secret findings

- [ ] Run release-ready gate:

```bash
node scripts/ops/dingtalk-p4-smoke-status.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --handoff-summary artifacts/dingtalk-staging-evidence-packet/142-final/handoff-summary.json \
  --require-release-ready
```

## Local Regression Gates

- [x] Add one-command local regression gate with redacted JSON/MD reports:

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs \
  --profile ops \
  --output-dir output/dingtalk-p4-regression-gate/142-ops
```

- [ ] Run the ops profile before final remote smoke.
- [ ] Attach or reference `output/dingtalk-p4-regression-gate/142-ops/summary.json` and `summary.md` in final verification notes.

## Product Regression Gates

- [ ] Run the product profile when dependency/runtime state is ready:

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs \
  --profile product \
  --output-dir output/dingtalk-p4-regression-gate/142-product
```

- [ ] Confirm `summary.json` has `overallStatus: "pass"`.
- [ ] Review per-check logs under `logs/` if any product gate fails.

## Final Documentation Outputs

- [x] Add a gated final documentation generator:

```bash
node scripts/ops/dingtalk-p4-final-docs.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --handoff-summary artifacts/dingtalk-staging-evidence-packet/142-final/handoff-summary.json \
  --require-release-ready \
  --output-dir docs/development
```

- [ ] Create `docs/development/dingtalk-final-remote-smoke-development-20260423.md`
- [ ] Create `docs/development/dingtalk-final-remote-smoke-verification-20260423.md`
- [ ] Include remote smoke session path, final packet path, commands run, pass/fail status, and residual risks.
- [ ] Do not include secrets, tokens, full webhooks, temporary passwords, cookies, or raw public form tokens.

## Assumptions

- No additional product capability is planned for this phase beyond form-level DingTalk authorization.
- Row, column, and cell-level assigned filling stays out of scope.
- Claude Code CLI remains read-only review only.
- Existing `node_modules` dirty files are unrelated and must not be staged or reverted.
- Real admin tokens and DingTalk webhooks are supplied out-of-band and never written into tracked docs.
