# DingTalk Final Development Plan And TODO

- Date: 2026-04-23
- Goal: finish DingTalk group/person/form-access workflow through remote smoke and release evidence handoff
- Current base branch: `codex/dingtalk-next-slice-20260423` from `origin/main`
- Current base commit: `8d2d3e1b0`
- Remaining work type: private remote-smoke inputs, remote smoke execution, evidence collection, final handoff, and final verification notes

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
- [x] Evidence recorder auto-refresh for smoke status/TODO and optional auto-finalize handoff
- [x] Final closeout wrapper for strict finalize, final handoff, release-ready gate, and final remote-smoke docs

## PR Stack To Confirm

- [x] Confirm #1104 merged: unauthorized denial evidence contract
- [x] Confirm #1105 merged: remote smoke TODO export
- [x] Confirm #1106 merged: session status autorefresh
- [x] Confirm #1107 merged: no-email admin evidence helper
- [x] Confirm #1118 merged: organization-scoped DingTalk group destination catalog v1
- [x] Merge or promote the stack in order after earlier base PRs are merged
- [x] Re-run targeted local checks after promotion to `origin/main`: `node scripts/ops/dingtalk-p4-regression-gate.mjs --profile ops --output-dir output/dingtalk-p4-regression-gate/142-ops --fail-fast`

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

- [x] Create the canonical private env file with `0600` permissions:

```bash
node scripts/ops/dingtalk-p4-env-bootstrap.mjs --init
```

- Canonical env file: `$HOME/.config/yuantus/dingtalk-p4-staging.env`
- The private env is intentionally untracked and is written with `0600` permissions.
- [x] Add a safe setter for the canonical private env:

```bash
node scripts/ops/dingtalk-p4-env-bootstrap.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --set-from-env DINGTALK_P4_AUTH_TOKEN
```

- [ ] Fill the private env outside git with the real staging/admin and DingTalk values.
- [x] Add a one-command release-readiness + smoke-session handoff:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --regression-profile ops \
  --run-smoke-session \
  --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-session
```

- This should only start the session when env readiness and local regression both pass.
- When the smoke session starts successfully, release-readiness may still return/report `manual_pending` because the API bootstrap can pass while DingTalk-client/admin evidence remains outstanding.
- [ ] Run the real command above with populated private values.
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
- [x] Recorder updates with `--session-dir` now refresh `smoke-status.json`, `smoke-status.md`, and `smoke-todo.md` automatically.
- [x] The final manual evidence update can use `--finalize-when-ready` to auto-attempt strict finalize when no required checks remain.
- [x] The final manual evidence update can use `--closeout-when-ready` to auto-run final closeout when no required checks remain.

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
  --artifact artifacts/no-email-user-create-bind/account-linked-after-refresh.png \
  --closeout-when-ready \
  --closeout-packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --closeout-docs-output-dir docs/development \
  --closeout-date 20260423
```

- `--finalize-when-ready` should be used only on the update that is expected to complete the remaining manual evidence. It refreshes smoke status first and only runs strict finalize when the session has actually reached `finalize_pending`.
- `--closeout-when-ready` is the faster final path for the last manual evidence update. It refreshes smoke status first and only runs final closeout when the session has actually reached `finalize_pending`.
- Do not combine `--finalize-when-ready` and `--closeout-when-ready`; use the former for targeted debugging and the latter for the normal final handoff chain.

## Finalization

- [x] Add one-command final closeout wrapper:

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --docs-output-dir docs/development \
  --date 20260423
```

- The closeout wrapper runs strict finalize, final handoff, release-ready status, and final remote-smoke docs generation in order.
- [ ] Run the closeout wrapper against the real 142/staging session after all manual evidence is recorded.
- [ ] Confirm generated closeout files:
  - `artifacts/dingtalk-staging-evidence-packet/142-final/closeout-summary.json`
  - `artifacts/dingtalk-staging-evidence-packet/142-final/closeout-summary.md`

- [ ] If debugging finalization separately, run final strict compile:

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

- [ ] Export and validate final packet, either through `dingtalk-p4-final-closeout.mjs` above or directly:

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

- [ ] Generate final remote-smoke development and verification docs, either through `dingtalk-p4-final-closeout.mjs` or directly:

```bash
node scripts/ops/dingtalk-p4-final-docs.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --handoff-summary artifacts/dingtalk-staging-evidence-packet/142-final/handoff-summary.json \
  --require-release-ready \
  --output-dir docs/development
```

## Local Regression Gates

- [x] Add one-command local regression gate with redacted JSON/MD reports:

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs \
  --profile ops \
  --output-dir output/dingtalk-p4-regression-gate/142-ops
```

- [x] Run the ops profile before final remote smoke.
- [x] Attach or reference `output/dingtalk-p4-regression-gate/142-ops/summary.json` and `summary.md` in final verification notes.
- [x] Run release readiness locally with the generated template and ops profile:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --regression-profile ops \
  --output-dir output/dingtalk-p4-release-readiness/142-local \
  --allow-failures
```

- [x] Add automatic smoke-session handoff after readiness passes:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file "$HOME/.config/yuantus/dingtalk-p4-staging.env" \
  --regression-profile ops \
  --run-smoke-session \
  --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-session
```

- Current readiness status is still `fail` against the real private env until admin token, group A/B webhooks, allowlist, and manual target identities are filled.

## Product Regression Gates

- [x] Run the product profile when dependency/runtime state is ready:

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs \
  --profile product \
  --output-dir output/dingtalk-p4-regression-gate/142-product \
  --fail-fast
```

- [x] Confirm `summary.json` has `overallStatus: "pass"`.
- [x] Review per-check logs under `logs/` if any product gate fails.
- [x] Attach or reference `output/dingtalk-p4-regression-gate/142-product/summary.json` and `summary.md` in final verification notes.

Result: 13 passed, 0 failed, 0 skipped. The product profile covered backend DingTalk automation link routes, public form flow, DingTalk delivery routes, org destination catalog routes, DingTalk group/person services, automation v1 contracts, web DingTalk binding/access/client tests, web automation catalog tests, backend build, and web build.

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
