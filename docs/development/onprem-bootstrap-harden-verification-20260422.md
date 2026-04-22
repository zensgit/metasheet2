# Verification — On-Prem Bootstrap Hardening

- **Branch**: `codex/harden-onprem-bootstrap-20260422`
- **Date**: 2026-04-22
- **Development MD**: `onprem-bootstrap-harden-development-20260422.md`
- **Closes**: #517, #518

## Evidence matrix

| Issue | Fix | Test(s) |
|---|---|---|
| #517 DATABASE_URL sslmode not documented | Added `?sslmode=disable` comment above `DATABASE_URL` in all four env templates | Visual diff on `docker/app.env.*.template` |
| #518 `pm2 start` loses `DATABASE_URL` | Inline env loader at top of `ecosystem.config.cjs` reads `docker/app.env` into `process.env` | `scripts/ops/ecosystem-env-loader.test.mjs` (7 cases) |
| #518 bootstrap scripts still win | Loader uses `if (!(key in process.env))` — shell-exported values are preserved | Loader test: "does NOT override values already present in the shell env" |
| #518 dev/CI path | `fs.existsSync` guard — missing `docker/app.env` is a silent no-op | Loader test: "is a silent no-op when docker/app.env is missing" |

## Test runs

### Ecosystem env loader

```
node --test scripts/ops/ecosystem-env-loader.test.mjs
```

Result:

```text
✔ populates process.env from docker/app.env (27ms)
✔ skips comments and blank lines without error (27ms)
✔ strips single and double quotes from values (bash-like) (28ms)
✔ preserves `=` characters inside values (27ms)
✔ preserves empty values without crashing (28ms)
✔ does NOT override values already present in the shell env (27ms)
✔ is a silent no-op when docker/app.env is missing (27ms)
✔ ecosystem.config.cjs env loader (196ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

### Manual smoke — direct `pm2 start` path

Before this change (reproducing #518 on bare shell):

```bash
# In a fresh shell with no sourced env
node -e "require('./ecosystem.config.cjs'); console.log(process.env.DATABASE_URL)"
# → undefined  (backend would crash-loop here)
```

After this change, with a populated `docker/app.env`:

```bash
cat > docker/app.env <<'EOF'
DATABASE_URL=postgres://metasheet:change-me@127.0.0.1:5432/metasheet?sslmode=disable
JWT_SECRET=dev-secret
EOF

node -e "require('./ecosystem.config.cjs'); console.log(process.env.DATABASE_URL)"
# → postgres://metasheet:change-me@127.0.0.1:5432/metasheet?sslmode=disable
```

### Manual smoke — bootstrap-script path (unchanged contract)

```bash
# Simulate what attendance-onprem-bootstrap.sh does
DATABASE_URL=postgres://shell-value node -e "
  require('./ecosystem.config.cjs')
  console.log(process.env.DATABASE_URL)
"
# → postgres://shell-value   (shell-sourced env wins; file would NOT override)
```

### Template doc

```
git diff main -- docker/app.env.example docker/app.env.attendance-onprem.template docker/app.env.multitable-onprem.template docker/app.staging.env.example
```

Shows the inserted comment block on all four files; no functional env
values changed.

## Rollback

Both changes are inert when `docker/app.env` is missing, so rollback on
a running stack is simply:

1. `git revert` the PR commit.
2. Rebuild & restart. The previous behavior (`pm2 start` fails without
   `source`, templates silent on `sslmode`) returns.

No schema migration, no data change.
