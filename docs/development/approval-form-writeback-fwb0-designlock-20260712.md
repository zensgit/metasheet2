# 审批表单回写 FWB（Form Writeback）— FWB-0 设计锁（2026-07-12）

**Status: RATIFIED 2026-07-15（owner）。** 设计经 owner ratify——本锁契约即为实现验收标准。落地顺序：在 #4196 之后合入 main；全部四锁落 main 后方授权启动 P2 durable-delivery runtime，FWB / 附件 / 一切相关 flag 保持 **OFF**，直至完整实现 + 8 场景全链验收通过。**本文档仍是设计契约（零 runtime、零迁移、零 flag 随附）。** 历史：曾为 PROPOSED awaiting owner ratify。本文档自身无
ratify 权；下述任何内容在 owner 显式 ratify 前不得实现。文中「已裁决」条目是 owner 在 FWB-0 共同设计
轮中给出的口径，随本锁一并提交 owner 最终 ratify——它们不是本 session 的自我裁决。

- Grounded on `origin/main` `b06837db8`；file:line 引用已于 2026-07-13 对 `origin/main`
  `f0ce863ea` 复核修正。**本次修订**（新增 Layer 1 事务 outbox + 租约投递、Layer 2
  一等公民 `record-link` 字段——owner 代码评审要求补齐的两项前置设计）已于 2026-07-13 对
  `origin/main` `cb58e00a0` 逐条复核 file:line。
- **owner 对本次修订的后续复核（P1×3 + P3）已并入本稿**：(1) Layer 1 改写为
  transport 层 at-least-once + sink 侧幂等，删除一切「transport 层恰好一次 / handler ack
  之后才标记 dispatched」的措辞；(2) Layer 2 新增 `record-link` 的 submit-time / execute-time
  服务端鉴权（混淆代理人防线）与统一 fail-closed 口径；(3) §2.1「暴露上界=规则创建者读权限，
  无越权放大」结论移除，转为 §11 新增 Q6 owner 裁决；(4) CI 措辞订正——`web-tests` 现为
  branch protection 的 required check（仍是白名单式）。
- **owner 第二轮复核（durable consumer 闭环 + 两项折入本锁 + Q6 落定）已并入本稿**：(1) Layer 1
  改为 **durable dispatcher 直接 `await` 命名 consumer adapter**（`approval-bridge` /
  `approval-trigger` / `approval-projection` 至少三个 `consumer_key`，各自成功才标 `done`；
  `eventemitter3` 总线降级为 best-effort fanout，不推进持久状态），并纠正旧稿「只有
  automation-service 一个消费者」——单订阅回调 fan-out 成 bridge+trigger 两条 error-isolated
  路径、projection 是独立订阅，且 per-rule `event_fires` 与 per-consumer outbox 状态是**两个不同
  粒度**，consumer 级 `done` ≠ 名下所有规则完成；(2) 把上一轮只进了 #4239 的两项订正**折入本
  权威锁**——`SKIP LOCKED` ≠「单飞」（leader lock = 单实例；`SKIP LOCKED` = 逐行无并发双持有、
  不保证跨崩溃只处理一次）、迁移回填须走**升级路径**（旧 schema 写历史行 → 目标迁移，非 fresh-DB
  全量）；(3) §11 Q6 由 owner 裁决落定（允许显式解密，闸 = admin/`canManageSheetAccess` + 源读
  目标写 + save 显式确认且审计只记标识不记值 + execute 复核，不量化「扩大到多少人」）。
- **owner 第三轮复核（sink 可恢复 + Q6 绑定实际配置 + 残余措辞）已并入本稿**：(1) Layer 1 新增
  「**每个 consumer sink 自身必须可恢复**」——`await` 只让 dispatcher 可观察，不等于 sink 可恢复；
  以 bridge 为例，`claimCompletion`（`automation-approval-bridge-service.ts:312`）在 continuation 前
  就把 `pending` 写成 `resumed`（终态墓碑），claim 后崩溃即永久丢工作 → 改为 `pending/in_progress/
  done` 租约、continuation+执行日志持久化后才标 `done`、租约过期可 reclaim、尾动作经 #4196 分类账
  可重放，配三窗（claim 后 / 首尾动作后 / 完成前）真库崩溃测；(2) Q6 确认**绑定实际配置**——服务端
  对规范化 `{模板/版本, 目标 base/sheet, 映射}` 生成确认哈希，任一变化即失效重确认，execute 权限
  复核显式调用目标 sheet 的 `resolveSheetCapabilitiesForUser`（非全局 capability）；(3) 残余措辞
  订正——§9 的「完成事件恰好触发一次」改为「consumer sink 净效果恰好一次」。
- **owner 第四轮复核（#4203 P1：durable outbox 缺原子化、版本化 consumer 路由 manifest + 跨锁
  action.type）已并入本稿**：(1) Layer 1 新增**版本化、原子的 consumer 路由 manifest**——生产事务在
  同一 `COMMIT` 内写 outbox 行**与**该事件按 VERSIONED manifest 展开的完整 `(outbox_id, consumer_key)`
  行集（每行 stamped `manifest_version`），manifest 覆盖全事件族，补齐旧稿只枚举 approval-completion
  三消费者的缺口（`approval.task_created`、`record.*`/`form.submitted`、webhook-bridge）；(2) dispatcher
  **只按已写入的行**派发、绝不在派发时回读活 manifest 重新推导——v1 写入的行恒按 v1 投递，manifest
  bump 新增 consumer **不追溯**历史事件；(3) 每个内建 consumer **启动期恰注册一次**（注册表断言唯一、
  重复注册=启动错误），旧 `eventemitter3` 路径**非承重**、cutover 期双路径短暂并发**仅因 sink 幂等而
  安全**（迁移安全论证，非零重叠断言），稳态双跑/漏投均不得存活；(4) 跨锁——D9 的 `action_key` 身份
  并入 **action.type**，改为 {structuralPath, action.type, canonicalConfig}，与 #4196 更正后的 identity
  对齐。**仍 PROPOSED；本次仅 reliability 面，零 runtime。**
- **owner 第五轮复核（租约 fencing + 中毒事件终态 + manifest 完整性机器断言）已并入本稿**：(1)
  **fencing token**——每个租约行带单调 `fence`，claim/reclaim 自增；对持久状态的写必须 fence-CAS,
  被 reclaim 的**「僵尸」**（活着但租约过期的持有者）CAS 命中 0 行即中止，**持久状态因此是单写者**；
  纠正「无并发双持有」被误读为覆盖 post-lease 执行窗口（无双持有只在持锁期成立；class-B 外发对僵尸
  用续租/心跳收窄窗口 + 幂等键 / `outcome_unknown`）；(2) **中毒事件终态**——状态机加 `failed`/`dead_letter`
  + 有界 `attempts`，确定性永久失败经上限后置终态、非无限 reclaim + 告警 seam；(3) manifest 完整性
  **启动期机器断言**（订阅了却漏登记 ⇒ fail-closed，非人肉维护）；(4) 验证新增僵尸腿与中毒腿。
- **owner 第六轮复核（construct-a-failure gate 抓到一个可构造漏投 + 若干硬化）已并入本稿**：(1)
  **manifest 完整性守卫改为「注册表唯一枚举源 + 双向断言」**——此前的单向断言挡不住**裸
  `eventBus.subscribe` 的匿名 durable consumer**（不带 `consumer_key`、总线侧不可枚举）静默漏投；现契约
  =outbox 覆盖族的 durable 订阅只能经必带 `consumer_key` 的单一注册表，禁裸订阅，注册表即断言枚举源，
  双向 fail-closed；(2) **fence 是普适规则**、覆盖每个可 reclaim 租约行，**含 bridge 续跑租约行**
  （`automation_approval_bridge` 的 `resumed`，第三种 durable-status 行），枚举是示例非穷举；(3)
  adapter-resolve 的终态集合显式含 `failed`/`dead_letter`（消除 round-5 加 `failed` 后的术语漂移，否则毒规则
  永挡 resolve）；(4) **三条 producer/identity 契约**——producer 侧原子入队覆盖 manifest 全族（非仅
  approval-completion）、dispatcher 转发原始事件 identity 供共享非-FWB consumer 的 per-rule 去重、外发幂等键
  绑稳定事件/动作 identity 跨 fence token 不变。**仍 PROPOSED；纯 reliability，零 runtime。**
- **owner 第七轮复核（Q1–Q5 裁决 + rolling-deploy manifest 协议）已并入本稿**：(1) §11 的 **Q1–Q5 由 owner
  全部裁决为 v1 DECIDED**——Q1 目标缺失=`failed`(可重试)、Q2 rejected/cancelled 回写=命名 v2 follow-up、Q3
  same-base 其他表(FWB-1.5)=不做、Q4 核定值读取范围随实例详情/生命周期随实例(前置 S-0 私有)、Q5 decimal
  超目标字段 precision=整步 REJECT 不舍入；**本锁现无残余开放问题**（Q6 早前已裁）；(2) Layer 1 新增
  **rolling-deploy manifest 协议**——先迁移后启用、N/N-1 双版共存、**未知 `consumer_key` 保持 `pending` +
  告警、绝不误标 `done`/`dead_letter`**（避免 N-1 worker 把该由 N 处理的行静默终结=漏投），配 N+N-1 并发
  验证 + 正控。**仍 PROPOSED，零 runtime。**
  这是 owner 提出的差异化车道：竞品的「审批」与「表格」是两个孤岛，审批通过后的数据要人肉誊抄；
  MetaSheet 的审批产品与 multitable 同库同内核，可以把「审批终态」直接变成「受治理的数据落库」。
- 切片：FWB-0（本锁）→ FWB-1（新建记录，~4-6 pd）→ FWB-2（回写已有记录，~3-5 pd）→
  FWB-3（审批人核定值，**8-12 pd，向上修正**，见 §6）。

---

## 0. 定位：FWB 不是 W7 resultWriteback，也不是 T3-6 投影

三条既有线各管一段，FWB 是缺口本身：

