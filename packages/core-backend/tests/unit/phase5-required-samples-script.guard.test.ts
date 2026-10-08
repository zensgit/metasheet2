import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const run = promisify(execFile)
const repoRoot = resolve(__dirname, '../../../..')

// The required backend test command discovers this file; the root ops suite has no default test glob.
test('runs the whole Phase 5 sample-validity script contract without skipped cases', async () => {
  const { stdout } = await run(process.execPath, [
    '--test',
    '--test-reporter=tap',
    'scripts/ops/phase5-required-samples-contract.test.mjs',
  ], {
    cwd: repoRoot,
    env: { ...process.env, npm_config_offline: 'true' },
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  const summary = Object.fromEntries([...stdout.matchAll(
    /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm,
  )].map((match) => [match[1], Number(match[2])]))
  expect(summary).toEqual({
    tests: 7,
    pass: 7,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  })
}, 150_000)
