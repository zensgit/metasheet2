/**
 * Protection Rules Admin API Routes
 * Sprint 2: Snapshot Protection System
 *
 * Provides REST API for protection rule management
 */

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { protectionRuleService } from '../services/ProtectionRuleService';
import { requireAdminRole } from '../guards/audit-integration';
import { Logger } from '../core/logger';

const router = Router();
const logger = new Logger('ProtectionRulesRoutes');

// SECURITY (issue #5667): this router is mounted at /api/admin/safety/rules (admin-routes.ts) and its
// four write endpoints (POST /, PATCH /:id, DELETE /:id, POST /evaluate) used to carry NO authorization
// at all, while the rule creator and the rate-limit bucket were read from the caller-controlled
// `x-user-id` header with an `'anon'`/`'system'` fallback — so any authenticated user could rewrite the
// safety rules that gate destructive operations, and attribute the change to anyone. Writes are now
// platform-admin (requireAdminRole: isAdmin throwing -> 503; no pool -> isAdmin returns false -> 403,
// see rbac/service.ts) and identity
// comes ONLY from req.user.id. Same treatment as the sibling snapshot-labels router (GHSA-h8mf F2).
//
// SECURITY (issue #5678, batch 1): the two reads (GET /, GET /:id) were left open by #5667 and are
// now admin-only as well. They return each rule's name, conditions and effects — the full map of
// which destructive operations are blocked and under what predicate — to any authenticated caller,
// which is reconnaissance for the writes the gate above protects. Same guard, same semantics
// (403 ADMIN_REQUIRED / 503 RBAC_CHECK_FAILED); admins see exactly what they saw before.
// Ordering note: the rate limiter below is a router.use registered ahead of every route, so it runs
// BEFORE this gate. A denied caller is still metered against its own quota instead of getting an
// unmetered probing channel — and the 11th request in a burst is still 429, not 403, which is what
// keeps scripts/verify-sprint2-staging.sh's rate-limit probe meaningful.
const getUserId = (req: Request): string => {
  const id = req.user?.id;
  if (id === undefined || id === null || String(id).length === 0) {
    throw new Error('unauthenticated: protection rule mutation requires an authenticated req.user.id');
  }
  return String(id);
};

// Simple in-memory rate limiter: 10 requests per 60s per user + method + route shape.
//
// MEMORY (ADM-18): this Map used to be append-only — the key carried the raw `req.path`, so every
// distinct `GET /:id` a caller invented opened a new bucket, and nothing ever deleted one. The
// limiter runs ahead of requireAdminRole (see the ordering note above, kept on purpose), so any
// authenticated non-admin could grow it without bound with one request per made-up id. Three
// changes below: the key is narrowed to a fixed set of route shapes, expired buckets are swept
// lazily, and the bucket count has a hard ceiling.
const rateLimitStore = new Map<string, number[]>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Hard ceiling on distinct buckets held in memory (ADM-18). */
export const RATE_LIMIT_MAX_KEYS = 10_000;
/** Sweep at least this often in metered requests, so a steady stream is reclaimed without a timer. */
const RATE_LIMIT_SWEEP_EVERY_WRITES = 512;

let writesSinceSweep = 0;
let lastSweepAt = 0;
let lastOverflowWarnAt = 0;

/**
 * Collapse `req.path` onto this router's own route shapes: '/' (collection), '/:id' (item),
 * '/evaluate' (the one named action) and '/:other' for anything that matched no route.
 *
 * This is a BUCKET-NARROWING change only: paths that used to hold separate quotas now share one,
 * so a caller can never get MORE requests through than before — `GET /a` and `GET /b` are one
 * bucket of 10 instead of two. Nothing that was previously limited becomes unlimited, which is
 * what keeps scripts/verify-sprint2-staging.sh's "11 quick GETs on the collection -> 429" probe
 * true. It also makes the key space per principal a constant (methods x 4 shapes) instead of
 * unbounded in caller-chosen ids.
 */
function rateLimitRouteShape(path: string): string {
  const segments = path.split('/').filter(segment => segment.length > 0);
  if (segments.length === 0) return '/';
  if (segments.length === 1) return segments[0] === 'evaluate' ? '/evaluate' : '/:id';
  return '/:other';
}

/** Drop every bucket whose newest timestamp has fallen out of the window. */
function sweepExpiredRateLimitKeys(now: number): void {
  for (const [key, timestamps] of rateLimitStore) {
    const newest = timestamps[timestamps.length - 1];
    if (newest === undefined || now - newest >= RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(key);
    }
  }
  lastSweepAt = now;
  writesSinceSweep = 0;
}

