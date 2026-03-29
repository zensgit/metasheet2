#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." 2>/dev/null && pwd || pwd)"

HOST="${HOST:-142.171.239.56}"
USER_NAME="${USER_NAME:-mainuser}"
IDENTITY_FILE="${IDENTITY_FILE:-${HOME}/.ssh/metasheet2_deploy}"
TARGET_DIR="${TARGET_DIR:-/home/mainuser/metasheet2-git-baseline}"
DEPLOY_DIR="${DEPLOY_DIR:-/home/mainuser/metasheet2}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-}"
SLICE_NAME="${SLICE_NAME:-directory-migration-baseline}"
PUBLISH_MANIFEST="${PUBLISH_MANIFEST:-}"
REMOTE_BRANCH="${REMOTE_BRANCH:-}"
VERIFY_MODE="${VERIFY_MODE:-0}"
JSON_OUTPUT="${JSON_OUTPUT:-0}"
KEEP_REMOTE_WORK_DIR="${KEEP_REMOTE_WORK_DIR:-0}"
LOCAL_OUTPUT_DIR="${LOCAL_OUTPUT_DIR:-}"
REMOTE_WORK_ROOT="${REMOTE_WORK_ROOT:-/home/mainuser/deliver-runs}"

die() {
  echo "[deliver-remote-git-slice] ERROR: $*" >&2
  exit 1
}

is_config_lock_output() {
  local output="${1:-}"
  [[ "${output}" == *"could not lock config file .git/config: File exists"* ]]
}

run_bootstrap_json() {
  local attempt=0
  local max_attempts=4

  while true; do
    local output
    if output="$(
      bash "${REPO_ROOT}/scripts/ops/bootstrap-remote-git-baseline.sh" \
        --host "${HOST}" \
        --user "${USER_NAME}" \
        --identity-file "${IDENTITY_FILE}" \
        --repo-url "${REPO_URL}" \
        --branch "${BRANCH}" \
        --target-dir "${TARGET_DIR}" \
        --deploy-dir "${DEPLOY_DIR}" \
        --json 2>&1
    )"; then
      printf '%s\n' "${output}"
      return 0
    fi

    if [[ ${attempt} -ge ${max_attempts} ]] || ! is_config_lock_output "${output}"; then
      printf '%s\n' "${output}" >&2
      return 1
    fi

    attempt=$((attempt + 1))
    sleep 1
  done
}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/ops/deliver-remote-git-slice.sh [options]

Options:
  --host <host>                Remote host. Default: 142.171.239.56
  --user <name>                Remote user. Default: mainuser
  --identity-file <path>       SSH identity file. Default: ~/.ssh/metasheet2_deploy
  --repo-url <url>             Git remote URL. Default: local origin fetch URL
  --branch <name>              Remote branch to track. Default: local upstream branch name
  --target-dir <path>          Remote Git baseline directory. Default: /home/mainuser/metasheet2-git-baseline
  --deploy-dir <path>          Existing deployed directory for comparison. Default: /home/mainuser/metasheet2
  --slice <name>               Slice name. Default: directory-migration-baseline
  --publish-manifest <path>    Local publish manifest. Default: output/remote-git-slice-publishes/<slice>/publish/artifacts/manifest.json
  --remote-branch <name>       Override remote branch name
  --verify                     Run remote deliver in verify mode
  --keep-remote-work-dir       Keep the remote temp work dir after fetching artifacts
  --local-output-dir <path>    Local artifact output dir. Default: output/remote-git-slice-deliveries/<slice>/<verify|deliver>
  --remote-work-root <path>    Remote temp work root. Default: /home/mainuser/deliver-runs
  --json                       Print JSON result
  --help, -h                   Show help
EOF
}

