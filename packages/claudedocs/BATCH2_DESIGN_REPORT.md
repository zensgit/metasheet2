# Batch 2 设计报告 — Telemetry 插件与 Cache Phase 1 本地验证与测试稳定化

日期: 2025-11-04
状态: 已完成本地验证；最小化代码改动已就绪以提交 PR

## 1. 背景与目标

Batch 2 已合并的两项交付物：
- PR #357: plugin-telemetry-otel（OpenTelemetry 插件，默认关闭 FEATURE_OTEL=false）
- PR #358: Cache Phase 1（Registry + NullCache，可观测性优先，默认 NullCache）

本报告目标：
- 核实插件/缓存实现与文档一致性（端点、开关、默认行为）
- 修复/稳定本地测试运行（Vitest + Vite 的 ESM/SSR 兼容问题）
- 提供可复用的“最小化”测试脚本与本地验证路径

## 2. 变更范围（最小化）

本次只做测试与包脚本层面的“非功能性”调整，不改变运行时逻辑：

1) Telemetry 插件测试稳定化
- 新增 CJS 构建产物，测试侧改为引用 CJS，避免 `__vite_ssr_exportName__` 运行时报错（Vitest SSR Helper）。
  - 变更: `metasheet-v2/plugins/plugin-telemetry-otel/vite.config.ts`（构建 formats: ['es','cjs']）
  - 变更: `metasheet-v2/plugins/plugin-telemetry-otel/tests/smoke.test.ts`（从 `../dist/index.cjs` 导入）
- 为 Vitest 增加最小配置，指定 Node 环境，降低 SSR/依赖内联风险。
  - 新增: `metasheet-v2/plugins/plugin-telemetry-otel/vitest.config.ts`
- 增加本地冒烟脚本，便于快速验证端点注册与 Prometheus 输出。
  - 变更: `metasheet-v2/plugins/plugin-telemetry-otel/package.json`（新增 `smoke:local`；`test` 先构建再测）

2) Core Backend Cache 测试聚焦
- 新增 cache 测试专用 Vitest 配置，强制 Node 环境/禁用线程，聚焦 `src/cache/__tests__`。
  - 新增: `metasheet-v2/packages/core-backend/vitest.cache.config.ts`
- 新增专用构建配置与脚本，仅编译缓存模块与类型，避免与主包其他子系统的类型/依赖冲突：
  - 新增: `metasheet-v2/packages/core-backend/tsconfig.cache.tests.json`
  - 新增: `metasheet-v2/packages/core-backend/package.json` 脚本 `build:cache`
- 缓存用例支持按需从构建产物导入，避免 Vitest 在 TS 源上注入 SSR helpers：
  - `TEST_USE_DIST=true vitest --config vitest.cache.config.ts run`
- 新增 npm 脚本以只运行 Cache Phase 1 的单测：
  - 变更: `metasheet-v2/packages/core-backend/package.json`（新增/更新 `test:cache`）

注意：上述改动均为测试与构建配置，不更改业务逻辑与运行接口。

## 3. 一致性与功能核实

- Telemetry 插件端点：
  - 代码注册 `/metrics` 与 `/metrics/otel`（FEATURE_OTEL=true 时）：
    - `plugins/plugin-telemetry-otel/src/index.ts:41` 和 `:57`
  - 文档与总结一致：
    - `packages/claudedocs/BATCH2_MERGE_SUMMARY.md:69, 190, 250`
    - `plugins/plugin-telemetry-otel/README.md:90-97`
    - `claudedocs/PHASE2_PREPARATION_GUIDE.md:73`
- Cache Phase 1 默认 NullCache，安全可部署：
  - `packages/core-backend/src/cache/index.ts:34-35`
  - `packages/core-backend/src/cache/implementations/null-cache.ts:13`
  - `packages/core-backend/src/cache/registry.ts:17`

## 4. 本地验证结果

Telemetry 插件
- 构建 + 本地冒烟：
  - `cd metasheet-v2/plugins/plugin-telemetry-otel`
  - `npm run build`
  - `npm run smoke:local` → 输出包含 routes ["/metrics", "/metrics/otel"] 与 Prometheus 预览
- 单测（已稳定）：
  - `npx vitest run --reporter=dot` → 9 个测试全部通过

Cache Phase 1（单测聚焦）
- 本环境存在 Vite 启动 dev server 的权限限制（EPERM），因此提供“聚焦 cache 的 Node 环境”配置以便在本地/CI 运行：
  - `cd metasheet-v2/packages/core-backend`
  - `npm run test:cache`
  - 注：在当前沙箱环境仍可能受限（EPERM），建议在本地/CI（有完整网络与端口权限）运行。

## 5. 风险评估与回滚

- 风险等级：低（仅测试与构建脚本层面）
- 回滚策略：
  - 直接撤销以下文件变更或 PR revert：
    - `plugins/plugin-telemetry-otel/vite.config.ts`
    - `plugins/plugin-telemetry-otel/tests/smoke.test.ts`
    - `plugins/plugin-telemetry-otel/vitest.config.ts`
    - `plugins/plugin-telemetry-otel/package.json`
    - `packages/core-backend/vitest.cache.config.ts`
    - `packages/core-backend/package.json`

## 6. CI 与发布建议

- 建议在 Telemetry 插件包中加入一个轻量 CI 任务：
  - `npm run build` + `npm run smoke:local` + `vitest run`（dot 报告器）
- 若需要对 cache 做持续验证：
  - 在核心仓库 CI 中新增 `npm run test:cache` job（Node 环境、非浏览器、禁线程）
- 所有改动默认不开启功能（FEATURE_OTEL=false，缓存默认 NullCache），对生产零影响。

## 7. 后续工作（Phase 2 前）

- 若需要彻底避免 `/metrics` 命名冲突，可在后续 PR 中将插件端点主推 `/metrics/otel`（目前已提供 alias，文档也推荐此路径）。
- 在开发/测试环境开启 `FEATURE_OTEL=true` 做端到端观察验证；稳定后再推广。
- 适度补充：
  - Telemetry 插件重复加载/卸载的内存友好性测试
  - Cache Registry 并发操作与指标采集一致性测试

## 8. 提交与合并建议

- PR 标题：
  - `chore(test): stabilize telemetry plugin tests and add focused cache test runner`
- 提交说明（摘要）：
  - Add CJS build for telemetry plugin and import CJS in tests to avoid SSR helper runtime
  - Add vitest config (node env) and smoke:local script
  - Add core-backend vitest cache config and test:cache script
  - No runtime behavior changes; docs already aligned

## 9. 验证清单（Checklist）

- [x] Telemetry 插件本地冒烟通过（/metrics 与 /metrics/otel）
- [x] Telemetry 插件单测通过（9/9）
- [x] 文档与实现一致（Summary/README/Phase2 Guide）
- [x] Cache Phase 1 文件完整，默认 NullCache
- [x] 提供 cache 聚焦的测试脚本与配置

—— 以上为 Batch 2 的测试稳定化与本地验证设计报告 ——
