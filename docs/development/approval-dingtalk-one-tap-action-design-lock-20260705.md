# 审批钉钉消息一键处理（one-tap action）· DESIGN-LOCK — 2026-07-05

> **目标**：自动化发出的钉钉审批通知，从「打开链接 → 登录 → 详情页 → 找按钮 → 同意 → 意见 → 确认」
> 的跨端多步，压缩到钉钉内 1-2 步完成处理。两个切片分层推进，各自独立 gated opt-in：
> **Slice A**（第一刀）= `action_card` 工作通知 + 免登极简决策页；
> **Slice B**（最终形态）= 互动卡片 + Stream 模式回调 + 卡片原地终态更新。
>
> 本锁经 owner 审阅定稿（2026-07-05），吸收三处承重修正（§2）。执行顺序：A 全绿并验收后，
> B 才解锁（独立 opt-in，见 §8 checklist）。

## 1. 已有地基（复用面，均已核实）

| 资产 | 锚点 | 复用方式 |
|---|---|---|
| 企业内部应用工作通知通道 | `integrations/dingtalk/client.ts:644` `corpconversation/asyncsend_v2`（现发 `msgtype:'markdown'`） | 同一 app 凭证升级 `action_card` / 互动卡片 |
| 钉钉身份 ↔ 本地用户映射 | `auth/dingtalk-oauth.ts:397` + `user_external_identities` + `user_external_auth_grants` | 回调点击者 → 本地 user 的唯一合法路径 |
| OAuth 登录/绑定跳转流 | `/api/auth/dingtalk/launch?intent=bind&redirect=…`（先例：`PublicMultitableFormView.vue:284/314`） | Slice A 决策页的登录/绑定路径 |
| 统一动作端点 | `routes/approvals.ts:1561` `/api/approvals/:id/actions`（受理人校验 / reject comment 必填 / nodeEntryEpoch 轮次隔离全在服务端） | 唯一执行面；卡片只是它的又一个前端 |
| 签名入站纪律 | `automation-inbound-webhook.ts`（HMAC + 重放窗 + 限流 + secret 脱敏） | B 若走 HTTP 回调时的纪律基线（首选 Stream，见 §5） |

## 2. 承重修正（owner 审阅结论，实现必须遵守）

1. **【P1】既有投递台账不能当审批回调锚点。** `dingtalk_person_deliveries` / `dingtalk_group_deliveries`
   只有 delivery id / recipient / subject / rule / record 等通知字段（migration
   `zzzz20260419214000:5`），没有 `approval_instance_id`、`action_kind`、`out_track_id`、
   `task_id` / card instance id。**新增专用台账 `dingtalk_approval_card_deliveries`**（§3），
   回调**只能**经台账反查实例；payload 携带的任何 instanceId 一律忽略。
2. **【P2】「H5 免登 requestAuthCode 已有」不成立。** 现有前端是 OAuth redirect callback
   （`DingTalkAuthCallbackView.vue:132`），无 JSAPI `requestAuthCode`。Slice A 的准确表述：
   **复用后端 code exchange / identity mapping，登录用现有 `/api/auth/dingtalk/launch` redirect 流**
   （含 `intent=bind` 补绑定）；钉钉容器内 JSAPI 静默免登是 A 的**后续增强**（A-6，新前端逻辑），
   不是前提。
3. **【P2】`metadata.channel='dingtalk_card'` 不是现成能力。** 统一 actions route 不接收 metadata，
   `ApprovalProductService.insertApprovalRecord`（`:5747`）无 platform/channel 参数。
   **channel 由服务端内部 wrapper 注入**（§4）：wrapper 在调用内部动作路径时把
   `channel` + `cardDeliveryId` 写入 `approval_records.metadata`（该 jsonb 列已存在）；
   HTTP route 继续**不**接收 metadata，回调 payload 更不允许自带。

## 3. 专用台账 `dingtalk_approval_card_deliveries`（A/B 共用，A 先建）

一行 = 一次「可操作审批卡片」投递。**不**扩展既有 person/group deliveries（它们服务通用通知，
生命周期语义不同，混用会污染两边）。

