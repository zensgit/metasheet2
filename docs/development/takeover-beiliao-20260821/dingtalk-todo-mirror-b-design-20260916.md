# 钉钉待办单向镜像（B 方案）设计 — 备料 × 审批

日期：2026-09-16（第六次 24h 自主授权内，设计先行；代码按本文实现，默认关闭）
状态：实现分支 `feat/dingtalk-todo-mirror`（默认关闭）；§4 已按反驳轮修正为"席位存活退休"；owner 前置见 §8；实现 PR 见 24h 记录 §0 Q19
关联裁决：`beiliao-dingtalk-todo-decision`（A 工作通知先上 → B 单向镜像下一波 → 永不做 C 入站）；`stock-preparation-overall-plan-20260902.md` W2-1；`multitable-approval-integration-design-20260915.md`（钉钉只做 transport）

## 0. 一句话

审批产生"待某人处理"的那一刻（`approval.task_created`），在该处理人的钉钉待办里**镜像一条**，带深链回平台；处理完成（下一节点激活或实例终态）时把镜像**标记完成/作废**。**只出不进**：钉钉侧的勾选、评论、驳回一概不回流平台（C 方案永不做）。

## 1. 现状（2026-09-16 三读者只读地图，origin/main 784c22dc1）

| 事实 | 证据 |
| --- | --- |
| 代码里**没有**任何钉钉待办（`/v1.0/todo/`）调用；`index.ts` 明示"无待办 API" | `packages/core-backend/src/index.ts:495-503`；`integrations/dingtalk/client.ts` 导出清单 |
| "A 方案"实际上只上了**群机器人** handoff 通知（`(本条由系统发送)`），不是按人工作通知；`stock-preparation-24h-design-and-verification-20260903.md:109` 的表述与代码不符 | `plugins/plugin-integration-core/lib/stock-preparation-handoff.cjs:597-633`；`multitable/dingtalk-group-destination-service.ts` |
| 钉钉 HTTP 统一走 `transport.ts`（分 read/exchange/send 三档，send 档不重试并打 outcome-unknown 标记）；app access token 进程内缓存 | `integrations/dingtalk/transport.ts`, `client.ts:406-494` |
| 企业应用凭据在 `directory_integrations.config`（appKey 明文，appSecret / workNotificationAgentId 加密），owner 在 `DirectoryManagementView.vue` 录入；**不是** `data_sources` | `integrations/dingtalk/work-notification-settings.ts:133-213`；`apps/web/src/views/DirectoryManagementView.vue` |
| unionId 已落库：`user_external_identities.provider_union_id`（免登/OAuth 写）、`directory_accounts.union_id`（通讯录同步写），经 `directory_account_links.local_user_id` 关联平台用户 | 迁移 `zzzz20260323120000_create_user_external_identities.ts`、`zzzz20260324150000_create_directory_sync_tables.ts` |
| 耐久投递：`meta_automation_outbox` + consumer 表，manifest v2 路由五个审批事件族；新增消费者必须开 **manifest v3**（v1/v2 冻结）+ `DURABLE_CONSUMER_KEYS` + handler + 两条腿（durable 与 eventBus） | `multitable/automation-routing-manifest.ts:96-194`；`automation-durable-activation.ts:47-66` |
| `approval.task_created` 每个 **user 型**在途席位一条（role/source_queue 席位不发）；payload 含 instanceId/requestNo/templateId、task{nodeKey, entryEpoch, assigneeUserId, sourceStep}、requester{id}；**不含** org_id | `services/ApprovalTaskCreatedEvent.ts:145-239` |
| **没有** "任务已决/节点推进/任务作废" 事件；只能从下一节点的 task_created 与实例终态事件推断 | grep `task_decided|node_advanced|task_cancelled` 无结果 |
| 可照抄的账本：`attendance_notification_deliveries`（UNIQUE(org_id, source_key)、SKIP LOCKED 租约、CAS 终态、1m/5m/15m/60m/6h 退避、outcome_unknown 永不重发、redelivery_safe 只在确定失败时置位）与 `dingtalk_approval_card_deliveries`（按 instance/node/epoch/recipient 键、superseded 状态） | 对应迁移与 `AttendanceNotificationDeliveryWorker.ts`、`AttendanceNotificationRedelivery.ts` |
| 功能开关约定：`config/flags.ts` 精确字面量 `'true'`；on-prem 由 `docker/app.env` 注入，无 key 白名单 | `config/flags.ts:25-64`；`ecosystem.config.cjs:7-52` |

## 2. 范围

