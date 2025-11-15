# Gantt Chart Plugin Documentation

## Overview
A comprehensive Gantt chart view plugin for MetaSheet, providing project timeline visualization with task dependencies, critical path analysis, and resource management capabilities.

## Architecture

### Plugin Structure
```
plugins/plugin-view-gantt/
├── plugin.json              # Plugin manifest
├── package.json             # Dependencies
├── tsconfig.json            # TypeScript configuration
├── src/
│   └── index.ts            # Main plugin implementation
└── dist/                   # Compiled output
```

### Database Schema

#### gantt_tasks Table
```sql
CREATE TABLE gantt_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id UUID NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  status VARCHAR(50) DEFAULT 'not_started',
  priority VARCHAR(20) DEFAULT 'medium',
  parent_id UUID REFERENCES gantt_tasks(id) ON DELETE CASCADE,
  assignee VARCHAR(255),
  color VARCHAR(7),
  is_milestone BOOLEAN DEFAULT false,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

#### gantt_dependencies Table
```sql
CREATE TABLE gantt_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_task_id UUID NOT NULL REFERENCES gantt_tasks(id) ON DELETE CASCADE,
  target_task_id UUID NOT NULL REFERENCES gantt_tasks(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL DEFAULT 'finish_to_start',
  lag_days INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_task_id, target_task_id)
);
```

## API Endpoints

### 1. Get Gantt View
**GET** `/api/gantt/:viewId`

Returns complete Gantt chart data including tasks and dependencies.

**Response:**
```json
{
  "ok": true,
  "data": {
    "view": {
      "id": "uuid",
      "name": "Project Timeline",
      "config": {
        "timeScale": "day",
        "showCriticalPath": true,
        "workingDays": [1, 2, 3, 4, 5]
      }
    },
    "tasks": [
      {
        "id": "task_uuid",
        "name": "Task Name",
        "start_date": "2025-01-24",
        "end_date": "2025-01-30",
        "progress": 50,
        "status": "in_progress",
        "priority": "high",
        "children": []
      }
    ],
    "dependencies": [
      {
        "id": "dep_uuid",
        "source": "task_1",
        "target": "task_2",
        "type": "finish_to_start",
        "lag": 0
      }
    ]
  }
}
```

### 2. Create Task
**POST** `/api/gantt/:viewId/tasks`

Creates a new task in the Gantt chart.

**Request Body:**
```json
{
  "name": "New Task",
  "start_date": "2025-01-24",
  "end_date": "2025-01-30",
  "assignee": "john@example.com",
  "parent_id": null,
  "is_milestone": false
}
```

### 3. Update Task
**PUT** `/api/gantt/:viewId/tasks/:taskId`

Updates task properties including dates, progress, and status.

**Request Body:**
```json
{
  "name": "Updated Task",
  "progress": 75,
  "status": "in_progress",
  "end_date": "2025-02-01"
}
```

### 4. Delete Task
**DELETE** `/api/gantt/:viewId/tasks/:taskId`

Deletes a task and all its dependencies.

### 5. Create Dependency
**POST** `/api/gantt/:viewId/dependencies`

Creates a dependency between two tasks.

**Request Body:**
```json
{
  "source_task_id": "task_1_uuid",
  "target_task_id": "task_2_uuid",
  "type": "finish_to_start",
  "lag_days": 2
}
```

### 6. Calculate Critical Path
**GET** `/api/gantt/:viewId/critical-path`

Calculates and returns the critical path for the project.

**Response:**
```json
{
  "ok": true,
  "data": {
    "critical_path": ["task_1", "task_3", "task_7"],
    "total_duration": 45,
    "start_date": "2025-01-24",
    "end_date": "2025-03-10"
  }
}
```

## Plugin Features

### Task Management
- **Hierarchical Structure**: Support for parent-child task relationships
- **Progress Tracking**: 0-100% completion tracking
- **Status Management**: Multiple status states (not_started, in_progress, completed, etc.)
- **Priority Levels**: low, medium, high, critical
- **Milestones**: Special zero-duration milestone tasks
- **Resource Assignment**: Assignee tracking for resource management

### Dependency System
- **Dependency Types**:
  - Finish-to-Start (FS): Default, successor starts after predecessor finishes
  - Start-to-Start (SS): Tasks start simultaneously
  - Finish-to-Finish (FF): Tasks finish simultaneously
  - Start-to-Finish (SF): Successor finishes after predecessor starts
- **Lag Time**: Configurable delay between dependent tasks
- **Circular Dependency Prevention**: Automatic validation to prevent loops
- **Cascade Updates**: Automatic date adjustment when dependencies change

### Critical Path Analysis
- **Algorithm**: Forward and backward pass calculation
- **Slack Time**: Identifies tasks with float time
- **Real-time Updates**: Critical path recalculation on task changes
- **Visualization Ready**: Returns data for highlighting critical tasks

### Performance Optimizations
- **Caching**: 5-minute cache for view configurations
- **Batch Operations**: Bulk task updates in single transaction
- **Indexed Queries**: Database indexes on frequently queried columns
- **Lazy Loading**: Load task details on demand

## Configuration Options

The plugin supports extensive configuration through `views.config`:

```json
{
  "timeScale": "day",        // day, week, month, quarter, year
  "showCriticalPath": true,  // Highlight critical path
  "showProgress": true,      // Display progress bars
  "showDependencies": true,  // Draw dependency lines
  "workingDays": [1,2,3,4,5], // Monday to Friday
  "hoursPerDay": 8,          // Working hours per day
  "dateFormat": "YYYY-MM-DD", // Date display format
  "colors": {
    "critical": "#ff0000",
    "normal": "#0066cc",
    "milestone": "#ffaa00"
  }
}
```

## WebSocket Events

### Outbound Events

#### `gantt:taskUpdated`
Emitted when a task is modified.
```json
{
  "viewId": "view_uuid",
  "taskId": "task_uuid",
  "changes": {...},
  "userId": "user_uuid"
}
```

#### `gantt:dependencyCreated`
Emitted when a new dependency is created.
```json
{
  "viewId": "view_uuid",
  "dependency": {...},
  "affectedTasks": ["task_1", "task_2"]
}
```

#### `gantt:criticalPathChanged`
Emitted when the critical path changes.
```json
{
  "viewId": "view_uuid",
  "newPath": ["task_1", "task_3", "task_7"],
  "previousPath": ["task_1", "task_2", "task_7"]
}
```

## Integration with Core System

### Plugin Activation
The plugin activates when:
- A Gantt view is accessed (`onView:gantt`)
- The plugin loader initializes on server start

### Permissions Required
```json
"permissions": [
  "database.read",
  "database.write",
  "http.addRoute",
  "websocket.broadcast",
  "events.emit"
]
```

### Database Migrations
Run migrations to create Gantt tables:
```bash
pnpm run db:migrate
```

## Usage Example

### Creating a Gantt View
```typescript
// Create a new Gantt view for a project
const view = await createView({
  table_id: 'projects_table',
  type: 'gantt',
  name: 'Project Timeline',
  config: {
    timeScale: 'week',
    showCriticalPath: true,
    workingDays: [1, 2, 3, 4, 5]
  }
})

