/**
 * Event Bus Service
 * Central event distribution system for plugin communication and system events
 */

import { EventEmitter } from 'eventemitter3'
import { db } from '../db/db'
import { sql } from 'kysely'
import { Logger } from './logger'
import * as Ajv from 'ajv'
import type { CoreAPI } from '../types/plugin'

// JSON Schema type for event validation
interface JSONSchema {
  type?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  [key: string]: unknown
}

interface EventType {
  id: string
  event_name: string
  category: string
  payload_schema?: JSONSchema | string
  metadata_schema?: JSONSchema | string
  is_async: boolean
  is_persistent: boolean
  is_transactional: boolean
  max_retries: number
  retry_delay_ms: number
  ttl_seconds?: number
}

// Filter expression for event matching
interface FilterExpression {
  [key: string]: unknown
}

// Handler configuration
interface HandlerConfig {
  [key: string]: unknown
}

// Replay criteria interface
interface ReplayCriteria {
  event_ids?: string[]
  event_pattern?: string
  time_range?: { start: Date; end: Date }
  subscription_ids?: string[]
}

interface EventSubscription {
  id: string
  subscriber_id: string
  subscriber_type: string
  event_pattern: string
  event_types?: string[]
  filter_expression?: FilterExpression
  handler_type: string
  handler_config: HandlerConfig
  priority: number
  is_sequential: boolean
  timeout_ms: number
  transform_enabled: boolean
  transform_template?: string
}

interface Event {
  event_id: string
  event_name: string
  event_version: string
  source_id: string
  source_type: string
  correlation_id?: string
  causation_id?: string
  payload: unknown
  metadata: Record<string, unknown>
  occurred_at: Date
}

interface EventHandler {
  (event: Event, context: EventContext): Promise<unknown>
}

interface EventContext {
  subscription: EventSubscription
  attempt: number
  core: CoreAPI
  logger: Logger
}

interface PluginEventPermissions {
  plugin_id: string
  can_emit: string[]
  can_subscribe: string[]
  max_events_per_minute: number
  max_subscriptions: number
  max_event_size_kb: number
}

export class EventBusService extends EventEmitter {
  private logger: Logger
  private ajv: Ajv.Ajv
  private subscriptions = new Map<string, EventSubscription[]>()
  private handlers = new Map<string, EventHandler>()
  private pluginPermissions = new Map<string, PluginEventPermissions>()
  private processingInterval?: NodeJS.Timeout
  private cleanupInterval?: NodeJS.Timeout
  private metricsInterval?: NodeJS.Timeout
  private isProcessing = false
  private eventQueue: Event[] = []
  private core?: CoreAPI
  private degradedMode: boolean = false
  private allowDegradation: boolean = false

  constructor() {
    super()
    this.logger = new Logger('EventBus')
    this.ajv = new Ajv.default({ allErrors: true })
    this.allowDegradation = process.env.EVENT_BUS_OPTIONAL === '1'
    this.setupInternalHandlers()
  }

  /**
   * Initialize the event bus
   */
  async initialize(core: CoreAPI): Promise<void> {
    this.logger.info('Initializing EventBus service')
    this.core = core

    try {
      // Load event types
      await this.loadEventTypes()

      // Load subscriptions
      await this.loadSubscriptions()

      // Load plugin permissions
      await this.loadPluginPermissions()

      // Start processors
      this.startEventProcessor()
      this.startCleanupProcessor()
      this.startMetricsProcessor()

      // Register system events
      await this.registerSystemEvents()

      this.logger.info('EventBus service initialized successfully')
    } catch (error) {
      // Check if this is a "table does not exist" error (PostgreSQL error code 42P01)
      const isTableMissing = this.isDatabaseSchemaError(error)

      if (isTableMissing && this.allowDegradation) {
        this.degradedMode = true
        this.logger.warn('⚠️  EventBus initialized in DEGRADED mode - database tables not found')
        this.logger.warn('⚠️  Event publishing and subscription will be no-ops')
        this.logger.warn('⚠️  Set EVENT_BUS_OPTIONAL=1 environment variable is active')
        return
      }

      // If degradation not allowed or different error, re-throw
      this.logger.error('Failed to initialize EventBus service:', error instanceof Error ? error : undefined)
      throw error
    }
  }

