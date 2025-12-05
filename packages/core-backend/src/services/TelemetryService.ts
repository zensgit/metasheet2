/**
 * OpenTelemetry Service
 * Provides distributed tracing, metrics, and structured logging
 */

// Soft dependencies: these imports may be unavailable in minimal setups.
// We keep types and only load real modules in initialize().

// Type definitions for OpenTelemetry APIs
interface OTelNodeSDK {
  start(): Promise<void>
  shutdown(): Promise<void>
}

interface OTelResource {
  new (attributes: Record<string, unknown>): unknown
}

interface OTelSpanContext {
  traceId: string
  spanId: string
  traceFlags?: number
  isRemote?: boolean
}

interface OTelSpan {
  addEvent(name: string, attributes?: Record<string, unknown>): void
  setStatus(status: { code: number; message?: string }): void
  setAttributes(attributes: Record<string, unknown>): void
  recordException(exception: Error): void
  end(): void
  spanContext(): OTelSpanContext
  parentSpanId?: string
}

interface OTelTracer {
  startActiveSpan<T>(
    name: string,
    options: unknown,
    fn: (span: OTelSpan) => T
  ): T
  startActiveSpan<T>(
    name: string,
    fn: (span: OTelSpan) => T
  ): T
  startSpan(name: string, options?: unknown, context?: unknown): OTelSpan
}

interface OTelTrace {
  getTracer(name: string): OTelTracer
  getActiveSpan(): OTelSpan | null
  setSpanContext(context: unknown, spanContext: OTelSpanContext): unknown
  setSpan(context: unknown, span: OTelSpan): unknown
}

interface OTelContext {
  active(): unknown
  with<T>(context: unknown, fn: () => T): T
  setSpan(context: unknown, span: OTelSpan): unknown
}

interface OTelHistogram {
  record(value: number, attributes?: Record<string, string>): void
}

interface OTelCounter {
  add(value: number, attributes?: Record<string, string>): void
}

interface OTelObservableResult {
  observe(value: number, attributes?: Record<string, string>): void
}

interface OTelObservableGauge {
  addCallback(callback: (result: OTelObservableResult) => void): void
}

interface OTelMeter {
  createHistogram(name: string, options?: { description?: string; unit?: string }): OTelHistogram
  createCounter(name: string, options?: { description?: string }): OTelCounter
  createUpDownCounter(name: string, options?: { description?: string }): OTelCounter
  createObservableGauge(name: string, options?: { description?: string }): OTelObservableGauge
}

interface OTelMetrics {
  getMeter(name: string): OTelMeter
}

// Module-level variables for lazy-loaded OpenTelemetry modules
let NodeSDK: { new (config: unknown): OTelNodeSDK } | undefined
let getNodeAutoInstrumentations: ((config?: unknown) => unknown[]) | undefined
let Resource: OTelResource | undefined
let SemanticResourceAttributes: Record<string, string> | undefined
let PrometheusExporter: { new (config: unknown, callback?: () => void): unknown } | undefined
let PeriodicExportingMetricReader: { new (config: unknown): unknown } | undefined
let JaegerExporter: { new (config: { endpoint?: string }): unknown } | undefined
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _BatchSpanProcessor: unknown
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _otelApi: unknown

// Minimal placeholders (no-op) to allow structured logger usage before init
const trace: OTelTrace = {
  getTracer: (_n: string) => ({
    startActiveSpan: <T>(_name: string, _optsOrFn: unknown, fnOrUndefined?: (span: OTelSpan) => T): T => {
      const fn = typeof _optsOrFn === 'function' ? _optsOrFn : fnOrUndefined
      if (!fn) {
        throw new Error('Invalid startActiveSpan arguments')
      }
      return fn({
        addEvent: () => {},
        setStatus: () => {},
        setAttributes: () => {},
        recordException: () => {},
        end: () => {},
        spanContext: () => ({ traceId: '', spanId: '' }),
        parentSpanId: ''
      })
    },
    startSpan: (_name: string, _opts?: unknown, _ctx?: unknown) => ({
      addEvent: () => {},
      setStatus: () => {},
      setAttributes: () => {},
      recordException: () => {},
      end: () => {},
      spanContext: () => ({ traceId: '', spanId: '' }),
      parentSpanId: ''
    })
  }),
  getActiveSpan: () => null,
  setSpanContext: (_ctx: unknown, _spanCtx: OTelSpanContext) => ({}),
  setSpan: (_a: unknown, _b: OTelSpan) => ({})
}

