# 备料上手向导 ①拆分 + /stock-prep 门对齐 — 验证 (2026-09-10)

设计见同名 `-design-20260910.md`。本机 Windows，`pnpm install --frozen-lockfile --offline` 退出码 0。
下述数字均为**变基到 `feat/data-sources-fold-into-workbench` @ afcf9e374 之后**重跑的结果。

## 1. 命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm --filter web run type-check` | 0 | `vue-tsc -b` + 两个 verification tsconfig 全过 |
| `pnpm --filter web run lint` | 0 | 项目 lint glob（含 `src/App.vue`）0 error 0 warning |
| `npx eslint`（我改到的、glob 外的 10 个文件） | 1 | **0 error**；5 warning 全在 `StockPreparationWorkspace.spec.ts:1547-1550` 的 `router-view`/`router-link` 桩，`git show 7eff1e8d2:` 里已存在，非本波引入 |
| 下述 12 个 spec | 0 | 全部通过 |
| `playwright test --config playwright.stock-prep-verification.config.ts` | 0 | **29 passed**（本机装了 chromium，真跑） |
| `node --test scripts/ops/stock-prep-browser-ci-wiring.test.mjs` | 0 | 6/6，含 classifier 对导入闭包的游走 |

单跑（退出码均 0，2026-09-10 终审复跑重新核对过一遍，见文末新增一节）：`StockPreparationGettingStarted` **67** / `StockPreparationDataSourceRegistry`（新增）**33** / `StockPreparationWorkspace` **55** / `StockPreparationInstallView` **29** / `StockPreparationSourceBinding` **9** / `StockPreparationOnboardingReadiness` 40 / `stockPrepPermissionMatrix` 24 / `IntegrationWorkbenchView` 55 / `dataSourcesPanelEmbedded` 4 / `dataSourcesRouteRedirect` 11 / `integrationWorkbenchSectionLanding` 12 / `StockPreparationCodeHelp` 13。（`StockPreparationHelpCard` 无自有 spec，单跑 exit=1 是 "no test files found"；其文案由整壳渲染覆盖。全量 web 测试本机有既有噪音，以 CI 为准。`StockPreparationInstallView` 与 `StockPreparationSourceBinding` 两个数原稿写错/漏写，已按终审复跑的实测数改正。）

## 2. 新增/改动的测试

`tests/StockPreparationDataSourceRegistry.spec.ts`（新文件 33 例，D1–D7）：SQL 类型过滤（http/plm 不计入 `sqlCount` 但仍计入 `totalCount`）、`absent` 与 `unknown` 分家、值无关反向断言（塞进连接名/主机/库名/端口/账号/邮箱，投影只剩 `{state,sqlCount,totalCount,status}`）、路由字面量 + 无 query + 无 write method + `suppressUnauthorizedRedirect`、只发一次请求且不是 `/test|/schema|/select|/preview`、永不 reject。

`tests/StockPreparationGettingStarted.spec.ts` 新增/改写 9 例：七步顺序；进度 0/7→4/7→5/7；`①a comes from the registry read and ①b from the binding envelope — all four combinations`；`①a's evidence is a COUNT scoped to this account, and ①b's names which road the bindings took`；`①a's read is issued once on mount and never auto-probes the customer database (D6)`；`①b has its own row, its own link into the SAME section, and names「新增连接草稿」`；双语对；`a caller who cannot open 数据工厂 gets both sentences and NEITHER link`；`the link gate is FAIL-CLOSED for BOTH halves when the prop is genuinely absent`（变基后的真实用例名，spec :1330 —— 终审加入 F06/item 5 的四个新用例后行号从 :1228 下移到此，已按当前文件核对）。

`tests/StockPreparationWorkspace.spec.ts` 门 pin（新 describe `gate alignment: nav, route and workbench answer with ONE predicate`，4 例）：11 个主体一个结论四个读法——导航谓词 / 工作台谓词 / 真实 `/stock-prep` route meta 过真实守卫适配器，且分别用「全允许」与「全拒绝」两种 app-wide 探针各跑一遍，所以结论必须来自 principal 而不是探针；另钉探针只对三个 stock-prep 码改判、其余逐字节委派、snapshot 取不到时 fail-closed。

