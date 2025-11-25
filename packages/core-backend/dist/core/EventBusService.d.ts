/**
 * Event Bus Service
 * Central event distribution system for plugin communication and system events
 */
import { EventEmitter } from 'eventemitter3';
import { Logger } from './logger';
import { CoreAPI } from '../types/plugin';
interface EventSubscription {
    id: string;
    subscriber_id: string;
    subscriber_type: string;
    event_pattern: string;
    event_types?: string[];
    filter_expression?: any;
    handler_type: string;
    handler_config: any;
    priority: number;
    is_sequential: boolean;
    timeout_ms: number;
    transform_enabled: boolean;
    transform_template?: string;
}
interface Event {
    event_id: string;
    event_name: string;
    event_version: string;
    source_id: string;
    source_type: string;
    correlation_id?: string;
    causation_id?: string;
    payload: any;
    metadata: any;
    occurred_at: Date;
}
interface EventHandler {
    (event: Event, context: EventContext): Promise<any>;
}
interface EventContext {
    subscription: EventSubscription;
    attempt: number;
    core: CoreAPI;
    logger: Logger;
}
export declare class EventBusService extends EventEmitter {
    private logger;
    private ajv;
    private subscriptions;
    private handlers;
    private pluginPermissions;
    private processingInterval?;
    private cleanupInterval?;
    private metricsInterval?;
    private isProcessing;
    private eventQueue;
    private core?;
    private degradedMode;
    private allowDegradation;
    constructor();
    /**
     * Initialize the event bus
     */
    initialize(core: CoreAPI): Promise<void>;
    /**
     * Check if error is database schema error (table/relation does not exist)
     */
    private isDatabaseSchemaError;
    /**
     * Emit an event
     */
    emit(eventName: string, payload: any, options?: {
        source_id?: string;
        source_type?: string;
        correlation_id?: string;
        causation_id?: string;
        metadata?: any;
    }): Promise<string>;
    /**
     * Subscribe to events
     */
    subscribe(subscriberId: string, eventPattern: string, handler: EventHandler, options?: {
        subscriber_type?: string;
        filter?: any;
        priority?: number;
        transform?: string;
        timeout_ms?: number;
    }): Promise<string>;
    /**
     * Unsubscribe from events
     */
    unsubscribe(subscriptionId: string): Promise<void>;
    /**
     * Register an event type
     */
    registerEventType(eventName: string, options?: {
        category?: string;
        payload_schema?: any;
        metadata_schema?: any;
        is_async?: boolean;
        is_persistent?: boolean;
        ttl_seconds?: number;
        max_retries?: number;
    }): Promise<void>;
    /**
     * Replay events
     */
    replayEvents(criteria: {
        event_ids?: string[];
        event_pattern?: string;
        time_range?: {
            start: Date;
            end: Date;
        };
        subscription_ids?: string[];
    }, reason: string): Promise<string>;
    /**
     * Get event metrics
     */
    getMetrics(eventName?: string, timeRange?: {
        start: Date;
        end: Date;
    }): Promise<any>;
    /**
     * Set plugin permissions
     */
    setPluginPermissions(pluginId: string, permissions: {
        can_emit?: string[];
        can_subscribe?: string[];
        max_events_per_minute?: number;
        max_subscriptions?: number;
    }): Promise<void>;
    /**
     * Private: Process event
     */
    private processEvent;
    /**
     * Private: Handle local event
     */
    private handleLocalEvent;
    /**
     * Private: Validate event schema
     */
    private validateEventSchema;
    /**
     * Private: Validate plugin permission
     */
    private validatePluginPermission;
    /**
     * Private: Persist event
     */
    private persistEvent;
    /**
     * Private: Find matching subscriptions
     */
    private findMatchingSubscriptions;
    /**
     * Private: Match pattern
     */
    private matchesPattern;
    /**
     * Private: Match filter
     */
    private matchesFilter;
    /**
     * Private: Transform event
     */
    private transformEvent;
    /**
     * Private: Get nested value
     */
    private getNestedValue;
    /**
     * Private: Execute with timeout
     */
    private executeWithTimeout;
    /**
     * Private: Log delivery
     */
    private logDelivery;
    /**
     * Private: Update subscription stats
     */
    private updateSubscriptionStats;
    /**
     * Private: Add to dead letter queue
     */
    private addToDeadLetter;
    /**
     * Private: Check rate limit
     */
    private checkRateLimit;
    /**
     * Private: Load event types
     */
    private loadEventTypes;
    /**
     * Private: Load subscriptions
     */
    private loadSubscriptions;
    /**
     * Private: Load plugin permissions
     */
    private loadPluginPermissions;
    /**
     * Private: Get event type
     */
    private getEventType;
    /**
     * Private: Store subscription
     */
    private storeSubscription;
    /**
     * Private: Get matching patterns
     */
    private getMatchingPatterns;
    /**
     * Private: Determine replay type
     */
    private determineReplayType;
    /**
     * Private: Start replay
     */
    private startReplay;
    /**
     * Private: Register system events
     */
    private registerSystemEvents;
    /**
     * Private: Setup internal handlers
     */
    private setupInternalHandlers;
    /**
     * Private: Start event processor
     */
    private startEventProcessor;
    /**
     * Private: Start cleanup processor
     */
    private startCleanupProcessor;
    /**
     * Private: Start metrics processor
     */
    private startMetricsProcessor;
    /**
     * Private: Cleanup old events
     */
    private cleanupOldEvents;
    /**
     * Private: Update metrics
     */
    private updateMetrics;
    /**
     * Private: Generate IDs
     */
    private generateEventId;
    private generateSubscriptionId;
    private generateReplayId;
    /**
     * Shutdown the event bus
     */
    shutdown(): Promise<void>;
}
export declare const eventBus: EventBusService;
export {};
//# sourceMappingURL=EventBusService.d.ts.map