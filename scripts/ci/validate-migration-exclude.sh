#!/usr/bin/env bash
set -euo pipefail

echo "🔎 Validating MIGRATION_EXCLUDE baseline (warn-only)"

EXPECTED=(
  "008_plugin_infrastructure.sql"
  "048_create_event_bus_tables.sql"
  "049_create_bpmn_workflow_tables.sql"
)

MEXC=${MIGRATION_EXCLUDE:-}
echo "Current MIGRATION_EXCLUDE: '${MEXC}'"

WARN=0
for item in "${EXPECTED[@]}"; do
  if [[ ",${MEXC}," != *",${item},"* ]]; then
    echo "⚠️  Expected to include: ${item}"
    WARN=1
  fi
done

if [[ $WARN -eq 0 ]]; then
  echo "✅ MIGRATION_EXCLUDE baseline looks good."
else
  echo "ℹ️  This is a warning only. Proceeding without failure."
fi
exit 0

