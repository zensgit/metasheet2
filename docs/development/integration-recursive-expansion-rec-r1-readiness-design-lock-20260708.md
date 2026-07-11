# REC-R1 递归 BOM 展开 — runtime 就绪评估 + demand-gate — 2026-07-08

## Status

**PROPOSED · docs-only · 本文档不授权任何实现。REC-R1 runtime 保持 🔒 DEMAND-GATED。**

本文档是 REC-R0 方向锁
(`docs/development/integration-read-source-recursive-expansion-direction-design-lock-20260705.md`)
的下一梯级的**就绪评估与门槛定义**——它回答"如果开 REC-R1,R1 是什么、必须守什么、
怎么验证",并把 R0 已宣告的 demand gate 收紧为可判定的显式条件。它**不**打开 R1:
没有 runtime、没有 config model、没有 planner、没有 route、没有 UI、没有代码、没有写。

**Owner 硬约束(2026-07-08,本文档的治理前提)**:递归展开是**能力扩展
(capability extension),不是收尾必需(closure necessity)**。数据库及系统连接线
已按三层 DoD 收尾(final closure report 2026-07-06),不欠递归任何东西。
**只在现场有多层 BOM 展开需求才开 REC-R1;否则暂缓。**
本文档把这条约束落为 §3 的 demand gate——它是 R1 的唯一开启条件,本文档本身不满足它。

## 1. 地基(已落 main 的事实,本文档不重开)

- **REC-R0 方向锁(2026-07-05)**:锁定了有界多层展开的方向——同一 `executeConfiguredRead`
  原语、三重预算(深度/单层扇出/总节点)、环检测 fail-closed、values-free 分层聚合证据、
  双门(demand + governance)。REC-R0 ✅,本文档全盘继承其 §4 八条方向锁,不改一字方向。
