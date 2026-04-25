# Approval OpenAPI Contracts PR #1138 Rebase Verification

Date: 2026-04-26

## Local Verification

Worktree:

`/Users/chouhua/Downloads/Github/metasheet2/.worktrees/pr1138-clean-review-20260426`

### Conflict State

Command:

```bash
rg -n '<<<<<<<|=======' packages/openapi/src/paths/approvals.yml packages/openapi/dist/openapi.json packages/openapi/dist/openapi.yaml packages/openapi/dist/combined.openapi.yml || true
```

Result:

- no conflict markers remained after source resolution and dist regeneration.

### OpenAPI Build

Command:

```bash
node --import tsx packages/openapi/tools/build.ts
```

Result:

- passed;
- rebuilt `packages/openapi/dist/combined.openapi.yml`;
- rebuilt `packages/openapi/dist/openapi.yaml`;
- rebuilt `packages/openapi/dist/openapi.json`.

### SDK Type Generation

Command:

```bash
/Users/chouhua/Downloads/Github/metasheet2/packages/openapi/dist-sdk/node_modules/.bin/openapi-typescript \
  /Users/chouhua/Downloads/Github/metasheet2/.worktrees/pr1138-clean-review-20260426/packages/openapi/dist/openapi.yaml \
  --output /Users/chouhua/Downloads/Github/metasheet2/.worktrees/pr1138-clean-review-20260426/packages/openapi/dist-sdk/index.d.ts

/Users/chouhua/Downloads/Github/metasheet2/node_modules/.bin/tsc \
  client.ts \
  --declaration \
  --module NodeNext \
  --moduleResolution NodeNext \
  --target ES2020 \
  --skipLibCheck
```

Result:

- passed;
- regenerated `packages/openapi/dist-sdk/index.d.ts`;
- verified `packages/openapi/dist-sdk/client.ts` declaration output.

### OpenAPI Security Validation

Command:

```bash
node --import tsx packages/openapi/tools/validate.ts packages/openapi/dist/openapi.yaml
```

Result:

- passed;
- output: `OpenAPI security validation passed`.

### SDK Tests

Command:

```bash
/Users/chouhua/Downloads/Github/metasheet2/node_modules/.bin/vitest run \
  tests/approval-paths.test.ts \
  tests/plm-workbench-paths.test.ts \
  tests/client.test.ts \
  --reporter=dot
```

Run from:

`packages/openapi/dist-sdk`

Result:

- 3 test files passed;
- 19 tests passed.

## Pending Remote Verification

After #1138 is pushed, GitHub CI must rerun the repository checks. Because this PR changes generated OpenAPI artifacts and SDK declarations, the important gates are:

- contracts checks;
- SDK/client tests;
- Node 18/20 matrix;
- coverage and PR validation gates.
