# 审批及流程线 · 续作开发与验证记录（2026-07-17，Session 审批及流程-260717）

> **性质**：本轮 /goal「规划并完成开发线未完成项」的开发+验证记录。**诚实边界**：本文所有条目均为
> build+push+review-ready；**合并 / ratify / flag-ON / UAT 全部是 owner 门**，本文不主张任何一项已上主干
> （明确标注 MERGED 者除外）。模型分工：机械/规格化实现→sonnet 或 fable 子代理；同事务/幂等等精细切片与
> 全部对抗审阅→opus；集成、冲突解决、变异验证、收口→主循环（fable）。
>
> **状态：LIVING（2026-07-18 收尾轮进行中）。** 「剩余全为 owner 门」的旧表述经 owner 复核**不成立**
> （FWB 栈测试漂移红检 / #4439 冲突 / 多 PR 落后 main 均为工程侧事项），§5 已改为「工程侧 vs owner 门」
> 双栏对账。本文在收尾序列（FWB 栈落地→#4439 解冲→8 场景→本 MD 终版）完成后才转 FINAL。
> CI 状态以各 PR 当前 head 的 checks 为权威（本文数字绑定文中注明的 SHA）。

## 0. 接手时的权威状态
- #4196 durable-delivery 链 6/6 已全部串行落 main（fingerprint / S6 lease / RULE_CHANGED / Class-A /
  Class-B webhook+email+card），flag 全 OFF。
- owner 2026-07-17T07:04Z 在 #4337 留 checkpoint（REQUEST CHANGES）：①补完 P1 边界（可回收
  bridge/trigger/projection sink + 真 producer/consumer/boot 接线）②rebase 至当前 main 后 exact-head 全绿
  ③review thread 确认。
- 原会话已建：bridge sink P1#1a-d、真 consumer + boot（167e09801）、producer REPLACE seam + family 3。
- #4342 附件 25 findings 修复推毕待审计；#4450 fan-out 锁 PROPOSED 无审阅;#4433/#4439 Codex 双 PR 待审。

## 1. #4337 S5 — P1 边界补完（本轮核心）

### 1.1 Producer 家族接线（REPLACE 契约）
| 家族 | 站点 | 实现 | 验证 |
|---|---|---|---|
| manifest 修正 | automation-routing-manifest.ts | `'form.submitted'`→`'multitable.form.submitted'`（锁 §283-291 简写转写漂移；锁自身 grounding 引用 automation-service.ts:892-936 订阅面裁决；**动 ratified 字面量已在 PR 显著标注请 owner 复核**） | manifest 单测 7/7（裸 trigger-type 断言 UNROUTED）+ 21/21 关联真库 |
| F2 executor Class-A ×3 | automation-executor.ts update/delete/create | 主循环亲手；payload 提升 + 事务尾 enqueue + emit 替换；duplicate-claim 早退同跳过 enqueue；0-row 宽容路径 1:1 镜像 legacy | F2-G1..G6 真库 7/7（含 PG 级失败注入原子性、replay 零二次投递）；变异 2/2 击杀 |
| F4 record-service ×4 + record-write ×1 | record-service.ts / record-write-service.ts | fable 子代理建、主循环 cherry-pick 集成；全部站点已在 pool.transaction 内，零重构 | 真库 10/10 + 单测 6/6；变异 2/2；record-service 既有 76/76 |
| F5 univer-meta ×4 | routes/univer-meta.ts（undelete/reset/form-submit） | fable 子代理建、主循环集成；reset 路径逐行 in-txn 构建 payload（changes=revisionPatch 只在事务内可得，诚实偏离「事务前构建」并已注释） | route 级真库 8/8（supertest 驱动真路由；form.submitted 扇出断言=manifest 修正端到端证明）；变异 2/2 |
| F1 approval completion ×6 + task_created ×9 | ApprovalProductService.ts + 两个 choke 模块 | opus 子代理建至验证中段死于 session limit；主循环抢救（未提交 WIP 先 checkpoint 提交）后接管收尾：新 seam `enqueueApprovalEventIfDurable`（顶层 eventId、depth 0）；两 choke 单点 REPLACE suppression；task_created 复查/去重/构建抽出共享 `collectLiveApprovalTaskCreatedEvents` 核心（flag-ON 事务内腿 / flag-OFF post-commit 腿共用，语义不可漂移；quad eventId 与 legacy 字节一致） | F1-G1..G5 真库 6/6（fresh DB；terminal 扇出 3 consumer / per-recipient quad / auto-approve 级联零 task 行 / flag-OFF legacy+零 outbox / 注入失败原子性）+ 单测 8/8 + collector 5/5；变异 3/3 击杀（choke suppression→F1-G1+G3 红；单站点 enqueue 删除→F1-G3 红；is_active 复查中和→collector 专用 mutation-catch 单测红[共享单核=双腿覆盖]）；worktree 全量单测 6735/0 |
- un-routed 事件（approval.admin_jumped / bulk_reassigned / automation.notification）保持 legacy（正确不接）。
- `multitable.comment.created`：本轮初期记录为「manifest 有路由但全仓无发射方=两路径皆惰性」；该状态在
  §1.4 item 2 被 owner 判为不可接受并已**从 v1 manifest 移除**（本行按 owner inline review 修正为与 §1.4
  一致——最终事实=v1 不再路由该事件；真 producer=family-6 + manifest v2 菜单项）。

