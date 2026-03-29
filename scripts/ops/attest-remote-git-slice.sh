#!/usr/bin/env bash
set -euo pipefail

HOST=""
USER_NAME=""
IDENTITY_FILE=""
TARGET_DIR=""
DEPLOY_DIR=""
SLICE="directory-migration-baseline"
OUTPUT_DIR=""
VERIFY_MODE=0
JSON_MODE=0

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
    --target-dir)
      TARGET_DIR="${2:-}"
      shift 2
      ;;
    --deploy-dir)
      DEPLOY_DIR="${2:-}"
      shift 2
      ;;
    --slice)
      SLICE="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --verify)
      VERIFY_MODE=1
      shift
      ;;
    --json)
      JSON_MODE=1
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: bash scripts/ops/attest-remote-git-slice.sh [options]

Options:
  --host <host>           Remote host
  --user <user>           Remote user
  --identity-file <path>  SSH identity file
  --target-dir <path>     Remote baseline git clone path
  --deploy-dir <path>     Remote deploy directory
  --slice <name>          Slice name. Default: directory-migration-baseline
  --output-dir <path>     Local output dir
  --verify                Verify mode
  --json                  Print JSON
  --help, -h              Show help
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$HOST" || -z "$USER_NAME" || -z "$IDENTITY_FILE" || -z "$TARGET_DIR" || -z "$DEPLOY_DIR" ]]; then
  echo "Missing required arguments: --host --user --identity-file --target-dir --deploy-dir" >&2
  exit 1
fi

if [[ -z "$OUTPUT_DIR" ]]; then
  if [[ "$VERIFY_MODE" -eq 1 ]]; then
    OUTPUT_DIR="output/remote-git-slice-attestations/${SLICE}/verify"
  else
    OUTPUT_DIR="output/remote-git-slice-attestations/${SLICE}/attest"
  fi
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/remote-git-slice-attest.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

BOOTSTRAP_JSON="$TMP_DIR/bootstrap.json"
ATTEST_JSON="$TMP_DIR/attest.json"

bash scripts/ops/bootstrap-remote-git-baseline.sh \
  --host "$HOST" \
  --user "$USER_NAME" \
  --identity-file "$IDENTITY_FILE" \
  --target-dir "$TARGET_DIR" \
  --deploy-dir "$DEPLOY_DIR" \
  --json >"$BOOTSTRAP_JSON"

ATTEST_ARGS=(
  node scripts/ops/git-slice-attest.mjs
  --slice "$SLICE"
  --local-handoff-manifest "output/git-slice-handoffs/${SLICE}/manifest.json"
  --local-replay-manifest "output/git-slice-replays/${SLICE}/manifest.json"
  --remote-handoff-manifest "output/remote-git-slice-handoffs/${SLICE}/handoff/artifacts/manifest.json"
  --remote-replay-manifest "output/remote-git-slice-replays/${SLICE}/replay/artifacts/manifest.json"
  --output-dir "$OUTPUT_DIR"
  --json
)

if [[ "$VERIFY_MODE" -eq 1 ]]; then
  ATTEST_ARGS+=(--verify)
fi

"${ATTEST_ARGS[@]}" >"$ATTEST_JSON"

if [[ "$JSON_MODE" -eq 1 ]]; then
  python3 - "$HOST" "$USER_NAME" "$SLICE" "$VERIFY_MODE" "$BOOTSTRAP_JSON" "$ATTEST_JSON" <<'PY'
import json
import pathlib
import sys

host, user_name, slice_name, verify_mode, bootstrap_path, attest_path = sys.argv[1:]
bootstrap = json.loads(pathlib.Path(bootstrap_path).read_text())
attest = json.loads(pathlib.Path(attest_path).read_text())

payload = {
    "generatedAt": attest["generatedAt"],
    "host": host,
    "user": user_name,
    "slice": slice_name,
    "mode": "verify" if verify_mode == "1" else "attest",
    "bootstrap": bootstrap,
    "report": attest,
    "verifyPassed": bool(attest.get("verifyPassed")),
}
print(json.dumps(payload, indent=2))
PY
  exit 0
fi

python3 - "$BOOTSTRAP_JSON" "$ATTEST_JSON" <<'PY'
import json
import pathlib
import sys

bootstrap = json.loads(pathlib.Path(sys.argv[1]).read_text())
attest = json.loads(pathlib.Path(sys.argv[2]).read_text())

print(f"remote-git-slice-attest: {attest['slice']}")
print(f"  baseline_head: {bootstrap.get('head')}")
print(f"  baseline_dirty: {bootstrap.get('dirty')}")
print(f"  verify_passed: {attest.get('verifyPassed')}")
print(f"  output_dir: {attest.get('outputDir')}")
print("  invariants:")
for key, value in attest.get("invariants", {}).items():
    print(f"    {key}={value}")
PY
