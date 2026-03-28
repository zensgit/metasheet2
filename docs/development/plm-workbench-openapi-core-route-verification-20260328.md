# PLM Workbench OpenAPI core route verification

## Scope

- `packages/openapi/src/paths/plm-workbench.yml`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist-sdk/index.d.ts`
- `packages/openapi/dist-sdk/tests/plm-workbench-paths.test.ts`

## Checks

1. Source OpenAPI now includes the core `plm-workbench` team view/team preset route family.
2. `openapi build` pushes those path keys into dist artifacts.
3. `dist-sdk build` regenerates `index.d.ts` with matching `paths[...]` entries.
4. `plm-workbench-paths.test.ts` compile-time locks those keys so future build regressions会直接暴露。

## Validation commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm exec tsx packages/openapi/tools/build.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk
pnpm build
pnpm exec vitest run tests/client.test.ts tests/plm-workbench-paths.test.ts
```
