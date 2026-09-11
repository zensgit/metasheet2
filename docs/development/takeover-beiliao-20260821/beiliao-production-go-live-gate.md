# 备料接管 · 生产上线门(草案 2026-08-22)

> **状态:DRAFT — 待 owner 裁定。** 本文是清单本身,不是通过证明。
>
> **立文缘由**:2026-08-22 的仓库盘点确认,"生产上线四层门"此前**只存在于会话与未提交的草稿中,仓库任何分支都没有这份清单**——即八项门槛没有文档、没有责任人、没有退出条件。本文把它写下来,结构照搬考勤线已实战验证的先例(`docs/attendance-production-go-no-go-20260211.md`、`docs/attendance-production-ga-daily-gates-20260209.md`、`docs/attendance-production-closure-report-20260221.md`)。
>
> **值域纪律**:本文及其后续证据面**不得出现**主机名 / IP / 口令 / authorityCode / appKey / 凭据,只指位置。

---

## 0. 范围

**上线对象**:某大客户生产备料系统接管进 MetaSheet(单客户)。
**在范围内**:备料主表及卫星表的读写、PLM 只读同步、历史迁移与双轨对账、按项目号切换。
**明确不在范围内**:任何 K3 外部写回(**永久禁止**,见 G-4);CRM / 派工 / 项目等后续需求(章程已封存)。

