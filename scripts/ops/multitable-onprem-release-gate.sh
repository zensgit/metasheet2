#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_ROOT="${OUTPUT_ROOT:-${ROOT_DIR}/output/releases/multitable-onprem/gates/$(date +%Y%m%d-%H%M%S)}"
LOG_ROOT="${OUTPUT_ROOT}/logs"
REPORT_JSON="${OUTPUT_ROOT}/report.json"
REPORT_MD="${OUTPUT_ROOT}/report.md"
REPORT_JSON_TMP="${OUTPUT_ROOT}/report.json.tmp"
COMMANDS_SH="${OUTPUT_ROOT}/operator-commands.sh"
COMMANDS_SH_TMP="${OUTPUT_ROOT}/operator-commands.sh.tmp"
VERIFY_ROOT="${ROOT_DIR}/output/releases/multitable-onprem/verify"
DEFAULT_PREFLIGHT_REPORT_JSON="/opt/metasheet/output/preflight/multitable-onprem-preflight.json"
DEFAULT_PREFLIGHT_REPORT_MD="/opt/metasheet/output/preflight/multitable-onprem-preflight.md"

PACKAGE_PREFIX="${PACKAGE_PREFIX:-metasheet-multitable-onprem}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)}"
PACKAGE_TAG="${PACKAGE_TAG:-release-gate-$(date +%H%M%S)}"
PACKAGE_JSON_OVERRIDE="${PACKAGE_JSON:-}"
BUILD_PACKAGE="${BUILD_PACKAGE:-true}"
INSTALL_DEPS="${INSTALL_DEPS:-0}"
BUILD_WEB="${BUILD_WEB:-0}"
BUILD_BACKEND="${BUILD_BACKEND:-0}"
BUILD_STATUS="SKIPPED"

mkdir -p "$LOG_ROOT"
mkdir -p "$VERIFY_ROOT"

function info() {
  echo "[multitable-onprem-release-gate] $*" >&2
}

function latest_package_json() {
  node -e "const fs=require('fs');const path=require('path');const root=process.argv[1];const files=fs.readdirSync(root,{withFileTypes:true}).filter((entry)=>entry.isFile()&&entry.name.startsWith('metasheet-multitable-onprem-')&&entry.name.endsWith('.json')&&!entry.name.endsWith('.verify.json')&&!entry.name.endsWith('.build-report.json')).map((entry)=>entry.name).sort();if(!files.length){process.exit(2)}process.stdout.write(path.join(root, files.at(-1)))" \
    "${ROOT_DIR}/output/releases/multitable-onprem"
}

function package_field() {
  local file="$1"
  local field="$2"
  node -e "const fs=require('fs');const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const value=raw[process.argv[2]];if(value===undefined||value===null){process.exit(3)}process.stdout.write(String(value))" "$file" "$field"
}

function require_file() {
  local file="$1"
  [[ -f "$file" ]] || {
    echo "[multitable-onprem-release-gate] ERROR: required file missing: $file" >&2
    exit 1
  }
}

function built_package_json() {
  printf '%s\n' "${ROOT_DIR}/output/releases/multitable-onprem/${PACKAGE_PREFIX}-v${PACKAGE_VERSION}-${PACKAGE_TAG}.json"
}

if [[ "$BUILD_PACKAGE" == "true" ]]; then
  info "Building on-prem package"
  PACKAGE_TAG="$PACKAGE_TAG" \
  PACKAGE_PREFIX="$PACKAGE_PREFIX" \
  PACKAGE_VERSION="$PACKAGE_VERSION" \
  INSTALL_DEPS="$INSTALL_DEPS" \
  BUILD_WEB="$BUILD_WEB" \
  BUILD_BACKEND="$BUILD_BACKEND" \
  bash scripts/ops/multitable-onprem-package-build.sh >"${LOG_ROOT}/build.log" 2>&1
  BUILD_STATUS="PASS"
fi

if [[ -n "$PACKAGE_JSON_OVERRIDE" ]]; then
  PACKAGE_JSON_PATH="$(cd "$(dirname "$PACKAGE_JSON_OVERRIDE")" && pwd)/$(basename "$PACKAGE_JSON_OVERRIDE")"
elif [[ "$BUILD_PACKAGE" == "true" ]]; then
  PACKAGE_JSON_PATH="$(built_package_json)"
else
  PACKAGE_JSON_PATH="$(latest_package_json)"
fi

require_file "$PACKAGE_JSON_PATH"

