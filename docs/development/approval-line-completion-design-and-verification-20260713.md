# 审批/流程线收官 · 设计与验证计划（2026-07-13，Rev 9）

> **性质**：规划与验证设计文档，回答 owner「审阅审批线代码、完成未开发项、按难度分派模型、可并行、给设计及验证 MD」。
> **状态（2026-07-15）：四把设计锁 #4196/#4203/#4195/#4239 均已 owner RATIFIED，按 #4196→#4203→#4195→#4239 串行合入 main。设计阶段完成——但整条开发线尚未完成。** 全部四锁落 main 后，授权启动 **P2 durable-delivery runtime**；FWB、附件及一切相关 flag 保持 **OFF**，直至完整实现 + 8 场景全链验收通过。每条 runtime 车道仍受 per-slice deploy 门约束。**本文档不主张任何 runtime 已上生产。**
> **披露纪律**：仓库 PUBLIC。本文档只涵盖**可靠性与功能设计**——持久投递、`record-link` 字段、附件并发契约、W7 revision 等。任何安全敏感面均**不在此**公开文档。
> Rev 2：依 owner REQUEST-CHANGES 修正（outbox 语义、record-link confused-deputy、附件 bind/GC、W7 已落 main 的漂移）。
> Rev 3：依 owner 第二轮复核修正——durable dispatcher 直接 await 命名 consumer adapter（bridge/trigger/projection 三 consumer_key，consumer 级 done ≠ 名下所有 rule 完成）；`SKIP LOCKED` 只保证同一 lease 期内无并发双持有、不保证跨崩溃只处理一次（三腿断言：无同时双持有 + 允许重投 + sink 净效果一次）；权威锁 #4203 已同步折入 SKIP-LOCKED≠单飞与升级路径回填、并落定 Q6。
> Rev 4：依 owner 第三轮复核修正——sink 自身可恢复（bridge `claimCompletion` 现在 continuation 前预写 `resumed` 终态墓碑，改租约 + 三窗崩溃测，§4）；模型分级不再把 dispatcher 泛称「单飞」；#4203 同步新增 sink 可恢复要求、Q6 确认绑定实际配置哈希 + 目标 sheet `resolveSheetCapabilitiesForUser` 复核、并订正「完成事件恰好触发一次」措辞。
> Rev 5：跨锁漂移订正——#4196 已完成自包含化（#4164 C1/C4 + `meta_automation_action_applied` row-shape 折入，webhook 4xx→`outcome_unknown`），本文 §1/§2/§6 原「#4196 不能独立 ratify / 还需自包含化」表述已过期，改为「已自包含、可独立 ratify」；#4195 已折入 owner O1-O4 + bind↔GC 对称守卫 + 对象存储级联清理。四锁均已修订+独立门禁过，全 HOLD 待 owner ratify。
> Rev 6：同步三锁第六轮契约变更（本轮增量为新契约，**未过任何对抗门禁 / 无 CI**，全 HOLD）。**#4196**：`action_key` 现纳入 `action.type`（= {`structuralPath`, `action.type`, `canonicalConfig`}）；test-run 身份改为**服务端派生 + 非可选 `kind` scope**（客户端提交值到不了真实执行命名空间）；Q-A..Q-D 已裁定为 v1 CLOSED ⇒ 锁内不再残留 open owner-decision，Rev 5 的「已自包含、可独立 ratify」**现完全成立**（不是新翻转，是移除最后一个决策保留项）。**#4203**：**版本化原子 consumer routing manifest**，覆盖全事件族（approval-completion 三元 + `task_created` + `record.*`/`form.submitted` + webhook-bridge）；dispatcher 按 manifest 落库的**已写入行**推进、不读 live manifest；registration 恰一次（= manifest 每 consumer 唯一路由行，非投递恰一次）+ 旧内存总线 non-load-bearing + cutover 安全靠 sink 幂等。**#4195**：durable blob-purge intent 的入队门 = claim 的**非空 `RETURNING`** + DB-trigger 路径无关入队（捕获级联删除路径）+ worker 幂等（not-found = 终态成功），替换原「可恢复孤儿」表述。§1/§2/§4/§5/§6 同步；四锁仍全 HOLD/PROPOSED。
> Rev 7：对抗门禁**构造并发**新逼出两处 miss，折入设计（新契约，**未过任何对抗门禁**；CI 现况：#4203 `test(18.x)` 在 stale base 上红、#4195/#4196 相对 main **BEHIND**——**不主张任何一处 CI-green**，全 HOLD）。**① 租约僵尸 / fencing**：SKIP-LOCKED 的「同一 lease 期内无并发双持有」原为**无条件**断言，实为**仅锁作用域**——一个 **LIVE 但 lease 已过期**的持有者（非崩溃）与一个 reclaimer **同时抵达 execute** 时，双执行是可能的；**fence-CAS** 才是关闭**持久状态**窗口的机制（durable state 单写者、恰一次落地），外发仍 at-least-once、由 endpoint 幂等键或 `outcome_unknown` 去重。§4 leg (a)/§5 ③ 就地加锁作用域限定并把持久状态保证交给 fence（cross-ref #4203 Layer-1 fencing）。**② 毒丸 / 终态失败**：确定性永久失败的**持久 event** ⇒ **有界尝试** ⇒ 终态 `failed`/`dead_letter`，**非**无限 reclaim；与 `outcome_unknown`（§5②，仅外发、结果模糊、不盲重发）**不同**。**#4203** 现含 lease fencing + poison-terminal + manifest-completeness 启动断言；**#4195** 现含 upload-crash bucket-reconciler + over-claim 限定（每条 DELETE 路径）+ bound-row-cascade-only + purge-worker dead-letter。§1/§4/§5 同步；四锁仍全 HOLD/PROPOSED。
> Rev 8：**四锁均已过独立 construct-a-failure 门禁（本轮增量 PUSH verdict）**，并折入门禁再逼出的三处 #4203 精化（仍**未过 CI**、四锁仍 HOLD；#4203 相对 main 需 rebase）。**(1) 漏投挡法从「单向断言」升级为「注册表唯一枚举源 + 双向断言 + 具体强制缝」**——裸 `eventBus.subscribe` 的匿名 durable consumer 不带 `consumer_key`、总线侧不可枚举，故 durable 订阅只能经必带 `consumer_key` 的封装注册 API（或 lint/注册期扫描禁裸订阅），断言双向（每注册项∈manifest ∧ 每 manifest 条目有活注册），缺缝时稳态生产侧静音已把违规从静默漏投降级为 loud-dead（测试即红）。**(2) producer 侧原子入队扩到 manifest 全事件族**（非仅 approval-completion）——`record.*`/`form.submitted`/`task_created`/webhook-bridge 的 outbox 行须与各自源变更同事务，否则事件在 producer 侧就丢。**(3) 外发幂等键须绑稳定事件+动作 identity、不含 fence token/attempt 序号**——否则僵尸(fence N)与 reclaimer(fence N+1) 发不同键 ⇒ endpoint 双执行。§5 ⑥⑧ 就地精化。
> **CI 现况订正（2026-07-14，owner 确认）：四 PR 现均 CLEAN、全 checks 绿（含 test 20.x / web-tests / coverage），CI 门已关。** 上文 Rev 7 的「不主张任何一处 CI-green」是当时 stale-base 现况，现已过时——早轮 + 第六轮契约=**已过独立门禁 + CI 绿**。
> Rev 9：折入 owner 第七轮 5 处承重修正。**状态（as-reviewed）：本轮增量已过独立针对性对抗复核（四路 adversarial-reviewer 逐锁 construct-a-failure，#4203/#4239 PUSH、#4196/#4195 的窄发现已修复后全部澄清），且四 PR 全部 required + coverage 检查（11/11）现已 CI 全绿。四锁仍全 HOLD/PROPOSED，待 owner 依序 ratify。** **#4195**：(a) 下载改 `downloadByKey(storage_path)`（跨进程可靠），不用索引式 `download(fileId)`；(b) bucket-reconciler **限定审批专属 bucket / `approval-attachments/` prefix**，配正控「同库非审批对象不删」（`StorageService` 是共享底座）；(c) purge 态机补全 `pending/in_progress/done/dead_letter`、`attempts` **claim 时原子递增**（否则崩溃后 attempts 永不增长）、每次终态写 `fence`-CAS；(d) raw-delete 合同=机制(trigger 对每条 DELETE 入队) vs 政策(bound-row 仅经 cascade)，与本文 §4⑦ 统一；(e) **一附件一独立 blob、禁内容寻址复用**（`storage_file_id` UNIQUE）⇒ v1 无需 refcount（owner 裁）。**#4196**：`meta_automation_action_applied` **保持终态 claim 表**（无 lease/fence/attempts；靠 UNIQUE 挡 class-A 重铸），fence/lease **只落 `event_fires`/bridge/outbox** 租约行；Q1/Q2/Q6 **折入本锁**为自有裁决（test-run runtime 依赖之，不能挂 #4164 ratify）；Q3 判 **superseded**（非仍开放），本锁自包含成立。**#4203**：Q1–Q5 owner 裁决（Q1 failed/可重试 · Q2 命名 v2 follow-up · Q3 不做 FWB-1.5 · Q4 读取范围随实例详情/生命周期随实例[S-0 私有前置] · Q5 按目标字段 precision 超限整步 REJECT 不舍入）；**rolling-deploy manifest 协议**（先迁移后启用 / N·N-1 双版 / 未知 `consumer_key` 保持 pending+告警、绝不误 done/dead_letter；**激活门槛两侧对称——全部 producer 与 worker 都 N-aware 才展开新 key**，否则滞后 N-1 producer 不写新 key 行=静默漏投，配 producer-skew 验证腿）。§1/§4/§5 同步；四锁仍全 HOLD/PROPOSED。

