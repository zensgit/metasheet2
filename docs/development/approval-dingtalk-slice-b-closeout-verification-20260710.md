# 审批钉钉互动卡 Slice-B · 余量池设计与验证收尾 — 2026-07-10

> 计划：`approval-dingtalk-slice-b-remaining-plan-20260710.md`。锁：`approval-dingtalk-interactive-card-slice-b-design-lock-20260709.md`（RATIFIED）。UAT 交付物：`approval-dingtalk-slice-b-uat-checklist-20260710.md`（U1-U13）。
> 纪律：只陈述 MetaSheet 自身原则。**Stream flag 全程默认 OFF，每刀有测试钉死；本文不含任何「已过 UAT」声明。**

## 1. 落地台账（全部 squash-merge）

| PR | 刀 | 一句话 as-built |
|---|---|---|
| #4058 | B-2 投放链 | 完整配置才走互动卡（否则 OA ActionCard 原路）；outTrackId=台账 id；createAndDeliver 契约 + HTTP-200 业务失败 fail-closed；B-1 三尾（单飞/半开清理/sdk_unwired）收拢 |
| #4071 | B-3 回调 adapter | ratified 三元组 only；UUID 门→台账-only 解析→**企业 pin 身份映射**→A-4 wrapper 单一执行路径（同源 token 穿线）；approve-only；no-raw-/actions tripwire；flag OFF 钉死 |
| #4070 | B-2 P3 加固包 | 执行器级 partial-config→OA 直测（mutation 判别）；shutdown×init 竞态红测试（当时 skipped，SDK 刀修复后 un-skip）；单 corp env 边界文档 |
| #4078 | B-4 卡片终态 | 结果→卡面映射表全行落地；**不回滚不变量结构化**（builder 入 try）；无存在性 oracle（delivery_not_found 与全部 operator_unresolved 字节等同）；display name 只取服务端本地用户；落地中适配 #4046 transport seam（update = 'send' 档：幂等覆写但歧义不自动重发，丢更新走 stale-summary 收敛） |
| #4079 | Stream SDK adapter | 官方 `dingtalk-stream@^2.1.5` 接线；只订卡片回调 topic；**竞态修复**（shutdownRequested latch 每 await 后复查）；close() 清凭据杀已排程重连；ack-before-dispatch（at-most-once，蓄意，测试钉死） |

## 2. 审阅判定（每刀独立 adversarial-reviewer，refute-first + mutation 复跑）

- **B-2 #4058**：APPROVE（1 P2 = 顶层 success!==true 守卫未测 → 原会话自补负例，本会话独立 mutation 复验判别）。
- **B-3 #4071**：APPROVE（0 P1/P2）。headline「token 重签稀释安全语义」被实证**反驳**：A-4 token 只绑 delivery id（无收件人/期限绑定），引擎受理人门独立生效——真库非受理人测试带有效自签 token 仍 403 `APPROVAL_ASSIGNMENT_REQUIRED` 零写入。P3-1（不可读 wire content + 显式 approve 绕过双拼写一致门）已修：`null`（不可读）≠`[]`（无意见），fail-close。
- **B-4 #4078**：APPROVE。**裁决①（定 UAT U7）**：中性文案本就是锁的「请先在网页端绑定钉钉后再处理」——锁表与 P3-H 同时满足；oracle 在此面不可达（Stream 无公网喷洒入口、卡面只对持卡人渲染、不转发、hook 不回传结果），字节等同留作免费纵深。**裁决②**：`ignored_unsupported_action` 静默跳过合规且更安全（该 outTrackId 未经台账验证，发更新可能污染在途卡面）；驳回按钮是 URL 动作无回调，无正当路径被静音。P2=落地纪律（见 §3）；P3-1/P3-2 已修。
- **SDK #4079**：APPROVE-with-fixes（双 P2 均已修，见 §4）。**供应链 PASS**：`opendingtalk` 官方包（open-dingtalk/dingtalk-stream-sdk-nodejs，85.8k 周下载，2.1.5 活跃维护，锁文件 integrity 与 registry 一致，全链无 install hooks）。**ack 语义**：ack-before-dispatch = at-most-once，蓄意（慢执行器会引发 ~60s 系统性重投）；崩溃窗丢的是一次点击而非动作（台账行仍可操作、卡面未终态、重复点击经 B-3 幂等收敛）；两个 ack 重排 mutation 皆红。

