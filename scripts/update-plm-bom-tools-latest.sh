#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
LATEST_JSON="${PLM_BOM_TOOLS_LATEST:-$OUTPUT_DIR/plm-bom-tools-latest.json}"
LATEST_MD="${PLM_BOM_TOOLS_LATEST_MD:-$OUTPUT_DIR/plm-bom-tools-latest.md}"

SOURCE_JSON=$(ls -t "$OUTPUT_DIR"/plm-bom-tools-*.json 2>/dev/null | head -n1 || true)

if [[ -z "$SOURCE_JSON" ]]; then
  echo "No BOM tools JSON found in $OUTPUT_DIR" >&2
  exit 1
fi

SOURCE_MD="${SOURCE_JSON%.json}.md"

cp "$SOURCE_JSON" "$LATEST_JSON"
if [[ -f "$SOURCE_MD" ]]; then
  cp "$SOURCE_MD" "$LATEST_MD"
fi

echo "Updated:"
echo "- JSON: $LATEST_JSON"
if [[ -f "$LATEST_MD" ]]; then
  echo "- MD:   $LATEST_MD"
fi
