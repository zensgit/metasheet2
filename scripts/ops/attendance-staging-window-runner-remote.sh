#!/usr/bin/env bash
# attendance-staging-window-runner-remote.sh
#
# Remote (deploy-host) half of .github/workflows/attendance-staging-window-runner.yml.
# Executes ONE action per invocation against the STAGING stack only:
#   deploy         — pin staging backend+web to a full-SHA image tag, migrate, verify build+auth
#   smoke          — run one of the five window smokes in-container (bundle doc:
#                    docs/development/attendance-staging-window-bundle-20260702.md)
#   status         — read-only snapshot (containers, health, settings, pending migrations)
#   migrate        — backup + clone-rehearsal + apply, per
#                    docs/operations/staging-migration-alignment-runbook.md and
#                    docs/development/staging-migration-alignment-runbook-verification-20260519.md.
#                    Only reachable path from a `do_not_run_full_migrate` decision surfaced by
#                    action=deploy's migration-alignment gate: pg_dump the real staging DB to a
#                    HOST file (never uploaded — business data), clone-restore it into a
#                    throwaway `window_runner_rehearsal` DB inside the SAME postgres container,
#                    run migrate.js against ONLY the rehearsal DB, and require it to fully
#                    succeed (pending=0) before ever touching the real staging DB. The rehearsal
#                    DB is always dropped (trap-guarded), including on failure.
#   residue-sweep  — bundle §7 "Consolidated final residue sweep": every §7 cross-smoke SQL
#                    count (users/user_orgs/records/requests/deliveries, OT-bank money-path,
#                    approval-engine, plus the optional MP-6/HMR-5 blocks), run read-only via
#                    `docker exec metasheet-staging-postgres psql -tA`, against the REAL
#                    staging DB (never a rehearsal DB — this action never writes). Fails iff
#                    any count is nonzero. Also captures env flags + GET
#                    /api/attendance/settings into the same artifact. See action_residue_sweep
#                    below for the per-query §7→SQL substitution notes (the bundle's own
#                    `:otbank_approval_ids` / `:otbank_cycle_ids` / `:mp6_request_ids` /
#                    `:mp6_approval_ids` / `:rd45_smoke_org` / `:hmr5_org` placeholders name
#                    captured-id lists the smoke helpers print to logs but never archive to a
#                    file this script can read back — each is replaced by a
#                    stamp/prefix-anchored equivalent query, documented at its call site).
#   soak-baseline  — #4556 W4+W7 combined-soak step 0: capture the O4-2 pre-enablement p95
#                    baseline (P95-BASELINE-CAPTURE-PACK-20260816) via
#                    `docker exec metasheet-staging-postgres psql -tA`, named
#                    p95-baseline-<sha8>-<ts>. FAILS CLOSED if either soak allowlist env
#                    (W4 ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED / W7
#                    ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED) is already set on the backend —
#                    a baseline captured after enablement is not a baseline.
#   soak-seed      — idempotently seed the three synthetic soak orgs (users/user_orgs/
#                    full-day shift+segment/group/fixed-schedule config/members/published
#                    group-produced assignments/calc-group memberships — mirroring
#                    attendance-w7-1b-cutover-e2e.db.test.ts seedShiftAndEffectiveGroup),
#                    then walk POSTURE through the REAL operator CLIs only (never a bare
#                    INSERT — the posture tables carry legal-transition triggers):
#                    W4 legacy->shadow for org2+org3 via attendance-w4c5-rollout-transition.ts,
#                    W7 off->group_shadow for org3 via attendance-w7-context-source-transition.ts,
#                    both run inside the deployed backend image (its own CLI copy, so CLI and
#                    boundary are the same build). org1 stays legacy/off (three-posture design).
#   soak-flags     — write the two soak allowlist env vars into the SAME persistent runner
#                    override the deploy action manages (atomic candidate->validate->rename),
#                    recreate ONLY the backend container (postgres/redis/web asserted
#                    untouched by container-id comparison), verify via docker exec env + a
#                    health check. REFUSES unless soak-baseline's marker exists on the host
#                    (order enforcement: baseline BEFORE flags).
#   soak-run       — log every synthetic user in through the REAL POST /api/auth/login route
#                    (tokens are never minted for soak users), then run the committed
#                    attendance-w4w7-soak-load-generator.mjs IN the backend container against
#                    the in-container BASE_URL at the ruled <=1 req/sec ceiling; upload the
#                    tally JSON (haltedReason is load-bearing — only targets_met means the
#                    invocation's targets were reached).
#   soak-status    — the daily monitoring channel: run the soak monitoring pack's Q1-Q16
#                    read set plus the W7-2 compare-window counters (marker
#                    'w7GroupShadowCompare' + selector 'group_effective', mirroring
#                    w7-compare-window-status.ts) via psql, read-only; exits nonzero when a
#                    mechanical alert condition fires (critical diffs / unresolved reviews /
#                    orphans / selector-less corruption).
#
# HARD SAFETY RAILS:
#   * Operates exclusively on the staging compose file docker-compose.app.staging.yml
#     and the metasheet-staging-{backend,web,postgres,redis} containers. Fails closed
#     if the staging compose file is absent or does not define the staging containers.
#   * NEVER runs compose against the prod-track stack, and NEVER recreates staging
#     postgres/redis (deploy uses `up -d --no-deps backend web` and asserts the
#     postgres/redis container ids are unchanged afterwards).
#   * Invoked by the workflow as `bash -o pipefail -c '<script>'`; this file also sets
#     pipefail itself so pipelines inside it stay strict when run directly.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=attendance-window-runner-pipeline.lib.sh
source "${HERE}/attendance-window-runner-pipeline.lib.sh"

log() { echo "[window-runner] $*"; }
fail() { echo "[window-runner][error] $*" >&2; exit 1; }

hash_value() {
  # sha256 of a file, tool-portable (GNU sha256sum on the deploy host; shasum fallback).
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    fail "no sha256 tool available (need sha256sum or shasum) to hash ${file}"
  fi
}

ACTION="${ACTION:?ACTION is required (deploy|smoke|status|migrate|residue-sweep|soak-baseline|soak-seed|soak-flags|soak-run|soak-status)}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
SMOKE_ID="${SMOKE_ID:-}"
SET_WINDOW_ENV="${SET_WINDOW_ENV:-none}"
FORCE_RECREATE="${FORCE_RECREATE:-false}"
STAMPS="${STAMPS:-}"
SOAK_ORGS="${SOAK_ORGS:-}"
SOAK_OPTS="${SOAK_OPTS:-}"
STAGING_DEPLOY_PATH="${STAGING_DEPLOY_PATH:-metasheet2-dingtalk-staging}"
DEPLOY_PATH="${DEPLOY_PATH:-metasheet2}"
SKIP_HOST_SYNC="${SKIP_HOST_SYNC:-false}"
OUTPUT_DIR="${OUTPUT_DIR:?OUTPUT_DIR is required}"
IMAGE_OWNER="${IMAGE_OWNER:-zensgit}"
RUN_STAMP="${RUN_STAMP:?RUN_STAMP is required (workflow run id marker)}"

case "$FORCE_RECREATE" in
  true|false) ;;
  *) fail "FORCE_RECREATE must be true or false, got: '${FORCE_RECREATE}'" ;;
esac
if [[ "$ACTION" != "deploy" && "$FORCE_RECREATE" == "true" ]]; then
  fail "FORCE_RECREATE=true is only allowed for action=deploy"
fi

BACKEND_CONTAINER="metasheet-staging-backend"
WEB_CONTAINER="metasheet-staging-web"
POSTGRES_CONTAINER="metasheet-staging-postgres"
REDIS_CONTAINER="metasheet-staging-redis"
CONTAINER_RUNNER_DIR="/tmp/window-runner"
STAGING_WEB_HEALTH_URL="http://127.0.0.1:8082/api/health"
STAGING_BACKEND_HEALTH_URL="http://127.0.0.1:18900/health"
IN_CONTAINER_BASE_URL="http://127.0.0.1:8900"
MIGRATE_JS="packages/core-backend/dist/src/db/migrate.js"
TARGET_MIGRATION_IMAGE=""
TARGET_MIGRATION_IMAGE_ID=""
TARGET_MIGRATION_REPO_DIGEST=""
TARGET_MIGRATION_ENV_FILE=""
# P1-1/P2-4 hardening (2026-08-24, staging-review-adjudication-20260824.md): the running
# backend's Config.Env is NOT copied verbatim into TARGET_MIGRATION_ENV_FILE any more (that
# copy previously carried every staging secret PLUS any inherited MIGRATION_EXCLUDE /
# MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL / ALLOW_DB_RESET straight into every migrate
# `docker run`). Only names on THIS allowlist are written. Each entry below is the FULL
# migrate-path env surface as read from source. CENSUS METHOD (corrected 2026-08-25 — the
# original claim named 5 files and said "zero other reads found", but the real IMPORT CLOSURE of
# migrate.ts is 9 files and one of the unnamed four DID read an env var; a census whose scope is
# smaller than the code it vouches for produces honest-looking absences): walk the full import
# closure of migrate.ts (incl. core/logger.ts, context/request-context.ts,
# integration/metrics/metrics.ts), grep `process\.env\.` in
# every file, plus every file under src/db/migrations|migrations/:
#   DATABASE_URL                    - connection-pool.ts:200 secretManager.get('DATABASE_URL', ...)
#   NODE_ENV                        - connection-pool.ts:200,207 (required/ssl gate);
#                                      SecretManager.ts:69,74 (fallback + provider-required gate).
#                                      Staging pins NODE_ENV=production (docker/app.staging.env.example:6)
#                                      — dropping it would silently fall back to the image's own
#                                      Dockerfile ENV default (also production), so this is about
#                                      staying in explicit lockstep with the running backend, not a
#                                      behavior change by itself.
#   DB_SSL                          - connection-pool.ts:205 sslDisabledByEnv. MUST-HAVE: staging
#                                      pins DB_SSL=false (docker/app.staging.env.example:28) against a
#                                      non-SSL postgres; NODE_ENV=production is always true inside the
#                                      migration container (image default), so omitting DB_SSL flips
#                                      ssl ON and breaks the connection (adjudication P1-1 refinement 2).
#   DB_SSL_REJECT_UNAUTHORIZED      - connection-pool.ts:209
#   DB_SSL_CA                       - connection-pool.ts:210
#   DB_SSL_CERT                     - connection-pool.ts:211
#   DB_SSL_KEY                      - connection-pool.ts:212
#   DB_POOL_MAX                     - connection-pool.ts:222
#   DB_POOL_MIN                     - connection-pool.ts:223
#   DB_IDLE_TIMEOUT                 - connection-pool.ts:226
#   DB_CONNECT_TIMEOUT              - connection-pool.ts:227
#   DB_QUERY_TIMEOUT                - connection-pool.ts:234
#   DB_STATEMENT_TIMEOUT            - connection-pool.ts:235
#   DB_SLOW_MS                      - connection-pool.ts:238 (also read directly at :58)
#   APP_NAME                        - connection-pool.ts:242 (pg application_name)
#   STORAGE_BASE_URL                - zzzz20260710140000_add_files_storage_key.ts:77 (backfill
#                                      migration; already applied on staging, kept for generality
#                                      per the adjudication — a rollback/replay could still read it)
#   SECRET_PROVIDER                 - SecretManager.ts:74 (selects env|file|vault)
#   SECRET_FILE_PATH                - SecretManager.ts:79 (only consulted when SECRET_PROVIDER=file;
#                                      passed through so the migration container keeps whatever
#                                      provider mode the running backend actually uses — NOT asserting
#                                      env-provider, which the adjudication offers as an alternative
#                                      but which would need its own separate verification the runner
#                                      cannot make today)
#   LOG_LEVEL                       - core/logger.ts:78 (in migrate.ts's import closure; unset
#                                      falls back to 'info' — inert today, allowlisted so the
#                                      census and the allowlist describe the same closure)
# Deliberately NOT allowlisted: ALLOW_SECRET_FALLBACK (SecretManager.ts:69) — staging's template
# never sets it and its absence is fail-CLOSED-safe (a genuinely missing required secret throws
# rather than silently degrading), consistent with this allowlist's containment goal. Also never
# allowlisted: MIGRATION_EXCLUDE / MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL / ALLOW_DB_RESET — those
# three are handled by the separate detect-and-abort + forced -e neutralization below
# (materialize_target_migration_env, target_migrate_exec), never by silent inclusion here.
TARGET_MIGRATION_ENV_ALLOWLIST=(
  DATABASE_URL NODE_ENV
  DB_SSL DB_SSL_REJECT_UNAUTHORIZED DB_SSL_CA DB_SSL_CERT DB_SSL_KEY
  DB_POOL_MAX DB_POOL_MIN DB_IDLE_TIMEOUT DB_CONNECT_TIMEOUT
  DB_QUERY_TIMEOUT DB_STATEMENT_TIMEOUT DB_SLOW_MS APP_NAME
  STORAGE_BASE_URL SECRET_PROVIDER SECRET_FILE_PATH LOG_LEVEL
)
# Fixed, clearly-synthetic rehearsal DB name for action=migrate. Lives inside the SAME
# postgres container/server as staging, never on a different host, and is always dropped
# (created fresh each run — never assumed to persist).
REHEARSAL_DB="window_runner_rehearsal"
# Host-side backup dir for action=migrate (HOME is writable; the staging repo dir is not
# — proven by run 29313154282, same reason OVERRIDE_FILE above lives under ${HOME}/.metasheet2).
BACKUP_DIR="${HOME}/window-runner-backups"

