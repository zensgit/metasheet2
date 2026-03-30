# DingTalk Auth Staging Execution

## Environment

- Target host: `142.171.239.56`
- Expected SSH user from existing repo docs: `mainuser`
- Expected repo path from existing repo docs: `~/metasheet2`
- Public web entry: `http://142.171.239.56:8081`
- Public API entry: `http://142.171.239.56:8081/api`

## Current Remote Observations

Observed on March 24, 2026 (Asia/Shanghai) from the local development machine:

- `http://142.171.239.56:8081` returned `200 OK`
- `http://142.171.239.56:8081/api/plugins` returned `200 OK`
- `http://142.171.239.56:8081/api/auth/dingtalk/login-url?redirect=/settings` returned `401 Unauthorized`

Inference:

- The host is up and nginx/API proxy are reachable.
- The currently deployed backend does not yet expose DingTalk login as a public unauthenticated entry in the expected way.
- This is consistent with the remote deployment still being on an older auth build, or with the newer DingTalk route not yet deployed.

SSH status from the current environment:

- `ssh mainuser@142.171.239.56` timed out during banner exchange.

Inference:

- HTTP is reachable, but TCP/22 is not reachable from the current client path.
- Deployment likely needs to be executed either from an allowed bastion/client or after firewall/network access is restored.

## Recommended Rollout Order

1. Restore or confirm SSH access to `mainuser@142.171.239.56`.
2. Pull the new code and images on the server.
3. Update runtime env with `PUBLIC_APP_URL` and `DINGTALK_*`.
4. Run the new DingTalk preflight on the host checkout.
5. Apply database migrations, including external identity hardening.
6. Restart backend/web.
7. Verify public DingTalk login-url is no longer protected by bearer auth.
8. Run browser/API smoke with auto-provision still disabled.
9. Enable auto-provision only after bound-login flow is confirmed.

## Server Commands

SSH and repo status:

```bash
ssh mainuser@142.171.239.56 '
  cd ~/metasheet2 &&
  printf "pwd=%s\n" "$PWD" &&
  git rev-parse HEAD &&
  docker compose -f docker-compose.app.yml ps
'
```

Pull latest code and images:

```bash
ssh mainuser@142.171.239.56 '
  cd ~/metasheet2 &&
  git pull --ff-only &&
  docker compose -f docker-compose.app.yml pull backend web
'
```

Suggested env additions on host:

```dotenv
PUBLIC_APP_URL=http://142.171.239.56:8081
DINGTALK_AUTH_ENABLED=true
DINGTALK_CLIENT_ID=<redacted>
DINGTALK_CLIENT_SECRET=<redacted>
# Optional when PUBLIC_APP_URL is correct:
# DINGTALK_REDIRECT_URI=http://142.171.239.56:8081/auth/dingtalk/callback
DINGTALK_ALLOWED_CORP_IDS=<corp-id>
DINGTALK_AUTO_PROVISION=false
# Later phase:
# DINGTALK_AUTO_PROVISION=true
# DINGTALK_AUTO_PROVISION_PRESET_ID=attendance-employee
# DINGTALK_AUTO_PROVISION_ORG_ID=default
# DINGTALK_AUTO_PROVISION_EMAIL_DOMAIN=dingtalk.local
```

Host-side preflight:

```bash
ssh mainuser@142.171.239.56 '
  cd ~/metasheet2 &&
  node scripts/dingtalk-auth-preflight.mjs
'
```

Restart and migrate:

```bash
ssh mainuser@142.171.239.56 '
  cd ~/metasheet2 &&
  docker compose -f docker-compose.app.yml up -d &&
  docker compose -f docker-compose.app.yml exec -T backend node packages/core-backend/dist/src/db/migrate.js &&
  docker compose -f docker-compose.app.yml restart web
'
```

## Post-Deploy API Checks

Public DingTalk login entry should become public:

```bash
curl -i 'http://142.171.239.56:8081/api/auth/dingtalk/login-url?redirect=%2Fsettings'
```

Expected:

- not `401 Missing Bearer token`
- either `200` with login URL payload
- or `503` when DingTalk auth is deployed but not yet configured

Plugin/API baseline:

```bash
curl -I 'http://142.171.239.56:8081'
curl -I 'http://142.171.239.56:8081/api/plugins'
```

## Acceptance Checklist

- [ ] `/api/auth/dingtalk/login-url` returns `200` or `503`, but no longer returns bearer-auth `401`
- [ ] login page shows `钉钉登录`
- [ ] DingTalk callback route `/auth/dingtalk/callback` is reachable through nginx
- [ ] existing local account can complete bind flow
- [ ] bindings list shows the new DingTalk identity
- [ ] unbind works
- [ ] already-bound user can complete DingTalk login
- [ ] session center shows DingTalk login session normally
- [ ] `refresh-token` does not desync session expiry
- [ ] auto-provision remains disabled during first smoke

## Phase 2

After phase-1 smoke passes:

1. Enable `DINGTALK_AUTO_PROVISION=true`
2. Keep `DINGTALK_ALLOWED_CORP_IDS` mandatory
3. Set `DINGTALK_AUTO_PROVISION_PRESET_ID`
4. Set `DINGTALK_AUTO_PROVISION_ORG_ID`
5. Re-run preflight and smoke