| 列 | 语义 |
|---|---|
| `id` (uuid, PK) | 台账主键；**Slice B 投放互动卡片时即 `outTrackId`** |
| `instance_id` | 审批实例（FK approval_instances） |
| `node_key` | 投递时的目标节点（回调时用于陈旧性判断） |
| `recipient_user_id` / `recipient_dingtalk_user_id` | 本地受理人 / 钉钉侧 userId（发送时解析） |
| `delivery_kind` | `work_notice_action_card`（A）/ `interactive_card`（B） |
| `task_id` | `asyncsend_v2` 返回的 task_id（A 的发送凭据） |
| `card_state` | `sent` → `acted` / `superseded`（节点已过/实例终态）/ `expired` / `revoked` |
| `acted_action` / `acted_by` / `acted_at` | 终态审计（与 approval_records 互证） |

**锚定规则（不可协商）**：回调/落地页解析顺序 = `outTrackId`（或深链 token）→ 台账行 →
`instance_id`。**payload 里的 instanceId / sheet / 金额 / 任何业务数据一律不读**（values-free、
find-then-patch 同族纪律）。台账行不存在或 `card_state != 'sent'` → 拒绝并（B）把卡片刷新为
当前真实状态。

## 4. 统一执行面：服务端内部 wrapper

新增内部函数（非公开 HTTP 面）
`executeApprovalActionFromCardDelivery(deliveryId, decision, actor, comment?)` ——
**两个前端共用**：Slice A 的 card-delivery 动作端点（§5，`actor = { kind:'session', userId }`，
会话内已认证的本地用户）与 Slice B 的 Stream 回调（`actor = { kind:'dingtalk', dingtalkUserId }`，
平台已验证的点击者）。

1. 台账反查 → `instance_id` + 期望受理人 + `card_state` 校验（非 `sent` → 拒绝并返回真实状态）；
2. actor 解析：session 路径直接用本地 user；dingtalk 路径经
   `user_external_identities` 映射 → 本地 user，**未绑定 → fail-closed**
   （A：落地页引导 `intent=bind`；B：卡片回「请先在网页端绑定钉钉」）；
3. 调用与 `/api/approvals/:id/actions` 同一条内部动作路径 —— 受理人校验、reject comment 必填、
   nodeEntryEpoch、版本冲突**原样生效，零旁路**；
4. 注入 `approval_records.metadata = { channel: 'dingtalk_card', cardDeliveryId }`（服务端注入，
   见 §2-3）；
5. 成功 → 台账 `card_state='acted'`；冲突/已处理 → 台账刷新为真实状态，返回结构化结果供
   卡片/页面渲染。

## 5. 两个切片

### Slice A — `action_card` + 免登极简决策页（第一刀）

- **发**：`asyncsend_v2` 的 msg 升级为 `action_card`（单按钮「查看并处理」；`action_card` 按钮仅支持
  URL 跳转）。深链 = `/m/approval-decision?d=<deliveryId>&t=<签名短token>`（URL 不含 instanceId、
  不含任何表单值）。发送成功即写台账（§3）。
- **登录**：未登录 → 现有 `/api/auth/dingtalk/launch?redirect=<决策页>` redirect 流；已登录直达。
  未绑定钉钉 → `intent=bind` 流（先例 PublicMultitableFormView）。
- **决策页**（新，移动优先，动作集 = 同意/拒绝/意见 —— 在既有移动动作集边界内，不触碰其扩展议题）：
  单据摘要（标题 + 前 3 个关键表单字段）+ 同意 / 拒绝（意见按 `policy.rejectCommentRequired`
  必填前置）→ **提交到新的 card-delivery 动作端点**
  `POST /api/approval-card-deliveries/:deliveryId/actions`（会话鉴权，body 仅
  `{ decision, comment? }`）。该端点内部调用 `executeApprovalActionFromCardDelivery`（§4），
  wrapper 再复用与 `/actions` 完全相同的服务端动作路径。
  **移动决策页不得直接调用 raw `/api/approvals/:id/actions`** —— 直连会绕开台账
  `card_state` 回写与 `cardDeliveryId` metadata 注入（本条即为封死该歧义路径的硬性规则）。
- **A 的界限**：工作通知卡片**不可**原地更新 → 防重靠台账 + 引擎冲突语义；页面对已处理单据
  显示真实终态。
- **A-6（后续增强，非前提）**：钉钉容器内 JSAPI `requestAuthCode` 静默免登，复用后端 exchange。

### Slice B — 互动卡片 + Stream 回调 + 原地终态（最终形态，A 验收后独立 opt-in）

- **发**：互动卡片（开放平台注册卡片模板），`outTrackId` = 台账 id；按钮 = 同意（1-tap）/
  拒绝（跳 A 决策页 —— 拒绝意见必填，不赌卡片输入组件）。
