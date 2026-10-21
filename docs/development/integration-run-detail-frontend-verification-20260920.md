# 验证：集成工作台「运行详情」前端接线 + OpenAPI 契约

日期：2026-09-20 · 设计：`docs/development/integration-run-detail-frontend-design-20260920.md`

所有命令在 worktree `metasheet-wt-w7h`（基线 `origin/main` @ `19cb18f85`，后 rebase 到 `6ea19e2de`）本机执行。

## 1. 新 spec

`pnpm --filter @metasheet/web exec vitest run IntegrationRunDetail --watch=false`

```
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

9 条 = 5 个场景（URL/租户头、渲染、空态、404、501）中三个按 zh-CN / en 各跑一遍，加值面 values-free 一条。

## 2. 邻域 spec（未回归）

`pnpm --filter @metasheet/web exec vitest run IntegrationMonitoringSection IntegrationWorkbenchView integrationWorkbench IntegrationRunDetail --watch=false --reporter=dot`

```
 Test Files  6 passed (6)
      Tests  139 passed (139)
```

首跑出现 1 条**既有**用例超时（`IntegrationWorkbenchView > loads systems, object schemas, and previews a
template payload`，`Test timed out in 5000ms`）。判定为 #4614 那一类并发假红，不是本改动：
单跑 `IntegrationWorkbenchView` → `61 passed (61)`；同一四 token 批次重跑 → `139 passed (139)`。
该用例不经过本 PR 新增的任何代码路径。

## 3. 类型检查（含假绿证伪）

| 命令 | 退出码 | 输出行数 |
| --- | --- | --- |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | 0 | 0 |
| **同上 + 故意注入类型错误** | **0** | **0** ← 假绿 |
| `pnpm --filter @metasheet/web exec vue-tsc -b` | 0 | 0 |
| **同上 + 故意注入类型错误** | **1** | **6** |
| `pnpm --filter @metasheet/web run type-check`（CI 用的那条） | 0 | 12（全是 pnpm 横幅） |

**结论：`vue-tsc --noEmit` 在本仓库是假绿，不可作为证据。** 根因：`apps/web/tsconfig.json` 是
`"files": []` + `references` 的空壳，裸 `--noEmit` 什么都不检查。证伪方法：把
`getIntegrationRun(runId, currentScope())` 改成 `getIntegrationRun(42, currentScope())`：

- `vue-tsc --noEmit` 仍然 `EXIT=0`、0 行输出；
- `vue-tsc -b` 报 `src/views/IntegrationWorkbenchView.vue(3524,41): error TS2345: Argument of type
  'number' is not assignable to parameter of type 'string'.`，`EXIT=1`。

探针已还原（`git diff` 对 `apps/web/src` 零删除行）。真实类型结论取 `vue-tsc -b` / `run type-check` 的绿。

## 4. OpenAPI

```
pnpm --filter @metasheet/openapi build     → Built OpenAPI to dist with parts: [... 'integration-runs.yml' ...]
pnpm --filter @metasheet/openapi validate  → OpenAPI security validation passed
pnpm --filter @metasheet/openapi guard:codegen → [openapi-guard] all checks passed
   content-sha256 dist/openapi.json=820725d9f253…
   content-sha256 dist-sdk/index.d.ts=91012380b7c4…
```

生成物已提交（`dist/` 三个文件 + `dist-sdk/index.d.ts`），满足 plugin-tests.yml:799-803 的
`generate:sdk` → `git diff --exit-code` 一致性守卫。

注：本机 `generate:sdk` 的第二段在 Windows 上 `spawnSync pnpm ENOENT`
（`dist-sdk/scripts/build.mjs` 用 `execFileSync('pnpm', …)`，Windows 下解析不到 `.cmd`），
因此改为按该脚本的原样参数手工执行两条同样的命令
（`pnpm exec openapi-typescript ../dist/openapi.yaml --output index.d.ts`、
`pnpm exec tsc client.ts --declaration --module NodeNext --moduleResolution NodeNext --target ES2020 --skipLibCheck`）。
这是本机平台限制，CI（Linux）上 `generate:sdk` 一条命令即可，产物一致——`guard:codegen` 对最终产物做的是
内容指纹校验（非 mtime），已全绿。

## 5. 变异探针（每条守卫都有「去掉它就红」）

全部为源码级即时变异 + 逐条还原，还原后 `git diff origin/main -- apps/web/src` 的删除行数为 **0**，
且五个锚点字符串各自 `grep -c` = 1。

| # | 变异 | 结果 |
| --- | --- | --- |
| M1 | 服务层单读 URL → `/api/integration/runs?id=<runId>`（退化成 list 形状） | **8 failed / 1 passed** |
| M2 | 去掉 `code === 'RUN_NOT_FOUND'` 分支 | **2 failed / 7 passed**（404 两个 locale） |
| M3 | 去掉 `code === 'RUN_READ_NOT_IMPLEMENTED'` 分支 | **2 failed / 7 passed**（501 两个 locale） |
| M4 | `details` 空对象不再收敛为 ''（空态失效，改成打印 `{}`） | **2 failed / 7 passed**（空态两个 locale） |
| M5 | 服务层自己拼 `x-tenant-id` 请求头 | **1 failed / 8 passed**（租户头那条） |

还原后重跑：`Tests 9 passed (9)`。

## 6. 两点登记

| 文件 | 改动 |
| --- | --- |
| `apps/web/scripts/run-required-web-tests.sh` | 保留 main 行原样，仅在 `--reporter=dot` 前追加 token `IntegrationRunDetail` + 说明注释 |
| `scripts/ops/integration-guard-run-web-specs.sh` | 同上 |

token 双向撞名检查（机械跑，脚本见 PR 描述）：在两份登记文件解析出的 **469** 个 token 中，
没有任何既有 token 是 `IntegrationRunDetail` 的子串、也没有任何 token 包含它；没有既有 token 已经
收走这个新文件；`IntegrationRunDetail` 在 `apps/web` 下恰好匹配 1 个文件。

本 PR 触及的三个 src 文件（`IntegrationMonitoringSection.vue`、`services/integration/workbench.ts`、
`views/IntegrationWorkbenchView.vue`）都是 `scripts/ops/integration-guard-guarded-paths.mjs:46,64,65`
的精确 roster 条目，所以 integration-guard 泳道必然触发。

## 7. 本机环境限制（非本改动引起）

`node --test scripts/ops/integration-guard-required-wiring-contract.test.mjs` 在本机 fail-closed：
`python3 could not be spawned for the YAML parse (spawnSync python3 ENOENT)`。
在**未改动的主检出**上跑同一条命令得到同样的错误，故为环境问题（Windows 无 `python3`），CI（Linux）不受影响。
该测试 pin 的是 workflow 里的 `run:` 文本（`bash scripts/ops/integration-guard-run-web-specs.sh`），
不是本脚本内部的 spec 清单，本 PR 未触及。
