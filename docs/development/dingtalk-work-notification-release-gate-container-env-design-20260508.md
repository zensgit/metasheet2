# DingTalk Work Notification Release Gate — Container Env Skip Option Design (2026-05-08)

## Background

After PR #1430 merged, host-side runs of `scripts/ops/dingtalk-work-notification-release-gate.mjs` on 142 reported `ENV_STATUS_BLOCKED` for app key and app secret even though the backend runtime admin API correctly considered the work-notification channel available except for Agent ID.

Reason: on 142 the real DingTalk runtime envs (`DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`) live inside the backend container's process environment — injected at container start from a private secrets bundle — and are not present in `/home/mainuser/metasheet2/.env`. The host-side env-status helper only inspects host env files, so it cannot see container-side envs and falsely flags them as missing.

Two truths coexist on 142:

- Host env-status helper: `blocked` (host env file does not contain app key / app secret).
- Backend admin runtime API: `available=false` only because `agent_id` is unset.

The previous override path in the release gate (`runtimeStatusOverridesEnvStatus`) only kicks in when the runtime API reports `available=true`. While the Agent ID is still missing, that override cannot fire, so ops were getting an extra noisy `ENV_STATUS_BLOCKED` failure code that does not reflect the real production state.

## Goal

Give ops a redaction-safe way to opt out of the host env-status check when they know the runtime envs live in the backend container, while keeping every other check (health, auth, admin runtime status) intact and the default behavior unchanged.

## Non-Goals

- Do not read `.env`, `.secrets`, token, webhook, recipient, or remote server files.
- Do not change how the env-status helper itself works.
- Do not auto-detect the container-env case; this stays explicit because it is an ops decision.

## Change

Add a `--skip-env-status` flag to `scripts/ops/dingtalk-work-notification-release-gate.mjs`.

When the flag is set:

- The env-status helper subprocess is not invoked.
- No `env-status.json` / `env-status.md` artifact is produced.
- The summary records `envStatus.skipped=true`, `envStatus.overallStatus="not_applicable"`, and `envStatus.reason="skip_env_status_flag"`.
- `ENV_STATUS_BLOCKED` and `ENV_STATUS_HELPER_FAILED` are suppressed because both depend on `envStatus.skipped===false`.
- Health, auth, and admin runtime workNotification checks run unchanged, so a missing Agent ID still produces `WORK_NOTIFICATION_UNAVAILABLE`.

When the flag is not set, behavior is identical to today.

### JSON shape

The change is additive:

- `summary.skipEnvStatus`: boolean.
- `summary.envStatus.skipped`: boolean (also added to the non-skipped path so the shape is consistent for downstream consumers).
- `summary.envStatus.overallStatus`: stays a string. In the skipped path it is `"not_applicable"`.

### Markdown rendering

Adds an `Env Status Skipped: \`true\`` header line and renders the env-status check value as `skipped` in the Checks section. The Evidence section omits env-status JSON / MD paths in the skipped path.

## Security

The flag is purely a control-flow toggle:

- No new file IO. The script still does not read `.env`, `.secrets`, token, webhook, or remote server files.
- No new logging. Bearer token, webhook, robot `SEC` secret, JWT, and access-token redaction paths are unchanged.
- `--skip-env-status` is independent of `--skip-admin-api`. Combining the two requires no token, but downgrades the gate to a pure health check; ops should only use that combination intentionally.

## 142 Usage

```bash
node /tmp/dingtalk-work-notification-release-gate.mjs \
  --status-helper /tmp/dingtalk-work-notification-env-status.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/metasheet-142-admin-2h-20260508.jwt \
  --user-id b928b8d9-8881-43d7-a712-842b28870494 \
  --skip-env-status \
  --allow-blocked \
  --output-json /tmp/dingtalk-work-notification-release-gate/summary.json \
  --output-md /tmp/dingtalk-work-notification-release-gate/summary.md
```

Expected before Agent ID is configured: `status=blocked`, single failure `WORK_NOTIFICATION_UNAVAILABLE` (`unavailableReason=missing_agent_id`).

After Agent ID is configured: rerun the same command without `--allow-blocked`. Expected status: `pass`.
