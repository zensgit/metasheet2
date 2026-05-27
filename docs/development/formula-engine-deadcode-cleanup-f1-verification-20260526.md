# 网格 A1 引擎死依赖图代码清理（F1）—— 验证

> Date: 2026-05-26 · Branch: `runtime/formula-engine-deadcode-f1-20260526`（切自 `origin/main` 516176619）
> 关联: Track F / `docs/development/multitable-derived-field-borrow-plan-20260526.md` F1
> 范围: **仅删 `formula/engine.ts` 零生产调用的死代码**；不动 `MultitableFormulaEngine`；不做 AST 缓存/环检测/函数重构。K3 PoC Stage-1 锁内允许的内核打磨。

## 1. 为什么

OSS 对标（`multitable-vs-teable-hyperformula-comparison-20260526.md` §"HyperFormula"）确认：网格 A1 引擎 `formula/engine.ts` 的依赖图机器是**死代码**——`buildDependencyGraph()`/`topologicalSort()`/`calculationOrder`/`dependencyGraph` 没有任何生产调用方，唯一命中是一条只测内部状态的单测。把它留在代码里会让人误以为这套依赖图在生产链路生效（实际不然——网格公式按 `calculate()` 即时求值，依赖图从不参与）。

## 2. 死代码核实（删前全仓 grep）

| 符号 | 调用情况 | 结论 |
|---|---|---|
| `buildDependencyGraph(sheetId)` (`engine.ts`) | **唯一调用方 = `tests/unit/formula-engine.test.ts` 的 `'Build dependency graph'` 测试**；`src/` 内零调用 | 死 |
| `topologicalSort()` | 仅被 `buildDependencyGraph` 内部调用 | 死 |
| `calculationOrder` 字段 | 仅在 `buildDependencyGraph` 内被**写**（`= this.topologicalSort()`），**无任何读取** | 死（write-only） |
| `dependencyGraph: Map` 字段（`engine.ts`） | 仅在上述两方法内用 | 死 |

**明确不相关、未触碰**（同名但不同物）：
- `PluginRegistry.ts` 的 `dependencyGraph` / `rebuildDependencyGraph()` —— 插件依赖图，另一个类，生产在用。
- `packages/openapi/dist-sdk` 的 `MultitableDependencyGraph` —— 生成的 SDK schema，与网格引擎无关。

## 3. 改动

- `packages/core-backend/src/formula/engine.ts`：删 `calculationOrder` + `dependencyGraph` 两个私有字段；删 `buildDependencyGraph()` + `topologicalSort()` 两个方法（含其 doc 注释）。其余（`db`/`functions`/`calculate()`/内置函数等）不动。
- `packages/core-backend/tests/unit/formula-engine.test.ts`：删只覆盖死代码的 `describe('Dependency Graph')` 块（其内仅一条 `'Build dependency graph'` 测试，注释自承"tests internal state… in a real implementation you'd expose methods"）。`TEST_IDS.SHEET_1` 仍被其它用例使用，保留。

净 **−82 行，纯删除**，无行为变化。

## 4. 验证

- `tsc --noEmit`：绿。
- `pnpm build`（core-backend `tsc`）：绿。
- `eslint src/formula/engine.ts`：0 error。
- 指定单测 `formula-engine.test.ts` + `multitable-formula-engine.test.ts`：**129 passed (2 files)**。
- 全后端单元套件：**3229 passed / 86 skipped**（= A2-defense 后 3230 − 删掉的 1 条死代码测试），零回归。

## 5. K3 / OSS 合规
- 仅删网格 A1 引擎死代码；不动 `MultitableFormulaEngine`、不动 integration-core/K3/RBAC/auth/存储。
- 未引入任何 OSS 代码。无 migration。
