import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

async function calculateCacheHitRate(metricsText) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phase5-cache-hit-rate-'));
  const metricsPath = path.join(dir, 'metrics.prom');

  try {
    await writeFile(metricsPath, metricsText);
    const { stdout } = await execFileAsync('bash', ['scripts/phase5-cache-hit-rate.sh', metricsPath], {
      cwd: repoRoot,
    });
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('uses generic cache counters when they have samples', async () => {
  const result = await calculateCacheHitRate(`
# HELP cache_hits_total Total cache hits
cache_hits_total{impl="memory",key_pattern="foo"} 8
cache_miss_total{impl="memory",key_pattern="foo"} 2
rbac_perm_cache_hits_total 100
rbac_perm_cache_miss_total 1
`);

  assert.equal(result.source, 'generic_cache');
  assert.equal(result.hits, 8);
  assert.equal(result.misses, 2);
  assert.equal(result.total, 10);
  assert.equal(result.hit_rate, 80);
});

test('falls back to RBAC permission cache counters when generic cache is idle', async () => {
  const result = await calculateCacheHitRate(`
# HELP cache_hits_total Total cache hits
# HELP rbac_perm_cache_hits_total Total RBAC permission cache hits
rbac_perm_cache_hits_total 10
rbac_perm_cache_miss_total 1
`);

  assert.equal(result.source, 'rbac_permission_cache');
  assert.equal(result.hits, 10);
  assert.equal(result.misses, 1);
  assert.equal(result.total, 11);
  assert.equal(result.hit_rate, 90.91);
});

test('supports the legacy plural RBAC miss counter when singular misses are absent', async () => {
  const result = await calculateCacheHitRate(`
rbac_perm_cache_hits_total 9
rbac_perm_cache_misses_total 1
`);

  assert.equal(result.source, 'rbac_permission_cache_legacy');
  assert.equal(result.hits, 9);
  assert.equal(result.misses, 1);
  assert.equal(result.total, 10);
  assert.equal(result.hit_rate, 90);
});

test('returns a zero none source when no supported cache counters have samples', async () => {
  const result = await calculateCacheHitRate(`
# HELP cache_hits_total Total cache hits
# HELP rbac_perm_cache_hits_total Total RBAC permission cache hits
http_requests_total{method="GET",status="200"} 5
`);

  assert.equal(result.source, 'none');
  assert.equal(result.hits, 0);
  assert.equal(result.misses, 0);
  assert.equal(result.total, 0);
  assert.equal(result.hit_rate, 0);
});
