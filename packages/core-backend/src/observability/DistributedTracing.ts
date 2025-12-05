/**
 * Distributed Tracing System
 * OpenTelemetry-based tracing for distributed system observability
 */

// OpenTelemetry type imports - using unknown for optional dependencies
type NodeTracerProviderType = unknown
type ResourceType = unknown
type SpanExporterType = unknown
type SpanType = unknown
type TracerType = unknown
type ContextType = unknown
type SpanProcessorType = unknown
type InstrumentationType = unknown
type AttributeValue = string | number | boolean | Array<string | number | boolean>

// Dynamic OpenTelemetry imports with proper typing
interface OtelSdkTraceNode {
  NodeTracerProvider: new (config: {
    resource: ResourceType
    forceFlushTimeoutMillis?: number
  }) => NodeTracerProviderType
}

interface ResourceClass {
  default: () => ResourceType
  new (attributes: Record<string, AttributeValue>): ResourceType
}

interface ResourceWithMerge {
  merge: (other: ResourceType) => ResourceType
}

interface OtelResources {
  Resource: ResourceClass
}

interface OtelSemanticConventions {
  SemanticResourceAttributes: {
    SERVICE_NAME: string
    SERVICE_VERSION: string
    DEPLOYMENT_ENVIRONMENT: string
  }
}

interface OtelSdkTraceBase {
  BatchSpanProcessor: new (exporter: SpanExporterType) => SpanProcessorType
  ConsoleSpanExporter: new () => SpanExporterType
  SimpleSpanProcessor: new (exporter: SpanExporterType) => SpanProcessorType
}

interface OtelExporterJaeger {
  JaegerExporter: new (config: {
    endpoint: string
    username?: string
    password?: string
  }) => SpanExporterType
}

interface OtelExporterZipkin {
  ZipkinExporter: new (config: {
    url: string
    serviceName?: string
  }) => SpanExporterType
}

interface InstrumentationConfig {
  requestHook?: (span: SpanType, request: unknown) => void
  responseHook?: (span: SpanType, response: unknown) => void
  ignoreIncomingPaths?: string[]
}

interface OtelInstrumentation {
  registerInstrumentations: (config: {
    instrumentations: InstrumentationType[]
  }) => void
}

interface OtelInstrumentationHttp {
  HttpInstrumentation: new (config: InstrumentationConfig) => InstrumentationType
}

interface OtelInstrumentationExpress {
  ExpressInstrumentation: new (config: {
    requestHook?: (span: SpanType, info: { route?: string; request: { params?: unknown } }) => void
  }) => InstrumentationType
}

interface OtelInstrumentationIoredis {
  IORedisInstrumentation: new (config: {
    requestHook?: (span: SpanType, info: { command: { name: string; args?: unknown[] } }) => void
  }) => InstrumentationType
}

interface OtelApi {
  trace: {
    getTracer: (name: string, version: string) => TracerType
    getActiveSpan: () => SpanType | undefined
    setSpan: (context: ContextType, span: SpanType) => ContextType
  }
  context: {
    active: () => ContextType
  }
  SpanKind: {
    INTERNAL: number
    SERVER: number
    CLIENT: number
    PRODUCER: number
    CONSUMER: number
  }
  SpanStatusCode: {
    UNSET: number
    OK: number
    ERROR: number
  }
}

