# Production deploy window runbook

The `deploy` job of `.github/workflows/docker-build.yml` runs a production deploy as a
**deploy window** on the deploy host: refuse early with nothing changed, stop writes,
back up, migrate once, then start the new version. This page tells the dispatcher what
to set, how to stop a window, and what to do for each outcome.

All host paths below are relative to the deploy user's home directory (`$HOME`).

## Host layout

| Path | What it is |
|---|---|
| `$HOME/metasheet2-deploy-window/lock` | host lock, held by a running window for its whole life |
| `$HOME/metasheet2-deploy-window/state` | the window's state (`phase=`, `env_written=`, `backend_verified=`, `web_verified=`, `rc=` ...). Only the lock holder writes it |
| `$HOME/metasheet2-deploy-window/abort` | created by the operator to abort a window before the migration (see below) |
| `$HOME/metasheet2-deploy-window/host-checks/` | owner-installed host checks: every executable here runs with one argument, the phase (`pre-stop`, `pre-restart-old`, `post-backend`); all must exit 0 and at least `DEPLOY_WINDOW_MIN_HOST_CHECKS` must be present |
| `$HOME/metasheet2-deploy-window/runs/<run_id>-<attempt>/` | one directory per dispatch (mode 700): `window.log`, `rc`, the env snapshots, the dump `db.dump`, `meta.txt`, `globals.sql`, `shim-candidates.txt`, `RESTORE-README.txt`, `appdata.tar` when the backend held local files, and raw tool outputs. Host only; never uploaded |

The env snapshots and `globals.sql` hold secrets and password hashes. Keep the run
directories on the host and prune old dumps by hand; the workflow never deletes a
verified dump and never prunes.

## Before dispatching

- The deploy commit is main HEAD at dispatch time, and the whole pending migration set
  at that commit was rehearsed on a production-schema copy.
- `expected_pending_sha256` = sha256 of the in-play pending migration names (pending
  names minus the committed exclusion list) in `migrate.js --list` load order, joined
  by a newline, **without** a trailing newline. From a rehearsal list file
  `inplay.txt` with one name per line: `printf '%s' "$(cat inplay.txt)" | sha256sum`.
  Derive it from the rehearsal, never from a refused run's log.
- `restore_proof`: `ref:<id>` naming the restore proof, or `waived`.
- `pre_commit_abort`: what the window does if it aborts after the stop and before the
  migration commits:
  - `restart-old` restarts the stopped old containers (never recreates them);
  - `stay-stopped` keeps production down for the operator.
- `vars.PROD_HEALTH_PROBE_SILENCE` must be `true` (the build job refuses otherwise);
  unset it after verification.
- Measure the database dump size and time at a quiet hour and set
  `DEPLOY_BACKUP_TIMEOUT_S` to about twice the measured time (default 1200 s).
- No staging window-runner, docker GC or env-reconcile dispatch may run during the
  window. The deploy user's crontab must have no docker GC / prune entry (the window
  refuses otherwise).
- The quiet schedule in the window script refuses a dispatch whose expected window
  (`DEPLOY_WINDOW_EXPECTED_MIN`, default 90) overlaps a blocking scheduled job.
- Drills: `drill_fail_stage=migrate` exits 92 after the pending-set check,
  `drill_fail_stage=deploy` exits 91 after the full preflight. Neither stops anything.
- Every dispatch with `publish_images=true` moves `:latest`, including drills and
  runs the host later refuses.

Tunables (repository variables, validated before the build): `DEPLOY_WINDOW_PULL_BUDGET_KB`
(3 GiB), `DEPLOY_WINDOW_RESERVE_KB` (2 GiB), `DEPLOY_BACKUP_TIMEOUT_S` (1200),
`DEPLOY_BACKUP_VERIFY_TIMEOUT_S` (900), `DEPLOY_WINDOW_EXPECTED_MIN` (90),
`DEPLOY_WINDOW_DRAIN_S` (60), `DEPLOY_WINDOW_QUEUED_MAX_AGE_S` (86400),
`DEPLOY_WINDOW_MIN_HOST_CHECKS` (1), `DEPLOY_WINDOW_CANCEL_OWN_SESSIONS` (`false`; when
`true`, a timed-out window may `pg_cancel_backend` its own pg_dump or migrate session,
never any other backend).

## During the window

- Cancelling the GitHub run, or losing the runner's ssh session, does **not** stop the
  window: it runs detached on the host and finishes its own branch. The run only follows
  its log.
- To abort before the migration, create the abort file:
  `touch "$HOME/metasheet2-deploy-window/abort"`. Before the stop the window refuses
  (70); after the stop it restarts the old version per `pre_commit_abort` (71 or 72).
  From the migration on, the abort file is ignored. Remove the file afterwards; a stale
  abort file makes the next dispatch refuse with 70.
- Users see connection refused on the public port from the web stop to the web start
  (stop, drain, dump, dump verification, migration, backend start). There is no
  maintenance page; open tabs must be refreshed afterwards.
- The dispatcher stays on call until the window's final `outcome=` line, or, after a
  runner timeout, 255 or 76, until the host `state` shows a terminal phase.

## Outcomes

Read first: `$HOME/metasheet2-deploy-window/state`, then the run directory's `rc` and
`window.log`.

| rc | Final phase | Production | What to do |
|---|---|---|---|
| 0 | `done-new` | new version serving | unset the probe silence; keep the dump until the next committed run |
| 70 | `refused-unchanged` | old version serving; env files restored | read the refusal line in the log, fix the cause, dispatch again |
| 71 | `done-restored-old` | old containers restarted and verified | read why it aborted; the migration did not commit |
| 72 | `needs-owner` | **down**; pre-commit (the ledger is unchanged) | the stopped old containers, if they still exist, may be started by the owner (`docker start metasheet-backend`, then `metasheet-web`) only after the owner decides whether restarting the previous version is allowed. Recreating containers from an older tag would be a fresh deployment outside this window's checks; stay stopped and let the owner decide |
| 73 | `needs-owner` | migration committed; unverified containers stopped | fix forward (see below); never start the old containers |
| 74 | `needs-owner` | stopped; `.env` names the new image if the ledger reads fully applied | check `env_written` in `state`; resolve the ledger by hand with the owner |
| 75 | (state untouched) | untouched | another window holds the lock, the host state is unfinished, or flock is missing; read `state` |
| 76 | read `state` | unknown | the bootstrap lost the window; it may still be running: read `state` and `window.log` |
| 255 | read `state` | unknown | the runner lost ssh; the window may still be running: read `state` and `window.log` |

### Never, when `state` has `env_written=new`

`env_written=new` is always the case for 73; check it for 74, 76 and 255 (72 is always
before the commit). Then:

- never `docker start` the old `metasheet-backend` / `metasheet-web` containers: the old
  image does not know the new migrations;
- never run `scripts/ops/deploy-attendance-prod.sh` (it removes the postgres container);
- never run the env-reconcile workflow (it recreates the backend from `.env`);
- never run a bare `docker compose up -d` before confirming `.env` names the new image.

### Fix forward after a commit (73, 74)

With the owner's word: start the same SHA (or a hotfix SHA) by hand,
`docker compose -p <project> -f docker-compose.app.yml up -d --no-deps backend`, verify
`/health` `build.commit`, then the same for `web`. Restoring the dump needs the owner's
approval of the recovery point; follow `RESTORE-README.txt` in the run directory
(restore into a new database, globals first, sequential restore).

### Clearing the state

Only the owner clears a `needs-owner` or unfinished state, after recovery, by editing
`state` to a terminal phase or removing it. Until then every dispatch, and the host file
sync, refuses with 75.
