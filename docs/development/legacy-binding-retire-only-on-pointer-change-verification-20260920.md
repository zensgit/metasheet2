# 验证记录：legacy 绑定退役只在「生效指针变化」时触发

- 日期：2026-09-20（本机时钟 01:31，+08:00）
- 分支：`fix/legacy-binding-retire-only-on-pointer-change`
- 基线：`origin/main` = `0708051caeee1ba6c2a69487eb6359e547b7c33d`
- 设计文档：`docs/development/legacy-binding-retire-only-on-pointer-change-design-20260920.md`
- 本机：Windows，`core.autocrlf=true`（见 §5 的一条既有本机假红）

## 1. 改动面

| 文件 | 改了什么 |
| --- | --- |
| `plugins/plugin-integration-core/lib/external-systems.cjs` | 新增纯函数 `effectiveLegacyBindingPointer`（:685）；退役判据加一条「请求连接 `!==` 生效指针」（:773-779） |
| `plugins/plugin-integration-core/__tests__/legacy-binding-canonical-invariant.test.cjs` | 新增第 9–13 组，原 8 组一字未改 |
| `docs/development/legacy-binding-canonical-invariant-design-20260916.md` | 追加 §10 |
| `docs/development/legacy-binding-retire-only-on-pointer-change-design-20260920.md` | 新建 |

`test-chain.txt` 未改（该测试早在第 40 行登记）。
`lib/sealed-export/vectors/s6a-package-provenance-pins.json` 未改：其
`runtimeFiles` 键只有
`pluginPackageJson / pnpmLock / pluginIndex / pluginHttpRoutes / testChainRunner /
s6aProvisioningCli / s6aAcceptanceRunner / s6aOnpremRunbook / multitableOnpremPackageVerify`，
`external-systems` 出现次数 = 0，本 PR 不触碰任何被 pin 的文件。

## 2. 本机跑过的命令与结果

在 `plugins/plugin-integration-core` 下逐个 `node __tests__/<name>.test.cjs`：

| 用例 | 结果 |
| --- | --- |
| `legacy-binding-canonical-invariant.test.cjs`（13 组，原 8 + 新 5） | PASS |
| `external-systems.test.cjs` | PASS |
| `external-systems-list-workspace-fallback.test.cjs` | PASS |
| `connection-resolver.test.cjs` | PASS |
| `http-routes.test.cjs` | PASS |
| `integration-connection-binding-migration.test.cjs` | PASS |
| `pr1-canonical-legacy-read-equivalence.test.cjs` | PASS |
| `sealed-export-package-provenance.test.cjs`（逐文件 sha256 比对冻结清单） | PASS |

选用例的依据：全仓 `__tests__` 里提及 `legacy_connection_fallback_eligible` /
`legacyConnectionFallbackEligible` 的文件共 6 个，上表覆盖其全部，另加 provenance pin 用例。

## 3. 新增的 5 组断言

| 组 | 内容 |
| --- | --- |
| 9 | 纯改名保存（`connectionId` = 本行当前连接）→ 标记保持 TRUE、`config.dataSourceId` 保留；带 `config` 与不带 `config` 两种 payload 都测 |
| 10 | 迁移形状（`connection_id` 已写 + 标记 TRUE）同指针保存 → 不退役；含「canonical 已写、legacy 指针已空」的子例，专门钉住「canonical 优先」的读法 |
| 11 | 回归：`ds-1 → ds-2` 仍退役 + 仍丢 legacy 指针，legacy 形状与迁移形状各一例 |
| 12 | 僵尸行防护：只带 `connectionId`、不带 `config` 的移指针 → `CONNECTION_BINDING_MISMATCH`，零写入，两种形状各一例 |
| 13 | 现状确认：`connectionId: null` 与 `''` 在既有行上照旧被拒，标记与指针不动（`config.dataSourceId: null` 的允许清空由原第 5 组继续钉） |

## 4. 变异自证（全部内存级）

工具：`<scratchpad>/w7f/w7f-mutate.cjs` —— 从磁盘读源码、在内存里改一处、
用 `new Module()._compile` 编译后塞进 `require.cache`，再 `require` 测试文件。
**不落盘改任何仓库文件**（并行代理共用同一对象库）。每次都以退出码 1 结束。

| 变异 | 改了什么 | 结果 |
| --- | --- | --- |
| m1 | 删掉 `&& normalized.connectionId !== effectiveLegacyBindingPointer(existing)`（回到 #5783 的「非空即退役」） | 红于第 9 组 `testSamePointerSaveDoesNotRetireTheMarker`（`legacy_connection_fallback_eligible` false !== true） |
| m2 | `effectiveLegacyBindingPointer` 去掉 `connection_id` 优先，只读 `config.dataSourceId` | 红于第 10 组 `testMigratedRowSamePointerSaveDoesNotRetireTheMarker` |
| m3 | 退役判据恒 false | 红于第 3 组 `testRepointWithConnectionIdConvertsToCanonical`（真变指针必须退役的回归） |
| m4 | 指针删除改成无条件执行（忽略标记） | 红于第 9 组「回滚凭证必须留存」那条断言 |
| m5 | `connectionId: null` 由拒绝改成清空 canonical 列 | 红于第 13 组 |

未变异即跑，13 组全绿。

## 5. 一条**既有**本机假红（与本 PR 无关，未修）

`node __tests__/sealed-export-s4-generation-migration.test.cjs` 在本机红：

```
vitest.config.ts must exclude tests/integration/sealed-export-s4-generation-kernel-realdb.test.ts
  from no-DB jobs   (at __tests__/sealed-export-s4-generation-migration.test.cjs:302)
```

实证根因 = 本机 `core.autocrlf=true` 的 CRLF 检出，与本 PR 的改动无关：

- `packages/core-backend/vitest.config.ts:58` 确实有该条目，且本 PR 对该文件零 diff
  （`git diff origin/main -- packages/core-backend/vitest.config.ts` 为空）；
- `scripts/ops/ci-realdb-step-contract.mjs:684` 的 `extractTestExcludeArrayBody` /
  `quotedExcludeEntries` 对 CRLF 敏感：同一份内容按原样（CRLF）解析得 462 条且
  `isQuotedInTestExclude` 返回 `false`；把 `\r\n` 归一成 `\n` 后得 400 条且返回 `true`。

CI 在 LF 检出上跑，故此项由 CI 裁判；本文档只记录，不在本 PR 修。

## 6. 其它检查

- `git diff --cached | grep -P '\x08'` → 无匹配（Edit 工具退格字节扫描）。
- values-free：diff 内只有既有合成夹具（`ds-1`/`ds-2`/`tenant_1`/`owner_1`），
  无主机、IP、口令、appKey、真实租户 id、客户数据样本。
- 未跑 `pnpm --filter @metasheet/core-backend exec tsc --noEmit`：本 PR 对
  `packages/core-backend` 零改动，改动全在插件的 CJS 运行时与其 `__tests__`。
