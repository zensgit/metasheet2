# 集成层 G4 结构化强制 — M2 实施记录（2026-09-10）

> 一句话：把「adapter 加载点是否读解密访问器」从**每个调用点自己记得**变成**装配时的硬依赖 + 结构上唯一可表达的写法**。本 PR 只交付 M2；M1（resolver 实例身份）与 M3（通信面拒绝）不在内。

- 设计：`docs/development/integration-g4-structural-enforcement-design-20260908.md`（§2 I2、§3 M2、§4 M2-a/M2-b、§5 序 1、§7）。
- 基线：`origin/main@1e6e138af`（2026-09-09）。本文行号为该基线上本 PR 落盘后的实际行号。
- 分支名 `feat/integration-g4-structural-enforcement-m1` 里的 `m1` 是**历史命名**，在选定实施顺序之前建的；本 PR 的内容是 **M2**，与设计 §5 的「序 1 = M2 去回退」一致，不需要任何前置刀。
- 性质：实施记录，values-free。核验记录另见
  `docs/development/integration-g4-structural-enforcement-m2-verification-20260910.md`。

## 1. 交付了 M2 的哪些

设计 §3 M2 列了三件事，三件都做了：

| 设计条目 | 状态 | 代码位置 |
|---|---|---|
| 路由 `requireService` 增加 `getExternalSystemForAdapter` | 已做 | `plugins/plugin-integration-core/lib/http-routes.cjs:3504` |
| 13 处三元回退改直接调用 | 已做（13/13） | `http-routes.cjs:4086, 4472, 4776, 4816, 4855, 5003, 5148, 5246, 5269, 5468, 5613, 6601, 9473` |
| 2 处 C6 target 条件重载只移除方法存在性条件 | 已做（2/2），peek→kind→reload 次序与种类限制原样保留 | `http-routes.cjs:5488-5493`（dry-run）、`5584+5621-5625`（apply） |
| runner 独立依赖检查增加该方法 | 已做 | `lib/pipeline-runner.cjs:344` |
| runner 删除公共投影回退，覆盖源 / 目标 / replay | 已做 | `lib/pipeline-runner.cjs:385-387`（唯一函数体）；三处消费点 `:419`（源）、`:426`（目标）、`:1286`（dead-letter replay 的 target kind 判定） |
| 不新增 `PUBLIC_PROJECTION` 品牌 | 未新增 | — |

13 处调用点的归属（用于核验表里的变异序号）：

| 序 | 行 | 所在处理器 |
|---|---|---|
| 1 | 4086 | `loadStockPreparationReadonlySource` |
| 2 | 4472 | `loadTableActionSourceAdapter` |
| 3 | 4776 | `externalSystemsTest` |
| 4 | 4816 | `externalSystemReadSmoke` |
| 5 | 4855 | `externalSystemReadSourceProbe` |
| 6 | 5003 | `readSourceConfigsRead` |
| 7 | 5148 | `readSourceCompositionsRun` |
| 8 | 5246 | `externalSystemObjects` |
| 9 | 5269 | `externalSystemSchema` |
| 10 | 5468 | `pipelinesExternalWriteDryRun`（C6 source） |
| 11 | 5613 | `pipelinesExternalWriteApply`（C6 source） |
| 12 | 6601 | `stockPreparationSourcePreflight` |
| 13 | 9473 | `templatesPreview` |

## 2. 装载入口盘点：为什么是两个，不是三个

设计只点名了路由与 runner 两个入口。落地前把插件内所有 `getExternalSystem(` /
`getExternalSystemForAdapter(` / `getExternalSystemAdapterConfig(` 调用点逐个判过一遍，结论：

**是 adapter 装载入口（本刀改）**

1. `lib/http-routes.cjs` — `createHandlers` 装配的 13 个加载点 + 2 个 C6 target 重载。
2. `lib/pipeline-runner.cjs` — 自己的 `requireDependency`，`index.cjs:397` 直接构造它，dead-letter
   replay 也从它重入，路由层的硬依赖够不着。

**不是 adapter 装载入口（本刀不改，逐条理由已落进测试的 allowlist）**

- `lib/http-routes.cjs:4164 / 4228` — B2a 与 E3-01 的**种类读**。合同要求它们发生在任何凭据重载**之前**，
  既有围栏测试断言解密访问器在拒绝路径上被调用 **0 次**；改成解密访问器会直接违反那条合同。
- `lib/http-routes.cjs:4395-4396` — `peekTableActionSourceBinding` 的第二优先级。首选是
  `getExternalSystemAdapterConfig`（**不解密**的守卫访问器）；它唯一的消费者是读身份解析，读的字段
  （`config.dataSourceOwnerId`）在公共投影里原样保留，且从不进 `createAdapter`。
