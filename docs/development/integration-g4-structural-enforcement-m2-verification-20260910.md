# 集成层 G4 / M2 核验记录（2026-09-10）

配套实施记录：`docs/development/integration-g4-structural-enforcement-m2-implementation-20260910.md`。
设计：`docs/development/integration-g4-structural-enforcement-design-20260908.md` §4。

- 基线：`origin/main@1e6e138af`；本 PR 提交 `232a90783`。
- 环境：Windows 11，Node `v25.9.0`，`core.autocrlf=true`，worktree
  `C:\Users\zhou\Downloads\dev\metasheet-wt-g4`。**CI 才是裁判**，本机结果里有一批已知的
  Windows-only 红，逐条在 §5 列出并已证明与本 PR 无关。
- 本文只记录本机实测；不代表任何 CI / 部署结论。

## 1. 命令与退出码

工作目录 `plugins/plugin-integration-core/`。

| # | 命令 | 退出码 |
|---|---|---|
| 1 | `node __tests__/integration-g4-m2-adapter-load-hard-dependency.test.cjs` | 0（**16** pass / 0 fail；终审收口后从 14 条增加两条结构 control，见 §7） |
| 2 | `node __tests__/sealed-export-package-provenance.test.cjs` | 0 |
| 3 | `node __tests__/test-chain-completeness.test.cjs` | 0（215 suites，0 intentional exclusions） |
| 4 | `node __tests__/test-chain-runner.test.cjs` | 0 |
| 5 | `node scripts/test-chain.cjs`（全链，fail-fast） | 1，停在 `sealed-export-s3-private-ingestion-migration`（§5 第 1 条，Windows-only） |
| 6 | 全链逐条跑、不 fail-fast（脚本见 §6） | **215 条，210 绿 / 5 红**，5 条全部在 §5 |
| 7 | `git show :plugins/plugin-integration-core/lib/http-routes.cjs \| sha256sum` | 0（值见 §4） |

第 1 条的 16 条测试名（`†` = 终审收口新增，`‡` = 同轮改名）：

```
G4/M2-b structural: every getExternalSystemForAdapter expression in http-routes.cjs is an UNCONDITIONAL adapter load
G4/M2-b structural: every credential-free registry read in http-routes.cjs is on the reviewed non-adapter allowlist                     ‡
G4/M2-b structural: pipeline-runner.cjs expresses one unconditional adapter load and its credential-free reads are rostered            ‡
G4/M2-b structural CONTROL: three rewrites that leave every allowlisted line intact are still red                                      †
G4/M2-b structural CONTROL: the control harness passes text that IS on the roster                                                      †
G4/M2-a route: registerIntegrationRoutes REFUSES a registry without getExternalSystemForAdapter
G4/M2-a route control: the SAME mount succeeds once the decrypting accessor is present
G4/M2-a runner: createPipelineRunner REFUSES deps without getExternalSystemForAdapter
G4/M2-a runner control: the SAME deps construct once the decrypting accessor is present
G4/M2-b runtime (HTTP kind): externalSystemsTest builds its adapter from the DECRYPTING accessor
G4/M2-b runtime (SQL kind): externalSystemObjects builds its adapter from the DECRYPTING accessor
G4/M2-b runtime (runner): the pipeline SOURCE and TARGET adapters are built from the DECRYPTING accessor
G4/M2-b C6 dry-run: an ADAPTER-BACKED target IS re-loaded through the decrypting accessor
G4/M2-b C6 dry-run: a NON-adapter-backed target is NEVER re-loaded through the decrypting accessor
G4/M2-b C6 apply: the only adapter-backed kind is refused BEFORE any credential load
G4/M2-b C6 apply: a NON-adapter-backed target loads the SOURCE with credentials and the target without
```

## 2. 变异表

探针：`plugins/plugin-integration-core/scripts/g4-m2-mutation-probe.cjs`。**`-r` 预载 + 内存改源，
不落盘**；目标文本找不到 / 命中数不对 / 改动为空一律 exit 2，不允许「没变异也报绿」。
目录：`G4_M2_MUTATION=list node -r ./scripts/g4-m2-mutation-probe.cjs -e ""`。

**「不允许没变异也报绿」原先只在探针被加载时成立**（终审指出）：`G4_M2_MUTATION=… node <套件>`——
少了 `-r`——什么都没改，套件照样 14/14 全绿，正好是它自称排除的那种假绿。已收口：探针加载时在
`globalThis[Symbol.for('metasheet.g4.m2.mutation-probe')]` 上留标记，套件顶部见到 env 却没见到标记
就直接 throw。实测见 §7.3。