const context: OTelContext = {
  active: () => ({}),
  with: <T>(_s: unknown, fn: () => T) => fn(),
  setSpan: (_a: unknown, _b: OTelSpan) => ({})
}

const SpanStatusCode = { OK: 1, ERROR: 2 }
const SpanKind = { INTERNAL: 1, SERVER: 2 }

const metrics: OTelMetrics = {
  getMeter: (_n: string) => ({
    createHistogram: () => ({ record: () => {} }),
    createCounter: () => ({ add: () => {} }),
    createUpDownCounter: () => ({ add: () => {} }),
    createObservableGauge: () => ({ addCallback: () => {} })
  })
}

import { Logger } from '../core/logger'
import * as crypto from 'crypto'

const logger = new Logger('TelemetryService')

export interface TelemetryConfig {
  serviceName?: string
  serviceVersion?: string
  environment?: string
  jaegerEndpoint?: string
  prometheusPort?: number
  enableAutoInstrumentation?: boolean
  enableMetrics?: boolean
  enableTracing?: boolean
  samplingRate?: number
}

/**
 * Context propagation for distributed tracing
 */
export class TraceContext {
  private static readonly TRACE_HEADER = 'x-trace-id'
  private static readonly SPAN_HEADER = 'x-span-id'
  private static readonly PARENT_HEADER = 'x-parent-span-id'

  static extract(headers: Record<string, string | undefined>): OTelSpanContext | undefined {
    const traceId = headers[this.TRACE_HEADER]
    const spanId = headers[this.SPAN_HEADER]

    if (!traceId || !spanId) {
      return undefined
    }

    return {
      traceId,
      spanId,
      traceFlags: 1,
      isRemote: true
    }
  }

  static inject(span: OTelSpan): Record<string, string> {
    const spanContext = span.spanContext()
    return {
      [this.TRACE_HEADER]: spanContext.traceId,
      [this.SPAN_HEADER]: spanContext.spanId,
      [this.PARENT_HEADER]: span.parentSpanId || ''
    }
  }
}

/**
 * Structured logger with trace context
 */
export class StructuredLogger {
  private tracer: OTelTracer
  private correlationId: string

  constructor(
    private name: string,
    private telemetry: TelemetryService
  ) {
    this.tracer = trace.getTracer(name)
    this.correlationId = crypto.randomUUID()
  }

  private getContext() {
    const span = trace.getActiveSpan()
    const spanContext = span?.spanContext()

    return {
      timestamp: new Date().toISOString(),
      service: this.telemetry.config.serviceName,
      environment: this.telemetry.config.environment,
      logger: this.name,
      correlationId: this.correlationId,
      traceId: spanContext?.traceId,
      spanId: spanContext?.spanId,
      parentSpanId: span?.parentSpanId
    }
  }

  log(level: string, message: string, metadata?: Record<string, unknown>) {
    const logEntry = {
      ...this.getContext(),
      level,
      message,
      ...metadata
    }

    // Output structured log
    console.log(JSON.stringify(logEntry))

    // Add event to span if active
    const span = trace.getActiveSpan()
    span?.addEvent(message, {
      level,
      ...metadata
    })
  }

  debug(message: string, metadata?: Record<string, unknown>) {
    this.log('debug', message, metadata)
  }

  info(message: string, metadata?: Record<string, unknown>) {
    this.log('info', message, metadata)
  }

  warn(message: string, metadata?: Record<string, unknown>) {
    this.log('warn', message, metadata)
  }

  error(message: string, error?: Error, metadata?: Record<string, unknown>) {
    const errorData = error ? {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    } : {}

    this.log('error', message, {
      ...errorData,
      ...metadata
    })

    // Record exception in span
    const span = trace.getActiveSpan()
    if (span && error) {
      span.recordException(error)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message
      })
    }
  }

  setCorrelationId(id: string) {
    this.correlationId = id
  }
}