export const protectionRulesRateLimit = (req: Request, res: Response, next: NextFunction) => {
  const now = Date.now();
  // Lazy reclamation instead of a module-load setInterval (importing this router must not start a
  // timer); mirrors what MemoryRateLimitStore does in middleware/rate-limiter.ts:45-58, minus the
  // timer. Whichever trips first: a window has passed, or enough metered requests have accumulated.
  if (now - lastSweepAt >= RATE_LIMIT_WINDOW_MS || writesSinceSweep >= RATE_LIMIT_SWEEP_EVERY_WRITES) {
    sweepExpiredRateLimitKeys(now);
  }

  // Bucket by the authenticated principal, falling back to the peer address — never by a header the
  // caller writes, which would let anyone mint a fresh quota per request by changing one string.
  const userId = req.user?.id ? String(req.user.id) : (req.ip || 'unknown');
  const key = `${userId}:${req.method}:${rateLimitRouteShape(req.path)}`;
  let timestamps = rateLimitStore.get(key);

  if (timestamps === undefined) {
    // Only a NEW bucket can grow the map, so the ceiling is checked here and never penalises a
    // caller that already has one.
    if (rateLimitStore.size >= RATE_LIMIT_MAX_KEYS) {
      sweepExpiredRateLimitKeys(now);
      if (rateLimitStore.size >= RATE_LIMIT_MAX_KEYS) {
        // Fail OPEN on purpose: this limiter is not the security boundary — requireAdminRole on
        // every route below is. Refusing traffic or evicting a live bucket to make room would turn
        // a memory ceiling into an availability bug, so the overflow request is passed through
        // unmetered and the condition is logged (values-free, once per window).
        if (now - lastOverflowWarnAt >= RATE_LIMIT_WINDOW_MS) {
          lastOverflowWarnAt = now;
          logger.warn('Protection-rules rate-limit table at capacity; passing requests unmetered', {
            keys: rateLimitStore.size,
            max_keys: RATE_LIMIT_MAX_KEYS,
          });
        }
        return next();
      }
    }
    timestamps = [];
  }

  // prune
  timestamps = timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ success: false, error: 'Rate limit exceeded', error_code: 'RATE_LIMIT' });
  }
  timestamps.push(now);
  rateLimitStore.set(key, timestamps);
  writesSinceSweep += 1;
  return next();
};

router.use(protectionRulesRateLimit);

/**
 * Expose the internal map for testing purposes (mirrors middleware/rate-limiter.ts:75).
 * Tests read `.size` and call `.clear()`; nothing in src/ may use this.
 */
export function _rateLimitStoreForTests(): Map<string, number[]> {
  return rateLimitStore;
}

/** Reset the limiter's bookkeeping between tests so sweep state cannot leak across specs. */
export function _resetRateLimitForTests(): void {
  rateLimitStore.clear();
  writesSinceSweep = 0;
  lastSweepAt = 0;
  lastOverflowWarnAt = 0;
}

// Define types for query options
interface ListRulesOptions {
  target_type?: string;
  is_active?: boolean;
}

// Type guard for database errors with code property
interface DatabaseError extends Error {
  code?: string;
}

function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof Error && 'code' in error;
}

/**
 * GET /api/admin/safety/rules
 * List all protection rules
 */
