# PLM Real Regression Blocker 2026-03-19

## Scope

- Worktree: `metasheet2-plm-workbench`
- Branch: `codex/plm-workbench-collab-20260312`
- Goal: run real `PLM` regression after committing the audit/team-scene context batch

## Confirmed State

- `core-backend` health is reachable at `http://127.0.0.1:7778/health`
- `web` is reachable at `http://127.0.0.1:8899/`
- Current PLM batch has already been committed as `bcb189a68` `feat(plm-audit): add team scene context workflows`

## Blocker

Real `PLM` regression was blocked earlier in the day, but the blocker has now been narrowed down and resolved.

### Startup recovery status

Three local recovery paths were attempted:

1. `sqlite + local storage + create_all`
   - `Yuantus` seed commands succeeded
   - API startup failed during schema initialization
   - root cause: runtime schema contains `JSONB`, which SQLite cannot compile

2. reuse host PostgreSQL at `127.0.0.1:5435`
   - TCP port is open
   - direct `psycopg` connection to `postgresql://metasheet:metasheet@127.0.0.1:5435/postgres` timed out
   - this prevented provisioning a dedicated smoke database for `Yuantus`

3. `sqlite + existing migrated database + SCHEMA_MODE=migrations`
   - successful with:
     - `YUANTUS_DATABASE_URL=sqlite:////Users/huazhou/Downloads/Github/Yuantus/yuantus_mt_skip.db`
     - `YUANTUS_IDENTITY_DATABASE_URL=sqlite:////Users/huazhou/Downloads/Github/Yuantus/yuantus_mt_skip.db`
     - `YUANTUS_SCHEMA_MODE=migrations`
     - `YUANTUS_STORAGE_TYPE=local`
   - `Yuantus` health recovered at `http://127.0.0.1:7910/api/v1/health`

### Resolved root cause

After `Yuantus` was recovered, the next blocker was not upstream data semantics. The main issue was that local verification scripts were silently reusing another repo's running services:

- `core-backend` on `127.0.0.1:7778` was from `metasheet2-multitable`
- `web` on `127.0.0.1:8899` was also from `metasheet2-multitable`

That older process mix caused:

- `federation` requests to hit a different codebase and `PLMAdapter` runtime
- mock-like `bom_compare` responses (`summary` non-zero with empty arrays)
- missing newer routes such as `/api/federation/integration-status`
- UI regression to exercise the wrong frontend

After switching regression to isolated ports tied to the current `metasheet2-plm-workbench` worktree and using the working PostgreSQL URL from the running local stack, both regression scripts passed.

### Script fixes applied

- `scripts/verify-plm-ui-regression.sh`
  - now derives `VITE_PORT` from `WEB_BASE` before starting the dev server
  - uses stable element IDs for BOM / Where-Used local preset actions instead of text-substring locators
- `apps/web/src/components/plm/PlmBomPanel.vue`
  - added stable IDs for local preset action buttons
- `apps/web/src/components/plm/PlmWhereUsedPanel.vue`
  - added stable IDs for local preset action buttons

## Evidence

- SQLite startup failure log: `/tmp/yuantus-local-single-7910.log`
- Existing migrated DB startup succeeded in PTY with `yuantus_mt_skip.db`
- PostgreSQL connection probe: `psycopg.errors.ConnectionTimeout`
- Misrouted local services:
  - `127.0.0.1:7778` process cwd/env pointed at `metasheet2-multitable`
  - `127.0.0.1:8899` process cwd/env pointed at `metasheet2-multitable`
- `Yuantus` repo used for recovery attempts: `/Users/huazhou/Downloads/Github/Yuantus`
- Working smoke DB URL for isolated `PLM` regression:
  - `postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2`

## Resolution

The following commands completed successfully against isolated worktree-local services:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
API_BASE=http://127.0.0.1:7779 \
PLM_BASE_URL=http://127.0.0.1:7910 \
SMOKE_DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2 \
AUTO_START=true \
bash scripts/verify-plm-bom-tools.sh

API_BASE=http://127.0.0.1:7779 \
WEB_BASE=http://127.0.0.1:8901 \
UI_BASE=http://127.0.0.1:8901/plm \
VITE_PORT=8901 \
PLM_BASE_URL=http://127.0.0.1:7910 \
SMOKE_DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2 \
AUTO_START=true \
PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-20260319_2139.json \
bash scripts/verify-plm-ui-regression.sh
```

Artifacts:

- `artifacts/plm-bom-tools-20260319_2139.json`
- `artifacts/plm-bom-tools-20260319_2139.md`
- `docs/verification-plm-ui-regression-20260319_214459.md`
- `artifacts/plm-ui-regression-20260319_214459.png`

## Next Run

Prefer isolated ports when another local MetaSheet repo is already running:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
API_BASE=http://127.0.0.1:7779 \
WEB_BASE=http://127.0.0.1:8901 \
UI_BASE=http://127.0.0.1:8901/plm \
VITE_PORT=8901 \
PLM_BASE_URL=http://127.0.0.1:7910 \
SMOKE_DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2 \
AUTO_START=true \
bash scripts/verify-plm-bom-tools.sh

API_BASE=http://127.0.0.1:7779 \
WEB_BASE=http://127.0.0.1:8901 \
UI_BASE=http://127.0.0.1:8901/plm \
VITE_PORT=8901 \
PLM_BASE_URL=http://127.0.0.1:7910 \
SMOKE_DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2 \
AUTO_START=true \
PLM_BOM_TOOLS_JSON=artifacts/plm-bom-tools-*.json \
bash scripts/verify-plm-ui-regression.sh
```
