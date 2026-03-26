#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
EXPECT_PRODUCT_MODE="${EXPECT_PRODUCT_MODE:-platform}"
REQUIRE_DEPLOYMENT_MODEL="${REQUIRE_DEPLOYMENT_MODEL:-onprem}"
REQUIRE_STORAGE_DIRS="${REQUIRE_STORAGE_DIRS:-1}"
PREFLIGHT_REPORT_JSON="${PREFLIGHT_REPORT_JSON:-}"
PREFLIGHT_REPORT_MD="${PREFLIGHT_REPORT_MD:-}"
DEFAULT_PREFLIGHT_REPORT_JSON="/opt/metasheet/output/preflight/multitable-onprem-preflight.json"
DEFAULT_PREFLIGHT_REPORT_MD="/opt/metasheet/output/preflight/multitable-onprem-preflight.md"
REPAIR_HELPER_PATH="${OPS_DIR}/multitable-onprem-repair-helper.sh"

JWT_SECRET=""
POSTGRES_PASSWORD=""
DATABASE_URL=""
PRODUCT_MODE=""
DEPLOYMENT_MODEL=""
IMPORT_REQUIRE_TOKEN=""
IMPORT_UPLOAD_DIR=""
ATTACHMENT_PATH=""
ATTACHMENT_STORAGE_BASE_URL=""

function die() {
  write_report "FAIL" "$*"
  echo "[multitable-onprem-preflight] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[multitable-onprem-preflight] $*" >&2
}

function json_escape() {
  node -e "process.stdout.write(JSON.stringify(process.argv[1] ?? ''))" "${1:-}"
}

function write_text_file() {
  local file_path="$1"
  local content="$2"
  local tmp_path="${file_path}.tmp.$$"
  mkdir -p "$(dirname "$file_path")"
  printf '%s' "$content" > "$tmp_path"
  mv "$tmp_path" "$file_path"
}

function json_array_from_values() {
  if [[ "$#" -eq 0 ]]; then
    printf '[]'
    return 0
  fi
  local first="true"
  printf '['
  local item
  for item in "$@"; do
    if [[ "$first" == "true" ]]; then
      first="false"
    else
      printf ', '
    fi
    json_escape "$item"
  done
  printf ']'
}

function shell_escape() {
  printf '%q' "${1:-}"
}

function build_env_set_snippet() {
  local key="$1"
  local value="$2"
  local comment="$3"
  cat <<EOF
# ${comment}
TARGET_ENV_FILE="${ENV_FILE}"
python3 - <<'PY' "\${TARGET_ENV_FILE}" "${key}" "${value}"
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text().splitlines() if path.exists() else []

for index, line in enumerate(lines):
    if line.startswith(f"{key}="):
        lines[index] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")

path.write_text("\\n".join(lines) + "\\n")
PY
grep '^${key}=' "\${TARGET_ENV_FILE}"
EOF
}

function build_generated_secret_snippet() {
  local key="$1"
  local generator="$2"
  local comment="$3"
  cat <<EOF
# ${comment}
TARGET_ENV_FILE="${ENV_FILE}"
NEW_VALUE="\$(${generator})"
python3 - <<'PY' "\${TARGET_ENV_FILE}" "${key}" "\${NEW_VALUE}"
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text().splitlines() if path.exists() else []

for index, line in enumerate(lines):
    if line.startswith(f"{key}="):
        lines[index] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")

path.write_text("\\n".join(lines) + "\\n")
PY
grep '^${key}=' "\${TARGET_ENV_FILE}"
EOF
}

function build_directory_create_snippet() {
  local dir_path="$1"
  local comment="$2"
  cat <<EOF
# ${comment}
SERVICE_USER="\${SERVICE_USER:-metasheet}"
SERVICE_GROUP="\${SERVICE_GROUP:-metasheet}"
sudo mkdir -p "${dir_path}"
sudo chown "\${SERVICE_USER}:\${SERVICE_GROUP}" "${dir_path}"
sudo chmod 775 "${dir_path}"
ls -ld "${dir_path}"
EOF
}

function build_set_env_quick_command() {
  local key="$1"
  local value="$2"
  printf 'bash %s set-env --env-file %s --key %s --value %s' \
    "$(shell_escape "$REPAIR_HELPER_PATH")" \
    "$(shell_escape "$ENV_FILE")" \
    "$(shell_escape "$key")" \
    "$(shell_escape "$value")"
}

