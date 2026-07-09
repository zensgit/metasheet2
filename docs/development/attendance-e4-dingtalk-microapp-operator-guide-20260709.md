# Attendance E4 DingTalk Micro-App Operator Guide — 2026-07-09

> Scope: E4 real-device validation for the attendance DingTalk H5 micro-app.
> This document records the current operator steps and evidence with secrets
> redacted. It does not store screenshots because the admin directory page can
> expose app and tenant identifiers.

## 1. Current Goal

E4 proves the phone DingTalk path:

1. Open the DingTalk H5 micro-app on a phone.
2. Container login exchanges DingTalk `authCode` for a MetaSheet JWT.
3. The user lands on `/attendance` without seeing the normal password login.
4. A DingTalk work-notification action card can deep-link back to
   `/attendance?noticeSource=...`.

Code-side E1/E2/E3 has already landed. E4 is an operator/platform validation.

## 2. DingTalk Console Settings

Open DingTalk Developer Console:

1. `应用开发`
2. Select the internal H5 micro-app.
3. Configure these fields.

Use the public tunnel origin:

```text
Public origin:
<HTTPS_APP_URL>
```

Homepage fields:

```text
应用首页 / H5首页:
<HTTPS_APP_URL>/attendance
```

Security domain fields:

```text
H5安全域名:
<DOMAIN_ONLY>

JSAPI安全域名:
<DOMAIN_ONLY>
```

OAuth / login callback:

```text
redirect_uri / 回调地址:
<HTTPS_APP_URL>/login/dingtalk/callback
```

If the DingTalk console only accepts a domain for the callback whitelist, use:

```text
<DOMAIN_ONLY>
```

## 3. Required DingTalk API Permissions

If the phone shows `钉钉登录失败，请稍后再试`, check backend logs before changing
MetaSheet code. The current confirmed backend failure was:

```text
DingTalk request failed (403): 没有调用该接口的权限
```

That means the new DingTalk application is active, but it has not been granted
the APIs needed by login / container login.

Grant or verify these DingTalk API permission surfaces:

| Purpose | DingTalk console permission / control | System API surface | Requirement |
|---|---|---|---|
| Web OAuth login | `通讯录个人信息读权限` / `Contact.User.Read` | `/v1.0/contact/users/me` | Required. Missing permission produced the observed 403. |
| In-container DingTalk login | `SNS 基础权限` / `snsapi_base`; if the console lists an auth-code identity permission, grant it too | `/topapi/v2/user/getuserinfo` | Must be available. `snsapi_base` is usually default-enabled. |
| User detail fallback | `通讯录个人信息读权限` / `Contact.User.Read` | `/topapi/v2/user/get` | Required for stable identity detail lookup by DingTalk `userid`. |
| Directory access scope | `通讯录接口权限范围` | `全部员工` / `部分员工` | The phone-test user must be in scope; use `全部员工` for initial E4 validation unless policy requires otherwise. |
| Work-notification deep link | Work notification / enterprise conversation message permission; search the console for `工作通知` or `消息` if sends fail | `/topapi/message/corpconversation/asyncsend_v2` | Required only for attendance notification action cards, not for login-only validation. |

After adding permissions, click the console's save/publish/effective action.
Some DingTalk settings do not take effect until the app is published or the
permission application is approved.

## 4. Runtime Env Status

Deployment host env was updated on 2026-07-09. Secrets are intentionally
redacted here.

Backup created on host:

```text
/home/mainuser/metasheet2/docker/app.env.bak.e4-dingtalk-switch-20260709T004815Z
```

Runtime keys after switch:

```text
PUBLIC_APP_URL=<HTTPS_APP_URL>
APP_BASE_URL=<HTTPS_APP_URL>

DINGTALK_CLIENT_ID=<DINGTALK_CLIENT_ID>
DINGTALK_CLIENT_SECRET=<redacted>
DINGTALK_CORP_ID=dingb980...a795
DINGTALK_ALLOWED_CORP_IDS=dingd1f...455b,dingb980...a795
DINGTALK_REDIRECT_URI=<HTTPS_APP_URL>/login/dingtalk/callback

DINGTALK_CONTAINER_LOGIN_ENABLED=true
ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED=true
```

Backend was recreated only for the `backend` service; DB, Redis, and Web were
not recreated.

## 5. Verification Commands

Do not print secrets. These commands only display public identifiers or
redacted status.

Check current OAuth URL:

```bash
curl -ksS \
  '<HTTPS_APP_URL>/api/auth/dingtalk/launch?redirect=%2Fattendance' \
| python3 -c 'import sys,json,urllib.parse; d=json.load(sys.stdin); u=d["data"]["url"]; qs=urllib.parse.parse_qs(urllib.parse.urlparse(u).query); print("client_id="+qs.get("client_id",[""])[0]); print("redirect_uri="+qs.get("redirect_uri",[""])[0])'
```

Expected:

```text
client_id=<DINGTALK_CLIENT_ID>
redirect_uri=<HTTPS_APP_URL>/login/dingtalk/callback
```