`tests/stockPrepPermissionMatrix.spec.ts`：F-03 四行期望值 `redirect/allow/allow/allow` → `allow/redirect/redirect/redirect`；F-07 改钉 `canReachStockPrepWorkbench(getAccessSnapshot())`，并**负向**钉住 `hasPermission(STOCK_PREP_ROUTE_PERMISSION)` 不得出现。

## 3. 变异表（内存变异，跑完即还原，未落盘）

| 变异 | 退出码 | 变红 |
|---|---|---|
| M1 从 step order 删掉 ①b（地图折回一行） | 1 | 12 failed / 63 |
| M2 删掉整个 ①b 提示块（行 + 链接 + denied 节点） | 1 | 5：①b 自有行/自有链接、双语对、denied 两态、基分支 ①a denied 例 |
| M3 ①a 改回从 binding 信封推导（取消拆分） | 1 | 2：四组合、进度 |
| M4 放开 ①a 链接的 `canOpenDataFactory` 门（`v-if="true"`） | 1 | 5：denied 四例 + fail-closed |
| M5 守卫适配器改回 `deps.auth.hasPermission` | 1 | 2：门 pin + F-03 |
| M6 导航谓词改回 `hasPermission('stock-prep:read')` | 1 | 1：F-07 |
| L1 P0-05 步数断言改回 6 | 1 | P0-05（浏览器道） |
| L2 `/api/data-sources` 夹具路径指向不可达值 | 1 | P0-05 的 `expectNoUnmockedRoutes` |

M2/M4 第一版删 `<a>` 导致 `v-else` 失配、模板编译失败（"no tests"）—— 那是编译错误不是断言证据；上表是改成可编译变体后的重跑结果。

## 4. 一个被既有守卫抓到的真问题

①a 英文文案初版写作 `— host, account and password —`，撞上 `shell copy is values-free` 守卫的 `FORBIDDEN_SUBSTRINGS`（`password`/`token`/`secret`/`connectionString` 等）。这条红是对的：点名凭据字段对读者没有增益，却把一个 secret 形状的词放上了屏幕。改为「填地址与登录凭据」/`its address and sign-in credentials`。

归因过程值得记：该红只在两个 spec 合跑时出现，我先做了「把门相关 4 个文件还原成基线字节再合跑」的归因探针，仍红，一度判成既有跨 spec 干扰——但那个探针没有还原向导拆分的文件，并不能洗清本波。改完文案后合跑 210/210 全绿，才确认根因是我自己的文案。

## 5. 门核对结论

分歧**存在**且两个方向都错。证据：`apps/web/src/composables/useAuth.ts:521-537` 的 `hasPermission` 展开 `${resource}:*`(L533)、`${resource}:admin`(L534)、`:write`→`:read`(L535)，并在 L526 用 `isAdmin` 短路，而 `isAdmin` 认 `*:*`/`admin:all`/`users:write`/`roles:write`/`permissions:write`(L330-336)；`workbenchAccess.ts:344` 的 `satisfiesStockPrepAccess` 字面匹配，`PLATFORM_ADMIN_PERMISSIONS = ['role:admin','integration:admin']`(L58)。分歧此前被写死在 `stockPrepPermissionMatrix.spec.ts` F-03 的四行注释里。

已修到一致（`workbenchAccess.ts` 新增 `canReachStockPrepWorkbench`、`router/guardPolicy.ts` 新增 `buildStockPrepAwarePermissionProbe`、`App.vue:169`），并由第 2 节的门 pin 钉住。四种展开主体严格收紧；`integration:admin` 那行由 redirect 改 allow 是唯一一处答案由 false 变 true，理由是服务端对该主体本来就答 true，客户端此前是在藏一个服务端已经在服务的页面——路由守卫不是安全边界，其后每条路由仍由服务端同一套阶梯把门。

