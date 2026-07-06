# 审批操作面 UX · 桌面 parity 达标 — 设计与验证 MD（2026-07-06）

> `/goal`「剩余开发量作为总目标池，固定节奏开发，完成后给出设计及验证 MD」的收官交付。
> 对照 `docs/research/approval-automation-operation-ux-benchmark-20260704.md`（#3564 审计）
> 的 §7 收尾点，逐条核对达标状态。

## 1. 结论

**桌面 parity 达标线 = §7 P 切片 5/5 全部落 main。** 加上一键处理主链（Slice A，A-5 待你侧
env 实跑），审批操作面已从审计开局的「引擎强、体验弱」推到 **「桌面 parity + 一个真差异化」**。
此后不再堆通用面（军备竞赛是钉钉/飞书主场），转投 fusion（T3-6，见 §5）。

## 2. §7 P 切片（parity 必需）· 逐条达标

| P 项 | 交付 | 修复的「去掉就做不成」 |
|---|---|---|
| **B2-01** 列表关键字段摘要 | #3666 | 不点开就能决策（每单被迫进详情 → 摘要行） |
| **B2-08** 时间线当前处理人 + 后续节点 | #3667 | 「卡在谁那里 / 接下来到谁」（钉住冻结版本，条件分支诚实） |
| **B2-07** 提交前流程链 | #3675 | 「会到谁手上、几步」（`summarizeApprovalFlow` = DRY 包 `buildUpcomingNodes`） |
| **B2-15** 校验深度 | #3675 | 明细必填客户端校验 + change 触发 + scroll-to-error（脏数据不再死成不可读 400；派生列豁免防误阻） |
| **B2-13** 再次提交 | #3677 | 驳回→改→重提免手抄（`prefillFromSnapshot` drift guard：丢弃/改类型/附件跳过） |

## 3. 一并完成的正确性缺陷修复（审计头部）

| 缺陷 | 修复 |
|---|---|
| 发起人身份 mock（`isRequester === 'user_1'`）→ 生产撤回/催办不可见 | #3567 B1-01（同步种入真身份） |
| 自动化管理器「更新即关闭」 | #3566 B1-06 |
| 附件 File→`{}` 静默丢失 | #3640 B2-28（诚实禁用止血）；全管线 = gated B3-07 |
| **转交/加签/表单选人/委托 硬编码假人**（生产不可用） | #3664 B3-04 D-1 端点（rbacGuardAny read\|write\|act）+ #3672 D-2（真实选人器，假人清零，candidate≠授权兜底不弱化） |

## 4. 差异化：一键处理链（Slice A）

design-lock #3594 的 A-1..A-4-core 全落 main（#3610 + #3647）：`approval.task_created` 触发器 →
`send_dingtalk_approval_card` 动作（台账先行、values-free 深链）→ `/m/approval-decision` 决策页 +
card-delivery wrapper（token/ledger-only/channelOrigin 服务端注入/并发 tripwire）。
- **自动化验证闭合**：真库 17/17 + FE 9/9（见 `approval-dingtalk-one-tap-a5-verification-20260705.md`）
- **A-5 剩余唯一门**：owner env（DingTalk 三件套 + `APPROVAL_CARD_LINK_SECRET` + `PUBLIC_APP_URL`
  + linked 受理人，键已入 `.env.example` #3670）→ 按 A-5 §4 剧本 U1–U7 实跑 → PASS。**未跑前不写「已验收」。**
- **B-0（Slice B：互动卡片 + Stream）🔒**：A-5 PASS + owner opt-in 前锁死。

## 5. batch-2 管理面（P0 余项，一并落）

#3663：B2-03 发布前校验清单前置 · B2-04 看板模板名映射 + 日期快捷档 · B2-05 委托 4 态时间感知 + 停用确认。

## 6. 收尾点之后（菜单，非完成度分母）

- **战略大刀（owner-gated，待点名）**：**T3-6 approval projection per-row `visibility_scope` 继承**
  —— 让「审批结果是一张可被公式/视图/下一条自动化消费的表」对普通用户成立（当前 #3537 后 admin-only）。
  价值 > batch-2 剩余全部 G 项之和；独立 design-lock，不与已完成的 B3-04 候选人目录混合。
- **batch-2 G 项（锦上添花，空闲带宽点单）**：画布脊柱 B2-06、金额大写 B2-16、草稿自动保存 B2-14、
  自动化编辑器渐进披露 B2-22..27 等——按 §7 判据均「能做成只是更烦」，非 parity 必需。
- **batch-3 gated opt-in**：B3-05 动态审批人预览、B3-07 附件全管线、B3-10 自动化失败重试 等，
  各自 gate + 独立锁；服务 fusion 的优先。

## 7. 验证总览

- 每刀：Sonnet 代理实现（规格完整前端）→ Opus 审查 + 硬化 → rebase → PR → 串行冠军 lander 保落地
- 全部 PR：`vue-tsc -b` 0 + 焦点/守护 spec 绿 + 与 clean main 逐文件一致（预存 attendance/multitable 失败 stash 复验非本波引入）
- 合并机制教训：strict required-checks + 并行会话高频推进 main 下，**单冠军串行 lander（一次 rebase 一个 + 0-behind 即 admin-merge）远优于 N 路并行 auto-merge**（CI 抖动降 N 倍、真正收敛）；根治 = 仓库 merge queue 设置（owner 一次性）

——本波在固定节奏 + Sonnet/Opus 分工下，把审批操作面推至桌面 parity 达标，一键链主体上主干、待 env 验收。
