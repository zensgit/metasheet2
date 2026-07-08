# Multitable Global History — R4「闸门前推进」轮 设计+验证记录(2026-07-07)

**性质:** 固定节奏第 4 轮(R1/R2/R3 见各自轮次 MD)的设计+验证记录。本轮授权来源 = owner 线级全自动 /goal(「完成这条历史记录与版本恢复开发线中所有的开发…我不在电脑前,全自动处理」)。
**执行口径(本轮的核心裁量):** 线上剩余项全部带 owner 闸门(forward-plan #3633),线级授权**不等于**逐项签核——故本轮把每个闸门项推进到**闸门前的最远点**(锁文起草/方向文档/彩排取证),**不越**:4c impl(需 ratify)、flag 翻转与 staging 操作(operator)、GW runtime(属多维表窗口会话)。

## 1. 轮编成与模型分派(难度×模型,承袭 §0 策略)

| 车道 | 内容 | 模型 | 结果 |
|---|---|---|---|
| 地基×3 | retype 管线 / tombstone 捕获面 / T-source 现状(并行 Explore) | Explore(读检索) | 三份 file:line 地基素材 |
| R4-A | 4c-1 lossy retype revert design-lock 起草 | **Fable(主会话)** | #3812 |
| R4-B | 4c-2 forward tombstone-capture design-lock 起草 | **Fable(主会话)** | #3809 |
| R4-C | T-source 方向一页纸 | **Fable(主会话)** | #3807(+#3830 更正) |
| R4-D | O-1 本地彩排(#3609 harness 首次真跑) | **Sonnet**(隔离 worktree) | #3820 |
| 闸门审 | 三文档 post-hoc/pre-merge 对抗审阅 | **Opus**(adversarial-reviewer) | 判定+findings(见 §3) |

**断档韧性(本轮实证):** 车道执行中遭遇账号级 session-limit(~40 分钟级)。期间:纯 bash 的 auto-merge+keep-sync 照常落了 2 个 PR(不吃模型配额);心跳 cron(:13/:43,空闲时触发)在配额重置后自动唤醒会话续跑;被杀车道经 SendMessage 带上下文复活。owner 同日新增指令已入记忆:**Fable 5 不可用 → 强模型角色回退 Opus**(账号级断档除外,只能等重置)。

## 2. 交付物(全部 docs/evidence,零 runtime 改动)

| PR | 内容 | 状态 |
|---|---|---|
| #3807 | T-source 方向一页纸(PROPOSED) | MERGED `32cb8fdd5`;post-hoc 审出 P1 前提过时 → #3830 更正 |
| #3809 | **4c-2 forward tombstone-capture DESIGN-LOCK(PROPOSED,待 ratify)** | MERGED `e7ac00cf8`(+#3830 修正) |
| #3812 | **4c-1 lossy retype revert DESIGN-LOCK(PROPOSED,待 ratify)** | MERGED `6fc1462de` |
| #3820 | O-1 本地彩排证据(40 PASS / 0 FAIL / 0 SKIP) | MERGED `a5f655da9` |
| #3830 | post-hoc 审阅修正(#3807 前提重写 + #3809 锚/口径/行号) | MERGED `6136cdd88` |

两份锁文合计:C1-C7×2 不变量、G1-G10 + L1-L11 golden 矩阵(fail-first,含 mutation 锁与 no-oracle 专项)、互引联动条款(锚 = coercing revert 自身 revision,双 ratify 才生效)。

## 3. 验证

### 3.1 对抗审阅(Opus,refute-first;MD = `/tmp/pr3809-pr3812-pr3807-review-claude-20260707.md`)
- **#3812:APPROVE-with-fixes** — 起草者自修的 drift 同尺比对 + L5b golden 被判定「真正闭掉隐藏行探针自伤」;2 个 P2 已修:①U-L8 祖源 owner 修正 `:130` 对齐(undisclosed 标记禁止数据派生,capability-常量或 full-read gate,**ratify 时 owner 二择一**);②联动锚统一为「该次 lossy revert 自身的 config revision」。
- **#3809:APPROVE-with-fixes(post-hoc)** — 捕获模型判定 sound(入/出边划分、mirror/自链场景、4d 红线全部核过);fixes 经 #3830 落地(锚对齐、cap 422 vs 413 口径注、行号刷新)。
- **#3807:CHANGES-REQUESTED(post-hoc)** — **P1:前提为伪**。A2 形态已由当日 06:02 的 **#3749**(Codex 线)上线;初版基于落后 155 commits 的过时快照调研。#3830 已重写 §1/§4:真实决策点 = **保持 A2(已上线)vs 简化为 A1**。
- 审阅横断面结论:三文档中所有非 `univer-meta.ts` 引用逐一核准;`univer-meta.ts` 行号系统性过时(已刷新 + 加行号注)。

### 3.2 O-1 本地彩排(#3820;「本地彩排 ≠ staging 验收」)
6 次运行、6 种 flag 姿态全部预期(全关 7P / 单开 16P/17P/21P / 全开 **40P-0F-0S** / 无 EDITOR_TOKEN 干净 SKIP),exit 全 0;**harness 零代码缺陷**;2 条 operator 前置入库(EDITOR_TOKEN 须真实 users 行;exit 2 无 summary 的定位法)+ 8 条 staging 首跑注意事项。

### 3.3 跨车道发现(重要,更新线状态图)
**#3749「complete Global History remaining code gates」(Codex 线,owner 已合,06:02)** 一次性落了本线三个原 gated 项的 runtime:①PIT Reset 的 retention 冲突 fail-closed 守卫(`RESET_RETENTION_CONFLICT`,零写入)——PIT_RESET STOP-SHIP 条件的后端侧闭合;②T-source A2(锚定 select 主路径 + Advanced 兜底);③三破坏性 config tier 的 Config History modal 接线(typed confirms + execute confirm 转发)。**本线的「破坏性 tier FE」与「T-source」两个闸门项的形态已由该 PR 实质推进**;flag 仍全部默认关。

## 4. R4 后的线状态(闸门菜单,owner 逐项决策)

1. **ratify 4c-1 / ratify 4c-2**(锁文已备、已对抗审阅;4c-1 ratify 时须二择一 U-L8 式:full-read gate(推荐)或 capability-常量标记);4c-3 依赖 4c-2 impl 先行。
2. **T-source 残余一句话:「保持 A2」(零工作)或「简化为 A1」**(#3830 更正后的 §4)。
3. **O-1 staging 正式验收**(operator;#3820 已把首跑摩擦预清:token 前置/退出码语义/8 条清单)→ O-2 flag 阶梯(#3749 的 retention 守卫使 PIT_RESET 的 STOP-SHIP 后端侧已闭,建议 owner 确认后按既有顺序推进)。
4. **destructive-tier FE 是否视为闭合**:#3749 已接线 modal previews——原 gated 项「三破坏性 tier 的 FE」建议由 owner 对照后判定闭合或列残差。

**池空声明:** 至此本线再无「闸门前可推进」项;线保持静默,直到任一解锁词出现或 operator 阶梯产出新证据(节奏承诺同 forward-plan §4)。

## 5. 本轮教训(记忆已归档)

1. **stale-worktree 第 5 次翻车(P1 级)**:向子代理断言「park-neutral≈origin/main」→ #3807 前提为伪。新推论已入记忆:**永远不向子代理断言 checkout 新鲜度**,让子代理自己 `git fetch` + `git show origin/main:<path>`。
2. **误判子代理死活 → 双跑浪费**:以输出文件时间戳/体积猜测复活的审阅代理已死,另起新代理——实际前者活着且交付了完整审阅(后者中途叫停)。修正:**以任务通知为准,不以文件元数据猜死活**。
3. 断档韧性三层(shell 循环/心跳 cron/带上下文复活)首次全链路实证,已成本线标准姿态。