PACKAGE_NAME="$(package_field "$PACKAGE_JSON_PATH" name)"
ARCHIVE_TGZ="${ROOT_DIR}/output/releases/multitable-onprem/${PACKAGE_NAME}.tgz"
ARCHIVE_ZIP="${ROOT_DIR}/output/releases/multitable-onprem/${PACKAGE_NAME}.zip"
VERIFY_TGZ_JSON="${VERIFY_ROOT}/${PACKAGE_NAME}.tgz.verify.json"
VERIFY_TGZ_MD="${VERIFY_ROOT}/${PACKAGE_NAME}.tgz.verify.md"
VERIFY_ZIP_JSON="${VERIFY_ROOT}/${PACKAGE_NAME}.zip.verify.json"
VERIFY_ZIP_MD="${VERIFY_ROOT}/${PACKAGE_NAME}.zip.verify.md"
DELIVERY_ROOT="${ROOT_DIR}/output/delivery/multitable-onprem/${PACKAGE_NAME}"
DELIVERY_JSON="${DELIVERY_ROOT}/DELIVERY.json"
DELIVERY_MD="${DELIVERY_ROOT}/DELIVERY.md"
DELIVERY_PREFLIGHT_ENV_TEMPLATE="${DELIVERY_ROOT}/ops/multitable-onprem-preflight.env.example.sh"
DELIVERY_PREFLIGHT_HELPER="${DELIVERY_ROOT}/ops/multitable-onprem-preflight.sh"
DELIVERY_REPAIR_HELPER="${DELIVERY_ROOT}/ops/multitable-onprem-repair-helper.sh"
SIGNOFF_STEP1_COMMAND="set -a && source ${DELIVERY_PREFLIGHT_ENV_TEMPLATE} && set +a && bash ${DELIVERY_PREFLIGHT_HELPER}"
DELIVERY_VERIFY_TGZ_JSON="${DELIVERY_ROOT}/verify/${PACKAGE_NAME}.tgz.verify.json"
DELIVERY_VERIFY_TGZ_MD="${DELIVERY_ROOT}/verify/${PACKAGE_NAME}.tgz.verify.md"
DELIVERY_VERIFY_ZIP_JSON="${DELIVERY_ROOT}/verify/${PACKAGE_NAME}.zip.verify.json"
DELIVERY_VERIFY_ZIP_MD="${DELIVERY_ROOT}/verify/${PACKAGE_NAME}.zip.verify.md"
DELIVERY_DOCS_ROOT="${DELIVERY_ROOT}/docs"
TEMPLATE_CUSTOMER_DELIVERY_SIGNOFF="${DELIVERY_DOCS_ROOT}/multitable-customer-delivery-signoff-template-20260323.md"
TEMPLATE_UAT_SIGNOFF="${DELIVERY_DOCS_ROOT}/multitable-uat-signoff-template-20260323.md"
TEMPLATE_PILOT_EXPANSION="${DELIVERY_DOCS_ROOT}/multitable-pilot-expansion-decision-template-20260323.md"
TEMPLATE_PILOT_GONOGO="${DELIVERY_DOCS_ROOT}/multitable-pilot-go-no-go-template-20260319.md"

require_file "$ARCHIVE_TGZ"
require_file "$ARCHIVE_ZIP"

info "Verifying tgz package"
VERIFY_REPORT_JSON="$VERIFY_TGZ_JSON" \
VERIFY_REPORT_MD="$VERIFY_TGZ_MD" \
bash scripts/ops/multitable-onprem-package-verify.sh "$ARCHIVE_TGZ" >"${LOG_ROOT}/verify-tgz.log" 2>&1

info "Verifying zip package"
VERIFY_REPORT_JSON="$VERIFY_ZIP_JSON" \
VERIFY_REPORT_MD="$VERIFY_ZIP_MD" \
bash scripts/ops/multitable-onprem-package-verify.sh "$ARCHIVE_ZIP" >"${LOG_ROOT}/verify-zip.log" 2>&1

cat > "$COMMANDS_SH_TMP" <<EOF
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR}"
PACKAGE_JSON="${PACKAGE_JSON_PATH}"
GATE_REPORT_JSON="${REPORT_JSON}"
PREFLIGHT_REPORT_JSON="${DEFAULT_PREFLIGHT_REPORT_JSON}"
PREFLIGHT_REPORT_MD="${DEFAULT_PREFLIGHT_REPORT_MD}"

