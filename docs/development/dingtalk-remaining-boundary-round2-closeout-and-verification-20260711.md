# 钉钉同步业务线 · 第二轮「剩余边界」池 — 设计与验证记录（2026-07-10）

- Status: 第二轮目标池（owner /goal「这条线剩余边界=第二轮池，固定节奏、可并行、收官交设计+验证 MD」）的落地与验证台账。前置：`dingtalk-sync-integrated-roadmap-20260708.md`（§7/§8 设计源）、`dingtalk-backlog-pool-closeout-design-and-verification-20260710.md`（第一轮收官，13/13 实现 PR + 1 MD）。
- 纪律基线（与第一轮同）：每 PR 独立对抗 gate（非自审，Opus）→ P1/P2 修复 → 承重 mutation 重放 → 单窗武装串行落地；逐窗协议 = 对齐最新 main → 解组合冲突 → 重放/重核承重属性 → CI 全绿 → 才 arm。

## 1. 完成声明（owner 口径）

第二轮池的**自主可决层已排空**：5 个实现 PR 独立 gate 通过并 MERGED（R1 四 lane + R2 的 N+1 遥测 lane），本收官 MD 1 份。**1 个实现 PR（#4102 §7.6 投递关闭）首轮 gate 通过，但 owner 2026-07-11 逐条审阅判为 CHANGES-REQUESTED**（1 P1 + 2 P2 **代码级** + 平台管理员门，见 §6；「ship-ready」表述已撤销），续 HELD-FOR-OWNER 重做中。R3 Phase-3（§8.3/8.5/8.6）为**仅设计**产出，见 §7。**不声称「全部开发好了」**——剩余 = #4102 重做（1 P1+2 P2）+ owner 授权/org-scoped-RBAC 治理决策 + Phase-3 实现（gated）+ staging-gated 项（user/list 主源翻转）。

计数纪律：**5 实现 PR MERGED + 1 实现 PR HELD + 1 收官 MD**。docs 不计入实现票数。

## 2. 过程要事：Fable5 额度耗尽 → Opus 4.8 接管

本轮开发中 Fable5 额度耗尽，R1 三 gate + R2 双 impl lane 同时撞限额全死。按 owner 站令「fable5 不可用→opus4.8」，**全部 lane 与 gate 改用 Opus 4.8 重启**（adversarial-reviewer agent 本即 Opus，gate 零 Fable 依赖）。一个 impl lane（#4102）曾 mid-stream stall，从 transcript resume 续跑未丢 landscape。零功能损失。

## 3. 落地台账（merge SHA 逐票）

| PR | Lane | 内容 | Gate（Opus） | Merge |
|---|---|---|---|---|
| #4085 | R1-L2 test-send 显示 | admin test-send 区分 outcome_unknown（502 + "may still have been delivered"）vs 普通失败（400） | APPROVE（承重 mutation：区分逻辑失效→502 测试红） | `434ba8d58` |
| #4087 | R1-L1 scheduler 卫生 | 远期 cron delay 钳制（setTimeout >2^31-1）+ boot 无效 cron 遥测 + fire-time 显示名解析（杀闭包旧名） | APPROVE 无 P1/P2（3 mutation 红；钳制边界安全 16.7min headroom；boot sweep 逐行 fault-isolated） | `5e5673ab8` |
| #4088 | R1-L4 编排 harness | syncDirectoryIntegration 编排真库 harness（心跳生命周期/H02 admission+SAVEPOINT/OPS-01 deprovision 接线/reclaim 组合），12 测试零生产源改 | APPROVE（12/12：11 承重各被专属生产 mutation 变红，1 sentinel；两点接线真实 vitest.config:52+plugin-tests.yml:427） | `609035ac3` |
| #4090 | R1-L3 web guard | 把 #4046 Phase B web specs（approvalCardDecisionView + meta-person-delivery-viewer-migration）接入 required web-tests + #4069 手动同步 409 补测 | APPROVE-with-hardening（见 §5 血账 #1：暴露 Node-20-only 红 spec） | `dc2650081` |
| #4100 | R2-L6 N+1 ops 可见 | 把 directory-sync `user/get` N+1（每唯一用户一次 detail）做成 ops 可见：per-run 5 计数键折入 run stats JSONB，经既有 runs 路由零 UI 改动暴露 | APPROVE（行为中立 HOLD+去重诚实 HOLD；3 mutation 红；getDingTalkUserDetail 仍唯一字段源；去重非套套逻辑：U3 跨两部门→计数 4 非 5；5078 测试单元套全绿） | `29582328f` |
| #4102 | R2-L5 §7.6 投递关闭 | task_id 可查（partial index + findByTaskId 访问器，**降级为 trace foundation**）+ 运维手动重投 FAILED | **CHANGES-REQUESTED**（owner 2026-07-11：1 P1 + 2 P2，见 §6）→ 重做中 | — （unarmed OPEN） |