| 线 | 写什么 | 往哪写 | 状态 |
|---|---|---|---|
| W7 `resultWriteback`（T3-5，#3506，`w7-cross-base-resultwriteback-design-lock-20260703.md`） | 审批**结果元数据**（status/approver/completedAt） | 触发记录或字面 triple 指定的已有记录 | SHIPPED |
| T3-6 approvals-as-records（投影） | 审批实例本身的**只读投影** | 专用投影表 | 已落 |
| **FWB（本线）** | 表单里的**业务数据**（金额、日期、选项……） | **新建**记录（FWB-1）/ 表单锚定的**已有**记录（FWB-2），外加**审批人核定值**（FWB-3） | 本锁 |

W7 回答「这条记录被审批成什么样了」；FWB 回答「这次审批**产生/修正了什么业务数据**」。两者共享
跨 base 写闸（§2.2），但写的内容、寻址方式、幂等键完全不同。FWB 不改动 W7 的任何行为。

---

## 1. 架构裁决（LEAD DECISION，owner 已定）：hybrid + 专用受限动作

**裁决：(b)/hybrid。** 审批状态机在终态迁移时发出**最小化完成事件**（已存在：
`buildApprovalCompletionEvent`，`ApprovalProductService.ts:3955` 发出，`automation-service.ts:930`
订阅）→ automation 规则以既有 `approval.completed` 触发器（`automation-service.ts:109`，
template-keyed dispatch `handleApprovalCompletionTrigger` `:2517`）消费 → 一个**专用、受限的新动作
`write_approval_form_values`** 调用回写服务完成落库。

被否掉的两条路，及理由：

- **(a) 审批生命周期钩子**（状态机在 `ApprovalProductService` 里直接写记录）：把 multitable 写路径
  塞进审批热文件；绕开自动化的三道既有闸（跨 base 写闸、深度闸、事件去重）后全部要在审批侧重造；
  且 automation retry 永远够不到它——失败恢复要另起炉灶。REJECTED。
- **复用通用 `create_record` 动作**：`create_record` 的值来自规则配置/触发记录上下文，让它读审批
  快照意味着把表单值塞进事件载荷或动作配置——两者都是**篡改/注入面**（见下）。且通用动作解不开
  `approval.completed` 规则「record-less v1 禁记录写」的结构性边界（`automation-service.ts:105-108`
  注释：v1 只允许非记录副作用，*structurally breaks the start_approval → approval.completed →
  start_approval loop*）——那道边界是刻意的，FWB 必须以
  **受控放行一个专用动作**的方式打开，而不是把通用记录写整体放进来。REJECTED。

**`write_approval_form_values` 的输入面收窄到三样：`instanceId` + 显式字段映射 + 目标寻址。**
表单值**永远不进事件载荷、不进动作配置**——完成事件今天就只带 `approval`/`transition`/`requester`
元数据（`automation-service.ts:2558-2570`），保持不变；回写服务在服务端按 `instanceId` 读**权威的
不可变 `form_snapshot`**（建实例时一次性落库，`ApprovalProductService.ts:3905` INSERT；读侧
`:4162/:4617/:4819`）。载荷带值 = 任何能构造/转发事件的代码路径都能伪造业务数据；服务端读快照 =
单一权威源，事件只是「去拉取」的信号。

**复用清单（组合既有件，不重造）：**

1. `approval.completed` 触发器全套：模板必填校验、outcomes 过滤、创建者双时点授权（§2.2）、
   `claimEventDelivery` 事件级去重（`automation-service.ts:2554`）。
2. 跨 base 写闸 `evaluateCrossBaseWriteGate`（context-agnostic 形状，`automation-executor.ts:1955`；
   T3-5 已示范审批侧调用方直接传显式 actor 并共享 per-target-base 配额）。
3. 深度闸 `MAX_AUTOMATION_DEPTH = 3`（`automation-service.ts:79`）+ `approval.completed` 路径已有的
   桥接深度继承（`approvalBridgeAutomationDepth` → depth+1，`:2532-2537`，`_automationDepth: depth`
   入载荷 `:2563`）。
4. #4196 Class A 同事务账本**机制**与 C4 `action_key` 身份（§3 D9）——账本表本身 FWB 自建
   instance-scoped（见 §9 第 1 条，#4196 的 execution-scoped 账本挡不住新 `root_execution_id` 重投）。

---

## 2. 三项 grounding 修正（owner 修正，本 worktree 代码逐条验证）

### 2.1 FWB 自带导出白名单（只读规则显式映射的字段）

回写服务**只读取规则映射表里逐字段列出的 `formFieldId`**；映射之外的任何表单快照字段永不读取、永不写出——白名单 fail-closed，不存在「整快照透传」模式。这样导出面 = 规则显式映射的字段集。

配套两条（DECIDED）：

1. **规则创建者必须在 save 与 execute 双时点都能查看该模板。** 直接复用 `approval.completed` 已有的双腿：`approvalCompletedCreatorAuthorized` + `approvalTemplateVisibleToCreator`（save 侧 `automation-service.ts:1859-1863`，fire 侧 `:2545-2550`）。FWB 动作不新增任何检查器，挂进同一对钩子。
2. **回写把表单值写进目标表，本身是一次受控的数据解密/再发布，不是「零风险、已被目标表 ACL 证明安全」的操作。** 早前版本在这里断言「暴露上界 = 规则创建者本人的读权限，无越权放大」——**该结论不成立，予以移除**：§2.2 保证的是「谁有权把表单值写出去」（规则创建者），但**目标表的读者范围与规则创建者的读者范围是两个独立集合**，目标表既有 ACL 只约束「谁能读目标表」，不能反向约束或证明「目标表的读者不会因此看到一份原本只有规则创建者才能看到的数据」。把受限字段写进一张读者范围更宽的目标表，客观上是把数据的可见范围**扩大**了，这件事是否可接受、要不要加约束，是一个产品/安全决策，不是可以在设计文档里自证「无放大」的既成事实。**owner 已就此裁决**（§11 Q6：采「允许显式解密」，但以一组可稳定强制的闸替代无法稳定计算的读者集合比较——创建/改/启 FWB 规则须 admin 或对目标表持 `canManageSheetAccess`，源模板可读 + 目标表可写，save 显式确认「模板+目标表+映射」且审计**只记标识不记值**，execute 复核失效即 REJECT，且不量化「扩大到多少人」）。**该四闸落地前，任何 FWB-1/2 的实现或 ratify 都不得援引「无越权放大」作为依据。**

### 2.2 生效写身份 = **规则创建者**，不是完成事件 actor

完成事件的 `actor` 是最终审批人，且**可为 null**——自动通过/系统流转时没有人类 actor
（`ApprovalCompletionEventV1.actor: { id, name } | null`，`ApprovalCompletionEvent.ts:61-64`；
构造入参 `actor?: ... | null` `:87`）。拿事件 actor 当写身份，自动通过的审批就写不了（或更糟：
偷偷回退到某个系统身份）。

**裁决：生效写身份 = automation 规则的 `created_by`（规则创建者）。**

- save 时校验：模板可读（§2.1 第 3 条）**且**目标表可写；
- fire 时**双双复检**（复用既有 fire-time re-check 模式，`automation-service.ts:2545-2550` 同款）；
- 跨 base（仅 FWB-2）：调 `evaluateCrossBaseWriteGate(queryFn, ruleCreatorId, …)`
  （`automation-executor.ts:1955`），传**规则创建者**——**不回退**到审批人、发起人或 system。
  创建者无 userId / 授权缺失 → fail-closed（`resolveBaseWritable` 本就 fail-closed on no userId）。

**这不是新 RBAC。** 它是 `approval.completed` 触发器已经 ratify 的「规则创建者双时点授权」模式
（上引两函数）+ T3-5 已经 ratify 的「审批侧调用方向跨 base 写闸传显式 actor」模式的**逐字复用**，
只是把「显式 actor」从 T3-5 的 trigger actor 换成本线裁决的 rule creator。不新增权限模型、不新增
角色、不新增检查器。

### 2.3 幂等键分层：不是裸 `approval_instance_id`

一张审批模板可以挂**多条**回写规则，一条规则可以含**多个** FWB 动作（如同时建两张表的记录）——
裸 `approval_instance_id UNIQUE` 会让第二条规则/第二个动作永远打不进去。**裁决：**

| 切片 | 幂等键（UNIQUE） |
|---|---|
| FWB-1 / FWB-2 | `instance_id + rule_id + action_key` |
| FWB-3 | `instance_id + rule_id + action_key + node_key + entry_epoch` |

- `action_key` = #4196 C4 更正后的三元身份 **{structuralPath 结构化步径, action.type, canonicalConfig 规范化配置哈希}**（承接 #4196 修正后的 identity，不重造——action.type 并入以对齐 #4196 的更正）。
- `entry_epoch` 是既有概念：`approval_assignments.entry_epoch`（见
  `integrations/dingtalk/approval-card-deliveries.ts:48-56` 的 P1-1 注释；语义锁
  `node-entry-epoch-threshold-round-scoping-design-lock-20260703.md`）。
- **拒绝→重新提交 = 新实例 = 新键**，天然隔离；**退回/跳转 = 同实例但新一轮进入同节点，必须用
  新 epoch**——旧 epoch 的核定值与回写声明永不复用（§6）。
- 两层去重叠加：事件级 `claimEventDelivery`（防同一事件重复投递）照旧；**业务级 claim = 上表
  UNIQUE 键，与记录写同一事务提交**（§3 D9）——事件层挡「同一事件重来」，业务层挡「同一实例
  经不同 eventId / retry 路径重来」，缺一不可。

---

## Layer 1 — 完成事件到投递的持久链路（owner 代码评审：「FWB 上线前需要事务 outbox」）

