# 审批及流程自动化 · batch-3 目标池 · 设计与验证收尾 — 2026-07-10

> 计划与排序：`approval-automation-batch3-goalpool-plan-20260709.md`（A/B/C 三档分级 + 车道=文件独占）。
> 来源阶梯：`docs/research/approval-automation-operation-ux-benchmark-20260704.md` §4 batch-3。
> 纪律：只陈述 MetaSheet 自身原则，不出现外部产品名。

## 1. 这一轮做了什么

owner 于 2026-07-09 将「审批及流程自动化余下开发」重开为总目标池（固定节奏、可并行、模型按难度分派 Fable5/Sonnet5、Opus4.8 备援）。对账确认无门项/RP 线/UF 线均已收官 → 余下 = **batch-3 gated backlog**。按三档推进：

- **A 档（立即建）**：5 条车道并行实现（本文 §2）。
- **B 档（lock-first）**：2 份 PROPOSED 设计锁（§3）——只锁设计，runtime 等 owner ratify。
- **C 档（战略围栏）**：T36-3 / T3-3-ENF / T3-2 org-mapping / T1-4b / T3-5-FU **未动**，等 owner 点名。
- **排除**：DingTalk 交互卡片 Slice-B/A5（并行会话在推，#3999/#3991）。

**B3-12 重分类**（advisor + 源码证实）：`automation-service.ts testRun()` 真执行规则（write/notify/webhook 全真发）→ 接受真实 recordId = 真副作用，从 A 档降 B 档，并入 B3-10 治理锁。

## 2. A 档五车道 as-built

| 车道 | 项 | PR | 一句话 as-built |
|---|---|---|---|
| L1 收件箱完整性 | B3-01/02/03 | #4036 | 我已处理第5 tab（approval_records 按已认证 actor 反查，不限状态）· pending 行级 isRead（镜像徽标未读谓词，逐字节一致）· templateId+createdFrom/To 过滤 + 指标看板计数变深链 |
| L2 模板治理 | B3-08/09 | #4037 | published↔archived fail-closed 状态机（事务+FOR UPDATE；在途实例不受影响，逐读者清点证实）+ 用量 blast-radius 确认 · 版本历史 summary 端点（admin guard）+ 发布说明（事务前规范化 trim/2000 cap，additive nullable 列） |
| L3 自动化可观测 | B3-11 | #4033 | 监控列表 additive ruleName/sheetName（批量查询恒 2 条、fail-open 仅降级名字、删除行诚实回退 id）；**构建中自抓真 bug：首版误 join 旧 `sheets` 表，实为 `meta_sheets`** |
| L4 详情页打磨 | B3-13 精选 | #4035 | 撤回按 policy.allowRevoke 严格 fail-closed（FE=服务端可达性精确镜像，review 溯源证实运行时实例自首个 executor commit 起必带该布尔）· 按动作 loading · AsyncStateBlock 组合 UF-8 EmptyState · 复制摘要/打印 |
| L5 死代码清理 | B3-14 | #4034 | 删 523 行未路由 ApprovalInboxView + 孤儿引用；乐观冲突 reconcile 早已独立成 `approvalInboxFeedback.ts` 且被 live PlmProductView 依赖 → 不迁移只删视图 |

## 3. B 档两把锁（PROPOSED，runtime 🔒 owner ratify）

- **B3-07 附件管线锁**（#4031）：存储 = **HYBRID 复用**（复用 StorageService blob 底座 + attachment-service 模式；新 `approval_attachments` 表 + 审批域端点；**拒绝**复用 multitable_attachments——FK/授权模型/生命周期三重不匹配，其下载守卫会把审批附件泄给任何 multitable:read 持有者）。发起人-own-draft 上传、提交时事务内一次性 bind、下载=实例可见性 AND 隐藏字段脱敏、reject-by-default 类型/大小、refs 冻结进 form_snapshot、零新增 egress、default-OFF flag、G1-G10 + 12 项 RED-before 清单 + 7 个 ratify 问题。
- **B3-10+B3-12 重试/样本试运行治理锁**（#4032）：两项共用一个 replay/副作用底座（`testRun`/`retryExecution` 都重进 `executeRule` 真发动作；T2-6 ledger 只 gate `handleEvent`）。重试 = per-action applied-ledger（root_execution_id+action_key，claim-then-skip，mark-after-success）；试运行 = **默认 dry-run**（副作用动作 record-not-dispatch，真实记录只喂条件/取值），real_fire 显式 opt-in + confirmSideEffects + canManageAutomation。**顺带发现真缺口：backend test 路由今日无能力门（仅 FE confirm）→ 锁 G8 关闭。**

## 4. 验证与对抗审阅（全部独立 reviewer，非自审）

每条 impl 车道过独立 adversarial-reviewer（Fable，refute-first，一次性 worktree 真跑测试+复跑 mutation）：

