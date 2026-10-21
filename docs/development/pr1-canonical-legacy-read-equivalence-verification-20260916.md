# PR-1 canonical/legacy 读取路径等价性钉桩测试 — 验证（2026-09-16）

设计文档：`docs/development/pr1-canonical-legacy-read-equivalence-design-20260916.md`

- worktree：`../metasheet-wt-w5m`（独立于主检出）
- 分支：`test/pr1-canonical-legacy-read-equivalence`
- 起点：`origin/main` = `38caaf17bfc8eeca23e23f6dfe796683d35ab525`
- `git status --short` 在新增测试前后除新文件外无其他改动（`git diff --stat` 对
  `plugins/plugin-integration-core/lib/connection-resolver.cjs` 全程为空）。

## 1. 单文件运行

```
$ node __tests__/pr1-canonical-legacy-read-equivalence.test.cjs
✓ pr1-canonical-legacy-read-equivalence tests passed
```

```
$ node --test __tests__/pr1-canonical-legacy-read-equivalence.test.cjs
✓ pr1-canonical-legacy-read-equivalence tests passed
✔ __tests__\pr1-canonical-legacy-read-equivalence.test.cjs (97.8378ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

用例数：单个 `main()` 内含 3 个断言组（canonical/legacy 等价、三条只读调用等价、反向控制），共
约 20 条 `assert.*` 调用，全部通过。

## 2. 相邻测试回归

```
$ node --test __tests__/connection-resolver.test.cjs __tests__/external-systems.test.cjs \
    __tests__/external-systems-list-workspace-fallback.test.cjs \
    __tests__/integration-connection-binding-migration.test.cjs
✓ connection-resolver policy tests passed
✓ external-systems: list non-null workspace hint fallback tests passed
✓ external-systems: registry + credential boundary tests passed
integration-connection-binding-migration.test.cjs OK
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

零源码改动，四个既有套件保持原样通过——证明新测试没有依赖任何未提交的源码调整。

## 3. 变异验证（mutation kill）

按任务要求，变异只在内存/临时副本进行，**未提交、也未触碰 worktree 内的
`connection-resolver.cjs`**（`git status`/`git diff --stat` 全程干净，见上）。

步骤：
1. 把 worktree 内 `plugins/plugin-integration-core/lib/connection-resolver.cjs`（自包含、零
   `require`）复制到 scratchpad 两份：`connection-resolver.original.cjs` 与
   `connection-resolver.mutated.cjs`。
2. 只对 mutated 副本的第 266 行（`resolveLegacy` 的返回语句）做变异：
   ```diff
   -    return { binding: adapterBinding(binding, registrationId), registration }
   +    return { binding: adapterBinding(binding, 'MUTATED_WRONG_CONNECTION_ID'), registration }
   ```
   （第 202 行 `resolveCanonical` 里同名的返回语句未改动，只改 legacy 分支。）
3. 用 scratchpad 里的独立脚本 `mutation-check.cjs`（复用与新测试第 1 节相同的 canonical/legacy
   夹具形状：同一个 `ds_alpha` 连接，一条 canonical 行、一条 legacy 行，同一个 context）分别指向
   mutated 副本与 original 副本跑一遍 `resolve()` 并比较 `config.dataSourceId`/`config`。

结果：

```
=== MUTATED (expect FAIL) ===
FAIL: .../connection-resolver.mutated.cjs
Expected values to be strictly equal:
+ actual - expected
+ 'MUTATED_WRONG_CONNECTION_ID'
- 'ds_alpha'
exit=1

=== ORIGINAL COPY (expect OK) ===
OK: .../connection-resolver.original.cjs
exit=0
```

结论：legacy 分支被改坏后，等价性断言（`canonical.config.dataSourceId === legacy.config.dataSourceId`
以及 `deepEqual(canonical.config, legacy.config)`）立即红；还原后立即绿。证明新测试文件里对应的
断言不是空转——它们确实在检测 canonical/legacy 两条路径是否解析到同一个连接。

变异之后 worktree 的实际提交文件未被触碰：

```
$ git status --short
?? plugins/plugin-integration-core/__tests__/pr1-canonical-legacy-read-equivalence.test.cjs
   plugins/plugin-integration-core/test-chain.txt   (已加一行，见下)
?? docs/development/pr1-canonical-legacy-read-equivalence-design-20260916.md
?? docs/development/pr1-canonical-legacy-read-equivalence-verification-20260916.md
```

## 4. test-chain.txt

`plugins/plugin-integration-core/__tests__/connection-resolver.test.cjs` 一行之后新增：

```
node __tests__/pr1-canonical-legacy-read-equivalence.test.cjs
```

`pnpm install --frozen-lockfile`（`export https_proxy=http://127.0.0.1:10808 http_proxy=http://127.0.0.1:10808`）
在该 worktree 成功完成（`Done in 49.9s using pnpm v9.15.9`）。

```
$ node scripts/test-chain.cjs
...
✓ connection-resolver policy tests passed
✓ pr1-canonical-legacy-read-equivalence tests passed
...
AssertionError [ERR_ASSERTION]: vitest.config.ts must structurally exclude
  tests/integration/sealed-export-s3-private-ingestion-realdb.test.ts from the no-DB job
    at assertRealDbProofWiring (__tests__/sealed-export-s3-private-ingestion-migration.test.cjs:190:10)
test-chain: `node __tests__/sealed-export-s3-private-ingestion-migration.test.cjs` exited 1 — stopping the chain
```

**本机整链红，CI 为裁判**：新测试本身（以及它前面全部约 90+ 个既有套件，含
`connection-resolver.test.cjs`）在链中原样跑过并打印通过；链在数十个套件之后停在
`sealed-export-s3-private-ingestion-migration.test.cjs`，该用例断言
`packages/core-backend/vitest.config.ts` 是否按预期排除一个 realdb 测试文件——与本任务的
resolver/external-systems/adapter 改动无关，本任务未触碰 `vitest.config.ts`、
`scripts/ops/ci-realdb-step-contract.mjs`、`package.json` 中任何一个文件。判定为本机 workspace/
环境相关的既有红，不代表新增测试有问题；只保证「单文件绿 + 新测试在链中原位通过」。

## 5. 未做事项

- 未验证 `sealed-export-s3-private-ingestion-migration.test.cjs` 的本机红是否也出现在 CI 或主
  worktree 的 `origin/main`——未在本任务范围内诊断/修复它（零源码改动边界，且该红点与 PR-1 双读
  等价性无关）。
- 未验证除 `node --test`/`node scripts/test-chain.cjs` 之外的 CI 专用运行方式（如 GitHub Actions
  workflow 的具体 job 矩阵）。
- 按 pin 规则：本任务未改动 `plugins/plugin-integration-core/index.cjs`、`lib/http-routes.cjs`、
  `lib/sealed-export/*`、`package.json`、`.github/workflows/plugin-tests.yml`，因此未触发
  `computePackageProvenancePinSet` 重算，也未改动 66 项 pin。