function build_generate_secret_quick_command() {
  local key="$1"
  printf 'bash %s generate-secret --env-file %s --key %s' \
    "$(shell_escape "$REPAIR_HELPER_PATH")" \
    "$(shell_escape "$ENV_FILE")" \
    "$(shell_escape "$key")"
}

function build_ensure_dir_quick_command() {
  local dir_path="$1"
  printf 'SERVICE_USER="${SERVICE_USER:-metasheet}" SERVICE_GROUP="${SERVICE_GROUP:-metasheet}" bash %s ensure-dir --dir %s --service-user "${SERVICE_USER}" --service-group "${SERVICE_GROUP}"' \
    "$(shell_escape "$REPAIR_HELPER_PATH")" \
    "$(shell_escape "$dir_path")"
}

function build_suggested_actions() {
  local status="$1"
  local error_message="${2:-}"
  local -a actions=()

  if [[ "$status" == "PASS" ]]; then
    return 0
  fi

  case "$error_message" in
    ENV_FILE\ not\ found:*)
      actions+=("Set ENV_FILE to the deployed app.env path, or place the expected app.env file on disk before rerunning preflight.")
      actions+=("Confirm the file is readable by the operator account on the target host.")
      ;;
    REQUIRE_STORAGE_DIRS\ must\ be\ 0\ or\ 1*)
      actions+=("Set REQUIRE_STORAGE_DIRS to 0 or 1 before rerunning multitable-onprem-preflight.sh.")
      ;;
    JWT_SECRET\ is\ missing*|JWT_SECRET\ is\ still\ \'change-me\'*)
      actions+=("Set a real JWT_SECRET in app.env and remove placeholder values such as change-me.")
      ;;
    POSTGRES_PASSWORD\ is\ missing*|POSTGRES_PASSWORD\ is\ still\ \'change-me\'*)
      actions+=("Set a real POSTGRES_PASSWORD in app.env and remove placeholder values such as change-me.")
      ;;
    DATABASE_URL\ is\ missing*|DATABASE_URL\ still\ contains\ \'change-me\'*)
      actions+=("Set DATABASE_URL to the real PostgreSQL connection string for the deployed environment.")
      ;;
    PRODUCT_MODE\ must\ be*)
      actions+=("Set PRODUCT_MODE=platform in app.env for the multitable on-prem package.")
      ;;
    DEPLOYMENT_MODEL\ must\ be*)
      actions+=("Set DEPLOYMENT_MODEL=onprem in app.env for the on-prem package.")
      ;;
    ATTENDANCE_IMPORT_REQUIRE_TOKEN\ must\ be\ 1*)
      actions+=("Set ATTENDANCE_IMPORT_REQUIRE_TOKEN=1 in app.env before rerunning preflight.")
      ;;
    ATTENDANCE_IMPORT_UPLOAD_DIR\ is\ missing*)
      actions+=("Set ATTENDANCE_IMPORT_UPLOAD_DIR to an absolute path in app.env.")
      ;;
    ATTACHMENT_PATH\ is\ missing*)
      actions+=("Set ATTACHMENT_PATH to an absolute path in app.env.")
      ;;
    ATTENDANCE_IMPORT_UPLOAD_DIR\ must\ be\ an\ absolute\ path*)
      actions+=("Change ATTENDANCE_IMPORT_UPLOAD_DIR to an absolute path on the target host.")
      ;;
    ATTACHMENT_PATH\ must\ be\ an\ absolute\ path*)
      actions+=("Change ATTACHMENT_PATH to an absolute path on the target host.")
      ;;
    ATTACHMENT_STORAGE_BASE_URL\ is\ missing*)
      actions+=("Set ATTACHMENT_STORAGE_BASE_URL to the externally reachable attachment base URL.")
      ;;
    ATTACHMENT_STORAGE_BASE_URL\ must\ start\ with\ http://\ or\ https://*)
      actions+=("Set ATTACHMENT_STORAGE_BASE_URL to a full http:// or https:// URL.")
      ;;
    ATTENDANCE_IMPORT_UPLOAD_DIR\ does\ not\ exist\ on\ disk:*)
      actions+=("Create the ATTENDANCE_IMPORT_UPLOAD_DIR directory on disk or point the env var to an existing directory.")
      actions+=("Verify the service account can read and write the import directory.")
      ;;
    ATTACHMENT_PATH\ does\ not\ exist\ on\ disk:*)
      actions+=("Create the ATTACHMENT_PATH directory on disk or point the env var to an existing directory.")
      actions+=("Verify the service account can read and write the attachment directory.")
      ;;
  esac

  actions+=("Rerun multitable-onprem-preflight.sh after fixing the environment and return both the refreshed json and markdown reports.")
  printf '%s\n' "${actions[@]}"
}

