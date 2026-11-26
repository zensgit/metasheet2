#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C
revision=135a04df0bcc2c3f2d60a05f7de0b721b5b5e10f
backup_sha=8de8859655e253bda775d51407475822466c7e48a7e28f77589d3052763daffd
before_sha=36b6ee5ce823ba53585147a5fea3a4bc0befd5387d19fd278e6946fbedb0312e
base="$HOME/metasheet2-deploy-window"
origin="$base/runs/45001991740-1"
work="$base/permission-recovery-20261126"
d() { docker "$@"; }
echo RECOVERY_STAGE_STARTED
[[ -f "$base/lock" && ! -L "$base/lock" ]]
exec 9< "$base/lock"
flock -n 9
[[ "$(<"$origin/rc")" == 0 ]]
for item in db.dump globals.sql db.toc meta.txt shim-candidates.txt env-snapshot.app.env env-snapshot.app.env.sha256; do
  [[ ! -L "$origin/$item" && -f "$origin/$item" && -r "$origin/$item" && -s "$origin/$item" ]]
done
if [[ -e "$work" ]]; then echo recovery_stage=workspace_already_exists; exit 1; fi
mkdir -m 700 -- "$work"
stage=inputs
pg_id=
finish() {
  local rc=$?
  trap - EXIT
  if [[ -n "$pg_id" ]]; then
    d logs "$pg_id" > "$work/postgres-stage.log" 2>&1 || true
    d stop -t 20 "$pg_id" >> "$work/detail.log" 2>&1 || rc=1
  fi
  printf '%s\n' "$rc" > "$work/restore.rc"
  if ((rc)); then printf 'recovery_stage_failed=%s\n' "$stage"; fi
  exit "$rc"
}
trap finish EXIT
exec 2>>"$work/detail.log"
tr -d '\r' < "$origin/meta.txt" | grep -Fxq 'created_utc=2026-11-22T08:25:58Z'
dump_hash=$(timeout 240s sha256sum -- "$origin/db.dump")
[[ "${dump_hash%% *}" == "$backup_sha" ]]
env_hash=$(sha256sum -- "$origin/env-snapshot.app.env")
[[ "${env_hash%% *}" == "$(<"$origin/env-snapshot.app.env.sha256")" ]]
d info -f '{{.DockerRootDir}}' > "$work/storage.dir"
free=$(df -PB1 -- "$(<"$work/storage.dir")" | awk 'END { print $4 }')
size=$(stat -c '%s' -- "$origin/db.dump")
[[ "$free" =~ ^[0-9]+$ && "$size" =~ ^[0-9]+$ ]]
((free >= 4294967296 + size * 4))
for service in postgres redis backend web; do
  ! d inspect --type container "metasheet-$service" >/dev/null 2>&1
done
[[ -z "$(d ps --filter name=metasheet-window-migrate- --format '{{.ID}}')" ]]
echo recovery_inputs=verified