---

## 1. 已核实的开发缺口（审计基线 = `492c64d30`；此后 main 持续前进，本文以审计基线为准，不追每次 main 移动）

| 项 | 现状（核实）| 门 | 模型 |
|---|---|---|---|
| **持久投递链（P1）** | 完成事件两处崩溃丢写窗：commit-后-发到内存总线（无持久、无重投）+ 消费侧 claim-先于-execute（终态墓碑，重投跳过）。**且 `event-bus.ts` 的 `emit()` 返回 `void` 不 await、订阅者启动异步即返回 ⇒ relay 无法知「handler 已完成」。** #4196 Class-A 不修此两窗 | owner-ratify + deploy | **opus4.8**（并发/租约/崩溃恢复）|
| **record-link 审批字段（P1）** | FormFieldType 枚举（后端+FE）无此类型，publish 校验 fail-close 拒未知 ⇒ FWB-2 现状不可建。**且存在 confused-deputy 缺口**：只校验发布者可读目标表，未校验**填表人可读其所选记录** | owner-ratify（设计入 #4203）| **opus4.8** 契约 / sonnet FE |
| **附件 bind/GC 并发（P1）** | sweeper 先读 unbound → 提交事务后绑定 → sweeper 删 blob ⇒「审批已引用但对象已删」。需同一行锁序 + 带条件状态迁移 + 真实 GC↔submit 并发测试；**实例级联删除须显式安排对象存储清理**（DB `ON DELETE CASCADE` 不删 blob）。#4195 Rev 6 将 blob 清理改为 **durable blob-purge intent**：入队门 = 软删 claim 的**非空 `RETURNING`**（真抢到才登记清理意图）+ DB-trigger 路径无关入队（级联删除路径也入队，不依赖应用代码走到）+ 幂等 worker（not-found = 终态成功），取代原「可恢复孤儿 / 靠扫描找回」路径。**Rev 7 增量**：upload-crash **bucket-reconciler**（上传中途崩、DB 无 bound-row 的孤儿对象也被对账清；**限定审批专属 bucket / `approval-attachments/` prefix**，同库非审批对象不删）+ raw-delete 合同=**机制**（trigger 对每一条 `DELETE`-statement 都入队、无法自辨）vs **政策**（bound-row 删除仅经实例 cascade 才 sanctioned，§4.3 端点拒 raw bound-row delete）+ purge-worker **dead-letter**（永久失败的 blob 走有界尝试→终态 `dead_letter`，区别于 not-found 终态成功）+ purge 态机 `pending/in_progress/done/dead_letter`、`attempts` claim 时原子递增、fence-CAS | owner-ratify（设计入 #4195）| **opus4.8** |
| **W7 结果写回入版本历史** | **已在 main 落地**：#4248 把 `resultWriteback` 与 revision 放进同一事务；#4247 使 automation create/update 事务化并写 revision。**⇒ 从缺口转为「FWB 自身 create/update 必须显式继承 claim + record mutation + revision + event-outbox 同事务」，不另留补洞** | 已落 / FWB 继承 | — |
| **能力矩阵** | approval.completed 记录-less 仅通知类；事件不带 form_snapshot；仅 start_approval+resultWriteback 写记录；投影限元数据+~5min 最终一致——四项核实为真 | — | — |