function build_suggested_command_snippets() {
  local status="$1"
  local error_message="${2:-}"
  local import_dir_fallback="${IMPORT_UPLOAD_DIR:-/opt/metasheet/storage/attendance-import}"
  local attachment_dir_fallback="${ATTACHMENT_PATH:-/opt/metasheet/storage/attachments}"
  local attachment_base_url_fallback="${ATTACHMENT_STORAGE_BASE_URL:-https://files.example.com/uploads}"

  if [[ "$status" == "PASS" ]]; then
    return 0
  fi

  case "$error_message" in
    ENV_FILE\ not\ found:*)
      printf '%s\0' "$(cat <<EOF
# Point ENV_FILE at the deployed app.env before rerunning preflight
export ENV_FILE="/absolute/path/to/app.env"
test -f "\${ENV_FILE}" && printf 'Using %s\n' "\${ENV_FILE}"
EOF
)"
      ;;
    REQUIRE_STORAGE_DIRS\ must\ be\ 0\ or\ 1*)
      printf '%s\0' "$(cat <<EOF
# Reset REQUIRE_STORAGE_DIRS to a supported value before rerunning preflight
export REQUIRE_STORAGE_DIRS=1
printf 'REQUIRE_STORAGE_DIRS=%s\n' "\${REQUIRE_STORAGE_DIRS}"
EOF
)"
      ;;
    JWT_SECRET\ is\ missing*|JWT_SECRET\ is\ still\ \'change-me\'*)
      printf '%s\0' "$(build_generated_secret_snippet "JWT_SECRET" "openssl rand -hex 32" "Generate and persist a strong JWT secret")"
      ;;
    POSTGRES_PASSWORD\ is\ missing*|POSTGRES_PASSWORD\ is\ still\ \'change-me\'*)
      printf '%s\0' "$(build_env_set_snippet "POSTGRES_PASSWORD" "replace-with-real-db-password" "Write the real PostgreSQL password into app.env")"
      ;;
    DATABASE_URL\ is\ missing*|DATABASE_URL\ still\ contains\ \'change-me\'*)
      printf '%s\0' "$(build_env_set_snippet "DATABASE_URL" "postgresql://metasheet:replace-with-real-db-password@127.0.0.1:5432/metasheet" "Write the real DATABASE_URL into app.env")"
      ;;
    PRODUCT_MODE\ must\ be*)
      printf '%s\0' "$(build_env_set_snippet "PRODUCT_MODE" "${EXPECT_PRODUCT_MODE}" "Align PRODUCT_MODE with the multitable on-prem package")"
      ;;
    DEPLOYMENT_MODEL\ must\ be*)
      printf '%s\0' "$(build_env_set_snippet "DEPLOYMENT_MODEL" "${REQUIRE_DEPLOYMENT_MODEL}" "Align DEPLOYMENT_MODEL with the on-prem package")"
      ;;
    ATTENDANCE_IMPORT_REQUIRE_TOKEN\ must\ be\ 1*)
      printf '%s\0' "$(build_env_set_snippet "ATTENDANCE_IMPORT_REQUIRE_TOKEN" "1" "Force attendance import token validation on the deployed host")"
      ;;
    ATTENDANCE_IMPORT_UPLOAD_DIR\ is\ missing*)
      printf '%s\0' "$(build_env_set_snippet "ATTENDANCE_IMPORT_UPLOAD_DIR" "${import_dir_fallback}" "Set ATTENDANCE_IMPORT_UPLOAD_DIR to an absolute storage path")"
      printf '%s\0' "$(build_directory_create_snippet "${import_dir_fallback}" "Create the import upload directory and align ownership")"
      ;;
    ATTACHMENT_PATH\ is\ missing*)
      printf '%s\0' "$(build_env_set_snippet "ATTACHMENT_PATH" "${attachment_dir_fallback}" "Set ATTACHMENT_PATH to an absolute storage path")"
      printf '%s\0' "$(build_directory_create_snippet "${attachment_dir_fallback}" "Create the attachment storage directory and align ownership")"
      ;;
    ATTENDANCE_IMPORT_UPLOAD_DIR\ must\ be\ an\ absolute\ path*)
      printf '%s\0' "$(build_env_set_snippet "ATTENDANCE_IMPORT_UPLOAD_DIR" "${import_dir_fallback}" "Rewrite ATTENDANCE_IMPORT_UPLOAD_DIR as an absolute path")"
      ;;
    ATTACHMENT_PATH\ must\ be\ an\ absolute\ path*)
      printf '%s\0' "$(build_env_set_snippet "ATTACHMENT_PATH" "${attachment_dir_fallback}" "Rewrite ATTACHMENT_PATH as an absolute path")"
      ;;
    ATTACHMENT_STORAGE_BASE_URL\ is\ missing*)
      printf '%s\0' "$(build_env_set_snippet "ATTACHMENT_STORAGE_BASE_URL" "${attachment_base_url_fallback}" "Set ATTACHMENT_STORAGE_BASE_URL to the externally reachable base URL")"
      ;;
    ATTACHMENT_STORAGE_BASE_URL\ must\ start\ with\ http://\ or\ https://*)
      printf '%s\0' "$(build_env_set_snippet "ATTACHMENT_STORAGE_BASE_URL" "${attachment_base_url_fallback}" "Rewrite ATTACHMENT_STORAGE_BASE_URL as a full http(s) URL")"
      ;;
    ATTENDANCE_IMPORT_UPLOAD_DIR\ does\ not\ exist\ on\ disk:*)
      printf '%s\0' "$(build_directory_create_snippet "${import_dir_fallback}" "Create the missing import upload directory and align ownership")"
      ;;
    ATTACHMENT_PATH\ does\ not\ exist\ on\ disk:*)
      printf '%s\0' "$(build_directory_create_snippet "${attachment_dir_fallback}" "Create the missing attachment storage directory and align ownership")"
      ;;
  esac
}

