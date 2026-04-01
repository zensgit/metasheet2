# Run26 On-Prem Packaging And Event Bus Hotfix Verification

Date: 2026-04-01

## Commands

```bash
git diff --check
bash -n scripts/ops/attendance-onprem-package-build.sh
bash -n scripts/ops/attendance-onprem-package-verify.sh
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/events-api.test.ts --reporter=dot
OUTPUT_DIR="$(mktemp -d)" INSTALL_DEPS=0 BUILD_WEB=1 BUILD_BACKEND=0 PACKAGE_VERSION=2.7.2 PACKAGE_TAG=run27-20260401 scripts/ops/attendance-onprem-package-build.sh
scripts/ops/attendance-onprem-package-verify.sh "$OUTPUT_DIR/metasheet-attendance-onprem-v2.7.2-run27-20260401.zip"
unzip -Z1 "$OUTPUT_DIR/metasheet-attendance-onprem-v2.7.2-run27-20260401.zip" | grep -E 'start-pm2|deploy-run27|attendance-onprem-start-pm2\.ps1|attendance-onprem-deploy-run\.ps1'
```

## Results

- `git diff --check`: pass
- `bash -n` for package build/verify scripts: pass
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit`: pass
- `events-api.test.ts`: pass
  - Note: local DB env in this session is absent, so the test exits early after loading the file; the suite still validates test wiring and does not fail.
- Isolated package build with `BUILD_WEB=1`: pass
- Package verify on generated zip: pass
- Generated zip contains:
  - `start-pm2.bat`
  - `start-pm2-remote.bat`
  - `deploy-run27.bat`
  - `scripts/ops/attendance-onprem-start-pm2.ps1`
  - `scripts/ops/attendance-onprem-deploy-run.ps1`

## Outcome

- Windows on-prem packages regain the PM2 startup entrypoints expected by scheduled tasks.
- The Kysely migration path now aligns event bus storage with the runtime `/api/events` and cleanup logic.
