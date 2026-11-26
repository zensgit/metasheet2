#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
work="$HOME/metasheet2-deploy-window/permission-recovery-20261126-v2"
[[ -d "$work" ]]
echo PRODUCTION_RECOVERY_OBSERVATION
df -PB1 -- "$(<"$work/storage.dir")" | awk 'END { print "remaining_bytes=" $4 }'
[[ ! -f "$work/restore.sealed" ]] || echo archive_verified=sealed
exec 9< "$HOME/metasheet2-deploy-window/lock"
if flock -n 9; then echo recovery_process_lock=free; else echo recovery_process_lock=held; fi
if ! state=$(docker inspect --format '{{.State.Status}}' metasheet-permission-recovery-postgres 2>/dev/null); then
  echo isolated_database=absent
else
  [[ "$state" =~ ^[a-z]+$ ]]
  printf 'isolated_database=%s\n' "$state"
  if [[ "$state" == running ]]; then
    mapfile -t identity < "$work/identity"
    db=${identity[3]}
    [[ "$db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]
    docker exec metasheet-permission-recovery-postgres psql -X -qAt -v ON_ERROR_STOP=1 \
      -U permission_recovery_bootstrap_20261126 -d "$db" \
      -c "SELECT 'database_bytes='||pg_database_size(current_database()); SELECT 'restore_sessions='||count(*) FROM pg_stat_activity WHERE application_name='pg_restore' AND pid != pg_backend_pid() AND state='active'; SELECT 'copy_workers='||count(*) FROM pg_stat_progress_copy; SELECT 'index_workers='||count(*) FROM pg_stat_progress_create_index; SELECT 'copy_processed='||COALESCE(sum(bytes_processed),0)||' tuples='||COALESCE(sum(tuples_processed),0) FROM pg_stat_progress_copy; SELECT 'restore_wait='||COALESCE(wait_event_type,'CPU') FROM pg_stat_activity WHERE application_name='pg_restore' AND state='active' LIMIT 1" \
      </dev/null 2>/dev/null || true
  fi
fi
for file in pg_restore.log detail.log migrate.log fence.log; do
  [[ -f "$work/$file" ]] || continue
  if grep -Eiq 'error:|^ERROR:' "$work/$file"; then
    category=unknown
    if grep -Eiq 'no space left|disk full' "$work/$file"; then category=storage
    elif grep -Eiq 'password authentication failed|role .* does not exist' "$work/$file"; then category=roles_or_authentication
    elif grep -Eiq 'function .* does not exist' "$work/$file"; then category=restore_functions
    elif grep -Eiq 'constraint|violates' "$work/$file"; then category=constraint
    fi
    printf 'diagnostic_file=%s category=%s\n' "$file" "$category"
  fi
done