function build_suggested_quick_fix_commands() {
  local status="$1"
  local error_message="${2:-}"
  local import_dir_fallback="${IMPORT_UPLOAD_DIR:-/opt/metasheet/storage/attendance-import}"
  local attachment_dir_fallback="${ATTACHMENT_PATH:-/opt/metasheet/storage/attachments}"
  local attachment_base_url_fallback="${ATTACHMENT_STORAGE_BASE_URL:-https://files.example.com/uploads}"

  if [[ "$status" == "PASS" ]]; then
    return 0
  fi

  case "$error_message" in
    ENV_FILE\ not\ found:*)
      printf '%s\n' "export ENV_FILE=/absolute/path/to/app.env && test -f \"\$ENV_FILE\" && printf 'Using %s\n' \"\$ENV_FILE\""
      ;;
    REQUIRE_STORAGE_DIRS\ must\ be\ 0\ or\ 1*)
      printf '%s\n' "export REQUIRE_STORAGE_DIRS=1 && printf 'REQUIRE_STORAGE_DIRS=%s\n' \"\$REQUIRE_STORAGE_DIRS\""
      ;;
    JWT_SECRET\ is\ missing*|JWT_SECRET\ is\ still\ \'change-me\'*)
      printf '%s\n' "$(build_generate_secret_quick_command "JWT_SECRET")"
      ;;
    POSTGRES_PASSWORD\ is\ missing*|POSTGRES_PASSWORD\ is\ still\ \'change-me\'*)
      printf '%s\n' "$(build_set_env_quick_command "POSTGRES_PASSWORD" "replace-with-real-db-password")"
      ;;
    DATABASE_URL\ is\ missing*|DATABASE_URL\ still\ contains\ \'change-me\'*)
      printf '%s\n' "$(build_set_env_quick_command "DATABASE_URL" "postgresql://metasheet:replace-with-real-db-password@127.0.0.1:5432/metasheet")"
      ;;
    PRODUCT_MODE\ must\ be*)
      printf '%s\n' "$(build_set_env_quick_command "PRODUCT_MODE" "${EXPECT_PRODUCT_MODE}")"
      ;;
    DEPLOYMENT_MODEL\ must\ be*)
      printf '%s\n' "$(build_set_env_quick_command "DEPLOYMENT_MODEL" "${REQUIRE_DEPLOYMENT_MODEL}")"
      ;;
    ATTENDANCE_IMPORT_REQUIRE_TOKEN\ must\ be\ 1*)
      printf '%s\n' "$(build_set_env_quick_command "ATTENDANCE_IMPORT_REQUIRE_TOKEN" "1")"
      ;;
    ATTENDANCE_IMPORT_UPLOAD_DIR\ is\ missing*|ATTENDANCE_IMPORT_UPLOAD_DIR\ must\ be\ an\ absolute\ path*)
      printf '%s\n' "$(build_set_env_quick_command "ATTENDANCE_IMPORT_UPLOAD_DIR" "${import_dir_fallback}")"
      printf '%s\n' "$(build_ensure_dir_quick_command "${import_dir_fallback}")"
      ;;
    ATTACHMENT_PATH\ is\ missing*|ATTACHMENT_PATH\ must\ be\ an\ absolute\ path*)
      printf '%s\n' "$(build_set_env_quick_command "ATTACHMENT_PATH" "${attachment_dir_fallback}")"
      printf '%s\n' "$(build_ensure_dir_quick_command "${attachment_dir_fallback}")"
      ;;
    ATTACHMENT_STORAGE_BASE_URL\ is\ missing*|ATTACHMENT_STORAGE_BASE_URL\ must\ start\ with\ http://\ or\ https://*)
      printf '%s\n' "$(build_set_env_quick_command "ATTACHMENT_STORAGE_BASE_URL" "${attachment_base_url_fallback}")"
      ;;
    ATTENDANCE_IMPORT_UPLOAD_DIR\ does\ not\ exist\ on\ disk:*)
      printf '%s\n' "$(build_ensure_dir_quick_command "${import_dir_fallback}")"
      ;;
    ATTACHMENT_PATH\ does\ not\ exist\ on\ disk:*)
      printf '%s\n' "$(build_ensure_dir_quick_command "${attachment_dir_fallback}")"
      ;;
  esac
}