Check DingTalk runtime status:

```bash
curl -ksS \
  '<HTTPS_APP_URL>/api/auth/dingtalk/launch?probe=1'
```

Expected fields:

```text
configured=true
available=true
corpId=dingb980...a795
```

Check backend health:

```bash
curl -ksS \
  '<HTTPS_APP_URL>/api/health'
```

## 6. Backend Log Triage

On the deploy host:

```bash
docker logs --since 20m metasheet-backend 2>&1 \
| grep -Ei 'dingtalk|container login|auth code|corp|grant|external|union|openId|login failed|error|warn' \
| sed -E 's/(client_secret|access_token|Bearer )[A-Za-z0-9._~+\/=:-]+/\1<redacted>/g'
```

Common outcomes:

| Log evidence | Meaning | Action |
|---|---|---|
| `redirect_uri 参数错误` on phone before backend callback | DingTalk console callback whitelist mismatch | Add callback URL/domain in DingTalk console |
| `没有调用该接口的权限` | App lacks DingTalk API permissions | Grant APIs listed in section 3 |
| `grant_required` / `unlinked_enabled_local_user` | DingTalk user resolved, but local login grant or binding is missing | Bind DingTalk identity to local user or enable grant |
| `invalid_auth_code` for a dummy code | Expected for test probes | Ignore unless it happens with real phone authCode |
| `container_login_disabled` | Env flag is off | Set `DINGTALK_CONTAINER_LOGIN_ENABLED=true` and restart backend |

## 7. Phone Test Checklist

Run on a real phone inside DingTalk:

1. Open the micro-app from DingTalk workbench.
2. Confirm the page does not stop at normal password login.
3. Confirm `/attendance` overview loads.
4. Perform one lightweight attendance action if appropriate.
5. Trigger an attendance work notification.
6. Tap the action card button `打开考勤`.
7. Confirm it returns to `/attendance?noticeSource=...`.

Evidence to keep:

```text
E4_DINGTALK_REAL_DEVICE_PASS
deploy=<current /api/health build.commit>
client_id=<DINGTALK_CLIENT_ID>
corp=dingb980...a795
homepage=/attendance
container_login=pass
action_card_deeplink=pass
```

Current observed result on 2026-07-09:

```text
phone_dingtalk_login=pass
operator_observation=User confirmed the phone DingTalk micro-app can log in.
remaining_manual_check=Action-card deep link back to /attendance?noticeSource=...
```

## 8. Rollback

If the new DingTalk app must be rolled back, restore the backup on the deploy
host and recreate only the backend container:

```bash
cd /home/mainuser/metasheet2
cp docker/app.env.bak.e4-dingtalk-switch-20260709T004815Z docker/app.env
current_image="$(docker inspect -f '{{.Config.Image}}' metasheet-backend)"
current_tag="${current_image##*:}"
IMAGE_TAG="$current_tag" docker compose -f docker-compose.app.yml up -d --no-deps --force-recreate backend
curl -fsS http://127.0.0.1:8900/api/health
```

## 9. Browser Note

The Codex in-app browser panel was requested for this record. The browser
automation connection was opened, but the active tab was not exposed through the
automation API at the time of this note. No browser screenshot was stored, to
avoid capturing directory integration identifiers. The durable evidence in this
guide comes from public health probes and redacted backend logs.

## 10. Screenshot Checklist and Redaction Rules

Live screenshot capture was attempted from the Codex in-app browser, but the
browser safety policy blocked navigation to the public tunnel URL. Do not work
around that block with another automated browser surface. Instead, capture the
following screenshots manually during E4 and redact them before storing:

| Screenshot | When to capture | Required redaction |
|---|---|---|
| DingTalk app homepage settings | After setting the H5 homepage | Mask full App ID, Client ID suffix is enough (`<DINGTALK_CLIENT_ID>`), mask any secret |
| H5安全域名 / JSAPI安全域名 | After saving both domains | Domain can remain visible; mask unrelated tenant/app identifiers |
| OAuth / redirect URI setting | After saving callback URL | URL can remain visible; mask app identifiers |
| API permission page | After granting login/contact APIs | Keep API names visible; mask tenant/app identifiers |
| Phone micro-app opens `/attendance` | After opening the app in DingTalk mobile | Mask user avatar/name/phone/email; keep URL path visible |
| Login failure toast, if any | Immediately after failure | Mask user identity; keep the exact toast text visible |
| ActionCard deep-link return | After tapping `打开考勤` | Mask user identity; keep `noticeSource` path/query visible |

Recommended file location for redacted screenshots:

```text
docs/development/assets/e4-dingtalk-20260709/
```

Suggested names:

```text
01-dingtalk-homepage-redacted.png
02-dingtalk-safe-domains-redacted.png
03-dingtalk-api-permissions-redacted.png
04-phone-attendance-open-redacted.png
05-phone-actioncard-deeplink-redacted.png
```

Never store screenshots that expose:

```text
Client Secret / AppSecret
access_token
JWT / Authorization header
full phone number
full email if not necessary
unredacted employee directory rows
```
