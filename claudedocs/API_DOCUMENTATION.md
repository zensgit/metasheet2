# MetaSheet v2 API Documentation

**Version**: 2.4.0
**Last Updated**: 2025-11-16
**Base URL**: `http://localhost:8900` (development) / `https://api.metasheet.com` (production)

---

## 📚 Table of Contents

1. [Authentication](#authentication)
2. [Approval System API](#approval-system-api)
3. [Cache System API](#cache-system-api)
4. [RBAC Permission API](#rbac-permission-api)
5. [API Gateway](#api-gateway)
6. [Event Bus API](#event-bus-api)
7. [Notification API](#notification-api)
8. [Error Handling](#error-handling)

---

## 🔐 Authentication

All API requests require authentication via Bearer token.

### Generate Development Token

```bash
# Using the gen-dev-token script
TOKEN=$(node scripts/gen-dev-token.js)

# Use in requests
curl -H "Authorization: Bearer $TOKEN" http://localhost:8900/api/...
```

### Token Format

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## 📋 Approval System API

### Overview

The Approval System provides automated workflow approval for spreadsheet data changes, with integration to Feishu, DingTalk, and WeCom.

### Endpoints

#### 1. List Approvals

```http
GET /api/approvals
```

**Query Parameters**:
- `spreadsheetId` (optional): Filter by spreadsheet
- `status` (optional): `pending`, `approved`, `rejected`
- `limit` (optional): Number of results (default: 20)
- `offset` (optional): Pagination offset

**Response**:
```json
{
  "ok": true,
  "data": [
    {
      "id": "approval-001",
      "spreadsheetId": "sheet-001",
      "triggerType": "value_change",
      "status": "pending",
      "version": 1,
      "createdAt": "2025-11-16T10:00:00Z"
    }
  ],
  "total": 42
}
```

#### 2. Get Approval Details

```http
GET /api/approvals/:id
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "id": "approval-001",
    "spreadsheetId": "sheet-001",
    "cellAddress": "A1",
    "oldValue": "100",
    "newValue": "200",
    "triggerType": "value_change",
    "status": "pending",
    "version": 1,
    "approvers": ["user-001", "user-002"],
    "currentApprover": "user-001",
    "history": [
      {
        "action": "created",
        "userId": "system",
        "timestamp": "2025-11-16T10:00:00Z"
      }
    ],
    "createdAt": "2025-11-16T10:00:00Z",
    "updatedAt": "2025-11-16T10:00:00Z"
  }
}
```

#### 3. Approve Request

```http
POST /api/approvals/:id/approve
```

**Request Body**:
```json
{
  "version": 1,
  "comment": "Approved, looks good"
}
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "id": "approval-001",
    "status": "approved",
    "version": 2,
    "approvedBy": "user-001",
    "approvedAt": "2025-11-16T10:05:00Z"
  }
}
```

#### 4. Reject Request

```http
POST /api/approvals/:id/reject
```

**Request Body**:
```json
{
  "version": 1,
  "reason": "Values out of acceptable range"
}
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "id": "approval-001",
    "status": "rejected",
    "version": 2,
    "rejectedBy": "user-001",
    "rejectedAt": "2025-11-16T10:05:00Z",
    "reason": "Values out of acceptable range"
  }
}
```

### Testing Examples

```bash
# List all pending approvals
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8900/api/approvals?status=pending"

# Get specific approval
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8900/api/approvals/demo-1"

# Approve a request
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":1,"comment":"Approved"}' \
  "http://localhost:8900/api/approvals/demo-1/approve"
```

---

## 💾 Cache System API

### Overview

The Cache System provides high-performance caching with Prometheus metrics integration.

### Endpoints

#### 1. Cache Health Check

```http
GET /api/cache/health
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "status": "healthy",
    "registeredCaches": 5,
    "caches": [
      {
        "name": "permission-cache",
        "type": "redis",
        "status": "active"
      },
      {
        "name": "spreadsheet-cache",
        "type": "memory",
        "status": "active"
      }
    ]
  }
}
```

#### 2. Get Cache Statistics

```http
GET /api/cache/stats
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "totalHits": 15420,
    "totalMisses": 1234,
    "hitRate": 0.9259,
    "caches": {
      "permission-cache": {
        "hits": 8500,
        "misses": 500,
        "hitRate": 0.9444,
        "size": 2500
      },
      "spreadsheet-cache": {
        "hits": 6920,
        "misses": 734,
        "hitRate": 0.9041,
        "size": 1200
      }
    }
  }
}
```

#### 3. Clear Cache

```http
DELETE /api/cache/:cacheName
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "cacheName": "permission-cache",
    "cleared": true,
    "itemsRemoved": 2500
  }
}
```

### Prometheus Metrics

```bash
# Get cache metrics
curl http://localhost:8900/metrics/prom | grep cache

# Expected metrics:
# cache_hits_total{cache="permission-cache"} 8500
# cache_misses_total{cache="permission-cache"} 500
# cache_size{cache="permission-cache"} 2500
# cache_hit_rate{cache="permission-cache"} 0.9444
```

---

## 🔒 RBAC Permission API

### Overview

Role-Based Access Control (RBAC) system with fine-grained permissions and metrics.

### Endpoints

#### 1. Check Permission

```http
GET /api/permissions/check
```

**Query Parameters**:
- `userId` (required): User ID
- `resource` (required): Resource type (e.g., `spreadsheet`, `cell`, `row`)
- `resourceId` (required): Resource identifier
- `action` (required): Action to check (e.g., `read`, `write`, `delete`)

**Response**:
```json
{
  "ok": true,
  "data": {
    "hasPermission": true,
    "userId": "user-001",
    "resource": "spreadsheet",
    "resourceId": "sheet-001",
    "action": "write",
    "source": "cache",
    "checkedAt": "2025-11-16T10:00:00Z"
  }
}
```

#### 2. Get User Permissions

```http
GET /api/permissions?userId=:userId
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "userId": "user-001",
    "permissions": [
      {
        "resource": "spreadsheet",
        "resourceId": "sheet-001",
        "actions": ["read", "write"]
      },
      {
        "resource": "spreadsheet",
        "resourceId": "sheet-002",
        "actions": ["read"]
      }
    ],
    "roles": ["editor", "viewer"]
  }
}
```

#### 3. Grant Permission

```http
POST /api/permissions/grant
```

**Request Body**:
```json
{
  "userId": "user-001",
  "permission": "spreadsheet:sheet-001:write"
}
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "userId": "user-001",
    "permission": "spreadsheet:sheet-001:write",
    "granted": true,
    "grantedAt": "2025-11-16T10:00:00Z"
  }
}
```

#### 4. Revoke Permission

```http
POST /api/permissions/revoke
```

**Request Body**:
```json
{
  "userId": "user-001",
  "permission": "spreadsheet:sheet-001:write"
}
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "userId": "user-001",
    "permission": "spreadsheet:sheet-001:write",
    "revoked": true,
    "revokedAt": "2025-11-16T10:00:00Z"
  }
}
```

### Testing Examples

```bash
# Check permission
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8900/api/permissions/check?userId=u1&resource=spreadsheet&resourceId=sheet-001&action=write"

# Get all user permissions
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8900/api/permissions?userId=u1"

# Grant permission
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"u1","permission":"spreadsheet:sheet-001:write"}' \
  "http://localhost:8900/api/permissions/grant"
```

### Prometheus Metrics

```bash
# Get RBAC metrics
curl http://localhost:8900/metrics/prom | grep rbac

# Expected metrics:
# rbac_perm_queries_real_total 5000
# rbac_perm_queries_synth_total 500
# rbac_perm_cache_hits_total 4500
# rbac_perm_cache_misses_total 1000
```

---

## 🚪 API Gateway

### Overview

API Gateway provides rate limiting, circuit breaking, and request routing.

### Features

- **Rate Limiting**: Configurable per-endpoint limits
- **Circuit Breaker**: Automatic failure detection and recovery
- **Load Balancing**: Intelligent request distribution
- **Request Validation**: Schema validation and sanitization

### Configuration

Rate limits are configured per endpoint in the gateway configuration.

### Monitoring

```bash
# Get gateway metrics
curl http://localhost:8900/metrics/prom | grep gateway

# Expected metrics:
# gateway_requests_total{endpoint="/api/approvals"} 1500
# gateway_rate_limited_total{endpoint="/api/approvals"} 5
# gateway_circuit_breaker_open{endpoint="/api/backend"} 0
```

---

## 📢 Event Bus API

### Overview

Event Bus provides pub/sub messaging for inter-plugin communication.

### Events

#### System Events
- `spreadsheet.created`
- `spreadsheet.updated`
- `spreadsheet.deleted`
- `cell.value_changed`
- `approval.created`
- `approval.approved`
- `approval.rejected`

### Publishing Events

```javascript
// Example: Publishing an event
const eventBus = require('./core/EventBusService');

eventBus.publish('spreadsheet.updated', {
  spreadsheetId: 'sheet-001',
  changes: {
    cells: ['A1', 'B2'],
    timestamp: new Date().toISOString()
  }
});
```

### Subscribing to Events

```javascript
// Example: Subscribing to events
eventBus.subscribe('spreadsheet.updated', (data) => {
  console.log('Spreadsheet updated:', data.spreadsheetId);
  // Handle the event
});
```

---

## 🔔 Notification API

### Overview

Multi-channel notification system with support for Email, SMS, Push, and IM platforms.

### Endpoints

#### 1. Send Notification

```http
POST /api/notifications/send
```

**Request Body**:
```json
{
  "userId": "user-001",
  "channel": "email",
  "template": "approval-required",
  "data": {
    "approvalId": "approval-001",
    "spreadsheetName": "Q4 Sales",
    "requester": "John Doe"
  }
}
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "notificationId": "notif-001",
    "status": "sent",
    "channel": "email",
    "sentAt": "2025-11-16T10:00:00Z"
  }
}
```

#### 2. Get Notification Status

```http
GET /api/notifications/:id/status
```

**Response**:
```json
{
  "ok": true,
  "data": {
    "notificationId": "notif-001",
    "status": "delivered",
    "channel": "email",
    "sentAt": "2025-11-16T10:00:00Z",
    "deliveredAt": "2025-11-16T10:00:05Z"
  }
}
```

### Supported Channels

- **email**: Email notifications
- **sms**: SMS notifications
- **push**: Push notifications
- **feishu**: Feishu (Lark) messages
- **dingtalk**: DingTalk messages
- **wecom**: WeCom (Enterprise WeChat) messages

---

## ⚠️ Error Handling

### Error Response Format

All errors follow a consistent format:

```json
{
  "ok": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "User does not have write permission for this resource",
    "details": {
      "userId": "user-001",
      "resource": "spreadsheet:sheet-001",
      "action": "write"
    }
  }
}
```

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication token |
| `PERMISSION_DENIED` | 403 | User lacks required permissions |
| `NOT_FOUND` | 404 | Requested resource not found |
| `VALIDATION_ERROR` | 400 | Invalid request parameters |
| `VERSION_CONFLICT` | 409 | Optimistic lock version mismatch |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server internal error |

### Version Conflict Handling

For approval operations, version conflicts are handled with optimistic locking:

```json
{
  "ok": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "The approval has been modified by another user",
    "details": {
      "expectedVersion": 1,
      "currentVersion": 2,
      "suggestion": "Fetch the latest version and retry"
    }
  }
}
```

**Resolution**:
1. Fetch the latest approval version
2. Review the changes
3. Retry the operation with the new version number

---

## 📊 Health Check

### System Health

```http
GET /health
```

**Response**:
```json
{
  "ok": true,
  "status": "healthy",
  "version": "2.4.0",
  "uptime": 3600,
  "services": {
    "database": "healthy",
    "cache": "healthy",
    "eventBus": "healthy"
  }
}
```

---

## 🔗 Related Documentation

- [Feature Migration Assessment](FEATURE_MIGRATION_ASSESSMENT.md)
- [Observability Guide](OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md)
- [Phase 5 Completion Guide](PHASE5_COMPLETION_GUIDE.md)

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**

**Last Updated**: 2025-11-16