**PROPOSED——本次修订新增，非共同设计轮已裁项，待 owner 与本锁一并 ratify。** 现状（本 worktree
已对 `origin/main` `cb58e00a0` 逐行核对）：`approval.completed` 完成事件 → automation 消费这条
既有链路上有两个真实的崩溃丢失窗口——它们不是 FWB 引入的新问题，而是既有基础设施里今天就存在的
缺口；FWB-1/2 只是把这条链路的后果从「丢一条通知」升级成「丢一条业务记录写」，把缺口的代价放大到
不可再忽略的程度。

### 窗口 1（事件丢失）：提交后才 emit，无持久层、无重投

`ApprovalCompletionEventV1` 在审批状态机的 DB 事务**内部**构建（`buildApprovalCompletionEvent`，
创建路径 `ApprovalProductService.ts:3955`），但要等事务 `COMMIT` **之后**才 emit 到一个纯内存的
`eventemitter3` 总线——多条终态路径都是同一形状：创建 commit `:3978` / emit `:4041`；同意
（approve）commit `:5820` / emit `:5840`；拒绝（reject）commit `:5376` / emit `:5377`；撤回
（revoke）commit `:5227` / emit `:5228`；管理员跳转（adminJump）commit `:4256` / emit `:4283`。
COMMIT 与 emit 之间进程崩溃 = 这次完成事件永久丢失——没有持久存储、没有重投机制，下游 automation
永远不会知道这次审批完成过。

### 窗口 2（终态 claim 先于执行）：claim 是墓碑，不是租约

消费侧的去重写入发生在 `executeRule` **之前**：`claimEventDelivery`（`automation-service.ts:1551`）
向 `meta_automation_event_fires` 执行 `INSERT … ON CONFLICT DO NOTHING`（`:1553-1555`；schema 见迁移
`zzzz20260701120000_create_automation_event_fires.ts`：`PRIMARY KEY (rule_id, dedup_key)`，**无状态
列**——纯粹「来过」布尔），随后 `if (!claimed) continue`（通用事件路径 `:2069-2070`；
`approval.completed` 专属路径 `:2554-2555`）——claim 一旦成功即视为「已处理」，是**终态**判断，不是
可过期的租约。若进程在 claim 成功之后、`executeRule`（`:2072`/`:2571`）执行完成之前崩溃，重投会因为
claim 行已存在而被 `if (!claimed) continue` 直接跳过——工作被**永久丢弃**，而不是重试。

`meta_automation_event_fires` 是全体事件驱动 automation（record.created/updated/deleted、
form.submitted、approval.completed、approval.task_created）共用的既有基础设施，不是 FWB 专属表；
本节的修复面向的是这张共享表，收益覆盖全体 automation 触发器，不止 approval.completed。

### 设计（仅设计，PROPOSED，待 owner ratify）

1. **事务性 OUTBOX + durable dispatcher 直接 await 命名 consumer adapter**（`meta_automation_outbox`，
   表名 PROPOSED）：完成事件行与审批状态写落在**同一个** `BEGIN…COMMIT`（`insertApprovalRecord`
   所在的 create/decide/revoke/reject 各路径）里提交。**同一事务还写入该完成事件按一份 VERSIONED
   路由 manifest 展开的完整 `(outbox_id, consumer_key)` 行集**——manifest 把每个事件族映射到其**全部
   已注册 consumer_key**，每行 stamped `manifest_version`，与 outbox 行、审批状态写落在**同一个**
   `COMMIT` 里同存同亡；consumer 集合**永不在提交之后才补写**（提交后才补写 = 回到窗口 1 的丢失形态）。
   **dispatcher 只按已写入的 `(outbox_id, consumer_key)` 行派发，绝不在派发时回头去读活的 manifest
   重新推导**：这些持久行本身**就是**该事件的路由快照；一条在 manifest v1 下写入的行**永远按 v1
   派发**，绝不被后来的 v2 manifest 重新解释。经由 manifest bump 新增的 consumer **对已经 emit 的
   历史事件不追溯生效**（明确取态——新消费者只对 bump 之后新写入的 outbox 行展开）。

   **滚动部署（rolling deploy）协议——新旧 worker 并存期的 manifest 版本协商（owner P2，此前缺）。**
   部署期会有 N（新，认识新 `consumer_key`）与 N-1（旧，不认识）两版 worker **同时在线**。契约：
   - **激活顺序 = 先迁移、后启用——且门槛是「全部 producer 与全部 worker 都认识 K」，不只 worker
     （对抗审阅 catch：漏了 producer 侧会静默漏投）。** 新 `consumer_key` K 的 manifest 条目分两步落：**先**
     部署「认识 K 的 worker + 认识 K 的 producer」，**但 producer 暂不展开 K 的路由行**（manifest 版本 bump
     与「开始展开 K」解耦）；**确认全部 worker 且全部 producer 都已升到 N、不再有任何 N-1 producer 或
     N-1 worker 在线**，**再**启用对 K 的展开。**为何 producer 侧同样致命**：dispatcher 只投**已写入的**
     `(outbox_id, consumer_key)` 行，一个**滞后的 N-1 producer** 按同事务入队契约（§Layer 1）提交事件时，
     只会写它 manifest 里的 {旧 key} 行、**根本不写 K 行**——于是这次事件对 K **永远没有行**。`pending` +
     告警防线**看不到**它：告警只在**存在**一条未知-key 行时触发，一条**从未被写入的**行无处 park、无从
     告警 = **静默漏投**。故激活门槛必须两侧对称：producer 全 N-aware 才可展开 K。
   - **支持范围 = N / N-1 双版共存**（不承诺跨 ≥2 个版本跳跃）；部署编排须保证 N-1（producer 与 worker
     两类）完全退场后才启用只有 N 认识的路由展开。
   - **未知 `consumer_key` 的处理 = 保持 `pending` + 告警，绝不误判终态。** 若一个 N-1 worker 仍读到了
     一条它不认识的 `consumer_key` 路由行（激活顺序被打破 / 回滚窗口），它**必须把该行留在 `pending`
     并告警**，**绝不**把它标 `done`、更**绝不** `dead_letter`（那会把一条本该由 N worker 处理的行错误
     地终结掉 = 静默漏投）。未知 key 是「我这版处理不了、交给认识它的 worker」，不是「处理失败」。
     **此「未知即 pending+告警」逻辑必须在 outbox dispatcher 的第一个版本就落地**——它自己在位时不会遇到
     未知 key，没有本地压力去实现它，但下一次 bump 时它就是 N-1，缺了这条就漏投。
   - 验证（两条骨架 + 用**真实的 N-1 二进制**、非「教会 pending 的 mock」）：**(worker skew)** 构造 N + N-1
     两 dispatcher 并发、制造一条只有 N 认识的 `consumer_key` 行 → 断言 N-1 **不**动它（留 pending + 告警）、
     N 正常处理；**(producer skew，对抗审阅新增)** 构造 N-1 producer 与 N producer 并发提交同类事件 →
     断言**每次事件都拿到 K 行**（即：在 producer 全 N-aware 之前 K 展开未启用；一旦启用，无 N-1 producer
     还在写缺 K 的行）——正控 = 双版都认识的 key 行被恰好一版处理、不双跑、不漏。**durable
   dispatcher（轮询或 LISTEN/NOTIFY）
   读取 pending 行后，绝不再靠把事件 `emit()` 给现有 `eventemitter3` 总线来推进持久状态**——因为
   `emit()` 返回 `void`、`dispatch()` 对 handler **不 `await`**（`event-bus.ts:33` 直接
   `this.emitter.emit(...)`，handler 类型 `void | Promise<void>` 不等待）、订阅回调内部又各自
   `.catch()` 即返回（`automation-service.ts:914/919`），dispatcher 在结构上**不可能**观察到某个
   具体 consumer 是否处理完成，也就不可能可靠推进 `(outbox_id, consumer_key)` 状态。**dispatcher
   必须直接调用并 `await` 每个命名 consumer 的 adapter 函数**（一个返回 `Promise`、成功即代表该
   consumer 对这条事件已终态处理的真实入口）：adapter resolve 成功才把该 `(outbox_id, consumer_key)`
   行标 `done`；抛错/超时 → 保留 `pending` + `attempts++`，租约（`lease_expires_at`）过期后被
   reclaim 重投。**现有 `eventemitter3` 总线降级为非承重的 best-effort fanout**——只服务于不需要
   持久保证的旁路旁听者，绝不承担 FWB/持久链任何一条 consumer 的交付状态。这替换掉今天「提交后
   才 emit」的 `emitApprovalCompletionEvent` 全部调用点；同样的提交后-emit 模式也出现在 multitable
   侧的 `multitable.record.created`/`updated`（`record-service.ts:760`、`record-write-service.ts:1421`
   等）与 `emitApprovalTaskCreatedEventsPostCommit`（`ApprovalProductService.ts:6140`），outbox 的
   覆盖面需含这些提交后 emit 点；FWB 自身写记录后要 emit 的 `multitable.record.created`/`updated`
   （D10）同样走这条 outbox 路径，见 D9 的事务边界。
2. **consumer 拓扑（本 worktree 对 `origin/main` 代码逐行核实，纠正旧稿「今天只有 automation-service
   一个消费者」的错误）**：`approval.approved/rejected/revoked/cancelled` 的下游**不是一个 consumer**
   ——`automation-service` 的**单个**订阅回调（`automation-service.ts:911-924`）在同一 tick 内**启动
   两条相互独立、各自 `.catch()` 即返回的异步路径**：`handleApprovalCompletionEvent`（bridge resume，
   `:914`）与 `handleApprovalCompletionTrigger`（fresh 规则触发，`:919`；注释 `:917-918` 明言二者
   不共享状态）；`ApprovalRecordProjectionService.subscribe(eventBus)`（`index.ts:2119`）是**第三个**
   完全独立的订阅者；`approval.task_created`（`:930`）另有一路。因此 **consumer_key 至少拆成
   `approval-bridge` / `approval-trigger` / `approval-projection`**（task_created 触发另计），每个各
   持一行 `(outbox_id, consumer_key)`（`status(pending|in_progress|done)` + `lease_expires_at` +
   `attempts`），各自成功才标 `done`。一个笼统的 `consumer_key='automation-service'` done 标记既**不
   成立**（两路各自 error-isolated，service 级根本没有单一完成信号）也**不充分**。**完整 manifest
   （事件族 → consumer_key 全集，`automation-service.ts:892-936` 订阅面 + `index.ts:2119` projection
   订阅）**：`approval.{approved,rejected,revoked,cancelled}` → {`approval-bridge`, `approval-trigger`,
   `approval-projection`}；`approval.task_created` → {`approval-task-trigger`}（`:930` 独立订阅）；
   `multitable.record.{created,updated,deleted}` 与 `form.submitted` → {`automation-record-trigger`}
   （`handleEvent` 单一 record 消费者）；以及适用事件上的 `webhook-event-bridge` consumer
   （`webhook-event-bridge.ts`）。**旧稿只枚举了 approval-completion 三消费者——`approval.task_created`、
   `record.*`/`form.submitted` 与 webhook-bridge 三条必须一并纳入 manifest 全集**，否则 outbox 展开会
   漏掉这些事件族的持久投递行。

