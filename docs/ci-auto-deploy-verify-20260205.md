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
Not executed in CI yet. To validate end-to-end:
1. Add the required GitHub secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`; optional `DEPLOY_PATH`, `DEPLOY_COMPOSE_FILE`).
2. Trigger **Build and Push Docker Images** on `main`.
3. Confirm `deploy` job runs and completes.
4. On server, verify:
   - `docker compose -f docker-compose.app.yml ps` shows updated `backend` and `web`.
   - Web UI loads and `/api/health` responds.

## Status
✅ Static checks complete  
⏳ Runtime deploy awaiting secrets/configuration