resolve_home_path() {
  local raw="$1"
  if [[ "$raw" == /* ]]; then
    printf '%s' "$raw"
  elif [[ "$raw" == ~/* ]]; then
    printf '%s' "${HOME}/${raw#~/}"
  else
    printf '%s' "${HOME}/${raw}"
  fi
}

STAGING_DIR="$(resolve_home_path "$STAGING_DEPLOY_PATH")"
PROD_REPO_DIR="$(resolve_home_path "$DEPLOY_PATH")"
LEGACY_STAGING_COMPOSE_FILE="${STAGING_DIR}/docker-compose.app.staging.yml"
# The override MUST persist across runs. `docker compose up -d` stamps each container's
# com.docker.compose.project.config_files label with the -f paths it was given, so any later
# `docker compose config` (e.g. the recovery-flag containment check) re-reads THIS file BY PATH.
# When the override lived under the per-run $OUTPUT_DIR (which the workflow rm -rf's on cleanup),
# that label dangled and staging's next-restart config became unverifiable — run 29398270060
# FAIL-CLOSED. It still cannot live under ${STAGING_DIR} (the SSH user has no write there — run
# 29313154282 "Permission denied"), so it lives in a stable, deploy-user-writable directory under
# $HOME that the workflow cleanup never touches. Rewritten atomically on each deploy (temp file +
# `docker compose config` validation + rename); set_window_env=none rewrites it WITHOUT the flags,
# preserving the removal semantic.
RUNNER_PERSIST_DIR="${HOME}/.metasheet2/window-runner"
OVERRIDE_FILE="${RUNNER_PERSIST_DIR}/docker-compose.window-runner.override.yml"
PERSISTENT_STAGING_COMPOSE_FILE="${RUNNER_PERSIST_DIR}/docker-compose.app.staging.yml"
STAGING_COMPOSE_FILE="$LEGACY_STAGING_COMPOSE_FILE"
if [[ -f "$PERSISTENT_STAGING_COMPOSE_FILE" ]]; then
  STAGING_COMPOSE_FILE="$PERSISTENT_STAGING_COMPOSE_FILE"
fi

# --- W4+W7 combined-soak (#4556) constants ---------------------------------------------
# Everything soak-persistent lives under the SAME workflow-cleanup-immune persist dir as the
# compose override (see the comment above OVERRIDE_FILE). The credentials file is host-only,
# 0600, and NEVER copied into OUTPUT_DIR (public-repo artifacts are world-downloadable).
SOAK_PERSIST_DIR="${RUNNER_PERSIST_DIR}/soak"
SOAK_BASELINE_MARKER="${SOAK_PERSIST_DIR}/p95-baseline.marker"
SOAK_WINDOW_START_FILE="${SOAK_PERSIST_DIR}/soak-window-start"
SOAK_HOST_CONFIG_FILE="${SOAK_PERSIST_DIR}/soak-config.json"
SOAK_CREDENTIALS_FILE="${SOAK_PERSIST_DIR}/credentials.env"
# Closed synthetic user family (generator README convention): USERNAMES synth-w4w7-<org8>-u<NN>.
# The prefix marks usernames/emails, NEVER user ids: ids are minted UUIDs because the W4C0
# §4.1 canonical identity gate fail-closes non-UUID user ids at the live shadow boundary
# (staging run 31957449480 — a TEXT family id 500s every punch once its org enters W4 shadow).
SOAK_USER_PREFIX="synth-w4w7-"
SOAK_W4_ENV_NAME="ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED"
SOAK_W7_ENV_NAME="ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED"
SOAK_GENERATOR_SCRIPT="attendance-w4w7-soak-load-generator.mjs"
SOAK_UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
# Manifest reference pattern — mirrors REF_PATTERN in both transition-CLI libs.
SOAK_REF_RE='^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
# soak_seed_rotate_password's RAISE NOTICE result line (no GNU-vs-BSD `\+` trap: bash's own
# `=~` is POSIX ERE on every platform, and the grep pre-filter below uses `-E` for the same
# reason — neither depends on the host sed/grep BRE dialect).
SOAK_ROTATE_NOTICE_RE='ROTATE_RESULT family_count=([0-9]+) updated_count=([0-9]+)'
# The DEPLOYED image's own CLI copies — deliberately /app paths, NOT host-synced copies:
# the CLI and the transition boundary it drives must come from the same build.
SOAK_W4C5_CLI="/app/scripts/ops/attendance-w4c5-rollout-transition.ts"
SOAK_W7_CLI="/app/scripts/ops/attendance-w7-context-source-transition.ts"
SOAK_TSX="/app/node_modules/tsx/dist/cli.mjs"
SOAK_SEED_START_DATE="2026-01-01"
SOAK_SEED_END_DATE="2027-12-31"

# --- staging-only guard (fail closed) -------------------------------------------------
assert_staging_only() {
  [[ -d "$STAGING_DIR" ]] || fail "staging stack directory missing: ${STAGING_DIR} (set STAGING_DEPLOY_PATH); refusing to guess"
  [[ -f "$STAGING_COMPOSE_FILE" ]] || fail "staging compose file missing: ${STAGING_COMPOSE_FILE}; fail closed — this runner never falls back to another compose file"
  grep -q "container_name: ${BACKEND_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "compose file does not define ${BACKEND_CONTAINER}; refusing (wrong file?)"
  grep -q "container_name: ${WEB_CONTAINER}" "$STAGING_COMPOSE_FILE" \
    || fail "compose file does not define ${WEB_CONTAINER}; refusing (wrong file?)"
  if grep -qE 'container_name: metasheet-(backend|web|postgres|redis)[[:space:]]*$' "$STAGING_COMPOSE_FILE"; then
    fail "compose file defines PROD-track container names; refusing"
  fi
  if [[ "$STAGING_DIR" == "$PROD_REPO_DIR" ]]; then
    fail "staging stack dir equals the prod-track repo dir (${STAGING_DIR}); refusing"
  fi
  log "staging-only guard OK: dir=${STAGING_DIR} compose=$(basename "$STAGING_COMPOSE_FILE")"
}

require_compose_v2() {
  if docker compose version >/dev/null 2>&1; then
    return 0
  fi
  fail "docker compose v2 plugin is required (legacy docker-compose v1 breaks up -d against existing containers; see docs/development/staging-deploy-d88ad587b-20260426.md)"
}

compose_staging() {
  # The ONLY compose entry point in this script: staging compose file + runner override.
  (cd "$STAGING_DIR" && IMAGE_OWNER="$IMAGE_OWNER" IMAGE_TAG="$DEPLOY_SHA" \
    docker compose --project-directory "$STAGING_DIR" -f "$STAGING_COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@")
}

prepare_staging_compose_for_deploy() {
  local candidate="${HERE}/docker-compose.app.staging.yml"
  [[ -f "$candidate" ]] || fail "checked-out staging compose candidate missing: ${candidate}"
  for name in "$BACKEND_CONTAINER" "$WEB_CONTAINER" "$POSTGRES_CONTAINER" "$REDIS_CONTAINER"; do
    grep -q "container_name: ${name}" "$candidate" \
      || fail "staging compose candidate does not define ${name}; refusing install"
  done
  if grep -qE 'container_name: metasheet-(backend|web|postgres|redis)[[:space:]]*$' "$candidate"; then
    fail "staging compose candidate defines PROD-track container names; refusing install"
  fi

  mkdir -p "$RUNNER_PERSIST_DIR"
  STAGING_COMPOSE_CANDIDATE_TMP="$(mktemp "${RUNNER_PERSIST_DIR}/.staging-compose.XXXXXX")"
  cp "$candidate" "$STAGING_COMPOSE_CANDIDATE_TMP"
  if ! (cd "$STAGING_DIR" && IMAGE_OWNER="$IMAGE_OWNER" IMAGE_TAG="$DEPLOY_SHA" \
    docker compose --project-directory "$STAGING_DIR" -f "$STAGING_COMPOSE_CANDIDATE_TMP" config) >/dev/null 2>&1; then
    rm -f "$STAGING_COMPOSE_CANDIDATE_TMP"
    STAGING_COMPOSE_CANDIDATE_TMP=""
    fail "checked-out staging compose candidate failed validation; kept ${STAGING_COMPOSE_FILE}"
  fi
}

staging_exec() {
  # The ONLY docker-exec entry point: pinned staging backend container name.
  docker exec "$BACKEND_CONTAINER" "$@"
}

staging_exec_env() {
  # docker exec with -e pairs: staging_exec_env "A=1" "B=2" -- cmd...
  local -a env_flags=()
  while [[ "$#" -gt 0 && "$1" != "--" ]]; do
    env_flags+=(-e "$1")
    shift
  done
  [[ "${1:-}" == "--" ]] && shift
  docker exec ${env_flags[@]+"${env_flags[@]}"} "$BACKEND_CONTAINER" "$@"
}

cleanup_target_migration_runtime() {
  # The env file carries a (now allowlist-narrowed, but still real) DB DSN and possibly a
  # secrets-file path. It is materialized only because docker run has no safe "inherit
  # another container's env" primitive; never copy it to OUTPUT_DIR or print it.
  # P2-4 hardening (2026-08-24): overwrite-before-unlink (shred) when available, so a crash
  # between materialization and this cleanup does not leave forensically-recoverable
  # plaintext disk blocks behind after the unlink. Falls back to a plain rm -f on hosts
  # without shred(1) — still correct, just the pre-hardening guarantee (mode 0600 + rm).
  if [[ -n "${TARGET_MIGRATION_ENV_FILE:-}" ]]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u -z -n 1 -- "$TARGET_MIGRATION_ENV_FILE" 2>/dev/null || rm -f -- "$TARGET_MIGRATION_ENV_FILE"
    else
      rm -f -- "$TARGET_MIGRATION_ENV_FILE"
    fi
    TARGET_MIGRATION_ENV_FILE=""
  fi
}

materialize_target_migration_env() {
  # P1-1 hardening (2026-08-24, staging-review-adjudication-20260824.md): previously this
  # copied the running backend's ENTIRE Config.Env verbatim into TARGET_MIGRATION_ENV_FILE,
  # so an inherited MIGRATION_EXCLUDE / MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL /
  # ALLOW_DB_RESET reached the migration container's process.env unfiltered — silently
  # shrinking the manifest `--list`/`--confirm` certify while `Pending: 0` stays green
  # (migration-provider.ts:267-272,309-311). Two independent layers now:
  #   (a) detect-and-FAIL-LOUD (preferred, per the adjudication's refinement 1): if the
  #       INHERITED env carries any of the three hazard variables in a hazardous state,
  #       abort naming ONLY the variable name(s) — never the value — before writing
  #       anything to disk. This is either host-side env drift or an undocumented owner
  #       ruling the runner must not silently honor (migration-provider.ts's own docblock:
  #       "never a normal deploy switch" / staging audit 20260519:132 "do not hide this
  #       with a broad MIGRATION_EXCLUDE until ... explicitly accepted").
  #   (b) allowlist (defense-in-depth / least-privilege, TARGET_MIGRATION_ENV_ALLOWLIST
  #       above): only pass through names the migrate path actually reads. The three
  #       hazard vars are deliberately never on that allowlist, so even if (a) somehow
  #       didn't fire they still would not reach the file this way.
  # target_migrate_exec below ALSO forces -e MIGRATION_EXCLUDE=/…=false/…=false on every
  # migrate-family docker run as a third, independent backstop (docker applies trailing -e
  # after --env-file, so it always wins regardless of what (a)/(b) let through).
  local allowlist_csv
  allowlist_csv="$(printf '%s,' "${TARGET_MIGRATION_ENV_ALLOWLIST[@]}")"
  # Reject multiline/NUL values: Docker's env-file grammar cannot preserve them byte-for-byte.
  # The JSON and resulting secret file are never emitted to logs or artifacts.
  docker inspect -f '{{json .Config.Env}}' "$BACKEND_CONTAINER" \
    | TARGET_ENV_FILE="$TARGET_MIGRATION_ENV_FILE" TARGET_ENV_ALLOWLIST_CSV="$allowlist_csv" python3 -c '
import json, os, sys

values = json.load(sys.stdin)
if not isinstance(values, list) or not values:
    raise SystemExit("running backend has no Config.Env")

pairs = []
for value in values:
    if not isinstance(value, str) or "=" not in value or any(c in value for c in ("\n", "\r", "\0")):
        raise SystemExit("running backend has an env entry incompatible with a secure env-file")
    name, _, val = value.partition("=")
    pairs.append((name, val))

# (a) detect-and-fail-loud: values-free by construction (only names ever reach the message).
def is_truthy(v):
    return v.strip().lower() == "true"

hazards = []
for name, val in pairs:
    if name == "MIGRATION_EXCLUDE" and val.strip() != "":
        hazards.append(name)
    elif name == "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL" and is_truthy(val):
        hazards.append(name)
    elif name == "ALLOW_DB_RESET" and is_truthy(val):
        hazards.append(name)
if hazards:
    names = ", ".join(sorted(set(hazards)))
    raise SystemExit(
        "ABORT: the running backend'"'"'s inherited environment carries hazardous "
        "migration-control variable(s): " + names + " (value withheld). This can silently "
        "narrow or reset the migration manifest that Pending:0 certifies. This is either "
        "host-side env drift or an owner ruling this runner must not silently honor -- "
        "resolve it as its own change, never by rerunning this action."
    )

# (b) allowlist: only names the migrate path actually reads (see the bash comment above
# TARGET_MIGRATION_ENV_ALLOWLIST for the per-entry source justification).
allowlist = set(n for n in os.environ["TARGET_ENV_ALLOWLIST_CSV"].split(",") if n)
filtered = [f"{name}={val}" for name, val in pairs if name in allowlist]

path = os.environ["TARGET_ENV_FILE"]
with open(path, "w", encoding="utf-8", newline="\n") as handle:
    handle.write("\n".join(filtered) + "\n")
'
}

prepare_target_migration_image() {
  require_sha
  TARGET_MIGRATION_IMAGE="ghcr.io/${IMAGE_OWNER}/metasheet2-backend:${DEPLOY_SHA}"

  log "target migration universe: pulling exact image ${TARGET_MIGRATION_IMAGE} (running application is not changed)"
  docker pull "$TARGET_MIGRATION_IMAGE" 2>&1 | tee "${OUTPUT_DIR}/target-image-pull.log"

  local revision
  revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$TARGET_MIGRATION_IMAGE" 2>/dev/null || true)"
  [[ "$revision" == "$DEPLOY_SHA" ]] \
    || fail "target migration image revision mismatch: expected ${DEPLOY_SHA}, got '${revision:-<missing>}'"
  TARGET_MIGRATION_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$TARGET_MIGRATION_IMAGE")"
  TARGET_MIGRATION_REPO_DIGEST="$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$TARGET_MIGRATION_IMAGE" | grep '/metasheet2-backend@' | head -n 1 || true)"
  [[ -n "$TARGET_MIGRATION_REPO_DIGEST" ]] \
    || fail "target migration image has no metasheet2-backend repo digest after pull; refusing an unattested migration run"

  mkdir -p "$RUNNER_PERSIST_DIR"
  TARGET_MIGRATION_ENV_FILE="$(mktemp "${RUNNER_PERSIST_DIR}/.target-migrate-env.XXXXXX")"
  chmod 0600 "$TARGET_MIGRATION_ENV_FILE"
  materialize_target_migration_env

  {
    echo "image=${TARGET_MIGRATION_IMAGE}"
    echo "revision=${revision}"
    echo "image_id=${TARGET_MIGRATION_IMAGE_ID}"
    echo "repo_digest=${TARGET_MIGRATION_REPO_DIGEST}"
    echo "running_application_changed=no"
  } > "${OUTPUT_DIR}/target-migration-image.txt"
}

target_migrate_exec() {
  # target_migrate_exec ["A=1" ...] -- command args...
  local -a env_flags=()
  while [[ "$#" -gt 0 && "$1" != "--" ]]; do
    env_flags+=(-e "$1")
    shift
  done
  [[ "${1:-}" == "--" ]] && shift
  [[ -n "$TARGET_MIGRATION_IMAGE" && -r "$TARGET_MIGRATION_ENV_FILE" ]] \
    || fail "target migration runtime was not prepared"
  # P1-1 hardening, layer 3 (defense-in-depth backstop behind materialize_target_migration_env's
  # detect-and-abort + allowlist): force the three hazard vars off on EVERY migrate-family
  # docker run, unconditionally. `docker run` applies `-e` flags AFTER `--env-file` and later
  # `-e NAME=value` wins for a repeated NAME, so these three placed after the caller's own
  # env_flags always have the final word — including for a hypothetical future caller that
  # tried to pass one of these three names itself. None of the three has a legitimate runner
  # use: this runner never invokes --reset (ALLOW_DB_RESET is only read by `migrate.ts --reset`);
  # MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL is documented "never a normal deploy switch"
  # (migration-provider.ts); MIGRATION_EXCLUDE changes are owner-ruled, separate-PR material
  # (staging audit 20260519:132, precedent #4228), never a runner default.
  docker run --rm --pull=never \
    --network "container:${BACKEND_CONTAINER}" \
    --env-file "$TARGET_MIGRATION_ENV_FILE" \
    ${env_flags[@]+"${env_flags[@]}"} \
    -e "MIGRATION_EXCLUDE=" \
    -e "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=false" \
    -e "ALLOW_DB_RESET=false" \
    "$TARGET_MIGRATION_IMAGE" "$@"
}

list_migration_name_universe() {
  # P1-2 hardening (2026-08-24): filesystem enumeration INSIDE the pinned target image —
  # bypasses Kysely's getMigrations() (and therefore process.env / MIGRATION_EXCLUDE)
  # entirely. Dockerfile.backend COPIES the whole `packages` tree — source, not just the
  # compiled dist — into the runner image (Dockerfile.backend:9,43), so these directories
  # are guaranteed present in TARGET_MIGRATION_IMAGE with basenames identical to what the
  # compiled provider reads. Verified against migration-provider.ts's actual folder
  # candidates and directory contents (2026-08-24), not assumed:
  #   - packages/core-backend/src/db/migrations/*.ts — the TS provider folder
  #     (getProviderFolderCandidates; compiles to the dist twin migrate.js actually loads).
  #     Every non-underscore-prefixed .ts file there carries a real `up` export (checked);
  #     names starting with `_` (`_patterns.ts`, `_template.ts`) are shared helper code, not
  #     migrations, and the provider itself skips them the same way
  #     (migration-provider.ts's addProviderMigrations: `if (name.startsWith("_")) continue`)
  #     — the `_*` skip below exists for exactly that file, not defensively.
  #   - packages/core-backend/src/db/migrations/*.sql — raw legacy .sql files that ALSO
  #     live in this same directory (20250925_create_view_tables.sql,
  #     20250926_create_audit_tables.sql) and are picked up by
  #     getSqlFolderCandidates's `../../../src/db/migrations` candidate. Missing this glob
  #     was caught in review: it would have silently narrowed the universe (opposite of the
  #     canary's purpose) for these two names specifically.
  #   - packages/core-backend/migrations/*.sql — the top-level raw-SQL folder
  #     (getSqlFolderCandidates's `../../../migrations` candidate; 076 and its siblings).
  #     Contains a non-.sql `claudedocs/` subdirectory the provider never loads — the .sql
  #     glob already excludes it, no extra filtering needed.
  # No --network, no --env-file, no credentials: this step reads nothing but filenames, so
  # it cannot leak anything and needs no allowlist.
  docker run --rm --pull=never "$TARGET_MIGRATION_IMAGE" sh -c '
    for f in /app/packages/core-backend/src/db/migrations/*.ts; do
      [ -f "$f" ] || continue
      b=$(basename "$f")
      case "$b" in .*|_*) continue ;; esac
      echo "${b%.ts}"
    done
    for f in /app/packages/core-backend/src/db/migrations/*.sql /app/packages/core-backend/migrations/*.sql; do
      [ -f "$f" ] || continue
      b=$(basename "$f")
      case "$b" in .*|_*) continue ;; esac
      echo "${b%.sql}"
    done
  ' | sort -u
}

list_migration_names_applied() {
  # list_migration_names_applied <db-name>
  # Direct psql read of kysely_migration's own `name` column — bypasses process.env and the
  # Node migration provider entirely (no docker run of the migration image at all here), so
  # this is immune to the exclusion vector by construction, independently of the fixes
  # above and of list_migration_name_universe.
  docker exec "$POSTGRES_CONTAINER" psql -U "$MIGRATE_BACKUP_PG_USER" -d "$1" -tA \
    -c "SELECT name FROM kysely_migration ORDER BY name;" 2>/dev/null \
    | tr -d '\r' | sed '/^$/d' | sort -u
}

compute_in_play_migrations() {
  # compute_in_play_migrations <real-db-name>
  # "In play" = migration names present in the pinned image's own migrations directories
  # (the full, env-immune filesystem manifest from list_migration_name_universe) that are
  # NOT YET recorded in the real DB's kysely_migration ledger (also env-immune, read
  # directly via psql). Because BOTH sources bypass process.env entirely, this set cannot
  # be shrunk by an inherited MIGRATION_EXCLUDE the way `migrate.js --list`'s own Pending
  # count could before materialize_target_migration_env/target_migrate_exec were hardened —
  # which is exactly why confirm_in_play_migrations below doubles as P1-1's canary: kysely
  # 0.28.8's Migrator.getMigrations() maps over PROVIDER ENTRIES ONLY, so a name excluded
  # from the provider is simply absent from the result and `--confirm` returns exit 2 "not
  # found among the known migrations" for it (migrate.ts's commandConfirm), never exit 0.
  local real_db="$1"
  list_migration_name_universe > "${OUTPUT_DIR}/migration-name-universe.txt"
  [[ -s "${OUTPUT_DIR}/migration-name-universe.txt" ]] \
    || fail "migration name universe is empty — refusing to compute an in-play set from nothing (image filesystem read failed?)"
  list_migration_names_applied "$real_db" > "${OUTPUT_DIR}/migration-applied-before.txt"
  # Sanity floor (review, 2026-08-24): an empty-but-successful psql read is always wrong
  # for a live staging DB carrying 300+ historically-applied migrations, and silently
  # treats the ENTIRE universe as in-play — hundreds of unnecessary --confirm docker runs
  # inside the migration window, none of them informative. The caller cross-checks this
  # same count against the provider's own Applied:N (a second, independent env-immune-ish
  # source) before trusting either.
  [[ -s "${OUTPUT_DIR}/migration-applied-before.txt" ]] \
    || fail "psql read of kysely_migration returned zero applied names for a live staging DB — refusing to treat the entire migration universe as in-play"
  comm -23 "${OUTPUT_DIR}/migration-name-universe.txt" "${OUTPUT_DIR}/migration-applied-before.txt" \
    > "${OUTPUT_DIR}/migration-in-play.txt"
}

assert_applied_counts_agree() {
  # assert_applied_counts_agree <psql-applied-names-file> <provider-list-output-file>
  # Cross-check (review, 2026-08-24): the psql-derived applied count
  # (list_migration_names_applied, env-immune) and the provider's own `Applied: N` (from a
  # `--list` run against the SAME real DB) are two INDEPENDENT sources for "how many
  # migrations are already applied" — they must agree. This is what makes the in-play
  # canary trustworthy rather than merely present: a silent divergence here (a stale read,
  # a provider-side surprise) would otherwise flow straight into
  # confirm_in_play_migrations as either a false-empty (nothing gets confirmed) or
  # false-huge (the whole 300+-name universe gets re-confirmed) in-play set. Also serves as
  # the sanity floor: a live staging DB always has a large positive applied count, so a
  # zero/unreadable psql count is treated as a hard failure, never as "nothing to compare."
  local psql_file="$1" provider_list_file="$2"
  local applied_count_psql applied_count_provider
  applied_count_psql="$(wc -l < "$psql_file" | tr -d '[:space:]')"
  applied_count_provider="$(grep -oE '^Applied: [0-9]+$' "$provider_list_file" | awk '{print $2}')"
  [[ "$applied_count_psql" =~ ^[0-9]+$ && "$applied_count_psql" -gt 0 ]] \
    || fail "psql-derived applied-migration count is not a positive integer ('${applied_count_psql}') — refusing to trust it for the in-play computation"
  [[ -n "$applied_count_provider" ]] \
    || fail "could not read a 'Applied: N' line from ${provider_list_file}"
  [[ "$applied_count_psql" == "$applied_count_provider" ]] \
    || fail "applied-migration count mismatch: psql (env-immune) read ${applied_count_psql}, provider --list reported ${applied_count_provider} — investigate before proceeding (see ${psql_file} vs ${provider_list_file}); refusing to trust either source alone"
}

confirm_in_play_migrations() {
  # confirm_in_play_migrations <names-file>
  # Per-name --confirm for EVERY migration this deploy has in play (P1-2): `--latest`/
  # `--list` exiting 0 / Pending:0 is NOT proof any SPECIFIC migration ran (an
  # empty/excluded/no-op/partially-applied set all reach the same green line — migrate.ts's
  # commandConfirm docblock). Fails loud, naming the specific migration, on the first
  # non-applied/unknown name.
  local names_file="$1" name out
  : > "${OUTPUT_DIR}/confirm-in-play.txt"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    out=""
    out="$(target_migrate_exec -- node "$MIGRATE_JS" --confirm "$name" < /dev/null 2>&1 || true)"
    printf '%s\n' "$out" >> "${OUTPUT_DIR}/confirm-in-play.txt"
    grep -q "^migration \"${name}\" is applied\$" <<< "$out" \
      || fail "named confirmation for in-play migration '${name}' did not pass (see confirm-in-play.txt): ${out}"
  done < "$names_file"
}

require_sha() {
  [[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || fail "deploy_sha must be the FULL 40-char lowercase commit SHA (GHCR tags are full-SHA; a 9-char prefix fails with manifest unknown — 2026-04-26 postmortem), got: '${DEPLOY_SHA}'"
}

resolve_backend_database_url() {
  # stdout: the RUNNING staging backend container's own DATABASE_URL (never hardcoded —
  # read from the container's actual env, sourced from docker/app.staging.env on the host).
  local dsn
  dsn="$(docker exec "$BACKEND_CONTAINER" printenv DATABASE_URL 2>/dev/null || true)"
  [[ -n "$dsn" ]] || fail "could not resolve DATABASE_URL from ${BACKEND_CONTAINER}'s own env"
  printf '%s' "$dsn"
}

resolve_postgres_creds() {
  # stdout: "<POSTGRES_USER> <POSTGRES_DB>" resolved from the RUNNING postgres container's
  # own env (never hardcoded — same docker/app.staging.env source as the backend's DSN).
  local pg_user pg_db
  pg_user="$(docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_USER 2>/dev/null || true)"
  pg_db="$(docker exec "$POSTGRES_CONTAINER" printenv POSTGRES_DB 2>/dev/null || true)"
  [[ -n "$pg_user" ]] || fail "could not resolve POSTGRES_USER from ${POSTGRES_CONTAINER}'s own env"
  [[ -n "$pg_db" ]] || fail "could not resolve POSTGRES_DB from ${POSTGRES_CONTAINER}'s own env"
  printf '%s %s' "$pg_user" "$pg_db"
}

fetch_health_commit() {
  # stdout: build.commit from the staging web port (/api/health), empty on failure.
  local body
  if ! body="$(curl -fsS --max-time 10 "$STAGING_WEB_HEALTH_URL" 2>/dev/null)"; then
    printf ''
    return 0
  fi
  printf '%s' "$body" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("build", {}).get("commit", ""))
except Exception:
    print("")'
}

wait_for_health_commit() {
  local expected="$1" attempts="${2:-30}" delay="${3:-4}" i commit
  for ((i = 1; i <= attempts; i += 1)); do
    commit="$(fetch_health_commit)"
    if [[ "$commit" == "$expected" ]]; then
      log "health build.commit matches deploy sha (attempt ${i}/${attempts})"
      return 0
    fi
    log "waiting for health build.commit==${expected} (attempt ${i}/${attempts}, got '${commit:-<unreachable>}')"
    sleep "$delay"
  done
  curl -sS --max-time 10 "$STAGING_WEB_HEALTH_URL" > "${OUTPUT_DIR}/health-last.json" 2>&1 || true
  # L6 precedent (tracker 2026-06-21 annual-leave staging closeout, re-proven by run
  # 29314093729): the staging stack's env file can pin a stale METASHEET_BUILD_COMMIT,
  # so /api/health build metadata is NOT a reliable deploy identity on staging. The
  # accepted deploy evidence is the CONTAINER IMAGE TAG. Health must still be
  # RESPONDING (fetch_health_commit returned a body above); identity falls back to
  # docker inspect. Fail closed if neither channel matches.
  local live_image
  live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
  if [[ "$live_image" == *":${expected}" ]]; then
    if ! curl -sS --max-time 10 "$STAGING_WEB_HEALTH_URL" | grep -q '"ok":true'; then
      fail "backend image tag matches ${expected} but /api/health is not ok — not accepting image-tag identity for an unhealthy backend"
    fi
    log "health build.commit is stale (env-pinned; L6 precedent) but backend container image tag matches deploy sha: ${live_image}"
    echo "identity_channel=image-tag health_commit_stale=1 live_image=${live_image}" > "${OUTPUT_DIR}/deploy-identity.txt"
    return 0
  fi
  fail "staging deploy identity failed BOTH channels: /api/health build.commit never matched ${expected} AND backend image is '${live_image:-<none>}'"
}

prepare_container_runner() {
  staging_exec mkdir -p "${CONTAINER_RUNNER_DIR}/scripts/ops"
  # Bare ESM imports (e.g. `import('pg')`) resolve node_modules upward from the script
  # location; a symlink makes /tmp/window-runner scripts resolve the image's node_modules.
  staging_exec ln -sfn /app/node_modules "${CONTAINER_RUNNER_DIR}/node_modules"
  docker cp "${HERE}/attendance-window-runner-mint-token.mjs" \
    "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/scripts/ops/attendance-window-runner-mint-token.mjs"
}

find_admin_user() {
  staging_exec node "${CONTAINER_RUNNER_DIR}/scripts/ops/attendance-window-runner-mint-token.mjs" --find-admin
}

mint_token() {
  # mint_token <user_id> <roles_csv> <perms_csv>; token printed to stdout (never logged).
  local user_id="$1" roles="$2" perms="$3"
  [[ "$user_id" =~ ^[A-Za-z0-9._@-]+$ ]] || fail "refusing to mint token for unsafe user id: ${user_id}"
  staging_exec node "${CONTAINER_RUNNER_DIR}/scripts/ops/attendance-window-runner-mint-token.mjs" \
    --mint --user-id "$user_id" --roles "$roles" --perms "$perms"
}

capture_settings() {
  # capture_settings <token> <out_file>; records HTTP code alongside the body.
  local token="$1" out_file="$2" http_code
  http_code="$(curl -sS --max-time 15 -o "$out_file" -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" -H 'x-org-id: default' \
    'http://127.0.0.1:8082/api/attendance/settings?orgId=default' || echo '000')"
  echo "$http_code" > "${out_file}.http_code"
  # callers capture stdout as the code — informational line goes to stderr
  log "GET /api/attendance/settings -> ${http_code} (${out_file})" >&2
  printf '%s' "$http_code"
}

assert_window_env_flags() {
  # The digest gate must stay unset/false for the whole window (bundle §3.4); the two
  # rd-window flags must be live when requested. Verified in the RUNNING container env.
  staging_exec node -e '
const mode = process.argv[1]
const digest = process.env.ATTENDANCE_REPORT_DIGEST_ENABLED
if (digest === "true") {
  console.error("FAIL: ATTENDANCE_REPORT_DIGEST_ENABLED=true in the staging backend — the window plan requires it UNSET for the whole window (bundle §3.4)")
  process.exit(1)
}
const sched = process.env.ATTENDANCE_SCHEDULER_ENABLED
const worker = process.env.ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED
if (mode === "rd-window") {
  if (sched !== "true" || worker !== "true") {
    console.error(`FAIL: rd-window requested but scheduler=${sched} worker=${worker} in the running container`)
    process.exit(1)
  }
} else if (sched === "true" || worker === "true") {
  console.warn(`WARN: set_window_env=none but scheduler=${sched} worker=${worker} are on (likely set in the host env file; this runner only manages its own override)`)
}
console.log(`env-flags ok: mode=${mode} scheduler=${sched||"<unset>"} worker=${worker||"<unset>"} digest=${digest||"<unset>"}`)
' "$SET_WINDOW_ENV" | tee "${OUTPUT_DIR}/env-flags.txt"
}

snapshot_staging_ps() {
  docker ps --filter 'name=metasheet-staging-' \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' > "${OUTPUT_DIR}/docker-ps-staging.txt"
}

host_sync_prod_repo() {
  # Same discipline as attendance-remote-log-snapshot-prod.yml: the smoke scripts are
  # docker-cp'd from the host-synced repo (main), decoupled from the deployed image SHA.
  [[ -d "$PROD_REPO_DIR" ]] || fail "host repo missing: ${PROD_REPO_DIR} (DEPLOY_PATH)"
  if [[ "$SKIP_HOST_SYNC" == "true" ]]; then
    log "host-sync skipped (skip_host_sync=true)"
    return 0
  fi
  if git -C "$PROD_REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$PROD_REPO_DIR" fetch origin main
    git -C "$PROD_REPO_DIR" checkout main
    git -C "$PROD_REPO_DIR" pull --ff-only origin main
    log "host-sync ok: $(git -C "$PROD_REPO_DIR" rev-parse HEAD)"
  else
    log "host-sync: ${PROD_REPO_DIR} is not a git repo; continuing with existing files"
  fi
}

auth_round_trip() {
  # Bundle §3: staging-realm token must authenticate. Mint in-container (staging
  # JWT_SECRET), then require /api/auth/me == 200 AND /api/attendance/settings == 200.
  local admin_id admin_token me_code settings_code
  admin_id="$(find_admin_user)"
  log "auth round-trip subject: ${admin_id}"
  admin_token="$(mint_token "$admin_id" 'admin' 'attendance:read,attendance:write,attendance:admin,attendance:approve')"
  me_code="$(curl -sS --max-time 15 -o "${OUTPUT_DIR}/auth-me.json" -w '%{http_code}' \
    -H "Authorization: Bearer ${admin_token}" 'http://127.0.0.1:8082/api/auth/me' || echo '000')"
  echo "$me_code" > "${OUTPUT_DIR}/auth-me.http_code"
  [[ "$me_code" == "200" ]] || fail "auth round-trip failed: GET /api/auth/me -> ${me_code} (401 = wrong-realm token / missing admin user; do not debug the route — see bundle §3)"
  settings_code="$(capture_settings "$admin_token" "${OUTPUT_DIR}/settings-postdeploy.json")"
  [[ "$settings_code" == "200" ]] || fail "auth round-trip failed: GET /api/attendance/settings -> ${settings_code} (503 = schema gap: STOP per bundle §3)"
  log "auth round-trip OK (me=200, settings=200)"
}

# --- actions ---------------------------------------------------------------------------

# F1 (2026-08-25, gate on 5b4b38d925 + independent external review — both found it): action=deploy's
# inline migrate runs in the RUNNING backend container via staging_exec and inherits its WHOLE
# environment. A container-level MIGRATION_EXCLUDE narrows the manifest INVISIBLY: excluded names
# vanish from `--list` (the provider drops them), `Pending: 0` goes green over unapplied
# migrations, and the alignment report cannot catch it — it has no filesystem census of its own
# and parses the SAME `--list` text, so an exclusion pushes it TOWARD the pass branch. Meanwhile
# action=migrate aborts loud on the identical host state. Same class as the target-migrate hazard
# handling above: detect-and-abort first (visibility — a set hazard var is a misconfiguration to
# surface, not to silently mask), then forced `-e` neutralization OF ALL THREE NAMES at every
# exec (belt — N3: the first shape forced only MIGRATION_EXCLUDE while this comment claimed all
# three), so weakening either layer alone still leaves the other standing.
assert_deploy_migrate_env_safe() {
  # PROBE HONESTY (N2, gate on c5be6a54e8): the first shape of this helper ended the probe with
  # `|| true`, which collapsed EVERY nonzero exit — docker exec rc=125, missing printenv rc=127 —
  # into value="" and certified SAFE without having observed anything. That is the exact class
  # this PR guards against elsewhere (a zero-read is not a read of zero). printenv distinguishes
  # natively: rc=0 set (possibly empty — empty is genuinely safe, all three consumers treat only
  # non-empty / exact-true as active), rc=1 unset, anything else = THE PROBE FAILED.
  local name value rc probe_err probe_err_txt
  for name in MIGRATION_EXCLUDE MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL ALLOW_DB_RESET; do
    rc=0
    # stdout carries the VALUE (captured, never printed); stderr carries only docker's own
    # diagnostics — discarding it (the first shape did) left a failed probe as a bare rc with
    # nothing to debug from. Kept, and surfaced ONLY on the failed-probe branch.
    probe_err="$(mktemp "${OUTPUT_DIR}/.probe-err.XXXXXX")"
    value="$(docker exec "$BACKEND_CONTAINER" printenv "$name" 2>"$probe_err")" || rc=$?
    case "$rc" in
      0)
        rm -f "$probe_err"
        [[ -z "$value" ]] \
          || fail "running backend container carries ${name} (value not printed) — deploy's inline migrate would inherit it and the migration ledger would lie; unset it on the container before deploying"
        ;;
      1)
        rm -f "$probe_err" # printenv: variable unset — besides set-empty, the only SAFE observation
        ;;
      *)
        probe_err_txt="$(head -c 200 "$probe_err" | tr '\n' ' ')"
        rm -f "$probe_err"
        fail "could not observe ${name} on the running backend (docker exec rc=${rc}: ${probe_err_txt}) — refusing to certify the deploy migrate env as safe on a FAILED probe; a zero-read is not a read of zero"
        ;;
    esac
  done
}

action_deploy() {
  require_sha
  require_compose_v2
  local STAGING_COMPOSE_CANDIDATE_TMP=""
  prepare_staging_compose_for_deploy

  local backend_image="ghcr.io/${IMAGE_OWNER}/metasheet2-backend:${DEPLOY_SHA}"
  local web_image="ghcr.io/${IMAGE_OWNER}/metasheet2-web:${DEPLOY_SHA}"

  local pg_id_before redis_id_before
  pg_id_before="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER")" \
    || fail "staging postgres container not found: ${POSTGRES_CONTAINER}"
  redis_id_before="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER")" \
    || fail "staging redis container not found: ${REDIS_CONTAINER}"

  # Persistent override, written ATOMICALLY: candidate → validate → rename. The persistent path
  # (RUNNER_PERSIST_DIR under $HOME) survives the workflow's OUTPUT_DIR cleanup, so the container
  # config_files label it stamps never dangles. set_window_env=none takes the branch that omits
  # the flags, so redeploying with none rewrites the SAME file without them (clears the old flags).
  mkdir -p "$RUNNER_PERSIST_DIR"
  local override_tmp
  # mktemp requires the X placeholder run at the END of the template (a trailing suffix like
  # .yml makes GNU mktemp error and BSD/macOS return the literal, un-randomized). The candidate
  # needs no extension — `docker compose config -f <file>` reads it by content, and it is renamed
  # to the .yml-named live override on success.
  override_tmp="$(mktemp "${RUNNER_PERSIST_DIR}/.override.XXXXXX")"
  {
    echo "# Written by attendance-staging-window-runner (run ${RUN_STAMP}). Pins the staging"
    echo "# backend/web images to one full-SHA tag; env flips happen ONLY here, together with"
    echo "# the deploy (bundle §3.4). Redeploying with set_window_env=none removes the flags."
    echo "services:"
    echo "  backend:"
    echo "    image: ${backend_image}"
    if [[ "$SET_WINDOW_ENV" == "rd-window" ]]; then
      echo "    environment:"
      echo "      ATTENDANCE_SCHEDULER_ENABLED: \"true\""
      echo "      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: \"true\""
    fi
    echo "  web:"
    echo "    image: ${web_image}"
  } > "$override_tmp"
  # Validate the candidate renders against the staging compose file BEFORE it goes live — a broken
  # override would otherwise dangle EVERY container's config_files label. On failure, keep the
  # previous known-good override untouched and fail closed.
  # Validate in the SAME cwd as compose_staging() above: staging compose uses relative
  # env_file + .env interpolation, so `cd "$STAGING_DIR"` first — otherwise we'd validate a
  # different resolved config than the one `up -d` actually executes.
  if ! (cd "$STAGING_DIR" && IMAGE_OWNER="$IMAGE_OWNER" IMAGE_TAG="$DEPLOY_SHA" \
    docker compose --project-directory "$STAGING_DIR" -f "$STAGING_COMPOSE_CANDIDATE_TMP" -f "$override_tmp" config) >/dev/null 2>&1; then
    rm -f "$override_tmp" "$STAGING_COMPOSE_CANDIDATE_TMP"
    fail "candidate base/override pair failed 'docker compose config' validation; kept previous persistent files"
  fi
  # Both candidates are validated as one pair before either persistent file changes. Each
  # same-directory rename is atomic; workflow concurrency serializes staging transitions.
  mv -f "$STAGING_COMPOSE_CANDIDATE_TMP" "$PERSISTENT_STAGING_COMPOSE_FILE"
  STAGING_COMPOSE_FILE="$PERSISTENT_STAGING_COMPOSE_FILE"
  mv -f "$override_tmp" "$OVERRIDE_FILE"
  hash_value "$STAGING_COMPOSE_FILE" > "${OUTPUT_DIR}/staging-compose.sha256"
  log "staging compose installed atomically at persistent path: ${STAGING_COMPOSE_FILE}"
  log "override written (persistent, atomic): ${OVERRIDE_FILE} (env mode: ${SET_WINDOW_ENV})"

  compose_staging pull backend web 2>&1 | tee "${OUTPUT_DIR}/compose-pull.log"
  # NEVER recreate postgres/redis: only backend+web, --no-deps.
  local -a up_args=(up -d --no-deps)
  if [[ "$FORCE_RECREATE" == "true" ]]; then
    up_args+=(--force-recreate)
  fi
  up_args+=(backend web)
  compose_staging "${up_args[@]}" 2>&1 | tee "${OUTPUT_DIR}/compose-up.log"

  local pg_id_after redis_id_after
  pg_id_after="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER")"
  redis_id_after="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER")"
  [[ "$pg_id_before" == "$pg_id_after" ]] || fail "staging postgres container was recreated — hard constraint violated"
  [[ "$redis_id_before" == "$redis_id_after" ]] || fail "staging redis container was recreated — hard constraint violated"
  log "postgres/redis untouched (container ids unchanged)"

  local running_backend_image
  running_backend_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")"
  [[ "$running_backend_image" == "$backend_image" ]] \
    || fail "backend container image is ${running_backend_image}, expected ${backend_image}"

  wait_for_health_commit "$DEPLOY_SHA"
  curl -fsS --max-time 10 "$STAGING_WEB_HEALTH_URL" > "${OUTPUT_DIR}/health-web.json"
  curl -fsS --max-time 10 "$STAGING_BACKEND_HEALTH_URL" > "${OUTPUT_DIR}/health-backend.json" || true

  assert_window_env_flags

  # Migration discipline (bundle §3.2): list BEFORE, classify read-only, migrate, list
  # AFTER (must end pending=0). The alignment report runs in-container from the deployed
  # image's own /app/scripts copy so its file scan matches the deployed migration set.
  prepare_container_runner
  assert_deploy_migrate_env_safe
  staging_exec_env "MIGRATION_EXCLUDE=" "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=" "ALLOW_DB_RESET=" -- node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/migrate-list-before.txt"
  docker cp "${OUTPUT_DIR}/migrate-list-before.txt" "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/migrate-list-before.txt"
  staging_exec node /app/scripts/ops/staging-migration-alignment-report.mjs \
    --migrate-list-file "${CONTAINER_RUNNER_DIR}/migrate-list-before.txt" \
    --out-dir "${CONTAINER_RUNNER_DIR}/migration-report" < /dev/null 2>&1 \
    | tee "${OUTPUT_DIR}/migration-alignment-stdout.txt"
  docker cp "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/migration-report" "${OUTPUT_DIR}/migration-report" || true
  if grep -q 'decision=do_not_run_full_migrate' "${OUTPUT_DIR}/migration-alignment-stdout.txt"; then
    fail "migration alignment report says do_not_run_full_migrate — STOP per bundle §3.2; follow docs/development/staging-migration-alignment-runbook-verification-20260519.md"
  fi

  staging_exec_env "MIGRATION_EXCLUDE=" "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=" "ALLOW_DB_RESET=" -- node "$MIGRATE_JS" < /dev/null 2>&1 | tee "${OUTPUT_DIR}/migrate-run.log"
  staging_exec_env "MIGRATION_EXCLUDE=" "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=" "ALLOW_DB_RESET=" -- node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/migrate-list-after.txt"
  grep -q '^Pending: 0$' "${OUTPUT_DIR}/migrate-list-after.txt" \
    || fail "migrations did not end at pending=0 (see migrate-list-after.txt)"

  auth_round_trip
  snapshot_staging_ps

  {
    echo "action=deploy"
    echo "deploy_sha=${DEPLOY_SHA}"
    echo "set_window_env=${SET_WINDOW_ENV}"
    echo "force_recreate=${FORCE_RECREATE}"
    echo "backend_image=${backend_image}"
    echo "web_image=${web_image}"
    echo "result=ok"
  } > "${OUTPUT_DIR}/summary.txt"
  log "deploy OK: ${DEPLOY_SHA}"
}

action_smoke() {
  [[ -n "$DEPLOY_SHA" ]] || fail "deploy_sha is REQUIRED for action=smoke (every stamp must name the exact deployed SHA — precedent-window lesson)"
  require_sha
  [[ -n "$SMOKE_ID" ]] || fail "smoke input is required for action=smoke"

  local smoke_script stamp_prefix
  local -a extra_env=() extra_tokens=()
  case "$SMOKE_ID" in
    ae4)
      smoke_script="staging-attendance-ae4-result-edit-smoke.mjs"
      stamp_prefix="ae4-smoke"
      extra_tokens=("NON_ADMIN_TOKEN:reader:user:attendance:read")
      ;;
    rd45)
      smoke_script="staging-attendance-report-digest-rd45-smoke.mjs"
      stamp_prefix="rd45-smoke"
      extra_env=("PLUGIN_INDEX_PATH=/app/plugins/plugin-attendance/index.cjs")
      ;;
    otbank-v18)
      smoke_script="staging-attendance-overtime-bank-v18-smoke.mjs"
      stamp_prefix="otbank-v18-smoke"
      extra_tokens=(
        "CASE1_TOKEN:case1:user:attendance:read,attendance:write"
        "CASE2_TOKEN:case2:user:attendance:read,attendance:write"
        "CASE3_TOKEN:case3:user:attendance:read,attendance:write"
        "MUSTPAY_TOKEN:mustpay:user:attendance:read,attendance:write"
        "DORMANT_TOKEN:dormant:user:attendance:read,attendance:write"
      )
      ;;
    mp6)
      smoke_script="staging-attendance-makeup-punch-mp6-smoke.mjs"
      stamp_prefix="mp6-smoke"
      extra_tokens=("SUBJECT_TOKEN:subject:user:attendance:read,attendance:write")
      ;;
    hmr5)
      smoke_script="staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs"
      stamp_prefix="hmr5-smoke"
      extra_tokens=("SCOPED_TOKEN:scoped:user:attendance:read,attendance:write")
      ;;
    *)
      fail "unknown smoke id: ${SMOKE_ID}"
      ;;
  esac
  local stamp="${stamp_prefix}-${RUN_STAMP}"

  host_sync_prod_repo
  local smoke_src="${PROD_REPO_DIR}/scripts/ops/${smoke_script}"
  [[ -f "$smoke_src" ]] || fail "smoke script missing in host-synced repo: ${smoke_src}"

  # The deployed build must BE the SHA the stamps will name (bundle §2). Same dual-channel
  # identity as the deploy verifier: staging /api/health build.commit is env-pinned stale
  # (L6 precedent; proven again by run 29378042837), so fall back to the backend container
  # image tag — but only for a HEALTHY backend (health must answer ok:true).
  local live_commit live_image
  live_commit="$(fetch_health_commit)"
  if [[ "$live_commit" != "$DEPLOY_SHA" ]]; then
    live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
    if [[ "$live_image" == "ghcr.io/${IMAGE_OWNER}/metasheet2-backend:${DEPLOY_SHA}" ]] \
       && curl -sS --max-time 10 "$STAGING_WEB_HEALTH_URL" | grep -q '"ok":true'; then
      log "smoke identity: health build.commit stale ('${live_commit:-<unreachable>}', env-pinned) but backend image tag matches deploy sha: ${live_image}"
    else
      fail "staging identity failed BOTH channels for smoke: /api/health build.commit='${live_commit:-<unreachable>}' and backend image='${live_image:-<none>}' vs deploy_sha=${DEPLOY_SHA}; refusing to smoke a mismatched build"
    fi
  fi

  prepare_container_runner
  local admin_id admin_token
  admin_id="$(find_admin_user)"
  admin_token="$(mint_token "$admin_id" 'admin' 'attendance:read,attendance:write,attendance:admin,attendance:approve')"
  log "smoke admin subject: ${admin_id}; stamp: ${stamp}"

  # Window-level settings-restore evidence (bundle §5): settings BEFORE and AFTER.
  capture_settings "$admin_token" "${OUTPUT_DIR}/settings-before.json" >/dev/null

  docker cp "$smoke_src" "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/scripts/ops/${smoke_script}"

  local -a run_env=(
    "BASE_URL=${IN_CONTAINER_BASE_URL}"
    "DEPLOY_SHA=${DEPLOY_SHA}"
    "STAMP=${stamp}"
    "ADMIN_TOKEN=${admin_token}"
  )
  local spec env_name suffix roles perms
  for spec in "${extra_tokens[@]:-}"; do
    [[ -n "$spec" ]] || continue
    env_name="${spec%%:*}"
    suffix="$(printf '%s' "$spec" | cut -d: -f2)"
    roles="$(printf '%s' "$spec" | cut -d: -f3)"
    perms="$(printf '%s' "$spec" | cut -d: -f4-)"
    run_env+=("${env_name}=$(mint_token "${stamp}-${suffix}" "$roles" "$perms")")
  done
  for spec in "${extra_env[@]:-}"; do
    [[ -n "$spec" ]] || continue
    run_env+=("$spec")
  done

  # DATABASE_URL intentionally NOT passed: the container's own env already carries the
  # staging DB URL, which is exactly the API↔DB coherence the helpers assert.
  local -a pipe_status
  set +e
  staging_exec_env "${run_env[@]}" -- node "${CONTAINER_RUNNER_DIR}/scripts/ops/${smoke_script}" \
    < /dev/null 2>&1 | tee "${OUTPUT_DIR}/smoke-${SMOKE_ID}.log"
  pipe_status=("${PIPESTATUS[@]}")
  set -e
  local smoke_rc="${pipe_status[0]}"
  if [[ "${pipe_status[1]}" != "0" ]]; then
    fail "tee failed writing the smoke log (rc=${pipe_status[1]})"
  fi

  capture_settings "$admin_token" "${OUTPUT_DIR}/settings-after.json" >/dev/null

  # Filtered backend log slice for the artifact — zero matches is a normal outcome;
  # a failing `docker logs` must still fail this step (filtered_pipe contract, proven
  # by scripts/ops/attendance-window-runner-pipeline.test.mjs).
  filtered_pipe "${OUTPUT_DIR}/backend-log-slice.log" \
    'attendance|digest|delivery|reminder|overtime|makeup' \
    -- docker logs --since 30m "$BACKEND_CONTAINER"

  snapshot_staging_ps
  {
    echo "action=smoke"
    echo "smoke=${SMOKE_ID}"
    echo "deploy_sha=${DEPLOY_SHA}"
    echo "stamp=${stamp}"
    echo "smoke_rc=${smoke_rc}"
  } > "${OUTPUT_DIR}/summary.txt"

  if [[ "$smoke_rc" != "0" ]]; then
    echo "[window-runner][error] smoke ${SMOKE_ID} exited rc=${smoke_rc} (full log: smoke-${SMOKE_ID}.log)" >&2
    exit "$smoke_rc"
  fi
  log "smoke ${SMOKE_ID} OK (stamp ${stamp})"
}

# residue_check <pg_user> <pg_db> <name> <sql>
#
# Runs ONE read-only §7 count query via `docker exec metasheet-staging-postgres psql -tA`
# (tuples-only, unaligned — a bare integer, nothing else) against the REAL staging DB,
# appends "<name>=<value>" to $RESIDUE_RESULTS_FILE, and prints the value to stdout so the
# caller can decide pass/fail. A query that does not come back as a bare integer (bad SQL,
# connection drop, wrong column) is a hard failure — never silently treated as "0 residue".
residue_check() {
  local pg_user="$1" pg_db="$2" name="$3" sql="$4" value
  value="$(docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "$pg_db" -v ON_ERROR_STOP=1 -tA -c "$sql" | tr -d '[:space:]')"
  [[ "$value" =~ ^[0-9]+$ ]] \
    || fail "residue-sweep query '${name}' did not return a bare integer (got '${value}'); sql: ${sql}"
  echo "${name}=${value}" >> "$RESIDUE_RESULTS_FILE"
  # stderr, NOT stdout: callers capture this function's stdout as the numeric count, and a
  # stdout log line contaminates the comparison (run 29395824577: all 29 counts were 0 yet
  # the sweep false-FAILED because the captured value was "log-line\n0").
  log "residue-sweep ${name}=${value}" >&2
  printf '%s' "$value"
}

action_residue_sweep() {
  # Bundle §7 "Consolidated final residue sweep (window close)": every count in that SQL
  # block must be 0. This action runs each one individually (not as one multi-statement
  # script) so a single bad query fails closed with its own name, and so the source-contract
  # self-test (scripts/ops/attendance-window-runner-pipeline.test.mjs) can grep this file for
  # each stamp-prefix family independently.
  #
  # STAMPS is "ae4,rd45,otbank,mp6,hmr5" (bundle §1 order). ae4/rd45/otbank are the three
  # core smokes and are REQUIRED (a window always runs them per bundle §4); mp6/hmr5 are the
  # optional 4th/5th smokes and their fields may be empty ("...,otbankstamp,," or
  # "...,otbankstamp,mp6stamp,") when that smoke did not run this window (bundle §1/§8:
  # "skip cleanly if not run").
  [[ -n "$STAMPS" ]] || fail "STAMPS is required for action=residue-sweep (comma-separated ae4,rd45,otbank,mp6,hmr5 stamps — bundle §7)"
  local ae4_stamp rd45_stamp otbank_stamp mp6_stamp hmr5_stamp sentinel
  IFS=',' read -r ae4_stamp rd45_stamp otbank_stamp mp6_stamp hmr5_stamp sentinel <<< "${STAMPS},__sentinel__"
  [[ -n "$ae4_stamp" && -n "$rd45_stamp" && -n "$otbank_stamp" && "$sentinel" == "__sentinel__" ]] \
    || fail "STAMPS must be exactly 5 comma-separated fields (ae4,rd45,otbank,mp6,hmr5) with ae4/rd45/otbank non-empty, got: '${STAMPS}'"
  [[ "$ae4_stamp" =~ ^ae4-smoke-[A-Za-z0-9-]+$ ]] || fail "ae4 stamp must match ^ae4-smoke-[A-Za-z0-9-]+\$, got: '${ae4_stamp}'"
  [[ "$rd45_stamp" =~ ^rd45-smoke-[A-Za-z0-9-]+$ ]] || fail "rd45 stamp must match ^rd45-smoke-[A-Za-z0-9-]+\$, got: '${rd45_stamp}'"
  [[ "$otbank_stamp" =~ ^otbank-v18-smoke-[A-Za-z0-9-]+$ ]] || fail "otbank stamp must match ^otbank-v18-smoke-[A-Za-z0-9-]+\$, got: '${otbank_stamp}'"
  [[ -z "$mp6_stamp" || "$mp6_stamp" =~ ^mp6-smoke-[A-Za-z0-9-]+$ ]] || fail "mp6 stamp must be empty or match ^mp6-smoke-[A-Za-z0-9-]+\$, got: '${mp6_stamp}'"
  [[ -z "$hmr5_stamp" || "$hmr5_stamp" =~ ^hmr5-smoke-[A-Za-z0-9-]+$ ]] || fail "hmr5 stamp must be empty or match ^hmr5-smoke-[A-Za-z0-9-]+\$, got: '${hmr5_stamp}'"

  local pg_user pg_db
  read -r pg_user pg_db <<< "$(resolve_postgres_creds)"

  # Deterministic per-stamp business-key reconstruction (NOT captured-id substitution — these
  # are simple string templates the OT-bank helper builds directly from STAMP, so recomputing
  # them here is exact, not an approximation):
  #   otbank_rule_name      mirrors `${STAMP}-ot-rule`             (smoke script: overtimeRuleName)
  #   otbank_leave_type_code mirrors `${STAMP}-offset`             (smoke script: leaveTypeCode)
  #   otbank_holiday_name    mirrors `${STAMP} statutory holiday`  (smoke script: holidayName)
  #   otbank_poison_lot_key  mirrors `otbank-v18-smoke:${STAMP}:poison-statutory-lot` (poisonLotKey)
  local otbank_rule_name="${otbank_stamp}-ot-rule"
  local otbank_leave_type_code="${otbank_stamp}-offset"
  local otbank_holiday_name="${otbank_stamp} statutory holiday"
  local otbank_poison_lot_key="otbank-v18-smoke:${otbank_stamp}:poison-statutory-lot"
  # MP-6 and OT-bank v1-8 share the window's org (bundle §5 "Org scope"); the remote script's
  # own action_smoke never overrides ORG_ID for either, so both default to 'default' exactly
  # as their smoke scripts do. If a future window ever runs either under an overridden
  # ORG_ID, this constant must move to a workflow input alongside it.
  local window_org="default"
  local otbank_user_prefix="${otbank_stamp}-"
  local mp6_user_prefix="${mp6_stamp}-"

  local results_file="${OUTPUT_DIR}/residue-sweep.txt"
  RESIDUE_RESULTS_FILE="$results_file"
  {
    echo "# attendance-staging-window-runner residue-sweep — bundle §7 consolidated final residue sweep"
    echo "# generated=$(date -u +%Y-%m-%dT%H:%M:%SZ) deploy_sha=${DEPLOY_SHA:-<not provided>}"
    echo "# window-intended-stamps: ae4=${ae4_stamp} rd45=${rd45_stamp} otbank=${otbank_stamp} mp6=${mp6_stamp:-<not run this window>} hmr5=${hmr5_stamp:-<not run this window>}"
  } > "$results_file"

  local -a nonzero=()
  local v

  # -- synthetic users and memberships, core families (bundle §7 ¶1) ---------------------
  v="$(residue_check "$pg_user" "$pg_db" users \
    "SELECT count(*) FROM users WHERE left(id, 10) = 'ae4-smoke-' OR left(id, 11) = 'rd45-smoke-' OR left(id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("users=${v}")
  v="$(residue_check "$pg_user" "$pg_db" user_orgs \
    "SELECT count(*) FROM user_orgs WHERE left(user_id, 10) = 'ae4-smoke-' OR left(user_id, 11) = 'rd45-smoke-' OR left(user_id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("user_orgs=${v}")

  # -- attendance business rows by stamped meta/user (bundle §7 ¶2) ----------------------
  v="$(residue_check "$pg_user" "$pg_db" records \
    "SELECT count(*) FROM attendance_records WHERE meta->>'smokeStamp' IN ('${ae4_stamp}', '${rd45_stamp}', '${otbank_stamp}') OR left(user_id, 10) = 'ae4-smoke-' OR left(user_id, 11) = 'rd45-smoke-' OR left(user_id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("records=${v}")
  v="$(residue_check "$pg_user" "$pg_db" requests \
    "SELECT count(*) FROM attendance_requests WHERE metadata->>'smokeStamp' IN ('${ae4_stamp}', '${rd45_stamp}', '${otbank_stamp}') OR left(user_id, 10) = 'ae4-smoke-' OR left(user_id, 11) = 'rd45-smoke-' OR left(user_id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("requests=${v}")

  # -- shared deliveries table, per source_type + stamped scoping (bundle §7 ¶3) ---------
  v="$(residue_check "$pg_user" "$pg_db" ae4_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries d JOIN attendance_record_result_edits e ON d.source_id = e.id::text AND e.org_id = d.org_id WHERE d.source_type = 'attendance_result_edit' AND left(e.idempotency_key, length('ae4-smoke:${ae4_stamp}:')) = 'ae4-smoke:${ae4_stamp}:';")"
  [[ "$v" == "0" ]] || nonzero+=("ae4_deliveries=${v}")
  # SUBSTITUTION: bundle §7 uses `org_id = :rd45_smoke_org` (a single captured org id, default
  # "<STAMP>-org", never archived to a file this script can read). RD-4/5's own smoke script
  # (staging-attendance-report-digest-rd45-smoke.mjs) enforces `ORG_ID.startsWith('rd45-smoke-')`
  # for every TRIGGER_MODE=seam run, so every RD-4/5 disposable org — not just this run's
  # default-named one — carries the "rd45-smoke-" prefix (bundle §5 table). Scoping on that
  # PREFIX instead of the one derived org id is strictly broader (also catches an operator
  # ORG_ID override, or a leftover disposable org from an earlier unswept window) while never
  # matching a real org (prefixes are mutually exclusive by construction — bundle §5).
  v="$(residue_check "$pg_user" "$pg_db" rd45_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE source_type = 'attendance_report_digest' AND left(org_id, 11) = 'rd45-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("rd45_deliveries=${v}")
  v="$(residue_check "$pg_user" "$pg_db" stray_deliveries_to_smoke_users \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE left(recipient_user_id, 10) = 'ae4-smoke-' OR left(recipient_user_id, 11) = 'rd45-smoke-' OR left(recipient_user_id, 17) = 'otbank-v18-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("stray_deliveries_to_smoke_users=${v}")

  # -- OT-bank money-path tables (bundle §7 ¶4) -------------------------------------------
  # SUBSTITUTION: bundle §7 uses `cycle_id = ANY(:otbank_cycle_ids::uuid[])` (captured cycle
  # ids, never archived). The OT-bank smoke script stamps every cycle it creates with
  # `metadata->>'smokeStamp' = STAMP` (same column the sibling `cycles` query below already
  # keys on), so the cycle-id list is reconstructed exactly — not approximated — via a
  # subquery on that same metadata key, scoped to the two smokes that ever write a cycle row
  # (AE-4 SQL-seeds one stamped closed cycle for its 409 guard — bundle §5 "Payroll cycles").
  v="$(residue_check "$pg_user" "$pg_db" settlements \
    "SELECT count(*) FROM attendance_payroll_cycle_settlements WHERE cycle_id IN (SELECT id FROM attendance_payroll_cycles WHERE metadata->>'smokeStamp' IN ('${ae4_stamp}', '${otbank_stamp}'));")"
  [[ "$v" == "0" ]] || nonzero+=("settlements=${v}")
  v="$(residue_check "$pg_user" "$pg_db" cycles \
    "SELECT count(*) FROM attendance_payroll_cycles WHERE metadata->>'smokeStamp' IN ('${ae4_stamp}', '${otbank_stamp}');")"
  [[ "$v" == "0" ]] || nonzero+=("cycles=${v}")
  v="$(residue_check "$pg_user" "$pg_db" lots \
    "SELECT count(*) FROM attendance_leave_balances WHERE left(user_id, 17) = 'otbank-v18-smoke-' OR source_key = '${otbank_poison_lot_key}';")"
  [[ "$v" == "0" ]] || nonzero+=("lots=${v}")
  v="$(residue_check "$pg_user" "$pg_db" fixtures \
    "SELECT count(*) FROM attendance_overtime_rules WHERE name = '${otbank_rule_name}';")"
  [[ "$v" == "0" ]] || nonzero+=("fixtures=${v}")
  v="$(residue_check "$pg_user" "$pg_db" leave_types \
    "SELECT count(*) FROM attendance_leave_types WHERE code = '${otbank_leave_type_code}';")"
  [[ "$v" == "0" ]] || nonzero+=("leave_types=${v}")
  v="$(residue_check "$pg_user" "$pg_db" holidays \
    "SELECT count(*) FROM attendance_holidays WHERE name = '${otbank_holiday_name}';")"
  [[ "$v" == "0" ]] || nonzero+=("holidays=${v}")

  # -- approval-engine rows written by the v1-8 request chain (bundle §7 ¶5) -------------
  # SUBSTITUTION: bundle §7 uses `id = ANY(:otbank_approval_ids::text[])` (captured approval
  # instance ids, never archived). attendance_requests.approval_instance_id (text) links a
  # request to its approval_instances row; every OT-bank v1-8 request is created by a
  # STAMP-prefixed user (USER_PREFIX = `${STAMP}-` in the smoke script), so joining through
  # requests scoped by that prefix reconstructs the exact same approval-instance set the
  # bundle's captured-id list would have named — this is the literal "approval rows joined to
  # requests/users with smoke prefixes" substitution the task calls for.
  v="$(residue_check "$pg_user" "$pg_db" approval_instances \
    "SELECT count(*) FROM approval_instances ai JOIN attendance_requests r ON r.approval_instance_id = ai.id WHERE left(r.user_id, ${#otbank_user_prefix}) = '${otbank_user_prefix}';")"
  [[ "$v" == "0" ]] || nonzero+=("approval_instances=${v}")

  # -- MP-6 makeup-punch (optional 4th smoke) — subject-scoped, family-prefix 'mp6-smoke-'
  # (10 chars). These always run (not gated on mp6_stamp being provided): the prefix is
  # global to the MP-6 family, not this run's stamp, so it also catches leftover rows from
  # an earlier unswept window — a strictly safer sweep than skipping when this window didn't
  # run MP-6 (bundle §7 ¶6).
  v="$(residue_check "$pg_user" "$pg_db" mp6_requests \
    "SELECT count(*) FROM attendance_requests WHERE org_id = '${window_org}' AND left(user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_requests=${v}")
  v="$(residue_check "$pg_user" "$pg_db" mp6_records \
    "SELECT count(*) FROM attendance_records WHERE org_id = '${window_org}' AND left(user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_records=${v}")
  # SUBSTITUTION: bundle §7 uses `meta->>'requestId' = ANY(:mp6_request_ids::text[])`
  # (captured request ids, never archived) — replaced by the same requests-family-prefix join
  # as approval_instances above, scoped to the MP-6 family prefix ('mp6-smoke-', 10 chars)
  # rather than one run's stamp, for the same "catches earlier leftovers too" reason.
  v="$(residue_check "$pg_user" "$pg_db" mp6_events \
    "SELECT count(*) FROM attendance_events e WHERE e.org_id = '${window_org}' AND EXISTS (SELECT 1 FROM attendance_requests r WHERE r.id::text = e.meta->>'requestId' AND r.org_id = e.org_id AND left(r.user_id, 10) = 'mp6-smoke-');")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_events=${v}")
  # SUBSTITUTION: bundle §7 uses `id = ANY(:mp6_approval_ids::text[])` (captured approval
  # instance ids, never archived) — replaced by the requests-family-prefix join, same
  # reasoning as approval_instances above.
  v="$(residue_check "$pg_user" "$pg_db" mp6_approval_instances \
    "SELECT count(*) FROM approval_instances ai JOIN attendance_requests r ON r.approval_instance_id = ai.id WHERE r.org_id = '${window_org}' AND left(r.user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_approval_instances=${v}")
  v="$(residue_check "$pg_user" "$pg_db" mp6_users \
    "SELECT count(*) FROM users WHERE left(id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_users=${v}")
  v="$(residue_check "$pg_user" "$pg_db" mp6_user_orgs \
    "SELECT count(*) FROM user_orgs WHERE left(user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_user_orgs=${v}")
  # MP-6 writes NO deliveries — this must be 0 (never delete/query by source_type alone).
  v="$(residue_check "$pg_user" "$pg_db" mp6_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE org_id = '${window_org}' AND left(recipient_user_id, 10) = 'mp6-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("mp6_deliveries=${v}")

  # -- HMR-5 manual missed-punch reminder (optional 5th smoke) — disposable-org scoped.
  # SUBSTITUTION: bundle §7 uses `:hmr5_org` (default "<STAMP>-org", a single captured org id)
  # for every org-scoped HMR-5 query. Same reasoning as rd45_deliveries above: HMR-5's own
  # smoke script enforces `ORG_ID.startsWith('hmr5-smoke-')`, so scoping on the "hmr5-smoke-"
  # prefix (11 chars) is a strictly broader, always-safe generalization of the one derived org
  # id — it needs no stamp at all, so (unlike the deliberately-skippable per-runbook PASS
  # stamps) these queries always run, including when HMR-5 did not run this window.
  v="$(residue_check "$pg_user" "$pg_db" hmr5_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE left(org_id, 11) = 'hmr5-smoke-' AND source_type = 'manual_missed_punch_reminder';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_deliveries=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_stray_deliveries \
    "SELECT count(*) FROM attendance_notification_deliveries WHERE left(recipient_user_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_stray_deliveries=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_requests \
    "SELECT count(*) FROM attendance_requests WHERE left(org_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_requests=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_records \
    "SELECT count(*) FROM attendance_records WHERE left(org_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_records=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_scopes \
    "SELECT count(*) FROM attendance_scheduler_scopes WHERE left(org_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_scopes=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_user_orgs \
    "SELECT count(*) FROM user_orgs WHERE left(org_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_user_orgs=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_user_roles \
    "SELECT count(*) FROM user_roles WHERE left(user_id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_user_roles=${v}")
  v="$(residue_check "$pg_user" "$pg_db" hmr5_users \
    "SELECT count(*) FROM users WHERE left(id, 11) = 'hmr5-smoke-';")"
  [[ "$v" == "0" ]] || nonzero+=("hmr5_users=${v}")

  # -- env flags + settings baseline capture, same artifact (owner ask: confirm the
  # env-switch and settings baseline alongside the residue counts, not in a separate run).
  # A live ATTENDANCE_REPORT_DIGEST_ENABLED=true is a real §3.4 violation (never allowed for
  # the whole window), so it flips the sweep result to FAIL like any other nonzero count —
  # but it must not abort mid-sweep and skip the remaining §7 counts, so capture the outcome
  # instead of letting `set -e` propagate it.
  local env_flags_ok=1
  assert_window_env_flags || env_flags_ok=0
  if [[ "$env_flags_ok" != "1" ]]; then
    nonzero+=("env_flags_violation=1")
  fi
  prepare_container_runner
  local admin_id admin_token
  if admin_id="$(find_admin_user)"; then
    admin_token="$(mint_token "$admin_id" 'admin' 'attendance:read,attendance:admin')"
    capture_settings "$admin_token" "${OUTPUT_DIR}/settings-sweep.json" >/dev/null || true
  else
    echo "no active admin user found; settings snapshot skipped" > "${OUTPUT_DIR}/settings-sweep.json"
  fi

  local result="ok" nonzero_list="none"
  if [[ "${#nonzero[@]}" -gt 0 ]]; then
    result="FAIL"
    nonzero_list="$(IFS=,; echo "${nonzero[*]}")"
  fi

  {
    echo "checks_total=29"
    echo "result=${result}"
    echo "nonzero=${nonzero_list}"
  } >> "$results_file"
  {
    echo "action=residue-sweep"
    echo "deploy_sha=${DEPLOY_SHA:-}"
    echo "stamps=${STAMPS}"
    echo "result=${result}"
    echo "nonzero=${nonzero_list}"
  } > "${OUTPUT_DIR}/summary.txt"

  echo "CONSOLIDATED_RESIDUE_SWEEP result=${result} nonzero=${nonzero_list}"

  if [[ "$result" != "ok" ]]; then
    fail "residue sweep found nonzero residue: ${nonzero_list} (see residue-sweep.txt in the artifact; bundle §7 requires every count to be 0 before window close)"
  fi
  log "residue-sweep OK: all 29 §7 checks are zero"
}

# Values-free classification of the persistent runner override — the read-only collection the
# deploy-order decision depends on (owner-endorsed review, 2026-08-25). The OVERRIDE_FILE has
# THREE writer-produced shapes plus absence, and action=deploy OVERWRITES it unconditionally with
# only the none/rd-window shapes — so a deploy over a live soak override silently clears the W4/W7
# allowlists. Before any deploy, the operator needs: which shape is on disk, which of the four
# candidate flags are live in the backend container, and whether disk and container AGREE (drift
# between them means the file was rewritten without a recreate, or vice versa — an unexplained
# environment, so fail loud). NO VALUES are ever read into this function's output: file flags are
# detected by KEY name only, live flags by printenv EXIT CODE only (stdout discarded unread), so
# soak org slugs cannot leak into logs or artifacts.
classify_runner_override() {
  local out="${OUTPUT_DIR}/override-shape.txt"
  local candidates="ATTENDANCE_SCHEDULER_ENABLED ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED ${SOAK_W4_ENV_NAME} ${SOAK_W7_ENV_NAME}"
  local rd_set="ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED ATTENDANCE_SCHEDULER_ENABLED"
  local soak_set
  soak_set="$(printf '%s\n%s\n' "$SOAK_W4_ENV_NAME" "$SOAK_W7_ENV_NAME" | sort | tr '\n' ' ')"
  soak_set="${soak_set% }"

  local file_present=false file_sha="" file_names=""
  if [[ -f "$OVERRIDE_FILE" && ! -r "$OVERRIDE_FILE" ]]; then
    # Present but unreadable: an environment we cannot explain. Classify as unexpected rather
    # than letting an empty read pass as the none shape — an empty read is not a read of empty.
    file_present=true
    file_names="__UNREADABLE__"
  elif [[ -f "$OVERRIDE_FILE" ]]; then
    file_present=true
    file_sha="$(hash_value "$OVERRIDE_FILE")"
    # KEY names only. Env keys in every writer-produced shape are UPPER_SNAKE and indented;
    # yaml structure keys (services/backend/web/environment/image) are lowercase; full-line
    # comments start at column 0. A key this pattern cannot see cannot silently pass either —
    # unknown UPPER keys land in file_names and force shape=unexpected below.
    # grep exits 1 on ZERO matches — the expected outcome for the none shape. MECHANISM
    # CORRECTED (P3-1, gate on fa74e5cae1): errexit is SUPPRESSED for a function invoked on the
    # left of `||` (the sole call site is `classify_runner_override || status_rc=1`), so on a
    # host the un-fixed line would NOT have aborted — it silently yielded empty file_names and a
    # calm `none`, the UNSAFE direction. The executable test caught it only because its harness
    # calls the function bare. Readability was checked above, so rc>=2 cannot hide an unreadable
    # file behind the trailing `|| true`.
    file_names="$(grep -Eo '^[[:space:]]+[A-Z_][A-Z0-9_]*:' "$OVERRIDE_FILE" | tr -d ' \t:' | sort -u | tr '\n' ' ' || true)"
    file_names="${file_names% }"
  fi

  local shape
  if [[ "$file_present" == false ]]; then shape="absent"
  elif [[ -z "$file_names" ]] && [[ -r "$OVERRIDE_FILE" ]] && grep -q 'environment:' "$OVERRIDE_FILE"; then
    # P2-3 (gate on fa74e5cae1): quoted keys, flow maps and list-form entries are legal compose
    # spellings this parser does not read — a hand-edited file in any of them parsed as a CALM
    # none, inverting this function's own fail-loud principle. An environment block whose keys
    # we cannot enumerate is an environment we cannot explain.
    shape="unexpected"
  elif [[ -z "$file_names" ]]; then shape="none"
  elif [[ "$file_names" == "$rd_set" ]]; then shape="rd-window"
  elif [[ "$file_names" == "$soak_set" ]]; then shape="soak-w4w7"
  else shape="unexpected"
  fi

  # Live side: presence by EXIT CODE only — stdout goes to /dev/null UNREAD, so values never
  # enter this function.
  #
  # POSITIVE CONTROL FOR THE PROBE CHANNEL (P2-2, gate on fa74e5cae1 — MEASURED, and it
  # falsified this function's first shape): docker exec returns rc=1 both for "var unset" AND
  # for most cannot-observe failures — stopped container, no such container, daemon unreachable
  # all yield rc=1, not >1. rc alone cannot distinguish "observed unset" from "observed
  # nothing", and the first shape would have printed a confident file_live_match=true over zero
  # observations. PATH is set in every container this runner manages, so if PATH cannot be read
  # through the SAME channel, nothing below is an observation and the verdict is indeterminate.
  local name rc live_names="" probe_failed=false
  if ! docker exec "$BACKEND_CONTAINER" printenv PATH >/dev/null 2>&1; then
    probe_failed=true
  else
    for name in $candidates; do
      rc=0
      docker exec "$BACKEND_CONTAINER" printenv "$name" >/dev/null 2>&1 || rc=$?
      case "$rc" in
        0) live_names="${live_names:+$live_names }$name" ;;
        1) : ;;
        *) probe_failed=true ;;
      esac
    done
  fi

  local match live_sorted live_render
  if [[ "$probe_failed" == true ]]; then
    match="indeterminate"
    live_render="unobserved"
  else
    live_sorted="$(printf '%s\n' $live_names | sort -u | tr '\n' ' ')"
    live_sorted="$(echo "$live_sorted" | tr -s ' ')"; live_sorted="${live_sorted% }"; live_sorted="${live_sorted# }"
    [[ "$file_names" == "$live_sorted" ]] && match=true || match=false
    live_render="${live_sorted:-none}"
  fi

  {
    echo "override_shape=${shape}"
    echo "override_file_present=${file_present}"
    echo "override_file_sha256=${file_sha:-none}"
    echo "file_flag_names=${file_names:-none}"
    echo "live_flag_names=${live_render}"
    echo "file_live_match=${match}"
  } | tee "$out"

  # FAIL LOUD, never silently: an unexpected shape, a disk/live disagreement, or a failed probe
  # each mean the environment is not explained — the collection still WROTE everything above,
  # but the action must not exit 0 over it.
  [[ "$shape" != "unexpected" ]] || return 1
  [[ "$match" == true ]] || return 1
  return 0
}

action_status() {
  snapshot_staging_ps
  curl -sS --max-time 10 "$STAGING_WEB_HEALTH_URL" > "${OUTPUT_DIR}/health-web.json" 2>&1 \
    || echo "unreachable" > "${OUTPUT_DIR}/health-web.json"
  curl -sS --max-time 10 "$STAGING_BACKEND_HEALTH_URL" > "${OUTPUT_DIR}/health-backend.json" 2>&1 \
    || echo "unreachable" > "${OUTPUT_DIR}/health-backend.json"
  local live_commit
  live_commit="$(fetch_health_commit)"
  log "live build.commit: ${live_commit:-<unreachable>}"

  local status_rc=0
  # Values-free override classification FIRST: it needs no running container for the file side,
  # and a stopped/unreachable container fails the probe's PATH positive control, degrading the
  # verdict to file_live_match=indeterminate (never a confident green over zero observations).
  classify_runner_override || status_rc=1
  if docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER" 2>/dev/null | grep -qx 'true'; then
    prepare_container_runner
    staging_exec node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/migrate-list.txt" || status_rc=1
    assert_window_env_flags || status_rc=1
    local admin_id admin_token
    if admin_id="$(find_admin_user)"; then
      admin_token="$(mint_token "$admin_id" 'admin' 'attendance:read,attendance:admin')"
      capture_settings "$admin_token" "${OUTPUT_DIR}/settings-current.json" >/dev/null || status_rc=1
    else
      echo "no active admin user found; settings snapshot skipped" > "${OUTPUT_DIR}/settings-current.json"
    fi
  else
    log "backend container not running; container-side snapshots skipped"
    status_rc=1
  fi

  {
    echo "action=status"
    echo "live_commit=${live_commit:-unreachable}"
    grep '^override_shape=' "${OUTPUT_DIR}/override-shape.txt" 2>/dev/null || echo "override_shape=unrecorded"
    echo "status_rc=${status_rc}"
  } > "${OUTPUT_DIR}/summary.txt"
  return "$status_rc"
}

assert_migration_rollout_flags_off() {
  # Values are intentionally never printed. Include the two #4556 gates explicitly and any
  # future env whose name advertises ROLLOUT/SHADOW, so a newly-added flag fails closed too.
  local phase="$1" name value
  local -a names=(
    ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED
  )
  while IFS= read -r name; do
    [[ -n "$name" ]] && names+=("$name")
  done < <(
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$BACKEND_CONTAINER" \
      | sed 's/=.*//' | grep -Ei '(ROLLOUT|SHADOW)' || true
  )

  : > "${OUTPUT_DIR}/rollout-shadow-flags-${phase}.txt"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    value="$(docker exec "$BACKEND_CONTAINER" printenv "$name" 2>/dev/null || true)"
    case "${value,,}" in
      ''|0|false|off) echo "${name}=OFF" >> "${OUTPUT_DIR}/rollout-shadow-flags-${phase}.txt" ;;
      *) fail "rollout/shadow flag ${name} is enabled during ${phase}; action=migrate requires every rollout/shadow flag OFF" ;;
    esac
  done < <(printf '%s\n' "${names[@]}" | sort -u)
}

