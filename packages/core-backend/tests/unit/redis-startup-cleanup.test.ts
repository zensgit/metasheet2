import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('releases a failed real Redis connection while retaining fail-closed startup memoization', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'plm-redis-startup-'))
  const require = createRequire(import.meta.url)
  const source = path.resolve('src/db/redis.ts')
  const script = `
    const assert = require('node:assert/strict');
    const {getRedisClient, closeRedisClient} = require(${JSON.stringify(source)});
    (async () => {
      assert.equal(await getRedisClient(), null);
      assert.equal(await getRedisClient(), null);
      await closeRedisClient();
      console.log('closed-without-fallback');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  try {
    const result = await promisify(execFile)(process.execPath,
      ['--require', require.resolve('tsx/cjs'), '-e', script], {
        env: { ...process.env, REDIS_URL: path.join(root, 'missing.sock') },
        timeout: 3000,
      })
    expect(result.stdout.trim()).toBe('closed-without-fallback')
    expect(result.stderr).toContain('failed to connect')
  } finally {
    rmSync(root, { recursive: true })
  }
})
