# 审批 API 使用指南

> 日期: 2026-04-11
> 基地址: `http://localhost:8900`
> OpenAPI: `packages/openapi/src/paths/approvals.yml`
> 类型定义: `apps/web/src/types/approval.ts`

---

## 认证

所有请求需要 Bearer token:

```bash
TOKEN="your-jwt-token"
AUTH="Authorization: Bearer $TOKEN"
```

---

## 模板管理

### 创建模板

```bash
curl -s -X POST http://localhost:8900/api/approval-templates \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "key": "general-expense",
    "name": "通用报销审批",
    "description": "部门日常费用报销，500元以下主管审批，500元以上需总监审批",
    "formSchema": {
      "fields": [
        {
          "id": "reason",
          "type": "textarea",
          "label": "报销原因",
          "required": true,
          "placeholder": "请详细描述报销事由"
        },
        {
          "id": "amount",
          "type": "number",
          "label": "金额（元）",
          "required": true
        },
        {
          "id": "category",
          "type": "select",
          "label": "费用类别",
          "required": true,
          "options": [
            { "label": "差旅费", "value": "travel" },
            { "label": "办公用品", "value": "office" },
            { "label": "招待费", "value": "entertainment" },
            { "label": "培训费", "value": "training" },
            { "label": "其他", "value": "other" }
          ]
        },
        {
          "id": "date",
          "type": "date",
          "label": "费用发生日期",
          "required": true
        },
        {
          "id": "receipt",
          "type": "attachment",
          "label": "发票/收据",
          "required": false,
          "placeholder": "上传发票照片或PDF"
        }
      ]
    },
    "approvalGraph": {
      "nodes": [
        { "key": "start_1", "type": "start", "config": {} },
        {
          "key": "condition_1",
          "type": "condition",
          "name": "金额判断",
          "config": {
            "branches": [
              {
                "edgeKey": "e_high",
                "rules": [{ "fieldId": "amount", "operator": "gte", "value": 500 }],
                "conjunction": "and"
              }
            ],
            "defaultEdgeKey": "e_low"
          }
        },
        {
          "key": "approval_manager",
          "type": "approval",
          "name": "主管审批",
          "config": { "assigneeType": "role", "assigneeIds": ["manager"] }
        },
        {
          "key": "approval_director",
          "type": "approval",
          "name": "总监审批",
          "config": { "assigneeType": "role", "assigneeIds": ["director"] }
        },
        {
          "key": "cc_finance",
          "type": "cc",
          "name": "抄送财务",
          "config": { "targetType": "role", "targetIds": ["finance"] }
        },
        { "key": "end_1", "type": "end", "config": {} }
      ],
      "edges": [
        { "key": "e1", "source": "start_1", "target": "condition_1" },
        { "key": "e_low", "source": "condition_1", "target": "approval_manager" },
        { "key": "e_high", "source": "condition_1", "target": "approval_director" },
        { "key": "e3", "source": "approval_manager", "target": "cc_finance" },
        { "key": "e4", "source": "approval_director", "target": "cc_finance" },
        { "key": "e5", "source": "cc_finance", "target": "end_1" }
      ]
    }
  }'
```

**成功响应** (201):
```json
{
  "ok": true,
  "data": {
    "id": "tpl_abc123",
    "key": "general-expense",
    "name": "通用报销审批",
    "description": "部门日常费用报销，500元以下主管审批，500元以上需总监审批",
    "status": "draft",
    "activeVersionId": null,
    "latestVersionId": "ver_001",
    "formSchema": { "fields": [ ... ] },
    "approvalGraph": { "nodes": [ ... ], "edges": [ ... ] },
    "createdAt": "2026-04-11T10:00:00.000Z",
    "updatedAt": "2026-04-11T10:00:00.000Z"
  }
}
```

**错误 — key 重复** (400):
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Template key 'general-expense' already exists"
  }
}
```

---

### 模板列表

```bash
# 列出所有已发布模板
curl -s "http://localhost:8900/api/approval-templates?status=published&limit=20&offset=0" \
  -H "$AUTH"
```

**成功响应** (200):
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "tpl_abc123",
        "key": "general-expense",
        "name": "通用报销审批",
        "description": "部门日常费用报销...",
        "status": "published",
        "activeVersionId": "ver_002",
        "latestVersionId": "ver_002",
        "createdAt": "2026-04-11T10:00:00.000Z",
        "updatedAt": "2026-04-11T10:30:00.000Z"
      },
      {
        "id": "tpl_def456",
        "key": "leave-request",
        "name": "请假审批",
        "description": "员工请假申请流程",
        "status": "published",
        "activeVersionId": "ver_003",
        "latestVersionId": "ver_003",
        "createdAt": "2026-04-10T08:00:00.000Z",
        "updatedAt": "2026-04-10T09:00:00.000Z"
      }
    ],
    "total": 2,
    "limit": 20,
    "offset": 0
  }
}
```

