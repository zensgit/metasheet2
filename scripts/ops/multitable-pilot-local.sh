#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
RUNNER_SCRIPT="${RUNNER_SCRIPT:-scripts/verify-multitable-live-smoke.mjs}"
RUN_LABEL="${RUN_LABEL:-multitable-pilot}"
OUTPUT_ROOT="${OUTPUT_ROOT:-output/playwright/${RUN_LABEL}-local/${timestamp}}"
API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
PILOT_DATABASE_URL="${PILOT_DATABASE_URL:-${DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}}"
RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST:-true}"
ENSURE_PLAYWRIGHT="${ENSURE_PLAYWRIGHT:-true}"
HEADLESS="${HEADLESS:-true}"
TIMEOUT_MS="${TIMEOUT_MS:-30000}"
REPORT_NAME="${REPORT_NAME:-report.json}"
RUN_MODE="${RUN_MODE:-local}"
RUNNER_REPORT_BASENAME="${RUNNER_REPORT_BASENAME:-local-report}"
AUTO_START_SERVICES="${AUTO_START_SERVICES:-true}"
REQUIRE_RUNNING_SERVICES="${REQUIRE_RUNNING_SERVICES:-false}"
SMOKE_REPORT_JSON="${OUTPUT_ROOT}/${REPORT_NAME}"
SMOKE_REPORT_MD="${SMOKE_REPORT_MD:-${OUTPUT_ROOT}/report.md}"
LOCAL_REPORT_JSON="${LOCAL_REPORT_JSON:-${OUTPUT_ROOT}/${RUNNER_REPORT_BASENAME}.json}"
LOCAL_REPORT_MD="${LOCAL_REPORT_MD:-${OUTPUT_ROOT}/${RUNNER_REPORT_BASENAME}.md}"
BACKEND_MODE="reused"
WEB_MODE="reused"

mkdir -p "$OUTPUT_ROOT"
BACK_PID=""
WEB_PID=""

function info() {
  echo "[multitable-pilot-local] $*" >&2
}

function parse_port() {
  python3 - <<'PY' "$1"
from urllib.parse import urlparse
import sys
url = urlparse(sys.argv[1])
if url.port:
    print(url.port)
elif url.scheme == 'https':
    print(443)
else:
    print(80)
PY
}

function wait_for_url() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 45); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "${name} failed to become ready: ${url}" >&2
  return 1
}

function cleanup() {
  if [[ -n "$BACK_PID" ]]; then
    kill "$BACK_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$WEB_PID" ]]; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
  fi
}

