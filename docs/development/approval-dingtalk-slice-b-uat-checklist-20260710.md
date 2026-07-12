# 审批钉钉互动卡 Slice-B · 真实 Stream UAT 脚本与验收清单 — 2026-07-10

> 地位：锁 `approval-dingtalk-interactive-card-slice-b-design-lock-20260709.md` §6「UAT」条款的可执行交付物。
> **执行前提（owner 手上）**：真实钉钉企业 + Stream 应用凭据 + 互动卡模板 + 至少两个已绑定钉钉的本地账号（一个审批受理人 A、一个非受理人 B）。UAT 通过前 `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` 保持 OFF；UAT 在受控环境短时开启。
> 纪律：全程 values-free 记录（只记 reason/category/id 前缀，不记表单值/姓名快照）。

## 0. 环境准备

- [ ] `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=1` 仅在 UAT 环境设置；prod 保持缺省（OFF）。
- [ ] **`DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID=<Stream 应用所绑定企业的 directory_integrations.id>`**（P1-2 跨企业门，#4116 新增）。
      **未设置 = 互动卡一律不投放，全部回落 OA 工作通知**——这是 fail-closed 的正确行为，但会表现为「Stream 开了却永远收不到互动卡」。排查 U1 无卡时，**先查这个 env**。
- [ ] Stream 凭据/模板 id 按锁 §4 B-1 env 形状配置（或 per-corp config store，PR body 声明过的那种）。

### 0-a. 🚧 硬前置：真实回调帧的 corpId 字段形状（**flag ON 之前必须做完**）

P1-2 跨企业门（#4116）用「点击方企业」与「台账 `integration_id` 所属企业」比对，fail-closed。它按优先级读：
**(1) frame header `eventCorpId`**（SDK 类型化、网关填充，adapter 盖到 payload 上）→ **(2) body `corpId`**；两者都缺 ⇒ 判 `corp_mismatch` 拒绝。

**风险（#4116 对抗审阅 P3-2，未经真实帧验证）**：`dingtalk-stream@2.1.5` 的类型声明里 `eventCorpId` 只出现在 **EVENT 主题**的 header 组；**互动卡 callback 帧很可能根本不带这个 header**。若为真：
- 门会静默退化为只认 body `corpId`（不是「网关保证的权威锚点」，与设计意图不符）；
- **若真实 callback body 顶层也没有 `corpId`，则每一次点击都会 fail-closed → 卡片「点了没反应」（dead-on-arrival）。**

- [ ] **抓一帧真实的互动卡 callback frame**（worker 侧 values-free 落一条「字段是否存在」的日志即可，**切勿打印 corpId 值本身**），确认：
      - [ ] header 里是否有 `eventCorpId`？
      - [ ] body 顶层是否有 `corpId`？
- [ ] 依结果决定：两者皆无 ⇒ **不得开 flag**，先补一个真实可用的企业锚点（例如从 Stream 连接自身所绑定的 corp 推导），否则互动卡必然全数拒绝。
- [ ] 结论回填本文件，并同步到 `interactive-card-callback.ts` 的 `readCallbackCorpId` 注释（把「推测」改成「实测」）。
- [ ] 互动卡模板的「同意」按钮 action id **必须字面 `approve`**（B-3 review 指定的 UAT 必验项）；「驳回」按钮 = 签名 `/m/approval-decision` 深链（B-2 as-built：驳回必填意见走 Slice-A 页）。
- [ ] 确认 worker 状态从 `sdk_unwired` → 连接态（W2b adapter 接线后）；断网重连一次验证 backoff 日志 values-free。

## 1. 投放链（B-2 面）

