import type { Application, Request, Response, NextFunction} from 'express';
import { Router } from 'express'
import { EventEmitter } from 'events'
import * as crypto from 'crypto'
import type { RateLimitConfig } from './RateLimiter';
import { RateLimiter } from './RateLimiter'
import { CircuitBreaker } from './CircuitBreaker'
import { authService, type User } from '../auth/AuthService'
import { Logger } from '../core/logger'

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

// Validation rule type definition
export interface ValidationRule {
  required?: boolean
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object'
  pattern?: string
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  enum?: unknown[]
}

export interface ValidationSchema {
  query?: Record<string, ValidationRule>
  body?: Record<string, ValidationRule>
  params?: Record<string, ValidationRule>
  headers?: Record<string, ValidationRule>
}

export interface CacheConfig {
  enabled: boolean
  ttl: number // seconds
  keyGenerator?: (req: Request) => string
  invalidateOn?: string[] // Event names that invalidate cache
}

export interface TransformConfig {
  request?: (req: Request) => Request | Promise<Request>
  response?: (data: unknown, req: Request) => unknown | Promise<unknown>
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

// Extended Request interface for custom properties
export interface RequestWithExtensions extends Request {
  requestId?: string
  user?: User
}

// Cache entry type
interface CacheEntry {
  data: unknown
  expires: Date
}

export class APIGateway extends EventEmitter {
  private app: Application
  private router: Router
  private config: Required<GatewayConfig>
  private endpoints: Map<string, APIEndpoint> = new Map()
  private rateLimiters: Map<string, RateLimiter> = new Map()
  private circuitBreakers: Map<string, CircuitBreaker> = new Map()
  private cache: Map<string, CacheEntry> = new Map()
  private cleanupTimer: NodeJS.Timeout | null = null  // Store timer reference for cleanup
  private isDestroyed = false  // Track destruction state
  private logger = new Logger('APIGateway')
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

      ;(req as RequestWithExtensions).requestId = requestId
      res.setHeader('X-Request-ID', requestId)

