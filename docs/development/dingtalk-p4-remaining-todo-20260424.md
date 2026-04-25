# DingTalk P4 Remaining TODO

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Verified base commit: `07119e52c`
- Goal: finish DingTalk P4 remote-smoke evidence, final handoff, and release-ready docs
- Estimated remaining work: 10%-15% code fixes if real smoke exposes defects, 70%-80% remote verification and evidence collection, 10% final docs and PR closeout

## Current State

- Product and local P4 tooling are implemented on the current branch.
- `remoteSmokePhase` is available in compiled evidence, smoke status/TODO, smoke session summaries, release readiness, final docs, and packet metadata.
- Current open work is the real 142/staging remote-smoke execution and evidence closeout.
- The current sandbox blocks local fake API tests that listen on `127.0.0.1`; run the full P4 regression in an environment that allows local loopback listening.

## Latest Local Readiness Snapshot

- Date: 2026-04-24
- Verified base commit: `07119e52c`
- Worktree was clean before this local readiness slice.
- Static P4 ops script checks passed for 8 scripts.
- Sandbox-safe P4 tests passed: 27/27, 37/37, and 25/25.
- Full P4 regression was not run in this sandbox because fake API tests require local listening on `127.0.0.1`.
- Real 142/staging smoke was not run; it still requires private environment inputs and DingTalk operator access.

## 1. Local Tooling Readiness

- [x] Confirm the worktree is clean with `git status --short`.
- [x] Confirm the PR branch contains at least commit `33a0ed517`.
- [x] Run static checks for all P4 ops scripts:

```bash
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
node --check scripts/ops/dingtalk-p4-smoke-status.mjs
node --check scripts/ops/dingtalk-p4-smoke-session.mjs
node --check scripts/ops/dingtalk-p4-evidence-record.mjs
node --check scripts/ops/export-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/validate-dingtalk-staging-evidence-packet.mjs
node --check scripts/ops/dingtalk-p4-release-readiness.mjs
node --check scripts/ops/dingtalk-p4-final-docs.mjs
git diff --check
```

- [x] Run sandbox-safe P4 tests:

```bash
node --test scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/dingtalk-p4-smoke-status.test.mjs
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs scripts/ops/dingtalk-p4-release-readiness.test.mjs scripts/ops/dingtalk-p4-final-docs.test.mjs
node --test scripts/ops/dingtalk-p4-evidence-record.test.mjs
```

- [ ] Run full P4 regression outside the current sandbox or in another environment that permits local fake API servers on `127.0.0.1`.
- [ ] If full P4 regression fails for reasons other than local-listen sandbox limits, capture the failing test names and fix those defects before remote smoke.

## 2. 142/Staging Input Readiness

- [ ] Prepare `output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env` from the env template.
- [ ] Fill `DINGTALK_P4_API_BASE` for 142/staging.
- [ ] Fill `DINGTALK_P4_WEB_BASE` for the user-facing web origin.
- [ ] Fill `DINGTALK_P4_AUTH_TOKEN` with an authorized admin/API token.
- [ ] Fill two DingTalk group robot webhook URLs.
- [ ] Fill optional robot `SEC...` secrets if the robots require signing.
- [ ] Fill `DINGTALK_P4_ALLOWED_USER_IDS`.
- [ ] Fill `DINGTALK_P4_PERSON_USER_IDS`.
- [ ] Fill `DINGTALK_P4_AUTHORIZED_USER_ID`.
- [ ] Fill `DINGTALK_P4_UNAUTHORIZED_USER_ID`.
- [ ] Fill `DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID`.
- [ ] Confirm the env file is private and is not committed.
- [ ] Run P4 env/bootstrap readiness checks before calling staging or DingTalk.

## 3. Remote Smoke Bootstrap

- [ ] Start the smoke session:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --require-manual-targets \
  --output-dir output/dingtalk-p4-remote-smoke-session/142-session