let otelSdkTraceNode: OtelSdkTraceNode | null = null
let otelResources: OtelResources | null = null
let otelSemanticConventions: OtelSemanticConventions | null = null
let otelSdkTraceBase: OtelSdkTraceBase | null = null
let otelExporterJaeger: OtelExporterJaeger | null = null
let otelExporterZipkin: OtelExporterZipkin | null = null
let otelInstrumentation: OtelInstrumentation | null = null
let otelInstrumentationHttp: OtelInstrumentationHttp | null = null
let otelInstrumentationExpress: OtelInstrumentationExpress | null = null
let otelInstrumentationIoredis: OtelInstrumentationIoredis | null = null
let otelApi: OtelApi | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelSdkTraceNode = require('@opentelemetry/sdk-trace-node') as OtelSdkTraceNode
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelResources = require('@opentelemetry/resources') as OtelResources
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelSemanticConventions = require('@opentelemetry/semantic-conventions') as OtelSemanticConventions
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelSdkTraceBase = require('@opentelemetry/sdk-trace-base') as OtelSdkTraceBase
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelApi = require('@opentelemetry/api') as OtelApi
} catch {
  // OpenTelemetry core packages not installed
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelExporterJaeger = require('@opentelemetry/exporter-jaeger') as OtelExporterJaeger
} catch {
  // Jaeger exporter not installed
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelExporterZipkin = require('@opentelemetry/exporter-zipkin') as OtelExporterZipkin
} catch {
  // Zipkin exporter not installed
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelInstrumentation = require('@opentelemetry/instrumentation') as OtelInstrumentation
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelInstrumentationHttp = require('@opentelemetry/instrumentation-http') as OtelInstrumentationHttp
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelInstrumentationExpress = require('@opentelemetry/instrumentation-express') as OtelInstrumentationExpress
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  otelInstrumentationIoredis = require('@opentelemetry/instrumentation-ioredis') as OtelInstrumentationIoredis
} catch {
  // Instrumentation packages not installed
}

import { EventEmitter } from 'eventemitter3'

// Re-export SpanKind and SpanStatusCode for external use
export const SpanKind = otelApi?.SpanKind || {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4
}

export const SpanStatusCode = otelApi?.SpanStatusCode || {
  UNSET: 0,
  OK: 1,
  ERROR: 2
}

export interface TracingConfig {
  serviceName: string
  serviceVersion: string
  environment: string
  exporters?: {
    console?: boolean
    jaeger?: {
      endpoint: string
      username?: string
      password?: string
    }
    zipkin?: {
      url: string
      serviceName?: string
    }
    custom?: SpanExporterType
  }
  sampling?: {
    probability: number
  }
  propagators?: string[]
  instrumentations?: {
    http?: boolean
    express?: boolean
    database?: boolean
    redis?: boolean
    grpc?: boolean
  }
}

export interface TraceContext {
  traceId: string
  spanId: string
  parentSpanId?: string
  flags: number
  state?: string
  baggage?: Record<string, string>
}

export interface SpanStatus {
  code: number
  message?: string
}

export interface SpanMetadata {
  name: string
  kind: number
  attributes?: Record<string, AttributeValue>
  events?: Array<{
    name: string
    attributes?: Record<string, AttributeValue>
    timestamp?: number
  }>
  links?: Array<{
    context: TraceContext
    attributes?: Record<string, AttributeValue>
  }>
  status?: SpanStatus
}

// Internal interfaces for span operations
interface SpanWithContext {
  spanContext: () => {
    spanId: string
    traceId: string
    traceFlags: number
  }
  setStatus: (status: SpanStatus) => void
  end: () => void
  recordException: (error: Error) => void
  setAttributes: (attributes: Record<string, AttributeValue>) => void
  addEvent: (name: string, attributes?: Record<string, AttributeValue>, timestamp?: number) => void
}

interface TracerProviderWithMethods {
  addSpanProcessor: (processor: SpanProcessorType) => void
  register: () => void
  forceFlush: () => Promise<void>
  shutdown: () => Promise<void>
}

interface TracerWithStartSpan {
  startSpan: (
    name: string,
    options?: {
      kind?: number
      attributes?: Record<string, AttributeValue>
    },
    context?: ContextType
  ) => SpanWithContext
}

interface BaggageEntry {
  value: string
}

interface Baggage {
  setEntry: (key: string, entry: BaggageEntry) => void
  getEntry: (key: string) => BaggageEntry | undefined
}