  /**
   * Check if error is database schema error (table/relation does not exist)
   */
  private isDatabaseSchemaError(error: unknown): boolean {
    // PostgreSQL error code 42P01: "relation does not exist"
    const err = error as { code?: string; message?: string } | null
    if (err?.code === '42P01') {
      return true
    }
    // Also check error message for common patterns
    if (err?.message && typeof err.message === 'string') {
      const message = err.message.toLowerCase()
      return message.includes('relation') && message.includes('does not exist') ||
             message.includes('table') && message.includes('does not exist')
    }
    return false
  }

  /**
   * Publish an event (async version with persistence and validation)
   */
  async publish(
    eventName: string,
    payload: unknown,
    options?: {
      source_id?: string
      source_type?: string
      correlation_id?: string
      causation_id?: string
      metadata?: Record<string, unknown>
    }
  ): Promise<string> {
    // In degraded mode, return a fake event ID without actually emitting
    if (this.degradedMode) {
      this.logger.debug(`[DEGRADED] Skipping event emission: ${eventName}`)
      return `evt_degraded_${Date.now()}`
    }

    const eventId = this.generateEventId()

    // Validate permission
    if (options?.source_type === 'plugin') {
      await this.validatePluginPermission(options.source_id!, 'emit', eventName)
    }

    // Validate event schema
    await this.validateEventSchema(eventName, payload)

    const event: Event = {
      event_id: eventId,
      event_name: eventName,
      event_version: '1.0.0',
      source_id: options?.source_id || 'system',
      source_type: options?.source_type || 'system',
      correlation_id: options?.correlation_id,
      causation_id: options?.causation_id,
      payload,
      metadata: options?.metadata || {},
      occurred_at: new Date()
    }

    // Get event type configuration
    const eventType = await this.getEventType(eventName)

    if (eventType?.is_persistent) {
      // Store in database
      await this.persistEvent(event, eventType)
    }

    if (eventType?.is_async) {
      // Queue for async processing
      this.eventQueue.push(event)
    } else {
      // Process synchronously
      await this.processEvent(event)
    }

    // Emit locally for real-time listeners
    super.emit(eventName, event)

    this.logger.debug(`Event emitted: ${eventName} (${eventId})`)
    return eventId
  }

  /**
   * Subscribe to events
   */
  async subscribe(
    subscriberId: string,
    eventPattern: string,
    handler: EventHandler,
    options?: {
      subscriber_type?: string
      filter?: FilterExpression
      priority?: number
      transform?: string
      timeout_ms?: number
    }
  ): Promise<string> {
    // In degraded mode, return a fake subscription ID without actually subscribing
    if (this.degradedMode) {
      this.logger.debug(`[DEGRADED] Skipping event subscription: ${subscriberId} -> ${eventPattern}`)
      return `sub_degraded_${Date.now()}`
    }

    // Validate permission
    if (options?.subscriber_type === 'plugin') {
      await this.validatePluginPermission(subscriberId, 'subscribe', eventPattern)
    }

    // Create subscription
    const subscription: EventSubscription = {
      id: this.generateSubscriptionId(),
      subscriber_id: subscriberId,
      subscriber_type: options?.subscriber_type || 'service',
      event_pattern: eventPattern,
      filter_expression: options?.filter,
      handler_type: 'function',
      handler_config: {},
      priority: options?.priority || 0,
      is_sequential: false,
      timeout_ms: options?.timeout_ms || 30000,
      transform_enabled: !!options?.transform,
      transform_template: options?.transform
    }

    // Store subscription
    await this.storeSubscription(subscription)

    // Register handler
    this.handlers.set(subscription.id, handler)

    // Update in-memory cache
    const patterns = this.getMatchingPatterns(eventPattern)
    for (const pattern of patterns) {
      if (!this.subscriptions.has(pattern)) {
        this.subscriptions.set(pattern, [])
      }
      this.subscriptions.get(pattern)!.push(subscription)
    }

    // Register local listener
    if (!eventPattern.includes('*')) {
      super.on(eventPattern, async (event: Event) => {
        await this.handleLocalEvent(event, subscription, handler)
      })
    }

    this.logger.info(`Subscription created: ${subscriberId} -> ${eventPattern}`)
    return subscription.id
  }

