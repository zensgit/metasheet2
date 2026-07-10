# DingTalk Attendance E4 Deployment And Smoke Runbook

Date: 2026-07-09

Audience: implementation owners, customer success, staging operators

## Goal

Bring up the MetaSheet attendance DingTalk H5 micro-app, verify mobile DingTalk
container sign-in, and prove that a work-notification action card can deep-link
back into the populated attendance page.

This runbook covers the operator path that was proven during E4:

```text
DingTalk app settings -> MetaSheet directory integration -> mobile DingTalk login
-> attendance page renders -> work notification button opens attendance again
```

It is intentionally values-safe. Do not paste AppSecret, access tokens, cookies,
full DingTalk user IDs, full phone numbers, or passwords into this document,
issue comments, screenshots, or chat logs.

## Completion Criteria

E4 is complete only when all of these pass on a real phone in DingTalk:

1. The DingTalk micro-app opens the MetaSheet H5 home page.
2. The attendance entry opens without showing the generic MetaSheet login page.
3. The attendance page renders usable content, including clock-in / clock-out
   entry points and today's attendance status or timeline.
4. A DingTalk work-notification action card is received.
5. Tapping the action-card button opens the attendance page in the DingTalk
   container.

## Required MetaSheet Runtime Settings

The public deployment must expose a stable HTTPS URL reachable from the phone.
For temporary validation, a `trycloudflare.com` URL is acceptable. For customer
production, prefer a real customer-controlled domain.

Required backend/runtime values:

```text
PUBLIC_APP_URL=https://<public-host>
DINGTALK_CONTAINER_LOGIN_ENABLED=true
ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED=true
ATTENDANCE_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED=true
```

Keep the attendance scheduler disabled unless the runbook explicitly asks for
scheduled outbox processing. E4 can be proven with a direct test notification
and does not require batch processing historical pending rows.

Verify after deploy:

```bash
curl -fsS https://<public-host>/api/health
curl -fsS https://<public-host>/build-info.json
```

Record only the build SHA and safe metadata.

## DingTalk Open Platform Settings

Open the DingTalk developer console for the internal H5 app. Exact navigation
labels may move in the DingTalk UI; keep the configured values aligned with the
fields below.

### H5 Home Page

Set the H5 home page / application home page to the public MetaSheet entry.

Recommended for the attendance app:

```text
https://<public-host>/attendance
```

If the customer wants the app launcher first, use:

```text
https://<public-host>/apps
```

For E4, `/attendance` is the shortest path because it proves the attendance
container shell and attendance page directly.

### H5 Safe Domain

Add only the host, without protocol and without path:

```text
<public-host>
```

Example shape:

```text
demonstration-postings-nashville-premises.trycloudflare.com
```

Do not add `/attendance`, `/login`, or query strings to the safe domain field.

### JSAPI Safe Domain

Use the same host-only value as H5 safe domain:

```text
<public-host>
```

This is required for the DingTalk JSAPI container login flow.

### OAuth Callback Address

Add the MetaSheet DingTalk callback URL:

```text
https://<public-host>/login/dingtalk/callback
```

If DingTalk reports `redirect_uri` parameter errors, check these three things
first:

- the callback uses `https`
- the host exactly matches the public app URL host
- the callback path is `/login/dingtalk/callback`

### App Credentials

Record the AppKey / Client ID in the MetaSheet directory integration. Store the
AppSecret only through the MetaSheet UI or environment configuration. Never add
it to docs, screenshots, PR bodies, or issue comments.

The work-notification Agent ID must belong to the same DingTalk internal app as
the AppKey / AppSecret. A mismatched Agent ID produces DingTalk errors such as
`agentId ... don't legal`.

## DingTalk API Permissions

Open the DingTalk app's permission management page and enable the capabilities
needed by the selected features.

Minimum for E1 / E4 container login:

- obtain an app access token for the internal app
- exchange an in-container auth code for the corp user ID

Minimum for directory sync and user binding:

