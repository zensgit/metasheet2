/**
 * Example Event Bus Plugin
 * 事件总线插件示例
 *
 * This plugin demonstrates how to use the Event Bus System for inter-plugin communication.
 * 此插件演示如何使用事件总线系统进行插件间通信。
 */

import type { PluginLifecycle, PluginContext, PluginManifest } from '../types/plugin'
import type { Request, Response } from 'express'

// Event payload types
interface SpreadsheetCreatedPayload {
  spreadsheetId?: string
  userId?: string
  timestamp?: string
  changes?: string[]
}

interface SpreadsheetUpdatedPayload {
  spreadsheetId?: string
  userId?: string
  timestamp?: string
  changes?: string[]
}

interface WorkflowPayload {
  id?: string
  workflowId?: string
  status?: string
  timestamp?: string
}

interface SystemMaintenancePayload {
  reason?: string
  scheduledTime?: string
  duration?: number
}

interface UserEventPayload {
  userId?: string
  action?: string
  timestamp?: string
}

interface DataPointPayload {
  series?: string
  value?: unknown
  timestamp?: string
}

interface ProcessPayload {
  processId?: string
  data?: unknown
  valid?: boolean
  result?: string
}

interface TaskPayload {
  taskId?: string
  priority?: 'low' | 'normal' | 'high' | 'critical'
  userId?: string
}

interface ActionRequestPayload {
  actionId?: string
  userRole?: 'user' | 'admin' | 'manager'
  userId?: string
}

// Generic event structure
interface PluginEvent<T = unknown> {
  type: string
  payload?: T
  timestamp?: string
}

// Event statistics type
interface EventStatistics {
  eventsEmitted: number
  eventsReceived: number
  activeSubscriptions: number
  uptime: number
  lastActivity: string
}

// Bulk event request types
interface BulkEventItem {
  type: string
  payload?: unknown
}

interface BulkEventResult {
  type: string
  status: 'emitted' | 'failed'
  error?: string
}

export class EventExamplePlugin implements PluginLifecycle {
  public manifest: PluginManifest = {
    name: 'event-example-plugin',
    version: '1.0.0',
    displayName: 'Event Bus Example Plugin',
    description: 'Demonstrates event bus usage patterns',
    author: 'MetaSheet Team',
    capabilities: ['events', 'http'],
    dependencies: {},
    permissions: ['events.emit', 'events.subscribe', 'http.addRoute'],
    contributes: {
      // Note: events field is not part of PluginManifest.contributes
      // Event capabilities are declared through permissions
      commands: [
        {
          id: 'trigger-event',
          title: 'Trigger example events',
          name: 'trigger-event'
        }
      ]
    }
  };

  public status: 'loading' | 'active' | 'error' = 'loading';
  private context?: PluginContext;
  private subscriptions: string[] = [];

  async activate(context: PluginContext): Promise<void> {
    this.context = context;

    try {
      // Register event handlers
      await this.registerEventHandlers();

      // Register HTTP routes
      this.registerRoutes();

      // Set up periodic event emission (example)
      this.setupPeriodicEvents();

      this.status = 'active';
      context.logger.info(`${this.manifest.displayName} initialized successfully`);
    } catch (error) {
      this.status = 'error';
      context.logger.error(`Failed to initialize ${this.manifest.displayName}:`, error as Error);
      throw error;
    }
  }

  private async registerEventHandlers(): Promise<void> {
    if (!this.context) return;

    // Subscribe to spreadsheet events
    this.context.api.events.on('spreadsheet.created', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<SpreadsheetCreatedPayload>;
      this.context!.logger.info('Spreadsheet created event received:', { event: event.type, payload: event.payload });

      // React to spreadsheet creation
      await this.handleSpreadsheetCreated(event);
    });