**注册恰好一次 + 旧总线非承重 + cutover 安全（结构性守卫）。** 每个内建 consumer 在启动时**恰注册一次**
——由一个注册表在启动期**断言 consumer_key 唯一**，**重复注册是启动错误、绝不静默双跑**。

**manifest 完整性守卫必须以「注册表为唯一枚举源」+ 双向断言，否则漏投这一方向根本挡不住（对抗审阅
catch，此前的单向断言不成立）。** 关键：一个 durable consumer 若经**裸 `eventBus.subscribe('approval.approved',
anonHandler)`**（今天 `automation-service.ts:892-936` / `index.ts:2119` 就是这个形态）注册，它是一个
**匿名闭包、不携带任何 `consumer_key`**——因此**无法**从总线侧被枚举或映射回 manifest。若断言只「枚举已注册
consumer、检查每个都在 manifest 里」，它只能覆盖**「登记了却不在 manifest」**这个*可枚举*方向，而**「订阅了
却没登记」**（正是会静默漏投的方向）对断言**不可见**：这样的 consumer 拿 best-effort 投递（dev/test 全绿），
却永远拿不到 `(outbox_id, consumer_key)` 行 ⇒ commit→投递崩溃窗上**静默 miss**——恰是 outbox 要消除的。
**因此契约收紧为：**
- **outbox 覆盖的事件族，其 durable 订阅只能经一个「必须带 `consumer_key`」的单一注册表 API 完成；对这些
  事件族禁止裸 `eventBus.subscribe`**（裸订阅仅允许给**确证非承重**的旁听者，且这些旁听者不得承担任何持久
  投递语义）。
- **该注册表——而非一份手列的代码站点清单——是完整性断言的唯一枚举源。**
- **断言是双向的**：(a) 每个注册项的 `consumer_key` 都在其事件族 manifest 里；(b) 每个 manifest 条目都有一个
  活注册项。任一方向不满足 ⇒ **启动即 fail-closed**。这样「订阅了却没登记」在**编译/注册期**就无处可藏，而不是
  指望一个事后扫描去发现一个它看不见的匿名闭包。**「没有绕过注册表的 durable 订阅路径」必须由一个具体的
  强制缝落实，不能只是散文（对抗审阅 catch）**：因为 `eventBus.subscribe` 仍是给 best-effort 旁听者的公开
  方法，需明确其一——(i) **durable consumer 只经一个不暴露裸 `subscribe`、强制传 `consumer_key` 的封装注册
  API**（outbox 覆盖族拿不到裸 `subscribe` 句柄）；或 (ii) 一条 **lint / 注册期扫描**规则，禁止对 outbox 覆盖
  的事件字符串直接调用 `eventBus.subscribe`（除白名单的非承重旁听者）。有了这道缝，即便违规也在**编译/注册
  期**被挡；退一步，稳态下生产侧对这些事件族**静音**已把任何漏网的违规从「静默漏投」降级为「该 consumer
  收不到任何事件 = 测试即红/loud-dead」，不是静默 miss——但强制缝要把 loud-dead 也一并消灭在注册期。旧
`eventemitter3` fire-and-forget 路径**降级为非承重**——持久交付**只**经 dispatcher→adapter，绝不由旧
总线推进任何 consumer 的持久状态。需明确：在旧总线→dispatcher 的**切换（cutover）期间**，两条路径可能
短暂**同时 fire**；这之所以安全，**仅仅因为 sink 是幂等的**（per-consumer / per-rule 的 claim 行 +
§2.3 业务键去重）——这是**迁移安全性论证，不是「零重叠」的断言**。稳态下**双跑（两条都投）与漏投
（两条都不投）都不允许存活**。**cutover 的双跑之所以只限于切换窗，是因为本设计
**替换掉生产侧全部「提交后 emit」调用点**（`emitApprovalCompletionEvent` 等，见 Layer 1 第 1 条）——
切换后旧总线对这些事件族**静音**（生产侧脱钩），仍订阅旧总线的 durable consumer 不会二次触发；因此
必须显式声明：**要么 durable consumer 从 best-effort 总线脱钩、要么 dispatcher 复用原始事件 identity
作为 per-rule 去重基准**（下条）。

**三条 producer/identity 契约（对抗审阅 catch，manifest 展开后必须补齐）：**
- **producer 侧原子入队覆盖 manifest 全部事件族，不止 approval-completion。** manifest 新纳入的
  `record.*`/`form.submitted`/`task_created`/webhook-bridge，其 outbox 行**必须与各自的源变更（记录写 /
  表单提交 / 任务创建）落在同一事务**。否则一条 `record.created` 的 outbox 行在**另一个**事务里、pre-commit
  崩溃 = **事件丢失**，at-least-once 在 producer 侧就被击穿——早于 dispatcher/fence/sink 任何逻辑。旧稿只对
  approval-completion 声明了事务入队；本条把它扩到全 manifest 族。验证：对每个非-approval 族，在源变更
  commit 与 outbox 入队之间 kill → 断言事件不丢（单事务入队）。
- **共享非-FWB consumer 的 net-once 需要 dispatcher 转发原始事件 identity。** 对
  `automation-record-trigger`（`record.*`/`form.submitted`）而言，其 `_eventId` 今天是 `withAutomationEventId`
  贴的**新传输戳**、而 #4196 账本是 execution-scoped——若 dispatcher 不把**原始事件 identity** 作为 per-rule
  去重基准转发下去，「sink 幂等保证 net-once」就只是**断言而非证明**。契约：dispatcher 转发原始
  `_eventId`（或等价稳定事件键）供 `event_fires` dedup_key 使用，使 cutover 双投在这些共享 consumer 上也
  collapse 成一次。
- **外发动作的 net-once 依赖 endpoint 幂等键，而该键必须绑定稳定事件/动作 identity、跨 fence token 不变。**
  fence-CAS 只让**持久状态**单写；一个活着的僵尸（fence N）与其 reclaimer（fence N+1）**都会执行外发那一次
  send**（外发不受 fence 保护，见 §Class-B / #4196）。若传给 endpoint 的幂等键是 per-fence / per-attempt 的,
  两者发出**不同键** → endpoint 双执行 = 正是 fencing 叙事要限制的双外部效果。契约：外发幂等键**由稳定
  的事件+动作 identity 派生，绝不含 fence token / attempt 序号**；端点不支持幂等键 → 记 `outcome_unknown`
  不自动重发。验证：构造僵尸+reclaimer 都到达 send → 断言 endpoint 收到**一次有效请求**（键跨 fence 相同），
  配正控。

3. **两层粒度不可混同 + 交付语义最终措辞（替换旧稿一切「exactly once emit」）**：`approval-trigger`
   这一个 consumer 内部会命中**多条**规则，每条规则各自在 `meta_automation_event_fires`
   （`PRIMARY KEY (rule_id, dedup_key)`）维护自己的 claim/终态——**一条 consumer 级 `done` 绝不能
   等同于「该 consumer 名下所有规则都执行完毕」**。语义：`approval-trigger` adapter 只有在把本事件
   命中的**每一条**规则的 `event_fires` 都推进到**某个终态**之后，才允许 resolve、dispatcher 才允许标它的
   `(outbox_id, 'approval-trigger')` 行为 `done`。**「终态」是集合 `{done, outcome_unknown, failed,
   dead_letter}`（成功 `done`；外发歧义 `outcome_unknown`，第 6 条；确定性永久失败 `failed`/`dead_letter`
   经有界 attempts，见下「中毒事件的终态」）——四者都是 resolve-permitting 终态**，否则一条被判定
   `failed`/`dead_letter` 的规则会永远挡住 adapter resolve（round-5 新增 `failed` 终态后必须显式纳入,
   消除术语漂移）。`meta_automation_event_fires` 因此从「一次性
   INSERT 终态墓碑」升级为 `status` + `lease_expires_at` + `attempts` 的**逐 `rule_id` 租约**
   （`claimEventDelivery` 变原子 claim-or-reclaim：`INSERT … ON CONFLICT … DO UPDATE … WHERE
   lease_expires_at < now()`；`executeRule` 成功才 `done`）——它是 per-rule 的 sink 幂等行，与
   per-consumer 的 outbox 状态行是**两个不同粒度**，不可互相冒充。据此交付语义分两层：**(a)
   transport 层 = dispatcher→adapter 的调用，是 at-least-once**（adapter 副作用已落但标 `done` 前
   崩溃 → 租约过期后 reclaim 重投）；**(b) 净效果恰好一次完全来自 sink 侧幂等**——事件级是各
   consumer 自己的 claim 行（`meta_automation_event_fires` 逐 `rule_id` / 未来其他 `consumer_key`
   各自的 claim），业务级是 §2.3 的 `instance_id + rule_id + action_key` UNIQUE 键。旧稿中任何读作
   transport 层承诺的「恰好一次 emit」/「handler ack 之后才标 dispatched」措辞均为对底层机制的
   误描述，以本节为准删除。