run_local_git() {
  git -C "${REPO_ROOT}" "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --user)
      USER_NAME="${2:-}"
      shift 2
      ;;
    --identity-file)
      IDENTITY_FILE="${2:-}"
      shift 2
      ;;
    --repo-url)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --target-dir)
      TARGET_DIR="${2:-}"
      shift 2
      ;;
    --deploy-dir)
      DEPLOY_DIR="${2:-}"
      shift 2
      ;;
    --slice)
      SLICE_NAME="${2:-}"
      shift 2
      ;;
    --publish-manifest)
      PUBLISH_MANIFEST="${2:-}"
      shift 2
      ;;
    --remote-branch)
      REMOTE_BRANCH="${2:-}"
      shift 2
      ;;
    --verify)
      VERIFY_MODE="1"
      shift 1
      ;;
    --keep-remote-work-dir)
      KEEP_REMOTE_WORK_DIR="1"
      shift 1
      ;;
    --local-output-dir)
      LOCAL_OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --remote-work-root)
      REMOTE_WORK_ROOT="${2:-}"
      shift 2
      ;;
    --json)
      JSON_OUTPUT="1"
      shift 1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

if [[ -z "${REPO_URL}" ]]; then
  REPO_URL="$(run_local_git remote get-url origin 2>/dev/null || true)"
fi

if [[ -z "${BRANCH}" ]]; then
  UPSTREAM_BRANCH="$(run_local_git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || true)"
  BRANCH="${UPSTREAM_BRANCH#origin/}"
fi

if [[ -z "${PUBLISH_MANIFEST}" ]]; then
  PUBLISH_MANIFEST="${REPO_ROOT}/output/remote-git-slice-publishes/${SLICE_NAME}/publish/artifacts/manifest.json"
fi

[[ -n "${REPO_URL}" ]] || die "Unable to determine repo URL. Pass --repo-url explicitly."
[[ -n "${BRANCH}" ]] || die "Unable to determine branch. Pass --branch explicitly."
[[ -f "${IDENTITY_FILE}" ]] || die "Identity file not found: ${IDENTITY_FILE}"
[[ -f "${PUBLISH_MANIFEST}" ]] || die "Publish manifest not found: ${PUBLISH_MANIFEST}"

MODE_NAME="deliver"
if [[ "${VERIFY_MODE}" == "1" ]]; then
  MODE_NAME="verify"
fi

if [[ -z "${LOCAL_OUTPUT_DIR}" ]]; then
  LOCAL_OUTPUT_DIR="${REPO_ROOT}/output/remote-git-slice-deliveries/${SLICE_NAME}/${MODE_NAME}"
fi

SSH_TARGET="${USER_NAME}@${HOST}"
SSH_OPTS=(-i "${IDENTITY_FILE}" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no)

LOCAL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/remote-git-slice-deliver-XXXXXX")"
cleanup_local() {
  rm -rf "${LOCAL_TMP}"
}
trap cleanup_local EXIT

BOOTSTRAP_JSON_PATH="${LOCAL_TMP}/bootstrap.json"
run_bootstrap_json > "${BOOTSTRAP_JSON_PATH}"

PAYLOAD_DIR="${LOCAL_TMP}/payload"
SCRIPTS_DIR="${PAYLOAD_DIR}/scripts/ops"
MANIFEST_DIR="${PAYLOAD_DIR}/manifests"
mkdir -p "${SCRIPTS_DIR}" "${MANIFEST_DIR}"

cp "${REPO_ROOT}/scripts/ops/git-slice-deliver.mjs" "${SCRIPTS_DIR}/git-slice-deliver.mjs"
cp "${REPO_ROOT}/scripts/ops/git-slices.mjs" "${SCRIPTS_DIR}/git-slices.mjs"
cp "${PUBLISH_MANIFEST}" "${MANIFEST_DIR}/publish.json"

PAYLOAD_ARCHIVE="${LOCAL_TMP}/payload.tar.gz"
COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --format ustar -C "${PAYLOAD_DIR}" -czf "${PAYLOAD_ARCHIVE}" .

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
REMOTE_WORK_DIR="${REMOTE_WORK_ROOT%/}/${SLICE_NAME}-${MODE_NAME}-${RUN_ID}"

ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "mkdir -p $(printf '%q' "${REMOTE_WORK_DIR}")"
scp "${SSH_OPTS[@]}" "${PAYLOAD_ARCHIVE}" "${SSH_TARGET}:$(printf '%q' "${REMOTE_WORK_DIR}/payload.tar.gz")" >/dev/null

REMOTE_STATUS=0
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" \
  env \
    REMOTE_SLICE="${SLICE_NAME}" \
    REMOTE_TARGET_DIR="${TARGET_DIR}" \
    REMOTE_WORK_DIR="${REMOTE_WORK_DIR}" \
    REMOTE_VERIFY="${VERIFY_MODE}" \
    REMOTE_REPO_URL="${REPO_URL}" \
    REMOTE_REMOTE_BRANCH="${REMOTE_BRANCH}" \
    bash -s <<'EOF' || REMOTE_STATUS=$?