/**
 * Custom metrics collectors
 */
export class MetricsCollector {
  private httpRequestDuration: OTelHistogram
  private httpRequestTotal: OTelCounter
  private dbQueryDuration: OTelHistogram
  private cacheHitRate: OTelHistogram
  private activeConnections: OTelCounter
  private memoryUsage: OTelObservableGauge

  constructor() {
    const meter = metrics.getMeter('metasheet-metrics')

    // HTTP metrics
    this.httpRequestDuration = meter.createHistogram('http_request_duration_ms', {
      description: 'HTTP request duration in milliseconds',
      unit: 'ms',
      // valueType: ValueType.DOUBLE
    })

    this.httpRequestTotal = meter.createCounter('http_requests_total', {
      description: 'Total number of HTTP requests'
    })

    // Database metrics
    this.dbQueryDuration = meter.createHistogram('db_query_duration_ms', {
      description: 'Database query duration in milliseconds',
      unit: 'ms',
      // valueType: ValueType.DOUBLE
    })

    // Cache metrics
    this.cacheHitRate = meter.createHistogram('cache_hit_rate', {
      description: 'Cache hit rate',
      // valueType: ValueType.DOUBLE
    })

    // System metrics
    this.activeConnections = meter.createUpDownCounter('active_connections', {
      description: 'Number of active connections'
    })

    this.memoryUsage = meter.createObservableGauge('memory_usage_bytes', {
      description: 'Memory usage in bytes'
    })

    // Register memory observer
    this.memoryUsage.addCallback((observableResult: OTelObservableResult) => {
      const usage = process.memoryUsage()
      observableResult.observe(usage.heapUsed, { type: 'heap_used' })
      observableResult.observe(usage.heapTotal, { type: 'heap_total' })
      observableResult.observe(usage.rss, { type: 'rss' })
      observableResult.observe(usage.external, { type: 'external' })
    })
  }

  recordHttpRequest(method: string, path: string, statusCode: number, duration: number) {
    const labels = { method, path, status_code: statusCode.toString() }
    this.httpRequestDuration.record(duration, labels)
    this.httpRequestTotal.add(1, labels)
  }

  recordDbQuery(operation: string, table: string, duration: number, success: boolean) {
    this.dbQueryDuration.record(duration, {
      operation,
      table,
      success: success.toString()
    })
  }

  recordCacheOperation(operation: string, hit: boolean) {
    this.cacheHitRate.record(hit ? 1 : 0, { operation })
  }

  incrementConnections(delta: number) {
    this.activeConnections.add(delta)
  }
}

/**
 * Main Telemetry Service
 */
export class TelemetryService {
  private sdk: OTelNodeSDK | null = null
  private tracer: OTelTracer
  private metricsCollector: MetricsCollector
  private loggers: Map<string, StructuredLogger> = new Map()
  private initialized = false
  public readonly config: TelemetryConfig

  constructor(config?: TelemetryConfig) {
    this.config = {
      serviceName: config?.serviceName || 'metasheet',
      serviceVersion: config?.serviceVersion || process.env.VERSION || '1.0.0',
      environment: config?.environment || process.env.NODE_ENV || 'development',
      jaegerEndpoint: config?.jaegerEndpoint || 'http://localhost:14268/api/traces',
      prometheusPort: config?.prometheusPort || 9090,
      enableAutoInstrumentation: config?.enableAutoInstrumentation ?? true,
      enableMetrics: config?.enableMetrics ?? true,
      enableTracing: config?.enableTracing ?? true,
      samplingRate: config?.samplingRate ?? 1.0
    }

    this.tracer = trace.getTracer(this.config.serviceName || 'metasheet')
    this.metricsCollector = new MetricsCollector()
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('Telemetry already initialized')
      return
    }