**结论口径（诚实）**：过程/结果**元数据**已能入多维表；**任意审批表单业务值 + 审批人核定值**尚不能自动写入；FWB-0 仍 docs-only，`write_approval_form_values` / `record-link` / `approval_node_decision_values` / automation outbox 当前 main **均无 runtime**。核心 FWB 闭环（独立审批收数据 → 确认 → 自动进多维表）**尚未开发**。

**设计侧**：#4196（Class-A + FOR UPDATE，Rev；**已自包含**——#4164 C1/C4 + `meta_automation_action_applied` row-shape 已折入本锁；`action_key` 现纳入 `action.type`（= {`structuralPath`, `action.type`, `canonicalConfig`}）；test-run 身份**服务端派生 + 非可选 `kind`**；Q-A..Q-D 已裁为 v1 CLOSED ⇒ 锁内无残留 open-decision，**可独立 ratify**；webhook 4xx *response*→`outcome_unknown`）· #4203（**版本化原子 consumer routing manifest**——全事件族路由行落库，dispatcher 按已写入行推进、不读 live 总线；registration 恰一次 = 每 consumer 唯一路由行；持久 outbox + 租约 dispatch + record-link；**Rev 7 增量**：**lease fencing**（LIVE-lease-expired 僵尸的持久状态写被 fence-CAS 拒，Layer-1）+ **poison-terminal**（永久失败持久 event 有界尝试→`dead_letter`）+ **manifest-completeness 启动断言**（缺路由行的事件族在启动即可观测报缺，非静默吞），Rev）· #4195（附件；owner O1-O4 已裁 + bind↔GC 对称 + **durable blob-purge intent**：门在软删 claim 非空 `RETURNING` + DB-trigger 路径无关入队 + 幂等 worker（not-found 终态成功）；**Rev 7 增量**：upload-crash **bucket-reconciler**（限定审批 prefix）+ raw-delete 机制(每条 DELETE 入队)vs 政策(bound-row 仅经 cascade)+ purge-worker **dead-letter** + purge 态机 4 态/claim-time attempts/fence，Rev）。三者 **HOLD，待 owner ratify**。

