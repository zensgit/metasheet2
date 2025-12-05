/**
 * Protection Rules Admin API Routes
 * Sprint 2: Snapshot Protection System
 *
 * Provides REST API for protection rule management
 */

import { Router } from 'express';
import { protectionRuleService } from '../services/ProtectionRuleService';
import { Logger } from '../core/logger';

const router = Router();
const logger = new Logger('ProtectionRulesRoutes');

// Simple in-memory rate limiter: 10 requests per 60s per user+method+path
const rateLimitStore = new Map<string, number[]>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

router.use((req, res, next) => {
  const userId = (req.headers['x-user-id'] as string) || 'anon';
  const key = `${userId}:${req.method}:${req.path}`;
  let timestamps = rateLimitStore.get(key) || [];
  const now = Date.now();
  // prune
  timestamps = timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ success: false, error: 'Rate limit exceeded', error_code: 'RATE_LIMIT' });
  }
  timestamps.push(now);
  rateLimitStore.set(key, timestamps);
  return next();
});

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
router.get('/', async (req, res) => {
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
router.get('/:id', async (req, res) => {
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
router.post('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'system';
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
router.patch('/:id', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
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
router.post('/evaluate', async (req, res) => {
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