  /**
   * Unsubscribe from events
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    // Remove from database
    await db
      .deleteFrom('event_subscriptions')
      .where('id', '=', subscriptionId)
      .execute()

    // Remove handler
    this.handlers.delete(subscriptionId)

    // Update cache
    for (const [pattern, subs] of this.subscriptions) {
      const index = subs.findIndex(s => s.id === subscriptionId)
      if (index !== -1) {
        subs.splice(index, 1)
        if (subs.length === 0) {
          this.subscriptions.delete(pattern)
        }
      }
    }

    this.logger.info(`Subscription removed: ${subscriptionId}`)
  }

  /**
   * Register an event type
   */
  async registerEventType(
    eventName: string,
    options?: {
      category?: string
      payload_schema?: JSONSchema
      metadata_schema?: JSONSchema
      is_async?: boolean
      is_persistent?: boolean
      ttl_seconds?: number
      max_retries?: number
    }
  ): Promise<void> {
    await db
      .insertInto('event_types')
      .values({
        event_name: eventName,
        category: options?.category || 'system',
        payload_schema: options?.payload_schema ? JSON.stringify(options.payload_schema) : null,
        metadata_schema: options?.metadata_schema ? JSON.stringify(options.metadata_schema) : null,
        is_async: options?.is_async ?? false,
        is_persistent: options?.is_persistent ?? true,
        is_transactional: false,
        ttl_seconds: options?.ttl_seconds || null,
        max_retries: options?.max_retries ?? 3,
        retry_delay_ms: 1000,
        is_active: true
      })
      .onConflict((oc) => oc
        .column('event_name')
        .doUpdateSet({
          payload_schema: options?.payload_schema ? JSON.stringify(options.payload_schema) : null
        })
      )
      .execute()

    this.logger.info(`Event type registered: ${eventName}`)
  }

  /**
   * Replay events
   */
  async replayEvents(
    criteria: ReplayCriteria,
    reason: string
  ): Promise<string> {
    const replayId = this.generateReplayId()

    // Create replay record
    await db
      .insertInto('event_replays')
      .values({
        id: replayId,
        replay_type: this.determineReplayType(criteria),
        event_ids: criteria.event_ids || null,
        event_pattern: criteria.event_pattern || null,
        time_range_start: criteria.time_range?.start?.toISOString() || null,
        time_range_end: criteria.time_range?.end?.toISOString() || null,
        subscription_ids: criteria.subscription_ids || null,
        status: 'pending',
        initiated_by: 'system',
        reason,
        started_at: null,
        completed_at: null
      })
      .execute()

    // Start replay in background
    this.startReplay(replayId, criteria)

    return replayId
  }

  /**
   * Get event metrics
   */
  async getMetrics(
    eventName?: string,
    timeRange?: { start: Date; end: Date }
  ): Promise<unknown[]> {
    let query = db
      .selectFrom('event_aggregates')
      .selectAll()

    if (eventName) {
      query = query.where('event_name', '=', eventName)
    }

    if (timeRange) {
      query = query
        .where('window_start', '>=', timeRange.start)
        .where('window_end', '<=', timeRange.end)
    }

    const metrics = await query
      .orderBy('window_start', 'desc')
      .execute()

    return metrics
  }

