# 审批钉钉一键处理 · A-5 设计与验证 MD — 2026-07-05

> design-lock `approval-dingtalk-one-tap-action-design-lock-20260705.md` 的 **A-5 验收档**。
> Slice A（A-1..A-4-core）实现已于 #3610（A-1）+ #3647（A-2a/A-2b/A-3+A-4-core）落地。
> 本 MD = 「已做什么 + 自动化验证结论 + 真钉钉 UAT 剧本 + 验收判据」。
> **2026-07-09 更新**：owner 侧 env 已就绪，并完成 Slice A 主链 UAT。§4.1 记录实跑证据；
> 本档从验收*计划*翻为验收*结论*。敏感深链 token、钉钉 userId、corpId、taskId 原值不写入本文。

## 1. As-built（三提交，锁 checklist A-1..A-4-core）

| 环节 | 落点 | 关键不变式 |
|---|---|---|
| **A-1** 台账 | `dingtalk_approval_card_deliveries`（#3610） | delivery→instance 唯一反查锚点；`card_state`(sent→acted/superseded/…) + `send_status`(pending/sent/failed) 状态机；`claimActed` 要求 `card_state='sent' AND send_status='sent'`（review P2） |
| **A-2a** 触发器 | `approval.task_created`（#3647·1） | 每受理人一事件；eventId 四元组 `instanceId:nodeKey:entryEpoch:assigneeUserId`；post-commit 发射 + is_active 复核；T2-6 dedup；save+fire 两腿权限复查；templateId-null out-of-contract |
| **A-2b** 卡片动作 | `send_dingtalk_approval_card`（#3647·2） | 收件人固定取事件 assignee（不可手填）；台账先行 → 成功补 task_id / 失败 send_error；未绑定→skipped 无卡片行不猜映射；深链 values-free（仅 deliveryId+HMAC，无 instanceId，卡片体无表单值） |
| **A-3** 决策页 | `/m/approval-decision` + `ApprovalCardDecisionView`（#3647·3） | 公开 shell；未登录直走 `/api/auth/dingtalk/launch?redirect=<深链>` + sessionStorage 防循环；驳回意见前置必填；stale/终态渲染真实态；禁直连 raw `/actions`（静态 tripwire） |
| **A-4-core** wrapper+端点 | `ApprovalCardDeliveryAction` + `/api/approval-card-deliveries/:id(/actions)`（#3647·3） | token 校验（timingSafeEqual + 无 secret fail-closed）；ledger-only 反查；dispatchAction 零旁路；channelOrigin 服务端注入（HTTP body 不可注入）；404 无存在性预言 / 409 stale / 引擎 4xx 透传 |

## 2. 自动化验证结论（已完成）

- **真库集成 17/17**（三文件，均两点 CI 接线，不 skip-green）：
  - `automation-approval-task-created-trigger.test.ts` 5/5（quad eventId / ledger dedup / replay no-op / transfer+add-sign+return 再轮 / acted 不复发 / templateId-null / visibility-flip fire-skip）
  - `automation-dingtalk-approval-card-action.test.ts` 5/5（placement 双闸 / 未绑定 skipped 无卡片行 / 台账先行 + task_id + values-free 深链 / 发送失败 send_error）
  - `approval-card-delivery-wrapper.db.test.ts` 7/7（token 纪律 / undelivered stale / approve+channel 落账+claim / reject 必填重试 / 非受理人引擎拒 / **并发 tripwire**：Promise.all 双 approve → 恰一 engine action + 恰一 channel metadata + 恰一 claim / 源码守卫）
- FE：`approvalCardDecisionView.spec.ts` 9/9（含未登录 auto-launch / 弹回手动按钮 / 已登录不 launch / 缺参本地失败 / 禁直连 tripwire）
- `tsc` 0 · `vue-tsc -b` 0 · 换底后 unit 全量 pass · 三迁移本地真库执行成功
- **CI-green SHA**：✅ 一键链主体 #3647 于 `b938bf617561bed9a56da40ec7ebb47054ba965b` 合入 main（A-1 #3610 先于其前）；上述 17/17 真库 + FE 9/9 均在该链的 CI 上通过。

