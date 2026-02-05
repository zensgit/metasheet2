# CI Auto-Deploy Verification (2026-02-05)

## Scope
- Verify auto-deploy job wiring in `docker-build.yml`.
- Verify env templates include `ATTENDANCE_IMPORT_REQUIRE_TOKEN`.

## Checks Performed
### 1) Workflow wiring
Command:
```
rg -n "appleboy/ssh-action|Deploy backend" .github/workflows/docker-build.yml
```
Result:
```
55:      - name: Deploy backend + web containers
56:        uses: appleboy/ssh-action@v1.0.3
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
Screenshot: `artifacts/attendance-ui-regression-20260205.png`

## Deploy Key Rotation
- Generated dedicated key: `~/.ssh/metasheet2_deploy`
- Added public key to `mainuser@142.171.239.56` `~/.ssh/authorized_keys`
- Updated GitHub secret `DEPLOY_SSH_KEY` to the new private key
- Verified SSH with:  
  `ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 true`

## Status
✅ Static checks complete  
✅ Runtime deploy verified
✅ UI smoke verified  
✅ Deploy key rotation verified
