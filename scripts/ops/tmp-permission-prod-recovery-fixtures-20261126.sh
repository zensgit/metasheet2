#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
source_dir="$HOME/metasheet2-deploy-window/runs/45001991740-1"
work="$HOME/metasheet2-deploy-window/permission-recovery-20261126-v2"
[[ -f "$work/backup.sha256" && "$(<"$work/backup.sha256")" == 8de8859655e253bda775d51407475822466c7e48a7e28f77589d3052763daffd ]]
[[ -f "$source_dir/db.dump" && ! -L "$source_dir/db.dump" ]]
mapfile -t identity < "$work/identity"
image=${identity[4]}
[[ "$image" =~ ^(docker.io/library/)?postgres:15[.0-9]*(-alpine[A-Za-z0-9.]*)?$ ]]
# Parse only the named COPY sections in memory on the production host.
audit=$(cat <<'PY'
import re
import sys

header = re.compile(rb'^COPY public\.(users|user_roles|roles|role_permissions) \(([^)]+)\) FROM stdin;$')
markers = re.compile(r'(synthetic|合成|production[ ._-]*smoke|生产冒烟|测试账号)', re.I)
reserved = re.compile(r'@example\.(invalid|test)$', re.I)
role_marker = re.compile(r'^(?:acceptance[0-9]+_|synthetic[0-9a-z_-]*_)')
profiles = {}
admins = set()
roles = set()
role_perms = {}
model = ''
columns = ()
seen = set()

def item(fields, key):
    value = fields.get(key, b'')
    return '' if value == b'\\N' else value.decode('utf8', 'strict')

for raw in sys.stdin.buffer:
    line = raw.rstrip(b'\n')
    if model:
        if line == b'\\.':
            model = ''
            continue
        values = line.split(b'\t')
        if len(columns) != len(values):
            raise SystemExit('Unrecognized COPY record shape')
        fields = dict(zip(columns, values))
        if model == 'users':
            name = item(fields, 'name')
            email = item(fields, 'email')
            if not markers.search(name):
                continue
            uid = item(fields, 'id')
            active = item(fields, 'is_active') == 't'
            activated = item(fields, 'activation_status') == 'activated'
            removed = bool(item(fields, 'deleted_at') or item(fields, 'purged_at'))
            if uid and active and activated and not removed:
                profiles[uid] = (bool(reserved.search(email)), item(fields, 'is_admin') == 't' or item(fields, 'role') == 'admin')
        elif model == 'user_roles' and item(fields, 'role_id') == 'admin':
            admins.add(item(fields, 'user_id'))
        elif model == 'roles':
            role = item(fields, 'id')
            if role_marker.search(role):
                roles.add(role)
        elif model == 'role_permissions':
            role = item(fields, 'role_id')
            if role_marker.search(role):
                role_perms.setdefault(role, set()).add(item(fields, 'permission_code'))
    elif match := header.match(line):
        model = match.group(1).decode()
        columns = tuple(c.decode().strip().strip('"') for c in match.group(2).split(b','))
        seen.add(model)

if model or seen != {'users', 'user_roles', 'roles', 'role_permissions'}:
    raise SystemExit('Did not read all selected archive sections')

print('archive_marker_candidates_admin=' + str(sum(uid in admins for uid in profiles)))
print('archive_marker_candidates_member=' + str(sum(uid not in admins and not row[1] for uid, row in profiles.items())))
print('archive_reserved_synthetic_admin=' + str(sum(uid in admins and row[0] for uid, row in profiles.items())))
print('archive_reserved_synthetic_member=' + str(sum(uid not in admins and row[0] and not row[1] for uid, row in profiles.items())))
print('archive_marked_roles_with_permissions=' + str(sum(bool(role_perms.get(role)) for role in roles)))
PY
)
timeout 180s docker run --rm -i --pull never --network none "$image" pg_restore --exit-on-error \
  --data-only --schema public --table users --table user_roles --table roles --table role_permissions --file - \
  < "$source_dir/db.dump" | python3 -c "$audit"