## 6. 变基与冲突解决（afcf9e374）

基分支新增了同名 prop `canOpenDataFactory`（默认 false）与 ① 的 denied 态。三个 commit 重放，第一个（门对齐）干净应用，第二个冲突：

- **GettingStarted.vue**：prop 声明取基分支那份（删掉我的重复声明）；①a 的 denied 节点改用基分支的 `<span>` 与文案（点名 `integration:write` + 找实施）；①b 保留我的 testid，文案改成同一句式以成对；两套注释理由合并。
- **InstallView.vue**：git 自动合并出了**重复**的模板绑定与重复的 `const canOpenDataFactory`（会编译失败），人工去重，保留基分支那一处，并把它注释里单数的「向导① 的 LINK」改口为两条。
- **GettingStarted.spec.ts**：`Props` 与 `defaultProps` 同样自动合并出重复键，去重后采用基分支的 `canOpenDataFactory: false` 默认（比我原本的 `true` 诚实：`true` 会让一个丢掉整个门的组件在所有不提这个 prop 的用例里看起来都对），我那几个需要链接的用例改为显式传 `true`；两边用例全保留，断言按合并后的 DOM 改写（①a denied 改成断言 `integration:write`/`实施`）。基分支的 fail-closed 例（传 `false`）与我的（真的把键删掉）并存，后者严格更强。

**浏览器验收道（CI #5594 红的那项）**：两类失败都是 ① 拆分的直接后果。一是夹具没覆盖 `GET /api/data-sources`（①a 的新读），而夹具的 catch-all 把未模拟路由当失败而不是放行，所以每条 `expectNoUnmockedRoutes` 都红；已在 `ROUTES` 表（它就是这条道的「已覆盖路由清单」）里补上，并按场景分三态（`fresh` 0 条 / `readerOnly` 403 / 其余 1 条 sqlserver），让 ①a 的 done/held/unknown 三个分支都有人走。二是 P0-05 还期望 6 个步骤元素与「/6」进度，改为 7 与「/7」。未增删任何用例：`--list` 仍是 29 tests in 2 files；workflow 的 classifier 也无需改，新文件 `dataSourceRegistry.ts` 落在已有的 `services/integration/stockPreparation/*` 通配里。

**一条事实注记（避免把 fail-closed 读得比实际大）**：`main.ts:119-136` 外层那个 `try { … } catch { /* If guard fails (network/offline), don't block navigation. */ }` 是**既有结构**，本 PR 没碰它——守卫整体仍然是 fail-OPEN（抛异常就放行）。本 PR 新增的 fail-closed 只覆盖**快照读取**这一步：`buildStockPrepAwarePermissionProbe` 在 `getAccessSnapshot()` 抛异常时对三个 stock-prep 码答 false，而不是回退到更宽的探针。

**pin 文件**：未触碰任何被 `sealed-export-package-provenance` 钉住的文件：该清单只覆盖 `plugins/plugin-integration-core/lib/**` 的 `.cjs` 与 `migrations`，本波改动全在 `apps/web/**` 与 `docs/**`，故无需重打 pin、无需 66 项 LF 字节校验。

## 7. 终审修复（2026-09-10，额度中断后收尾）

上一轮代理在跑到本节列的第 6 项时被中断，改动留在工作区未提交。本节是收尾轮，逐条核对终审提出的六项必修并补完半截项。

1. **InstallView.spec 六步→七步**：`apps/web/tests/StockPreparationInstallView.spec.ts` 里对 `[data-testid="stock-prep-getting-started-step"]` 数量的断言已由 6 改为 7（配注释说明「①拆分」多出一行）。核对：`StockPreparationGettingStarted.vue` 的 `stepOrder` 确实是 `STOCK_PREP_GETTING_STARTED_STEP_ORDER`，7 个 key（`source-register`/`source-connect`/`source-verify`/`source-bind`/`install-tables`/`grant-access`/`first-project-run`）——断言与实现一致。