function write_report() {
  local status="$1"
  local error_message="${2:-}"
  local ok="false"
  local generated_at
  local signoff_report_json
  local signoff_report_md
  local signoff_message
  local -a suggested_actions=()
  local -a suggested_quick_fix_commands=()
  local -a suggested_command_snippets=()
  local extra_md_sections=""
  local suggested_actions_json="[]"
  local suggested_quick_fix_commands_json="[]"
  local suggested_command_snippets_json="[]"
  if [[ "$status" == "PASS" ]]; then
    ok="true"
  fi
  generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  signoff_report_json="${PREFLIGHT_REPORT_JSON:-$DEFAULT_PREFLIGHT_REPORT_JSON}"
  signoff_report_md="${PREFLIGHT_REPORT_MD:-$DEFAULT_PREFLIGHT_REPORT_MD}"
  signoff_message="Return this preflight json and markdown pair before checkpoint, UAT, customer delivery, or final sign-off."
  while IFS= read -r action; do
    [[ -n "$action" ]] || continue
    suggested_actions+=("$action")
  done < <(build_suggested_actions "$status" "$error_message")
  if [[ "${#suggested_actions[@]}" -gt 0 ]]; then
    suggested_actions_json="$(json_array_from_values "${suggested_actions[@]}")"
    local action
    local suggested_actions_md=""
    for action in "${suggested_actions[@]}"; do
      suggested_actions_md+="- ${action}"$'\n'
    done
    extra_md_sections+=$'\n## Suggested Actions\n\n'"${suggested_actions_md}"
  fi
  while IFS= read -r quick_command; do
    [[ -n "$quick_command" ]] || continue
    suggested_quick_fix_commands+=("$quick_command")
  done < <(build_suggested_quick_fix_commands "$status" "$error_message")
  if [[ "${#suggested_quick_fix_commands[@]}" -gt 0 ]]; then
    suggested_quick_fix_commands_json="$(json_array_from_values "${suggested_quick_fix_commands[@]}")"
    local quick_command
    extra_md_sections+=$'\n## One-Line Quick Fix Commands\n'
    for quick_command in "${suggested_quick_fix_commands[@]}"; do
      extra_md_sections+=$'\n```bash\n'"${quick_command}"$'\n```\n'
    done
  fi
  while IFS= read -r -d '' snippet; do
    [[ -n "$snippet" ]] || continue
    suggested_command_snippets+=("$snippet")
  done < <(build_suggested_command_snippets "$status" "$error_message")
  if [[ "${#suggested_command_snippets[@]}" -gt 0 ]]; then
    suggested_command_snippets_json="$(json_array_from_values "${suggested_command_snippets[@]}")"
    local snippet_index=1
    local snippet
    extra_md_sections+=$'\n## Copyable Command Snippets\n'
    for snippet in "${suggested_command_snippets[@]}"; do
      extra_md_sections+=$'\n### Snippet '"${snippet_index}"$'\n\n```bash\n'"${snippet}"$'\n```\n'
      snippet_index=$((snippet_index + 1))
    done
  fi

  if [[ -n "$PREFLIGHT_REPORT_JSON" ]]; then
    local json_content
    json_content="$(
      cat <<EOF
{
  "ok": ${ok},
  "status": $(json_escape "$status"),
  "reportRole": "signoff-evidence",
  "signoffEvidence": {
    "required": true,
    "message": $(json_escape "$signoff_message"),
    "preflightReportJson": $(json_escape "$signoff_report_json"),
    "preflightReportMd": $(json_escape "$signoff_report_md")
  },
  "suggestedActions": ${suggested_actions_json},
  "suggestedQuickFixCommands": ${suggested_quick_fix_commands_json},
  "suggestedCommandSnippets": ${suggested_command_snippets_json},
  "error": $(json_escape "$error_message"),
  "envFile": $(json_escape "$ENV_FILE"),
  "expectedProductMode": $(json_escape "$EXPECT_PRODUCT_MODE"),
  "deploymentModel": $(json_escape "$DEPLOYMENT_MODEL"),
  "requireStorageDirs": $(json_escape "$REQUIRE_STORAGE_DIRS"),
  "importUploadDir": $(json_escape "$IMPORT_UPLOAD_DIR"),
  "attachmentPath": $(json_escape "$ATTACHMENT_PATH"),
  "attachmentStorageBaseUrl": $(json_escape "$ATTACHMENT_STORAGE_BASE_URL"),
  "reportPaths": {
    "json": $(json_escape "$signoff_report_json"),
    "markdown": $(json_escape "$signoff_report_md")
  },
  "generatedAt": $(json_escape "$generated_at")
}
EOF
    )"
    write_text_file "$PREFLIGHT_REPORT_JSON" "${json_content}"$'\n'
  fi

  if [[ -n "$PREFLIGHT_REPORT_MD" ]]; then
    local md_content
    md_content="$(
      cat <<EOF