### 1.2 Sink 可回收性（owner P1 边界的另一半）
- **审计**（fable 子代理，63/63 既有 spec 复跑）：projection sink=RECOVERABLE-AS-BUILT（advisory xact lock
  + 单调 projected_version + rollback-rethrow + leader sweep）；trigger 三 sink 与 approval-bridge 存在
  **组合时序洞**；webhook bridge 存在首跑卡死态。
- **组合时序洞修复（P1#1e）**：outbox 租约 30s < sink 租约 60s ⇒ 崩溃后唯一重投落在死 worker 活租约内被
  静默 resolve done=工作永久丢失。结构修=三态拆分：`claimEventFiresLease → {fence}|'done'|'busy'`、
  `claimCompletion → claimed|none|busy`；busy→`DurableSinkBusyError`（retryable）；boot outbox 租约对齐
  90s。wire 级 goldens W1-W3（真 AutomationService 驱动）+ 原语套件更新至三态契约；**变异 2/2**（两处
  busy→silent-skip 还原旧洞分别被 W1/W2 精确击杀）。
- **webhook 首跑卡死态修复**：pending+next_retry_at NULL 永不被扫（吸收态）；retry scan 加 stray 宽限腿
  （max(5min, timeout×10)）；golden（旧 stray 被领取投递 / 新鲜首跑不被双发）+ 变异击杀。

### 1.3 收口
- 分支已 rebase 至当前 main（与 W0 L4-cov 的 withTransaction(sheetId) fence 签名两处冲突，均按「新签名+
  payload 提升」联合解决，锚定 grep 证两侧存活）；fresh-DB 全 durable 电池 **90/90**；tsc 0；全量单测
  **6734/6734 passed**（首轮 2 个失败复跑不复现=vitest.config 记载的本地端口碰撞 flake 类，CI retry:2
  吸收、本地 retry:0 显形）。
- **已收口**：family-1 集成（union 冲突 2 文件）→ 二次 rebase（main 又进 1=W0 L5-wire，干净）→
  exact-head `8c95bec48` 验证：durable/lease/producer 电池 **96/96（13 文件，fresh DB 全迁移）** +
  全量单测 **6742/0** + tsc 0 → `--force-with-lease` 推送（先证远端未被平行会话动过）→ PR body 重写
  （19 commit 全景+诚实 out-of-scope）→ owner checkpoint 三门逐条回复（②exact-head 数据绑 SHA）。
  **CI 于 head 8c95bec48 全部 checks 通过（0 失败）**，零自合等 owner 审。

### 1.4 activation 收口（owner 复审「producer 基本完成≠activation 闭合」四项，head `5afe30f26`）
owner 指出「只剩 family-1」只适用于 producer 分组，不等于 #4337 只剩一项，列四项必须先关否则 checkpoint 应
诚实写「基本完成，仍 REQUEST CHANGES」，不能报 activation 闭合。**四项已全关**：
1. **family-1 同源事务证据缺口**：completion×6 经 `approvalTxnHandle(client)` 在事务回调内、task_created×9
   经 `enqueueApprovalTaskCreatedEventsInTxn(client,…)` 紧邻 COMMIT——全部词法核实在源 BEGIN..COMMIT 内。
   上轮只有 completion 原子性（F1-G5），补 **F1-G6**（注入 task_created outbox 失败→instance/assignments/
   enqueue 三者同滚零残留，clean retry 三者同 commit；变异=挪到 COMMIT 后即红）。