router.get('/', requireAdminRole(), async (req, res) => {
  try {
    const { target_type, is_active } = req.query;

    const options: ListRulesOptions = {};
    if (target_type) options.target_type = target_type as string;
    if (is_active !== undefined) options.is_active = is_active === 'true';

    const rules = await protectionRuleService.listRules(options);

    res.json({
      success: true,
      rules,
      count: rules.length
    });
  } catch (error) {
    logger.error('Failed to list protection rules', error as Error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * GET /api/admin/safety/rules/:id
 * Get a single protection rule
 */
router.get('/:id', requireAdminRole(), async (req, res) => {
  try {
    const { id } = req.params;
    const rule = await protectionRuleService.getRule(id);

    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Protection rule not found'
      });
    }

    res.json({
      success: true,
      rule
    });
  } catch (error) {
    logger.error('Failed to get protection rule', error as Error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * POST /api/admin/safety/rules
 * Create a new protection rule
 */
router.post('/', requireAdminRole(), async (req, res) => {
  try {
    const userId = getUserId(req);
    const {
      rule_name,
      description,
      target_type,
      conditions,
      effects,
      priority,
      is_active
    } = req.body;

    // Validation
    if (!rule_name || !target_type || conditions === undefined || effects === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: rule_name, target_type, conditions, effects'
      });
    }

    if (!['snapshot', 'plugin', 'schema', 'workflow'].includes(target_type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid target_type. Must be: snapshot, plugin, schema, or workflow'
      });
    }

    // Normalize if client sent stringified JSON
    let normalizedConditions: unknown = conditions
    let normalizedEffects: unknown = effects
    try {
      if (typeof normalizedConditions === 'string') normalizedConditions = JSON.parse(normalizedConditions)
      if (typeof normalizedEffects === 'string') normalizedEffects = JSON.parse(normalizedEffects)
    } catch (e) {
      return res.status(400).json({ success:false, error:'conditions/effects string not valid JSON' })
    }

    if (typeof normalizedEffects === 'object' && normalizedEffects !== null && 'action' in normalizedEffects) {
      const effectsObj = normalizedEffects as Record<string, unknown>;
      if (!['allow', 'block', 'elevate_risk', 'require_approval'].includes(effectsObj.action as string)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid effects.action. Must be: allow, block, elevate_risk, or require_approval'
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid effects format'
      });
    }

    // Debug logging for malformed JSON
    if (typeof conditions === 'string') {
      logger.warn('conditions received as string – attempting JSON.parse')
      try { JSON.parse(conditions) } catch (e) { return res.status(400).json({ success:false, error:'conditions string not valid JSON' }) }
    }
    if (typeof effects === 'string') {
      logger.warn('effects received as string – attempting JSON.parse')
      try { JSON.parse(effects) } catch (e) { return res.status(400).json({ success:false, error:'effects string not valid JSON' }) }
    }

    const rule = await protectionRuleService.createRule({
      rule_name,
      description,
      target_type: target_type as 'snapshot' | 'plugin' | 'schema' | 'workflow',
      conditions: normalizedConditions as Record<string, unknown>,
      effects: normalizedEffects as { action: 'allow' | 'block' | 'elevate_risk' | 'require_approval'; [key: string]: unknown },
      priority,
      is_active,
      created_by: userId
    });

    res.status(201).json({
      success: true,
      rule,
      message: 'Protection rule created successfully'
    });
  } catch (error) {
    if (isDatabaseError(error) && error.code === '23505') { // unique_violation
      return res.status(409).json({ success: false, error: 'Rule name already exists', error_code: 'RULE_DUPLICATE' });
    }
    logger.error('Failed to create protection rule', error as Error);
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * PATCH /api/admin/safety/rules/:id
 * Update a protection rule
 */
router.patch('/:id', requireAdminRole(), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Validate if target_type is being updated
    if (updates.target_type && !['snapshot', 'plugin', 'schema', 'workflow'].includes(updates.target_type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid target_type'
      });
    }

    // Validate if effects.action is being updated
    if (updates.effects?.action && !['allow', 'block', 'elevate_risk', 'require_approval'].includes(updates.effects.action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid effects.action'
      });
    }

    const rule = await protectionRuleService.updateRule(id, updates);

    res.json({
      success: true,
      rule,
      message: 'Protection rule updated successfully'
    });
  } catch (error) {
    logger.error('Failed to update protection rule', error as Error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * DELETE /api/admin/safety/rules/:id
 * Delete a protection rule
 */
router.delete('/:id', requireAdminRole(), async (req, res) => {
  try {
    const { id } = req.params;

    await protectionRuleService.deleteRule(id);

    res.json({
      success: true,
      message: 'Protection rule deleted successfully'
    });
  } catch (error) {
    logger.error('Failed to delete protection rule', error as Error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * POST /api/admin/safety/rules/evaluate
 * Dry-run evaluation of protection rules
 */
router.post('/evaluate', requireAdminRole(), async (req, res) => {
  try {
    const { entity_type, entity_id, operation, properties, user_id } = req.body;

    if (!entity_type || !entity_id || !operation) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: entity_type, entity_id, operation'
      });
    }

    const result = await protectionRuleService.evaluateRules({
      entity_type,
      entity_id,
      operation,
      properties: properties || {},
      user_id
    });

    res.json({
      success: true,
      result,
      message: result.matched
        ? `Rule matched: ${result.rule_name}`
        : 'No rules matched'
    });
  } catch (error) {
    logger.error('Failed to evaluate protection rules', error as Error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

export default router;
