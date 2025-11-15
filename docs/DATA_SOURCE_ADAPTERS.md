# External Data Source Adapters

## Overview

The Data Source Adapter system provides a unified interface for connecting to and querying multiple types of external data sources including relational databases (PostgreSQL, MySQL), NoSQL databases (MongoDB), and HTTP/REST APIs.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  DataSourceManager                    │
│  - Manages multiple adapters                         │
│  - Routes queries to appropriate adapter             │
│  - Handles connection pooling                        │
│  - Provides federated query capabilities             │
└─────────────────────────┬───────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
┌───────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
│ PostgreSQL   │  │   MySQL     │  │   MongoDB   │
│   Adapter    │  │   Adapter   │  │   Adapter   │
└──────────────┘  └─────────────┘  └─────────────┘
        │                 │                 │
┌───────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
│   HTTP/API   │  │   GraphQL   │  │   Custom    │
│   Adapter    │  │   Adapter   │  │   Adapter   │
└──────────────┘  └─────────────┘  └─────────────┘
```

## Core Components

### 1. BaseDataAdapter

Abstract base class that defines the standard interface for all adapters:

```typescript
export abstract class BaseDataAdapter extends EventEmitter {
  // Connection management
  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract testConnection(): Promise<boolean>

  // Query operations
  abstract query<T>(sql: string, params?: any[]): Promise<QueryResult<T>>
  abstract select<T>(table: string, options?: QueryOptions): Promise<QueryResult<T>>
  abstract insert<T>(table: string, data: any): Promise<QueryResult<T>>
  abstract update<T>(table: string, data: any, where: any): Promise<QueryResult<T>>
  abstract delete<T>(table: string, where: any): Promise<QueryResult<T>>

  // Schema operations
  abstract getSchema(schema?: string): Promise<SchemaInfo>
  abstract getTableInfo(table: string): Promise<TableInfo>

  // Transaction support
  abstract beginTransaction(): Promise<any>
  abstract commit(transaction: any): Promise<void>
  abstract rollback(transaction: any): Promise<void>
}
```

### 2. DataSourceManager

Central management system for all data source adapters:

- **Adapter Registration**: Register custom adapter types
- **Connection Management**: Handle connect/disconnect/reconnect
- **Query Routing**: Route queries to appropriate adapters
- **Federation**: Execute queries across multiple data sources
- **Health Monitoring**: Track adapter health and performance

### 3. Built-in Adapters

#### PostgreSQL Adapter
- Full SQL support with parameterized queries
- Transaction support with isolation levels
- Streaming support for large result sets
- Connection pooling with pg library

#### MySQL Adapter
- MySQL/MariaDB compatibility
- Prepared statements for security
- Batch insert optimization
- Connection pool management

#### MongoDB Adapter
- Aggregation pipeline support
- Document-based operations
- GridFS for large files
- Session-based transactions

#### HTTP Adapter
- RESTful API integration
- Authentication support (API Key, Bearer, Basic)
- Request/response transformation
- Pagination handling
- Batch request support

## Usage Examples

### Basic Setup

```typescript
import { DataSourceManager } from './data-adapters/DataSourceManager'

const manager = new DataSourceManager()

// Add PostgreSQL data source
await manager.addDataSource({
  id: 'main-db',
  name: 'Main Database',
  type: 'postgresql',
  connection: {
    host: 'localhost',
    port: 5432,
    database: 'myapp'
  },
  credentials: {
    username: 'user',
    password: 'password'
  },
  poolConfig: {
    min: 2,
    max: 20
  }
})

// Add HTTP API data source
await manager.addDataSource({
  id: 'api-source',
  name: 'External API',
  type: 'http',
  connection: {
    baseURL: 'https://api.example.com'
  },
  credentials: {
    apiKey: 'your-api-key'
  }
})
```

### Executing Queries

```typescript
// Simple select
const users = await manager.select('main-db', 'users', {
  where: { active: true },
  orderBy: [{ column: 'created_at', direction: 'desc' }],
  limit: 10
})

// Raw SQL query
const results = await manager.query(
  'main-db',
  'SELECT * FROM orders WHERE total > $1',
  [1000]
)

// HTTP API call
const apiData = await manager.select('api-source', '/users', {
  params: { page: 1, limit: 20 }
})
```

### Cross-Database Operations

```typescript
// Copy data between databases
const result = await manager.copyData(
  'source-db',
  'users',
  'target-db',
  'imported_users',
  {
    where: { created_at: { $gte: '2024-01-01' } },
    batchSize: 1000,
    transform: (row) => ({
      ...row,
      imported_at: new Date()
    })
  }
)