    this.context.api.events.on('spreadsheet.updated', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<SpreadsheetUpdatedPayload>;
      this.context!.logger.info('Spreadsheet updated event received:', { event: event.type, payload: event.payload });

      // Trigger calculation if needed
      if (event.payload?.changes?.includes('formula') && event.payload?.spreadsheetId) {
        await this.triggerCalculation(event.payload.spreadsheetId);
      }
    });

    // Subscribe to workflow events
    this.context.api.events.on('workflow.started', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<WorkflowPayload>;
      this.context!.logger.info('Workflow started:', { event: event.type, payload: event.payload });

      // Track workflow execution
      if (event.payload) {
        await this.trackWorkflowExecution(event.payload);
      }
    });

    // Subscribe to system events
    this.context.api.events.on('system.maintenance', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<SystemMaintenancePayload>;
      this.context!.logger.warn('System maintenance event:', { event: event.type, payload: event.payload });

      // Prepare for maintenance
      await this.prepareForMaintenance();
    });

    // Pattern-based subscription
    this.context.api.events.on('user.*', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<UserEventPayload>;
      this.context!.logger.info(`User event received: ${event.type}`, { payload: event.payload });
    });
  }

  private registerRoutes(): void {
    if (!this.context) return;

    // Trigger event endpoint
    this.context.api.http.addRoute('POST', '/api/plugins/event-example/trigger', async (req: Request, res: Response) => {
      try {
        const { eventType, payload } = req.body as { eventType?: string; payload?: unknown };

        if (!eventType) {
          return res.status(400).json({
            ok: false,
            error: { code: 'EVENT_TYPE_REQUIRED', message: 'eventType is required' }
          });
        }

        // Emit the event through the event bus
        this.context!.api.events.emit(eventType, payload || {});

        // Log the event emission
        this.context!.logger.info(`Event emitted: ${eventType}`, { payload });

        res.json({
          ok: true,
          data: {
            eventType,
            payload,
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        const err = error as Error;
        this.context!.logger.error('Failed to trigger event:', err);
        res.status(500).json({
          ok: false,
          error: { code: 'TRIGGER_FAILED', message: err.message }
        });
      }
    });

    // Get event statistics
    this.context.api.http.addRoute('GET', '/api/plugins/event-example/stats', async (_req: Request, res: Response) => {
      try {
        const stats = await this.getEventStatistics();

        res.json({
          ok: true,
          data: stats
        });
      } catch (error) {
        const err = error as Error;
        this.context!.logger.error('Failed to get stats:', err);
        res.status(500).json({
          ok: false,
          error: { code: 'STATS_FAILED', message: err.message }
        });
      }
    });

    // Bulk event emission
    this.context.api.http.addRoute('POST', '/api/plugins/event-example/bulk', async (req: Request, res: Response) => {
      try {
        const { events } = req.body as { events?: unknown };

        if (!Array.isArray(events)) {
          return res.status(400).json({
            ok: false,
            error: { code: 'INVALID_FORMAT', message: 'events must be an array' }
          });
        }

        const results: BulkEventResult[] = [];
        for (const event of events as BulkEventItem[]) {
          try {
            this.context!.api.events.emit(event.type, event.payload);
            results.push({ type: event.type, status: 'emitted' });
          } catch (error) {
            const err = error as Error;
            results.push({ type: event.type, status: 'failed', error: err.message });
          }
        }

        res.json({
          ok: true,
          data: {
            total: events.length,
            successful: results.filter(r => r.status === 'emitted').length,
            failed: results.filter(r => r.status === 'failed').length,
            results
          }
        });
      } catch (error) {
        const err = error as Error;
        this.context!.logger.error('Bulk emission failed:', err);
        res.status(500).json({
          ok: false,
          error: { code: 'BULK_FAILED', message: err.message }
        });
      }
    });
  }

  private setupPeriodicEvents(): void {
    // Emit a heartbeat event every 30 seconds
    setInterval(() => {
      if (this.context && this.status === 'active') {
        this.context.api.events.emit('plugin.heartbeat', {
          pluginName: this.manifest.name,
          timestamp: new Date().toISOString(),
          status: this.status
        });
      }
    }, 30000);

    // Emit usage statistics every 5 minutes
    setInterval(() => {
      if (this.context && this.status === 'active') {
        void this.emitUsageStatistics();
      }
    }, 300000);
  }

  private async handleSpreadsheetCreated(event: PluginEvent<SpreadsheetCreatedPayload>): Promise<void> {
    // Example: Auto-configure new spreadsheets
    const { spreadsheetId, userId } = event.payload || {};

    if (spreadsheetId) {
      // Emit a configuration event
      this.context!.api.events.emit('spreadsheet.autoconfigured', {
        spreadsheetId,
        configuredBy: this.manifest.name,
        timestamp: new Date().toISOString(),
        settings: {
          autoCalculate: true,
          versionControl: true,
          collaborationMode: 'realtime'
        }
      });
    }

    // Emit user notification
    if (userId) {
      this.context!.api.events.emit('user.notification', {
        userId,
        type: 'info',
        message: 'New spreadsheet created and configured',
        source: this.manifest.name
      });
    }
  }

  private async triggerCalculation(spreadsheetId: string): Promise<void> {
    // Emit calculation started event
    this.context!.api.events.emit('calculation.started', {
      spreadsheetId,
      initiatedBy: this.manifest.name,
      timestamp: new Date().toISOString()
    });

    // Simulate calculation
    setTimeout(() => {
      // Emit calculation completed event
      this.context!.api.events.emit('calculation.completed', {
        spreadsheetId,
        completedBy: this.manifest.name,
        timestamp: new Date().toISOString(),
        results: {
          cellsCalculated: Math.floor(Math.random() * 1000),
          duration: Math.floor(Math.random() * 100),
          errors: []
        }
      });
    }, 1000);
  }

  private async trackWorkflowExecution(workflow: WorkflowPayload): Promise<void> {
    // Store workflow execution data
    const executionData = {
      workflowId: workflow.id || workflow.workflowId,
      startTime: new Date().toISOString(),
      trackedBy: this.manifest.name
    };

    // Emit tracking event
    this.context!.api.events.emit('workflow.tracking', executionData);
  }

  private async prepareForMaintenance(): Promise<void> {
    // Clean up resources
    this.context!.logger.info('Preparing for maintenance...');

    // Emit preparation complete event
    this.context!.api.events.emit('plugin.maintenance.ready', {
      pluginName: this.manifest.name,
      timestamp: new Date().toISOString()
    });
  }

  private async emitUsageStatistics(): Promise<void> {
    const stats = await this.getEventStatistics();

    this.context!.api.events.emit('plugin.usage.stats', {
      pluginName: this.manifest.name,
      timestamp: new Date().toISOString(),
      stats
    });
  }

  private async getEventStatistics(): Promise<EventStatistics> {
    // In a real implementation, this would query actual statistics
    return {
      eventsEmitted: Math.floor(Math.random() * 1000),
      eventsReceived: Math.floor(Math.random() * 1000),
      activeSubscriptions: this.subscriptions.length,
      uptime: process.uptime(),
      lastActivity: new Date().toISOString()
    };
  }

  async destroy(): Promise<void> {
    // Clean up subscriptions
    for (const subscription of this.subscriptions) {
      this.context?.api.events.off(subscription);
    }

    this.status = 'loading';
    this.context?.logger.info(`${this.manifest.displayName} destroyed`);
  }

  // Advanced event patterns

  /**
   * Event aggregation pattern
   * 聚合多个事件并在满足条件时触发
   */
  private setupEventAggregation(): void {
    const aggregationBuffer: Map<string, DataPointPayload[]> = new Map();
    const aggregationThreshold = 10;
    const aggregationTimeout = 5000;

    this.context?.api.events.on('data.point', (...args: unknown[]) => {
      const event = args[0] as PluginEvent<DataPointPayload>;
      const key = event.payload?.series || 'default';

      if (!aggregationBuffer.has(key)) {
        aggregationBuffer.set(key, []);

        // Set timeout to flush buffer
        setTimeout(() => {
          const buffer = aggregationBuffer.get(key);
          if (buffer && buffer.length > 0) {
            this.context!.api.events.emit('data.aggregated', {
              series: key,
              points: buffer,
              count: buffer.length,
              timestamp: new Date().toISOString()
            });
            aggregationBuffer.delete(key);
          }
        }, aggregationTimeout);
      }

      const buffer = aggregationBuffer.get(key)!;
      if (event.payload) {
        buffer.push(event.payload);
      }

      // Flush if threshold reached
      if (buffer.length >= aggregationThreshold) {
        this.context!.api.events.emit('data.aggregated', {
          series: key,
          points: buffer,
          count: buffer.length,
          timestamp: new Date().toISOString()
        });
        aggregationBuffer.delete(key);
      }
    });
  }

  /**
   * Event chaining pattern
   * 事件链式处理
   */
  private setupEventChaining(): void {
    // Start of chain
    this.context?.api.events.on('process.start', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<ProcessPayload>;
      const { processId, data } = event.payload || {};

      // Step 1: Validation
      this.context!.api.events.emit('process.validating', { processId, data });

      // Simulate validation
      setTimeout(() => {
        this.context!.api.events.emit('process.validated', {
          processId,
          data,
          valid: true
        });
      }, 500);
    });

    // Chain continuation
    this.context?.api.events.on('process.validated', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<ProcessPayload>;
      if (!event.payload?.valid) {
        this.context!.api.events.emit('process.failed', event.payload);
        return;
      }

      // Step 2: Processing
      this.context!.api.events.emit('process.processing', event.payload);

      // Simulate processing
      setTimeout(() => {
        this.context!.api.events.emit('process.processed', {
          ...event.payload,
          result: 'success'
        });
      }, 1000);
    });

    // End of chain
    this.context?.api.events.on('process.processed', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<ProcessPayload>;
      this.context!.api.events.emit('process.completed', {
        ...event.payload,
        completedAt: new Date().toISOString()
      });
    });
  }

  /**
   * Event filtering pattern
   * 事件过滤模式
   */
  private setupEventFiltering(): void {
    // Only process high-priority events
    this.context?.api.events.on('task.created', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<TaskPayload>;
      const priority = event.payload?.priority || 'normal';

      if (priority === 'high' || priority === 'critical') {
        this.context!.api.events.emit('task.priority.high', event.payload);
      }
    });

    // Filter by user role
    this.context?.api.events.on('action.requested', async (...args: unknown[]) => {
      const event = args[0] as PluginEvent<ActionRequestPayload>;
      const userRole = event.payload?.userRole;

      if (userRole === 'admin' || userRole === 'manager') {
        this.context!.api.events.emit('action.authorized', event.payload);
      } else {
        this.context!.api.events.emit('action.pending.approval', event.payload);
      }
    });
  }
}

// Export plugin factory
export default function createPlugin(): PluginLifecycle {
  return new EventExamplePlugin();
}
