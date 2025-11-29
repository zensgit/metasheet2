// @ts-nocheck
/**
 * Example Event Bus Plugin
 * 事件总线插件示例
 *
 * This plugin demonstrates how to use the Event Bus System for inter-plugin communication.
 * 此插件演示如何使用事件总线系统进行插件间通信。
 */

import { Plugin, PluginContext, PluginManifest } from '../types/plugin';

export class EventExamplePlugin implements Plugin {
  public manifest: PluginManifest = {
    name: 'event-example-plugin',
    version: '1.0.0',
    displayName: 'Event Bus Example Plugin',
    description: 'Demonstrates event bus usage patterns',
    author: 'MetaSheet Team',
    capabilities: ['events', 'http'],
    dependencies: [],
    contributes: {
      events: {
        emits: [
          'user.created',
          'user.updated',
          'data.changed',
          'calculation.completed'
        ],
        subscribes: [
          'spreadsheet.*',
          'workflow.*',
          'system.*'
        ]
      },
      routes: [
        {
          method: 'POST',
          path: '/api/plugins/event-example/trigger',
          description: 'Trigger example events'
        }
      ]
    }
  };

  public status: 'loading' | 'active' | 'error' = 'loading';
  private context?: PluginContext;
  private subscriptions: string[] = [];

  async initialize(context: PluginContext): Promise<void> {
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
    this.context.events.on('spreadsheet.created', async (event: any) => {
      this.context!.logger.info('Spreadsheet created event received:', event);

      // React to spreadsheet creation
      await this.handleSpreadsheetCreated(event);
    });

    this.context.events.on('spreadsheet.updated', async (event: any) => {
      this.context!.logger.info('Spreadsheet updated event received:', event);

      // Trigger calculation if needed
      if (event.payload?.changes?.includes('formula')) {
        await this.triggerCalculation(event.payload.spreadsheetId);
      }
    });

    // Subscribe to workflow events
    this.context.events.on('workflow.started', async (event: any) => {
      this.context!.logger.info('Workflow started:', event);

      // Track workflow execution
      await this.trackWorkflowExecution(event.payload);
    });

    // Subscribe to system events
    this.context.events.on('system.maintenance', async (event: any) => {
      this.context!.logger.warn('System maintenance event:', event);

      // Prepare for maintenance
      await this.prepareForMaintenance();
    });

    // Pattern-based subscription
    this.context.events.on('user.*', async (event: any) => {
      this.context!.logger.info(`User event received: ${event.type}`, event);
    });
  }

