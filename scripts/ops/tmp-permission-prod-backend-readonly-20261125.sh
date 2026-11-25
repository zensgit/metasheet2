#!/usr/bin/env bash
set -euo pipefail

services_ready=true
for name in metasheet-backend metasheet-web metasheet-postgres metasheet-redis; do
  if ! details=$(docker inspect --type container --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null); then
    printf '%s=unavailable\n' "$name"
    services_ready=false
    continue
  fi
  read -r state health <<< "$details"
  case "$state" in
    running|created|restarting|removing|paused|exited|dead) ;;
    *) echo 'Unknown container state' >&2; exit 1 ;;
  esac
  case "$health" in
    healthy|unhealthy|starting|none) ;;
    *) echo 'Unknown container health state' >&2; exit 1 ;;
  esac
  printf '%s=%s health=%s\n' "$name" "$state" "$health"
  if [[ "$state" != running || "$health" == unhealthy || "$health" == starting ]]; then
    services_ready=false
  elif [[ "$name" == metasheet-postgres || "$name" == metasheet-redis ]] && [[ "$health" != healthy ]]; then
    services_ready=false
  fi
done
[[ "$services_ready" == true ]] || exit 1

image=$(docker inspect --type container --format '{{.Image}}' metasheet-backend)
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
revision=$(docker inspect --type image --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 1

docker exec -i metasheet-backend node --input-type=module - "$revision" <<'JS'
import { readFileSync } from 'node:fs'

try {
  const command = readFileSync('/proc/1/cmdline', 'utf8').split('\0')
  if (!command.some(value => /(?:^|\/)packages\/core-backend\/dist\/src\/index\.js$/.test(value))) {
    throw new Error('EXPECTED_BACKEND_PID_NOT_FOUND')
  }

  const values = readFileSync('/proc/1/environ', 'utf8').split('\0')
  const get = key => values.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1)
  const port = get('PORT') ?? '7778'
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('INVALID_BACKEND_PORT')
  }

  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    redirect: 'error', signal: AbortSignal.timeout(5000),
  })
  const body = await response.json()
  const commit = /^[0-9a-f]{40}$/.test(body?.build?.commit ?? '') ? body.build.commit : null
  const backendHealthy = response.status === 200 && body?.status === 'ok' && body?.ok === true
  const imageMatchesBackend = commit === process.argv[2]
  const exactDepartmentEnabled = get('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED') === 'true'
  const activationEnabled = get('DELEGATED_SCOPE_ACTIVATION_ENABLED') === 'true'
  console.log(JSON.stringify({ http: response.status, backendHealthy, commit, imageMatchesBackend, exactDepartmentEnabled, activationEnabled }))
  if (!backendHealthy || !imageMatchesBackend || exactDepartmentEnabled || activationEnabled) process.exitCode = 1
} catch {
  console.error('Production backend health or process inspection failed')
  process.exitCode = 1
}
JS
