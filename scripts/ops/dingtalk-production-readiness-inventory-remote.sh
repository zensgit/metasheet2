#!/usr/bin/env bash
# dingtalk-production-readiness-inventory-remote.sh
#
# READ-ONLY production inventory for DingTalk readiness. Runs on the deploy host
# under the same host-authenticated SSH path as the OAuth stability lane.
#
# Safety rails:
#   * Never writes env files, never mutates DB, never flips lifecycle flags.
#   * Counts + presence only (no row picking of a user/integration).
#   * Artifacts are values-free: booleans, counts, enum reasons, deployed SHA only.
#   * No secret material, corp values, integration ids, or PII in output.
#   * Missing tables or query errors => fail-closed "unknown", not zero.
#
# Invoked as: bash -o pipefail -c '<script path>'
set -euo pipefail

log() { echo "[dingtalk-prod-inventory] $*"; }
fail() { echo "[dingtalk-prod-inventory][error] $*" >&2; exit 1; }

DEPLOY_PATH="${DEPLOY_PATH:-metasheet2}"
DEPLOY_COMPOSE_FILE="${DEPLOY_COMPOSE_FILE:-docker-compose.app.yml}"
OUTPUT_DIR="${OUTPUT_DIR:-}"
RUN_STAMP="${RUN_STAMP:-manual}"
BACKEND_HEALTH_URL="${BACKEND_HEALTH_URL:-http://127.0.0.1:8900/health}"
WEB_HEALTH_URL="${WEB_HEALTH_URL:-http://127.0.0.1:8081/api/health}"

