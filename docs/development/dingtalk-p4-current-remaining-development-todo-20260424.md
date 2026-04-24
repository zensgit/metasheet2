# DingTalk P4 Current Remaining Development TODO

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Baseline commit: `30a6ee05d`
- Goal: finish DingTalk P4 by converting the remaining external smoke work into release-ready evidence and final handoff docs
- Current answer: code development remaining is low and conditional; verification, evidence, and handoff remain the dominant work

## Remaining Volume

- Code implementation left: 0%-15%, only if the real 142/staging smoke exposes product or tooling defects.
- External verification left: 70%-80%, including private env setup, real DingTalk group/person sends, manual client checks, and admin no-email binding proof.
- Finalization and PR closeout left: 10%-15%, including strict compile, final packet export, publish validation, final docs, and PR summary.
- If 142/staging inputs are ready and remote smoke passes, the remaining work is mainly one operator smoke session plus closeout.
- If remote smoke fails, estimate one to three focused fix/verify cycles depending on whether the failure is product behavior, smoke tooling, data setup, or environment access.

## Completion Boundary

- `smoke-status.json.remoteSmokePhase` reaches a final-ready state after all manual evidence is recorded.
- `smoke-status.json.overallStatus` reaches `release_ready` after final handoff and publish validation.
- Final packet validation passes without raw secrets or stale evidence.
- Final development and verification Markdown are generated for the real 142/staging run.
- PR is updated with final commands, pass/fail counts, artifact paths, and residual risks.

## P0 Already Completed Locally

- [x] Product and P4 smoke tooling are implemented on the branch.
- [x] `remoteSmokePhase` contract is present across compiled evidence, status/TODO, session summary, release readiness, final docs, and packet metadata.
- [x] Local static checks passed for 8 P4 ops scripts.
- [x] Sandbox-safe P4 tests passed: 27/27, 37/37, and 25/25.
- [x] Repo-tracked baseline TODO exists at `docs/development/dingtalk-p4-remaining-todo-20260424.md`.
- [x] P4 smoke/session/regression/readiness output directories are gitignored to reduce the risk of committing private env or evidence artifacts.

## P1 Private 142/Staging Input Readiness

- [x] Create a private env file from the smoke-session template; keep it outside git-tracked docs and PR comments.
- [ ] Fill `DINGTALK_P4_API_BASE` with the 142/staging API base.
- [ ] Fill `DINGTALK_P4_WEB_BASE` with the reachable web origin used by DingTalk message links.
- [x] Fill `DINGTALK_P4_AUTH_TOKEN` with an authorized admin/API token from the approved private secret path.
- [ ] Fill two real DingTalk group robot webhook URLs.
- [ ] Fill optional DingTalk robot `SEC...` secrets if the robots require signing.
- [x] Fill allowed local user IDs and person delivery target IDs.
- [x] Fill the authorized DingTalk manual validation target.
- [ ] Fill the unauthorized DingTalk manual validation target.
- [ ] Fill the no-email DingTalk manual validation target.
- [x] Confirm the env file permission is private and no secret values appear in tracked files.

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --init-env-template output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env
```

Latest local prep result:

- Env template path: `output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env`.
- File mode: `0600`.
- Git status: output path is ignored and not staged.
- Admin token source: `/tmp/metasheet-main-admin-6h.jwt`, validated by `/api/auth/me` without printing token contents.
- Token readiness result: `authTokenPresent: true`.
- Readiness still fails, as expected, until private webhooks, allowlist/person inputs, and manual targets are filled.
- Remaining failed readiness checks: `dingtalk_p4_group_a_webhook`, `group-a-webhook-shape`, `dingtalk_p4_group_b_webhook`, `group-b-webhook-shape`, `allowlist-present`, `person-smoke-input`, `manual-targets-declared`.

Latest user-target readiness result:

- 142 currently has one active DingTalk-bound and DingTalk-granted local user candidate.
- Filled that user id into `DINGTALK_P4_ALLOWED_USER_IDS`, `DINGTALK_P4_PERSON_USER_IDS`, and `DINGTALK_P4_AUTHORIZED_USER_ID`.
- Readiness now reports `allowedUserCount: 1`, `personUserCount: 1`, and an authorized manual target.
- Remaining failed readiness checks: `dingtalk_p4_group_a_webhook`, `group-a-webhook-shape`, `dingtalk_p4_group_b_webhook`, `group-b-webhook-shape`, `manual-targets-declared`.
- 142 did not have a second DingTalk-bound local user or a no-email DingTalk external identity available in the queried data, so unauthorized/no-email targets remain manual setup blockers.

## P2 Non-Sandbox Regression Gate

- [x] Generate the all-profile regression plan-only output so the non-sandbox command list is fixed before final smoke.
- [ ] Run the P4 regression gate in an environment that permits fake API servers on `127.0.0.1`.
- [ ] Use `--profile all` before final smoke if the environment can run backend and frontend checks.
- [ ] If the regression fails only because of sandbox local-listen limits, do not treat it as a product blocker.
- [ ] If the regression fails for product or tooling reasons, fix that narrow defect and add or update the relevant regression test.

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs \
  --profile all \
  --output-dir output/dingtalk-p4-regression-gate/142-final \
  --timeout-ms 120000
```

