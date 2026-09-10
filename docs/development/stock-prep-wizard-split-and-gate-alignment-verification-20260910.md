# 备料上手向导 ①拆分 + /stock-prep 门对齐 — 验证 (2026-09-10)

设计见同名 `-design-20260910.md`。本机 Windows，`pnpm install --frozen-lockfile --offline` 退出码 0。

## 1. 命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm --filter web run type-check` | 0 | `vue-tsc -b` + 两个 verification tsconfig 全过 |
| `pnpm --filter web run lint` | 0 | 项目 lint glob（含 `src/App.vue`）0 error 0 warning |
| `npx eslint`（我改到的、glob 外的 10 个文件） | 1 | **0 error**；5 warning 全在 `StockPreparationWorkspace.spec.ts:1547-1550` 的 `router-view`/`router-link` 桩，`git show 7eff1e8d2:` 里已存在，非本波引入，且该文件本来就不在项目 lint glob 内 |
| `npx vitest run`（下表 5 个 spec，一次跑） | 0 | **210 passed (210)** |

单跑：

| spec | 退出码 | 用例数 |
|---|---|---|
| `tests/StockPreparationGettingStarted.spec.ts` | 0 | 60 passed |
| `tests/StockPreparationDataSourceRegistry.spec.ts`（新增） | 0 | 33 passed |
| `tests/StockPreparationOnboardingReadiness.spec.ts` | 0 | 40 passed |
| `tests/stockPrepPermissionMatrix.spec.ts` | 0 | 24 passed |
| `tests/StockPreparationWorkspace.spec.ts` | 0 | 53 passed |

（`StockPreparationHelpCard` 没有自己的 spec，单跑 exit=1 是 "no test files found"，不是失败；它的文案由 `StockPreparationWorkspace.spec.ts` 整壳渲染覆盖。全量 web 测试本机有既有噪音，以 CI 为准。）

## 2. 新增/改动的测试名

`tests/StockPreparationDataSourceRegistry.spec.ts`（新文件，33 例，D1–D7）：SQL 类型过滤（postgres/postgresql/sqlserver/mysql 计入，http/plm 不计但仍计入 `totalCount`）、`absent` 与 `unknown` 分家、值无关反向断言（塞了连接名/主机/库名/端口/账号/邮箱，投影只剩 `{state,sqlCount,totalCount,status}`）、路由字面量 + 无 query + 无 write method + `suppressUnauthorizedRedirect`、只发一次请求且不是 `/test|/schema|/select|/preview`、永不 reject。

`tests/StockPreparationGettingStarted.spec.ts`（60 例，其中新增/改写 8 例）：
- `renders all seven steps, in order, before any button is pressed`
- `progress counts only 已完成 …`（0/7、4/7、①a 答 present 后 5/7）
- `①a comes from the registry read and ①b from the binding envelope — all four combinations`
- `①a's evidence is a COUNT scoped to this account, and ①b's names which road the bindings took`
- `①a's read is issued once on mount and never auto-probes the customer database (D6)`
- `①b has its own row, its own link into the SAME section, and names「新增连接草稿」`
- `①a and ①b render as a bilingual PAIR`
- `a caller who cannot open 数据工厂 gets both sentences and NEITHER link`
- `the link gate is FAIL-CLOSED: an omitted canOpenDataFactory renders the sentences without links`

`tests/StockPreparationWorkspace.spec.ts`（门 pin，新 describe `gate alignment: nav, route and workbench answer with ONE predicate`，4 例）：11 个主体一个结论四个读法（导航谓词 / 工作台谓词 / 真实 `/stock-prep` route meta 过真实守卫适配器，且分别用「全允许」和「全拒绝」两种 app-wide 探针各跑一遍）；探针只对三个 stock-prep 码改判、其余逐字节委派；snapshot 取不到时 fail-closed。

`tests/stockPrepPermissionMatrix.spec.ts`：F-03 四行期望值 `redirect/allow/allow/allow` → `allow/redirect/redirect/redirect`；F-07 改钉 `canReachStockPrepWorkbench(getAccessSnapshot())` 且**负向**钉住 `hasPermission(STOCK_PREP_ROUTE_PERMISSION)` 不得出现。