2. **夹具与 p0 spec 七步**：`apps/web/verification/stock-prep-p0-acceptance.spec.ts:177-178` 已断言 `toHaveCount(7)` 与 `/7`（本项在更早的 commit 里已落地，本轮工作区无改动，仅复核确认未回退）。

3. **F06 旧式桥接部署 ①a/①b 不适用 + `requiredKind` 信封**：`sourceBinding.ts` 新增 `STOCK_PREPARATION_LEGACY_BRIDGE_KIND`；`StockPreparationSourceBindingPanel.vue:282` 把 `view.value.effectiveSourceKind` 投影进 `StockPrepGettingStartedBinding.requiredKind`；`gettingStarted.ts` 的 `stockPrepGettingStartedSteps`/`stockPrepGettingStartedEvidence` 在 `requiredKind === STOCK_PREPARATION_LEGACY_BRIDGE_KIND` 时把 ①a/①b 判 `done` 而非 `held`/常规判定，并给出「不适用」证据；`StockPreparationGettingStarted.vue` 新增 `isLegacyBridgeDeployment` 计算属性 + 一条替代提示块，原 ①a/①b 提示块加 `!isLegacyBridgeDeployment` 门。类型链核对：`StockPrepGettingStartedBinding.requiredKind: string | null` 与 `view.value.effectiveSourceKind: string | null` 类型对齐，`publishBinding()` 走 `defineEmits<{ (event: 'binding-read', binding: StockPrepGettingStartedBinding | null): void }>()`，编译期即会拦住漏传。测试：`StockPreparationGettingStarted.spec.ts` 新增「legacy-bridge 不适用」正例 + 「data-source 道不受影响」反例，`binding()` 夹具默认 `requiredKind: 'data-source:sql-readonly'`。

4. **DataSourceRegistry 加进必过清单**：`apps/web/scripts/run-required-web-tests.sh` 的必跑 token 列表里加入 `StockPreparationDataSourceRegistry`（核对：仅出现 1 次，未与其它 token 产生子串碰撞）。

5. **①a 对 403 指明缺 `data_sources:read`**：`StockPrepGettingStartedRegistry` 新增 `status: number | null` 字段，`GettingStarted.vue` 的 `derivationInput` 把 `dataSourceRegistry.value.status` 原样透传（不新增任何值）；`gettingStarted.ts` 的 `stockPrepGettingStartedEvidence` 在 `state === 'unknown' && (status === 401 || status === 403)` 时返回「看不到外接数据源清单(需要 data_sources:read),请找实施确认」，其余 `unknown`（含 500）保持空证据。测试新增两例：403 给出理由、500 保持空白；以及 403 + `canOpenDataFactory: false` 的整卡叙事一致性断言。核对 `dataSourceRegistry.ts` 里 `status` 字段与 `stockPrepDataSourceRegistryUnknown(status)` 为既有代码，未被本波改动，只是被消费。

