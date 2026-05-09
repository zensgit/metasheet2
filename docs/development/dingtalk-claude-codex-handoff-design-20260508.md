# DingTalk Agent ID — Claude / Codex Handoff Design

Date: 2026-05-08

## Background

PR #1430 ports the DingTalk work-notification Agent ID admin configuration onto
`origin/main` so the 142 production deployment can build an image that exposes
status / test / save endpoints plus the directory-management Agent ID UI.

State at handoff time:

- Branch: `codex/dingtalk-agent-id-mainline-20260508`.
- PR #1430 runtime/code verification point:
  `826242b5adb89c87b4e03d502a3905e4b270e43a` (rebased onto latest
  `origin/main`). The PR may contain later docs-only commits; those do
  not change the runtime code verified at this point.
- PR #1430 base: `20fb5270a09d4cc3d2c98e84db3601fc3f4231c5`.
- All non-review CI checks on PR #1430 are green. The merge is BLOCKED
  only by `REVIEW_REQUIRED` (human approval policy), not by any failing
  technical check.
- 142 currently runs the auto-deployed main tag
  `20fb5270a09d4cc3d2c98e84db3601fc3f4231c5` for both
  `metasheet-backend` and `metasheet-web`.
- 142 backend health: `200`.
- 142 frontend root: `200`.
- The Agent ID runtime tag `245701aeb5afc57ae5a5932cc4f58ef3aef3a973`
  that was previously verified on 142 has been overwritten by the
  automatic `main` deployment. Repeated manual container switches back
  onto a feature tag are **not** recommended at this point — they will
  keep being overwritten by the next `main` auto-deploy and only churn
  the runtime.
- The private Agent ID file on 142 still exists but is empty, so
  real-send DingTalk work-notification acceptance is still pending.
- Forward path: merge PR #1430 into `main` first, let 142 auto-deploy
  the new `main` image (which will include the Agent ID feature
  commits), then run the real Agent ID save and real-send acceptance
  on that auto-deployed image — not on a manually switched tag.

This document defines the division of labor between Claude (in-repo agent) and
Codex (release / verification agent) for the remaining work.

## Why the split exists

Two constraints drive the split:

1. **Secret boundary.** Real DingTalk Agent ID, admin JWTs, recipient user
   ids, and webhook URLs must never enter the repository, the chat transcript,
   or any AI-readable file. Only Codex, running in the operator environment,
   may read or write those values.
2. **Runtime boundary.** Only Codex has direct access to the 142 host, the
   GHCR registry tag list, the `.secrets/` directory, and the manual
   container-switch workflow. Claude must stay confined to the working tree.

## Division of labor

### Claude scope (allowed)

Claude is allowed to perform bounded, redaction-safe, repo-local work:

- Author or revise design / verification / runbook Markdown under `docs/`.
- Edit non-secret backend or frontend source files when given a specific
  diff intent (e.g., add a validation rule, fix a typo, adjust a test
  assertion) — and only after the user explicitly asks for code changes.
- Update or extend unit tests that already exist in the tree, as long as
  they do not require real DingTalk credentials.
- Summarize public PR / CI / git state from text the user pastes in.
- Produce status checklists, stop-condition lists, rollback notes, and
  changelog entries that reference only redaction-safe identifiers
  (image SHAs, run URLs, route paths, exit codes, structured status JSON
  with `agentIdValuePrinted=false`).

For this specific handoff, Claude is restricted to editing only:

- `docs/development/dingtalk-claude-codex-handoff-design-20260508.md`
- `docs/development/dingtalk-claude-codex-handoff-verification-20260508.md`

### Claude scope (forbidden)

Claude must not:

- Read `.env`, `.env.*`, `.secrets/**`, token files, webhook files, or any
  file whose name or path implies it stores credentials.
- Print, paste, echo, or log values that look like an Agent ID, admin JWT,
  DingTalk robot secret, robot webhook URL, or recipient user id list.
- Modify backend or frontend source files as part of this handoff task —
  this handoff is documentation only.
- Run any command that would touch 142, GHCR, the manual container switch,
  or the real DingTalk send API.
- Speculate about secret values or reconstruct them from context.

### Codex scope (allowed and required)

Codex is the only agent permitted to:

- Read `/home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt` and any
  related private recipient files.
- Generate, hold, and rotate the admin JWT used by the helper scripts.
- Run `pnpm install`, `pnpm build`, targeted `vitest`, and `node --test`
  jobs in the trusted build environment (locally or in CI).
- Trigger and inspect the GHCR `Build and Push Docker Images` workflow.
- Execute the manual 142 container switch for `metasheet-backend` and
  `metasheet-web`, including rollback to the prior baseline. At this
  stage of the loop, manual switches should be reserved for rollback
  only — forward switches onto pre-merge feature tags will be
  overwritten by the next `main` auto-deploy and are no longer the
  preferred path to acceptance.
- Run `scripts/ops/dingtalk-work-notification-admin-agent-id.mjs` against
  127.0.0.1 on 142 with the real auth token file and Agent ID file.
- Drive the real-send DingTalk work-notification acceptance using the
  recipient user id file, observe delivery, and record only the
  redaction-safe status payload.
- Update PR #1430 description, request reviews, and resolve the merge
  policy block once acceptance is green.

### Shared / handoff artifacts

Both sides write or consume these artifacts, but only in the redaction-safe
shape described below:

- `status.json` and `status.md` produced by the admin helper. Claude may
  read and quote fields such as `configured`, `available`,
  `unavailableReason`, `source`, `agentIdLength`, and
  `agentIdValuePrinted` — but never the Agent ID itself.
- PR #1430 metadata: number, head SHA, base SHA, check names, run URLs,
  merge state.
- Image tags: GHCR digests / commit SHAs are public identifiers and may be
  written to docs.
- 142 health output: `{"ok":true,"status":"ok",...}` is non-secret.

## Workflow loop

1. Codex performs a runtime / acceptance step on 142 or in CI.
2. Codex captures the redaction-safe outputs (status JSON, exit codes,
   image tag, run URL).
3. Codex relays those outputs to the operator or pastes them into the
   conversation.
4. Claude updates `docs/development/...` Markdown, checklists, or PR notes
   based only on those pasted outputs.
5. Operator reviews the Markdown, then asks Codex to drive the next
   runtime step.

The loop terminates when the verification doc's stop conditions are all
green and PR #1430 is merged into `main`.

## Risk / failure handling

- If a helper exits non-zero with `AGENT_ID_FILE_EMPTY`, that is the
  current expected blocker and is not a regression. Codex fills the
  private file and re-runs `--save`.
- If the helper exits non-zero with `STATUS_API_FAILED` and `httpStatus`
  is `404`, the deployed image does not contain the Agent ID API. Codex
  must rebuild / redeploy from a branch that includes the feature.
- If the helper exits non-zero with `httpStatus: 401`, the admin JWT is
  missing or expired. Codex refreshes the token; Claude does not see it.
- If the secret scan in CI fails, Claude inspects only the file paths and
  line numbers reported by the scanner — never the matched values — and
  proposes a redaction patch.
- If 142 disk fills again, Codex repeats the bounded GHCR backend/web tag
  cleanup that preserves running images plus the current and rollback
  baselines, and never touches Postgres / Redis / uploads.

## Out of scope for this handoff

- Group-failure-alert rollout.
- Multitable Feishu / field-type work.
- Integration-core changes.
- Any change to the K3 PoC stage-1 lock.
- Any code modification on the Agent ID branch as part of this
  documentation handoff.
