# API Gateway and Rate Limiting System

## Overview

The API Gateway provides a centralized entry point for all API requests with built-in rate limiting, circuit breaking, authentication, caching, and request/response transformation capabilities.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 API Gateway                      │
│                                                  │
│  ┌────────────┐  ┌────────────┐  ┌───────────┐ │
│  │   CORS     │→ │   Auth     │→ │   Rate    │ │
│  │ Middleware │  │ Middleware │  │  Limiter  │ │
│  └────────────┘  └────────────┘  └───────────┘ │
│         ↓               ↓              ↓        │
│  ┌────────────┐  ┌────────────┐  ┌───────────┐ │
│  │ Validation │→ │   Cache    │→ │  Circuit  │ │
│  │            │  │            │  │  Breaker  │ │
│  └────────────┘  └────────────┘  └───────────┘ │
│                        ↓                        │
│               ┌─────────────────┐              │
│               │    Handlers     │              │
│               │   or Proxies    │              │
│               └─────────────────┘              │
└─────────────────────────────────────────────────┘
```

## Core Components

### 1. APIGateway
Main orchestrator that:
- Manages endpoint registration
- Coordinates middleware chain
- Handles request routing
- Collects metrics
- Manages cache

### 2. RateLimiter
Controls request rates with:
- Sliding window algorithm
- Per-user/IP/API key limits
- Dynamic request weighting
- Distributed state (Redis support)

### 3. CircuitBreaker
Prevents cascading failures:
- Three states: Closed, Open, Half-Open
- Automatic recovery
- Latency tracking
- Error threshold monitoring

## Quick Start

### Basic Setup

```typescript
import { createGateway } from '@metasheet/core-backend/gateway'
import express from 'express'

const app = express()

// Create gateway with moderate preset
const gateway = createGateway(app, 'moderate')

// Register a simple endpoint
gateway.registerEndpoint({
  path: '/hello',
  method: 'GET',
  handler: (req, res) => {
    res.json({ message: 'Hello World' })
  }
})
```

### With Custom Configuration

```typescript
const gateway = new APIGateway(app, {
  basePath: '/api/v1',
  defaultRateLimit: {
    windowMs: 60000,      // 1 minute
    maxRequests: 100      // 100 requests per minute
  },
  enableCircuitBreaker: true,
  enableMetrics: true,
  enableCors: true,
  corsOptions: {
    origin: ['https://app.example.com'],
    credentials: true
  },
  timeout: 10000,         // 10 seconds
  retries: 3
})
```

## Endpoint Registration

### Basic Endpoint

```typescript
gateway.registerEndpoint({
  path: '/users',
  method: 'GET',
  handler: async (req, res) => {
    const users = await db.users.findAll()
    res.json(users)
  }
})
```

### Protected Endpoint

```typescript
gateway.registerEndpoint({
  path: '/admin/users',
  method: 'POST',
  authentication: 'jwt',
  authorization: ['admin'],
  validation: {
    body: {
      email: { type: 'string', required: true, pattern: '^[\\w@.]+$' },
      name: { type: 'string', required: true, minLength: 2 },
      role: { type: 'string', enum: ['user', 'admin'] }
    }
  },
  handler: async (req, res) => {
    const user = await db.users.create(req.body)
    res.json(user)
  }
})
```

### Cached Endpoint

```typescript
gateway.registerEndpoint({
  path: '/products/:id',
  method: 'GET',
  cache: {
    enabled: true,
    ttl: 300,  // 5 minutes
    keyGenerator: (req) => `product:${req.params.id}`
  },
  handler: async (req, res) => {
    const product = await db.products.findById(req.params.id)
    res.json(product)
  }
})
```

### Proxied Endpoint

```typescript
gateway.registerEndpoint({
  path: '/external/weather',
  method: 'GET',
  upstream: 'https://api.weather.com',
  rateLimits: {
    windowMs: 60000,
    maxRequests: 10
  },
  circuitBreaker: true,
  timeout: 5000
})
```

## Rate Limiting

### Global Rate Limiting

```typescript
import { createModerateRateLimiter } from '@metasheet/core-backend/gateway'

