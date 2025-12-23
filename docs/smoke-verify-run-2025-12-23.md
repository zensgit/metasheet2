# Smoke Verify Report (2025-12-23)

## Scope
- Workflow: Smoke Verify (smoke-verify.yml)
- Branch: main
- Commit: 0f65b7a793f00ae0f424b2313cc095ca48360756

## Result
- Status: completed
- Conclusion: success
- Run: https://github.com/zensgit/metasheet2/actions/runs/20457346056
- Started: 2025-12-23T09:49:15Z
- Finished: 2025-12-23T09:50:18Z

## CI Artifacts
- Artifact path: `/private/tmp/metasheet2-ci/artifacts/ci-20457346056/smoke-verify`
- smoke-report.json: ok=true
- Checks:
  - api.health: ok (200)
  - api.dev-token: ok (200)
  - api.spreadsheets: skipped
  - web.home: skipped

## Local Verification
- Workspace: `/Users/huazhou/Downloads/Github/metasheet2`
- Fix applied: `scripts/verify-smoke-core.mjs` accepts `id="app"` as a valid marker
- Attempt 1 (existing DB `metasheet_smoke`) failed during migrations:
  - Error: migration order mismatch (`20251216000001_create_dlq_table` vs `20251211_initial_meta_schema`)
  - Artifact path: `artifacts/smoke-local-v3`
- Attempt 2 (fresh DB `metasheet_smoke_v2`) succeeded:
  - Command: `SMOKE_DATABASE_URL=postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet_smoke_v2 ./scripts/verify-smoke.sh`
  - Result: success
  - Artifact path: `artifacts/smoke-local-v4`
  - smoke-report.json: ok=true
- Enhancement: added `api.univer-meta.sheets`, `api.univer-meta.fields`, `api.univer-meta.views` smoke checks
- Added `api.univer-meta.records-summary` check (requires `sheetId`)
- Attempt with missing `sheetId` failed (400); fixed by using the first sheet ID when available
- If no sheets exist, the records-summary check is marked as skipped
- Re-run (same DB) succeeded:
  - Command: `SMOKE_DATABASE_URL=postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet_smoke_v2 ./scripts/verify-smoke.sh`
  - Result: success
  - Artifact path: `artifacts/smoke-local-v8`
  - smoke-report.json: ok=true

## Notes
- This run supersedes earlier failures on 2025-12-23.
- Local verification used a fresh smoke database to avoid migration drift.
