# 验证 — GET /api/integration/runs OpenAPI 契约

日期：2026-09-20

## 契约来源

`plugins/plugin-integration-core/lib/http-routes.cjs:9910-9919`（`runsList` 处理器），
交叉核对 `plugins/plugin-integration-core/lib/pipelines.cjs:699-718`
（`listPipelineRuns` 注册表实现）与既有测试
`plugins/plugin-integration-core/__tests__/http-routes.test.cjs:3245-3264`
（实读确认响应形状与 registry 收到的参数键集合）。详细逐条对照见同目录的
`-design-20260920.md`。

## 执行的命令与结果

```
cd packages/openapi
pnpm install --filter @metasheet/openapi...      # 首次装依赖（worktree 无 node_modules）
pnpm install --filter @metasheet/sdk...           # dist-sdk 也是独立 workspace 包
pnpm run build      # OK，合并出 dist/{combined.openapi.yml,openapi.json,openapi.yaml}
pnpm run validate   # "OpenAPI security validation passed"
cd dist-sdk
pnpm exec openapi-typescript ../dist/openapi.yaml --output index.d.ts   # 502ms 成功
pnpm exec tsc client.ts --declaration --module NodeNext --moduleResolution NodeNext \
  --target ES2020 --skipLibCheck                                       # 无输出=成功
cd ..
pnpm run guard:codegen   # "[openapi-guard] all checks passed"
```

（按硬边界第 8 条，手动两步跑 SDK 生成，绕开 Windows 上 `dist-sdk/scripts/build.mjs`
`execFileSync('pnpm')` 的 ENOENT。）

`guard:codegen` 完整通过项：source needles / record-link-options / department
directory / FormField 判别联合 / RecordLinkFieldProps 模式 / SDK 类型覆盖 / 包名
校验，以及两个内容哈希（`content-sha256 dist/openapi.json=3f70059105c6…`、
`content-sha256 dist-sdk/index.d.ts=6eb21b11ec51…`）——全部 OK。

## dist 与源码一致性核验（硬边界第 8 条）

重新跑一遍 `pnpm run build` 后：

```
git diff --stat -- packages/openapi/dist-sdk/
 packages/openapi/dist-sdk/index.d.ts | 67 ++++++++++++++++++++++++++++++++++++
 1 file changed, 67 insertions(+)
```

`client.js`/`client.d.ts` 在 git status 里显示 `M` 但内容 diff 为空——只是 Windows
CRLF/LF 触碰导致的元数据变化，不是真实内容变更（用 `git diff --stat` 确认零行改动）。
`dist/{combined.openapi.yml,openapi.json,openapi.yaml}` 的 diff 只含新增的
`/api/integration/runs` 路径块，与 `src/paths/integration-runs.yml` 的源改动逐字对应。

提交后跑：

```
git diff --exit-code -- packages/openapi/dist packages/openapi/dist-sdk/index.d.ts
```

为空（exit 0）——dist 与 dist-sdk 已随提交同步，不存在"改了 src 忘记重生成 dist"的漂移。

## 反斜杠/控制字符扫描（硬边界第 6 条）

```
git diff origin/main -- packages/openapi | grep -P '\x08'
```

0 处命中。

## 前端

未改动 `apps/web` 任何文件（见 design 文档"改动"一节的说明：
`workbench.ts` 的手写 `IntegrationPipelineRun` 接口已经与契约字段一致，且该文件所有
integration 导出统一走手写接口、不 import 生成 SDK 类型，为一个函数单独切换会破坏文件内
一致性、超出本任务范围）。因此本次不需要跑 `vue-tsc -b`；`apps/web` 目录树本身零变更。

## 测试

未新增/修改任何 `.test.cjs`/`.spec.ts`——纯 OpenAPI 契约 + 生成产物补齐，零后端行为
变更。已有的 `http-routes.test.cjs:3245-3264` 早已实读覆盖了这条路由的真实响应形状，
本次契约的字段、错误码均以该测试与其对应的处理器/注册表源码为准编写（design 文档给了
逐条 path:line）。`pnpm run validate` + `pnpm run guard:codegen` 是 `packages/openapi`
包自身的契约正确性测试，均已跑绿（见上）。

## 残余

- 未对 `apps/web` 做改动或验证（判定为不适用，见上）。
- 未验证 GitHub Actions CI 上 `guard:codegen`/`validate` 是否有额外步骤本地未复现
  （本地跑的是仓库脚本本身，逻辑应一致）。