做：
1. 新耐久消费者 `dingtalk-todo-mirror`（manifest v3），订阅 `approval.task_created` + `approval.approved/rejected/revoked/cancelled`。
2. 账本表 `dingtalk_todo_mirrors`。
3. 钉钉待办客户端三个函数（创建 / 完成 / 删除），走 `transport.ts` send 档。
4. 后台投递 worker（复用 attendance 的租约/退避/CAS 形状），以及 operator 级重投门。
5. 功能开关 `DINGTALK_TODO_MIRROR_ENABLED`（默认关）；开关关闭时消费者 **ACK 且不写账本**（不能让 outbox 堆积）。
6. 单测 + 契约测试（fixture 化的钉钉响应，不打真网）。

不做：
- 入站（钉钉侧勾选/评论回流）—— C 方案永不做。
- role / source_queue 席位的待办（现有事件不覆盖；§8 列为后续）。
- 待办卡片/审批卡片（已有 interactive card 线，不混）。
- 前端配置页：凭据仍走 `DirectoryManagementView`；镜像开关走 app.env。

## 3. 数据模型

`dingtalk_todo_mirrors`
| 列 | 说明 |
| --- | --- |
| id uuid PK | |
| org_id text NOT NULL | 从 `approval_instances.org_id` 回读（payload 不带）；NULL 的历史实例 → 跳过并记 `skipped_no_org` |
| instance_id, request_no, template_id | 审批实例 |
| node_key text, entry_epoch int | 任务身份（与 task_created 事件一致） |
| recipient_user_id text NOT NULL | 平台用户 id |
| recipient_union_id text NULL | 解析后的钉钉 unionId（解析失败 → `skipped_no_identity`） |
| integration_id uuid NULL | 该收件人所属 `directory_integrations`（多 corp 时按人分派凭据） |
| source_key text NOT NULL, UNIQUE (org_id, source_key) | = task_created 的 `eventId`（`approval-task:<instanceId>:<nodeKey>:<epoch>:<assignee>`），幂等键，也作钉钉 `sourceId` |
| dingtalk_task_id text NULL | 创建成功后回填 |
| status text CHECK IN ('pending','sending','created','completing','completed','superseded','failed','skipped','outcome_unknown') | 见 §5 |
| complete_reason text NULL | `next_node` / `approved` / `rejected` / `revoked` / `cancelled` |
| attempt_count, next_attempt_at, last_attempt_at, claimed_at, claim_expires_at, claim_worker_id, last_error, redelivery_safe boolean DEFAULT false | 照抄 attendance 账本 |
| created_at, updated_at | |

索引：UNIQUE(org_id, source_key)；(status, next_attempt_at)；(status, claim_expires_at)；(instance_id, status)。

## 4. 事件到动作

| 事件 | 动作 |
| --- | --- |
| `approval.task_created`（instance X, node N, epoch E, assignee U） | ① **按席位存活退休**（实现修正，2026-09-16 反驳轮）：X 上状态 ∈ {pending, created} 且在 `approval_assignments` 里**已无 is_active 席位**（同 instance/node_key/entry_epoch/recipient）的行标 `superseded`（created 行进入 `completing`）；不再用 "(node, epoch) ≠ (N, E)"——那会把并行网关的同 epoch 兄弟分支、以及 at-least-once 重投的旧事件误杀当前席位；同轮改派（同 node/epoch 换人）也靠存活判定退休旧收件人。② 插入 (X, N, E, U) status=`pending`，且只在该席位仍存活时插入（幂等键冲突即 ACK）。 |
| `approval.approved/rejected/revoked/cancelled` | X 上所有 pending → `skipped`（未发出的不再发）；created → `completing`（complete_reason=事件）。 |
| worker 取 `pending` | 解析 unionId → 无则 `skipped_no_identity`；调创建 API（sourceId = source_key，subject = 「审批待处理：<模板名> <requestNo>」，detailUrl = 平台 `/approvals/<instanceId>`，executorIds=[unionId]，creatorId = 应用操作者 unionId，见 §8）；成功 → `created` + task_id；确定失败 → `failed`（redelivery_safe=true）；网络/超时/5xx → `outcome_unknown`（终态，不重发，留给对账）。 |
| worker 取 `completing` | 调完成 API（PUT done=true）；成功 → `completed`；HTTP 404 → `completed`（视为已清理；**裁判提醒**：操作者 unionId 变更或权限问题也可能答 404，owner 实测前此分支按 404 处理，见 §8.5）；408/429/5xx → 退避重试；其它 4xx → `failed`。 |
| worker 取 `pending` 补充 | 发请求前先在租约 CAS 下戳 `send_issued_at`（在取 token 之后、真正 POST 之前）；租约过期被重领时若已戳 → `outcome_unknown`（不重发，避免重复待办）；未戳 → 可安全重发。创建成功后立刻探一次席位存活，已死则直接进 `completing`（覆盖"发送中实例已终态"的窗口）。 |

**没有任务已决事件**的后果：某节点若被或签同伴先决，其余同伴的待办要到下一节点激活时才会被标 superseded；这是现有事件模型的边界，写进 owner 说明，不在本轮补事件（审批中心代码属另一窗口）。

## 5. 状态机

