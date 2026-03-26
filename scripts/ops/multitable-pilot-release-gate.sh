#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
HEADLESS="${HEADLESS:-true}"
TIMEOUT_MS="${TIMEOUT_MS:-40000}"
RUN_MODE="${RUN_MODE:-local}"
SKIP_MULTITABLE_PILOT_SMOKE="${SKIP_MULTITABLE_PILOT_SMOKE:-false}"
DEFAULT_OUTPUT_ROOT="output/playwright/multitable-pilot-release-gate/${timestamp}"
if [[ "${RUN_MODE}" == "staging" ]]; then
  DEFAULT_OUTPUT_ROOT="output/playwright/multitable-pilot-release-gate-staging/${timestamp}"
fi
OUTPUT_ROOT="${OUTPUT_ROOT:-}"
REPORT_JSON="${REPORT_JSON:-}"
REPORT_MD="${REPORT_MD:-}"
LOG_PATH="${LOG_PATH:-}"
if [[ -z "${OUTPUT_ROOT}" ]]; then
  if [[ -n "${REPORT_JSON}" ]]; then
    OUTPUT_ROOT="$(dirname "${REPORT_JSON}")"
  elif [[ -n "${REPORT_MD}" ]]; then
    OUTPUT_ROOT="$(dirname "${REPORT_MD}")"
  elif [[ -n "${LOG_PATH}" ]]; then
    OUTPUT_ROOT="$(dirname "${LOG_PATH}")"
  else
    OUTPUT_ROOT="${DEFAULT_OUTPUT_ROOT}"
  fi
fi
REPORT_JSON="${REPORT_JSON:-${OUTPUT_ROOT}/report.json}"
REPORT_MD="${REPORT_MD:-${OUTPUT_ROOT}/report.md}"
LOG_PATH="${LOG_PATH:-${OUTPUT_ROOT}/release-gate.log}"
COMMANDS_SH="${COMMANDS_SH:-${OUTPUT_ROOT}/operator-commands.sh}"
PILOT_SMOKE_OUTPUT_ROOT="${PILOT_SMOKE_OUTPUT_ROOT:-${OUTPUT_ROOT}/smoke}"
PILOT_SMOKE_REPORT="${PILOT_SMOKE_REPORT:-${PILOT_SMOKE_OUTPUT_ROOT}/report.json}"
PILOT_SMOKE_REPORT_MD="${PILOT_SMOKE_REPORT_MD:-${PILOT_SMOKE_OUTPUT_ROOT}/report.md}"

mkdir -p "$(dirname "${REPORT_JSON}")" "$(dirname "${REPORT_MD}")" "$(dirname "${LOG_PATH}")" "$(dirname "${COMMANDS_SH}")" "${PILOT_SMOKE_OUTPUT_ROOT}"

export API_BASE WEB_BASE HEADLESS TIMEOUT_MS RUN_MODE

LIVE_SMOKE_COMMAND="pnpm verify:multitable-pilot"
LIVE_SMOKE_SKIP_NOTE="executed earlier by multitable-pilot-ready-local"
if [[ "$RUN_MODE" == "staging" ]]; then
  LIVE_SMOKE_COMMAND="pnpm verify:multitable-pilot:staging"
  LIVE_SMOKE_SKIP_NOTE="executed earlier by multitable-pilot-ready-staging"
fi

log_release_gate() {
  printf '%s\n' "$*" >> "$LOG_PATH"
}

init_release_gate_log() {
  : > "$LOG_PATH"
  log_release_gate "[gate] started_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  log_release_gate "[gate] run_mode=${RUN_MODE}"
  log_release_gate "[gate] output_root=${OUTPUT_ROOT}"
  log_release_gate "[gate] report_json=${REPORT_JSON}"
  log_release_gate "[gate] report_md=${REPORT_MD}"
  log_release_gate "[gate] operator_helper=${COMMANDS_SH}"
  log_release_gate "[gate] smoke_output_root=${PILOT_SMOKE_OUTPUT_ROOT}"
  log_release_gate "[gate] smoke_report=${PILOT_SMOKE_REPORT}"
  log_release_gate "[gate] smoke_report_md=${PILOT_SMOKE_REPORT_MD}"
}

declare -a STEP_NAMES=()
declare -a STEP_COMMANDS=()
declare -a STEP_LOGS=()
declare -a STEP_ENVS=()
declare -a STEP_NOTES=()
declare -a STEP_STATUSES=()

SCRIPT_EXIT_CODE=0
FAILED_STEP=""

