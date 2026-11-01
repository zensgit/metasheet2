# Automation A：手动只读请求的关联重试决策（SA06AI）

状态：本地已实现并取得专用PG及完整112项合成实链证据，非发布就绪；T 层 Ratified-by-default-2026-10-02。依据目标文件 §58 的 Automation A 授权及只读端口决策 §4 第3项。本决策不授权真实客户读取、发送、发布、合并或部署。验证范围、首败及未通过检查见CodeWT的`automation-integration-read-primitives-verification-20261001.md` §41。

## 1. 范围与语义

只接手动只读请求（`manual`、授权 purpose 为 `standalone` 或 `retry`）。父请求必须已处于 `blocked/failed/cancelled/outcome_unknown`；queued、running、succeeded 均不接受。自动 record/schedule 请求另需事件与条件语义，不得通过这里升级成手动权限。

用户明确确认“之前的读取可能已经发生；取消不证明远端已经停止；本次会再次读取并消耗新预算”。创建一份 purpose=`retry`、单项目、仅 manual、maxExecutions=1 的新授权及一个新请求。旧状态、旧次数、旧预算均不改写、不退款、不复用。普通 submit 仍只接受 standalone 授权。

每个父请求一生最多一个子尝试；再次失败时沿子尝试继续。原 key + 同一父请求 + 完整相同请求体仅恢复原子尝试，不能创建新预算。其它 key/不同请求体冲突即拒。

## 2. 新入口与权限边界

- `GET /api/integration/automation-read/requests/:id/retry-context`：只观察父请求、原授权及可空的不可变子链接；不改变状态、不自动判定超时、不预留预算、不承诺当前可执行。由独立 management 提供，插件停止仍可查看。所有合法状态/触发类别都可观察。
- `POST /api/integration/automation-read/requests/:id/retry`：仅接受 `retryKey/budget/expiresAt/acknowledgeNewRead:true`。parent 只来自路径；tenant/owner/project/selector/trigger/source/proof 不可自报。返回 `parentRequestId/grantId/requestId/status`，202 不等于远端读取完成。

两口都仅使用可信 JWT tenant，workspace 固定 null，并重新核验当前 Connection incarnation 的原 owner ∩ 集成管理员。POST（含同 key 恢复）须在线 runtime；management 不持有执行能力。

新尝试允许原授权已过期、撤销或耗尽，但实际 source incarnation、authority key 必须仍与原授权一致；新预算不得超过当前审批上限，可以超过旧请求主动缩小的预算。新到期时间按真实 DB 时钟验证。旧版本漂移时只允许观察已有子回执，不能追加新尝试。

**双重授权不互相替代**：新 ledger 预算不生成、不重置 B2a 来源的一次性操作授权。旧请求已花掉唯一登记时，child 即使成功登记也会在来源读取前拒绝，当前保守终态是 outcome_unknown（不推断旧尝试未读）。真正再次读取仍需原来源围栏内另有独立有效的一次性登记；真实客户登记/读取仍单独授权。合成正控预置两个不同 registrationId/operationRef，各 limit=1；负控保留仅一个登记，要求 child 零新增 native IO。不得清旧 claim、复用 parent runId 或提高原登记次数来造绿。

## 3. 事务、身份及不可变证据

追加 migration `zzzz20261002142000_automation_read_linked_retry.ts`，不重写历史迁移：retry purpose 的闭合形状、私有父子关联、租户/owner 范围内 key 唯一、父唯一/子唯一、确认值 IS TRUE、引用 RESTRICT、关系不可 UPDATE/DELETE/TRUNCATE；提交时拒绝孤儿 retry grant。关联父子请求的身份必须不可变，包括没有 134 审计链接的历史父请求。

新执行证明与上限检查在请求锁之前完成；再按 parent grant → parent request 的 NOWAIT 顺序锁定并比对证明。key 使用非等待 advisory lock。子请求沿用实际 admission/audit/outbox 事务，COMMIT 不明确时不自动重新提交。worker 不反向锁祖先。runtime stop 的 signal 在关键 await 前后检查。

## 4. UI 与验证门

界面使用父请求自己的 retry-context，不推断 currentGrant 的归属。确认前显示固定项目/配置、新期限和预算；有 nextAttempt 时展示既有子尝试，不产生新 key。网络结果未知时锁定父/key/完整请求体，只允许同命令恢复。scope/session/unmount/epoch 变化丢弃晚到响应。

验证须覆盖真实 PG 约束与并发、权限/版本/预算拒绝、same-key 恢复、新预算只消费一次、停止 runtime 无新增请求、实际 HTTP 链和浏览器交互。窄 mock 单测不替代实际 authority 链。新增场景应说明哪些层是真实、哪些仍为合成替身。

## 5. 部署与剩余工作

本地迁移先于新代码；本轮不执行生产迁移。出现 retry 历史后 down 必须拒绝，不删除关联来伪造可回滚。无新外发开关；只读预览仍不发 apply token、不写业务表、不发送宜搭、K3 永久禁写。

自动请求关联重试、全目标的其它未交付项与真实客户验收仍单独列账。SA06AH 的一次 native PG 107/108 历史失败尚未归因；之后 108/108 不等于已根治，本轮合成漂移拒绝用例也不是历史根因证明。