action_migrate_read_only_prechecks() {
  # Values-free prechecks for the target's data-dependent fail-loud arms. Only action names and
  # cardinalities enter the artifact; no ids, org labels, tenant data, DSNs, or credentials.
  local pg_user="$MIGRATE_BACKUP_PG_USER" pg_db="$MIGRATE_BACKUP_PG_DB"
  local has_org_id org_null_predicate=''
  has_org_id="$(docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "$pg_db" -tA -v ON_ERROR_STOP=1 \
    -c "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='approval_instances' AND column_name='org_id');" | tr -d '[:space:]')"
  [[ "$has_org_id" == "t" || "$has_org_id" == "f" ]] \
    || fail "could not determine whether approval_instances.org_id exists"
  [[ "$has_org_id" == "t" ]] && org_null_predicate='AND i.org_id IS NULL'

  docker exec -i "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "$pg_db" -tA -v ON_ERROR_STOP=1 <<SQL \
    | tee "${OUTPUT_DIR}/target-read-only-prechecks.txt"
SELECT 'approval_action_histogram=' || COALESCE(jsonb_object_agg(action, n ORDER BY action), '{}'::jsonb)::text
  FROM (SELECT action, count(*) AS n FROM approval_records GROUP BY action) h;
SELECT 'invalid_approval_action_count=' || count(*)::text
  FROM approval_records
 WHERE action NOT IN ('created','approve','reject','return','revoke','transfer','sign','comment','cc','remind','jump','add_sign','reduce_sign','reassign','handle','policy_denied');
