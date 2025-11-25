#!/usr/bin/env bash
# Capture environment & plugin snapshot for Phase 5 baseline
set -euo pipefail
DIR="${1:-results/phase5-20251122-150047}"; mkdir -p "$DIR"
ENV_FILE="$DIR/environment.md"
PLUG_FILE="$DIR/plugin-audit.md"

echo "# Environment Snapshot" > "$ENV_FILE"
echo "Captured: $(date -Iseconds)" >> "$ENV_FILE"
echo "\n## Versions" >> "$ENV_FILE"
{ node -v; pnpm -v; } 2>&1 | awk '{print "- " $0}' >> "$ENV_FILE"
command -v psql >/dev/null 2>&1 && psql --version 2>&1 | awk '{print "- " $0}' >> "$ENV_FILE" || echo "- psql: not available" >> "$ENV_FILE"

echo "\n## Key Env Vars" >> "$ENV_FILE"
for v in PORT DATABASE_URL JWT_SECRET NODE_ENV FEATURE_CACHE FEATURE_TABLE_RBAC_ENABLED WORKFLOW_ENABLED; do
  echo "- $v=${!v-}" >> "$ENV_FILE"
done

echo "\n## Migration Files" >> "$ENV_FILE"
ls -1 packages/core-backend/migrations | head -n 100 | awk '{print "- " $0}' >> "$ENV_FILE"

# Plugin audit
echo "# Plugin Audit" > "$PLUG_FILE"
echo "Captured: $(date -Iseconds)" >> "$PLUG_FILE"
resp=$(curl -s http://localhost:8900/api/plugins || echo '{}')
echo "\n\n## Raw Response" >> "$PLUG_FILE"
echo '\n```json' >> "$PLUG_FILE"
echo "$resp" >> "$PLUG_FILE"
echo '```' >> "$PLUG_FILE"
echo "\n## Summary" >> "$PLUG_FILE"
echo "$resp" | grep -q 'loaded' || echo "- Error reading plugin summary" >> "$PLUG_FILE"
echo "Environment + plugin snapshot written to $DIR" >&2