  private registerRoutes(): void {
    if (!this.context) return;

    // Trigger event endpoint
    this.context.http.addRoute('POST', '/api/plugins/event-example/trigger', async (req, res) => {
      try {
        const { eventType, payload } = req.body;

        if (!eventType) {
          return res.status(400).json({
            ok: false,
            error: { code: 'EVENT_TYPE_REQUIRED', message: 'eventType is required' }
          });
        }

        // Emit the event through the event bus
        this.context!.events.emit(eventType, payload || {});

        // Log the event emission
        this.context!.logger.info(`Event emitted: ${eventType}`, payload);

        res.json({
          ok: true,
          data: {
            eventType,
            payload,
            timestamp: new Date().toISOString()
          }
        });
      } catch (error: any) {
        this.context!.logger.error('Failed to trigger event:', error);
        res.status(500).json({
          ok: false,
          error: { code: 'TRIGGER_FAILED', message: error.message }
        });
      }
    });

    // Get event statistics
    this.context.http.addRoute('GET', '/api/plugins/event-example/stats', async (req, res) => {
      try {
        const stats = await this.getEventStatistics();

        res.json({
          ok: true,
          data: stats
        });
      } catch (error: any) {
        this.context!.logger.error('Failed to get stats:', error);
        res.status(500).json({
          ok: false,
          error: { code: 'STATS_FAILED', message: error.message }
        });
      }
    });

    // Bulk event emission
    this.context.http.addRoute('POST', '/api/plugins/event-example/bulk', async (req, res) => {
      try {
        const { events } = req.body;

        if (!Array.isArray(events)) {
          return res.status(400).json({
            ok: false,
            error: { code: 'INVALID_FORMAT', message: 'events must be an array' }
          });
        }

        const results = [];
        for (const event of events) {
          try {
            this.context!.events.emit(event.type, event.payload);
            results.push({ type: event.type, status: 'emitted' });
          } catch (error: any) {
            results.push({ type: event.type, status: 'failed', error: error.message });
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
      } catch (error: any) {
        this.context!.logger.error('Bulk emission failed:', error);
        res.status(500).json({
          ok: false,
          error: { code: 'BULK_FAILED', message: error.message }
        });
      }
    });
  }

  private setupPeriodicEvents(): void {
    // Emit a heartbeat event every 30 seconds
    setInterval(() => {
      if (this.context && this.status === 'active') {
        this.context.events.emit('plugin.heartbeat', {
          pluginName: this.manifest.name,
          timestamp: new Date().toISOString(),
          status: this.status
        });
      }
    }, 30000);

    // Emit usage statistics every 5 minutes
    setInterval(() => {
      if (this.context && this.status === 'active') {
        this.emitUsageStatistics();
      }
    }, 300000);
  }

  private async handleSpreadsheetCreated(event: any): Promise<void> {
    // Example: Auto-configure new spreadsheets
    const { spreadsheetId, userId } = event.payload || {};

    if (spreadsheetId) {
      // Emit a configuration event
      this.context!.events.emit('spreadsheet.autoconfigured', {
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
      this.context!.events.emit('user.notification', {
        userId,
        type: 'info',
        message: 'New spreadsheet created and configured',
        source: this.manifest.name
      });
    }
  }

  private async triggerCalculation(spreadsheetId: string): Promise<void> {
    // Emit calculation started event
    this.context!.events.emit('calculation.started', {
      spreadsheetId,
      initiatedBy: this.manifest.name,
      timestamp: new Date().toISOString()
    });

    // Simulate calculation
    setTimeout(() => {
      // Emit calculation completed event
      this.context!.events.emit('calculation.completed', {
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

  private async trackWorkflowExecution(workflow: any): Promise<void> {
    // Store workflow execution data
    const executionData = {
      workflowId: workflow.id,
      startTime: new Date().toISOString(),
      trackedBy: this.manifest.name
    };

    // Emit tracking event
    this.context!.events.emit('workflow.tracking', executionData);
  }

  private async prepareForMaintenance(): Promise<void> {
    // Clean up resources
    this.context!.logger.info('Preparing for maintenance...');

    // Emit preparation complete event
    this.context!.events.emit('plugin.maintenance.ready', {
      pluginName: this.manifest.name,
      timestamp: new Date().toISOString()
    });
  }

  private async emitUsageStatistics(): Promise<void> {
    const stats = await this.getEventStatistics();

    this.context!.events.emit('plugin.usage.stats', {
      pluginName: this.manifest.name,
      timestamp: new Date().toISOString(),
      stats
    });
  }

  private async getEventStatistics(): Promise<any> {
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
      this.context?.events.off(subscription);
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
    const aggregationBuffer: Map<string, any[]> = new Map();
    const aggregationThreshold = 10;
    const aggregationTimeout = 5000;

    this.context?.events.on('data.point', (event: any) => {
      const key = event.payload?.series || 'default';

      if (!aggregationBuffer.has(key)) {
        aggregationBuffer.set(key, []);

        // Set timeout to flush buffer
        setTimeout(() => {
          const buffer = aggregationBuffer.get(key);
          if (buffer && buffer.length > 0) {
            this.context!.events.emit('data.aggregated', {
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
      buffer.push(event.payload);

      // Flush if threshold reached
      if (buffer.length >= aggregationThreshold) {
        this.context!.events.emit('data.aggregated', {
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
    this.context?.events.on('process.start', async (event: any) => {
      const { processId, data } = event.payload;

      // Step 1: Validation
      this.context!.events.emit('process.validating', { processId, data });

      // Simulate validation
      setTimeout(() => {
        this.context!.events.emit('process.validated', {
          processId,
          data,
          valid: true
        });
      }, 500);
    });

    // Chain continuation
    this.context?.events.on('process.validated', async (event: any) => {
      if (!event.payload.valid) {
        this.context!.events.emit('process.failed', event.payload);
        return;
      }

      // Step 2: Processing
      this.context!.events.emit('process.processing', event.payload);

      // Simulate processing
      setTimeout(() => {
        this.context!.events.emit('process.processed', {
          ...event.payload,
          result: 'success'
        });
      }, 1000);
    });

    // End of chain
    this.context?.events.on('process.processed', async (event: any) => {
      this.context!.events.emit('process.completed', {
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
    this.context?.events.on('task.created', async (event: any) => {
      const priority = event.payload?.priority || 'normal';

      if (priority === 'high' || priority === 'critical') {
        this.context!.events.emit('task.priority.high', event.payload);
      }
    });

    // Filter by user role
    this.context?.events.on('action.requested', async (event: any) => {
      const userRole = event.payload?.userRole;

      if (userRole === 'admin' || userRole === 'manager') {
        this.context!.events.emit('action.authorized', event.payload);
      } else {
        this.context!.events.emit('action.pending.approval', event.payload);
      }
    });
  }
}

// Export plugin factory
export default function createPlugin(): Plugin {
  return new EventExamplePlugin();
}