# G09 验证:`integration:*` / `data_sources:*` 六码种子化(2026-09-10)

设计见 `integration-permission-codes-seed-design-20260910.md`。本机 Windows,**无本地 PostgreSQL**。

## 1. 改动文件

| 文件 | 性质 |
|---|---|
| `packages/core-backend/src/db/migrations/zzzz20260910120000_add_integration_permissions.ts` | 新增,种子六码 |
| `packages/core-backend/tests/unit/integration-permission-codes-seed.test.ts` | 新增,19 项 |
| `plugins/plugin-integration-core/app.manifest.json` | 新增 `platformPermissions` 键(`permissions` 数组**未动**) |
| `plugins/plugin-integration-core/__tests__/app-manifest.test.cjs` | 扩充:平台层对账 + 两词表不得互串 |
| `docs/development/takeover-beiliao-20260821/customer-delivery-guide-20260904.md` | 新增 §5-6 角色模板 |

## 2. 命令与退出码

| # | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/integration-permission-codes-seed.test.ts` | 19 passed (1 file) | 0 |
| 2 | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/platform-app-manifest-files.test.ts tests/unit/platform-apps-router.test.ts` | 27 passed (2 files) | 0 |
| 3 | `pnpm --filter @metasheet/core-backend run type-check` | `tsc --noEmit` 无输出 | 0 |
| 4 | `node plugins/plugin-integration-core/__tests__/app-manifest.test.cjs` | `✓ app-manifest: BOM备料 declared — 2 managed objects, 3 permission codes, …` | 0 |
| 5 | `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` | `sealed-export-package-provenance.test.cjs OK` | 0 |
| 6 | `node plugins/plugin-integration-core/__tests__/stock-preparation-permission-matrix.test.cjs` | 通过 | 0 |
| 7 | `node plugins/plugin-integration-core/__tests__/stock-preparation-handoff.test.cjs` | 通过 | 0 |

命令 #2 的意义:`platform-app-manifest-files.test.ts` 用**真实 zod schema 解析真实的 `app.manifest.json`**,
所以它绿 = 新增的 `platformPermissions` 顶层键不会让清单解析失败(未知键被丢弃,非报错)。
命令 #4 自报 **3 permission codes**,即应用自身词表未被扩大——这正是本次刻意保持的。
命令 #5 复核 `app.manifest.json` 不在溯源 pin 覆盖内,无需重打 pin(66 项 pin 未受影响)。

## 3. 变异表

全部为**内存变异,不落盘**:探针读真实文件,在内存里改副本,再要求同一个断言函数抛错。
M1–M5、M11 是测试文件里的**常驻用例**(每次 CI 都跑);M6–M10 是一次性探针脚本
(跑在临时目录,不入库)。

| # | 变异 | 期望 | 实测 |
|---|---|---|---|
| M1 | 从迁移 `VALUES` 里删掉六码中的**任意一个**(逐个试遍 6 次) | 对账抛 `enforced but never seeded` | 红 ✓ |
| M2 | 网关多出一个没被种子化的动作(`data_sources:truncate`) | 对账抛,指出该码 | 红 ✓ |
| M3 | 去掉 `ON CONFLICT (code) DO NOTHING`(改的是迁移**自己发出的真实 SQL**) | 第二遍抛 `duplicate key value` | 红 ✓ |
| M4 | 在 `up()` 里加 `INSERT INTO role_permissions … ('admin', …)` | 「零自动持有」守卫抛 `only seed permission rows` | 红 ✓ |
| M5 | 断言不空转的反证:对**已在**豁免名单里的资源(`multitable`/`workflow`/`approvals`/`admin`)求值 | 全部 `false` / `null` | 符合 ✓ |
| M6 | 网关多出 `integration:execute`,清单与迁移未跟进 | 清单对账 `codes mismatch` | 红 ✓ |
| M7 | 清单 `platformPermissions.codes` 删掉 `integration:admin` | `codes mismatch` | 红 ✓ |
| M8 | 整个 `platformPermissions` 键删除 | `platformPermissions missing` | 红 ✓ |
| M9 | `seededBy` 改指向 stock-prep 那支迁移(存在但没种这些码) | `integration:read not seeded` | 红 ✓ |
| M10 | 把 `integration:write` 塞进应用自身的 `permissions` 数组 | `leaked into app vocabulary` | 红 ✓ |
| M11 | 解析器射程反证:合成源里用**双引号 / 反引号 / 单参** `rbacGuard('data_sources:execute')` 六种写法 | 六个码全被解析出来;而**运行时拼接**(`rbacGuard('data_sources', action)`)解析为空 | 符合 ✓ |

M5 是给 §「两个命名空间仍受准入管控」那条断言做的反证:如果该断言恒真,它就证明不了任何事;
M5 证明同一个函数对豁免资源确实答 `false`,所以一旦有人把 `integration`/`data_sources` 加进豁免名单,
那条断言会红。M10 是给第 5 节那个判断做的守卫:防止后来者把平台层码并回应用词表,重新引入
「给一线的码讲错」的交付回归。M11 把对账的**射程**钉住:既证明四种合法写法都在射程内
(防止有人把正则改窄导致对账悄悄空转),也把「运行时拼接看不见」这条**残余风险**从注释里的
声明变成断言。

## 3.1 #5611 复核后的四处修改

| # | 修改 | 位置 |
|---|---|---|
| 1 | **删掉迁移排序断言**(`allowUnorderedMigrations: true` 使其零保护,却会把别人的迁移 PR 打红在 required check 上);换成「migrations 目录里必须有 `20250924190000_create_rbac_tables.ts`」这条有牙的目录证明 | `tests/unit/integration-permission-codes-seed.test.ts:276-288` |
| 2 | **两处绝对句收窄**为「以引号字面量写在这两个文件之内的门」,并把解析器放宽到三种引号 + 单参形式(见 M11) | `…seed.test.ts:81-110`、`…:130-141`;`app-manifest.test.cjs:212-222`;设计文档 `:74-80` |
| 3 | **`/data-sources` 方向订正**:挡住的是导航链接,路由 meta 无 `permissions` 键 | 指南 §5-6 末尾 |
| 4 | **「核对」段补前置**:改完必须重登(RBAC 缓存 60s,只有 admission 那半边失效缓存),且 `/me` 不是唯一裁判 | 指南 §5-6「核对」 |

## 3.2 与在飞 #5650 的解耦(2026-09-11 追加)

**问题。** `data_sources:*` 这张词表是**两支 PR 共有**的:#5650(G02 PR-1)新增迁移
`zzzz20260912120000_add_data_source_sharing_permissions.ts` 种子化 `data_sources:use|rotate|share`,
并把 `PUT /api/data-sources/:id/credentials` 的粗门从 `data_sources:write` 改成 `data_sources:rotate` 独占。
本文件原先把「代码里被强制的 `data_sources` 码集合」与「本迁移种子集」写成**等式**,
两支**无论谁先合**,组合态都会红;而 main 上没有合并前的组合态 CI,这个红会潜伏到
下一支碰 `packages/core-backend/**` 的 PR 才冒出来,打在无关作者头上。「后合者改一行」也不成立
(等式 + `assertSeedMatchesEnforcement` 两处都要动)。故在本支就把断言改成**双向子集**。

**断言形状(改前 → 改后)**,`tests/unit/integration-permission-codes-seed.test.ts`:

| | 改前 | 改后 |
|---|---|---|
| 词表 | `expect(enforced).toEqual([...DATA_SOURCES_PERMISSION_CODES].sort())`(等式) | 方向一 `:452` 本迁移六码**每一个**仍必须在路由文件里有门;方向二 `:456` 路由文件不得出现「本迁移六码 ∪ #5650 三码」之外的动作 |
| 可授予性 | `assertSeedMatchesEnforcement(seeded, enforced)` | `assertSeedMatchesEnforcement(seeded, enforced, grantableElsewhere)` `:473`,第三参**默认空**,只能放宽「被强制的码」一侧,永远不能豁免「本迁移种下的码必须被强制」 |
| 宽限来源 | — | `grantableElsewhere` = **写死的 #5650 三码** `:94`(该迁移在本支不存在,不能 import,故列出并注明来源 PR)**∩** `codesSeededByOtherMigrations()` `:126` 在 `src/db/migrations` 里真正扫到的 `INSERT INTO permissions` 码 |

两个集合取**交**是关键:光有清单等于白送三个码,光有扫描等于任何迁移种下的任何码都能开门。
交集使得「门先于种子上线」(G09 原 bug)在本支仍然红,而「三码之外的第七个动作」到哪儿都红。
扫描按**内容**而非文件名判断(342 个迁移顺序读、逐个丢弃,26ms),所以 #5650 那支改名也不会误红。

**本机组合态实跑**(内存/临时改写,跑完按备份逐字节还原,`git status` 只剩本次测试文件):

| 状态 | 构造 | 结果 |
|---|---|---|
| A 单独态 | 本支原样 | `19 passed (19)` ✓ |
| B 组合态 | `routes/data-sources.ts:716` 的门改成 `rbacGuard('data_sources','rotate')` **且**把 #5650 头(`10f79c95`)的迁移文件放进 `src/db/migrations/` | `19 passed (19)` ✓ |
| A' 还原 | 还原上述两处 | `19 passed (19)` ✓ |
| **基线反证** | **改前**的断言(`git show HEAD:…`)+ 组合态 B | `1 failed / 18 passed` ✗ —— 证明「不改就会红」不是推测 |

| # | 变异 | 期望 | 实测 |
|---|---|---|---|
| M12 | 组合态 B,把 `data_sources:rotate` 从 `:94` 的清单里删掉 | 方向二抛 | 红 ✓ `1 failed / 18 passed`,`expected [ 'data_sources:rotate' ] to deeply equal []` |
| M13 | 门已改成 `rotate`,但**不放**#5650 的迁移文件(门先于种子上线) | 对账抛 `enforced but never seeded` | 红 ✓ `1 failed / 18 passed`,`…ungrantable): data_sources:rotate` |
| M14 | 单独态,从迁移 `VALUES` 删掉 `('data_sources:write', …)` 一行 | 种子侧仍有牙 | 红 ✓ `5 failed / 14 passed`,`…ungrantable): data_sources:write` |
| M15 | 宽限只能单向:`assertSeedMatchesEnforcement(seeded, seeded∖{write}, ['data_sources:write'])` | 抛 `seeded but enforced nowhere` | 红 ✓(常驻用例 `:571-575`;同段 `:563-567` 钉住「空扫描 → rotate 仍红 / 有扫描 → 放行」这对夹子) |

M12/M13 合起来钉住宽限的**两个夹子**:少了清单红、少了真实种子也红。M14 证明加宽没有把
种子侧的牙拔掉。M1(逐个删六码)与 M2(`data_sources:truncate`)保持不变且仍红,M1 的断言
另行**收紧**为「错误信息里必须点名被删的那个码」——否则组合态下一条泛泛的
`/enforced but never seeded/` 可能被别的码满足,探针就空转了(`:544-550`)。

**本节未做**:没有把两支真合到一起跑(不 push / 不 merge / 不 rebase);组合态是把 #5650 头的
那一个迁移文件与那一行门改动搬到本支模拟出来的,#5650 自己的三个测试文件没跑;
#5650 若在合并前改动三码拼写或改动别的门,本节结论需重跑。

## 4. 交给 CI / 未做

- **真库重放**:本机无 PostgreSQL,`db:migrate` 跑两遍的真库幂等验证交给 CI 的 migration-replay 泳道。
  本机以「模型化 `permissions` 主键 + `ON CONFLICT` 语义」的内存模拟覆盖了同一性质(见 M3)。
- **222 上机验证角色模板**:§5-6 的三类角色模板尚未在 222 上按真实账号逐条实测;
  其中「一线只需两个 `stock-prep` 码」一条有 2026-09-08 的既有实测背书(角色 `stock-prep-operator`,
  目录/确认队列 200),`integration`/`data_sources` 两个命名空间的准入开关未实测。
- **`/data-sources` 入口与路由的门不一致**:按分工不在本次改动内,属在飞的 #5587。
  (方向已在指南 §5-6 订正:挡住的是**导航链接** `App.vue:70`,路由 meta 本身没有 `permissions` 键。)
- 未跑全量 `core-backend` 单测与前端套件;仅跑了与本次改动相关的上述七条。

## 5. 后续单(#5611 对抗复核提出,本次**不改代码**,仅登记)

1. **`POST /api/permissions/grant` 对受准入管控的码会报成功。**
   (`src/routes/permissions.ts:133`)授予确实入库,但随后被命名空间准入过滤掉,调用方拿到 200
   却得不到权限——本次新增的六个码同形,**另有约 15 个既有码同形**。这是平台级既有问题,
   不是 G09 引入的,修法应统一(要么授予时校验准入、要么返回体明确告知还差一步),
   不宜在本次单点改。指南 §5-6 已用「必须经角色授予 + 逐个开准入」把运维绕开这个坑。
2. **seed 类迁移的 `down()` 语义宜横扫统一。** 本次沿用 stock-prep/elearning 的既有做法
   (先删子表再删父表,连带删掉运维已授出的角色绑定)。是否应改成「仅在无引用时才删」
   属于跨全部 seed 迁移的口径问题,单改本支会造成两套语义并存,故未动。
3. **指南 :423「备料自己的路由由 `stock-prep:*` 独占判定」应收窄。** 该句过于绝对:
   `lib/http-routes.cjs` 里仍有备料路由走**旧有 action 门**而非备料码,已核实两处——
   `:7176` `stockPreparationProjectList` 用 `requireAccess(req, 'read')`、
   `:7197` `stockPreparationSnapshotBatchList` 用 `requireAccess(req, 'admin')`。
   结论方向不变(一线拿两个 `stock-prep` 码即可跑通已实测的主旅程),但「独占」二字需限定为
   「以 `stock-prep:*` 为门的那些路由」。按协调方要求本次仅登记,不改文字。
4. **给「投影里不得出现 `platformPermissions`」补一条钉子。** 目前该键靠 zod 顶层非 `.strict()`
   被丢弃(已由 `platform-app-manifest-files.test.ts` 间接覆盖:真清单解析通过),
   但**没有**一条断言直接钉住「`collectPlatformApps` 的输出/`/api/platform-apps` 响应里不出现
   `platformPermissions`」。若将来有人把该键加进 schema 或改成 passthrough,会静默泄进前端投影。