// Add tasks
const task1 = await createTask(view.id, {
  name: 'Project Planning',
  start_date: '2025-01-24',
  end_date: '2025-01-31',
  assignee: 'pm@company.com'
})

const task2 = await createTask(view.id, {
  name: 'Development Phase',
  start_date: '2025-02-01',
  end_date: '2025-02-28',
  parent_id: null
})

// Create dependency
await createDependency(view.id, {
  source_task_id: task1.id,
  target_task_id: task2.id,
  type: 'finish_to_start',
  lag_days: 0
})

// Calculate critical path
const { critical_path } = await calculateCriticalPath(view.id)
console.log('Critical tasks:', critical_path)
```

## Development

### Building the Plugin
```bash
cd plugins/plugin-view-gantt
pnpm install
pnpm run build
```

### Testing
```bash
# Run unit tests
pnpm test

# Test API endpoints
curl -X GET http://localhost:8900/api/gantt/test-view-id \
  -H "Authorization: Bearer $JWT_TOKEN"
```

### Hot Reload Development
```bash
# Watch mode for TypeScript
pnpm run dev

# Start MetaSheet with plugin
cd ../..
pnpm run dev:core
```

## Troubleshooting

### Common Issues

1. **Tasks not displaying**
   - Check database connection
   - Verify view_id exists
   - Ensure proper authentication

2. **Dependencies not working**
   - Verify both tasks exist
   - Check for circular dependencies
   - Ensure valid dependency type

3. **Critical path incorrect**
   - Check task dates are valid
   - Verify dependencies are correct
   - Ensure no orphaned tasks

## Future Enhancements

### Planned Features
- Resource leveling and allocation
- Baseline comparison
- Multiple dependency lag units (hours, days, weeks)
- Task templates and recurring tasks
- Export to MS Project / import from CSV
- Gantt chart PDF export
- Real-time collaboration cursors
- Undo/redo functionality
- Custom fields and formulas
- Integration with calendar view

### Performance Improvements
- Virtual scrolling for large projects
- Progressive loading for deep hierarchies
- WebWorker for critical path calculation
- GraphQL API for selective field queries

## API Rate Limits
- 100 requests per minute per user
- 1000 requests per hour per user
- Bulk operations count as single request

## Security Considerations
- SQL injection prevention via parameterized queries
- XSS protection on task names and descriptions
- CSRF protection via JWT tokens
- Row-level security for multi-tenant scenarios