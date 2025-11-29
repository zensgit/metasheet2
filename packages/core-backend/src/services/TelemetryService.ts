// @ts-nocheck
/**
 * OpenTelemetry Service
 * Provides distributed tracing, metrics, and structured logging
 */

// Soft dependencies: these imports may be unavailable in minimal setups.
// We keep types via 'any' and only load real modules in initialize().
let NodeSDK: any, getNodeAutoInstrumentations: any, Resource: any, SemanticResourceAttributes: any
let PrometheusExporter: any, PeriodicExportingMetricReader: any, JaegerExporter: any, BatchSpanProcessor: any
let otelApi: any
// Minimal placeholders (no-op) to allow structured logger usage before init
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const trace: any = {
  getTracer: (_n: any) => ({
    startActiveSpan: (_name: any, _opts: any, fn: any) => fn({
      addEvent: () => {},
      setStatus: () => {},
      end: () => {},
      spanContext: () => ({ traceId: '', spanId: '' }),
      parentSpanId: ''
    })
  }),
  // no-op placeholders before real API is loaded
  getActiveSpan: () => null,
  setSpanContext: (_ctx: any, _spanCtx: any) => ({})
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const context: any = { active: ()=>({}), with: (_s:any, fn:any)=>fn(), setSpan: (_a:any,_b:any)=>({}) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpanStatusCode: any = { OK: 1, ERROR: 2 }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpanKind: any = { INTERNAL: 1, SERVER: 2 }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tracer = any; type Span = any; type SpanContext = any; type ValueType = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const metrics: any = { getMeter: (_n:any)=>({ createHistogram: ()=>({ record:()=>{} }), createCounter: ()=>({ add:()=>{} }), createUpDownCounter:()=>({ add:()=>{} }), createObservableGauge: ()=>({ addCallback: ()=>{} }) }) }
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

  static extract(headers: Record<string, string>): SpanContext | undefined {
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

  static inject(span: Span): Record<string, string> {
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
  private tracer: Tracer
  private correlationId: string

  constructor(
    private name: string,
    private telemetry: TelemetryService
  ) {
    this.tracer = trace.getTracer(name)
    this.correlationId = crypto.randomUUID()
  }

  private getContext() {
    const span = (trace as any)?.getActiveSpan?.()
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

  log(level: string, message: string, metadata?: any) {
    const logEntry = {
      ...this.getContext(),
      level,
      message,
      ...metadata
    }

    // Output structured log
    console.log(JSON.stringify(logEntry))

    // Add event to span if active
    const span = (trace as any)?.getActiveSpan?.()
    span?.addEvent(message, {
      level,
      ...metadata
    })
  }

  debug(message: string, metadata?: any) {
    this.log('debug', message, metadata)
  }

  info(message: string, metadata?: any) {
    this.log('info', message, metadata)
  }

  warn(message: string, metadata?: any) {
    this.log('warn', message, metadata)
  }

  error(message: string, error?: Error, metadata?: any) {
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
    const span = (trace as any)?.getActiveSpan?.()
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
  private httpRequestDuration: any
  private httpRequestTotal: any
  private dbQueryDuration: any
  private cacheHitRate: any
  private activeConnections: any
  private memoryUsage: any

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
    this.memoryUsage.addCallback((observableResult: any) => {
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
  private sdk: any | null = null
  private tracer: Tracer
  private metricsCollector: MetricsCollector
  private loggers: Map<string, StructuredLogger> = new Map()
  private initialized = false
  public readonly config: TelemetryConfig

  constructor(config?: TelemetryConfig) {
    this.config = {
      serviceName: config?.serviceName || 'metasheet',
      serviceVersion: config?.serviceVersion || (process as any).env.VERSION || '1.0.0',
      environment: config?.environment || (process as any).env.NODE_ENV || 'development',
      jaegerEndpoint: config?.jaegerEndpoint || 'http://localhost:14268/api/traces',
      prometheusPort: config?.prometheusPort || 9090,
      enableAutoInstrumentation: config?.enableAutoInstrumentation ?? true,
      enableMetrics: config?.enableMetrics ?? true,
      enableTracing: config?.enableTracing ?? true,
      samplingRate: config?.samplingRate ?? 1.0
    }

    this.tracer = trace.getTracer(this.config.serviceName)
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
        BatchSpanProcessor = require('@opentelemetry/sdk-trace-base').BatchSpanProcessor
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        otelApi = require('@opentelemetry/api')
      } catch (e) {
        logger.warn('OpenTelemetry modules not available; skipping telemetry init')
        return
      }

      const resource = new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: this.config.serviceVersion,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment,
        [SemanticResourceAttributes.HOST_NAME]: require('os').hostname(),
        [SemanticResourceAttributes.PROCESS_PID]: process.pid
      })

      const instrumentations = this.config.enableAutoInstrumentation
        ? [getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-fs': {
              enabled: false // Disable fs instrumentation to reduce noise
            }
          })]
        : []

      // Configure trace exporter
      let traceExporter = undefined
      if (this.config.enableTracing) {
        traceExporter = new JaegerExporter({
          endpoint: this.config.jaegerEndpoint
        })
      }

      // Configure metrics exporter
      let metricReader = undefined
      if (this.config.enableMetrics) {
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

  getTracer(name?: string): Tracer {
    return trace.getTracer(name || this.config.serviceName)
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
  trace<T extends (...args: any[]) => any>(
    fn: T,
    options?: {
      name?: string
      kind?: any
      attributes?: Record<string, any>
    }
  ): T {
    const tracer = this.tracer
    const spanName = options?.name || fn.name || 'anonymous'

    return (async function traced(...args: any[]) {
      return tracer.startActiveSpan(spanName, {
        kind: options?.kind || SpanKind.INTERNAL,
        attributes: options?.attributes
      }, async (span) => {
        try {
          const result = await fn.apply(this, args)
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
    target: any,
    propertyName: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value
    const tracer = this.tracer

    descriptor.value = async function(...args: any[]) {
      const spanName = `${target.constructor.name}.${propertyName}`

      return tracer.startActiveSpan(spanName, async (span) => {
        try {
          span.setAttributes({
            'code.function': propertyName,
            'code.namespace': target.constructor.name
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
   */
  expressMiddleware() {
    const tracer = this.tracer
    const metrics = this.metricsCollector

    return (req: any, res: any, next: any) => {
      const startTime = Date.now()

      // Extract trace context from headers
      const parentContext = TraceContext.extract(req.headers)

      // Start span
      const span = (tracer as any).startSpan(`HTTP ${req.method} ${req.route?.path || req.path}`, {
        kind: SpanKind.SERVER,
        attributes: {
          'http.method': req.method,
          'http.url': req.url,
          'http.target': req.path,
          'http.host': req.hostname,
          'http.scheme': req.protocol,
          'http.user_agent': req.get('user-agent'),
          'net.peer.ip': req.ip
        }
      }, parentContext ? trace.setSpanContext(context.active(), parentContext) : undefined)

      // Inject trace context into response headers
      const traceHeaders = TraceContext.inject(span as any)
      Object.entries(traceHeaders).forEach(([key, value]) => {
        res.setHeader(key, value)
      })

      // Store span in request for later use
      req.span = span

      // Hook response end
      const originalEnd = res.end
      res.end = function(...args: any[]) {
        // Set final span attributes
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.response.size': res.get('content-length') || 0
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
        metrics.recordHttpRequest(
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
      ;(context as any).with((trace as any).setSpan((context as any).active(), span), () => {
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
export function Trace(options?: { name?: string; kind?: any }) {
  return function(
    target: any,
    propertyName: string,
    descriptor: PropertyDescriptor
  ) {
    const telemetry = getTelemetry()
    return telemetry.traceMethod(target, propertyName, descriptor)
  }
}

export default getTelemetry