- **收**：**Stream 模式 worker**（官方 SDK，服务端主动长连；无公网入站、无 IP 白名单、无自建验签），
  对自部署/内网客户是决定性运维优势。**运维边界**：worker 按 env 配置门禁注册
  （未配置 = 不注册、零告警噪音 —— 沿用可选通知通道 env-gate 纪律）；断线重连由 SDK 负责；
  消费幂等靠台账状态机（§3）。
- **执行**：回调 →（仅取 outTrackId + decision + 平台已验证的点击者 userId）→ §4 wrapper。
- **闭环**：wrapper 结果 → **原地更新卡片**为终态（「✅ 已由 张三 同意 · 12:03」）；重复点击 /
  并发回调 → 引擎冲突 → 卡片刷新为当前真实状态。所有会话成员看到同一张已完结卡片。

## 6. 治理红线（对齐仓内既有纪律）

- **不可信通道**：回调/深链只携带 `(deliveryId|outTrackId, decision)`；一切业务数据服务端反查。
- **身份 fail-closed**：只认平台验证的 dingtalk userId → 本地映射；无映射不猜、不建。
- **零旁路**：卡片/页面全部经 card-delivery 端点 → wrapper → 统一动作路径；移动决策页与回调
  一律**不得**直连 raw `/api/approvals/:id/actions`；服务端门控（受理人/意见必填/轮次隔离）无一豁免。
- **审计**：`approval_records.metadata.channel` + `cardDeliveryId`，渠道可追溯、与台账互证。
- **env-gate**：Stream worker 与卡片发送均按 env 配置注册，缺配置 = 静默不启用。
- **UAT 纪律**：前端 `USE_MOCK = import.meta.env.DEV` —— 本地 dev 看不出真实链路，
  **验收必须用生产构建 + 真实钉钉应用**。

## 7. Out of scope（显式不做）

- 飞书/企业微信卡片适配（台账 + wrapper 的形状保持 channel-agnostic，但不预建）。
- 卡片内输入组件收集驳回意见（跳页解决）。
- 机器人关键词回复（「同意」对话式操作）——不做主路径。
- 移动动作集扩展（既有边界不变；本锁动作集 = 同意/拒绝/意见，在边界内）。
- 群会话内的审批卡片（本锁仅单聊工作通知/互动卡片；群投递按需另立）。

## 8. Gated TODO checklist

- ✅ **A-0** 本 design-lock 评审定稿（owner 三处承重修正已吸收）
- ✅ **A-1** 台账迁移 + 模型（#3610）（`dingtalk_approval_card_deliveries`，含状态机约束与索引）
- ✅ **A-2** `action_card` 发送路径（#3647） + 深链 token + 写台账（automation 动作配置沿用既有
  meta-automation 编辑面，新增「审批卡片」投递形态）
- ✅ **A-3** 移动极简决策页（#3647） + `/launch` 登录/绑定接入（含未绑定 fail-closed 引导）
- ✅ **A-4** card-delivery 动作端点（#3647） `POST /api/approval-card-deliveries/:deliveryId/actions` +
  channel 注入 wrapper（§4）+ 台账状态回写（raw `/actions` 直连禁令的 tripwire 测试随此项落）
- 🟡 **A-5** 验证：CI 可测部分已收口（#3665/#3669：单测/台账状态机/wrapper fail-closed 矩阵/伪造
  instanceId tripwire 全绿；配置面已页面自助化 #3690/#3693/#3698/#3707）；**真钉钉 UAT 仍 ⬜ =
  owner 实跑（跑通前不写「已验收」）**
- ⬜ **A-6**（增强，可后置）钉钉容器内 JSAPI 免登
- 🔒 **B-0** Slice B opt-in gate（A-5 验收 + owner 点名解锁）
- 🔒 **B-1** Stream worker 基建（env-gate 注册 / 重连 / 消费幂等）
- 🔒 **B-2** 互动卡片模板注册 + 投放（outTrackId=台账 id）
- 🔒 **B-3** 回调 → wrapper → 卡片原地终态更新（含冲突刷新真实状态）
- 🔒 **B-4** 并发/重放/陈旧节点矩阵测试 + 生产构建真钉钉 UAT

> **as-built 对账（2026-07-07）**：A-1..A-4 于 #3610/#3647 落地时未同步翻转本清单（收官口径纪律漏扫），随本对账 PR 补翻。