resolve_home_path() {
  local raw="$1"
  if [[ "$raw" == /* ]]; then
    printf '%s' "$raw"
  elif [[ "$raw" == "~/"* ]]; then
    printf '%s' "${HOME}/${raw#"~/"}"
  else
    printf '%s' "${HOME}/${raw}"
  fi
}

REPO_DIR="$(resolve_home_path "$DEPLOY_PATH")"

require_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
    return 0
  fi
  fail "docker compose is required"
}

compose_exec() {
  # compose_exec <service> <remote command...>
  local service="$1"
  shift
  (cd "$REPO_DIR" && "${COMPOSE[@]}" -f "$DEPLOY_COMPOSE_FILE" exec -T "$service" "$@") </dev/null
}

is_truthy() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$v" in
    true|1|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

flag_state_from_env() {
  # Prints true|false|unknown for a lifecycle flag. Missing => false (code default OFF).
  local key="$1" raw
  if ! raw="$(compose_exec backend sh -lc "if printenv $(printf '%q' "$key") >/dev/null 2>&1; then printenv $(printf '%q' "$key"); else printf '__MISSING__'; fi" 2>/dev/null)"; then
    printf 'unknown'
    return 0
  fi
  if [[ "$raw" == "__MISSING__" ]]; then
    printf 'false'
    return 0
  fi
  if is_truthy "$raw"; then
    printf 'true'
  else
    printf 'false'
  fi
}

env_present() {
  # Prints true|false|unknown — presence only, never the value.
  local keys=("$@") key raw
  for key in "${keys[@]}"; do
    if ! raw="$(compose_exec backend sh -lc "if printenv $(printf '%q' "$key") >/dev/null 2>&1; then v=\$(printenv $(printf '%q' "$key")); if [ -n \"\$(printf '%s' \"\$v\" | tr -d '[:space:]')\" ]; then printf 'yes'; else printf 'empty'; fi; else printf 'missing'; fi" 2>/dev/null)"; then
      printf 'unknown'
      return 0
    fi
    if [[ "$raw" == "yes" ]]; then
      printf 'true'
      return 0
    fi
  done
  printf 'false'
}

read_env_raw_or_empty() {
  # Used only for closed enum classification (never printed). On probe failure => empty + caller sets unknown.
  local key="$1" raw
  if ! raw="$(compose_exec backend sh -lc "printenv $(printf '%q' "$key") 2>/dev/null || true" 2>/dev/null)"; then
    printf ''
    return 1
  fi
  printf '%s' "$raw"
  return 0
}

classify_allowlist() {
  # Sets ALLOWLIST_READY and ALLOWLIST_REASON (configured|empty|placeholder|unknown).
  # Never emits the corp id list.
  local raw rc=0
  raw="$(read_env_raw_or_empty DINGTALK_ALLOWED_CORP_IDS)" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    ALLOWLIST_READY="unknown"
    ALLOWLIST_REASON="unknown"
    return 0
  fi
  # Match runtime-policy.ts: split on commas or whitespace, then trim tokens.
  local normalized
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$normalized" ]]; then
    ALLOWLIST_READY="false"
    ALLOWLIST_REASON="empty"
    return 0
  fi
  # Placeholder tokens (staging templates / example values).
  local token placeholders
  placeholders='replace-me changeme change-me placeholder todo xxx your-corp-id example'
  local has_placeholder=false has_any=false
  while IFS= read -r token; do
    [[ -z "$token" ]] && continue
    has_any=true
    case " $placeholders " in
      *" $token "*) has_placeholder=true ;;
      *) ;;
    esac
  done < <(printf '%s\n' "$normalized" | tr ',[:space:]' '\n' | sed '/^$/d')
  if [[ "$has_any" != "true" ]]; then
    ALLOWLIST_READY="false"
    ALLOWLIST_REASON="empty"
    return 0
  fi
  if [[ "$has_placeholder" == "true" ]]; then
    ALLOWLIST_READY="false"
    ALLOWLIST_REASON="placeholder"
    return 0
  fi
  ALLOWLIST_READY="true"
  ALLOWLIST_REASON="configured"
}

classify_log_level() {
  # Sets LOG_LEVEL_READY and LOG_LEVEL_REASON (info|debug|other|missing|unknown).
  local raw rc=0
  raw="$(read_env_raw_or_empty LOG_LEVEL)" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    LOG_LEVEL_READY="unknown"
    LOG_LEVEL_REASON="unknown"
    return 0
  fi
  local normalized
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [[ -z "$normalized" ]]; then
    # core/logger.ts defaults to info when unset/empty.
    LOG_LEVEL_READY="true"
    LOG_LEVEL_REASON="missing"
    return 0
  fi
  case "$normalized" in
    info)
      LOG_LEVEL_READY="true"
      LOG_LEVEL_REASON="info"
      ;;
    debug)
      LOG_LEVEL_READY="true"
      LOG_LEVEL_REASON="debug"
      ;;
    *)
      LOG_LEVEL_READY="false"
      LOG_LEVEL_REASON="other"
      ;;
  esac
}

resolve_deployed_sha() {
  local live_image image_commit="" health_commit="" body
  live_image="$(docker inspect -f '{{.Config.Image}}' "$BACKEND_CONTAINER_ID" 2>/dev/null || true)"
  if [[ "$live_image" =~ :([0-9a-f]{40})$ ]]; then
    image_commit="${BASH_REMATCH[1]}"
  fi
  if body="$(curl -fsS --max-time 10 "$WEB_HEALTH_URL" 2>/dev/null || curl -fsS --max-time 10 "$BACKEND_HEALTH_URL" 2>/dev/null)"; then
    health_commit="$(printf '%s' "$body" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  print((d.get("build") or {}).get("commit") or d.get("commit") or "")
except Exception:
  print("")' 2>/dev/null || true)"
  fi
  DEPLOYED_SHA='unknown'
  DEPLOYED_SHA_VERIFIED='false'
  if [[ -n "$image_commit" && "$health_commit" =~ ^[0-9a-f]{40}$ ]]; then
    if [[ "$image_commit" == "$health_commit" ]]; then
      DEPLOYED_SHA="$image_commit"
      DEPLOYED_SHA_VERIFIED='true'
    else
      DEPLOYED_SHA='conflict'
    fi
  fi
}

# SQL inventory: values-free counts only. Fail closed to "unknown" on any error/missing table.
# Uses backend+node+pg (DATABASE_URL already in the backend container) so we never need
# to surface DB credentials. Queries return counts/EXISTS only — never secret or PII columns.
run_sql_inventory() {
  local env_app_key_present="$1"
  local env_app_secret_present="$2"
  local env_agent_id_present="$3"
  local out sql_probe
  sql_probe="$(cat <<'NODE'
const { Client } = require('pg')
const unknown = {
  active_dingtalk_integration_count: 'unknown',
  active_corp_anchored_integration_count: 'unknown',
  active_directory_account_count: 'unknown',
  active_linked_local_user_count: 'unknown',
  same_integration_two_linked_users_ready: 'unknown',
  directory_uat_baseline_ready: 'unknown',
  password_capable_alias_admin_count: 'unknown',
  pending_user_count: 'unknown',
  stored_app_key_present: 'unknown',
  stored_app_secret_present: 'unknown',
  stored_agent_id_present: 'unknown',
  effective_app_credentials_ready: 'unknown',
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj))
}
;(async () => {
  const url = process.env.DATABASE_URL
  if (!url) {
    emit(unknown)
    return
  }
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 })
  let connected = false
  try {
    await c.connect()
    connected = true
    await c.query('BEGIN READ ONLY')
  } catch {
    if (connected) {
      try { await c.end() } catch { /* ignore */ }
    }
    emit(unknown)
    return
  }
  async function tableExists(name) {
    const r = await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', ['public.' + name])
    return Boolean(r.rows[0] && r.rows[0].ok)
  }
  async function countOrUnknown(sql) {
    try {
      const r = await c.query(sql)
      const n = Number(r.rows[0] && r.rows[0].n)
      return Number.isFinite(n) ? String(n) : 'unknown'
    } catch {
      return 'unknown'
    }
  }
  async function boolOrUnknown(sql, params = []) {
    try {
      const r = await c.query(sql, params)
      return r.rows[0] && r.rows[0].ok ? 'true' : 'false'
    } catch {
      return 'unknown'
    }
  }
  try {
    const result = Object.assign({}, unknown)
    const placeholderCorpIds = new Set([
      'replace-me', 'changeme', 'change-me', 'placeholder',
      'todo', 'xxx', 'your-corp-id', 'example',
    ])
    const rawAllowedCorpIds = String(process.env.DINGTALK_ALLOWED_CORP_IDS || '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
    const hasPlaceholderCorpId = rawAllowedCorpIds.some(
      (value) => placeholderCorpIds.has(value.toLowerCase()),
    )
    const allowedCorpIds = hasPlaceholderCorpId
      ? []
      : Array.from(new Set(rawAllowedCorpIds))
    let envKey = false
    let envSecret = false
    let envAgent = false
    let envStatesKnown = false
    if (await tableExists('directory_integrations')) {
      result.active_dingtalk_integration_count = await countOrUnknown(`
        SELECT count(*)::int AS n
          FROM directory_integrations
         WHERE provider = 'dingtalk'
           AND status = 'active'
      `)
      // Corp-anchored: active DingTalk integration with non-empty, non-placeholder corp_id.
      // Presence/shape only — never returns the corp_id value.
      result.active_corp_anchored_integration_count = await countOrUnknown(`
        SELECT count(*)::int AS n
          FROM directory_integrations
         WHERE provider = 'dingtalk'
           AND status = 'active'
           AND corp_id IS NOT NULL
           AND length(trim(corp_id)) > 0
           AND lower(trim(corp_id)) NOT IN (
             'replace-me', 'changeme', 'change-me',
             'placeholder', 'todo', 'xxx', 'your-corp-id', 'example'
           )
      `)
      result.stored_app_key_present = await boolOrUnknown(`
        SELECT EXISTS (
          SELECT 1 FROM directory_integrations
           WHERE provider = 'dingtalk' AND status = 'active'
             AND nullif(trim(config->>'appKey'), '') IS NOT NULL
        ) AS ok
      `)
      result.stored_app_secret_present = await boolOrUnknown(`
        SELECT EXISTS (
          SELECT 1 FROM directory_integrations
           WHERE provider = 'dingtalk' AND status = 'active'
             AND nullif(trim(config->>'appSecret'), '') IS NOT NULL
        ) AS ok
      `)
      result.stored_agent_id_present = await boolOrUnknown(`
        SELECT EXISTS (
          SELECT 1 FROM directory_integrations
           WHERE provider = 'dingtalk' AND status = 'active'
             AND (
               nullif(trim(config->>'workNotificationAgentId'), '') IS NOT NULL
               OR nullif(trim(config->>'agentId'), '') IS NOT NULL
             )
        ) AS ok
      `)
      const envStates = [
        process.env.INVENTORY_ENV_APP_KEY_PRESENT,
        process.env.INVENTORY_ENV_APP_SECRET_PRESENT,
        process.env.INVENTORY_ENV_AGENT_ID_PRESENT,
      ]
      if (!envStates.includes('unknown')) {
        ;[envKey, envSecret, envAgent] = envStates.map((value) => value === 'true')
        envStatesKnown = true
        result.effective_app_credentials_ready = await boolOrUnknown(`
        WITH selected AS (
          SELECT status, config
            FROM directory_integrations
           WHERE provider = 'dingtalk'
           ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC
           LIMIT 1
        )
        SELECT EXISTS (
          SELECT 1 FROM selected
           WHERE status = 'active'
             AND (${envKey ? 'TRUE' : "nullif(trim(config->>'appKey'), '') IS NOT NULL"})
             AND (${envSecret ? 'TRUE' : "nullif(trim(config->>'appSecret'), '') IS NOT NULL"})
             AND (${envAgent ? 'TRUE' : "nullif(trim(config->>'workNotificationAgentId'), '') IS NOT NULL OR nullif(trim(config->>'agentId'), '') IS NOT NULL"})
        ) AS ok
        `)
      }
    }
    if ((await tableExists('directory_accounts')) && (await tableExists('directory_integrations'))) {
      result.active_directory_account_count = await countOrUnknown(`
        SELECT count(*)::int AS n
          FROM directory_accounts a
          JOIN directory_integrations i ON i.id = a.integration_id
         WHERE a.provider = 'dingtalk'
           AND a.is_active = TRUE
           AND i.provider = 'dingtalk'
           AND i.status = 'active'
      `)
    }
    if ((await tableExists('directory_account_links')) && (await tableExists('directory_accounts')) &&
        (await tableExists('directory_integrations')) && (await tableExists('users'))) {
      result.active_linked_local_user_count = await countOrUnknown(`
        SELECT count(DISTINCT l.local_user_id)::int AS n
          FROM directory_account_links l
          JOIN directory_accounts a ON a.id = l.directory_account_id
          JOIN directory_integrations i ON i.id = a.integration_id
          JOIN users u ON u.id = l.local_user_id
         WHERE a.provider = 'dingtalk'
           AND a.is_active = TRUE
           AND i.provider = 'dingtalk'
           AND i.status = 'active'
           AND u.is_active = TRUE
           AND COALESCE(u.activation_status, 'activated') = 'activated'
           AND l.link_status = 'linked'
           AND l.local_user_id IS NOT NULL
           AND length(trim(l.local_user_id)) > 0
      `)
      result.same_integration_two_linked_users_ready = await boolOrUnknown(`
        SELECT EXISTS (
          SELECT 1
            FROM directory_account_links l
            JOIN directory_accounts a ON a.id = l.directory_account_id
            JOIN directory_integrations i ON i.id = a.integration_id
            JOIN users u ON u.id = l.local_user_id
           WHERE a.provider = 'dingtalk'
             AND a.is_active = TRUE
             AND i.provider = 'dingtalk'
             AND i.status = 'active'
             AND i.corp_id = ANY($1::text[])
             AND u.is_active = TRUE
             AND COALESCE(u.activation_status, 'activated') = 'activated'
             AND l.link_status = 'linked'
             AND l.local_user_id IS NOT NULL
           GROUP BY i.id
          HAVING count(DISTINCT l.local_user_id) >= 2
        ) AS ok
      `, [allowedCorpIds])
      if (envStatesKnown) {
        result.directory_uat_baseline_ready = await boolOrUnknown(`
          WITH selected AS (
            SELECT id, status, corp_id, config
              FROM directory_integrations
             WHERE provider = 'dingtalk'
             ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC
             LIMIT 1
          )
          SELECT EXISTS (
            SELECT 1
              FROM selected i
              JOIN directory_accounts a ON a.integration_id = i.id
              JOIN directory_account_links l ON l.directory_account_id = a.id
              JOIN users u ON u.id = l.local_user_id
             WHERE i.status = 'active'
               AND i.corp_id = ANY($1::text[])
               AND (${envKey ? 'TRUE' : "nullif(trim(i.config->>'appKey'), '') IS NOT NULL"})
               AND (${envSecret ? 'TRUE' : "nullif(trim(i.config->>'appSecret'), '') IS NOT NULL"})
               AND (${envAgent ? 'TRUE' : "nullif(trim(i.config->>'workNotificationAgentId'), '') IS NOT NULL OR nullif(trim(i.config->>'agentId'), '') IS NOT NULL"})
               AND a.provider = 'dingtalk'
               AND a.is_active = TRUE
               AND u.is_active = TRUE
               AND COALESCE(u.activation_status, 'activated') = 'activated'
               AND l.link_status = 'linked'
               AND l.local_user_id IS NOT NULL
             GROUP BY i.id
            HAVING count(DISTINCT l.local_user_id) >= 2
          ) AS ok
        `, [allowedCorpIds])
      }
    }
    if ((await tableExists('users')) && (await tableExists('user_login_aliases'))) {
      // Platform-admin identity is authoritative only through user_roles.role_id = admin.
      const hasRoles = await tableExists('user_roles')
      if (hasRoles) {
        result.password_capable_alias_admin_count = await countOrUnknown(`
          SELECT count(DISTINCT u.id)::int AS n
            FROM users u
            JOIN user_login_aliases a ON a.user_id = u.id
            JOIN user_roles ur ON ur.user_id = u.id AND ur.role_id = 'admin'
           WHERE u.is_active = TRUE
             AND COALESCE(u.local_password_set, TRUE) = TRUE
             AND COALESCE(u.activation_status, 'activated') = 'activated'
             AND u.password_hash IS NOT NULL
             AND length(trim(u.password_hash)) > 0
             AND u.password_hash NOT LIKE 'unusable:%'
        `)
      }
    }
    if (await tableExists('users')) {
      result.pending_user_count = await countOrUnknown(`
        SELECT count(*)::int AS n
          FROM users
         WHERE activation_status = 'pending_activation'
      `)
    }
    emit(result)
  } finally {
    try { await c.query('ROLLBACK') } catch { /* ignore */ }
    try { await c.end() } catch { /* ignore */ }
  }
})().catch(() => emit(unknown))
NODE
)"
  # Pipe the probe via stdin so docker compose exec does not need complex argv quoting.
  if ! out="$(
    (cd "$REPO_DIR" && "${COMPOSE[@]}" -f "$DEPLOY_COMPOSE_FILE" exec -T \
      -e "INVENTORY_ENV_APP_KEY_PRESENT=${env_app_key_present}" \
      -e "INVENTORY_ENV_APP_SECRET_PRESENT=${env_app_secret_present}" \
      -e "INVENTORY_ENV_AGENT_ID_PRESENT=${env_agent_id_present}" \
      backend node -) \
      <<<"$sql_probe" 2>/dev/null
  )"; then
    printf '%s' '{"active_dingtalk_integration_count":"unknown","active_corp_anchored_integration_count":"unknown","active_directory_account_count":"unknown","active_linked_local_user_count":"unknown","same_integration_two_linked_users_ready":"unknown","directory_uat_baseline_ready":"unknown","password_capable_alias_admin_count":"unknown","pending_user_count":"unknown","stored_app_key_present":"unknown","stored_app_secret_present":"unknown","stored_agent_id_present":"unknown","effective_app_credentials_ready":"unknown"}'
    return 0
  fi
  # Accept only a single JSON object line; otherwise fail closed.
  if ! printf '%s' "$out" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' >/dev/null 2>&1; then
    printf '%s' '{"active_dingtalk_integration_count":"unknown","active_corp_anchored_integration_count":"unknown","active_directory_account_count":"unknown","active_linked_local_user_count":"unknown","same_integration_two_linked_users_ready":"unknown","directory_uat_baseline_ready":"unknown","password_capable_alias_admin_count":"unknown","pending_user_count":"unknown","stored_app_key_present":"unknown","stored_app_secret_present":"unknown","stored_agent_id_present":"unknown","effective_app_credentials_ready":"unknown"}'
    return 0
  fi
  printf '%s' "$out"
}