2. **`multitable.comment.created` 从 v1 manifest 移除**（自纠：上轮回复把它记为「惰性无害」不当）：全仓普查零
   发射方，连 legacy bridge 订阅从上线即死；路由无 producer=死配置伪装覆盖。真 producer=family-6 + manifest
   v2（否则是 flag-OFF 行为变更）。第二处标注的 ratified 字面量修改。
3. **webhook durable handler 丢 eventId**（自纠：上轮把重复投递记为「教义接受」——对 send↔done-CAS 崩溃窗成立，
   但 handler **整个丢弃** outbox eventId ⇒ 连普通 busy-retry 都重建行+重发=非受迫重复，非 at-least-once 下限）：
   迁移加 `event_id`+partial-unique `(webhook_id,event_id)`；durable 腿穿 eventId→claim（ON CONFLICT DO
   NOTHING，0 行→跳过发送）；legacy 无 eventId→NULL→字节等价。G1-G4 goldens+2 变异。
4. **flag-ON boot fail-closed**：boot 失败原「continuing in degraded mode」吞异常——flag ON 下 legacy emit 已
   被抑制、无 loop 即静默全量断投（比崩溃更糟）。改 disposition 策略（单测钉死）：ON=rethrow 中止启动，
   OFF=log-and-continue 字节等价。
**验证 head `5afe30f26`**（fresh DB 全迁移含新 webhook 迁移）：durable+webhook 电池 **104/104（15 文件）**+
全量单测 **6782/0**+tsc 0；两处 ratified 字面量修改（form.submitted 事件名 + comment.created 移除）均显著标注
请 owner 复核。收口 MD（本文）随 #4457 更新。

### 1.5 启动可靠性第二轮（owner 对 5afe30f26 REQUEST-CHANGES 2P1+1P2，head `1d3854c7a`）
owner 精确指出 disposition 只覆盖 boot 块内异常、整链仍可绕过：①AutomationService 早期 init 失败被吞 →
`if (this.automationService)` 静默跳过 durable boot（flag ON 无 dispatcher 无异常=静默滞留）；②retry
scheduler 可被 env 关闭/init 失败被吞，但 durable webhook 腿的崩溃恢复正是它；③types.ts 缺 `event_id`
（raw SQL 绕过类型层所以 tsc 不报）。**修复**：`assertDurableRuntimeDependency`（单测矩阵 5/5）在 skip 前
与 scheduler 启动后断言，flag ON 缺失即 throw→disposition 中止启动，flag OFF 字节等价降级；types 补列。
**真实启动级回归**（owner 明确要求非纯函数测试）：`multitable-durable-startup-failclosed.db.test.ts` 驱动
真 `MetaSheetServer.start()` 生命周期 ×5——S1 flag ON+scheduler 禁用→启动拒绝；S2 flag ON+AutomationService
构造失败（模块 mock 向真 init 路径注入构造异常，其余全真）→启动拒绝；S3/S4 flag OFF 同故障→照旧降级启动；
S5 flag ON 健康→正常启动（不过度触发）。5/5；**变异证**：同时移除两处 assert（=修复前形态）恰好 S1+S2 红、
S3-S5 绿。harness 约束（stop() 会 end 共享 pool）已在 spec 头注文档化。
**验证 head `1d3854c7a`**：durable+webhook+startup 电池 **109/109（16 文件）**+全量单测 **6785/0**+tsc 0；
push 后回读远端 SHA=1d3854c7a 确认。**状态=工程侧修复交付、待 owner 复审**（在复审通过前 #4337 不可合，
不再主张「全为 owner 门」）。

