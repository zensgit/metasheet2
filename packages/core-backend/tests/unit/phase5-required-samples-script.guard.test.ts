import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const run = promisify(execFile)
const repoRoot = resolve(__dirname, '../../../..')

// The required backend unit chain discovers this wrapper; root ops has no default test glob.
test('runs the whole Phase5 validity and sampling union without skipped cases', async () => {
  const { stdout } = await run(process.execPath, [
    '--test', '--test-reporter=tap', 'scripts/ops/phase5-required-samples-contract.test.mjs',
  ], {
    cwd: repoRoot,
    env: { ...process.env, npm_config_offline: 'true' },
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  const summary = Object.fromEntries([...stdout.matchAll(
    /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm,
  )].map(match => [match[1], Number(match[2])]))
  expect(summary).toEqual({ tests: 13, pass: 13, fail: 0, cancelled: 0, skipped: 0, todo: 0 })
}, 150_000)
