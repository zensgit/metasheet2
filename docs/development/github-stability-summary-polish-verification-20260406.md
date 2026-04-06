# GitHub Stability Summary Polish Verification

Date: 2026-04-06

## Scope

Verify the GitHub-side summary polish without depending on a live workflow run.

## Commands

### 1. Python syntax

```bash
PYTHONPYCACHEPREFIX="$(mktemp -d)" \
python3 -m py_compile scripts/ops/github-dingtalk-oauth-stability-summary.py
```

Expected: pass

### 2. Summary generator with healthy sample

```bash
tmpdir="$(mktemp -d)"
cat > "${tmpdir}/stability.json" <<'EOF'
{
  "checkedAt": "2026-04-06T00:00:00Z",
  "host": "mainuser@142.171.239.56",
  "healthy": true,
  "health": { "status": "ok", "plugins": 11, "ok": true },
  "webhookConfig": { "configured": true, "host": "hooks.slack.com" },
  "alertmanager": { "activeAlertsCount": 0, "notifyErrorsLastWindow": 0 },
  "storage": { "root": { "usePercent": 89, "availableKBlocks": 9000000, "maxUsePercent": 95 } },
  "bridge": { "notifyEventsLastWindow": 4, "resolvedEventsLastWindow": 2 },
  "metrics": { "operationsSamples": [], "fallbackSamples": [], "redisSamples": [] }
}
EOF
: > "${tmpdir}/stability.log"
STABILITY_RC=0 HEALTHY=true GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=zensgit/metasheet2 GITHUB_RUN_ID=12345 \
python3 scripts/ops/github-dingtalk-oauth-stability-summary.py \
  "${tmpdir}/stability.json" \
  "${tmpdir}/stability.log" \
  "${tmpdir}/summary.md"
```

Expected:

- command exits `0`
- `${tmpdir}/summary.md` exists
- `${tmpdir}/summary.json` exists
- markdown reports `Overall: PASS`
- JSON contains:
  - `"status": "PASS"`
  - `"healthy": true`
  - empty `failureReasons`

### 3. Summary generator with failing sample

```bash
tmpdir="$(mktemp -d)"
cat > "${tmpdir}/stability.json" <<'EOF'
{
  "checkedAt": "2026-04-06T00:00:00Z",
  "host": "mainuser@142.171.239.56",
  "healthy": false,
  "health": { "status": "degraded", "plugins": 11, "ok": false },
  "webhookConfig": { "configured": false, "host": "" },
  "alertmanager": { "activeAlertsCount": 0, "notifyErrorsLastWindow": 2 },
  "storage": { "root": { "usePercent": 97, "availableKBlocks": 0, "maxUsePercent": 95 } },
  "bridge": { "notifyEventsLastWindow": 0, "resolvedEventsLastWindow": 0 },
  "metrics": { "operationsSamples": [], "fallbackSamples": [], "redisSamples": [] }
}
EOF
: > "${tmpdir}/stability.log"
STABILITY_RC=1 HEALTHY=false \
python3 scripts/ops/github-dingtalk-oauth-stability-summary.py \
  "${tmpdir}/stability.json" \
  "${tmpdir}/stability.log" \
  "${tmpdir}/summary.md"
```

Expected:

- command exits `0`
- markdown reports `Overall: FAIL`
- markdown includes `Failure reason:` lines
- JSON includes non-empty:
  - `failureReasons`
  - `nextActions`

### 4. Workflow static check

```bash
python3 - <<'EOF'
from pathlib import Path
text = Path(".github/workflows/dingtalk-oauth-stability-recording-lite.yml").read_text()
assert "Build step summary and summary artifacts" in text
assert "github-dingtalk-oauth-stability-summary.py" in text
EOF
```

Expected: pass

## Result

Verified locally:

- Python summary generator compiles
- healthy sample writes both markdown and JSON summary artifacts
- failing sample writes actionable failure reasons and next actions
- workflow still invokes the same summary generator and uploads the same artifact directory
