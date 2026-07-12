# 备料 MVP(历史 #3751)— 实体机(Windows on-prem)验收 corrective 弧 — 设计与验证记录 — 2026-07-10

> 承接 `stock-preparation-mvp-w3-w6-dev-verification-20260710.md`(W3-W6 代码侧完成)。本文记录
> **代码侧完成之后、实体机验收 PASS 之前**的 corrective 弧:每一轮实体机 dispatch 暴露的缺陷、
> 其根因、修复 PR、以及重发的验收包。**范围界定(审阅 P2)**:这些缺陷**由 Windows on-prem 验收
> 暴露,未改变产品 API / 业务运行面**——但修复的落点不全是 on-prem 专用工具链:#4084 改的是**共享的
> 迁移 provider**(`core-backend/src/db/migration-provider.ts`),#4068 改的是**共享的依赖清单**
> (`package.json` + lockfile);corrective-1/2/4 才是 on-prem 打包/部署脚本本身。**本文是记录,不是授权。**
>
> 执行/结论落点:历史 #3751 现已 404,**实体机验收统一在 #4101 追踪**(见 §5)。

## 0. 口径

- 备料 MVP 的 **runtime 代码**在 W3-W6 弧全部 MERGED(13 实现 PR),见前序 MD。
- 本弧的每个修复都由**实体机 dispatch 的 values-free 证据块**驱动(操作员只回贴迁移名/SQLSTATE/
  对象类型/失败类,无业务值),对抗审阅后落地,再重切包。
- **PASS 判据**:操作员回贴 `mvpSmoke.pass=true` + `auditActionsCovered=8/8` + `selfScanClean=true`。
  在此之前口径恒为「代码侧完成 + 验收进行中」,不称全线闭环。

## 1. corrective 轮次台账