# Multitable On-Prem Preflight

- Overall: **${status}**
- Env file: \`${ENV_FILE}\`
- Expected product mode: \`${EXPECT_PRODUCT_MODE}\`
- Deployment model: \`${DEPLOYMENT_MODEL:-<empty>}\`
- Storage dirs required: \`${REQUIRE_STORAGE_DIRS}\`
- Import upload dir: \`${IMPORT_UPLOAD_DIR:-<empty>}\`
- Attachment path: \`${ATTACHMENT_PATH:-<empty>}\`
- Attachment base URL: \`${ATTACHMENT_STORAGE_BASE_URL:-<empty>}\`
- Generated at: \`${generated_at}\`

## Sign-Off Evidence

- This report is sign-off evidence for multitable on-prem delivery and pilot rollout.
- Return \`${signoff_report_json}\` and \`${signoff_report_md}\` before checkpoint, UAT, customer delivery, or final sign-off.
$(printf '%s' "$extra_md_sections")

## Result

- Error: ${error_message:-none}
EOF
    )"
    write_text_file "$PREFLIGHT_REPORT_MD" "${md_content}"$'\n'
  fi
}

function get_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo ""
    return 0
  fi
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  echo "${line#${key}=}"
}

function strip_quotes() {
  local value="$1"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    echo "${value:1:${#value}-2}"
    return 0
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    echo "${value:1:${#value}-2}"
    return 0
  fi
  echo "$value"
}

function require_nonempty_env() {
  local key="$1"
  local value="$2"
  [[ -n "$value" ]] || die "${key} is missing in ${ENV_FILE}"
  [[ "$value" != "change-me" ]] || die "${key} is still 'change-me' in ${ENV_FILE}"
}

function require_absolute_path_env() {
  local key="$1"
  local value="$2"
  [[ -n "$value" ]] || die "${key} is missing in ${ENV_FILE}"
  [[ "$value" == /* ]] || die "${key} must be an absolute path (got: '${value}')"
}

[[ -f "$ENV_FILE" ]] || die "ENV_FILE not found: ${ENV_FILE}"
[[ "$REQUIRE_STORAGE_DIRS" == "0" || "$REQUIRE_STORAGE_DIRS" == "1" ]] || die "REQUIRE_STORAGE_DIRS must be 0 or 1"

JWT_SECRET="$(strip_quotes "$(get_env_value JWT_SECRET)")"
POSTGRES_PASSWORD="$(strip_quotes "$(get_env_value POSTGRES_PASSWORD)")"
DATABASE_URL="$(strip_quotes "$(get_env_value DATABASE_URL)")"
PRODUCT_MODE="$(strip_quotes "$(get_env_value PRODUCT_MODE)")"
DEPLOYMENT_MODEL="$(strip_quotes "$(get_env_value DEPLOYMENT_MODEL)")"
IMPORT_REQUIRE_TOKEN="$(strip_quotes "$(get_env_value ATTENDANCE_IMPORT_REQUIRE_TOKEN)")"
IMPORT_UPLOAD_DIR="$(strip_quotes "$(get_env_value ATTENDANCE_IMPORT_UPLOAD_DIR)")"
ATTACHMENT_PATH="$(strip_quotes "$(get_env_value ATTACHMENT_PATH)")"
ATTACHMENT_STORAGE_BASE_URL="$(strip_quotes "$(get_env_value ATTACHMENT_STORAGE_BASE_URL)")"

require_nonempty_env "JWT_SECRET" "$JWT_SECRET"
require_nonempty_env "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD"
require_nonempty_env "DATABASE_URL" "$DATABASE_URL"

if [[ "$DATABASE_URL" == *"change-me"* ]]; then
  die "DATABASE_URL still contains 'change-me' in ${ENV_FILE}"
fi

if [[ -n "$EXPECT_PRODUCT_MODE" && "$PRODUCT_MODE" != "$EXPECT_PRODUCT_MODE" ]]; then
  die "PRODUCT_MODE must be '${EXPECT_PRODUCT_MODE}' for multitable on-prem (got: '${PRODUCT_MODE:-<empty>}')"
fi

if [[ -n "$REQUIRE_DEPLOYMENT_MODEL" && "$DEPLOYMENT_MODEL" != "$REQUIRE_DEPLOYMENT_MODEL" ]]; then
  die "DEPLOYMENT_MODEL must be '${REQUIRE_DEPLOYMENT_MODEL}' for this package (got: '${DEPLOYMENT_MODEL:-<empty>}')"
fi

if [[ "$IMPORT_REQUIRE_TOKEN" != "1" ]]; then
  die "ATTENDANCE_IMPORT_REQUIRE_TOKEN must be 1 for production"
fi

require_absolute_path_env "ATTENDANCE_IMPORT_UPLOAD_DIR" "$IMPORT_UPLOAD_DIR"
require_absolute_path_env "ATTACHMENT_PATH" "$ATTACHMENT_PATH"

[[ -n "$ATTACHMENT_STORAGE_BASE_URL" ]] || die "ATTACHMENT_STORAGE_BASE_URL is missing in ${ENV_FILE}"
if [[ ! "$ATTACHMENT_STORAGE_BASE_URL" =~ ^https?:// ]]; then
  die "ATTACHMENT_STORAGE_BASE_URL must start with http:// or https:// (got: '${ATTACHMENT_STORAGE_BASE_URL}')"
fi

if [[ "$REQUIRE_STORAGE_DIRS" == "1" ]]; then
  [[ -d "$IMPORT_UPLOAD_DIR" ]] || die "ATTENDANCE_IMPORT_UPLOAD_DIR does not exist on disk: ${IMPORT_UPLOAD_DIR}"
  [[ -d "$ATTACHMENT_PATH" ]] || die "ATTACHMENT_PATH does not exist on disk: ${ATTACHMENT_PATH}"
fi

info "Env file: ${ENV_FILE}"
info "Import upload dir: ${IMPORT_UPLOAD_DIR}"
info "Attachment path: ${ATTACHMENT_PATH}"
info "Attachment base URL: ${ATTACHMENT_STORAGE_BASE_URL}"
if [[ -n "$PREFLIGHT_REPORT_JSON" ]]; then
  info "Preflight report JSON: ${PREFLIGHT_REPORT_JSON}"
fi
if [[ -n "$PREFLIGHT_REPORT_MD" ]]; then
  info "Preflight report Markdown: ${PREFLIGHT_REPORT_MD}"
fi
write_report "PASS" ""
info "Preflight OK"