// Apply to all routes
app.use(createModerateRateLimiter().middleware())
```

### Per-Endpoint Rate Limiting

```typescript
gateway.registerEndpoint({
  path: '/api/expensive-operation',
  method: 'POST',
  rateLimits: {
    windowMs: 60000,        // 1 minute window
    maxRequests: 5,         // 5 requests per window
    keyGenerator: (req) => {
      // Rate limit by user ID
      return req.user?.id || req.ip
    },
    skipSuccessfulRequests: false,
    standardHeaders: true,  // Return RateLimit headers
    handler: (req, res) => {
      res.status(429).json({
        error: 'Too many requests',
        retryAfter: req.rateLimit.retryAfter
      })
    }
  },
  handler: async (req, res) => {
    // Expensive operation
  }
})
```

### Dynamic Request Weighting

```typescript
gateway.registerEndpoint({
  path: '/api/search',
  method: 'GET',
  rateLimits: {
    windowMs: 60000,
    maxRequests: 100,
    weight: (req) => {
      // Complex queries cost more
      const query = req.query.q as string
      return query.length > 100 ? 5 : 1
    }
  },
  handler: searchHandler
})
```

### Redis Store for Distributed Rate Limiting

```typescript
import { RedisRateLimitStore } from '@metasheet/core-backend/gateway'
import Redis from 'ioredis'

const redis = new Redis()

gateway.registerEndpoint({
  path: '/api/data',
  method: 'GET',
  rateLimits: {
    windowMs: 60000,
    maxRequests: 100,
    store: new RedisRateLimitStore(redis)
  },
  handler: dataHandler
})
```

## Circuit Breaking

### Basic Circuit Breaker

```typescript
gateway.registerEndpoint({
  path: '/api/external-service',
  method: 'GET',
  circuitBreaker: true,  // Uses default configuration
  handler: async (req, res) => {
    const data = await callExternalService()
    res.json(data)
  }
})
```

### Custom Circuit Breaker Configuration

```typescript
import { CircuitBreaker } from '@metasheet/core-backend/gateway'

const breaker = new CircuitBreaker({
  timeout: 5000,           // 5 second timeout
  errorThreshold: 50,      // Open at 50% error rate
  resetTimeout: 30000,     // Try again after 30 seconds
  volumeThreshold: 10,     // Need 10 requests minimum
  halfOpenRequests: 3      // Allow 3 requests in half-open state
})

// Use directly
const result = await breaker.execute(async () => {
  return await riskyOperation()
})

// Monitor state
breaker.on('stateChange', ({ from, to }) => {
  console.log(`Circuit breaker: ${from} -> ${to}`)
})

breaker.on('shortCircuit', () => {
  console.log('Request rejected by circuit breaker')
})
```

## Authentication & Authorization

### JWT Authentication

```typescript
gateway.registerEndpoint({
  path: '/api/protected',
  method: 'GET',
  authentication: 'jwt',
  handler: (req, res) => {
    res.json({ user: req.user })
  }
})
```

### API Key Authentication

```typescript
gateway.registerEndpoint({
  path: '/api/data',
  method: 'GET',
  authentication: 'api-key',
  handler: (req, res) => {
    res.json({ data: 'protected data' })
  }
})
```

### Role-Based Authorization

```typescript
gateway.registerEndpoint({
  path: '/api/admin/settings',
  method: 'PUT',
  authentication: 'jwt',
  authorization: ['admin', 'super-admin'],
  handler: updateSettings
})
```

## Request Validation

### Schema-Based Validation

```typescript
gateway.registerEndpoint({
  path: '/api/users',
  method: 'POST',
  validation: {
    body: {
      email: {
        type: 'string',
        required: true,
        pattern: '^[^@]+@[^@]+\\.[^@]+$'
      },
      age: {
        type: 'number',
        min: 18,
        max: 120
      },
      roles: {
        type: 'array',
        minLength: 1,
        items: {
          enum: ['user', 'admin', 'moderator']
        }
      }
    },
    query: {
      limit: {
        type: 'number',
        min: 1,
        max: 100
      }
    }
  },
  handler: createUser
})
```

## Caching

### Simple Caching

```typescript
gateway.registerEndpoint({
  path: '/api/config',
  method: 'GET',
  cache: {
    enabled: true,
    ttl: 3600  // 1 hour
  },
  handler: getConfig
})
```

### Custom Cache Key

```typescript
gateway.registerEndpoint({
  path: '/api/search',
  method: 'GET',
  cache: {
    enabled: true,
    ttl: 300,
    keyGenerator: (req) => {
      const { q, page = 1, limit = 10 } = req.query
      return `search:${q}:${page}:${limit}`
    }
  },
  handler: searchHandler
})
```

### Cache Invalidation

```typescript
// Clear specific cache pattern
gateway.clearCache('search:*')