---

## 2. 有序执行阶段（谁能做 · 并行）

| Phase | 内容 | 并行 | 门 |
|---|---|---|---|
| **P1 · ratify 基础锁**（修订**已落**）| 早轮 + 第六轮契约**均已过独立 construct-a-failure 门禁（PUSH）且四 PR CI 全绿**：#4196 自包含（C1/C4/row-shape + `action_key` 纳 `action.type` + test-run 服务端派生 `kind` + Q-A..Q-D v1 CLOSED）；#4203 版本化原子 routing manifest + registration 恰一次 + fencing + poison-terminal；#4195 O1-O4 + bind↔GC 对称 + durable blob-purge intent。**第七轮 owner-P2 承重增量（已过独立针对性对抗复核 + 四 PR CI 全绿 11/11）**：#4195 下载改 `downloadByKey` + reconciler 限定审批 prefix + purge 态机 `pending/in_progress/done/dead_letter` + claim-time attempts + fence；#4196 fence 只落 lease 行（claim 表保持终态）+ Q1/Q2/Q6 折入本锁 + Q3 判 superseded；#4203 Q1–Q5 owner 裁决 + rolling-deploy manifest 协议（producer+worker 两侧 N-aware）。**剩 owner-ratify**：ratify #4196（自包含）→ 再 ratify #4203/#4195 | — | owner-ratify |
| **P2 · 持久链 runtime** | `meta_automation_outbox`（与审批状态同事务）+ **显式可等待的 durable dispatcher**（直接 `await` 命名 consumer adapter、不经 `eventemitter3` 推进持久状态；**按 #4203 版本化原子 routing manifest 的已写入路由行分发**——覆盖全事件族 approval-completion 三元 + `task_created` + `record.*`/`form.submitted` + webhook-bridge，dispatcher 只读落库路由行、不读 live 总线，registration 恰一次 = 每 consumer 唯一路由行、旧内存总线 non-load-bearing、cutover 安全靠 sink 幂等；至少拆 `approval-bridge`/`approval-trigger`/`approval-projection` 三个 `consumer_key`，各自成功才标 done；`approval-trigger` 内部逐 `rule_id` 维护 `event_fires`，consumer 级 done ≠ 名下所有 rule 完成；**at-least-once 投递 + sink 幂等**，不声称「恰一次 emit」）+ relay 并发正确性（leader lock ⇒ 单实例执行；或 `SKIP LOCKED` ⇒ 多 relay 可并行、同一 lease 期内无并发双持有，跨崩溃重领靠 sink 幂等去重——二者是不同机制，不可都称「单飞」）+ `event_fires` 租约态机（execute 成功才 done）+ **迁移回填既有行→done** + 动作分级（外发/通知类=`outcome_unknown` 不盲重发）| — | ratify+deploy |
| **P3 · FWB-1** | 独立表单 text/number/date/select → 新建记录；**create 同事务写 claim + record + revision + outbox**（继承 #4247 已落模式）| ∥ P4a | ratify+deploy |
| **P4 · 附件 / record-link / FWB-2** | (a) 附件 runtime（含 bind/GC 并发契约 + 对象存储级联清理）∥ FWB-1 →(b) 附件释放 `ApprovalProductService` 后落 record-link 字段（含 confused-deputy 异步校验）→(c) FWB-2 回写（服务端绑定 sheet 胜；rule-creator 身份过 `evaluateCrossBaseWriteGate`）| a∥P3 | ratify+deploy |
| **P5 · FWB-3** | `dispatchAction` 锁事务内冻结 decisionData 再回写核定值 | — | ratify+deploy |
| **P6 · 全链测试 → flag ON 决策** | 跑 8 场景全链，再决定 flag ON | — | ratify+deploy |