## 3. Owner env 前置清单（UAT 实跑前配到验收环境）

| 变量 | 用途 | 备注 |
|---|---|---|
| `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` | 企业内部应用凭证（gettoken） | 测试用钉钉企业内部应用 |
| `DINGTALK_AGENT_ID` | asyncsend_v2 发送方 agent | 同上应用 |
| `APPROVAL_CARD_LINK_SECRET` | 深链 HMAC 签名密钥 | 随机 ≥32 字节；缺失则卡片动作 fail-closed（不发） |
| `PUBLIC_APP_URL`（或 `APP_BASE_URL`） | 深链 base | 指向验收环境的对外可达地址 |
| 一个**已做钉钉目录绑定**的测试受理人账号 | 卡片投递 + 免登映射 | `directory_account_links.link_status='linked'` |

**USE_MOCK 陷阱**（锁 §6）：前端 `USE_MOCK = import.meta.env.DEV`，本地 dev 走 mock 看不出真实链路——UAT **必须生产构建 + 真实后端**。

## 4. 真钉钉 UAT 剧本（owner 侧实跑，逐步勾选）

> 前置：§3 env 就绪 + 生产构建部署 + 一条含 `approval.task_created → send_dingtalk_approval_card`
> 规则的模板（自动化编辑器里新增，规则创建者持 `approvals:read` 且对该模板可见）。

- ⬜ **U1 发起**：以发起人提交该模板一单 → 受理人钉钉工作通知收到 **action_card**（标题=单据名、含「查看并处理」按钮）；台账新增一行 `card_state=sent, send_status=sent, task_id 非空`。
- ⬜ **U2 未登录免登**：受理人在钉钉容器内点按钮 → 未登录时**直接进入钉钉 OAuth**（不是普通 /login）→ 授权后回到决策页并展示单据摘要（标题/编号/节点）。
- ⬜ **U3 同意**：点「同意」→ 决策页显示已处理终态；后台 `approval_records` 出现一条 `action=approve, metadata.channel='dingtalk_card', cardDeliveryId=<台账id>`；台账该行 `card_state=acted`。
- ⬜ **U4 驳回必填**：另起一单，点「驳回」不填意见 → 确认键置灰 / 提交被引擎拒并框内提示；补意见后成功，records 记 reject + channel。
- ⬜ **U5 深链纪律**：检查按钮 URL 仅 `?d=<deliveryId>&t=<32hex>`，**不含 instanceId**；卡片正文不含任何表单字段值。
- ⬜ **U6 重复/失效**：已处理单据再点按钮 → 决策页渲染真实终态（不再可操作）；节点已流转（转办/新一轮）的旧卡片点开 → stale 提示。
- ⬜ **U7 未绑定**：以一个**未做钉钉绑定**的受理人跑 U1 → 无 action_card；台账**无**该受理人卡片行；`dingtalk_person_deliveries` 有一条 `status=skipped`（不猜映射）。
- ⬜ **U8 并发**（可选压测）：同一卡片快速双击 → 仅一次生效，`approval_records` 无双 approve。

## 4.1 2026-07-09 真钉钉 UAT 结果（PASS evidence）

**环境**

- Public URL: `https://demonstration-postings-nashville-premises.trycloudflare.com`
- Server IP: `23.254.236.11`
- Runtime image / health commit: `9ac55cba0cac8c0d2224a5f46ec6564bf6864d15`
- Health observed at: `2026-07-09T13:09:58Z`
- Runtime: production build, real backend, real DingTalk work-notification app channel; DB/Redis/plugins healthy.

**Config evidence**

