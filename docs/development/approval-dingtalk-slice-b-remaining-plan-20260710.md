# 审批钉钉互动卡 Slice-B · 余下开发规划与排序 — 2026-07-10

> 锁：`approval-dingtalk-interactive-card-slice-b-design-lock-20260709.md`（RATIFIED；owner 2026-07-09「请继续」= B-1..B-4 按 RECOMMENDED 默认逐刀 reviewed slice 交付）。
> 已落：B-1 stream gate #3999 · B-2 投放链 #4058（对抗审 APPROVE，1 P2 待补）。
> 本文 = owner /goal「这条线余下开发」的池化排序。纪律：只陈述 MetaSheet 自身原则。

## 0. 池子边界

**in**：B-2 收尾（P2 负例 + 落地）→ B-3 callback adapter → B-4 卡片终态更新 → 真实 Stream SDK adapter → B-2 review P3 加固包 → UAT 脚本/清单（可交付物）→ 收尾 MD。
**out（硬门，不自动做）**：真实钉钉 Stream UAT 执行（要 owner env + 真实账号）；Stream flag 翻开（锁死：B-3/B-4+SDK+UAT 全过才可）；§7 任何 RECOMMENDED 默认的变更（product/security choice）。

## 1. 排序（依赖驱动，车道=文件独占）

| # | 刀 | 内容（锁条款） | 依赖 | 模型 | 状态 |
|---|---|---|---|---|---|
| T0 | B-2 收尾 | #4058 补 P2-1 负例（client.ts:863 顶层 success!==true 守卫钉死）→ 落地 | — | 主循环 | ⬜ |
| W1a | **B-3 callback adapter** | ratified 回调形（outTrackId/approve-only/operator id）；UUID 校验；非 approve 动作忽略+无启发映射；linked-user 解析；`executeApprovalActionFromCardDelivery(deliveryId,'approve',{kind:'dingtalk'})`；**no-raw-/actions 静态 tripwire**（Slice-A 同款）；mocked-Stream 测试 | T0 | Fable | ⬜ |
| W1b | P3 加固包 | shutdown×initialize 竞态测试 · executor 级 partial-config→OA 直测 · 单 corp env 边界文档点名（并行车道：纯测试+文档，文件不撞 W1a） | T0 | Sonnet | ⬜ |
| W2a | **B-4 卡片终态更新** | wrapper 结果→卡面映射表（同意/stale/未绑定/无权/校验错/更新失败不回滚）；display name 只取服务端本地用户；duplicate 收敛 via stale summary | W1a | Fable | ⬜ |
| W2b | **真实 Stream SDK adapter** | 接官方 Stream SDK（新依赖→pnpm-lock 同变更）；只接受 ratified 回调形；沿用 B-1/B-2 单飞+半开清理+sdk_unwired；flag 仍默认 OFF | W1a（共享 interactive-card-stream.ts → 与 W2a 串行落，构建可并行 worktree） | Fable | ⬜ |
| W3 | UAT 交付物 | UAT 脚本/清单（锁 §6 UAT 条款 + B-2 review 的 im_robot 形态必验项），values-free | W2a+W2b | Sonnet | ⬜ |
| W4 | 收尾 MD | 设计+验证 as-built（每刀 RED-before/mutation 证据 + 对抗审判定） | 全部 | 主循环 | ⬜ |

## 2. 节奏与纪律

- 每刀独立 reviewed slice：build（隔离 worktree，逐子项 commit+push）→ 独立对抗审（refute-first + mutation 复跑）→ 修 → champion 串行落（union 规则：勿复活 main 已删 token）。
- 安全红线（锁 §2/§5 继承）：callbacks 只经台账解析（payload instanceId 忽略）；values-free 日志/卡面；无 raw `/actions`；secrets 不入台账。
- W2b 新依赖须同 PR 更 `pnpm-lock.yaml`（CI --frozen-lockfile）。
- flag 默认 OFF 每刀都要有测试钉住；任何刀不得翻转。

## 3. 进度（as-built 回填，2026-07-10）
- ✅ T0 B-2 收尾（P2 负例原会话自补+本会话 mutation 复验；#4058 落地）
- ✅ W1a B-3（#4071；审 APPROVE 0P1/P2；**owner 硬门加固**：unpinned 台账 refuse outright `integration_unpinned`，SQL 无条件企业 pin）
- ✅ W1b P3 加固包（#4070；抓到真竞态→红测试入库）
- ✅ W2a B-4（#4078 landing；审 APPROVE；U7 文案裁决=锁表与 P3-H 同时满足；落地纪律=不复活 legacy resolver）
- ✅ W2b SDK adapter（#4079；审 APPROVE-with-fixes 双 P2 已修；竞态修复 un-skip 绿；供应链 PASS）
- ✅ W3 UAT 清单（`approval-dingtalk-slice-b-uat-checklist-20260710.md`，U1-U13）
- ✅ W4 收尾 MD（`approval-dingtalk-slice-b-closeout-verification-20260710.md`）
- 🔒 硬门未动：真实 Stream UAT 执行（owner env）；flag 转 ON（UAT 后独立 owner 决定）；§7 RECOMMENDED 默认变更
