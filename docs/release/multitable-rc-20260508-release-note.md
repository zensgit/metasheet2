# Multitable RC Release Note - 2026-05-08

## Candidate

- RC tag proposal: `multitable-rc-20260508-1b06bf286`
- Source commit: `1b06bf286915b4eafc4d5d0287f5ce6ad95cbd9b`
- Staging host: `staging/142`
- Staging image tag: `1b06bf286915b4eafc4d5d0287f5ce6ad95cbd9b`

## Included Scope

This RC covers the current Multitable Feishu-parity release candidate after the
RC smoke, hardening, and staging blocker fixes.

Major verified surfaces:

- Basic multitable lifecycle.
- Public form submission and rotated-token behavior.
- Hierarchy view cycle guard.
- Gantt dependency configuration validation.
- Formula field persistence.
- Automation `send_email` execution and log persistence.
- AutoNumber backfill and raw-write rejection.

Recent staging blockers resolved before this RC:

- PR `#1435` / commit `4fae7dc32d1a2b3ed6241c675bc3ec4c0729f72d`:
  `send_email` was accepted by application code but rejected by the database
  `automation_rules.chk_automation_action_type` constraint.
- Automation execution logs could crash persistence on JSONB `steps` insertion.
  This was fixed by PR `#1436` / commit
  `1b06bf286915b4eafc4d5d0287f5ce6ad95cbd9b`.

## Verification

Automated staging verification:

```text
pnpm verify:multitable-rc:staging
```

Result on 142 staging:

```text
7 pass / 0 fail / 0 skip / 7 total
```

Per-check result:

| Check | Status |
| --- | --- |
| lifecycle | pass |
| public-form | pass |
| hierarchy | pass |
| gantt-config | pass |
| formula | pass |
| automation-email | pass |
| autoNumber-backfill | pass |

Evidence artifact:

- `docs/development/multitable-rc-staging-142-verification-20260508.md`
- `docs/development/artifacts/multitable-rc-staging-142-20260508/report.json`
- `docs/development/artifacts/multitable-rc-staging-142-20260508/report.md`

## Known Limits

- This RC note records automated API-level staging verification. Manual browser
  visual sign-off is still useful for final product confidence, especially for
  table layout, Gantt rendering, hierarchy interactions, and formula editor UX.
- The staging harness creates timestamped test data and does not clean it up.
- The harness validates the mocked/default email delivery path by execution log
  output, not delivery to an external SMTP inbox.

## Rollback

Preferred rollback posture:

- Prefer a forward bugfix over image rollback for this RC, because the previous
  image before `#1436` is known to reintroduce the automation execution-log
  crash when `send_email` rules run.
- If rollback is required, the release owner must choose the rollback image and
  confirm whether `send_email` automations are allowed to keep running.

Partial rollback target:

- `4fae7dc32d1a2b3ed6241c675bc3ec4c0729f72d` is only a partial rollback target
  for issues isolated to `#1436`. It still contains `send_email` support and is
  known to crash the automation execution-log path for triggered `send_email`
  rules.

Rollback preconditions:

1. Backend and web images must be rolled as a matched tag pair.
2. If rolling to an image before `#1436`, disable or quarantine active
   `send_email` automation rules before restart.
3. Leave the `#1435` widened CHECK constraint migration in place unless a
   separate database rollback plan explicitly handles existing `send_email`
   rows.

Rollback procedure:

1. Set `IMAGE_TAG` in the 142 deployment environment to the selected prior
   image tag.
2. Run `docker-compose -f docker-compose.app.yml pull`.
3. Run `docker-compose -f docker-compose.app.yml up -d`.
4. Verify `/api/health`.
5. Re-run `pnpm verify:multitable-rc:staging` or a scoped equivalent for the
   rollback target.

Data note:

- The `#1435` migration expands an allowed CHECK constraint value and is safe to
  leave in place for forward-compatible rows. Rolling application code to a
  version that does not understand `send_email` while leaving active
  `send_email` rules enabled is not safe.

Rollback success criteria:

- `/api/health` returns healthy.
- The selected staging smoke or scoped rollback smoke returns `0` failures.
- Abort rollback completion if any smoke check fails or if backend logs show
  automation execution-log persistence errors.

## RC Decision

Automated staging signal: `GO`.

Recommended gate before broad rollout:

- Keep the branch in bugfix-only mode.
- Run a short manual browser smoke for visual/product confidence if the release
  owner requires UI sign-off.
- If no blocker is found, tag `multitable-rc-20260508-1b06bf286`.
