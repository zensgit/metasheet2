# Global History — staging flag enablement operator checklist (2026-07-01)

This is an operator checklist for staging/sandbox flag enablement. Canonical source remains current main plus the
existing `multitable-global-history-*` docs; this note does not create a new design authority and does not authorize
production enablement.

## Scope

This checklist covers staging/sandbox operation for the four Global History flags already smoke-verified in
`multitable-global-history-staging-flag-smoke-20260701.md`:

- `MULTITABLE_ENABLE_SHEET_CONFIG_REVERT=true`
- `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT=true`
- `MULTITABLE_ENABLE_PIT_RESET=true`
- `MULTITABLE_ENABLE_PIT_UNDELETE=true`

It also records the safety guard for `MULTITABLE_META_REVISION_RETENTION_ENABLED`: keep it absent/off while
`MULTITABLE_ENABLE_PIT_RESET=true` unless the owner explicitly accepts that revert-undo becomes time-windowed.

Production flags, product rollout scope, and the history-anchored Reset T-source upgrade remain separate owner
decisions.

## Preconditions

Before enabling or re-enabling the flags on staging:

1. Confirm the backend and web containers are on the intended Global History-capable image. The 2026-07-01 smoke used:
   - `ghcr.io/zensgit/metasheet2-backend:925932837965c7e95fa2974dcdbc3a539581bf9b`
   - `ghcr.io/zensgit/metasheet2-web:925932837965c7e95fa2974dcdbc3a539581bf9b`
2. Confirm health is `status=ok` for the running backend.
3. Confirm `MULTITABLE_META_REVISION_RETENTION_ENABLED` is absent/off before enabling `MULTITABLE_ENABLE_PIT_RESET`.
4. Confirm the target is staging/sandbox, not production.
5. Keep rollback ready: either a backup of the staging override file or a known-good edit that removes the four flags.

## Read-only status helper

Use the helper to inspect the running containers and the allowed flag set without dumping secrets:

```bash
METASHEET_STATUS_SSH_HOST=mainuser@<staging-host> \
  node scripts/ops/multitable-global-history-flag-status.mjs
```

Optional health check, if a local tunnel is already open:

```bash
METASHEET_STATUS_SSH_HOST=mainuser@<staging-host> \
METASHEET_STATUS_HEALTH_URL=http://127.0.0.1:18900/health \
  node scripts/ops/multitable-global-history-flag-status.mjs --strict
```

The helper returns non-zero for stop conditions such as:

- backend or web container not running;
- health check not OK;
- `MULTITABLE_ENABLE_PIT_RESET=true` together with `MULTITABLE_META_REVISION_RETENTION_ENABLED=true`;
- backend/web image mismatch when `--strict` is used.

It prints only these keys from the backend container environment:

- `MULTITABLE_ENABLE_SHEET_CONFIG_REVERT`
- `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT`
- `MULTITABLE_ENABLE_PIT_RESET`
- `MULTITABLE_ENABLE_PIT_UNDELETE`
- `MULTITABLE_META_REVISION_RETENTION_ENABLED`

## Enablement procedure

On staging, keep the compose chain explicit:

```text
/home/mainuser/metasheet2-dingtalk-staging/docker-compose.app.staging.yml
/home/mainuser/docker-compose.v12-hotpatch.override.yml
/home/mainuser/metasheet2-staging-t9w.override.yml
```

The override should pin both images and carry only the intended staging flags:

```yaml
services:
  backend:
    image: ghcr.io/zensgit/metasheet2-backend:<verified-image-tag>
    environment:
      MULTITABLE_ENABLE_SHEET_CONFIG_REVERT: "true"
      MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: "true"
      MULTITABLE_ENABLE_PIT_RESET: "true"
      MULTITABLE_ENABLE_PIT_UNDELETE: "true"
  web:
    image: ghcr.io/zensgit/metasheet2-web:<verified-image-tag>
```

Then restart the affected services with the same compose chain:

```bash
docker compose \
  -f /home/mainuser/metasheet2-dingtalk-staging/docker-compose.app.staging.yml \
  -f /home/mainuser/docker-compose.v12-hotpatch.override.yml \
  -f /home/mainuser/metasheet2-staging-t9w.override.yml \
  up -d backend web
```

Run the status helper after restart. Stop if any stop condition appears.

## Smoke checks

### T9-W low-risk flags

Browser smoke:

1. Open a throwaway multitable sheet.
2. Change a supported sheet config value.
3. Open the config-history modal.
4. Preview and confirm the supported revert.
5. Confirm the current config value returned to the target value.
6. Confirm a `meta_config_revisions` row exists with `source='restore'` and `restored_from_id` pointing to the reverted
   revision.

This checks the product path. It does not expand the supported revert set.

### PIT_RESET

Use the committed harness:

```bash
BASE_URL=http://127.0.0.1:18082 \
ADMIN_TOKEN=<sheet-admin-jwt> \
EDITOR_TOKEN=<record-editor-jwt> \
  node packages/core-backend/scripts/reset-acceptance.mjs
```

Expected flag-on result with the default ceiling:

```text
summary: 10 passed, 0 failed, 1 skipped
```

The skipped case is the optional 413 ceiling check unless `RESET_MAX_RECORDS=<small>` matches the environment ceiling.
After the happy path, manually confirm once that post-T records landed in `meta_records_trash` rather than being hard
deleted. The 2026-07-01 evidence confirmed this for the staging run.

### PIT_UNDELETE

There is no committed operator harness equivalent to `reset-acceptance.mjs` yet. Until one exists, use a throwaway
fixture equivalent to the 2026-07-01 evidence:

1. Create a deleted record `U` with create/delete revisions and no live row.
2. Create a live record `L`.
3. Ensure `U`'s T-snapshot links outbound to `L`.
4. Run `revert-preview` at T and verify `visibleUndeleteCount=1`, `undeleteSupported=true`, and an executable identity.
5. Run execute without confirm and expect `400 CONFIRM_REQUIRED`.
6. Run execute with `confirm:"undelete"` and expect resurrection.
7. Confirm the live row data, outbound `meta_links` rebuild, and `meta_record_revisions.source='restore'`.

Clean the throwaway base/sheet/records/revisions/links immediately after the check.

## Rollback

1. Remove the four Global History flags from the staging override, or set them to anything other than `"true"`.
2. Restart the backend. Restart web too if the rollback also changes the image.
3. Run the status helper and confirm the four flags are absent/off.
4. Re-run a minimal flag-off probe for the affected route. For example, `reset-preview` should return
   `403 RESET_DISABLED` when `MULTITABLE_ENABLE_PIT_RESET` is off.

No data migration is required for rollback.

## Stop conditions

Stop and do not broaden rollout if any of these occurs:

- target host or compose chain is not staging/sandbox;
- backend or web image is not the intended verified image;
- health is not OK after restart;
- `MULTITABLE_ENABLE_PIT_RESET=true` and `MULTITABLE_META_REVISION_RETENTION_ENABLED=true`;
- reset acceptance has any failure;
- T9-W browser smoke cannot find the config-history entry on a verified web image;
- PIT_UNDELETE smoke lacks `CONFIRM_REQUIRED`, `source='restore'`, or outbound link rebuild evidence;
- cleanup cannot isolate the throwaway fixture from real user data.

## Cleanup notes

Use unique prefixes for smoke fixtures and delete only those prefixes. The 2026-07-01 pass cleaned the latest
PIT_RESET/T9-W/PIT_UNDELETE fixtures and observed older `RESET-ACCEPT ...` residue from previous runs; do not bulk-delete
unreviewed historical residues unless they are explicitly tied to a smoke prefix and owner-approved.
