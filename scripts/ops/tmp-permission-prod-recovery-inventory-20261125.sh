#!/usr/bin/env bash
set -euo pipefail

revision=135a04df0bcc2c3f2d60a05f7de0b721b5b5e10f
deploy_path=$(printf '%s' "$PROBE_PATH_B64" | base64 -d)
compose_file=$(printf '%s' "$PROBE_COMPOSE_B64" | base64 -d)
unset PROBE_PATH_B64 PROBE_COMPOSE_B64
case "$deploy_path" in
  /*) directory=$deploy_path ;;
  '~/'*) directory="$HOME/${deploy_path#\~/}" ;;
  *) directory="$HOME/$deploy_path" ;;
esac
case "$compose_file" in
  /*) compose_path=$compose_file ;;
  *) compose_path="$directory/$compose_file" ;;
esac

file_state() {
  if [[ -r "$2" && -s "$2" ]]; then printf '%s=present\n' "$1"; else printf '%s=unavailable\n' "$1"; fi
}

echo INVENTORY_STARTED
if [[ -d "$directory" && -x "$directory" ]]; then
  echo deploy_directory=accessible
else
  echo deploy_directory=unavailable
fi
file_state compose_file "$compose_path"
file_state app_env "$directory/docker/app.env"
file_state prior_backup "$HOME/metasheet2-deploy-window/runs/45001991740-1/db.dump"
file_state prior_backup_catalog "$HOME/metasheet2-deploy-window/runs/45001991740-1/db.toc"

for service in backend web; do
  image="ghcr.io/zensgit/metasheet2-$service:$revision"
  if label=$(timeout 8s docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null); then
    if [[ "$label" == "$revision" ]]; then printf 'release_image_%s=matches\n' "$service"
    else printf 'release_image_%s=revision_mismatch\n' "$service"; fi
  else
    printf 'release_image_%s=unavailable\n' "$service"
  fi
done

if [[ -d "$directory" && -r "$compose_path" ]] && project=$(
  timeout 10s docker compose --project-directory "$directory" -f "$compose_path" \
     config --no-interpolate --no-env-resolution --format json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("name", ""))' 2>/dev/null
); then
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo compose_project=unavailable; exit 0; }
else
  echo compose_project=unavailable
  exit 0
fi
echo compose_project=identified

if members=$(timeout 8s docker ps -a --filter "label=com.docker.compose.project=$project" \
  --format '{{.Label "com.docker.compose.service"}} {{.State}}' 2>/dev/null); then
  for service in backend web postgres redis; do
    total=$(awk -v service="$service" '$1 == service { count++ } END { print count + 0 }' <<< "$members")
    running=$(awk -v service="$service" '$1 == service && $2 == "running" { count++ } END { print count + 0 }' <<< "$members")
    printf 'project_service=%s total=%s running=%s\n' "$service" "$total" "$running"
  done
else
  echo compose_services=unavailable
fi

if volumes=$(timeout 8s docker volume ls --filter "label=com.docker.compose.project=$project" \
  --format '{{.Label "com.docker.compose.volume"}}' 2>/dev/null); then
  for volume in metasheet-postgres-data metasheet-redis-data metasheet-attendance-import-data; do
    total=$(awk -v volume="$volume" '$0 == volume { count++ } END { print count + 0 }' <<< "$volumes")
    printf 'project_volume=%s count=%s\n' "$volume" "$total"
  done
else
  echo compose_volumes=unavailable
fi