      next()
    }
  }

  private loggingMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now()
      const requestId = (req as RequestWithExtensions).requestId

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
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const gateway = this
      res.send = function(this: Response, data: unknown) {
        const duration = Date.now() - start

        // Log response
        gateway.emit('response', {
          requestId,
          statusCode: res.statusCode,
          duration,
          timestamp: new Date()
        })

        return originalSend.call(this, data)
      }

      next()
    }
  }

  private metricsMiddleware() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const gateway = this
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now()
      const key = `${req.method}:${req.path}`

      gateway.metrics.totalRequests++

      // Get or create endpoint metrics
      let endpointMetrics = gateway.metrics.endpoints.get(key)
      if (!endpointMetrics) {
        endpointMetrics = {
          requests: 0,
          successes: 0,
          failures: 0,
          totalTime: 0,
          averageTime: 0,
          lastAccess: new Date()
        }
        gateway.metrics.endpoints.set(key, endpointMetrics)
      }

      endpointMetrics.requests++
      endpointMetrics.lastAccess = new Date()

      // Intercept response
      const originalSend = res.send
      res.send = function(this: Response, data: unknown) {
        const duration = Date.now() - start

        if (res.statusCode < 400) {
          gateway.metrics.successfulRequests++
          endpointMetrics!.successes++
        } else {
          gateway.metrics.failedRequests++
          endpointMetrics!.failures++
        }

        endpointMetrics!.totalTime += duration
        endpointMetrics!.averageTime = endpointMetrics!.totalTime / endpointMetrics!.requests

        // Update global average
        gateway.metrics.averageResponseTime =
          (gateway.metrics.averageResponseTime * (gateway.metrics.totalRequests - 1) + duration) /
          gateway.metrics.totalRequests

        return originalSend.call(this, data)
      }

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
    const middlewares: Array<(req: Request, res: Response, next: NextFunction) => void> = []

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
    const method = endpoint.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch'
    this.router[method](endpoint.path, ...middlewares)

    this.emit('endpointRegistered', endpoint)
  }

  private createAuthMiddleware(type: AuthenticationType) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        switch (type) {
          case 'jwt': {
            // JWT validation using real AuthService
            const token = req.headers.authorization?.replace('Bearer ', '')
            if (!token) {
              return res.status(401).json({ error: 'No token provided' })
            }

            const user = await authService.verifyToken(token)
            if (!user) {
              return res.status(401).json({ error: 'Invalid or expired token' })
            }

            // 将用户信息附加到请求对象
            (req as RequestWithExtensions).user = user
            next()
            break
          }

          case 'api-key': {
            const apiKey = req.headers['x-api-key'] as string
            if (!apiKey) {
              return res.status(401).json({ error: 'No API key provided' })
            }

            // 验证API Key (从环境变量或数据库)
            const validApiKeys = process.env.VALID_API_KEYS?.split(',') || []
            if (!validApiKeys.includes(apiKey)) {
              return res.status(401).json({ error: 'Invalid API key' })
            }

            // 为API Key创建系统用户
            (req as RequestWithExtensions).user = {
              id: 'api-key-user',
              email: 'api@metasheet.com',
              name: 'API Key User',
              role: 'api',
              permissions: ['api:*'],
              created_at: new Date(),
              updated_at: new Date()
            }
            next()
            break
          }

          case 'basic': {
            const auth = req.headers.authorization
            if (!auth || !auth.startsWith('Basic ')) {
              return res.status(401).json({ error: 'No basic auth provided' })
            }

            try {
              const credentials = Buffer.from(auth.substring(6), 'base64').toString('ascii')
              const [email, password] = credentials.split(':')

              if (!email || !password) {
                return res.status(401).json({ error: 'Invalid basic auth format' })
              }

              // 使用AuthService验证基础认证
              const loginResult = await authService.login(email, password)
              if (!loginResult) {
                return res.status(401).json({ error: 'Invalid credentials' })
              }

              (req as RequestWithExtensions).user = loginResult.user
              next()
            } catch (error) {
              return res.status(401).json({ error: 'Invalid basic auth encoding' })
            }
            break
          }

          case 'oauth':
            // OAuth validation - 暂时返回错误，需要配置OAuth提供商
            return res.status(501).json({
              error: 'OAuth authentication not implemented yet. Please use JWT authentication.'
            })

          case 'none':
            // 无认证需求
            next()
            break

          default:
            next()
        }
      } catch (error) {
        this.logger.error('Authentication middleware error', error instanceof Error ? error : undefined)
        return res.status(500).json({ error: 'Authentication service error' })
      }
    }
  }

  private createAuthzMiddleware(roles: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      const user = (req as RequestWithExtensions).user

      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' })
      }

      // 检查用户是否拥有所需权限
      const hasPermission = roles.some(roleOrPermission => {
        // 使用AuthService的权限检查逻辑
        const [resource, action] = roleOrPermission.includes(':')
          ? roleOrPermission.split(':')
          : [roleOrPermission, '*']

        return authService.checkPermission(user, resource, action)
      })

      if (!hasPermission) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          required: roles,
          userRole: user.role,
          userPermissions: user.permissions
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

  private validateObject(obj: Record<string, unknown>, schema: Record<string, ValidationRule>): string[] {
    const errors: string[] = []

    for (const [key, rules] of Object.entries(schema)) {
      const value = obj[key]

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
      const originalSend = res.json.bind(res)
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const gateway = this
      res.json = function(this: Response, data: unknown) {
        // Cache successful responses
        if (res.statusCode === 200) {
          const expires = new Date(Date.now() + cache.ttl * 1000)
          gateway.cache.set(key, { data, expires })
        }

        res.setHeader('X-Cache', 'MISS')
        return originalSend(data)
      }

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
        url.search = new URLSearchParams(req.query as Record<string, string>).toString()

        // Forward request
        const headers: Record<string, string> = {
          host: url.host,
          'x-forwarded-for': req.ip || '',
          'x-forwarded-proto': req.protocol,
          'x-forwarded-host': req.get('host') || '',
          'content-type': req.get('content-type') || 'application/json'
        }

        const response = await fetch(url.toString(), {
          method: req.method,
          headers,
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
            return new Promise<unknown>((resolve, reject) => {
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
          if ((error as Error).message === 'Circuit breaker is open') {
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
    // Store the timer reference to allow proper cleanup on destruction
    this.cleanupTimer = setInterval(() => {
      // Skip if already destroyed
      if (this.isDestroyed) return

      const now = new Date()
      for (const [key, entry] of this.cache.entries()) {
        if (entry.expires < now) {
          this.cache.delete(key)
        }
      }
    }, 60000)

    // Unref the timer so it doesn't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * Gracefully destroy the API Gateway and clean up resources
   * Prevents memory leaks by clearing timers and caches
   */
  destroy(): void {
    if (this.isDestroyed) return

    this.isDestroyed = true

    // Clear the cleanup timer to prevent memory leak
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    // Clear all caches
    this.cache.clear()
    this.endpoints.clear()
    this.rateLimiters.clear()
    this.circuitBreakers.clear()

    // Clear metrics
    this.metrics.endpoints.clear()

    // Remove all event listeners
    this.removeAllListeners()

    this.emit('destroyed')
    this.logger.info('Gateway destroyed and resources cleaned up')
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
