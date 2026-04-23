# DingTalk Remote Smoke Checklist

- Date: 2026-04-22
- Scope: deployed environment validation
- Audience: release owner, QA, implementation owner

## Purpose

Use this checklist after the stacked DingTalk PRs are deployed to a remote environment.

The checklist proves the full product loop:

- table trigger
- DingTalk group/person message
- form link or internal processing link
- DingTalk identity gate
- local user/member-group authorization
- delivery history evidence

## Preconditions

- backend migrations have run
- at least one admin can sign in
- DingTalk app credentials are configured for sign-in and person work notifications
- at least two DingTalk group robot webhooks are available for testing
- at least two local users are available:
  - one DingTalk-bound and authorized user
  - one user that should be denied
- at least one synced DingTalk account without a matched local user is available if no-email admission is being tested

## Evidence to capture

Capture:

- environment URL
- commit or image tag
- table ID
- form view ID
- automation rule ID
- DingTalk group destination IDs
- screenshots of access mode and allowlist settings
- delivery history rows for group and person sends
- submit result for authorized user
- blocked submit result for unauthorized user

Do not capture or paste:

- DingTalk robot full webhook URLs
- DingTalk app secrets
- temporary passwords
- admin tokens

## Evidence compiler

Use the evidence compiler after the manual smoke is executed. It does not call DingTalk or staging; it validates the operator-provided result file, redacts secrets, and writes a reusable evidence summary.

Create a manual evidence kit when starting a full remote smoke run:

```bash
node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs \
  --init-kit output/dingtalk-p4-remote-smoke/142-manual-kit
```

Expected generated files:

- `evidence.json`
- `manual-evidence-checklist.md`
- `artifacts/send-group-message-form-link/`
- `artifacts/authorized-user-submit/`
- `artifacts/unauthorized-user-denied/`
- `artifacts/no-email-user-create-bind/`

Create only the JSON template when you do not need artifact folders:

```bash
node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs \
  --init-template output/dingtalk-p4-remote-smoke/evidence.json
```

After filling the template with results, compile it:

```bash
node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs \
  --input output/dingtalk-p4-remote-smoke/evidence.json \
  --output-dir output/dingtalk-p4-remote-smoke/20260422 \
  --strict
```

Expected generated files:

- `summary.json`
- `summary.md`
- `evidence.redacted.json`

The compiler requires every smoke check in this document to be `pass` when `--strict` is used. It redacts DingTalk webhook `access_token`, `SEC...` secrets, bearer/JWT tokens, passwords, and public form tokens before writing artifacts.

Strict mode also requires real manual evidence metadata for the checks that only a DingTalk client or administrator can prove. For each check below, add `source`, `operator`, `performedAt`, `summary` or `notes`, and at least one per-check artifact reference:

- `send-group-message-form-link`: `source: "manual-client"`
- `authorized-user-submit`: `source: "manual-client"`
- `unauthorized-user-denied`: `source: "manual-client"`
- `no-email-user-create-bind`: `source: "manual-admin"`

Strict artifact refs are self-contained by default:

- Use relative paths only.
- Put each file under `artifacts/<check-id>/` next to the input `evidence.json`.
- The referenced path must exist, be a file, and be non-empty.
- External URL refs are rejected unless `--allow-external-artifact-refs` is passed. Prefer local files for release evidence because URL-only proof can be edited or become unavailable.

Example check evidence:

```json
{
  "id": "authorized-user-submit",
  "status": "pass",
  "evidence": {
    "source": "manual-client",
    "operator": "qa",
    "performedAt": "2026-04-22T15:00:00.000Z",
    "summary": "Allowed DingTalk-bound user opened the group link and submitted one record.",
    "artifacts": ["artifacts/authorized-user-submit/authorized-submit.png"]
  }
}
```

## Session Orchestrator

Use the session orchestrator for the normal 142/staging P4 run. It runs preflight, bootstraps the API-addressable smoke workspace, compiles a non-strict evidence summary, and writes a session report. It stops before the API runner when preflight fails.

Create a local env template first:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --init-env-template output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env
```

Fill the generated file outside git with real staging and DingTalk robot inputs.

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --output-dir output/dingtalk-p4-remote-smoke-session/142-session
```