print_signoff_evidence() {
  cat <<USAGE
Required sign-off evidence:
  - \${PREFLIGHT_REPORT_JSON}
  - \${PREFLIGHT_REPORT_MD}
Do not complete customer delivery, UAT, or final sign-off until both files are returned.
Run preflight first:
  ${SIGNOFF_STEP1_COMMAND}
If preflight fails:
  Run the first command shown under "One-Line Quick Fix Commands" in the generated preflight report.
Repair helper:
  ${DELIVERY_REPAIR_HELPER}
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
  rerun-gate
  refresh-delivery
  prepare-pilot-release-bound
  show-signoff-evidence
USAGE
    echo
    print_signoff_evidence
    ;;
  rerun-gate)
    print_signoff_reminder
    cd "\${ROOT_DIR}"
    exec env BUILD_PACKAGE=false PACKAGE_JSON="\${PACKAGE_JSON}" pnpm verify:multitable-onprem:release-gate
    ;;
  refresh-delivery)
    print_signoff_reminder
    cd "\${ROOT_DIR}"
    exec env PACKAGE_JSON="\${PACKAGE_JSON}" pnpm prepare:multitable-onprem:delivery
    ;;
  prepare-pilot-release-bound)
    print_signoff_reminder
    cd "\${ROOT_DIR}"
    exec env ONPREM_GATE_REPORT_JSON="\${GATE_REPORT_JSON}" ENSURE_PLAYWRIGHT=false pnpm prepare:multitable-pilot:release-bound
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
mv "$COMMANDS_SH_TMP" "$COMMANDS_SH"
chmod +x "$COMMANDS_SH"

info "Preparing delivery bundle"
PACKAGE_JSON="$PACKAGE_JSON_PATH" \
ONPREM_GATE_OPERATOR_COMMAND_SCRIPT="$COMMANDS_SH" \
node scripts/ops/multitable-onprem-delivery-bundle.mjs >"${LOG_ROOT}/delivery.log" 2>&1

require_file "$VERIFY_TGZ_JSON"
require_file "$VERIFY_TGZ_MD"
require_file "$VERIFY_ZIP_JSON"
require_file "$VERIFY_ZIP_MD"
require_file "$DELIVERY_JSON"
require_file "$DELIVERY_MD"
require_file "$DELIVERY_VERIFY_TGZ_JSON"
require_file "$DELIVERY_VERIFY_TGZ_MD"
require_file "$DELIVERY_VERIFY_ZIP_JSON"
require_file "$DELIVERY_VERIFY_ZIP_MD"

DELIVERY_VERIFY_OK="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const reports=data.verifyReports||{};const ok=Boolean(reports.tgzVerifyJson&&reports.tgzVerifyMd&&reports.zipVerifyJson&&reports.zipVerifyMd);process.stdout.write(ok?'true':'false')" "$DELIVERY_JSON")"
if [[ "$DELIVERY_VERIFY_OK" != "true" ]]; then
  echo "[multitable-onprem-release-gate] ERROR: DELIVERY.json missing verify report references" >&2
  exit 1
fi

DELIVERY_TEMPLATE_JSON="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const templates=data.recommendedTemplates||{};process.stdout.write(JSON.stringify(templates))" "$DELIVERY_JSON")"
DELIVERY_PREFLIGHT_REPORT_JSON_DEFAULT="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const value=data?.operatorArtifacts?.preflightReportJsonDefault||'';process.stdout.write(String(value))" "$DELIVERY_JSON")"
DELIVERY_PREFLIGHT_REPORT_MD_DEFAULT="$(node -e "const fs=require('fs');const file=process.argv[1];const data=JSON.parse(fs.readFileSync(file,'utf8'));const value=data?.operatorArtifacts?.preflightReportMdDefault||'';process.stdout.write(String(value))" "$DELIVERY_JSON")"
if [[ -z "$DELIVERY_PREFLIGHT_REPORT_JSON_DEFAULT" ]]; then
  DELIVERY_PREFLIGHT_REPORT_JSON_DEFAULT="$DEFAULT_PREFLIGHT_REPORT_JSON"
fi
if [[ -z "$DELIVERY_PREFLIGHT_REPORT_MD_DEFAULT" ]]; then
  DELIVERY_PREFLIGHT_REPORT_MD_DEFAULT="$DEFAULT_PREFLIGHT_REPORT_MD"
fi