通用命令：

```
G4_M2_MUTATION=<id> node -r ./scripts/g4-m2-mutation-probe.cjs \
  __tests__/integration-g4-m2-adapter-load-hard-dependency.test.cjs
```

**原版（无变异）该套件 exit 0。下表每一行的变异版 exit 均为 1。** 「设计见证」列是这条变异**本来
要靠**哪条测试抓；「并发红」列如实列出同时变红的其它测试 —— 不拿它们冒充见证（设计 §4 / I4）。

### 2.1 M2-a 构造期硬依赖

| 变异 id | 做了什么 | 设计见证（红） | 并发红 |
|---|---|---|---|
| `route-hard-dep` | 从 `requireService` 列表里删掉 `getExternalSystemForAdapter` | `G4/M2-a route: registerIntegrationRoutes REFUSES a registry without getExternalSystemForAdapter` | 两条 http-routes 结构测试 |
| `runner-hard-dep` | 从 `requireDependency` 列表里删掉它 | `G4/M2-a runner: createPipelineRunner REFUSES deps without getExternalSystemForAdapter` | runner 结构测试 |

两条 control（`…route control` / `…runner control`）在原版和上述变异版**都绿**，它们的作用是排除
「harness 自己坏了所以 `assert.throws` 通过」这种假绿，不是变异见证。

### 2.2 M2-b 调用点：恢复回退（`route-fallback:*` / `runner-fallback` / `c6-condition:*`）

| 变异 id | 做了什么 | 设计见证（红） | 运行时测试 |
|---|---|---|---|
| `route-fallback:1` … `:13`、`:all` | 在第 N 个加载点恢复 M2 之前的三元回退 | `G4/M2-b structural: every getExternalSystemForAdapter expression …` + `… every credential-free registry read …` | **全绿（预期）** |
| `runner-fallback` | 恢复 runner 的公共投影回退 | `G4/M2-b structural: pipeline-runner.cjs expresses one unconditional adapter load …` | **全绿（预期）** |
| `c6-condition:1`（dry-run）、`:2`（apply） | 给 C6 target 重载重新加上方法存在性条件 | `G4/M2-b structural: every getExternalSystemForAdapter expression …` | **全绿（预期）** |

**为什么运行时抓不到，而且这是对的**：当 registry 实际带着该访问器时（本仓所有替身现在都带），
恢复后的三元与直接调用**行为完全相同**，任何运行时断言都分不出。设计 §4 正是因此要求 M2-b 必须有
静态 / AST 约束。把这一格写成「运行时也红」就是假绿。

### 2.3 M2-b 调用点：整个换成公共访问器（`route-swap:*` / `c6-swap:*` / `runner-swap`）

这一组是**单点、有可观测效果**的变异，用来证明运行时那一半不是装饰。

| 变异 id | 处理器 | 新套件里变红的运行时测试 | `__tests__/http-routes.test.cjs` |
|---|---|---|---|
| `route-swap:1` | `loadStockPreparationReadonlySource` | —（结构测试红） | 红（`assertOkResponse`） |
| `route-swap:2` | `loadTableActionSourceAdapter` | —（结构测试红） | 红（`assertOkResponse`） |
| `route-swap:3` | `externalSystemsTest` | `G4/M2-b runtime (HTTP kind): …` | 红 |
| `route-swap:4` | `externalSystemReadSmoke` | —（结构测试红） | 红（`assertOkResponse`） |
| `route-swap:5` | `externalSystemReadSourceProbe` | —（结构测试红） | 红（`assertOkResponse`） |
| `route-swap:6` | `readSourceConfigsRead` | —（结构测试红） | 红（`assertOkResponse`） |
| `route-swap:7` | `readSourceCompositionsRun` | —（结构测试红） | 红（`testReadSourceCompositionRoutes`） |
| `route-swap:8` | `externalSystemObjects` | `G4/M2-b runtime (SQL kind): …` | 红 |
| `route-swap:9` | `externalSystemSchema` | —（结构测试红） | 红（`testDiscoveryRoutes`） |
| `route-swap:10` | C6 dry-run source | 两条 `G4/M2-b C6 dry-run: …` | 红 |
| `route-swap:11` | C6 apply source | `G4/M2-b C6 apply: a NON-adapter-backed target loads the SOURCE with credentials …` | 红 |
| `route-swap:12` | `stockPreparationSourcePreflight` | —（结构测试红） | **绿**；由 `__tests__/stock-preparation-source-preflight.test.cjs` 抓（`routeDefaultsToTheConfiguredSourceAndAcceptsAnOverride`，exit 1） |
| `route-swap:13` | `templatesPreview` | —（结构测试红） | 红（`testTemplatePreviewLiveBulkRead`） |
| `c6-swap:1` | C6 dry-run target 重载 | `G4/M2-b C6 dry-run: an ADAPTER-BACKED target IS re-loaded …` | — |
| `c6-swap:2` | C6 apply target 重载 | —（只有结构测试红，见 §3 第 2 条） | — |
| `runner-swap` | runner 的唯一函数体 | `G4/M2-b runtime (runner): the pipeline SOURCE and TARGET adapters …` | — |