// Clear all cache
gateway.clearCache()
```

## Versioning

### Version in Path

```typescript
// Register versioned endpoint
gateway.registerVersionedEndpoint({
  path: '/users',
  method: 'GET',
  handler: getUsersV2
}, '2')

// Results in: /v2/users
```

### Multiple Versions

```typescript
const v1Handler = (req, res) => res.json({ version: 1 })
const v2Handler = (req, res) => res.json({ version: 2 })

gateway.registerEndpoint({
  path: '/v1/api/data',
  method: 'GET',
  handler: v1Handler,
  deprecated: true
})

gateway.registerEndpoint({
  path: '/v2/api/data',
  method: 'GET',
  handler: v2Handler
})
```

## Metrics & Monitoring

### Getting Metrics

```typescript
const metrics = gateway.getMetrics()

console.log('Total requests:', metrics.totalRequests)
console.log('Success rate:',
  (metrics.successfulRequests / metrics.totalRequests * 100).toFixed(2) + '%')
console.log('Average response time:', metrics.averageResponseTime + 'ms')

// Per-endpoint metrics
metrics.endpoints.forEach((stats, endpoint) => {
  console.log(`${endpoint}:`, {
    requests: stats.requests,
    averageTime: stats.averageTime,
    errorRate: ((stats.failures / stats.requests) * 100).toFixed(2) + '%'
  })
})
```

### Event Monitoring

```typescript
gateway.on('request', (data) => {
  console.log('Request:', data.method, data.path)
})

gateway.on('response', (data) => {
  console.log('Response:', data.statusCode, data.duration + 'ms')
})

gateway.on('endpointRegistered', (endpoint) => {
  console.log('New endpoint:', endpoint.method, endpoint.path)
})

gateway.on('proxyError', ({ endpoint, error }) => {
  console.error('Proxy failed:', endpoint.path, error)
})
```

## CRUD Helpers

### Auto-generate CRUD Endpoints

```typescript
import { createCRUDEndpoints } from '@metasheet/core-backend/gateway'

// Generate all CRUD endpoints for a resource
const userEndpoints = createCRUDEndpoints('users', {
  authentication: 'jwt',
  authorization: ['admin'],
  cache: true,
  rateLimit: 100
})

gateway.registerEndpoints(userEndpoints)
```

This generates:
- `GET /users` - List all users (cached)
- `GET /users/:id` - Get specific user (cached)
- `POST /users` - Create user
- `PUT /users/:id` - Update user
- `PATCH /users/:id` - Partially update user
- `DELETE /users/:id` - Delete user (admin only)

## Presets

### Using Presets

```typescript
import { createGateway, GATEWAY_PRESETS } from '@metasheet/core-backend/gateway'

// Strict preset (10 req/min, circuit breaker, 5s timeout)
const strictGateway = createGateway(app, 'strict')

// Moderate preset (60 req/min, circuit breaker, 10s timeout)
const moderateGateway = createGateway(app, 'moderate')

// Relaxed preset (200 req/min, no circuit breaker, 30s timeout)
const relaxedGateway = createGateway(app, 'relaxed')

// Custom configuration based on preset
const customGateway = createGateway(app, {
  ...GATEWAY_PRESETS.moderate,
  basePath: '/api/v2'
})
```

## Best Practices

1. **Use appropriate rate limits**: Set limits based on actual usage patterns
2. **Enable circuit breakers**: For external service calls
3. **Cache strategically**: Cache expensive, rarely-changing data
4. **Validate inputs**: Always validate request data
5. **Monitor metrics**: Track performance and errors
6. **Version APIs**: Use versioning for breaking changes
7. **Document endpoints**: Provide clear descriptions
8. **Handle errors gracefully**: Return appropriate status codes
9. **Use request IDs**: For tracing and debugging
10. **Test rate limits**: Ensure limits work as expected

## Troubleshooting

### Rate Limit Not Working

Check:
- Key generator returning unique values
- Store configured correctly (Redis connected)
- Window size and max requests set appropriately

### Circuit Breaker Always Open

Check:
- Error threshold not too low
- Reset timeout not too long
- Actual error rate in metrics

### Cache Not Working

Check:
- Cache enabled for endpoint
- TTL value reasonable
- Cache key generator working
- Only caching GET requests

### Authentication Failing

Check:
- Token/API key present in request
- Authentication type matches implementation
- JWT secret configured correctly

## Examples

See the `examples/gateway` directory for complete working examples:
- Basic API with rate limiting
- Microservice gateway with circuit breaking
- Cached API with invalidation
- Multi-version API
- Authenticated API with roles