**每个 consumer sink 自身必须可恢复（owner 复核新增，关键）——`await` 只让 dispatcher *可观察*，不等于
sink *可恢复*。** 以 bridge（`approval-bridge`）为例：今天 `claimCompletion`
（`automation-approval-bridge-service.ts:312`）执行 `UPDATE … SET status='resumed' … WHERE
status='pending'`——**在 continuation 真正跑完之前，就把状态从 `pending` 写成 `resumed`（一个终态墓碑，
不是租约）**。若在 claim 之后、`continueExecution()` 之前崩溃，重投的 `claimCompletion` 找不到
`status='pending'` 行 → 返回 `null` → adapter 直接返回 → 续跑工作**永久丢失**；若尾部动作跑到一半崩溃，
还需 #4196 的 action-level 幂等才能安全重放。因此每个 sink（尤以 bridge）**必须自身满足**：**(a)** 用
`pending / in_progress / done` 租约——`claimCompletion` 只把 `pending → in_progress` 并写
`lease_expires_at`，**不预写 `resumed`/任何终态**；**(b)** 只有在 continuation 与执行日志**持久化完成
之后**才标 `done`（bridge 原 `resumed` 语义并入 `done`）；**(c)** 租约过期即可被 reclaim 重领；**(d)**
续跑中的尾部动作经 #4196 分类账保证**可重放、净效果幂等**。`approval-projection` / `approval-trigger`
的 sink 同理——各自的终态标记只能在其副作用持久化之后落。**验证（真库崩溃注入，三窗，各配正控）**：①
claim 之后、首个尾动作之前崩 → 重投 reclaim、续跑恰好一次；② 首个尾动作之后、continuation 未完崩 →
reclaim 后尾动作经 #4196 账本**不重复落地**；③ 全部尾动作完成、标 `done` 之前崩 → reclaim 发现工作已
幂等落地、只补标终态、**不重复副作用**。正控：无崩溃路径 continuation 恰好跑一次且标 `done`。

**租约 fencing —— 处理「僵尸」执行者（owner 复核新增，关键）。** 前述所有 reclaim 场景都默认
「前持有者已崩溃」。但基于时间的租约还有一种**未崩溃**的失败：持有者 A 领到租约（TTL 30s）后**释放
行锁、在锁外执行**，若 execute 慢（GC 停顿 / 下游慢，45s），到 30s 租约过期而 **A 仍活着仍在执行**，
另一 relay B 在 `SKIP LOCKED` 下 reclaim 同一行并并发执行——`t=30–45s` 内 A（僵尸）与 B 同时对同一行
执行。这**证伪**了「同一 lease 期内无并发双持有」被当作全程保证的读法：无双持有只在**持锁期间**成立，
锁外的 post-lease 执行窗口需要 **fencing** 才安全。**契约：**
- **每一个持有「可被 reclaim 的租约状态」的行都带一个单调 `fence`（epoch），每次 claim/reclaim 自增——
  这条是普适规则，下面的枚举是示例、不是穷举。** 至少覆盖：`(outbox_id, consumer_key)` outbox 状态行、
  per-rule `event_fires` 行，**以及 bridge 自己的续跑租约行**（`automation_approval_bridge` 的 `status`——
  今天 `claimCompletion` 在 continuation 前把它写 `resumed`，`automation-approval-bridge-service.ts:265/312`，
  这是**第三种** durable-status 行，同样必须带 fence，否则一个僵尸 bridge 的终态写会「落地」）。worker 携带
  其 claim 时的 `fence`。
- **对持久状态（`status`/`done`/outcome）的任何写入必须 fence-CAS**：`UPDATE … SET status='done' …
  WHERE id=$1 AND fence=$myFence`。被 reclaim 过的僵尸其 `fence` 已过期 → CAS 命中 **0 行** → 它**据此
  得知已被接管**，必须**中止、不得完成或标记副作用**。据此**持久状态是单写者**：reclaimer 的 fence 权威,
  僵尸的状态写全被拒。
- **class-A 同库写**由业务键 claim（`ON CONFLICT`）天然 fence，僵尸的写撞唯一约束回滚。**class-B 外发**
  的外部端点不认我们的 fence，无法阻止僵尸**已发出**的那一次调用——因此：(i) 长执行必须**续租/心跳**
  以收窄僵尸窗口，(ii) 发送**紧邻前**再断言 fence 当前，(iii) 外发本就是 **at-least-once**（僵尸只是又一个
  at-least-once 来源，非新增语义）——需真正一次的外部效果由**传给端点的幂等键**去重，端点不支持则按
  §Class-B 记 `outcome_unknown`、绝不自动重发。**「无并发双持有」的断言必须限定为持锁期，不得表述为
  覆盖 post-lease 执行窗口。**

**中毒事件的终态（owner 复核新增）。** `status` 状态机不能只有 `not-done(可 reclaim)/done`：一个
**确定性永久失败**的 execute（如目标记录在执行中途被删）永远到不了 `done`，每次租约过期就被重新
reclaim → **无界重试风暴**、该 `consumer_key`/`rule` 永不收敛。**契约：** 状态机新增终态
`failed`/`dead_letter` + **有界 `attempts`**；超过上限即置终态（**非无限 reclaim**），并留**告警 /
dead-letter seam**。`outcome_unknown`（§Class-B）只覆盖外发歧义，**不覆盖**确定性记录写失败——后者走
本条的终态-失败。**验证须新增**：僵尸腿（活着但租约过期的持有者 + reclaimer → 断言 fence-CAS 拒掉
僵尸的终态写，持久状态恰一次落地）；中毒腿（确定性永久失败 → 有界 attempts 后置终态-失败，非无限
reclaim；正控：一次性失败在下一次 reclaim 成功）。

4. **并发 dispatcher 的正确性（critique catch，纠正旧稿把两种机制都称「单飞」）**：两种机制给的
   保证**不同**，实现 PR 必须明确选定其一并按对应语义验证——**leader lock**（复用
   `ApprovalProjectionSweepScheduler` 已有的 Redis leader lock 形态，
   `ApprovalProjectionSweepScheduler.ts`）⇒ **单实例执行**（同一时刻只有 leader 那一个 dispatcher
   在跑，真正的「单飞」）；**对 outbox 行做 `SELECT … FOR UPDATE SKIP LOCKED`** ⇒ **允许多个
   dispatcher 同时运行**、各自领走**不同的**行并行处理，给的只是**同一 lease 期内每行至多一个持有
   者**，**不是**单实例执行、也**不保证**某行跨崩溃 + 租约重领后只被处理一次（那要靠 sink 幂等，
   第 3 条 (b)）。验证腿须按所选机制**分别**断言（单实例 vs 逐行无并发双持有 + 允许重投 + sink 净
   效果一次），不可都写成「单飞」。
5. **迁移回填（关键，critique catch）：** `event_fires` 从「终态」迁到「租约」时，**必须**把已部署
   环境里全部既有行回填为 `status='done'`，否则部署当天历史上已经完成投递的事件会在新 schema 下
   被判定为「从未 done」而在下一次扫描时重新触发。**验证必须走升级路径，不能用 fresh-DB 全量
   migrate 代替**：先把库迁到**目标迁移之前的旧 schema**、直接写入历史 `event_fires` 行（模拟存量、
   未回填数据）→ 再执行目标迁移并启动 dispatcher → 断言历史行被回填为 `status='done'` **且不重发**。
   fresh-DB 全量 migrate 会让历史行随目标迁移一起以已回填状态创建，**不覆盖**升级期回填这条真实路径，
   不能替代。
6. **重投的动作分级（critique catch，接 #4196）：** 一旦持久化让事件可以重投，记录写类动作走
   幂等账本（**净效果**恰好一次，经幂等键去重——不是 transport 层保证一次，是 sink 侧幂等）；
   **通知/发送类动作**（`send_notification`/`send_webhook`/`send_email`/
   `send_dingtalk_group_message`/`send_dingtalk_person_message`——`APPROVAL_COMPLETED_ALLOWED_ACTION_TYPES`
   `automation-service.ts:111-117`，**今天 `approval.completed` 上唯一允许的动作类别**）标记
   `outcome_unknown`、**不做盲重发**（重试按业务语义分级：网络错误 ≠ 未执行；交叉引用 #4196
   Class-B）。
7. **验证：** 真实 DB 崩溃注入矩阵——窗口 1（commit 后、dispatcher 派发前 kill，重启 → outbox 行
   仍在，dispatcher 重新 await adapter，sink 侧净效果恰好触发一次）；窗口 2（claim 租约后、
   `executeRule` 前抛错，时钟推过租约过期 → 被 reclaim，sink 侧净效果恰好一次）；构造并发
   dispatcher/投递竞态（按第 4 条所选机制分别断言）；**per-consumer 独立推进**：让某个命名 adapter
   （如 `approval-trigger`）抛错 → 断言其 `(outbox_id, consumer_key)` 行**不**被标 `done`（保持
   pending、`attempts++`、租约过期后重投），而**同一 outbox 行**的其他 consumer（如
   `approval-projection`）仍各自独立标 `done`；**per-rule 完成**：`approval-trigger` 命中两条规则、
   其中一条 `executeRule` 失败 → 断言该 consumer 行在两条规则**都**终态前**不**标 `done`，且失败规则
   的 `event_fires` 行仍可 reclaim。**强制正控腿**（无崩溃路径 → sink 侧净效果恰好触发一次；租约未
   过期时的重投 → 必须被挡）；断言点落在投递 sink（消费者侧的幂等 claim/账本行）与
   `(outbox_id, consumer_key)` 状态行，不是被 spy 的方法，也不是「`emit()` 被调用了几次」这类
   transport 层调用计数。

**明确结论：这条持久链路必须在任何 FWB 切片上线前落地。** 另需注记：#4196 的 Class-A 账本
（`meta_automation_action_applied`）**尚未落地**（本 worktree 对 `origin/main` 全仓搜索无迁移、
无 src 引用；PR #4196 当前状态 OPEN/PROPOSED），且它是 **execution-scoped**（以 `root_execution_id`
为维度，仅在派发**已经开始之后**才原子）——它本身**不能**让「完成→投递」这条链路变得持久；Layer 1
与 #4196 是正交的两层修复，都要落地，谁也不能替代谁。

