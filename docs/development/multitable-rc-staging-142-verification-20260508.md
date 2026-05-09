# Multitable RC Staging 142 Verification - 2026-05-08

## Scope

This is a verification-only artifact for the 142 staging deployment after the
`send_email` automation action fixes landed.

Validated fixes:

- PR `#1435` / commit `4fae7dc32d1a2b3ed6241c675bc3ec4c0729f72d`:
  database CHECK constraint includes `send_email`.
- PR `#1436` / commit `1b06bf286915b4eafc4d5d0287f5ce6ad95cbd9b`:
  automation execution log persists JSONB steps without crashing the backend.

No source code was changed in this verification run.

## Deployment Evidence

Target:

- Host: `staging/142`
- Backend local API: `http://127.0.0.1:8900`
- Verification access path: SSH local port forward to backend local API

Observed deployment state:

- `IMAGE_TAG=1b06bf286915b4eafc4d5d0287f5ce6ad95cbd9b`
- Backend image: `ghcr.io/zensgit/metasheet2-backend:1b06bf286915b4eafc4d5d0287f5ce6ad95cbd9b`
- Web image: `ghcr.io/zensgit/metasheet2-web:1b06bf286915b4eafc4d5d0287f5ce6ad95cbd9b`
- Backend container started at `2026-05-08T07:35:22.391346218Z`
- The image tags above were observed from `docker-compose -f docker-compose.app.yml images`.
- Health check: `/api/health` returned `status="ok"`, `plugins=13`, `failed=0`.
- Functional multitable readiness is asserted by the seven-check harness below,
  not by plugin count alone.

## Auth Handling

A short-lived staging admin JWT was generated from the running backend
container using the server signing configuration and a real active admin user
record.

Validation:

- `/api/auth/me` returned HTTP 200.
- Returned user role was `admin`.
- The token value was not written to this document.
- Local and remote temporary token files were removed after the harness run.

## Harness Command

The 142 host does not have a host-level Node runtime, so the harness was run
from the local repository through an SSH tunnel:

```bash
ssh -fN \
  -L 18990:127.0.0.1:8900 \
  -o ExitOnForwardFailure=yes \
  -o BatchMode=yes \
  -o ConnectTimeout=8 \
  -o StrictHostKeyChecking=accept-new \
  <staging-142>

OUTPUT_DIR=/tmp/metasheet-rc-staging-verify-20260508-004820 \
API_BASE=http://127.0.0.1:18990 \
AUTH_TOKEN="$(cat /tmp/metasheet-staging-admin.jwt)" \
pnpm verify:multitable-rc:staging
```

The tunnel was closed after the run.

## Result

Original temporary report files:

- `/tmp/metasheet-rc-staging-verify-20260508-004820/report.json`
- `/tmp/metasheet-rc-staging-verify-20260508-004820/report.md`

Committed report artifacts:

- `docs/development/artifacts/multitable-rc-staging-142-20260508/report.json`
- `docs/development/artifacts/multitable-rc-staging-142-20260508/report.md`

Summary:

```text
[rc-smoke] PASS lifecycle (2637ms)
[rc-smoke] PASS public-form (3045ms)
[rc-smoke] PASS hierarchy (1757ms)
[rc-smoke] PASS gantt-config (2131ms)
[rc-smoke] PASS formula (1947ms)
[rc-smoke] PASS automation-email (2191ms)
[rc-smoke] PASS autoNumber-backfill (2940ms)
[rc-smoke] result: 7 pass / 0 fail / 0 skip / 7 total
```

Report table:

| Check | Status | Duration |
| --- | --- | --- |
| lifecycle | pass | 2637ms |
| public-form | pass | 3045ms |
| hierarchy | pass | 1757ms |
| gantt-config | pass | 2131ms |
| formula | pass | 1947ms |
| automation-email | pass | 2191ms |
| autoNumber-backfill | pass | 2940ms |

## Conclusion

142 staging is green for the Multitable RC remote harness on image
`1b06bf286915b4eafc4d5d0287f5ce6ad95cbd9b`.

RC decision signal:

- `GO` for the seven automated staging checks covered by
  `pnpm verify:multitable-rc:staging`.
- Manual browser checks can still be run separately if product/UI sign-off is
  required, but the previous staging blockers in automation `send_email` are
  cleared.