### 1.6 终态：#4337 MERGED（2026-07-18，squash `dfc9318fc`）
owner 对 head ed2394b7f COMMENT-review **APPROVE**（无新 P1/P2；正式追认两处字面量修正），并在其会话
补强 publish-last readiness（构造+init+规则加载全成后才发布）与 boot 依赖全验证→dispatcher 最后启动
（失败路径 stop-and-null 回滚），启动矩阵扩至 **8/8**（含 init()/load 两 rung 注入 + dispatcher DB-tick
探针）。授权机械合并后：两轮 rebase（热 main）均以产品 diff md5 核验不变（`ce3d1714e…`）→ push 回读 →
armed auto-merge → **MERGED main**。非阻塞 P3 备忘：程序化 start() 拒绝时更早启动的非 durable 后台服务
仍存活（生产入口立即退出进程）。线剩余=flag 全 OFF→UAT→分级 ON（owner 门）；8 场景正式验收（S6/S8 依赖
FWB 栈合入，S1-S5/S7 可先行）；family-6 comment producer + manifest v2（菜单）。

## 2. #4342 附件 runtime — 闭合审计（review-ready，owner 门）
- opus 审计对 head 23e090807：**REVIEW-READY**。两 P1（G7 下载字节路径隐藏字段红线 / G15 reconciler 误删
  活 blob）在真码上变异证明 CLOSED（中和守卫→指定测试 RED，正控 12+4 绿）；17 个可识别 findings 全闭；
  本地 80/80。诚实边界：真库套件本地未跑（无迁移 PG，两点接线已核）；~8 个 P3 因原清单未公开不可复原;
  整链 boot 仍未接（flag OFF）。PR 标题已改为诚实全 7 切片表述。**合并形态（整包 vs 按锁拆）=owner 裁决**。

## 3. #4450 fan-out 设计锁 — 审阅 + rev 2（ratify-ready，owner 门）
- opus 审阅：NEEDS-CHANGES（3 P2+2 P3），已贴 PR。rev 2（c3f7cb827）全部吸收：person key 补 integrationId
  corp 维度（G-F4b 跨企业单射 golden）；group key 改真实 destinationId；person 语义重写为「per-target 行 +
  per-BATCH claim/outcome」保留已合入的 100/批 asyncsend_v2（拒绝 unbatch=flag-ON 行为变更），崩溃窗口全
  部映射 §8 fail-closed 教义；§2.2 迁移↔原语锁步义务；MAX_CLASSB_FANOUT_TARGETS 显式上限+G-F6。

## 4. #4433/#4439 审批模板「分支编排+版本管理」接管（owner 明示授权接管 Codex lane）
- 首轮 opus 审阅双双死于账号 session limit（12pm PT 重置）；按预案改 fable 模型代理续审（继承死代理
  部分结论线索），worktree 污染防护（死代理 worktree 弃用重建）。
- **#4439 版本 diff+安全恢复 审阅完成 = APPROVE-with-hardening**（对 head 2316446bd）：核心安全声明全部
  真库实证成立（IDOR 服务端 SQL 强制/乐观锚真 CAS 并发双 restore [201,409]/provenance 不可变/RA-1b
  publish fail-closed/无 closing keywords）；2 P2=覆盖接线缺口（快照重校验守卫可整块删除而全绿；新 FE
  diff spec 不在任何 CI gate）+3 P3（diff 烘 index/IDOR 真库判别缺/updateTemplate 并发 500）。审阅已贴
  PR。**硬化批完成并推送（head 22dc9dc6d，3 commit）**：P2-1 守卫实证为真、补判别真库 golden（非法历史
  快照→400 零写入）；P2-2 diff spec 双点接入 approval-web-guard + required-web-tests 并集；P3-2 跨模板
  404 真库负例；P3-3 **前提被反驳**（FOR UPDATE 基线即存在，改为确定性串行化 pin 测试，drop-lock 变异
  复现 review 预言的 500）；P3-1 `moved` kind 落地（中部插入 4 条虚假变更→精确 1 条 added）；NIT 缺锚
  400 负例。变异 6/6 击杀；head 全绿（tsc/vue-tsc 0、unit 32/32、真库 UAT 5/5、FE 94/94、lint 清）。
  PR body 已补硬化段。**剩 owner 审合门**。