## Layer 2 — 一等公民 `record-link` 审批表单字段（解锁 FWB-2）

**PROPOSED——本次修订新增，非共同设计轮已裁项，待 owner 与本锁一并 ratify。** FWB-2（§5，回写
已有记录）的目标寻址方式是 D3 已裁决的「经审批表单里的 linked-record 字段解析目标记录」——但
**这个字段类型今天不存在**，D3 目前是一个指向空气的裁决。

**现状核对（本 worktree 对 `origin/main` `cb58e00a0` 逐行验证）：**

- 后端权威枚举 `FormFieldType`（`packages/core-backend/src/types/approval-product.ts:57`）与前端
  镜像枚举（`apps/web/src/types/approval.ts:35`）内容完全一致，都只有
  `text | textarea | number | date | datetime | select | multi-select | user | attachment | detail`
  ——没有任何指向 multitable 记录的字段类型。
- 发布时校验 `normalizeFormField`（`ApprovalProductService.ts:657`）在 `:669` 对
  `FORM_FIELD_TYPES.has(String(value.type))` fail-closed 拒绝一切未知类型（`FORM_FIELD_TYPES` Set
  定义于 `:321-332`）——补上这个类型之前，任何试图声明「链接到记录」字段的表单模板发布都会被直接
  拒绝，FWB-2 无字段可读。
- 表单值提交侧的类型校验 `validateFieldType`（`ApprovalGraphExecutor.ts:328`）对未识别的
  `field.type` 落进 `default` 分支（`:363-364`）**直接放行**（返回 `null` = 校验通过）——若只放开
  枚举而不加校验分支，任意值（数组、字符串、伪造 id）都会被无校验地写进 `form_snapshot`，FWB-2
  据以寻址的目标记录就不可信。

**设计（仅设计，PROPOSED，待 owner ratify）：**

1. **Schema：** 同时扩展后端枚举（`approval-product.ts:57`）与前端镜像枚举
   （`apps/web/src/types/approval.ts:35`），并把 `'record-link'` 加入 `FORM_FIELD_TYPES` Set
   （`ApprovalProductService.ts:321`）。**v1 故意排除在 `DETAIL_LEAF_FIELD_TYPES` 之外**——该集合
   由 `FORM_FIELD_TYPES` 派生并剔除 `'detail'`（`:337-338`），新增类型默认会被继承进去，需要显式
   排除：linked-record 嵌进逐行明细子表单的语义（一行一个链接目标，还是整组共享一个）v1 不趟，
   只做顶层字段。
2. **发布校验（`normalizeFormField`）：** 复用既有「按类型做额外结构校验」的模式（`:899` 对
   `target.type === 'detail'` 的同类分支），为 `record-link` 加一个同级校验：要求
   `props.baseId` 与 `props.sheetId`（`FormField.props?: Record<string, unknown>`，
   `approval-product.ts:283`）均为非空字符串，且服务端在发布时把两者**定死**——publish-time
   校验 + 创建者对该 base/sheet 有读权限才允许把它选进模板，避免规则创建者把表单指向自己看不到
   的表。
3. **取值校验（执行器 `validateFieldType`，`ApprovalGraphExecutor.ts:328`）：** 新增
   `case 'record-link'`：合法值 = **恰好一个**结构化 `{ recordId: string }`，且 `recordId` 所指
   记录必须落在 `props` 定死的 `sheetId` 范围内；数组、0 个、2+ 个、裸字符串/自由文本 record-id
   **一律 REJECT**（fail-closed）——配一条正控腿：合法的单一 `{ recordId }` 必须通过。**这一步是
   同步的结构校验，不能替代下面第 4 条的鉴权**——`validateFieldType`（`ApprovalGraphExecutor.ts:328`）
   是**同步**函数，不能发起数据库查询，因此结构上就不可能在这里判断「填表人是否有权读到 TA
   选中的那条记录」；这一层只管值的形状合法，不管值背后的权限。
4. **submit-time 服务端异步鉴权（新增，混淆代理人 / confused-deputy 防线）：** 现有设计（第 3 条）
   只校验值的结构，完全不检查提交表单的**填表人（filler）**是否有权读到 TA 选中的那条记录——这是
   一个混淆代理人缺口：filler 的读权限通常远小于规则创建者，若不检查，filler 可以在 submit 时
   选中一条自己读不到、但规则创建者能写的记录，从而把「该 record-id 存在」这一信息侧信道地泄露
   出去，也让规则创建者的写权力被 filler 的选择间接操纵到任意目标。**新增一步独立于
   `validateFieldType` 的服务端异步鉴权**（因为需要查库，不能塞进上面第 3 条的同步校验函数）：
   确认提交表单的 filler 对所选 `recordId` 具有读权限；不满足 → 按第 6 条的统一 fail-closed
   形状拒绝。
5. **execute-time 复检（新增）：** `write_approval_form_values` 执行前，除 §5 已有的「同/跨 base
   复检」「记录锁」「字段类型 fire 时复验」外，新增确认所选记录**仍然存在**、**未被锁定**、且
   **规则创建者对其有写权限**——submit 时间与 execute 时间之间，记录可能已被删除、锁定，或规则
   创建者的写权限已被收回；三者任一不满足 → 整步 REJECT（终态语义见 §11 Q1）。
6. **统一 fail-closed、禁止存在性泄漏（新增）：** 无论「记录不可读」还是「记录不存在」，第 4 条
   （submit-time filler 鉴权）与第 5 条（execute-time 规则创建者复检）的失败**必须是同一种失败
   形状**（同错误码、同提示文案、同响应结构、同响应时延量级）——不得让调用方通过区分「不可读」
   vs「不存在」的差异，反推出一个自己读不到的 record-id 是否存在（existence oracle）。
7. **前端：** 单记录选择器，选择范围锁死为服务端定死的 `sheetId`（填表时不可改选其他表）；**不
   提供自由文本 record-id 录入框**——杜绝「手填一个假 id」的注入面。
8. **`record-link` 必须先落地，FWB-2 才能被 ratify / 开工。** 另需注记（2026-07-13 订正，此前
   口径有误）：取值校验的 fail-closed 契约**必须在服务端强制**——`apps/web` 的字段校验单测现在
   跑在 `web-tests` 这个**必需**（required）CI check 里：branch protection 的
   required status checks 现含 `contracts (strict)` / `contracts (dashboard)` / `pr-validate` /
   `test (20.x)` / `contracts (openapi)` / **`web-tests`**；required 的 `test (20.x)` 仍然只负责
   把 `apps/web` **构建**通过，真正跑 vitest 规格的是 `web-tests`
   （`.github/workflows/web-tests.yml` → `apps/web/scripts/run-required-web-tests.sh`）。**但
   `web-tests` 是白名单式必需闸**——只跑该脚本里显式列出的测试文件，新增 spec 不会自动被纳入，
   必须显式登记进 `run-required-web-tests.sh`（与 `approval-web-guard` / `multitable-web-guard`
   的「新增测试需两处同步登记」纪律一致）；`record-link` 的前端字段校验单测要真正被这道必需闸
   挡到，需要显式加入该脚本，不能假设「写在 `apps/web` 下就自动必需」。更根本的是：即使前端单测
   必需绿灯，前端校验本身仍可被绕过（直连 API 提交表单值）；只有服务端的 `validateFieldType`
   与发布时的 `normalizeFormField`、以及本节新增的第 4/5/6 条鉴权，才是真正、不可绕过的闸。

---

## 3. v1 已裁决决策清单（DECIDED——owner 口径，随本锁 ratify 后即为实现契约）

| # | 决策 | 内容与理由 |
|---|---|---|
| D1 | 触发 outcome | **仅 `approved`**。含 FWB 动作的规则，`trigger_config.outcomes` 锁定为 `['approved']`，save 时拒绝其他取值。rejected/cancelled 的回写见 §11 Q2（v2 事项）。 |
| D2 | FWB-1 目标 | **规则自己的表**（`rule.sheet_id`，规则本就 sheet-scoped，载荷 `sheetId: rule.sheet_id` `automation-service.ts:2559`）。**FWB-1 无跨 base**——建新记录没有表单锚点，字面跨 base 目标会重开 W7 Q2 的字面 triple 争论，v1 不碰。 |
| D3 | FWB-2 目标寻址 | 经**审批表单里的 linked-record 字段**解析目标记录（表单锚定 = 发起人指了哪条就是哪条，可审计）；跨 base **由此才解锁**，过 `evaluateCrossBaseWriteGate`（§2.2 身份）。v1 要求链接值**恰一条**记录，0 条或多条 → 整步 REJECT（fan-out 见 §10）。 |
| D4 | 数据源 | 服务端按 `instanceId` 读**不可变 `form_snapshot`**；表单值永不进事件载荷/动作配置（§1）。 |
| D5 | 缺失字段 | 映射的 `formFieldId` 在快照中不存在/无值 → **整步 REJECT**。绝不把缺失捏造成 `0`/`null`/`''` 写进记录（对齐「审计面不得捏造」纪律）。 |
| D6 | select | 目标字段无对应选项 → **REJECT**；**无 create-on-write**（自动化不静默改表结构）。 |
| D7 | number | 以 **decimal 定点字符串**规范化流转（避免 JS float 损失）；上限/超限处理见 §11 Q5。 |
| D8 | date / dateTime | **分开处理，无隐式时区转换**。date 按日历日字面写入；dateTime 按快照存储的 UTC epoch 语义写入。任何「猜测时区」都被禁止。 |
| D9 | 事务边界 | **claim（§2.3 键）+ 记录写 + revision + outbox 写 = 一个数据库事务。** 同事务落盘样式继承两条已有/已落地的模式：#4196 Class A 的 claim-then-write 样板（`approval-automation-retry-action-classification-designlock-20260712.md` §2，PR #4196，PROPOSED）；以及 #4247 **已在 main** 落地的「`meta_records` 写同事务落一行 revision，声明其 disposition」样式（`fix(multitable): W0 slice③ — automation create_record/update_record emit automation revisions`）。执行顺序：claim INSERT `ON CONFLICT DO NOTHING` 0 行 → ROLLBACK 报 `already_applied`；1 行 → 业务写 + revision + outbox 写（Layer 1，携带 `_automationDepth`）→ COMMIT。崩溃任意点，claim、记录、revision、outbox **四者同存同亡**，无「只剩一半」窗口。**claim 落 FWB 自有的 instance-scoped 账本**（§2.3 键），不是 #4196 的 `meta_automation_action_applied`（见 §9 第 1 条）。 |
| D10 | 事件与投递 | 成功 COMMIT 时，业务写、revision 与 outbox 行**同事务**落盘（携带本执行的 `_automationDepth`，下游继承 +1）；outbox 行由 Layer 1 的 durable dispatcher **直接 `await` 每个命名 consumer adapter** 投递（transport 层 **at-least-once**，不经 `eventemitter3` 推进持久状态），净效果恰好一次由消费者侧幂等 claim 保证（§2.3 UNIQUE 键 / `meta_automation_event_fires` 逐 `rule_id` 租约），**不是 transport 层的单次保证**；REJECT/ROLLBACK 路径不落 outbox 行，零投递。 |
| D11 | 动作形态 | 专用受限动作 **`write_approval_form_values`**，不复用 `create_record`（§1）；`APPROVAL_COMPLETED_ALLOWED_ACTION_TYPES`（`automation-service.ts:111-117`）**只**放行这一个新动作，`start_approval` 与通用记录写继续被 save 拒绝。 |

