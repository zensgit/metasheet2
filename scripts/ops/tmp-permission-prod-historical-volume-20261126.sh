#!/usr/bin/env bash
set -euo pipefail

project_sha=40b04012fd32c2ff94d77a9025ff2da5a3f31c43d672c1c383edab46eafdf4e5
echo HISTORICAL_VOLUME_CHECK_STARTED
for service in postgres redis; do
  key="metasheet-$service-data"
  if [[ "$service" == postgres ]]; then expected=a0fb1915d58df3e90913f3226c0660a80b51af6d401fe4fc94b668409685a75b; else expected=5f078c56f62c5c82a7b093b5633776368084578d9d088d51bd471687b3b4ad6c; fi
  if ! names=$(timeout 8s docker volume ls --filter "name=$key" --format '{{.Name}}' 2>/dev/null); then
    printf 'historical_volume=%s status=unavailable\n' "$service"
    continue
  fi
  exact=0
  labels=0
  while IFS= read -r name; do
    [[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$ ]] || continue
    hashed=$(printf '%s' "$name" | sha256sum)
    [[ "${hashed%% *}" == "$expected" ]] || continue
    exact=$((exact + 1))
    if project=$(timeout 6s docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$name" 2>/dev/null); then
      hashed=$(printf '%s' "$project" | sha256sum)
      if [[ "${hashed%% *}" == "$project_sha" ]]; then labels=$((labels + 1)); fi
    fi
  done <<< "$names"
  printf 'historical_volume=%s exact_name_count=%s matching_project_label_count=%s\n' "$service" "$exact" "$labels"
done