- list sub-departments
- read department detail
- list department users
- read user detail

Minimum for work notifications and E3 / E4 deep links:

- send enterprise work notifications
- allow action-card style work messages for the internal app

Implementation note for operators:

- The code currently calls DingTalk legacy OpenAPI endpoints under
  `/topapi/v2/department/*`, `/topapi/v2/user/*`, and
  `/topapi/message/corpconversation/asyncsend_v2`.
- If the DingTalk console shows permissions by product label instead of API
  path, search for the equivalent department, user, login, and work-notification
  permissions.
- After changing permissions, publish or update the DingTalk app version if the
  console requires publication before the app can use the new permissions.

## MetaSheet Directory Integration Settings

Open MetaSheet:

```text
Admin -> Directory Sync
```

Configure or confirm:

- provider: `dingtalk`
- Corp ID
- App Key / Client ID
- App Secret, entered only through the secret field
- work-notification Agent ID
- root department ID, usually the DingTalk root department
- base URL, usually blank or DingTalk default

Then run:

1. `测试连通性`
2. `手动同步`
3. confirm departments and accounts appear
4. bind or create local users from synced accounts
5. enable DingTalk login for users who should sign in through DingTalk

For users with no email in DingTalk, create a local user from the synced account
using username or mobile as the local login identifier. The local user remains
the authority subject; DingTalk is the identity and delivery channel.

## Work Notification Setup

In the same directory integration page:

1. Enter the DingTalk work-notification Agent ID.
2. Save it.
3. If testing from the UI, enter a DingTalk UserID and click the work
   notification test button.
4. For E4, send an action-card notification whose button URL points to:

```text
https://<public-host>/attendance?noticeSource=e4_dingtalk_real_device_smoke
```

Expected message behavior:

- the phone receives a DingTalk work notification
- the message contains a visible action button such as `打开考勤`
- tapping the button opens MetaSheet attendance in the DingTalk container

Record only masked recipient IDs, DingTalk task IDs, request IDs, and the build
SHA.

## E4 Real-Device Smoke

Use a real phone logged into the customer DingTalk org.

### Step 1: Open The Micro-App

Open the DingTalk workbench and tap the MetaSheet attendance H5 micro-app.

PASS:

- the H5 app opens
- the user is not bounced to a broken `redirect_uri` page
- the user is not stuck on the generic MetaSheet login page

FAIL routing:

- `redirect_uri` error: re-check OAuth callback and safe domains
- generic login page: check container login flag, app permissions, user binding,
  and DingTalk login enabled state for the local user
- immediate logout loop: check cookie/domain mismatch and public URL consistency

### Step 2: Verify Attendance Content

Open `/attendance`.

PASS:

- page title or attendance shell renders
- clock-in / clock-out entry points are visible
- today's timeline or attendance status renders
- helper sections such as missing-punch guidance may render

Record safe signals only, for example:

```text
attendance page rendered; clock-in/out controls visible; today's status visible
```

Do not record full personal schedules, full user IDs, or screenshots that expose
private employee details unless the screenshot is redacted first.

### Step 3: Send The Action-Card Test

Send a work notification action card to a linked DingTalk user. The button target
must include the public host and the E4 notice source:

```text
/attendance?noticeSource=e4_dingtalk_real_device_smoke
```

PASS:

- DingTalk API returns a task ID or request ID
- the phone receives the notification
- tapping `打开考勤` opens the attendance page
- attendance content is populated after the jump

### Step 4: Record Evidence

Values-safe evidence template:

```text
E4 real-device validation passed on <date>.

- Public app URL: https://<public-host>
- Deployed image/build SHA: <sha>
- Runtime health check: /api/health returned ok
- Work-notification Agent ID verified/saved with tail <last4>
- Recipient masked as <prefix>***<suffix>
- DingTalk taskId: <task-id>; requestId: <request-id>
- Owner confirmed on phone: received actionCard and `打开考勤` opened the populated attendance page.
```

## Host Hygiene