---

## 4. FWB-1 — 审批通过 → 新建记录（~4-6 pd）

**契约。** `write_approval_form_values` 配置 `mode: 'create'`：

- 目标 = 规则自己的表（D2）；无跨 base、无字面目标（同一表 → 走写闸的 same-sheet 快路，零回归）。
- 映射 = `[{ formFieldId, targetFieldId }]` 显式数组；类型面 v1 = **number / text / date / select**
  四类（每类语义见 D5-D8）；attachment 字段属 #4195 附件管线线，OUT（§10）。
- 读快照走 §2.1 导出白名单；写路径走 D9 单事务 + §2.3 `UNIQUE(instance_id, rule_id, action_key)`。
- 默认行为即「approved 后创建」（D1 已把 outcome 锁死）。
- save 校验：映射非空、targetFieldId 存在且类型受支持、创建者可读模板（§2.1 第 1 条）+ 目标表可写。

**实现位面。** 回写服务落 `packages/core-backend/src/multitable/`（消费审批读侧，不改
`ApprovalProductService` 热文件——§9 排序依赖这一点）；动作注册进 automation-executor 与其余动作
同位，天然进 retry/test-run 治理面（`simulate` 抑制 = #4196 §6 的 Class A 语义）。

## 5. FWB-2 — 审批通过 → 回写已有记录（~3-5 pd）

**契约。** `mode: 'update'`：

- 目标 = 表单 linked-record 字段所指记录（D3，恰一条）；目标表由链接字段的模式决定。
- **同/跨 base 复检**：目标表 base ≠ 规则表 base → `evaluateCrossBaseWriteGate` with rule-creator
  （§2.2）；同 base 快路不加新闸（零回归）；配额与 update/create/delete/lock 及 T3-5 共享单例。
- **记录锁**：写前按既有 `ensureRecordNotLocked` 语义检查（用规则创建者身份）；锁住 → 整步 REJECT。
- **字段类型 fire 时复验**：目标字段自 save 后可能被改型/删除——fire 时逐字段复验类型与存在性，
  失配 → 整步 REJECT（无部分写：一步的全部字段在同一事务里，任一失配即全滚）。
- **`record-link` 读权限（Layer 2 新增，见该节第 4/5/6 条）**：目标记录由表单 `record-link` 字段
  解析而来——submit 时已要求校验 filler 对该记录的读权限；execute 时本条与上面「记录锁」「字段
  类型 fire 时复验」并列，再复检记录存在 / 未锁 / 规则创建者可写；三类检查的失败**统一 fail-closed
  形状**，不得让「不可读」与「不存在」产生可区分的响应（存在性泄漏，见 Layer 2 第 6 条）。
- **目标记录缺失/已删** → fail-closed 不写；终态语义（failed-可重试 vs skipped-终态）见 §11 Q1。
- 幂等仍是 `instance_id + rule_id + action_key`（同一实例对同一动作至多一次成功更新）。
- 事件环路：emit `multitable.record.updated` 携深度（D10），§7 收束。

## 6. FWB-3 — 审批人核定值（**8-12 pd，向上修正**；greenfield，最重）

`decisionData` / 节点核定字段今天**不存在**——无 schema、无捕获点、无冻结语义，全部新建。原估
5-8 pd 过于乐观，**修正为 8-12 pd**：它横跨审批状态机热文件（捕获+冻结）、模板 authoring
（节点核定字段配置）、回写服务（消费冻结值）三个面。

**Schema（owner 已定）：专用表 `approval_node_decision_values`，不塞通用 metadata。**

```
approval_node_decision_values (
  instance_id    -- 审批实例
  node_key       -- 产生核定值的节点
  entry_epoch    -- 该节点第几轮进入（复用既有 entry_epoch 语义，§2.3）
  assignment_id  -- 哪个 assignment 的审批动作提交的
  field_id       -- 核定字段
  value          -- 冻结值（D7/D8 规范化后）
  actor_id       -- 提交核定值的审批人
  created_at
)
```

**捕获与冻结（owner 已定）：** 节点配置声明核定字段（如「核定金额」）；审批人 approve 时随
动作提交 `decisionData`；**校验 + 冻结必须发生在 `dispatchAction` 的实例锁事务内**
（`ApprovalProductService.ts:4780`，实例行 `FOR UPDATE` `:4793`）——与状态迁移同锁同事务，
并发双 approve 在锁下串行化，每 `(node_key, entry_epoch)` 至多一套冻结值。冻结后不可改；
回写只读冻结行，**永不读请求原始载荷**。

**transfer / jump / timeout（fail-closed，owner 已定）：** 这三类迁移**不携带核定值**——配置了
核定字段的节点若经转办/跳转/超时离开（`approval-node-timeout-effects` 覆盖区），该
`(node_key, entry_epoch)` 无冻结行；回写发现核定值不完整 → **整步 REJECT，绝无半写记录**。
退回后重入节点 = 新 `entry_epoch`，新一轮核定值重新提交，幂等键随之翻新（§2.3）。

## 7. 事件与循环边界

`approval.completed` v1 用「禁记录写」结构性防环（`automation-service.ts:105-108`）；FWB-1 受控
打开这道门后，环路形态为：FWB 写记录 → `record.created` → 记录规则 → `start_approval` → 审批
通过 → FWB……**收束依赖深度闸，FWB 必须全程参与：**

- 完成事件消费侧已有深度继承：桥接审批续父链 depth+1，人发起审批从 0 起
  （`approvalBridgeAutomationDepth`，`automation-service.ts:2532-2537`）；
- FWB 写记录 emit 的事件**必须携带本执行深度**（D10），下游规则照常 +1，链条在
  `MAX_AUTOMATION_DEPTH = 3`（`automation-service.ts:79`）处停；
- 结构闸不全拆：`start_approval` 在 `approval.completed` 规则上**继续被 save 拒绝**（D11）——
  环必须绕经「记录事件 → 另一条规则」才可能形成，且被深度闸有界截断（§8 V6 构造性证明）。

## 8. 验证计划——要求 PROVEN，不止 tested

每条「不发生」断言都配**正控腿**（standing 纪律：全 fail-closed 套件观测一坏就空转变绿）。

- **V1 幂等双发。** 构造同 `(instance, rule, action)` 的重复派发——并发双发（两连接同时进事务）
  与串行重放（retry 路径）各一——断言 `meta_records` 恰一行、claim 恰一行。**正控：** 换一个
  `instance_id` 的第二次派发**必须**产出第二行（证明「恰一行」断言有判别力）。
- **V2 同事务原子性（D9 的构造性证明，四件套）。** 注入 claim 后 / 业务写后 / revision 写后 /
  outbox 写后、COMMIT 前的故障 → 断言 claim 行、记录行、revision 行、outbox 行**四者皆不存在**；
  随后无注入重放 → **四者皆存在**（正控同腿完成）。
- **V3 导出白名单。** 映射外的表单快照字段永不落库：构造一条规则未映射的字段有值 → 断言其**不出现**在回写记录里。**正控：** 已映射字段照常落库（证明「不出现」断言有判别力，非空转）。
- **V4 身份 fail-closed。** save 后剥夺创建者的模板可见 / 目标表写权 → fire 双腿各自拒、零写、
  步态可观测；auto-approve（事件 actor = null）下授权创建者**照常写成**（正控 + 证明 §2.2 裁决：
  写身份与事件 actor 解耦）。跨 base 腿：无授权创建者被 `evaluateCrossBaseWriteGate` 拒。
- **V5 类型边界。** 缺失字段 / select 无选项 / number 超限 / date-dateTime 混用，各一条 REJECT 腿
  （零写零 emit）+ 各一条合法值绿腿。
- **V6 环路有界（构造并发/链条，非顺序论证）。** 构造 FWB → `record.created` → 规则 →
  `start_approval` → 通过 → FWB 的真实链，断言在深度阈值处停（递归守卫日志 + 无第 N+1 条记录）。
  **正控：** 阈值内的链**必须**走通两跳（证明「停」不是「根本没跑」）。
- **V7 FWB-3 冻结。** approve 携 `decisionData` → 锁事务内冻结行存在；并发双 approve → 每
  `(node_key, entry_epoch)` 恰一套；timeout/jump/transfer 离开节点 → 无冻结行且回写 REJECT；
  退回重入 → 新 epoch 新冻结、旧 epoch 不复用。