Latest local prep result:

- Plan-only output path: `output/dingtalk-p4-regression-gate/142-final-plan/summary.json`.
- Planned profile: `all`.
- Planned checks: 23.
- Execution status: `plan_only`; no product or fake API server tests were run in this sandbox.

## P3 Release Readiness And Remote Smoke Bootstrap

- [ ] Run release readiness with the private env file.
- [ ] If readiness passes, start the smoke session from the same command or run smoke-session directly.
- [ ] Confirm preflight, workspace evidence, compiled summary, session summary, smoke status, and smoke TODO files are generated.
- [ ] Confirm API/bootstrap evidence covers table creation, form view creation, two DingTalk group bindings, `dingtalk_granted` access, and delivery-history bootstrap rows.

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --regression-profile all \
  --run-smoke-session \
  --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --timeout-ms 120000
```

## P4 Manual DingTalk Evidence

- [ ] Use generated `smoke-todo.md` as the source of truth for manual steps.
- [ ] Capture real DingTalk group message evidence with a form link.
- [ ] Verify authorized DingTalk-bound user open and submit.
- [ ] Verify unauthorized DingTalk-bound user is blocked and record insert delta is zero.
- [ ] Verify group and person delivery history.
- [ ] Verify no-email DingTalk-synced user can be created and bound by an admin.
- [ ] Store proof files under `workspace/artifacts/<check-id>/`.
- [ ] Record evidence only through `dingtalk-p4-evidence-record.mjs`.

```bash
node scripts/ops/dingtalk-p4-smoke-status.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session
```

## P5 Conditional Code Fix Lane

- [ ] If API bootstrap fails due to runner assumptions, fix the smoke runner or preflight path and add a script test.
- [ ] If product access or submit behavior fails, fix backend guard or frontend form flow first, then add integration or UI tests.
- [ ] If delivery history is wrong, fix delivery service or route serialization and add route/service tests.
- [ ] If no-email binding fails, fix directory/admin binding flow and add targeted backend tests.
- [ ] If evidence tooling rejects valid proof, narrow the evidence contract fix and add an ops script test.
- [ ] For every code fix, add paired development and verification Markdown before final closeout.

## P6 Finalize And Closeout

- [ ] Re-run smoke status after each evidence update until no required manual checks remain.
- [ ] Run strict finalize for the completed smoke session.
- [ ] Run final closeout to export, validate, gate release readiness, and generate final docs.
- [ ] Confirm generated final docs contain no raw tokens, robot webhook URLs, `SEC...` secrets, public form tokens, or temporary passwords.

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --docs-output-dir docs/development \
  --date 20260424
```

## P7 PR Handoff

- [ ] Confirm final generated development and verification MD names.
- [ ] Confirm final packet path and publish-check path.
- [ ] Comment the PR with exact commands, pass/fail counts, artifact paths, and known limitations.
- [ ] Keep raw credentials out of git history, docs, generated packets, and PR comments.
- [ ] Mark the remaining remote-smoke checklist complete only after real evidence is available.

## Parallel Execution Plan

- Lane A: prepare private 142/staging env, token source, robot webhooks, and DingTalk validation users.
- Lane B: run non-sandbox P4 regression gate and fix only reproducible product/tooling failures.
- Lane C: prepare manual operators, browser/DingTalk clients, screenshot paths, and evidence naming.
- Lane D: keep closeout paths, final docs paths, and PR summary template ready.
- Sequencing constraint: the real smoke session must wait for env readiness and should not be marked complete until manual evidence is recorded and strict closeout passes.
