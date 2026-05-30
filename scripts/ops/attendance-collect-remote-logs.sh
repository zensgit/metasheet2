#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${OUTPUT_DIR:-output/remote-log-snapshot}"
SINCE="${SINCE:-2h}"
UNTIL="${UNTIL:-}"
TAIL_LINES="${TAIL_LINES:-2500}"
CONTAINERS_CSV="${CONTAINERS_CSV:-metasheet-backend,metasheet-web,metasheet-postgres,metasheet-redis}"

function info() {
  echo "[attendance-collect-remote-logs] $*" >&2
}

function sanitize_name() {
  printf '%s' "$1" | sed -E 's/[^A-Za-z0-9_.-]+/_/g'
}

function redact_stream() {
  sed -E \
    -e 's#(Bearer[[:space:]]+)[A-Za-z0-9._~+/=-]+#\1[REDACTED]#g' \
    -e 's#((authorization|cookie|set-cookie)[[:space:]]*:[[:space:]]*)[^[:space:]]+#\1[REDACTED]#Ig' \
    -e 's#(postgres(ql)?://)[^/@[:space:]]+@#\1[REDACTED]@#Ig' \
    -e 's#((access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|jwt|session|authorityCode)[A-Za-z0-9_.-]*[[:space:]]*[:=][[:space:]]*"?)[^"[:space:],}]+#\1[REDACTED]#Ig'
}

function run_redacted() {
  "$@" 2>&1 | redact_stream
}

mkdir -p "$OUTPUT_DIR/logs" "$OUTPUT_DIR/inspect"

generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
summary_path="$OUTPUT_DIR/snapshot-summary.md"

{
  echo "# Attendance Remote Log Snapshot"
  echo
  echo "- Generated at: \`${generated_at}\`"
  echo "- Since: \`${SINCE}\`"
  echo "- Until: \`${UNTIL:-<none>}\`"
  echo "- Tail lines: \`${TAIL_LINES}\`"
  echo "- Containers: \`${CONTAINERS_CSV}\`"
} >"$summary_path"

{
  echo "generated_at=${generated_at}"
  echo "since=${SINCE}"
  echo "until=${UNTIL:-}"
  echo "tail_lines=${TAIL_LINES}"
  echo "containers=${CONTAINERS_CSV}"
} >"$OUTPUT_DIR/snapshot.env"

{
  echo "=== host ==="
  date -u '+date_utc=%Y-%m-%dT%H:%M:%SZ'
  uname -a || true
  uptime || true
  echo
  echo "=== disk ==="
  df -h / || true
  echo
  echo "=== memory ==="
  free -m || true
  echo
  echo "=== docker ==="
  docker version --format 'Client={{.Client.Version}} Server={{.Server.Version}}' 2>/dev/null || docker version || true
  docker compose version 2>/dev/null || docker-compose version 2>/dev/null || true
} 2>&1 | redact_stream >"$OUTPUT_DIR/host-health.txt"

run_redacted docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' >"$OUTPUT_DIR/docker-ps.txt" || true
run_redacted docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}' >"$OUTPUT_DIR/docker-stats.txt" || true

IFS=',' read -r -a containers <<< "$CONTAINERS_CSV"
for raw_container in "${containers[@]}"; do
  container="$(printf '%s' "$raw_container" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  [[ -n "$container" ]] || continue
  safe_container="$(sanitize_name "$container")"
  inspect_path="$OUTPUT_DIR/inspect/${safe_container}.inspect.txt"
  log_path="$OUTPUT_DIR/logs/${safe_container}.log"

  info "collecting container=${container}"
  {
    echo "container=${container}"
    docker inspect --format 'Name={{.Name}}
Image={{.Config.Image}}
State={{.State.Status}}
StartedAt={{.State.StartedAt}}
FinishedAt={{.State.FinishedAt}}
RestartCount={{.RestartCount}}
OOMKilled={{.State.OOMKilled}}
ExitCode={{.State.ExitCode}}
Health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" || true
  } 2>&1 | redact_stream >"$inspect_path"

  docker_args=(logs --timestamps --tail "$TAIL_LINES" --since "$SINCE")
  if [[ -n "$UNTIL" ]]; then
    docker_args+=(--until "$UNTIL")
  fi
  docker_args+=("$container")

  run_redacted docker "${docker_args[@]}" >"$log_path" || true

  {
    echo
    echo "## ${container}"
    echo
    echo "- Inspect: \`inspect/${safe_container}.inspect.txt\`"
    echo "- Log: \`logs/${safe_container}.log\`"
  } >>"$summary_path"
done

info "snapshot written to ${OUTPUT_DIR}"