add_release_gate_step() {
  STEP_NAMES+=("$1")
  STEP_COMMANDS+=("$2")
  STEP_LOGS+=("$3")
  STEP_ENVS+=("$4")
  STEP_NOTES+=("${5:-}")
  STEP_STATUSES+=("${6:-not_run}")
}

define_release_gate_steps() {
  local shared_log="${LOG_PATH:-}"

  add_release_gate_step \
    "web.build" \
    "pnpm --filter @metasheet/web build" \
    "$shared_log" \
    ""

  add_release_gate_step \
    "core-backend.build" \
    "pnpm --filter @metasheet/core-backend build" \
    "$shared_log" \
    ""

  add_release_gate_step \
    "web.vitest.multitable" \
    "pnpm --filter @metasheet/web exec vitest run tests/multitable-field-manager.spec.ts tests/multitable-view-manager.spec.ts tests/multitable-import-modal.spec.ts tests/multitable-import.spec.ts tests/multitable-people-import.spec.ts tests/multitable-grid-attachment-editor.spec.ts tests/multitable-link-picker.spec.ts tests/multitable-gallery-view.spec.ts tests/multitable-calendar-view.spec.ts tests/multitable-kanban-view.spec.ts tests/multitable-timeline-view.spec.ts tests/multitable-workbench.spec.ts --reporter=dot" \
    "$shared_log" \
    ""

  add_release_gate_step \
    "web.vitest.multitable.contracts" \
    "pnpm --filter @metasheet/web exec vitest run tests/multitable-embed-route.spec.ts tests/multitable-embed-host.spec.ts tests/multitable-client.spec.ts tests/view-manager-multitable-contract.spec.ts --reporter=dot" \
    "$shared_log" \
    ""

  add_release_gate_step \
    "core-backend.integration.multitable" \
    "pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts tests/integration/multitable-record-form.api.test.ts tests/integration/multitable-attachments.api.test.ts tests/integration/multitable-view-config.api.test.ts --reporter=dot" \
    "$shared_log" \
    ""

  add_release_gate_step \
    "openapi.multitable.parity" \
    "pnpm verify:multitable-openapi:parity" \
    "$shared_log" \
    ""

  local smoke_env
  smoke_env="$(printf '{"API_BASE":"%s","WEB_BASE":"%s","HEADLESS":"%s","TIMEOUT_MS":"%s","OUTPUT_ROOT":"%s","REPORT_MD":"%s","SMOKE_REPORT_MD":"%s","RUN_MODE":"%s"}' "$API_BASE" "$WEB_BASE" "$HEADLESS" "$TIMEOUT_MS" "$PILOT_SMOKE_OUTPUT_ROOT" "$PILOT_SMOKE_REPORT_MD" "$PILOT_SMOKE_REPORT_MD" "$RUN_MODE")"

  if [[ "$SKIP_MULTITABLE_PILOT_SMOKE" == "true" ]]; then
    add_release_gate_step \
      "release-gate.multitable.live-smoke" \
      "$LIVE_SMOKE_COMMAND" \
      "${PILOT_SMOKE_REPORT:-$shared_log}" \
      "$smoke_env" \
      "$LIVE_SMOKE_SKIP_NOTE" \
      "skipped"
    return
  fi

  add_release_gate_step \
    "release-gate.multitable.live-smoke" \
    "$LIVE_SMOKE_COMMAND" \
    "${PILOT_SMOKE_REPORT:-$shared_log}" \
    "$smoke_env"
}

write_release_gate_operator_commands() {
  local commands_tmp="${COMMANDS_SH}.tmp"

  cat > "$commands_tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR}"
RUN_MODE="${RUN_MODE}"
API_BASE="${API_BASE}"
WEB_BASE="${WEB_BASE}"
HEADLESS="${HEADLESS}"
TIMEOUT_MS="${TIMEOUT_MS}"
OUTPUT_ROOT="${OUTPUT_ROOT}"
REPORT_JSON="${REPORT_JSON}"
REPORT_MD="${REPORT_MD}"
LOG_PATH="${LOG_PATH}"
COMMANDS_SH="${COMMANDS_SH}"
PILOT_SMOKE_OUTPUT_ROOT="${PILOT_SMOKE_OUTPUT_ROOT}"
PILOT_SMOKE_REPORT="${PILOT_SMOKE_REPORT}"
PILOT_SMOKE_REPORT_MD="${PILOT_SMOKE_REPORT_MD}"
LIVE_SMOKE_COMMAND="${LIVE_SMOKE_COMMAND}"

print_artifacts() {
  cat <<USAGE
Release-gate artifacts:
  - JSON report: \${REPORT_JSON}
  - Markdown report: \${REPORT_MD}
  - Gate log: \${LOG_PATH}
  - Helper: \${COMMANDS_SH}
  - Smoke output root: \${PILOT_SMOKE_OUTPUT_ROOT}
  - Smoke report: \${PILOT_SMOKE_REPORT}
  - Smoke markdown: \${PILOT_SMOKE_REPORT_MD}
USAGE
}

case "\${1:-help}" in
  help|-h|--help)
    cat <<'USAGE'
