// @ts-nocheck
/**
 * Event Bus REST API Endpoints
 * 事件总线REST API端点
 */

import { Router, Request, Response } from 'express';
import { EventBusService } from '../core/EventBusService';
import { z } from 'zod';

// Validation schemas
const EmitEventSchema = z.object({
  eventName: z.string().min(1).max(100),
  payload: z.any(),
  options: z.object({
    priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
    deliveryMode: z.enum(['at-most-once', 'at-least-once', 'exactly-once']).optional(),
    targetPlugins: z.array(z.string()).optional(),
    metadata: z.record(z.any()).optional(),
    scheduleAt: z.string().datetime().optional(),
    expireAt: z.string().datetime().optional()
  }).optional()
});

const SubscribeEventSchema = z.object({
  subscriberId: z.string().min(1),
  eventPattern: z.string().min(1),
  options: z.object({
    filter: z.string().optional(),
    priority: z.number().min(1).max(100).optional(),
    maxRetries: z.number().min(0).max(10).optional()
  }).optional()
});

const ReplayEventsSchema = z.object({
  criteria: z.object({
    eventPattern: z.string().optional(),
    fromTimestamp: z.string().datetime().optional(),
    toTimestamp: z.string().datetime().optional(),
    eventIds: z.array(z.string()).optional(),
    status: z.enum(['pending', 'delivered', 'failed', 'expired']).optional()
  }),
  reason: z.string().min(1)
});

const QueryEventsSchema = z.object({
  eventName: z.string().optional(),
  status: z.enum(['pending', 'delivered', 'failed', 'expired']).optional(),
  fromTime: z.string().datetime().optional(),
  toTime: z.string().datetime().optional(),
  subscriberId: z.string().optional(),
  limit: z.number().min(1).max(1000).default(100),
  offset: z.number().min(0).default(0)
});

