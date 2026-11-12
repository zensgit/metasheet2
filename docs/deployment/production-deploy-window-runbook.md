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
| `$HOME/metasheet2-deploy-window/host-checks/` | owner-installed host checks: every executable here runs with one argument, the phase (`pre-stop`, `pre-restart-old`, `post-backend`); all must exit 0 and at least `DEPLOY_WINDOW_MIN_HOST_CHECKS` must be present (see "Host checks") |
| `$HOME/metasheet2-deploy-window/runs/<run_id>-<attempt>/` | one directory per dispatch (mode 700): `window.log`, `rc`, the env snapshots, the dump `db.dump`, `meta.txt`, `globals.sql`, `shim-candidates.txt`, `RESTORE-README.txt`, `appdata.tar` when the backend held local files, and raw tool outputs. Host only; never uploaded |

The env snapshots and `globals.sql` hold secrets and password hashes. Keep the run
directories on the host and prune old dumps by hand; the workflow never deletes a
verified dump and never prunes. Never prune the run directory of a 73, 74, 76 or 255 run
while its `appdata.tar` may be the only copy of the backend's local files (see "Fix
forward after a commit").

### Host checks

- Each check runs under `timeout 400`; a check that runs longer counts as failed.
- Its output (stdout and stderr) goes to the run directory's `host-checks.out` on the host;
  the log carries only the check's index, the phase and `result=pass|fail`.
- A failing check, or fewer than `DEPLOY_WINDOW_MIN_HOST_CHECKS` installed, means:
  - at `pre-stop`: the window refuses with nothing changed (70);
  - at `pre-restart-old` (restarting the old version after an abort before the commit):
    nothing is started and production stays **down** (72);
  - at `post-backend`: the committed new backend is stopped, web is never started (73).

## Before dispatching

- The deploy commit is main HEAD at dispatch time, and the whole pending migration set
  at that commit was rehearsed on a production-schema copy.
- `expected_pending_sha256` = sha256 of the in-play pending migration names (pending
  names minus the committed exclusion list) in `migrate.js --list` load order, joined
  by a newline, **without** a trailing newline. From a rehearsal list file
  `inplay.txt` with one name per line: `printf '%s' "$(cat inplay.txt)" | sha256sum`.
  Derive it from the rehearsal, never from a refused run's log.
- `restore_proof`: `ref:<id>` naming the restore proof, or `waived`. The id is printed in
  the public run log and step summary; use an opaque id that maps to the proof only in
  private records.
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
- The abort file is not read continuously. The window checks it at the start and at four
  boundaries only: before the stop (after the preflight and the pull), right after the
  stop and the session drain, after the backup, and right before the migration. A file
  created during the dump takes effect only after the dump and both reads of the archive
  (with the default timeouts up to about 50 minutes later).
- To stop a hung or unwanted window at once, send TERM to the process in the run's
  `window.pid`: `kill -TERM "$(cat "$HOME/metasheet2-deploy-window/runs/<run_id>-<attempt>/window.pid")"`.
  It takes the same branch as an abort for the phase it is in (before the stop: 70; after
  the stop and before the commit: per `pre_commit_abort`; during the migration: the one-off
  is killed and the ledger decides; after the commit: 73 or 74). It acts once the current
  foreground step returns (every step is bounded by a timeout). Never send KILL: the window
  then ends without its exit branch, `state` stays unfinished and production stays in
  whatever phase it was.
- Users see connection refused on the public port from the web stop to the web start
  (stop, drain, dump, dump verification, migration, backend start). There is no
  maintenance page; open tabs must be refreshed afterwards.
- The dispatcher stays on call until the window's final `outcome=` line, or, after a
  runner timeout, 255 or 76, until the host `state` shows a terminal phase.

## Outcomes

Read first: `$HOME/metasheet2-deploy-window/state`, then the run directory's `rc` and
`window.log`.

Every deploy run ends with the read-only step "Read deploy window host state (read-only)".
It opens one more ssh session and prints the host `state`, this run's `rc` and the marker
lines of this run's `window.log` (archived as `window-status.log` in the run's deploy
artifact); it starts, stops and changes nothing. It matters after a runner timeout, 255,
76 or a cancelled run, when the log follower stopped before the window did. It is one
snapshot: if `rc` is absent and `state` is not terminal, the window may still be running;
read `state` again on the host until it is terminal.

