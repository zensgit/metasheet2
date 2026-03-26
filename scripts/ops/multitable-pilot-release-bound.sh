#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ONPREM_GATE_REPORT_JSON="${ONPREM_GATE_REPORT_JSON:-}"
ONPREM_GATE_STAMP="${ONPREM_GATE_STAMP:-}"
RUN_STAMP="${RUN_STAMP:-$(date +%Y%m%d-%H%M%S)}"
RUN_MODE="${RUN_MODE:-local}"
STAMP_WITH_SUFFIX="${RUN_STAMP}"
if [[ "${STAMP_WITH_SUFFIX}" != *"-release-bound" ]]; then
  STAMP_WITH_SUFFIX="${STAMP_WITH_SUFFIX}-release-bound"
fi
READY_OUTPUT_ROOT_DEFAULT="output/playwright/multitable-pilot-ready-local/${STAMP_WITH_SUFFIX}"
HANDOFF_OUTPUT_ROOT_DEFAULT="output/playwright/multitable-pilot-handoff"
REPORT_ROOT_DEFAULT="output/playwright/multitable-pilot-release-bound/${RUN_STAMP}"
RELEASE_BOUND_COMMAND="pnpm prepare:multitable-pilot:release-bound"
REFRESH_READINESS_COMMAND="pnpm verify:multitable-pilot:ready:local:release-bound"
REFRESH_HANDOFF_COMMAND="pnpm prepare:multitable-pilot:handoff:release-bound"

if [[ "${RUN_MODE}" == "staging" ]]; then
  READY_OUTPUT_ROOT_DEFAULT="output/playwright/multitable-pilot-ready-staging/${STAMP_WITH_SUFFIX}"
  HANDOFF_OUTPUT_ROOT_DEFAULT="output/playwright/multitable-pilot-handoff-staging"
  REPORT_ROOT_DEFAULT="output/playwright/multitable-pilot-release-bound-staging/${RUN_STAMP}"
  RELEASE_BOUND_COMMAND="pnpm prepare:multitable-pilot:release-bound:staging"
  REFRESH_READINESS_COMMAND="pnpm verify:multitable-pilot:ready:staging:release-bound"
  REFRESH_HANDOFF_COMMAND="pnpm prepare:multitable-pilot:handoff:staging:release-bound"
fi

READY_OUTPUT_ROOT="${READY_OUTPUT_ROOT:-${READY_OUTPUT_ROOT_DEFAULT}}"
HANDOFF_OUTPUT_ROOT="${HANDOFF_OUTPUT_ROOT:-${HANDOFF_OUTPUT_ROOT_DEFAULT}}"
REPORT_ROOT="${REPORT_ROOT:-${REPORT_ROOT_DEFAULT}}"
REPORT_JSON="${REPORT_ROOT}/report.json"
REPORT_MD="${REPORT_ROOT}/report.md"
REPORT_TMP_JSON="${REPORT_ROOT}/report.tmp.json"
REPORT_TMP_MD="${REPORT_ROOT}/report.tmp.md"
COMMANDS_SH="${REPORT_ROOT}/operator-commands.sh"
COMMANDS_SH_TMP="${REPORT_ROOT}/operator-commands.sh.tmp"
QUICKSTART_TEMPLATE_NAME="multitable-pilot-quickstart-20260319.md"
DAILY_TRIAGE_TEMPLATE_NAME="multitable-pilot-daily-triage-template-20260319.md"
GO_NOGO_TEMPLATE_NAME="multitable-pilot-go-no-go-template-20260319.md"
PILOT_EXPANSION_TEMPLATE_NAME="multitable-pilot-expansion-decision-template-20260323.md"
UAT_SIGNOFF_TEMPLATE_NAME="multitable-uat-signoff-template-20260323.md"
CUSTOMER_DELIVERY_SIGNOFF_TEMPLATE_NAME="multitable-customer-delivery-signoff-template-20260323.md"
FEEDBACK_TEMPLATE_NAME="multitable-pilot-feedback-template-20260319.md"
DEFAULT_PREFLIGHT_REPORT_JSON="/opt/metasheet/output/preflight/multitable-onprem-preflight.json"
DEFAULT_PREFLIGHT_REPORT_MD="/opt/metasheet/output/preflight/multitable-onprem-preflight.md"

