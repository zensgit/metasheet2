# Global History — staging flag smoke evidence (2026-07-01)

This is a dated staging evidence note. Canonical source remains current main plus the existing
`multitable-global-history-*` docs; this note records one live staging pass and does not create a new design authority.

## Environment

- Target: dingtalk staging, accessed through a local SSH tunnel.
- Backend image: `ghcr.io/zensgit/metasheet2-backend:925932837965c7e95fa2974dcdbc3a539581bf9b`
- Web image before this pass: `ghcr.io/zensgit/metasheet2-web:be16791d5afa2e52d50889e9661b052ed81cde13`
- Web image after correction: `ghcr.io/zensgit/metasheet2-web:925932837965c7e95fa2974dcdbc3a539581bf9b`
- Health after correction: `status=ok`, build commit `925932837965c7e95fa2974dcdbc3a539581bf9b`, created `2026-07-01T05:26:38Z`
- Staging override used for this pass:
  - `/home/mainuser/metasheet2-dingtalk-staging/docker-compose.app.staging.yml`
  - `/home/mainuser/docker-compose.v12-hotpatch.override.yml`
  - `/home/mainuser/metasheet2-staging-t9w.override.yml`

## Enabled staging flags

The backend container environment was verified with:

- `MULTITABLE_ENABLE_SHEET_CONFIG_REVERT=true`
- `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT=true`
- `MULTITABLE_ENABLE_PIT_RESET=true`
- `MULTITABLE_ENABLE_PIT_UNDELETE=true`

`MULTITABLE_META_REVISION_RETENTION_ENABLED` was not present in the backend container env during this pass.

No production flag was changed.

## T9-W low-risk flags — browser smoke

### Precondition correction

The backend was already on `925932837...`, but the staging web container was still on `be16791d...`. The old bundle did
not contain the config-history UI entry (`open-config-history` / `config-history-revert`), so a browser pass would have
falsely reported the feature as absent.

The staging override was updated to pin the web image to `925932837...`, then only the web service was restarted. After
that, the bundle contained the config-history UI code and the workbench toolbar exposed `配置历史`.

### Browser flow

An isolated smoke base/sheet was provisioned, then exercised through the in-app browser:

1. Opened the smoke workbench.
2. Verified toolbar action `配置历史` was visible.
3. Opened the config-history modal.
4. Clicked the single `撤销` action for a `sheet_config` update.
5. Verified the preview/confirm modal rendered and `确认撤销` was enabled.
6. Confirmed the revert.

### DB evidence

After confirm:

- Current `meta_sheets.conditional_read_rules` returned to the target value containing `ui-target-before`.
- `meta_config_revisions` contained a new row with:
  - `source='restore'`
  - `changed_keys={conditionalReadRules}`
  - `restored_from_id` pointing to the original mutation revision.

The isolated smoke base/sheet/user/session was cleaned up. Post-cleanup residue for the smoke base/sheet/config
revision/session/user set was `0`.

## PIT_RESET — staging API smoke

Harness: `packages/core-backend/scripts/reset-acceptance.mjs`

The harness was run with the flag ON, using temporary staging smoke users and sessions. Result:

```text
summary: 10 passed, 0 failed, 1 skipped
```

Passed scenarios:

- editor `reset-preview` -> `403` sheet-admin gate
- execute without `confirm:"reset"` -> `400`
- post-preview new record drift -> `409`, zero writes
- locked post-T target -> `409 RESET_BLOCKED`, zero writes
- happy path execute -> `2xx`
- preview reported the post-T delete-set
- post-T records left the live delete-set after reset
- survivors had no pending reverts at T after reset

Skipped scenario:

- ceiling `413` was skipped because no small `RESET_MAX_RECORDS` matching staging's runtime ceiling was set for this
  run. This is the existing harness behavior when the default ceiling is too large to seed cheaply.

Additional DB check:

- The latest harness base `RESET-ACCEPT 1782890719351` had `3` `meta_records_trash` rows before cleanup, confirming the
  happy-path delete-set was soft-deleted into trash rather than hard-deleted.

The latest harness base/sheet/trash/revisions were cleaned up. Post-cleanup check returned `reset_bases=0`.

## PIT_UNDELETE — staging API smoke

Because there is no committed operator harness equivalent to `reset-acceptance.mjs`, this pass used a one-off live API
smoke against staging with direct DB fixture setup and cleanup.

Fixture:

- A record `U` existed at `T1`, had create/delete revisions, and had no live row.
- A live record `L` existed.
- `U`'s T-snapshot linked outbound to `L`.

Live API flow:

1. `POST /api/multitable/sheets/:sheetId/revert-preview` at `T1`.
2. Verified preview returned `200`, `visibleUndeleteCount=1`, `undeleteSupported=true`, and an executable identity.
3. `POST /api/multitable/sheets/:sheetId/revert-execute` without confirm.
4. Verified `400 CONFIRM_REQUIRED`.
5. Re-ran execute with `confirm:"undelete"`.
6. Verified `2xx` and `resurrectedCount=1`.

DB evidence:

- The resurrected live row was restored from the T-snapshot (`u-at-T1`).
- The outbound `meta_links` edge `U -> L` was rebuilt.
- Inbound links to `U` remained absent, matching the design choice.
- A `meta_record_revisions` row with `action='create'` and `source='restore'` was recorded.

Result:

```text
summary: 9 passed, 0 failed
cleanup residue: 0,0,0
```

## Cleanup

Cleaned after this pass:

- T9-W browser smoke base/sheet/field/view/config revisions/session/user.
- Latest PIT_RESET harness base/sheet/trash/revisions (`RESET-ACCEPT 1782890719351`).
- PIT_UNDELETE live API smoke base/sheet/records/revisions/links.
- Temporary staging smoke users/sessions.
- Local temporary token and one-off harness files.
- Local SSH tunnel.

Older `RESET-ACCEPT ...` residues from previous runs were observed but not cleaned in this pass.

## Conclusion

Staging is now verified for:

- T9-W low-risk config restore flags through the browser UI and DB evidence.
- PIT_RESET flag-on API behavior through the committed harness, with trash landing confirmed for the latest run.
- PIT_UNDELETE flag-on API behavior through a live staging smoke, including outbound link rebuild and restore revision.

This evidence supports continued staging/sandbox enablement. Production enablement remains a separate owner decision.