SELECT 'attachment_org_conflict_count=' || count(*)::text FROM (
  SELECT a.instance_id
    FROM approval_attachments a
    JOIN approval_instances i ON i.id = a.instance_id
   WHERE a.instance_id IS NOT NULL
     ${org_null_predicate}
   GROUP BY a.instance_id
  HAVING count(DISTINCT a.org_id) > 1
) c;
SELECT 'zero_membership_active_user_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE);
SELECT 'zero_membership_no_row_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id);
SELECT 'zero_membership_only_deactivated_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE);
SELECT 'recovery09_repairable_user_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE)
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.org_id = 'default');
SELECT 'distinct_active_org_count=' || count(*)::text
  FROM (SELECT DISTINCT org_id FROM user_orgs WHERE is_active = TRUE) o;
SELECT 'directory_integration_distinct_org_count=' || count(*)::text
  FROM (SELECT DISTINCT org_id FROM directory_integrations WHERE org_id IS NOT NULL AND btrim(org_id) <> '') o;
SELECT 'directory_integration_non_default_count=' || count(*)::text
  FROM directory_integrations WHERE org_id <> 'default';
SELECT 'legacy_anchor_active_membership_witness_count=' || count(*)::text
  FROM user_orgs WHERE org_id = 'default' AND is_active = TRUE;
SELECT 'class6_candidate_count=' || count(*)::text
  FROM approval_instances i
 WHERE i.id NOT LIKE 'plm:%'
   AND i.id NOT LIKE 'afs:%'
   AND COALESCE(i.source_system, 'platform') = 'platform'
   AND i.template_id IS NULL
   ${org_null_predicate}
   AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
   AND NOT EXISTS (
     SELECT 1 FROM user_orgs uo
      WHERE uo.user_id = i.requester_snapshot->>'id'
        AND uo.is_active = TRUE
      GROUP BY uo.user_id
     HAVING count(*) = 1
   );
SELECT 'recovery09_unsupported_class6_count=' || count(*)::text
  FROM approval_instances i
 WHERE i.id NOT LIKE 'plm:%'
   AND i.id NOT LIKE 'afs:%'
   AND COALESCE(i.source_system, 'platform') = 'platform'
   AND i.template_id IS NULL
   ${org_null_predicate}
   AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
   AND NOT EXISTS (
     SELECT 1 FROM user_orgs uo
      WHERE uo.user_id = i.requester_snapshot->>'id' AND uo.is_active = TRUE
      GROUP BY uo.user_id HAVING count(*) = 1
   )
   AND NOT (
     NOT EXISTS (SELECT 1 FROM users u WHERE u.id = i.requester_snapshot->>'id')
     OR EXISTS (
       SELECT 1 FROM users u
        WHERE u.id = i.requester_snapshot->>'id' AND u.is_active = TRUE
          AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE)
          AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.org_id = 'default')
     )
   );
SQL

  local invalid conflicts zero_membership zero_no_row zero_deactivated repairable_users active_orgs directory_orgs non_default_integrations anchor_witness class6 unsupported_class6 value
  invalid="$(sed -n 's/^invalid_approval_action_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  conflicts="$(sed -n 's/^attachment_org_conflict_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  zero_membership="$(sed -n 's/^zero_membership_active_user_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  zero_no_row="$(sed -n 's/^zero_membership_no_row_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  zero_deactivated="$(sed -n 's/^zero_membership_only_deactivated_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  repairable_users="$(sed -n 's/^recovery09_repairable_user_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  active_orgs="$(sed -n 's/^distinct_active_org_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  directory_orgs="$(sed -n 's/^directory_integration_distinct_org_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  non_default_integrations="$(sed -n 's/^directory_integration_non_default_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  anchor_witness="$(sed -n 's/^legacy_anchor_active_membership_witness_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  class6="$(sed -n 's/^class6_candidate_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  unsupported_class6="$(sed -n 's/^recovery09_unsupported_class6_count=//p' "${OUTPUT_DIR}/target-read-only-prechecks.txt" | tail -n 1)"
  for value in "$invalid" "$conflicts" "$zero_membership" "$zero_no_row" "$zero_deactivated" "$repairable_users" "$active_orgs" "$directory_orgs" "$non_default_integrations" "$anchor_witness" "$class6" "$unsupported_class6"; do
    [[ "$value" =~ ^[0-9]+$ ]] || fail "target read-only precheck returned a non-numeric cardinality"
  done
  [[ "$invalid" == "0" ]] || fail "target precheck: ${invalid} approval_records rows carry an action outside the target constraint"
  [[ "$conflicts" == "0" ]] || fail "target precheck: ${conflicts} attachment-bearing approval instances have cross-org conflicts"
  # Deactivated-only rows are an explicitly disclosed non-resurrection residue. Recovery09 and
  # the corrected provisioning migration intentionally do not write them, so they must not make a
  # safe retry demand that the already-applied Recovery09 migration still be pending. Only the
  # executable no-row population and unresolved class-6 rows require the repair gate.
  if [[ "$repairable_users" -gt 0 || "$class6" -gt 0 ]]; then
    if [[ "$active_orgs" != "1" ]]; then
      grep -q 'zzzz20260823040000_recovery09_prepare_legacy_default_org' "${OUTPUT_DIR}/target-migrate-list-before.txt" \
        || fail "target precheck: multi-org repair is required but the Recovery09 pre-alignment migration is not pending in the exact target image"
      grep -q 'zzzz20260823149900_recovery09_close_approval_org_gap' "${OUTPUT_DIR}/target-migrate-list-before.txt" \
        || fail "target precheck: multi-org repair is required but the Recovery09 gap migration is not pending in the exact target image"
      [[ "$((zero_no_row + zero_deactivated))" == "$zero_membership" ]] \
        || fail "target precheck: Recovery09 zero-membership buckets do not close over the measured population"
      [[ "$directory_orgs" == "1" && "$non_default_integrations" == "0" && "$anchor_witness" -gt 0 ]] \
        || fail "target precheck: Recovery09 legacy default anchor is not uniquely and actively witnessed"
      [[ "$unsupported_class6" == "0" ]] \
        || fail "target precheck: ${unsupported_class6} class-6 candidate(s) are outside the bounded Recovery09 fallback"
    fi
  fi
  log "target read-only prechecks OK"
}

action_migrate_backup() {
  # Step 2 of the runbook-compliant sequence: pg_dump the REAL staging DB to a HOST file
  # (never the staging repo dir — not writable by this SSH user; never uploaded as a CI
  # artifact — it contains business data). Records sha256 + byte size + path only.
  # Here-string (not `< <(...)` process substitution): bash appends a trailing newline
  # when feeding a here-string, so `read` sees a complete line and exits 0 even though
  # resolve_postgres_creds's printf has no trailing \n. With process substitution instead,
  # `read` would hit EOF before a newline and return 1, tripping `set -e`.
  local pg_user pg_db
  read -r pg_user pg_db <<< "$(resolve_postgres_creds)"

  mkdir -p "$BACKUP_DIR"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  MIGRATE_BACKUP_PATH="${BACKUP_DIR}/staging-${ts}-pre-migrate.dump"

  log "backup: pg_dump -Fc -U ${pg_user} ${pg_db} -> ${MIGRATE_BACKUP_PATH}"
  docker exec "$POSTGRES_CONTAINER" pg_dump -Fc -U "$pg_user" "$pg_db" > "$MIGRATE_BACKUP_PATH"
  [[ -s "$MIGRATE_BACKUP_PATH" ]] \
    || fail "backup file is empty: ${MIGRATE_BACKUP_PATH}; refusing to proceed without a working backup (runbook: pg_dump first is non-negotiable)"

  MIGRATE_BACKUP_SHA256="$(hash_value "$MIGRATE_BACKUP_PATH")"
  MIGRATE_BACKUP_BYTES="$(wc -c < "$MIGRATE_BACKUP_PATH" | tr -d '[:space:]')"
  MIGRATE_BACKUP_PG_USER="$pg_user"
  MIGRATE_BACKUP_PG_DB="$pg_db"

  {
    echo "path=${MIGRATE_BACKUP_PATH}"
    echo "sha256=${MIGRATE_BACKUP_SHA256}"
    echo "bytes=${MIGRATE_BACKUP_BYTES}"
    echo "pg_user=${pg_user}"
    echo "pg_db=${pg_db}"
    echo "note=dump stays on the deploy host at the path above; NOT uploaded (business data, public-repo artifacts are world-downloadable); retention is an operator decision"
  } > "${OUTPUT_DIR}/backup-metadata.txt"
  log "backup OK: ${MIGRATE_BACKUP_BYTES} bytes, sha256=${MIGRATE_BACKUP_SHA256} (dump stays on host, not uploaded)"
}

action_migrate_rehearse() {
  # Step 3: clone-rehearsal. Restores the just-taken backup into a throwaway DB inside
  # the SAME postgres container/server, then runs migrate.js against ONLY that DB. The
  # real staging DB is never touched by this function. The rehearsal DB (and the
  # container-local copy of the dump used to restore it) are ALWAYS removed on exit —
  # trap-guarded so an abort mid-rehearsal still cleans up.
  # Globals (NOT locals): the EXIT trap must see these under every bash invocation mode
  # (function locals are not reliably visible to traps under `bash -c`). Review P3, round 6.
  REHEARSAL_PG_USER="$MIGRATE_BACKUP_PG_USER"
  REHEARSAL_CONTAINER_DUMP_PATH="${CONTAINER_RUNNER_DIR}/rehearsal-${RUN_STAMP}.dump"
  local pg_user="$REHEARSAL_PG_USER"
  local container_dump_path="$REHEARSAL_CONTAINER_DUMP_PATH"

  cleanup_rehearsal() {
    # Fixed synthetic name only — this can never name the real staging DB.
    docker exec "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_PG_USER" -d postgres -v ON_ERROR_STOP=0 \
      -c "DROP DATABASE IF EXISTS ${REHEARSAL_DB};" >/dev/null 2>&1 || true
    docker exec "$POSTGRES_CONTAINER" rm -f "$REHEARSAL_CONTAINER_DUMP_PATH" >/dev/null 2>&1 || true
  }

  log "rehearsal: dropping any prior ${REHEARSAL_DB} left by an aborted run"
  cleanup_rehearsal
  trap 'cleanup_rehearsal; cleanup_target_migration_runtime' EXIT
  # P2-4 hardening (2026-08-24): explicit HUP/INT/TERM registration, not relying on the
  # EXIT trap alone. CORRECTION during review: on the bash versions actually tested here
  # (3.2 and 5.3, foreground-command and pipeline cases both), a bare `trap ... EXIT` DID
  # already run on an uncaught SIGHUP/SIGINT/SIGTERM — so this is NOT closing a demonstrated
  # "signal leaves the secret file behind" hole on those bash builds. It ships anyway
  # because that behavior is bash's own implementation detail, not a documented contract
  # (the manual only promises EXIT's ACTION runs "on exit from the shell"; nothing commits
  # bash, on every version/platform this runner may ever run on, to also invoke it on every
  # uncaught deadly signal) — explicit registration is the portable, self-documenting
  # contract instead of an implicit one, and OOM-kill (SIGKILL) / host reboot remain
  # uncatchable by ANY trap regardless, EXIT included. What IS genuinely load-bearing here:
  # bash does NOT auto-terminate a process after running a trapped signal's handler (unlike
  # the EXIT pseudo-signal, which fires as the shell is already on its way out) — without
  # the explicit `exit 1` below, a HUP/INT/TERM handler that only ran cleanup would leave
  # the process hung, still consuming the migration window. Registered SEPARATELY from the
  # EXIT trap (not combined into one `trap ... EXIT HUP INT TERM`): a handler that also
  # covers EXIT and unconditionally calls `exit N` would clobber the script's real exit code
  # on the ordinary successful-completion path, where only EXIT fires. The EXIT trap above
  # fires again as part of this handler's own `exit` (harmless — cleanup_rehearsal is
  # DROP-IF-EXISTS/rm -f, cleanup_target_migration_runtime no-ops once TARGET_MIGRATION_ENV_FILE
  # is cleared). Mutation-proven via `trap -p` registration, not a signal-delivery A/B (that
  # comparison is exactly what did not discriminate in the bash versions tested — see the
  # pipeline test file for the measurement).
  trap 'cleanup_rehearsal; cleanup_target_migration_runtime; exit 1' HUP INT TERM

  log "rehearsal: creating ${REHEARSAL_DB} (clearly-synthetic fixed name; same postgres server as staging)"
  docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE ${REHEARSAL_DB};" 2>&1 | tee "${OUTPUT_DIR}/rehearsal-create-db.log"

  log "rehearsal: copying the backup into the postgres container (pg_restore -j needs a seekable file, not stdin)"
  docker exec "$POSTGRES_CONTAINER" mkdir -p "$CONTAINER_RUNNER_DIR"
  docker cp "$MIGRATE_BACKUP_PATH" "${POSTGRES_CONTAINER}:${container_dump_path}"

  log "rehearsal: restoring into ${REHEARSAL_DB}"
  # The audit-log partitions inherit a row trigger from their partitioned parent
  # (set_retention_period), which lives in the PRE-data section and fires during COPY,
  # querying audit_retention_policies before it is restored (run 29340321213).
  # pg_restore --disable-triggers is only honored in DATA-ONLY restores and is silently
  # inert in a full restore (empirically falsified in run 29347058494). The mechanism
  # that actually holds for a full parallel restore: DB-level
  # session_replication_role=replica (normal triggers do not fire in replica mode; the
  # DB-level GUC binds every -j worker connection). RESET before the rehearsal migrate
  # so migrations run under normal trigger semantics (faithful rehearsal).
  docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE ${REHEARSAL_DB} SET session_replication_role = 'replica';"

  # pg_restore pins each worker's search_path to the empty string. One already-applied
  # attendance SQL function calls another public function by bare name, so COPY of a table whose
  # CHECK constraint invokes it fails even though both functions are present. Restore pre-data
  # first, apply a clone-only function search_path for that exact legacy shape, then restore data
  # and post-data. Reset the clone function afterward so the rehearsal migration starts from the
  # same function configuration as the source DB. The real staging DB is queried read-only and is
  # never altered by this compatibility shim.
  local restore_log="${OUTPUT_DIR}/rehearsal-restore.log"
  local legacy_fn_signature="public.attendance_w4_scheduled_name_bytes(uuid, uuid, date)"
  local legacy_fn_present legacy_fn_def legacy_fn_config legacy_fn_shim="no"
  : > "$restore_log"

  legacy_fn_present="$(docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "$MIGRATE_BACKUP_PG_DB" -tA \
    -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_proc WHERE oid = to_regprocedure('${legacy_fn_signature}');" \
    2>/dev/null | tr -d '[:space:]')"
  [[ "$legacy_fn_present" =~ ^[01]$ ]] \
    || fail "rehearsal restore compatibility probe returned a non-boolean function count"
  if [[ "$legacy_fn_present" == "1" ]]; then
    legacy_fn_def="$(docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "$MIGRATE_BACKUP_PG_DB" -tA \
      -v ON_ERROR_STOP=1 -c "SELECT pg_get_functiondef(to_regprocedure('${legacy_fn_signature}'));" 2>/dev/null)"
    legacy_fn_config="$(docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "$MIGRATE_BACKUP_PG_DB" -tA \
      -v ON_ERROR_STOP=1 -c "SELECT COALESCE(array_to_string(proconfig, ','), '') FROM pg_proc WHERE oid = to_regprocedure('${legacy_fn_signature}');" \
      2>/dev/null | tr -d '[:space:]')"
    if [[ "$legacy_fn_def" == *"attendance_w4_canonical_date_text(work_date)"* \
       && "$legacy_fn_def" != *"public.attendance_w4_canonical_date_text(work_date)"* \
       && "$legacy_fn_config" != *"search_path="* ]]; then
      legacy_fn_shim="yes"
    fi
  fi

  log "rehearsal: restoring pre-data"
  docker exec "$POSTGRES_CONTAINER" pg_restore -j 2 --exit-on-error --section=pre-data -U "$pg_user" \
    -d "$REHEARSAL_DB" "$container_dump_path" 2>&1 | tee -a "$restore_log"
  if [[ "$legacy_fn_shim" == "yes" ]]; then
    log "rehearsal: applying clone-only legacy function search_path compatibility"
    docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "$REHEARSAL_DB" -v ON_ERROR_STOP=1 \
      -c "ALTER FUNCTION ${legacy_fn_signature} SET search_path = pg_catalog, public;" \
      2>&1 | tee "${OUTPUT_DIR}/rehearsal-restore-compat.log"
  fi
  log "rehearsal: restoring data"
  docker exec "$POSTGRES_CONTAINER" pg_restore -j 2 --exit-on-error --section=data -U "$pg_user" \
    -d "$REHEARSAL_DB" "$container_dump_path" 2>&1 | tee -a "$restore_log"
  log "rehearsal: restoring post-data"
  docker exec "$POSTGRES_CONTAINER" pg_restore -j 2 --exit-on-error --section=post-data -U "$pg_user" \
    -d "$REHEARSAL_DB" "$container_dump_path" 2>&1 | tee -a "$restore_log"
  if [[ "$legacy_fn_shim" == "yes" ]]; then
    log "rehearsal: resetting clone-only legacy function compatibility"
    docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "$REHEARSAL_DB" -v ON_ERROR_STOP=1 \
      -c "ALTER FUNCTION ${legacy_fn_signature} RESET search_path;" \
      2>&1 | tee -a "${OUTPUT_DIR}/rehearsal-restore-compat.log"
  fi
  docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE ${REHEARSAL_DB} RESET session_replication_role;"

  local backend_dsn rehearsal_dsn
  backend_dsn="$(resolve_backend_database_url)"
  rehearsal_dsn="$(dsn_replace_database "$backend_dsn" "$REHEARSAL_DB")"

  # Channel-independent isolation guard (review P2, round 6): the -e DATABASE_URL override
  # only isolates if migrate.js resolves its DSN from process.env (SECRET_PROVIDER=env).
  # Under file/vault providers the override is SILENTLY IGNORED and the "rehearsal" would
  # migrate the REAL staging DB. Defend independently of that channel: count applied
  # migrations in BOTH DBs via direct psql before and after the rehearsal run, and require
  # the real DB's count to be UNCHANGED and the rehearsal DB's to have ADVANCED.
  count_applied() { # count_applied <db-name>
    docker exec "$POSTGRES_CONTAINER" psql -U "$REHEARSAL_PG_USER" -d "$1" -tA \
      -c "SELECT COALESCE((SELECT count(*) FROM kysely_migration), 0);" 2>/dev/null | tr -d '[:space:]'
  }
  local real_db real_before rehearsal_before real_after rehearsal_after
  real_db="$(dsn_database_name "$backend_dsn")"
  [[ -n "$real_db" && "$real_db" != "$REHEARSAL_DB" ]] \
    || fail "could not resolve the real staging DB name distinct from the rehearsal DB (got '${real_db:-<empty>}')"
  real_before="$(count_applied "$real_db")"
  rehearsal_before="$(count_applied "$REHEARSAL_DB")"
  [[ "$real_before" =~ ^[0-9]+$ && "$rehearsal_before" =~ ^[0-9]+$ ]] \
    || fail "pre-rehearsal applied-migration counts unreadable (real='${real_before}' rehearsal='${rehearsal_before}')"
  log "rehearsal isolation baseline: applied(real ${real_db})=${real_before} applied(${REHEARSAL_DB})=${rehearsal_before}"

  log "rehearsal: running migrate.js against the REHEARSAL DB only (staging DB untouched so far)"
  target_migrate_exec "DATABASE_URL=${rehearsal_dsn}" -- node "$MIGRATE_JS" < /dev/null 2>&1 \
    | tee "${OUTPUT_DIR}/rehearsal-migrate-run.log"

  real_after="$(count_applied "$real_db")"
  rehearsal_after="$(count_applied "$REHEARSAL_DB")"
  log "rehearsal isolation check: applied(real ${real_db}) ${real_before}->${real_after}; applied(${REHEARSAL_DB}) ${rehearsal_before}->${rehearsal_after}"
  {
    echo "real_db=${real_db} real_before=${real_before} real_after=${real_after}"
    echo "rehearsal_before=${rehearsal_before} rehearsal_after=${rehearsal_after}"
  } > "${OUTPUT_DIR}/rehearsal-isolation-check.txt"
  [[ "$real_after" == "$real_before" ]] \
    || fail "ISOLATION BREACH: real staging DB applied-migration count changed ${real_before}->${real_after} during the rehearsal run — the DATABASE_URL override was ignored (non-env secret provider?). STOP; restore from ${MIGRATE_BACKUP_PATH} per runbook before ANY further action"
  [[ "$rehearsal_after" -gt "$rehearsal_before" || "$rehearsal_after" -ge "$real_before" ]] \
    || fail "rehearsal DB applied count did not advance (${rehearsal_before}->${rehearsal_after}) — the rehearsal migrate did not actually run against ${REHEARSAL_DB}; refusing to treat rehearsal as green"

  log "rehearsal: confirming pending=0 against the rehearsal DB"
  target_migrate_exec "DATABASE_URL=${rehearsal_dsn}" -- node "$MIGRATE_JS" --list < /dev/null 2>&1 \
    | tee "${OUTPUT_DIR}/rehearsal-migrate-list-after.txt"
  grep -q '^Pending: 0$' "${OUTPUT_DIR}/rehearsal-migrate-list-after.txt" \
    || fail "rehearsal migrate run did not leave the rehearsal DB at pending=0 (see rehearsal-migrate-list-after.txt); staging DB was NOT touched, stopping per the runbook"

  log "rehearsal: green — dropping ${REHEARSAL_DB} and the in-container dump copy"
  cleanup_rehearsal
  trap - EXIT HUP INT TERM
  log "rehearsal OK"
}

action_migrate_apply() {
  # Step 4: only reached if action_migrate_rehearse fully succeeded. Same before/after
  # pending-list discipline as action_deploy's migration step, against the REAL staging DB.
  local backend_dsn real_db
  backend_dsn="$(resolve_backend_database_url)"
  real_db="$(dsn_database_name "$backend_dsn")"
  [[ -n "$real_db" ]] || fail "could not resolve the real staging DB name for the in-play migration computation"

  log "apply: migrate-list BEFORE (real staging DB)"
  target_migrate_exec -- node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/apply-migrate-list-before.txt"

  # P1-2 (2026-08-24): compute the in-play set BEFORE running migrate, from two sources
  # that are both immune to process.env (see compute_in_play_migrations) — done up front so
  # the set reflects what SHOULD be applied by this run, independent of anything the apply
  # step itself might do to the ledger.
  log "apply: computing the in-play migration set (image filesystem manifest minus already-applied, both env-immune)"
  compute_in_play_migrations "$real_db"

  assert_applied_counts_agree "${OUTPUT_DIR}/migration-applied-before.txt" "${OUTPUT_DIR}/apply-migrate-list-before.txt"

  log "apply: running migrate.js against the REAL staging DB (rehearsal was green)"
  target_migrate_exec -- node "$MIGRATE_JS" < /dev/null 2>&1 | tee "${OUTPUT_DIR}/apply-migrate-run.log"

  target_migrate_exec -- node "$MIGRATE_JS" --list < /dev/null 2>&1 | tee "${OUTPUT_DIR}/apply-migrate-list-after.txt"
  grep -q '^Pending: 0$' "${OUTPUT_DIR}/apply-migrate-list-after.txt" \
    || fail "staging migrate did not end at pending=0 after apply (see apply-migrate-list-after.txt); restore from ${MIGRATE_BACKUP_PATH} if needed (runbook §Failure modes)"

  # Named invariant, independent of the mechanically-derived set below: 076 underlies the
  # stock-prep write path and is confirmed explicitly by name regardless of whether it was
  # already applied via the stock-prep window (and therefore absent from migration-in-play.txt).
  target_migrate_exec -- node "$MIGRATE_JS" --confirm 076_create_integration_stock_prep_pack_installs < /dev/null 2>&1 \
    | tee "${OUTPUT_DIR}/confirm-076.txt"
  grep -q '^migration "076_create_integration_stock_prep_pack_installs" is applied$' "${OUTPUT_DIR}/confirm-076.txt" \
    || fail "named confirmation for 076_create_integration_stock_prep_pack_installs.sql did not pass"

  # P1-2: confirm EVERY migration this deploy had in play, by name, mechanically derived
  # (never hardcoded) — this covers the 0817/0818 approval four
  # (approval-parity-verification-report-20260818.md:431,448-449) AND the closeout-chain
  # four (S1 org_id / Migration B backfill / provisioning / gap-closer) AND anything else
  # added since, without maintaining a second hand-written name list.
  log "apply: confirming $(wc -l < "${OUTPUT_DIR}/migration-in-play.txt" | tr -d '[:space:]') in-play migration(s) by name"
  confirm_in_play_migrations "${OUTPUT_DIR}/migration-in-play.txt"

  log "apply OK: staging migrate ended at pending=0"
}

action_migrate() {
  require_sha
  # P2-4: EXIT + HUP/INT/TERM registered separately — see the identical note at the clone
  # rehearsal step's first trap, above, for why (exit-code safety on the ordinary path).
  trap cleanup_target_migration_runtime EXIT
  trap 'cleanup_target_migration_runtime; exit 1' HUP INT TERM
  prepare_container_runner
  prepare_target_migration_image
  assert_migration_rollout_flags_off before

  log "target migration inventory BEFORE (exact deploy_sha image; read-only)"
  target_migrate_exec -- node "$MIGRATE_JS" --list < /dev/null 2>&1 \
    | tee "${OUTPUT_DIR}/target-migrate-list-before.txt"

  # Resolve credentials for the read-only gates without creating a backup yet. The backup helper
  # repeats this resolution and remains the first retentive step.
  read -r MIGRATE_BACKUP_PG_USER MIGRATE_BACKUP_PG_DB <<< "$(resolve_postgres_creds)"
  action_migrate_read_only_prechecks
  action_migrate_backup
  action_migrate_rehearse
  trap cleanup_target_migration_runtime EXIT
  trap 'cleanup_target_migration_runtime; exit 1' HUP INT TERM
  action_migrate_apply

  # Step 5: post-checks.
  curl -fsS --max-time 10 "$STAGING_WEB_HEALTH_URL" > "${OUTPUT_DIR}/health-web.json" \
    || fail "post-apply health check failed: ${STAGING_WEB_HEALTH_URL} unreachable"
  grep -q '"ok":true' "${OUTPUT_DIR}/health-web.json" \
    || fail "post-apply health check did not report ok:true (see health-web.json)"
  auth_round_trip
  snapshot_staging_ps
  assert_migration_rollout_flags_off after

  {
    echo "action=migrate"
    echo "migration_image=${TARGET_MIGRATION_IMAGE}"
    echo "migration_image_id=${TARGET_MIGRATION_IMAGE_ID}"
    echo "migration_repo_digest=${TARGET_MIGRATION_REPO_DIGEST}"
    echo "migration_revision=${DEPLOY_SHA}"
    echo "backup_path=${MIGRATE_BACKUP_PATH}"
    echo "backup_sha256=${MIGRATE_BACKUP_SHA256}"
    echo "backup_bytes=${MIGRATE_BACKUP_BYTES}"
    echo "rehearsal_db=${REHEARSAL_DB}"
    echo "rehearsal_result=ok"
    echo "apply_result=ok"
    echo "target_pending_after=0"
    echo "076_create_integration_stock_prep_pack_installs.sql=applied"
    echo "rollout_shadow_flags=OFF"
    echo "application_deployed=no"
    echo "result=ok"
  } > "${OUTPUT_DIR}/summary.txt"
  cleanup_target_migration_runtime
  trap - EXIT HUP INT TERM
  log "migrate OK: backup=${MIGRATE_BACKUP_PATH} rehearsal=ok apply=ok"
}

# --- W4+W7 combined-soak (#4556) helpers + actions -------------------------------------
#
# WHY POSTURE NEVER GOES THROUGH psql HERE: both posture tables carry legal-transition
# machinery (the W4 rollout trigger `attendance_w4_rollout_state_guard`; the W7 posture
# trigger `trg_accss_state_guard` + NOT NULL audit columns), and each has exactly ONE
# sanctioned writer (transitionAttendanceCalculationRolloutV1 /
# transitionAttendanceW7ContextSourceV1), driven exclusively by the two operator CLIs.
# soak-seed therefore drives the CLIs (plan -> manifest -> apply), and every seeded DATA
# shape below mirrors the inserts the real-PG e2e suite runs against the live schema
# (attendance-w7-1b-cutover-e2e.db.test.ts seedShiftAndEffectiveGroup — trigger-legal there).
#
# EXEC-SCOPED ALLOWLIST ENV, stated plainly: the transition boundaries gate on the org
# being in the W4/W7 allowlist env of the PROCESS RUNNING THE CLI. During soak-seed those
# variables are passed with `docker exec -e` to the CLI process ONLY — the serving backend
# process and the container's configured env are untouched (soak-seed re-probes and records
# them afterwards). The SERVING flags flip exactly once, in soak-flags, through the same
# atomic persistent-override mechanism the deploy action uses, and only after the
# soak-baseline marker exists (baseline BEFORE flags — O4-2 needs a pre-enablement anchor).

# Regexes kept in variables: ';' and '|' inside an inline [[ =~ ]] pattern are shell
# metacharacters and break parsing.
SOAK_OPTS_RE='^[A-Za-z0-9=;._:/|-]*$'
SOAK_OPT_VALUE_RE='^[A-Za-z0-9._:/|-]+$'

soak_validate_opts() {
  [[ "$SOAK_OPTS" =~ $SOAK_OPTS_RE ]] \
    || fail "soak_opts contains characters outside the safe set [A-Za-z0-9=;._:/|-]; refusing"
}

soak_opt() {
  # soak_opt <key> <default> — read one key=value pair out of SOAK_OPTS (';'-separated).
  local key="$1" default="${2:-}" pair value
  local IFS=';'
  for pair in $SOAK_OPTS; do
    [[ -n "$pair" ]] || continue
    if [[ "${pair%%=*}" == "$key" ]]; then
      value="${pair#*=}"
      [[ "$value" =~ $SOAK_OPT_VALUE_RE ]] \
        || fail "soak_opts ${key} value has unsafe characters: '${value}'"
      printf '%s' "$value"
      return 0
    fi
  done
  printf '%s' "$default"
}

soak_opt_present() {
  # soak_opt_present <key> — true (rc 0) iff `key=` appears as one of the ';'-separated
  # SOAK_OPTS pairs, regardless of value. Needed because soak_opt alone cannot distinguish
  # "operator supplied this key" from "soak_opt returned its own default" — w7_target in
  # particular always resolves to a value via its default, so rotate_password=true's
  # standalone-act refusal (action_soak_seed) must check presence, not the resolved value.
  local key="$1" pair
  local IFS=';'
  for pair in $SOAK_OPTS; do
    [[ -n "$pair" ]] || continue
    [[ "${pair%%=*}" == "$key" ]] && return 0
  done
  return 1
}

soak_require_orgs() {
  [[ -n "$SOAK_ORGS" ]] || fail "soak_orgs is required for action=${ACTION}: comma-separated org1,org2,org3 in the runbook's C3 order (org1=legacy-only, org2=W4-only, org3=both-machines/group-arm)"
  local extra
  IFS=',' read -r SOAK_ORG1 SOAK_ORG2 SOAK_ORG3 extra <<< "${SOAK_ORGS},"
  [[ -z "$extra" ]] || fail "soak_orgs must be exactly 3 comma-separated org UUIDs, got: '${SOAK_ORGS}'"
  local org
  for org in "$SOAK_ORG1" "$SOAK_ORG2" "$SOAK_ORG3"; do
    [[ "$org" =~ $SOAK_UUID_RE ]] \
      || fail "soak_orgs entry is not a lower-case UUID: '${org}'. The allowlist resolvers trim but do NOT case-fold while the compared org key arrives lower-cased, so an upper-case entry silently resolves to an off/no-op posture with no diagnostic (runbook §0.3 item 3) — this runner refuses instead"
  done
  [[ "$SOAK_ORG1" != "$SOAK_ORG2" && "$SOAK_ORG1" != "$SOAK_ORG3" && "$SOAK_ORG2" != "$SOAK_ORG3" ]] \
    || fail "soak_orgs must name 3 DISTINCT orgs"
  SOAK_ORG1_SHORT="${SOAK_ORG1:0:8}"
  SOAK_ORG2_SHORT="${SOAK_ORG2:0:8}"
  SOAK_ORG3_SHORT="${SOAK_ORG3:0:8}"
}

soak_backend_env() {
  # The CONTAINER-CONFIGURED value of one env var on the serving backend (docker exec
  # spawns with the container's configured env; a transient `docker exec -e` from another
  # invocation can never appear here). Empty when unset.
  docker exec "$BACKEND_CONTAINER" printenv "$1" 2>/dev/null || true
}

soak_resolve_pg() {
  read -r SOAK_PG_USER SOAK_PG_DB <<< "$(resolve_postgres_creds)"
}

soak_psql_ta() {
  # One read/write statement against the REAL staging DB, tuples-only unaligned.
  docker exec "$POSTGRES_CONTAINER" psql -U "$SOAK_PG_USER" -d "$SOAK_PG_DB" -v ON_ERROR_STOP=1 -tA -c "$1"
}

soak_psql_rows() {
  # Row-set form (aligned, with header) for report sections.
  docker exec "$POSTGRES_CONTAINER" psql -U "$SOAK_PG_USER" -d "$SOAK_PG_DB" -v ON_ERROR_STOP=1 -A -F'|' -c "$1"
}

soak_json_get() {
  # soak_json_get <file> <dotted.path> — prints the value ('null'/'true'/'false' for JSON
  # null/booleans); exits nonzero when the file/path is unreadable.
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        node = json.load(f)
    for part in sys.argv[2].split('.'):
        node = node[part]
except Exception:
    sys.exit(1)
if node is None:
    print("null")
elif isinstance(node, bool):
    print("true" if node else "false")
else:
    print(node)
PY
}

soak_uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

soak_require_backend_clis() {
  staging_exec test -f "$SOAK_W4C5_CLI" \
    || fail "deployed backend image lacks ${SOAK_W4C5_CLI}; deploy a newer SHA first (the CLI must come from the SAME build as the transition boundary it drives)"
  staging_exec test -f "$SOAK_W7_CLI" \
    || fail "deployed backend image lacks ${SOAK_W7_CLI} (W7-3 not in the deployed image); deploy a newer SHA first"
  staging_exec test -f "$SOAK_TSX" \
    || fail "deployed backend image lacks tsx at ${SOAK_TSX}"
}

soak_backend_image_sha() {
  # stdout: the RUNNING backend image's full-SHA tag; fails when the pin is not full-SHA.
  local live_image
  live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")"
  [[ "$live_image" =~ :([0-9a-f]{40})$ ]] \
    || fail "backend image tag is not a full-SHA pin: '${live_image}'"
  printf '%s' "${BASH_REMATCH[1]}"
}

action_soak_baseline() {
  soak_validate_opts
  mkdir -p "$SOAK_PERSIST_DIR"
  # FAIL CLOSED: a baseline captured after either allowlist flag is live is not a
  # pre-enablement baseline (O4-2 anchors on it). This is the order gate's first half;
  # soak-flags enforces the second half by requiring the marker this action writes.
  local w4_env w7_env
  w4_env="$(soak_backend_env "$SOAK_W4_ENV_NAME")"
  w7_env="$(soak_backend_env "$SOAK_W7_ENV_NAME")"
  if [[ -n "$w4_env" || -n "$w7_env" ]]; then
    fail "refusing to capture the p95 baseline: ${SOAK_W4_ENV_NAME}='${w4_env:-<unset>}' ${SOAK_W7_ENV_NAME}='${w7_env:-<unset>}' already set on the serving backend — the baseline must precede the flags (P95-BASELINE-CAPTURE-PACK-20260816; an unanchored +5% claim is not evidence)"
  fi
  soak_resolve_pg
  # Build identity = the CONTAINER IMAGE TAG SHA. This is the accepted staging deploy
  # identity (L6 precedent: /api/health build.commit can be env-pinned stale, so it is NOT a
  # reliable identity — recorded below only as an informational cross-check). Recording the
  # image-tag SHA is load-bearing for the soak-flags SHA-scope gate (P2-2): soak-flags
  # requires DEPLOY_SHA == the running image tag, so the marker's staging_build_commit must
  # be that same channel or the comparison would false-mismatch on a stale health commit.
  local live_commit commit sha8 ts
  live_commit="$(fetch_health_commit)"
  commit="$(soak_backend_image_sha)"
  sha8="${commit:0:8}"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local baseline_name="p95-baseline-${sha8}-${ts}"
  local out="${OUTPUT_DIR}/${baseline_name}.txt"
  # Baseline query 1 (pack §1): 24h p95 of the punch->calculation write-latency proxy.
  local p95
  p95="$(soak_psql_ta "SELECT COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (c.created_at - r.created_at)))::text, 'no_rows_in_window') FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id WHERE c.created_at > now() - interval '24 hours';")"
  # Baseline query 2 (pack §2): pg_stat_statements differential input. The extension may
  # not be installed on staging postgres — recorded as an explicit named limitation, never
  # silently skipped and never a reason to fail the whole baseline capture.
  local pss_present pss=""
  pss_present="$(soak_psql_ta "SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements';")"
  if [[ "$pss_present" == "1" ]]; then
    pss="$(soak_psql_ta "SELECT calls, round((total_exec_time / calls)::numeric, 3) FROM pg_stat_statements WHERE query ILIKE '%attendance_record%' ORDER BY calls DESC LIMIT 20;")"
  fi
  {
    echo "# ${baseline_name} — O4-2 pre-enablement p95 baseline (P95-BASELINE-CAPTURE-PACK-20260816)"
    echo "generated=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "staging_build_commit=${commit}"
    echo "health_build_commit=${live_commit:-<unreachable>}"
    echo "backend_image=$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")"
    echo "w4_allowlist_env=unset_verified"
    echo "w7_allowlist_env=unset_verified"
    echo "p95_calc_write_latency_seconds_24h=${p95}"
    if [[ "$pss_present" == "1" ]]; then
      echo "pg_stat_statements=present"
      echo "# calls|mean_exec_ms — top-20 statements matching %attendance_record% (normalized query text deliberately omitted: values-free artifact)"
      printf '%s\n' "$pss"
    else
      echo "pg_stat_statements=absent"
      echo "# extension not installed on staging postgres; the O4-1 round-trip baseline channel is recorded as absent (named limitation, not silently skipped)"
    fi
  } > "$out"
  cp "$out" "${SOAK_PERSIST_DIR}/${baseline_name}.txt"
  {
    echo "baseline_name=${baseline_name}"
    echo "staging_build_commit=${commit}"
    echo "captured_at=${ts}"
  } > "$SOAK_BASELINE_MARKER"
  snapshot_staging_ps
  {
    echo "action=soak-baseline"
    echo "baseline_name=${baseline_name}"
    echo "staging_build_commit=${commit}"
    echo "result=ok"
  } > "${OUTPUT_DIR}/summary.txt"
  log "soak-baseline OK: ${baseline_name} (host copy under ${SOAK_PERSIST_DIR}; soak-flags now unblocked)"
}