结论：**13 个加载点全部有运行时见证**（12 个在 `http-routes.test.cjs`，第 12 个在
`stock-preparation-source-preflight.test.cjs`），外加结构测试的全覆盖。

另跑的跨套件探针：

- `G4_M2_MUTATION=route-swap:2 node -r ./scripts/g4-m2-mutation-probe.cjs __tests__/stock-preparation-operator-value-read-scope.test.cjs`
  → exit 1，红的守卫名：`W-02 with the flag, an operator gets their OWN tenant's missing parts and nothing else`。
- `G4_M2_MUTATION=route-swap:2 node -r ./scripts/g4-m2-mutation-probe.cjs __tests__/stock-preparation-ext-field-mapping-wiring.test.cjs`
  → **exit 0（绿）**。见 §3 第 3 条。

### 2.4 联合变异（**不是**单守卫证据）

| 变异 id | 变红的测试 |
|---|---|
| `route-hard-dep,route-fallback:all` | `G4/M2-a route: …REFUSES…` + 两条 http-routes 结构测试 |
| `runner-hard-dep,runner-fallback` | `G4/M2-a runner: …REFUSES…` + runner 结构测试 |

按设计 §4 的要求明确记账：联合变异同时动了两处守卫，**任何一条红都不能用来给单独一处守卫背书**。
它证明的只是「两处一起降级也逃不掉」。

## 3. 反驳纪律：哪种降级它抓不到

1. **`createAdapter` 收到一个来路不明但形状正确的对象。** M2 不管这个。M2 只保证**生产加载路径不会
   自己降级**；「对象必须来自生产接线的 resolver」是 **M1**（设计 §3 M1 / §2 I1）。在 M1 落地之前，
   任何人在插件内构造一个 `{ id, kind, config, credentials }` 字面量交给 `createAdapter`，本刀的
   三条结构测试与七条运行时测试**一条都不会红**。
2. **C6 apply 的 adapter-backed 重载分支不可达，因此 `c6-swap:2` 只能被结构测试抓。**
   `ADAPTER_BACKED_C6_TARGET_KINDS` 只有 `erp:k3-wise-webapi`，而 apply 路由的 E4 第一层永久栅栏
   （`lib/http-routes.cjs:5599`）在源加载与 target 重载之前就 403 掉它。测试
   `G4/M2-b C6 apply: the only adapter-backed kind is refused BEFORE any credential load` 钉的是这个
   实际行为（403 + 解密访问器 0 次调用），不假装重载发生过。
3. **`__tests__/stock-preparation-ext-field-mapping-wiring.test.cjs` 在 `route-swap:2` 下仍然绿。**
   本 PR 把它的两个访问器从别名拆成了返回不同对象，但该套件**没有任何断言去读这个差**（它测的是
   ext 字段映射的接线，不是凭据上下文）。这是如实记录的一处「替身已修好、但断言没用上」，不是
   守卫漏洞：同一个调用点（site 2）由 `http-routes.test.cjs` 与结构测试双重抓住。
4. **非 adapter 公共投影读点的 allowlist 是「评审强制」而不是「机器证明」。** 结构测试能保证新增一处
   公共投影读**必须**被人加进 allowlist 并写理由，它不能证明那条理由是对的。
5. **同进程恶意代码不在威胁模型内**（设计 §2 威胁边界）。能替换 `fs`、`Module` 或 registry 的代码
   同样能绕过本刀的一切；结构测试读磁盘源文件，运行时测试依赖注入的替身。