```bash
# 按关键字搜索
curl -s "http://localhost:8900/api/approval-templates?search=报销" \
  -H "$AUTH"
```

---

### 获取模板详情

```bash
curl -s http://localhost:8900/api/approval-templates/tpl_abc123 \
  -H "$AUTH"
```

**成功响应** (200):
```json
{
  "ok": true,
  "data": {
    "id": "tpl_abc123",
    "key": "general-expense",
    "name": "通用报销审批",
    "description": "部门日常费用报销，500元以下主管审批，500元以上需总监审批",
    "status": "published",
    "activeVersionId": "ver_002",
    "latestVersionId": "ver_002",
    "formSchema": {
      "fields": [
        { "id": "reason", "type": "textarea", "label": "报销原因", "required": true },
        { "id": "amount", "type": "number", "label": "金额（元）", "required": true },
        { "id": "category", "type": "select", "label": "费用类别", "required": true, "options": [...] },
        { "id": "date", "type": "date", "label": "费用发生日期", "required": true },
        { "id": "receipt", "type": "attachment", "label": "发票/收据" }
      ]
    },
    "approvalGraph": {
      "nodes": [ ... ],
      "edges": [ ... ]
    },
    "createdAt": "2026-04-11T10:00:00.000Z",
    "updatedAt": "2026-04-11T10:30:00.000Z"
  }
}
```

**错误 — 模板不存在** (404):
```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Approval template not found"
  }
}
```

---

### 编辑模板

```bash
curl -s -X PATCH http://localhost:8900/api/approval-templates/tpl_abc123 \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "name": "通用报销审批（更新版）",
    "description": "增加了培训费类别",
    "formSchema": {
      "fields": [
        { "id": "reason", "type": "textarea", "label": "报销原因", "required": true },
        { "id": "amount", "type": "number", "label": "金额（元）", "required": true },
        { "id": "category", "type": "select", "label": "费用类别", "required": true,
          "options": [
            { "label": "差旅费", "value": "travel" },
            { "label": "办公用品", "value": "office" },
            { "label": "招待费", "value": "entertainment" },
            { "label": "培训费", "value": "training" },
            { "label": "会议费", "value": "meeting" },
            { "label": "其他", "value": "other" }
          ]
        },
        { "id": "date", "type": "date", "label": "费用发生日期", "required": true },
        { "id": "receipt", "type": "attachment", "label": "发票/收据" }
      ]
    }
  }'
```

**成功响应** (200): 返回更新后的 `ApprovalTemplateDetail`，`latestVersionId` 自动递增。

---

### 发布模板

```bash
curl -s -X POST http://localhost:8900/api/approval-templates/tpl_abc123/publish \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "policy": {
      "allowRevoke": true,
      "revokeBeforeNodeKeys": ["approval_manager", "approval_director"]
    }
  }'
```

**成功响应** (200):
```json
{
  "ok": true,
  "data": {
    "id": "ver_002",
    "templateId": "tpl_abc123",
    "version": 2,
    "status": "published",
    "formSchema": { "fields": [ ... ] },
    "approvalGraph": { "nodes": [ ... ], "edges": [ ... ] },
    "runtimeGraph": {
      "nodes": [ ... ],
      "edges": [ ... ],
      "policy": {
        "allowRevoke": true,
        "revokeBeforeNodeKeys": ["approval_manager", "approval_director"]
      }
    },
    "publishedDefinitionId": "pdef_xyz789",
    "createdAt": "2026-04-11T10:00:00.000Z",
    "updatedAt": "2026-04-11T10:30:00.000Z"
  }
}
```

**错误 — 缺少 policy** (400):
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "policy is required for publishing"
  }
}
```

---

### 获取模板版本详情

```bash
curl -s http://localhost:8900/api/approval-templates/tpl_abc123/versions/ver_002 \
  -H "$AUTH"
```

**成功响应** (200): 返回 `ApprovalTemplateVersionDetail`，已发布版本包含 `runtimeGraph`。

---

## 审批实例

### 发起审批

```bash
curl -s -X POST http://localhost:8900/api/approvals \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "templateId": "tpl_abc123",
    "formData": {
      "reason": "出差北京参加技术峰会，包含机票和酒店费用",
      "amount": 3500,
      "category": "travel",
      "date": "2026-04-08",
      "receipt": null
    }
  }'
