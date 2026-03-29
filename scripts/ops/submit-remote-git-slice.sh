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
PROMOTE_MANIFEST="${PROMOTE_MANIFEST:-}"
HANDOFF_MANIFEST="${HANDOFF_MANIFEST:-}"
REPLAY_MANIFEST="${REPLAY_MANIFEST:-}"
ATTEST_MANIFEST="${ATTEST_MANIFEST:-}"
VERIFY_MODE="${VERIFY_MODE:-0}"
JSON_OUTPUT="${JSON_OUTPUT:-0}"
KEEP_REMOTE_WORK_DIR="${KEEP_REMOTE_WORK_DIR:-0}"
LOCAL_OUTPUT_DIR="${LOCAL_OUTPUT_DIR:-}"
REMOTE_WORK_ROOT="${REMOTE_WORK_ROOT:-/home/mainuser/submit-runs}"

die() {
  echo "[submit-remote-git-slice] ERROR: $*" >&2
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
  bash scripts/ops/submit-remote-git-slice.sh [options]

Options:
  --host <host>               Remote host. Default: 142.171.239.56
  --user <name>               Remote user. Default: mainuser
  --identity-file <path>      SSH identity file. Default: ~/.ssh/metasheet2_deploy
  --repo-url <url>            Git remote URL. Default: local origin fetch URL
  --branch <name>             Remote branch to track. Default: local upstream branch name
  --target-dir <path>         Remote Git baseline directory. Default: /home/mainuser/metasheet2-git-baseline
  --deploy-dir <path>         Existing deployed directory for comparison. Default: /home/mainuser/metasheet2
  --slice <name>              Slice name. Default: directory-migration-baseline
  --promote-manifest <path>   Local promote manifest. Default: output/remote-git-slice-promotions/<slice>/promoted/artifacts/manifest.json
  --handoff-manifest <path>   Local handoff manifest. Default: output/remote-git-slice-handoffs/<slice>/handoff/artifacts/manifest.json
  --replay-manifest <path>    Local replay manifest. Default: output/remote-git-slice-replays/<slice>/replay/report.json
  --attest-manifest <path>    Local attest manifest. Default: output/remote-git-slice-attestations/<slice>/attest/manifest.json
  --verify                    Run remote submit in verify mode
  --keep-remote-work-dir      Keep the remote temp work dir after fetching artifacts
  --local-output-dir <path>   Local artifact output dir. Default: output/remote-git-slice-submissions/<slice>/<verify|submit>
  --remote-work-root <path>   Remote temp work root. Default: /home/mainuser/submit-runs
  --json                      Print JSON result
  --help, -h                  Show help
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
    --promote-manifest)
      PROMOTE_MANIFEST="${2:-}"
      shift 2
      ;;
    --handoff-manifest)
      HANDOFF_MANIFEST="${2:-}"
      shift 2
      ;;
    --replay-manifest)
      REPLAY_MANIFEST="${2:-}"
      shift 2
      ;;
    --attest-manifest)
      ATTEST_MANIFEST="${2:-}"
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

if [[ -z "${PROMOTE_MANIFEST}" ]]; then
  PROMOTE_MANIFEST="${REPO_ROOT}/output/remote-git-slice-promotions/${SLICE_NAME}/promoted/artifacts/manifest.json"
fi
if [[ -z "${HANDOFF_MANIFEST}" ]]; then
  HANDOFF_MANIFEST="${REPO_ROOT}/output/remote-git-slice-handoffs/${SLICE_NAME}/handoff/artifacts/manifest.json"
fi
if [[ -z "${REPLAY_MANIFEST}" ]]; then
  REPLAY_MANIFEST="${REPO_ROOT}/output/remote-git-slice-replays/${SLICE_NAME}/replay/report.json"
fi
if [[ -z "${ATTEST_MANIFEST}" ]]; then
  ATTEST_MANIFEST="${REPO_ROOT}/output/remote-git-slice-attestations/${SLICE_NAME}/attest/manifest.json"
fi

[[ -n "${REPO_URL}" ]] || die "Unable to determine repo URL. Pass --repo-url explicitly."
[[ -n "${BRANCH}" ]] || die "Unable to determine branch. Pass --branch explicitly."
[[ -f "${IDENTITY_FILE}" ]] || die "Identity file not found: ${IDENTITY_FILE}"
[[ -f "${PROMOTE_MANIFEST}" ]] || die "Promote manifest not found: ${PROMOTE_MANIFEST}"
[[ -f "${HANDOFF_MANIFEST}" ]] || die "Handoff manifest not found: ${HANDOFF_MANIFEST}"
[[ -f "${REPLAY_MANIFEST}" ]] || die "Replay manifest not found: ${REPLAY_MANIFEST}"
[[ -f "${ATTEST_MANIFEST}" ]] || die "Attest manifest not found: ${ATTEST_MANIFEST}"

MODE_NAME="submit"
if [[ "${VERIFY_MODE}" == "1" ]]; then
  MODE_NAME="verify"
fi

if [[ -z "${LOCAL_OUTPUT_DIR}" ]]; then
  LOCAL_OUTPUT_DIR="${REPO_ROOT}/output/remote-git-slice-submissions/${SLICE_NAME}/${MODE_NAME}"
fi

SSH_TARGET="${USER_NAME}@${HOST}"
SSH_OPTS=(-i "${IDENTITY_FILE}" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no)

BOOTSTRAP_JSON="$(run_bootstrap_json)"