printf '%s\n' \
  '{' \
  '  "ok": true,' \
  "  \"packageName\": \"${PACKAGE_NAME}\"," \
  "  \"packageJson\": \"${PACKAGE_JSON_PATH}\"," \
  "  \"deliveryRoot\": \"${DELIVERY_ROOT}\"," \
  "  \"operatorCommandScript\": \"${COMMANDS_SH}\"," \
  "  \"recommendedTemplates\": ${DELIVERY_TEMPLATE_JSON}," \
  '  "expectedOperatorEvidence": {' \
  "    \"preflightReportJson\": \"${DELIVERY_PREFLIGHT_REPORT_JSON_DEFAULT}\"," \
  "    \"preflightReportMd\": \"${DELIVERY_PREFLIGHT_REPORT_MD_DEFAULT}\"" \
  '  },' \
  '  "signoffRecoveryPath": {' \
  "    \"step1RunPreflight\": \"${SIGNOFF_STEP1_COMMAND}\"," \
  '    "step2RepairInstruction": "If preflight fails, run the first command shown under \"One-Line Quick Fix Commands\" in the generated preflight report.",' \
  "    \"step2RepairHelper\": \"${DELIVERY_REPAIR_HELPER}\"," \
  '    "step3ReturnEvidence": [' \
  "      \"${DELIVERY_PREFLIGHT_REPORT_JSON_DEFAULT}\"," \
  "      \"${DELIVERY_PREFLIGHT_REPORT_MD_DEFAULT}\"" \
  '    ]' \
  '  },' \
  '  "operatorCommands": [' \
  '    {' \
  '      "name": "showSignoffEvidence",' \
  "      \"command\": \"${COMMANDS_SH} show-signoff-evidence\"" \
  '    },' \
  '    {' \
  '      "name": "rerunGate",' \
  "      \"command\": \"BUILD_PACKAGE=false PACKAGE_JSON=${PACKAGE_JSON_PATH} pnpm verify:multitable-onprem:release-gate\"" \
  '    },' \
  '    {' \
  '      "name": "refreshDeliveryBundle",' \
  "      \"command\": \"PACKAGE_JSON=${PACKAGE_JSON_PATH} pnpm prepare:multitable-onprem:delivery\"" \
  '    },' \
  '    {' \
  '      "name": "preparePilotReleaseBound",' \
  "      \"command\": \"ONPREM_GATE_REPORT_JSON=${REPORT_JSON} ENSURE_PLAYWRIGHT=false pnpm prepare:multitable-pilot:release-bound\"" \
  '    }' \
  '  ],' \
  '  "operatorChecklist": [' \
  '    {' \
  '      "step": 1,' \
  '      "title": "Review gate status and package identity",' \
  "      \"artifact\": \"${REPORT_MD}\"" \
  '    },' \
  '    {' \
  '      "step": 2,' \
  '      "title": "Confirm tgz and zip verify reports are present and PASS",' \
  "      \"artifact\": \"${VERIFY_TGZ_JSON}\"" \
  '    },' \
  '    {' \
  '      "step": 3,' \
  '      "title": "Open the delivery bundle and choose the correct acceptance template",' \
  "      \"artifact\": \"${DELIVERY_MD}\"" \
  '    },' \
  '    {' \
  '      "step": 4,' \
  '      "title": "Use the customer sign-off or UAT template for the current rollout stage",' \
  "      \"artifact\": \"${TEMPLATE_CUSTOMER_DELIVERY_SIGNOFF}\"" \
  '    },' \
  '    {' \
  '      "step": 5,' \
  '      "title": "Ask the field operator to return the multitable preflight json and markdown reports before final sign-off",' \
  "      \"artifact\": \"${DELIVERY_PREFLIGHT_REPORT_MD_DEFAULT}\"" \
  '    }' \
  '  ],' \
  '  "checks": [' \
  '    {' \
  '      "name": "build.onprem-package",' \
  '      "ok": true,' \
  "      \"status\": \"${BUILD_STATUS}\"," \
  "      \"log\": \"${LOG_ROOT}/build.log\"" \
  '    },' \
  '    {' \
  '      "name": "verify.onprem-package.tgz",' \
  '      "ok": true,' \
  "      \"log\": \"${LOG_ROOT}/verify-tgz.log\"," \
  "      \"reportJson\": \"${VERIFY_TGZ_JSON}\"," \
  "      \"reportMd\": \"${VERIFY_TGZ_MD}\"" \
  '    },' \
  '    {' \
  '      "name": "verify.onprem-package.zip",' \
  '      "ok": true,' \
  "      \"log\": \"${LOG_ROOT}/verify-zip.log\"," \
  "      \"reportJson\": \"${VERIFY_ZIP_JSON}\"," \
  "      \"reportMd\": \"${VERIFY_ZIP_MD}\"" \
  '    },' \
  '    {' \
  '      "name": "delivery.onprem-bundle",' \
  '      "ok": true,' \
  "      \"log\": \"${LOG_ROOT}/delivery.log\"," \
  "      \"deliveryRoot\": \"${DELIVERY_ROOT}\"," \
  "      \"deliveryJson\": \"${DELIVERY_JSON}\"," \
  "      \"deliveryMd\": \"${DELIVERY_MD}\"" \
  '    },' \
  '    {' \
  '      "name": "delivery.onprem-verify-reports",' \
  '      "ok": true,' \
  "      \"deliveryVerifyTgzJson\": \"${DELIVERY_VERIFY_TGZ_JSON}\"," \
  "      \"deliveryVerifyZipJson\": \"${DELIVERY_VERIFY_ZIP_JSON}\"" \
  '    }' \
  '  ],' \
  "  \"generatedAt\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"" \
  '}' \
  > "$REPORT_JSON_TMP"