```

**成功响应** (201):
```json
{
  "ok": true,
  "data": {
    "id": "appr_001",
    "sourceSystem": "platform",
    "externalApprovalId": null,
    "workflowKey": null,
    "businessKey": null,
    "title": "通用报销审批",
    "status": "pending",
    "requester": {
      "id": "user_zhang",
      "name": "张三",
      "department": "技术部",
      "title": "高级工程师"
    },
    "subject": null,
    "policy": {
      "allowRevoke": true,
      "revokeBeforeNodeKeys": ["approval_manager", "approval_director"]
    },
    "currentStep": 1,
    "totalSteps": 3,
    "templateId": "tpl_abc123",
    "templateVersionId": "ver_002",
    "publishedDefinitionId": "pdef_xyz789",
    "requestNo": "AP-042601",
    "formSnapshot": {
      "reason": "出差北京参加技术峰会，包含机票和酒店费用",
      "amount": 3500,
      "category": "travel",
      "date": "2026-04-08",
      "receipt": null
    },
    "currentNodeKey": "approval_director",
    "assignments": [
      {
        "id": "asgn_001",
        "type": "approval",
        "assigneeId": "user_wang_director",
        "sourceStep": 1,
        "nodeKey": "approval_director",
        "isActive": true,
        "metadata": {}
      }
    ],
    "createdAt": "2026-04-11T11:00:00.000Z",
    "updatedAt": "2026-04-11T11:00:00.000Z"
  }
}
```

**错误 — 必填字段缺失** (400):
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Field 'reason' is required"
  }
}
```

**错误 — 类型不匹配** (400):
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Field 'amount' must be a number"
  }
}
```

**错误 — 枚举值非法** (400):
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Field 'category' value 'invalid' is not in allowed options"
  }
}
```

**错误 — 模板未发布** (400):
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Template is not published"
  }
}
```

---

### 审批列表（4 个 Tab）

#### 待审批

```bash
curl -s "http://localhost:8900/api/approvals?assignee=user_wang_director&status=pending&limit=20&offset=0" \
  -H "$AUTH"
```

#### 我发起的

```bash
curl -s "http://localhost:8900/api/approvals?requesterId=user_zhang&limit=20&offset=0" \
  -H "$AUTH"
```

#### 抄送我

```bash
curl -s "http://localhost:8900/api/approvals?ccRecipientId=user_li_finance&limit=20&offset=0" \
  -H "$AUTH"
```

#### 已完成

```bash
curl -s "http://localhost:8900/api/approvals?status=approved&limit=20&offset=0" \
  -H "$AUTH"
```

**成功响应** (200):
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "appr_001",
        "sourceSystem": "platform",
        "title": "通用报销审批",
        "status": "pending",
        "requester": { "id": "user_zhang", "name": "张三", "department": "技术部" },
        "currentStep": 1,
        "totalSteps": 3,
        "requestNo": "AP-042601",
        "assignments": [ ... ],
        "createdAt": "2026-04-11T11:00:00.000Z",
        "updatedAt": "2026-04-11T11:00:00.000Z"
      }
    ],
    "total": 1,
    "limit": 20,
    "offset": 0
  }
}
```

---

### 获取审批详情

```bash
curl -s http://localhost:8900/api/approvals/appr_001 \
  -H "$AUTH"
```

**成功响应** (200): 返回完整的 `UnifiedApprovalDTO`，包含 `formSnapshot`、`assignments` 等。

**错误 — 审批不存在** (404):
```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Approval instance not found"
  }
}
```

---

### 获取审批历史

```bash
curl -s "http://localhost:8900/api/approvals/appr_001/history?page=1&pageSize=50" \
  -H "$AUTH"
```

**成功响应** (200):
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "hist_001",
        "action": "create",
        "actorId": "user_zhang",
        "actorName": "张三",
        "comment": null,
        "fromStatus": null,
        "toStatus": "pending",
        "occurredAt": "2026-04-11T11:00:00.000Z",
        "metadata": {}
      },
      {
        "id": "hist_002",
        "action": "approve",
        "actorId": "user_wang_director",
        "actorName": "王总监",
        "comment": "费用合理，同意报销",
        "fromStatus": "pending",
        "toStatus": "approved",
        "occurredAt": "2026-04-11T14:30:00.000Z",
        "metadata": {}
      }
    ],
    "total": 2,
    "page": 1,
    "pageSize": 50
  }
}
```

---

## 审批操作（统一 Action 接口）

所有操作通过 `POST /api/approvals/{id}/actions` 统一分发。

### 审批通过

```bash
curl -s -X POST http://localhost:8900/api/approvals/appr_001/actions \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "action": "approve",
    "comment": "费用合理，同意报销"
  }'