if [[ -z "$ONPREM_GATE_REPORT_JSON" && -n "$ONPREM_GATE_STAMP" ]]; then
  ONPREM_GATE_REPORT_JSON="${ROOT_DIR}/output/releases/multitable-onprem/gates/${ONPREM_GATE_STAMP}/report.json"
fi

if [[ -z "$ONPREM_GATE_REPORT_JSON" ]]; then
  echo "[multitable-pilot-release-bound] ERROR: set ONPREM_GATE_STAMP or ONPREM_GATE_REPORT_JSON" >&2
  echo "[multitable-pilot-release-bound] Example: ONPREM_GATE_STAMP=20260323-083713 ENSURE_PLAYWRIGHT=false ${RELEASE_BOUND_COMMAND}" >&2
  exit 1
fi

if [[ ! -f "$ONPREM_GATE_REPORT_JSON" ]]; then
  echo "[multitable-pilot-release-bound] ERROR: on-prem gate report not found: ${ONPREM_GATE_REPORT_JSON}" >&2
  exit 1
fi

READY_OUTPUT_ROOT_ABS="${ROOT_DIR}/${READY_OUTPUT_ROOT}"
HANDOFF_ROOT_ABS="${ROOT_DIR}/${HANDOFF_OUTPUT_ROOT}/$(basename "${READY_OUTPUT_ROOT_ABS}")"
REPORT_ROOT_ABS="${ROOT_DIR}/${REPORT_ROOT}"

mkdir -p "${REPORT_ROOT_ABS}"

echo "[multitable-pilot-release-bound] Running release-bound readiness" >&2
echo "[multitable-pilot-release-bound] run_mode=${RUN_MODE}" >&2
ONPREM_GATE_REPORT_JSON="${ONPREM_GATE_REPORT_JSON}" \
RUN_MODE="${RUN_MODE}" \
OUTPUT_ROOT="${READY_OUTPUT_ROOT}" \
bash scripts/ops/multitable-pilot-ready-release-bound.sh

echo "[multitable-pilot-release-bound] Running release-bound handoff" >&2
ONPREM_GATE_REPORT_JSON="${ONPREM_GATE_REPORT_JSON}" \
RUN_MODE="${RUN_MODE}" \
PILOT_RUN_MODE="${RUN_MODE}" \
READINESS_ROOT="${READY_OUTPUT_ROOT_ABS}" \
HANDOFF_OUTPUT_ROOT="${HANDOFF_OUTPUT_ROOT}" \
bash scripts/ops/multitable-pilot-handoff-release-bound.sh

generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
HANDOFF_RECOMMENDED_TEMPLATES_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(data.recommendedTemplates||{}))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;process.stdout.write(JSON.stringify(runner))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_AVAILABLE="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;process.stdout.write(String(runner?.available===true?'true':'false'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_OK="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;process.stdout.write(String(runner?.ok===false?'false':'true'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_MODE="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;process.stdout.write(String(runner?.runMode||'local'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_REPORT="$(node -e "const fs=require('fs');const path=require('path');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;process.stdout.write(String(runner?.report||''))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_REPORT_MD="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;process.stdout.write(String(runner?.reportMd||''))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_REPORT_BASENAME="$(node -e "const fs=require('fs');const path=require('path');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;const fallback=(runner?.runMode==='staging'?'staging-report.json':'local-report.json');const report=runner?.report||fallback;process.stdout.write(path.basename(report))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_REPORT_MD_BASENAME="$(node -e "const fs=require('fs');const path=require('path');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;const fallback=(runner?.runMode==='staging'?'staging-report.md':'local-report.md');const report=runner?.reportMd||fallback;process.stdout.write(path.basename(report))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_BACKEND_MODE="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;process.stdout.write(String(runner?.serviceModes?.backend||'unknown'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_LOCAL_RUNNER_WEB_MODE="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const runner=data.pilotRunner||data.localRunner||null;process.stdout.write(String(runner?.serviceModes?.web||'unknown'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_ACCEPTANCE_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(data.embedHostAcceptance||null))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_PROTOCOL_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(data.embedHostProtocol||null))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_NAVIGATION_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(data.embedHostNavigationProtection||null))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_DEFERRED_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(data.embedHostDeferredReplay||null))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_ACCEPTANCE_OK="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(String(data?.embedHostAcceptance?.ok===false?'false':'true'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_PROTOCOL_AVAILABLE="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(String(data?.embedHostProtocol?.available===true?'true':'false'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_PROTOCOL_OK="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(String(data?.embedHostProtocol?.ok===false?'false':'true'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_NAVIGATION_AVAILABLE="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(String(data?.embedHostNavigationProtection?.available===true?'true':'false'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_NAVIGATION_OK="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(String(data?.embedHostNavigationProtection?.ok===false?'false':'true'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_DEFERRED_AVAILABLE="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(String(data?.embedHostDeferredReplay?.available===true?'true':'false'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_DEFERRED_OK="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(String(data?.embedHostDeferredReplay?.ok===false?'false':'true'))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_READINESS_GATE_OPERATOR_COMMANDS_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const contract=data?.readinessGateOperatorContract;const fallback=data?.artifactChecks?.readinessGate;const value=Array.isArray(contract?.operatorCommandEntries)?contract.operatorCommandEntries:Array.isArray(fallback?.operatorCommandEntries)?fallback.operatorCommandEntries:[];process.stdout.write(JSON.stringify(value))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_READINESS_GATE_OPERATOR_CHECKLIST_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const contract=data?.readinessGateOperatorContract;const fallback=data?.artifactChecks?.readinessGate;const value=Array.isArray(contract?.operatorChecklist)?contract.operatorChecklist:Array.isArray(fallback?.operatorChecklist)?fallback.operatorChecklist:[];process.stdout.write(JSON.stringify(value))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_READINESS_GATE_OPERATOR_COMMAND_NAMES="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const contract=data?.readinessGateOperatorContract;const fallback=data?.artifactChecks?.readinessGate;const value=Array.isArray(contract?.operatorCommandEntries)?contract.operatorCommandEntries:Array.isArray(fallback?.operatorCommandEntries)?fallback.operatorCommandEntries:[];process.stdout.write(value.length?value.map((item)=>String(item?.name||'unnamed')).join(', '):'none')" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_READINESS_GATE_OPERATOR_CHECKLIST_SUMMARY="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const contract=data?.readinessGateOperatorContract;const fallback=data?.artifactChecks?.readinessGate;const value=Array.isArray(contract?.operatorChecklist)?contract.operatorChecklist:Array.isArray(fallback?.operatorChecklist)?fallback.operatorChecklist:[];process.stdout.write(value.length?value.map((item)=>(String(item?.step ?? '?') + '. ' + String(item?.title || 'untitled'))).join(', '):'none')" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_EMBED_HOST_ACCEPTANCE_STATUS="FAIL"
HANDOFF_EMBED_HOST_PROTOCOL_STATUS="FAIL"
HANDOFF_EMBED_HOST_NAVIGATION_STATUS="FAIL"
HANDOFF_EMBED_HOST_DEFERRED_STATUS="FAIL"
HANDOFF_LOCAL_RUNNER_STATUS="FAIL"
if [[ "${HANDOFF_LOCAL_RUNNER_OK}" == "true" ]]; then
  HANDOFF_LOCAL_RUNNER_STATUS="PASS"
fi
if [[ "${HANDOFF_EMBED_HOST_ACCEPTANCE_OK}" == "true" ]]; then
  HANDOFF_EMBED_HOST_ACCEPTANCE_STATUS="PASS"
fi
if [[ "${HANDOFF_EMBED_HOST_PROTOCOL_OK}" == "true" ]]; then
  HANDOFF_EMBED_HOST_PROTOCOL_STATUS="PASS"
fi
if [[ "${HANDOFF_EMBED_HOST_NAVIGATION_OK}" == "true" ]]; then
  HANDOFF_EMBED_HOST_NAVIGATION_STATUS="PASS"
fi
if [[ "${HANDOFF_EMBED_HOST_DEFERRED_OK}" == "true" ]]; then
  HANDOFF_EMBED_HOST_DEFERRED_STATUS="PASS"
fi
HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const value=data?.artifactChecks?.preflight?.preflightReportJsonDefault||'';process.stdout.write(String(value))" "${HANDOFF_ROOT_ABS}/handoff.json")"
HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const value=data?.artifactChecks?.preflight?.preflightReportMdDefault||'';process.stdout.write(String(value))" "${HANDOFF_ROOT_ABS}/handoff.json")"
if [[ -z "$HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT" ]]; then
  HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT="$DEFAULT_PREFLIGHT_REPORT_JSON"
fi
if [[ -z "$HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT" ]]; then
  HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT="$DEFAULT_PREFLIGHT_REPORT_MD"
fi
HANDOFF_PREFLIGHT_ENV_TEMPLATE="${HANDOFF_ROOT_ABS}/artifacts/preflight/multitable-onprem-preflight.env.example.sh"
HANDOFF_PREFLIGHT_HELPER="${HANDOFF_ROOT_ABS}/artifacts/preflight/multitable-onprem-preflight.sh"
HANDOFF_REPAIR_HELPER="${HANDOFF_ROOT_ABS}/artifacts/preflight/multitable-onprem-repair-helper.sh"
SIGNOFF_STEP1_COMMAND="set -a && source ${HANDOFF_PREFLIGHT_ENV_TEMPLATE} && set +a && bash ${HANDOFF_PREFLIGHT_HELPER}"

cat > "${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH_TMP}")" <<EOF
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR}"
ONPREM_GATE_REPORT_JSON="${ONPREM_GATE_REPORT_JSON}"
READY_OUTPUT_ROOT="${READY_OUTPUT_ROOT_ABS}"
PREFLIGHT_REPORT_JSON="${HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT}"
PREFLIGHT_REPORT_MD="${HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT}"

print_signoff_evidence() {
  cat <<USAGE
Required sign-off evidence:
  - \${PREFLIGHT_REPORT_JSON}
  - \${PREFLIGHT_REPORT_MD}
Do not close checkpoint, expansion, UAT, or customer sign-off until both files are returned.
Run preflight first:
  ${SIGNOFF_STEP1_COMMAND}
If preflight fails:
  Run the first command shown under "One-Line Quick Fix Commands" in the generated preflight report.
Repair helper:
  ${HANDOFF_REPAIR_HELPER}
USAGE
}

print_signoff_reminder() {
  echo "[operator-commands] Sign-off evidence: \${PREFLIGHT_REPORT_JSON} and \${PREFLIGHT_REPORT_MD}" >&2
}

case "\${1:-help}" in
  help|-h|--help)
    cat <<'USAGE'
Usage: operator-commands.sh <command>

Commands:
  rerun-release-bound
  refresh-readiness
  refresh-handoff
  show-signoff-evidence
USAGE
    echo
    print_signoff_evidence
    ;;
  rerun-release-bound)
    print_signoff_reminder
    cd "\${ROOT_DIR}"
    exec env ONPREM_GATE_REPORT_JSON="\${ONPREM_GATE_REPORT_JSON}" ENSURE_PLAYWRIGHT=false ${RELEASE_BOUND_COMMAND}
    ;;
  refresh-readiness)
    print_signoff_reminder
    cd "\${ROOT_DIR}"
    exec env ONPREM_GATE_REPORT_JSON="\${ONPREM_GATE_REPORT_JSON}" OUTPUT_ROOT="\${READY_OUTPUT_ROOT}" ${REFRESH_READINESS_COMMAND}
    ;;
  refresh-handoff)
    print_signoff_reminder
    cd "\${ROOT_DIR}"
    exec env ONPREM_GATE_REPORT_JSON="\${ONPREM_GATE_REPORT_JSON}" READINESS_ROOT="\${READY_OUTPUT_ROOT}" ${REFRESH_HANDOFF_COMMAND}
    ;;
  show-signoff-evidence)
    print_signoff_evidence
    ;;
  *)
    echo "Unknown command: \$1" >&2
    exit 1
    ;;