Expected generated files:

- `preflight/preflight-summary.json`
- `preflight/preflight-summary.md`
- `workspace/evidence.json`
- `workspace/manual-evidence-checklist.md`
- `workspace/artifacts/<check-id>/`
- `compiled/summary.json`
- `compiled/summary.md`
- `compiled/evidence.redacted.json`
- `session-summary.json`
- `session-summary.md`

Expected session status is usually `manual_pending` after the API runner succeeds, because the real DingTalk-client/admin checks still need operator proof. Fill `workspace/evidence.json`, place files in `workspace/artifacts/<check-id>/`, then finalize the session:

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --finalize output/dingtalk-p4-remote-smoke-session/142-session
```

Finalizing reruns strict evidence compile, refreshes `session-summary.json` / `session-summary.md`, and returns non-zero until the manual evidence bundle is complete.

After finalization passes, export a handoff packet with the final-pass gate enabled:

```bash
node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \
  --include-output output/dingtalk-p4-remote-smoke-session/142-session \
  --require-dingtalk-p4-pass \
  --output-dir artifacts/dingtalk-staging-evidence-packet/142-final
```

The packet exporter rejects the included session unless the final pass is machine-verifiable:

- `session-summary.json` must be from `dingtalk-p4-smoke-session`, have `sessionPhase: "finalize"`, `overallStatus: "pass"`, `finalStrictStatus: "pass"`, no `pendingChecks`, and a passing `strict-compile` step.
- `compiled/summary.json` must be from `compile-dingtalk-p4-smoke-evidence`, have `overallStatus`, `apiBootstrapStatus`, and `remoteClientStatus` all set to `pass`.
- All eight required checks must exist with `status: "pass"`.
- `requiredChecksNotPassed`, `manualEvidenceIssues`, `failedChecks`, and `missingRequiredChecks` must be arrays and empty.
- The exporter does not create secrets, but it copies raw included evidence. Review and redact raw workspace/artifact files before release handoff.

## Preflight Gate

Before calling staging or DingTalk, run the preflight gate to check local tooling, required URLs, bearer token presence, DingTalk webhook format, optional `SEC...` secret format, allowlist inputs, and backend `/health`. It writes only redacted summaries.

```bash
node scripts/ops/dingtalk-p4-smoke-preflight.mjs \
  --api-base "$DINGTALK_P4_API_BASE" \
  --web-base "$DINGTALK_P4_WEB_BASE" \
  --auth-token "$DINGTALK_P4_AUTH_TOKEN" \
  --group-a-webhook "$DINGTALK_P4_GROUP_A_WEBHOOK" \
  --group-b-webhook "$DINGTALK_P4_GROUP_B_WEBHOOK" \
  --allowed-user "$DINGTALK_P4_ALLOWED_USER_ID" \
  --output-dir output/dingtalk-p4-remote-smoke/preflight-142
```

Expected generated files:

- `preflight-summary.json`
- `preflight-summary.md`

## API-Only Smoke Runner

Use the API-only runner directly when debugging the session's API step. It prepares the disposable test resources and collects backend evidence before the manual DingTalk-client checks. It creates a table, a form view, two group destinations, a `dingtalk_granted` form share, a group automation rule, and optional person-message rule when `--person-user` is supplied.

Do not paste secrets into docs or chat. Supply them through secure shell env, a local password manager, or a temporary shell session on the staging host.

```bash
node scripts/ops/dingtalk-p4-remote-smoke.mjs \
  --api-base "$DINGTALK_P4_API_BASE" \
  --web-base "$DINGTALK_P4_WEB_BASE" \
  --auth-token "$DINGTALK_P4_AUTH_TOKEN" \
  --group-a-webhook "$DINGTALK_P4_GROUP_A_WEBHOOK" \
  --group-b-webhook "$DINGTALK_P4_GROUP_B_WEBHOOK" \
  --allowed-user "$DINGTALK_P4_ALLOWED_USER_ID" \
  --person-user "$DINGTALK_P4_PERSON_USER_ID" \
  --output-dir output/dingtalk-p4-remote-smoke/142-api
