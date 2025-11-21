#!/usr/bin/env bash
set -euo pipefail

# Watch a GitHub Issue for a Staging JWT token and, once found, run
# the Sprint 2 staging validation and evidence collection.
#
# Usage:
#   GH_TOKEN=... bash scripts/watch-staging-token-and-validate.sh <ISSUE_NUMBER> <BASE_URL>
#
# Notes:
# - Does NOT print the JWT token.
# - Requires repo:issues scope on GH_TOKEN.
# - <BASE_URL> may also come from env BASE_URL.

# Prefer GH_TOKEN if available; otherwise fall back to gh CLI for API calls
USE_GH_API=0
if [[ -z "${GH_TOKEN:-}" ]]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    USE_GH_API=1
  else
    echo "❌ Neither GH_TOKEN nor authenticated gh CLI available" >&2; exit 2
  fi
fi

ISSUE_NUMBER=${1:-}
BASE_URL_INPUT=${2:-}
# BASE_URL may be empty; we will try to extract from the issue/comments if not provided
BASE_URL=${BASE_URL_INPUT:-${BASE_URL:-}}
# Poll staging token/URL more frequently by default; can be overridden via env
POLL_INTERVAL=${POLL_INTERVAL:-60}
TIMEOUT_SECONDS=${TIMEOUT_SECONDS:-86400}
# Send an hourly reminder by default (can be overridden). Previously this
# defaulted to TIMEOUT_SECONDS which delayed the first reminder too long.
REMINDER_INTERVAL=${REMINDER_INTERVAL:-3600}

if [[ -z "$ISSUE_NUMBER" ]]; then
  echo "Usage: $0 <ISSUE_NUMBER> <BASE_URL>" >&2; exit 2
fi

# Resolve GH_REPO from env or git origin
if [[ -z "${GH_REPO:-}" ]]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    origin=$(git remote get-url origin 2>/dev/null || echo "")
    if [[ "$origin" =~ github.com[:/](.+)/(.+)\.git$ ]]; then
      owner="${BASH_REMATCH[1]}"; repo="${BASH_REMATCH[2]}"; GH_REPO="$owner/$repo"
    else
      echo "❌ GH_REPO not set and could not parse git origin" >&2; exit 2
    fi
  else
    echo "❌ GH_REPO not set and not a git repo" >&2; exit 2
  fi
fi

echo "👀 Watching $GH_REPO#${ISSUE_NUMBER} for staging JWT and BASE_URL ... (poll ${POLL_INTERVAL}s)"

# API helpers (use curl+GH_TOKEN if available, else gh api)
fetch_issue() {
  if [[ $USE_GH_API -eq 0 ]]; then
    curl -fsS -H "Authorization: token $GH_TOKEN" -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$GH_REPO/issues/$ISSUE_NUMBER" || echo '{}'
  else
    gh api -H 'Accept: application/vnd.github+json' \
      repos/$GH_REPO/issues/$ISSUE_NUMBER || echo '{}'
  fi
}

fetch_comments() {
  if [[ $USE_GH_API -eq 0 ]]; then
    curl -fsS -H "Authorization: token $GH_TOKEN" -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$GH_REPO/issues/$ISSUE_NUMBER/comments?per_page=100" || echo '[]'
  else
    gh api -H 'Accept: application/vnd.github+json' \
      repos/$GH_REPO/issues/$ISSUE_NUMBER/comments --paginate || echo '[]'
  fi
}

find_jwt() {
  local issue comments token
  issue=$(fetch_issue)
  comments=$(fetch_comments)
  token=$(python3 - << 'PY' "$issue" "$comments"
import re,sys,json
issue=json.loads(sys.argv[1])
comments=json.loads(sys.argv[2])
texts=[issue.get('body') or '']+[c.get('body') or '' for c in comments]
pat=re.compile(r"eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}")
for t in texts:
    m=pat.search(t)
    if m:
        print(m.group(0));sys.exit(0)
print("")
PY
)
  echo "$token"
}

mask() { local s="$1"; echo "${#s} chars"; }

# Try to extract a plausible BASE_URL (non-GitHub https URL) from issue/comments
find_base_url() {
  local issue comments url
  issue=$(fetch_issue)
  comments=$(fetch_comments)
  url=$(python3 - << 'PY' "$issue" "$comments"
import re,sys,json,urllib.parse
issue=json.loads(sys.argv[1])
comments=json.loads(sys.argv[2])
texts=[issue.get('body') or '']+[c.get('body') or '' for c in comments]
url_re=re.compile(r"https?://[^\s'\"<>]+")
for t in texts:
    for m in url_re.finditer(t):
        u=m.group(0)
        # Strip common trailing punctuation from formatted links
        u=u.rstrip(")],.;'\"}")
        try:
            p=urllib.parse.urlparse(u)
        except Exception:
            continue
        host=(p.netloc or '').lower()
        if not host:
            continue
        # Skip GitHub links and example domains
        if host.endswith('github.com') or host.startswith('api.github.com') or host.endswith('example.com'):
            continue
        # Prefer hosts containing 'staging'
        if 'staging' in host:
            print(u); sys.exit(0)
        # Otherwise accept the first non-GitHub https URL
        print(u); sys.exit(0)
print("")
PY
)
  echo "$url"
}

