# CI Auto-Deploy Verification (2026-02-05)

## Scope
- Verify auto-deploy job wiring in `docker-build.yml`.
- Verify env templates include `ATTENDANCE_IMPORT_REQUIRE_TOKEN`.

## Checks Performed
### 1) Workflow wiring
Command:
```
rg -n "Deploy backend|DEPLOY_SSH_KEY_B64" .github/workflows/docker-build.yml
```
Result:
```
55:      - name: Deploy backend + web containers
58:          DEPLOY_SSH_KEY_B64: ${{ secrets.DEPLOY_SSH_KEY_B64 }}
```

### 2) Env template updates
Command:
```
rg -n "ATTENDANCE_IMPORT_REQUIRE_TOKEN" .env.example .env.phase5.template
```
Result:
```
.env.example:72:ATTENDANCE_IMPORT_REQUIRE_TOKEN=0
.env.phase5.template:15:ATTENDANCE_IMPORT_REQUIRE_TOKEN=0
```

## Runtime Validation
Executed end-to-end on 2026-02-05.

### 1) CI run
Workflow: **Build and Push Docker Images**  
Run ID: `21709320843`  
Status: ✅ Success (build + deploy)

### 2) Server containers
Command:
```
ssh mainuser@142.171.239.56 'cd metasheet2 && docker compose -f docker-compose.app.yml ps'
```
Result (abridged):
```
metasheet-backend  ghcr.io/zensgit/metasheet2-backend:latest  Up
metasheet-web      ghcr.io/zensgit/metasheet2-web:latest      Up
```

### 3) API check
Command:
```
ssh mainuser@142.171.239.56 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8900/api/plugins'
```
Result:
```
200
```

## UI Smoke (Attendance)
Page: `http://142.171.239.56:8081/p/plugin-attendance/attendance`  
Result: ✅ Loaded and rendered summary/admin console sections.  
Screenshot: `artifacts/attendance-ui-regression-20260205-5.png`

## Deploy Key Rotation
- Generated dedicated key: `~/.ssh/metasheet2_deploy`
- Added public key to `mainuser@142.171.239.56` `~/.ssh/authorized_keys`
- Updated GitHub secret `DEPLOY_SSH_KEY` to the new private key
- Verified SSH with:  
  `ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 true`

### Follow-up: legacy key cleanup
Initial cleanup attempts left the deploy key missing from `authorized_keys`, which caused CI SSH authentication to fail. The file was restored to include both the legacy key and the deploy key.

### CI retry after recovery
Workflow: **Build and Push Docker Images**  
Run ID: `21712168768`  
Status: ✅ Success (build + deploy + smoke checks)

### CI run after legacy key removal
Workflow: **Build and Push Docker Images**  
Run ID: `21712897235`  
Status: ❌ Deploy failed due to Docker iptables error on server:
```
failed to set up container networking ... iptables: No chain/target/match by that name
```

### Manual recovery
- Ran `sudo systemctl restart docker`
- Re-ran `docker compose up -d --no-deps --force-recreate backend web`
- Verified `/api/plugins` returns 200
- Verified `/health` returns 200
 - Installed `docker-iptables-ensure.service` to pre-create DOCKER chain on boot

### CI run after iptables fix
Workflow: **Build and Push Docker Images**  
Run ID: `21713500901`  
Status: ✅ Success (build + deploy + smoke checks)

### CI run with deploy smoke echo
Workflow: **Build and Push Docker Images**  
Run ID: `21713755609`  
Status: ✅ Success (build + deploy + smoke checks)  
Log: `Smoke: api/plugins=ok web=ok`

### Legacy key removed
`authorized_keys` now contains only `metasheet2-deploy`.
Validation:
- ✅ `ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 true`
- ✅ legacy key rejected (`id_ed25519`): Permission denied

## Status
✅ Static checks complete  
✅ Runtime deploy verified
✅ UI smoke verified  
✅ Deploy key rotation verified  
✅ Deploy key restored and CI deploy recovered  
✅ Legacy key removed  
✅ Docker iptables guard added  
✅ CI deploy stable after fix
