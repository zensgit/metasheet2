# DingTalk Work Notification Admin Agent ID Helper Verification

Date: 2026-05-08

## Local Verification

Commands:

```bash
node --check scripts/ops/dingtalk-work-notification-admin-agent-id.mjs
node --test scripts/ops/dingtalk-work-notification-admin-agent-id.test.mjs
git diff --check -- \
  scripts/ops/dingtalk-work-notification-admin-agent-id.mjs \
  scripts/ops/dingtalk-work-notification-admin-agent-id.test.mjs
```

Result:

- `node --check`: pass.
- `node --test`: pass, 4 tests.
- `git diff --check`: pass.

Test coverage:

- Status-only summary is redacted.
- Save workflow calls test and save endpoints and redacts token, Agent ID, and recipient id.
- Empty Agent ID file blocks before test/save.
- API error messages are redacted before output.

## 142 Main Stack Verification

Current accessible main stack:

- Web: `http://127.0.0.1:8081/`
- Backend: `http://127.0.0.1:8900`
- Public port: `8081`

Health after concurrent deployment settled:

```json
{"ok":true,"status":"ok","success":true,"plugins":13}
```

Frontend probe:

```text
HTTP/1.1 200 OK
```

## 142 Image Findings

The initial main image was:

```text
ghcr.io/zensgit/metasheet2-backend:2f42bab1430c4db650c654f6c21e5a3515a4e187
ghcr.io/zensgit/metasheet2-web:2f42bab1430c4db650c654f6c21e5a3515a4e187
```

I switched main briefly to the already-built Agent ID API image:

```text
ghcr.io/zensgit/metasheet2-backend:9129dae6678e623ff1df2e0d0121d5882199e9ef
ghcr.io/zensgit/metasheet2-web:9129dae6678e623ff1df2e0d0121d5882199e9ef
```

That image started and passed backend health and frontend HTTP 200 after startup. During verification, an external deployment process changed `.env IMAGE_TAG` several times and finally settled the main stack on:

```text
ghcr.io/zensgit/metasheet2-backend:bd3986143ad7be205982733a8bc553ac479f5436
ghcr.io/zensgit/metasheet2-web:bd3986143ad7be205982733a8bc553ac479f5436
```

I did not continue overwriting this external deployment, to avoid fighting a parallel production rollout.

## 142 Agent ID API Smoke

Admin token generation was performed inside the running main backend container and verified with the app `AuthService`. The token value was written only to a temporary file and removed after the probe.

Current `bd398614...` main image result:

```json
{
  "file": "status.json",
  "status": "blocked",
  "failures": [
    {
      "code": "STATUS_API_FAILED",
      "httpStatus": 404,
      "message": "Cannot GET /api/admin/directory/dingtalk/work-notification"
    }
  ],
  "agentIdLength": 0,
  "agentIdValuePrinted": false
}
```

Empty private Agent ID file path result:

```json
{
  "file": "empty-agent-save.json",
  "status": "blocked",
  "failures": [
    { "code": "STATUS_API_FAILED", "httpStatus": 404 },
    { "code": "AGENT_ID_FILE_EMPTY" }
  ],
  "agentIdLength": 0,
  "agentIdValuePrinted": false
}
```

Conclusion:

- The helper works locally and on 142 as an operational wrapper.
- 142 main is healthy, but the currently deployed image does not contain the new Agent ID admin API.
- Real Agent ID acceptance is blocked by the deployed image tag, not by helper logic.
- After the image tag is coordinated, the remaining real configuration blocker is filling `/home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt` or using the frontend admin page to save Agent ID.

## Next Verification Command

After deploying an image that contains the Agent ID API:

```bash
node /tmp/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/admin.jwt \
  --agent-id-file /home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt \
  --save \
  --output-json /tmp/dingtalk-agent/save.json \
  --output-md /tmp/dingtalk-agent/save.md
```

Expected pass criteria:

- `status=pass`
- `testResult.accessTokenVerified=true`
- `saveResult.saved=true`
- `statusAfter.available=true`
- `agentId.valuePrinted=false`
