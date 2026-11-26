#!/usr/bin/env bash
set -euo pipefail

echo OWNERSHIP_STARTED
for service in postgres redis; do
  key="metasheet-$service-data"
  if [[ "$service" == postgres ]]; then destination=/var/lib/postgresql/data; else destination=/data; fi
  format='{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "DESTINATION")}}{{println .Name}}{{end}}{{end}}'
  format=${format/DESTINATION/$destination}
  staging_volume=$(timeout 6s docker inspect --type container --format "$format" "metasheet-staging-$service" 2>/dev/null || true)
  production_volume=$(timeout 6s docker inspect --type container --format "$format" "metasheet-$service" 2>/dev/null || true)
  if ! names=$(timeout 8s docker volume ls --filter "label=com.docker.compose.volume=$key" --format '{{.Name}}' 2>/dev/null); then
    printf 'volume_ownership=%s status=unavailable\n' "$service"
    continue
  fi
  matched_staging=0
  matched_production=0
  shared=0
  other_attached=0
  unattached=0
  unknown=0
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if [[ ! "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$ ]]; then
      unknown=$((unknown + 1))
      continue
    fi
    if [[ "$name" == "$staging_volume" && "$name" == "$production_volume" ]]; then
      shared=$((shared + 1))
    elif [[ "$name" == "$staging_volume" ]]; then
      matched_staging=$((matched_staging + 1))
    elif [[ "$name" == "$production_volume" ]]; then
      matched_production=$((matched_production + 1))
    elif attached=$(timeout 6s docker ps -a --filter "volume=$name" --format '{{.ID}}' 2>/dev/null); then
      if [[ -n "$attached" ]]; then other_attached=$((other_attached + 1)); else unattached=$((unattached + 1)); fi
    else
      unknown=$((unknown + 1))
    fi
  done <<< "$names"
  printf 'volume_ownership=%s staging=%s production=%s shared=%s other_attached=%s unattached=%s unknown=%s\n' \
    "$service" "$matched_staging" "$matched_production" "$shared" "$other_attached" "$unattached" "$unknown"
done
