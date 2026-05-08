# DingTalk Agent ID — Claude / Codex Handoff Verification

Date: 2026-05-08

Companion to:
`docs/development/dingtalk-claude-codex-handoff-design-20260508.md`.

This document is the executable checklist Codex follows to validate the
Claude / Codex split for PR #1430, plus the explicit stop conditions that
end the loop.

All commands and outputs in this checklist are redaction-safe. Real Agent
ID, admin JWT, recipient user ids, and webhook URLs must never be pasted
into this file or its diffs.

## Inputs Codex must already hold

Before starting the checklist, Codex must already have, outside of the
repository:

- An admin JWT token file path (e.g. `/tmp/admin.jwt`).
- The 142 private Agent ID file path
  (`/home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt`).
- Optional recipient user id file for real-send testing.

Claude must not see, request, or echo any of the above.

## Pre-flight identity check

```bash
git rev-parse --abbrev-ref HEAD
git log -1 --oneline
```

Expected:

- Branch is `codex/dingtalk-agent-id-mainline-20260508`.
- HEAD is on PR #1430 branch. The runtime/code verification point
  referenced in the design doc is
  `826242b5adb89c87b4e03d502a3905e4b270e43a`, rebased onto base
  `20fb5270a09d4cc3d2c98e84db3601fc3f4231c5`. Later docs-only commits
  may advance HEAD without changing the verified runtime code.

## Doc-only diff check (Claude side)

```bash
git diff --name-only origin/main..HEAD -- docs/development \
  | rg 'dingtalk-claude-codex-handoff-(design|verification)-20260508\.md$'
```

Expected:

- Both files appear in the doc-only diff.
- No file outside `docs/development/` was modified by Claude in this
  handoff turn.

```bash
git diff --name-only origin/main..HEAD \
  | rg -v '^docs/' \
  | wc -l
```

Expected (for a Claude-only handoff turn):

- `0` non-doc files changed since `origin/main`, except for the existing
  Agent ID feature commits already cherry-picked by Codex.

## Secret-shape scan

Run the repository standard DingTalk/JWT secret-shape scan recorded in
`dingtalk-agent-id-mainline-integration-verification-20260508.md`. Keep the
pattern itself in that canonical verification file so this handoff document
does not introduce additional scanner matches.

Expected:

- No match in the two new handoff Markdown files.
- Existing matches are confined to redactor code, generated URL
  construction, prior docs scan commands, and dummy test fixtures, as
  already recorded in
  `dingtalk-agent-id-mainline-integration-verification-20260508.md`.

If any new match appears inside either handoff doc, **STOP** and revert
that doc to its previous state.

## Static helper / build checks (Codex)

These are reruns from the prior verification doc and must stay green:

```bash
pnpm install --frozen-lockfile --ignore-scripts
node --check scripts/ops/dingtalk-work-notification-admin-agent-id.mjs
node --test scripts/ops/dingtalk-work-notification-admin-agent-id.test.mjs
node --test scripts/ops/dingtalk-work-notification-release-gate.test.mjs
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/dingtalk-work-notification-settings.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync-work-notification-agent-id.test.ts \
  --run
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --run
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

Expected:

- Helper test files: 4 + 5 passing.
- Backend targeted unit tests: 33 passing across 3 files.
- Frontend targeted spec: 38 passing in 1 file.
- Backend build: pass.
- Frontend build: pass (only existing chunk-size warnings).
- Whitespace check: pass.

## 142 runtime image check (Codex)

```bash
docker ps --format '{{.Names}} {{.Image}}'
curl -fsS http://127.0.0.1:8900/api/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8900/api/admin/directory/dingtalk/work-notification
```

Expected at the current pre-merge handoff point:

- `metasheet-backend` and `metasheet-web` images both end with the
  current auto-deployed `main` tag
  `20fb5270a09d4cc3d2c98e84db3601fc3f4231c5`. The earlier verified
  Agent ID feature tag `245701aeb5afc57ae5a5932cc4f58ef3aef3a973`
  has been overwritten by the automatic `main` deploy and is no
  longer expected on 142.
- Health: `{"ok":true,"status":"ok","success":true,"plugins":13}`.
- Frontend: `200`.
- Unauthenticated admin route: `401` if the deployed `main` already
  ships the Agent ID admin endpoint, or `404` if `main` has not yet
  been advanced past PR #1430. A `404` here is the expected signal
  that the Agent ID save / real-send acceptance must wait for the
  post-merge `main` auto-deploy and must not be forced through a
  manual feature-tag switch.

After PR #1430 is merged and 142 has auto-deployed the new `main`,
re-run the same four commands. The two image tags should advance to
the post-merge `main` commit SHA, health and frontend stay `200`, and
the admin route returns `401` (now confirming the Agent ID feature is
live in `main`).

The Agent ID status / save / real-send helpers below are intended to
run against the post-merge `main` image on 142. Do **not** drive them
by manually switching `metasheet-backend` / `metasheet-web` back onto
a pre-merge feature tag — the next automatic `main` deploy will
overwrite that switch and invalidate any acceptance run captured on
top of it. Merge PR #1430 first, let 142 auto-deploy the new `main`,
then proceed.

## 142 Agent ID status helper (Codex)

```bash
node /tmp/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/admin.jwt \
  --status-only \
  --output-json /tmp/dingtalk-agent/status.json \
  --output-md /tmp/dingtalk-agent/status.md
