# Prod Health Probe Monitor — Runbook (2026-07-14)

Workflow: `.github/workflows/prod-health-probe-monitor.yml`

## What it does

A steady-state, external, read-only health probe for the deployed prod stack:

- A GitHub-hosted runner performs `GET http://23.254.236.11:8081/api/health`
  every 5 minutes (`schedule: */5 * * * *`; GitHub cron jitter is expected and
  acceptable — the alert logic counts runs, not wall-clock minutes).
- The probe uses **no secrets** (public endpoint). `GITHUB_TOKEN` is used only
  for run-history reads, dispatching the snapshot workflow, and issue
  operations. Workflow permissions are scoped to `issues: write` +
  `actions: write` only.
- The monitor **never** restarts services, deploys, or mutates the prod host
  in any way. Diagnosis and remediation are manual.

## Probe classification

Per run, up to 3 attempts (2 quick retries, 5 s apart) with
`--connect-timeout 5 --max-time 10`:

| Outcome | Classification |
|---|---|
| connection failure / timeout | fail |
| HTTP 5xx | fail |
| HTTP 200 | pass |
| any other HTTP status (e.g. 4xx, 3xx) | pass-with-note (endpoint reachable; note recorded in the run summary) |

A run concludes `failure` only when all attempts are fail-class. The final
workflow step deliberately fails the run in that case so the run conclusion
itself carries the state (see next section).

## State persistence (consecutive-failure counting)

No cache, artifact, or repo-variable state. Each run queries **this
workflow's own completed-run history** via
`gh api repos/<repo>/actions/workflows/prod-health-probe-monitor.yml/runs?status=completed`
and counts the leading streak of `success` / `failure` conclusions
(schedule/dispatch runs on `main` only; `cancelled`/`skipped`/`startup_failure`
runs are ignored for streak purposes).

- `consecutive_failures = leading failure streak + 1` when the current probe
  fails.
- `consecutive_successes = leading success streak + 1` when it passes.

Known over-approximation (conservative toward alerting): a run that fails for
an internal reason (e.g. Actions API error in the streak step) also concludes
`failure` and counts toward the streak. The alert still requires the
*current* run's probe to actually fail, so a pure infra blip cannot alert on
its own.

## Alert lifecycle

1. **Threshold**: alert only when `consecutive_failures == 3`.
2. **Second vantage first**: before alerting, the monitor dispatches the
   existing read-only SSH log snapshot workflow
   (`attendance-remote-log-snapshot-prod.yml`) via `workflow_dispatch` with
   `skip_host_sync=true` (no git sync on the host) and an empty
   `issue_number` (so the snapshot does not comment on its own default
   issue). The dispatched run's URL is linked in the alert.
3. **One deduplicated issue**: find-or-create by the exact stable title
   `[prod-health] Prod health probe failing: GET /api/health`.
   - No matching issue → create it.
   - Matching **closed** issue → reopen + comment (new outage, same thread).
   - Matching **open** issue → append a comment (never a duplicate issue).
4. **Continued failure**: while the outage continues, a heartbeat comment
   (with a fresh snapshot dispatch) is appended every 12th consecutive
   failing run (~hourly at the 5-minute cadence), not every run — this keeps
   the issue readable during long outages. The streak is computed from the
   probe's own last 96 completed runs, so heartbeats continue for roughly the
   first **8 hours** of a continuous outage and then stop; the alert issue
   stays open and the probe keeps running regardless. Additionally, every
   failing run at/past the 3-failure threshold self-heals a missed alert: if
   no open alert issue exists (e.g. the exact crossing run hit a transient
   API error), the next failing run creates/reopens it — comments still only
   append at crossing/heartbeat.
5. **Auto-close**: after **2 consecutive** successful probe runs, the monitor
   comments "Recovered" and closes the issue automatically.

## Silencing during maintenance windows

Mechanism implemented: repository variable **`PROD_HEALTH_PROBE_SILENCE`**.

```bash
# Silence (start of maintenance window)
gh variable set PROD_HEALTH_PROBE_SILENCE --repo zensgit/metasheet2 --body true

# Unsilence (end of maintenance window)
gh variable set PROD_HEALTH_PROBE_SILENCE --repo zensgit/metasheet2 --body false
# (or delete it: gh variable delete PROD_HEALTH_PROBE_SILENCE --repo zensgit/metasheet2)
```

While silenced:

- the probe still runs and logs its result (run-name shows `[SILENCED]`),
- streak evaluation, snapshot dispatch, and all issue operations are skipped,
- the run always concludes success — so silenced runs **reset the failure
  streak**; after unsilencing, alerting requires 3 fresh consecutive failing
  runs. This is intentional: a maintenance window should not pre-arm an
  alert.

Alternative (heavier) switch: disable the workflow entirely —
`gh workflow disable "Prod Health Probe Monitor" --repo zensgit/metasheet2`
(re-enable with `gh workflow enable ...`). Prefer the variable: it keeps the
probe logging and is visible in run names.

## What this monitor never does

- No auto-restart, no auto-deploy, no writes of any kind to the prod host.
- No secrets in the probe path; nothing secret is printed anywhere.
- No changes to postgres/redis deploy behavior or any other workflow.

## Manual verification

- Trigger one run by hand: `gh workflow run "Prod Health Probe Monitor" --repo zensgit/metasheet2`
  then check the run's step summary (result, streak, actions taken).
- The schedule only activates once the workflow file is on the default
  branch (`main`).