- **#4433 分支编排 审阅完成 = CHANGES-REQUESTED**（对 head a85fb4564）：**1 个活 P1**——「+条件分支」
  产出 `{rules: []}`，FE 校验/后端 normalize/publish 三层全放行，运行期 `[].every()`≡true ⇒ 该分支
  静默捕获全部流量、默认路径与后续分支失效（死代理的「silent P1」线索定位成功；仅 starter 网关有守卫，
  add-branch 路径无守卫无测试，变异证实）。+2 P2（并行同人 false-green→每请求 409；promote 保真对非
  默认配置变异盲=flatten 变异 109/109+90/90 全绿存活）+3 P3+NIT。绿面：4 套件 109/109、邻居 45/45、
  vue-tsc/lint 清、4 spec 已接 approval-web-guard。审阅已贴 PR。**修复批完成并推送（head fd727dd5e，
  4 commit）**：P1 四层收口（add-branch seed 网关 starter 规则 / FE 校验 0 规则报错 / 后端
  create·update·publish 三 choke 点 typed `APPROVAL_CONDITION_BRANCH_RULES_EMPTY`（故意不进存量图
  normalize——读路径永不 brick）/ 运行期 `resolveConditionTarget` 防御守卫（空规则分支永不匹配、落回
  默认边；先 grep 证存量 `rules:[]` fixture 全为公式分支，无钉死行为））；P2-并行同人=starter 改种现成
  configure-before-publish sentinel + publish 门 `assertNoParallelDynamicAssigneeConflicts`（仅可证同
  一动态源，异 kind/参数负例，merge 策略豁免）+ FE publish checklist 镜像；P2-promote=非默认配置
  RICH_LINEAR fixture 全配置 `toEqual` 往返（首轮存活的 flatten 变异现红）；P3=嵌套并行禁止编排（op
  throw + 画布/列表隐藏入口）。**13/13 变异击杀**（含首轮存活的 M1/M3）；head 全绿（FE 278/278、后端
  approval 单测 413/413、双 tsc 0、lint 清）。PR body 已补状态段。**剩 owner 审合门**。
- 功能缺口菜单（两侧合并，后续切片计划的输入）：#4439 侧=node-config 级 diff 深度 / publish 乐观锚 /
  版本 retention / restore audit 事件 / restore 权限位 / 孤儿草稿口径；#4433 侧=分支/网关删除 UI /
  demote 撤销 / 分支优先级重排（first-match-wins 不可编辑）/ re-merge 编辑 / FE 嵌套并行预防 /
  存前分支路由 dry-run / 画布拖连与缩放 / 用户文档。
- **切片排序建议（owner 菜单，每片独立 opt-in）**：
  ①（价值最高）分支/网关**删除 UI**——runtime `removeConditionBranch`/`removeParallelBranch` 已存在为
  dead export，纯 FE 接线+校验，小片；②**分支优先级重排**（条件分支 first-match-wins 当前不可编辑，
  与删除 UI 同一画布操作面）；③**restore audit 事件**（#4439 侧，与 publish/archive 对齐，后端小片）；
  ④**publish 乐观锚**（#4439 审阅指出 restore 扩大 surprise-publish 窗口，与既有 restore 锚同构）；
  ⑤**node-config 级 diff 深度**（版本 diff 目前只到节点增删改名级）；⑥版本 retention 策略（需先定
  产品口径=owner 决策）；⑦画布 UX（拖连/缩放）与用户文档（量大、放最后）。

## 5. 剩余事项（与 §1.6 及 GitHub 实况对账；owner 2026-07-18 inline review 更正后重写）
**工程侧（非 owner-only，2026-07-18 收尾轮处理中）**：
- ~~#4337 合并~~（**已 MERGED main `dfc9318fc`**，见 §1.6）。
- FWB 栈：#4341 曾有 required 红检（测试仍查 #4340 拆分前的旧 ledger 表名→42703；已修=四处引用改
  `meta_fwb_action_applied`，真库 4/4 复绿）→ rebase 落地后依次 #4343 → #4344。
- #4439 曾 CONFLICTING/DIRTY：需解冲突+重验证后才可复核（处理中）；#4433/#4342/#4450 落后 main，
  需 rebase/re-green（处理中）。
- 8 场景验收矩阵**拆分**：S1-S5/S7 现在即可跑（#4337 已落）；S6/S8 阻塞于 FWB 栈合入。
**owner 门**：#4342 合并形态裁决+合并；#4450 ratify；#4433/#4439 复核审合；3 个 runtime flag
（durable/CLASSA/CLASSB）全 OFF→UAT→按 durable→Class A→Class B 分级开启。