    try {
      // Load OpenTelemetry modules lazily
      try {
        // Lazy-load with require to avoid tsc module resolution
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        NodeSDK = require('@opentelemetry/sdk-node').NodeSDK
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        getNodeAutoInstrumentations = require('@opentelemetry/auto-instrumentations-node').getNodeAutoInstrumentations
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        Resource = require('@opentelemetry/resources').Resource
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        SemanticResourceAttributes = require('@opentelemetry/semantic-conventions').SemanticResourceAttributes
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        PrometheusExporter = require('@opentelemetry/exporter-prometheus').PrometheusExporter
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        PeriodicExportingMetricReader = require('@opentelemetry/sdk-metrics').PeriodicExportingMetricReader
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        JaegerExporter = require('@opentelemetry/exporter-jaeger').JaegerExporter
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _BatchSpanProcessor = require('@opentelemetry/sdk-trace-base').BatchSpanProcessor
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _otelApi = require('@opentelemetry/api')
      } catch (e) {
        logger.warn('OpenTelemetry modules not available; skipping telemetry init')
        return
      }

      if (!Resource || !SemanticResourceAttributes) {
        logger.warn('OpenTelemetry Resource not available')
        return
      }

      const resource = new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: this.config.serviceVersion,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment,
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        [SemanticResourceAttributes.HOST_NAME]: require('os').hostname(),
        [SemanticResourceAttributes.PROCESS_PID]: process.pid
      })

      const instrumentations = this.config.enableAutoInstrumentation && getNodeAutoInstrumentations
        ? [getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-fs': {
              enabled: false // Disable fs instrumentation to reduce noise
            }
          })]
        : []

      // Configure trace exporter
      let traceExporter: unknown = undefined
      if (this.config.enableTracing && JaegerExporter) {
        traceExporter = new JaegerExporter({
          endpoint: this.config.jaegerEndpoint
        })
      }

      // Configure metrics exporter
      let metricReader: unknown = undefined
      if (this.config.enableMetrics && PrometheusExporter && PeriodicExportingMetricReader) {
        const prometheusExporter = new PrometheusExporter({
          port: this.config.prometheusPort
        }, () => {
          logger.info(`Prometheus metrics server started on port ${this.config.prometheusPort}`)
        })

        metricReader = new PeriodicExportingMetricReader({
          exporter: prometheusExporter,
          exportIntervalMillis: 10000
        })
      }

      // Initialize SDK
      if (!NodeSDK) {
        logger.warn('NodeSDK not available')
        return
      }

      this.sdk = new NodeSDK({
        resource,
        instrumentations,
        traceExporter,
        metricReader
      })

      await this.sdk.start()
      this.initialized = true

      logger.info('OpenTelemetry initialized', {
        serviceName: this.config.serviceName,
        environment: this.config.environment,
        tracingEnabled: this.config.enableTracing,
        metricsEnabled: this.config.enableMetrics
      })

    } catch (error) {
      logger.error('Failed to initialize OpenTelemetry', error as Error)
      throw error
    }
  }

  async shutdown(): Promise<void> {
    if (!this.initialized || !this.sdk) {
      return
    }

    try {
      await this.sdk.shutdown()
      this.initialized = false
      logger.info('OpenTelemetry shut down successfully')
    } catch (error) {
      logger.error('Error shutting down OpenTelemetry', error as Error)
    }
  }

  getTracer(name?: string): OTelTracer {
    return trace.getTracer(name || this.config.serviceName || 'metasheet')
  }

  getLogger(name: string): StructuredLogger {
    if (!this.loggers.has(name)) {
      this.loggers.set(name, new StructuredLogger(name, this))
    }
    return this.loggers.get(name)!
  }

  getMetrics(): MetricsCollector {
    return this.metricsCollector
  }

  /**
   * Create a traced function wrapper
   */
  trace<T extends (...args: unknown[]) => unknown>(
    fn: T,
    options?: {
      name?: string
      kind?: number
      attributes?: Record<string, unknown>
    }
  ): T {
    const tracer = this.tracer
    const spanName = options?.name || fn.name || 'anonymous'

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return (async function traced(this: unknown, ...args: unknown[]) {
      return tracer.startActiveSpan(spanName, {
        kind: options?.kind || SpanKind.INTERNAL,
        attributes: options?.attributes
      }, async (span: OTelSpan) => {
        try {
          const result = await (fn as (...args: unknown[]) => Promise<unknown>).apply(self, args)
          span.setStatus({ code: SpanStatusCode.OK })
          return result
        } catch (error) {
          span.recordException(error as Error)
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message
          })
          throw error
        } finally {
          span.end()
        }
      })
    }) as T
  }

  /**
   * Decorator for tracing class methods
   */
  traceMethod(
    target: Record<string, unknown>,
    propertyName: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<unknown>
    const tracer = this.tracer

    descriptor.value = async function(this: unknown, ...args: unknown[]) {
      const targetConstructor = (target as { constructor: { name: string } }).constructor
      const spanName = `${targetConstructor.name}.${propertyName}`

      return tracer.startActiveSpan(spanName, async (span: OTelSpan) => {
        try {
          span.setAttributes({
            'code.function': propertyName,
            'code.namespace': targetConstructor.name
          })

          const result = await originalMethod.apply(this, args)
          span.setStatus({ code: SpanStatusCode.OK })
          return result

        } catch (error) {
          span.recordException(error as Error)
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message
          })
          throw error

        } finally {
          span.end()
        }
      })
    }

    return descriptor
  }

  /**
   * Express middleware for tracing HTTP requests
   * Returns a middleware function compatible with Express
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expressMiddleware(): (req: any, res: any, next: () => void) => void {
    const tracer = this.tracer
    const metricsCollector = this.metricsCollector

    interface ExpressRequest {
      method: string
      url: string
      path: string
      hostname: string
      protocol: string
      ip?: string
      headers: Record<string, string | undefined>
      route?: { path: string }
      span?: OTelSpan
      get(name: string): string | undefined
    }

    interface ExpressResponse {
      statusCode: number
      end(...args: unknown[]): unknown
      setHeader(name: string, value: string): void
      get(name: string): string | undefined
    }

    type NextFunction = () => void

    return (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
      const startTime = Date.now()

      // Extract trace context from headers
      const parentContext = TraceContext.extract(req.headers)

      // Start span
      const span = tracer.startSpan(`HTTP ${req.method} ${req.route?.path || req.path}`, {
        kind: SpanKind.SERVER,
        attributes: {
          'http.method': req.method,
          'http.url': req.url,
          'http.target': req.path,
          'http.host': req.hostname,
          'http.scheme': req.protocol,
          'http.user_agent': req.get('user-agent') || '',
          'net.peer.ip': req.ip || ''
        }
      }, parentContext ? trace.setSpanContext(context.active(), parentContext) : undefined)

      // Inject trace context into response headers
      const traceHeaders = TraceContext.inject(span)
      Object.entries(traceHeaders).forEach(([key, value]) => {
        res.setHeader(key, value)
      })

      // Store span in request for later use
      req.span = span

      // Hook response end
      const originalEnd = res.end
      res.end = function(this: ExpressResponse, ...args: unknown[]) {
        // Set final span attributes
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.response.size': parseInt(res.get('content-length') || '0', 10)
        })

        // Set span status based on HTTP status
        if (res.statusCode >= 400) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${res.statusCode}`
          })
        } else {
          span.setStatus({ code: SpanStatusCode.OK })
        }

        // Record metrics
        const duration = Date.now() - startTime
        metricsCollector.recordHttpRequest(
          req.method,
          req.route?.path || req.path,
          res.statusCode,
          duration
        )

        // End span
        span.end()

        // Call original end
        return originalEnd.apply(this, args)
      }

      // Continue with trace context
      context.with(trace.setSpan(context.active(), span), () => {
        next()
      })
    }
  }
}

// Export singleton instance
let telemetryInstance: TelemetryService | null = null

export function getTelemetry(config?: TelemetryConfig): TelemetryService {
  if (!telemetryInstance) {
    telemetryInstance = new TelemetryService(config)
  }
  return telemetryInstance
}

// Export decorators
export function Trace(_options?: { name?: string; kind?: number }) {
  return function(
    target: Record<string, unknown>,
    propertyName: string,
    descriptor: PropertyDescriptor
  ) {
    const telemetry = getTelemetry()
    return telemetry.traceMethod(target, propertyName, descriptor)
  }
}

export default getTelemetry
