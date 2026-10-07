# s6a pins 范围收窄:S6-A PowerShell 5.1 执行器独立成 workflow 并整文件钉(设计 + 验证)

- 日期:2026-09-30;分支 `chore/s6a-pins-narrow-workflow-scope`(Draft PR #6187);基线 `8e2e40d125`(main,#6216 之后;2026-10-07 自 `fc684dceeb` rebase 而来,10 个提交内容不变,pins.json 按仓库算法在新基线上重算;rebase 前的读数与 SHA 在 §5 / §7 单独标注)
- 依据:owner 2026-09-30 原话「按你给的「收益 ÷ 成本 顺序来执行」」,指向排序第 ③ 项「根治 s6a pins 串行瓶颈(须 sealed-export 线门审)」;决策单 D-13 的选项 (b)。
- 性质:**Draft PR 候选**。选型来自一份只读选项分析(私有记录),那是分析者建议,**不是授权**。合并须 owner 点名 + sealed-export 线门审。本文不改任何已 ratify 锁的正文(§4)。

## 0. 结论

| 项 | 结论 |
|---|---|
| 做了什么 | 把 `plugin-tests.yml` 的 `stock-prep-powershell51` job **逐字节原样**搬到新文件 `.github/workflows/stock-prep-powershell51.yml`;证据清单 `PINNED_EVIDENCE_FILES` 用 `s6aPowershell51Workflow`(新文件,**整文件** sha256)替换 `pluginTestsWorkflow`(`plugin-tests.yml`);清单仍是 10 条 |
| 证明力 | 对被证明对象(S6-A PS 5.1 证据执行器)**不削弱**:每一类篡改在新文件上仍令 live 比对红(§2.2,11 类用例 + 删除)。留在 `plugin-tests.yml` 里的内容所对应的篡改,**原本就不在证明范围内**(§2.3,附代码证据与演练读数) |
| 必需检查里的触发 | `plugin-tests.yml` 是必需检查 `integration-guard` 的守护路径;新文件自 C6 起同样列入守护名册(`scripts/ops/integration-guard-guarded-paths.mjs` 与 `integration-guard.yml` 的 `on.push.paths`),改它照旧在该必需检查里跑含 live 比对的 plugin-integration-core 链;provenance 测试断言这一条(§2.2、§5 V8) |
| 钉的移动 | C1 只动 4 个叶子(§5 V3);其后 C2 / C4 两次改 `plugin-tests.yml`、C3 / C6 改测试与守护名册,钉都是 0 移动;C7 纯注释只动 `modules.s5["sealed-export-package-provenance.cjs"]` 1 个叶子 |
| 需改已 ratify 锁 | 否(§4) |
| V6 | 已在 Draft PR #6187 上实测:必需检查 `stock-prep PowerShell 5.1 acceptance` 由新 workflow 报告并通过(§5);分支保护无需改动 |

## 1. 改动(C1–C4、C6–C7 六个代码提交 + C5 / C8 / C9 / C10 / C11 五个文档提交)

| 提交 | 内容 | 钉 |
|---|---|---|
| C1 | 新文件 `stock-prep-powershell51.yml`:头注释 + 新 `name:` + `plugin-tests.yml:2-27`(`on` / `env` / `concurrency` / `jobs:`)逐字节 + job 块 `:127-172` 逐字节。证据清单替换(附理由注释)、`.gitattributes` 钉块替换(`plugin-tests.yml` 另留一条非钉 `eol=lf`)、S5 workflow `paths` 过滤替换;用 `computePackageProvenancePinSet(repoRoot)` 重算 | 4 个叶子(白名单内) |
| C2 | `plugin-tests.yml` 删除 `:127-173`(job 块 + 其后空行);两条契约测试改读新文件 | 0 |
| C3 | provenance 测试:执行器逐类篡改负例、`plugin-tests.yml` 解耦正例、清单断言 | 0 |
| C4 | `plugin-tests.yml` 两处纯注释更新 | 0 |
| C5 | 本文 | 0 |
| C6 | 门审 P2:新文件加入 Integration Guard 守护名册与 `on.push.paths`(契约要求二者集合相等);provenance 测试新增 `s6aPowershell51ExecutorIsIntegrationGuarded`(路径取自清单条目 `s6aPowershell51Workflow`,不抄写) | 0 |
| C7 | 门审 NIT:清单理由注释与解耦用例头注释改为精确表述(`plugin-tests.yml` 不跑任何被钉测试体;其 core-backend vitest 步会收集两个被钉的 `.db.test.ts`,但该处无 `DATABASE_URL`,二者注册为 skipped);重算钉 | 1 个叶子 |
| C8 | 本文按门审意见更新(§0–§3、§5–§8) | 0 |
| C9 | 本文:§2.5 冻结清单摘要补到终值;§5 回归读数标明所在树,补 C6 后重跑的 workflow 枚举守卫 | 0 |
| C10 | 本文:§5 记 Draft PR 上的 V6 / V7 读数 | 0 |
| C11 | 本文:rebase 到 `8e2e40d125` 后的数值更正(基线、§1、§2.5、§3、§5、§7)与 PR 模板的被钉文件示例 | 0 |

## 2. 证明范围:前后对照

### 2.1 证明的性质(不变)
- 同树证明:模块头注释「this module does not claim that the same-tree manifest is itself an external trust root」;S5 认证文档:「Repository-frozen provenance pins prove candidate-tree consistency only」。
- 「能发现一次篡改」的含义:篡改者不同时改 `s6a-package-provenance-pins.json` 就过不了 live 比对;而改 pins.json 会改变 `frozenManifestDigest`(外部锚)。
- 证据文件是仓库 / CI 输入:`verifySealedExportRuntimePackageProvenance`(出包 / 实体机)只核清单 id 集合与摘要格式,不核证据字节。本改动两个入口的逻辑都不变,只换清单里的一条。

### 2.2 被证明对象:S6-A PS 5.1 证据执行器

| 篡改类 | 之前(整文件钉 `plugin-tests.yml`) | 之后(整文件钉 `stock-prep-powershell51.yml`) | 用例(C3 `s6aPowershell51ExecutorTamperFails`) |
|---|---|---|---|
| 同长度改被测路径 | 发现 | 发现 | `…ps51.tests.ps1` → `…ps52.tests.ps1`,断言长度相等 |
| T1 加一步 `run:` | 发现 | 发现 | 在 Setup Node 前插入一步 |
| T2 改 action 引用 | 发现 | 发现 | `actions/checkout@v4` → `@v3` |
| T3 改权限(含放在 `jobs:` **之后**的顶层键) | 发现 | 发现 | 文件末尾追加 `permissions: write-all`,断言其位置在 `jobs:` 之后 |
| T4 改环境变量 | 发现 | 发现 | workflow 级 `env:` 加一项 |
| T5 改工具链 / 安装 | 发现 | 发现 | `node-version: 20.x` → `18.x`(该 job 无依赖安装步,安装类篡改即 T1) |
| T6 让被测文件不跑 / 不拦 | 发现 | 发现 | 删 S6-A 调用后的退出码检查;job `continue-on-error: true`;job `if: false`;`pull_request` 触发器收窄 |
| 纯注释改动 | 发现(整文件) | 发现(整文件,无归一化) | 文件头加一行注释 |
| 删除 / 改名执行器 | — | fail-closed | `fs.rmSync` 后校验抛 `SEALED_EXPORT_INTERNAL_ERROR` |
| T7 改被测文件本身 | 发现(`s6aAcceptancePs51Test` 被钉) | 不变 | 既有 |

- 每个用例:锚点必须恰好出现一次;篡改后 `verifySealedExportPackageProvenance` 抛 `SEALED_EXPORT_INTERNAL_ERROR`,**且** `computePackageProvenancePinSet(root).evidenceFiles.s6aPowershell51Workflow` 与冻结值不同(即 live 比对红);还原后再校验为绿(正控,证明红来自该篡改)。
- 证明单元是整文件而不是文件内的 job 区段:YAML 映射键序自由,`jobs:` 之后的顶层 `permissions` / `env` / `defaults` 仍作用于每个 job(T3 用例专测这一点)。
- 清单断言(`positivePackagePin`):`s6aPowershell51Workflow` 指向新文件,且新文件确实调用被钉的 `s6aAcceptancePs51Test` 并紧跟退出码检查。
- 在哪个必需检查里被发现(C6,门审 P2):之前,`plugin-tests.yml` 在 Integration Guard 守护名册里,改它令必需的 `integration-guard` 跑 plugin-integration-core 链(含本 live 比对)。之后,新文件自 C6 起同样在名册与 `on.push.paths` 里(与之前持平);`s6aPowershell51ExecutorIsIntegrationGuarded` 以清单条目的路径调用 `classify()` 断言为 `true`,所以把该条从名册删掉、或把清单条目改指别的路径而不补名册,都会令 provenance 测试红(§5 V8 演练)。
- 测试自身的效力(对**模块**做变异,每次都重算钉,确保红是本测试的):去掉证据字节校验、清单改回钉 `plugin-tests.yml`、清单额外再钉 `plugin-tests.yml`,三者都令 provenance 测试红。

### 2.3 留在 `plugin-tests.yml` 里的内容(不再被钉)

`plugin-tests.yml` 退出清单后,改它的任何字节都不再动钉。逐类说明为什么这不是削弱(「原本就不在证明范围内」):

| 留下的内容 | 同一篡改结果今天就能不动任何钉达成 | 代码证据 / 读数 |
|---|---|---|
| sealed-export S3 / S4 真库证明步(`test` job,id `sealed-export-s3-real-db` / `sealed-export-s4-real-db`) | 两个被测文件 `tests/integration/sealed-export-s3-private-ingestion-realdb.test.ts`、`…-s4-generation-kernel-realdb.test.ts` **不在任何清单**里:直接改被测文件就能让这两步失去证明作用,且不动钉 | 清单代码只含 `s5SignerLifecycleRealDbTest`、`s6aRuntimeAuthorityRealDbTest` 两个真库测试;V4-c 实测:给 S3 被测文件追加一行,重算钉 0 移动 |
| (同上)步骤接线 | 另有结构守卫 `isSuiteWiredInRealDbStep`(`sealed-export-s3-private-ingestion-migration.test.cjs`、`-s4-generation-migration.test.cjs`,在必需的 `integration-guard` 里跑),与钉无关、本改动不碰 | 演练读数见 §2.3.1 |
| T9 pwsh 步(静态跑 ACL 测试) | 该测试文件不在清单;真 icacls 覆盖在随 job 搬走的 PS 5.1 job 里 | 清单代码 |
| 其余全部步骤(钉钉 / 考勤 / 审批 / 多维表 / elearning / K3 …)上的 T1–T5 | 在仓内任意未被钉的 workflow(或新建一个)里做同样的事都不动钉 | 被钉的 workflow 只有 2 个(之前:144 个中的 `sealed-export-s5-sqlserver.yml` + `plugin-tests.yml`;之后:145 个中的 `sealed-export-s5-sqlserver.yml` + 新文件)。必需的 `integration-guard.yml`(PR 触及其守护名册时跑含 provenance 测试的链)本身也未被钉。V4-d 实测:新建一个任意 workflow,重算钉 0 移动 |
| 跨 job 干扰 | job 在各自 runner 上跑;PS 5.1 job 没有 `needs:`、没有缓存步,也没有 job `needs` 它;现在它连文件都不共享 | `plugin-tests.yml` 唯一的 `needs:` 是 `coverage` → `test` |

#### 2.3.1 S3 / S4 步的篡改演练(在工作树上改 `plugin-tests.yml`,跑对应结构守卫,`cp` 还原并核 sha)

- 结构守卫拦得住(红)的四类,S3 与 S4 各自实测:被测路径换成别的文件、被测路径改名、步骤 `if:` 翻到 18.x、去掉 `DATABASE_URL`。
- 步骤级编辑的逐项读数:见私有记录。
- 这些编辑所能达成的结果(S3 / S4 真库证明不再有效)今天就能通过改**未被钉**的被测文件达成而不动任何钉(见上表第一行与 V4-c),所以它们不在证明保证内。列入 §3 未覆盖项。

### 2.4 被钉文件的执行器普查(`fc684dceeb`,按文件名在 `.github/workflows/*.yml` 里 grep,再区分 `paths:` 行与执行行)

| 被钉文件 | 被钉的执行器(之前) | 被钉的执行器(之后) |
|---|---|---|
| `s6aAcceptancePs51Test` | `plugin-tests.yml`(`sealed-export-s5-sqlserver.yml` 只在 `paths:` 里列它) | **新文件**(逐字节同一 job) |
| `s5SignerLifecycleRealDbTest`、`s6aRuntimeAuthorityRealDbTest` | `sealed-export-s5-sqlserver.yml`(执行行)。`plugin-tests.yml` 的 core-backend vitest 步(`vitest.config.ts` 未排除)会收集这两个文件,但该步的 workflow / job / 步骤 env 都没有 `DATABASE_URL`,此前也没有步骤把它写进 `GITHUB_ENV`(真库步都在 `Start Postgres` 之后,各自在步骤 env 里设),二者经 `describeIfDatabase` 注册为 skipped,不跑测试体 | 不变 |
| S5 runner / verifier、memory-db、provisioning CLI、`pluginPackageJson` / `pnpmLock` 等 | `sealed-export-s5-sqlserver.yml`(`pnpm --filter plugin-integration-core …` 经被钉的 `package.json`) | 不变 |
| `multitableOnpremPackageBuild`、`multitableOnpremPackageVerify` | `plugin-tests.yml` 里只在**注释**中出现;执行器是未被钉的 `multitable-onprem-package-build.yml` 等 | 不变 |
| `s6aProductRuntimeTest`、`testChainRunner` | 无 workflow 按文件名引用(经被钉的 `package.json` / `test-chain.cjs` 执行) | 不变 |

⇒ `plugin-tests.yml` 在清单里唯一的证据作用是执行 `s6aAcceptancePs51Test`(上表的「收集但 skipped」不产生证据);该作用由新文件原样承接。之前有被钉执行器的每个被钉测试,之后仍有。

### 2.5 不受影响的
- 已发布冻结包(`stock-prep-s6a-postgres17-validation.yml` 的 `PACKAGE_PROVENANCE_MANIFEST_DIGEST_PIN`):该 workflow 用**包内**的 provenance 模块与包内 pins 校验,与仓内清单变更无关。
- `frozenManifestDigest` 随 pins.json 变化(基线 `286e670f…` → `1b207c60…`,C1;→ `b443f66a…`,C7,即本分支终值;rebase 前在 `fc684dceeb` 上的对应值为 `e9b93a54…` → `4f2681e6…` → `b6a2270c…`,差别全部来自 main 侧在 #6060 / #6165 等合并中移动的钉),与任何一次重钉相同;下一次出包照常输出新摘要。
- 出包 / 实体机校验脚本(`multitable-onprem-package-verify.sh`、`multitable-onprem-package-build.sh`、S6-A 验收 runner)不引用证据 id。

## 3. 未覆盖项 / 残留

1. **S3 / S4 真库步**:`plugin-tests.yml` 不再是 provenance 输入(§2.3、§2.3.1)。原本就不在证明范围内(被测文件未被钉)。本 PR 不做。
2. 其余见私有记录。
3. **V6 / V7**:读数见 §5。
4. **PS 5.1 本身未在本地跑**(只有 Windows runner 能跑);本地跑了读该 job 的两条契约测试(node 与 pwsh 7)。
5. **本 PR 不治的**:`pluginHttpRoutes`(pins.json 最热的键)是随包出货的运行时文件,钉它是证明核心,不能照搬本方案;`plugin-tests.yml` 自身的文本冲突仍在。
6. 新文件未加 `permissions: contents: read`,为保持与原 job 头部逐字节可比;可另提。
7. **Integration Guard 触发**(门审 P2):C1–C5 之间新文件不在守护名册;C6 起与基线持平(§2.2、§5 V8)。
8. **部署就绪脚本不再汇总 PS 5.1 结果**(门审 P3,只记录不改):`scripts/ops/integration-erp-plm-deploy-readiness.mjs` 的 `REQUIRED_MAIN_WORKFLOWS` 按 workflow 名字取 `Plugin System Tests` 在所选 main 提交上的结论;拆分后 PS 5.1 job 失败不再令该 run 失败。该条目的 `purpose` 文本从未列出 PS 5.1,原覆盖是附带的。不改的理由:该脚本属部署 / 发布线(由 `docker-publish-guard.yml` 与其测试夹具守着),加一条必需 workflow 要连带改夹具,超出本 PR 范围。现状:新 workflow 的 `on:` 与 `plugin-tests.yml` 逐字节相同,在同一批 main 提交上运行;`stock-prep PowerShell 5.1 acceptance` 仍是 main 分支保护的必需 context(2026-09-30 只读 `gh api` 核对,13 个必需 context 之一,app 15368)。把 `Stock-prep PowerShell 5.1 acceptance` 加入 `REQUIRED_MAIN_WORKFLOWS` 作为后续单独一张。
9. **过时注释**(门审 NIT,只记录不改):约 35 个 `approval-realdb-*.yml` 头注释、`packages/core-backend/vitest.config.ts`、`approval-ci-coverage-enumeration.test.ts`、`approval-cancel-round-ci-wiring.test.ts` 里仍写着「`plugin-tests.yml` 是 s6a sha256 钉的 provenance 输入」。错在保守方向(照做只会多一次 0 差异的重算)。不在本 PR 扫:一次改几十个 workflow 会扩大本 PR 要缩小的冲突面;留作单独的纯文档清扫。
10. **提交尾注**(门审 NIT):C1–C5 缺 `Claude-Session` 尾注(身份均为 noreply,合规)。本轮约束「新提交、不 amend」,故不改;C6 起的提交带该尾注。squash 合并时可在合并信息里统一。

## 4. 与已 ratify 锁的关系
- 检索:`docs/development` 下同时含 `pluginTestsWorkflow` / `PINNED_EVIDENCE_FILES` 与 ratify 字样的文件,以及私有 reviews 目录下的锁文。
- 证据清单由代码 `PINNED_EVIDENCE_FILES` 定义,历次由普通 PR 变更(#4691 加 `s5EvidenceWorkflow`,#4694 加 `pluginTestsWorkflow`,#5420 加 `testChainRunner`)。没有任何已 ratify 锁的正文规定「`plugin-tests.yml` 必须被钉」。
- 已 ratify 文档里把「改 `plugin-tests.yml` 须重算 s6a 钉」写成**代价或流程**的地方(例:`approval-lock11-writer-org-derivation-20260822.md` §4.1 的 #5095 流程、`task-feature-design-lock-20260917.md` §13-12 对选项 (a) 的代价描述):本改动后这些描述变得过时,但它们是理由 / 流程说明,不是规范;各锁的裁定不受影响。**不改其正文**。
- S5 认证文档「bind … the workflow/runner/verifier/real-DB evidence files」:仍成立(被钉的 workflow 现为 S5 workflow 与新文件)。

## 5. 验证读数(node / pwsh 直接调用,不经 pnpm;无需真库)

| # | 内容 | 读数 |
|---|---|---|
| V1 | job 块逐字节 | `diff <(plugin-tests.yml@base :127-172) <(新文件 job 块)` 为空;头部 `:2-27` 逐字节相同;C2 删除的块 == 该 job 块 + 1 空行;契约测试的新正则抽出的块 == 基线 `:127-172` |
| V2 | sealed-export 全部 `.test.cjs`(33 个) | 基线 33/33;C1 / C2 / C3 之后各 33/33;C6、C7 之后各 33/33 |
| V3 | 钉的叶子级差异(66 个叶子) | C1:恰好 4 个 —— `evidenceFiles.pluginTestsWorkflow`(删)、`evidenceFiles.s6aPowershell51Workflow`(增)、`evidenceFiles.s5EvidenceWorkflow`、`modules.s5["sealed-export-package-provenance.cjs"]`;C2 / C3 / C4 / C6:0;C7:恰好 1 个 —— `modules.s5["sealed-export-package-provenance.cjs"]`(纯注释;冻结清单摘要 `4f2681e6…` → `b6a2270c…`) |
| V4 | 解耦演练(工作树上改、跑、`cp` 还原、核 sha) | 见下 |
| V5 | 读该 job 的契约测试 | `multitable-onprem-package-upgrade-inplace.test.mjs` 两条 CI wiring 用例 2/2(完整套件 79/79);`stock-preparation-rca-window.tests.ps1`(pwsh 7)38/38 |
| V6 | 必需 context 由新 workflow 满足 | **成立**(Draft PR #6187,head `dde90945f5`):该 context 由 workflow「Stock-prep PowerShell 5.1 acceptance」(`pull_request`,run 36707082295)报告 success;rebase 后 head `e0e2e972e2` 同样由该 workflow 报告(run 37575991751) |
| V7 | 必需 context 全绿 | head `dde90945f5`:**13/13 pass**(2026-09-30 20:03 +0800 读);rebase 后 head `e0e2e972e2`:**13/13 pass**(2026-10-07 读)。本行所在提交只改文档;其后的 head 以 PR 检查页为准 |
| V8 | 新文件是 Integration Guard 守护路径(C6) | 见下 |

V4 读数(每项改后跑 provenance 测试 + 叶子级重算,随后 `cp` 还原并核对与 HEAD blob 相同):

| 项 | 改动 | provenance 测试 | 移动的叶子 |
|---|---|---|---|
| V4-a | `plugin-tests.yml` 末尾加注释 + 一个新的 run 步 | 绿 | 无 |
| V4-b | 新文件加一行注释 | 红 `SEALED_EXPORT_INTERNAL_ERROR` | `evidenceFiles.s6aPowershell51Workflow` |
| V4-b2 | 新文件末尾(`jobs:` 之后)加顶层 `permissions: write-all` | 红 `SEALED_EXPORT_INTERNAL_ERROR` | `evidenceFiles.s6aPowershell51Workflow` |
| V4-c | S3 真库被测文件(未被钉)加一行 | 绿 | 无 |
| V4-d | 新建一个任意的未被钉 workflow | 绿 | 无 |

V8 读数(`printf '<路径>\0' | node scripts/ops/integration-guard-classify.mjs`;演练在工作树上改、跑、`cp` 还原并核 sha):

| 项 | 内容 | 读数 |
|---|---|---|
| V8-a | 新文件的分类:基线 `8e2e40d125` / C5 `8ba9468310` / C6 起(rebase 前:`fc684dceeb` / `515d3d6f38`) | `relevant=false` / `false` / `true`(`plugin-tests.yml` 三处都是 `true`) |
| V8-b | 对照(不改) | provenance 测试绿;`integration-guard-required-wiring-contract` 64/64 |
| V8-c | 只从名册删该条(`on.push.paths` 保留) | 分类 `false`;provenance 测试红(新断言);契约 63/64(集合相等用例红) |
| V8-d | 名册与 `on.push.paths` 同时删该条 | 分类 `false`;契约 64/64 绿;provenance 测试红(新断言)⇒ 这一情形契约不拦,靠新断言发现 |
| V8-e | 执行器改名为 `stock-prep-ps51.yml`,清单条目、测试常量、pins 都照改并重算,唯独不补守护名册 | provenance 测试在新断言处红(其前各用例都过);契约 63/64(「名册条目须存在」用例红,因旧路径已不存在) |
| V8-f | 叶子级重算 | C6 移动 0 个叶子 |

C6 / C7 之后的回归(rebase 前的树 `e6f218a583`,对应 rebase 后 `886711f5da`;C8 之后代码不变;依赖软链同下,未运行任何安装命令):plugin-integration-core 全链 235/235;sealed-export `.test.cjs` 33/33;`integration-guard-required-wiring-contract` 64/64;V5 两条契约测试 2/2、38/38。C6 改了 `integration-guard.yml` 的文本,因此在该树上重跑了读 / 枚举 `.github/workflows/` 的守卫:`attendance-w4c2-ci-wiring` 262/262、`multitable-onprem-package-no-node-modules` 14/14(rebase 后在 `e0e2e972e2` 上 15/15,main 侧新增一例)、`multitable-role-cascade-witness` 52 过 / 18 skipped(opt-in 真库 golden,未设 `ROLE_CASCADE_WITNESS_DB_GOLDENS=1`)、`ssh-hostkey-pin-family-contract` 12/12、`approval-ci-coverage-enumeration`(vitest)385/385。

其他回归(rebase 前的 C4 树 `d70039e563`,对应 rebase 后 `b35aced236`;C6 之前;依赖以软链指向主检出的 node_modules,未运行任何安装命令):

| 范围 | 读数 |
|---|---|
| plugin-integration-core 全链 `node scripts/test-chain.cjs`(必需的 `integration-guard` 所跑) | 基线 235/235;最终 235/235 |
| 读 `plugin-tests.yml` 的全部 node 测试(按 `git grep -l plugin-tests.yml` 列出,62 个) | 61 个在 200 s 内绿;余下 1 个(`multitable-onprem-package-upgrade-inplace.test.mjs`)单独放宽时限跑完整套件 79/79 |
| 读 `plugin-tests.yml` 的 core-backend 单测(vitest,19 个文件)+ 两个 `scripts/ops` tsx 测试 | 798/798;68/68、25/25 |
| 枚举 `.github/workflows/` 的守卫(`attendance-w4c2-ci-wiring`、`multitable-onprem-package-no-node-modules`、`multitable-role-cascade-witness`、`ssh-hostkey-pin-family-contract`、`approval-ci-coverage-enumeration`)与 `integration-guard-required-wiring-contract` | 全绿(包含在上两行内) |

## 6. 与只读分析里的方案的偏差
1. `upgrade-inplace` 测试:分析写「`workflowPath`(:44)改指新文件」。实际 `workflowPath` 还被 `:459` 的 ubuntu `test` job 接线用例使用,整体改指会令该用例红 ⇒ 改为新增 `windowsWorkflowPath`,只给 Windows 用例用。
2. EOF 正则用 `(?=\n {2}\S|\n*$)`(无 `m` 标志,`$` 只在输入末尾);已核:原正则在新文件上不匹配,新正则抽出的块与基线逐字节相同。
3. provenance 测试在「一个同长度负例 + 清单断言」之外,加了逐类篡改负例与解耦正例(任务要求 ① ②)。
4. `plugin-tests.yml` 里另外几处历史叙述性的「re-pin」注释(如 A3 backfill-down-guard 步前的说明)保持原样:它们记录的是当时的提交,不改历史叙述。
5. P2 的回归断言放在 provenance 测试,而不是 `integration-guard-required-wiring-contract.test.mjs`:该契约声明 64 条、下限 `MIN_CONTRACT_TESTS=62`、最大滞后 3,再加一条就用光余量,下一张加契约用例的 PR 必须同时改两个 workflow 的下限(其一是 `plugin-tests.yml`),与本 PR 的目标相悖。断言跑在 plugin-integration-core 链里;删名册条目的 PR 必然触及守护路径(名册文件本身在名册里),链会跑。

## 7. 过渡
- 在飞且改了 `pluginTestsWorkflow` 的 PR(2026-09-30 只读 `gh pr list` 前 100 个 open):#6060、#5598(均 draft)。二者改 `plugin-tests.yml` 的位置都不在被搬走的 job 内;合并本 PR 后,它们在 pins.json 上冲突一次,处理方式是丢弃自己那行 `pluginTestsWorkflow` 改动。#6165、#6098(draft)改 pins.json 的其他键,可能因相邻行冲突一次。**更新(2026-10-07 rebase)**:#6060 与 #6165 已于 2026-10-01 合入 main,在本分支基线之内,它们对 pins.json 的改动已随 rebase 重算吸收;上述冲突说明只对仍在飞的 #5598、#6098 有效。
- 建议本 PR 在合并列车里排第一,或在安静窗口落地。
- 建议 squash 合并:C1 是中间态(新文件已加、`plugin-tests.yml` 里的 job 尚未删),两个 workflow 里有同名 job;squash 后 main 上不存在这一中间态。即使不 squash,必需检查只在 PR 的合并预览 / 合并队列提交与合并后的 main 头上跑,中间提交不会被单独求值。

## 8. 回退
- 整体 revert 本分支全部提交即可(无迁移、无开关、无数据)。revert 后须再用 `computePackageProvenancePinSet(repoRoot)` 核对 pins(revert 自带原值,应 0 差异)。
