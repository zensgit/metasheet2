# DingTalk Work Notification Agent ID Apply Design (2026-05-08)

## Goal

Provide a safe final-step helper for the 142 DingTalk work-notification blocker: app key and app secret are already present, but `DINGTALK_AGENT_ID` or `DINGTALK_NOTIFY_AGENT_ID` is missing.

The helper lets operations initialize a private fill-in file, place the real agent id in that file, and apply it to the runtime env without pasting the value into chat, shell history, Git, or evidence markdown.

## Scope

- Add `scripts/ops/dingtalk-work-notification-agent-id-apply.mjs`.
- Add focused Node tests for file initialization, apply, dry-run, conflict protection, forced replacement, and invalid input.
- Keep `scripts/ops/dingtalk-work-notification-env-status.mjs` read-only.
- Do not call DingTalk APIs or validate the credential remotely; the existing status helper remains the readiness gate after restart.

## Behavior

The helper supports two modes.

Initialization mode:

- `--init-agent-id-file <file>`: create an empty `0600` file and a `0700` parent directory.
- `--force`: overwrite an existing file only when explicitly requested.

Apply mode requires:

- `--env-file <file>`: the env file to update.
- `--agent-id-file <file>`: a local file containing only the numeric DingTalk agent id.

Default target key is `DINGTALK_AGENT_ID`. If the env file already uses `DINGTALK_NOTIFY_AGENT_ID`, the helper reuses that alias to avoid creating duplicate agent id keys.

Before writing, the helper:

- Validates the agent id is non-empty and numeric.
- Detects existing agent id values.
- Blocks replacement of a different existing value unless `--force` is passed.
- Creates an env-file backup before modification.
- Writes redaction-safe `summary.json` and `summary.md`.

Optional `--restart-backend` runs:

```bash
docker compose -f <compose-file> up -d --no-deps --force-recreate <service>
```

The restart path records only command metadata and output lengths, never credential values.

## Security Boundary

- No `--agent-id <value>` option is provided to avoid shell history leaks.
- Console output and summaries include only key name, status, and length.
- The env file and backup are expected to remain on the deployment host and outside Git.
- Real webhook URLs, robot `SEC` secrets, JWTs, app secrets, and access tokens are not accepted or printed by this helper.

## 142 Usage

On 142, initialize the private file:

```bash
node /tmp/dingtalk-work-notification-agent-id-apply.mjs \
  --init-agent-id-file /home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt
```

Then fill that file with only the numeric agent id.

Then apply and restart:

```bash
node /tmp/dingtalk-work-notification-agent-id-apply.mjs \
  --env-file /home/mainuser/metasheet2/docker/app.env \
  --agent-id-file /home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt \
  --restart-backend \
  --compose-file /home/mainuser/metasheet2/docker-compose.app.yml \
  --output-json /tmp/dingtalk-work-notification-agent-id-apply/summary.json \
  --output-md /tmp/dingtalk-work-notification-agent-id-apply/summary.md
```

After restart, rerun:

```bash
node /tmp/dingtalk-work-notification-env-status.mjs \
  --env-file /home/mainuser/metasheet2/docker/app.env \
  --env-file /home/mainuser/metasheet2/.env
```

Expected final state: `Overall Status: ready`.