| 轮 | 实体机证据(values-free) | 根因 | 修复 PR | 验收包 |
|---|---|---|---|---|
| corrective-1 | 首包 dispatch 前置检查 | on-prem 包缺 frozen-lockfile 前置/回滚安全 | (#4050 前序轮) | `…-corrective-20260710-94d0bb964` |
| corrective-2 | `resolvedPnpmVersion=other` · `failureClass=PNPM_VERSION_MISMATCH` | `corepack prepare --activate` **不写 shim**(仅 `enable` 写);apply helper 从 PATH 解析 pnpm → 撞 profile 影子 pnpm.cmd(他版本),fail-closed 拦停 | **#4061**(corepack 版本寻址 dispatcher wrapper `corepack pnpm@<pin> %*`;PATH 影子结构性无关)| `…-corrective2-20260710-d6489851d` |
| corrective-3 | Node 24 尝试为**未使用的原生 `bcrypt@5.1.1`** 构建,无兼容 prebuilt 二进制/工具链 → 安装失败 | 该原生依赖从未被运行时用到(运行时用可移植的 `bcryptjs`)→ **移除 `bcrypt` + `@types/bcrypt`**,并在包验证器加回归守卫(`verify_no_native_bcrypt_dependency`:必须保 bcryptjs、禁 native bcrypt) | **#4068**(`4290b08c5`) | `…-corrective3-20260711-4290b08c5` |
| corrective-4 | 交付管道深路径清理残留 | staging `node_modules` 清理 SYSTEM-safe(长路径/深嵌套) | **#4073** | `…-corrective4-…` |
| corrective-5 | `failedMigrationName=20250926_create_audit_tables` · `42P07`(duplicate_table)· `table` | 实体机先跑幂等孪生 `zz20251231_create_audit_tables.ts`(allowUnorderedMigrations 历史);同名更早的 raw `.sql` 后合入被当 pending 重放 → 裸 `CREATE TABLE audit_logs` 撞已存在对象 | **#4084**(`.sql` 名加入 `SUPERSEDED_LEGACY_SQL_MIGRATIONS` no-op 名单) | `…-corrective5-20260710-698acd918` |
| **corrective-6** | 迁移全过(`migration066=applied`,42P07 消失),但**后端启动即崩**、`/api/health` **502** · `failureClass=RUNTIME_DEPENDENCY_DECLARED_AS_DEV_ONLY` · `missingRuntimeModule=uuid` | `uuid` 只声明在 core-backend **devDependencies**,而 `WorkflowDesigner` / `BPMNWorkflowEngine` / `DelayService` 在**模块加载期**就 import 它 —— **`--prod` 安装跳过 devDependencies** | **#4126**(`6b5a6d90a`)= `uuid` → `dependencies` + **production-install 启动契约 guard** + guard 顺带挖出的 **express-validator fail-open 安全缺陷**(见 §6) | `…-corrective6-20260712-6b5a6d90a` |
| **corrective-7** | *(本地全量预演捕获,**未烧实体机一轮**)* — corrective-6 修好启动后,smoke 在 persist 停下:`500 VALIDATION_ERROR: Unknown fieldId: snapshotBatchId` | 模板用**逻辑键**、provisioning 派生**物理 fieldId**、records 服务**只认物理 id**,而备料**全部读写路径**把逻辑键当 fieldId 传、**从不调 `resolveFieldIds`**(33 次 createRecord/patchRecord,0 次 resolveFieldIds;两个读模块**完全绕过 scoped API**)→ **写入面从未在真实 multitable 上运行过** | **#4163**(`94f124ba4`)= 翻译收口进 `createTargetScopedRecordsApi` + **把测试 fake 改成像真服务一样拒绝未知 fieldId** | `…-corrective7-20260712-94f124ba4` |

> 说明:#4062 与 #4061 是并行的同修法,#4062 在审阅确认机制等价后作为 superseded 关闭。

## 2. corrective-5 根因与修复(本轮主体)

**拓扑**:core-backend 迁移 runner(kysely,`allowUnorderedMigrations: true`)对乱序历史的机器
放行"补跑仍缺失的迁移"。实体机的 audit 表由幂等孪生 `zz20251231_create_audit_tables.ts` 先建;
`20250926_create_audit_tables.sql`(裸 DDL、无 `IF NOT EXISTS`)对该机是 pending → 重放 → 42P07。

**修复(#4084,一条名单项,零吞错)**:`migration-provider.ts` 的 `SUPERSEDED_LEGACY_SQL_MIGRATIONS`
是**专为此类问题建的 no-op 机制**——名字保留可见(kysely 对跑过它的机器仍能校验历史),raw DDL
永不重放。三类机器矩阵**在真 PG16 + 真 provider + 真 kysely 0.28.8 上实证**(对抗审阅执行):

| 机器 | 结果 |
|---|---|
| 跑过 `.sql` 的(台账含该名) | `migrateToLatest` 0 pending / 0 error(no-op 保名过历史校验) |
| 实体机(跑过 zz、缺该名) | 恰跑 1 个 no-op 迁移盖戳,**零业务 DDL** |
| 全新安装 | 全量 257 成功 / 0 错误,`audit_logs.created_at=timestamptz` 证明对象来自孪生 |

**无全局吞错**:名单是**名字精确匹配**,无模式匹配;42P07 对任何名单外迁移仍 fatal。

## 3. 孪生超集性 — 诚实差异记录(审阅 P3-1)

孪生 `zz20251231_create_audit_tables.ts` 覆盖 `.sql` 的对象,但**非字面同构**,双 fresh DB 全 catalog
diff 实测三处差异(均已缓解,记录于此以免后续误判):

1. **16 个时间戳列 `TIMESTAMP` → `TIMESTAMPTZ`**:舰队双模;孪生 2026-01 落地时既有,非本轮引入。
2. **分区策略**:`.sql` 硬编码 2025_01-03 三个月分区 → 孪生仅建当月动态分区(带 `IF NOT EXISTS`
   守卫)。运行时由 `AuditRepository.ensureCurrentMonthPartition` 插入时自愈,不缺分区。
3. **`audit_logs_archive` 二级索引**:孪生路少 11 个(`LIKE INCLUDING ALL` 语句顺序差异)。冷归档表,
   无按非 PK 列过滤的代码读者,纯性能项 → 拆 follow-up 后补(非验收阻断)。

## 4. 实体机操作(corrective-5 包)

1. 下载 `…-corrective5-20260710-698acd918.zip` + `SHA256SUMS` + 匹配 bootstrap sidecars,核校验和。
2. 经 release-sidecar `.bat` 装(勿手拷、勿 `--no-frozen-lockfile`)。
3. 依赖前置检查(pnpm 现由 corepack dispatcher 定版,`resolvedPnpmVersion=9.15.9` 应 PASS)。
4. **migration 066**(备料审计表)+ **迁移基线**(20250926 现为 no-op,42P07 应消失)。
5. PM2 重启 + 健康检查。
6. 打包内 values-free smoke:`METASHEET_AUTH_TOKEN=<admin> node scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs --base-url http://localhost:<port>`。

**应急续跑杠杆(≠ 验收路径,审阅 P1)**:实体机设 `MIGRATION_EXCLUDE=20250926_create_audit_tables`
可**临时**越过该迁移继续下游步骤,但**它不是正式 PASS 的等价路径**。机制上 `MIGRATION_EXCLUDE`
把该迁移**整个从 provider 返回集剔除**(`migration-provider.ts` 的 `!excludedNames.has(name)` 过滤)
→ kysely **从不写 ledger 戳**;而 corrective-5(#4084)的 no-op 超越是**保名跑 no-op → 写 ledger 戳**,
这才是**永久**解除。后果:设了变量续跑的机器,日后**移除该变量并仍运行旧 provider(#4084 之前)**,
20250926 会**再次**成为 pending → **42P07 复发**。
**正式验收要求(不可省)**:装 **corrective-5 包**,并在**不设 `MIGRATION_EXCLUDE`** 的情况下完成
迁移(20250926 走 no-op 盖戳)+ smoke。`MIGRATION_EXCLUDE` 仅用于现场应急,且仅对**台账不含该名**的
机器安全(实体机正属此类);台账**含**该名的机器设此值会 fatal(`corrupted migrations: … is missing`)。

## 5. 状态与范围边界(审阅纠正)

**本文的关闭范围 = W3-W6 on-prem 包的 *runtime 验收* 弧,不是整个 #3751 epic。** 明确划界:

- **runtime 验收余项(本文范围内)**:实体机装 **corrective-7** 包跑 smoke 回贴 `mvpSmoke.pass=true` +
  `auditActionsCovered=8/8` + `selfScanClean=true`。此为**唯一的 runtime 验收余项**;PASS 后
  前序 W3-W6 MD 补 addendum,**W3-W6 on-prem 包 runtime 验收弧**闭环。
- **包保障(本文范围外,已 MERGED `458373d54`)**:#4086 是 #4084 之后的**包验证器增量**——两个 on-prem 包验证器
  都须强制 superseded audit marker 在场。它是独立的代码审阅/合并项,不被实体机 smoke 覆盖。
- **更广 follow-up(本文范围外,**已 MERGED** `c70595e72`)**:#4093(#3889 下的 PLM/ERP/K3 只读 feeder)
  已落地,验证记录见 `stock-preparation-readonly-source-feeder-dev-verification-20260712.md`。
  **本文不关闭整个功能 epic。**

**执行与结论落点(审阅 P2 — 历史 #3751 现已 404,引用不可执行)**:功能 issue #3751 当前返回
404(历史 #3751,不可回填)。**实体机验收的执行、values-free 回贴、PASS 结论一律落到 #4101
(实体机验收追踪单)+ 本 W3-W6 corrective 弧 MD**,不再指向 #3751。

因此:**「本线转全线闭环」是过宽表述,已收回。** 正确口径 = 实体机 smoke PASS 只结**已合并的
W3-W6 on-prem 包 runtime 验收弧**;#4086 包保障已 MERGED、#4093 只读 feeder 已 MERGED。

> **⚠️ 范围修订(corrective-6)**:本弧前五轮**未改产品运行面**(仅交付管道/迁移基线)。
> **corrective-6 打破了这条**:它把 `express-validator` 的声明式校验从"**实际上没在跑**"变成"**真在跑**"
> —— 这是一次**真实的生产行为变更**(见 §6.3)。本文不再声称"runtime 产品面未因本弧改动"。

## 6. corrective-6 — 启动依赖 + 一条 fail-open 安全缺陷(#4126,`6b5a6d90a`)

### 6.1 崩溃与根因

corrective-5 之后,实体机迁移**全部通过**(`migration066=applied`,42P07 消失),但**后端启动即崩**、
`/api/health` **502**。values-free 证据:`failureClass=RUNTIME_DEPENDENCY_DECLARED_AS_DEV_ONLY`、
`missingRuntimeModule=uuid`。

**根因**:`uuid` 只声明在 core-backend 的 **devDependencies**,而 `WorkflowDesigner` /
`BPMNWorkflowEngine` / `DelayService` 在**模块加载期**就 import 它。**`--prod` 安装跳过 devDependencies**
→ 模块求值抛错 → 进程起不来。**开发机与 CI 都装 devDependencies,所以这个缺陷在仓内结构性不可见。**

### 6.2 修复不是"把 uuid 挪一下" —— 是一道**启动契约 guard**

只挪 `uuid` 只解决这一个 symptom;**下一个把 devDependency 写进启动路径的人会重演同一次 502**。
所以 #4126 立了 `tests/unit/runtime-dependency-classification.test.ts`:从 `src/index.ts` 出发,
用 **TypeScript AST**(不是正则)BFS 走遍启动图(**实测 343 个文件**),收集"**缺了就会让模块求值崩溃**"
的**硬 eager** 说明符 —— 每一个都必须是 core-backend 或 workspace root 的**生产依赖**,
否则必须是 `OPTIONAL_SOFT_DEPENDENCIES` 上的**显式例外**。

**例外由三把锁绑定**(缺一不可):

| 锁 | 作用 |
|---|---|
| **site** | 该模块只能在**那个精确文件**里 eager |
| **occurrence 计数** | 恰好一次 —— 同文件内**再加一个**裸 import 即失败 |
| **loader 形状** | 那唯一一次调用**必须落在一个会吞错的 `catch` 的 `try` 块里**;rethrow 的 catch / 无 catch 的 try-finally / 写在 catch·finally 里的调用 / finally 里有 throw —— **一律算未加守卫** |

**guard 的演进本身就是证据**(每一轮都是**实证**出来的真逃逸,不是推演):
逐行 regex → 整文件 regex → TypeScript AST → try-aware 遍历 → 「所有顶层 require 皆硬 + 显式 allowlist」
→ site-exact + 计数锁 → **取消 occurrence 折叠 + 形状锁**。

> 最后一轮的逃逸值得记:occurrence 在分类**之前**就被 `module@@file` **折叠**了,而例外键**也是**
> `module@@file` —— 于是在**已豁免文件内部**再加一个裸的顶层 `import 'js-yaml'`,会被折叠掉、
> **直接继承豁免**。旧 head 上实测 guard **全绿**。教训:**去重发生在判定之前,就等于把判定的输入删掉了。**

### 6.3 guard 顺带挖出的东西:声明式校验在生产里 fail-OPEN

guard 一上,`express-validator` 立刻被点名 —— 它**在任何地方都没声明**(连 devDependencies 都没有)、
也解析不到。追下去:

- `loadValidators()` 在 `catch` 里返回 **no-op 校验链**;
- `validate` 中间件在 `validationResult` 缺失时**无条件 `next()`**;
- ⇒ **workflow / workflow-designer / PLM 路由上的声明式校验,在包括生产在内的所有环境里,整体 fail-OPEN。**

**它不是"可接受的软依赖",不能用 allowlist 固化。** 修复:

1. `express-validator` → **生产依赖**(`^7.2.1`),移出例外名单;
2. **两个 loader 一律 fail-closed**:模块**缺失** → throw;**畸形/部分导出** → **也 throw**
   (否则交回 undefined 校验器,Express 会当成"**没有中间件**" —— **另一条路的 fail-open**);
3. **`createNoOpValidator()` 删除并钉死** —— 它返回的中间件**无条件 `next()`**,**就是那个 fail-open 原语本身**;
   修复后它已无调用者。**一个安全反模式的死导出,是留给下一个作者的邀请函。**

#### 一个必须记下的测试教训

第一版的"证明"是 `expect(source).toMatch(/throw new Error\(/)` —— **匹配源码文本**。
而两个 loader 里**各有两处 `throw`**,所以**把"模块缺失时抛错"那一处删掉、把 fail-open 放行恢复回去,
guard 照样全绿**(两个 loader 上都用 md5 验证的真实变异证实)。

> **一个名字叫「loaders are fail-closed」的测试,在 loader 已经 fail-OPEN 的情况下通过。**

而且别处也接不住:那几个路由测试把两个 loader 都 `vi.mock` 掉了;又因为依赖装上了,那个 `catch`
在测试期**根本不可达** —— **变异在行为上是惰性的,这正是它隐形的原因,不是偶然。**

**修法**:给两个 loader 开一条**可注入的模块解析缝**,让"模块缺失"这条分支**第一次真正可被驱动**;
断言改为**行为**(缺失 → throw · 畸形 → throw · **真模块仍能加载**,即 fail-**closed** 而非 fail-always)。

### 6.4 验证

- 独立 **exact-head 对抗审阅**:**APPROVE,0 P1**。它构造的所有逃逸(顶层 IIFE require / 调用一个会
  require 的 helper / 模板串说明符 / catch 里间接 rethrow)在**真实启动图上 occurrence 均为 0**;
  **独立** AST 扫描 353 个文件,**未发现第二个在启动期被 eager import 的 devDependency**;
  "343 文件"经插桩核实**恰为 343**。
- guard **9/9** · `tsc --noEmit` clean · 全量单测 **372 文件 / 5099 测试通过**(校验现在是**真在跑**的)。
- **guard 有 CI 牙**:required 的 `test (20.x)` 会跑到它(默认 include 覆盖 `tests/unit/**`,且不在 exclude 名单里)。

### 6.5 打包前置验证(**在包上实跑,不是读代码推断**)

fail-closed 有一个**必须正视的副作用**:**将来若打包漏了 `express-validator`,会变成一次启动崩溃**
—— 正是 corrective-6 要消灭的那类 502。因此 corrective-6 包在发给实体机**之前**,已在包上跑通:

| 检查 | 结果 |
|---|---|
| tarball SHA256 vs `SHA256SUMS` | **MATCH** |
| `pnpm install --prod --frozen-lockfile`(**模拟实体机生产安装**) | 成功,devDependencies skipped |
| 从 `packages/core-backend` 真 `require('uuid')` | **RESOLVED**,`uuid.v4()` 可用 |
| 从 `packages/core-backend` 真 `require('express-validator')` | **RESOLVED**,`body`/`param`/`query`/`validationResult` 齐全 |
| native `bcrypt` 是否复活 | **absent**(corrective-3 回归守卫仍成立) |

### 6.6 行为变更(如实告知,勿误认为回归)

声明式校验从"**其实没在跑**"变成"**真在跑**"。独立审阅逐个查过现有调用方(ID 都是真 `uuidv4()`、
无调用方发 `limit`、前端字面量联合与服务端 `isIn()` 白名单**逐字对应**)→ **现有调用方不会断**。

**残余**:以前能蒙混过关的**松散/遗留外部客户端**,现在会收到 **400**。**这是预期内的**——校验本就该在跑。

> 审阅同时诚实声明:**"5099 全绿"不能证明这一点**,因为路由测试把校验 mock 掉了。此处不做过度断言。

### 6.7 验收包

**Release**:`stock-prep-onprem-corrective6-20260712`
**包名**:`metasheet-multitable-onprem-v2.5.0-corrective6-20260712-6b5a6d90a`

**PASS 判据**(实体机回贴,**不贴业务值**):`mvpSmoke.pass=true` + `auditActionsCovered=8/8` + `selfScanClean=true`。
执行指引与证据落点:**#4101**。
## 7. corrective-7 — 备料的写入面从未在真实 multitable 上运行过(#4160 / PR #4163)

### 7.0 它是怎么被发现的:**本地把实体机那一轮整个演了一遍**

前六轮 corrective 的代价是**串行的**:每一轮都要等操作员在物理机上装完、跑到下一个坑,才知道下一个坑在哪。

corrective-6 发包**之前**,本轮改用**本地全量预演**替代"发包 → 等回贴":
真 Postgres → **全新空库** → `pnpm install --prod --frozen-lockfile`(**跳过 devDependencies**,即实体机 502 的那条路径)
→ `node dist/src/db/migrate.js` → 启后端 → **跑实体机将要跑的那个 smoke 脚本本身**。

结果分成两半:

**corrective-6 达成了它的目标** ✅

| 步骤 | 结果 |
|---|---|
| `--prod` 安装 | 成功(devDependencies skipped) |
| 全新库迁移 | **261 个,零错误**;**42P07 消失**;`066` 在;`audit_logs` 在 |
| **后端启动** | ✅ **`/api/health` → 200**(**502 崩溃循环消除**) |
| smoke:ensure / options-sync / plan | ok(9 张冻结表 · 19 个选项字段 · draft + 2 行) |

**但它一修好,就露出了后面那个从来没人看见过的洞** ❌

```
[smoke] sync persist -> 201: FAIL (http=500)
   → VALIDATION_ERROR: Unknown fieldId: snapshotBatchId
```

### 7.1 根因:逻辑键 vs 物理 fieldId

| 层 | 用的是什么 |
|---|---|
| **模板**(`stock-preparation-templates.cjs:627`) | **逻辑键** + 显示名:`field('snapshotBatchId', 'Snapshot Batch ID', …)` |
| **provisioning** | 按显示名建字段,派生**物理 id**:`'fld_' + sha1(projectId:objectId:fieldId)[0:24]`(确定性) |
| **multitable records 服务** | **只认物理 id**,两个方向都拒:写(`buildNormalizedPatch`)、读的 filter(`normalizeQueryFilters`);返回的行也是物理键 |
| **备料写入路径** | **把逻辑键直接当 fieldId 传**,且**从不调 `resolveFieldIds`** |

**影响面是整条链,不是单点**(真库实测):

| 模块 | createRecord/patchRecord | resolveFieldIds |
|---|---|---|
| `stock-preparation-sync-run-persist.cjs` | 6 | **0** |
| `stock-preparation-confirm-writes.cjs` | 11 | **0** |
| `stock-preparation-generation-runtime.cjs` | 10 | **0** |
| `stock-preparation-table-actions.cjs` | 6 | **0** |
| **`stock-preparation-confirm-reads.cjs` / `snapshot-reads.cjs`** | **完全绕过 scoped API** | **0** |

**读路径更阴**:逻辑键的 filter 会被**拒绝**;而按逻辑键去读物理键的行,**每个格子都是 `undefined`** —— **不报错,直接读到空**。

**同插件的其他模块全都用对了**(`option-sync` / `mvp-provisioning` / `erp-feedback` / `target-provisioning` 均调 `resolveFieldIds`)→ **这是遗漏,不是设计。**

### 7.2 为什么几十个绿测一个都没抓到

> **所有写入路径的测试都注入了 fake `recordsApi`,而 fake 接受逻辑键。真服务不接受。**

这是教科书级的 **「mock 不是契约」**:测试证明的是"我们的代码调用了我们自己的假 API",**不是"它能写进真表"**。

`sync-run-persist.cjs:120` 的注释甚至写着「the records service rejects an unknown fieldId」——
作者**知道**这条规则,**但假定了逻辑键就是 fieldId**。**注释里写着的正确知识,和代码里做的错误假设,在同一个文件里并存了几个月。**

### 7.3 修法:把翻译收口到唯一入口 + 让 fake 像真服务一样严格

1. **翻译绑在 `createTargetScopedRecordsApi` 内**(所有备料读写的**唯一收口**)——写(`data` / `changes`)· 读(`filters` **以及返回行的键反向翻回逻辑键**;`id`/`version` 不动以保 `patchRecord({recordId})` 可用)· **未知逻辑键 fail-closed**(绝不静默丢弃 —— 静默丢弃 = 又一个"绿着的谎")。
   **让"漏调 `resolveFieldIds`"结构上不可能再发生**,而不是逐个函数补一遍。
2. **把测试的 fake 改成"像真服务一样拒绝未知 fieldId"** —— **改完之后,不修代码的旧实现立刻 6/12 变红**。
   **这一步才是本次修复真正的价值**:否则同一类缺陷会再次全绿通过。

### 7.4 验证

**真服务端 end-to-end(不是 mock)**:全新库 → `pass=true` · `auditActionsCovered=8/8` · `selfScanClean=true`;
行**真的落进 Postgres**:2 batches / 4 lines / 6 mappings / 4 exceptions / 4 runs / 2 unit rules。

**独立对抗审阅:APPROVE(0 P1 · 0 P2)**,并**补上了作者诚实标记为「未覆盖」的那条路径**——
smoke 的 fixture 让 generation 停在 `blocked`,**零 prep-line 行**,所以 prep-line 的写入面 live smoke 没覆盖。审阅用真库把它造了出来:

- **值落进了*正确的列***,不只是"某些列":**`designQty 7.03125 × factor 2 = issueQty 14.0625`** —— **列错位则乘法等式不成立**。
- **重跑 v1→v2、零重复行** —— 反证反向映射正确:`existingPrepLinesById` 按**逻辑键**索引,**没有反向映射,每次重跑都会复制整张表**。
- 字段 id **从 `meta_fields` 表读取**,而非用代码同一套 sha1 派生 —— **fake 给不了的「代码 ↔ 数据库」交叉核对**。

**攻击面证伪**:`pre_mapped` 旁路**不是洞**(HTTP 面注入 → `400 unsupported request field`;夹带裸物理 fieldId → `400`,库里 `PWNED` 计数 **0**);读的反向映射对未声明字段是**透传**(既不静默丢、也不泄漏物理 id)。

**mutation**:写翻译 / 读反向映射 / 三处 fail-closed(`data`·`changes`·`filters`)逐个删 → 分别变红;
**并补上了 `withTargetSheet` 的 403 围栏测试**(此前**零覆盖**)——它是"备料只写自己那 9 张表"的最后一道锁。
删掉那道 throw 只会让越界尝试变**静默**而非**成功**,但 **静默正是一个调用方漂到错误 sheet 上却没人发现的方式。围栏必须出声。**

### 7.5 这一轮真正的教训

**如果没有这次本地预演,corrective-6 的包会被装上实体机 —— 启动会好,然后在 persist 停下,白烧第七轮。**

> **能在本地重放的验收步骤,就不要用别人的物理机去发现。**
> 六轮 corrective 里,有几轮的缺陷本可以在发包前的一次全量预演中被同时抓出来。

**并且:一个 fake 如果比真依赖宽容,它保护的不是代码,是缺陷。**

## 8. ✅ 实体机验收 PASS(corrective-7,2026-07-12,真实 Windows 硬件)

操作员在实体机上装 corrective-7 包、跑 smoke,回贴 values-free 证据(#4101):

```
pm2RestartCommand=PASS
pm2StableOnline=PASS            ← 后端在真实硬件上稳定上线(corrective-6 的 502 崩溃循环消除)
postRestartHealthcheck=PASS
mvpSmoke.pass=true
mvpSmoke.auditActionsCovered=8/8
mvpSmoke.selfScanClean=true
failedCheckCount=0
repeatability=1/1
externalPlmK3ErpWrite=false    ← C4 硬闸守住:零未授权外部写
postSmokeStabilityCheck=PASS
```

**判据全数满足**:`mvpSmoke.pass=true` + `auditActionsCovered=8/8` + `selfScanClean=true`。

### 范围界定(owner 口径,不过度声称)

这**只闭合 corrective-7 的实体机 *runtime 验收* 弧** —— 即「备料 MVP 的 on-prem 包在真实 Windows 硬件上装得上、起得来、写读审计全链跑通、C4 外部写硬闸守住」。它**不**声称整个功能 epic 完成,也**不**覆盖真实 PLM/K3/ERP 外部系统的现场对接(`externalPlmK3ErpWrite=false` 正表明本轮不触外部写)。#4141 是独立的 corrective-6 guard governance lane,与本弧分开。

### 这条 corrective 弧的最终账(corrective-1 → 7)

| 轮 | 症结 | 落点 |
|---|---|---|
| 1-2 | frozen-lockfile 安全 · corepack pnpm 定版 | #4050 · #4061 |
| 3-4 | 移除未用的原生 bcrypt · 深路径清理 | #4068 · #4073 |
| 5 | 42P07 迁移 supersession(no-op 保名盖戳) | #4084(+ 包保障 #4086) |
| 6 | uuid 运行时依赖 + production-install 启动契约 guard + express-validator fail-open 安全修 | #4126 |
| **7** | **备料写入面从未在真实 multitable 上运行(逻辑键 vs 物理 fieldId)** | **#4163** |

**贯穿七轮的方法论沉淀(见 §7.5 与本文结尾两条)**:
- **corrective-6 与 7 是「本地全量预演」抓出来的,没烧实体机额外轮次** —— 能在本地重放的验收步骤,就不要用别人的物理机去发现。
- **一个比真依赖更宽容的 fake,保护的不是代码,是缺陷** —— 修 fake 让未修代码当场变红,比修代码本身更防回归。

**至此,备料 MVP 的 on-prem 包在真实硬件上的 runtime 验收弧闭合。** 余项均属独立线:#4169(测试 flake 修复的 retry-vs-根因取舍,owner 待决)· 真实外部系统现场对接(需现场数据/授权)· #4141 corrective-6 guard governance lane。