function write_local_report() {
  LOCAL_REPORT_JSON_PATH="${LOCAL_REPORT_JSON}" \
  LOCAL_REPORT_MD_PATH="${LOCAL_REPORT_MD}" \
  RUNNER_REPORT_JSON_PATH="${SMOKE_REPORT_JSON}" \
  RUN_LABEL_VALUE="${RUN_LABEL}" \
  RUN_MODE_VALUE="${RUN_MODE}" \
  RUNNER_SCRIPT_VALUE="${RUNNER_SCRIPT}" \
  OUTPUT_ROOT_VALUE="${OUTPUT_ROOT}" \
  API_BASE_VALUE="${API_BASE}" \
  WEB_BASE_VALUE="${WEB_BASE}" \
  HEADLESS_VALUE="${HEADLESS}" \
  TIMEOUT_MS_VALUE="${TIMEOUT_MS}" \
  BACKEND_MODE_VALUE="${BACKEND_MODE}" \
  WEB_MODE_VALUE="${WEB_MODE}" \
  node <<'NODE'
const fs = require('fs')
const path = require('path')

const localReportJsonPath = process.env.LOCAL_REPORT_JSON_PATH
const localReportMdPath = process.env.LOCAL_REPORT_MD_PATH
const runnerReportPath = process.env.RUNNER_REPORT_JSON_PATH
const runnerReport = JSON.parse(fs.readFileSync(runnerReportPath, 'utf8'))
const checks = Array.isArray(runnerReport?.checks) ? runnerReport.checks : []
const embedNamespaceSeen = checks.some((check) => /^(ui|api)\.embed-host\./.test(String(check?.name || '')))

function summarizeEmbedEvidence(requiredWhenPresent) {
  const observedChecks = requiredWhenPresent.filter((name) => checks.some((item) => item?.name === name))
  const available = embedNamespaceSeen || observedChecks.length > 0
  const missingChecks = available
    ? requiredWhenPresent.filter((name) => !checks.some((item) => item?.name === name && item.ok))
    : []
  return {
    available,
    ok: !available || missingChecks.length === 0,
    requiredWhenPresent,
    observedChecks,
    missingChecks,
  }
}

const embedHostProtocol = summarizeEmbedEvidence([
  'ui.embed-host.ready',
  'ui.embed-host.state-query.initial',
  'ui.embed-host.navigate.generated-request-id',
  'ui.embed-host.navigate.applied',
  'ui.embed-host.navigate.explicit-request-id',
  'ui.embed-host.state-query.final',
])

const embedHostNavigationProtection = summarizeEmbedEvidence([
  'ui.embed-host.form-ready',
  'ui.embed-host.form-draft',
  'ui.embed-host.navigate.blocked-dialog',
  'ui.embed-host.navigate.blocked',
  'ui.embed-host.navigate.confirm-dialog',
  'ui.embed-host.navigate.confirmed',
  'api.embed-host.discard-unsaved-form-draft',
])

const embedHostDeferredReplay = summarizeEmbedEvidence([
  'ui.embed-host.navigate.deferred',
  'ui.embed-host.navigate.superseded',
  'ui.embed-host.state-query.deferred',
  'ui.embed-host.navigate.replayed',
  'api.embed-host.persisted-busy-form-save',
])

const embedHostAcceptance = {
  available: embedHostProtocol.available || embedHostNavigationProtection.available || embedHostDeferredReplay.available,
  ok: embedHostProtocol.ok && embedHostNavigationProtection.ok && embedHostDeferredReplay.ok,
  protocol: embedHostProtocol,
  navigationProtection: embedHostNavigationProtection,
  deferredReplay: embedHostDeferredReplay,
}

const runnerOk = runnerReport?.ok !== false
const localReport = {
  ok: runnerOk && embedHostAcceptance.ok,
  runLabel: process.env.RUN_LABEL_VALUE,
  runMode: process.env.RUN_MODE_VALUE || 'local',
  runnerScript: process.env.RUNNER_SCRIPT_VALUE,
  outputRoot: path.resolve(process.env.OUTPUT_ROOT_VALUE),
  apiBase: process.env.API_BASE_VALUE,
  webBase: process.env.WEB_BASE_VALUE,
  headless: process.env.HEADLESS_VALUE !== 'false',
  timeoutMs: Number(process.env.TIMEOUT_MS_VALUE || '0'),
  serviceModes: {
    backend: process.env.BACKEND_MODE_VALUE,
    web: process.env.WEB_MODE_VALUE,
  },
  runnerReport: {
    path: path.resolve(runnerReportPath),
    ok: runnerOk,
    checkCount: checks.length,
    failingChecks: checks.filter((item) => item && item.ok === false).map((item) => item.name),
    startedAt: runnerReport?.startedAt ?? null,
  },
  embedHostAcceptance,
  embedHostProtocol,
  embedHostNavigationProtection,
  embedHostDeferredReplay,
  generatedAt: new Date().toISOString(),
}

function evidenceSection(title, evidence) {
  return [
    title,
    '',
    `- Available in runner report: \`${evidence.available ? 'true' : 'false'}\``,
    `- Status: **${evidence.ok ? 'PASS' : 'FAIL'}**`,
    evidence.requiredWhenPresent.length
      ? `- Required when present: ${evidence.requiredWhenPresent.map((item) => `\`${item}\``).join(', ')}`
      : '- Required when present: none',
    evidence.observedChecks.length
      ? `- Observed checks: ${evidence.observedChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Observed checks: none',
    evidence.missingChecks.length
      ? `- Missing checks: ${evidence.missingChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Missing checks: none',
    '',
  ]
}

const lines = [
  '# Multitable Pilot Runner Report',
  '',
  `- Overall: **${localReport.ok ? 'PASS' : 'FAIL'}**`,
  `- Run label: \`${localReport.runLabel}\``,
  `- Run mode: \`${localReport.runMode}\``,
  `- Runner script: \`${localReport.runnerScript}\``,
  `- Output root: \`${localReport.outputRoot}\``,
  `- Runner report: \`${localReport.runnerReport.path}\``,
  `- API base: \`${localReport.apiBase}\``,
  `- Web base: \`${localReport.webBase}\``,
  `- Backend mode: \`${localReport.serviceModes.backend}\``,
  `- Web mode: \`${localReport.serviceModes.web}\``,
  '',
  '## Runner Report',
  '',
  `- Status: **${localReport.runnerReport.ok ? 'PASS' : 'FAIL'}**`,
  `- Check count: \`${localReport.runnerReport.checkCount}\``,
  localReport.runnerReport.failingChecks.length
    ? `- Failing checks: ${localReport.runnerReport.failingChecks.map((item) => `\`${item}\``).join(', ')}`
    : '- Failing checks: none',
  '',
  '## Embed Host Acceptance',
  '',
  `- Available in runner report: \`${embedHostAcceptance.available ? 'true' : 'false'}\``,
  `- Status: **${embedHostAcceptance.ok ? 'PASS' : 'FAIL'}**`,
  '',
  ...evidenceSection('### Embed Host Protocol Evidence', embedHostProtocol),
  ...evidenceSection('### Embed Host Navigation Protection', embedHostNavigationProtection),
  ...evidenceSection('### Embed Host Busy Deferred Replay', embedHostDeferredReplay),
]

