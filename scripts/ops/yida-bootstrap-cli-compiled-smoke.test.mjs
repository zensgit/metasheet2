import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Runs the COMPILED YiDa bootstrap CLI the way the deployed server does, after
// `pnpm --filter @metasheet/core-backend build` in the required test (20.x) job. The vitest suites
// only import its source, which by design never runs it, so only a spawned program shows that the
// CommonJS entry check still fires and that the file still compiles into dist. With no arguments and
// no DATABASE_URL it must refuse in the argument phase: one summary line, nothing on stderr, exit 1.
// A silent exit 0 would read to an operator as success.
const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const cli = path.join(repo, 'packages/core-backend/dist/scripts/bootstrap-yida-initialization-owner.js')

test('compiled YiDa bootstrap CLI refuses an empty invocation as a program', () => {
  assert.ok(fs.statSync(cli, { throwIfNoEntry: false })?.isFile(),
    'packages/core-backend/dist/scripts/bootstrap-yida-initialization-owner.js is missing: build core-backend first')
  // A clean environment: no DATABASE_URL and nothing else inherited from the runner.
  const result = spawnSync(process.execPath, [cli], { cwd: repo, env: {}, encoding: 'utf8', timeout: 30000 })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, '{"ok":false,"status":"input"}\n')
  assert.equal(result.stderr, '')
  assert.equal(result.status, 1)
})