**依赖硬边**：持久链(P2) **先于任何 FWB 上线**（owner：FWB 上线前需事务 outbox）· #4196 自包含 substrate 先于 FWB 记录写 · record-link 字段先于 FWB-2 · 附件释放热文件先于 record-link/FWB-2 · FWB-3 最后。

---

## 3. 模型分级（按难度）

- **fable5**：设计锁/规划/台账（低风险文字）。
- **sonnet5**：中等 impl —— record-link FE 选择器、FWB-1 值规整、附件 runtime 段。
- **opus4.8**：碰**锁/并发/崩溃恢复/写路径/授权**的 —— durable dispatcher + 租约 + relay 并发正确性（leader lock=单实例 / `SKIP LOCKED`=逐行无并发双持有，二者不可混称「单飞」）、consumer sink 自身可恢复（bridge `resumed` 墓碑改租约）、record-link confused-deputy 异步校验、附件 bind/GC 并发、FWB-3 decisionData 冻结、以及**每一道对抗门禁**。

---

## 4. 验证口径（每条如何被**证明**，非仅测过）

**持久链（P2）—— 真库崩溃注入矩阵：**
- **Window-1**：commit 后、relay dispatch 前 kill → 重启 → 事件**至少一次**送达；sink 幂等 ⇒ 净效果恰一次。
- **Window-2**：claim 租约、execute 前抛错 → 时钟推过 lease → 被 reclaim → 全程幂等落地一次。
- **sink 自身可恢复（bridge 三窗，owner 复核新增）**：bridge 的 `claimCompletion` 今天在 continuation 前就把 `pending` 写成 `resumed`（终态墓碑）——改为 `pending/in_progress/done` 租约、continuation+执行日志持久化后才标 done。三窗真库崩溃注入：① claim 后、首个尾动作前崩 → reclaim、续跑恰一次；② 首尾动作后、continuation 未完崩 → reclaim 后尾动作经 #4196 账本不重复落地；③ 尾动作全完、标 done 前崩 → reclaim 只补标终态、不重复副作用。正控：无崩溃路径 continuation 恰跑一次并标 done。projection/trigger sink 同理，终态标记只能在副作用持久化之后。
- **并发 relay（两种机制精确区分，不可混称「单飞」）**：
  - 若用 **leader lock**（advisory lock）：构造两 relay 同时抢 → 断言**单实例执行**（`pg_blocking_pids` 可观测未持锁的 relay 阻塞/让路，非计时器）。
  - 若用 **`FOR UPDATE SKIP LOCKED`**：构造多个 relay **同时运行**（非互斥）→ `SKIP LOCKED` 允许它们各自抓到**不同行**并行处理，这不是单实例执行。它保证的是**同一 lease 期内无并发双持有**（同一行同一时刻至多一个 relay 持有），**不**保证某行跨崩溃 + 租约重领后「只处理一次」——那要靠 sink 幂等。**注意此「无并发双持有」仅限锁作用域**：一个 **LIVE 但 lease 已过期**的持有者（进程没崩、还在跑）与 reclaimer 可**同时抵达 execute**，锁本身关不掉这个 post-lease 窗口——**持久状态**的单写者由下方 fence-CAS 关闭（见「租约僵尸 / fencing」），SKIP-LOCKED 不承担。断言分三腿：**(a) 无同时双持有**（两 relay 不会同时**持锁**处理同一行；此腿限锁作用域）+ **(b) 允许重投**（持有者崩溃后该行被另一 relay 重新领取，是预期行为，非错误）+ **(c) sink 净效果一次**（重投经幂等键去重，业务副作用只落一次）。