## 4. 设计裁决记录（doctrine 应用）

- **§7.6 重投遵守 send-once 教义**（[[retry-semantics-not-verbs]]）：手动重投只对**三谓词齐**的行（`status='failed' AND channel='dingtalk_work_notification' AND redelivery_safe=true`——owner 2026-07-11 P1 纠正：`status='failed'` 单谓词**不足**证可安全重投，表多通道共用 + 历史/非-DingTalk 模糊失败亦落 failed，故须持久化 `redelivery_safe` 由 worker 于 markFailed 明确写）；`outcome_unknown` 硬拒（可能已送达，绝不重发）；`sent`/`skipped` 无资格=去重 no-op；`source_key UNIQUE(org_id,source_key)` 保证原行翻转不插新行=恰一次发送；无后台/自动路径（worker claim 只取 pending/retrying/lease-expired-sending，绝不取 failed，经 worker-liveness 对照证非套套）。quiet-hours 不被绕过（重投只翻 DB 态，worker 整批 pre-claim 栅栏照旧作用）。
- **§7.7 N+1 转 ops 可见（不翻主源）**：instrument 而非改字段源。user/list 主源翻转按 roadmap「after staging verification」**保持 staging-gated + 默认关，本轮不翻**；`externalUserDetailCalls` 恰是未来翻转的 before/after 证据度量；canary `externalUserDetailCalls === accountsSynced` 为结构恒等（users.size 不被过滤/删改），已注释=翻转落地时放宽为 `<=`。batch-upsert/bcrypt-out-of-txn 结构增益因缠绕事务内 identity-match cascade **降级为设计-only**（PR body 记，未做）。
- **scheduler 为热共享文件**：#4087 timer 改动波及所有 cron 消费者（含 plugin scheduler），非仅 directory sync——gate 证对 <24.84 天的每个 cron 行为保持不变=安全；PR framing 已标为 scheduler-core 改动。
- **web guard = CI 可靠性即产品**：#4090 的 flushUi 修复以 macrotask 边界（非固定 cycle 数）把 undici body-read 排空做成 hop-count 无关=确定性；flush-until-condition poll 为 P3 硬化（未做，够 land）。

## 5. 验证方法与「本该失败却全绿」表（血账）

全线验收：**还原真正改行为的那一行 → 必须变红，且不能靠 fixture/env-stub/DI/Node 版本差遮蔽**。本轮新增遮蔽形态：

| # | 遮蔽形态 | 实例 | 修法 |
|---|---|---|---|
| 1 | **spec 在 CI 的 Node 版本下才红、dev 版本永绿**（apps/web CI-guard 缺口藏活红 spec） | #4090：`approvalCardDecisionView.spec.ts` 在 dev Node25 10/10 绿，CI Node20 隔离下红 5/10——`flushUi(6)` 在 Node20 欠排空 undici Response body（60-cycle 探针证组件运行时正确，非产品 bug） | 判因三桶：Bucket 2 spec-harness 漂移；改 flushUi 为 macrotask 排空（hop 无关）；独立 gate 在 Node20 复现旧 flushUi 红 5→证 product-bug 假设被驳 |
| 2 | 计数遥测与真实调用数可能悄悄漂移（套套逻辑风险） | #4100：`userDetailCalls` 若脱离 `if(!existing)` 去重分支则与真 mock 调用数漂移 | 单元 fixture 把 U3 放两部门→计数 pin 到独立 `vi.fn` 调用数（4 非 5 membership）；M3 去重突变→required 单元测试红 |
| 3 | send-capable 新路由的判据/授权/审计需 owner 定调（**owner 2026-07-11 判为代码级 CHANGES-REQUESTED，非仅设计裁决**） | #4102：owner 审出 1 P1（安全重投判据）+ 2 P2（operator trace / 语义审计）+ 平台管理员门；held，重做中 | 见 §6；工程细节私下交付，不在公开 doc 展开 |

