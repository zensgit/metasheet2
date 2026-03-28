# PLM Workbench OpenAPI mutation route verification

## Scope

- `packages/openapi/src/paths/plm-workbench.yml`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist-sdk/index.d.ts`
- `packages/openapi/dist-sdk/tests/plm-workbench-paths.test.ts`

## Checks

1. source OpenAPI now includes duplicate/transfer/archive/restore for both team view and team preset。
2. `openapi build` 将这些 path 推进到 dist artifacts。
3. `dist-sdk build` 生成的 `paths[...]` 类型包含这 8 组 route。
4. `plm-workbench-paths.test.ts` 会在未来 contract 回退时直接失败。

## Validation commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm exec tsx packages/openapi/tools/build.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk
pnpm build
pnpm exec vitest run tests/client.test.ts tests/plm-workbench-paths.test.ts
```