- **V8 事件投递净效果恰一次。** 成功路径的 outbox 行同事务落盘且携深度；下游 sink（消费者侧幂等
  claim，见 D10/Layer 1）净效果恰一次消费——**不是断言 `emit()` 只被调用一次**（transport 层是
  at-least-once，见 Layer 1）；一切 REJECT/ROLLBACK 路径不落 outbox 行、零投递。**正控：** 成功腿
  的事件必须被下游真实规则消费到（防 spy 对空串绿）。

## 9. 排序与并行（owner 已定；第 0 条为本次修订新增，PROPOSED，待 owner 一并 ratify）

0. **Layer 1（持久化 outbox + 租约投递）与 Layer 2（`record-link` 字段契约）先行**：FWB-1 依赖
   Layer 1——否则「approved 但记录没建/建了两次」的窗口就在完成事件本身，§7 的环路收束论证也建立
   在「完成事件的 consumer sink 净效果恰好一次」之上（transport 是 at-least-once，净效果一次由 sink
   幂等保证，非「emit 恰好一次」）；FWB-2 额外依赖 Layer 2——否则 D3 的 linked-record 寻址无字段
   可用。二者彼此正交，可并行设计/实现；与下面第 1 条 #4196 的关系：#4196 补的是动作层幂等账本
   **机制**（同事务 claim-then-write 的样板），Layer 1 补的是完成事件从产生到投递这条**链路**本身
   的持久性——两层修复正交，都要落地，谁也替代不了谁（详见 Layer 1 末段）。
1. **#4196 先行**：Class-A 同事务账本的最小 substrate 先落——FWB 的 D9 复用它的**同事务机制**与
   C4 `action_key` 身份，但 **必须自建 FWB 自己的 instance-scoped 幂等账本**（区别于 #4196 的
   `meta_automation_action_applied`）。原因：#4196 的账本是 **execution-scoped**
   `UNIQUE(root_execution_id, action_key)`——同一审批完成若经**新的** `root_execution_id` 重投
   （retry / 不同 eventId 路径），#4196 账本**不去重**，`executeCreateRecord` 会再铸一条
   `rec_<uuid>` 重复记录。FWB 的去重身份必须是 §2.3 的
   `instance_id + rule_id + action_key`（FWB-3 另加 `node_key + entry_epoch`）。
   「不自建账本」的说法不成立——复用的是机制与身份构件，账本表本身 FWB 自有。
2. **FWB-0（本锁）与 #4195 附件管线锁一起 ratify**（一批裁决，界面互斥：附件字段回写属 #4195 线）。
3. **Lane F**：FWB-1 → FWB-2（同一服务面顺序推进）。
4. **Lane A**：附件 runtime 与 FWB-1/2 **并行**（文件面 vs multitable 面不相交）。
5. **FWB-3 最后**：等附件线释放 `ApprovalProductService` 热文件后再动（FWB-3 的捕获/冻结必须改
   `dispatchAction`，与附件线同文件，串行避撞）。
6. retry Class-B outbound 语义按 #4196 继续，与本线无交叉。

## 10. 明确不做（v1 OUT）

- `rejected` / `revoked` / `cancelled` outcome 的回写（§11 Q2 是否给 v2 opt-in）。
- FWB-1 跨 base；一切不经表单 linked-record 锚定的跨 base 目标；字面 targetRecordId triple。
- select 选项 create-on-write；任何由自动化静默修改表结构的行为。
- linked-record 多值 fan-out（一次审批更新 N 条记录）——v1 恰一条，多值整步 REJECT。
- attachment 字段回写（归 #4195 附件管线线）；formula/lookup/rollup/link 作为**写目标**字段类型。
- 隐式时区转换、缺失值捏造、静默截断（超限一律 REJECT，§11 Q5 定上限语义）。
- 任何新权限/RBAC 模型（§2.2 只复用既有双时点授权 + 跨 base 写闸）。
- 已完成历史实例的存量回补（backfill）——只对 ratify 后新完成的审批生效。
- 事件载荷携带表单值——表单值一律由回写服务在服务端读取，绝不上事件载荷。
- 改动任何既有审批读 DTO 的语义；改动 W7 `resultWriteback` 的任何行为。
- 映射配置的高级 UI（拖拽映射器/实时预览）——v1 仅最小配置表单，UI 打磨另立切片。

## 11. owner 裁决记录（Q1–Q6 全部 DECIDED；本锁现无残余开放问题）

**本次修订新增的先决条件（随 #4203 本次 ratify 一并生效，不新开 Q 编号）：** owner 代码评审要求
补齐的 Layer 1（事务 outbox + 租约派发，§Layer 1）与 Layer 2（`record-link` 字段契约，§Layer 2）
均为 PROPOSED；#4203 的 ratify 视为同时对这两层设计表态——Layer 1 须在任何 FWB 切片上线前落地，
Layer 2 须在 FWB-2 被 ratify/开工前落地。下列 Q1–Q5 的编号、内容与 §9 的排序均不受本次修订影响，
**均已由 owner 裁决为 v1 DECIDED（2026-07-14，见下），本节不再有开放 Q1–Q5**；本次修订额外新增
**Q6**（同样已裁决）——§2.1 第 2 条「暴露上界 = 规则创建者读权限，无越权放大」结论作废后由此产生
的 owner 裁决点。**本锁现无残余开放问题。**

**Q1–Q5 现由 owner 全部裁决为 v1 DECIDED（2026-07-14），不再是开放项：**

- **Q1 — FWB-2 目标记录缺失/已删除的终态语义 —— 裁决 = `failed`（可重试）。** fail-closed 不写（§5）+
  步态 = `failed`（账本未 claim；时间机器 undelete 恢复目标后 retry 可写成），与本仓 T8.1/undelete 恢复线
  组合出「先恢复再重试」的操作员路径。**不**采 `skipped` 终态。
- **Q2 — `rejected`/`cancelled` opt-in 回写 —— 裁决 = 命名 v2 follow-up。** 作为命名 follow-up 挂起，v2
  再设计（届时 D1 的 outcome 锁放宽为显式 opt-in）；v1 不做。统计面暂由 T3-6 投影承担。
- **Q3 — FWB-1.5 same-base 其他表显式目标 —— 裁决 = 不做。** 跳过；「写到别的表」诉求一律经 FWB-2 的
  linked-record 锚定覆盖。**不**允许 same-base 显式 sheetId 目标（显式表目标无表单锚点，会重开 W7 Q2
  字面目标之争）。
- **Q4 — `approval_node_decision_values` 读取范围与保留期 —— 裁决 = 随实例详情 / 随实例生命周期。**
  读取范围**对齐审批实例详情**（能看实例详情即能看核定值），生命周期**随实例**（实例删除/归档级联）。
  **不**收紧为 admin/发起人/参与人（核定值语义上就是审批记录的一部分）。**前置依赖 S-0 落地（私有，
  详情不在本锁）**——该裁决在 S-0 落地后按此读取范围实现。
- **Q5 — D7 decimal scale/precision 上限与超限 —— 裁决 = 按目标字段 precision 超限整步 REJECT、不舍入。**
  以**目标 number 字段的精度配置**为上限，超限**整步 REJECT**（与 D5/D6 的 fail-closed 家族一致）；
  **绝不** banker's rounding 或任何静默舍入。
- **Q6 — 把审批表单值写进读者范围比规则创建者更宽的目标表（一次受控的数据解密/再发布，见 §2.1
  第 2 条订正）——owner 已裁决。** 早前「暴露上界 = 规则创建者读权限，无越权放大」结论作废（目标表
  既有 ACL 只约束「谁能读目标表」，不能反证「不会让人看到一份原本只有规则创建者能看到的数据」）。
  **裁决：采「允许显式解密」，但不采用「比较双方读者集合」那种当前无法稳定计算的判定**——读者集合
  随角色/共享动态变化，save 时算不准、算了到 execute 时也会过期。改为一组可稳定强制的闸：
  **(1)** 创建/修改/启用含 `write_approval_form_values` 的 FWB 规则者，必须是 **admin 或对目标表持有
  既有 `canManageSheetAccess`**——`canManageAutomation` 本身过宽，**不足以单独授权**这次解密（这是复用
  一个既有权限检查、挂到 FWB authoring 这道新闸，不是新权限模型）；**(2)** 同时要求**源模板可读、
  目标表可写**（§2.2 身份，仍是规则创建者，不回退）；**(3)** 确认必须**绑定实际配置**：
  save 时由**服务端**对规范化的 `{模板/版本, 目标 base/sheet, 字段映射}` 生成一个**确认哈希**，创建者
  对该哈希做一次**显式确认**；此后任一映射项或目标（base/sheet/模板版本）变化都**令确认失效**、要求
  重新确认——不接受一个与当前配置脱钩的「曾经确认过」布尔。审计**只记标识**（表 / 字段 / 规则 /
  执行 id + 确认哈希），**绝不记值**；**(4)** execute 时复核 (1)(2) 仍成立，且**权限复核须显式调用
  目标 sheet 的 `resolveSheetCapabilitiesForUser`**（`multitable/sheet-capabilities.ts`，按 sheet
  解析能力），**不能只读一个全局 capability**；确认哈希与当前规范化配置不符、或权限已失效 → 整步
  REJECT。**明确不声称能计算「解密扩大到多少人」**——不做读者
  集合大小的量化断言。裁决落地前，§2.1 第 2 条的「无放大」结论不得作为 FWB-1/2 实现或 ratify 的依据；
  裁决落地后，上述四闸即为 FWB-1/2 涉及受限字段映射时的实现契约。

## 12. Status

**PROPOSED。** 仅文档；零 runtime、零迁移、零 flag。ratify 权在 owner；按 §9 与 #4195 同批裁决。
Ratify 后的实现顺序、验证义务（§8 全量，含正控腿）与 OUT 边界（§10）即为 FWB-1/2/3 各 PR 的
验收契约。