// Federated query across multiple databases
const federatedResults = await manager.federatedQuery([
  {
    dataSourceId: 'db1',
    sql: 'SELECT id, name FROM users',
    alias: 'users'
  },
  {
    dataSourceId: 'db2',
    sql: 'SELECT user_id, order_total FROM orders',
    alias: 'orders'
  }
], (results) => {
  // Custom join logic
  const users = results.get('users')
  const orders = results.get('orders')
  return joinUserOrders(users, orders)
})
```

### Streaming Large Results

```typescript
const adapter = manager.getDataSource('main-db')

for await (const row of adapter.stream('SELECT * FROM large_table')) {
  // Process each row
  await processRow(row)
}
```

### Transaction Support

```typescript
const adapter = manager.getDataSource('main-db')
const transaction = await adapter.beginTransaction()

try {
  await adapter.query('INSERT INTO logs ...', [], transaction)
  await adapter.query('UPDATE stats ...', [], transaction)
  await adapter.commit(transaction)
} catch (error) {
  await adapter.rollback(transaction)
  throw error
}
```

## Configuration

### Connection Configuration

```typescript
interface DataSourceConfig {
  id: string
  name: string
  type: string
  connection: {
    host?: string
    port?: number
    database?: string
    baseURL?: string    // For HTTP
    uri?: string        // For MongoDB
    ssl?: boolean | object
  }
  credentials?: {
    username?: string
    password?: string
    apiKey?: string
    bearerToken?: string
  }
  poolConfig?: {
    min?: number
    max?: number
    idleTimeout?: number
    acquireTimeout?: number
  }
  options?: Record<string, any>
}
```

### Query Options

```typescript
interface QueryOptions {
  limit?: number
  offset?: number
  orderBy?: Array<{
    column: string
    direction: 'asc' | 'desc'
  }>
  where?: Record<string, any>
  select?: string[]
  joins?: Array<{
    table: string
    on: string
    type?: 'inner' | 'left' | 'right' | 'full'
  }>
}
```

## Database Schema

The system uses several tables to persist configuration and track usage:

- **data_sources**: Store data source configurations
- **data_source_schemas**: Cache schema information
- **query_templates**: Reusable query templates
- **query_history**: Query execution history
- **data_sync_jobs**: Scheduled synchronization jobs
- **connection_metrics**: Connection pool and performance metrics

## Security Considerations

1. **Credential Storage**: Credentials are encrypted using AES-256-GCM
2. **SQL Injection**: All adapters use parameterized queries
3. **Connection Security**: SSL/TLS support for all database connections
4. **API Authentication**: Multiple auth methods (API Key, OAuth, JWT)
5. **Query Sanitization**: Automatic identifier escaping and validation

## Performance Optimization

1. **Connection Pooling**: Reuse connections to reduce overhead
2. **Query Caching**: Optional result caching with TTL
3. **Batch Operations**: Efficient bulk insert/update
4. **Streaming**: Memory-efficient processing of large datasets
5. **Parallel Execution**: Concurrent query execution where possible

## Monitoring and Metrics

The system tracks:
- Connection pool utilization
- Query execution times
- Error rates and types
- Data synchronization status
- API response times

## Extending the System

### Creating a Custom Adapter

```typescript
import { BaseDataAdapter } from './BaseAdapter'

export class CustomAdapter extends BaseDataAdapter {
  async connect(): Promise<void> {
    // Implementation
  }

  async query<T>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    // Implementation
  }

  // Implement other abstract methods
}

// Register with manager
manager.registerAdapterType('custom', CustomAdapter)
```

## Error Handling

The system provides comprehensive error handling:

```typescript
try {
  const result = await manager.query('db-id', 'SELECT ...')
} catch (error) {
  if (error instanceof ConnectionError) {
    // Handle connection issues
  } else if (error instanceof QueryError) {
    // Handle query errors
  }
}
```

## Future Enhancements

- [ ] GraphQL adapter
- [ ] Redis adapter
- [ ] Elasticsearch adapter
- [ ] S3/Object storage adapter
- [ ] Query result caching layer
- [ ] Visual query builder
- [ ] Performance profiler
- [ ] Automatic retry with exponential backoff