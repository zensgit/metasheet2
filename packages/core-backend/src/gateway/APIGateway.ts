import { Application, Request, Response, NextFunction, Router } from 'express'
import { EventEmitter } from 'events'
import crypto from 'crypto'
import { RateLimiter, RateLimitConfig } from './RateLimiter'
import { CircuitBreaker } from './CircuitBreaker'

export interface APIEndpoint {
  path: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  handler?: (req: Request, res: Response, next: NextFunction) => void
  upstream?: string // URL for proxy
  rateLimits?: RateLimitConfig
  circuitBreaker?: boolean
  authentication?: AuthenticationType
  authorization?: string[] // Required roles/permissions
  validation?: ValidationSchema
  cache?: CacheConfig
  transform?: TransformConfig
  timeout?: number
  retries?: number
  version?: string
  deprecated?: boolean
  description?: string
}

export type AuthenticationType = 'jwt' | 'api-key' | 'oauth' | 'basic' | 'none'

export interface ValidationSchema {
  query?: Record<string, any>
  body?: Record<string, any>
  params?: Record<string, any>
  headers?: Record<string, any>
}

export interface CacheConfig {
  enabled: boolean
  ttl: number // seconds
  keyGenerator?: (req: Request) => string
  invalidateOn?: string[] // Event names that invalidate cache
}

export interface TransformConfig {
  request?: (req: Request) => Request | Promise<Request>
  response?: (data: any, req: Request) => any | Promise<any>
}

export interface GatewayConfig {
  basePath?: string
  defaultRateLimit?: RateLimitConfig
  enableCircuitBreaker?: boolean
  enableMetrics?: boolean
  enableLogging?: boolean
  enableCors?: boolean
  corsOptions?: CorsOptions
  timeout?: number
  retries?: number
}

export interface CorsOptions {
  origin?: string | string[] | ((origin: string) => boolean)
  methods?: string[]
  allowedHeaders?: string[]
  exposedHeaders?: string[]
  credentials?: boolean
  maxAge?: number
}

export interface APIMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  averageResponseTime: number
  endpoints: Map<string, EndpointMetrics>
}

export interface EndpointMetrics {
  requests: number
  successes: number
  failures: number
  totalTime: number
  averageTime: number
  lastAccess: Date
}

