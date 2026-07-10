# Multitable 时间机器线 — R9 恢复轮 设计+验证记录（2026-07-09/10）

> **性质**：R9 轮次记录（owner /goal「接续多维表历史记录与版本恢复线，剩余开发=总目标池，固定节奏，Fable5/Sonnet5 分派」）。
> 本轮 = 搁浅设计对话恢复 + 4 车道实况审计重derive池 + Wave-1 实现 + owner 深审(2P1+2P2)修复 + 复审落地。
> 权威现状图仍为 `multitable-global-history-verified-state-map-and-decision-menu-20260703.md`；本文只记 R9 增量。

## §0 轮次起点与池derive

- **恢复（#4003, MERGED `3e4b0ac4e`）**：「多维表历史记录与版本恢复」2026-06-19/29 设计对话的产物（Time Machine+ 设计锁+TODO+masterplan）搁浅于 `codex/review-pr-3381`（landing PR #3381 当日撤回）。cherry-pick `a3286d405`（逐字+原署名）+ AS-BUILT 对账层（#4000 模式）。对抗审阅 APPROVE 0P1/0P2，NIT×3 折入。masterplan §9 = plan→as-built 台账（T1 读时投影/T5 分族预览/T7 API 形态 = 设计允许项内选择；剩余池 = O-2🧭/D-2📄/S1📄/4d❌）。
- **审计（4 车道 workflow，445k tokens）**：A=TM+ 验收细则 vs 已建（绝大多数 MET；unmet=标题渲染×2、link/person JSON dump、浏览器证据）；B=残差实况（R5c web-guard 缺口已修=记录过时；**新发现 L1c**：HistoryBatchChangesList+3 真实 spec 零 CI 门；L2 field-value tombstone 地板=gated；L4 sheet_id 规则已有代码级注释守卫）；C=D-2 范围 brief（**PIT-reset 已由 4c-3 D-3 达全奇偶 ⇒ D-2 仅剩 plugin+automation 两路**）；D=History Center UX parity（met=搜索权限安全/actor 回退/空错态；unmet=字段名泄漏(g)/标题(b,h)/click-through(d)/JSON dump(i)；gated=restore 回链(e)需 schema 列）。

## §1 Wave-1 交付（全部经 owner 深审 + 修复 + 复审 LAND）

| PR | 内容 | 关键验证 |
|---|---|---|
| #4006 `a83499802` | CI：HistoryBatchChangesList + 3 真实 spec + **field-scope 安全 spec**（owner P1 补）接入 web-guard 两块 + guard filter + run-required | UNION token-diff REMOVED=空；落地顺序探针（vitest 容忍无匹配位置过滤器，exit 0） |
| #4007 `bd0c7da11` | 字段名泄漏修复：**layer-2 ∩ layer-3**（owner P1 修正后）`historyVisibleFields = filterPropertyVisibleFields(scopedAllFields)` | 真实挂载 spec 钉两层（HiddenNotes/SecretSalary）；两个单层突变各红对应断言 |
| #4012 `555a21079` | 记录标题（pickRecordTitle over 已掩码 payload；删除行取 before）+ link/person 类型化 diff + **owner P2 修**：`linkSummariesForSide` 按侧 value ids 值序过滤，全覆盖或计数回退 | 6+2 新 spec；标题双突变；unfiltered 直传突变恰好双红（before 含 Beta Task / under-counted）|
| #4018 `2dc5587ca` | 批次详情→记录抽屉 click-through（复刻 onNotificationNavigate：onSelectSheet→resolveDeepLink；零新端点/文案）| modal emit 契约 + workbench 四态（in-page/off-page fetch/gone toast/cross-sheet）；neuter emit 突变 5 红 |
| #4025 `ea45dde6a`（最终 head `7f48983a`；本行原记 auto-merge 布防中/旧 head `519679bfa`，由 R9 fix-forward 对账更正） | 4c-3 NIT 金测：RB15（drift-tripwire 竞态诚实钉）+ RB16（NOT EXISTS 同语句盲区=忠实双放）+ 注释精化（tripwire 语义/tombstone-capture 路由枚举补 PIT-reset）；NIT-5a(SELECT *) 如实跳过 | 每金测独立突变（fold 移除→RB15 红；DISTINCT ON→RB16 红）；新鲜 pg 16/16+邻居 35/35 |

## §2 Owner 深审（2P1+2P2）→ 修复 → 复审

- **P1 #4007**：初版换 scopedAllFields 丢 layer-2 —— 修=交集 + 双层 golden。**教训：字段可见性两层独立（property.hidden/visible 与 field_permissions RBAC），任何单层过滤=泄漏另一层名字。**
- **P1 #4006**：新安全 spec 本身不在门里 —— 修=四处接线 + 落地顺序探针。
- **P2 #4012**：formatFieldDisplay 有摘要即无视 value —— 两侧同名单；修=按侧过滤。
- **P2 #4004**：锁内四条款互相矛盾 —— 修=§1.11 真值表（SIDE_DOOR×CAPTURE×schema，每行 golden 钉）+ **schema 缺失+flag-on=fail-closed**（owner 裁决；与 UI 路径 never-fail 降级的不对称=显式 ratify 项）。
- **复审**（独立对抗代理，突变全数自行复现，worktree 复原核验）：#4003/#4006/#4007/#4012/#4018 全 **LAND**，#4004 **RATIFY-gate**（真值表无矛盾、每行有 golden）。0 新 P1/P2。附带：TrashModal layer-2 标题播种=观察项（未修）；pickRecordTitle 无摘要 NIT；#4004 §1.8 可补 path-2 交叉引用 NIT。复审 MD=/tmp/r9-stack-rereview-claude-20260710.md。