interface ContextWithBaggage {
  getValue: (key: symbol) => Baggage | undefined
}

export class DistributedTracing extends EventEmitter {
  private provider: NodeTracerProviderType
  private tracer: TracerType
  private config: TracingConfig
  private activeSpans: Map<string, SpanType> = new Map()
  private spanMetrics: {
    created: number
    completed: number
    errors: number
    active: number
  } = {
    created: 0,
    completed: 0,
    errors: 0,
    active: 0
  }

  constructor(config: TracingConfig) {
    super()

    if (!otelSdkTraceNode || !otelResources || !otelSemanticConventions || !otelSdkTraceBase || !otelApi) {
      throw new Error('OpenTelemetry core packages are not installed')
    }

    this.config = config
    this.provider = this.initializeProvider()
    this.tracer = otelApi.trace.getTracer(config.serviceName, config.serviceVersion)
    this.setupInstrumentations()
    this.emit('tracing:initialized', config)
  }

  /**
   * Initialize the tracer provider
   */
  private initializeProvider(): NodeTracerProviderType {
    if (!otelSdkTraceNode || !otelResources || !otelSemanticConventions) {
      throw new Error('OpenTelemetry packages not available')
    }

    const Resource = otelResources.Resource
    const SemanticResourceAttributes = otelSemanticConventions.SemanticResourceAttributes

    const defaultResource = Resource.default() as unknown as ResourceWithMerge
    const resource = defaultResource.merge(
      new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: this.config.serviceVersion,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment
      })
    );

    const provider = new otelSdkTraceNode.NodeTracerProvider({
      resource,
      forceFlushTimeoutMillis: 10000
    });

    // Add exporters
    const exporterSetup = this.configureSpanExporters.bind(this);
    exporterSetup(provider);

    // Register the provider
    (provider as unknown as TracerProviderWithMethods).register()

    return provider
  }

  /**
   * Setup span exporters
   */
  private configureSpanExporters(provider: NodeTracerProviderType): void {
    if (!otelSdkTraceBase) return

    const exporters = this.config.exporters || {}
    const typedProvider = provider as unknown as TracerProviderWithMethods

    // Console exporter for development
    if (exporters.console) {
      const consoleExporter = new otelSdkTraceBase.ConsoleSpanExporter()
      typedProvider.addSpanProcessor(new otelSdkTraceBase.SimpleSpanProcessor(consoleExporter))
    }

    // Jaeger exporter
    if (exporters.jaeger && otelExporterJaeger) {
      const jaegerExporter = new otelExporterJaeger.JaegerExporter({
        endpoint: exporters.jaeger.endpoint,
        username: exporters.jaeger.username,
        password: exporters.jaeger.password
      })
      typedProvider.addSpanProcessor(new otelSdkTraceBase.BatchSpanProcessor(jaegerExporter))
    }

    // Zipkin exporter
    if (exporters.zipkin && otelExporterZipkin) {
      const zipkinExporter = new otelExporterZipkin.ZipkinExporter({
        url: exporters.zipkin.url,
        serviceName: exporters.zipkin.serviceName || this.config.serviceName
      })
      typedProvider.addSpanProcessor(new otelSdkTraceBase.BatchSpanProcessor(zipkinExporter))
    }

    // Custom exporter
    if (exporters.custom) {
      typedProvider.addSpanProcessor(new otelSdkTraceBase.BatchSpanProcessor(exporters.custom))
    }
  }

  /**
   * Setup auto-instrumentations
   */
  private setupInstrumentations(): void {
    if (!otelInstrumentation) return

    const instrumentations = this.config.instrumentations || {}
    const instrumentationList: InstrumentationType[] = []

    if (instrumentations.http !== false && otelInstrumentationHttp) {
      instrumentationList.push(
        new otelInstrumentationHttp.HttpInstrumentation({
          requestHook: (span: SpanType, request: unknown) => {
            const typedSpan = span as unknown as SpanWithContext
            const req = request as { headers?: Record<string, string | number> }
            typedSpan.setAttributes({
              'http.request.body.size': req.headers?.['content-length'] || 0
            })
          },
          responseHook: (span: SpanType, response: unknown) => {
            const typedSpan = span as unknown as SpanWithContext
            const res = response as { headers?: Record<string, string | number> }
            typedSpan.setAttributes({
              'http.response.body.size': res.headers?.['content-length'] || 0
            })
          },
          ignoreIncomingPaths: ['/health', '/metrics', '/metrics/prom']
        })
      )
    }

    if (instrumentations.express !== false && otelInstrumentationExpress) {
      instrumentationList.push(
        new otelInstrumentationExpress.ExpressInstrumentation({
          requestHook: (span: SpanType, info: { route?: string; request: { params?: unknown } }) => {
            const typedSpan = span as unknown as SpanWithContext
            typedSpan.setAttributes({
              'express.route': info.route || '',
              'express.params': JSON.stringify(info.request.params || {})
            })
          }
        })
      )
    }

    if (instrumentations.redis !== false && otelInstrumentationIoredis) {
      instrumentationList.push(
        new otelInstrumentationIoredis.IORedisInstrumentation({
          requestHook: (span: SpanType, info: { command: { name: string; args?: unknown[] } }) => {
            const typedSpan = span as unknown as SpanWithContext
            typedSpan.setAttributes({
              'redis.command': info.command.name,
              'redis.key': String(info.command.args?.[0] || '')
            })
          }
        })
      )
    }

    otelInstrumentation.registerInstrumentations({
      instrumentations: instrumentationList
    })
  }

  /**
   * Start a new span
   */
  startSpan(
    name: string,
    options?: {
      kind?: number
      attributes?: Record<string, AttributeValue>
      parent?: ContextType | SpanType
    }
  ): SpanType {
    if (!otelApi) {
      throw new Error('OpenTelemetry API not available')
    }

    const spanOptions = {
      kind: options?.kind || SpanKind.INTERNAL,
      attributes: options?.attributes
    }

    const typedTracer = this.tracer as unknown as TracerWithStartSpan
    let span: SpanWithContext

    if (options?.parent) {
      const parent = options.parent as { spanContext?: () => unknown }
      const parentContext = parent.spanContext
        ? otelApi.trace.setSpan(otelApi.context.active(), options.parent as SpanType)
        : options.parent as ContextType

      span = typedTracer.startSpan(name, spanOptions, parentContext)
    } else {
      span = typedTracer.startSpan(name, spanOptions)
    }

    const spanId = span.spanContext().spanId
    this.activeSpans.set(spanId, span as unknown as SpanType)
    this.spanMetrics.created++
    this.spanMetrics.active++

    this.emit('span:started', {
      name,
      spanId,
      traceId: span.spanContext().traceId
    })

    return span as unknown as SpanType
  }

  /**
   * End a span
   */
  endSpan(span: SpanType, status?: SpanStatus): void {
    const typedSpan = span as unknown as SpanWithContext

    if (status) {
      typedSpan.setStatus(status)
    }

    typedSpan.end()

    const spanId = typedSpan.spanContext().spanId
    this.activeSpans.delete(spanId)
    this.spanMetrics.completed++
    this.spanMetrics.active--

    if (status?.code === SpanStatusCode.ERROR) {
      this.spanMetrics.errors++
    }

    this.emit('span:ended', {
      spanId,
      traceId: typedSpan.spanContext().traceId,
      status
    })
  }

  /**
   * Create a traced function
   */
  traceFunction<T extends (...args: unknown[]) => unknown>(
    name: string,
    fn: T,
    options?: {
      kind?: number
      attributes?: Record<string, AttributeValue>
    }
  ): T {
    return ((...args: unknown[]) => {
      const span = this.startSpan(name, options)
      const typedSpan = span as unknown as SpanWithContext

      try {
        const result = fn(...args)

        if (result instanceof Promise) {
          return result
            .then((value) => {
              this.endSpan(span, { code: SpanStatusCode.OK })
              return value
            })
            .catch((error: unknown) => {
              const err = error instanceof Error ? error : new Error(String(error))
              typedSpan.recordException(err)
              this.endSpan(span, {
                code: SpanStatusCode.ERROR,
                message: err.message
              })
              throw error
            })
        }

        this.endSpan(span, { code: SpanStatusCode.OK })
        return result
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error))
        typedSpan.recordException(err)
        this.endSpan(span, {
          code: SpanStatusCode.ERROR,
          message: err.message
        })
        throw error
      }
    }) as T
  }

  /**
   * Create a traced async function
   */
  traceAsyncFunction<T extends (...args: unknown[]) => Promise<unknown>>(
    name: string,
    fn: T,
    options?: {
      kind?: number
      attributes?: Record<string, AttributeValue>
    }
  ): T {
    return (async (...args: unknown[]) => {
      const span = this.startSpan(name, options)
      const typedSpan = span as unknown as SpanWithContext

      try {
        const result = await fn(...args)
        this.endSpan(span, { code: SpanStatusCode.OK })
        return result
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error))
        typedSpan.recordException(err)
        this.endSpan(span, {
          code: SpanStatusCode.ERROR,
          message: err.message
        })
        throw error
      }
    }) as T
  }

  /**
   * Trace HTTP request
   */
  async traceHttpRequest(
    method: string,
    url: string,
    handler: () => Promise<unknown>,
    headers?: Record<string, string>
  ): Promise<unknown> {
    const span = this.startSpan(`HTTP ${method} ${url}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.method': method,
        'http.url': url,
        'http.headers': JSON.stringify(headers || {})
      }
    })
    const typedSpan = span as unknown as SpanWithContext

    try {
      const startTime = Date.now()
      const result = await handler()
      const duration = Date.now() - startTime

      const res = result as { status?: number }
      typedSpan.setAttributes({
        'http.status_code': res.status || 200,
        'http.response_time': duration
      })

      this.endSpan(span, { code: SpanStatusCode.OK })
      return result
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error))
      typedSpan.recordException(err)
      typedSpan.setAttributes({
        'http.error': err.message
      })

      this.endSpan(span, {
        code: SpanStatusCode.ERROR,
        message: err.message
      })

      throw error
    }
  }

  /**
   * Trace database query
   */
  async traceDbQuery(
    operation: string,
    query: string,
    handler: () => Promise<unknown>,
    params?: unknown[]
  ): Promise<unknown> {
    const span = this.startSpan(`DB ${operation}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.operation': operation,
        'db.statement': query,
        'db.params': JSON.stringify(params || [])
      }
    })
    const typedSpan = span as unknown as SpanWithContext

    try {
      const startTime = Date.now()
      const result = await handler()
      const duration = Date.now() - startTime

      const dbResult = result as { rowCount?: number }
      typedSpan.setAttributes({
        'db.rows_affected': dbResult.rowCount || 0,
        'db.duration': duration
      })

      this.endSpan(span, { code: SpanStatusCode.OK })
      return result
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error))
      typedSpan.recordException(err)
      typedSpan.setAttributes({
        'db.error': err.message
      })

      this.endSpan(span, {
        code: SpanStatusCode.ERROR,
        message: err.message
      })

      throw error
    }
  }

  /**
   * Add event to current span
   */
  addEvent(
    name: string,
    attributes?: Record<string, AttributeValue>,
    timestamp?: number
  ): void {
    if (!otelApi) return
    const span = otelApi.trace.getActiveSpan()
    if (span) {
      const typedSpan = span as unknown as SpanWithContext
      typedSpan.addEvent(name, attributes, timestamp)
    }
  }

  /**
   * Set attributes on current span
   */
  setAttributes(attributes: Record<string, AttributeValue>): void {
    if (!otelApi) return
    const span = otelApi.trace.getActiveSpan()
    if (span) {
      const typedSpan = span as unknown as SpanWithContext
      typedSpan.setAttributes(attributes)
    }
  }

  /**
   * Set baggage
   */
  setBaggage(key: string, value: string): void {
    if (!otelApi) return
    const context = otelApi.context.active() as unknown as ContextWithBaggage
    const baggage = context.getValue(Symbol.for('OpenTelemetry Baggage'))
    if (baggage) {
      baggage.setEntry(key, { value })
    }
  }

  /**
   * Get baggage
   */
  getBaggage(key: string): string | undefined {
    if (!otelApi) return undefined
    const context = otelApi.context.active() as unknown as ContextWithBaggage
    const baggage = context.getValue(Symbol.for('OpenTelemetry Baggage'))
    if (baggage) {
      const entry = baggage.getEntry(key)
      return entry?.value
    }
    return undefined
  }

  /**
   * Extract trace context from headers
   */
  extractTraceContext(headers: Record<string, string>): TraceContext | null {
    const traceParent = headers['traceparent'] || headers['Traceparent']
    if (!traceParent) return null

    const parts = traceParent.split('-')
    if (parts.length !== 4) return null

    return {
      traceId: parts[1],
      spanId: parts[2],
      flags: parseInt(parts[3], 16),
      state: headers['tracestate'] || headers['Tracestate']
    }
  }

  /**
   * Inject trace context into headers
   */
  injectTraceContext(headers: Record<string, string>): Record<string, string> {
    if (!otelApi) return headers
    const span = otelApi.trace.getActiveSpan()
    if (!span) return headers

    const typedSpan = span as unknown as SpanWithContext
    const spanContext = typedSpan.spanContext()
    headers['traceparent'] = `00-${spanContext.traceId}-${spanContext.spanId}-0${spanContext.traceFlags}`

    return headers
  }

  /**
   * Create child span
   */
  createChildSpan(
    name: string,
    parentSpan: SpanType,
    options?: {
      kind?: number
      attributes?: Record<string, AttributeValue>
    }
  ): SpanType {
    return this.startSpan(name, {
      ...options,
      parent: parentSpan
    })
  }

  /**
   * Get active span
   */
  getActiveSpan(): SpanType | undefined {
    if (!otelApi) return undefined
    return otelApi.trace.getActiveSpan() as SpanType | undefined
  }

  /**
   * Get span by ID
   */
  getSpan(spanId: string): SpanType | undefined {
    return this.activeSpans.get(spanId)
  }

  /**
   * Get metrics
   */
  getMetrics(): {
    created: number
    completed: number
    errors: number
    active: number
    errorRate: number
  } {
    return {
      ...this.spanMetrics,
      errorRate: this.spanMetrics.completed > 0
        ? (this.spanMetrics.errors / this.spanMetrics.completed) * 100
        : 0
    }
  }

  /**
   * Force flush all spans
   */
  async flush(): Promise<void> {
    const typedProvider = this.provider as unknown as TracerProviderWithMethods
    await typedProvider.forceFlush()
  }

  /**
   * Shutdown tracing
   */
  async shutdown(): Promise<void> {
    // End all active spans - use Array.from to avoid iteration issues with unknown type
    const spans = Array.from(this.activeSpans.entries())
    for (const [_spanId, span] of spans) {
      this.endSpan(span, {
        code: SpanStatusCode.ERROR,
        message: 'Shutdown forced'
      })
    }

    const typedProvider = this.provider as unknown as TracerProviderWithMethods
    await typedProvider.shutdown()
    this.removeAllListeners()
    this.emit('tracing:shutdown')
  }
}

export default DistributedTracing