Usage: operator-commands.sh <command>

Commands:
  show-artifacts
  rerun-gate
  rerun-live-smoke
  show-log-tail
USAGE
    echo
    print_artifacts
    ;;
  show-artifacts)
    print_artifacts
    ;;
  rerun-gate)
    cd "\${ROOT_DIR}"
    exec env \
      RUN_MODE="\${RUN_MODE}" \
      API_BASE="\${API_BASE}" \
      WEB_BASE="\${WEB_BASE}" \
      HEADLESS="\${HEADLESS}" \
      TIMEOUT_MS="\${TIMEOUT_MS}" \
      OUTPUT_ROOT="\${OUTPUT_ROOT}" \
      REPORT_JSON="\${REPORT_JSON}" \
      REPORT_MD="\${REPORT_MD}" \
      LOG_PATH="\${LOG_PATH}" \
      COMMANDS_SH="\${COMMANDS_SH}" \
      PILOT_SMOKE_OUTPUT_ROOT="\${PILOT_SMOKE_OUTPUT_ROOT}" \
      PILOT_SMOKE_REPORT="\${PILOT_SMOKE_REPORT}" \
      PILOT_SMOKE_REPORT_MD="\${PILOT_SMOKE_REPORT_MD}" \
      bash scripts/ops/multitable-pilot-release-gate.sh
    ;;
  rerun-live-smoke)
    cd "\${ROOT_DIR}"
    exec env \
      API_BASE="\${API_BASE}" \
      WEB_BASE="\${WEB_BASE}" \
      HEADLESS="\${HEADLESS}" \
      TIMEOUT_MS="\${TIMEOUT_MS}" \
      RUN_MODE="\${RUN_MODE}" \
      OUTPUT_ROOT="\${PILOT_SMOKE_OUTPUT_ROOT}" \
      REPORT_MD="\${PILOT_SMOKE_REPORT_MD}" \
      SMOKE_REPORT_MD="\${PILOT_SMOKE_REPORT_MD}" \
      \${LIVE_SMOKE_COMMAND}
    ;;
  show-log-tail)
    exec tail -n "\${TAIL_LINES:-80}" "\${LOG_PATH}"
    ;;
  *)
    echo "Unknown command: \$1" >&2
    exit 1
    ;;
esac
EOF

  mv "$commands_tmp" "$COMMANDS_SH"
  chmod +x "$COMMANDS_SH"
}

