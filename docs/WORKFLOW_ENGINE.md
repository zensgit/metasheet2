# Workflow Engine Documentation

## Overview
A comprehensive workflow automation engine for MetaSheet that enables business process automation through triggers, conditions, and actions. The engine provides a queue-based execution system with retry logic, template processing, and extensive logging.

## Architecture

### Core Components
```
packages/core-backend/src/workflows/
├── engine.ts       # Core execution engine with queue processing
├── triggers.ts     # Trigger system and event handlers
├── actions.ts      # Action implementations
├── conditions.ts   # Condition evaluator with operators
└── routes/workflows.ts # REST API endpoints
```

### Database Schema

#### workflows Table
```sql
CREATE TABLE workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  table_id UUID,
  trigger_config JSONB NOT NULL DEFAULT '{}',
  actions JSONB NOT NULL DEFAULT '[]',
  conditions JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

#### workflow_runs Table
```sql
CREATE TABLE workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID REFERENCES workflows(id) ON DELETE CASCADE,
  trigger_data JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  error TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3
);
```

#### workflow_logs Table
```sql
CREATE TABLE workflow_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step VARCHAR(255) NOT NULL,
  action_type VARCHAR(100),
  action_config JSONB,
  status VARCHAR(20) NOT NULL,
  message TEXT,
  execution_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

## Trigger System

### Supported Triggers

#### 1. Record Change
Fires when any field in a record changes.
```json
{
  "type": "record_change",
  "config": {
    "tableId": "table_uuid",
    "includeFields": ["status", "amount"],
    "excludeFields": ["updated_at"]
  }
}
```

#### 2. Field Update
Fires when specific fields change with optional conditions.
```json
{
  "type": "field_update",
  "config": {
    "tableId": "table_uuid",
    "field": "status",
    "condition": {
      "operator": "changed_to",
      "value": "approved"
    }
  }
}
```

#### 3. Schedule
Fires on a schedule (cron-like or interval).
```json
{
  "type": "schedule",
  "config": {
    "interval": "daily",      // daily, weekly, monthly
    "time": "09:00",          // HH:mm format
    "timezone": "UTC",
    "daysOfWeek": [1, 5]      // Monday and Friday
  }
}
```

#### 4. Webhook
Fires when webhook endpoint receives a request.
```json
{
  "type": "webhook",
  "config": {
    "webhookId": "webhook_uuid",
    "secret": "webhook_secret",
    "validatePayload": true
  }
}
```

## Action System

### Supported Actions

#### 1. Send Notification
Sends notifications via multiple channels.
```json
{
  "type": "send_notification",
  "config": {
    "channel": "email",              // email, webhook, in_app
    "recipient": "user@example.com",
    "subject": "Task {{status}}",
    "message": "Task {{name}} is now {{status}}",
    "priority": "high"
  }
}
```

#### 2. Update Field
Updates record fields with template support.
```json
{
  "type": "update_field",
  "config": {
    "tableId": "table_uuid",
    "recordId": "{{trigger.recordId}}",
    "updates": {
      "status": "processed",
      "processed_at": "{{meta.timestamp}}",
      "processed_by": "{{meta.userId}}"
    }
  }
}
```

#### 3. Call API
Makes HTTP requests to external services.
```json
{
  "type": "call_api",
  "config": {
    "url": "https://api.example.com/webhook",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer {{env.API_KEY}}"
    },
    "body": {
      "record_id": "{{trigger.recordId}}",
      "status": "{{current.status}}"
    },
    "timeout": 30000,
    "retries": 3
  }
}
```

#### 4. Create Record
Creates new records with template data.
```json
{
  "type": "create_record",
  "config": {
    "tableId": "audit_logs",
    "data": {
      "action": "workflow_triggered",
      "workflow_id": "{{workflow.id}}",
      "record_id": "{{trigger.recordId}}",
      "timestamp": "{{meta.timestamp}}"
    }
  }
}
```

## Condition System

### Condition Types

#### Field Conditions
Compare field values with operators.
```json
{
  "type": "field_condition",
  "field": "amount",
  "operator": "greater_than",
  "value": 1000
}
```

#### Logical Conditions
Combine multiple conditions with AND/OR.
```json
{
  "type": "and",
  "conditions": [
    {
      "type": "field_condition",
      "field": "status",
      "operator": "equals",
      "value": "approved"
    },
    {
      "type": "field_condition",
      "field": "amount",
      "operator": "less_than",
      "value": 10000
    }
  ]
}
```