soak_seed_write_org_sql() {
  # Generates the per-org idempotent seeding SQL ONCE into OUTPUT_DIR (artifact-visible),
  # parameterized via psql -v. Shapes mirror seedShiftAndEffectiveGroup in
  # packages/core-backend/tests/integration/attendance-w7-1b-cutover-e2e.db.test.ts, which
  # the real-PG suite runs against the live schema (trigger-legal there); idempotency via ON CONFLICT DO NOTHING and
  # WHERE NOT EXISTS keyed on business keys (re-running soak-seed is a no-op).
  cat > "$1" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;

-- Synthetic users (closed set; USERNAME convention synth-w4w7-<org8>-u<NN>). The family
-- marker lives on username/email ONLY: user ids are minted UUIDs, because the W4 live
-- shadow boundary's canonical identity gate (W4C0 §4.1 parseCanonicalAttendanceUserIdV1)
-- fail-closes non-UUID user ids — a TEXT family id 500s every punch the moment its org
-- enters W4 shadow (proven on staging: run 31957449480, W4C0_USER_ID_INVALID for every
-- org2 attempt). Idempotency is keyed on the username business key (ids are minted, not
-- deterministic, so ON CONFLICT (id) can no longer carry it).
INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
SELECT gen_random_uuid()::text,
       :'user_prefix' || lpad(i::text, 2, '0') || '@w4w7-soak.synthetic',
       :'user_prefix' || lpad(i::text, 2, '0'),
       'W4W7 combined-soak synthetic user',
       :'pw_hash', 'user', '[]'::jsonb, true, false, now(), now()
FROM generate_series(1, :user_count) AS i
WHERE NOT EXISTS (
  SELECT 1 FROM users u WHERE u.username = :'user_prefix' || lpad(i::text, 2, '0'));

-- Keep the whole closed family loginable with the CURRENT host credentials file, and
-- past the auth gate (activation/local-password) — synthetic usernames only, prefix-scoped.
UPDATE users
   SET password_hash = :'pw_hash',
       is_active = true,
       activation_status = 'activated',
       local_password_set = true
 WHERE username LIKE :'user_prefix' || '%';

INSERT INTO user_orgs (user_id, org_id, is_active)
SELECT u.id, :'org', true
FROM generate_series(1, :user_count) AS i
JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')
ON CONFLICT DO NOTHING;

-- POST /api/attendance/punch is withPermission('attendance:write'); login tokens carry no
-- perms on staging (RBAC reads the tables), so grant the one needed permission directly.
INSERT INTO user_permissions (user_id, permission_code)
SELECT u.id, 'attendance:write'
FROM generate_series(1, :user_count) AS i
JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')
ON CONFLICT DO NOTHING;

-- Full-day shift 00:00-23:59 in the org's timezone (task-ruled shape).
INSERT INTO attendance_shifts (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days, late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
SELECT gen_random_uuid(), :'org', :'shift_name', :'tz', '00:00', '23:59', false, '[0,1,2,3,4,5,6]'::jsonb, 5, 5, 15, 'strict'
WHERE NOT EXISTS (SELECT 1 FROM attendance_shifts WHERE org_id = :'org' AND name = :'shift_name');

-- Segment 0 mirrors the shift envelope (same shape as the W3 migration's own backfill).
INSERT INTO attendance_shift_segments (org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
SELECT :'org', s.id, 0, '00:00', 0, '23:59', 0
FROM attendance_shifts s
WHERE s.org_id = :'org' AND s.name = :'shift_name'
ON CONFLICT (shift_id, segment_index) DO NOTHING;

INSERT INTO attendance_groups (id, org_id, name, attendance_type, timezone)
SELECT gen_random_uuid(), :'org', :'group_name', 'fixed_shift', :'tz'
WHERE NOT EXISTS (SELECT 1 FROM attendance_groups WHERE org_id = :'org' AND name = :'group_name');

INSERT INTO attendance_group_fixed_schedule_configs (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
SELECT :'org', g.id, s.id, :'start_date'::date, :'end_date'::date, 1, 'w4w7-soak-seed'
FROM attendance_groups g
JOIN attendance_shifts s ON s.org_id = g.org_id AND s.name = :'shift_name'
WHERE g.org_id = :'org' AND g.name = :'group_name'
ON CONFLICT (org_id, group_id) DO NOTHING;

INSERT INTO attendance_group_members (org_id, group_id, user_id)
SELECT :'org', g.id, u.id
FROM attendance_groups g
CROSS JOIN generate_series(1, :user_count) AS i
JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')
WHERE g.org_id = :'org' AND g.name = :'group_name'
  AND NOT EXISTS (
    SELECT 1 FROM attendance_group_members m
     WHERE m.org_id = :'org' AND m.group_id = g.id
       AND m.user_id = u.id);

-- Published GROUP-PRODUCED assignment. producer_key spells the ONE canonical
-- implementation (plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs):
-- 'attendance_group_fixed_schedule:<groupId>:<shiftId>:<startDate>:<endDate>'.
INSERT INTO attendance_shift_assignments (org_id, user_id, shift_id, start_date, end_date, is_active, producer_type, producer_ref_id, producer_key, producer_run_id, publish_status)
SELECT :'org', u.id, s.id, :'start_date'::date, :'end_date'::date, true,
       'attendance_group_fixed_schedule', g.id,
       'attendance_group_fixed_schedule:' || g.id || ':' || s.id || ':' || :'start_date' || ':' || :'end_date',
       gen_random_uuid(), 'published'
FROM attendance_groups g
JOIN attendance_shifts s ON s.org_id = g.org_id AND s.name = :'shift_name'
CROSS JOIN generate_series(1, :user_count) AS i
JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')
WHERE g.org_id = :'org' AND g.name = :'group_name'
  AND NOT EXISTS (
    SELECT 1 FROM attendance_shift_assignments a
     WHERE a.org_id = :'org'
       AND a.user_id = u.id
       AND a.shift_id = s.id
       AND a.producer_key = 'attendance_group_fixed_schedule:' || g.id || ':' || s.id || ':' || :'start_date' || ':' || :'end_date');

INSERT INTO attendance_calculation_group_memberships (org_id, user_id, group_id, effective_from, effective_to, assigned_by, assigned_reason, assigned_correlation_id)
SELECT :'org', u.id, g.id, :'start_date'::date, NULL, 'w4w7-soak-seed', 'combined-soak seed', 'w4w7-soak-' || g.id
FROM attendance_groups g
CROSS JOIN generate_series(1, :user_count) AS i
JOIN users u ON u.username = :'user_prefix' || lpad(i::text, 2, '0')
WHERE g.org_id = :'org' AND g.name = :'group_name'
  AND NOT EXISTS (
    SELECT 1 FROM attendance_calculation_group_memberships m
     WHERE m.org_id = :'org'
       AND m.user_id = u.id
       AND m.group_id = g.id AND m.effective_to IS NULL);

COMMIT;
SQL
}

soak_seed_report_org() {
  # soak_seed_report_org <org> <user_prefix> — values-free per-org count report. The family
  # marker lives on users.username (ids are minted UUIDs), so every per-user count reaches
  # the family through a username join, never a user_id prefix.
  local org="$1" prefix="$2"
  {
    echo "org=${org}"
    echo "users=$(soak_psql_ta "SELECT count(*) FROM users WHERE username LIKE '${prefix}%';")"
    echo "user_orgs=$(soak_psql_ta "SELECT count(*) FROM user_orgs uo WHERE uo.org_id = '${org}' AND EXISTS (SELECT 1 FROM users u WHERE u.id = uo.user_id AND u.username LIKE '${prefix}%');")"
    echo "user_permissions=$(soak_psql_ta "SELECT count(*) FROM user_permissions p WHERE p.permission_code = 'attendance:write' AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id AND u.username LIKE '${prefix}%');")"
    echo "shifts=$(soak_psql_ta "SELECT count(*) FROM attendance_shifts WHERE org_id = '${org}' AND name LIKE 'w4w7-soak%';")"
    echo "segments=$(soak_psql_ta "SELECT count(*) FROM attendance_shift_segments seg WHERE seg.org_id = '${org}' AND EXISTS (SELECT 1 FROM attendance_shifts s WHERE s.id = seg.shift_id AND s.name LIKE 'w4w7-soak%');")"
    echo "groups=$(soak_psql_ta "SELECT count(*) FROM attendance_groups WHERE org_id = '${org}' AND name LIKE 'w4w7-soak%';")"
    echo "fixed_schedule_configs=$(soak_psql_ta "SELECT count(*) FROM attendance_group_fixed_schedule_configs WHERE org_id = '${org}' AND updated_by = 'w4w7-soak-seed';")"
    echo "group_members=$(soak_psql_ta "SELECT count(*) FROM attendance_group_members m WHERE m.org_id = '${org}' AND EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id AND u.username LIKE '${prefix}%');")"
    echo "published_assignments=$(soak_psql_ta "SELECT count(*) FROM attendance_shift_assignments a WHERE a.org_id = '${org}' AND a.publish_status = 'published' AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id AND u.username LIKE '${prefix}%');")"
    echo "calc_group_memberships=$(soak_psql_ta "SELECT count(*) FROM attendance_calculation_group_memberships m WHERE m.org_id = '${org}' AND EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id AND u.username LIKE '${prefix}%');")"
  } >> "${OUTPUT_DIR}/soak-seed-report.txt"
}

soak_w4_walk_to_shadow() {
  # Walk ONE org's W4 rollout posture legacy->shadow through the REAL Gate C CLI
  # (plan -> fresh manifest -> apply). Idempotent: an org already at/past shadow is skipped.
  #
  # TWO STATEMENTS, NOT ONE — load-bearing, proven by real dispatch 31953379181: bash
  # expands EVERY word of a `local` simple command BEFORE the builtin performs any
  # assignment, so in `local org="$1" org8="${org:0:8}"` the `${org:0:8}` reads the
  # CALLER's `org` — which in action_soak_seed is the seeding loop's local, left at ORG3
  # after the loop. In that dispatch the CLI target/DB reads (`$org`) were correct (both
  # rollout rows landed), but org2's label, plan/apply/manifest artifact FILENAMES, and
  # the manifest's syntheticOrgRef suffix (all `$org8`) said org3 — org2's walk evidence
  # was overwritten and misattributed. Splitting the statements makes `${org:0:8}` expand
  # AFTER the local `org` is assigned. Pinned by the pipeline test (source shape + an
  # executable bash leg reproducing the expansion order + a rejoin mutation leg).
  local org="$1"
  local org8="${org:0:8}"
  local state
  state="$(soak_psql_ta "SELECT COALESCE((SELECT state FROM attendance_calculation_rollout_state WHERE org_id = '${org}'), 'absent');")"
  case "$state" in
    shadow|eligible|authoritative)
      log "soak-seed: org ${org8} W4 rollout already '${state}' — skipped (idempotent; deeper rungs are the owner's soak-ladder acts, not this seeder's)"
      echo "w4_${org8}=already_${state}" >> "${OUTPUT_DIR}/soak-seed-posture.txt"
      return 0
      ;;
    suspended)
      fail "org ${org} W4 rollout is 'suspended' — this seeder never resumes a suspended org (owner incident path, W4C-5 amendment)"
      ;;
    absent|legacy) ;;
    *)
      fail "org ${org} W4 rollout state '${state}' unrecognized; refusing"
      ;;
  esac
  local seed_env_w4="${SOAK_W4_ENV_NAME}=${SOAK_ORG2},${SOAK_ORG3}"
  local plan_file="${OUTPUT_DIR}/w4-plan-${org8}.json"
  local plan_rc=0
  # W4C-5 plan prints {…plan, planDigest} FLAT and exits nonzero when blocked — keep the
  # JSON either way, then fail with it in the artifact.
  staging_exec_env "$seed_env_w4" -- node "$SOAK_TSX" "$SOAK_W4C5_CLI" plan --org "$org" --target shadow \
    > "$plan_file" 2> "${OUTPUT_DIR}/w4-plan-${org8}.stderr" < /dev/null || plan_rc=$?
  [[ -s "$plan_file" ]] || fail "W4C-5 plan produced no JSON for org ${org8} (rc=${plan_rc}; see w4-plan-${org8}.stderr in the artifact)"
  local blocked digest cur_state cur_version
  blocked="$(soak_json_get "$plan_file" blocked)" || fail "W4C-5 plan JSON unparseable for org ${org8}"
  [[ "$blocked" == "false" ]] || fail "W4C-5 plan is BLOCKED for org ${org8} (rc=${plan_rc}; predicate array captured verbatim in w4-plan-${org8}.json) — the soak cannot start over a failing Gate C predicate"
  digest="$(soak_json_get "$plan_file" planDigest)"
  cur_state="$(soak_json_get "$plan_file" currentState)"
  cur_version="$(soak_json_get "$plan_file" currentVersion)"
  [[ "$cur_version" == "null" ]] && cur_version=1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "W4C-5 planDigest unparseable for org ${org8}"
  # Fresh manifest, built AFTER every attestation it carries was checked by this runner:
  # pending=0 / health ok / worker off (preflight), the org verified exclusively-synthetic
  # (customerData:false, preflight synthetic-org check), and ownerAuthorizationRef /
  # entrypointInventoryRef supplied by the operator (never fabricated — required soak_opts).
  local manifest_host="${OUTPUT_DIR}/w4-manifest-${org8}.json"
  printf '{"schemaVersion":1,"collectedAt":"%s","orgId":"%s","targetState":"shadow","imageSha":"%s","pendingMigrations":0,"serviceHealthy":true,"ownerAuthorizationRef":"%s","syntheticOrgRef":"synthetic-staging-org-%s","customerData":false,"externalNotificationsDisabled":true,"externalDestinationCount":0,"entrypointInventoryRef":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$org" "$SOAK_IMAGE_SHA" "$SOAK_OWNER_REF" "$org8" "$SOAK_ENTRYPOINT_INVENTORY_REF" > "$manifest_host"
  docker cp "$manifest_host" "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/w4-manifest-${org8}.json"
  local corr apply_rc=0
  corr="$(soak_uuid)"
  staging_exec_env "$seed_env_w4" -- node "$SOAK_TSX" "$SOAK_W4C5_CLI" apply \
    --org "$org" --target shadow \
    --expected-state "$cur_state" --expected-version "$cur_version" \
    --plan-digest "$digest" \
    --confirm I_UNDERSTAND_THIS_TRANSITIONS_A_SYNTHETIC_ORG_ONLY \
    --manifest "${CONTAINER_RUNNER_DIR}/w4-manifest-${org8}.json" \
    --actor-id "w4w7-soak-seed-${RUN_STAMP}" --correlation-id "$corr" \
    --engine-version "w4w7-soak-seed-v1" \
    > "${OUTPUT_DIR}/w4-apply-${org8}.json" 2> "${OUTPUT_DIR}/w4-apply-${org8}.stderr" < /dev/null || apply_rc=$?
  if [[ "$apply_rc" != "0" ]]; then
    cat "${OUTPUT_DIR}/w4-apply-${org8}.stderr" >&2 || true
    fail "W4C-5 apply failed for org ${org8} (rc=${apply_rc}; boundary refusal code above, JSON in artifact)"
  fi
  state="$(soak_psql_ta "SELECT state FROM attendance_calculation_rollout_state WHERE org_id = '${org}';")"
  [[ "$state" == "shadow" ]] || fail "post-apply verification failed: org ${org8} W4 rollout state is '${state}', expected 'shadow'"
  echo "w4_${org8}=transitioned_shadow correlation=${corr}" >> "${OUTPUT_DIR}/soak-seed-posture.txt"
  log "soak-seed: org ${org8} W4 rollout legacy->shadow applied via Gate C CLI (correlation ${corr})"
}

soak_w7_walk_org3() {
  # Walk org3's W7 context-source posture off->group_shadow through the REAL W7-3 CLI.
  # ONLY this rung: group_shadow->group_eligible and beyond carry compare-window exit
  # predicates (W7_CRITICAL_SHADOW_DIFF / W7_OFF_ROSTER_DIFF over a real compare window)
  # that can only be satisfied AFTER soak evidence accumulates — later owner acts, not
  # kickoff seeding. W7 plan prints {plan:{…}, planDigest} NESTED (unlike W4C-5's flat shape).
  local org="$SOAK_ORG3" org8="$SOAK_ORG3_SHORT"
  local state
  state="$(soak_psql_ta "SELECT COALESCE((SELECT state FROM attendance_calculation_context_source_state WHERE org_id = '${org}'), 'absent');")"
  case "$state" in
    group_shadow|group_eligible|group_authoritative)
      log "soak-seed: org ${org8} W7 posture already '${state}' — skipped (idempotent)"
      echo "w7_${org8}=already_${state}" >> "${OUTPUT_DIR}/soak-seed-posture.txt"
      return 0
      ;;
    suspended)
      fail "org ${org} W7 posture is 'suspended' — this seeder never resumes a suspended org (suspend/resume is the owner incident path, OD-W7-4(a))"
      ;;
    absent|off) ;;
    *)
      fail "org ${org} W7 posture state '${state}' unrecognized; refusing"
      ;;
  esac
  # W4 env is ALSO required by the W7 boundary's W4_POSTURE_COHERENT predicate
  # (resolveSegmentCalculationPosture is a row-plus-allowlist read; a non-allowlisted org
  # resolves to legacy/authorSegments='none' and the predicate fails).
  local seed_env_w4="${SOAK_W4_ENV_NAME}=${SOAK_ORG2},${SOAK_ORG3}"
  local seed_env_w7="${SOAK_W7_ENV_NAME}=${SOAK_ORG3}"
  local plan_file="${OUTPUT_DIR}/w7-plan-${org8}.json"
  local plan_rc=0
  staging_exec_env "$seed_env_w4" "$seed_env_w7" -- node "$SOAK_TSX" "$SOAK_W7_CLI" plan --org "$org" --target group_shadow \
    > "$plan_file" 2> "${OUTPUT_DIR}/w7-plan-${org8}.stderr" < /dev/null || plan_rc=$?
  [[ -s "$plan_file" ]] || fail "W7-3 plan produced no JSON for org ${org8} (rc=${plan_rc}; see w7-plan-${org8}.stderr in the artifact)"
  local blocked digest cur_state cur_version
  blocked="$(soak_json_get "$plan_file" plan.blocked)" || fail "W7-3 plan JSON unparseable for org ${org8}"
  [[ "$blocked" == "false" ]] || fail "W7-3 plan is BLOCKED for org ${org8} (predicate array captured verbatim in w7-plan-${org8}.json) — the soak cannot start over a failing W7 predicate"
  digest="$(soak_json_get "$plan_file" planDigest)"
  cur_state="$(soak_json_get "$plan_file" plan.currentState)"
  cur_version="$(soak_json_get "$plan_file" plan.currentVersion)"
  [[ "$cur_version" == "null" ]] && cur_version=1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "W7-3 planDigest unparseable for org ${org8}"
  local manifest_host="${OUTPUT_DIR}/w7-manifest-${org8}.json"
  # W7 manifest = base keys + groupProducerAttestationRef (group-arm entry pair); the
  # attestation ref names THIS run's seeding report, which just created/verified the
  # group-producer fixture rows the attestation is about.
  printf '{"schemaVersion":1,"collectedAt":"%s","orgId":"%s","targetState":"group_shadow","imageSha":"%s","pendingMigrations":0,"serviceHealthy":true,"customerData":false,"externalNotificationsDisabled":true,"externalDestinationCount":0,"ownerAuthorizationRef":"%s","syntheticOrgRef":"synthetic-staging-org-%s","groupProducerAttestationRef":"soak-seed-report-%s-%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$org" "$SOAK_IMAGE_SHA" "$SOAK_OWNER_REF" "$org8" "$RUN_STAMP" "$org8" > "$manifest_host"
  docker cp "$manifest_host" "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/w7-manifest-${org8}.json"
  local corr apply_rc=0
  corr="$(soak_uuid)"
  staging_exec_env "$seed_env_w4" "$seed_env_w7" -- node "$SOAK_TSX" "$SOAK_W7_CLI" apply \
    --org "$org" --target group_shadow \
    --expected-state "$cur_state" --expected-version "$cur_version" \
    --plan-digest "$digest" \
    --confirm I_UNDERSTAND_THIS_TRANSITIONS_A_SYNTHETIC_ORG_CONTEXT_SOURCE_ONLY \
    --manifest "${CONTAINER_RUNNER_DIR}/w7-manifest-${org8}.json" \
    --actor-id "w4w7-soak-seed-${RUN_STAMP}" --correlation-id "$corr" \
    --engine-version "w4w7-soak-seed-v1" \
    > "${OUTPUT_DIR}/w7-apply-${org8}.json" 2> "${OUTPUT_DIR}/w7-apply-${org8}.stderr" < /dev/null || apply_rc=$?
  if [[ "$apply_rc" != "0" ]]; then
    cat "${OUTPUT_DIR}/w7-apply-${org8}.stderr" >&2 || true
    fail "W7-3 apply failed for org ${org8} (rc=${apply_rc}; boundary refusal code above, JSON in artifact)"
  fi
  state="$(soak_psql_ta "SELECT state FROM attendance_calculation_context_source_state WHERE org_id = '${org}';")"
  [[ "$state" == "group_shadow" ]] || fail "post-apply verification failed: org ${org8} W7 posture is '${state}', expected 'group_shadow'"
  echo "w7_${org8}=transitioned_group_shadow correlation=${corr}" >> "${OUTPUT_DIR}/soak-seed-posture.txt"
  log "soak-seed: org ${org8} W7 posture off->group_shadow applied via W7-3 CLI (correlation ${corr})"
}