write_release_gate_report() {
  local exit_code="${1:-0}"
  if [[ -z "$REPORT_JSON" && -z "$REPORT_MD" ]]; then
    return 0
  fi

  local report_md_path="${REPORT_MD:-}"
  if [[ -z "$report_md_path" && -n "$REPORT_JSON" ]]; then
    report_md_path="$(dirname "$REPORT_JSON")/report.md"
  fi

  local steps_file
  steps_file="$(mktemp -t multitable-release-gate-steps.XXXXXX)"
  local index
  for index in "${!STEP_NAMES[@]}"; do
    local status="${STEP_STATUSES[$index]}"
    local ok="false"
    if [[ "$status" == "passed" || "$status" == "skipped" ]]; then
      ok="true"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${STEP_NAMES[$index]}" \
      "$ok" \
      "$status" \
      "${STEP_COMMANDS[$index]}" \
      "${STEP_LOGS[$index]}" \
      "${STEP_ENVS[$index]}" \
      "${STEP_NOTES[$index]}" >> "$steps_file"
  done

  REPORT_JSON_PATH="$REPORT_JSON" \
  REPORT_MD_PATH="$report_md_path" \
  COMMANDS_SH_PATH="$COMMANDS_SH" \
  RELEASE_GATE_OUTPUT_ROOT="$OUTPUT_ROOT" \
  RELEASE_GATE_LOG_PATH="$LOG_PATH" \
  RELEASE_GATE_EXIT_CODE="$exit_code" \
  RELEASE_GATE_FAILED_STEP="$FAILED_STEP" \
  RELEASE_GATE_STEPS_FILE="$steps_file" \
  PILOT_SMOKE_OUTPUT_ROOT_PATH="$PILOT_SMOKE_OUTPUT_ROOT" \
  PILOT_SMOKE_REPORT_PATH="$PILOT_SMOKE_REPORT" \
  PILOT_SMOKE_REPORT_MD_PATH="$PILOT_SMOKE_REPORT_MD" \
  RELEASE_GATE_RUN_MODE="$RUN_MODE" \
  node <<'NODE'
const fs = require('fs')
const path = require('path')

const reportPath = process.env.REPORT_JSON_PATH
const reportMdPath = process.env.REPORT_MD_PATH || null
const operatorCommandsPath = process.env.COMMANDS_SH_PATH || null
const outputRoot = process.env.RELEASE_GATE_OUTPUT_ROOT || null
const fallbackLogPath = process.env.RELEASE_GATE_LOG_PATH || null
const exitCode = Number(process.env.RELEASE_GATE_EXIT_CODE || '0')
const failedStep = process.env.RELEASE_GATE_FAILED_STEP || null
const smokeOutputRoot = process.env.PILOT_SMOKE_OUTPUT_ROOT_PATH || null
const smokeReportPath = process.env.PILOT_SMOKE_REPORT_PATH || null
const smokeReportMdPath = process.env.PILOT_SMOKE_REPORT_MD_PATH || null
const runMode = process.env.RELEASE_GATE_RUN_MODE === 'staging' ? 'staging' : 'local'
const rows = fs.readFileSync(process.env.RELEASE_GATE_STEPS_FILE, 'utf8').trimEnd()
const checks = rows
  ? rows.split('\n').map((line) => {
      const [name, ok, status, command, log, envJson, note] = line.split('\t')
      const entry = {
        name,
        ok: ok === 'true',
        status,
        command,
        log: log || fallbackLogPath,
      }
      if (envJson) entry.env = JSON.parse(envJson)
      if (note) entry.note = note
      return entry
    })
  : []

function readOptionalJson(filePath) {
  if (!filePath) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

const smokeReport = readOptionalJson(smokeReportPath)
const smokeChecks = Array.isArray(smokeReport?.checks) ? smokeReport.checks : []
const embedNamespaceSeen = smokeChecks.some((check) => /^(ui|api)\.embed-host\./.test(String(check?.name || '')))

function summarizeEmbedEvidence(requiredWhenPresent) {
  const observedChecks = requiredWhenPresent.filter((name) => smokeChecks.some((item) => item?.name === name))
  const available = embedNamespaceSeen || observedChecks.length > 0
  const missingChecks = available
    ? requiredWhenPresent.filter((name) => !smokeChecks.some((item) => item?.name === name && item.ok))
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

const embedEvidence = [embedHostProtocol, embedHostNavigationProtection, embedHostDeferredReplay]
const embedHostAcceptance = {
  available: embedEvidence.some((item) => item.available),
  ok: embedEvidence.every((item) => item.ok),
  protocol: embedHostProtocol,
  navigationProtection: embedHostNavigationProtection,
  deferredReplay: embedHostDeferredReplay,
}

const liveSmoke = {
  available: Boolean(smokeReport),
  ok: smokeReport ? Boolean(smokeReport.ok) : true,
  outputRoot: smokeOutputRoot ? path.resolve(smokeOutputRoot) : null,
  report: smokeReportPath ? path.resolve(smokeReportPath) : null,
  reportMd: smokeReportMdPath ? path.resolve(smokeReportMdPath) : null,
  checkCount: smokeChecks.length,
  failingChecks: smokeChecks.filter((item) => item && item.ok === false).map((item) => item.name),
}

const failingEvidence = [
  liveSmoke.available && !liveSmoke.ok ? 'liveSmoke' : null,
  embedHostProtocol.available && !embedHostProtocol.ok ? 'embedHostProtocol' : null,
  embedHostNavigationProtection.available && !embedHostNavigationProtection.ok ? 'embedHostNavigationProtection' : null,
  embedHostDeferredReplay.available && !embedHostDeferredReplay.ok ? 'embedHostDeferredReplay' : null,
].filter(Boolean)

const resolvedOperatorCommandsPath = operatorCommandsPath ? path.resolve(operatorCommandsPath) : null
const operatorCommands = resolvedOperatorCommandsPath
  ? [
      { name: 'showArtifacts', command: `${resolvedOperatorCommandsPath} show-artifacts` },
      { name: 'rerunGate', command: `${resolvedOperatorCommandsPath} rerun-gate` },
      { name: 'rerunLiveSmoke', command: `${resolvedOperatorCommandsPath} rerun-live-smoke` },
      { name: 'showLogTail', command: `${resolvedOperatorCommandsPath} show-log-tail` },
    ]
  : []
const operatorChecklist = [
  {
    step: 1,
    title: 'Review the canonical gate report before promotion or replay',
    artifact: reportPath ? path.resolve(reportPath) : null,
  },
  {
    step: 2,
    title: 'Use the gate log when a failed step or replay needs diagnosis',
    artifact: fallbackLogPath ? path.resolve(fallbackLogPath) : null,
  },
  {
    step: 3,
    title: 'Use the helper instead of rebuilding replay commands by hand',
    artifact: resolvedOperatorCommandsPath,
  },
  {
    step: 4,
    title: 'Inspect raw live-smoke artifacts when embed-host evidence fails',
    artifact: smokeReportPath ? path.resolve(smokeReportPath) : smokeOutputRoot ? path.resolve(smokeOutputRoot) : null,
  },
]

const report = {
  ok: exitCode === 0 && checks.every((check) => check.ok) && failingEvidence.length === 0,
  runMode,
  outputRoot: outputRoot ? path.resolve(outputRoot) : null,
  reportPath: reportPath ? path.resolve(reportPath) : null,
  reportMdPath: reportMdPath ? path.resolve(reportMdPath) : null,
  logPath: fallbackLogPath ? path.resolve(fallbackLogPath) : null,
  operatorCommandsPath: operatorCommandsPath ? path.resolve(operatorCommandsPath) : null,
  exitCode,
  failedStep,
  failingEvidence,
  checks,
  liveSmoke,
  embedHostAcceptance,
  embedHostProtocol,
  embedHostNavigationProtection,
  embedHostDeferredReplay,
  operatorCommands,
  operatorChecklist,
  generatedAt: new Date().toISOString(),
}

if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}

if (reportMdPath) {
  const evidenceSection = (title, evidence) => [
    title,
    '',
    `- Available in smoke: \`${evidence.available ? 'true' : 'false'}\``,
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

  const lines = [
    '# Multitable Pilot Release Gate',
    '',
    `- Overall: **${report.ok ? 'PASS' : 'FAIL'}**`,
    `- Run mode: \`${runMode}\``,
    `- Exit code: \`${exitCode}\``,
    `- Output root: \`${report.outputRoot ?? 'missing'}\``,
    failedStep ? `- Failed step: \`${failedStep}\`` : '- Failed step: none',
    report.reportPath ? `- JSON report: \`${report.reportPath}\`` : '- JSON report: not written',
    `- Markdown report: \`${report.reportMdPath ?? 'missing'}\``,
    `- Log path: \`${report.logPath ?? 'missing'}\``,
    `- Operator helper: \`${report.operatorCommandsPath ?? 'missing'}\``,
    '',
    '## Step Checks',
    '',
    ...checks.map((check) => {
      const suffix = check.status === 'skipped' && check.note ? `; ${check.note}` : ''
      return `- \`${check.name}\`: **${check.ok ? 'PASS' : 'FAIL'}** (\`${check.status}\`)${suffix}`
    }),
    '',
    '## Live Smoke Artifact',
    '',
    `- Available: \`${liveSmoke.available ? 'true' : 'false'}\``,
    `- Status: **${liveSmoke.ok ? 'PASS' : 'FAIL'}**`,
    liveSmoke.outputRoot ? `- Output root: \`${liveSmoke.outputRoot}\`` : '- Output root: missing',
    liveSmoke.report ? `- Report: \`${liveSmoke.report}\`` : '- Report: missing',
    liveSmoke.reportMd ? `- Markdown: \`${liveSmoke.reportMd}\`` : '- Markdown: missing',
    `- Check count: \`${liveSmoke.checkCount}\``,
    liveSmoke.failingChecks.length
      ? `- Failing checks: ${liveSmoke.failingChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Failing checks: none',
    '',
    '## Embed Host Acceptance',
    '',
    `- Available in smoke: \`${embedHostAcceptance.available ? 'true' : 'false'}\``,
    `- Status: **${embedHostAcceptance.ok ? 'PASS' : 'FAIL'}**`,
    failingEvidence.length
      ? `- Failing evidence: ${failingEvidence.map((item) => `\`${item}\``).join(', ')}`
      : '- Failing evidence: none',
    '',
    ...evidenceSection('### Embed Host Protocol Evidence', embedHostProtocol),
    ...evidenceSection('### Embed Host Navigation Protection', embedHostNavigationProtection),
    ...evidenceSection('### Embed Host Busy Deferred Replay', embedHostDeferredReplay),
    '## Operator Checklist',
    '',
    ...operatorChecklist.map((item) => `- ${item.step}. ${item.title}${item.artifact ? `: \`${item.artifact}\`` : ''}`),
    '',
    '## Operator Commands',
    '',
    `- Helper: \`${report.operatorCommandsPath ?? 'missing'}\``,
    report.operatorCommandsPath
      ? `- Show artifacts: \`${report.operatorCommandsPath} show-artifacts\``
      : '- Show artifacts: missing',
    report.operatorCommandsPath
      ? `- Rerun gate: \`${report.operatorCommandsPath} rerun-gate\``
      : '- Rerun gate: missing',
    report.operatorCommandsPath
      ? `- Rerun live smoke: \`${report.operatorCommandsPath} rerun-live-smoke\``
      : '- Rerun live smoke: missing',
    report.operatorCommandsPath
      ? `- Tail log: \`${report.operatorCommandsPath} show-log-tail\``
      : '- Tail log: missing',
    '',
  ]

  fs.mkdirSync(path.dirname(reportMdPath), { recursive: true })
  fs.writeFileSync(reportMdPath, `${lines.join('\n')}\n`)
}
NODE
  rm -f "$steps_file"
}

