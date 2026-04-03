#!/usr/bin/env bash
set -euo pipefail

LOG_ROOT="${LOG_ROOT:-${HOME}/Library/Logs/metasheet2/dingtalk-oauth}"
INDEX_FILE="${LOG_ROOT}/index.jsonl"
SUMMARY_DIR="${LOG_ROOT}/summaries"
STAMP_SAFE="$(date -u '+%Y%m%dT%H%M%SZ')"

mkdir -p "${SUMMARY_DIR}"

[[ -f "${INDEX_FILE}" ]] || {
  echo "[dingtalk-oauth-schedule-summary] ERROR: missing index file: ${INDEX_FILE}" >&2
  exit 1
}

python3 - "${INDEX_FILE}" "${SUMMARY_DIR}" "${STAMP_SAFE}" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

index_file = pathlib.Path(sys.argv[1])
summary_dir = pathlib.Path(sys.argv[2])
stamp_safe = sys.argv[3]

lines = [line.strip() for line in index_file.read_text(encoding='utf-8', errors='replace').splitlines() if line.strip()]
records = []
for line in lines:
    try:
        records.append(json.loads(line))
    except Exception:
        continue

latest_stability = next((record for record in reversed(records) if record.get('kind') == 'stability'), None)
latest_drill = next((record for record in reversed(records) if record.get('kind') == 'drill'), None)

generated_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
summary_base = summary_dir / f'summary-{stamp_safe}'
summary_json_path = summary_base.with_suffix('.json')
summary_md_path = summary_base.with_suffix('.md')

payload = {
    'generatedAt': generated_at,
    'summaryJsonFile': str(summary_json_path),
    'summaryMarkdownFile': str(summary_md_path),
    'latestStabilityCheckedAt': latest_stability.get('checkedAt') if latest_stability else None,
    'latestDrillCheckedAt': latest_drill.get('checkedAt') if latest_drill else None,
    'latestDrillId': latest_drill.get('drillId') if latest_drill else None,
    'healthy': latest_stability.get('healthy') if latest_stability else None,
    'firingObserved': latest_drill.get('firingObserved') if latest_drill else None,
    'resolvedObserved': latest_drill.get('resolvedObserved') if latest_drill else None,
    'latestStability': latest_stability,
    'latestDrill': latest_drill,
}

summary_json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

markdown = f"""# DingTalk OAuth Scheduled Summary

Generated at: `{generated_at}`

## Latest Stability

- Checked at: `{payload['latestStabilityCheckedAt'] or 'missing'}`
- Healthy: `{payload['healthy'] or 'unknown'}`
- Health line: `{(latest_stability or {}).get('healthLine', 'missing')}`
- Webhook line: `{(latest_stability or {}).get('webhookLine', 'missing')}`
- Alert line: `{(latest_stability or {}).get('alertLine', 'missing')}`
- Bridge line: `{(latest_stability or {}).get('bridgeLine', 'missing')}`
- Metrics line: `{(latest_stability or {}).get('metricsLine', 'missing')}`

## Latest Drill

- Checked at: `{payload['latestDrillCheckedAt'] or 'missing'}`
- Drill ID: `{payload['latestDrillId'] or 'missing'}`
- Firing observed: `{payload['firingObserved'] if payload['firingObserved'] is not None else 'unknown'}`
- Resolved observed: `{payload['resolvedObserved'] if payload['resolvedObserved'] is not None else 'unknown'}`
- Alert name: `{(latest_drill or {}).get('alertName', 'missing')}`

## Artifacts

- JSON: `{summary_json_path}`
- Markdown: `{summary_md_path}`
"""

summary_md_path.write_text(markdown, encoding='utf-8')
print(json.dumps(payload, ensure_ascii=False))
PY
