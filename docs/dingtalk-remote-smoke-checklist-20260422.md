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

Create a template:

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
