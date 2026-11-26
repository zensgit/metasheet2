#!/usr/bin/env bash
set -euo pipefail

echo RESTORE_LEDGER_STARTED
python3 - <<'PY'
import hashlib
from pathlib import Path
import re

directory = Path.home() / 'metasheet2-deploy-window' / 'runs' / '45001991740-1'

def names(filename):
    path = directory / filename
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1048576:
        raise ValueError('missing or unbounded ledger')
    result = path.read_text(encoding='utf-8').splitlines()
    if not all(re.fullmatch(r'(?:\d|z)[A-Za-z0-9_.-]{1,160}', value) for value in result):
        raise ValueError('unrecognized migration name')
    if len(result) != len(set(result)):
        raise ValueError('duplicate migration name')
    return result

def digest(values):
    return hashlib.sha256('\n'.join(values).encode()).hexdigest()

try:
    before = names('ledger-before.txt')
    delta = names('inplay.txt')
    after = names('ledger-final.txt')
    coherent = set(before).issubset(after) and not (set(before) & set(delta)) and set(after) - set(before) == set(delta)
    print(f'migration_ledger=checked before={len(before)} delta={len(delta)} after={len(after)} consistent={str(coherent).lower()}')
    print(f'before_ledger_sha256={digest(sorted(before))}')
    print(f'migration_delta_sha256={digest(delta)}')
    print(f'after_ledger_sha256={digest(sorted(after))}')
    for migration in delta:
        print(f'migration_to_replay={migration}')
except (OSError, ValueError):
    print('migration_ledger=unavailable')
    raise SystemExit(1)

toc_path = directory / 'db.toc'
try:
    if toc_path.is_symlink() or not toc_path.is_file() or toc_path.stat().st_size > 16777216:
        raise ValueError('backup directory unavailable')
    toc = toc_path.read_text(encoding='utf-8')
    for table in ('kysely_migration', 'users', 'user_roles', 'delegated_role_admin_scopes',
                  'delegated_role_admin_member_groups', 'authorization_operation_receipts', 'authorization_operation_audit'):
        present = bool(re.search(r'(?m)^\d+;[^\n]+\bTABLE DATA public ' + table + r' ', toc))
        print(f'backup_table_data={table} present={str(present).lower()}')
except (OSError, ValueError):
    print('backup_toc=unavailable')
    raise SystemExit(1)
if not coherent:
    raise SystemExit(1)
PY