export function eventsRouter(): Router {
  const router = Router();
  let eventBus: EventBusService | null = null;

  // Initialize event bus service
  const getEventBus = async (): Promise<EventBusService> => {
    if (!eventBus) {
      const { pool } = await import('../db/pg');
      eventBus = new EventBusService(pool);
      await eventBus.initialize();
    }
    return eventBus;
  };

  // POST /api/events/emit - Emit an event
  router.post('/api/events/emit', async (req: Request, res: Response) => {
    try {
      const validated = EmitEventSchema.parse(req.body);
      const service = await getEventBus();

      const eventId = await service.emit(
        validated.eventName,
        validated.payload,
        validated.options
      );

      res.json({
        ok: true,
        data: { eventId, status: 'emitted' }
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', details: error.errors }
        });
      }

      console.error('Failed to emit event:', error);
      res.status(500).json({
        ok: false,
        error: { code: 'EMIT_FAILED', message: error.message }
      });
    }
  });

  // POST /api/events/subscribe - Subscribe to events
  router.post('/api/events/subscribe', async (req: Request, res: Response) => {
    try {
      const validated = SubscribeEventSchema.parse(req.body);
      const service = await getEventBus();

      // For REST API subscriptions, we store the webhook URL as the handler
      const webhookUrl = req.body.webhookUrl;
      if (!webhookUrl) {
        return res.status(400).json({
          ok: false,
          error: { code: 'WEBHOOK_REQUIRED', message: 'webhookUrl is required for REST subscriptions' }
        });
      }

      const subscriptionId = await service.subscribe(
        validated.subscriberId,
        validated.eventPattern,
        async (event: any) => {
          // Webhook handler - will be called by the event bus
          try {
            const response = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(event)
            });
            return response.ok;
          } catch (error) {
            console.error('Webhook delivery failed:', error);
            return false;
          }
        },
        validated.options
      );

      res.json({
        ok: true,
        data: { subscriptionId, status: 'subscribed' }
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', details: error.errors }
        });
      }

      console.error('Failed to subscribe:', error);
      res.status(500).json({
        ok: false,
        error: { code: 'SUBSCRIBE_FAILED', message: error.message }
      });
    }
  });

  // DELETE /api/events/subscribe/:subscriptionId - Unsubscribe
  router.delete('/api/events/subscribe/:subscriptionId', async (req: Request, res: Response) => {
    try {
      const { subscriptionId } = req.params;
      const service = await getEventBus();

      await service.unsubscribe(subscriptionId);

      res.json({
        ok: true,
        data: { subscriptionId, status: 'unsubscribed' }
      });
    } catch (error: any) {
      console.error('Failed to unsubscribe:', error);
      res.status(500).json({
        ok: false,
        error: { code: 'UNSUBSCRIBE_FAILED', message: error.message }
      });
    }
  });

  // POST /api/events/replay - Replay events
  router.post('/api/events/replay', async (req: Request, res: Response) => {
    try {
      const validated = ReplayEventsSchema.parse(req.body);
      const service = await getEventBus();

      const replayId = await service.replayEvents(
        validated.criteria,
        validated.reason
      );

      res.json({
        ok: true,
        data: { replayId, status: 'replaying' }
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', details: error.errors }
        });
      }

      console.error('Failed to replay events:', error);
      res.status(500).json({
        ok: false,
        error: { code: 'REPLAY_FAILED', message: error.message }
      });
    }
  });

  // GET /api/events - Query events
  router.get('/api/events', async (req: Request, res: Response) => {
    try {
      const validated = QueryEventsSchema.parse(req.query);
      const service = await getEventBus();

      const { pool } = await import('../db/pg');

      // Build query
      let sql = `
        SELECT
          e.id AS event_id,
          e.event_name,
          e.payload,
          e.status,
          e.priority,
          e.created_at,
          e.delivered_at,
          e.error_message,
          COUNT(ed.id) AS delivery_count
        FROM event_store e
        LEFT JOIN event_deliveries ed ON e.id = ed.event_id
        WHERE 1=1
      `;

      const params: any[] = [];
      let paramIndex = 1;

      if (validated.eventName) {
        sql += ` AND e.event_name LIKE $${paramIndex++}`;
        params.push(`%${validated.eventName}%`);
      }

      if (validated.status) {
        sql += ` AND e.status = $${paramIndex++}`;
        params.push(validated.status);
      }

      if (validated.fromTime) {
        sql += ` AND e.created_at >= $${paramIndex++}`;
        params.push(validated.fromTime);
      }

      if (validated.toTime) {
        sql += ` AND e.created_at <= $${paramIndex++}`;
        params.push(validated.toTime);
      }

      if (validated.subscriberId) {
        sql += ` AND ed.subscriber_id = $${paramIndex++}`;
        params.push(validated.subscriberId);
      }

      sql += ` GROUP BY e.id ORDER BY e.created_at DESC`;
      sql += ` LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(validated.limit, validated.offset);

      const result = await pool.query(sql, params);

      res.json({
        ok: true,
        data: {
          events: result.rows,
          total: result.rowCount,
          limit: validated.limit,
          offset: validated.offset
        }
      });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', details: error.errors }
        });
      }

      console.error('Failed to query events:', error);
      res.status(500).json({
        ok: false,
        error: { code: 'QUERY_FAILED', message: error.message }
      });
    }
  });

  // GET /api/events/stats - Get event statistics
  router.get('/api/events/stats', async (req: Request, res: Response) => {
    try {
      const service = await getEventBus();
      const stats = await service.getStats();

      res.json({
        ok: true,
        data: stats
      });
    } catch (error: any) {
      console.error('Failed to get stats:', error);
      res.status(500).json({
        ok: false,
        error: { code: 'STATS_FAILED', message: error.message }
      });
    }
  });

  // GET /api/events/types - Get registered event types
  router.get('/api/events/types', async (req: Request, res: Response) => {
    try {
      const { pool } = await import('../db/pg');

      const result = await pool.query(`
        SELECT
          name,
          category,
          schema,
          description,
          created_by,
          is_active
        FROM event_types
        WHERE is_active = true
        ORDER BY category, name
      `);

      res.json({
        ok: true,
        data: result.rows
      });
    } catch (error: any) {
      console.error('Failed to get event types:', error);
      res.status(500).json({
        ok: false,
        error: { code: 'TYPES_FAILED', message: error.message }
      });
    }
  });

  return router;
}