  /**
   * Set plugin permissions
   */
  async setPluginPermissions(
    pluginId: string,
    permissions: {
      can_emit?: string[]
      can_subscribe?: string[]
      max_events_per_minute?: number
      max_subscriptions?: number
    }
  ): Promise<void> {
    await db
      .insertInto('plugin_event_permissions')
      .values({
        plugin_id: pluginId,
        can_emit: permissions.can_emit || null,
        can_subscribe: permissions.can_subscribe || null,
        max_events_per_minute: permissions.max_events_per_minute ?? 1000,
        max_subscriptions: permissions.max_subscriptions ?? 100,
        max_event_size_kb: 1024,
        events_emitted_today: 0,
        events_received_today: 0,
        quota_reset_at: null,
        is_active: true,
        is_suspended: false
      })
      .onConflict((oc) => oc
        .column('plugin_id')
        .doUpdateSet({
          can_emit: permissions.can_emit || null,
          can_subscribe: permissions.can_subscribe || null,
          max_events_per_minute: permissions.max_events_per_minute ?? 1000,
          max_subscriptions: permissions.max_subscriptions ?? 100
        })
      )
      .execute()

    await this.loadPluginPermissions()
  }

  /**
   * Private: Process event
   */
  private async processEvent(event: Event): Promise<void> {
    const startTime = Date.now()

    // Find matching subscriptions
    const subscriptions = await this.findMatchingSubscriptions(event.event_name)

    // Sort by priority
    subscriptions.sort((a, b) => b.priority - a.priority)

    // Process each subscription
    for (const subscription of subscriptions) {
      try {
        // Check filter
        if (subscription.filter_expression && !this.matchesFilter(event, subscription.filter_expression)) {
          continue
        }

        // Transform if needed
        let processedEvent = event
        if (subscription.transform_enabled && subscription.transform_template) {
          processedEvent = this.transformEvent(event, subscription.transform_template)
        }

        // Get handler
        const handler = this.handlers.get(subscription.id)
        if (!handler) {
          this.logger.warn(`No handler found for subscription ${subscription.id}`)
          continue
        }

        // Create context
        const context: EventContext = {
          subscription,
          attempt: 1,
          core: this.core!,
          logger: this.logger
        }

        // Execute handler with timeout
        const timeout = subscription.timeout_ms
        // Handler result currently unused but execution required for side effects
        await this.executeWithTimeout(
          handler(processedEvent, context),
          timeout
        )

        // Log delivery
        await this.logDelivery(event.event_id, subscription.id, true, Date.now() - startTime)

        // Update subscription stats
        await this.updateSubscriptionStats(subscription.id, true)

        // If sequential, wait for completion
        if (subscription.is_sequential) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        this.logger.error(`Failed to process event for subscription ${subscription.id}:`, error instanceof Error ? error : undefined)

        // Log failed delivery
        await this.logDelivery(event.event_id, subscription.id, false, Date.now() - startTime, errorMessage)

        // Update subscription stats
        await this.updateSubscriptionStats(subscription.id, false)

        // Add to dead letter queue if max retries exceeded
        await this.addToDeadLetter(event, subscription.id, errorMessage)
      }
    }

    // Update event status
    await db
      .updateTable('event_store')
      .set({
        status: 'processed',
        processed_at: new Date()
      })
      .where('event_id', '=', event.event_id)
      .execute()
  }

  /**
   * Private: Handle local event
   */
  private async handleLocalEvent(
    event: Event,
    subscription: EventSubscription,
    handler: EventHandler
  ): Promise<void> {
    try {
      const context: EventContext = {
        subscription,
        attempt: 1,
        core: this.core!,
        logger: this.logger
      }

      await handler(event, context)
    } catch (error) {
      this.logger.error(`Local event handler error:`, error instanceof Error ? error : undefined)
    }
  }