6. **文档/注释订正**（本节要收的尾，逐条列实际改动）：
   - `StockPreparationGettingStarted.vue`：模板顶部残留的 `<!-- THE SIX-STEP MAP. ... -->` 注释改为 `THE SEVEN-STEP MAP`（标题/进度条/intro 早已是「七步」「/7」，唯独这条模板注释没跟上，属于半截未完成项）。
   - `StockPreparationGettingStarted.spec.ts`：同名两处遗留注释（文件头 `— the six-step map's DOM half.` 与 `// The six-step map itself` 分节注释）同步改为「seven-step」。
   - `StockPreparationWorkspace.spec.ts:379-381` 与 `stockPrepPermissionMatrix.spec.ts:200-203` 附近的"不实注释"：核对后确认**上一轮代理已经改完**——前者已删去对 `App.vue` 的错误 pin 声明并改指向 F-07，后者已把「`probe()` 仍驱动 F-03 的路由守卫、本波未改」的过时说法改成「`buildStockPrepAwarePermissionProbe` 现在从 principal 直接回答三个 stock-prep 码、`probe()` 被有范围地绕过」。本轮未再改动这两处，只做了核对（`grep F-07` 确认 `stockPrepPermissionMatrix.spec.ts:390` 确有该用例，`grep canReachStockPrepWorkbench App.vue` 确认其断言与源码一致）。
   - 设计文档 `-design-20260910.md`：已有「对齐的是四面，不是三面」一段指出 `MyAppsLandingView.vue:149` 的卡片可达性判定也走 `buildRouteGuardContext`，并说明这一面**没有 pin**（本轮核对该行号：`MyAppsLandingView.vue:144-155` 的 `isEntryReachable` 函数确实在第 149 行调用 `buildRouteGuardContext({ auth, flags })`，失败走 `catch { return true }`，即 fail-OPEN 显卡——与文档描述一致，未改动）。
   - `guardPolicy.ts:126-134` 与设计文档 :52 的"类型错误"表述：已从"漏传是类型错误"收窄为"两个有类型的 src 调用点（`main.ts`、`MyAppsLandingView.vue`）漏传时编译不过"，并加一段"SCOPED CLAIM"说明测试 harness 手搭 deps 字面量不受类型约束、真正兜底靠运行时 fail-closed。本轮核对：两个调用点行号 `main.ts:129`、`MyAppsLandingView.vue:149` 均实测为 `buildRouteGuardContext({ auth, flags })` 调用，未改动，仅核对准确。
   - 验证记录本身（本文件）：第 17 行 `StockPreparationInstallView` 的用例数从错误的 `38` 改成实测 `29`，`StockPreparationSourceBinding` 从漏写的空白补成实测 `9`；第 23 行 `the link gate is FAIL-CLOSED...` 用例的行号引用从变基时的 `:1228` 更新为终审新增 4 例后的当前行号 `:1330`；新增了 `main.ts:119-136` 与 `getAccessSnapshot()` 的具体引用，补全此前留白的「事实注记」段落（原文是"外层那个 [ 空 ] 是既有结构"、"在 [ 空 ] 抛异常时"两处占位符未填的半截句）。

### 命令与退出码（本轮，2026-09-10 05:1x-05:2x，本机 Windows）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm --filter web exec vitest run tests/StockPreparationGettingStarted.spec.ts tests/StockPreparationInstallView.spec.ts tests/StockPreparationWorkspace.spec.ts tests/StockPreparationDataSourceRegistry.spec.ts tests/stockPrepPermissionMatrix.spec.ts tests/StockPreparationOnboardingReadiness.spec.ts` | 0 | 6 files passed / 248 tests passed（跑了三遍确认稳定；其中一遍加 `--reporter=verbose` 时 `StockPreparationWorkspace.spec.ts` 里 `main.ts delegates guard decisions to guardPolicy` 单例超时 5000ms，退出码 1——单独重跑该用例 1958ms 内通过，判定为并发资源争用的偶发抖动，非本波改动引入，与该用例无关的文件本轮均未改动） |
| `pnpm --filter web run type-check` | 0 | `vue-tsc -b` + 两个 verification tsconfig 全过 |
| `pnpm --filter web run lint` | 0 | 项目 lint glob（不含本波任何改动文件，见下一行） |
| `npx eslint`（本轮工作区实际改动的 9 个源文件/测试文件） | 1 | **0 error**；5 warning 全在 `StockPreparationWorkspace.spec.ts:1553-1556` 的 `router-view`/`router-link` 桩（第 2 节已核实为既有代码，行号因本轮在文件更早处新增内容而从文档原记的 1547-1550 下移到 1553-1556），`--max-warnings=0` 使退出码非零，不代表新问题 |

**未做项**：无。终审六项必修逐条核对/补完，`git status` 中原 12 个已改文件全部保留（无一被撤销），未新增文件之外的改动。