- `lib/http-routes.cjs:4766` — 公共 GET 路由，投影**就是**响应体。
- `lib/http-routes.cjs:5488 / 5584` — C6 的 peek，设计明确要求保留。
- `lib/http-routes.cjs:5518 / 5668` — 传给 `resolveC6WritePlanInputs` 的 seam，供 K3 B4 同实例比较读
  `kind` / `baseUrl`；该 planner 拿到的凭据来自上面已经重载过的 `targetSystem`，不来自这个 seam。
- `lib/http-routes.cjs:7998` — 源绑定候选行的 kind + 可达性检查，下游不建 adapter。
- `lib/pipeline-runner.cjs:593` — runner 侧的 B2a 种类读，与路由侧同一条合同。
- `lib/integration-templates.cjs:353` — 模板实例化的 bind + kind 校验；该函数注释与实现都是
  「creates NO external system, reads NO credentials, triggers NO run/external write」。
- `index.cjs:216-218` — 跨插件通信面的公共读，按设计属于 **M3** 的范围，不是 adapter 装载。
- sealed 侧 `lib/sealed-export/stock-preparation-runtime-core.cjs:179` 与
  `stock-preparation-sqlserver-runtime.cjs:162` 用的是第四个访问器
  `getExternalSystemForSealedSnapshot`，且缺失时直接 `failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')`
  —— **本来就 fail-closed，没有公共投影回退**，本刀无需改动；sealed 产物身份检查属于 M1。

## 3. 每条不变式的代码位置与测试名

本刀实现的是设计 §2 **I2** 收窄后的那一半（另一半由 M1 完成）。拆成两条可分别变异的子不变式：

### I2-a 构造期：缺解密访问器的装配不可表达

- 代码：`lib/http-routes.cjs:3504`、`lib/pipeline-runner.cjs:344`
- 测试（`plugins/plugin-integration-core/__tests__/integration-g4-m2-adapter-load-hard-dependency.test.cjs`）：
  - `G4/M2-a route: registerIntegrationRoutes REFUSES a registry without getExternalSystemForAdapter`
  - `G4/M2-a route control: the SAME mount succeeds once the decrypting accessor is present`
  - `G4/M2-a runner: createPipelineRunner REFUSES deps without getExternalSystemForAdapter`
  - `G4/M2-a runner control: the SAME deps construct once the decrypting accessor is present`
- 两条 control 是反假绿：拒绝断言必须是**这个方法**判的，不是 harness 本身坏了。

### I2-b 调用点：加载表达式只有一种合法写法

- 代码：上表 13 + 2 处，以及 `lib/pipeline-runner.cjs:385-387`。
- 结构测试（同一文件）：
  - `G4/M2-b structural: every getExternalSystemForAdapter expression in http-routes.cjs is an UNCONDITIONAL adapter load`
  - `G4/M2-b structural: every public-projection read in http-routes.cjs is on the reviewed non-adapter allowlist`
  - `G4/M2-b structural: pipeline-runner.cjs expresses one unconditional adapter load and one non-adapter kind read`
- 结构测试是**正向 allowlist**，不是负向禁模式：两个生产模块里每一行提到这两个访问器的**代码行**，
  去掉首尾空白后必须**逐字**等于 allowlist 里的某一条，并且出现次数必须等于登记的条数。因此
  「恢复三元」「`|| getExternalSystem` 兜底」「`?.` 可选调用」「换成公共访问器」都不需要各写一条禁令
  ——它们都不在 allowlist 里，一律红。新增一个公共投影读点必须在 allowlist 里补一条并写明
  「为什么它不会进 `createAdapter`」，这就是把 #5538 的「靠人记得」换成「靠评审签字」。
- 运行时测试（断言的是**性质**，不是访问器名字）：
  - `G4/M2-b runtime (HTTP kind): externalSystemsTest builds its adapter from the DECRYPTING accessor`
    —— 断言交给 `createAdapter` 的对象带 `credentials`（公共投影删掉该字段）。
  - `G4/M2-b runtime (SQL kind): externalSystemObjects builds its adapter from the DECRYPTING accessor`
    —— 断言交给 `createAdapter` 的对象带私有 config 子树 `lookupProjection`（`publicRow()` 对该 kind 删它）。
    HTTP 与 SQL 分开两条，按 §4 的要求。
  - `G4/M2-b runtime (runner): the pipeline SOURCE and TARGET adapters are built from the DECRYPTING accessor`
  - `G4/M2-b C6 dry-run: an ADAPTER-BACKED target IS re-loaded through the decrypting accessor`
  - `G4/M2-b C6 dry-run: a NON-adapter-backed target is NEVER re-loaded through the decrypting accessor`
  - `G4/M2-b C6 apply: the only adapter-backed kind is refused BEFORE any credential load`
  - `G4/M2-b C6 apply: a NON-adapter-backed target loads the SOURCE with credentials and the target without`

