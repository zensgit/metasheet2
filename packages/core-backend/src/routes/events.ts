/**
 * Event Bus REST API Endpoints
 * 事件总线REST API端点
 */

import type { Request, Response } from 'express';
import { Router } from 'express'
import { eventBus } from '../core/EventBusService'
import { z } from 'zod'
import { db } from '../db/db'
import { Logger } from '../core/logger'

const logger = new Logger('EventsRouter')

// Validation schemas
const EmitEventSchema = z.object({
  eventName: z.string().min(1).max(100),
  payload: z.any(),
  options: z.object({
    source_id: z.string().optional(),
    source_type: z.string().optional(),
    correlation_id: z.string().optional(),
    causation_id: z.string().optional(),
    metadata: z.record(z.any()).optional()
  }).optional()
})

const SubscribeEventSchema = z.object({
  subscriberId: z.string().min(1),
  eventPattern: z.string().min(1),
  webhookUrl: z.string().url(),
  options: z.object({
    subscriber_type: z.string().optional(),
    filter: z.record(z.any()).optional(),
    priority: z.number().min(0).max(100).optional(),
    transform: z.string().optional(),
    timeout_ms: z.number().min(1000).max(60000).optional()
  }).optional()
})

const ReplayEventsSchema = z.object({
  criteria: z.object({
    event_pattern: z.string().optional(),
    event_ids: z.array(z.string()).optional(),
    time_range: z.object({
      start: z.string().datetime(),
      end: z.string().datetime()
    }).optional(),
    subscription_ids: z.array(z.string()).optional()
  }),
  reason: z.string().min(1)
})

const QueryEventsSchema = z.object({
  eventName: z.string().optional(),
  status: z.enum(['pending', 'processed', 'archived']).optional(),
  fromTime: z.string().datetime().optional(),
  toTime: z.string().datetime().optional(),
  subscriberId: z.string().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100),
  offset: z.coerce.number().min(0).default(0)
})

const MetricsQuerySchema = z.object({
  eventName: z.string().optional(),
  fromTime: z.string().datetime().optional(),
  toTime: z.string().datetime().optional()
})