esac
EOF
mv "${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH_TMP}")" "${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}")"
chmod +x "${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}")"

printf '%s\n' \
  '{' \
  '  "ok": true,' \
  "  \"generatedAt\": \"${generated_at}\"," \
  "  \"runMode\": \"${RUN_MODE}\"," \
  "  \"onPremGateReportJson\": \"${ONPREM_GATE_REPORT_JSON}\"," \
  "  \"readinessRoot\": \"${READY_OUTPUT_ROOT_ABS}\"," \
  "  \"readinessJson\": \"${READY_OUTPUT_ROOT_ABS}/readiness.json\"," \
  "  \"readinessMd\": \"${READY_OUTPUT_ROOT_ABS}/readiness.md\"," \
  "  \"readinessGateReport\": \"${READY_OUTPUT_ROOT_ABS}/gates/report.json\"," \
  "  \"readinessGateReportMd\": \"${READY_OUTPUT_ROOT_ABS}/gates/report.md\"," \
  "  \"readinessGateLog\": \"${READY_OUTPUT_ROOT_ABS}/gates/release-gate.log\"," \
  "  \"readinessGateOperatorCommands\": \"${READY_OUTPUT_ROOT_ABS}/gates/operator-commands.sh\"," \
  '  "readinessGateOperatorContract": {' \
  "    \"helper\": \"${READY_OUTPUT_ROOT_ABS}/gates/operator-commands.sh\"," \
  "    \"operatorCommandEntries\": ${HANDOFF_READINESS_GATE_OPERATOR_COMMANDS_JSON}," \
  "    \"operatorChecklist\": ${HANDOFF_READINESS_GATE_OPERATOR_CHECKLIST_JSON}" \
  '  },' \
  "  \"handoffRoot\": \"${HANDOFF_ROOT_ABS}\"," \
  "  \"handoffJson\": \"${HANDOFF_ROOT_ABS}/handoff.json\"," \
  "  \"handoffMd\": \"${HANDOFF_ROOT_ABS}/handoff.md\"," \
  "  \"operatorCommandScript\": \"${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}")\"," \
  "  \"recommendedTemplates\": ${HANDOFF_RECOMMENDED_TEMPLATES_JSON}," \
  "  \"pilotRunner\": ${HANDOFF_LOCAL_RUNNER_JSON}," \
  "  \"localRunner\": ${HANDOFF_LOCAL_RUNNER_JSON}," \
  "  \"embedHostAcceptance\": ${HANDOFF_EMBED_HOST_ACCEPTANCE_JSON}," \
  "  \"embedHostProtocol\": ${HANDOFF_EMBED_HOST_PROTOCOL_JSON}," \
  "  \"embedHostNavigationProtection\": ${HANDOFF_EMBED_HOST_NAVIGATION_JSON}," \
  "  \"embedHostDeferredReplay\": ${HANDOFF_EMBED_HOST_DEFERRED_JSON}," \
  '  "expectedOperatorEvidence": {' \
  "    \"preflightReportJson\": \"${HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT}\"," \
  "    \"preflightReportMd\": \"${HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT}\"" \
  '  },' \
  '  "signoffRecoveryPath": {' \
  "    \"step1RunPreflight\": \"${SIGNOFF_STEP1_COMMAND}\"," \
  '    "step2RepairInstruction": "If preflight fails, run the first command shown under \"One-Line Quick Fix Commands\" in the generated preflight report.",' \
  "    \"step2RepairHelper\": \"${HANDOFF_REPAIR_HELPER}\"," \
  '    "step3ReturnEvidence": [' \
  "      \"${HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT}\"," \
  "      \"${HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT}\"" \
  '    ]' \
  '  },' \
  '  "operatorCommands": [' \
  '    {' \
  '      "name": "showSignoffEvidence",' \
  "      \"command\": \"${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}") show-signoff-evidence\"" \
  '    },' \
  '    {' \
  '      "name": "rerunReleaseBound",' \
  "      \"command\": \"ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} ENSURE_PLAYWRIGHT=false ${RELEASE_BOUND_COMMAND}\"" \
  '    },' \
  '    {' \
  '      "name": "refreshReadiness",' \
  "      \"command\": \"ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} OUTPUT_ROOT=${READY_OUTPUT_ROOT_ABS} ${REFRESH_READINESS_COMMAND}\"" \
  '    },' \
  '    {' \
  '      "name": "refreshHandoff",' \
  "      \"command\": \"ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} READINESS_ROOT=${READY_OUTPUT_ROOT_ABS} ${REFRESH_HANDOFF_COMMAND}\"" \
  '    }' \
  '  ],' \
  '  "operatorChecklist": [' \
  '    {' \
  '      "step": 1,' \
  '      "title": "Review the bound on-prem gate before sharing pilot artifacts",' \
  "      \"artifact\": \"${ONPREM_GATE_REPORT_JSON}\"" \
  '    },' \
  '    {' \
  '      "step": 2,' \
  '      "title": "Share the readiness bundle and canonical gate report with the pilot owner",' \
  "      \"artifact\": \"${READY_OUTPUT_ROOT_ABS}/gates/report.json\"" \
  '    },' \
  '    {' \
  '      "step": 3,' \
  '      "title": "Use the handoff bundle as the operating index for triage and sign-off",' \
  "      \"artifact\": \"${HANDOFF_ROOT_ABS}/handoff.md\"" \
  '    },' \
  '    {' \
  '      "step": 4,' \
  '      "title": "Pick the correct template for checkpoint, expansion, UAT, or customer delivery",' \
  "      \"artifact\": \"${HANDOFF_ROOT_ABS}/docs/${GO_NOGO_TEMPLATE_NAME}\"" \
  '    },' \
  '    {' \
  '      "step": 5,' \
  '      "title": "Collect the on-prem preflight json and markdown reports before pilot sign-off or expansion review",' \
  "      \"artifact\": \"${HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT}\"" \
  '    }' \
  '  ]' \
  '}' > "${REPORT_TMP_JSON}"