- **租约僵尸 / fencing（#4203 Layer-1，对抗门禁构造并发逼出，非顺序论证）**：构造一个 **LIVE 但 lease 已过期**的持有者（**不是崩溃**——进程仍在执行旧租约的 continuation）与一个已 reclaim 该行的新持有者，**二者都抵达 execute** → 断言 **fence-CAS 拒绝僵尸的终态 / 状态写**（每次 claim 递增 fence token，写终态时 `WHERE fence = :claimedFence`；僵尸的旧 token 不匹配 ⇒ 其 UPDATE 影响 0 行、被拒）。**持久状态是单写者、恰一次落地**；**外发**不受此保护、仍 **at-least-once**，由 endpoint 幂等键或 `outcome_unknown` 去重（两通道分开）。**正控**：合法的单一当前持有者（fence token 匹配）其终态写被 fence-CAS **接受**并落地一次。此腿收窄上面 SKIP-LOCKED (a) 腿留下的 post-lease 双执行缝——对**持久状态**闭合，对外发不闭合（设计如此）。
- **毒丸 / 终态失败（对抗门禁逼出，与「动作分级」§下条不同）**：构造一个**确定性永久失败**的持久 event（每次 execute 都以同一确定错误失败，非模糊结果）→ 断言经**有界尝试**后落 **终态 `failed` / `dead_letter`**，**不**进入无限 reclaim / 重试风暴。**与 `outcome_unknown` 明确区分**：`outcome_unknown` 仅用于**外发**且结果**模糊**（可能已送达）⇒ 不盲重发；毒丸是**持久 event** 的**确定性永久失败** ⇒ 有界后 dead-letter。**正控**：一个**一次性**失败的 event 在下一次 reclaim 时**成功**（证明有界终态不是把可恢复错误也误埋）。blob-purge worker 的永久失败走同一毒丸终态（§下附件段 dead-letter 腿）。
- **迁移回填（须走升级路径，非 fresh-DB 全量迁移）**：先将库迁移到**目标迁移之前的旧 schema**、直接写入历史 event 行（模拟已存量、未回填数据）→ 再跑目标迁移并启动 relay → 断言历史行被回填为 done **且不重发**。fresh-DB 全量迁移会让历史行随目标迁移一起创建为已回填状态，**不覆盖**升级期回填这条路径，不能替代。
- **动作分级**：外发/通知类在模糊结果下记 `outcome_unknown`，断言**不盲重发**（正控：明确未送达才重试）。
- **outbox routing-manifest（#4203：快照 + 反双跑 + 反漏 + registration 恰一次）**：对 manifest 打 snapshot，断言全事件族（approval-completion 三元 + `task_created` + `record.*`/`form.submitted` + webhook-bridge）各有且仅有一条路由行（**registration 恰一次 = 路由行唯一，非投递恰一次**——投递仍是 at-least-once + sink 幂等，见 §5④）· **反双跑**：构造两 dispatcher 并发处理同一 manifest 版本 → 断言无同一路由行被双跑 · **反漏**：构造某事件族缺路由行 → 断言该族事件**不被静默吞**而是可观测报缺 · dispatcher 只按**已写入行**推进——正控：改 live 总线不改行为，唯有新路由行落库后才生效。构造并发、非顺序论证。
- **#4196 契约（`action_key` 纳入 `action.type` + test-run `kind` 命名空间）**：
  - **`action_key` 含类型碰撞测**：同 `structuralPath` + 同 `canonicalConfig` 但 `action.type` 不同（`lock_record` vs `delete_record`）→ 断言二者 `action_key` **不相等**（否则其一被当另一之重复而跳过——这正是把 `action.type` 纳入键要防的失败）。正控：完全同 type+path+config 的重复触发确实同键、被幂等去重。
  - **test-run `kind` 命名空间不相交**：test-run 身份**服务端派生 + 非可选 `kind`** → 构造客户端提交任意 `kind`/执行 id → 断言其**到不了真实执行命名空间**（test-run 与 real-run 的执行命名空间不相交，客户端值不能寻址一次真实执行）。正控：合法 test-run 落在 test 命名空间且可回读。
