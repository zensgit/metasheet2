# PLM Workbench SDK Runtime Client Verification

## Scope

Verified the new `plm-workbench` runtime SDK surface and the Web client migration onto it.

## Focused checks

### dist-sdk

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk && pnpm build
```

Expectation:

- `client.js` / `client.d.ts` regenerate with `createPlmWorkbenchClient(...)`
- `index.d.ts` remains aligned with source OpenAPI

Result:

- Passed

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk && pnpm exec vitest run tests/client.test.ts tests/plm-workbench-paths.test.ts
```

Expectation:

- direct `plm-workbench` helper paths/methods/bodies are correct
- `batch.metadata` is preserved
- generated path typings still expose the `plm-workbench` route family

Result:

- Passed

### Web client

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plmWorkbenchClient.spec.ts
```

Expectation:

- all existing collaborative team-view/team-preset request contracts still pass
- batch results now preserve `metadata`

Result:

- Passed

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench && pnpm --filter @metasheet/web type-check
```

Expectation:

- SDK helper exports resolve cleanly from `@metasheet/sdk/client`
- Web migration keeps strict typing intact

Result:

- Passed

## Regression sweep

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expectation:

- no regressions across PLM workbench, audit, approvals, team view, and team preset flows

Result:

- Passed

## Conclusion

The `plm-workbench` collaborative route family is now exposed through a real runtime SDK client, consumed by the Web collaborative client, and verified end-to-end with preserved batch metadata and unchanged front-end normalization behavior.
