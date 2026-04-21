# DingTalk Deploy Image Tag Reconcile Verification - 2026-04-20

## Static Verification

Checked the workflow diff:

```bash
git diff -- .github/workflows/docker-build.yml
git diff --check
```

Results:

- workflow now persists `IMAGE_OWNER` and `IMAGE_TAG` into repo-root `.env`
- `git diff --check`: passed

## Local Logic Verification

Validated the new `.env` update logic on a temporary file:

```bash
tmpdir=$(mktemp -d)
cat > "$tmpdir/.env" <<'EOF'
FOO=bar
IMAGE_TAG=oldtag
# comment
EOF
python3 - "$tmpdir/.env" zensgit 88a45881821f0792e4a54c1161588f603a59e34b <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
image_owner = sys.argv[2].strip() or 'zensgit'
image_tag = sys.argv[3].strip()
lines = path.read_text().splitlines() if path.exists() else []
entries = {}
order = []
for line in lines:
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        if key not in entries:
            order.append(key)
        entries[key] = value
entries['IMAGE_OWNER'] = image_owner
if 'IMAGE_OWNER' not in order:
    order.append('IMAGE_OWNER')
entries['IMAGE_TAG'] = image_tag
if 'IMAGE_TAG' not in order:
    order.append('IMAGE_TAG')
updated = []
seen = set()
for line in lines:
    if '=' in line and not line.lstrip().startswith('#'):
        key = line.split('=', 1)[0]
        if key in seen:
            continue
        seen.add(key)
        updated.append(f"{key}={entries[key]}")
    else:
        updated.append(line)
for key in order:
    if key not in seen:
        updated.append(f"{key}={entries[key]}")
path.write_text('\n'.join(updated) + '\n')
PY
cat "$tmpdir/.env"
```

Result:

```text
FOO=bar
IMAGE_TAG=88a45881821f0792e4a54c1161588f603a59e34b
# comment
IMAGE_OWNER=zensgit
```

## Production Reconcile Verification

Manually aligned the current host `.env`:

```bash
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 "python3 - <<'PY'
from pathlib import Path
path = Path('/home/mainuser/metasheet2/.env')
lines = path.read_text().splitlines() if path.exists() else []
entries = {}
order = []
for line in lines:
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        if key not in entries:
            order.append(key)
        entries[key] = value
entries['IMAGE_OWNER'] = 'zensgit'
if 'IMAGE_OWNER' not in order:
    order.append('IMAGE_OWNER')
entries['IMAGE_TAG'] = '88a45881821f0792e4a54c1161588f603a59e34b'
if 'IMAGE_TAG' not in order:
    order.append('IMAGE_TAG')
updated = []
seen = set()
for line in lines:
    if '=' in line and not line.lstrip().startswith('#'):
        key = line.split('=', 1)[0]
        if key in seen:
            continue
        seen.add(key)
        updated.append(f'{key}={entries[key]}')
    else:
        updated.append(line)
for key in order:
    if key not in seen:
        updated.append(f'{key}={entries[key]}')
path.write_text('\\n'.join(updated) + '\\n')
print(path.read_text(), end='')
PY"
```

Result:

```text
IMAGE_OWNER=zensgit
IMAGE_TAG=88a45881821f0792e4a54c1161588f603a59e34b
```

## CLI Note

Tried to run Claude Code CLI for a one-line design sanity check:

```bash
claude -p "Reply with one short sentence only: ..."
```

Result:

- CLI invocation worked
- current account hit the daily usage limit: `You've hit your limit · resets 6pm (Asia/Shanghai)`

So this change was completed and verified without relying on Claude output.