### Supported Operators
- `equals` - Exact match
- `not_equals` - Not equal
- `contains` - String/array contains
- `not_contains` - String/array doesn't contain
- `starts_with` - String starts with
- `ends_with` - String ends with
- `greater_than` - Numeric greater than
- `less_than` - Numeric less than
- `greater_than_or_equals` - Numeric >=
- `less_than_or_equals` - Numeric <=
- `is_empty` - Null or empty
- `is_not_empty` - Not null/empty
- `in` - Value in list
- `not_in` - Value not in list

## Template System

### Variable Syntax
Templates use `{{variable}}` syntax for dynamic values.

### Available Variables
- `{{current.fieldName}}` - Current record field value
- `{{previous.fieldName}}` - Previous record field value
- `{{trigger.recordId}}` - ID of triggering record
- `{{trigger.tableId}}` - Table ID
- `{{trigger.userId}}` - User who triggered
- `{{meta.timestamp}}` - Current timestamp
- `{{meta.workflowId}}` - Workflow ID
- `{{env.VARIABLE}}` - Environment variable
- `{{workflow.name}}` - Workflow name

### Nested Path Support
Access nested objects with dot notation:
```
{{current.user.profile.email}}
{{trigger.data.items[0].name}}
```

## Execution Engine

### Queue Processing
- **Concurrency**: Configurable max concurrent executions (default: 5)
- **Priority**: FIFO queue with priority support
- **Batching**: Process multiple workflows in parallel
- **Throttling**: Rate limiting per workflow

### Retry Mechanism
```typescript
interface RetryConfig {
  maxRetries: 3,
  retryDelay: 1000,      // Initial delay in ms
  backoffMultiplier: 2,  // Exponential backoff
  maxRetryDelay: 30000   // Max delay between retries
}
```

### Error Handling
- **Graceful Failures**: Continue execution on non-critical errors
- **Error Context**: Detailed error logging with stack traces
- **Fallback Actions**: Define fallback actions on failure
- **Notifications**: Alert on critical failures

## REST API

### Endpoints

#### List Workflows
**GET** `/api/workflows`

Query Parameters:
- `status` - Filter by status (active, inactive, draft)
- `table_id` - Filter by table
- `search` - Search in name/description
- `page` - Page number (default: 1)
- `limit` - Results per page (default: 20)

#### Create Workflow
**POST** `/api/workflows`

Request Body:
```json
{
  "name": "Order Processing",
  "description": "Automate order fulfillment",
  "trigger": {...},
  "conditions": {...},
  "actions": [...]
}
```

#### Update Workflow
**PUT** `/api/workflows/:id`

Updates workflow configuration.

#### Delete Workflow
**DELETE** `/api/workflows/:id`

Soft deletes workflow (sets status to 'deleted').

#### Execute Workflow
**POST** `/api/workflows/:id/execute`

Manually trigger workflow execution.

Request Body:
```json
{
  "triggerData": {
    "recordId": "record_uuid",
    "userId": "user_uuid"
  }
}
```

#### Get Execution History
**GET** `/api/workflows/:id/runs`

Query Parameters:
- `status` - Filter by run status
- `start_date` - Filter by date range
- `end_date` - Filter by date range

#### Get Execution Logs
**GET** `/api/workflows/runs/:runId/logs`

Returns detailed step-by-step execution logs.

#### Webhook Endpoint
**POST** `/api/workflows/webhook/:webhookId`

Receives webhook triggers.

#### Statistics Overview
**GET** `/api/workflows/stats/overview`

Returns workflow execution statistics.

## WebSocket Events

### Outbound Events

#### `workflow:started`
```json
{
  "workflowId": "workflow_uuid",
  "runId": "run_uuid",
  "trigger": {...}
}
```

#### `workflow:completed`
```json
{
  "workflowId": "workflow_uuid",
  "runId": "run_uuid",
  "status": "completed",
  "duration": 1234
}
```

#### `workflow:failed`
```json
{
  "workflowId": "workflow_uuid",
  "runId": "run_uuid",
  "error": "Error message"
}
```

## Usage Examples