mv "$REPORT_JSON_TMP" "$REPORT_JSON"

cat > "$REPORT_MD" <<EOF
# Multitable On-Prem Release Gate

- Overall: **PASS**
- Package name: \`${PACKAGE_NAME}\`
- Package metadata: \`${PACKAGE_JSON_PATH}\`
- Gate root: \`${OUTPUT_ROOT}\`

## Checks

- \`build.onprem-package\`: $( [[ "$BUILD_PACKAGE" == "true" ]] && echo '`PASS`' || echo '`SKIPPED`' )
- \`verify.onprem-package.tgz\`: \`PASS\`
- \`verify.onprem-package.zip\`: \`PASS\`
- \`delivery.onprem-bundle\`: \`PASS\`
- \`delivery.onprem-verify-reports\`: \`PASS\`

## Key Artifacts

- \`${ARCHIVE_TGZ}\`
- \`${ARCHIVE_ZIP}\`
- \`${VERIFY_TGZ_JSON}\`
- \`${VERIFY_ZIP_JSON}\`
- \`${DELIVERY_JSON}\`
- \`${DELIVERY_MD}\`
- \`${REPORT_JSON}\`

## Recommended Templates

- Customer delivery receipt: \`${TEMPLATE_CUSTOMER_DELIVERY_SIGNOFF}\`
- Controlled rollout / UAT acceptance: \`${TEMPLATE_UAT_SIGNOFF}\`
- Internal pilot expansion decision: \`${TEMPLATE_PILOT_EXPANSION}\`
- Internal pilot checkpoint review: \`${TEMPLATE_PILOT_GONOGO}\`

## Operator Checklist

1. Review this gate summary and confirm the package identity matches the planned release.
2. Open \`${VERIFY_TGZ_JSON}\` and \`${VERIFY_ZIP_JSON}\` to confirm both archive formats passed verify.
3. Open \`${DELIVERY_MD}\` and choose the acceptance template that matches the rollout stage.
4. Use \`${TEMPLATE_CUSTOMER_DELIVERY_SIGNOFF}\` for customer delivery receipt or \`${TEMPLATE_UAT_SIGNOFF}\` for controlled rollout / UAT acceptance.
5. Ask the field operator to return \`${DELIVERY_PREFLIGHT_REPORT_JSON_DEFAULT}\` and \`${DELIVERY_PREFLIGHT_REPORT_MD_DEFAULT}\` before final sign-off.

## Sign-Off Recovery Path

- Step 1 command: \`${SIGNOFF_STEP1_COMMAND}\`
- If preflight fails, run the first line shown under \`One-Line Quick Fix Commands\` in the generated preflight report.
- Repair helper path: \`${DELIVERY_REPAIR_HELPER}\`
- Return both files: \`${DELIVERY_PREFLIGHT_REPORT_JSON_DEFAULT}\`, \`${DELIVERY_PREFLIGHT_REPORT_MD_DEFAULT}\`

## Operator Commands

- Executable helper: \`${COMMANDS_SH}\`
- Show sign-off evidence: \`${COMMANDS_SH} show-signoff-evidence\`
- Rerun gate: \`BUILD_PACKAGE=false PACKAGE_JSON=${PACKAGE_JSON_PATH} pnpm verify:multitable-onprem:release-gate\`
- Refresh delivery bundle: \`PACKAGE_JSON=${PACKAGE_JSON_PATH} pnpm prepare:multitable-onprem:delivery\`
- Produce bound pilot packet: \`ONPREM_GATE_REPORT_JSON=${REPORT_JSON} ENSURE_PLAYWRIGHT=false pnpm prepare:multitable-pilot:release-bound\`

## Expected Follow-up Evidence

- Preflight report JSON: \`${DELIVERY_PREFLIGHT_REPORT_JSON_DEFAULT}\`
- Preflight report Markdown: \`${DELIVERY_PREFLIGHT_REPORT_MD_DEFAULT}\`
EOF

info "PASS: on-prem release gate complete"
info "  gate_root: ${OUTPUT_ROOT}"
info "  report_json: ${REPORT_JSON}"
info "  report_md: ${REPORT_MD}"
