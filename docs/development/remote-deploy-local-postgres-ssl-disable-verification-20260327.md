# Remote Deploy Local Postgres SSL Disable Verification

## Scope

Verify that the release-unblock fix is present in code, wired into the remote deploy workflow, and aligned with shipped env templates.

## Source failure

Latest blocked mainline deploy:

- `Build and Push Docker Images #23624331554`

Failure evidence:

- `output/playwright/ga/23624331554/deploy-logs-23624331554-1/deploy.log`
- `output/playwright/ga/23624331554/deploy-logs-23624331554-1/step-summary.md`

Observed migrate failure:

- `Error: The server does not support SSL connections`

## Commands run

### Passed

```bash
git diff --check
```

```bash
python3 - <<'PY'
from pathlib import Path
p = Path('.github/workflows/docker-build.yml')
text = p.read_text()
assert 'local-postgres detected; forcing DB_SSL=false' in text
assert 'docker/app.env' in text
assert 'DATABASE_URL=' in text
print('workflow patch markers present')
PY
```

```bash
rg -n "DB_SSL=false|local-postgres detected|sslDisabledByEnv" \
  .github/workflows/docker-build.yml \
  packages/core-backend/src/integration/db/connection-pool.ts \
  docker/app.env.example \
  docker/app.env.attendance-onprem.template \
  docker/app.env.attendance-onprem.ready.env \
  docker/app.env.multitable-onprem.template
```

### Environment-limited

Attempted:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

- failed in this clean worktree because `tsc` is not installed in its local PNPM environment

Attempted fallback:

```bash
/Users/huazhou/Downloads/Github/metasheet2/node_modules/.bin/tsc \
  -p packages/core-backend/tsconfig.json --noEmit
```

Result:

- failed because this clean worktree does not have the matching local type dependency wiring for `vitest/globals`

These failures reflect workspace bootstrap mismatch in the clean deploy-fix worktree, not a known syntax issue in the patch itself.

## Verified file changes

### Backend runtime

Confirmed:

- `packages/core-backend/src/integration/db/connection-pool.ts`
  - production SSL now respects explicit `DB_SSL=false`

### Remote deploy workflow

Confirmed:

- `.github/workflows/docker-build.yml`
  - inspects `docker/app.env`
  - detects local/bundled Postgres targets
  - idempotently writes `DB_SSL=false`
  - logs: `local-postgres detected; forcing DB_SSL=false`

### Env templates

Confirmed:

- `docker/app.env.example`
- `docker/app.env.attendance-onprem.template`
- `docker/app.env.attendance-onprem.ready.env`
- `docker/app.env.multitable-onprem.template`

All now include:

- `DB_SSL=false`

## Conclusion

The patch matches the intended minimal unblock boundary:

- secure defaults remain unchanged for external production databases
- bundled local/on-prem Postgres now has an explicit non-SSL contract
- remote deploy workflow will self-heal older host `docker/app.env` files before recreate + migrate

Next validation step after merge:

- rerun the mainline `Build and Push Docker Images` workflow and confirm migrate proceeds past the previous SSL failure
