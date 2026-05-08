# DingTalk Final Closeout — Execution Design

- Date: 2026-05-08 / 2026-05-09 operator update
- Branch: `codex/dingtalk-final-closeout-20260508` (PR #1443)
- Reference PR head after operator rebase and before this execution-package
  doc-only update: `ca5ea87dc08a9146d678ea6e8281d2af73a011a8`
- Base used for the operator rebase: `origin/main=c74c15a2b`
- Current 142 deployed image observed by Claude evidence: `08c6036284bf975dc1396c752d07f44486c7d4b2`
- Delivery verdict at this checkpoint: **NOT DELIVERABLE — merge blocked**

## Purpose

This execution design records how the DingTalk closeout moves from a green PR
to a production-verified delivery without mixing responsibilities, leaking
secrets, or bypassing repository review rules.

The closeout package is intentionally split into two layers:

- Closeout package updates:
  `dingtalk-final-closeout-development-20260508.md` and
  `dingtalk-final-closeout-verification-20260508.md` capture the product
  state, blocker matrix, and acceptance checklist.
- Execution package updates:
  this document and `dingtalk-final-closeout-execution-verification-20260508.md`
  capture the operator boundary, ownership split, post-merge runbook,
  rollback plan, and this run's evidence ledger.

## Current Boundary

PR #1443 is ready for human review from a code and CI perspective, but it is
not a deployable delivery yet because the failure-alert runtime path is not
merged into `main` and therefore is not deployed on 142.

The final closeout may only move from **NOT DELIVERABLE** to **CLOSED** after:

1. a human reviewer approves PR #1443;
2. PR #1443 is squash-merged into `main`;
3. 142 deploys the resulting immutable GHCR image tag;
4. Codex performs the live post-merge acceptance checklist on 142;
5. the final evidence packet and secret scan pass.

## Ownership Split

### Codex Owns

- Updating the PR branch under explicit user direction.
- Running local code verification, branch secret scans, and PR diff checks.
- Rebasing the PR branch onto current `origin/main` when needed.
- Verifying GitHub CI after push.
- After merge, independently validating 142 image tags, health, admin API,
  DingTalk work notification, group robot delivery, public form modes, and
  failure-alert audit behavior.
- Recording only redaction-safe evidence in repository docs.

### Human Reviewer Owns

- Reviewing the PR diff.
- Approving PR #1443.
- Deciding whether to squash-merge.
- Confirming any production-risk acceptance when live fault injection is run.

### Claude Owns

- Drafting and refining the closeout / execution markdown package.
- Producing operator-readable evidence summaries from redaction-safe probes.
- Stating blockers and boundaries.
- Not merging, not approving, not handling private credentials in chat.

## Hard Rules

- Do not print or commit real DingTalk webhook URLs, robot `SEC...` values,
  JWTs, bearer tokens, app secrets, Agent ID values, recipient user ids, or
  temporary passwords.
- Private values must remain in private files or environment variables outside
  git.
- Do not bypass human review or repository branch protection.
- Do not hot-patch 142 as a delivery substitute; production delivery must use
  the post-merge GHCR image tag.
- Do not change K3, ERP, Feishu, unrelated multitable, or plugin surfaces in
  this closeout.
- Do not leave any intentionally broken DingTalk destination after failure
  injection; rollback the test fault immediately.

## Post-Merge Execution Sequence

Run these steps only after PR #1443 is approved and squash-merged.

1. Record the merged `main` SHA and old 142 backend/web image tags.
2. Wait for GHCR image build and 142 auto-deploy to complete.
3. Verify `metasheet-backend` and `metasheet-web` image tags equal the merged
   `main` SHA.
4. Verify 142 health: backend `/api/health=200`, web `/=200`, and expected
   unauthenticated admin/auth probes return `401`.
5. Validate the admin token through `/api/auth/me` using a private token file;
   do not print the token.
6. Run `dingtalk-work-notification-admin-agent-id.mjs --save` using the
   private Agent ID file and verify redaction flags show no value printed.
7. Run the same helper with `--recipient-user-id-file` and verify real
   DingTalk work notification delivery succeeds.
8. Re-run A/B DingTalk group robot `test-send` and confirm delivery rows show
   success for both groups.
9. Run `dingtalk-p4-release-readiness.mjs --run-smoke-session` against the
   post-merge 142 session.
10. Run `dingtalk-p4-final-closeout.mjs` and confirm the generated summary has
    `overallStatus=pass`, `finalStrictStatus=pass`, and no pending checks.
11. Run the failure-alert injection regression: force one controlled group
    send failure, confirm group delivery failure row, person delivery
    `failureAlert` row, rule-creator work notification, then restore the
    destination and run the final secret scan over generated evidence.

## Rollback Strategy

Rollback is image-level unless a deployment script explicitly introduces a
schema migration. The current PR changes backend runtime code and docs only;
it does not add a migration.

1. Before deployment, record old backend and web GHCR image tags.
2. If post-merge health fails or the app cannot serve forms, set backend/web
   tags back to the recorded old values and restart only those services.
3. Recheck backend `/api/health`, web `/`, and `/api/auth/me`.
4. If DingTalk delivery fails but core app health remains good, keep the app
   up, disable the affected automation/destination, and preserve delivery
   rows for diagnosis.
5. If failure injection modified any destination state, restore the original
   destination configuration immediately.
6. Record rollback evidence without printing secrets.

## Delivery Decision Logic

- **CLOSED**: PR #1443 merged, 142 runs the post-merge SHA, all blocker rows in
  the verification matrix pass, and final evidence secret scan is clean.
- **TRIAL ONLY**: code and CI pass, but one live DingTalk or public form
  acceptance row remains pending with a documented non-production workaround.
- **NOT DELIVERABLE**: PR is not merged, 142 does not run the post-merge SHA,
  a blocker row fails, or any real secret appears in git / PR / docs / chat.

Current decision: **NOT DELIVERABLE** because PR #1443 remains open and
requires human review before merge.