tri_and() {
  # AND of true|false|unknown values. unknown propagates.
  local a="$1" b="$2" c="${3:-true}"
  if [[ "$a" == "unknown" || "$b" == "unknown" || "$c" == "unknown" ]]; then
    printf 'unknown'
    return 0
  fi
  if [[ "$a" == "true" && "$b" == "true" && "$c" == "true" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

tri_or() {
  local a="$1" b="$2"
  if [[ "$a" == "true" || "$b" == "true" ]]; then
    printf 'true'
    return 0
  fi
  if [[ "$a" == "unknown" || "$b" == "unknown" ]]; then
    printf 'unknown'
    return 0
  fi
  printf 'false'
}

json_get() {
  local json="$1" key="$2"
  printf '%s' "$json" | python3 -c 'import json,sys
try:
  d=json.loads(sys.stdin.read())
  v=d.get(sys.argv[1], "unknown")
  print("unknown" if v is None else v)
except Exception:
  print("unknown")' "$key" 2>/dev/null || printf 'unknown'
}

# --- main -------------------------------------------------------------------------
if [[ "${DINGTALK_PRODUCTION_READINESS_SOURCE_ONLY:-false}" == "true" ]]; then
  return 0 2>/dev/null || exit 0
fi

[[ -n "$OUTPUT_DIR" ]] || fail "OUTPUT_DIR is required"
[[ -d "$REPO_DIR" ]] || fail "DEPLOY_PATH missing: ${DEPLOY_PATH} (resolved: ${REPO_DIR})"
[[ -f "${REPO_DIR}/${DEPLOY_COMPOSE_FILE}" ]] || fail "compose file missing: ${REPO_DIR}/${DEPLOY_COMPOSE_FILE}"
require_compose
mkdir -p "$OUTPUT_DIR"

BACKEND_CONTAINER_ID="$(cd "$REPO_DIR" && "${COMPOSE[@]}" -f "$DEPLOY_COMPOSE_FILE" ps -q backend 2>/dev/null || true)"
if [[ -z "$BACKEND_CONTAINER_ID" ]] || ! docker inspect -f '{{.State.Running}}' "$BACKEND_CONTAINER_ID" 2>/dev/null | grep -qx 'true'; then
  fail "production backend service is not running"
fi

log "read-only inventory start run_stamp=${RUN_STAMP} repo=${REPO_DIR}"

resolve_deployed_sha

ENV_APP_KEY_PRESENT="$(env_present DINGTALK_APP_KEY DINGTALK_CLIENT_ID)"
ENV_APP_SECRET_PRESENT="$(env_present DINGTALK_APP_SECRET DINGTALK_CLIENT_SECRET)"
ENV_AGENT_ID_PRESENT="$(env_present DINGTALK_AGENT_ID DINGTALK_NOTIFY_AGENT_ID)"

STREAM_CLIENT_ID_PRESENT="$(env_present DINGTALK_INTERACTIVE_CARD_CLIENT_ID)"
STREAM_CLIENT_SECRET_PRESENT="$(env_present DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET)"
STREAM_TEMPLATE_ID_PRESENT="$(env_present DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID)"
STREAM_INTEGRATION_ID_PRESENT="$(env_present DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID)"
STREAM_BASE_READY="$(tri_and "$STREAM_CLIENT_ID_PRESENT" "$STREAM_CLIENT_SECRET_PRESENT" "$STREAM_TEMPLATE_ID_PRESENT")"
STREAM_CREDS_READY="$(tri_and "$STREAM_BASE_READY" "$STREAM_INTEGRATION_ID_PRESENT")"

classify_allowlist
classify_log_level

FLAG_ALIAS="$(flag_state_from_env AUTH_LOGIN_USE_ALIASES)"
FLAG_PENDING="$(flag_state_from_env DIRECTORY_PENDING_ACTIVATION_ENABLED)"
FLAG_DEPROVISION="$(flag_state_from_env DIRECTORY_DEPROVISION_ENABLED)"
FLAG_STREAM="$(flag_state_from_env DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED)"

# Exact OFF required for all four lifecycle/stream gates.
if [[ "$FLAG_ALIAS" == "false" && "$FLAG_PENDING" == "false" && "$FLAG_DEPROVISION" == "false" && "$FLAG_STREAM" == "false" ]]; then
  LIFECYCLE_FLAGS_ALL_OFF="true"
elif [[ "$FLAG_ALIAS" == "unknown" || "$FLAG_PENDING" == "unknown" || "$FLAG_DEPROVISION" == "unknown" || "$FLAG_STREAM" == "unknown" ]]; then
  LIFECYCLE_FLAGS_ALL_OFF="unknown"
else
  LIFECYCLE_FLAGS_ALL_OFF="false"
fi

SQL_JSON="$(run_sql_inventory "$ENV_APP_KEY_PRESENT" "$ENV_APP_SECRET_PRESENT" "$ENV_AGENT_ID_PRESENT")"
ACTIVE_INT_COUNT="$(json_get "$SQL_JSON" active_dingtalk_integration_count)"
ACTIVE_CORP_INT_COUNT="$(json_get "$SQL_JSON" active_corp_anchored_integration_count)"
ACTIVE_DIR_ACCT_COUNT="$(json_get "$SQL_JSON" active_directory_account_count)"
ACTIVE_LINKED_USER_COUNT="$(json_get "$SQL_JSON" active_linked_local_user_count)"
ALIAS_ADMIN_COUNT="$(json_get "$SQL_JSON" password_capable_alias_admin_count)"
PENDING_USER_COUNT="$(json_get "$SQL_JSON" pending_user_count)"
STORED_APP_KEY_PRESENT="$(json_get "$SQL_JSON" stored_app_key_present)"
STORED_APP_SECRET_PRESENT="$(json_get "$SQL_JSON" stored_app_secret_present)"
STORED_AGENT_ID_PRESENT="$(json_get "$SQL_JSON" stored_agent_id_present)"
APP_CREDS_READY="$(json_get "$SQL_JSON" effective_app_credentials_ready)"
AT_LEAST_TWO_LINKED="$(json_get "$SQL_JSON" same_integration_two_linked_users_ready)"
DIRECTORY_UAT_BASELINE_READY="$(json_get "$SQL_JSON" directory_uat_baseline_ready)"

APP_KEY_PRESENT="$(tri_or "$ENV_APP_KEY_PRESENT" "$STORED_APP_KEY_PRESENT")"
APP_SECRET_PRESENT="$(tri_or "$ENV_APP_SECRET_PRESENT" "$STORED_APP_SECRET_PRESENT")"
AGENT_ID_PRESENT="$(tri_or "$ENV_AGENT_ID_PRESENT" "$STORED_AGENT_ID_PRESENT")"

# STATUS ARTIFACT CONTRACT: closed booleans / counts / enum reasons / SHA only.
{
  echo "schema=dingtalk-production-readiness-inventory-v1"
  echo "run_stamp=${RUN_STAMP}"
  echo "deployed_sha=${DEPLOYED_SHA}"
  echo "deployed_sha_verified=${DEPLOYED_SHA_VERIFIED}"
  echo "app_key_present=${APP_KEY_PRESENT}"
  echo "app_secret_present=${APP_SECRET_PRESENT}"
  echo "agent_id_present=${AGENT_ID_PRESENT}"
  echo "app_credentials_ready=${APP_CREDS_READY}"
  echo "allowed_corp_allowlist_ready=${ALLOWLIST_READY}"
  echo "allowed_corp_allowlist_reason=${ALLOWLIST_REASON}"
  echo "active_dingtalk_integration_count=${ACTIVE_INT_COUNT}"
  echo "active_corp_anchored_integration_count=${ACTIVE_CORP_INT_COUNT}"
  echo "active_directory_account_count=${ACTIVE_DIR_ACCT_COUNT}"
  echo "active_linked_local_user_count=${ACTIVE_LINKED_USER_COUNT}"
  echo "password_capable_alias_admin_count=${ALIAS_ADMIN_COUNT}"
  echo "pending_user_count=${PENDING_USER_COUNT}"
  echo "at_least_two_linked_users_ready=${AT_LEAST_TWO_LINKED}"
  echo "directory_uat_baseline_ready=${DIRECTORY_UAT_BASELINE_READY}"
  echo "log_level_ready=${LOG_LEVEL_READY}"
  echo "log_level_reason=${LOG_LEVEL_REASON}"
  echo "stream_client_id_present=${STREAM_CLIENT_ID_PRESENT}"
  echo "stream_client_secret_present=${STREAM_CLIENT_SECRET_PRESENT}"
  echo "stream_template_id_present=${STREAM_TEMPLATE_ID_PRESENT}"
  echo "stream_integration_id_present=${STREAM_INTEGRATION_ID_PRESENT}"
  echo "stream_credentials_ready=${STREAM_CREDS_READY}"
  echo "auth_login_use_aliases=${FLAG_ALIAS}"
  echo "directory_pending_activation_enabled=${FLAG_PENDING}"
  echo "directory_deprovision_enabled=${FLAG_DEPROVISION}"
  echo "dingtalk_interactive_card_stream_enabled=${FLAG_STREAM}"
  echo "lifecycle_flags_all_off=${LIFECYCLE_FLAGS_ALL_OFF}"
  echo "read_only=true"
} > "${OUTPUT_DIR}/inventory.txt"

OUTPUT_DIR_FOR_JSON="${OUTPUT_DIR}" \
python3 - <<'PY'
import json
from pathlib import Path
import os

out_dir = Path(os.environ['OUTPUT_DIR_FOR_JSON'])
fields = {}
for line in (out_dir / 'inventory.txt').read_text(encoding='utf-8').splitlines():
    if '=' not in line:
        continue
    k, v = line.split('=', 1)
    fields[k] = v

def tri(v):
    if v == 'true':
        return True
    if v == 'false':
        return False
    return None

def count(v):
    if v is None or v == 'unknown':
        return None
    try:
        return int(v)
    except Exception:
        return None

report = {
    'schema': fields.get('schema', 'dingtalk-production-readiness-inventory-v1'),
    'run_stamp': fields.get('run_stamp', ''),
    'deployed_sha': fields.get('deployed_sha', 'unknown'),
    'deployed_sha_verified': tri(fields.get('deployed_sha_verified')),
    'read_only': True,
    'app_credentials': {
        'app_key_present': tri(fields.get('app_key_present')),
        'app_secret_present': tri(fields.get('app_secret_present')),
        'agent_id_present': tri(fields.get('agent_id_present')),
        'ready': tri(fields.get('app_credentials_ready')),
    },
    'allowed_corp_allowlist': {
        'ready': tri(fields.get('allowed_corp_allowlist_ready')),
        'reason': fields.get('allowed_corp_allowlist_reason', 'unknown'),
    },
    'counts': {
        'active_dingtalk_integration_count': count(fields.get('active_dingtalk_integration_count')),
        'active_corp_anchored_integration_count': count(fields.get('active_corp_anchored_integration_count')),
        'active_directory_account_count': count(fields.get('active_directory_account_count')),
        'active_linked_local_user_count': count(fields.get('active_linked_local_user_count')),
        'password_capable_alias_admin_count': count(fields.get('password_capable_alias_admin_count')),
        'pending_user_count': count(fields.get('pending_user_count')),
    },
    'at_least_two_linked_users_ready': tri(fields.get('at_least_two_linked_users_ready')),
    'directory_uat_baseline_ready': tri(fields.get('directory_uat_baseline_ready')),
    'log_level': {
        'ready': tri(fields.get('log_level_ready')),
        'reason': fields.get('log_level_reason', 'unknown'),
    },
    'stream': {
        'client_id_present': tri(fields.get('stream_client_id_present')),
        'client_secret_present': tri(fields.get('stream_client_secret_present')),
        'template_id_present': tri(fields.get('stream_template_id_present')),
        'integration_id_present': tri(fields.get('stream_integration_id_present')),
        'credentials_ready': tri(fields.get('stream_credentials_ready')),
    },
    'lifecycle_flags': {
        'auth_login_use_aliases': tri(fields.get('auth_login_use_aliases')),
        'directory_pending_activation_enabled': tri(fields.get('directory_pending_activation_enabled')),
        'directory_deprovision_enabled': tri(fields.get('directory_deprovision_enabled')),
        'dingtalk_interactive_card_stream_enabled': tri(fields.get('dingtalk_interactive_card_stream_enabled')),
        'all_off': tri(fields.get('lifecycle_flags_all_off')),
    },
}
(out_dir / 'inventory.json').write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + '\n',
    encoding='utf-8',
)
print(json.dumps({'ok': True, 'schema': report['schema'], 'deployed_sha': report['deployed_sha']}))
PY

log "inventory written to ${OUTPUT_DIR} (values-free; read_only=true)"
# Explicit non-mutating exit.
exit 0