```
pending ──send ok──▶ created ──complete ok──▶ completed
   │                    │
   │ send definite fail │ (superseded / terminal event) ──▶ completing ──▶ completed
   ▼                    ▼
 failed(redelivery_safe)   outcome_unknown（终态，不重发）
   ▲
   └─ operator 重投门：failed ∧ redelivery_safe → pending
pending ──(实例终态先到)──▶ skipped
pending ──(无 unionId / 无 org)──▶ skipped
```

租约、退避与 CAS 与 attendance worker 完全一致（1m/5m/15m/60m/6h，最多 5 次）。

## 6. 钉钉 API（按开放平台公开文档，实现前以 owner 权限页核对）

- 创建：`POST /v1.0/todo/users/{operatorUnionId}/tasks`，头 `x-acs-dingtalk-access-token`；体 `sourceId, subject, creatorId, executorIds[], detailUrl{appUrl,pcUrl}, isOnlyShowExecutor:true, notifyConfigs{dingNotify:'1'}`。
- 完成：`PUT /v1.0/todo/users/{operatorUnionId}/tasks/{taskId}`，体 `{ done: true }`。
- 删除：`DELETE /v1.0/todo/users/{operatorUnionId}/tasks/{taskId}`（仅对账工具用，状态机不调用）。
- 重投：无路由，只有 CLI `packages/core-backend/scripts/dingtalk-todo-mirror-requeue.ts --id <row> --org <org>`（org 限定；席位已死的创建阶段行拒绝重投）。
- 深链：只读 env `PUBLIC_APP_URL` / `APP_BASE_URL`，不读 `directory_integrations.config.approvalCardPublicAppUrl`。
- 权限：企业应用需开通待办写权限（开放平台"待办"权限组）。
- 客户端落在 `integrations/dingtalk/client.ts` 新增 `createDingTalkTodoTask / completeDingTalkTodoTask / deleteDingTalkTodoTask`，`kind:'send'`、`envelope:'none'`，错误分类沿用 `isDingTalkOutcomeUnknown → DingTalkRequestError → DingTalkBusinessError`。

## 7. 安全与边界

- **凭据不经 Claude**：仍在 `directory_integrations.config`（owner 录入）；镜像只多读一个 `todoOperatorUnionId`（明文即可，非秘密）。
- **租户**：一律以 `approval_instances.org_id` 为准；收件人 unionId 通过 `directory_account_links(link_status='linked') → directory_accounts(is_active) → directory_integrations(status='active', 同 org)` 解析，跨 org 不解析。
- **值无关日志**：日志只打 instanceId/nodeKey/status/errcode，不打主题、姓名、unionId。
- **开关关闭 = ACK 不落库**；manifest v3 的 rolling-deploy 规则照旧（先上认识新 key 的 worker，再让生产者盖 v3 章；本轮 on-prem 单机可同包上）。
- **不入站**：不订阅任何钉钉待办回调。

## 8. Owner 前置（未满足前代码保持关闭）

1. 企业应用开通"待办"写权限，并确认应用可作为待办创建者。
2. 指定"操作者"账号的 unionId（待办在钉钉里显示的创建者），填入 `directory_integrations.config.todoOperatorUnionId`。
3. 222 上核对 `directory_accounts.union_id` / `user_external_identities.provider_union_id` 覆盖率（只报计数）；备料审批的处理人都要有。
4. 真租户探针一轮：创建 → 完成 → 再完成 → 完成一条已删除的任务，记录"任务不存在"的 HTTP 状态与 body code（账本目前把完成 PUT 的任何 404 当已清理）。
5. `docker/app.env` 设 `PUBLIC_APP_URL`（或 `APP_BASE_URL`），否则待办深链解析不到。
6. 决定是否要 role 席位待办（需审批窗口补"按角色展开成员"的事件，或镜像侧自行展开——后者会与审批中心的席位语义分叉，不建议）。

## 9. 验证矩阵（实现 PR 必附）

| 维度 | 用例 |
| --- | --- |
| manifest | v3 精确集 pin 更新；v1/v2 不变；`assertManifestCompleteness` 过 |
| 消费者 | task_created 幂等（同 eventId 两次 → 一行）；下一节点 → 旧行 superseded/completing；终态 → pending→skipped、created→completing；开关关 → ACK 且零行 |
| 身份 | 无 unionId → skipped_no_identity；跨 org 账号不解析 |
| worker | 租约/CAS 与 attendance 同形；确定失败 → failed+redelivery_safe；超时 → outcome_unknown 且永不重发；完成 API "不存在" → completed |
| 客户端 | fixture 响应（成功/业务错误/超时/畸形 2xx）四类；不打真网 |
| 值无关 | 日志断言不含主题/姓名/unionId |
| 变异 | 删掉幂等 UNIQUE → 重复用例红；删掉开关 → 关闭用例红；把 outcome_unknown 改成可重发 → 用例红 |