mv "${REPORT_TMP_JSON}" "${REPORT_JSON}"

printf '%s\n' \
  '# Multitable Pilot Release-Bound Report' \
  '' \
  "- Generated at: \`${generated_at}\`" \
  "- Run mode: \`${RUN_MODE}\`" \
  "- On-prem gate report: \`${ONPREM_GATE_REPORT_JSON}\`" \
  "- Readiness root: \`${READY_OUTPUT_ROOT_ABS}\`" \
  "- Readiness gate report: \`${READY_OUTPUT_ROOT_ABS}/gates/report.json\`" \
  "- Readiness gate markdown: \`${READY_OUTPUT_ROOT_ABS}/gates/report.md\`" \
  "- Readiness gate log: \`${READY_OUTPUT_ROOT_ABS}/gates/release-gate.log\`" \
  "- Readiness gate helper: \`${READY_OUTPUT_ROOT_ABS}/gates/operator-commands.sh\`" \
  "- Handoff root: \`${HANDOFF_ROOT_ABS}\`" \
  '' \
  '## Readiness Gate Operator Contract' \
  '' \
  "- Helper: \`${READY_OUTPUT_ROOT_ABS}/gates/operator-commands.sh\`" \
  "- Operator commands: ${HANDOFF_READINESS_GATE_OPERATOR_COMMAND_NAMES}" \
  "- Operator checklist: ${HANDOFF_READINESS_GATE_OPERATOR_CHECKLIST_SUMMARY}" \
  '' \
  '## Recommended Templates' \
  '' \
  "- Team quickstart: \`${HANDOFF_ROOT_ABS}/docs/${QUICKSTART_TEMPLATE_NAME}\`" \
  "- Daily issue review: \`${HANDOFF_ROOT_ABS}/docs/${DAILY_TRIAGE_TEMPLATE_NAME}\`" \
  "- Pilot checkpoint: \`${HANDOFF_ROOT_ABS}/docs/${GO_NOGO_TEMPLATE_NAME}\`" \
  "- Pilot expansion decision: \`${HANDOFF_ROOT_ABS}/docs/${PILOT_EXPANSION_TEMPLATE_NAME}\`" \
  "- Controlled rollout / UAT sign-off: \`${HANDOFF_ROOT_ABS}/docs/${UAT_SIGNOFF_TEMPLATE_NAME}\`" \
  "- Customer delivery receipt: \`${HANDOFF_ROOT_ABS}/docs/${CUSTOMER_DELIVERY_SIGNOFF_TEMPLATE_NAME}\`" \
  "- Feedback intake: \`${HANDOFF_ROOT_ABS}/docs/${FEEDBACK_TEMPLATE_NAME}\`" \
  '' \
  '## Pilot Runner' \
  '' \
  "- Available: \`${HANDOFF_LOCAL_RUNNER_AVAILABLE}\`" \
  "- Status: **${HANDOFF_LOCAL_RUNNER_STATUS}**" \
  "- Run mode: \`${HANDOFF_LOCAL_RUNNER_MODE}\`" \
  "- Backend mode: \`${HANDOFF_LOCAL_RUNNER_BACKEND_MODE}\`" \
  "- Web mode: \`${HANDOFF_LOCAL_RUNNER_WEB_MODE}\`" \
  "- Detailed pilot runner summary remains in \`${HANDOFF_ROOT_ABS}/handoff.md\` and \`${READY_OUTPUT_ROOT_ABS}/readiness.md\`." \
  '' \
  '## Operator Checklist' \
  '' \
  "- Review the bound on-prem gate report: \`${ONPREM_GATE_REPORT_JSON}\`" \
  "- Share \`${READY_OUTPUT_ROOT_ABS}/readiness.md\` and \`${READY_OUTPUT_ROOT_ABS}/gates/report.json\` with the pilot owner and confirm the rollout still matches the bound gate." \
  "- Use \`${READY_OUTPUT_ROOT_ABS}/gates/report.md\`, \`${READY_OUTPUT_ROOT_ABS}/gates/release-gate.log\`, and \`${READY_OUTPUT_ROOT_ABS}/gates/operator-commands.sh\` for operator-side diagnosis and replay when gate checks fail." \
  "- Use \`${HANDOFF_ROOT_ABS}/handoff.md\` as the operating index for daily triage, checkpoint review, and sign-off follow-up." \
  "- Select the correct template from \`${HANDOFF_ROOT_ABS}/docs\` before running checkpoint, expansion, UAT, or customer delivery sign-off." \
  "- Collect \`${HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT}\` and \`${HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT}\` before pilot sign-off or expansion review." \
  '' \
  '## Operator Commands' \
  '' \
  "- Readiness gate helper: \`${READY_OUTPUT_ROOT_ABS}/gates/operator-commands.sh\`" \
  "- Executable helper: \`${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}")\`" \
  "- Show sign-off evidence: \`${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}") show-signoff-evidence\`" \
  "- Rerun bound packet: \`ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} ENSURE_PLAYWRIGHT=false ${RELEASE_BOUND_COMMAND}\`" \
  "- Refresh readiness only: \`ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} OUTPUT_ROOT=${READY_OUTPUT_ROOT_ABS} ${REFRESH_READINESS_COMMAND}\`" \
  "- Refresh handoff only: \`ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} READINESS_ROOT=${READY_OUTPUT_ROOT_ABS} ${REFRESH_HANDOFF_COMMAND}\`" \
  '' \
  '## Expected Follow-up Evidence' \
  '' \
  "- Preflight report JSON: \`${HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT}\`" \
  "- Preflight report Markdown: \`${HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT}\`" \
  '' \
  '## Embed Host Acceptance' \
  '' \
  "- Overall embed-host acceptance: **${HANDOFF_EMBED_HOST_ACCEPTANCE_STATUS}**" \
  "- Protocol evidence available: \`${HANDOFF_EMBED_HOST_PROTOCOL_AVAILABLE}\`" \
  "- Protocol status: **${HANDOFF_EMBED_HOST_PROTOCOL_STATUS}**" \
  "- Navigation protection available: \`${HANDOFF_EMBED_HOST_NAVIGATION_AVAILABLE}\`" \
  "- Navigation protection status: **${HANDOFF_EMBED_HOST_NAVIGATION_STATUS}**" \
  "- Busy deferred replay available: \`${HANDOFF_EMBED_HOST_DEFERRED_AVAILABLE}\`" \
  "- Busy deferred replay status: **${HANDOFF_EMBED_HOST_DEFERRED_STATUS}**" \
  "- Detailed checks remain in \`${HANDOFF_ROOT_ABS}/handoff.md\` and \`${READY_OUTPUT_ROOT_ABS}/readiness.md\`." \
  '' \
  '## Sign-Off Recovery Path' \
  '' \
  "- Step 1 command: \`${SIGNOFF_STEP1_COMMAND}\`" \
  '- If preflight fails, run the first line shown under \`One-Line Quick Fix Commands\` in the generated preflight report.' \
  "- Repair helper path: \`${HANDOFF_REPAIR_HELPER}\`" \
  "- Return both files: \`${HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT}\`, \`${HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT}\`" \
  '' \
  '## Outputs' \
  '' \
  "- \`${READY_OUTPUT_ROOT_ABS}/readiness.md\`" \
  "- \`${READY_OUTPUT_ROOT_ABS}/readiness.json\`" \
  "- \`${READY_OUTPUT_ROOT_ABS}/gates/report.json\`" \
  "- \`${READY_OUTPUT_ROOT_ABS}/gates/report.md\`" \
  "- \`${READY_OUTPUT_ROOT_ABS}/gates/release-gate.log\`" \
  "- \`${READY_OUTPUT_ROOT_ABS}/gates/operator-commands.sh\`" \
  "- \`${READY_OUTPUT_ROOT_ABS}/smoke/report.md\`" \
  "- \`${READY_OUTPUT_ROOT_ABS}/smoke/${HANDOFF_LOCAL_RUNNER_REPORT_BASENAME}\`" \
  "- \`${READY_OUTPUT_ROOT_ABS}/smoke/${HANDOFF_LOCAL_RUNNER_REPORT_MD_BASENAME}\`" \
  "- \`${HANDOFF_ROOT_ABS}/handoff.md\`" \
  "- \`${HANDOFF_ROOT_ABS}/handoff.json\`" \
  > "${REPORT_TMP_MD}"
mv "${REPORT_TMP_MD}" "${REPORT_MD}"

mkdir -p "${HANDOFF_ROOT_ABS}/release-bound"
cp "${REPORT_JSON}" "${HANDOFF_ROOT_ABS}/release-bound/report.json"
cp "${REPORT_MD}" "${HANDOFF_ROOT_ABS}/release-bound/report.md"
cp "${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}")" "${HANDOFF_ROOT_ABS}/release-bound/operator-commands.sh"

echo "[multitable-pilot-release-bound] PASS: release-bound pilot bundle complete" >&2
echo "[multitable-pilot-release-bound] report_json=${REPORT_JSON}" >&2
echo "[multitable-pilot-release-bound] report_md=${REPORT_MD}" >&2