## §2b Owner 补审（#4025/#4042，2026-07-10）→ fix-forward

轮末汇报曾把 #4025/#4042 与前六项并述——实际上二者当时**仅做了合并核验，未做 owner 内容深审**。补审结论：1 P2 + 2 P3，由本 fix-forward PR 同修：

- **P2（行为修正，owner 裁决）**：`InboundReplayResult.total` 承诺 `total === replayed + sum(skipped)`，但实现先算 `total` 再做 tripwire fold（`skipped.alreadyPresent` 后增）——drift 窗口内 total 少计且下游 `recoverable: replay.total > 0`（record-service.ts）随之失真；RB15 还把这一不一致固化为断言（`total===0`）。修：**fold 完再算 total**；RB15 改期望 `total===1` 并新增契约恒等断言。
- **P3（注释自相矛盾）**：tripwire 注释称 NOT EXISTS「仍能阻止任何重复」，与 RB16 证明的同语句盲区矛盾——收窄为「拒绝语句快照中已可见的重复；同语句正在插入的兄弟行对其不可见（RB16）」。
- **P3（本台账过时）**：§1 表 #4025 行原记旧 head `519679bfa`/auto-merge 中——已更正为合并 SHA `ea45dde6a`（最终 head `7f48983a`）。

补审其余结论良好（RB15 注入确在两条 SQL 之间、RB16 确验同语句可见性边界、测试文件已在 real-DB CI 清单、#4025 全检查通过）。

## §3 D-2 设计锁（#4004, PROPOSED — owner ratify 前零实现授权）

范围收窄（审计 brief）：四条 `DELETE FROM meta_records` 路径中 PIT-reset 已由 4c-3 D-3 as-built 达全奇偶 ⇒ D-2 = plugin-SDK + automation 两路。锁定：锚奇偶（预生成 uuid=revision id=trash.delete_revision_id=tombstone source_revision_id，禁启发式）、同事务原子（D1-5b BEFORE-DELETE 触发器技法）、cap fail-closed、restore 侧零改动（trash 行 source-agnostic，retention 地板自动覆盖）、§1.11 真值表、G1-G12 金测族、OD-1..OD-8（含跨 base 处置）。两轮对抗审阅：APPROVE 0P1/0P2（4P3 全折入）+ 复审 coherence PASS。

## §4 事故与工程教训（如实记录）

1. **会话限额中途杀死全部 4 个子代理**：CI 车道改动完成未提交=主会话就地收割；FE 车道 WIP=主会话接手补 mock/修测试交付。耐久纪律（早 commit+push）救了本轮。
2. **`git checkout -- file` 抹掉未提交改动 ×1、sed 全局替换毁现场 ×2**：突变验证一律 Edit 工具单点做、做前必 checkpoint commit。
3. **jsdom 单 window/spec 文件 + workbench 把选中记录镜像进 URL hash 并在挂载时 deep-link 自举** → 跨用例幻影 resolveDeepLink（同消息双 toast）；修=beforeEach 清 hash。
4. **workbench 的 showError 走 MetaToast 模板 ref 而非 useToast composable** —— stub 必须 expose({showError})。
5. **stacked rebase 用 `--onto old-parent-tip`**，直接 rebase 会重放旧父提交（冲突噪声）。
6. **复用优先**：record title=pickRecordTitle（TrashModal 同款）、diff 渲染=formatFieldDisplay（drawer 同款）、click-through=onNotificationNavigate/resolveDeepLink（通知中心同款）——三处全零新端点/零新文案。
7. 两个审阅代理均死于收尾 advisor pass（交付 MD 均先落盘无损）——**审阅代理规程：完整 MD 先写盘再进 advisor**。

## §5 剩余（诚实清单）

- 🧭 **O-2 operator flag 阶梯**：纯 owner 开关决策（前置全清，阶梯文档在 main）。
- 🔒 **#4004 D-2 ratify**：OD-1..OD-8 + §1.11 真值表（含 fail-closed 不对称）owner 逐项签核后才排 impl（hot-core：强模型+对抗审）。
- 🔒 owner 菜单既有项：restore 批次回链（需 revision schema 列+写路径穿线）、L2 field-value tombstone 地板、4c-3 锚精确化/响应形状、S1 快照、4d 不可能项。
- ⬜ 未做携带项：Playwright 密集时间线浏览器证据（T2 验收细则要求，历史欠账+本轮 FE 改动后更应补）；all-tables 模式非活动表字段元数据（id 回退如实保留）；历史任意 id 批量解析端点（gated）；TrashModal layer-2 标题播种观察项。

## §6 验证物索引

/tmp/pr4003-review-claude-20260709.md（APPROVE）· /tmp/pr4004-review-claude-20260709.md（APPROVE 0P1/0P2/4P3/2NIT）· /tmp/r9-stack-rereview-claude-20260710.md（六项 LAND/RATIFY 判定+突变复现日志）· /tmp/pr4025-review-claude-20260710.md（APPROVE 0P1/0P2，RB15 突变独立复现，comment-only diff 实证）· 审计 workflow journal（session artifacts wf_bc8e84d6-31d）。
