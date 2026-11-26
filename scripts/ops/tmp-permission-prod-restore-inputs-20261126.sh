#!/usr/bin/env bash
set -euo pipefail

echo RESTORE_INPUTS_STARTED
python3 - <<'PY'
import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path.home() / 'metasheet2-deploy-window' / 'runs' / '45001991740-1'
backup_hash = '8de8859655e253bda775d51407475822466c7e48a7e28f77589d3052763daffd'
revision = '135a04df0bcc2c3f2d60a05f7de0b721b5b5e10f'

def file(name):
    value = root / name
    return value if not value.is_symlink() and value.is_file() else None

def read(name, limit=1048576):
    path = file(name)
    if path is None or path.stat().st_size > limit:
        raise ValueError('missing or unbounded recovery input')
    return path.read_bytes()

def status(name, value):
    print(f'{name}={str(value).lower()}')

def fields(data, allowed):
    result = {}
    for line in data.decode('utf-8').splitlines():
        key, separator, value = line.partition('=')
        if separator and key in allowed:
            if key in result:
                raise ValueError('duplicate configuration key')
            result[key] = value.strip()
    return result

def image_matches(role, expected):
    repository = f'ghcr.io/zensgit/metasheet2-{role}'
    if not re.fullmatch(re.escape(repository) + r'@sha256:[a-f0-9]{64}', expected):
        return False
    try:
        result = subprocess.run(
            ['docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', f'{repository}:{revision}'],
            capture_output=True, timeout=8, check=True, text=True,
        )
        return expected in (json.loads(result.stdout) or [])
    except (OSError, ValueError, subprocess.SubprocessError):
        return False

try:
    meta = fields(read('meta.txt'), {'file', 'sha256', 'bytes', 'ledger_before', 'server_version', 'new_sha',
                                    'appdata_tar', 'new_backend_digest', 'new_web_digest'})
    status('archive_metadata_matches', meta.get('sha256') == backup_hash and meta.get('new_sha') == revision
           and meta.get('file') == 'db.dump' and meta.get('ledger_before') == '335')
    db = file('db.dump')
    status('database_archive_size_matches', db is not None and str(db.stat().st_size) == meta.get('bytes'))
    version = re.match(r'^(\d+)\.(\d+)(?:\.(\d+))?', meta.get('server_version', ''))
    print('source_postgres_version=' + (version[0] if version else 'unknown'))

    env = read('env-snapshot.app.env')
    status('old_env_snapshot_hash_matches', hashlib.sha256(env).hexdigest() == read('env-snapshot.app.env.sha256').decode().strip())
    configuration = fields(env, {'POSTGRES_USER', 'POSTGRES_DB', 'DB_SSL'})
    boot_role = configuration.get('POSTGRES_USER', '').strip('\'"')
    database = configuration.get('POSTGRES_DB', boot_role).strip('\'"')
    role_archive = read('globals.sql').decode('utf-8')
    role_names = re.findall(r'(?m)^CREATE ROLE ([a-z_][a-z0-9_]{0,62});$', role_archive)
    status('global_roles_archive_present', bool(role_names))
    status('bootstrap_role_recorded', bool(boot_role) and boot_role in role_names)
    status('old_database_ssl_explicitly_disabled', configuration.get('DB_SSL', '').strip('\'"').lower() in {'false', '0', 'off', 'no'})
    toc = read('db.toc', 16777216).decode('utf-8')
    header = re.search(r'(?m)^;\s*dbname:\s*(\S+)\s*$', toc)
    status('database_name_matches_old_config', bool(header and database and header[1] == database))

    shims = [line for line in read('shim-candidates.txt', 16777216).decode('utf-8').splitlines() if line.strip()]
    print(f'archived_search_path_shim_candidates={len(shims)}')
    status('appdata_expected', meta.get('appdata_tar') == '1')
    appdata = file('appdata.tar')
    status('appdata_present', appdata is not None and appdata.stat().st_size > 0)
    listing = file('appdata.list')
    status('appdata_listing_present', listing is not None and listing.stat().st_size > 0)
    for role in ('backend', 'web'):
        status(f'{role}_recorded_image_digest_matches', image_matches(role, meta.get(f'new_{role}_digest', '')))
except (OSError, ValueError):
    print('restore_inputs=unavailable')
    raise SystemExit(1)
PY
