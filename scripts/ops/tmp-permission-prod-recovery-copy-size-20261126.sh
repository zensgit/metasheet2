#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
base="$HOME/metasheet2-deploy-window"
work="$base/permission-recovery-20261126-v2"
source="$base/runs/45001991740-1/db.dump"
[[ "$(<"$work/backup.sha256")" == 8de8859655e253bda775d51407475822466c7e48a7e28f77589d3052763daffd ]]
mapfile -t identity < "$work/identity"
database=${identity[3]}
image=${identity[4]}
stage=metasheet-permission-recovery-postgres
[[ "$database" =~ ^[a-z_][a-z0-9_]*$ && "$image" =~ ^(docker.io/library/)?postgres:15[.0-9]*(-alpine[A-Za-z0-9.]*)?$ ]]
if ! row=$(docker exec "$stage" psql -X -qAt -F '|' -v ON_ERROR_STOP=1 \
  -U permission_recovery_bootstrap_20261126 -d "$database" \
  -c "SELECT n.nspname,c.relname,p.bytes_processed FROM pg_stat_progress_copy p JOIN pg_catalog.pg_class c ON c.oid=p.relid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE p.command='COPY FROM' AND p.type='PIPE' LIMIT 1" \
  </dev/null 2>/dev/null); then
  echo volume_estimate=process_left_copy
  exit 0
fi
IFS='|' read -r schema relation offset <<< "$row"
if [[ ! "$schema" =~ ^[a-z_][a-z0-9_]*$ || ! "$relation" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || ! "$offset" =~ ^[0-9]+$ ]]; then
  echo volume_estimate=unavailable
  exit 0
fi
printf 'current_copy_bytes=%s\n' "$offset"
total=$(timeout 160s docker run --rm -i --cpu-shares 64 --pull never --network none "$image" \
  pg_restore --data-only --schema "$schema" --table "$relation" --file - \
  < "$source" | wc -c)
if ((total > offset)); then
  printf 'archive_active_table_bytes=%s\n' "$total"
else
  echo volume_estimate=unavailable
fi