  /**
   * Private: Validate event schema
   */
  private async validateEventSchema(eventName: string, payload: unknown): Promise<void> {
    const eventType = await this.getEventType(eventName)
    if (!eventType?.payload_schema) return

    // payload_schema is already parsed in getEventType
    const schema = typeof eventType.payload_schema === 'string'
      ? JSON.parse(eventType.payload_schema) as JSONSchema
      : eventType.payload_schema
    const validate = this.ajv.compile(schema)

    if (!validate(payload)) {
      throw new Error(`Invalid event payload: ${JSON.stringify(validate.errors)}`)
    }
  }

  /**
   * Private: Validate plugin permission
   */
  private async validatePluginPermission(
    pluginId: string,
    action: 'emit' | 'subscribe',
    eventPattern: string
  ): Promise<void> {
    const permissions = this.pluginPermissions.get(pluginId)
    if (!permissions) {
      throw new Error(`Plugin ${pluginId} has no event permissions`)
    }

    const allowedPatterns = action === 'emit' ? permissions.can_emit : permissions.can_subscribe

    if (!allowedPatterns.some(pattern => this.matchesPattern(eventPattern, pattern))) {
      throw new Error(`Plugin ${pluginId} is not allowed to ${action} event: ${eventPattern}`)
    }

    // Check rate limits
    if (action === 'emit') {
      await this.checkRateLimit(pluginId, permissions.max_events_per_minute)
    }
  }

  /**
   * Private: Persist event
   */
  private async persistEvent(event: Event, eventType: EventType): Promise<void> {
    await db
      .insertInto('event_store')
      .values({
        event_id: event.event_id,
        event_name: event.event_name,
        event_version: event.event_version,
        source_id: event.source_id,
        source_type: event.source_type,
        correlation_id: event.correlation_id || null,
        causation_id: event.causation_id || null,
        payload: JSON.stringify(event.payload),
        metadata: JSON.stringify(event.metadata),
        occurred_at: event.occurred_at.toISOString(),
        received_at: new Date().toISOString(),
        processed_at: null,
        status: 'pending',
        expires_at: eventType.ttl_seconds
          ? new Date(Date.now() + eventType.ttl_seconds * 1000).toISOString()
          : null
      })
      .execute()
  }

  /**
   * Private: Find matching subscriptions
   */
  private async findMatchingSubscriptions(eventName: string): Promise<EventSubscription[]> {
    const subscriptions: EventSubscription[] = []

    // Check exact match
    if (this.subscriptions.has(eventName)) {
      subscriptions.push(...this.subscriptions.get(eventName)!)
    }

    // Check pattern matches
    for (const [pattern, subs] of this.subscriptions) {
      if (pattern.includes('*') && this.matchesPattern(eventName, pattern)) {
        subscriptions.push(...subs)
      }
    }

    // Remove duplicates
    return Array.from(new Map(subscriptions.map(s => [s.id, s])).values())
  }

  /**
   * Private: Match pattern
   */
  private matchesPattern(eventName: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
    return regex.test(eventName)
  }