soak_mint_password() {
  # Single shared generator for BOTH the first-mint path (action_soak_seed, below) and
  # rotate_password=true (soak_seed_rotate_password, below): 24 random bytes, hex-encoded
  # (48 chars), from /dev/urandom.
  local pw
  pw="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [[ "${#pw}" -eq 48 ]] || fail "password minting failed"
  printf '%s' "$pw"
}

soak_hash_password_in_backend() {
  # soak_hash_password_in_backend <password> — bcrypt the password IN-CONTAINER, reading it
  # on STDIN (never `-e`/argv): a `docker exec -e` env or an argv value would sit in the
  # host process table and the docker daemon's exec config for the call's duration. Stdin
  # does not. Shared by the first-mint path (below) and rotate_password=true.
  local pw="$1" hash
  hash="$(printf '%s' "$pw" | docker exec -i "$BACKEND_CONTAINER" node -e 'const b = require("bcryptjs"); let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c }); process.stdin.on("end", () => { b.hash(d, 10).then((h) => console.log(h)).catch((e) => { console.error(e && e.message); process.exit(1) }) })')"
  [[ "$hash" == '$2'* ]] || fail "bcrypt hash minting failed in the backend container"
  printf '%s' "$hash"
}

soak_seed_rotate_password() {
  # Standalone act (#4556 soak-seed soak_opts rotate_password=true): rotates ONLY the
  # host-only synthetic-user password and its DB hash for the EXISTING closed synthetic
  # family (username LIKE '${SOAK_USER_PREFIX}%'). Never inserts, never walks posture,
  # never touches shift/group/schedule config, never remints a retired family.
  # action_soak_seed dispatches here BEFORE soak_require_orgs is ever called, so soak_orgs
  # is unused by this act (it stays a REQUIRED workflow input for action=soak-seed
  # regardless — this act just never reads it).
  #
  # owner_ref / entrypoint_inventory_ref asymmetry (deliberate, NOT a bug): unlike
  # users_per_org/tz/w7_target — which action_soak_seed REFUSES when present alongside
  # rotate_password=true, because they would otherwise silently take no effect and mislead
  # the operator — owner_ref/entrypoint_inventory_ref are pure attestation REFERENCES with
  # no behavioural effect of their own anywhere in this act (they only gate the transition
  # manifests on the non-rotate path, which this act never reaches). There is nothing for
  # them to silently "not take effect" — so they are allowed to ride along unused rather
  # than refused. This was the original design-lock's explicit choice, not an oversight.
  #
  # .prev is a SINGLE generation (see the atomic-replace block below): two consecutive
  # FAILED rotations can lose the recoverable password (documented rather than solved with
  # a second generation, because the far more common failure mode — matching zero family
  # rows — is handled below by auto-restoring .prev itself, which removes the repeat-
  # failure trigger in practice).
  [[ -f "$SOAK_CREDENTIALS_FILE" ]] \
    || fail "rotate_password=true but no credentials file exists at ${SOAK_CREDENTIALS_FILE} — nothing to rotate (run action=soak-seed once, without rotate_password, first)"
  soak_resolve_pg

  local new_password new_hash
  new_password="$(soak_mint_password)"
  new_hash="$(soak_hash_password_in_backend "$new_password")"

  # --- atomic credentials-file replace (tmp+mv, same dir; previous copy kept as .prev,
  # 0600 from birth via the SAME umask idiom the first-mint path uses, so a rotation that
  # fails partway is recoverable: mv the .prev copy back onto SOAK_CREDENTIALS_FILE to
  # restore the host file to match the DB's still-unrotated hash) ------------------------
  local cred_tmp
  cred_tmp="$(mktemp "${SOAK_PERSIST_DIR}/.credentials.XXXXXX")"
  chmod 0600 "$cred_tmp"
  printf 'SOAK_SYNTH_PASSWORD=%s\n' "$new_password" > "$cred_tmp"
  ( umask 077 && cp "$SOAK_CREDENTIALS_FILE" "${SOAK_CREDENTIALS_FILE}.prev" ) \
    || { rm -f "$cred_tmp"; fail "failed to preserve the pre-rotation credentials file as ${SOAK_CREDENTIALS_FILE}.prev — refusing to rotate without a recovery copy"; }
  mv -f "$cred_tmp" "$SOAK_CREDENTIALS_FILE"
  log "soak-seed rotate_password: minted a new synthetic-user password into ${SOAK_CREDENTIALS_FILE} (host-only, 0600, atomic replace; previous copy kept at ${SOAK_CREDENTIALS_FILE}.prev for one-generation recovery)"

  # --- re-hash ONLY the existing synthetic family; no inserts, no posture walk, no
  # group/shift/schedule seeding, no remint of retired families. Blast-radius, inside the
  # SAME transaction, BEFORE COMMIT: (1) refuse a family bigger than a generous 999-row
  # sanity ceiling (defense-in-depth against a mis-composed prefix — NOT a derived bound:
  # the family accumulates across dispatches with no hard cap, so a tight ceiling would
  # false-alarm on a legitimate multi-triple family); (2) the UPDATE's own row count must
  # equal the family's pre-count (refuses on a concurrent write between the two); (3) the
  # UPDATE must not have left NOTHING un-matched (the degenerate "touched every row" case a
  # mis-composed -v user_prefix="%" would produce — the C9 static pin already forbids that
  # composition; this is a runtime backstop for anything else that could widen it). KNOWN
  # trade-off, verified against a real postgres, not assumed: a staging users table that
  # happens to contain ONLY synth-w4w7-* rows and nothing else would also refuse here (it
  # cannot be told apart from a mis-composed prefix from row counts alone) — acceptable per
  # the reviewed design (a cheap invariant, not a completeness guarantee; staging always
  # carries non-synthetic accounts in practice). NO `-e` on the psql invocation below
  # (echo-queries would print the interpolated bcrypt hash into this world-downloadable
  # OUTPUT_DIR artifact) — the result is read from an explicit RAISE NOTICE line instead of
  # psql's own command-tag text. -----------------------------------------------------------
  local rotate_sql="${OUTPUT_DIR}/soak-seed-rotate.sql"
  cat > "$rotate_sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
-- transaction-scoped: recovers RAISE NOTICE regardless of the server/session
-- client_min_messages default (round-2 gate #5063: a session running at warning
-- would otherwise silently drop the ROTATE_RESULT line below even though the
-- transaction committed, which breaks the F4 recovery rule this function
-- documents — 'markers absent' must reliably mean 'did not commit').
SET LOCAL client_min_messages = notice;
-- psql's `:'var'` client-side substitution does NOT reach inside a `DO $$ ... $$` body
-- (dollar-quoted strings are opaque to it — verified empirically against a real postgres:16,
-- not assumed: a naive `:'user_prefix'` reference inside the DO block below is a silent
-- syntax error psql would report, not a hash leak, but IS a shipped-broken rotation). Route
-- both values through a transaction-local GUC instead: `set_config(..., true)` scopes it to
-- THIS transaction only (reset at COMMIT/ROLLBACK), and `\gset` into a throwaway column name
-- suppresses psql's normal result-table PRINTOUT — `SELECT set_config(...)` bare would
-- otherwise echo the value (including the bcrypt hash) to this same OUTPUT_DIR-bound file,
-- recreating exactly the class of leak the missing `-e` flag (see below) fixes.
SELECT set_config('rotate.user_prefix', :'user_prefix', true) AS _discard \gset
SELECT set_config('rotate.pw_hash', :'pw_hash', true) AS _discard \gset
DO $$
DECLARE
  v_user_prefix text := current_setting('rotate.user_prefix');
  v_pw_hash text := current_setting('rotate.pw_hash');
  family_count integer;
  updated_count integer;
  untouched_count integer;
BEGIN
  SELECT count(*) INTO family_count FROM users WHERE username LIKE v_user_prefix;
  IF family_count > 999 THEN
    RAISE EXCEPTION 'rotate_password refuses: % users match username LIKE % - exceeds the 999 sanity ceiling (defense-in-depth, not the real family size)', family_count, v_user_prefix;
  END IF;

  UPDATE users SET password_hash = v_pw_hash WHERE username LIKE v_user_prefix;
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  IF updated_count <> family_count THEN
    RAISE EXCEPTION 'rotate_password blast-radius mismatch: UPDATE touched % row(s) but the pre-count was % for username LIKE % (possible concurrent write) - refusing', updated_count, family_count, v_user_prefix;
  END IF;

  SELECT count(*) INTO untouched_count FROM users WHERE username NOT LIKE v_user_prefix;
  IF updated_count > 0 AND untouched_count = 0 THEN
    RAISE EXCEPTION 'rotate_password blast-radius check failed: the UPDATE touched % row(s) and left NOTHING un-matched (0 rows are NOT LIKE %) - refusing what looks like a full-table rewrite', updated_count, v_user_prefix;
  END IF;

  RAISE NOTICE 'ROTATE_RESULT family_count=% updated_count=%', family_count, updated_count;
END $$;
COMMIT;
SQL
  docker exec -i "$POSTGRES_CONTAINER" psql -U "$SOAK_PG_USER" -d "$SOAK_PG_DB" \
    -v pw_hash="$new_hash" -v user_prefix="${SOAK_USER_PREFIX}%" \
    < "$rotate_sql" > "${OUTPUT_DIR}/soak-seed-rotate.txt" 2>&1 \
    || fail "rotate_password DB step returned a nonzero exit — this does NOT prove nothing committed (a transport/stream failure can occur AFTER a successful COMMIT): check soak-seed-rotate.txt for 'ROTATE_RESULT ...' followed by 'COMMIT' — if both are present the DB WAS rotated and ${SOAK_CREDENTIALS_FILE}.prev must NOT be restored (investigate instead); only restore ${SOAK_CREDENTIALS_FILE}.prev to ${SOAK_CREDENTIALS_FILE} if they are absent. ${SOAK_CREDENTIALS_FILE}.prev is retained either way for that decision; see soak-seed-rotate.txt"

  local notice_line rotated_users
  notice_line="$(grep -E 'ROTATE_RESULT family_count=[0-9]+ updated_count=[0-9]+' "${OUTPUT_DIR}/soak-seed-rotate.txt" | tail -n1)"
  if [[ "$notice_line" =~ $SOAK_ROTATE_NOTICE_RE ]]; then
    rotated_users="${BASH_REMATCH[2]}"
  else
    fail "could not read the rotation result from soak-seed-rotate.txt (psql/PL/pgSQL output shape changed?)"
  fi

  # A rotation matching ZERO family rows must never report result=ok: the credentials file
  # would hold a password matching nothing (and the DB genuinely was NOT touched — an
  # UPDATE matching 0 rows changes nothing), so auto-restore .prev (nothing was committed
  # for this specific failure mode, so restoring is always safe here) rather than leaving
  # host state that silently breaks the next action=soak-run.
  (( rotated_users > 0 )) \
    || { mv -f "${SOAK_CREDENTIALS_FILE}.prev" "$SOAK_CREDENTIALS_FILE" \
           || fail "rotate_password matched 0 users for username LIKE '${SOAK_USER_PREFIX}%', AND restoring ${SOAK_CREDENTIALS_FILE}.prev also failed — the credentials file may now hold a password matching nothing; restore it by hand from ${SOAK_CREDENTIALS_FILE}.prev"; \
         fail "rotate_password matched 0 users for username LIKE '${SOAK_USER_PREFIX}%' — the synthetic family does not exist in this DB (nothing was rotated in the DB); restored the pre-rotation credentials file from ${SOAK_CREDENTIALS_FILE}.prev, so ${SOAK_CREDENTIALS_FILE} is unchanged from before this run"; }

  snapshot_staging_ps
  {
    echo "action=soak-seed"
    echo "rotated=1"
    echo "rotated_users=${rotated_users}"
    echo "result=ok"
  } > "${OUTPUT_DIR}/summary.txt"
  log "soak-seed rotate_password OK: ${rotated_users} existing synthetic family user(s) re-hashed (no inserts, no posture walk, no group/shift seeding); password never printed"
}

action_soak_seed() {
  soak_validate_opts
  local rotate_password
  rotate_password="$(soak_opt rotate_password '')"
  if [[ -n "$rotate_password" && "$rotate_password" != "true" ]]; then
    fail "soak_opts rotate_password only accepts 'true' (or omit the key entirely), got '${rotate_password}'"
  fi
  if [[ "$rotate_password" == "true" ]]; then
    # Standalone act: refuse if any full-seed-only opt is ALSO supplied — a rotation
    # dispatch that also carried users_per_org/tz/w7_target would otherwise silently
    # ignore them (this branch never reaches the code that reads them), misleading the
    # operator into thinking they took effect. soak_opt_present checks PRESENCE, not the
    # resolved value, because w7_target in particular always resolves via its default.
    local -a rotate_conflicts=()
    soak_opt_present users_per_org && rotate_conflicts+=(users_per_org)
    soak_opt_present tz && rotate_conflicts+=(tz)
    soak_opt_present w7_target && rotate_conflicts+=(w7_target)
    [[ "${#rotate_conflicts[@]}" -eq 0 ]] \
      || fail "soak_opts rotate_password=true is a standalone act and refuses users_per_org/tz/w7_target in the same invocation (got: $(IFS=,; echo "${rotate_conflicts[*]}")) — rotate the password alone, or run a normal (non-rotating) soak-seed"
    soak_seed_rotate_password
    return 0
  fi
  soak_require_orgs
  mkdir -p "$SOAK_PERSIST_DIR"
  local users_per_org tz_opt w7_target
  users_per_org="$(soak_opt users_per_org 10)"
  [[ "$users_per_org" =~ ^[1-9][0-9]?$ ]] || fail "users_per_org must be 1..99, got '${users_per_org}'"
  tz_opt="$(soak_opt tz Asia/Shanghai)"
  w7_target="$(soak_opt w7_target group_shadow)"
  if [[ "$w7_target" != "group_shadow" ]]; then
    fail "w7_target='${w7_target}' is not runnable by this kickoff seeder: the only rung reachable at soak start is off->group_shadow (bootstrap). group_shadow->group_eligible and beyond carry compare-window exit predicates that need REAL accumulated soak evidence, and are separate owner-run CLI acts, not seeding"
  fi
  SOAK_OWNER_REF="$(soak_opt owner_ref '')"
  [[ -n "$SOAK_OWNER_REF" ]] || fail "owner_ref is required for action=soak-seed (soak_opts owner_ref=<ref>): the transition manifests' ownerAuthorizationRef must name the owner's own authorization artifact — this runner never fabricates one (authorization source must be owner-authored)"
  [[ "$SOAK_OWNER_REF" =~ $SOAK_REF_RE ]] || fail "owner_ref does not match the manifest reference pattern [A-Za-z0-9][A-Za-z0-9._:-]{0,127}: '${SOAK_OWNER_REF}'"
  # entrypointInventoryRef (W4 manifest) is an operator ATTESTATION the boundary only
  # pattern-checks — it cannot be fabricated as a constant here for the same reason
  # ownerAuthorizationRef cannot (a runner-invented attestation is exactly the class the
  # 820f5d354c retraction forbade). Required from the operator, same REF_PATTERN, never
  # defaulted. The W7 manifest deliberately does NOT carry this key (verified asymmetry).
  SOAK_ENTRYPOINT_INVENTORY_REF="$(soak_opt entrypoint_inventory_ref '')"
  [[ -n "$SOAK_ENTRYPOINT_INVENTORY_REF" ]] || fail "entrypoint_inventory_ref is required for action=soak-seed (soak_opts entrypoint_inventory_ref=<ref>): the W4 transition manifest's entrypointInventoryRef is an operator attestation this runner will not fabricate (W4 lock §12.8 entry 4 names the entrypoint set; the operator asserts they collected it)"
  [[ "$SOAK_ENTRYPOINT_INVENTORY_REF" =~ $SOAK_REF_RE ]] || fail "entrypoint_inventory_ref does not match the manifest reference pattern [A-Za-z0-9][A-Za-z0-9._:-]{0,127}: '${SOAK_ENTRYPOINT_INVENTORY_REF}'"
  # Per-org timezones: one value for all three, or exactly three '|'-separated.
  local tz1 tz2 tz3 tz_extra
  if [[ "$tz_opt" == *'|'* ]]; then
    IFS='|' read -r tz1 tz2 tz3 tz_extra <<< "${tz_opt}|"
    [[ -n "$tz1" && -n "$tz2" && -n "$tz3" && -z "$tz_extra" ]] \
      || fail "tz must be one IANA name or exactly three '|'-separated names, got '${tz_opt}'"
  else
    tz1="$tz_opt"; tz2="$tz_opt"; tz3="$tz_opt"
  fi
  soak_resolve_pg
  local tz
  for tz in "$tz1" "$tz2" "$tz3"; do
    [[ "$(soak_psql_ta "SELECT count(*) FROM pg_timezone_names WHERE name = '${tz}';")" == "1" ]] \
      || fail "timezone '${tz}' is not a known IANA name on the staging postgres (pg_timezone_names) — a typo here would silently mis-attribute every work date"
  done
  soak_psql_ta "SELECT gen_random_uuid();" >/dev/null \
    || fail "gen_random_uuid() unavailable on the staging DB (pgcrypto missing?) — refusing to seed"

  # --- SYNTHETIC-ORG verification: verify BEFORE attesting customerData=false ----------
  # customerData:false / syntheticOrgRef are operator attestations the W4C-5 boundary
  # cannot verify; whoever automates the CLI becomes the attester. So verify it here rather
  # than assert it: refuse any org that holds NON-synthetic content. A real staging org
  # (typo / copy-paste / demo-org reuse) would otherwise be seeded, walked legacy->shadow
  # through the sanctioned writer on a fabricated customerData:false, exactly what that
  # predicate exists to stop. Scoped to NON-synth rows so an idempotent re-seed (whose own
  # prior synth rows are present) still passes; a foreign user/attendance/posture row fails.
  local org nonsynth_users nonsynth_records foreign_w4 foreign_w7
  for org in "$SOAK_ORG1" "$SOAK_ORG2" "$SOAK_ORG3"; do
    # Family membership = users.username prefix (ids are minted UUIDs and carry no marker).
    # A row whose user_id resolves to NO users row at all also counts as non-synthetic —
    # strictly fail-closed relative to the retired user_id-prefix predicate. The retired
    # TEXT-id family still passes here pre-remint because those rows' usernames carry the
    # same prefix (their user_id IS their username's value, and the users row still exists).
    nonsynth_users="$(soak_psql_ta "SELECT count(*) FROM user_orgs uo WHERE uo.org_id = '${org}' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = uo.user_id AND u.username LIKE '${SOAK_USER_PREFIX}%');")"
    [[ "$nonsynth_users" == "0" ]] \
      || fail "org ${org:0:8} has ${nonsynth_users} non-synthetic user_orgs member(s) — refusing to attest customerData=false / syntheticOrgRef for an org that is not exclusively synthetic (a real org must never be walked to shadow on a fabricated attestation)"
    nonsynth_records="$(soak_psql_ta "SELECT count(*) FROM attendance_records r WHERE r.org_id = '${org}' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id AND u.username LIKE '${SOAK_USER_PREFIX}%');")"
    [[ "$nonsynth_records" == "0" ]] \
      || fail "org ${org:0:8} has ${nonsynth_records} attendance_records for non-synthetic users — refusing (org is not exclusively synthetic)"
    # A posture row written by anything other than this soak's own seed actor family is a
    # foreign row: refuse rather than idempotently 'skip' a real org already mid-rollout.
    foreign_w4="$(soak_psql_ta "SELECT count(*) FROM attendance_calculation_rollout_state WHERE org_id = '${org}' AND state <> 'legacy' AND (actor_id IS NULL OR actor_id NOT LIKE 'w4w7-soak-seed-%');")"
    [[ "$foreign_w4" == "0" ]] \
      || fail "org ${org:0:8} has a W4 rollout row not written by this soak's seed actor — refusing (foreign posture history; not a virgin/synthetic org)"
    foreign_w7="$(soak_psql_ta "SELECT count(*) FROM attendance_calculation_context_source_state WHERE org_id = '${org}' AND state <> 'off' AND (actor_id IS NULL OR actor_id NOT LIKE 'w4w7-soak-seed-%');")"
    [[ "$foreign_w7" == "0" ]] \
      || fail "org ${org:0:8} has a W7 context-source row not written by this soak's seed actor — refusing (foreign posture history)"
    echo "org_${org:0:8}_synthetic_verified=nonsynth_users:${nonsynth_users},nonsynth_records:${nonsynth_records},foreign_w4:${foreign_w4},foreign_w7:${foreign_w7}" >> "${OUTPUT_DIR}/soak-seed-synthetic-check.txt"
  done

  # --- manifest-attestation preflight: verify BEFORE attesting -------------------------
  prepare_container_runner
  staging_exec node "$MIGRATE_JS" --list < /dev/null > "${OUTPUT_DIR}/seed-migrate-list.txt" 2>&1
  grep -q '^Pending: 0$' "${OUTPUT_DIR}/seed-migrate-list.txt" \
    || fail "staging has pending migrations — the transition manifests attest pendingMigrations=0 and this runner will not attest what it has not verified (run action=migrate first)"
  curl -fsS --max-time 10 "$STAGING_WEB_HEALTH_URL" | grep -q '"ok":true' \
    || fail "staging /api/health is not ok — the transition manifests attest serviceHealthy=true"
  local worker_env
  worker_env="$(soak_backend_env ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED)"
  [[ "$worker_env" != "true" ]] \
    || fail "ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED=true on the staging backend — refusing to attest externalNotificationsDisabled=true in the transition manifests"
  soak_require_backend_clis
  SOAK_IMAGE_SHA="$(soak_backend_image_sha)"

  # --- host-only synthetic credentials (0600; reused across re-seeds; NEVER uploaded) ---
  local password
  if [[ -f "$SOAK_CREDENTIALS_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$SOAK_CREDENTIALS_FILE"
    password="${SOAK_SYNTH_PASSWORD:-}"
    [[ -n "$password" ]] || fail "credentials file exists but carries no SOAK_SYNTH_PASSWORD: ${SOAK_CREDENTIALS_FILE}"
    log "soak-seed: reusing the existing synthetic-user password from ${SOAK_CREDENTIALS_FILE}"
  else
    password="$(soak_mint_password)"
    ( umask 077 && printf 'SOAK_SYNTH_PASSWORD=%s\n' "$password" > "$SOAK_CREDENTIALS_FILE" )
    log "soak-seed: minted a new synthetic-user password into ${SOAK_CREDENTIALS_FILE} (host-only, 0600, never uploaded)"
  fi
  local pw_hash
  pw_hash="$(soak_hash_password_in_backend "$password")"

  # --- one-time remint of the RETIRED TEXT-id family (identity-gate defect, 2026-08-16) --
  # The first soak seed minted users whose IDS carried the family marker
  # (synth-w4w7-<org8>-u<NN>). The W4C0 §4.1 canonical identity gate fail-closes non-UUID
  # user ids at the live shadow boundary, so every such user 500s the moment its org enters
  # W4 shadow (staging run 31957449480, W4C0_USER_ID_INVALID on all org2 attempts). Ids are
  # minted UUIDs now with the marker on username/email; this block deletes retired-shape
  # rows so the username-keyed reseed below can re-mint the same closed family. Scope is
  # provably the retired shape ONLY: current-family ids are UUIDs and can never match the
  # family prefix. Dependency order, one transaction; a fresh host is a no-op.
  # attendance_events rows keyed to retired ids are DELIBERATELY left in place: no FK or
  # unique index binds them, no soak/preflight/P95 query reads events by user_id, and
  # deleting them would add another census-tracked business-table writer for zero
  # behavioural benefit (#4931 gate, disclosed inert orphans).
  local retired retired_calc
  retired="$(soak_psql_ta "SELECT count(*) FROM users WHERE id LIKE '${SOAK_USER_PREFIX}%';")"
  if [[ "$retired" != "0" ]]; then
    # attendance_record_calculations is a w4_canonical-bucket table (census boundary: only
    # the canonical adapter path may write it), so this remint never deletes from it.
    # Provably empty for the retired family — org1 stayed in W4 'legacy' rollout state (no
    # calc artifacts) and every org2/org3 punch 500-rolled-back — but verify, don't assume:
    retired_calc="$(soak_psql_ta "SELECT count(*) FROM attendance_record_calculations c JOIN attendance_records r ON c.attendance_record_id = r.id WHERE r.user_id LIKE '${SOAK_USER_PREFIX}%';")"
    [[ "$retired_calc" == "0" ]] \
      || fail "retired-family attendance_records carry ${retired_calc} attendance_record_calculations row(s) — refusing to remint (that table is canonical-writer-only; clean-up of calc artifacts is an owner/ops act through the canonical path)"
    log "soak-seed: reminting ${retired} retired TEXT-id synthetic user(s) (family marker moves to username; ids become UUIDs)"
    local remint_sql="${OUTPUT_DIR}/soak-seed-remint.sql"
    cat > "$remint_sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM attendance_records WHERE user_id LIKE :'retired_prefix';
DELETE FROM attendance_calculation_group_memberships WHERE user_id LIKE :'retired_prefix';
DELETE FROM attendance_shift_assignments WHERE user_id LIKE :'retired_prefix';
DELETE FROM attendance_group_members WHERE user_id LIKE :'retired_prefix';
DELETE FROM user_permissions WHERE user_id LIKE :'retired_prefix';
DELETE FROM user_orgs WHERE user_id LIKE :'retired_prefix';
DELETE FROM users WHERE id LIKE :'retired_prefix';
COMMIT;
SQL
    docker exec -i "$POSTGRES_CONTAINER" psql -U "$SOAK_PG_USER" -d "$SOAK_PG_DB" -e \
      -v retired_prefix="${SOAK_USER_PREFIX}%" \
      < "$remint_sql" > "${OUTPUT_DIR}/soak-seed-remint.txt" 2>&1 \
      || fail "retired TEXT-id family remint failed (transactional — nothing deleted); see soak-seed-remint.txt"
    log "soak-seed: retired-family remint complete (per-table DELETE counts in soak-seed-remint.txt)"
  fi

  # --- idempotent data seeding, one transaction per org --------------------------------
  local seed_sql="${OUTPUT_DIR}/soak-seed-org.sql"
  soak_seed_write_org_sql "$seed_sql"
  : > "${OUTPUT_DIR}/soak-seed-report.txt"
  : > "${OUTPUT_DIR}/soak-seed-posture.txt"
  local org tzv prefix
  local -a orgs=("$SOAK_ORG1" "$SOAK_ORG2" "$SOAK_ORG3") tzs=("$tz1" "$tz2" "$tz3")
  local i
  for i in 0 1 2; do
    org="${orgs[$i]}"; tzv="${tzs[$i]}"; prefix="${SOAK_USER_PREFIX}${org:0:8}-u"
    log "soak-seed: seeding org ${org:0:8} (tz=${tzv}, users=${users_per_org})"
    docker exec -i "$POSTGRES_CONTAINER" psql -U "$SOAK_PG_USER" -d "$SOAK_PG_DB" -q \
      -v org="$org" -v tz="$tzv" -v user_prefix="$prefix" -v user_count="$users_per_org" \
      -v pw_hash="$pw_hash" \
      -v shift_name="w4w7-soak full-day ${org:0:8}" -v group_name="w4w7-soak group ${org:0:8}" \
      -v start_date="$SOAK_SEED_START_DATE" -v end_date="$SOAK_SEED_END_DATE" \
      < "$seed_sql" \
      || fail "seeding SQL failed for org ${org:0:8} (transactional — org left unchanged)"
    soak_seed_report_org "$org" "$prefix"
  done

  # --- posture walks through the REAL CLIs only ----------------------------------------
  # org1 stays legacy/off by DESIGN (three-posture C3 row a) — no posture act at all.
  soak_w4_walk_to_shadow "$SOAK_ORG2"
  soak_w4_walk_to_shadow "$SOAK_ORG3"
  soak_w7_walk_org3

  # --- serving-env non-mutation record --------------------------------------------------
  # The CLI walks above ran under exec-scoped -e allowlists; record the SERVING backend's
  # configured values afterwards so the artifact records that seeding flipped nothing.
  {
    echo "serving_w4_env=$(soak_backend_env "$SOAK_W4_ENV_NAME")"
    echo "serving_w7_env=$(soak_backend_env "$SOAK_W7_ENV_NAME")"
    echo "# empty values above = seeding left the serving allowlists untouched (flags flip only in action=soak-flags)"
  } >> "${OUTPUT_DIR}/soak-seed-posture.txt"

  # --- host soak config for action=soak-run (tokens deliberately ABSENT) ----------------
  # `userIds` entries are the closed family USERNAMES — soak-run feeds each one to POST
  # /api/auth/login as `identifier` (resolved by username) and the returned token carries
  # the user's minted UUID id. They are generator-local login/attribution keys, not DB ids.
  python3 - "$SOAK_HOST_CONFIG_FILE" "$SOAK_ORG1" "$SOAK_ORG2" "$SOAK_ORG3" "$users_per_org" "$SOAK_USER_PREFIX" "$tz1" "$tz2" "$tz3" <<'PY'
import json, os, sys
path, org1, org2, org3, count, prefix, tz1, tz2, tz3 = sys.argv[1:10]
count = int(count)
postures = ["legacy_only", "w4_only_legacy_arm", "both_machines_group_arm"]
entries = []
for org, posture, tz in zip([org1, org2, org3], postures, [tz1, tz2, tz3]):
    user_prefix = f"{prefix}{org[:8]}-u"
    entries.append({
        "orgId": org,
        "posture": posture,
        "minCleanPunches": 20,
        "userIds": [f"{user_prefix}{i:02d}" for i in range(1, count + 1)],
        "tokenOrCreds": {},
        # gate round-2 P2-1: the 2/day cap must count against the ORG'S calendar day, not
        # the generator's UTC default. Bookkeeping-only; never sent in a punch body.
        "dailyCapTimezone": tz,
    })
cfg = {
    "baseUrl": "http://127.0.0.1:8900",
    "sourceTag": "synthetic_w4w7_soak_accelerator_v1",
    "entries": entries,
}
fd = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_CREAT, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, indent=2)
print(f"[soak-seed] host soak config written: {path}")
PY
  cp "$SOAK_HOST_CONFIG_FILE" "${OUTPUT_DIR}/soak-config.json"

  snapshot_staging_ps
  {
    echo "action=soak-seed"
    echo "orgs=${SOAK_ORGS}"
    echo "users_per_org=${users_per_org}"
    echo "timezones=${tz1}|${tz2}|${tz3}"
    echo "w7_target=${w7_target}"
    echo "image_sha=${SOAK_IMAGE_SHA}"
    echo "result=ok"
  } > "${OUTPUT_DIR}/summary.txt"
  log "soak-seed OK: three orgs seeded idempotently; posture via Gate C / W7-3 CLIs only (see soak-seed-posture.txt)"
}