**前置事实(2026-08-23 复核后重写)**:
- 接管产出**已有 19 条合入 `main`**,未合入 2 条(#5067 所有权写守卫、#5117 合成源 fixture,均 26/26 全绿、MERGEABLE/CLEAN)。
- 客户现系统已知暴露:匿名可达的 `/erp/*` 写端点、明文凭据。**默认视为已泄露。**(唯一未过期的一条)
- 备料 pack **已有可执行安装入口**:四条路由注册在 `plugins/plugin-integration-core/lib/http-routes.cjs:132-136`(list / installs / dry-run / install,admin 门禁,pack 永不由请求提供),宿主侧 catalog 由 #5108 填在 `packages/core-backend/src/plugin-runtime-config.ts:95`。

> **两条前置事实曾长期为假。** 上文原写「`main` 上尚无接管代码」与「没有任何可执行安装入口」,自 #5100(`21a24b45a`)建档后**一次未改**,而 #5122 的「docs freshness pass」只保鲜了审批线的两份报告,**恰好漏掉了这份唯一决定 go/no-go 的文档**。这正是本文 §3(1) 自己规定的活文档纪律失守一次的记录——**保鲜必须覆盖判据文档,否则先保鲜的是最不需要保鲜的那份**。

**gate 备料的代码缺陷(2026-08-23,两条,不是一条)**:

1. **mapper 未接线** —— 源→`ext_` 的 mapper 已合入(#5118)但两条刷新路由只传 `installedFieldProperties`,从不传 `extFieldMapping`,生产代码里没有任何地方构造过一个。修复在 [#5126](https://github.com/zensgit/metasheet2/pull/5126)。

2. **pack 目标与 apply 目标互斥** —— 本文此前写「唯一一条」,**说少了这一条**,而且它此前不在任何账本里。
   - pack 的 `targetObjectId` **硬编码**为 canonical(`lib/stock-preparation-customer-pack.cjs:446` 取 `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId`),且 `targetObjectId` **不在 `PACK_KEYS`**(`:67`)里 —— 任何 pack、任何请求都改不动它。
   - apply 对同一个 objectId **无条件 403**(`lib/stock-preparation-table-actions.cjs:998-1005`,`STOCK_PREP_APPLY_SANDBOX_ONLY` / `prod_canonical`),在 policy 被读之前就拒;且 `objectId` 省略时**默认当作 canonical**,一样拒。
   - **两个集合不相交**:pack 只能把 `ext_` 列装到 canonical,apply 只能写非 canonical。于是 sandbox 目标上根本没有 `ext_` 列,安装账本按 `action.target.objectId` 查不到 → 可写 band 里没有 `ext_` → **mapper 刚算出来的值在写入前一层被静默丢掉**。
   - 影响:即使 #5126 合入,**合成数据也跑不出一个落表的 `ext_` 值**。最小修法是允许 pack 装到 `plm_stock_preparation_sandbox` 命名空间(复用 `lib/stock-preparation-target-provisioning.cjs:61-79` 已有的校验),约 1–2 天。

> 本条的教训与上一条同源:**"唯一"这种量化断言,写下时就该跑一次穷举去证否。** 上面那句「唯一 gate 备料的代码缺陷」是本文 2026-08-23 自己新写的,几小时后即被一次系统盘点推翻。

---

## 0b. 部署窗口开始前必须先量的一件事(跨线耦合,2026-08-23 新增)

**一次纯备料的部署,可能因为审批线的迁移而整体失败。**

`packages/core-backend/src/db/migration-provider.ts` 自己写明:**生产与 on-prem 的 `db:migrate` 既不用该排除清单也不用 `MIGRATION_EXCLUDE`,跑全部迁移**;而 kysely 把整条链包在**一个事务**里。

Lock-11 的两支迁移(`zzzz20260823050000_provision_zero_membership_active_users.ts`、`zzzz20260823100000_backfill_approval_instance_org_id.ts`)以 **`user_orgs` 恰好只有一个 distinct active org** 为前提,前提不成立即**抛错**(错误只报数量,不报是哪些)。

**后果**:目标实例若已有 ≥2 个 active org → 迁移抛错 → 整条链回滚 → `db:migrate` 退出 1 → **备料自己一行代码没错,部署照样失败**。

**退出条件**:在排定部署窗口**之前**(不是窗口里),对目标库量一次 distinct active org 数量并记录结果(values-free:只记数量)。数量 ≠ 1 时,先与审批线裁定处置,再排窗口。

**谁可推动**:运维 + 技术负责人。零客户依赖,今天就能做。

---

## 1. 门(G-1 … G-8)

每一项的默认状态是 **未达成**。只有填入证据链接且 owner 签字,才可标 PASS。

### G-1 备份与恢复演练
- **要求**:在与生产同构的环境上完成一次**真实恢复**演练——不是"备份任务在跑",而是"从备份把数据恢复回来并验证一致"。
- **退出条件**:一次演练记录,含:备份时点、恢复耗时、恢复后行数/校验和比对结果、演练执行人。
- **现状**:☐ 未达成(无演练记录)
- **谁可推动**:运维 + owner

### G-2 数据留存与租户删除
- **要求**:明确备料数据的留存期限;租户删除时数据如何处置(硬删 / 匿名化 / 归档),并有可执行路径。
- **退出条件**:留存策略written + 一次租户删除演练(合成租户)。
- **现状**:☐ 未达成
- **谁可推动**:owner(政策)+ 开发(执行路径)

### G-3 凭据轮换与端点封闭
- **要求**:客户现系统的全部凭据(明文 DB 口令、K3 授权码、钉钉 appSecret、SMB 域账号)**按已泄露处理**:轮换 + 重置 + 历史访问排查;匿名可达的 `/erp/*` 写端点封闭。
- **退出条件**:values-free 的轮换回执(逐项"已轮换/已重置"清单,不含任何值)+ 端点封闭验证(匿名请求被拒的证据)。
- **现状**:☐ 未达成 —— **本项是安全运营工作,不是工程工作,可与开发并行,且不应等待任何 PR。**
- **谁可推动**:owner + 客户 IT

### G-4 外部写入永久禁止的验证
- **要求**:上线态下,K3 Save/Submit/Audit 等外部写路径**不可达**;所有外部写开关 exact-literal `'true'` 才开,且全部处于 OFF。
- **退出条件**:开关清单逐项验证 OFF 的截图/日志(values-free)+ 一次尝试触发外部写被 fail-closed 拒绝的证据。
- **现状**:☐ 未达成(开关机制存在且默认 OFF,但缺上线态的逐项验证记录)
- **谁可推动**:运维 + owner

### G-5 SLO 与告警
- **要求**:定义备料关键路径的 SLO(至少:PLM 同步成功率与时延、备料表读写时延、对账任务成功率),并接上告警。
- **退出条件**:SLO written + 告警通道联通验证(一次人为触发的告警到达记录)。
- **现状**:☐ 未达成
- **谁可推动**:运维 + 技术负责人

### G-6 灾难恢复
- **要求**:主机 / 数据库不可用时的恢复路径与 RTO/RPO 目标。
- **退出条件**:DR 方案 written + 与 G-1 演练结果对齐的 RTO/RPO 实测值。
- **现状**:☐ 未达成
- **谁可推动**:运维 + owner

### G-7 权限运行时强制(App Center)
- **要求**:备料作为应用入口时,**服务端与前端双侧**权限过滤生效,不出现"无权用户可见但打不开的假入口"。
- **四个前置(源:`docs/development/stock-preparation-generalization-and-scenario-packaging-proposal-20260717.md` §5.3 P1),2026-08-22 核实全部未达成;④ 已于 2026-09-11 达成,①②③ 仍未达成**:
  | # | 前置 | 现状 | 证据 |
  |---|---|---|---|
  | ① | 一个插件可注册多个子应用 | 未达成 | `packages/core-backend/src/platform/app-registry.ts` 每插件只收一个 manifest |
  | ② | manifest 支持 `requiredPermissions` | 未达成(字段名口径待定) | 全部 `app.manifest.json` 零匹配 `requiredPermissions`;实际落地的字段叫 `permissions`(`packages/core-backend/src/platform/app-manifest.ts:253`),四个 manifest 均已声明,④ 消费的就是它 —— 是否就以 `permissions` 认定 ② 达成,留给 owner |
  | ③ | 功能 / 就绪态声明 | 未达成 | 全部 manifest 零匹配 |
  | ④ | 服务端 + 前端双侧权限过滤 | 已达成(2026-09-11),但留有**两类未消除的可见性/可达性失配**(方向相反),见下「④ 的残留」 | 服务端 `packages/core-backend/src/routes/platform-apps.ts:67` `canSeePlatformApp` —— `:139` 过滤 `GET /`、`:190` 无权则 404(与"不存在"同体同文,无 existence oracle);前端 `apps/web/src/composables/usePlatformApps.ts:444` `isPlatformAppAccessible` / `:458` `accessibleApps`,由 `views/PlatformAppLauncherView.vue:116` 与 `views/PlatformAppShellView.vue:221` 共用 |
- **④ 的口径与双侧同形**(2026-09-11,PR 内替 owner 预设,可否决):任一命中即可见(manifest 的 `permissions` 是"这个应用用到的码",不是"全都要有");平台管理员旁路 —— **注意两侧并不同形**(2026-09-11 终审):服务端集合是 `role=admin` / `roles` 含 `admin` / `*:*` / `users.is_admin`(`routes/platform-apps.ts` 的 `isPlatformAppAdminRequest`),浏览器侧 `useAuth().isAdmin` 还额外把 `admin:all` / `users:write` / `roles:write` / `permissions:write` 算作管理员。方向是"前端更宽",而列表由服务端先过滤,所以更宽的一侧造不出假入口;但"双侧同形"这句话只适用于**权限码代数**,不适用于 admin 旁路。;`permissions` 为空数组的 app 视为公开(四个内置 app 均非空,只影响未来的 app),声明了但规范化后为空(`[""]`)则 fail-closed;`GET /:appId` 无权返回 404 而非 403。两侧跑同一套代数:`packages/core-backend/src/auth/permission-match.ts` 与 `apps/web/src/utils/permission-match.ts`(后者被 `composables/useAuth.ts#hasPermission` 复用),由同一张真值表 `packages/core-backend/tests/fixtures/permission-match-truth-table.json` 钉住 —— 单侧改动会让另一侧的测试变红,因此"服务端藏了前端还显示"这类假入口有测试兜底。  **同形机制的准确说法**(2026-09-11 终审实证订正):同形靠 `packages/core-backend/tests/fixtures/permission-match-truth-table.json` 这一张真值表;改任一侧的实现而**不**改真值表,变红的是**那一侧自己**的用例(实测:删掉后端 `resource:admin` 覆盖非 admin 动作那条规则 → 后端 3 红、前端仍 61 绿);改真值表则另一侧也红。两者合起来才使"单侧漂移无法悄悄落地"成立 —— 早先"单侧改动会让另一侧变红"的说法不准确。
- **④ 的证据**:`packages/core-backend/tests/unit/platform-apps-router.test.ts`(22 用例,含无权账号列表不含该 app / 详情 404 与"不存在"同体 / 任一码即可见 / admin 四种旁路 / 空声明公开 / 无权时不发实例查询)、`packages/core-backend/tests/unit/permission-match.test.ts`(34)、`apps/web/tests/permission-match-parity.spec.ts`(61)、`apps/web/tests/platform-app-launcher.spec.ts` 与 `platform-app-shell.spec.ts` 的隐藏用例、`apps/web/tests/platform-app-entry-mismatch-inventory.spec.ts`(7,下「④ 的残留」两格的精确集合账本);每条守卫都做过单点变异(去掉即红)。**仍未做**:一次真账号的端到端双侧拒绝验证(退出条件里的那一条)仍待 222 上机补。CI 裁判:服务端两支由 `.github/workflows/plugin-tests.yml` 的 `Run core-backend tests` 步骤(整套无库 vitest)收走;前端四支 2026-09-11 起登记在 `apps/web/scripts/run-required-web-tests.sh`(`web-tests.yml` 的常开必需门),此前它们在 CI 上无任何裁判。
- **④ 的残留(2026-09-11,已知未消除,不影响「服务端零过滤」这条缺口已补的事实)**:卡片**可见性**是 manifest 声明码的 any-of(`packages/core-backend/src/routes/platform-apps.ts:67`、`apps/web/src/composables/usePlatformApps.ts:444`),而卡片**落点进不进得去**由另一个谓词决定 —— 落点路由自己的 `meta`(`apps/web/src/router/appRoutes.ts`,经 `apps/web/src/router/guardPolicy.ts:147` `resolveRouteGuardDecision` 重放)。两者**不同量**,于是四个内置 app 在**两个相反方向**上各有失配。账本(由 `apps/web/tests/platform-app-entry-mismatch-inventory.spec.ts` 以精确集合钉住:加 app、改 manifest 码、改落点路由 meta 都会让它红,即"来更新这张表或去要 owner 裁决"):

  | app | 落点 entryPath(`platform/app-registry.ts:114` `resolveEntryPath`) | 落点路由 meta 的权限要求 | 失配方向 |
  | --- | --- | --- | --- |
  | stock-preparation | `/stock-prep` | `permissions: ['stock-prep:read']`(`appRoutes.ts:330`) | **可见但打不开**:只持 `stock-prep:operate`(代数里 operate 不覆盖 read) |
  | elearning | `/learn` | `permissions: ['elearning:read']`(`appRoutes.ts:442`) | **可见但打不开**:只持 `elearning:grade` 或 `elearning:stats` |
  | attendance | `/attendance` | 仅 `requiresAuth` + `requiredFeature: 'attendance'`,**无 `permissions`**(`appRoutes.ts:105`) | **有权但看不见**:manifest 声明 5 个码,不持任一码的账号仍进得去 `/attendance`,卡片却在两个列表都消失 |
  | after-sales | `/p/plugin-after-sales/after-sales` | **无专属路由**,落在通配 `/p/:plugin/:viewId`,meta 仅 `requiresAuth`(`appRoutes.ts:195-198`) | **有权但看不见**:同上,manifest 声明 4 个码 |

  两个方向性质不同,不要混为一谈:
  - **可见但打不开**(stock-prep `operate`、elearning `grade`/`stats`)是 G-7 要求原文点名的那种假入口;同一份列表在工作台 `apps/web/src/views/MyAppsLandingView.vue:145-155` `isEntryReachable()` 会重放 guardPolicy 把这张卡**隐藏** —— 两个应用列表面对同一主体给出**相反**答案。
  - **有权但看不见**(attendance、after-sales)是**本 PR 新引入的行为变化**:改前 `PlatformAppLauncherView` 零过滤,所有已登录账号看得见所有卡片;现在落点路由明明不拦,卡片却被可见性过滤掉,而且两个列表**一致地**隐藏(服务端已过滤,工作台根本拿不到这张卡)。它破的是同一条原则的另一半(`plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs:24`「what is not permitted must not be visible, **what is visible must be actionable**」的逆命题侧)。可发生面必须说清:attendance 一侧较窄 —— `PRODUCT_MODE=platform|attendance` 下 `packages/core-backend/src/auth/AuthService.ts:777-781` 的自助补码会给非 admin 账号补上 `attendance:read/write`(卡片照旧可见),而 `plm-workbench` 且 `ENABLE_PLM` 开时 `guardPolicy.ts:181-188` 的前缀白名单连 `/apps` 本身都重定向(两侧都到不了),剩下的可发生面是补码未持久化(`AuthService.ts:753-772` 明写不伪造未持久化权限)或部署自行调整过角色;after-sales 一侧**不依赖模式** —— 全仓没有任何迁移/预设给普通角色发 `after_sales:*`(只有插件安装期种的 `plugin-after-sales:after-sales:*` 角色),未被显式授予的非 admin 账号在任何模式下都看不到该卡片,而路由前门不拦它(页面内的 API 能否用取决于插件自身守卫,那是另一条链,不在本条结论里)。

  彻底消除仍要 owner 择一,本轮不擅自放宽:(a) 让 `PlatformAppLauncherView` 在 `accessibleApps` 之后再过一遍工作台已有的 guardPolicy 重放 —— 只会更严,消的是第一个方向;(b) 把可见性判定改成「manifest 码 any-of **或** 落点路由 meta 无权限要求」(消第二个方向),或把 `/stock-prep`、`/learn` 的 meta 放成 any-of(消第一个方向)—— **(b) 的两种写法都是放宽**,须与 owner 决策 #5 的词表一起定。admin 两个方向都不受影响(`*:*` 旁路 + `resource:admin` 覆盖 `read`)。
- **附带未决**:owner 决策 #5(`stock-prep:read/operate/admin` 权限词表命名与迁移路径)仍 OPEN,是 V4 前置;~~现状权限过宽——操作员需持 `integration:write`(`apps/web/src/router/appRoutes.ts` `/stock-prep` 路由)~~ **已过期(2026-09-11 核实)**:`appRoutes.ts:323-330` 的注释与 meta 早已改成 `permissions: ['stock-prep:read']`,`integration:write` 不再是备料工作台的门;真正的现状问题是上面「④ 的残留」那张表(可见性的 any-of 与落点路由 meta 不同量,两个方向各有失配)。
- **退出条件**:①–④ 全部达成 + 决策 #5 落定 + 一次无权账号访问被双侧拒绝的验证 + **「④ 的残留」两格都消除或被 owner 明确接受**(其一:只持 `stock-prep:operate` / `elearning:grade` / `elearning:stats` 的账号在 `/apps` 仍见卡片、点击被路由守卫拦,且与工作台列表判定相反;其二:不持 `attendance:*` / `after_sales:*` 的账号进得去 `/attendance` 与 `/p/plugin-after-sales/after-sales`,却在两个列表都看不到卡片)。
- **现状**:☐ 未达成
- **谁可推动**:开发(①–④)+ owner(决策 #5)

### G-8 审计导出与生产回滚演练
- **要求**:(a) 备料关键操作可审计且可导出;(b) 一次**生产回滚演练**——上线后能退回上一版本且数据一致。
- **退出条件**:审计导出样例(values-free)+ 一次回滚演练记录(回滚耗时、数据一致性验证)。
- **现状**:☐ 未达成
- **谁可推动**:运维 + 开发

---

## 2. 接管专属门(T-1 … T-3)

这三项不属于通用平台上线门,但**接管不能没有**。

### T-1 只读窗口授权(客户侧)
- **现状**:PLM/K3 侧的只读窗口验收**已完成一次**(delivery-plan §0.1 全 PASS,#4628 CLOSED),但 §0.3 明确该授权**不可复用**:每次重跑需重新冻结包、新的一次性操作号、owner 重新授权。**备料 MySQL 库的读授权尚未取得。**
- **退出条件**:客户书面授权的只读窗口(范围、期限、数据边界)。
- **谁可推动**:owner + 客户

### T-2 双轨对账零差异窗口
- **要求**:新旧系统并行运行,按 `product_code` 达成连续 N 日零差异。
- **依据**:`mysql-migration-plan.md` §2(4) 的 7 行对账表与容差、§ 切换判据四条件。
- **现状**:☐ 未达成 —— **对账引擎尚未实现(零可执行面)**。
- **谁可推动**:开发(引擎)+ owner(N 值与容差裁定)

### T-3 按项目号切换判据
- **四条件**(源 `mysql-migration-plan.md`):连续 N 日零差异、列权限已建立、选项映射命中率 100%、provenance 完整。
- **现状**:☐ 未达成(判据已写,四条均未实现)
- **谁可推动**:开发 + owner

---

## 3. 使用方式

1. 本文是**活文档**:每项状态变化就地更新,不另起快照(沿用状态账本的纪律)。
2. 任一项标 PASS 必须附**可核验证据链接**且 values-free。
3. **G-3 与 T-1 不依赖任何代码**,可立即并行推进——它们目前是整条接管线的真实关键路径。
4. 上线决策(Go / No-Go)按考勤线先例,写成一份独立的 go-no-go 记录,引用本文各门的最终状态。

---

*本文由 2026-08-22 仓库盘点触发创建。修改本文属技术负责人(T)层决策,走"默认前进 + 24h 异步否决";其中 G-3 / T-1 / 决策 #5 属 owner(O)层,先批后动。*