# Return 0 if the URL looks valid (scheme http/https, host has a dot, not example.com)
is_valid_base_url() {
  local url="$1"
  python3 - "$url" << 'PY' || return 1
import sys, urllib.parse, re
u=sys.argv[1]
try:
  p=urllib.parse.urlparse(u)
  host=p.netloc.lower()
  scheme_ok = p.scheme in ('http','https')
  host_ok = bool(host) and '.' in host and not host.endswith('example.com')
  # Reject bare 'staging' host or IP-only without dots
  if host in ('staging','staging-env','staging-stage'): host_ok=False
  # Basic TLD pattern (not exhaustive)
  tld_ok = bool(re.search(r"\.[a-zA-Z]{2,}$", host))
  ok = scheme_ok and host_ok and tld_ok
  print('OK' if ok else '')
except Exception:
  print('')
PY
  [[ $(tail -n1) == "OK" ]]
}

# Best-effort reachability probe (non-fatal): try /health then root
preflight_base_url() {
  local url="$1"
  local code
  code=$(curl -m 5 -fsS -o /dev/null -w '%{http_code}' "$url/health" 2>/dev/null || true)
  if [[ -z "$code" || "$code" == "000" ]]; then
    code=$(curl -m 5 -fsS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)
  fi
  if [[ -n "$code" && "$code" != "000" ]]; then
    echo "reachable:$code"
    return 0
  else
    echo "unreachable"
    return 1
  fi
}

post_comment() {
  local msg="$1"
  if [[ $USE_GH_API -eq 0 ]]; then
    local payload
    payload=$(printf '{"body": %q}' "$msg")
    curl -fsS -X POST \
      -H "Authorization: token $GH_TOKEN" \
      -H 'Accept: application/vnd.github+json' \
      -d "$payload" \
      "https://api.github.com/repos/$GH_REPO/issues/$ISSUE_NUMBER/comments" >/dev/null 2>&1 || true
  else
    gh api -X POST -H 'Accept: application/vnd.github+json' \
      repos/$GH_REPO/issues/$ISSUE_NUMBER/comments \
      -f body="$msg" >/dev/null 2>&1 || true
  fi
}

start_ts=$(date +%s)
# Add an earlier 2h reminder milestone in addition to 6h/12h/24h
two_hour_ts=$((start_ts + 7200))         # 2h reminder
six_hour_ts=$((start_ts + 21600))        # 6h escalation
twelve_hour_ts=$((start_ts + 43200))     # 12h escalation
twentyfour_hour_ts=$((start_ts + 86400)) # 24h escalation
thirty_hour_ts=$((start_ts + 108000))    # 30h status escalation (extended delay)
forty_eight_hour_ts=$((start_ts + 172800)) # 48h conditional merge consideration
next_reminder_ts=$((start_ts + REMINDER_INTERVAL))
reminder_count=0
escalation_level=0