- **强制正控腿** + **落到 sink 断言**，非 spy 方法层。

**record-link / FWB-2**：publish 校验（拒未绑定 + 正控接受已绑定）· executor（单条接受 / 0 / 2+ / 自由文本 全拒，配正控）· **confused-deputy**：提交时断言填表人**不可读**其所选记录 → 拒且不泄露存在性；执行时断言规则创建者可写、记录仍存在且未锁 · 跨 Base 门在 creator 缺目标库写权时拒。

**附件 bind/GC**：构造 GC↔submit 并发（sweeper 读 unbound 与 submit 绑定交错）→ 断言不产生「已引用但已删」；实例级联删除 → 断言对象存储 blob 被清理（DB CASCADE 之外的显式清理腿）。**durable blob-purge 崩溃恢复（#4195，四窗，构造并发注入、非顺序论证）**：① 软删 claim 提交（**非空 `RETURNING`** 真抢到）后、purge worker 跑前崩 → 重启后清理 job 仍在（意图已持久、不丢）；② 实例级联删除路径应用代码从未走到、仅 **DB-trigger** 入队 → 断言 blob 仍被入队清理（**路径无关**）；③ worker 删 blob 中途崩 → reclaim 幂等重试、净删一次；④ blob 已删、标 done 前崩 → reclaim 时 worker 遇 **not-found 记终态成功**、不悬挂、不重试风暴。每窗配正控（无崩溃路径清理恰跑一次并标终态；未 claim 到（空 `RETURNING`）**不入队**——空抢不登记清理意图）。**Rev 7 增补三腿**：(⑤) **purge-worker dead-letter**——构造对象存储对某 blob **确定性永久失败**（非 not-found）→ 断言经有界尝试落终态 `dead_letter`、不无限重试（同毒丸终态；正控：一次性失败下次 reclaim 成功）；(⑥) **upload-crash bucket-reconciler**——构造上传中途崩、对象已落桶但 DB **无 bound-row** 的孤儿 → 断言 reconciler 对账清除该孤儿对象；**两条正控**：(i) 有 bound-row 引用的对象**不**被误删；(ii) **同库、审批 prefix 之外的非审批对象**（multitable/files blob）**永不**被 reconciler 删除（证明其限定在 `approval-attachments/` prefix / 审批 bucket，非「删所有无审批行的对象」——`StorageService` 共享底座）；(⑧) **purge 态机**——断言 `pending/in_progress/done/dead_letter` 四态、`attempts` 于 **claim 时**原子递增（构造「每次 claim 后即崩」→ attempts 仍增长 → 有界后落 `dead_letter`，非永不增长空转）、每次终态写 **fence-CAS**（僵尸 worker 旧 fence 写命中 0 行、被拒）；正控：正常单持有者 fence 匹配、终态写被接受；(⑦) **raw-delete 合同 = 机制 vs 政策（与 #4195 统一，非「仅 cascade 入队」）**——**机制**：row-delete trigger 对**每一条 `DELETE`-statement**（含 raw bound-row delete）都入队，无法自行区分合法 cascade 与非法 raw delete；**政策**：bound-row 删除**仅经实例 cascade** 才是 sanctioned（§4.3 端点拒绝 raw bound-row delete）。验证据此分两腿：(a) 断言 trigger 对任意 DELETE-statement 都入队（机制正确）；(b) 断言 sanctioned 路径下 unbound GC / 实例 cascade 入队正确，而 raw bound-row delete of a live instance 被端点拒绝（政策由「永不发出 raw bound-row delete」强制，不靠 trigger 辨别）。正控：unbound / cascade 正常入队清理。

**FWB-3**：decisionData 冻结用**构造并发**证（非顺序论证）。

**8 场景全链矩阵（收尾）**：崩溃窗 / 重复投递 / 权限撤销 / 映射边界（映射外字段不落地）/ 目标删除 / 跨 Base / 节点重入 / 历史恢复。

**变异先证落地**（`git diff --exit-code`）· **每刀独立 opus 对抗门禁（非自审）** · **每条 runtime 落地用 fresh 隔离 worktree**（canonical 现在是 on a branch + 有未跟踪文件 + 他 session 改动，非 detached，绝不在其中改）。

---