set -euo pipefail

SLICE_NAME="${REMOTE_SLICE}"
TARGET_DIR="${REMOTE_TARGET_DIR}"
WORK_DIR="${REMOTE_WORK_DIR}"
VERIFY_MODE="${REMOTE_VERIFY}"
REPO_URL="${REMOTE_REPO_URL}"
REMOTE_BRANCH="${REMOTE_REMOTE_BRANCH}"

mkdir -p "${WORK_DIR}/payload"
tar -xzf "${WORK_DIR}/payload.tar.gz" -C "${WORK_DIR}/payload"

cd "${TARGET_DIR}"

ARGS=(
  node "${WORK_DIR}/payload/scripts/ops/git-slice-deliver.mjs"
  --slice "${SLICE_NAME}"
  --publish-manifest "${WORK_DIR}/payload/manifests/publish.json"
  --repo-url "${REPO_URL}"
  --output-dir "${WORK_DIR}/artifacts"
  --json
)

if [[ -n "${REMOTE_BRANCH}" ]]; then
  ARGS+=(--remote-branch "${REMOTE_BRANCH}")
fi

if [[ "${VERIFY_MODE}" == "1" ]]; then
  ARGS+=(--verify)
fi

"${ARGS[@]}" > "${WORK_DIR}/report.json"
EOF

if [[ "${REMOTE_STATUS}" -ne 0 ]]; then
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "if [ -f $(printf '%q' "${REMOTE_WORK_DIR}/report.json") ]; then cat $(printf '%q' "${REMOTE_WORK_DIR}/report.json"); fi" || true
  [[ "${KEEP_REMOTE_WORK_DIR}" == "1" ]] || ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "rm -rf $(printf '%q' "${REMOTE_WORK_DIR}")" >/dev/null 2>&1 || true
  exit "${REMOTE_STATUS}"
fi

mkdir -p "${LOCAL_OUTPUT_DIR}/artifacts"
scp "${SSH_OPTS[@]}" "${SSH_TARGET}:$(printf '%q' "${REMOTE_WORK_DIR}/report.json")" "${LOCAL_OUTPUT_DIR}/report.json" >/dev/null
ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "tar -C $(printf '%q' "${REMOTE_WORK_DIR}/artifacts") -czf $(printf '%q' "${REMOTE_WORK_DIR}/artifacts.tar.gz") ." >/dev/null
scp "${SSH_OPTS[@]}" "${SSH_TARGET}:$(printf '%q' "${REMOTE_WORK_DIR}/artifacts.tar.gz")" "${LOCAL_OUTPUT_DIR}/artifacts.tar.gz" >/dev/null
tar -xzf "${LOCAL_OUTPUT_DIR}/artifacts.tar.gz" -C "${LOCAL_OUTPUT_DIR}/artifacts"
rm -f "${LOCAL_OUTPUT_DIR}/artifacts.tar.gz"
printf '%s\n' "${REMOTE_STATUS}" > "${LOCAL_OUTPUT_DIR}/exit-code"

[[ "${KEEP_REMOTE_WORK_DIR}" == "1" ]] || ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "rm -rf $(printf '%q' "${REMOTE_WORK_DIR}")" >/dev/null 2>&1 || true

python3 - "$HOST" "$USER_NAME" "$SLICE_NAME" "$MODE_NAME" "$BOOTSTRAP_JSON_PATH" "${LOCAL_OUTPUT_DIR}/report.json" <<'PY'
import json
import pathlib
import sys

host, user_name, slice_name, mode_name, bootstrap_path, report_path = sys.argv[1:]
bootstrap = json.loads(pathlib.Path(bootstrap_path).read_text())
report = json.loads(pathlib.Path(report_path).read_text())

payload = {
    "generatedAt": report["generatedAt"],
    "host": host,
    "user": user_name,
    "slice": slice_name,
    "mode": mode_name,
    "bootstrap": bootstrap,
    "report": report,
    "verifyPassed": bool(report.get("verifyPassed")),
}
print(json.dumps(payload, indent=2))
PY