deploy=$(printf '%s' "$PROBE_PATH_B64" | base64 -d)
config=$(printf '%s' "$PROBE_COMPOSE_B64" | base64 -d)
case "$deploy" in /*) dir=$deploy;; '~/'*) dir="$HOME/${deploy#\~/}";; *) dir="$HOME/$deploy";; esac
case "$config" in /*) file=$config;; *) file="$dir/$config";; esac
dir=$(realpath -e -- "$dir")
file=$(realpath -e -- "$file")
[[ -f "$file" && -f "$dir/docker/app.env" && -f "$dir/.env" ]]
IMAGE_OWNER=zensgit IMAGE_TAG="$revision" d compose --project-directory "$dir" -f "$file" config --format json > "$work/compose.json"

stage=compose_identity
python3 - "$work" "$origin" "$dir" "$file" <<'PY'
import json, re, sys
from pathlib import Path
from urllib.parse import unquote, urlparse
work, origin = (Path(value) for value in sys.argv[1:3])
dirpath, composepath = sys.argv[3:]
cfg = json.loads((work / 'compose.json').read_text())
services = cfg['services']
identifier = re.compile(r'[a-z_][a-z0-9_]{0,62}')
current = services['postgres']['environment']
user = current['POSTGRES_USER']
db = current.get('POSTGRES_DB') or user
assert identifier.fullmatch(user) and identifier.fullmatch(db)
assert db not in {'postgres', 'template0', 'template1'}
archive = {}
for line in (origin / 'env-snapshot.app.env').read_text().splitlines():
    key, sep, value = line.partition('=')
    if sep and key in {'POSTGRES_USER', 'POSTGRES_DB'}:
        assert key not in archive
        archive[key] = value.strip().strip('\'"')
assert user == archive.get('POSTGRES_USER')
assert db == (archive.get('POSTGRES_DB') or user)
toc = (origin / 'db.toc').read_text()
assert re.search(rf'(?m)^;\s*dbname:\s*{re.escape(db)}\s*$', toc)
assert f'CREATE ROLE {user};' in (origin / 'globals.sql').read_text().splitlines()

backend = services['backend']
dsn = urlparse(backend['environment']['DATABASE_URL'])
assert dsn.scheme in ('postgres', 'postgresql') and dsn.hostname in ('postgres', 'metasheet-postgres')
assert dsn.port in (None, 5432) and unquote(dsn.path) == '/' + db
assert identifier.fullmatch(unquote(dsn.username or '')) and bool(dsn.password)
mounts = services['postgres']['volumes']
assert any(v['type'] == 'volume' and v['source'] == 'metasheet-postgres-data'
           and v['target'] == '/var/lib/postgresql/data' for v in mounts)
pg_image = services['postgres']['image']
assert re.fullmatch(r'(?:docker.io/library/)?postgres:15[.0-9]*(?:-alpine[A-Za-z0-9.]*)?', pg_image)
project = cfg['name']
assert re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project)
volume = cfg['volumes']['metasheet-postgres-data']['name']
assert volume == project + '_metasheet-postgres-data'
assert '\n' not in dirpath and '\n' not in composepath
(work / 'identity').write_text('\n'.join((project, volume, user, db, pg_image, dirpath, composepath)) + '\n')
PY
mapfile -t identity < "$work/identity"
[[ "${#identity[@]}" == 7 ]]
project=${identity[0]}
volume=${identity[1]}
pg_user=${identity[2]}
pg_db=${identity[3]}
pg_image=${identity[4]}
! d volume inspect "$volume" >/dev/null 2>&1
d image inspect "$pg_image" >/dev/null
[[ "$(d run --rm --pull never --network none "$pg_image" postgres --version)" =~ PostgreSQL\)\ 15\.18([[:space:]]|$) ]]
printf '%s\n' "$backup_sha" > "$work/backup.sha256"
echo target_database=verified

stage=archive_compatibility
python3 - "$origin/shim-candidates.txt" "$work" <<'PY'
import re, sys
from pathlib import Path
shim_file, root = map(Path, sys.argv[1:])
shims = shim_file.read_text().splitlines()
pattern = re.compile(r'public\.[a-z_][a-z0-9_]*\([A-Za-z0-9_ ,."\[\]]*\)')
assert len(shims) == 79 and len(set(shims)) == 79 and all(pattern.fullmatch(entry) for entry in shims)
for name, tail in (('shim.set.sql', 'SET search_path = pg_catalog, public'),
                   ('shim.reset.sql', 'RESET search_path')):
    (root / name).write_text(''.join(f'ALTER FUNCTION {signature} {tail};\n' for signature in shims))
PY

stage=isolated_postgres
admin=permission_recovery_bootstrap_20261126
! grep -Fxq "CREATE ROLE $admin;" "$origin/globals.sql"
init_pw=$(openssl rand -hex 32)
[[ "$(d volume create --label "com.docker.compose.project=$project" \
   --label com.docker.compose.volume=metasheet-postgres-data \
   --label metasheet.recovery.archive=45001991740-1 "$volume")" == "$volume" ]]
pg_id=$(d run -d --rm --pull never --network none --name metasheet-permission-recovery-postgres \
  --mount "type=volume,src=$volume,dst=/var/lib/postgresql/data" \
  -e "POSTGRES_USER=$admin" -e "POSTGRES_PASSWORD=$init_pw" -e POSTGRES_DB=postgres "$pg_image")
unset init_pw
[[ "$(d inspect --format '{{.HostConfig.NetworkMode}}/{{len .HostConfig.PortBindings}}' "$pg_id")" == none/0 ]]
for _ in $(seq 1 40); do
  if d exec "$pg_id" pg_isready -h 127.0.0.1 -U "$admin" -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
d exec "$pg_id" pg_isready -h 127.0.0.1 -U "$admin" -d postgres >/dev/null
echo target_database=isolated
psql_db() {
  local db=$1; shift
  d exec -i "$pg_id" psql -X -v ON_ERROR_STOP=1 -qAt -U "$admin" -d "$db" "$@"
}
restore() {
  timeout 30m docker exec -i "$pg_id" pg_restore --exit-on-error -U "$admin" "$@" \
    < "$origin/db.dump" >> "$work/pg_restore.log" 2>&1
}

stage=roles
psql_db postgres --single-transaction -f - < "$origin/globals.sql" >> "$work/globals.log" 2>&1
echo roles_restore=passed
stage=pre_data
restore --create --section=pre-data -d postgres
[[ "$(psql_db "$pg_db" -c "SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname=current_database()")" == "$pg_user" ]]
echo pre_data_restore=passed

fingerprint_sql="SELECT md5(coalesce(string_agg(p.oid::pg_catalog.regprocedure::text || '|' || coalesce(pg_catalog.array_to_string(p.proconfig, ','), '-'), ';' ORDER BY p.oid::pg_catalog.regprocedure::text COLLATE \"C\"), '')) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'"
original_proconfig=$(psql_db "$pg_db" -c "$fingerprint_sql")
[[ "$original_proconfig" =~ ^[a-f0-9]{32}$ ]]
psql_db postgres -c "ALTER DATABASE $pg_db SET session_replication_role = 'replica'"
psql_db "$pg_db" --single-transaction -f - < "$work/shim.set.sql"

stage=data
restore --single-transaction --section=data -d "$pg_db"
echo data_restore=passed
stage=post_data
restore --single-transaction --section=post-data -d "$pg_db"
echo post_data_restore=passed
stage=restore_validation
psql_db "$pg_db" --single-transaction -f - < "$work/shim.reset.sql"
psql_db postgres -c "ALTER DATABASE $pg_db RESET session_replication_role"
[[ "$(psql_db "$pg_db" -c 'SHOW session_replication_role')" == origin ]]
[[ "$(psql_db "$pg_db" -c "$fingerprint_sql")" == "$original_proconfig" ]]
ledger=$(psql_db "$pg_db" -c 'SELECT name FROM public.kysely_migration ORDER BY name COLLATE "C"')
[[ "$(grep -c . <<< "$ledger")" == 335 ]]
ledger_hash=$(printf '%s' "$ledger" | sha256sum)
[[ "${ledger_hash%% *}" == "$before_sha" ]]
echo before_ledger=335_verified
scopes="SELECT (SELECT count(*) FROM public.delegated_role_admin_scopes), (SELECT md5(COALESCE(jsonb_agg(to_jsonb(s)-'include_children' ORDER BY s.id)::text, '[]')) FROM public.delegated_role_admin_scopes s), (SELECT count(*) FROM public.delegated_role_admin_member_groups), (SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id)::text, '[]')) FROM public.delegated_role_admin_member_groups s)"
psql_db "$pg_db" -c "$scopes" > "$work/legacy-scopes.before"
printf '%s\n' "$scopes" > "$work/legacy-scopes.sql"
psql_db postgres -c "ALTER ROLE $admin NOLOGIN PASSWORD NULL"
d stop -t 30 "$pg_id" >> "$work/detail.log" 2>&1
pg_id=
echo RECOVERY_STAGE_COMPLETE
