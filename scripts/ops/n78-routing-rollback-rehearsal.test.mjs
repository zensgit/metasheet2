import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./n78-routing-rollback-rehearsal.mjs', import.meta.url))
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
test('help is offline and states the synthetic database and pinned checkout requirements', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /32aac002a2/)
  assert.match(result.stdout, /DATABASE_URL/)
  assert.match(result.stdout, /No retries/)
})
test('argument errors do not begin an execution', () => assert.equal(run([]).status, 2))
for (const [env, expected] of [
  [{}, 'EXPECT_DB_REQUIRED'],
  [{ EXPECT_DB: '1' }, 'DATABASE_URL_REQUIRED'],
  [{ EXPECT_DB: '1', DATABASE_URL: 'private-input-that-must-not-escape' }, 'DATABASE_URL_REQUIRED'],
  [{ EXPECT_DB: '1', DATABASE_URL: 'postgres://synthetic:private-input-that-must-not-escape@invalid/none' }, 'SYNTHETIC_DATABASE_REQUIRED'],
]) test(`preflight ${expected} writes failure evidence before nonzero exit`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'n78-rehearsal-'))
  try {
    const output = join(dir, 'result.json')
    const result = run([dir, dir, output], env)
    const raw = readFileSync(output, 'utf8'), report = JSON.parse(raw)
    assert.equal(result.status, 1)
    assert.equal(report.error, expected)
    assert.equal(report.status, 'failed')
    assert.deepEqual(report.steps, [])
    assert.ok(!(raw + result.stdout + result.stderr).includes('private-input-that-must-not-escape'))
  } finally { rmSync(dir, { recursive: true }) }
})
test('existing evidence is never overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n78-rehearsal-'))
  try {
    const output = join(dir, 'result.json'); writeFileSync(output, 'prior-evidence')
    const result = run([dir, dir, output])
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'OUTPUT_UNAVAILABLE\n')
    assert.equal(readFileSync(output, 'utf8'), 'prior-evidence')
  } finally { rmSync(dir, { recursive: true }) }
})
