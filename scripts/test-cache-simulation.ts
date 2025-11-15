#!/usr/bin/env tsx
/**
 * Cache Access Simulation Script
 *
 * Purpose: Simulate different cache access patterns to test Phase 1 observability
 * Usage: tsx scripts/test-cache-simulation.ts
 */

import { CacheRegistry } from '../packages/core-backend/core/cache/CacheRegistry';

// Simulated access patterns matching real-world scenarios
const ACCESS_PATTERNS = {
  // High-frequency patterns (potential cache candidates)
  highFrequency: [
    { key: 'user:123', pattern: 'user', frequency: 100 },
    { key: 'user:456', pattern: 'user', frequency: 80 },
    { key: 'department:dept_1', pattern: 'department', frequency: 60 },
    { key: 'spreadsheet:sheet_1', pattern: 'spreadsheet', frequency: 50 },
  ],

  // Medium-frequency patterns
  mediumFrequency: [
    { key: 'workflow:wf_1', pattern: 'workflow', frequency: 30 },
    { key: 'file:file_1', pattern: 'file', frequency: 25 },
    { key: 'permission:perm_1', pattern: 'permission', frequency: 20 },
  ],

  // Low-frequency patterns
  lowFrequency: [
    { key: 'audit:log_1', pattern: 'audit', frequency: 5 },
    { key: 'config:app_config', pattern: 'config', frequency: 3 },
  ],
};

async function simulateCacheAccess(key: string, count: number) {
  const cache = CacheRegistry.getInstance().getCache();

  for (let i = 0; i < count; i++) {
    // Simulate cache get (will always miss with NullCache)
    await cache.get(key);

    // Occasionally simulate cache set
    if (i % 10 === 0) {
      await cache.set(key, JSON.stringify({ data: `value_${i}` }), 3600);
    }

    // Occasionally simulate cache delete
    if (i % 20 === 0) {
      await cache.del(key);
    }
  }
}

async function simulateTagInvalidation(tag: string) {
  const cache = CacheRegistry.getInstance().getCache();
  await cache.invalidateByTag(tag);
}

async function runSimulation() {
  console.log('🚀 Starting cache access simulation...\n');

  // Phase 1: High-frequency access simulation
  console.log('📊 Phase 1: High-frequency patterns');
  for (const item of ACCESS_PATTERNS.highFrequency) {
    console.log(`  → ${item.pattern}: ${item.key} (${item.frequency} accesses)`);
    await simulateCacheAccess(item.key, item.frequency);
  }

  // Phase 2: Medium-frequency access simulation
  console.log('\n📊 Phase 2: Medium-frequency patterns');
  for (const item of ACCESS_PATTERNS.mediumFrequency) {
    console.log(`  → ${item.pattern}: ${item.key} (${item.frequency} accesses)`);
    await simulateCacheAccess(item.key, item.frequency);
  }

  // Phase 3: Low-frequency access simulation
  console.log('\n📊 Phase 3: Low-frequency patterns');
  for (const item of ACCESS_PATTERNS.lowFrequency) {
    console.log(`  → ${item.pattern}: ${item.key} (${item.frequency} accesses)`);
    await simulateCacheAccess(item.key, item.frequency);
  }

  // Phase 4: Tag-based invalidation simulation
  console.log('\n📊 Phase 4: Tag invalidation patterns');
  await simulateTagInvalidation('user');
  console.log('  → Invalidated tag: user');
  await simulateTagInvalidation('spreadsheet');
  console.log('  → Invalidated tag: spreadsheet');

  console.log('\n✅ Simulation complete!');
  console.log('\n📈 Check metrics at: http://localhost:8900/metrics/prom');
  console.log('📊 Check cache status at: http://localhost:8900/internal/cache');
}

// Execute simulation
runSimulation().catch(console.error);
