# 一键卡片配置进设置 UI（含「生成随机密钥」按钮）· DESIGN-LOCK（PROPOSED）— 2026-07-06

> **状态：PROPOSED，待 owner ratify。** 未 ratify 前不实现（staged-opt-in）。
> **committed 文档纪律**：陈述 MetaSheet 自身原则，不出现外部品牌名。
>
> **目标**：把一键处理卡片当前 env-only 的两个配置（`APPROVAL_CARD_LINK_SECRET` 签名密钥 +
> `PUBLIC_APP_URL` 深链 base）搬进既有集成设置页，让管理员**纯页面自助**（含一键生成随机密钥），
> 不再需要 SSH 改 `docker/app.env`——降低客户 onboarding 成本。

## 1. 需求门（demand gate，具名）

一键卡片（design-lock #3594，A-1..A-4-core 已落 main）读两个运行时值：
`APPROVAL_CARD_LINK_SECRET`（深链 HMAC 签名密钥，MetaSheet 自生成、非钉钉）与
`PUBLIC_APP_URL`/`APP_BASE_URL`（深链 base）。二者**目前只能改 `docker/app.env`**——对 ERP 客户
不友好（要 SSH + openssl）。**具名用例**：系统管理员在集成设置页点一下「生成随机密钥」+ 填对外地址，
即完成一键卡片上线配置。

## 2. 治理门（governance gate，全复用不新建）

**不新建任何密钥基建**——照搬现有 DingTalk 集成配置的完整链路：
- 存储：`directory_integrations.config`（JSONB），密钥字段经 **`security/encrypted-secrets`**
  （`normalizeStoredSecretValue` 写入加密 / `decryptStoredSecretValue` 读出解密）——与既有
  `appSecret`/`workNotificationAgentId` **同一加密路径**。
- 读取兜底：**env 优先、stored 解密兜底**——照 `readDingTalkMessageConfigFromRuntime` 的既有语义。
- UI：扩展 `DirectoryManagementView.vue` 既有集成表单（已有 appKey / Agent ID(password 不回显) /
  baseUrl / 测试 UserID + `...Configured` 状态 chip）。
- 守卫：沿用集成配置写入的既有 admin gate（仅系统管理员）。

## 3. 设计（三处改动，均为既有模式扩展）

### 3.1 存储 + 读取解析器（后端）
- `directory_integrations.config` 新增两键：
  - `approvalCardLinkSecret`（**加密**，经 `normalizeStoredSecretValue`——与 appSecret 同）
  - `approvalCardPublicAppUrl`（**明文**，非密钥）
- 新解析器（放 `work-notification-settings.ts` 旁或同族）：
  - `resolveApprovalCardLinkSecret()` = `process.env.APPROVAL_CARD_LINK_SECRET || decrypt(stored.approvalCardLinkSecret) || ''`
  - `resolveApprovalCardPublicAppUrl()` = 既有 `resolveAutomationAppBaseUrl()`（env）→ 无则 `stored.approvalCardPublicAppUrl`
- **改两处读点从 `process.env` 换成解析器**（当前 as-built）：
  - `automation-executor.ts` 的 `executeSendDingTalkApprovalCard`（发卡片时签名）
  - `services/ApprovalCardDeliveryAction.ts` 的 `verifyApprovalCardLinkToken`（决策页/回调验签）
  - **不变式**：两处必须解析出**同一** secret，否则签验不一致——由「env 优先、否则同一 stored 源」保证。
  - **fail-closed 不变**：解析为空 → 卡片动作 fail-closed 不发（现有行为，不削弱）。

### 3.2 「生成随机密钥」端点（后端，密钥永不出后端明文）
- `POST /api/.../integrations/:id/approval-card-secret:generate`（admin-gated，复用集成配置守卫）：
  - `crypto.randomBytes(32).toString('hex')` 生成 → `normalizeStoredSecretValue` 加密 → 写入 config
  - **返回 `{ configured: true }`，绝不回显密钥值**（照 Agent ID「不回显已保存值」纪律）
- **前端不生成密钥**（避免密钥在浏览器出现/传输）——只发「生成」意图，后端生成并保存。

### 3.3 UI（`DirectoryManagementView.vue` 扩展）
- **一键卡片密钥**：一个「生成随机密钥」按钮 + `approvalCardLinkSecretConfigured` 状态 chip
  （「密钥已生成」/「未生成」，镜像 `workNotificationAgentIdConfigured`）；**不显示明文**。
- **重新生成语义（必做交互）**：已配置时点「重新生成」→ 先 `ElMessageBox.confirm`
  「重新生成将使**已发出但未处理**的审批卡片链接失效，确定吗？」；首次生成无此提示。
- **对外地址**：`approvalCardPublicAppUrl` 普通 URL 输入框（占位说明「一键卡片深链的对外可达地址；
  留空则用部署 env」）。

## 4. 安全边界

- 密钥**加密存储**（encrypted-secrets），**读取只在后端解密**，**任何 API 响应不回显明文**。
- 生成/写入端点 **admin-gated**（既有集成配置守卫）。
- **旋转失效语义**明确告知（重新生成 → 在途卡片链接失效）——不静默。
- env 覆盖优先级不变（运维仍可用 env 强制，UI 值仅兜底）。
- values-free / 不碰审批业务数据（本刀只管配置）。

## 5. 验证计划（ratify 后实现时执行）

- 后端单测：解析器 env-优先/stored-兜底/空→fail-closed；生成端点返回不含明文、写入后 `configured=true`、
  加密往返（存加密、读解密一致）；签名/验签用**同一解析源**（发卡片签的 token 能被 wrapper 验过）。
- 真库集成：生成→发卡片→决策页验签闭环（复用 A-2b/A-4 既有测试骨架，secret 来源从 env 换成 stored）。
- 前端：生成按钮调端点 + chip 翻「已生成」+ **响应/DOM 不含明文密钥**（tripwire）；重新生成弹确认；URL 字段保存。
- 组合回归：#3594 一键链既有 17/17 在「secret 来自 stored」路径下仍绿。

## 6. Out of scope

- DingTalk appKey/appSecret/agentId 的 UI（**已存在**于 DirectoryManagementView，不重做）。
- Slice B（Stream/互动卡片）配置——A-5 PASS + opt-in 后另议。
- 多租户 per-workspace 密钥隔离——v1 沿用集成粒度，需要再评估。

## 7. Checklist（ratify 后解锁）

- ✅ **CFG-0** 本设计锁（PROPOSED）
- 🔒 **CFG-1** 解析器 + 两读点切换（env 优先、stored 加密兜底）+ 单测（含签验同源不变式）
- 🔒 **CFG-2** 生成端点（admin-gated、不回显）+ 真库闭环
- 🔒 **CFG-3** DirectoryManagementView 生成按钮 + chip + 重新生成确认 + URL 字段 + 不回显 tripwire

## 8. 与 A-5 的关系（排序，不冲突）

- **A-5 现在**：用 env 一行（`openssl rand -hex 32`）最快跑通 UAT、坐实差异化——**本切片不阻塞 A-5**。
- **本切片随后**：让配置从「SSH 改 app.env」变「页面点一下生成」，客户自助上线。二者叠加：先证明能用，再做自助。

---

**一句话**：`APPROVAL_CARD_LINK_SECRET` 是自生成密钥，正好适合「页面一键生成」；实现即复用现有
`encrypted-secrets` 加密存储 + `directory_integrations` 配置 + DirectoryManagementView 的 Agent-ID
不回显模式，是干净的既有模式扩展。**待 owner ratify 后按 CFG-1→CFG-3 实现。**