- **单跳先例(BL0→BL4,已闭)**:BOM/GetList-by-material 二跳能力按 staged opt-in 落完
  (BL1 契约 #3689/#3691 → BL2 runtime #3695 → BL3 standalone 实体机冒烟 PASS #3701/#3702
  → BL4 组合复跑 PASS #3703,2026-07-06)。
- **二跳组合已证**:`materialNumber → FItemID → FBOMNumber` 全链实体机端到端 PASS,
  values-free、fail-closed(AMBIGUOUS 在 standalone 与组合两层正确浮出)。
- **能力边界现状**:standalone resolver + depth-2 组合,read-only。递归 = 把这条已证的
  "一跳解析"从固定二级链扩展为**多级 fan-out**(父 → 子 → 孙 → …)——这正是组合 v1
  明确拒绝、REC-R0 单独锁方向的那件事。

读线纪律(values-free / fail-closed / 零写)在上述每一级实战履职,是 REC 各梯级的
不可回退底线。

## 2. REC-R1 是什么(定义,非授权)

**能力目标(整条 REC 线交付什么)**:有界多层 BOM fan-out——给定一个根业务键,
沿 config 声明的下降接线逐层展开(父 → 子 → 孙 → …),每层都是同一已批准的
key-only、values-free、read-only configured-read;带**显式单层预算、环检测、硬深度上限**;
只读、零写、零生产副作用;超预算即 fail-closed 中止,**截断的遍历永不作为成功返回**。

**REC-R1 这一梯级的范围(沿用 R0 §5 阶梯,不合并梯级)**:

| 含 | 不含 |
| --- | --- |
| 展开 config model(下降接线声明 + 三重预算字段,预算 ≤ 平台固定上限) | 任何出站调用(zero outbound) |
| config validator(write-shaped 一律拒绝;预算越界拒绝;非法接线拒绝) | route / API 面 |
| **纯**遍历 planner / 预算-环评估器(纯函数,可离线测试) | UI |
| 闭集粗码注册(环、各预算帽、下降失败) | executor(那是 REC-R2) |

R1 是"模型 + 校验 + 纯规划",一次外部读都不发。executor(REC-R2)与
route/mirror/UI(REC-R3)是之后各自独立的 opt-in。

## 3. DEMAND GATE(本文档的核心;R1 的开启条件)

**REC-R1 runtime 在以下两个条件同时满足之前,不被授权:**

> **(a) 一个有名有姓的现场/客户用例被书面记录,且该用例确实需要 ≥3 层 BOM 展开**
> ——通过治理读面(approved configured reads)完成,用例文档须写明:是谁、什么业务动作、
> 为什么现有能力(单级 BOM 明细读、BOM-list-by-material 单跳、depth-2 组合)不够;
>
> **且 (b) owner 显式逐梯 opt-in(REC-R1 单独一次,不连带 R2+)。**
>
> **(a) 不满足时,(b) 不可单独开门——R1 保持 🔒 冻结。这是本文档的支配条件。**

**为什么门槛是 ≥3 层**:1 层 = 既有 `BOM/GetDetail` / BOM-list 单跳已覆盖;
2 层 = 已收尾的 depth-2 组合链已覆盖并实体机证明。只有 ≥3 层的真实需求才真正需要
REC 基底——低于此线的"需求"应回到既有能力,不构成开 R1 的理由。

**邻线分流(继承 R0 §2,防止假需求)**:若未来用例实为备料/库存类场景,它属于既有的
桥接 SQL 大 BOM 展开通道(有界同步 + checkpoint 后台),**不属于本线**——那条通道的存在
本身就是对"这里是否真有需求"的第一道过滤。K3 productionization 的"补全 ref 对象"
是潜在需求形状,但至今未被命名为需要多层展开,不算数。

**需求不出现,门就不开**——这是设计意图,不是欠账。

## 4. R1(若开)的硬不变量

以下各条在任何未来 R1/R2/R3 实现 PR 中均为硬性守卫,违反任何一条 = 该 PR 不可合:

1. **有界深度 + 单层行预算 + 总节点预算,三者独立、皆有平台固定上限;命中任一即
   fail-closed 中止**(专属粗码,如 `…EXPANSION_DEPTH_CAP` / `…EXPANSION_NODE_BUDGET`),
   **永不无界、永不静默截断、截断永不伪装成功**。
2. **环检测,fail-closed**:BOM 直接或传递引用祖先 → 在展开内的 visited 集合上被**检测**
   (专属粗码 `…EXPANSION_CYCLE`),遍历中止——不是无限循环,也不是 v1 默认的
   skip-and-continue。
3. **只读**:每一层都是 configured READ;零写、零 Save/Submit/Audit、零外部写、
   零生产副作用;同根键重跑按声明子序确定性重读,无状态、无部分效果。
4. **Values-free 证据**:证据面只承载分层聚合计数——到达深度、每层访问节点数、
   命中的预算帽(布尔 + 计数)、是否检出环、分层粗败码。**永不**承载物料号、BOM 号、
   数量、名称、行值、根键、host、租户、凭证。遍历数据(有界树)只流向授权调用方——
   与整条读线相同的双平面切分。
5. **单租户凭证上下文复用**:每层复用既有注册外部系统的后端持有凭证;**不新增任何
   凭证路径**、不新增第二条读路径、不放宽 host allowlist。
6. **Key-only 请求 + 平台派生下降**:runtime 请求只带根业务键(既有严格
   `{ inputs: { key } }` 契约);每个下降键由平台按 config 声明接线从父行派生——
   永不由请求方提供、永不是 raw filter。
7. **闭集粗码 + mirror 义务**:新粗码为服务端注册闭集;未来任何 route/UI 梯级承担
   client mirror + CI tripwire 义务(组合线既有模式)。

## 5. Non-goals(显式)

- 不写:零 Save / Submit / Audit / 外部写 / 生产写(生产写客户级禁止)。
- 不生产:零生产侧副作用,零后台/checkpoint/可恢复通道(那属于 apply 类工作负载)。
- 不无界:零"best-effort 部分展开"、零静默截断、零无预算遍历。
- 不接受客户自编遍历逻辑:零客户提供的脚本/SQL/表达式/JSONPath/正则驱动下降。
- 不放宽 host allowlist,不新增凭证路径,不 fork 第二条读路径。
- 不替代备料线的桥接 SQL 大 BOM 通道。
- 不在多义子节点间自动择一(resolver 的 no-auto-pick 纪律在每一层成立)。
- **本文档零实现、零解锁。**

## 6. 验证计划(为将来"若开 R1"预置;现在不执行)

未来 R1(及其后 R2)实现必须至少证明:

1. **有界深度 fail-closed**:构造超过声明深度的展开 → 专属深度帽粗码、遍历中止、
   不返回部分树为成功;单层扇出帽与总节点帽各自同证(三帽三测,互相独立触发)。
2. **环检测**:植入环(子引用祖先)的固定装置 → 检出专属环粗码、有界步数内终止,
   **不是**超时或无限循环;证据只含"检出环"布尔 + 计数。
3. **零写(mutation-provable)**:适配器写方法在整个展开中零调用——以突变测试证明
   守卫真在管事(注掉写拦截 → 测试必须变红),沿用 BL2 的 refute-first + mutation 纪律。
4. **Values-free 证据**:证据快照断言不含物料/BOM/数量/名称/行值/根键/host/租户/凭证/
   raw payload;负面控制沿 BL0 模式逐项列举。
5. **确定性**:同根键两次展开产生相同遍历序(声明子序),diff 为空。
6. **R1 本级(纯层)**:validator 拒绝 write-shaped config、拒绝超平台帽预算;
   纯 planner 在无网环境下全量单测通过(zero outbound 是 R1 的定义属性,须以测试锁死)。

## 7. 阶梯与处置

| 梯级 | 范围 | 状态 |
| --- | --- | --- |
| **REC-R0** | 方向锁(预算/环/values-free 聚合/同原语/双门) | ✅ 已落 main(2026-07-05) |
| **REC-R1** | config model + validator + 纯 planner(zero outbound, no route) | 🔒 **DEMAND-GATED(本文档 §3)** |
| **REC-R2** | 展开 runtime executor(迭代 configured read,分层 fail-closed) | 🔒 R1 之后单独 opt-in |
| **REC-R3** | route + client mirror/tripwire + UI | 🔒 R2 之后单独 opt-in |

每一梯级都是 demand gate 满足**之后**的一次单独 owner opt-in;任何 PR 不得合并
model + executor + route。

**处置**:就绪评估完成——R1 的定义、门槛、不变量、验证计划在此锁定;**没有任何东西被
打开**。在 §3(a)+(b) 同时满足之前,读源线的能力边界维持现状:standalone resolver +
depth-2 组合,read-only。需求不来,本文档就是这条线关于递归的最后一份文档——
这同样是设计意图。
