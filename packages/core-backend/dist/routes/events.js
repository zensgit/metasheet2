"use strict";
/**
 * Event Bus REST API Endpoints
 * 事件总线REST API端点
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventsRouter = eventsRouter;
const express_1 = require("express");
const EventBusService_1 = require("../core/EventBusService");
const zod_1 = require("zod");
// Validation schemas
const EmitEventSchema = zod_1.z.object({
    eventName: zod_1.z.string().min(1).max(100),
    payload: zod_1.z.any(),
    options: zod_1.z.object({
        priority: zod_1.z.enum(['low', 'normal', 'high', 'critical']).optional(),
        deliveryMode: zod_1.z.enum(['at-most-once', 'at-least-once', 'exactly-once']).optional(),
        targetPlugins: zod_1.z.array(zod_1.z.string()).optional(),
        metadata: zod_1.z.record(zod_1.z.any()).optional(),
        scheduleAt: zod_1.z.string().datetime().optional(),
        expireAt: zod_1.z.string().datetime().optional()
    }).optional()
});
const SubscribeEventSchema = zod_1.z.object({
    subscriberId: zod_1.z.string().min(1),
    eventPattern: zod_1.z.string().min(1),
    options: zod_1.z.object({
        filter: zod_1.z.string().optional(),
        priority: zod_1.z.number().min(1).max(100).optional(),
        maxRetries: zod_1.z.number().min(0).max(10).optional()
    }).optional()
});
const ReplayEventsSchema = zod_1.z.object({
    criteria: zod_1.z.object({
        eventPattern: zod_1.z.string().optional(),
        fromTimestamp: zod_1.z.string().datetime().optional(),
        toTimestamp: zod_1.z.string().datetime().optional(),
        eventIds: zod_1.z.array(zod_1.z.string()).optional(),
        status: zod_1.z.enum(['pending', 'delivered', 'failed', 'expired']).optional()
    }),
    reason: zod_1.z.string().min(1)
});
const QueryEventsSchema = zod_1.z.object({
    eventName: zod_1.z.string().optional(),
    status: zod_1.z.enum(['pending', 'delivered', 'failed', 'expired']).optional(),
    fromTime: zod_1.z.string().datetime().optional(),
    toTime: zod_1.z.string().datetime().optional(),
    subscriberId: zod_1.z.string().optional(),
    limit: zod_1.z.number().min(1).max(1000).default(100),
    offset: zod_1.z.number().min(0).default(0)
});
function eventsRouter() {
    const router = (0, express_1.Router)();
    let eventBus = null;
    // Initialize event bus service
    const getEventBus = async () => {
        if (!eventBus) {
            const { pool } = await Promise.resolve().then(() => __importStar(require('../db/pg')));
            eventBus = new EventBusService_1.EventBusService(pool);
            await eventBus.initialize();
        }
        return eventBus;
    };
    // POST /api/events/emit - Emit an event
    router.post('/api/events/emit', async (req, res) => {
        try {
            const validated = EmitEventSchema.parse(req.body);
            const service = await getEventBus();
            const eventId = await service.emit(validated.eventName, validated.payload, validated.options);
            res.json({
                ok: true,
                data: { eventId, status: 'emitted' }
            });
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
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
    router.post('/api/events/subscribe', async (req, res) => {
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
            const subscriptionId = await service.subscribe(validated.subscriberId, validated.eventPattern, async (event) => {
                // Webhook handler - will be called by the event bus
                try {
                    const response = await fetch(webhookUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(event)
                    });
                    return response.ok;
                }
                catch (error) {
                    console.error('Webhook delivery failed:', error);
                    return false;
                }
            }, validated.options);
            res.json({
                ok: true,
                data: { subscriptionId, status: 'subscribed' }
            });
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
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
    router.delete('/api/events/subscribe/:subscriptionId', async (req, res) => {
        try {
            const { subscriptionId } = req.params;
            const service = await getEventBus();
            await service.unsubscribe(subscriptionId);
            res.json({
                ok: true,
                data: { subscriptionId, status: 'unsubscribed' }
            });
        }
        catch (error) {
            console.error('Failed to unsubscribe:', error);
            res.status(500).json({
                ok: false,
                error: { code: 'UNSUBSCRIBE_FAILED', message: error.message }
            });
        }
    });
    // POST /api/events/replay - Replay events
    router.post('/api/events/replay', async (req, res) => {
        try {
            const validated = ReplayEventsSchema.parse(req.body);
            const service = await getEventBus();
            const replayId = await service.replayEvents(validated.criteria, validated.reason);
            res.json({
                ok: true,
                data: { replayId, status: 'replaying' }
            });
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
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
    router.get('/api/events', async (req, res) => {
        try {
            const validated = QueryEventsSchema.parse(req.query);
            const service = await getEventBus();
            const { pool } = await Promise.resolve().then(() => __importStar(require('../db/pg')));
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
            const params = [];
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
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
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
    router.get('/api/events/stats', async (req, res) => {
        try {
            const service = await getEventBus();
            const stats = await service.getStats();
            res.json({
                ok: true,
                data: stats
            });
        }
        catch (error) {
            console.error('Failed to get stats:', error);
            res.status(500).json({
                ok: false,
                error: { code: 'STATS_FAILED', message: error.message }
            });
        }
    });
    // GET /api/events/types - Get registered event types
    router.get('/api/events/types', async (req, res) => {
        try {
            const { pool } = await Promise.resolve().then(() => __importStar(require('../db/pg')));
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
        }
        catch (error) {
            console.error('Failed to get event types:', error);
            res.status(500).json({
                ok: false,
                error: { code: 'TYPES_FAILED', message: error.message }
            });
        }
    });
    return router;
}
//# sourceMappingURL=events.js.map