### Example 1: Auto-Assignment Workflow
```json
{
  "name": "Auto-assign Support Tickets",
  "trigger": {
    "type": "record_change",
    "config": {
      "tableId": "support_tickets",
      "includeFields": ["status"]
    }
  },
  "conditions": {
    "type": "and",
    "conditions": [
      {
        "type": "field_condition",
        "field": "status",
        "operator": "equals",
        "value": "new"
      },
      {
        "type": "field_condition",
        "field": "priority",
        "operator": "in",
        "value": ["high", "critical"]
      }
    ]
  },
  "actions": [
    {
      "type": "update_field",
      "config": {
        "tableId": "support_tickets",
        "recordId": "{{trigger.recordId}}",
        "updates": {
          "assignee": "senior_support@company.com",
          "status": "assigned"
        }
      }
    },
    {
      "type": "send_notification",
      "config": {
        "channel": "email",
        "recipient": "senior_support@company.com",
        "subject": "High Priority Ticket: {{current.title}}",
        "message": "A high priority ticket needs your attention."
      }
    }
  ]
}
```

### Example 2: Data Sync Workflow
```json
{
  "name": "Sync to External CRM",
  "trigger": {
    "type": "field_update",
    "config": {
      "tableId": "customers",
      "field": "status",
      "condition": {
        "operator": "changed_to",
        "value": "active"
      }
    }
  },
  "actions": [
    {
      "type": "call_api",
      "config": {
        "url": "https://api.crm.com/customers",
        "method": "POST",
        "headers": {
          "Authorization": "Bearer {{env.CRM_API_KEY}}",
          "Content-Type": "application/json"
        },
        "body": {
          "external_id": "{{current.id}}",
          "name": "{{current.name}}",
          "email": "{{current.email}}",
          "status": "active"
        }
      }
    },
    {
      "type": "update_field",
      "config": {
        "tableId": "customers",
        "recordId": "{{trigger.recordId}}",
        "updates": {
          "synced_to_crm": true,
          "sync_timestamp": "{{meta.timestamp}}"
        }
      }
    }
  ]
}
```

## Performance Optimization

### Caching Strategy
- Workflow definitions cached for 5 minutes
- Template compilation cached
- Database connection pooling

### Database Optimization
- Indexes on frequently queried columns
- JSONB GIN indexes for condition matching
- Partitioning for large log tables

### Monitoring
- Execution time tracking per action
- Queue depth monitoring
- Success/failure rate metrics
- Performance dashboards via `/metrics/prom`

## Security Considerations

### Authentication
- JWT-based authentication required
- Webhook signatures for external triggers
- API key rotation support

### Authorization
- Role-based workflow creation
- Table-level permissions checked
- Action-level permission validation

### Data Protection
- Sensitive data masking in logs
- Encrypted storage for API keys
- Audit trail for all executions

## Testing

### Unit Tests
```bash
# Run workflow tests
pnpm test tests/unit/workflows.test.ts

# Test coverage
pnpm test:coverage
```

### Integration Testing
```bash
# Test complete workflow execution
pnpm test:integration tests/workflows

# Load testing
pnpm test:load --workflows 100 --concurrent 10
```

## Troubleshooting

### Common Issues

1. **Workflow not triggering**
   - Check trigger configuration
   - Verify workflow status is 'active'
   - Check database connectivity
   - Review error logs

2. **Action failing**
   - Validate action configuration
   - Check permissions
   - Verify external API availability
   - Review retry logs

3. **Performance issues**
   - Check queue depth
   - Review concurrent execution limits
   - Optimize conditions and queries
   - Consider action parallelization

## Future Enhancements

### Planned Features
- Visual workflow designer UI
- Conditional branching (if/else)
- Loops and iterations
- Human approval steps
- Workflow versioning
- A/B testing for workflows
- Custom action plugins
- Workflow marketplace
- Advanced scheduling (cron expressions)
- Workflow templates library

### Performance Improvements
- Redis queue for better scalability
- Distributed execution across workers
- Workflow compilation for faster execution
- Intelligent caching strategies

## Configuration

### Environment Variables
```env
# Workflow engine settings
WORKFLOW_MAX_CONCURRENT=5
WORKFLOW_RETRY_DELAY=1000
WORKFLOW_MAX_RETRIES=3
WORKFLOW_QUEUE_SIZE=100

# External service timeouts
API_CALL_TIMEOUT=30000
WEBHOOK_TIMEOUT=10000

# Feature flags
ENABLE_WORKFLOW_ENGINE=true
ENABLE_WORKFLOW_WEBHOOKS=true
```

### Server Integration
The workflow engine automatically initializes when the server starts:
```typescript
// In server startup
await workflowEngine.initialize()

// Graceful shutdown
await workflowEngine.shutdown()
```