```

- [ ] Confirm generated files exist:

```text
output/dingtalk-p4-remote-smoke-session/142-session/preflight/preflight-summary.json
output/dingtalk-p4-remote-smoke-session/142-session/workspace/evidence.json
output/dingtalk-p4-remote-smoke-session/142-session/workspace/manual-evidence-checklist.md
output/dingtalk-p4-remote-smoke-session/142-session/compiled/summary.json
output/dingtalk-p4-remote-smoke-session/142-session/session-summary.json
output/dingtalk-p4-remote-smoke-session/142-session/smoke-status.json
output/dingtalk-p4-remote-smoke-session/142-session/smoke-status.md
output/dingtalk-p4-remote-smoke-session/142-session/smoke-todo.md
```

- [ ] Confirm `smoke-status.json.remoteSmokePhase` is not `fail`.
- [ ] Confirm API/bootstrap evidence covers table creation, form view creation, two DingTalk group bindings, `dingtalk_granted` access, and delivery-history bootstrap rows.
- [ ] If bootstrap fails, inspect `preflight-summary.md`, `session-summary.md`, and `smoke-status.md` before changing code.

## 4. Manual DingTalk Evidence

- [ ] Use `smoke-todo.md` as the source of truth for the next manual action.
- [ ] Capture the real DingTalk group message with the form link.
- [ ] Verify the authorized DingTalk-bound user can open the form and submit one record.
- [ ] Verify the unauthorized DingTalk-bound user is blocked and the record insert delta is zero.
- [ ] Verify group and person delivery history.
- [ ] Verify a no-email DingTalk-synced local user can be created and bound by an administrator.
- [ ] Store all screenshots or proof files under `workspace/artifacts/<check-id>/`.
- [ ] Record evidence through `dingtalk-p4-evidence-record.mjs`; do not hand-edit `workspace/evidence.json`.

Example authorized-user command:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id authorized-user-submit \
  --status pass \
  --source manual-client \
  --operator qa \
  --summary "Allowed DingTalk-bound user opened the group link and submitted one record." \
  --artifact artifacts/authorized-user-submit/authorized-submit.png
```

Example unauthorized-user command:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id unauthorized-user-denied \
  --status pass \
  --source manual-client \
  --operator qa \
  --summary "Unauthorized DingTalk-bound user was blocked and no record was inserted." \
  --artifact artifacts/unauthorized-user-denied/unauthorized-denied.png \
  --submit-blocked \
  --record-insert-delta 0 \
  --blocked-reason "Visible error showed the user is not in the allowlist."
```

Example no-email admin command:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id no-email-user-create-bind \
  --status pass \
  --source manual-admin \
  --operator qa-admin \
  --summary "Admin created and bound a no-email DingTalk-synced local user; temporary password is redacted." \
  --artifact artifacts/no-email-user-create-bind/admin-create-bind-result.png \
  --artifact artifacts/no-email-user-create-bind/account-linked-after-refresh.png \
  --admin-email-was-blank \
  --admin-created-local-user-id <local-user-id> \
  --admin-bound-dingtalk-external-id <dingtalk-external-id> \
  --admin-account-linked-after-refresh
```

## 5. Finalize And Handoff

- [ ] Re-run smoke status after manual evidence updates:

```bash
node scripts/ops/dingtalk-p4-smoke-status.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session
```

- [ ] Confirm `remoteSmokePhase` is `finalize_pending`.
- [ ] Run final strict compile:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --finalize output/dingtalk-p4-remote-smoke-session/142-session
```

- [ ] Confirm `compiled/summary.json` has `overallStatus: "pass"`, `apiBootstrapStatus: "pass"`, `remoteClientStatus: "pass"`, and `remoteSmokePhase: "finalize_pending"`.
- [ ] Run final closeout:

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --docs-output-dir docs/development \
  --date 20260424
```

- [ ] Confirm `smoke-status.json.overallStatus` reaches `release_ready` when run with the final handoff summary.
- [ ] Confirm packet validator writes a passing `publish-check.json`.
- [ ] Confirm final generated docs exist and contain no raw secrets.

## 6. Bug Fix Policy

- [ ] If API/bootstrap fails due to tooling assumptions, fix only the affected runner/preflight/session path and add a regression test.
- [ ] If strict evidence rejects valid manual evidence, adjust the narrow evidence contract and add a regression test.
- [ ] If final packet/handoff rejects a valid finalized session, fix exporter/validator metadata compatibility and add a regression test.
- [ ] If product behavior fails, fix backend guard/data-flow first, then UI or documentation.
- [ ] Every code change after remote smoke must include paired development and verification MD.

## 7. Final Deliverables

- [ ] Create `docs/development/dingtalk-p4-final-remote-smoke-development-20260424.md`.
- [ ] Create `docs/development/dingtalk-p4-final-remote-smoke-verification-20260424.md`.
- [ ] Include final branch, commit, session directory, packet directory, completed checks, code changes, residual risks, and exact verification commands.
- [ ] Comment the PR with command results, pass/fail counts, known limitations, and artifact paths.
- [ ] Keep all raw credentials and raw webhook URLs out of repo-tracked files and PR comments.