```

**成功响应** (200): 返回更新后的 `UnifiedApprovalDTO`，`status` 可能变为 `approved`（最后一步）或保持 `pending`（流程未结束）。

---

### 驳回

```bash
curl -s -X POST http://localhost:8900/api/approvals/appr_001/actions \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "action": "reject",
    "comment": "报销金额超出预算，请提供详细清单后重新提交"
  }'
```

**成功响应** (200): `status` 变为 `rejected`。

---

### 转交

```bash
curl -s -X POST http://localhost:8900/api/approvals/appr_001/actions \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "action": "transfer",
    "comment": "本人出差中，转交副总监处理",
    "targetUserId": "user_chen_vice_director"
  }'
```

**成功响应** (200): `assignments` 中的当前审批人变更为 `user_chen_vice_director`。

**错误 — 缺少 targetUserId** (400):
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "targetUserId is required for transfer action"
  }
}
```

---

### 撤回

```bash
curl -s -X POST http://localhost:8900/api/approvals/appr_001/actions \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "action": "revoke",
    "comment": "报销信息填写有误，需要修改后重新提交"
  }'
```

**成功响应** (200): `status` 变为 `revoked`。

**错误 — 非发起人撤回** (403):
```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Only the requester can revoke an approval"
  }
}
```

**错误 — 撤回策略不允许** (409):
```json
{
  "ok": false,
  "error": {
    "code": "APPROVAL_REVOKE_DISABLED",
    "message": "Approval cannot be revoked for this template"
  }
}
```

---

### 评论

```bash
curl -s -X POST http://localhost:8900/api/approvals/appr_001/actions \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "action": "comment",
    "comment": "补充说明：这次出差是应客户邀请，已获部门领导口头同意"
  }'
```

**成功响应** (200): 审批状态不变，评论记录添加到历史中。

---

### 并发操作与串行化

统一 `POST /api/approvals/{id}/actions` 端点采用数据库行锁串行化并发写入。
它不要求客户端提供 `version`，也不承诺返回 `APPROVAL_VERSION_CONFLICT`。
在前序动作已经提交、当前状态不再满足后续动作要求时，后续请求可能收到 409:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_STATUS_TRANSITION",
    "message": "Cannot approve: current status is approved"
  }
}
```

**处理方式**: 客户端收到 409 后应重新 GET 审批详情，按最新状态决定是否继续操作。

旧版 per-action 接口仍保留基于 `version` 的 409 冲突语义，但已标记为 `deprecated`。

---

## 旧版接口（已废弃）

以下接口标记为 `deprecated`，仍可使用但建议迁移到统一 action 接口:

| 旧接口 | 替代方案 |
|--------|---------|
| `POST /api/approvals/{id}/approve` | `POST /api/approvals/{id}/actions` `{"action":"approve"}` |
| `POST /api/approvals/{id}/reject` | `POST /api/approvals/{id}/actions` `{"action":"reject"}` |
| `POST /api/approvals/{id}/return` | `POST /api/approvals/{id}/actions` `{"action":"reject"}` |
| `POST /api/approvals/{id}/revoke` | `POST /api/approvals/{id}/actions` `{"action":"revoke"}` |
| `GET /api/approvals/pending` | `GET /api/approvals?assignee={userId}&status=pending` |

---

## 权限速查

| 权限码 | 允许的操作 |
|--------|-----------|
| `approvals:read` | 查看审批列表、审批详情、审批历史 |
| `approvals:write` | 发起审批（POST /api/approvals） |
| `approvals:act` | 执行审批操作（approve/reject/transfer/revoke/comment） |
| `approval-templates:manage` | 创建/编辑/发布/归档模板 |

---

## 完整端点列表

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/approval-templates` | 模板列表 | `approvals:read` |
| POST | `/api/approval-templates` | 创建模板 | `approval-templates:manage` |
| GET | `/api/approval-templates/{id}` | 模板详情 | `approvals:read` |
| PATCH | `/api/approval-templates/{id}` | 编辑模板 | `approval-templates:manage` |
| POST | `/api/approval-templates/{id}/publish` | 发布模板 | `approval-templates:manage` |
| GET | `/api/approval-templates/{id}/versions/{versionId}` | 版本详情 | `approvals:read` |
| GET | `/api/approvals` | 审批列表 | `approvals:read` |
| POST | `/api/approvals` | 发起审批 | `approvals:write` |
| GET | `/api/approvals/{id}` | 审批详情 | `approvals:read` |
| POST | `/api/approvals/{id}/actions` | 执行操作 | `approvals:act` |
| GET | `/api/approvals/{id}/history` | 审批历史 | `approvals:read` |
