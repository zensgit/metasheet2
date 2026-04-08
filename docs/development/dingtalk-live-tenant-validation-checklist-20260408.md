# DingTalk Live Tenant Validation Checklist

Date: 2026-04-08
Scope: staged validation after `#725`, `#723`, and `#724` are deployed together

## Preconditions

- DingTalk enterprise app credentials are available:
  - `DINGTALK_CLIENT_ID` or `DINGTALK_APP_KEY`
  - `DINGTALK_CLIENT_SECRET` or `DINGTALK_APP_SECRET`
  - `DINGTALK_REDIRECT_URI`
  - `DINGTALK_CORP_ID` when used
- staging callback domain is reachable over HTTPS
- one test DingTalk org structure is available
- one attendance sample range is available
- one DingTalk group robot webhook is available

## Login validation

1. Open the staging login page.
2. Confirm the DingTalk login entry is visible.
3. Start DingTalk login and complete the browser redirect.
4. Confirm callback lands on the expected MetaSheet route.
5. Confirm a normal MetaSheet session/JWT is issued.
6. Confirm `users.last_login_at` is updated for the linked local user.

Expected outcome:

- login succeeds without manual token editing
- redirect path is honored
- linked user receives the expected role and permissions

Failure cases to test:

- expired `state`
- missing `code`
- DingTalk user with disabled external auth grant
- DingTalk user with no local link when auto-provision is disabled

## Directory validation

1. Open `/admin/directory` in staging.
2. Test credentials before saving the integration.
3. Create or update one DingTalk integration.
4. Run a manual sync.
5. Inspect recent runs and integration stats.
6. Confirm departments and accounts were persisted.
7. Check link suggestions for:
   - external identity match
   - email match
   - mobile match
   - unmatched account

Expected outcome:

- sync run completes with usable stats
- departments and users appear once, without obvious duplication
- pending/linked/unmatched counts align with the sample tenant

Failure cases to test:

- invalid app secret
- wrong root department id
- empty department
- user detail fetch failure for one user

## Attendance validation

1. Use an existing DingTalk attendance integration or create a test one.
2. Run a dry-run sync for a small date range.
3. Run a non-dry-run sync for the same range.
4. Confirm import result, skipped rows, and `partialErrors` shape.
5. Re-run the same range to check idempotent behavior.
6. Force one user-level failure if possible and verify the run becomes `partial`, not `failed`.
7. Force one full-request failure and verify the run becomes `failed`, not `running`.

Expected outcome:

- token reuse works without repeated auth churn
- transient failures retry and recover
- partial user failures do not abort the whole sync
- failed runs are visible and diagnosable

## Robot notification validation

1. Configure one DingTalk robot webhook in staging.
2. Trigger one notification through the normal workflow path.
3. Confirm the robot receives markdown with the expected title and body.
4. If webhook signing is enabled, confirm `timestamp` and `sign` are accepted by DingTalk.
5. Trigger one deliberately invalid payload or endpoint and confirm non-retryable `HTTP 400` errors are not retried.

Expected outcome:

- message arrives once
- no duplicate retries for non-retryable 4xx responses
- retry still occurs for retryable 429 or 5xx responses

## Rollout sign-off checklist

- login flow verified with a real DingTalk user
- directory sync verified with a real department tree
- attendance sync verified with a real date range
- robot notification verified with a real group
- callback URI confirmed against DingTalk app config
- production decision recorded for `DINGTALK_AUTH_AUTO_LINK_EMAIL`
- production decision recorded for `DINGTALK_AUTH_AUTO_PROVISION`
- reviewers approve merge order `#725 -> #723 -> #724`
