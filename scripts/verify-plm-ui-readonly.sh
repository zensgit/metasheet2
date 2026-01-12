#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
AUTO_START="${AUTO_START:-true}"
PLM_BOM_TOOLS_JSON="${PLM_BOM_TOOLS_JSON:-}"
PLM_BOM_TOOLS_LATEST="${PLM_BOM_TOOLS_LATEST:-$OUTPUT_DIR/plm-bom-tools-latest.json}"

if [[ -z "$PLM_BOM_TOOLS_JSON" && -f "$PLM_BOM_TOOLS_LATEST" ]]; then
  PLM_BOM_TOOLS_JSON="$PLM_BOM_TOOLS_LATEST"
fi

if [[ -z "$PLM_BOM_TOOLS_JSON" ]]; then
  PLM_BOM_TOOLS_JSON=$(ls -t "$OUTPUT_DIR"/plm-bom-tools-*.json 2>/dev/null | head -n1 || true)
fi

if [[ -z "$PLM_BOM_TOOLS_JSON" ]]; then
  echo "Missing PLM_BOM_TOOLS_JSON and no $OUTPUT_DIR/plm-bom-tools-*.json found." >&2
  echo "Run: pnpm verify:plm-ui-full (with PLM_CLEANUP=false) or set PLM_BOM_TOOLS_JSON." >&2
  exit 1
fi

VERIFY_READONLY=true AUTO_START="$AUTO_START" PLM_BOM_TOOLS_JSON="$PLM_BOM_TOOLS_JSON" \
  bash scripts/verify-plm-ui-full.sh
