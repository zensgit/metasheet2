# DingTalk Agent ID Mainline Integration Design

Date: 2026-05-08

## Goal

Move the DingTalk work-notification Agent ID feature from the Codex feature branch onto current `origin/main` so the 142 main deployment can build an image that contains:

- Work-notification runtime status.
- Admin API to test and save Agent ID.
- Frontend directory-management Agent ID configuration entry.
- Release-gate and acceptance helpers.

## Root Cause

142 main was healthy on `origin/main`, but authenticated calls to:

```text
GET /api/admin/directory/dingtalk/work-notification
```

returned `404 Cannot GET ...`.

That showed the deployed main image did not contain the Agent ID admin API. The feature existed only on:

```text
codex/dingtalk-directory-return-banner-tests-20260505
```

## Mainline Strategy

Created integration branch:

```text
codex/dingtalk-agent-id-mainline-20260508
```

Base:

```text
origin/main
```

Cherry-picked feature commits:

```text
8f5bd7f4b  feat(dingtalk): surface work notification env status
78d3e86bb  chore(dingtalk): add work notification agent id apply helper
b32b97594  chore(dingtalk): initialize work notification agent id file
c33d8969b  chore(dingtalk): add work notification release gate
9129dae66  feat(dingtalk): add admin Agent ID work notification config
348e55e46  chore(dingtalk): add admin Agent ID acceptance helper
```

## Conflict Policy

Two conflicts appeared:

- `apps/web/src/views/DirectoryManagementView.vue`
- `packages/core-backend/src/multitable/automation-executor.ts`

Resolution:

- Kept current `origin/main` behavior where unrelated group-failure-alert logic was not present.
- Added only the Agent ID UI/status/save/test surface to the directory management page.
- Kept the automation runtime change that reads DingTalk work-notification config from runtime/store instead of env-only config.
- Did not bring the large `d8a47297c` group-failure-alert commit or broad multitable/governance docs into the mainline branch.

## Delivery Scope

Included:

- Backend work-notification runtime settings.
- Admin directory routes for status/test/save.
- Directory integration storage boundary that prevents generic create/update from writing Agent ID.
- Frontend Agent ID entry, validation test button, and save button.
- Release gate and admin acceptance helper scripts.
- Targeted unit tests and operational docs.

Excluded:

- Broad DingTalk group-failure-alert rollout.
- Multitable Feishu/field-type work.
- Unrelated integration-core and staging documentation.
- Secrets, webhook URLs, Agent ID values, or admin JWT values.

## 142 Next Step

After this branch builds GHCR images, deploy 142 main with the new SHA, then run:

```bash
node /tmp/dingtalk-work-notification-admin-agent-id.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/admin.jwt \
  --status-only \
  --output-json /tmp/dingtalk-agent/status.json \
  --output-md /tmp/dingtalk-agent/status.md
```

Expected first result before filling Agent ID:

- API should return `200` with a redacted status payload.
- Runtime may report `missing_agent_id`.

After filling the private file:

```text
/home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt
```

run the same helper with `--agent-id-file ... --save`.

## Final Release Design Notes

During release, `origin/main` advanced again after the first integration image
was built. To avoid rolling back unrelated mainline changes, the integration
branch was rebased onto the latest observed main:

```text
06f71465ac55843431f7d5de7eea00fd7eb1a5d2
```

The final deployable Agent ID image tag is:

```text
9e17038871ff4a0cbdb32d8c816692f10d1f92cb
```

142 also had concurrent external deployments that temporarily moved the main
containers through other mainline tags. The release policy used here was:

- Do not fight an active external deploy process.
- Wait for 142 to settle on the latest main tag.
- Rebase Agent ID work onto that latest main.
- Build immutable GHCR images from the rebased branch.
- Manually switch only `metasheet-backend` and `metasheet-web`.
- Keep the immediately previous main tag as the rollback baseline.

The 142 disk filled during image pulls because many old GHCR backend/web images
were retained. The cleanup deliberately removed only unused `metasheet2`
backend/web GHCR image tags, preserving running images plus the current and
rollback baselines. No database volumes, Redis data, or application uploads were
removed.