export function eventsRouter(): Router {
  const router = Router()

  // POST /api/events/emit - Emit an event
  router.post('/api/events/emit', async (req: Request, res: Response) => {
    try {
      const validated = EmitEventSchema.parse(req.body)

      const eventId = await eventBus.publish(
        validated.eventName,
        validated.payload,
        validated.options
      )

      res.json({
        ok: true,
        data: { eventId, status: 'emitted' }
      })
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', details: error.errors }
        })
        return
      }

      logger.error('Failed to emit event', error instanceof Error ? error : undefined)
      res.status(500).json({
        ok: false,
        error: { code: 'EMIT_FAILED', message: error instanceof Error ? error.message : 'Unknown error' }
      })
    }
  })

  // POST /api/events/subscribe - Subscribe to events
  router.post('/api/events/subscribe', async (req: Request, res: Response) => {
    try {
      const validated = SubscribeEventSchema.parse(req.body)

      const subscriptionId = await eventBus.subscribe(
        validated.subscriberId,
        validated.eventPattern,
        async (event, _context) => {
          // Webhook handler - will be called by the event bus
          try {
            const response = await fetch(validated.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(event)
            })
            return response.ok
          } catch (err) {
            logger.error('Webhook delivery failed', err instanceof Error ? err : undefined)
            return false
          }
        },
        validated.options
      )

      res.json({
        ok: true,
        data: { subscriptionId, status: 'subscribed' }
      })
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', details: error.errors }
        })
        return
      }

      logger.error('Failed to subscribe', error instanceof Error ? error : undefined)
      res.status(500).json({
        ok: false,
        error: { code: 'SUBSCRIBE_FAILED', message: error instanceof Error ? error.message : 'Unknown error' }
      })
    }
  })

  // DELETE /api/events/subscribe/:subscriptionId - Unsubscribe
  router.delete('/api/events/subscribe/:subscriptionId', async (req: Request, res: Response) => {
    try {
      const { subscriptionId } = req.params

      await eventBus.unsubscribe(subscriptionId)

      res.json({
        ok: true,
        data: { subscriptionId, status: 'unsubscribed' }
      })
    } catch (error) {
      logger.error('Failed to unsubscribe', error instanceof Error ? error : undefined)
      res.status(500).json({
        ok: false,
        error: { code: 'UNSUBSCRIBE_FAILED', message: error instanceof Error ? error.message : 'Unknown error' }
      })
    }
  })

  // POST /api/events/replay - Replay events
  router.post('/api/events/replay', async (req: Request, res: Response) => {
    try {
      const validated = ReplayEventsSchema.parse(req.body)

      // Convert time_range strings to Date objects if provided
      const criteria: {
        event_ids?: string[]
        event_pattern?: string
        time_range?: { start: Date; end: Date }
        subscription_ids?: string[]
      } = {
        event_ids: validated.criteria.event_ids,
        event_pattern: validated.criteria.event_pattern,
        subscription_ids: validated.criteria.subscription_ids
      }

      if (validated.criteria.time_range) {
        criteria.time_range = {
          start: new Date(validated.criteria.time_range.start),
          end: new Date(validated.criteria.time_range.end)
        }
      }

      const replayId = await eventBus.replayEvents(criteria, validated.reason)

      res.json({
        ok: true,
        data: { replayId, status: 'replaying' }
      })
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', details: error.errors }
        })
        return
      }

      logger.error('Failed to replay events', error instanceof Error ? error : undefined)
      res.status(500).json({
        ok: false,
        error: { code: 'REPLAY_FAILED', message: error instanceof Error ? error.message : 'Unknown error' }
      })
    }
  })

  // GET /api/events - Query events
  router.get('/api/events', async (req: Request, res: Response) => {
    try {
      const validated = QueryEventsSchema.parse(req.query)

      // Build query using Kysely
      let query = db
        .selectFrom('event_store')
        .select([
          'event_id',
          'event_name',
          'payload',
          'status',
          'source_id',
          'source_type',
          'occurred_at',
          'received_at',
          'processed_at'
        ])

      if (validated.eventName) {
        query = query.where('event_name', 'like', `%${validated.eventName}%`)
      }

      if (validated.status) {
        query = query.where('status', '=', validated.status)
      }

      if (validated.fromTime) {
        query = query.where('occurred_at', '>=', new Date(validated.fromTime))
      }

      if (validated.toTime) {
        query = query.where('occurred_at', '<=', new Date(validated.toTime))
      }

      const events = await query
        .orderBy('occurred_at', 'desc')
        .limit(validated.limit)
        .offset(validated.offset)
        .execute()

      res.json({
        ok: true,
        data: {
          events,
          limit: validated.limit,
          offset: validated.offset
        }
      })
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', details: error.errors }
        })
        return
      }

      logger.error('Failed to query events', error instanceof Error ? error : undefined)
      res.status(500).json({
        ok: false,
        error: { code: 'QUERY_FAILED', message: error instanceof Error ? error.message : 'Unknown error' }
      })
    }
  })

  // GET /api/events/stats - Get event statistics/metrics
  router.get('/api/events/stats', async (req: Request, res: Response) => {
    try {
      const validated = MetricsQuerySchema.parse(req.query)

      const timeRange = validated.fromTime && validated.toTime
        ? { start: new Date(validated.fromTime), end: new Date(validated.toTime) }
        : undefined

      const metrics = await eventBus.getMetrics(validated.eventName, timeRange)

      res.json({
        ok: true,
        data: metrics
      })
    } catch (error) {
      logger.error('Failed to get stats', error instanceof Error ? error : undefined)
      res.status(500).json({
        ok: false,
        error: { code: 'STATS_FAILED', message: error instanceof Error ? error.message : 'Unknown error' }
      })
    }
  })

  // GET /api/events/types - Get registered event types
  router.get('/api/events/types', async (req: Request, res: Response) => {
    try {
      const result = await db
        .selectFrom('event_types')
        .select([
          'event_name',
          'category',
          'payload_schema',
          'is_async',
          'is_persistent',
          'max_retries',
          'ttl_seconds'
        ])
        .where('is_active', '=', true)
        .orderBy('category')
        .orderBy('event_name')
        .execute()

      res.json({
        ok: true,
        data: result
      })
    } catch (error) {
      logger.error('Failed to get event types', error instanceof Error ? error : undefined)
      res.status(500).json({
        ok: false,
        error: { code: 'TYPES_FAILED', message: error instanceof Error ? error.message : 'Unknown error' }
      })
    }
  })

  return router
}