- DingTalk directory integration existed and the work-notification Agent ID was saved through the settings UI.
- A stored one-tap card secret was generated through the settings UI; no secret value is recorded here.
- `PUBLIC_APP_URL` / `APP_BASE_URL` pointed at the public Cloudflare URL above.
- Staging-only RBAC bootstrap was applied for the two linked test users:
  - rule creator: `approvals:read`
  - card actors: `approvals:act`
  This was necessary because the save/fire gates trust DB permissions, and the card delivery action endpoint requires `approvals:act`.

**Run A — endpoint-path guard run, linked Li test account**

- Request: `AP-100043`, title `A5 钉钉一键审批 UAT 20260709131825`
- Delivery: `d9b18cb2-47fc-41f0-9f2f-7880c1145148`
- U1/send: card delivery reached `card_state='sent', send_status='sent'`; DingTalk API returned a task id (not recorded).
- U2/summary: `GET /api/approval-card-deliveries/:id` returned the decision summary with `viewerIsRecipient=true` and `actionable=true`.
- U4 guard: reject without comment returned `REJECT_COMMENT_REQUIRED`; the delivery was not claimed.
- U3 action: approve through the card-delivery endpoint returned success.
- U6 duplicate: a second approve returned `409 APPROVAL_CARD_DELIVERY_STALE` and the true terminal state.
- DB terminal evidence: instance approved; delivery became `card_state='acted', send_status='sent', acted_action='approve'`; the approval record metadata included `channel='dingtalk_card'` and the delivery id.

**Run B — in-app browser live decision-page run, linked zhouhua test account**

- Request: `AP-100044`, title `A5 钉钉一键审批 zhouhua 20260709133030`
- Delivery: `d98b83e3-9d36-4fcc-bd1d-a18049cb63b9`
- U1/send: card delivery reached `card_state='sent', send_status='sent'`; DingTalk API returned a task id (not recorded).
- U5 deep-link discipline: page was opened with the expected shape `...?d=<deliveryId>&t=<32hex>`. The token value is intentionally omitted from this document; no instance id or form value appeared in the URL.
- U2/page summary: the decision page rendered title, request number, node key, comment box, approve button, reject button, and the reject-required hint.
- U3 live approve: owner authorized clicking `同意` in the Codex in-app browser. The page changed to terminal copy: `该待办已处理（同意）。`
- DB terminal evidence: instance `AP-100044` became `approved`; delivery became `card_state='acted', send_status='sent', acted_action='approve'`; the approval record metadata included `channel='dingtalk_card'`, the delivery id, `nodeEntryEpoch=1`, and `aggregateComplete=true`.

**Coverage split**

- Live UAT covered the production send path, real DingTalk API acceptance, values-free deep-link shape, decision page rendering, approve action, ledger claim, channel metadata injection, and duplicate/stale behavior.
- Negative paths that were not repeated as a manual mobile click in this run remain covered by the §2 automated suites: unbound-user skip, token discipline, undelivered stale, reject-comment retry, non-recipient engine rejection, and concurrent double-click.
- Operator evidence should keep the two UAT records until this closeout is accepted. Optional cleanup can remove the dedicated UAT bases/sheets afterward.

## 5. 验收判据（PASS 定义）

**PASS** = §2 自动化验证全绿 + §4.1 live UAT 主链通过 + 负向门有自动化/端点证据。2026-07-09 已满足。
若后续要求“每个负向项均在钉钉容器里人工点一遍”，可按 §4 继续补跑；那是更强验收，不再阻塞 Slice B design-lock。
任一 U 项偏差即 **HOLD**，记录现象 → 定位（台账状态 / 免登 redirect / channel 注入 / 引擎门）→ 修复后重跑该项。

## 6. A-5 之后

- **A-6**（可选增强）：钉钉容器内 JSAPI `requestAuthCode` 静默免登（当前 A-3 用 redirect launch，已可用；A-6 只是省一次授权点击）。
- **B-0..B-4**（Slice B）：互动卡片 + Stream 回调 + 原地终态。A-5 PASS 门已满足；runtime 仍需 owner 对 B-0 design-lock 单独 ratify 后再开。