LOCAL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/remote-git-slice-submit-XXXXXX")"
cleanup_local() {
  rm -rf "${LOCAL_TMP}"
}
trap cleanup_local EXIT

PAYLOAD_DIR="${LOCAL_TMP}/payload"
SCRIPTS_DIR="${PAYLOAD_DIR}/scripts/ops"
MANIFEST_DIR="${PAYLOAD_DIR}/manifests"
mkdir -p "${SCRIPTS_DIR}" "${MANIFEST_DIR}"

cp "${REPO_ROOT}/scripts/ops/git-slice-submit.mjs" "${SCRIPTS_DIR}/git-slice-submit.mjs"
cp "${REPO_ROOT}/scripts/ops/git-slices.mjs" "${SCRIPTS_DIR}/git-slices.mjs"
cp "${PROMOTE_MANIFEST}" "${MANIFEST_DIR}/promote.json"
cp "${HANDOFF_MANIFEST}" "${MANIFEST_DIR}/handoff.json"
cp "${REPLAY_MANIFEST}" "${MANIFEST_DIR}/replay.json"
cp "${ATTEST_MANIFEST}" "${MANIFEST_DIR}/attest.json"

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
    bash -s <<'EOF' || REMOTE_STATUS=$?
set -euo pipefail

SLICE_NAME="${REMOTE_SLICE}"
BRANCH="${REMOTE_BRANCH}"
TARGET_DIR="${REMOTE_TARGET_DIR}"
WORK_DIR="${REMOTE_WORK_DIR}"
VERIFY_MODE="${REMOTE_VERIFY}"

mkdir -p "${WORK_DIR}/payload" "${WORK_DIR}/artifacts"
tar -xzf "${WORK_DIR}/payload.tar.gz" -C "${WORK_DIR}/payload"

STATUS=0
set +e
(
  cd "${TARGET_DIR}"
  CMD=(
    node
    "${WORK_DIR}/payload/scripts/ops/git-slice-submit.mjs"
    --slice "${SLICE_NAME}"
    --promote-manifest "${WORK_DIR}/payload/manifests/promote.json"
    --handoff-manifest "${WORK_DIR}/payload/manifests/handoff.json"
    --replay-manifest "${WORK_DIR}/payload/manifests/replay.json"
    --attest-manifest "${WORK_DIR}/payload/manifests/attest.json"
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
exit "${STATUS}"
EOF

mkdir -p "${LOCAL_OUTPUT_DIR}"
scp "${SSH_OPTS[@]}" "${SSH_TARGET}:$(printf '%q' "${REMOTE_WORK_DIR}/report.json")" "${LOCAL_OUTPUT_DIR}/report.json" >/dev/null
scp "${SSH_OPTS[@]}" "${SSH_TARGET}:$(printf '%q' "${REMOTE_WORK_DIR}/exit-code")" "${LOCAL_OUTPUT_DIR}/exit-code" >/dev/null
scp -r "${SSH_OPTS[@]}" "${SSH_TARGET}:$(printf '%q' "${REMOTE_WORK_DIR}/artifacts")" "${LOCAL_OUTPUT_DIR}/" >/dev/null

if [[ "${KEEP_REMOTE_WORK_DIR}" != "1" ]]; then
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "rm -rf $(printf '%q' "${REMOTE_WORK_DIR}")"
fi

RESULT_JSON="$(
  BOOTSTRAP_JSON="${BOOTSTRAP_JSON}" \
  LOCAL_OUTPUT_DIR="${LOCAL_OUTPUT_DIR}" \
  REMOTE_STATUS="${REMOTE_STATUS}" \
  REMOTE_WORK_DIR="${REMOTE_WORK_DIR}" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

bootstrap = json.loads(os.environ["BOOTSTRAP_JSON"])
output_dir = Path(os.environ["LOCAL_OUTPUT_DIR"])
report = json.loads((output_dir / "report.json").read_text())

result = {
    "bootstrap": bootstrap,
    "outputDir": str(output_dir.resolve()),
    "artifactsDir": str((output_dir / "artifacts").resolve()),
    "reportPath": str((output_dir / "report.json").resolve()),
    "exitCodePath": str((output_dir / "exit-code").resolve()),
    "remoteWorkDir": os.environ["REMOTE_WORK_DIR"],
    "remoteTransportExitCode": int(os.environ["REMOTE_STATUS"]),
    "remoteCommandExitCode": int((output_dir / "exit-code").read_text().strip()),
    "report": report,
}
print(json.dumps(result, indent=2))
PY
)"

if [[ "${JSON_OUTPUT}" == "1" ]]; then
  printf '%s\n' "${RESULT_JSON}"
else
  RESULT_JSON="${RESULT_JSON}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["RESULT_JSON"])
report = payload["report"]
print(f"remote-git-slice-submit: {report['slice']}")
print(f"  promoted_branch: {report['promote']['branchName']}")
print(f"  promoted_head: {report['promote']['head']}")
print(f"  verify_passed: {report['verifyPassed']}")
print(f"  output_dir: {payload['outputDir']}")
PY
fi

REMOTE_COMMAND_EXIT_CODE="$(RESULT_JSON="${RESULT_JSON}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["RESULT_JSON"])
print(payload["remoteCommandExitCode"])
PY
)"

if [[ "${REMOTE_STATUS}" -ne 0 ]]; then
  exit "${REMOTE_STATUS}"
fi

if [[ "${REMOTE_COMMAND_EXIT_CODE}" -ne 0 ]]; then
  exit "${REMOTE_COMMAND_EXIT_CODE}"
fi
