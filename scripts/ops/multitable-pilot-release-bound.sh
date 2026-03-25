#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ONPREM_GATE_REPORT_JSON="${ONPREM_GATE_REPORT_JSON:-}"
ONPREM_GATE_STAMP="${ONPREM_GATE_STAMP:-}"
RUN_STAMP="${RUN_STAMP:-$(date +%Y%m%d-%H%M%S)}"
STAMP_WITH_SUFFIX="${RUN_STAMP}"
if [[ "${STAMP_WITH_SUFFIX}" != *"-release-bound" ]]; then
  STAMP_WITH_SUFFIX="${STAMP_WITH_SUFFIX}-release-bound"
fi
READY_OUTPUT_ROOT="${READY_OUTPUT_ROOT:-output/playwright/multitable-pilot-ready-local/${STAMP_WITH_SUFFIX}}"
HANDOFF_OUTPUT_ROOT="${HANDOFF_OUTPUT_ROOT:-output/playwright/multitable-pilot-handoff}"
REPORT_ROOT="${REPORT_ROOT:-output/playwright/multitable-pilot-release-bound/${RUN_STAMP}}"
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
  echo "[multitable-pilot-release-bound] Example: ONPREM_GATE_STAMP=20260323-083713 ENSURE_PLAYWRIGHT=false pnpm prepare:multitable-pilot:release-bound" >&2
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
ONPREM_GATE_REPORT_JSON="${ONPREM_GATE_REPORT_JSON}" \
OUTPUT_ROOT="${READY_OUTPUT_ROOT}" \
bash scripts/ops/multitable-pilot-ready-release-bound.sh

echo "[multitable-pilot-release-bound] Running release-bound handoff" >&2
ONPREM_GATE_REPORT_JSON="${ONPREM_GATE_REPORT_JSON}" \
READINESS_ROOT="${READY_OUTPUT_ROOT_ABS}" \
HANDOFF_OUTPUT_ROOT="${HANDOFF_OUTPUT_ROOT}" \
bash scripts/ops/multitable-pilot-handoff-release-bound.sh

generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
HANDOFF_RECOMMENDED_TEMPLATES_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(data.recommendedTemplates||{}))" "${HANDOFF_ROOT_ABS}/handoff.json")"
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
    exec env ONPREM_GATE_REPORT_JSON="\${ONPREM_GATE_REPORT_JSON}" ENSURE_PLAYWRIGHT=false pnpm prepare:multitable-pilot:release-bound
    ;;
  refresh-readiness)
    print_signoff_reminder
    cd "\${ROOT_DIR}"
    exec env ONPREM_GATE_REPORT_JSON="\${ONPREM_GATE_REPORT_JSON}" OUTPUT_ROOT="\${READY_OUTPUT_ROOT}" pnpm verify:multitable-pilot:ready:local:release-bound
    ;;
  refresh-handoff)
    print_signoff_reminder
    cd "\${ROOT_DIR}"
    exec env ONPREM_GATE_REPORT_JSON="\${ONPREM_GATE_REPORT_JSON}" READINESS_ROOT="\${READY_OUTPUT_ROOT}" pnpm prepare:multitable-pilot:handoff:release-bound
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
  "  \"onPremGateReportJson\": \"${ONPREM_GATE_REPORT_JSON}\"," \
  "  \"readinessRoot\": \"${READY_OUTPUT_ROOT_ABS}\"," \
  "  \"readinessJson\": \"${READY_OUTPUT_ROOT_ABS}/readiness.json\"," \
  "  \"readinessMd\": \"${READY_OUTPUT_ROOT_ABS}/readiness.md\"," \
  "  \"handoffRoot\": \"${HANDOFF_ROOT_ABS}\"," \
  "  \"handoffJson\": \"${HANDOFF_ROOT_ABS}/handoff.json\"," \
  "  \"handoffMd\": \"${HANDOFF_ROOT_ABS}/handoff.md\"," \
  "  \"operatorCommandScript\": \"${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}")\"," \
  "  \"recommendedTemplates\": ${HANDOFF_RECOMMENDED_TEMPLATES_JSON}," \
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
  "      \"command\": \"ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} ENSURE_PLAYWRIGHT=false pnpm prepare:multitable-pilot:release-bound\"" \
  '    },' \
  '    {' \
  '      "name": "refreshReadiness",' \
  "      \"command\": \"ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} OUTPUT_ROOT=${READY_OUTPUT_ROOT_ABS} pnpm verify:multitable-pilot:ready:local:release-bound\"" \
  '    },' \
  '    {' \
  '      "name": "refreshHandoff",' \
  "      \"command\": \"ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} READINESS_ROOT=${READY_OUTPUT_ROOT_ABS} pnpm prepare:multitable-pilot:handoff:release-bound\"" \
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
  '      "title": "Share the readiness bundle with the pilot owner and confirm current checks",' \
  "      \"artifact\": \"${READY_OUTPUT_ROOT_ABS}/readiness.md\"" \
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
  "- On-prem gate report: \`${ONPREM_GATE_REPORT_JSON}\`" \
  "- Readiness root: \`${READY_OUTPUT_ROOT_ABS}\`" \
  "- Handoff root: \`${HANDOFF_ROOT_ABS}\`" \
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
  '## Operator Checklist' \
  '' \
  "- Review the bound on-prem gate report: \`${ONPREM_GATE_REPORT_JSON}\`" \
  "- Share \`${READY_OUTPUT_ROOT_ABS}/readiness.md\` with the pilot owner and confirm the rollout still matches the bound gate." \
  "- Use \`${HANDOFF_ROOT_ABS}/handoff.md\` as the operating index for daily triage, checkpoint review, and sign-off follow-up." \
  "- Select the correct template from \`${HANDOFF_ROOT_ABS}/docs\` before running checkpoint, expansion, UAT, or customer delivery sign-off." \
  "- Collect \`${HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT}\` and \`${HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT}\` before pilot sign-off or expansion review." \
  '' \
 '## Operator Commands' \
  '' \
  "- Executable helper: \`${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}")\`" \
  "- Show sign-off evidence: \`${REPORT_ROOT_ABS}/$(basename "${COMMANDS_SH}") show-signoff-evidence\`" \
  "- Rerun bound packet: \`ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} ENSURE_PLAYWRIGHT=false pnpm prepare:multitable-pilot:release-bound\`" \
  "- Refresh readiness only: \`ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} OUTPUT_ROOT=${READY_OUTPUT_ROOT_ABS} pnpm verify:multitable-pilot:ready:local:release-bound\`" \
  "- Refresh handoff only: \`ONPREM_GATE_REPORT_JSON=${ONPREM_GATE_REPORT_JSON} READINESS_ROOT=${READY_OUTPUT_ROOT_ABS} pnpm prepare:multitable-pilot:handoff:release-bound\`" \
  '' \
  '## Expected Follow-up Evidence' \
  '' \
  "- Preflight report JSON: \`${HANDOFF_PREFLIGHT_REPORT_JSON_DEFAULT}\`" \
  "- Preflight report Markdown: \`${HANDOFF_PREFLIGHT_REPORT_MD_DEFAULT}\`" \
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