action_soak_flags() {
  soak_validate_opts
  soak_require_orgs
  require_sha
  require_compose_v2
  # ORDER ENFORCEMENT (second half of the baseline<->flags gate): the marker only exists
  # once action=soak-baseline captured a PRE-enablement p95 baseline.
  [[ -f "$SOAK_BASELINE_MARKER" ]] \
    || fail "refusing to set soak flags: baseline marker absent (${SOAK_BASELINE_MARKER}) — run action=soak-baseline first (baseline BEFORE flags; O4-2 needs a pre-enablement anchor)"
  # SHA-SCOPE the marker: a marker captured on a DIFFERENT build than the one the flags go
  # live on anchors every later O4-2 "+5% vs baseline" comparison to the wrong image (runbook
  # §2A.5 requires the baseline at "the same deployed image SHA"). This bites on the PR's own
  # documented mid-soak redeploy path (baseline@A, deploy->B, re-run soak-flags@B). Refuse it;
  # the operator must re-run soak-baseline against the redeployed SHA.
  local marker_sha
  marker_sha="$(sed -n 's/^staging_build_commit=//p' "$SOAK_BASELINE_MARKER")"
  [[ "$marker_sha" == "$DEPLOY_SHA" ]] \
    || fail "baseline marker was captured at build ${marker_sha:-<unreadable>}, but flags are being set on ${DEPLOY_SHA} — re-run action=soak-baseline against the deployed SHA (O4-2 must anchor on the same build)"
  # Never silently drop (or silently carry) rd-window flags: env flips for those happen
  # only together with a deploy (bundle §3.4), and this action rewrites the same file.
  if [[ -f "$OVERRIDE_FILE" ]] && grep -qE 'ATTENDANCE_SCHEDULER_ENABLED|ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED' "$OVERRIDE_FILE"; then
    fail "existing runner override carries rd-window env flags; refusing to rewrite them from a soak action — redeploy with set_window_env=none first"
  fi
  # This action changes ENV only, never images: deploy_sha must equal BOTH running images.
  local backend_image web_image
  backend_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER")"
  web_image="$(docker inspect -f '{{.Config.Image}}' "$WEB_CONTAINER")"
  [[ "$backend_image" == "ghcr.io/${IMAGE_OWNER}/metasheet2-backend:${DEPLOY_SHA}" ]] \
    || fail "deploy_sha must equal the RUNNING backend image tag (running: ${backend_image}) — soak-flags flips env only, never images; use action=deploy to change images"
  [[ "$web_image" == "ghcr.io/${IMAGE_OWNER}/metasheet2-web:${DEPLOY_SHA}" ]] \
    || fail "deploy_sha must equal the RUNNING web image tag (running: ${web_image})"

  local pg_id_before redis_id_before web_id_before
  pg_id_before="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER")"
  redis_id_before="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER")"
  web_id_before="$(docker inspect -f '{{.Id}}' "$WEB_CONTAINER")"

  mkdir -p "$RUNNER_PERSIST_DIR" "$SOAK_PERSIST_DIR"
  # Same atomic mechanism as action_deploy's override write: mktemp candidate in the
  # persist dir -> `docker compose config` pair validation -> same-directory rename.
  local soak_override_tmp
  soak_override_tmp="$(mktemp "${RUNNER_PERSIST_DIR}/.soak-override.XXXXXX")"
  {
    echo "# Written by attendance-staging-window-runner action=soak-flags (run ${RUN_STAMP})."
    echo "# W4+W7 combined-soak allowlists (#4556): exact orgs only, NO wildcard, lower-case"
    echo "# byte-for-byte (the resolvers trim but do not case-fold — runbook §0.3 item 3)."
    echo "# NOTE: a later action=deploy REWRITES this file without these flags — after any"
    echo "# mid-soak redeploy, re-run action=soak-flags before more soak load."
    echo "services:"
    echo "  backend:"
    echo "    image: ${backend_image}"
    echo "    environment:"
    echo "      ${SOAK_W4_ENV_NAME}: \"${SOAK_ORG1},${SOAK_ORG2},${SOAK_ORG3}\""
    echo "      ${SOAK_W7_ENV_NAME}: \"${SOAK_ORG3}\""
    echo "  web:"
    echo "    image: ${web_image}"
  } > "$soak_override_tmp"
  if ! (cd "$STAGING_DIR" && IMAGE_OWNER="$IMAGE_OWNER" IMAGE_TAG="$DEPLOY_SHA" \
    docker compose --project-directory "$STAGING_DIR" -f "$STAGING_COMPOSE_FILE" -f "$soak_override_tmp" config) >/dev/null 2>&1; then
    rm -f "$soak_override_tmp"
    fail "candidate soak override failed 'docker compose config' validation; kept previous override at ${OVERRIDE_FILE}"
  fi
  mv -f "$soak_override_tmp" "$OVERRIDE_FILE"
  hash_value "$OVERRIDE_FILE" > "${OUTPUT_DIR}/soak-override.sha256"
  log "soak override written (persistent, atomic): ${OVERRIDE_FILE}"

  # Recreate ONLY the backend (env change forces recreate). postgres/redis/web untouched,
  # asserted by container-id comparison below.
  compose_staging up -d --no-deps backend 2>&1 | tee "${OUTPUT_DIR}/soak-flags-compose-up.log"

  local pg_id_after redis_id_after web_id_after
  pg_id_after="$(docker inspect -f '{{.Id}}' "$POSTGRES_CONTAINER")"
  redis_id_after="$(docker inspect -f '{{.Id}}' "$REDIS_CONTAINER")"
  web_id_after="$(docker inspect -f '{{.Id}}' "$WEB_CONTAINER")"
  [[ "$pg_id_before" == "$pg_id_after" ]] || fail "staging postgres container was recreated — hard constraint violated"
  [[ "$redis_id_before" == "$redis_id_after" ]] || fail "staging redis container was recreated — hard constraint violated"
  [[ "$web_id_before" == "$web_id_after" ]] || fail "staging web container was recreated — soak-flags must touch ONLY the backend"
  log "postgres/redis/web untouched (container ids unchanged)"

  # Verify in the RUNNING container env, exact-match — then health.
  local live_w4 live_w7
  live_w4="$(soak_backend_env "$SOAK_W4_ENV_NAME")"
  live_w7="$(soak_backend_env "$SOAK_W7_ENV_NAME")"
  [[ "$live_w4" == "${SOAK_ORG1},${SOAK_ORG2},${SOAK_ORG3}" ]] \
    || fail "backend ${SOAK_W4_ENV_NAME}='${live_w4}' != expected '${SOAK_ORG1},${SOAK_ORG2},${SOAK_ORG3}'"
  [[ "$live_w7" == "${SOAK_ORG3}" ]] \
    || fail "backend ${SOAK_W7_ENV_NAME}='${live_w7}' != expected '${SOAK_ORG3}'"
  local i ok=0
  for ((i = 1; i <= 30; i += 1)); do
    if curl -sS --max-time 10 "$STAGING_WEB_HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
      ok=1
      break
    fi
    sleep 4
  done
  [[ "$ok" == "1" ]] || fail "staging web health did not return ok:true within 120s of the flags recreate"
  {
    echo "${SOAK_W4_ENV_NAME}=${live_w4}"
    echo "${SOAK_W7_ENV_NAME}=${live_w7}"
  } > "${OUTPUT_DIR}/soak-flags-env.txt"

  if [[ ! -f "$SOAK_WINDOW_START_FILE" ]]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$SOAK_WINDOW_START_FILE"
    log "soak window start recorded: $(cat "$SOAK_WINDOW_START_FILE")"
  else
    log "soak window start already recorded ($(cat "$SOAK_WINDOW_START_FILE")) — kept (idempotent re-run does not restart the clock)"
  fi
  snapshot_staging_ps
  {
    echo "action=soak-flags"
    echo "deploy_sha=${DEPLOY_SHA}"
    echo "orgs=${SOAK_ORGS}"
    echo "window_start=$(cat "$SOAK_WINDOW_START_FILE")"
    echo "result=ok"
  } > "${OUTPUT_DIR}/summary.txt"
  log "soak-flags OK: W4=${SOAK_ORG1_SHORT},${SOAK_ORG2_SHORT},${SOAK_ORG3_SHORT} W7=${SOAK_ORG3_SHORT} live on the backend"
}

# --- soak daily-batch guard + halt classification (testable units; #4932 follow-up) ------
# soak_batch_guard_entries <config_path> — prints "orgId<TAB>dailyCapTimezone" per entry;
# fails (non-zero) if any entry lacks either field (stale-config fail-closed, round-3
# P2-R3-1 contract).
soak_batch_guard_entries() {
  python3 -c '
import json, sys
cfg = json.load(open(sys.argv[1]))
for e in cfg["entries"]:
    try:
        org, tz = e["orgId"], e["dailyCapTimezone"]
    except KeyError:
        sys.stderr.write("entry missing orgId/dailyCapTimezone\n"); sys.exit(1)
    if not org or not tz:
        sys.stderr.write("entry missing orgId/dailyCapTimezone\n"); sys.exit(1)
    print(f"{org}\t{tz}")
' "$1"
}

