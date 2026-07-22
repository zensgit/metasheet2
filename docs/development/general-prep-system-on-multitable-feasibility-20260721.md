# 通用备料系统:在多维表+现有 stock-prep 线上实现的可行性与架构(2026-07-21, rev-2)

**状态:PROPOSED（可行性论证 + 三层架构;非设计锁,每刀各自过门）**
**rev-2:据 Fable5 独立对抗审阅（`/tmp/prep-plan-review-fable5.md`,基线 origin/main）吸收 2×P1 + 6×P2 修订。
修订点在各节标 ⟲。**

三源合成:Java 备料系统四路还原(`references/radar/beiliao-reference-capability-fit-20260721.md`)
+ 我方 stock-prep 线逐字段盘点 + 三视角对抗设计工作流 + Fable5 独立审阅。所有断言对照 origin/main,
file:line 可核。

## 结论:能——「yes-with-caveats」

**Java 备料功能集可在多维表 + 现有 stock-prep 线上实现为通用(多客户)备料系统。** 三条诚实前提(rev-2 修正):

1. ⟲ **真正的 ERP 写回欠账在 T3 线,不在 production-policy。** 审阅纠错:`production-policy.cjs` **早已接线**
   (#3199,2026-06-25 落 main;`table-actions.cjs:863` `assertStockPrepApplyAllowed` 是双写入口单一门,
   `http-routes.cjs:3494/3650` 均已传 policy)——但它门的是 **MetaSheet canonical 备料表的 apply 写**,
   **不是 K3/ERP 写回**。要替代亚光的 K3 写回,真 go-live 欠账是 **T3 external-write 线(K3 Save 生产解锁,
   现锁在 dry-run/Save-only)**——需单独一刀,过需求门。
2. **「通用」在第二场景处证明**——循 owner 已拍板的抽取序(generalization proposal §4:第二场景=D 线
   物料主数据对账拉动 K1 抽取,非 big-bang)。v1 通用性 = 配置载体存在 + stock-prep preset #1 逐字节钉死今天行为。
3. **三处亚光语义需新治理代码**(carry-policy、suggestion 算子、identity profile);其余全是现成 substrate。

## 关键事实(改变可行性判断;审阅确认为真)

**那 9 张备料表是真 MetaSheet multitable**(`provisioning.ts:203/270/314/448` 写
`meta_bases/meta_sheets/meta_fields/meta_views`),**不是插件私有孤岛**(`plugin_multitable_object_registry`
只在插件间 claim/assert,用户 record 路由零引用)。网格/字段权限/视图/personal-view/公式/审批**本来就
作用在它们上**。

⟲ **但有一条精确边界(审阅 P2-1)**:**自动化事件只在网格路由层发射**(`univer-meta.ts:10530+`);
**插件面 records API 与 persist unit-of-work 不发自动化事件**(`stock-preparation-persist-unit-of-work.ts`
零 event/automation import,已核)。而这 9 表生产里的主写入方正是插件(refresh/apply/sync/confirm)。
后果:「人在网格编辑 → 触发自动化」成立;「**批次刷新改了行 → 自动通知采购/仓库**」(亚光钉钉待办总线
最重的一类)**现有自动化表达不了**,需新 seam(插件写入口发事件/outbox)。这是 substrate 断言的真实边界。

## 三层架构(对抗收敛 + 审阅修订后)

### 层 1 — 冻结治理核心(产品代码,租户永不可达)

现有价值链**不变**:BOM 读计划(预算/环检测,身份=`makeIdempotencyKey` projectNo+componentSourceId+
parentSourceId+path,`bom-expansion.cjs:401-408`)→ 快照批次/行 + 阻断式 diff → 冲突规划器所有权墙 →
确认写服务盖章(K2)→ values-free 审计 → policy-gated apply(**已接线**)。**加有界新增**:

- ⟲ **carryPolicy**(闭词表)跨批继承——`carryKey ∈ {idempotency_key(默认), component_source_id}`。
  审阅修正两点:① **1→1 同 idempotencyKey 的继承今天已由 UPDATE-保留免费成立**(planner 对已存在 key
  只 patch plmFields,human 字段原地保留),故 carry 的**真实增量收窄到 `component_source_id` 跨 key 场景**;
  ② 跨 key carry 要把 human 字段带进 ADD,会撞 `makeAddDecision` 的 `assertNoHumanFields` 墙——**必须走
  K2 式服务代人签署写**(confirm-writes 先例:confirmedBy/At 是 human_preserved 由服务写入),不是「墙不变」。
- ⟲ **歧义落点二选一(审阅 P2-4,必须在设计锁定死)**:1→N 歧义与手工行重挂,要么走 **planner 行级 hold**
  (`MANUAL_CONFIRM`→`held`,现成,UX 弱,`apply-writer.cjs:487`),要么**扩 `exception_confirmation` 闭词表**
  (现 8 项 `stock_preparation_exception_type_v1`,无 carry 类,扩版 = 新治理代码 + confirm-reads/writes 改)。
  **绝不学亚光 latest-createTime 静默覆盖。**
