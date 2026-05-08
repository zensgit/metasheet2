# DingTalk Work Notification Agent ID Apply Verification (2026-05-08)

## Summary

Added a redaction-safe helper for the remaining 142 work-notification configuration step. The helper can apply `DINGTALK_AGENT_ID` from a private file, create a backup, optionally restart backend, and emit evidence without printing the value.

142 was not changed in this verification because the real DingTalk agent id value is still not available in the workspace or chat. A private fill-in file was prepared on 142 for the operator-provided value.

## Local Verification

Syntax check:

```bash
node --check scripts/ops/dingtalk-work-notification-agent-id-apply.mjs
```

Result: passed.

Unit tests:

```bash
node --test scripts/ops/dingtalk-work-notification-agent-id-apply.test.mjs
```

Result: passed, 6 tests.

Covered cases:

- Missing agent id is appended as `DINGTALK_AGENT_ID`.
- `--dry-run` writes evidence without changing env file.
- Existing `DINGTALK_NOTIFY_AGENT_ID` alias is reused.
- Different existing value is blocked unless `--force` is used.
- `--force` creates a backup before replacement.
- Empty and non-numeric agent id files are rejected.
- Console output and `summary.json/md` do not contain the agent id value.

Scoped leak scan:

```bash
rg -n "(oapi\\.dingtalk\\.com/robot/send\\?access_token=|SEC[A-Za-z0-9]{16,}|eyJ[a-zA-Z0-9_-]{20,}\\.|access_token=[A-Za-z0-9]{20,})" \
  scripts/ops/dingtalk-work-notification-agent-id-apply.mjs \
  scripts/ops/dingtalk-work-notification-agent-id-apply.test.mjs \
  docs/development/dingtalk-work-notification-agent-id-apply-design-20260508.md \
  docs/development/dingtalk-work-notification-agent-id-apply-verification-20260508.md
```

Result: no matches.

Whitespace check:

```bash
git diff --check -- \
  scripts/ops/dingtalk-work-notification-agent-id-apply.mjs \
  scripts/ops/dingtalk-work-notification-agent-id-apply.test.mjs \
  docs/development/dingtalk-work-notification-agent-id-apply-design-20260508.md \
  docs/development/dingtalk-work-notification-agent-id-apply-verification-20260508.md
```

Result: passed.

## 142 Verification

Current status helper result remains:

- Overall Status: `blocked`
- App key: present via `DINGTALK_CLIENT_ID`
- App secret: present via `DINGTALK_CLIENT_SECRET`
- Agent id: missing

Helper install check:

```bash
scp scripts/ops/dingtalk-work-notification-agent-id-apply.mjs \
  metasheet-142:/tmp/dingtalk-work-notification-agent-id-apply.mjs
ssh metasheet-142 'node --check /tmp/dingtalk-work-notification-agent-id-apply.mjs'
```

Result: passed.

Prepared private input path on 142:

```bash
/home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt
```

Result:

- File exists.
- File size: `0` bytes.
- File mode: `600`.
- Parent directory mode: `700`.

The file is intentionally empty and mode-restricted. The operator should put only the numeric DingTalk agent id in that file, then run the apply helper.

Remote dry-run smoke used only dummy values under `/tmp` and did not modify production env:

```bash
ssh metasheet-142 'node /tmp/dingtalk-work-notification-agent-id-apply.mjs \
  --env-file /tmp/dingtalk-agent-id-apply-smoke/app.env \
  --agent-id-file /tmp/dingtalk-agent-id-apply-smoke/agent-id.txt \
  --dry-run \
  --output-json /tmp/dingtalk-agent-id-apply-smoke/summary.json \
  --output-md /tmp/dingtalk-agent-id-apply-smoke/summary.md'
```

Result:

- `status=pass`
- `action=would_update`
- `dryRun=true`
- `targetKey=DINGTALK_AGENT_ID`
- `agentIdLength=9`

## Final Apply Command

After filling the private file on 142:

```bash
node /tmp/dingtalk-work-notification-agent-id-apply.mjs \
  --env-file /home/mainuser/metasheet2/docker/app.env \
  --agent-id-file /home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt \
  --restart-backend \
  --compose-file /home/mainuser/metasheet2/docker-compose.app.yml \
  --output-json /tmp/dingtalk-work-notification-agent-id-apply/summary.json \
  --output-md /tmp/dingtalk-work-notification-agent-id-apply/summary.md
```

Then confirm readiness:

```bash
node /tmp/dingtalk-work-notification-env-status.mjs \
  --env-file /home/mainuser/metasheet2/docker/app.env \
  --env-file /home/mainuser/metasheet2/.env
```

Expected state after the real agent id is applied: `Overall Status: ready`, and the admin user DingTalk access API should report `workNotification.available=true`.
