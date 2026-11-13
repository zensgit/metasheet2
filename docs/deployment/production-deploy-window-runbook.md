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
| `$HOME/metasheet2-deploy-window/runs/<run_id>-<attempt>/` | one directory per dispatch (mode 700): `window.log` (the same lines as the public run log), `window-detail.log` (host-only details, see "Public log and host details"), `rc`, the env snapshots, the dump `db.dump`, `meta.txt`, `globals.sql`, `shim-candidates.txt`, `RESTORE-README.txt`, `appdata.tar` when the backend held local files, `git-sync.out` (the output of the deploy checkout's git sync), and raw tool outputs. Host only; never uploaded |

The env snapshots and `globals.sql` hold secrets and password hashes. Keep the run
directories on the host and prune old dumps by hand; the workflow never deletes a
verified dump and never prunes. Never prune the run directory of a 73, 74, 76 or 255 run
while its `appdata.tar` may be the only copy of the backend's local files (see "Fix
forward after a commit").

### Public log and host details

The run log, the step summary, the uploaded deploy artifact and the read-only status step
show the dispatched commit, the phases and the outcome, but not the production state before
the deploy. These details stay on the host, in the run directory's `window-detail.log`
(mode 600), in `state` and in the raw tool outputs:

- the running and old backend/web commit, image names, ids and digests (public:
  `running_backend_commit=match`, `old_images recorded=ok`, `old version restarted revision=match`);
- the in-play migration names, the exclusion-proof details and every ledger count
  (public: `pending_set=match|mismatch`, `exclusion_proof=ok|fail`,
  `ledger=committed|rolled-back|other`, `MIGRATE COMMITTED ledger=committed`);
- the per-migration result lines of `migrate.js` (public: `migrate rc=<n> sqlstate=<code|none>`);
- database, dump, app-data and free-space sizes (public: `disk_gate=ok|fail`,
  `backup ok sha256=<hash>`, `appdata copy=ok sha256=<hash>`, `appdata read_back=match|mismatch`);
- the output of the deploy checkout's git sync (fetch, stash, checkout, merge), which names
  commits and changed files, in `git-sync.out` (public: `git_sync=ok`, or
  `git_sync=fail step=<step>`).

The host file sync step before the window still prints the deploy path's free space
(`[host-sync] disk_available_kb=`), as the workflow did before this window.

The status step prints only these `state` keys: `phase`, `rc`, `raw_rc`, `env_written`,
`backend_verified`, `web_verified`, `updated_utc`.

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
- The repository secret `DEPLOY_EXPECTED_PENDING_SHA256` = sha256 of the in-play pending
  migration names (pending names minus the committed exclusion list) in `migrate.js --list`
  load order, joined by a newline, **without** a trailing newline. From a rehearsal list
  file `inplay.txt` with one name per line: `printf '%s' "$(cat inplay.txt)" | sha256sum`.
  Derive it from the rehearsal, never from a refused run's host files. Set the secret with
  `gh secret set DEPLOY_EXPECTED_PENDING_SHA256` before the dispatch; it is compared on the
  host and never printed. It is required on every production dispatch, drills included
  (the build job refuses otherwise). Each job reads the secret when it starts, so do not
  change it while a dispatch is queued or running.
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
- `docker/app.env` must not set `LOG_LEVEL` stricter than `info` (`warn`, `error`). After
  the commit the window checks a line the new backend logs at `info`; without it every
  deploy ends 73 with the committed backend stopped.
- Check the size of the attendance-import volume (the compose volume
  `metasheet-attendance-import-data`, mounted at `/app/uploads/attendance-import`), for
  example with `docker system df -v`. After the commit, the read-back of the app data from
  the created backend streams that volume too (`docker cp` of the uploads path cannot leave
  it out; it is not counted), within 600 s per app-data path. A volume too large to stream
  in that time ends the window 73 with the new backend never started.
- A deploy is always a fresh dispatch. "Re-run failed jobs" on a deploy run skips the
  build job's input validation (the probe-silence check included) and runs the window
  again with the first attempt's inputs; never use it for the deploy job.
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
  is killed and the ledger decides; after the commit: 73 or 74). While the window waits
  for a background job (the pull, the app-data copy-out, the dump and its two reads, the
  migration), the TERM acts at once: the job is stopped (the migration one-off is killed
  and the ledger decides). Otherwise it acts once the current foreground step returns.
  Steps with a time limit: every docker and compose call except the two
  `docker image inspect` digest reads after the pull and the `docker compose` /
  `docker-compose` version probes of the prologue; every curl (5 s to connect, 10 s per
  request unless the step sets less); the deploy checkout's `git fetch` (300 s); each host
  check (400 s). The longest foreground limit is 600 s (copying the app data into, or
  reading it back from, the new backend). Steps without a limit: local file work
  (`git checkout` / `git merge` in the deploy directory, the env-file writes, listing and
  hashing the run directory's files) and `scripts/ops/attendance-preflight.sh`. The exit
  branch starts with a `raw_rc=` line in `window.log`; from then on the window ignores
  further TERM signals and ends by the same limits (restarting the old version can take
  up to about 30 minutes: host check, `docker start`, the old-version checks). If no
  `raw_rc=` line appears within 10 minutes of the TERM, the owner decides. Never send
  KILL: the window then ends without its exit branch, `state` stays unfinished, no `rc`
  file is written and production stays in whatever phase it was.
- Users see connection refused on the public port from the web stop to the web start
  (stop, drain, dump, dump verification, migration, backend start). There is no
  maintenance page; open tabs must be refreshed afterwards.
- The dispatcher stays on call until the window's final `outcome=` line, or, after a
  runner timeout, 255 or 76, until the host `state` shows a terminal phase.
- The `remote_deploy` step is limited to 285 minutes and the `deploy` job to 330. The
  window's own time limits add up to about 259 minutes with the default tunables, one
  host check per phase and every limited step at its limit; raised tunables or more host
  checks can exceed the step limit. A runner timeout
  ends only the log follower: the window finishes its branch on the host, and the
  read-only status step (or `state` on the host) shows where it ended.

## Outcomes

Read first: `$HOME/metasheet2-deploy-window/state`, then the run directory's `rc`,
`window.log` and, for counts, names and versions, `window-detail.log`.

Every deploy run ends with the read-only step "Read deploy window host state (read-only)".
It opens one more ssh session and prints the host `state`, this run's `rc` and the marker
lines of this run's `window.log` (archived as `window-status.log` in the run's deploy
artifact); it starts, stops and changes nothing. It matters after a runner timeout, 255,
76 or a cancelled run, when the log follower stopped before the window did. It is one
snapshot: if `rc` is absent and `state` is not terminal, the window may still be running;
read `state` again on the host until it is terminal.