For small demo hosts, run only MetaSheet during E4. Do not co-locate heavy
Athena, Yuantus, Elasticsearch, MinIO, Keycloak, Collabora, or buildkit stacks
unless the host has enough CPU and memory headroom.

Observed bad shape on an undersized shared host:

```text
load average above 80
swap fully used
SSH banner exchange timeouts
Docker exec/logs intermittently hanging
```

Stop-only cleanup is acceptable before E4:

- back up public and staging MetaSheet DBs
- stop non-MetaSheet containers
- keep volumes
- do not run `docker system prune -a`
- do not delete volumes during a validation window

Recommended minimum if the host only runs MetaSheet:

```text
4 vCPU / 8 GB RAM / 80 GB SSD
```

Recommended if the same host must also run multiple large demo stacks:

```text
4-8 vCPU / 16 GB RAM / 100 GB SSD or larger
```

## Troubleshooting

### DingTalk says `redirect_uri` is invalid

Check:

- OAuth callback is exactly `https://<public-host>/login/dingtalk/callback`
- the callback host is listed in DingTalk safe-domain settings
- there is no path in the safe-domain field
- the H5 app was published after changing settings, if DingTalk requires publish

### MetaSheet shows `DingTalk login failed`

Check:

- AppKey and AppSecret are from the same internal app
- Corp ID matches the DingTalk org
- the required login/user APIs are authorized
- the public host is reachable from the phone
- backend env has `DINGTALK_CONTAINER_LOGIN_ENABLED=true`

### Error: `dingtalk login is not enabled for this user`

The synced DingTalk account exists, but the local MetaSheet user is not allowed
to use DingTalk login.

Fix:

1. Open Admin -> Users or Admin -> Directory Sync.
2. Locate the local user bound to the DingTalk account.
3. Enable DingTalk login for that user.
4. Retry from the phone.

### Synced DingTalk user has no `openId`

Directory sync may have user ID / union ID but not openId depending on the API
payload and permission shape. For local login and work-notification delivery,
the important binding is the local user mapped to the DingTalk directory user.

Do not ask customers to manually type 100 users one by one. Prefer:

- directory sync
- batch create-and-bind from synced accounts
- username/mobile based local users when DingTalk email is empty
- explicit DingTalk-login enablement for the created local users

### Work notification test fails with invalid Agent ID

Check:

- Agent ID is numeric
- Agent ID belongs to the same DingTalk internal app as AppKey/AppSecret
- work-notification permission is enabled
- app version has been published if DingTalk requires publishing permission
  changes

### Phone receives notification but button opens login

Check:

- button URL host equals `PUBLIC_APP_URL`
- H5 safe domain and JSAPI safe domain contain the same host
- local user is bound to the DingTalk directory account
- DingTalk login is enabled for the local user
- container login flag is enabled

## Screenshot Slots

Add redacted screenshots only when they are needed for customer-facing help.
Recommended safe captures:

- DingTalk app page showing H5 home page field, with App ID and secrets masked
- DingTalk security page showing safe-domain fields, with unrelated app details
  masked
- DingTalk permission page showing enabled API groups, with org-specific details
  masked
- MetaSheet directory integration page showing configured status chips, with
  Corp ID, AppSecret, Agent ID, and full user IDs masked
- Mobile DingTalk attendance page after deep link, with names and detailed
  personal data masked

Store screenshot assets under a dated asset folder and reference them from this
runbook only after redaction.

## Current E4 Attestation Example

The 2026-07-09 E4 run used a temporary HTTPS public host and completed after
stop-only cleanup of unrelated containers. Safe evidence recorded in the issue:

- build SHA: `38337c1bb6928ee21d9be57f86aeeebb237df874`
- work-notification Agent ID tail: `4271`
- recipient masked as `044***74`
- DingTalk taskId: `3421805734405`
- requestId: `15rzrt460ezox`
- owner confirmed on phone that the notification button opened the populated
  attendance page

Do not reuse this example as a future PASS without re-running the real-device
steps against the current deployment.