fs.mkdirSync(path.dirname(localReportJsonPath), { recursive: true })
fs.writeFileSync(localReportJsonPath, `${JSON.stringify(localReport, null, 2)}\n`)
fs.writeFileSync(localReportMdPath, `${lines.join('\n')}\n`)
NODE
}

trap cleanup EXIT INT TERM

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Please install pnpm first." >&2
  exit 1
fi

if [[ "$ENSURE_PLAYWRIGHT" == "true" ]]; then
  info "Ensuring Playwright Chromium is installed"
  npx playwright install chromium >"${OUTPUT_ROOT}/playwright-install.log" 2>&1
fi

if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
  if [[ "${AUTO_START_SERVICES}" != "true" || "${REQUIRE_RUNNING_SERVICES}" == "true" ]]; then
    echo "[multitable-pilot-local] ERROR: backend not reachable at ${API_BASE} and AUTO_START_SERVICES=false" >&2
    exit 1
  fi
  info "Preparing database"
  DATABASE_URL="${PILOT_DATABASE_URL}" pnpm --filter @metasheet/core-backend migrate >"${OUTPUT_ROOT}/backend-migrate.log" 2>&1

  info "Starting backend"
  BACKEND_MODE="started"
  API_PORT="$(parse_port "${API_BASE}")"
  PORT="${API_PORT}" DATABASE_URL="${PILOT_DATABASE_URL}" RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST}" \
    pnpm --filter @metasheet/core-backend dev >"${OUTPUT_ROOT}/backend.log" 2>&1 &
  BACK_PID=$!
  wait_for_url "${API_BASE}/health" "backend"
else
  info "Backend already running at ${API_BASE}"
fi

if ! curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
  if [[ "${AUTO_START_SERVICES}" != "true" || "${REQUIRE_RUNNING_SERVICES}" == "true" ]]; then
    echo "[multitable-pilot-local] ERROR: web not reachable at ${WEB_BASE} and AUTO_START_SERVICES=false" >&2
    exit 1
  fi
  info "Starting web"
  WEB_MODE="started"
  WEB_PORT="$(parse_port "${WEB_BASE}")"
  pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port "${WEB_PORT}" >"${OUTPUT_ROOT}/web.log" 2>&1 &
  WEB_PID=$!
  wait_for_url "${WEB_BASE}/" "web"
else
  info "Web already running at ${WEB_BASE}"
fi

info "Running ${RUN_LABEL}"
API_BASE="${API_BASE}" \
WEB_BASE="${WEB_BASE}" \
OUTPUT_DIR="${OUTPUT_ROOT}" \
REPORT_JSON="${SMOKE_REPORT_JSON}" \
REPORT_MD="${SMOKE_REPORT_MD}" \
HEADLESS="${HEADLESS}" \
TIMEOUT_MS="${TIMEOUT_MS}" \
RUN_MODE="${RUN_MODE}" \
node "${RUNNER_SCRIPT}"

if [[ ! -f "${SMOKE_REPORT_JSON}" ]]; then
  echo "[multitable-pilot-local] ERROR: runner completed but did not write ${SMOKE_REPORT_JSON}" >&2
  exit 1
fi

write_local_report

info "PASS: ${RUN_LABEL} completed"
info "Artifacts: ${OUTPUT_ROOT}"
info "runner_report_json=${SMOKE_REPORT_JSON}"
info "runner_report_md=${SMOKE_REPORT_MD}"
info "local_report_json=${LOCAL_REPORT_JSON}"
info "local_report_md=${LOCAL_REPORT_MD}"
