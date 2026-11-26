#!/usr/bin/env bash
set -euo pipefail

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

echo PROOF_STARTED
for service in backend web postgres redis; do
  if state=$(timeout 6s docker inspect --type container --format '{{.State.Status}}' "metasheet-$service" 2>/dev/null); then
    case "$state" in
      running|created|restarting|removing|paused|exited|dead) ;;
      *) state=unknown ;;
    esac
  else
    state=unavailable
  fi
  printf 'known_service=%s state=%s\n' "$service" "$state"
done

deploy_scope=()
if [[ -d "$directory" && -r "$compose_path" ]] && metadata=$(
  timeout 10s docker compose --project-directory "$directory" -f "$compose_path" \
    config --no-interpolate --no-env-resolution --format json 2>/dev/null \
  | python3 -c '
import json, re, sys
data = json.load(sys.stdin)
def checked(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}", value) else "-"
print(checked(data.get("name")))
for key in ("metasheet-postgres-data", "metasheet-redis-data"):
    info = (data.get("volumes") or {}).get(key) or {}
    print(checked(info.get("name")))
' 2>/dev/null
); then
  mapfile -t deploy_scope <<< "$metadata"
fi
project=${deploy_scope[0]:--}

volume_present() {
  local name=$1 names
  if [[ "$name" == '-' ]]; then
    echo unknown
  elif names=$(timeout 6s docker volume ls --filter "name=$name" --format '{{.Name}}' 2>/dev/null); then
    if grep -Fxq -- "$name" <<< "$names"; then echo present; else echo absent; fi
  else
    echo unknown
  fi
}

for service in postgres redis; do
  key="metasheet-$service-data"
  if [[ "$service" == postgres ]]; then configured=${deploy_scope[1]:--}; else configured=${deploy_scope[2]:--}; fi
  if candidates=$(timeout 6s docker volume ls --filter "label=com.docker.compose.volume=$key" \
      --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null); then
    other=$(awk -v project="$project" 'NF && $0 != project { count++ } END { print count + 0 }' <<< "$candidates")
  else
    other=unknown
  fi
  printf 'volume=%s configured=%s literal=%s outside_project_label_count=%s\n' \
    "$service" "$(volume_present "$configured")" "$(volume_present "$key")" "$other"
done

window="$HOME/metasheet2-deploy-window/runs"
known_run=45001991740-1
known_sha=8de8859655e253bda775d51407475822466c7e48a7e28f77589d3052763daffd
known_dump="$window/$known_run/db.dump"
backup_count=0
newer_count=0
for dump in "$window"/*/db.dump; do
  run_folder=${dump%/db.dump}
  run_key=${run_folder##*/}
  if [[ ! "$run_key" =~ ^[1-9][0-9]{0,17}-[1-9][0-9]{0,7}$ || -L "$run_folder" || -L "$dump" || ! -f "$dump" || ! -r "$dump" || ! -s "$dump" ]]; then
    continue
  fi
  backup_count=$((backup_count + 1))
  if [[ "${run_key%-*}" -gt "${known_run%-*}" || "${run_key%-*}" == "${known_run%-*}" && "${run_key#*-}" -gt "${known_run#*-}" ]]; then
    newer_count=$((newer_count + 1))
  fi
done
printf 'available_window_backups=%s newer_run_backups=%s\n' "$backup_count" "$newer_count"

if [[ -L "$window/$known_run" || -L "$known_dump" || ! -f "$known_dump" || ! -r "$known_dump" || ! -s "$known_dump" ]]; then
  echo backup_checksum=unavailable
elif checksum=$(timeout 120s nice -n 10 sha256sum -- "$known_dump" 2>/dev/null); then
  if [[ "${checksum%% *}" == "$known_sha" ]]; then echo backup_checksum=matches; else echo backup_checksum=mismatch; fi
else
  code=$?
  if [[ "$code" == 124 ]]; then echo backup_checksum=timed_out; else echo backup_checksum=read_failed; fi
fi