| PR | 判定 | 要点 |
|---|---|---|
| #4033 | APPROVE（0 P1/P2） | 逐写路径证实 sheet_id 恒为 meta_sheets id；4/4 独立 mutation 红；P3 陈旧注释已修 |
| #4036 | APPROVE-with-hardening | **P2（已修）**：approval_reads 每用户谓词被 mock 前缀匹配遮蔽——service 里删掉 `user_id=$1` 测试仍绿；修法=mock 按完整谓词文本 key，service 侧两种 mutation 现在必红。processed 反查防敌意参数改向 = SQL 谓词内钉死（复跑 mutation 红） |
| #4037 | APPROVE（0 P1/P2） | 逐读者清点证实归档不影响在途实例每个动作；**P3-1（已修）**：publish 曾无条件把 archived 翻回 published（静默绕过启用确认）→ 409 APPROVAL_TEMPLATE_ARCHIVED fail-closed + mutation 红；**P3-2（已修）**：summary shape 测试钉精确 key 集 |
| #4035 | APPROVE | 头号反驳假设（严格 === true 杀死存量撤回）被后端取证**反驳**：运行时实例自 68d0f988b (2026-04-11) 起构造性必带布尔 allowRevoke，legacy 非运行时路径服务端本就 400/409；**P3-2（已修）**：UF-8 tripwire 从可被注释满足的词匹配收紧为元素形态 `<el-skeleton`（mutation 红） |
| #4034 | APPROVE | 独立全仓 grep 零功能引用；kept-modules 被 live PlmProductView 依赖证实 |

数字（各车道分支上）：backend 全套 341-342 files / 4550-4588 · required web gate 106-110 files / 1568-1599 · lint/vue-tsc build 全绿 · RED-before：L2 7/7 精确红、L1/L3/L4 各自 RED-before + mutation 轮（L1 M1-M8、L3 4/4、L4 M1-M4）。

## 5. review 发现但**有意不修**的（follow-up 菜单，非缺陷掩盖）

- #4035 P3-1：跨动作并发守卫 neuterable-green（同动作已测；服务端 FOR UPDATE+版本检查兜底）· P3-3：FE 未镜像 revokeBeforeNodeKeys 窗口（既有类）· 复制摘要硬编码 zh。
- #4037 NITs：requester 画廊显示 inert 归档卡片 · 状态过滤 tab 翻转后行残留 · down()-after-deploy 破 publish（回滚 SOP 注意）· 自动化规则保存时可绑归档模板（触发时 fail-closed）。
- #4036 P3s：sourceSystem=all 视图下外部行未读点不受本地标记已读影响（继承的 LIST↔COUNT 集合分歧，未读谓词本身合规）· 单边 createdFrom 深链丢过滤（现实 producer 不可达）。
- #4034 P3：kept-modules 的 ~7 个 test-only 导出成死代码 + plmApprovalInbox specs 不在任何 CI gate（清点入 [[feedback_apps_web_specs_ungated]] 家族）。

## 6. 过程（工程记录）

- **session 限额 ×3**：两轮 agent 全灭 + 一次 finisher 中断（重度车道 L3 246k/L4 199k tokens 抽干整窗）。对策：①每子项增量 commit+push（第二轮起每次死亡至多损失一个子项）②主循环从死 agent worktree `add -A && commit && push` 抢救未提交工作 ③主循环亲自收尾（L2 B3-09 route/FE/tests、L1 终验）④Sonnet 池被限时 Fable-model agent 可用。
- **auth 403 一轮**（Please run /login）：瞬时，resume 探针恢复。
- `git checkout -- <file>` 又吃掉一次未提交改动（B3-08 409 gate，重写后 commit-before-mutate 补救）——旧教训第三次验证。
- 落地：strict up-to-date + 并行会话高频落主 → BEHIND 治理 = update-branch + auto-merge + champion 串行；4 个 impl PR 在 `run-required-web-tests.sh`/`approval-web-guard` filter 行互撞 → **union 解**（保 main 全集 + 加本支 tokens；L5 同时删 approval-inbox-auth-guard token）。

## 7. 落地台账（全部 squash-merge 到 main，2026-07-10）

| PR | 内容 | merge SHA |
|---|---|---|
| #4031 | B3-07 附件管线锁 (PROPOSED) | ecefe934e |
| #4032 | B3-10+12 重试/试运行治理锁 (PROPOSED) | 438056a93 |
| #4033 | B3-11 监控行 ruleName/sheetName | 5fe73075d |
| #4034 | B3-14 删除遗留 ApprovalInboxView | 409a06cd7 |
| #4035 | B3-13 详情页打磨 | a0e05898a |
| #4036 | B3-01/02/03 收件箱完整性 | 743572306 |
| #4037 | B3-08/09 模板治理 | bdf37fb08 |

**落地机制记录（owner 决策项实证）**：strict up-to-date + required `test(20.x)`≈11min + 四条并行会话车队（stock-prep/multitable-R9/attendance-Wave1/DingTalk）高频落 main → #4035 一支经历 **10 轮 update-branch treadmill、三次全绿被抢窗**才落地；#4034/#4036 各 2-6 轮。**merge-queue（分支保护开关）是治本**——本轮是至今最强实证。CI-filter 行冲突全部按 union 解（main 全量 + 本支引入 tokens；两次自动 union 差点复活 main 已删除的 `approval-inbox-auth-guard` token，被逐支手检拦下——union 规则须区分「本支引入」与「本支残留而 main 已删」）。

## 8. 池后状态

A 档五车道 + B 档两锁 = 本轮 opt-in 池清空。**剩余 = gated**：B3-07/B3-10+12 实现（等锁 ratify）· C 档战略项（等点名）· §5 follow-up 菜单（spare-bandwidth）。