```

Expected output:

- `evidence.json`
- `manual-evidence-checklist.md`
- `artifacts/send-group-message-form-link/`
- `artifacts/authorized-user-submit/`
- `artifacts/unauthorized-user-denied/`
- `artifacts/no-email-user-create-bind/`

The runner intentionally leaves these checks as `pending`:

- real DingTalk group message visibility, form link, and access-copy screenshot
- authorized DingTalk-bound user opens and submits from the real DingTalk group message
- unauthorized DingTalk-bound user is blocked and inserts no record
- no-email DingTalk-synced account creation and binding

If no `--person-user` is provided, person delivery evidence is also `pending`. Fill the manual checks in the generated `evidence.json`, place files in the matching `artifacts/<check-id>/` folders, then run the compiler with `--strict`.

## Smoke 1: Create table and public form

Steps:

1. Create a new table or choose a disposable test table.
2. Add fields required by the test form.
3. Create a form view.
4. Enable public form sharing.
5. Save the form with access mode `dingtalk_granted`.
6. Add an allowlist containing the authorized local user or an allowed local member group.

Expected:

- form share manager shows `Authorized DingTalk users only`
- local allowlist summary names the allowed local users/member groups
- generated public form link is available

## Smoke 2: Bind two DingTalk groups

Steps:

1. Open `API Tokens / Webhooks / DingTalk Groups`.
2. Add DingTalk group destination A.
3. Add DingTalk group destination B.
4. Run `Test send` for both destinations.

Expected:

- both destinations are enabled
- webhook URL is masked in the UI
- secret is not displayed
- test-send delivery history records success or a clear DingTalk error

## Smoke 3: Send group message with form link

Steps:

1. Create an automation rule.
2. Use action `Send DingTalk group message`.
3. Select both DingTalk group destinations.
4. Select the protected form view as the public form link.
5. Save the rule.
6. Trigger the rule by creating or updating a record.

Expected:

- DingTalk group message is received in both groups
- message includes the form link
- message includes access text showing DingTalk authorization and local allowlist scope
- rule-level group delivery history records the send

## Smoke 4: Authorized user can submit

Steps:

1. Open the DingTalk group message as the authorized DingTalk-bound user.
2. Open the form link.
3. Complete and submit the form.
4. Check the table for the inserted record.

Expected:

- DingTalk sign-in succeeds if a session is not already active
- form opens
- submit succeeds
- a new record is inserted

## Smoke 5: Unauthorized user cannot submit

Steps:

1. Open the same form link as a DingTalk-bound user who is not authorized or not in the allowlist.
2. Attempt to submit the form.
3. Check the table for inserted records.

Expected:

- form access or submit is blocked
- error copy explains the missing grant or allowlist access
- no record is inserted

## Smoke 6: Person delivery history records skipped users

Steps:

1. Create or edit an automation rule with action `Send DingTalk person message`.
2. Select one bound local user and one unbound or inactive local user.
3. Trigger the rule.
4. Open person delivery history.

Expected:

- the bound local user receives the message
- the unbound or inactive local user appears as `skipped`
- skipped delivery reason explains that the DingTalk account is not linked or the user is inactive
- skipped recipient does not block delivery to the bound recipient

## Smoke 7: No-email DingTalk account creation and binding

Steps:

1. Open directory management.
2. Find a synced DingTalk account without a matched local user.
3. Expand manual creation from the member account list or pending review queue.
4. Leave email empty.
5. Enter name plus username or mobile.
6. Submit create-and-bind.

Expected:

- local user is created
- DingTalk account is linked to the local user
- onboarding packet is shown
- temporary password is shown only in the admin result panel
- the account list refreshes and shows the local link

## Pass criteria

The remote smoke passes only when:

- group destinations can be created and test-sent without leaking secrets
- group automation sends a protected form link
- authorized user can submit
- unauthorized user cannot insert a record
- group delivery history records group sends
- person delivery history records `success`, `failed`, or `skipped`
- no-email synced account can be manually created and bound when username or mobile is present

## Failure handling

If a smoke step fails:

1. capture the exact step and timestamp
2. capture the visible error message
3. check backend logs for the route or delivery error
4. do not retry by weakening the form access mode
5. keep the DingTalk webhook and app secrets redacted in all reports
