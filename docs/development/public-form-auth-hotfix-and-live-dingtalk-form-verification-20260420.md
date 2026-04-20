# Public Form Auth Hotfix And Live DingTalk Form Verification - 2026-04-20

## Verification Summary

The full chain now works in the live environment:

1. create a real public form
2. load it anonymously
3. submit it anonymously
4. send the public form link to the DingTalk group

## Local Code Verification

Commands run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/jwt-middleware.test.ts \
  tests/integration/public-form-flow.test.ts \
  tests/integration/multitable-record-form.api.test.ts \
  --watch=false
pnpm --filter @metasheet/core-backend build
```

Results:

- `18 passed`
- backend build: passed

## Remote Runtime Verification

### Public form context

Verified on the live host:

```bash
curl -s "http://142.171.239.56:8081/api/multitable/form-context?viewId=view_form_dingtalk_demo_20260420&publicToken=pub_dingtalk_demo_20260420"
```

Observed:

- `ok=true`
- view name: `钉钉填写入口`
- fields: `姓名 / 手机号 / 需求说明`

### Public form page

Verified the public page responds:

```text
PUBLIC_FORM_HTTP=200
```

### Anonymous submit

Verified on the live backend:

```bash
POST /api/multitable/views/view_form_dingtalk_demo_20260420/submit?publicToken=pub_dingtalk_demo_20260420
```

Observed:

- `ok=true`
- `mode=create`
- created record id:
  - `rec_eea1e3e6-f51e-481c-ad21-86598599f0ad`

## DingTalk Group Send Verification

Sent a real DingTalk group markdown message containing the public form link.

Observed DingTalk response:

```json
{"status":200,"body":{"errcode":0,"errmsg":"ok"}}
```

The first send attempt failed with:

```json
{"errcode":310000,"errmsg":"关键词不匹配"}
```

Then resent using the same successful keyword family as the earlier real send (`metasheet2 / Yjs`), and the message was accepted.

## Important Operational Note

The live runtime is currently functional because of a temporary backend dist hot-patch.

Permanent closure still requires:

- merge `#931`
- rebuild/deploy the normal backend image
- remove the temporary runtime divergence

## User-Facing Answer

“在钉钉中发送消息并打开表单” is no longer blocked by feature development.

It is now working live for the created verification form. The remaining work is only to merge and redeploy the auth hotfix cleanly, not to invent a new capability.