## 3. 变异表（内存变异，跑完即还原，未落盘）

| 变异 | 退出码 | 变红用例 |
|---|---|---|
| M1 从 step order 里删掉 ①b（地图折回一行） | 1 | 12 failed / 60 |
| M2 删掉整个 ①b 提示块（行 + 链接 + denied 注） | 1 | 4 failed：①b 自有行/自有链接、双语对、denied 两态 |
| M3 ①a 改回从 binding 信封推导（取消拆分） | 1 | 2 failed：四组合、进度 5/7 |
| M4 放开 ①a 链接的 `canOpenDataFactory` 门（`v-if="true"`） | 1 | 2 failed：denied 两态 |
| M5 守卫适配器改回 `deps.auth.hasPermission` | 1 | 2 failed：门 pin + F-03 |
| M6 导航谓词改回 `hasPermission('stock-prep:read')` | 1 | 1 failed：F-07 |

M2/M4 第一版是删 `<a>` 导致 `v-else` 失去配对、Vue 模板编译失败（"no tests"），那是编译错误不是断言证据；已改成保持可编译的变体重跑，上表是重跑结果。

## 4. 一个被既有守卫抓到的真问题

第一版 ①a 英文文案写成 `— host, account and password —`。`StockPreparationWorkspace.spec.ts` 的 `shell copy is values-free` 守卫把 `password` 列在 `FORBIDDEN_SUBSTRINGS`（连同 `token`/`secret`/`connectionString` 等），整壳渲染里出现该词即红。这条红是**对的**：点名凭据字段对读者没有增益，却把一个 secret 形状的词放到了屏幕上。文案改为「填地址与登录凭据」/`its address and sign-in credentials`。

值得记一笔的是我最初的归因走了弯路：这条红在两个 spec 合跑时才出现，我先做了「把门相关 4 个文件还原成基线字节再合跑」的归因探针，结果仍红，于是一度判成既有跨 spec 干扰——但那个探针没有还原向导拆分的文件，所以并不能洗清本波。改完文案后合跑 210/210 全绿，才确认根因是我自己的文案。

## 5. 门核对结论

分歧**存在**，且两个方向都错，证据：

- `apps/web/src/composables/useAuth.ts:521-537` — `hasPermission` 展开 `${resource}:*`（L533）、`${resource}:admin`（L534）、`:write`→`:read`（L535），并在 L526 用 `isAdmin` 短路，而 `isAdmin` 认 `*:*`/`admin:all`/`users:write`/`roles:write`/`permissions:write`（L330-336）。
- `apps/web/src/services/integration/stockPreparation/workbenchAccess.ts:344` `satisfiesStockPrepAccess` 字面匹配，`PLATFORM_ADMIN_PERMISSIONS = ['role:admin','integration:admin']`（L58）。
- 分歧此前被写死在 `apps/web/tests/stockPrepPermissionMatrix.spec.ts` F-03 的四行注释里（「narrowing the app-wide guard is a platform change, not a stock-prep one」）。

已修到一致（`workbenchAccess.ts` 新增 `canReachStockPrepWorkbench`、`router/guardPolicy.ts` 新增 `buildStockPrepAwarePermissionProbe`、`App.vue:169`），并由第 2 节的门 pin 钉住。四种展开主体严格收紧，`integration:admin` 那行由 redirect 改 allow——这是唯一一处答案由 false 变 true，理由是服务端 `satisfiesStockPrepAccess` 对该主体本来就答 true，客户端此前是在藏一个服务端已经在服务的页面；路由守卫不是安全边界，其后每条路由仍由服务端同一套阶梯把门。

## 6. pin 文件

未触碰任何被 `sealed-export-package-provenance` 钉住的文件——该清单只覆盖 `plugins/plugin-integration-core/lib/**` 的 `.cjs` 与 `migrations`，本波改动全在 `apps/web/**` 与 `docs/**`，故无需重打 pin、无需 66 项 LF 字节校验。