export class APIGateway extends EventEmitter {
  private app: Application
  private router: Router
  private config: Required<GatewayConfig>
  private endpoints: Map<string, APIEndpoint> = new Map()
  private rateLimiters: Map<string, RateLimiter> = new Map()
  private circuitBreakers: Map<string, CircuitBreaker> = new Map()
  private cache: Map<string, { data: any; expires: Date }> = new Map()
  private metrics: APIMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    endpoints: new Map()
  }

  constructor(app: Application, config: GatewayConfig = {}) {
    super()

    this.app = app
    this.router = Router()

    this.config = {
      basePath: config.basePath || '/api',
      defaultRateLimit: config.defaultRateLimit || {
        windowMs: 60000,
        maxRequests: 100
      },
      enableCircuitBreaker: config.enableCircuitBreaker !== false,
      enableMetrics: config.enableMetrics !== false,
      enableLogging: config.enableLogging !== false,
      enableCors: config.enableCors !== false,
      corsOptions: config.corsOptions || {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
        credentials: true
      },
      timeout: config.timeout || 30000,
      retries: config.retries || 3
    }

    this.setupMiddleware()
    this.setupCleanupTimer()
  }

  private setupMiddleware(): void {
    // CORS
    if (this.config.enableCors) {
      this.router.use(this.corsMiddleware())
    }

    // Request ID
    this.router.use(this.requestIdMiddleware())

    // Logging
    if (this.config.enableLogging) {
      this.router.use(this.loggingMiddleware())
    }

    // Metrics
    if (this.config.enableMetrics) {
      this.router.use(this.metricsMiddleware())
    }

    // Mount router
    this.app.use(this.config.basePath, this.router)
  }

  private corsMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const options = this.config.corsOptions!

      // Handle origin
      let origin = '*'
      if (typeof options.origin === 'function') {
        origin = options.origin(req.headers.origin || '') ? req.headers.origin! : ''
      } else if (Array.isArray(options.origin)) {
        origin = options.origin.includes(req.headers.origin || '') ? req.headers.origin! : ''
      } else if (options.origin) {
        origin = options.origin
      }

      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin)
      }

      // Other CORS headers
      if (options.credentials) {
        res.setHeader('Access-Control-Allow-Credentials', 'true')
      }
      if (options.methods) {
        res.setHeader('Access-Control-Allow-Methods', options.methods.join(','))
      }
      if (options.allowedHeaders) {
        res.setHeader('Access-Control-Allow-Headers', options.allowedHeaders.join(','))
      }
      if (options.exposedHeaders) {
        res.setHeader('Access-Control-Expose-Headers', options.exposedHeaders.join(','))
      }
      if (options.maxAge) {
        res.setHeader('Access-Control-Max-Age', options.maxAge.toString())
      }

      // Handle preflight
      if (req.method === 'OPTIONS') {
        return res.sendStatus(204)
      }

      next()
    }
  }

  private requestIdMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const requestId = req.headers['x-request-id']?.toString() ||
                        crypto.randomBytes(16).toString('hex')

      ;(req as any).requestId = requestId
      res.setHeader('X-Request-ID', requestId)

      next()
    }
  }

  private loggingMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now()
      const requestId = (req as any).requestId

      // Log request
      this.emit('request', {
        requestId,
        method: req.method,
        path: req.path,
        query: req.query,
        headers: req.headers,
        timestamp: new Date()
      })

      // Intercept response
      const originalSend = res.send
      res.send = function(data) {
        const duration = Date.now() - start

        // Log response
        this.emit('response', {
          requestId,
          statusCode: res.statusCode,
          duration,
          timestamp: new Date()
        })

        return originalSend.call(this, data)
      }.bind(this)

      next()
    }
  }

  private metricsMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now()
      const key = `${req.method}:${req.path}`

      this.metrics.totalRequests++

      // Get or create endpoint metrics
      let endpointMetrics = this.metrics.endpoints.get(key)
      if (!endpointMetrics) {
        endpointMetrics = {
          requests: 0,
          successes: 0,
          failures: 0,
          totalTime: 0,
          averageTime: 0,
          lastAccess: new Date()
        }
        this.metrics.endpoints.set(key, endpointMetrics)
      }

      endpointMetrics.requests++
      endpointMetrics.lastAccess = new Date()

      // Intercept response
      const originalSend = res.send
      res.send = function(data) {
        const duration = Date.now() - start

        if (res.statusCode < 400) {
          this.metrics.successfulRequests++
          endpointMetrics!.successes++
        } else {
          this.metrics.failedRequests++
          endpointMetrics!.failures++
        }

        endpointMetrics!.totalTime += duration
        endpointMetrics!.averageTime = endpointMetrics!.totalTime / endpointMetrics!.requests

        // Update global average
        this.metrics.averageResponseTime =
          (this.metrics.averageResponseTime * (this.metrics.totalRequests - 1) + duration) /
          this.metrics.totalRequests

        return originalSend.call(this, data)
      }.bind(this)

      next()
    }
  }

  registerEndpoint(endpoint: APIEndpoint): void {
    const key = `${endpoint.method}:${endpoint.path}`
    this.endpoints.set(key, endpoint)

    // Create rate limiter if needed
    if (endpoint.rateLimits) {
      this.rateLimiters.set(key, new RateLimiter(endpoint.rateLimits))
    }

    // Create circuit breaker if needed
    if (endpoint.circuitBreaker && this.config.enableCircuitBreaker) {
      this.circuitBreakers.set(key, new CircuitBreaker({
        timeout: endpoint.timeout || this.config.timeout,
        errorThreshold: 50,
        resetTimeout: 30000
      }))
    }

    // Build middleware chain
    const middlewares: any[] = []

    // Authentication
    if (endpoint.authentication && endpoint.authentication !== 'none') {
      middlewares.push(this.createAuthMiddleware(endpoint.authentication))
    }

    // Authorization
    if (endpoint.authorization) {
      middlewares.push(this.createAuthzMiddleware(endpoint.authorization))
    }

    // Rate limiting
    const rateLimiter = this.rateLimiters.get(key)
    if (rateLimiter) {
      middlewares.push(rateLimiter.middleware())
    }

    // Validation
    if (endpoint.validation) {
      middlewares.push(this.createValidationMiddleware(endpoint.validation))
    }

    // Cache
    if (endpoint.cache?.enabled) {
      middlewares.push(this.createCacheMiddleware(endpoint))
    }

    // Main handler
    const handler = endpoint.handler || this.createProxyHandler(endpoint)
    middlewares.push(this.wrapHandler(handler, endpoint))

    // Register route
    const method = endpoint.method.toLowerCase() as any
    this.router[method](endpoint.path, ...middlewares)

    this.emit('endpointRegistered', endpoint)
  }

  private createAuthMiddleware(type: AuthenticationType) {
    return (req: Request, res: Response, next: NextFunction) => {
      switch (type) {
        case 'jwt':
          // JWT validation (placeholder - integrate with existing JWT middleware)
          const token = req.headers.authorization?.replace('Bearer ', '')
          if (!token) {
            return res.status(401).json({ error: 'No token provided' })
          }
          // TODO: Validate JWT token
          next()
          break

        case 'api-key':
          const apiKey = req.headers['x-api-key']
          if (!apiKey) {
            return res.status(401).json({ error: 'No API key provided' })
          }
          // TODO: Validate API key
          next()
          break

        case 'basic':
          const auth = req.headers.authorization
          if (!auth || !auth.startsWith('Basic ')) {
            return res.status(401).json({ error: 'No basic auth provided' })
          }
          // TODO: Validate basic auth
          next()
          break

        case 'oauth':
          // OAuth validation
          // TODO: Implement OAuth validation
          next()
          break

        default:
          next()
      }
    }
  }

  private createAuthzMiddleware(roles: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      const user = (req as any).user

      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' })
      }

      // Check if user has required role/permission
      const hasPermission = roles.some(role => {
        return user.roles?.includes(role) || user.permissions?.includes(role)
      })

      if (!hasPermission) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          required: roles
        })
      }

      next()
    }
  }

  private createValidationMiddleware(schema: ValidationSchema) {
    return (req: Request, res: Response, next: NextFunction) => {
      const errors: string[] = []

      // Validate query parameters
      if (schema.query) {
        const queryErrors = this.validateObject(req.query, schema.query)
        errors.push(...queryErrors.map(e => `query.${e}`))
      }

      // Validate body
      if (schema.body) {
        const bodyErrors = this.validateObject(req.body, schema.body)
        errors.push(...bodyErrors.map(e => `body.${e}`))
      }

      // Validate params
      if (schema.params) {
        const paramErrors = this.validateObject(req.params, schema.params)
        errors.push(...paramErrors.map(e => `params.${e}`))
      }

      // Validate headers
      if (schema.headers) {
        const headerErrors = this.validateObject(req.headers, schema.headers)
        errors.push(...headerErrors.map(e => `headers.${e}`))
      }

      if (errors.length > 0) {
        return res.status(400).json({
          error: 'Validation failed',
          details: errors
        })
      }

      next()
    }
  }

  private validateObject(obj: any, schema: any): string[] {
    const errors: string[] = []

    for (const [key, rules] of Object.entries(schema)) {
      const value = obj[key]

      if (typeof rules === 'object' && rules !== null) {
        // Check required
        if (rules.required && value === undefined) {
          errors.push(`${key} is required`)
          continue
        }

        // Check type
        if (rules.type && value !== undefined) {
          const type = Array.isArray(value) ? 'array' : typeof value
          if (type !== rules.type) {
            errors.push(`${key} must be of type ${rules.type}`)
          }
        }

        // Check pattern
        if (rules.pattern && typeof value === 'string') {
          const regex = new RegExp(rules.pattern)
          if (!regex.test(value)) {
            errors.push(`${key} does not match pattern ${rules.pattern}`)
          }
        }

        // Check min/max for numbers
        if (typeof value === 'number') {
          if (rules.min !== undefined && value < rules.min) {
            errors.push(`${key} must be at least ${rules.min}`)
          }
          if (rules.max !== undefined && value > rules.max) {
            errors.push(`${key} must be at most ${rules.max}`)
          }
        }

        // Check length for strings and arrays
        if ((typeof value === 'string' || Array.isArray(value)) && value !== undefined) {
          if (rules.minLength !== undefined && value.length < rules.minLength) {
            errors.push(`${key} must have at least ${rules.minLength} characters/items`)
          }
          if (rules.maxLength !== undefined && value.length > rules.maxLength) {
            errors.push(`${key} must have at most ${rules.maxLength} characters/items`)
          }
        }

        // Check enum
        if (rules.enum && !rules.enum.includes(value)) {
          errors.push(`${key} must be one of: ${rules.enum.join(', ')}`)
        }
      }
    }

    return errors
  }

  private createCacheMiddleware(endpoint: APIEndpoint) {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET') {
        return next()
      }

      const cache = endpoint.cache!
      const key = cache.keyGenerator ?
        cache.keyGenerator(req) :
        `cache:${req.method}:${req.path}:${JSON.stringify(req.query)}`

      // Check cache
      const cached = this.cache.get(key)
      if (cached && cached.expires > new Date()) {
        res.setHeader('X-Cache', 'HIT')
        return res.json(cached.data)
      }

      // Store original send
      const originalSend = res.json
      res.json = function(data) {
        // Cache successful responses
        if (res.statusCode === 200) {
          const expires = new Date(Date.now() + cache.ttl * 1000)
          this.cache.set(key, { data, expires })
        }

        res.setHeader('X-Cache', 'MISS')
        return originalSend.call(this, data)
      }.bind(this)

      next()
    }
  }

  private createProxyHandler(endpoint: APIEndpoint) {
    return async (req: Request, res: Response) => {
      if (!endpoint.upstream) {
        return res.status(501).json({ error: 'No upstream configured' })
      }

      try {
        // Build upstream URL
        const url = new URL(endpoint.upstream)
        url.pathname = req.path
        url.search = new URLSearchParams(req.query as any).toString()

        // Forward request
        const response = await fetch(url.toString(), {
          method: req.method,
          headers: {
            ...req.headers,
            host: url.host,
            'x-forwarded-for': req.ip,
            'x-forwarded-proto': req.protocol,
            'x-forwarded-host': req.get('host') || ''
          },
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
          signal: AbortSignal.timeout(endpoint.timeout || this.config.timeout)
        })

        // Forward response
        const data = await response.json()
        res.status(response.status).json(data)
      } catch (error) {
        this.emit('proxyError', { endpoint, error })
        res.status(502).json({ error: 'Bad Gateway' })
      }
    }
  }

  private wrapHandler(
    handler: (req: Request, res: Response, next: NextFunction) => void,
    endpoint: APIEndpoint
  ) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const circuitBreaker = this.circuitBreakers.get(`${endpoint.method}:${endpoint.path}`)

      if (circuitBreaker) {
        try {
          await circuitBreaker.execute(async () => {
            return new Promise((resolve, reject) => {
              // Override send to capture response
              const originalSend = res.send
              res.send = function(data) {
                if (res.statusCode >= 500) {
                  reject(new Error(`Server error: ${res.statusCode}`))
                } else {
                  resolve(data)
                }
                return originalSend.call(this, data)
              }

              handler(req, res, next)
            })
          })
        } catch (error) {
          if ((error as any).message === 'Circuit breaker is open') {
            return res.status(503).json({ error: 'Service temporarily unavailable' })
          }
          throw error
        }
      } else {
        handler(req, res, next)
      }
    }
  }

  private setupCleanupTimer(): void {
    // Clean up expired cache entries every minute
    setInterval(() => {
      const now = new Date()
      for (const [key, entry] of this.cache.entries()) {
        if (entry.expires < now) {
          this.cache.delete(key)
        }
      }
    }, 60000)
  }

  // Public methods
  getMetrics(): APIMetrics {
    return { ...this.metrics }
  }

  getEndpoint(method: string, path: string): APIEndpoint | undefined {
    return this.endpoints.get(`${method}:${path}`)
  }

  removeEndpoint(method: string, path: string): boolean {
    const key = `${method}:${path}`

    // Clean up associated resources
    this.rateLimiters.delete(key)
    this.circuitBreakers.delete(key)

    return this.endpoints.delete(key)
  }

  clearCache(pattern?: string): number {
    let cleared = 0

    if (pattern) {
      const regex = new RegExp(pattern)
      for (const key of this.cache.keys()) {
        if (regex.test(key)) {
          this.cache.delete(key)
          cleared++
        }
      }
    } else {
      cleared = this.cache.size
      this.cache.clear()
    }

    return cleared
  }

  // Batch registration
  registerEndpoints(endpoints: APIEndpoint[]): void {
    for (const endpoint of endpoints) {
      this.registerEndpoint(endpoint)
    }
  }

  // Version management
  registerVersionedEndpoint(endpoint: APIEndpoint, version: string): void {
    const versionedEndpoint = {
      ...endpoint,
      path: `/v${version}${endpoint.path}`,
      version
    }
    this.registerEndpoint(versionedEndpoint)
  }
}