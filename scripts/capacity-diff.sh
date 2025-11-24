#!/usr/bin/env bash
set -euo pipefail

# capacity-diff.sh base.json compare.json
# Produces JSON + human MD diff with growth percentages and alert levels.

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <base.json> <compare.json> [output-dir]" >&2
  exit 1
fi

BASE=$1
NEW=$2
OUT_DIR=${3:-docs/sprint2/capacity}
TS=$(date +%Y%m%d-%H%M%S)
OUT_JSON="$OUT_DIR/capacity-diff-$TS.json"
OUT_MD="$OUT_DIR/capacity-diff-$TS.md"
mkdir -p "$OUT_DIR"

jq_exist() { command -v jq >/dev/null 2>&1; }
if ! jq_exist; then
  echo "jq required" >&2; exit 2; fi

DB_BASE=$(jq -r '.database_size_bytes' "$BASE")
DB_NEW=$(jq -r '.database_size_bytes' "$NEW")

pct() { # pct old new
  if [ "$1" -eq 0 ]; then echo 0; else awk -v o=$1 -v n=$2 'BEGIN{printf "%.2f", ((n-o)/o)*100}'; fi
}

DB_GROW=$(pct "$DB_BASE" "$DB_NEW")

tables_json=$(jq -n --slurpfile b "$BASE" --slurpfile n "$NEW" '
  ($b[0].tables // []) as $bt |
  ($n[0].tables // []) as $nt |
  [ ($bt + $nt | map(.name) | unique[]) as $names | $names[] ] as $names_flat |
  [ ($bt + $nt | map(.name) | unique[])[] as $nm | 
    { name: $nm,
      base_size_bytes: (( $bt[]? | select(.name==$nm) | .size_bytes ) // 0),
      new_size_bytes: (( $nt[]? | select(.name==$nm) | .size_bytes ) // 0),
      growth_pct: (if (( $bt[]? | select(.name==$nm) | .size_bytes ) // 0) == 0 then 0 else (((( $nt[]? | select(.name==$nm) | .size_bytes ) // 0)-(( $bt[]? | select(.name==$nm) | .size_bytes ) // 0))/(( $bt[]? | select(.name==$nm) | .size_bytes ) // 0))*100 end)
    } ]')

alert_level="GREEN"
if awk -v g=$DB_GROW 'BEGIN{exit !(g>15)}'; then alert_level="YELLOW"; fi
if awk -v g=$DB_GROW 'BEGIN{exit !(g>30)}'; then alert_level="RED"; fi

cat > "$OUT_JSON" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "base_snapshot": "$(basename "$BASE")",
  "new_snapshot": "$(basename "$NEW")",
  "database_growth_pct": $DB_GROW,
  "alert_level": "$alert_level",
  "tables": $tables_json
}
EOF

cat > "$OUT_MD" <<EOF
# Capacity Diff $TS

Base: $(basename "$BASE")
New : $(basename "$NEW")

Database Growth: ${DB_GROW}% (Alert: $alert_level)

Per-Table Growth:
$(jq -r '.tables[] | "- " + .name + ": " + (.base_size_bytes|tostring) + " -> " + (.new_size_bytes|tostring) + " (" + (.growth_pct|tostring) + "%)"' "$OUT_JSON")

Source JSON: $OUT_JSON
EOF

echo "[capacity-diff] written $OUT_JSON and $OUT_MD" >&2