6. **不宣称**所有 HTTP/K3/PLM 公共对象在任意 `createAdapter` 调用上都被打标拒绝（设计 §2 I2 原话）；
   C6 非 adapter-backed 的 config-only 路径按设计保留。

## 4. Pin 记录

被本 PR 改动的**被钉文件**只有一个：`plugins/plugin-integration-core/lib/http-routes.cjs`
（清单项 `runtimeFiles.pluginHttpRoutes`）。

- 算法：先 `git add`，再对 **git blob 的 LF 字节**取 sha256 —— Windows CRLF 检出上直接对工作区文件
  取 sha 会错（`.gitattributes` 对该文件是 `text eol=lf`，其它如 `lib/pipeline-runner.cjs` 不是）。
- 命令：`git show :plugins/plugin-integration-core/lib/http-routes.cjs | sha256sum`
- 旧值：`7dcb06a74e672dd336b089eab4eb7eb5ce16a02ca2bdb3cad7eff8c401ad3c3d`
- 新值：`a80172e80bfa68a968313d6eba224dd711fd76ece5567c0c940b7f2df9015636`
- 落在 `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`；
  该 JSON 仍为纯 LF（0 个 CR）。
- 提交后复算 `git show HEAD:…` 得到同一个值。
- 校验：`node __tests__/sealed-export-package-provenance.test.cjs` → exit 0。清单共 **65 条内容摘要
  + 1 个 frozenManifestDigest = 66 项**，由该测试逐条按字节比对。
- `runtimeFiles.pluginPackageJson` / `pluginIndex` / `testChainRunner` **未动**：本 PR 没改
  `package.json`、`index.cjs`、`scripts/test-chain.cjs`。新套件加在
  `plugins/plugin-integration-core/test-chain.txt`（**不在钉单内**，`.gitattributes` 给它
  `eol=lf merge=union`），插在 S4 尾块之前。
- `frozenManifestDigest` 无任何硬编码引用（`sealed-export-s5-evidence.test.cjs` 是动态计算的）。

## 5. 本机已知红（5 条），以及它们与本 PR 无关的证明

全链逐条跑：215 条，210 绿，以下 5 条红。

| 套件 | 报错 | 归类 |
|---|---|---|
| `sealed-export-s3-private-ingestion-migration` | `vitest.config.ts must structurally exclude …realdb.test.ts` | `packages/core-backend/vitest.config.ts` 在本机是 CRLF，契约解析器按 `\n` 匹配。实测：原文 `isQuotedInTestExclude` = false，LF 规范化后 = true |
| `sealed-export-s4-generation-migration` | 同上（S4 的那条 realdb 套件） | 同上 |
| `sealed-export-s6a-source-authority-adapter-projection` | `the registry scan did not notice a smuggled pin — it is decorative` | 该测试自检时对**自身文件**做 `readFileSync(__filename).replace("…\n", …)`；测试文件本机是 CRLF，`\n` 匹配不上 |
| `gip-sqlserver-snapshot-paged-read-profile` | `actual: ['plugins\\plugin-integration-core\\…']` vs `expected: ['plugins/plugin-integration-core/…']` | Windows 路径分隔符 |
| `stock-preparation-department-fields-and-write-scoping` | `spawnSync python3 ENOENT` | 本机 PATH 上没有 `python3`（CI 的 YAML 解析依赖它），守卫按设计 fail-closed |

**证明方式（不是推断）**：用同一套 `-r` 预载技术把
`lib/http-routes.cjs`、`lib/pipeline-runner.cjs`、`s6a-package-provenance-pins.json` 三个文件的内容
在内存里换回基线 `HEAD`（= `origin/main@1e6e138af`）的版本，再跑这 5 条：

```
BASE-RESTORED sealed-export-s3-private-ingestion-migration            -> exit=1
BASE-RESTORED gip-sqlserver-snapshot-paged-read-profile               -> exit=1
BASE-RESTORED stock-preparation-department-fields-and-write-scoping   -> exit=1
BASE-RESTORED sealed-export-s4-generation-migration                   -> exit=1
BASE-RESTORED sealed-export-s6a-source-authority-adapter-projection   -> exit=1
```

5 条在基线内容下**同样红**，且这 5 个测试文件本 PR 一个字都没改。判定：与本 PR 无关，属于
「只在 Windows 上红、CI 才是裁判」那一类。**本 PR 不去改它们**（改 `vitest.config.ts` /
CI 契约文件不在 M2 范围内）。