The per-migration lines of `migrate.js` are in `window-detail.log` on the host. A
rolled-back batch still has `migration "<name>" was executed successfully` lines for its
earlier migrations before the `failed to execute migration` line; those migrations are not
applied, and the ledger (the `ledger` lines of `window-detail.log` and `state`) decides,
not those lines.

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
- A window that died without its exit branch (KILL, out of memory, a host reboot) never
  writes `rc`, and `state` keeps its last phase. When the lock is free (the `flock -n`
  command succeeds) and the `window.pid` process is gone, the window has ended: the owner
  decides from the ledger alone.
- `ledger before` and the in-play count are `ledger_before=` and `inplay=` in `state`
  (also the `ledger before=` line of `window-detail.log`).
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
- `<compose file>`: the `com.docker.compose.project.config_files` label of
  `metasheet-postgres`
  (`docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' metasheet-postgres`).
  The window verified that it is the compose file the deploy used (the
  `DEPLOY_COMPOSE_FILE` secret, default `docker-compose.app.yml`, taken relative to the
  deploy directory unless it is an absolute path; a secret cannot be read back, so use the
  label). A different file would create backend and web from another compose definition.
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
exists, or, for a window that died without its exit branch, the `window.pid` process is
gone. Until the state is cleared every dispatch, and the host file sync, refuses with 75.
