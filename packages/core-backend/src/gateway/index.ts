export * from './APIGateway'
export * from './RateLimiter'
export * from './CircuitBreaker'

import type { Application } from 'express'
import type { APIEndpoint, GatewayConfig } from './APIGateway';
import { APIGateway } from './APIGateway'
import { Logger } from '../core/logger'

const logger = new Logger('Gateway')
import {
  createStrictRateLimiter,
  createModerateRateLimiter,
  createRelaxedRateLimiter,
  createApiRateLimiter,
  createUserRateLimiter
} from './RateLimiter'

// Preset configurations for common use cases
export const GATEWAY_PRESETS = {
  strict: {
    defaultRateLimit: {
      windowMs: 60000,
      maxRequests: 10
    },
    enableCircuitBreaker: true,
    timeout: 5000,
    retries: 1
  },
  moderate: {
    defaultRateLimit: {
      windowMs: 60000,
      maxRequests: 60
    },
    enableCircuitBreaker: true,
    timeout: 10000,
    retries: 2
  },
  relaxed: {
    defaultRateLimit: {
      windowMs: 60000,
      maxRequests: 200
    },
    enableCircuitBreaker: false,
    timeout: 30000,
    retries: 3
  }
} as const

// Helper to create gateway with preset
export function createGateway(
  app: Application,
  preset: keyof typeof GATEWAY_PRESETS | GatewayConfig = 'moderate'
): APIGateway {
  const config = typeof preset === 'string' ? GATEWAY_PRESETS[preset] : preset
  return new APIGateway(app, config)
}

// Endpoint templates
export const ENDPOINT_TEMPLATES = {
  publicRead: {
    method: 'GET',
    authentication: 'none',
    rateLimits: {
      windowMs: 60000,
      maxRequests: 100
    },
    cache: {
      enabled: true,
      ttl: 300
    }
  },
  publicWrite: {
    method: 'POST',
    authentication: 'none',
    rateLimits: {
      windowMs: 60000,
      maxRequests: 10
    },
    circuitBreaker: true
  },
  authenticatedRead: {
    method: 'GET',
    authentication: 'jwt',
    rateLimits: {
      windowMs: 60000,
      maxRequests: 200
    },
    cache: {
      enabled: true,
      ttl: 60
    }
  },
  authenticatedWrite: {
    method: 'POST',
    authentication: 'jwt',
    rateLimits: {
      windowMs: 60000,
      maxRequests: 50
    },
    circuitBreaker: true
  },
  adminEndpoint: {
    method: 'POST',
    authentication: 'jwt',
    authorization: ['admin'],
    rateLimits: {
      windowMs: 60000,
      maxRequests: 20
    }
  }
} as const

// Common endpoint patterns
export function createCRUDEndpoints(
  resource: string,
  options: {
    authentication?: 'jwt' | 'api-key' | 'none'
    authorization?: string[]
    cache?: boolean
    rateLimit?: number
  } = {}
): APIEndpoint[] {
  const base = {
    authentication: options.authentication || 'jwt',
    authorization: options.authorization,
    rateLimits: {
      windowMs: 60000,
      maxRequests: options.rateLimit || 100
    }
  }

  return [
    // List
    {
      ...base,
      path: `/${resource}`,
      method: 'GET',
      cache: options.cache ? { enabled: true, ttl: 60 } : undefined,
      description: `List all ${resource}`
    },
    // Get
    {
      ...base,
      path: `/${resource}/:id`,
      method: 'GET',
      cache: options.cache ? { enabled: true, ttl: 300 } : undefined,
      description: `Get a specific ${resource}`
    },
    // Create
    {
      ...base,
      path: `/${resource}`,
      method: 'POST',
      circuitBreaker: true,
      description: `Create a new ${resource}`
    },
    // Update
    {
      ...base,
      path: `/${resource}/:id`,
      method: 'PUT',
      circuitBreaker: true,
      description: `Update a ${resource}`
    },
    // Patch
    {
      ...base,
      path: `/${resource}/:id`,
      method: 'PATCH',
      circuitBreaker: true,
      description: `Partially update a ${resource}`
    },
    // Delete
    {
      ...base,
      path: `/${resource}/:id`,
      method: 'DELETE',
      authorization: options.authorization || ['admin'],
      rateLimits: {
        windowMs: 60000,
        maxRequests: 10
      },
      description: `Delete a ${resource}`
    }
  ] as APIEndpoint[]
}

// Utility for bulk endpoint registration
export function registerBulkEndpoints(
  gateway: APIGateway,
  endpoints: Record<string, APIEndpoint[]>
): void {
  for (const [category, endpointList] of Object.entries(endpoints)) {
    logger.debug(`Registering ${endpointList.length} endpoints for ${category}`)
    gateway.registerEndpoints(endpointList)
  }
}

// Rate limiter factories
export const rateLimiters = {
  strict: createStrictRateLimiter,
  moderate: createModerateRateLimiter,
  relaxed: createRelaxedRateLimiter,
  api: createApiRateLimiter,
  user: createUserRateLimiter
}

// Re-export commonly used types
export type {
  APIEndpoint,
  GatewayConfig,
  ValidationSchema,
  CacheConfig
} from './APIGateway'

export type { RateLimitConfig } from './RateLimiter'
export { CircuitState } from './CircuitBreaker'
export type { CircuitBreakerConfig } from './CircuitBreaker'