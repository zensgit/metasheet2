# Yjs Staging Enable Workflow Verification

Date: 2026-04-21

## Scope

Verification for:

- `.github/workflows/docker-build.yml`
- `.github/workflows/yjs-staging-validation.yml`

## Static Checks

### YAML parse

Command:

```bash
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/yjs-staging-validation.yml'); YAML.load_file('.github/workflows/docker-build.yml'); puts 'yaml ok'"
```

Result:

```text
yaml ok
```

### Shell syntax

Command:

```bash
ruby -ryaml -e 'w=YAML.load_file(".github/workflows/yjs-staging-validation.yml"); w["jobs"]["validate"]["steps"].each_with_index { |s,i| next unless s["run"]; File.write("/tmp/yjs-step-#{i}.sh", s["run"]) } ; w=YAML.load_file(".github/workflows/docker-build.yml"); w["jobs"].each { |job, spec| spec["steps"].each_with_index { |s,i| next unless s["run"]; File.write("/tmp/docker-#{job}-step-#{i}.sh", s["run"]) } }'
bash -n /tmp/yjs-step-1.sh
bash -n /tmp/yjs-step-4.sh
bash -n /tmp/yjs-step-5.sh
bash -n /tmp/yjs-step-6.sh
bash -n /tmp/docker-build-step-2.sh
bash -n /tmp/docker-build-step-3.sh
bash -n /tmp/docker-deploy-step-1.sh
bash -n /tmp/docker-deploy-step-2.sh
```

Result:

```text
bash syntax ok
```

## Expected Remote Validation After Merge

The post-merge validation must prove:

- Docker build logs show `VITE_ENABLE_YJS_COLLAB: true`.
- Deploy logs show `ENABLE_YJS_COLLAB=true in docker/app.env`.
- `/api/admin/yjs/status` passes via the workflow-resolved token.
- `yjs-node-client.mjs` cold run passes.
- `yjs-node-client.mjs` warm-doc run passes.

## Current Limitation

The real remote Yjs validation is intentionally not run before this PR is merged, because:

- The validation workflow changes must exist on the default branch before manual dispatch can use them.
- The repository variables must be set before rebuilding the frontend image and reconciling backend runtime env.

## Post-Merge Token Resolver Follow-Up

Initial default-branch validation after PR #1025 proved the SSH resolver ran, but `/api/admin/yjs/status` rejected the generated token with `401 Invalid token`.

Root cause: signing from host `docker/app.env` can drift from the running backend container's actual `JWT_SECRET`.

Follow-up fix, iteration 1:

- Generate the short-lived admin JWT by running `node` inside the `backend` container.
- Read `process.env.JWT_SECRET` from the actual runtime env used by the API.
- Keep token masking and `GITHUB_ENV` propagation unchanged.

Second default-branch validation still returned `401 Invalid token`, which showed that signing with the correct runtime secret is not sufficient: production-like auth does not trust arbitrary token claims, and it validates the user/RBAC state.

Follow-up fix, iteration 2:

- Run token generation inside the backend container.
- Query the deployment database for a real active admin user.
- Sign through the app's compiled `authService.createToken()` implementation.
- Filter stdout to the JWT-shaped line before exporting `YJS_TOKEN`, so logger output cannot contaminate the token value.

Third default-branch validation advanced from `401 Invalid token` to `403 ADMIN_REQUIRED`.

Root cause: the selected user had legacy `users.role='admin'`, but `requireAdminRole()` checks the RBAC bridge table via `user_roles(role_id='admin')`.

Follow-up fix, iteration 3:

- Prefer users already present in `user_roles(role_id='admin')`.
- If only a legacy active admin user exists, insert the missing `roles('admin')` and `user_roles(user_id, 'admin')` bridge.
- Then sign the token through `authService.createToken()`.

Re-run static checks:

```text
yaml ok
bash syntax ok
git diff --check clean
```