**Gate 盲区再证**：#4102 首轮 gate 曾自判某修法「不可行」、自纠为「可行（既有先例）」——对抗 gate 亦会错，owner/主循环实态核对仍是最后一道门。#4090 gate 在 Node20 独立复现是「gate 必须在 CI 同版本下跑」的实证。

## 6. #4102 owner 决策项（高层，细节私下）

**2026-07-11 更正：先前「#4102 代码 ship-ready、仅待授权」表述已撤销。** owner 逐条审阅判为 **CHANGES-REQUESTED**——尚有 1 项 P1 + 2 项 P2 **代码级**修改，非仅设计裁决：
- **P1 安全重投判据**：`status='failed'` 单谓词**不足**证可安全重投（表多通道共用 + #4046 前 DingTalk 模糊结果与 WeCom/Email 失败均落 failed → 可能重复通知）；须加持久列 `redelivery_safe`（历史行默认 false，worker 于 markFailed 明确写），UPDATE 三谓词齐（`status='failed' AND channel='dingtalk_work_notification' AND redelivery_safe=true`）。
- **P2 operator trace**：`findByTaskId` 除测试无生产调用方 → 降级为 **trace foundation**，不宣称 §7.6 operator-trace acceptance；operator API/CLI 列 follow-up。
- **P2 语义审计**：扩展**既有** attendance 审计 middleware（非另写日志）加 `notification_redeliver` operation + deliveryId→resource_id + **values-free** org/channel/旧状态/结果，best-effort；补 supertest 路由级 400/403/409/200 + 授权 + 审计测试。

**owner 授权裁决**：`attendance:admin` 当前无法证 org-boundedness（`user_roles` 无 org_id）→ **过渡期仅平台管理员可调**此触发外发路由（复用既有 `ensurePlatformAdmin` 单一真源，不套 org-member 补丁）；org-scoped RBAC 列为**独立 P1 治理线**（org-scoped role binding + 服务端从资源派生 org + 全 attendance-admin/plugin 路由盘点）。另立 doctrine：**所有触发外发的 operator mutation 必须有语义审计**。

修完过 **exact-head re-gate（Node 20）** 后仍 **HOLD-FOR-OWNER，不自动 arm**（CHANGES-REQUESTED + 安全 + owner 不在 → 绿 gate ≠ 合并授权）。**续 unarmed。工程细节私下交付，不在公开 doc 展开。**

## 7. R3 Phase-3 设计（§8.3/8.5/8.6，仅设计——不实现）

> 原则声明：以下为 MetaSheet 目录/集成子系统自身的演进原则，非对标任何品牌。DingTalk 为当前具体 provider。

### 7.1 §8.3 凭据单一真源（Credential Single Source of Truth）
- **目标**：directory sync / OAuth / 工作通知 / 审批卡 四类配置统一到 integration config；环境变量降为 bootstrap fallback。
- **现状**：本线已在多处把 env 旋钮降为 default-off + 集成级配置优先（如 #4011 quiet-hours env v1、oauth shared-state env）。凭据仍散落 env + 集成表。
- **Phase-3 净新设计**：单一 `directory_integrations`（或 sibling 凭据表）承载四类 provider 凭据/端点/密钥；读取顺序 = 集成config → env bootstrap fallback → 缺失即 fail-closed；密钥列沿用已落地的 at-rest 加密 seam（第一轮 #3898 加密迁移）。迁移须覆盖 down()、活行先回填。**风险门**：凭据集中=更高价值目标，须与 field-layer 权限、审计三类读方对齐；不在本轮实现。

