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
- HEAD matches the latest commit referenced in the design doc.

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

Expected:

- `metasheet-backend` and `metasheet-web` images both end with the tag
  `245701aeb5afc57ae5a5932cc4f58ef3aef3a973`.
- Health: `{"ok":true,"status":"ok","success":true,"plugins":13}`.
- Frontend: `200`.
- Unauthenticated admin route: `401`.

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

Expected:

- `mergeable` is `MERGEABLE` or `UNKNOWN`.
- `mergeStateStatus` ends in either `CLEAN` or `BLOCKED` (BLOCKED only
  because of human review policy, not failed checks).
- All non-skipped checks are `SUCCESS`.
- The configured strict E2E job may remain `SKIPPED` per workflow policy.

## Stop conditions

The handoff loop ends when **all** of the following are true:

1. Both handoff Markdown files exist under `docs/development/` and have
   passed the secret-shape scan.
2. 142 backend health is `200` and frontend root is `200` on image tag
   `245701aeb5afc57ae5a5932cc4f58ef3aef3a973`.
3. The admin status helper returns `status: "pass"` with
   `agentIdValuePrinted=false`.
4. The admin save helper returns `status: "pass"` with
   `statusAfter.configured=true` and `statusAfter.available=true`.
5. At least one real-send DingTalk work-notification acceptance has
   recorded `delivered=true` and `recipientValuePrinted=false`.
6. PR #1430 has all required checks green and is merged into `main`.

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
