# DingTalk Protected Form Test Links 142 Development Verification - 2026-05-06

## Goal

Prepare two real test links on the 142 environment for DingTalk form acceptance:

1. A form that can be filled by any local user who is DingTalk-bound.
2. A form that can be filled only by a specified DingTalk-authorized local user.

## Runtime Configuration

### Link A: DingTalk-bound local users only

- View: `view_form_dingtalk_demo_20260420`
- Sheet: `sheet_dingtalk_form_demo_20260420`
- Access mode: `dingtalk`
- Allowed users: none
- Allowed member groups: none
- Public token retained: `pub_dingtalk_demo_20260420`

Link:

`http://142.171.239.56:8081/multitable/public-form/sheet_dingtalk_form_demo_20260420/view_form_dingtalk_demo_20260420?publicToken=pub_dingtalk_demo_20260420`

### Link B: Specified user only

- View: `view_a2c6b959-84d3-4b25-aa70-e8988af69baa`
- Sheet: `sheet_83340851-6c7e-4123-8f6f-a4b6949f9be2`
- Access mode: `dingtalk_granted`
- Allowed users:
  - `zhouhua` (`b928b8d9-8881-43d7-a712-842b28870494`)
- Allowed member groups: none
- Public token retained: `pub_a6074144-f8f4-4bc6-87bd-3c885e5aac9a`

Link:

`http://142.171.239.56:8081/multitable/public-form/sheet_83340851-6c7e-4123-8f6f-a4b6949f9be2/view_a2c6b959-84d3-4b25-aa70-e8988af69baa?publicToken=pub_a6074144-f8f4-4bc6-87bd-3c885e5aac9a`

## Development Notes

- 142 production mounts the canonical router at `/api/multitable`, not `/api/univer-meta`.
- The existing anonymous demo form was updated in-place from `public` to `dingtalk` using the live form-share API.
- The existing protected sample already matched the "specified user only" requirement and did not need changes.

## Verification

### Commands

```bash
TOKEN="$(cat /tmp/metasheet-142-main-admin-72h.jwt)"

curl -sS -X PATCH \
  'http://142.171.239.56:8081/api/multitable/sheets/sheet_dingtalk_form_demo_20260420/views/view_form_dingtalk_demo_20260420/form-share' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"enabled":true,"accessMode":"dingtalk","allowedUserIds":[],"allowedMemberGroupIds":[],"expiresAt":"2099-12-31T23:59:59.000Z"}'

curl -sS \
  'http://142.171.239.56:8081/api/multitable/sheets/sheet_83340851-6c7e-4123-8f6f-a4b6949f9be2/views/view_a2c6b959-84d3-4b25-aa70-e8988af69baa/form-share' \
  -H "Authorization: Bearer $TOKEN"

curl -sS -i \
  'http://142.171.239.56:8081/api/multitable/form-context?viewId=view_form_dingtalk_demo_20260420&publicToken=pub_dingtalk_demo_20260420'

curl -sS -i \
  'http://142.171.239.56:8081/api/multitable/form-context?viewId=view_a2c6b959-84d3-4b25-aa70-e8988af69baa&publicToken=pub_a6074144-f8f4-4bc6-87bd-3c885e5aac9a'

curl -sS \
  'http://142.171.239.56:8081/api/admin/users/b928b8d9-8881-43d7-a712-842b28870494/dingtalk-access' \
  -H "Authorization: Bearer $TOKEN"
```

### Results

- Link A form-share update succeeded.
- Link A current form-share config:
  - `accessMode = dingtalk`
  - no local allowlist
- Link B current form-share config:
  - `accessMode = dingtalk_granted`
  - `allowedUserIds = ["b928b8d9-8881-43d7-a712-842b28870494"]`
- Anonymous access to Link A returns:
  - `401`
  - `DINGTALK_AUTH_REQUIRED`
- Anonymous access to Link B returns:
  - `401`
  - `DINGTALK_AUTH_REQUIRED`
- `zhouhua` DingTalk access status confirms:
  - DingTalk identity exists
  - `hasOpenId = true`
  - grant is enabled
  - directory is linked

## Operational Guidance

- Use Link A when the test target is "any existing local user with a valid DingTalk binding can fill".
- Use Link B when the test target is "only the explicitly granted user can fill".
- If you need a third variant later for "selected member group only", reuse the same API and set `allowedMemberGroupIds`.