A rolled-back batch still prints `migration "<name>" was executed successfully` lines
for its earlier migrations before the `failed to execute migration` line; those
migrations are not applied, and the ledger (the window's `ledger` lines and `state`)
decides, not those lines.

| rc | Final phase | Production | What to do |
|---|---|---|---|
| 0 | `done-new` | new version serving | unset the probe silence; keep the dump until the next committed run |
| 70 | `refused-unchanged` | old version serving; env files restored | read the refusal line in the log, fix the cause, dispatch again |
| 71 | `done-restored-old` | old containers restarted and verified | read why it aborted; the migration did not commit |
| 72 | `needs-owner` | **down**; pre-commit (the ledger is unchanged) | the stopped old containers, if they still exist, may be started by the owner (`docker start metasheet-backend`, then `metasheet-web`) only after the owner decides whether restarting the previous version is allowed. Recreating containers from an older tag would be a fresh deployment outside this window's checks; stay stopped and let the owner decide |
| 73 | `needs-owner` | migration committed; unverified containers stopped | fix forward (see below); never start the old containers |
| 74 | `needs-owner` | stopped; the ledger may be committed even when `state` says `env_written=old`; `.env` names the new image only when `state` says `env_written=new` | start nothing (see "Never" below); the owner reads the ledger, then fixes forward or resolves it by hand |
| 75 | (state untouched) | untouched | another window holds the lock, the host state is unfinished, or flock is missing; read `state` |
| 76 | read `state` | unknown | the bootstrap lost the window; it may still be running: read `state` and `window.log` |
| 255 | read `state` | unknown | the runner lost ssh; the window may still be running: read `state` and `window.log` |

Old and new containers carry the same names (`metasheet-backend`, `metasheet-web`); after a
73 the container of that name may already be the new one. A container is the old one when
its image id (`docker inspect -f '{{.Image}}' <name>`) equals `old_backend_image_id` /
`old_web_image_id` in `state`.

### Never, after 73, 74, 76, 255 or a missing rc

These rules hold whatever `env_written` says (`env_written=old` does not prove the
migration did not commit; 72 is always before the commit). They hold until the window
has ended and the owner has read the ledger.

- The window has ended when `state` shows a terminal phase with `rc=` set, or the process
  in the run's `window.pid` is gone; and `flock -n "$HOME/metasheet2-deploy-window/lock" true`
  succeeds and the run's `rc` file exists. While the window may still run, a ledger at the
  `ledger before` count proves nothing: the window may be about to migrate.
- Then the ledger either reads fully applied (`ledger before` + the in-play count, every
  name of the run directory's `inplay.txt` present), and the owner fixes forward as below;
  or it reads the run's `ledger before` count with none of the names in `inplay.txt`
  present and no `metasheet-window-migrate-*` container or database session alive, and the
  case is a pre-commit one (the 72 row applies).

Until then:

- never `docker start` the old `metasheet-backend` / `metasheet-web` containers: the old
  image does not know the new migrations;
- never run `scripts/ops/deploy-attendance-prod.sh` (it removes the postgres container);
- never run the env-reconcile workflow (it recreates the backend from `.env`);
- never run a bare `docker compose up -d`.

### Fix forward after a commit (73, 74)

With the owner's word, and only when the ledger reads fully applied, start the same SHA
(or a hotfix SHA) by hand, with the compose file and from the directory the deploy used:

- `<deploy dir>`: the `com.docker.compose.project.working_dir` label of `metasheet-postgres`
  (`docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' metasheet-postgres`);
  the run's `[deploy] repo_path=` line names the same directory. Run every step below
  from it (`cd <deploy dir>`).
- `<compose file>`: `<deploy dir>/<DEPLOY_COMPOSE_FILE>`, the compose file the deploy used
  (the `DEPLOY_COMPOSE_FILE` secret, default `docker-compose.app.yml`). It equals the
  `com.docker.compose.project.config_files` label of `metasheet-postgres`; a different
  file would create backend and web from another compose definition.
- `<project>`: the value of the run's `compose_identity=match project=` log line (the
  `com.docker.compose.project` label of `metasheet-postgres`).
- `<run dir>`: `$HOME/metasheet2-deploy-window/runs/<run_id>-<attempt>` of the run;
  `<sha>`: the full 40-character commit.

Run the steps in order: the compose commands only after `.env` was confirmed in step 1.

1. Set or confirm `IMAGE_OWNER=zensgit` and `IMAGE_TAG=<sha>` in `<deploy dir>/.env`.
2. Create the backend without starting it:
   `IMAGE_OWNER=zensgit IMAGE_TAG=<sha> docker compose -p <project> --project-directory <deploy dir> -f <compose file> up --no-start --no-deps --force-recreate backend`.
3. If the run directory has `appdata.tar`, copy it into that container before its first
   start: `docker cp - metasheet-backend:/ < <run dir>/appdata.tar`. This applies to every
   newly created backend container, a hotfix one included. Keep the run directory until
   the files are confirmed in the running backend.
4. `docker start metasheet-backend`, then verify `/health` `build.commit` equals `<sha>`.
5. Web: `IMAGE_OWNER=zensgit IMAGE_TAG=<sha> docker compose -p <project> --project-directory <deploy dir> -f <compose file> up -d --no-deps --force-recreate web`,
   then verify `/build-info.json` `commit` equals `<sha>`.

Restoring the dump needs the owner's approval of the recovery point; follow
`RESTORE-README.txt` in the run directory (restore into a new database, globals first,
sequential restore).

### Clearing the state

Only the owner clears a `needs-owner` or unfinished state, after recovery, by editing
`state` to a terminal phase or removing it. First confirm that no window is running:
`flock -n "$HOME/metasheet2-deploy-window/lock" true` succeeds and the run's `rc` file
exists. Until the state is cleared every dispatch, and the host file sync, refuses with 75.