# soak_batch_guard_check <config_path> <marker_path> <override(true|false)> — prints a
# refusal message and returns 1 if ANY config org already ran a batch on its OWN current
# local day (whole-batch refusal — Codex P1: per-org day boundaries diverge across the three
# supported org timezones). Malformed or legacy marker content refuses fail-closed. Returns
# 0 (silent) when the batch may proceed.
soak_batch_guard_check() {
  local config_path="$1" marker="$2" override="$3"
  local line org tz today rec_day entries
  entries="$(soak_batch_guard_entries "$config_path")" \
    || { echo "config at ${config_path} is missing orgId/dailyCapTimezone — it predates the org-day cap contract; re-run action=soak-seed first"; return 1; }
  # LEGACY MARKER MIGRATION (#4933 gate P2-3): the pre-per-org guard wrote ONE global day
  # to the singular path; silently ignoring it would re-open the same-day duplicate window
  # for a marker written by the previous code. Migrate CONSERVATIVELY — the legacy day is
  # attributed to EVERY org (it was derived from entries[0]'s timezone; over-refusing for up
  # to one day is the fail-closed direction, and it self-heals at each org's next local day).
  local legacy_marker="${marker%-days}-day"
  if [[ "$legacy_marker" != "$marker" && -f "$legacy_marker" && ! -f "$marker" ]]; then
    local legacy_day
    legacy_day="$(head -1 "$legacy_marker" | tr -d '[:space:]')"
    if [[ "$legacy_day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      local mig_tmp="${marker}.tmp.$$"
      : > "$mig_tmp"
      while IFS=$'\t' read -r org tz; do
        printf '%s=%s=%s\n' "$org" "$tz" "$legacy_day" >> "$mig_tmp"
      done <<< "$entries"
      mv -f "$mig_tmp" "$marker"
      rm -f "$legacy_marker"
      echo "migrated legacy single-day batch marker (${legacy_day}) to the per-org set — the legacy day counts for EVERY org (conservative fail-closed)" >&2
    else
      echo "legacy batch marker at ${legacy_marker} holds unrecognized content '${legacy_day}' — refusing fail-closed; inspect and remove it manually if a batch is genuinely due"
      return 1
    fi
  fi
  [[ -f "$marker" ]] || return 0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if ! [[ "$line" =~ ^[0-9a-fA-F-]+=[A-Za-z0-9_/+-]+=[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      echo "unrecognized batch-marker line '${line}' in ${marker} (legacy or corrupted format) — refusing fail-closed; inspect and remove the marker manually if a batch is genuinely due"
      return 1
    fi
  done < "$marker"
  # CLOSED-SET equality (Codex r2 P1): the marker's (orgId,timezone) set must equal the
  # config's, with no duplicates — a format-valid SUBSET (a half-written or tampered
  # marker, or one from a different config shape) would silently admit exactly the orgs
  # whose lines are missing. Refuse fail-closed; the explicit override admits, and the
  # fresh full-set stamp that follows self-heals the marker.
  local marker_set config_set
  marker_set="$(awk -F= '{print $1 "\t" $2}' "$marker" | sort)"
  if [[ "$override" != "true" ]]; then
    if [[ "$(printf '%s\n' "$marker_set" | sort -u | wc -l)" -ne "$(printf '%s\n' "$marker_set" | wc -l)" ]]; then
      echo "batch marker ${marker} carries duplicate org lines — refusing fail-closed (corrupted or tampered marker); pass soak_opts allow_same_day_rerun=true to override deliberately (the next stamp rewrites the full set)"
      return 1
    fi
    config_set="$(printf '%s\n' "$entries" | sort)"
    if [[ "$marker_set" != "$config_set" ]]; then
      echo "batch marker ${marker} does not carry EXACTLY the config's (orgId, timezone) set — a partial/stale/tampered marker would silently admit the missing orgs into a same-day second batch. Refusing fail-closed; pass soak_opts allow_same_day_rerun=true to override deliberately (the next stamp rewrites the full set)"
      return 1
    fi
  fi
  while IFS=$'\t' read -r org tz; do
    today="$(TZ="$tz" date +%Y-%m-%d)"
    rec_day="$(grep -m1 "^${org}=" "$marker" | awk -F= '{print $3}')"
    if [[ -n "$rec_day" && "$rec_day" == "$today" && "$override" != "true" ]]; then
      echo "org ${org:0:8} already ran (or started) a batch on its local day ${today} (${tz}) — a second same-day batch lands duplicate sessions on the same work date (§4.2-critical review_required); the WHOLE batch is refused. Wait for every org's next local day, or pass soak_opts allow_same_day_rerun=true for a deliberate retry (accepting that risk for already-punched users)"
      return 1
    fi
  done <<< "$entries"
  return 0
}

# soak_batch_guard_stamp <config_path> <marker_path> — records ONE line per org:
# "<orgId>=<tz>=<its-current-local-day>" (whole-file overwrite; only same-day lines matter).
soak_batch_guard_stamp() {
  local config_path="$1" marker="$2"
  local org tz tmp
  # ATOMIC (Codex r2 P1): write the full set to a temp file, then rename. A
  # truncate-then-append writer can leave a format-valid but org-missing marker if the job
  # dies mid-loop; rename makes partial states unobservable on any POSIX filesystem.
  tmp="${marker}.tmp.$$"
  : > "$tmp"
  while IFS=$'\t' read -r org tz; do
    printf '%s=%s=%s\n' "$org" "$tz" "$(TZ="$tz" date +%Y-%m-%d)" >> "$tmp"
  done < <(soak_batch_guard_entries "$config_path")
  mv -f "$tmp" "$marker"
}

# soak_run_classify <haltedReason> <total_clean> <total_attempts> <punch_target> — the ONE
# halt classifier (Codex P2: daily_capacity_exhausted with scattered incidents must never
# print ok — dailyCounts increments on EVERY attempt, so capacity exhaustion alone proves
# nothing about cleanliness). ok ONLY for a clean halt with zero incidents and the target
# reached; FAIL for the consecutive-incident halt; WARN for everything else, including
# non-numeric tallies (fail-closed).
soak_run_classify() {
  local halted="$1" clean="$2" attempts="$3" target="$4"
  if ! [[ "$clean" =~ ^[0-9]+$ && "$attempts" =~ ^[0-9]+$ && "$target" =~ ^[0-9]+$ ]]; then
    echo "WARN"
    return 0
  fi
  # Codex r2 P2: a contradictory tally (clean > attempts) makes the subtraction negative
  # and every branch below fail-open — an honest classifier WARNs on impossible inputs.
  if (( clean > attempts )); then
    echo "WARN"
    return 0
  fi
  local incidents=$(( attempts - clean ))
  case "$halted" in
    max_consecutive_incidents) echo "FAIL" ;;
    targets_met|daily_capacity_exhausted)
      if (( incidents > 0 )); then echo "WARN"
      elif (( clean < target )); then echo "WARN"
      else echo "ok"; fi
      ;;
    *) echo "WARN" ;;
  esac
}

action_soak_run() {
  soak_validate_opts
  local punch_target config_path
  # Default `auto` = this run's ONE-DAY BATCH: with the 2/user/day cap (one in/out pair per
  # user per wall-clock day — same-day session packing floods §4.2-critical review_required
  # diffs, soak-status 31962440160, and backdating is rejected by the route's global-latest
  # ordering, #4932 gate P1-1), a soak-run invocation is one daily batch. The runbook's
  # CUMULATIVE §2A.3 criteria (200 total / 20 per org / 50 per arm) are judged from
  # soak-status DB counts across days, never from one run's tally.
  punch_target="$(soak_opt punch_target auto)"
  [[ "$punch_target" == "auto" || "$punch_target" =~ ^[1-9][0-9]{0,3}$ ]] \
    || fail "punch_target must be 1..9999 or 'auto' (one-day batch), got '${punch_target}'"
  config_path="$(soak_opt config "$SOAK_HOST_CONFIG_FILE")"
  [[ -f "$config_path" ]] || fail "soak config not found at ${config_path} — action=soak-seed writes it (or pass soak_opts config=<host-path>)"
  # Order enforcement: the flags must be LIVE on the serving backend before load.
  local live_w4 live_w7
  live_w4="$(soak_backend_env "$SOAK_W4_ENV_NAME")"
  live_w7="$(soak_backend_env "$SOAK_W7_ENV_NAME")"
  [[ -n "$live_w4" && -n "$live_w7" ]] \
    || fail "refusing to drive load: allowlist env not live on the backend (${SOAK_W4_ENV_NAME}='${live_w4:-<unset>}' ${SOAK_W7_ENV_NAME}='${live_w7:-<unset>}') — run action=soak-flags first"
  [[ -f "$SOAK_CREDENTIALS_FILE" ]] \
    || fail "credentials file missing (${SOAK_CREDENTIALS_FILE}) — action=soak-seed writes it"
  # shellcheck disable=SC1090
  source "$SOAK_CREDENTIALS_FILE"
  [[ -n "${SOAK_SYNTH_PASSWORD:-}" ]] || fail "credentials file carries no SOAK_SYNTH_PASSWORD"

  # Fail-closed allowlist coverage: every config org must be in the live W4 allowlist and
  # every both-machines org in the live W7 allowlist — a mismatch would silently no-op.
  local orgs_csv both_csv org total_users day_capacity
  orgs_csv="$(python3 -c 'import json,sys; print(",".join(e["orgId"] for e in json.load(open(sys.argv[1]))["entries"]))' "$config_path")" \
    || fail "could not parse soak config ${config_path}"
  both_csv="$(python3 -c 'import json,sys; print(",".join(e["orgId"] for e in json.load(open(sys.argv[1]))["entries"] if e["posture"] == "both_machines_group_arm"))' "$config_path")"
  # DAY-CAPACITY (P3-2/P3-3, revised for the 2/user/day pair cadence): one soak-run
  # invocation is one daily batch — the most CLEAN punches it can produce is total_users * 2
  # (one in/out pair per user per wall-clock day). punch_target=auto resolves to exactly that
  # batch; an explicit target above it can never reach targets_met and would only idle to the
  # stall timeout. Well inside the 40-minute job at <=1 req/s + >=60s per-user spacing.
  total_users="$(python3 -c 'import json,sys; print(sum(len(e["userIds"]) for e in json.load(open(sys.argv[1]))["entries"]))' "$config_path")"
  [[ "$total_users" =~ ^[1-9][0-9]*$ ]] || fail "could not derive the synthetic user count from ${config_path}"
  day_capacity=$(( total_users * 2 ))
  # Past ~30x3 users the GLOBAL <=1 req/sec ceiling binds instead of the per-user spacing;
  # 1800 = 30 min of active load at 1/s, leaving job-window margin for logins/docker cp/scp.
  (( day_capacity > 1800 )) && day_capacity=1800
  [[ "$punch_target" == "auto" ]] && punch_target="$day_capacity"
  [[ "$punch_target" -le "$day_capacity" ]] \
    || fail "punch_target=${punch_target} exceeds this config's one-day clean-punch capacity (${total_users} users x 2/user/day = ${day_capacity}); the pair cadence makes cumulative criteria a multi-day affair — raise users_per_org at seed time or run daily batches"

  local IFS_SAVE="$IFS"
  IFS=','
  for org in $orgs_csv; do
    [[ ",${live_w4}," == *",${org},"* ]] \
      || fail "config org ${org} is NOT in the live W4 allowlist ('${live_w4}') — load against it would silently no-op; re-run soak-flags with matching orgs"
  done
  for org in $both_csv; do
    [[ ",${live_w7}," == *",${org},"* ]] \
      || fail "both-machines config org ${org} is NOT in the live W7 allowlist ('${live_w7}')"
  done
  IFS="$IFS_SAVE"

  # SAME-DAY RE-DISPATCH GUARD (gate round-2 P2-1; Codex post-merge review P1): the
  # generator's daily cap is per-process, so a second soak-run inside the same org-calendar
  # day would land a second pair on the SAME work date — the duplicate-session shape that
  # floods §4.2-critical review_required diffs. The seeder explicitly supports THREE
  # independent org timezones, so the marker is a PER-ORG closed set ({orgId}={tz}={localDay}
  # lines) and the batch is refused WHOLE if ANY org already ran on its own current local
  # day — a first-entry-only derivation would admit a second batch the moment org1 crossed
  # midnight while org2/org3 had not. Override only for a deliberate halt-retry with
  # soak_opts allow_same_day_rerun=true (documented critical-shape risk).
  mkdir -p "$SOAK_PERSIST_DIR"
  local batch_marker="${SOAK_PERSIST_DIR}/soak-run-last-batch-days"
  local guard_msg
  if ! guard_msg="$(soak_batch_guard_check "$config_path" "$batch_marker" "$(soak_opt allow_same_day_rerun false)")"; then
    fail "${guard_msg}"
  fi
  # Stamped BEFORE the generator runs: even a PARTIAL batch punched some users, so a bare
  # same-day retry would duplicate exactly those — burning each org's day on any attempt is
  # the fail-closed choice; the override above is the deliberate escape hatch.
  soak_batch_guard_stamp "$config_path" "$batch_marker"

  # Log every synthetic user in through the REAL login route; tokens go ONLY into a 0600
  # host temp config (deleted below) and are never echoed (per-user output is id + ok/fail).
  local run_config_host
  run_config_host="$(mktemp "${SOAK_PERSIST_DIR}/.soak-run-config.XXXXXX")"
  cleanup_soak_run() {
    rm -f "$run_config_host"
    staging_exec rm -f "${CONTAINER_RUNNER_DIR}/soak-run-config.json" >/dev/null 2>&1 || true
  }
  trap cleanup_soak_run EXIT
  local -a login_pipe_status
  set +e
  SOAK_SYNTH_PASSWORD="$SOAK_SYNTH_PASSWORD" python3 - "$config_path" "$run_config_host" <<'PY' 2>&1 | tee "${OUTPUT_DIR}/soak-run-login.log"
import json, os, sys, urllib.request
config_path, out_path = sys.argv[1], sys.argv[2]
cfg = json.load(open(config_path))
password = os.environ["SOAK_SYNTH_PASSWORD"]
base = "http://127.0.0.1:8082"
failures = 0
for entry in cfg["entries"]:
    creds = {}
    for user_id in entry["userIds"]:
        body = json.dumps({"identifier": user_id, "password": password}).encode()
        req = urllib.request.Request(
            base + "/api/auth/login", data=body,
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.load(resp)
            token = (data.get("data") or {}).get("token")
            if data.get("success") is True and token:
                creds[user_id] = token
                print(f"[soak-run] login ok: {user_id}")
            else:
                print(f"[soak-run] login FAILED (response shape): {user_id}")
                failures += 1
        except Exception as err:
            print(f"[soak-run] login FAILED: {user_id} ({getattr(err, 'code', type(err).__name__)})")
            failures += 1
    entry["tokenOrCreds"] = creds
fd = os.open(out_path, os.O_WRONLY | os.O_TRUNC | os.O_CREAT, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f)
sys.exit(1 if failures else 0)
PY
  login_pipe_status=("${PIPESTATUS[@]}")
  set -e
  [[ "${login_pipe_status[1]}" == "0" ]] || fail "tee failed writing soak-run-login.log (rc=${login_pipe_status[1]})"
  [[ "${login_pipe_status[0]}" == "0" ]] || fail "one or more synthetic-user logins failed (rc=${login_pipe_status[0]}; see soak-run-login.log) — tokens are obtained ONLY via the real login route, never minted"

  prepare_container_runner
  docker cp "${HERE}/${SOAK_GENERATOR_SCRIPT}" \
    "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/scripts/ops/${SOAK_GENERATOR_SCRIPT}"
  docker cp "$run_config_host" "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/soak-run-config.json"

  # The generator runs IN the backend container against the in-container BASE_URL, at the
  # ruled global ceiling of 1 req/sec and the ruled 8 punches/user/day quota. No
  # --duration-minutes: the run ends on targets_met or on its own bounded halts (attempts
  # safety cap / consecutive-incident threshold / 15-minute zero-attempt stall).
  local -a pipe_status
  set +e
  staging_exec node "${CONTAINER_RUNNER_DIR}/scripts/ops/${SOAK_GENERATOR_SCRIPT}" \
    --config "${CONTAINER_RUNNER_DIR}/soak-run-config.json" \
    --base-url "$IN_CONTAINER_BASE_URL" \
    --target-total "$punch_target" \
    --rate-limit-per-sec 1 \
    --punches-per-user-per-day 2 \
    --stall-timeout-minutes 15 \
    --tally-interval 10 \
    --output "${CONTAINER_RUNNER_DIR}/soak-run-summary.json" \
    --execute \
    --confirm I_UNDERSTAND_THIS_DRIVES_SYNTHETIC_STAGING_TRAFFIC_ONLY \
    --confirm-org-ids "$orgs_csv" \
    < /dev/null 2>&1 | tee "${OUTPUT_DIR}/soak-run.log"
  pipe_status=("${PIPESTATUS[@]}")
  set -e
  local gen_rc="${pipe_status[0]}"
  [[ "${pipe_status[1]}" == "0" ]] || fail "tee failed writing soak-run.log (rc=${pipe_status[1]})"
  docker cp "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/soak-run-summary.json" \
    "${OUTPUT_DIR}/soak-run-summary.json" 2>/dev/null || true
  # Filtered backend-log slice, ALWAYS captured (same filtered_pipe contract as
  # action_smoke): dispatch 31953571638 produced five INTERNAL_ERROR punch 500s on the
  # W4-shadow org with zero artifact-side server evidence — the HTTP body says only
  # "Failed to punch attendance", so without this slice a server-side punch failure is
  # undiagnosable from the run's own artifact.
  filtered_pipe "${OUTPUT_DIR}/soak-run-backend-log-slice.log" \
    'attendance|punch|calculation|shadow|segment|boundary|error|Error' \
    -- docker logs --since 30m "$BACKEND_CONTAINER"
  cleanup_soak_run
  trap - EXIT
  [[ "$gen_rc" == "0" ]] || fail "soak load generator exited rc=${gen_rc} (see soak-run.log)"

  local halted total_clean total_attempts
  halted="$(soak_json_get "${OUTPUT_DIR}/soak-run-summary.json" haltedReason)" \
    || fail "generator summary missing or unparseable (soak-run-summary.json)"
  total_clean="$(soak_json_get "${OUTPUT_DIR}/soak-run-summary.json" tally.totalClean)" || total_clean="unknown"
  total_attempts="$(soak_json_get "${OUTPUT_DIR}/soak-run-summary.json" tally.totalAttempts)" || total_attempts="unknown"
  {
    echo "action=soak-run"
    echo "punch_target=${punch_target}"
    echo "halted_reason=${halted}"
    echo "http_level_clean=${total_clean}"
    echo "attempts=${total_attempts}"
    echo "note=haltedReason is LOAD-BEARING: targets_met and daily_capacity_exhausted are clean outcomes ONLY with zero incidents and the target reached (Codex P2: capacity counts every ATTEMPT, so exhaustion alone proves nothing about cleanliness); the HTTP tally upper-bounds (never equals) the DB-level clean-punch count — soak-status Q1-Q4 are the authoritative counts"
    if [[ "$total_clean" =~ ^[0-9]+$ && "$total_attempts" =~ ^[0-9]+$ ]]; then
      echo "incidents=$(( total_attempts - total_clean ))"
    else
      echo "incidents=unknown"
    fi
    # gate round-2 P2-3 + Codex P2: ONE classifier decides — ok only for a clean halt with
    # zero incidents and target reached; incidents-halt FAILs; everything else WARNs.
    echo "result=$(soak_run_classify "$halted" "$total_clean" "$total_attempts" "$punch_target")"
  } > "${OUTPUT_DIR}/summary.txt"
  if [[ "$halted" == "max_consecutive_incidents" ]]; then
    fail "generator halted on consecutive non-clean responses (haltedReason=max_consecutive_incidents) — alert-class outcome, see soak-run.log + soak-run-summary.json"
  fi
  local batch_result
  batch_result="$(soak_run_classify "$halted" "$total_clean" "$total_attempts" "$punch_target")"
  if [[ "$batch_result" != "ok" ]]; then
    log "soak-run ${batch_result}: haltedReason=${halted} clean=${total_clean}/${punch_target} — see summary.txt (a same-day retry needs soak_opts allow_same_day_rerun=true and accepts the duplicate-session risk for already-punched users)"
  fi
  log "soak-run done: haltedReason=${halted} http_clean=${total_clean}/${punch_target} (DB-level counts come from action=soak-status, never from this tally)"
}

soak_status_scalar() {
  # soak_status_scalar <label> <sql> — appends "label=value" to the status file and echoes
  # the value; a non-scalar/failed query is a hard failure (never silently 0).
  local label="$1" sql="$2" value
  value="$(soak_psql_ta "$sql")" || fail "soak-status query '${label}' failed"
  echo "${label}=${value}" >> "$SOAK_STATUS_FILE"
  printf '%s' "$value"
}

soak_status_rows() {
  # soak_status_rows <header> <sql> — appends a row-set section.
  {
    echo ""
    echo "## $1"
    soak_psql_rows "$2"
  } >> "$SOAK_STATUS_FILE"
}

action_soak_status() {
  soak_validate_opts
  soak_resolve_pg
  local window_start
  window_start="$(soak_opt window_start '')"
  if [[ -z "$window_start" ]]; then
    [[ -f "$SOAK_WINDOW_START_FILE" ]] \
      || fail "no soak window start: pass soak_opts window_start=<ISO8601 UTC> or run action=soak-flags first (it records ${SOAK_WINDOW_START_FILE})"
    window_start="$(cat "$SOAK_WINDOW_START_FILE")"
  fi
  [[ "$window_start" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)?$ ]] \
    || fail "window_start unparseable (want YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ): '${window_start}'"
  if [[ -z "$SOAK_ORGS" ]]; then
    [[ -f "$SOAK_HOST_CONFIG_FILE" ]] \
      || fail "no soak orgs: pass soak_orgs or run action=soak-seed first (it writes ${SOAK_HOST_CONFIG_FILE})"
    SOAK_ORGS="$(python3 -c 'import json,sys; print(",".join(e["orgId"] for e in json.load(open(sys.argv[1]))["entries"]))' "$SOAK_HOST_CONFIG_FILE")"
  fi
  soak_require_orgs
  local window_date="${window_start:0:10}"
  SOAK_STATUS_FILE="${OUTPUT_DIR}/soak-status.txt"
  {
    echo "# attendance W4+W7 combined-soak daily status (monitoring pack Q-series + W7-2 compare-window counters)"
    echo "generated=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "window_start=${window_start}"
    echo "orgs=${SOAK_ORGS}"
  } > "$SOAK_STATUS_FILE"
  local -a alerts=()
  local v

  # Live allowlist env capture (runbook §5 item 8 — catches silent case-fold no-ops early).
  {
    echo "serving_w4_env=$(soak_backend_env "$SOAK_W4_ENV_NAME")"
    echo "serving_w7_env=$(soak_backend_env "$SOAK_W7_ENV_NAME")"
  } >> "$SOAK_STATUS_FILE"

  # --- cumulative count criteria (C1-C4) -------------------------------------------------
  # [Q1]/[Q2] count BOTH regimes (post-merge review P1: the W4-side join is structurally
  # empty for a legacy_only org, so C1/C2 evidence was unreachable for the control arm):
  #  - W4-postured orgs: DISTINCT clean operations (calc completed, diff NULL|equal) — the
  #    converged unit (a transient in-only mismatch row keeps its op out until it converges);
  #  - legacy-postured orgs (rollout row absent or state='legacy'): COMPLETED PAIR DAYS —
  #    attendance_records with BOTH boundaries set, created in-window, synthetic-family
  #    users only — the same one-per-user-per-day converged unit in the regime that org
  #    actually runs. Orgs are the config CLOSED SET; posture is read at query time (this
  #    soak's postures are constant in-window by design — org walks are seed-time acts).
  soak_status_scalar "[Q1]_clean_punch_total_cumulative" \
    "SELECT (SELECT count(DISTINCT op.operation_id) FROM attendance_result_operations op JOIN attendance_record_calculations c ON c.org_id = op.org_id AND c.operation_id = op.operation_id WHERE op.org_id IN ('${SOAK_ORG1}','${SOAK_ORG2}','${SOAK_ORG3}') AND op.entrypoint = 'live_punch' AND op.state = 'completed' AND op.created_at >= '${window_start}'::timestamptz AND op.created_at < now() AND c.calculation_kind = 'calculation' AND c.outcome = 'completed' AND (c.shadow_diff_code IS NULL OR c.shadow_diff_code = 'equal')) + (SELECT count(*) FROM attendance_records r WHERE r.org_id IN ('${SOAK_ORG1}','${SOAK_ORG2}','${SOAK_ORG3}') AND NOT EXISTS (SELECT 1 FROM attendance_calculation_rollout_state s WHERE s.org_id = r.org_id AND s.state <> 'legacy') AND EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id AND u.username LIKE '${SOAK_USER_PREFIX}%') AND r.first_in_at IS NOT NULL AND r.last_out_at IS NOT NULL AND r.created_at >= '${window_start}'::timestamptz AND r.created_at < now());" >/dev/null
  soak_status_rows "[Q2] per-org clean punches (cumulative; BOTH regimes; weakest org first)" \
    "SELECT target.org_id, COALESCE(sum(cnt), 0)::int AS clean_punch_count FROM (VALUES ('${SOAK_ORG1}'),('${SOAK_ORG2}'),('${SOAK_ORG3}')) AS target(org_id) LEFT JOIN ( SELECT c.org_id, count(DISTINCT op.operation_id) AS cnt FROM attendance_result_operations op JOIN attendance_record_calculations c ON c.org_id = op.org_id AND c.operation_id = op.operation_id WHERE op.org_id IN ('${SOAK_ORG1}','${SOAK_ORG2}','${SOAK_ORG3}') AND op.entrypoint = 'live_punch' AND op.state = 'completed' AND op.created_at >= '${window_start}'::timestamptz AND op.created_at < now() AND c.calculation_kind = 'calculation' AND c.outcome = 'completed' AND (c.shadow_diff_code IS NULL OR c.shadow_diff_code = 'equal') GROUP BY c.org_id UNION ALL SELECT r.org_id, count(*) FROM attendance_records r WHERE r.org_id IN ('${SOAK_ORG1}','${SOAK_ORG2}','${SOAK_ORG3}') AND NOT EXISTS (SELECT 1 FROM attendance_calculation_rollout_state s WHERE s.org_id = r.org_id AND s.state <> 'legacy') AND EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id AND u.username LIKE '${SOAK_USER_PREFIX}%') AND r.first_in_at IS NOT NULL AND r.last_out_at IS NOT NULL AND r.created_at >= '${window_start}'::timestamptz AND r.created_at < now() GROUP BY r.org_id ) both_regimes ON both_regimes.org_id = target.org_id GROUP BY target.org_id ORDER BY clean_punch_count ASC;"
  soak_status_rows "[Q3] org/posture classification (three-posture buckets; investigate any 'unclassified')" \
    "SELECT target.org_id, COALESCE(w4.state, 'legacy') AS w4_posture, COALESCE(w7.state, 'off') AS w7_posture, CASE WHEN COALESCE(w4.state,'legacy') = 'legacy' AND COALESCE(w7.state,'off') = 'off' THEN 'legacy_only' WHEN COALESCE(w4.state,'legacy') <> 'legacy' AND COALESCE(w7.state,'off') = 'off' THEN 'w4_only_legacy_arm' WHEN COALESCE(w7.state,'off') IN ('group_shadow','group_eligible','group_authoritative') THEN 'both_machines_group_arm' WHEN COALESCE(w7.state,'off') = 'suspended' THEN 'w7_suspended' ELSE 'unclassified' END AS soak_posture_bucket FROM (VALUES ('${SOAK_ORG1}'),('${SOAK_ORG2}'),('${SOAK_ORG3}')) AS target(org_id) LEFT JOIN attendance_calculation_rollout_state w4 ON w4.org_id = target.org_id LEFT JOIN attendance_calculation_context_source_state w7 ON w7.org_id = target.org_id ORDER BY soak_posture_bucket, target.org_id;"
  soak_status_scalar "[Q4a]_w4_legacy_arm_clean_punches_cumulative" \
    "SELECT count(DISTINCT op.operation_id) FROM attendance_result_operations op JOIN attendance_record_calculations c ON c.org_id = op.org_id AND c.operation_id = op.operation_id LEFT JOIN attendance_calculation_context_source_state w7 ON w7.org_id = op.org_id WHERE op.entrypoint = 'live_punch' AND op.state = 'completed' AND op.created_at >= '${window_start}'::timestamptz AND op.created_at < now() AND c.calculation_kind = 'calculation' AND c.outcome = 'completed' AND (c.shadow_diff_code IS NULL OR c.shadow_diff_code = 'equal') AND COALESCE(w7.state, 'off') = 'off';" >/dev/null
  # [Q4b] MUST NOT join attendance_result_operations: a W7 group-shadow comparison row
  # carries operation_id IS NULL BY DESIGN (chk_arc_operation_id's marker disjunct,
  # zzzz20260815130000_w7_2_group_shadow_comparison_identity.ts), so that join is
  # identically empty and C4's group-arm channel would be structurally zero forever. The
  # producing operation travels inside the marker instead; count it out of there,
  # marker AND selector scoped, mirroring w7-compare-window-status.ts:189-196
  # (uq_arc_w7_comparison_identity makes that marker operationId unique per (org,entrypoint)).
  soak_status_scalar "[Q4b]_w7_group_arm_clean_punches_cumulative" \
    "SELECT count(DISTINCT (c.input_provenance -> 'w7GroupShadowCompare' ->> 'operationId')) FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id WHERE c.created_at >= '${window_start}'::timestamptz AND c.created_at < now() AND c.mode = 'shadow' AND (c.input_provenance ? 'w7GroupShadowCompare') AND c.context_snapshot IS NOT NULL AND (c.context_snapshot ->> 'selector') = 'group_effective' AND c.outcome = 'completed' AND (c.shadow_diff_code IS NULL OR c.shadow_diff_code = 'equal');" >/dev/null
  # [Q14] universe = config CLOSED SET (post-merge review P3: a posture-table-derived
  # universe omits the legacy_only control org — no state rows — and the two-row summary
  # misleads on-duty readers even though C1-C3 acceptance reads Q1-Q3, not Q14).
  soak_status_rows "[Q14] posture-state distribution (org-count summary; config closed set)" \
    "SELECT COALESCE(w4.state,'legacy') AS w4_posture, COALESCE(w7.state,'off') AS w7_posture, count(*)::int AS org_count FROM (VALUES ('${SOAK_ORG1}'),('${SOAK_ORG2}'),('${SOAK_ORG3}')) AS target(org_id) LEFT JOIN attendance_calculation_rollout_state w4 ON w4.org_id = target.org_id LEFT JOIN attendance_calculation_context_source_state w7 ON w7.org_id = target.org_id GROUP BY w4_posture, w7_posture ORDER BY w4_posture, w7_posture;"
  soak_status_rows "posture rows for the three soak orgs (W4 then W7)" \
    "SELECT 'w4' AS machine, org_id, state, version, prior_state FROM attendance_calculation_rollout_state WHERE org_id IN ('${SOAK_ORG1}','${SOAK_ORG2}','${SOAK_ORG3}') UNION ALL SELECT 'w7', org_id, state, version, prior_state FROM attendance_calculation_context_source_state WHERE org_id IN ('${SOAK_ORG1}','${SOAK_ORG2}','${SOAK_ORG3}') ORDER BY 1, 2;"

  # --- Q15a: FK negative controls are only meaningful while the constraints exist -------
  v="$(soak_status_scalar "[Q15a]_live_fk_constraints_expected_2" \
    "SELECT count(*) FROM pg_constraint WHERE conname IN ('fk_arc_record', 'fk_ar_current_calculation') AND contype = 'f';")"
  [[ "$v" == "2" ]] || alerts+=("Q15a_fk_constraints_missing=${v}")

  # --- [Q2b] legacy-control byte-neutrality (post-merge review P1 follow-through): for
  # every CONFIG org still legacy-postured, ANY W4 calculation or operation row is an
  # alert — the control arm's evidence is that the W4 machinery never touched it.
  local ctrl_state ctrl_rows org
  for org in "$SOAK_ORG1" "$SOAK_ORG2" "$SOAK_ORG3"; do
    ctrl_state="$(soak_psql_ta "SELECT COALESCE((SELECT state FROM attendance_calculation_rollout_state WHERE org_id = '${org}'), 'legacy');")"
    if [[ "$ctrl_state" == "legacy" ]]; then
      # Byte-neutrality = the W4 CALCULATION machinery never touched the org. An operation
      # row with accepted_write_posture='legacy_projection_only' is the RULED ledger of a
      # legacy write (boundary seals one per punch, resolved_calculation_id NULL, zero calc
      # rows — pinned by attendance-w4c2-live-scheduled-boundary.db.test.ts) and is NOT
      # contamination; #4975 gate P1 reproduced 60 such rows on the control org. Count calc
      # rows plus only NON-legacy-posture ops (NULL posture is anomalous => counted).
      ctrl_rows="$(soak_status_scalar "[Q2b]_legacy_control_w4_rows_${org:0:8}" \
        "SELECT (SELECT count(*) FROM attendance_record_calculations WHERE org_id = '${org}') + (SELECT count(*) FROM attendance_result_operations WHERE org_id = '${org}' AND COALESCE(accepted_write_posture, '') <> 'legacy_projection_only');")"
      [[ "$ctrl_rows" == "0" ]] || alerts+=("Q2b_legacy_control_w4_rows_${org:0:8}=${ctrl_rows}")
    fi
  done

  # --- [Q3b] posture-constancy guard (#4975 gate P2-2): the dual-regime counters assume
  # each config org's posture is CONSTANT in-window (walks are seed-time acts). A W4 row in
  # state 'legacy' with a non-NULL prior_state is a ROLLBACK (shadow->legacy is a legal
  # transition) — its history double-counts and Q2b false-alarms; any state outside this
  # soak's plan (legacy|shadow) — e.g. 'suspended' — makes the org invisible to BOTH
  # regimes. Either voids the counting assumptions => mechanical alert.
  local pc_bad
  # changed_at >= window_start catches the FORWARD walk too (legacy->shadow mid-window, or
  # a round trip landing on a nominal-looking shape) — every seed-time walk precedes the
  # window start, so this adds no false alarms (#4975 gate round-2 P3).
  pc_bad="$(soak_psql_ta "SELECT count(*) FROM attendance_calculation_rollout_state WHERE org_id IN ('${SOAK_ORG1}','${SOAK_ORG2}','${SOAK_ORG3}') AND (state NOT IN ('legacy','shadow') OR (state = 'legacy' AND prior_state IS NOT NULL) OR changed_at >= '${window_start}'::timestamptz);")"
  echo "[Q3b]_posture_constancy_violations=${pc_bad}" >> "$SOAK_STATUS_FILE"
  [[ "$pc_bad" == "0" ]] || alerts+=("Q3b_posture_constancy_violations=${pc_bad}")

  # --- per-org read set ------------------------------------------------------------------
  local org8
  for org in "$SOAK_ORG1" "$SOAK_ORG2" "$SOAK_ORG3"; do
    org8="${org:0:8}"
    echo "" >> "$SOAK_STATUS_FILE"
    echo "### org ${org}" >> "$SOAK_STATUS_FILE"
    v="$(soak_status_scalar "[Q5]_critical_shadow_diffs_24h_${org8}" \
      "SELECT count(*) FROM attendance_record_calculations WHERE org_id = '${org}' AND created_at >= now() - interval '24 hours' AND mode = 'shadow' AND shadow_diff_code IN ('work_date_mismatch','context_mismatch','input_mismatch','review_required');")"
    [[ "$v" == "0" ]] || alerts+=("Q5_critical_diffs_${org8}=${v}")
    soak_status_scalar "[Q5]_critical_shadow_diffs_cumulative_${org8}" \
      "SELECT count(*) FROM attendance_record_calculations WHERE org_id = '${org}' AND created_at >= '${window_start}'::timestamptz AND mode = 'shadow' AND shadow_diff_code IN ('work_date_mismatch','context_mismatch','input_mismatch','review_required');" >/dev/null
    soak_status_rows "[Q6] shadow-diff histogram 24h, org ${org8} (reconcile against the roster BY HAND; selector='group_effective' rows are W7 group-shadow rows)" \
      "SELECT entrypoint, shadow_diff_code, (context_snapshot ->> 'selector') AS selector, count(*)::int AS item_count FROM attendance_record_calculations WHERE org_id = '${org}' AND created_at >= now() - interval '24 hours' AND mode = 'shadow' AND shadow_diff_code IS NOT NULL AND shadow_diff_code <> 'equal' GROUP BY entrypoint, shadow_diff_code, selector ORDER BY entrypoint, shadow_diff_code, selector;"
    v="$(soak_status_scalar "[Q7]_unresolved_ingress_reviews_${org8}" \
      "SELECT count(*) FROM attendance_records r WHERE r.org_id = '${org}' AND EXISTS (SELECT 1 FROM attendance_record_calculations c WHERE c.org_id = '${org}' AND c.attendance_record_id = r.id AND c.outcome_reason_code = 'legacy_time_ingress_not_authoritative' AND c.version = (SELECT MAX(c2.version) FROM attendance_record_calculations c2 WHERE c2.org_id = '${org}' AND c2.attendance_record_id = r.id));")"
    [[ "$v" == "0" ]] || alerts+=("Q7_unresolved_reviews_${org8}=${v}")
    # Q9 marker AND selector scoped (unified with the [W7-2]_W7_COMPARE_COVERAGE counter
    # below and with w7-compare-window-status.ts:189-196): selector alone would also count
    # a group_authoritative-era W4 group-context shadow row (§3.2 T-D1), so the two spellings
    # could disagree once such rows exist. Marker-scoping makes them one number.
    soak_status_scalar "[Q9]_w7_compare_coverage_cumulative_${org8}" \
      "SELECT count(DISTINCT (r.user_id, r.work_date)) FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id WHERE c.org_id = '${org}' AND c.created_at >= '${window_start}'::timestamptz AND c.mode = 'shadow' AND (c.input_provenance ? 'w7GroupShadowCompare') AND c.context_snapshot IS NOT NULL AND c.context_snapshot ->> 'selector' = 'group_effective';" >/dev/null
    soak_status_rows "[Q10] failed scheduled-run target outcomes 24h, org ${org8} (每行单独 triage — not a bare zero requirement)" \
      "SELECT o.run_id, o.target_id, o.terminal_outcome, o.failure_reason_code, o.recorded_at FROM attendance_scheduled_run_target_outcomes o WHERE o.org_id = '${org}' AND o.recorded_at >= now() - interval '24 hours' AND o.terminal_outcome = 'failed' ORDER BY o.recorded_at;"
    soak_status_rows "[Q11] outcome/reason counts 24h, org ${org8}" \
      "SELECT outcome, outcome_reason_code, count(*)::int AS n FROM attendance_record_calculations WHERE org_id = '${org}' AND created_at >= now() - interval '24 hours' GROUP BY outcome, outcome_reason_code ORDER BY outcome, n DESC;"
    soak_status_rows "[Q12] projection_owner/visibility distribution, org ${org8}" \
      "SELECT projection_owner, visibility_state, count(*)::int AS n FROM attendance_records WHERE org_id = '${org}' GROUP BY projection_owner, visibility_state ORDER BY projection_owner, visibility_state;"
    soak_status_scalar "[Q13]_context_mismatch_reviews_24h_${org8}" \
      "SELECT count(*) FROM attendance_record_calculations WHERE org_id = '${org}' AND created_at >= now() - interval '24 hours' AND outcome = 'review_required' AND outcome_reason_code = 'context_mismatch';" >/dev/null
    v="$(soak_status_scalar "[Q15b]_calculations_without_parent_${org8}" \
      "SELECT count(*) FROM attendance_record_calculations c LEFT JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id WHERE c.org_id = '${org}' AND r.id IS NULL;")"
    [[ "$v" == "0" ]] || alerts+=("Q15b_orphan_calculations_${org8}=${v}")
    v="$(soak_status_scalar "[Q15c]_dangling_current_calculation_pointers_${org8}" \
      "SELECT count(*) FROM attendance_records r LEFT JOIN attendance_record_calculations c ON c.id = r.current_calculation_id AND c.attendance_record_id = r.id AND c.org_id = r.org_id WHERE r.org_id = '${org}' AND r.current_calculation_id IS NOT NULL AND c.id IS NULL;")"
    [[ "$v" == "0" ]] || alerts+=("Q15c_dangling_pointers_${org8}=${v}")
    soak_status_rows "[Q16] full diff-code histogram 24h (incl. 'equal' denominator), org ${org8}" \
      "SELECT shadow_diff_code, count(*)::int AS n FROM attendance_record_calculations WHERE org_id = '${org}' AND created_at >= now() - interval '24 hours' AND mode = 'shadow' AND shadow_diff_code IS NOT NULL GROUP BY shadow_diff_code ORDER BY n DESC;"
  done

  # --- [Q17]/[Q18] human-tail attribution (2026-08-21) — WHERE did real-browser punches land? ---
  # Real-browser self-service punches are not guaranteed to be attributed to the soak orgs the way
  # the generator's explicit-orgId punches are, so every per-org Q-read above can stay flat while
  # tester rows exist elsewhere. Q17 groups synthetic-account records by the org they were actually
  # written under (NOT restricted to the soak orgs — that restriction is the blind spot); Q18 dumps
  # the tester accounts' (u01) rows column-agnostically (to_jsonb) so a schema rename can't silently
  # blank the read. Read-only; no alert semantics (disposition by hand, attribution notes private).
  soak_status_rows "[Q17] synthetic-account attendance_records by ACTUAL org_id, last 96h (tail attribution; NOT restricted to the soak orgs)" \
    "SELECT r.org_id, count(*)::int AS n, min(r.work_date)::text AS first_work_date, max(r.work_date)::text AS last_work_date FROM attendance_records r JOIN users u ON u.id = r.user_id WHERE u.username LIKE '${SOAK_USER_PREFIX}%' AND r.updated_at >= now() - interval '96 hours' GROUP BY r.org_id ORDER BY n DESC;"
  soak_status_rows "[Q18] tester (u01) attendance_records rows, last 96h, column-agnostic (to_jsonb minus ids)" \
    "SELECT u.username, r.org_id, (to_jsonb(r) - 'id' - 'user_id' - 'org_id')::text AS row_json FROM attendance_records r JOIN users u ON u.id = r.user_id WHERE u.username LIKE '${SOAK_USER_PREFIX}%-u01' AND r.updated_at >= now() - interval '96 hours' ORDER BY u.username, r.work_date;"

  # --- [Q8] 8-cell request-snapshot defect report — the EXISTING function, never raw SQL --
  # (W8-RECONCILIATION-PACK Q8 rule: re-deriving classifyAttendanceRequestSnapshotDefectsV1
  # in SQL risks silent drift). Runs the deployed image's own module via tsx.
  local q8_script_host="${OUTPUT_DIR}/soak-q8.mts"
  cat > "$q8_script_host" <<'Q8'
// soak-q8.mts — generated by attendance-staging-window-runner-remote.sh action=soak-status.
// Calls the EXISTING readAttendanceRequestSnapshotDefectReportV1 (w4c3a-rollout-control.ts)
// against the staging DB; prints the report JSON verbatim. Read-only.
const orgId = process.argv[2]
if (!orgId) { console.error('usage: soak-q8.mts <orgId>'); process.exit(2) }
const pgNs = await import('pg')
const pg = (pgNs as any).default ?? pgNs
const rolloutNs = await import('/app/packages/core-backend/src/attendance/w4c3a-rollout-control.ts')
const rollout = 'readAttendanceRequestSnapshotDefectReportV1' in rolloutNs
  ? (rolloutNs as any)
  : (rolloutNs as any).default
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
const client = await pool.connect()
try {
  const trx = {
    query: async (text: string, params?: unknown[]) => {
      const result = await client.query(text, params)
      return { rows: result.rows }
    },
  }
  const report = await rollout.readAttendanceRequestSnapshotDefectReportV1(trx, orgId)
  console.log(JSON.stringify(report))
} finally {
  client.release()
  await pool.end()
}
Q8
  prepare_container_runner
  staging_exec test -f "$SOAK_TSX" || fail "deployed image lacks tsx at ${SOAK_TSX} (needed for the Q8 function call)"
  docker cp "$q8_script_host" "${BACKEND_CONTAINER}:${CONTAINER_RUNNER_DIR}/scripts/ops/soak-q8.mts"
  for org in "$SOAK_ORG1" "$SOAK_ORG2" "$SOAK_ORG3"; do
    org8="${org:0:8}"
    local q8_out="${OUTPUT_DIR}/soak-q8-${org8}.json"
    staging_exec node "$SOAK_TSX" "${CONTAINER_RUNNER_DIR}/scripts/ops/soak-q8.mts" "$org" \
      < /dev/null > "$q8_out" 2> "${OUTPUT_DIR}/soak-q8-${org8}.stderr" \
      || fail "[Q8] request-snapshot defect report failed for org ${org8} (see soak-q8-${org8}.stderr)"
    v="$(soak_json_get "$q8_out" totalDefectiveRequests)" || fail "[Q8] report JSON unparseable for org ${org8}"
    echo "[Q8]_total_defective_requests_${org8}=${v}" >> "$SOAK_STATUS_FILE"
    [[ "$v" == "0" ]] || alerts+=("Q8_defective_request_snapshots_${org8}=${v}")
  done

  # --- W7-2 compare-window counters via psql (org3; marker-scoped, mirroring
  # w7-compare-window-status.ts: marker 'w7GroupShadowCompare' AND selector
  # 'group_effective' — selector alone would count W4 shadow rows) ----------------------
  local org3="$SOAK_ORG3" org38="$SOAK_ORG3_SHORT"
  v="$(soak_status_scalar "[W7-2]_selectorless_shadow_rows_${org38}" \
    "SELECT count(*) FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id WHERE c.org_id = '${org3}' AND c.mode = 'shadow' AND r.work_date >= '${window_date}'::date AND c.context_snapshot IS NOT NULL AND (c.context_snapshot ->> 'selector') IS NULL;")"
  [[ "$v" == "0" ]] || alerts+=("W7_selectorless_corruption_${org38}=${v}")
  v="$(soak_status_scalar "[W7-2]_W7_CRITICAL_SHADOW_DIFF_${org38}" \
    "SELECT count(*) FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id WHERE c.org_id = '${org3}' AND c.mode = 'shadow' AND r.work_date >= '${window_date}'::date AND (c.input_provenance ? 'w7GroupShadowCompare') AND c.context_snapshot IS NOT NULL AND (c.context_snapshot ->> 'selector') = 'group_effective' AND c.shadow_diff_code IN ('work_date_mismatch','context_mismatch','input_mismatch','review_required');")"
  [[ "$v" == "0" ]] || alerts+=("W7_CRITICAL_SHADOW_DIFF_${org38}=${v}")
  soak_status_scalar "[W7-2]_W7_COMPARE_COVERAGE_${org38}" \
    "SELECT count(DISTINCT (r.user_id, r.work_date)) FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id WHERE c.org_id = '${org3}' AND c.mode = 'shadow' AND r.work_date >= '${window_date}'::date AND (c.input_provenance ? 'w7GroupShadowCompare') AND c.context_snapshot IS NOT NULL AND (c.context_snapshot ->> 'selector') = 'group_effective';" >/dev/null
  soak_status_scalar "[W7-2]_W7_GROUP_RESOLUTION_FAILCLOSE_${org38}" \
    "SELECT count(*) FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id WHERE c.org_id = '${org3}' AND c.mode = 'shadow' AND r.work_date >= '${window_date}'::date AND (c.input_provenance -> 'w7GroupShadowCompare' ->> 'shadowReason') IS NOT NULL;" >/dev/null
  soak_status_rows "[W7-2] non-equal group-compare rows ${org38} (W7_OFF_ROSTER_DIFF raw input — every selector='group_effective' row here needs a roster disposition BY HAND until the mechanical reader is called directly)" \
    "SELECT c.entrypoint, c.shadow_diff_code, c.outcome, count(*)::int AS n FROM attendance_record_calculations c JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id WHERE c.org_id = '${org3}' AND c.mode = 'shadow' AND r.work_date >= '${window_date}'::date AND (c.input_provenance ? 'w7GroupShadowCompare') AND c.context_snapshot IS NOT NULL AND (c.context_snapshot ->> 'selector') = 'group_effective' AND c.shadow_diff_code IS NOT NULL AND c.shadow_diff_code <> 'equal' GROUP BY c.entrypoint, c.shadow_diff_code, c.outcome ORDER BY n DESC;"

  {
    echo "action=soak-status"
    echo "window_start=${window_start}"
    echo "orgs=${SOAK_ORGS}"
    echo "alerts=${#alerts[@]}"
    if [[ "${#alerts[@]}" -gt 0 ]]; then
      echo "alert_list=$(IFS=,; echo "${alerts[*]}")"
    fi
    echo "result=$([[ "${#alerts[@]}" -eq 0 ]] && echo ok || echo ALERT)"
  } > "${OUTPUT_DIR}/summary.txt"
  if [[ "${#alerts[@]}" -gt 0 ]]; then
    fail "soak-status found ${#alerts[@]} mechanical alert condition(s): $(IFS=,; echo "${alerts[*]}") — full read set in soak-status.txt; disposition is a reviewed owner call, never a unilateral one"
  fi
  log "soak-status OK: zero mechanical alerts (full Q-series in soak-status.txt; roster reconciliation of Q6/[W7-2] histograms stays a manual step)"
}

# --- main ------------------------------------------------------------------------------

mkdir -p "$OUTPUT_DIR"
assert_staging_only

case "$ACTION" in
  deploy) action_deploy ;;
  smoke) action_smoke ;;
  status) action_status ;;
  migrate) action_migrate ;;
  residue-sweep) action_residue_sweep ;;
  soak-baseline) action_soak_baseline ;;
  soak-seed) action_soak_seed ;;
  soak-flags) action_soak_flags ;;
  soak-run) action_soak_run ;;
  soak-status) action_soak_status ;;
  *) fail "unknown action: ${ACTION} (expected deploy|smoke|status|migrate|residue-sweep|soak-baseline|soak-seed|soak-flags|soak-run|soak-status)" ;;
esac