| # | 步骤 | 期望 | 结果 |
|---|---|---|---|
| U1 | 触发 task_created（模板含互动卡完整配置） | 卡片送达受理人 A；台账 `delivery_kind='interactive_card'`，`send_status='sent'`，outTrackId=台账 id | ⬜ |
| U2 | 配置不完整（如缺模板 id）同场景 | 走 OA ActionCard 旧路；台账 `work_notice_action_card`；无报错 | ⬜ |
| U3 | 卡片正文检查 | 仅 标题/单号/节点/状态，**无表单值** | ⬜ |
| U3-a | **`IM_ROBOT` 大小写（#4118 已改）** | 送卡的 `cardTypeId` / spaceType 用 **大写 `IM_ROBOT`**（`dtv1.card//IM_ROBOT`）。旧文档写的小写 `im_robot` 是**未经真实 API 验证的猜测**，#4118 已按 sibling spaceType 的既有写法改成大写。UAT 必验：真实 API 接受大写形态、卡片正常送达。**若真实 API 反而只认小写，立刻回报——那说明大写这次也是猜的。** | ⬜ |

## 2. 回调链（B-3 面）

| # | 步骤 | 期望 | 结果 |
|---|---|---|---|
| U4 | 受理人 A 点「同意」 | 引擎记录 approve（web 端可见）；audit actor=A 的本地账号；台账回调结果 executed | ⬜ |
| U5 | A 重复点击（重复回调） | 幂等收敛：无第二次引擎写；卡面显示真实终态 | ⬜ |
| U6 | 非受理人 B 点「同意」（转发的卡） | 引擎 403 `APPROVAL_ASSIGNMENT_REQUIRED`；**无审批写入**；卡面「当前账号无权处理该审批」 | ⬜ |
| U7 | 未绑定钉钉的操作者点卡 | 无引擎调用；卡面「请先在网页端绑定钉钉后再处理」 | ⬜ |
| U8 | 点「驳回」 | 跳 Slice-A 决策页（深链），页面强制意见后驳回成功 | ⬜ |

## 3. 卡片终态（B-4 面）

| # | 步骤 | 期望 | 结果 |
|---|---|---|---|
| U9 | U4 成功后卡面 | `已由 <A 的服务端本地显示名> 同意 · <时间>`（显示名非钉钉 payload 回显） | ⬜ |
| U10 | 卡片更新 API 人为置失败（如临时错模板）后 A 同意 | **审批已提交不回滚**；日志 values-free 错误；再次点击经 stale summary 收敛出真实终态 | ⬜ |
| U11 | 伪造/过期 outTrackId 的回调（技术注入） | 卡面中性文案，与 operator-未解析场景**字节等同**（无存在性 oracle） | ⬜ |
| **U11-a** | **真实点击的企业来源（#4116 跨企业门实证）** | 一次**真实**的同意点击必须**通过**跨企业门（而不是被 `corp_mismatch` 拒掉）。这是 §0-a 的验收面：worker values-free 日志应显示门读到了企业锚点（header `eventCorpId` 或 body `corpId`）**且与台账 `integration_id` 所属企业一致**。**若真实点击被判 `corp_mismatch` ⇒ 说明真实帧根本不带任何 corp 字段 ⇒ 立刻停止 UAT、关 flag**（这正是 §0-a 预警的 dead-on-arrival）。 | ⬜ |
| **U11-b** | **过期卡（若已启用保留期清扫 #4142）** | 已被清扫成 `expired` 的卡再点击 ⇒ 不可操作、**零审批写入**，卡面走 stale 终态文案。（清扫默认 OFF；只有设了 `DINGTALK_DELIVERY_RETENTION_DAYS` 才需验这条，且**窗口须大于审批 SLA**，否则活卡会被过期。） | ⬜ |

## 4. 生命周期与运维（W2b 面）

| # | 步骤 | 期望 | 结果 |
|---|---|---|---|
| U12 | UAT 结束流程内 shutdown（含 init 进行中 shutdown 一次） | 无半开连接残留；worker 状态终态一致 | ⬜ |
| U13 | 关闭 flag 重启 | worker 不再连接；一切回 OA 路径；prod 缺省安全确认 | ⬜ |

## 5. 通过标准

U1-U13 全绿 = Slice-B 达锁 §6 UAT 门槛；此后 flag 转 ON 是独立的 owner 运维决定（锁 §7）。任何一项红 → 记 values-free 现象 + 归属刀（B-2/B-3/B-4/SDK）开修复位，flag 保持 OFF。