run_release_gate_step() {
  local index="$1"
  local name="${STEP_NAMES[$index]}"
  local command="${STEP_COMMANDS[$index]}"
  local env_json="${STEP_ENVS[$index]}"

  if [[ "${STEP_STATUSES[$index]}" == "skipped" ]]; then
    log_release_gate "[step] name=${name} status=skipped note=${STEP_NOTES[$index]:-none}"
    return 0
  fi

  local -a env_args=()
  if [[ -n "$env_json" ]]; then
    while IFS= read -r env_arg; do
      [[ -z "$env_arg" ]] && continue
      env_args+=("$env_arg")
    done < <(
      RELEASE_GATE_ENV_JSON="$env_json" \
      node <<'NODE'
const raw = process.env.RELEASE_GATE_ENV_JSON
if (!raw) process.exit(0)
const envMap = JSON.parse(raw)
for (const [key, value] of Object.entries(envMap)) {
  process.stdout.write(`${key}=${String(value)}\n`)
}
NODE
    )
  fi

  log_release_gate "[step] name=${name} status=running"
  log_release_gate "[step] name=${name} command=${command}"

  set +e
  if [[ "${#env_args[@]}" -gt 0 ]]; then
    env "${env_args[@]}" bash -c "$command" >>"$LOG_PATH" 2>&1
  else
    bash -c "$command" >>"$LOG_PATH" 2>&1
  fi
  local step_exit=$?
  set -e

  if [[ "$step_exit" -eq 0 ]]; then
    STEP_STATUSES[$index]="passed"
    log_release_gate "[step] name=${name} status=passed"
    return 0
  fi

  STEP_STATUSES[$index]="failed"
  FAILED_STEP="$name"
  SCRIPT_EXIT_CODE="$step_exit"
  log_release_gate "[step] name=${name} status=failed exit=${step_exit}"
  echo "[multitable-pilot-release-gate] ERROR: ${name} failed with exit ${step_exit}" >&2
  return "$step_exit"
}

cleanup_release_gate() {
  local exit_code=$?
  trap - EXIT
  if [[ "$SCRIPT_EXIT_CODE" -eq 0 && "$exit_code" -ne 0 ]]; then
    SCRIPT_EXIT_CODE="$exit_code"
  fi
  set +e
  log_release_gate "[gate] completed exit=${SCRIPT_EXIT_CODE} failed_step=${FAILED_STEP:-none}"
  write_release_gate_operator_commands
  write_release_gate_report "$SCRIPT_EXIT_CODE"
  exit "$SCRIPT_EXIT_CODE"
}

main() {
  init_release_gate_log
  define_release_gate_steps

  local index
  for index in "${!STEP_NAMES[@]}"; do
    if ! run_release_gate_step "$index"; then
      return "$SCRIPT_EXIT_CODE"
    fi
  done
}

trap cleanup_release_gate EXIT
main "$@"
