# PLM Workbench Clear Default OpenAPI Parity Verification

## Scope

Verify that generated OpenAPI/SDK artifacts expose `clear default` on `/default` and no longer on `/restore`.

## Coverage

- Added type assertions in `packages/openapi/dist-sdk/tests/plm-workbench-paths.test.ts`:
  - `paths['/api/plm-workbench/views/team/{id}/default']['delete']` is not `never`
  - `paths['/api/plm-workbench/views/team/{id}/restore']['delete']` is `never`
  - same assertions for `filter-presets/team/{id}`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm exec tsx packages/openapi/tools/build.ts
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk && pnpm build
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk && pnpm exec vitest run tests/client.test.ts tests/plm-workbench-paths.test.ts
```

## Result

- OpenAPI build: pass
- `dist-sdk` build: pass
- `dist-sdk` focused tests: pass