审阅 MD 存档：`/tmp/pr4058-review-claude-20260710.md` · `/tmp/b3-callback-review-claude-20260710.md` · `/tmp/w2a-b4-review-claude-20260710.md` · `/tmp/w2b-sdk-review-claude-20260710.md`。

## 3. Owner 硬门（2026-07-10）：跨企业身份碰撞面关闭

Owner 指令：**点击者映射必须由台账 integration_id 限定同一钉钉企业，不能只按 DingTalk userId 全局查找**。直查发现主路径已 pin（mutation 证明），但谓词带 `($2 IS NULL OR integration_id=$2)`——**unpinned 台账行退化为全局查找**，正是被禁形态（异企业同名 userId 全局唯一时可错配；歧义拒绝只兜非唯一碰撞）。修复：unpinned 行 refuse outright（`integration_unpinned`，查找前拒绝）；SQL 无条件 pin；测试禁止 `IS NULL OR` 臂回潮；不可达 legacy secret 分支删除（类型收窄）；真库 DT-R2 断言升级为 refuse-outright。**B-4 落地纪律（review P2）**：rebase 冲突侧带着已废弃的 legacy resolver——按 review 验证的终态解（owner-gate 侧 + B-4 返回形），落地后 0 legacy 引用。

## 4. 竞态与生命周期（W1b 发现 → SDK 刀修复 → review 再加固）

- W1b 实证 shutdown×in-flight-initialize 是**真竞态**（shutdown 在 client null 时早退→晚到的 init 激活本应死掉的 worker），红测试入库（当时 skipped）。
- SDK 刀修复：`shutdownRequested` latch 每个 await 后复查 + `closeAbortedStartClient` 收尾同形；un-skip 转绿；latch mutation → 恰 3 红。
- Review P2-1（跑真 SDK dist 实证）：翻 autoReconnect 挡不住**已排程**的重连 timer（门只在 schedule 时检查，_connect 重置 user-disconnect latch）→ close() 追加清空凭据，复活的 connect() 死在 endpoint 解析且不再排程；测试钉死。
- Review P2-2：SDK 的 connect() 错配也 resolve 并内部无限重试 → `active` 语义诚实化为「运行中，连接生命周期委托 SDK」，真连接性为 UAT 项（U12/U13）。

## 5. 验证数字（各自分支落地 tip）

tsc 全程 0。B-2：单测 17（+P2 负例）+ 真库 10/10 + OA-branch golden 精确红。B-3：单测 27+stream 14 + 真库 11/11（两点接线 vitest.config+plugin-tests.yml）；mutation 13 项（builder 7 + reviewer 6 独立复跑 + owner-gate/P3-1 后补）全判别。W1b：355f/4808（1 skip=蓄意红测试）+ 真库 11/11。B-4：套件 76/76 + 全量 362f/4974；mutation 5（P3-H×2/no-rollback×2/值泄漏×6 断言/fail-closed 弱化/skip neuter×2）。SDK：29/29（竞态 un-skip 绿）+ 全量 364f/4962 + frozen-lockfile 证明 + mutation M1-M6。

## 6. 剩余（诚实边界）

- **UAT = owner gate**：真实钉钉 Stream UAT（U1-U13，需真企业/凭据/模板/双绑定账号）未执行；**flag 转 ON 是 UAT 全绿后的独立 owner 运维决定（锁 §7）**。UAT 必验项：卡片模板同意按钮 action id 字面 `approve`（B-3）、`im_robot` 小写请求形态（B-2）、真实连接性（P2-2 语义下 active≠connected）。
- **Spare-bandwidth 菜单（非缺陷掩盖）**：W2a P3-3（inactive/ambiguous 共用 bind-first 文案略误导，可拆 SYSTEM_UNAVAILABLE——owner's call）+ NIT（Asia/Shanghai 硬编码格式化，已文档）；W2b P3/NIT（mirror race probe-verified fail-safe / sdk_unwired 字面量比较 / SDK console 噪声绕过 Logger / abortInFlightInitialize 报 env_disabled）。
- B-2 review 遗留 UAT 项与 B-1 review 尾巴均已在各刀或 UAT 清单归位。

## 7. 过程记录

会话限额两次打断 W2 双建——per-sub-step commit+push + 主循环接管收尾（W2a hook 重构收尾 + W2b 全套 mutation/验证由主循环补完）双双零损失。落地 treadmill 与并行车队竞窗如批三轮所记，nudge+arm 收敛。lifecycle 测试文件 W1b（skipped）↔SDK（un-skipped）对撞由 rebase 的 already-upstream 丢弃自动收敛，un-skipped 胜出如纪律预设。
