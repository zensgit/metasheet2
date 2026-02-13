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

### CI run with health smoke
Workflow: **Build and Push Docker Images**  
Run ID: `21714194104`  
Status: ✅ Success (build + deploy + smoke checks)  
Log: `Smoke: api/plugins=ok health=ok web=ok`

### CI run with smoke summary (manual trigger)
Workflow: **Build and Push Docker Images**  
Run ID: `21714622170`  
Status: ✅ Success (build + deploy + smoke checks)  
Log: `Smoke: api/plugins=ok health=ok web=ok`  
Note: one transient `curl: (56) Recv failure: Connection reset by peer` occurred before retries succeeded.

### CI step summary
Deploy job now appends a smoke summary to `GITHUB_STEP_SUMMARY`:
- api/plugins: ok
- health: ok
- web: ok

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

## Update (2026-02-12): Remote Preflight Summary + Deploy Log Artifacts

Deploy job now archives remote deploy logs and surfaces the Attendance preflight result in GitHub Step Summary.

- Workflow: **Build and Push Docker Images**
- Run: [#21958027752](https://github.com/zensgit/metasheet2/actions/runs/21958027752) (`SUCCESS`)
- Evidence (local):
  - `output/playwright/ga/21958027752/deploy.log`

Behavior:

- Remote preflight output is wrapped by markers and persisted into `deploy.log`.
- Step Summary includes:
  - Preflight PASS/FAIL
  - A short preflight output snippet
  - Runbook links
- `deploy.log` is uploaded as an artifact even if deploy fails (job still ends as `FAIL` when `deploy_rc != 0`).

## Update (2026-02-13): workflow_dispatch Re-Verification

Manual dispatch re-verified the same deploy evidence path on latest `main`.

- Workflow: **Build and Push Docker Images**
- Run: [#21972069433](https://github.com/zensgit/metasheet2/actions/runs/21972069433) (`SUCCESS`, `workflow_dispatch`)
- Evidence (local):
  - `output/playwright/ga/21972069433/deploy.log`

Checks observed from the downloaded artifact:

- Marker coverage present:
  - `=== ATTENDANCE PREFLIGHT START/END ===`
  - `=== DEPLOY START/END ===`
  - `=== MIGRATE START/END ===`
  - `=== SMOKE START/END ===`
- Smoke completed with expected success line:
  - `Smoke: api/plugins=ok health=ok web=ok`

## Update (2026-02-13): Failure Drill (Expected FAIL)

This drill validates the failure path behavior:

- deploy job ends as `FAIL` (blocks deployment)
- deploy artifacts still upload
- Step Summary still contains preflight output + runbook links

Run:

- Workflow: **Build and Push Docker Images**
- Run: [#21973689456](https://github.com/zensgit/metasheet2/actions/runs/21973689456) (`FAILURE`, expected)
- Evidence (local):
  - `output/playwright/ga/21973689456/deploy.log`

Observed failure:

- Preflight failed as expected:
  - `ATTENDANCE_IMPORT_REQUIRE_TOKEN must be set to '1' in docker/app.env`

### Restore Validation (Expected PASS)

- Workflow: **Build and Push Docker Images**
- Run: [#21973784431](https://github.com/zensgit/metasheet2/actions/runs/21973784431) (`SUCCESS`)
- Evidence (local):
  - `output/playwright/ga/21973784431/deploy.log`

### Repeat Drill (Preflight END Marker On FAIL)

This re-validates that the preflight marker block is always well-formed even when preflight fails.

- Workflow: **Build and Push Docker Images**
- Run: [#21974005618](https://github.com/zensgit/metasheet2/actions/runs/21974005618) (`FAILURE`, expected)
- Evidence (local):
  - `output/playwright/ga/21974005618/deploy.log`
- Verified:
  - `=== ATTENDANCE PREFLIGHT END ===` is present even on failure.

### Restore Validation (Expected PASS, Post Marker Hardening)

- Workflow: **Build and Push Docker Images**
- Run: [#21974057204](https://github.com/zensgit/metasheet2/actions/runs/21974057204) (`SUCCESS`)
- Evidence (local):
  - `output/playwright/ga/21974057204/deploy.log`

## Update (2026-02-13): Step Summary (Artifacts + Status Hint)

Deploy Step Summary now includes:

- a dedicated **Artifacts** section with the artifact name and a copy/paste `gh run download ...` command
- a status hint when `Overall=FAIL` but `Preflight=PASS` (failure happened after preflight)

- Workflow: **Build and Push Docker Images**
- Run: [#21973932069](https://github.com/zensgit/metasheet2/actions/runs/21973932069) (`SUCCESS`)
- Evidence (local):
  - `output/playwright/ga/21973932069/deploy.log`

## Update (2026-02-13): Step Summary (Remote Stages: Migrate + Smoke)

Deploy Step Summary now also includes a "Remote Stages" section (Deploy/Migrate/Smoke statuses). On failures after preflight, it can surface a short tail of migrate/smoke output to reduce time-to-diagnosis.

- Workflow: **Build and Push Docker Images**
- Run: [#21974371801](https://github.com/zensgit/metasheet2/actions/runs/21974371801) (`SUCCESS`)
- Evidence (local):
  - `output/playwright/ga/21974371801/deploy.log`

## Update (2026-02-13): Stage Failure Drills (Migrate + Smoke)

Two `workflow_dispatch` drills validated the "Remote Stages" summary and that failure-stage tails appear when the corresponding stage fails.

### Drill: migrate failure (expected FAIL)

- Run: [#21974887993](https://github.com/zensgit/metasheet2/actions/runs/21974887993) (`FAILURE`, expected)
- Evidence (local):
  - `output/playwright/ga/21974887993/deploy.log`
- Expected drill marker:
  - `[deploy][drill] intentional failure at migrate stage`

### Drill: smoke failure (expected FAIL)

- Run: [#21975944250](https://github.com/zensgit/metasheet2/actions/runs/21975944250) (`FAILURE`, expected)
- Evidence (local):
  - `output/playwright/ga/21975944250/deploy.log`
- Expected drill marker:
  - `[deploy][drill] intentional failure at smoke stage`

## Update (2026-02-13): Step Summary Archived As Artifact

Deploy now copies the generated Step Summary content into `output/deploy/step-summary.md`, which is uploaded alongside `deploy.log` (so evidence is reviewable without opening GitHub UI).

PASS path:

- Run: [#21976281725](https://github.com/zensgit/metasheet2/actions/runs/21976281725) (`SUCCESS`, push)
- Evidence (local):
  - `output/playwright/ga/21976281725/step-summary.md`
  - `output/playwright/ga/21976281725/deploy.log`

Drill path (stage recorded in summary):

- Run: [#21976355633](https://github.com/zensgit/metasheet2/actions/runs/21976355633) (`FAILURE`, expected, `drill_fail_stage=smoke`)
- Evidence (local):
  - `output/playwright/ga/21976355633/step-summary.md`
  - `output/playwright/ga/21976355633/deploy.log`

## Update (2026-02-13): Deploy Drill + Deploy Output Tail

Added a deploy-stage drill and a "Deploy Output (tail)" section in Step Summary to help diagnose failures during image pull / container recreate.

- Run: [#21976588135](https://github.com/zensgit/metasheet2/actions/runs/21976588135) (`FAILURE`, expected, `drill_fail_stage=deploy`)
- Evidence (local):
  - `output/playwright/ga/21976588135/step-summary.md`
  - `output/playwright/ga/21976588135/deploy.log`

## Update (2026-02-13): Exit Code Meaning + Stage Reasons

Step Summary now also includes:

- remote exit code meaning (maps drill exit codes and flags unknown failures)
- stage reasoning inline (e.g., "start marker present; end marker missing")

PASS example:

- Run: [#21976718210](https://github.com/zensgit/metasheet2/actions/runs/21976718210) (`SUCCESS`)
- Evidence (local):
  - `output/playwright/ga/21976718210/step-summary.md`
  - `output/playwright/ga/21976718210/deploy.log`

Drill example (`drill_fail_stage=deploy`, exit code `91`):

- Run: [#21976791431](https://github.com/zensgit/metasheet2/actions/runs/21976791431) (`FAILURE`, expected)
- Evidence (local):
  - `output/playwright/ga/21976791431/step-summary.md`
  - `output/playwright/ga/21976791431/deploy.log`

## Update (2026-02-13): Re-Verify Smoke PASS Criteria (Requires SMOKE END Marker)

Smoke now counts as `PASS` in the Step Summary only when **both** are present in `deploy.log`:

- `Smoke: api/plugins=ok health=ok web=ok`
- `=== SMOKE END ===`

Verification:

- Run: [#21977059789](https://github.com/zensgit/metasheet2/actions/runs/21977059789) (`SUCCESS`, workflow_dispatch)
- Evidence (local):
  - `output/playwright/ga/21977059789/step-summary.md`
  - `output/playwright/ga/21977059789/deploy.log`

Drill verification (expected FAIL, ensures artifacts still upload and summary marks Smoke as FAIL):

- Run: [#21977247241](https://github.com/zensgit/metasheet2/actions/runs/21977247241) (`FAILURE`, expected, `drill_fail_stage=smoke`)
- Evidence (local):
  - `output/playwright/ga/21977247241/step-summary.md`
  - `output/playwright/ga/21977247241/deploy.log`

## Update (2026-02-13): Remote Preflight (Prod) Gate + Evidence Artifacts

Added a standalone remote preflight workflow for detecting config drift even when no deploy happens:

- Workflow: `.github/workflows/attendance-remote-preflight-prod.yml`
- Behavior:
  - sync deploy host repo (`git pull --ff-only origin main`)
  - run `scripts/ops/attendance-preflight.sh` on the deploy host
  - include host sync output in Step Summary (so git failures are diagnosable without opening raw logs)
  - upload `preflight.log` + `step-summary.md` artifacts (even on failure)

PASS example:

- Run: [#21984121413](https://github.com/zensgit/metasheet2/actions/runs/21984121413) (`SUCCESS`)
- Evidence (local):
  - `output/playwright/ga/21984121413/step-summary.md`
  - `output/playwright/ga/21984121413/preflight.log`

Drill example (expected FAIL, validates FAIL-path evidence):

- Run: [#21984026399](https://github.com/zensgit/metasheet2/actions/runs/21984026399) (`FAILURE`, expected, `drill_fail=true`)
- Evidence (local):
  - `output/playwright/ga/21984026399/step-summary.md`
  - `output/playwright/ga/21984026399/preflight.log`

## Update (2026-02-13): Tag Drill Runs + Daily Dashboard Ignores Them

To avoid `P0` false-alarms during drills:

- `attendance-remote-preflight-prod.yml` tags drill runs with `run-name` suffix: `[DRILL]`
- `attendance-daily-gate-report.mjs` filters out `[DRILL]` runs when selecting the latest completed `Remote Preflight` run

Verification:

- Drill run (tagged `[DRILL]`, expected FAIL):
  - Run: [#21984401016](https://github.com/zensgit/metasheet2/actions/runs/21984401016) (`FAILURE`, expected)
  - Evidence (local):
    - `output/playwright/ga/21984401016/step-summary.md`
    - `output/playwright/ga/21984401016/preflight.log`
- Daily dashboard still PASS (ignores `[DRILL]`):
  - Run: [#21984436363](https://github.com/zensgit/metasheet2/actions/runs/21984436363) (`SUCCESS`)
  - Evidence (local):
    - `output/playwright/ga/21984436363/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/21984436363/attendance-daily-gate-dashboard.json`