### 7.2 §8.5 考勤集成扩展（Attendance Integration Expansion）
- **目标（roadmap 列举）**：目录驱动的参与人扩展 / 定时或事件驱动的考勤拉取 / quiet hours / 收件人退订 / 每日通知上限 / CSV 导入时区+表头形状预警。
- **现状（已落地，非 Phase-3 净新）**：quiet-hours 全通道 pre-claim 栅栏（#4011）；CSV 导入 xlsx-guard + 模板/预警（第一轮外考勤线）。
- **Phase-3 净新设计**：①**目录驱动参与人扩展**——从 directory_accounts/links 解析考勤组成员，随 sync 增量增删（复用 OPS-01 deprovision 语义，tombstone 先行）；②**事件驱动考勤拉取**——从定时轮询升级为事件触发（须先有事件源 §8.1，依赖）；③**收件人退订**——per-user opt-out 表 + worker claim 前置过滤（与 quiet-hours 同层 pre-claim 栅栏）；④**每日通知上限**——per-user/per-org 日计数 + claim 前置软上限（best-effort，多副本共享须 Redis 级，标注）。**需求门**：②③④均须现场 use-case 立项（demand-gated），本轮仅设计。

### 7.3 §8.6 目录管理台现代化（Directory Admin Modernization）
- **目标**：拆分大 Directory Management SFC / i18n label helpers / run-diff 面板 / 临时密码 reveal 行为 / 集成 archive-delete 生命周期。
- **现状（已落地）**：run-diff/async-UI 面板（第一轮 #4069）；i18n label helpers（multitable i18n STRICT-ZERO 体系 + typed label modules）。
- **Phase-3 净新设计**：①**SFC 拆分**——把 Directory Management 大组件按视图切片（列表/详情/run-diff/凭据），沿用 UI-Foundation tokens 单一真源 + MtButton 迁移精选纪律；②**临时密码 reveal**——一次性初始密码的显隐/复制/审计（与 #4069 auto-admission 警示门一致：202 会丢，reveal 须 fail-safe 不持久化）；③**集成 archive/delete 生命周期**——软归档（停 sync 保数据）vs 硬删（级联 tombstone）两态 + 二次确认门；archive 态 scheduler 不再 arm 其 cron。**门**：③涉及删除顺序悬挂态（tombstone 先行）与 scheduler 生命周期，须与 lease/reclaim 语义对齐。

## 8. 诚实清单（未做/未证明/owner 决策）

- **HELD-FOR-OWNER**：#4102 **CHANGES-REQUESTED**（owner 2026-07-11，1 P1 + 2 P2 代码级 + 平台管理员门，见 §6）——首轮 gate 通过但**非 ship-ready**，重做中，续 unarmed。
- **未做（demand-gated / staging-gated）**：§8.5 事件驱动拉取/退订/日上限（现场立项）；§7.7 user/list 主源翻转（staging 验证字段完整性后 + 默认关 flag）；§7.7 batch-upsert/bcrypt-out-of-txn（缠事务内 identity-match，设计-only）；§8.3/8.6 Phase-3 实现（本轮仅设计）。
- **未证明**：#4102 attempt_count=0 重置允许特权操作者对永久失败发送手动循环（重置本身正确/必要，per gate PROBE 4）；#4102 无路由级测试、无 send-triggering mutation 审计日志（NIT，建议 owner 决策时一并加）；#4100 真库 stats-landing 证据仅在 plugin-tests.yml（非 required），与本线模型一致。
- **owner 决策项**：三 env 开关翻转（纯运维，不入池）；auth P3s（roadmap §11 owner 边界，不入池）；#4102 授权模型 + attendance-admin 面是否需 org 作用域（§6）。

## 9. 过程事实（组织学）

- 模型分工：本轮全 Opus 4.8（Fable 额度耗尽 fallback）；adversarial-reviewer(Opus) 跑全部 gate，general-purpose(Opus) 跑 impl lane。
- 单窗串行落地：#4085→#4087→#4088→#4090→#4100 逐个 arm+守窗；热 main 无 merge queue，test(20.x) 恒为慢 blocker（~8min），守窗器 8×60s 多次 relaunch 属常态非故障；每次落地 rebase 干净（scheduler/web/backend 文件未被 main 触碰）。
- #4102 stall→resume 保 landscape；advisor 在 #4102 决策前介入，纠正主循环「safe under both models」论证的一处未证前提，并给出「先跑代码可验证的判别读、再定 owner 边界」的方法；判别读结论把此项归入「surface 为 owner finding 非 quiet-patch」分支（细节私下）。
