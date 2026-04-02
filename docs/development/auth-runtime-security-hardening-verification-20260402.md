# Auth Runtime Security Hardening Verification

Date: 2026-04-02

## Commands

```bash
git diff --check
```

```bash
bash -n scripts/ops/attendance-onprem-env-check.sh \
  && bash -n scripts/ops/attendance-preflight.sh \
  && bash -n scripts/ops/attendance-onprem-bootstrap-admin.sh \
  && bash -n scripts/ops/attendance-onprem-package-verify.sh
```

```bash
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" /opt/homebrew/bin/pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-runtime-config.test.ts tests/unit/AuthService.test.ts --watch=false
```

```bash
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" /opt/homebrew/bin/pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts tests/unit/auth-invite-routes.test.ts tests/unit/admin-users-routes.test.ts --watch=false
```

```bash
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" /opt/homebrew/bin/pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

```bash
tmp_env="$(mktemp)"
cat > "$tmp_env" <<'EOF'
NODE_ENV=production
HOST=127.0.0.1
PORT=8900
PRODUCT_MODE=attendance
DEPLOYMENT_MODEL=onprem
JWT_SECRET=prod-secret-abcdefghijklmnopqrstuvwxyz1234567890abcd
BCRYPT_SALT_ROUNDS=12
POSTGRES_USER=metasheet
POSTGRES_PASSWORD=strong-db-password-1234567890
POSTGRES_DB=metasheet
DATABASE_URL=postgres://metasheet:strong-db-password-1234567890@127.0.0.1:5432/metasheet
DB_SSL=false
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
ATTENDANCE_IMPORT_REQUIRE_TOKEN=1
ATTENDANCE_IMPORT_UPLOAD_DIR=/app/uploads/attendance-import
ATTENDANCE_IMPORT_CSV_MAX_ROWS=100000
ATTENDANCE_IMPORT_HEAVY_QUERY_TIMEOUT_MS=180000
EOF
ENV_FILE="$tmp_env" REQUIRE_ATTENDANCE_ONLY=1 scripts/ops/attendance-onprem-env-check.sh
ENV_FILE="$tmp_env" scripts/ops/attendance-preflight.sh
rm -f "$tmp_env"
```

## Results

- `git diff --check`: PASS
- shell syntax validation: PASS
- `auth-runtime-config.test.ts` + `AuthService.test.ts`: PASS (`12 passed`)
- auth/admin route unit tests: PASS (`33 passed`)
- `tsc --noEmit`: PASS
- synthetic production `app.env`:
  - `attendance-onprem-env-check.sh`: PASS
  - `attendance-preflight.sh`: PASS

## Notes

- Production `JWT_SECRET` is now fail-fast instead of silently falling back to development secrets.
- Invite-token signing and verification now follow the same production secret requirements.
- On-prem env/preflight/bootstrap/package-verify are aligned on `BCRYPT_SALT_ROUNDS >= 12` and strong JWT secret requirements.