```

Expected redaction-safe shape:

```json
{
  "status": "pass",
  "statusBefore": {
    "configured": false,
    "available": false,
    "unavailableReason": "missing_agent_id",
    "source": "mixed"
  }
}
```

Pasteable to Claude. The Agent ID value itself must not appear.

## 142 Agent ID save helper (Codex)

```bash
node /tmp/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/admin.jwt \
  --agent-id-file /home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt \
  --save \
  --output-json /tmp/dingtalk-agent/save.json
```

Three possible outcomes:

1. **File still empty** (current state):

   ```json
   {
     "saveExitCode": 1,
     "saveStatus": "blocked",
     "saveFailureCodes": ["AGENT_ID_FILE_EMPTY"],
     "agentFileEmpty": true
   }
   ```

   Action: Codex fills the private file (outside the repo), then reruns.

2. **File filled, save succeeded**:

   ```json
   {
     "saveExitCode": 0,
     "saveStatus": "pass",
     "agentFileEmpty": false,
     "statusAfter": {
       "configured": true,
       "available": true,
       "source": "runtime"
     }
   }
   ```

   Action: proceed to real-send acceptance.

3. **Anything else** (`STATUS_API_FAILED`, `httpStatus: 404` or `401`,
   schema error, etc.):

   Action: **STOP**, do not retry destructively, and report failure mode
   to the operator. Claude updates docs only after Codex resolves the
   underlying cause.

## Optional real-send acceptance (Codex)

Only after outcome 2 above:

```bash
node /tmp/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/admin.jwt \
  --recipient-user-id-file <private-recipient-file> \
  --send-test \
  --output-json /tmp/dingtalk-agent/send.json
```

Expected redaction-safe shape:

```json
{
  "status": "pass",
  "send": {
    "delivered": true,
    "recipientCount": 1,
    "recipientValuePrinted": false
  }
}
```

If `delivered` is not `true`, **STOP** and triage in the DingTalk admin
console — not in the repo.

## PR #1430 readiness check (Codex)

```bash
gh pr view 1430 --json number,headRefOid,baseRefOid,mergeable,mergeStateStatus,statusCheckRollup
```

Expected at the current handoff point:

- `headRefOid` is at or after the runtime/code verification point
  `826242b5adb89c87b4e03d502a3905e4b270e43a`.
- `baseRefOid` is `20fb5270a09d4cc3d2c98e84db3601fc3f4231c5`.
- `mergeable` is `MERGEABLE` (or transiently `UNKNOWN`).
- `mergeStateStatus` is `BLOCKED`, blocked **only** by
  `REVIEW_REQUIRED` from the human review policy. No technical check
  is failing.
- All non-skipped checks are `SUCCESS`.
- The configured strict E2E job may remain `SKIPPED` per workflow policy.

After human review is added and the PR is merged, the post-merge
`main` is what 142 should auto-deploy and what the Agent ID save /
real-send acceptance runs against.

## Stop conditions

The handoff loop ends when **all** of the following are true:

1. Both handoff Markdown files exist under `docs/development/` and have
   passed the secret-shape scan.
2. PR #1430 has all required technical checks green, has cleared the
   `REVIEW_REQUIRED` block via human approval, and is merged into
   `main`.
3. 142 has auto-deployed the post-merge `main` image; both
   `metasheet-backend` and `metasheet-web` advance to that post-merge
   commit SHA without any manual container switch onto a pre-merge
   feature tag.
4. 142 backend health is `200` and frontend root is `200` on the
   post-merge `main` tag.
5. The admin status helper (run on the post-merge image) returns
   `status: "pass"` with `agentIdValuePrinted=false`.
6. The admin save helper returns `status: "pass"` with
   `statusAfter.configured=true` and `statusAfter.available=true`.
7. At least one real-send DingTalk work-notification acceptance has
   recorded `delivered=true` and `recipientValuePrinted=false`, on the
   post-merge `main` image.

The loop must **abort** (not auto-retry) on any of:

- New secret-shape match introduced in `docs/`.
- Helper failure with `STATUS_API_FAILED` and `httpStatus: 404` after a
  redeploy attempt — implies wrong image was rolled out.
- Helper failure with `httpStatus: 401` after a fresh JWT — implies a
  schema or auth regression and needs human triage.
- 142 disk pressure where Postgres / Redis / uploads risk eviction —
  Codex stops and asks the operator before any cleanup.

## Roles summary

| Step                                      | Claude | Codex |
| ----------------------------------------- | :----: | :---: |
| Edit handoff design / verification docs   |   ✓    |       |
| Read `.secrets/`, `.env`, token files     |        |   ✓   |
| Run pnpm install / build / vitest         |        |   ✓   |
| Trigger GHCR build workflow               |        |   ✓   |
| Switch 142 backend / web containers       |        |   ✓   |
| Execute admin Agent ID status helper      |        |   ✓   |
| Execute admin Agent ID save helper        |        |   ✓   |
| Execute real-send acceptance              |        |   ✓   |
| Quote redaction-safe status JSON in docs  |   ✓    |   ✓   |
| Update PR #1430 description / labels      |        |   ✓   |
| Merge PR #1430 to `main`                  |        |   ✓   |
