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

- **runtime 验收余项(本文范围内)**:实体机装 corrective-5 包跑 smoke 回贴 `mvpSmoke.pass=true` +
  `auditActionsCovered=8/8` + `selfScanClean=true`。此为**唯一的 runtime 验收余项**;PASS 后
  前序 W3-W6 MD 补 addendum,**W3-W6 on-prem 包 runtime 验收弧**闭环。
- **包保障(本文范围外,已 MERGED `458373d54`)**:#4086 是 #4084 之后的**包验证器增量**——两个 on-prem 包验证器
  都须强制 superseded audit marker 在场。它是独立的代码审阅/合并项,不被实体机 smoke 覆盖。
- **更广 follow-up(本文范围外,仍 open)**:#4093(#3889 下的 PLM/ERP/K3 只读 feeder)与
  原始只读同步验收重叠,仍在开发。**本文不关闭整个功能 epic。**

**执行与结论落点(审阅 P2 — 历史 #3751 现已 404,引用不可执行)**:功能 issue #3751 当前返回
404(历史 #3751,不可回填)。**实体机验收的执行、values-free 回贴、PASS 结论一律落到 #4101
(实体机验收追踪单)+ 本 W3-W6 corrective 弧 MD**,不再指向 #3751。

因此:**「本线转全线闭环」是过宽表述,已收回。** 正确口径 = 实体机 smoke PASS 只结**已合并的
W3-W6 on-prem 包 runtime 验收弧**;#4086 包保障已 MERGED、#4093 只读 feeder 仍独立推进。runtime 产品面
未因本弧改动。
