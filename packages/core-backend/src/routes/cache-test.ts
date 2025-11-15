/**
 * Cache Testing Endpoints
 *
 * Development-only endpoints for testing cache observability
 */

import { Router } from 'express';
import { cacheRegistry } from '../../core/cache/CacheRegistry';

const router = Router();

// Type definitions for simulation results
interface CacheOperationResult {
  key: string;
  operations: number;
}

interface SimulationResults {
  highFrequency: CacheOperationResult[];
  mediumFrequency: CacheOperationResult[];
  lowFrequency: CacheOperationResult[];
  tagInvalidations: string[];
}

/**
 * POST /api/cache-test/simulate
 *
 * Simulate cache access patterns
 */
router.post('/simulate', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  const cache = cacheRegistry.get();
  const results: SimulationResults = {
    highFrequency: [],
    mediumFrequency: [],
    lowFrequency: [],
    tagInvalidations: [],
  };

  try {
    // High-frequency patterns
    for (const item of [
      { key: 'user:123', count: 100 },
      { key: 'user:456', count: 80 },
      { key: 'department:dept_1', count: 60 },
      { key: 'spreadsheet:sheet_1', count: 50 },
    ]) {
      for (let i = 0; i < item.count; i++) {
        await cache.get(item.key);
        if (i % 10 === 0) await cache.set(item.key, `value_${i}`, 3600);
        if (i % 20 === 0) await cache.del(item.key);
      }
      results.highFrequency.push({ key: item.key, operations: item.count });
    }

    // Medium-frequency patterns
    for (const item of [
      { key: 'workflow:wf_1', count: 30 },
      { key: 'file:file_1', count: 25 },
      { key: 'permission:perm_1', count: 20 },
    ]) {
      for (let i = 0; i < item.count; i++) {
        await cache.get(item.key);
        if (i % 5 === 0) await cache.set(item.key, `value_${i}`, 1800);
      }
      results.mediumFrequency.push({ key: item.key, operations: item.count });
    }

    // Low-frequency patterns
    for (const item of [
      { key: 'audit:log_1', count: 5 },
      { key: 'config:app_config', count: 3 },
    ]) {
      for (let i = 0; i < item.count; i++) {
        await cache.get(item.key);
      }
      results.lowFrequency.push({ key: item.key, operations: item.count });
    }

    // Tag invalidations (skipped for NullCache - optional feature for Phase 3)
    // await cache.invalidateByTag('user');
    // results.tagInvalidations.push('user');
    // await cache.invalidateByTag('spreadsheet');
    // results.tagInvalidations.push('spreadsheet');

    res.json({
      success: true,
      message: 'Cache simulation completed',
      results,
      metricsUrl: '/metrics/prom',
      statusUrl: '/internal/cache',
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/cache-test/metrics
 *
 * Get cache metrics summary
 */
router.get('/metrics', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  const status = cacheRegistry.getStatus();

  res.json({
    cacheStatus: {
      enabled: status.enabled,
      implementation: status.implName,
    },
    stats: status.stats,
    metricsEndpoint: '/metrics/prom',
    cacheStatusEndpoint: '/internal/cache',
  });
});

export default router;