## 5. 对抗复核修正（已折入设计）

① `event_fires` 迁移**必须回填**既有行→done（否则部署重发历史事件）② 重投须**动作分级**（外发/通知类=`outcome_unknown` 不盲重发）③ relay 并发正确性须精确区分两种机制：**leader lock** ⇒ **单实例执行**（真单飞）；**`FOR UPDATE SKIP LOCKED`** ⇒ 允许多 relay **并行运行**、各抓不同行，给的是**同一 lease 期内无并发双持有**（**仅锁作用域**——LIVE 但 lease 已过期的持有者与 reclaimer 仍可同时抵达 execute，见 ⑧），**不**保证某行跨崩溃 + 租约重领后只处理一次（那靠 sink 幂等 + fence），不是单实例——验证需分别断言（SKIP LOCKED 腿 = 无同时双持有 + 允许重投 + sink 净效果一次），不可都称「单飞」④ **outbox 传输语义 = at-least-once + sink 幂等**，不声称普通 outbox「恰好 emit 一次」（因 `emit()` 不可 await）⑤ record-link 须**服务端异步授权**（提交查填表人可读、执行查创建者可写），纯同步结构校验（`ApprovalGraphExecutor:328`）承担不了 DB 授权 ⑥ **#4203** consumer routing 须**版本化原子 manifest**：dispatcher 按**已写入路由行**推进而非 live 内存总线；registration 恰一次 = 每 consumer 唯一路由行（**≠ 投递恰一次**——投递仍 at-least-once + sink 幂等，见 ④）；旧内存总线 non-load-bearing、cutover 安全**只**靠 sink 幂等 ⑦ **#4196** `action_key` 须纳入 `action.type`（= {`structuralPath`, `action.type`, `canonicalConfig`}），否则同路径同配置不同类型动作（`lock_record`/`delete_record`）键碰撞互相跳过；test-run 身份须**服务端派生 + 非可选 `kind`**，客户端提交值不能寻址真实执行命名空间 ⑧ **#4203 租约 fencing（Layer-1）**：SKIP-LOCKED 的「无并发双持有」仅锁作用域；一个 **LIVE 但 lease 已过期**的持有者（非崩溃）与 reclaimer 可**同时抵达 execute**，故**持久状态**须由 **fence-CAS**（每次 claim 递增 fence token、写终态 `WHERE fence = :claimedFence`）保证**单写者、恰一次落地**——僵尸旧 token 不匹配 ⇒ 终态 / 状态写被拒（0 行）；**外发**不受 fence 保护、仍 at-least-once，由 endpoint 幂等键或 `outcome_unknown` 去重（两通道分开）。验证须**构造并发**（僵尸 + reclaimer 同抵 execute）、非顺序论证；配正控（合法当前持有者 fence 匹配、写被接受）⑨ **毒丸 / 终态失败**：**确定性永久失败**的持久 event 须经**有界尝试**落终态 `failed` / `dead_letter`，**非**无限 reclaim；与 ②`outcome_unknown`（仅外发、结果模糊、不盲重发）**不同**——毒丸是持久 event 的确定性永久失败。blob-purge worker 的永久失败（非 not-found）走同一毒丸终态。配正控（一次性失败下次 reclaim 成功，证明未把可恢复错误误埋终态）。

---

## 6. 本文不主张什么

- 不主张收官——runtime 全 owner-ratify+deploy 门。
- 不主张任何锁「已定」——#4195/#4196/#4203 全 **HOLD/PROPOSED**；#4196 **已自包含化**（#4164 C1/C4 契约已折入 + Q1/Q2/Q6 折入本锁）且 Q-A..Q-D / Q3 已裁、锁内无残留 open-decision ⇒ 可独立 ratify，但仍待 owner ratify。早轮 + 第六轮增量**已过独立门禁且四 PR CI 全绿**；**第七轮 owner-P2 承重增量**（下载 `downloadByKey` / reconciler prefix 限定 / purge 态机 + claim-time attempts + fence / claim 表保持终态 / Q1-Q5 裁决 / rolling-deploy 协议）**亦已过独立针对性对抗复核、四 PR CI 全绿（11/11）**。四锁内容均 as-reviewed，仍全 HOLD/PROPOSED，待 owner 依序 ratify。
- **不自 ratify、不自建被门约束的东西、不公开披露任何安全敏感面。** 能推到的极限=决策侧一键可拍 + 代码侧不涉披露部分待 ratify 即可建。