  /**
   * Private: Match filter
   */
  private matchesFilter(event: Event, filter: FilterExpression): boolean {
    // Simplified filter matching - in production use JSONPath or similar
    try {
      const eventPayload = event.payload as Record<string, unknown>
      for (const [key, value] of Object.entries(filter)) {
        if (eventPayload[key] !== value) {
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * Private: Transform event
   */
  private transformEvent(event: Event, template: string): Event {
    // Simplified transformation - in production use template engine
    try {
      const transformed = JSON.parse(template.replace(/\{\{(.+?)\}\}/g, (_match, path) => {
        const value = this.getNestedValue(event as unknown as Record<string, unknown>, path)
        return JSON.stringify(value)
      })) as unknown

      return {
        ...event,
        payload: transformed
      }
    } catch (error) {
      this.logger.error('Event transformation failed:', error instanceof Error ? error : undefined)
      return event
    }
  }

  /**
   * Private: Get nested value
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce((current: unknown, key) => {
      if (current && typeof current === 'object' && key in current) {
        return (current as Record<string, unknown>)[key]
      }
      return undefined
    }, obj as unknown)
  }

  /**
   * Private: Execute with timeout
   */
  private async executeWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Handler timeout')), timeout)
    })

    return Promise.race([promise, timeoutPromise])
  }

  /**
   * Private: Log delivery
   */
  private async logDelivery(
    eventId: string,
    subscriptionId: string,
    success: boolean,
    duration: number,
    error?: string
  ): Promise<void> {
    await db
      .insertInto('event_deliveries')
      .values({
        event_id: eventId,
        subscription_id: subscriptionId,
        started_at: new Date(Date.now() - duration).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: duration,
        success,
        error_message: error || null
      })
      .execute()
  }

  /**
   * Private: Update subscription stats
   */
  private async updateSubscriptionStats(
    subscriptionId: string,
    success: boolean
  ): Promise<void> {
    await db
      .updateTable('event_subscriptions')
      .set({
        total_events_processed: sql`total_events_processed + 1`,
        total_events_failed: success ? sql`total_events_failed` : sql`total_events_failed + 1`,
        last_event_at: new Date().toISOString()
      })
      .where('id', '=', subscriptionId)
      .execute()
  }

  /**
   * Private: Add to dead letter queue
   * Note: event_dead_letters table may not exist in minimal schema, operation is optional
   */
  private async addToDeadLetter(
    event: Event,
    subscriptionId: string,
    error: string
  ): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any)
        .insertInto('event_dead_letters')
        .values({
          event_id: event.event_id,
          subscription_id: subscriptionId,
          event_name: event.event_name,
          event_data: JSON.stringify(event),
          failure_reason: error,
          error_message: error,
          first_failed_at: new Date().toISOString(),
          last_failed_at: new Date().toISOString()
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .onConflict((oc: any) => oc
          .columns(['event_id', 'subscription_id'])
          .doUpdateSet({
            failure_count: sql`failure_count + 1`,
            last_failed_at: new Date().toISOString(),
            error_message: error
          })
        )
        .execute()
    } catch {
      // Table may not exist, log and continue
      this.logger.debug(`Could not add to dead letter queue: ${event.event_id}`)
    }
  }

  /**
   * Private: Check rate limit
   */
  private async checkRateLimit(pluginId: string, limit: number): Promise<void> {
    const permissions = await db
      .selectFrom('plugin_event_permissions')
      .select(['events_emitted_today'])
      .where('plugin_id', '=', pluginId)
      .executeTakeFirst()

    if (permissions && permissions.events_emitted_today >= limit) {
      throw new Error(`Rate limit exceeded for plugin ${pluginId}`)
    }

    await db
      .updateTable('plugin_event_permissions')
      .set({
        events_emitted_today: sql`events_emitted_today + 1`
      })
      .where('plugin_id', '=', pluginId)
      .execute()
  }

  /**
   * Private: Load event types
   */
  private async loadEventTypes(): Promise<void> {
    const types = await db
      .selectFrom('event_types')
      .selectAll()
      .where('is_active', '=', true)
      .execute()

    this.logger.info(`Loaded ${types.length} event types`)
  }

  /**
   * Private: Load subscriptions
   */
  private async loadSubscriptions(): Promise<void> {
    const subs = await db
      .selectFrom('event_subscriptions')
      .selectAll()
      .where('is_active', '=', true)
      .where('is_paused', '=', false)
      .execute()

    this.subscriptions.clear()

    for (const sub of subs) {
      const subscription = {
        ...sub,
        handler_config: JSON.parse(sub.handler_config as string),
        filter_expression: sub.filter_expression ? JSON.parse(sub.filter_expression as string) : null
      } as EventSubscription

      const patterns = this.getMatchingPatterns(subscription.event_pattern)
      for (const pattern of patterns) {
        if (!this.subscriptions.has(pattern)) {
          this.subscriptions.set(pattern, [])
        }
        this.subscriptions.get(pattern)!.push(subscription)
      }
    }

    this.logger.info(`Loaded ${subs.length} subscriptions`)
  }