## 6. 复跑方式

```
cd plugins/plugin-integration-core

# 新套件
node __tests__/integration-g4-m2-adapter-load-hard-dependency.test.cjs

# 变异目录
G4_M2_MUTATION=list node -r ./scripts/g4-m2-mutation-probe.cjs -e ""

# 单条变异（原版 exit 0 / 变异版 exit 1 才算数）
G4_M2_MUTATION=route-hard-dep node -r ./scripts/g4-m2-mutation-probe.cjs \
  __tests__/integration-g4-m2-adapter-load-hard-dependency.test.cjs

# 某个加载点的运行时见证
G4_M2_MUTATION=route-swap:8 node -r ./scripts/g4-m2-mutation-probe.cjs __tests__/http-routes.test.cjs

# 探针陷阱：少了 -r 必须报错，不许绿（§7.3）
G4_M2_MUTATION=route-fallback:3 node __tests__/integration-g4-m2-adapter-load-hard-dependency.test.cjs

# 全链
node scripts/test-chain.cjs

# pin
git show :plugins/plugin-integration-core/lib/http-routes.cjs | sha256sum
node __tests__/sealed-export-package-provenance.test.cjs
```

§1 第 6 行的「逐条跑、不 fail-fast」用的是一次性脚本：读 `scripts/test-chain.cjs` 导出的
`loadChain` / `toArgv`，对每条 `spawnSync`，记录非零退出后继续。它只用于本次核验，未入库
（入库的可复跑件是变异探针；全链本身由 `scripts/test-chain.cjs` 覆盖）。

## 7. M2 终审收口：已知逃逸面、反假绿 control、探针陷阱

本节记录终审对**结构守卫本身**的核验结论与收口后的实测。生产代码（`lib/`）一行未改，改的只有
测试、探针脚本与这两份文档。

### 7.1 已知逃逸面（收口前 → 收口后）

终审在内存里复现了 7 种改写形，初版结构守卫**全部看不见**。逐条对照：

| # | 改写形 | 初版 | 现在 | 抓它的东西 |
|---|---|---|---|---|
| 1 | `/*…*/ const loadSystem = externalSystems.getExternalSystem.bind(…)` | 看不见（`*` / `/*` 开头**整行丢弃**） | 红 | control「inline block comment in front of the statement」 |
| 2 | `const { getExternalSystem: loadPublic } = externalSystems` | 看不见（正则只认 `.名` 与 `'名'`） | 红（**造别名那一行**） | control「destructuring alias + appended .catch fallback」 |
| 3 | `… .catch(() => loadPublic(x))` 追加式回退 | 看不见 | **仍然看不见**（这一行不提名字） | 无——见 §7.4 |
| 4 | `externalSystems["getExternalSystem"](…)` | 看不见 | 红 | control「bracket read with a quoted accessor name」 |
| 5 | 双引号词形 `"getExternalSystem"` | 看不见 | 红 | 同上 |
| 6 | `listExternalSystems(...)` 的结果喂 `createAdapter` | 不在匹配范围 | 该行必须进名册并写明「为什么不进 createAdapter」 | 名册 `OTHER_PUBLIC_READS` |
| 7 | `getExternalSystemAdapterConfig(...)` 的结果喂 `createAdapter` | 不在匹配范围 | 同上 | 同上 |

**原有名册条目与计数一个字没动**（13 个加载点 = 11 + 2，C6 重载 2 处，各处公共投影条数原样）；新增的是
**10 条既有合法读点**（http-routes 8 条 + pipeline-runner 2 条，都是本来就在跑、只是原来不在匹配范围里的
公共读）与**10 条块注释散文行**（`*_DOC_MENTIONS`，`why` 统一为「doc-comment prose; carries no expression」）：

| 文件 | 行 | 性质 |
|---|---|---|
| `lib/http-routes.cjs` | 2011 | `resolveC6WritePlanInputs` 的解构参数名（终审点名的「裸标识符」词形） |
| `lib/http-routes.cjs` | 4149-4150 | `b2aSourceSystemConfigLoader` 的不解密 config 读（另见实施记录 §7.1） |
| `lib/http-routes.cjs` | 4393-4394 | `peekTableActionSourceBinding` 的第一优先级（原来只登记了 4395-4396 的第二优先级） |
| `lib/http-routes.cjs` | 4663 / 4736 / 7860 | hub 概览、公共 LIST 路由、源绑定候选 |
| `lib/pipeline-runner.cjs` | 615 / 617 | H-3 的不解密 config 读（另见实施记录 §7.1） |
| 两个模块 | 4131 / 4142 / 4251 / 4348 / 4354 / 4358 / 4381 / 4383 / 7838；runner 561 | 块注释散文行 |

