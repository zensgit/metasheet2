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