  /**
   * Private: Load plugin permissions
   */
  private async loadPluginPermissions(): Promise<void> {
    const permissions = await db
      .selectFrom('plugin_event_permissions')
      .selectAll()
      .where('is_active', '=', true)
      .where('is_suspended', '=', false)
      .execute()

    this.pluginPermissions.clear()

    for (const perm of permissions) {
      this.pluginPermissions.set(perm.plugin_id, perm as PluginEventPermissions)
    }

    this.logger.info(`Loaded permissions for ${permissions.length} plugins`)
  }

  /**
   * Private: Get event type
   */
  private async getEventType(eventName: string): Promise<EventType | null> {
    const type = await db
      .selectFrom('event_types')
      .selectAll()
      .where('event_name', '=', eventName)
      .where('is_active', '=', true)
      .executeTakeFirst()

    if (!type) return null

    return {
      ...type,
      payload_schema: type.payload_schema ? JSON.parse(type.payload_schema as string) : null,
      metadata_schema: type.metadata_schema ? JSON.parse(type.metadata_schema as string) : null
    } as EventType
  }

  /**
   * Private: Store subscription
   */
  private async storeSubscription(subscription: EventSubscription): Promise<void> {
    await db
      .insertInto('event_subscriptions')
      .values({
        id: subscription.id,
        subscriber_id: subscription.subscriber_id,
        subscriber_type: subscription.subscriber_type,
        event_pattern: subscription.event_pattern,
        event_types: subscription.event_types || null,
        filter_expression: subscription.filter_expression ? JSON.stringify(subscription.filter_expression) : null,
        handler_type: subscription.handler_type,
        handler_config: JSON.stringify(subscription.handler_config),
        priority: subscription.priority,
        is_sequential: subscription.is_sequential,
        timeout_ms: subscription.timeout_ms,
        transform_enabled: subscription.transform_enabled,
        transform_template: subscription.transform_template || null,
        is_active: true,
        is_paused: false,
        total_events_processed: 0,
        total_events_failed: 0,
        last_event_at: null
      })
      .execute()
  }