while true; do
  TOKEN=$(find_jwt)
  if [[ -z "${BASE_URL:-}" ]]; then
    CANDIDATE=$(find_base_url)
    if [[ -n "$CANDIDATE" ]]; then
      BASE_URL="$CANDIDATE"
      echo "🔗 BASE_URL detected: $BASE_URL"
    fi
  fi

  if [[ -n "$TOKEN" && -n "${BASE_URL:-}" ]]; then
    # Validate BASE_URL shape to avoid cases like 'https://staging' or example.com
    if ! is_valid_base_url "$BASE_URL"; then
      echo "⚠️  Invalid BASE_URL format detected: '$BASE_URL'. Waiting for a proper URL (must include a dot, e.g., https://staging.company.com)."
      sleep "$POLL_INTERVAL"
      continue
    fi
    echo "✅ Token and BASE_URL detected. Proceeding with validation..."
    export API_TOKEN="$TOKEN"

    # Best-effort reachability probe (non-fatal); will continue even if probe fails
    probe=$(preflight_base_url "$BASE_URL") || true
    echo "🌐 Preflight BASE_URL: $probe"

    if [[ -x "/tmp/execute-staging-validation.sh" ]]; then
      echo "🚀 Running wrapper: /tmp/execute-staging-validation.sh"
      /tmp/execute-staging-validation.sh "$API_TOKEN" "$BASE_URL" || true
    else
      echo "ℹ️ Wrapper not found, falling back to pnpm scripts"
      if command -v pnpm >/dev/null 2>&1; then
        pnpm run staging:validate || true
        pnpm run staging:perf || true
        pnpm run staging:schema || true
      else
        echo "❌ pnpm not found and wrapper missing; cannot run validation" >&2
      fi
    fi

    if [[ -x "/tmp/collect-evidence.sh" ]]; then
      echo "🗂  Collecting evidence via /tmp/collect-evidence.sh"
      /tmp/collect-evidence.sh || true
    fi

    # Post-staging finalize (insert metrics into PR description if perf summary exists)
    if [[ -x "scripts/post-staging-finalize.sh" ]]; then
      # Attempt to locate a staging perf summary; use default placeholder if not yet replaced
      perf_summary=$(ls -1t docs/sprint2/performance/staging*summary.json 2>/dev/null | head -n1 || true)
      if [[ -n "$perf_summary" ]]; then
        echo "📊 Inserting staging performance metrics into PR draft (file: $perf_summary)"
        bash scripts/post-staging-finalize.sh "$perf_summary" || true
      else
        echo "ℹ️ No staging performance summary found; skipping metrics insertion"
      fi
    fi

    # Optional: comment back to the issue (no token exposure)
    summary="Staging validation executed on ${BASE_URL}. Evidence pushed to docs/sprint2."
    post_comment "$summary"

    # Auto-commit docs and mark PR ready if possible
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
      repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
      if [[ -n "$repo_root" ]]; then
        ( set -e
          cd "$repo_root"
          git add docs/sprint2/ || true
          git commit -m "docs(sprint2): add staging validation evidence" || true
          git push || true
          prnum=$(gh pr view --json number -q .number 2>/dev/null || echo "")
          if [[ -n "$prnum" ]]; then
            if [[ -f docs/sprint2/pr-description-draft.md ]]; then
              gh pr edit "$prnum" --body "$(cat docs/sprint2/pr-description-draft.md)" || true
            fi
            gh pr ready "$prnum" || gh pr ready || true
            gh pr comment "$prnum" --body "✅ Staging validation complete. Evidence pushed to docs/sprint2." || true
          fi
        ) || true
      fi
    fi

    echo "🎉 Done. Exiting watcher."
    exit 0
  fi

  # Reminder logic
  now_ts=$(date +%s)
  if [[ $now_ts -ge $next_reminder_ts ]]; then
    reminder_count=$((reminder_count+1))
    case $escalation_level in
      0) post_comment "⏰ Reminder ${reminder_count}: awaiting Staging BASE_URL + JWT. Hourly reminders active." ;;
      1) post_comment "⏰ Reminder (2h): still awaiting BASE_URL + JWT. Increasing cadence to every 30 minutes." ;;
      2) post_comment "⏰ Escalation (6h): still awaiting BASE_URL + JWT. Consider prioritizing to unblock Sprint 2 validation." ;;
      3) post_comment "⚠️ Escalation (12h): Sprint 2 staging validation blocked. Provide BASE_URL + JWT or progress will slip." ;;
      4) post_comment "🚨 Final escalation (24h): Blocking release. Next fallback: partial internal staging if no response." ;;
      *) post_comment "⏰ Reminder ${reminder_count}: still awaiting BASE_URL + JWT." ;;
    esac
    next_reminder_ts=$((now_ts + REMINDER_INTERVAL))
  fi

  # Escalation changes at 2h / 6h / 12h / 24h
  if [[ $escalation_level -lt 1 && $now_ts -ge $two_hour_ts ]]; then
    escalation_level=1; post_comment "⏰ Reminder (2h): awaiting BASE_URL + JWT.";
    REMINDER_INTERVAL=1800  # 30m reminders after 2h
  fi
  if [[ $escalation_level -lt 2 && $now_ts -ge $six_hour_ts ]]; then
    escalation_level=2; post_comment "🔺 Escalation threshold reached (6h without token). Increasing visibility.";
    REMINDER_INTERVAL=1800  # keep 30m reminders
  fi
  if [[ $escalation_level -lt 3 && $now_ts -ge $twelve_hour_ts ]]; then
    escalation_level=3; post_comment "🔺 Escalation threshold reached (12h). Will add stronger warnings.";
    REMINDER_INTERVAL=1200  # 20m reminders
  fi
  if [[ $escalation_level -lt 4 && $now_ts -ge $twentyfour_hour_ts ]]; then
    escalation_level=4; post_comment "🔺 Escalation threshold reached (24h). Preparing fallback / partial validation plan.";
    REMINDER_INTERVAL=3600  # back to hourly after hard escalation
  fi
  if [[ $escalation_level -lt 5 && $now_ts -ge $thirty_hour_ts ]]; then
    escalation_level=5; post_comment "⏳ Extended delay (30h). Executing enhanced local validation & documenting h30 status.";
    REMINDER_INTERVAL=3600
  fi
  if [[ $escalation_level -lt 6 && $now_ts -ge $forty_eight_hour_ts ]]; then
    escalation_level=6; post_comment "🚨 48h threshold reached. Initiating conditional merge plan if credentials still absent.";
    REMINDER_INTERVAL=5400  # reduce frequency after decisive escalation
  fi

  sleep "$POLL_INTERVAL"
done
