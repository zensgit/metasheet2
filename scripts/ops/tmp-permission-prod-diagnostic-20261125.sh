#!/usr/bin/env bash
set -euo pipefail

classify_error() {
  local rc=$1 message=${2,,}
  if [[ "$rc" == 124 || "$rc" == 137 ]]; then
    printf '%s' timeout
  elif [[ "$message" == *'permission denied'* || "$message" == *'access denied'* || "$message" == *'authorization denied'* || "$message" == *'not authorized'* ]]; then
    printf '%s' access_denied
  elif [[ "$message" == *'no such container'* || "$message" == *'no such object'* ]]; then
    printf '%s' container_absent
  elif [[ "$message" == *'context'* && "$message" == *'not found'* ]]; then
    printf '%s' context_unavailable
  elif [[ "$message" == *'cannot connect to the docker daemon'* || "$message" == *'connection refused'* || "$message" == *'no such file or directory'* && "$message" == *'sock'* ]]; then
    printf '%s' daemon_unreachable
  else
    printf '%s' query_failed
  fi
}

if ! command -v docker >/dev/null; then
  printf '%s\n' 'docker=cli_missing'
  exit 2
fi

if context=$(timeout 8s docker context show 2>&1); then
  if [[ "$context" == default ]]; then
    printf '%s\n' 'docker_context=default'
  else
    printf '%s\n' 'docker_context=nondefault'
  fi
else
  printf '%s\n' 'docker_context=unavailable'
fi

if [[ -n "${DOCKER_HOST:-}" || -n "${DOCKER_CONTEXT:-}" ]]; then
  printf '%s\n' 'docker_environment_override=present'
else
  printf '%s\n' 'docker_environment_override=absent'
fi

if daemon=$(timeout 8s docker version --format '{{.Server.Version}}' 2>&1); then
  if [[ ! "$daemon" =~ ^[0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9._+-]*$ ]]; then
    printf '%s\n' 'docker=version_unrecognized'
    exit 2
  fi
  printf '%s\n' 'docker=reachable'
else
  rc=$?
  printf 'docker=%s\n' "$(classify_error "$rc" "$daemon")"
  exit 2
fi

result=0
for name in metasheet-backend metasheet-web metasheet-postgres metasheet-redis; do
  if state=$(timeout 8s docker inspect --type container --format '{{.State.Status}}' "$name" 2>&1); then
    case "$state" in
      running|created|restarting|removing|paused|exited|dead)
        printf 'container=%s state=%s\n' "$name" "$state"
        ;;
      *) printf 'container=%s error=state_unrecognized\n' "$name"; result=1 ;;
    esac
  else
    rc=$?
    printf 'container=%s error=%s\n' "$name" "$(classify_error "$rc" "$state")"
    result=1
  fi
done
exit "$result"
