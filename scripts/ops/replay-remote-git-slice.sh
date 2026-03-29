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
SOURCE_MANIFEST="${SOURCE_MANIFEST:-}"
VERIFY_MODE="${VERIFY_MODE:-0}"
JSON_OUTPUT="${JSON_OUTPUT:-0}"
KEEP_REMOTE_WORK_DIR="${KEEP_REMOTE_WORK_DIR:-0}"
LOCAL_OUTPUT_DIR="${LOCAL_OUTPUT_DIR:-}"
REMOTE_WORK_ROOT="${REMOTE_WORK_ROOT:-/home/mainuser/replay-runs}"

die() {
  echo "[replay-remote-git-slice] ERROR: $*" >&2
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
  bash scripts/ops/replay-remote-git-slice.sh [options]

Options:
  --host <host>              Remote host. Default: 142.171.239.56
  --user <name>              Remote user. Default: mainuser
  --identity-file <path>     SSH identity file. Default: ~/.ssh/metasheet2_deploy
  --repo-url <url>           Git remote URL. Default: local origin fetch URL
  --branch <name>            Remote branch to track. Default: local upstream branch name
  --target-dir <path>        Remote Git baseline directory. Default: /home/mainuser/metasheet2-git-baseline
  --deploy-dir <path>        Existing deployed directory for comparison. Default: /home/mainuser/metasheet2
  --slice <name>             Slice name. Default: directory-migration-baseline
  --source-manifest <path>   Local handoff manifest path. Default: output/remote-git-slice-handoffs/<slice>/handoff/artifacts/manifest.json
  --verify                   Run remote replay in verify mode
  --keep-remote-work-dir     Keep the remote temp work dir after fetching artifacts
  --local-output-dir <path>  Local artifact output dir. Default: output/remote-git-slice-replays/<slice>/<verify|replay>
  --remote-work-root <path>  Remote temp work root. Default: /home/mainuser/replay-runs
  --json                     Print JSON result
  --help, -h                 Show help
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
    --source-manifest)
      SOURCE_MANIFEST="${2:-}"
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

if [[ -z "${SOURCE_MANIFEST}" ]]; then
  SOURCE_MANIFEST="${REPO_ROOT}/output/remote-git-slice-handoffs/${SLICE_NAME}/handoff/artifacts/manifest.json"
fi

[[ -n "${REPO_URL}" ]] || die "Unable to determine repo URL. Pass --repo-url explicitly."
[[ -n "${BRANCH}" ]] || die "Unable to determine branch. Pass --branch explicitly."
[[ -f "${IDENTITY_FILE}" ]] || die "Identity file not found: ${IDENTITY_FILE}"
[[ -f "${SOURCE_MANIFEST}" ]] || die "Source manifest not found: ${SOURCE_MANIFEST}"

SOURCE_ARTIFACT_DIR="$(cd "$(dirname "${SOURCE_MANIFEST}")" && pwd)"

MODE_NAME="replay"
if [[ "${VERIFY_MODE}" == "1" ]]; then
  MODE_NAME="verify"
fi

if [[ -z "${LOCAL_OUTPUT_DIR}" ]]; then
  LOCAL_OUTPUT_DIR="${REPO_ROOT}/output/remote-git-slice-replays/${SLICE_NAME}/${MODE_NAME}"
fi

SSH_TARGET="${USER_NAME}@${HOST}"
SSH_OPTS=(-i "${IDENTITY_FILE}" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no)

BOOTSTRAP_JSON="$(run_bootstrap_json)"

LOCAL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/remote-git-slice-replay-XXXXXX")"
cleanup_local() {
  rm -rf "${LOCAL_TMP}"
}
trap cleanup_local EXIT

PAYLOAD_DIR="${LOCAL_TMP}/payload"
SCRIPTS_DIR="${PAYLOAD_DIR}/scripts/ops"
HANDOFF_DIR="${PAYLOAD_DIR}/handoff"
mkdir -p "${SCRIPTS_DIR}" "${HANDOFF_DIR}"

cp "${REPO_ROOT}/scripts/ops/git-slice-replay.mjs" "${SCRIPTS_DIR}/git-slice-replay.mjs"
cp "${REPO_ROOT}/scripts/ops/git-slices.mjs" "${SCRIPTS_DIR}/git-slices.mjs"
cp -R "${SOURCE_ARTIFACT_DIR}/." "${HANDOFF_DIR}/"

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
    REMOTE_BRANCH="${BRANCH}" \
    REMOTE_TARGET_DIR="${TARGET_DIR}" \
    REMOTE_WORK_DIR="${REMOTE_WORK_DIR}" \
    REMOTE_VERIFY="${VERIFY_MODE}" \
    REMOTE_REPO_URL="${REPO_URL}" \
    bash -s <<'EOF' || REMOTE_STATUS=$?
set -euo pipefail

SLICE_NAME="${REMOTE_SLICE}"
BRANCH="${REMOTE_BRANCH}"
TARGET_DIR="${REMOTE_TARGET_DIR}"
WORK_DIR="${REMOTE_WORK_DIR}"
VERIFY_MODE="${REMOTE_VERIFY}"
REPO_URL="${REMOTE_REPO_URL}"

mkdir -p "${WORK_DIR}/payload" "${WORK_DIR}/artifacts"
tar -xzf "${WORK_DIR}/payload.tar.gz" -C "${WORK_DIR}/payload"