**所有 registry 替身都不许别名。** 本刀新增的替身里 `getExternalSystem` 与
`getExternalSystemForAdapter` 返回**不同对象**（公共那个删凭据、删该 kind 的私有 config 子树，
照 `external-systems.cjs publicRow()` 的做法）。别名替身分不出降级过的调用点和正确的调用点——
这是前一版 `stock-preparation-source-preflight.test.cjs` 的
`registry.getExternalSystemForAdapter = registry.getExternalSystem` 一行的问题，本 PR 一并拆掉了。

## 4. 与设计的偏离

1. **§4 说的「新测试加进 `package.json` 测试链」在本仓已不成立。** 链早已搬到
   `plugins/plugin-integration-core/test-chain.txt`（`scripts/test-chain.cjs` 解析并执行，
   `.gitattributes` 给它 `merge=union`），`package.json` 只剩 `"test": "node scripts/test-chain.cjs"`。
   新套件因此加在 `test-chain.txt`，位置仍按要求插在 **S4 尾块之前**。副作用是
   `runtimeFiles.pluginPackageJson` 这次**不需要重打**。
2. **C6 apply 的 adapter-backed 重载分支目前不可达。** `ADAPTER_BACKED_C6_TARGET_KINDS` 只有
   `erp:k3-wise-webapi` 一个成员，而 apply 路由的 E4 第一层永久栅栏（`http-routes.cjs:5599`）在源加载
   与 target 重载**之前**就拒绝该 kind。所以设计 §4 要求的「C6 两个入口分别验证 adapter-backed 必重载」
   在 apply 侧**没法被见证**。没有为了凑对称去绕栅栏，也没有假装重载发生了：测试
   `G4/M2-b C6 apply: the only adapter-backed kind is refused BEFORE any credential load` 钉的是
   **实际行为**（403 + 解密访问器 0 次调用）。若将来栅栏收窄或加入第二个 adapter-backed kind，
   这条测试就是必须被改动、因而必须被注意到的地方。
3. **`route-fallback:*` 变异只有结构测试能抓，运行时测试抓不到，且这是对的。** 当 registry 实际带着
   该访问器时，恢复后的三元与直接调用**行为完全相同**，任何运行时断言都分不出。设计 §4 预见到了这一点，
   要求 M2-b 必须有静态 / AST 约束；运行时那一半的鉴别力另用 `route-swap:*`（把调用点整个换成公共访问器）
   证明。核验文档的变异表把两类分开列，不混报。
4. 设计 §4 提到的联合变异（硬依赖 + 调用点同时降级）已跑并记录，明确**不作为单守卫证据**。

## 5. 回滚

- 本刀是设计 §5 的序 1，独立 revert 即可，无数据迁移、无 schema 改动、无开关。
- revert 一次性把三件事退回去：路由/runner 的硬依赖、15 处调用点、结构测试。退回后的残余风险就是
  M2 之前的原状——**缺 `getExternalSystemForAdapter` 的装配会静默降级到 credential-stripped 公共投影
  并据此建 adapter**，且没有任何测试会红。这一点必须写进 revert 说明，不能当成无害回退。
- revert 时必须同时重打 `lib/sealed-export/vectors/s6a-package-provenance-pins.json` 的
  `runtimeFiles.pluginHttpRoutes`（按 git blob 的 LF 字节算），否则
  `sealed-export-package-provenance` 会红。
- 测试链条目与 `scripts/g4-m2-mutation-probe.cjs` 随 revert 一起走；`test-chain-completeness`
  是双向的，留下任何一半都会红。

## 6. 本刀没有做、也不宣称的事

- 不做 M1（resolver 实例身份 / WeakMap 登记 / sealed 最终产物检查）。**在 M1 落地之前，
  `createAdapter` 仍然接受任何形状对得上的对象**——M2 保证的是「生产加载路径不会自己降级」，
  不是「adapter 不可能被喂进一个伪造对象」。
- 不做 M3（通信面对无可信身份的敏感操作拒绝）。`index.cjs` 的 `upsertPipeline` 仍原样转发
  `createdBy` / `tenantId`。
- 不改 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 默认值，不动 K3 写栅栏与 Bridge 无写通道，
  不改迁移，不改被钉的 `scripts/ops/stock-preparation-s6a-onprem-acceptance.ps1`。
- 不宣称所有 HTTP/K3/PLM 公共对象在任意 `createAdapter` 调用上都被打标拒绝（设计 §2 I2 的原话）。
