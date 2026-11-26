#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C
d() { timeout 15s docker "$@"; }
echo RECOVERY_PREFLIGHT_STARTED
backup_home="$HOME/metasheet2-deploy-window"
source_dir="$backup_home/runs/45001991740-1"
[[ -f "$backup_home/lock" && ! -L "$backup_home/lock" ]]
exec 9< "$backup_home/lock"
if ! flock -n 9; then echo recovery_lock=busy; exit 1; fi
echo recovery_lock=free
phase=$(sed -nE 's/^phase=([a-z_-]+)$/\1/p' "$backup_home/state" 2>/dev/null | head -n1 || true)
rc=$(tr -d '[:space:]' < "$source_dir/rc")
[[ "$phase" =~ ^(done-new|needs-owner|done-restored-old|refused-unchanged)$ && "$rc" =~ ^[0-9]{1,3}$ ]]
printf 'last_phase=%s last_rc=%s\n' "$phase" "$rc"
for service in postgres redis backend web; do
  if state=$(d inspect --type container --format '{{.State.Status}}' "metasheet-$service" 2>/dev/null); then
    [[ "$state" =~ ^(running|created|restarting|removing|paused|exited|dead)$ ]]
  else state=absent; fi
  printf 'service=%s state=%s\n' "$service" "$state"
done
[[ -z "$(d ps --filter name=metasheet-window-migrate- --format '{{.ID}}')" ]]
echo old_migrator=absent

deploy_path=$(printf '%s' "$PROBE_PATH_B64" | base64 -d)
compose_file=$(printf '%s' "$PROBE_COMPOSE_B64" | base64 -d)
case "$deploy_path" in
  /*) directory=$deploy_path ;;
  '~/'*) directory="$HOME/${deploy_path#\~/}" ;;
  *) directory="$HOME/$deploy_path" ;;
esac
case "$compose_file" in /*) f=$compose_file ;; *) f="$directory/$compose_file" ;; esac
[[ -d "$directory" && -f "$f" && -f "$directory/.env" && -f "$directory/docker/app.env" ]]
docker_root=$(d info -f '{{.DockerRootDir}}')
[[ "$docker_root" == /* && -d "$docker_root" ]]
free_bytes() { df -PB1 -- "$1" | awk 'END { print $4 }'; }
dump_bytes=$(stat -c '%s' -- "$source_dir/db.dump")
docker_free=$(free_bytes "$docker_root")
host_free=$(free_bytes "$backup_home")
[[ "$dump_bytes" =~ ^[0-9]+$ && "$docker_free" =~ ^[0-9]+$ && "$host_free" =~ ^[0-9]+$ ]]
printf 'database_archive_bytes=%s docker_free_bytes=%s window_free_bytes=%s\n' "$dump_bytes" "$docker_free" "$host_free"
checksum=$(timeout 240s nice -n 10 sha256sum -- "$source_dir/db.dump")
[[ ! -L "$source_dir/db.dump" && "${checksum%% *}" == 8de8859655e253bda775d51407475822466c7e48a7e28f77589d3052763daffd ]]
echo backup_checksum=matches

revision=135a04df0bcc2c3f2d60a05f7de0b721b5b5e10f
read_config='
import json, os, re, sys
from urllib.parse import urlparse
cfg = json.load(sys.stdin)
services = cfg["services"]
assert all(s in services for s in ("backend", "web", "postgres", "redis"))
backend = services["backend"]["environment"]
pg = services["postgres"]["environment"]
url = urlparse(backend.get("DATABASE_URL", ""))
assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", cfg["name"])
print("current_db_targets_compose=" + str(url.hostname == "postgres" and (url.port in (None, 5432))).lower())
print("current_db_name_agrees=" + str(bool(url.path) and url.path[1:] == (pg.get("POSTGRES_DB") or pg.get("POSTGRES_USER"))).lower())
print("current_exact_scope_disabled=" + str(backend.get("DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED") != "true").lower())
print("current_activation_disabled=" + str(backend.get("DELEGATED_SCOPE_ACTIVATION_ENABLED") != "true").lower())
print("current_auth_fixture_configured=" + str(any("SMOKE" in key and ("TOKEN" in key or "PASSWORD" in key) for key in backend)).lower())
for s, pattern in (("postgres", r"(?:docker.io/library/)?postgres:15[.0-9]*(?:-alpine[A-Za-z0-9.]*)?"), ("redis", r"(?:docker.io/library/)?redis:7[.0-9]*(?:-alpine[A-Za-z0-9.]*)?")):
    image = services[s].get("image", "")
    assert re.fullmatch(pattern, image)
    print("dependency_image=" + s + " tag=" + image.split("/")[-1])
for kind in ("postgres", "redis", "attendance-import"):
    name = cfg.get("volumes", {}).get("metasheet-" + kind + "-data", {}).get("name", "")
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name)
    print(name, file=sys.stderr)
'
mapfile -t volume_names < <(IMAGE_OWNER=zensgit IMAGE_TAG="$revision" d compose --project-directory "$directory" -f "$f" config --format json \
  | python3 -c "$read_config" 3>&1 1>&2 2>&3)
[[ "${#volume_names[@]}" == 3 ]]
for i in 0 1 2; do
  state=absent
  if d volume inspect "${volume_names[$i]}" >/dev/null 2>&1; then state=present; fi
  case "$i" in 0) kind=postgres;; 1) kind=redis;; 2) kind=attendance-import;; esac
  printf 'volume=%s state=%s\n' "$kind" "$state"
done
echo RECOVERY_PREFLIGHT_COMPLETE
