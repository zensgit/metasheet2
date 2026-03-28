# PLM Workbench Audit SDK Contract Verification

## Scope

验证 `plm-workbench` collaborative audit JSON route 已经打通：

- source OpenAPI
- dist OpenAPI
- dist-sdk runtime client
- Web collaborative audit client

不包含 `export.csv` 下载链。

## Focused checks

### OpenAPI build

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench && pnpm exec tsx packages/openapi/tools/build.ts
```

Expectation:

- `plm-workbench` source OpenAPI 能成功生成
- `audit-logs` / `audit-logs/summary` 进入 dist OpenAPI

Result:

- Passed

### dist-sdk

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk && pnpm build
```

Expectation:

- `client.js` / `client.d.ts` 生成新的 audit helper
- `index.d.ts` 包含新增 audit paths

Result:

- Passed

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk && pnpm exec vitest run tests/client.test.ts tests/plm-workbench-paths.test.ts
```

Expectation:

- audit helper 生成正确 query path
- `plm-workbench` path typings 暴露 audit routes

Result:

- Passed (`2` files / `12` tests)

### Web client

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plmWorkbenchClient.spec.ts
```

Expectation:

- Web audit list/summary helper 通过 SDK runtime client 正常工作
- 现有 team view / team preset contract 无回归

Result:

- Passed (`1` file / `23` tests)

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench && pnpm --filter @metasheet/web type-check
```

Expectation:

- `@metasheet/sdk/client` 导出的新 audit helper 被 Web 正确解析

Result:

- Passed

## Regression sweep

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expectation:

- PLM workbench / audit / approvals / team view / team preset 回归无新增破坏

Result:

- Passed

## Conclusion

`plm-workbench` 的 collaborative audit JSON route 现在已经与 source OpenAPI、dist SDK runtime、Web client 对齐成单一 contract；本轮 focused 与 PLM 前端回归均通过，剩余未纳入 SDK 的只有 CSV 导出这条非 JSON transport。