- **suggestion 算子对**:需求日期级联(`engine.ts` DATEADD/WORKDAY,**无节假日日历**——审阅确认,`engine.ts:576`
  NETWORKDAYS 仅 2-arg)写 `plm_system` 建议列;跨项目预填候选(用已跨项目的 `plmDrawingNo` 映射表)。
  二者**只经 K2 确认进 human_preserved**。
- ⟲ **租户扩展字段命名空间(审阅 P1-2 修正前提)**:审阅证实**扩展字段今天已 refresh-安全 by construction**
  (planner 只 `pickFields(plmFields)`,模板外字段永不进 patch),且 **drift 检查是单向的**(只查模板字段缺失,
  忽略多余租户字段——`target-provisioning.cjs:214`)。所以本项不是「修订会误判的守卫」(那守卫不存在),
  而是**新增**命名空间纪律(前缀 + 防未来模板字段撞名)。两个卖点(refresh 安全/不触 drift)今天已成立。

### 层 2 — approved config(版本化,owner/admin 门,非实时网格数据)

- **identity-convention profile**:亚光图号语法 = **版本化+审批**的有界 ReDoS-checked 分类规则,**只发
  `plm_system` 注解列**(isSelfMadeCandidate/rootCandidate/hierarchyHint,**永不发身份**)。
  ⟲ **载体依赖 D 线(审阅 P2-5)**:main 上只有 D1 binding-member **契约模板**(`material-reconciliation-templates.cjs:812`,
  含 approved_config_version_id + system_content_key,但 schema-only 且被 MR 场景词表锁死)。**物理载体
  (真表+生命周期事务)是 D2 设计锁,现仅在未合分支 PROPOSED**(#4520)。故 P5 = **模式复制 + 新建载体**,
  对 D2 落地有真实依赖,不是「直接复用」。
- scenario-pack manifest 统一在 K3 manifest 原语(schema-only,FORBIDDEN_CONTENT_KEYS)。

### 层 3 — 租户/实施方配置(普通多维表原语)

- **部门协作** = 字段权限 profile + 部门存档视图 + personal-view + done-state 复选字段——**取代** Java 的
  RoleColumn/TableColumnConfig/PurchaseInfo/WarehouseInfo 四概念(列级权限 + 过滤视图使卫星表多余)。
- ⟲ **通知配方(审阅 P2-1 圈定)** = 自动化规则,但**只覆盖「人工网格编辑触发 + 日程触发」**;
  refresh-驱动通知列为**需新 seam 的后续刀**。投递 flag owner 门(env-gated register-only,四 durable-delivery flag OFF)。
- **工段/工序/工艺** = 模板 gallery 里**普通非冻结租户表**(C 胜 B:级联自动填=link+lookup+automation update_record;
  最全方案复用=层 1 预填算子 `rankBy:'field_presence'`(按非空 human 字段计数降序;默认 `recency` 服务跨项目预填,二者皆为确定性全序);30 字段工艺词表属实施方——冻结纪律只留给承载治理的表)。
- ⟲ **「可导入包」措辞诚实化(审阅 P3-3)**:`template-library` 只装 sheets/fields/views,**无字段权限/自动化/
  personal-view 导入原语**。所以 P2/P6 的「包」要么是**手工配置 + 文档**(守住「无代码」),要么是**新 installer 代码**
  (与「无门」矛盾)——设计锁二选一,不含糊。

## 明确不做(仅逃生舱)

MRP/ATP 引擎;SMB 图纸爬取;宜搭推送(需求门);像素级复刻;**human 字段跨 path 静默继承**;
**自动选任何复用候选**;节假日日期算术(待 holidays-range NETWORKDAYS 变体)。

## ⟲ 审阅打掉的两个原前提(如实记录,防再犯)

1. **原「production-policy 未接线」= 过时事实**:我的工作流代理读了 `production-policy.cjs:5-8` 的陈旧头注释
   (「NOT wired… P2 will wire」,P2 落地后没更新),没查调用点。已亲验:`http-routes.cjs:3494/3650` 双入口
   均已传 policy。**这是「对旧基点断言、把已落地写成 gap」的老毛病,栽在自己身上。**
2. **原「未知字段今天即 drift 错」= 不存在的守卫**:drift 单向(`target-provisioning.cjs:214`),多余租户字段本被忽略。

## 战略判断(供 owner;定位不变)

**赢在哪**:客户留着 Java 的代价——无事务、明文密码、三 @Primary 冲突、单线程 sleep 当同步、图号/宜搭/钉钉
全写死、换厂就重写。我们给**受治理内核 + 配置层 + 逃生舱**。**定位与 main 上 generalization proposal §5 及
multitable 底座一致,无冲突**(审阅确认)。**不是做一个备料 App,是让备料成为底座上一个受治理 scenario。**

**最小可信第一步 = P1a substrate 证明**(含审阅要求的负例:插件写路径**不**触发自动化、租户改坏冻结表结构、
UI 可达性)。这一刀落地,「通用备料在多维表上成立」从论证变实证——且诚实标出「refresh 驱动通知需新 seam」这个真边界。