  /**
   * Private: Get matching patterns
   */
  private getMatchingPatterns(pattern: string): string[] {
    if (!pattern.includes('*')) {
      return [pattern]
    }

    // For wildcard patterns, return the pattern itself
    // and any more specific patterns that might match
    const patterns = [pattern]

    // Add common base patterns
    const parts = pattern.split('.')
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] === '*') {
        patterns.push(parts.slice(0, i).join('.') + '.*')
      }
    }

    return patterns
  }

  /**
   * Private: Determine replay type
   */
  private determineReplayType(criteria: ReplayCriteria): string {
    if (criteria.event_ids?.length) return 'single_event'
    if (criteria.time_range) return 'time_range'
    if (criteria.subscription_ids?.length) return 'subscription'
    if (criteria.event_pattern) return 'pattern'
    return 'single_event'
  }

  /**
   * Private: Start replay
   */
  private async startReplay(replayId: string, _criteria: ReplayCriteria): Promise<void> {
    // This would be implemented as an async task
    // For now, just update status
    await db
      .updateTable('event_replays')
      .set({
        status: 'running',
        started_at: new Date()
      })
      .where('id', '=', replayId)
      .execute()

    // Replay logic would go here...

    await db
      .updateTable('event_replays')
      .set({
        status: 'completed',
        completed_at: new Date()
      })
      .where('id', '=', replayId)
      .execute()
  }

  /**
   * Private: Register system events
   */
  private async registerSystemEvents(): Promise<void> {
    const systemEvents = [
      // Plugin events
      'plugin.loaded',
      'plugin.unloaded',
      'plugin.error',

      // Data events
      'data.created',
      'data.updated',
      'data.deleted',

      // Workflow events
      'workflow.started',
      'workflow.completed',
      'workflow.failed',

      // User events
      'user.login',
      'user.logout',
      'user.created',

      // System events
      'system.startup',
      'system.shutdown',
      'system.error'
    ]

    for (const eventName of systemEvents) {
      await this.registerEventType(eventName, {
        category: 'system',
        is_persistent: true,
        ttl_seconds: 86400 // 1 day
      })
    }
  }

  /**
   * Private: Setup internal handlers
   */
  private setupInternalHandlers(): void {
    // Log all events in debug mode
    if (process.env.LOG_LEVEL === 'debug') {
      this.on('*', (event: Event) => {
        this.logger.debug(`Event: ${event.event_name}`, event as unknown as Record<string, unknown>)
      })
    }
  }

  /**
   * Private: Start event processor
   */
  private startEventProcessor(): void {
    this.processingInterval = setInterval(async () => {
      if (this.isProcessing || this.eventQueue.length === 0) return

      this.isProcessing = true
      try {
        const batch = this.eventQueue.splice(0, 10)
        for (const event of batch) {
          await this.processEvent(event)
        }
      } catch (error) {
        this.logger.error('Event processor error:', error instanceof Error ? error : undefined)
      } finally {
        this.isProcessing = false
      }
    }, 100) // Process every 100ms
  }

  /**
   * Private: Start cleanup processor
   */
  private startCleanupProcessor(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanupOldEvents()
      } catch (error) {
        this.logger.error('Cleanup processor error:', error instanceof Error ? error : undefined)
      }
    }, 3600000) // Run every hour
  }

  /**
   * Private: Start metrics processor
   */
  private startMetricsProcessor(): void {
    this.metricsInterval = setInterval(async () => {
      try {
        await this.updateMetrics()
      } catch (error) {
        this.logger.error('Metrics processor error:', error instanceof Error ? error : undefined)
      }
    }, 60000) // Run every minute
  }

  /**
   * Private: Cleanup old events
   */
  private async cleanupOldEvents(): Promise<void> {
    // Archive old events
    await db
      .updateTable('event_store')
      .set({ status: 'archived' })
      .where('status', '=', 'processed')
      .where('processed_at', '<', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
      .execute()

    // Delete archived events
    await db
      .deleteFrom('event_store')
      .where('status', '=', 'archived')
      .where('processed_at', '<', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
      .execute()

    // Delete old deliveries
    await db
      .deleteFrom('event_deliveries')
      .where('completed_at', '<', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      .execute()

    // Reset quotas
    await db
      .updateTable('plugin_event_permissions')
      .set({
        events_emitted_today: 0,
        events_received_today: 0,
        quota_reset_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      })
      .where('quota_reset_at', '<', new Date())
      .execute()

    this.logger.info('Cleaned up old events')
  }

  /**
   * Private: Update metrics
   */
  private async updateMetrics(): Promise<void> {
    // This would aggregate metrics
    // For now, just log stats
    const stats = {
      subscriptions: this.subscriptions.size,
      handlers: this.handlers.size,
      queueSize: this.eventQueue.length
    }

    this.logger.debug('Event bus metrics:', stats)
  }

  /**
   * Private: Generate IDs
   */
  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  private generateSubscriptionId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  private generateReplayId(): string {
    return `rpl_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * Shutdown the event bus
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down EventBus...')

    // Stop processors
    if (this.processingInterval) clearInterval(this.processingInterval)
    if (this.cleanupInterval) clearInterval(this.cleanupInterval)
    if (this.metricsInterval) clearInterval(this.metricsInterval)

    // Process remaining events
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift()
      if (event) {
        await this.processEvent(event)
      }
    }

    // Clear listeners
    this.removeAllListeners()

    this.logger.info('EventBus shutdown complete')
  }
}

// Export singleton instance
export const eventBus = new EventBusService()