### 7.2 反假绿 control 的变异证据（改测试、不改 `lib/`）

用同一套 `-r` 预载技术把**测试文件自身**的某一处收口在内存里退回旧写法，看 control 是否变红。
基线（无变异）：`exit 0，16 pass / 0 fail`。

| 内存变异（对测试文件） | 退出码 | control 的报错 |
|---|---|---|
| `codeLinesFrom` 恢复 `startsWith('*') / startsWith('/*')` 整行丢弃 | 1（4 红） | `Missing expected exception: inline block comment in front of the statement: this rewrite must NOT be expressible without a roster change` |
| `DECRYPTING` / `PUBLIC_PROJECTION` 退回 `.名` + `'名'` 词形 | 1（3 红） | `Missing expected exception: destructuring alias + appended .catch fallback: …` |

（两次都还有其它结构测试同时变红——旧写法下真实文件的名册计数也对不上了。如实列出，不拿它们冒充
control 的见证。）

正则层面的单点对照（同一段文本，旧守卫 / 新守卫是否看得见）：

```
(a) destructuring alias      old-guard-sees=false new-guard-sees=true
(a2) alias call site         old-guard-sees=false new-guard-sees=false   <- §7.4 的残余
(b) bracket + quoted name    old-guard-sees=false new-guard-sees=true
(c) inline block comment     old-guard-sees=false new-guard-sees=true
```

原有变异仍然红（收口后复跑，逐条 exit 1）：

| 变异 id | 退出码 | 变红的测试 |
|---|---|---|
| `route-fallback:3` | 1 | 两条 http-routes 结构测试（2 红 / 14 绿） |
| `route-swap:3` | 1 | 两条结构测试 + `G4/M2-b runtime (HTTP kind): …`（3 红 / 13 绿） |
| `route-hard-dep` | 1 | 两条结构测试 + `G4/M2-a route: …REFUSES…`（3 红 / 13 绿） |

### 7.3 探针陷阱

```
G4_M2_MUTATION=route-fallback:3 node __tests__/integration-g4-m2-adapter-load-hard-dependency.test.cjs
-> exit 1
   Error: G4_M2_MUTATION="route-fallback:3" is set but scripts/g4-m2-mutation-probe.cjs was never
   preloaded, so NOTHING was mutated. …
```

收口前同一条命令是 exit 0 / 14 绿。`G4_M2_MUTATION=list node -r … -e ""` 仍正常打印目录（exit 0）：
标记在探针加载时就设，与是否真的应用了变异无关。

### 7.4 收口后仍然不宣称的事

1. **结构守卫是逐行标识符匹配，不是 AST 分析。** 一个不在任何一行里写出访问器名就拿到的绑定
   （拼出来的属性名、第三个模块的再导出、别名被造出来之后的调用行）它看不见。上表第 3 行是这一类的
   代表：`.catch(() => loadPublic(x))` 之所以会被抓住，是因为**造 `loadPublic` 那一行**提到了名字，
   不是因为这一行被看见了。这一半的鉴别力由 `route-swap:*` 的运行时见证承担。
2. **块注释散文进名册是评审税，不是证明。** 它保证的是「改动被看见」，不保证理由正确（同 §3 第 4 条）。
3. **探针陷阱只装在本套件里。** §2.3 的跨套件探针（`route-swap:8` 打 `__tests__/http-routes.test.cjs`
   等）如果漏了 `-r`，仍然会安静地跑出一个「原版绿」——那些套件没有这道自检。本轮没有给 13 个既有套件
   逐个加陷阱（会为了一条自检去改十几个与本 PR 无关的文件）；跨套件探针的正确读法仍然是：命令行里必须
   看得见 `-r ./scripts/g4-m2-mutation-probe.cjs`，且 stderr 上必须有 `applied <id>` 那一行。
3. §3 的六条反驳纪律**一条都没有因为本轮收口而变弱**：M2 仍然不管「伪造对象喂 `createAdapter`」
   （那是 M1），C6 apply 的 adapter-backed 分支仍不可达，同进程恶意代码仍不在威胁模型内。
