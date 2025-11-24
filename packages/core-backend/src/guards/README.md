# SafetyGuard Module

SafetyGuard 提供危险操作的安全检查和双重确认机制。

## 功能特点

- **风险评估**: 自动评估操作风险等级 (LOW/MEDIUM/HIGH/CRITICAL)
- **确认流程**: 高风险操作需要确认才能执行
- **双重确认**: 关键操作需要用户输入操作名称确认
- **Token 机制**: 安全的确认 token，带过期时间
- **指标监控**: Prometheus 指标追踪所有危险操作
- **Express 中间件**: 简单集成到 API 端点

## 快速开始

### 基本使用

```typescript
import { getSafetyGuard, OperationType } from './guards';

const guard = getSafetyGuard();

// 检查操作
const result = guard.checkOperation({
  operation: OperationType.DELETE_DATA,
  initiator: 'user@example.com',
  details: { tableId: 'users', count: 100 }
});

if (result.allowed) {
  // 执行操作
} else {
  // 需要确认
  console.log('Token:', result.confirmationToken);
  console.log('Risk:', result.assessment.riskDescription);
}
```

### Express 中间件集成

```typescript
import express from 'express';
import {
  requireSafetyCheck,
  createSafetyConfirmEndpoint,
  OperationType
} from './guards';

const app = express();

// 保护危险端点
app.delete('/api/tables/:id',
  requireSafetyCheck({
    operation: OperationType.DROP_TABLE,
    getDetails: (req) => ({ tableId: req.params.id })
  }),
  (req, res) => {
    // 如果到达这里，操作已被确认
    res.json({ success: true });
  }
);

// 确认端点
app.post('/api/safety/confirm', createSafetyConfirmEndpoint());
```

### 客户端确认流程

1. **首次请求** (被阻止):

```javascript
// DELETE /api/tables/users
// Response: 403
{
  "error": "SafetyCheck",
  "code": "SAFETY_CHECK_REQUIRED",
  "assessment": {
    "riskLevel": "critical",
    "requiresDoubleConfirm": true,
    "riskDescription": "This will permanently delete the table...",
    "safeguards": ["Create a snapshot before proceeding"]
  },
  "confirmation": {
    "token": "sfg_abc123...",
    "expiresAt": "2025-11-17T13:00:00Z",
    "instructions": "To confirm, type 'drop_table' as confirmation"
  }
}
```

2. **确认请求**:

```javascript
// POST /api/safety/confirm
{
  "token": "sfg_abc123...",
  "typedConfirmation": "droptable",  // 用户输入
  "acknowledged": true
}
// Response: 200
{ "success": true }
```

3. **重试请求** (带 token):

```javascript
// DELETE /api/tables/users
// Headers: X-Safety-Token: sfg_abc123...
// Response: 200
{ "success": true }
```

## 风险等级

| 等级 | 需要确认 | 需要双重确认 | 示例操作 |
|------|----------|--------------|----------|
| LOW | ❌ | ❌ | reset_metrics |
| MEDIUM | ✅ | ❌ | unload_plugin, clear_cache |
| HIGH | ✅ | ❌ | delete_data, bulk_update |
| CRITICAL | ✅ | ✅ | drop_table, shutdown_service |

## Prometheus 指标

```promql
# 危险操作总数
metasheet_dangerous_operations_total{operation="delete_data", risk_level="high", result="allowed"}

# 被阻止的操作
metasheet_blocked_operations_total{operation="drop_table", reason="blocked_by_policy"}

# 待确认数量
metasheet_pending_confirmations

# 确认延迟分布
histogram_quantile(0.95, metasheet_confirmation_delay_seconds_bucket)
```

## 配置选项

```typescript
import { initSafetyGuard, OperationType } from './guards';

const guard = initSafetyGuard({
  enabled: true,
  allowBypass: false,
  tokenExpirationSeconds: 300,  // 5 分钟
  doubleConfirmOperations: [
    OperationType.DROP_TABLE,
    OperationType.TRUNCATE_TABLE,
    OperationType.SHUTDOWN_SERVICE
  ],
  blockedOperations: [
    // 完全禁止的操作
  ]
});
```

## 测试

```bash
# 运行单元测试
pnpm test -- --grep SafetyGuard
```

## 最佳实践

1. **始终创建快照**: 在执行高风险操作前创建快照
2. **记录操作日志**: 所有危险操作都有审计日志
3. **合理设置过期时间**: 不要让 token 过期太快或太慢
4. **监控指标**: 关注 `blocked_operations_total` 异常增长
5. **用户教育**: 确保用户理解双重确认的重要性

## 下一步

- [ ] 添加更多操作类型
- [ ] 实现基于角色的确认要求
- [ ] 添加操作历史审计
- [ ] 集成到前端 UI (确认对话框组件)