STATUS=0
set +e
(
  cd "${TARGET_DIR}"
  CMD=(
    node
    "${WORK_DIR}/payload/scripts/ops/git-slice-replay.mjs"
    --slice "${SLICE_NAME}"
    --manifest "${WORK_DIR}/payload/handoff/manifest.json"
    --repo-url "${REPO_URL}"
    --base-ref "origin/${BRANCH}"
    --output-dir "${WORK_DIR}/artifacts"
    --json
  )
  if [[ "${VERIFY_MODE}" == "1" ]]; then
    CMD+=(--verify)
  fi
  "${CMD[@]}" > "${WORK_DIR}/report.json"
)
STATUS=$?
set -e

printf '%s\n' "${STATUS}" > "${WORK_DIR}/exit-code"
tar -C "${WORK_DIR}" -czf "${WORK_DIR}/artifacts.tar.gz" report.json exit-code artifacts
exit 0
EOF

mkdir -p "${LOCAL_OUTPUT_DIR}"
scp "${SSH_OPTS[@]}" "${SSH_TARGET}:$(printf '%q' "${REMOTE_WORK_DIR}/artifacts.tar.gz")" "${LOCAL_OUTPUT_DIR}/artifacts.tar.gz" >/dev/null
tar -C "${LOCAL_OUTPUT_DIR}" -xzf "${LOCAL_OUTPUT_DIR}/artifacts.tar.gz"
rm -f "${LOCAL_OUTPUT_DIR}/artifacts.tar.gz"

REMOTE_EXIT_CODE="$(cat "${LOCAL_OUTPUT_DIR}/exit-code" | tr -d '\n\r')"
REPORT_PATH="${LOCAL_OUTPUT_DIR}/report.json"
[[ -f "${REPORT_PATH}" ]] || die "Missing fetched report: ${REPORT_PATH}"

if [[ "${KEEP_REMOTE_WORK_DIR}" != "1" ]]; then
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "rm -rf $(printf '%q' "${REMOTE_WORK_DIR}")"
fi

COMBINED_REPORT="$(
  BOOTSTRAP_JSON="${BOOTSTRAP_JSON}" \
  REPORT_PATH="${REPORT_PATH}" \
  HOST_VALUE="${HOST}" \
  USER_VALUE="${USER_NAME}" \
  SLICE_VALUE="${SLICE_NAME}" \
  MODE_VALUE="${MODE_NAME}" \
  SOURCE_MANIFEST_VALUE="${SOURCE_MANIFEST}" \
  LOCAL_OUTPUT_DIR_VALUE="${LOCAL_OUTPUT_DIR}" \
  REMOTE_WORK_DIR_VALUE="${REMOTE_WORK_DIR}" \
  REMOTE_EXIT_CODE_VALUE="${REMOTE_EXIT_CODE}" \
  REMOTE_STATUS_VALUE="${REMOTE_STATUS}" \
  KEEP_REMOTE_WORK_DIR_VALUE="${KEEP_REMOTE_WORK_DIR}" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

bootstrap = json.loads(os.environ["BOOTSTRAP_JSON"])
report = json.loads(Path(os.environ["REPORT_PATH"]).read_text())
remote_exit_code = int(os.environ["REMOTE_EXIT_CODE_VALUE"])
remote_status = int(os.environ["REMOTE_STATUS_VALUE"])

combined = {
    "generatedAt": report.get("generatedAt"),
    "host": os.environ["HOST_VALUE"],
    "user": os.environ["USER_VALUE"],
    "slice": os.environ["SLICE_VALUE"],
    "mode": os.environ["MODE_VALUE"],
    "sourceManifest": os.environ["SOURCE_MANIFEST_VALUE"],
    "localOutputDir": os.environ["LOCAL_OUTPUT_DIR_VALUE"],
    "remoteWorkDir": os.environ["REMOTE_WORK_DIR_VALUE"],
    "keepRemoteWorkDir": os.environ["KEEP_REMOTE_WORK_DIR_VALUE"] == "1",
    "bootstrap": bootstrap,
    "remoteCommandExitCode": remote_exit_code,
    "remoteTransportExitCode": remote_status,
    "report": report,
}
combined["verifyPassed"] = remote_status == 0 and remote_exit_code == 0 and bool(report.get("verifyPassed"))
print(json.dumps(combined, indent=2))
PY
)"

if [[ "${JSON_OUTPUT}" == "1" ]]; then
  printf '%s\n' "${COMBINED_REPORT}"
else
  COMBINED_REPORT="${COMBINED_REPORT}" python3 - <<'PY'
import json
import os

report = json.loads(os.environ["COMBINED_REPORT"])
inner = report["report"]
print("Remote git slice replay")
print(f"  host: {report['host']}")
print(f"  user: {report['user']}")
print(f"  slice: {report['slice']}")
print(f"  mode: {report['mode']}")
print(f"  source_manifest: {report['sourceManifest']}")
print(f"  local_output_dir: {report['localOutputDir']}")
print(f"  remote_work_dir: {report['remoteWorkDir']}")
print(f"  bootstrap_action: {report['bootstrap']['action']}")
print(f"  remote_command_exit_code: {report['remoteCommandExitCode']}")
print(f"  remote_transport_exit_code: {report['remoteTransportExitCode']}")
print(f"  replay_branch_name: {inner.get('replayBranchName')}")
print(f"  replayed_head: {inner.get('replayedHead')}")
print(f"  bundle_sha256: {inner.get('bundleSha256')}")
print(f"  commit_count: {inner.get('commitCount')}")
print(f"  verify_passed: {'yes' if report['verifyPassed'] else 'no'}")
PY
fi

if [[ "${REMOTE_STATUS}" != "0" ]]; then
  exit "${REMOTE_STATUS}"
fi

if [[ "${REMOTE_EXIT_CODE}" != "0" ]]; then
  exit "${REMOTE_EXIT_CODE}"
fi
