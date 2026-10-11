import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { parseYamlDocument } from './ci-realdb-step-contract.mjs'

const bridgeUrl = new URL('./ci-realdb-step-contract.mjs', import.meta.url).href

function checkInputAndCleanup(outcome) {
  const program = `
    import assert from 'node:assert/strict'
    import cp from 'node:child_process'
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const originalMkdtemp = fs.mkdtempSync
    const directories = []
    const descriptors = []
    const yaml = 'name: 中文😀\\njobs: {}\\n# ' + 'padding'.repeat(24000) + '\\n'
    const outcome = ${JSON.stringify(outcome)}
    let calls = 0
    fs.mkdtempSync = (...args) => {
      const dir = originalMkdtemp(...args)
      directories.push(dir)
      if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
      return dir
    }
    if (outcome === 'write-error') fs.writeFileSync = () => { throw new Error('DIAGNOSTIC_WRITE_FAILED') }
    cp.spawnSync = (command, args, options) => {
      calls++
      assert.equal(command, 'python3')
      assert.equal(options.input, undefined, 'YAML must not use a synchronous input pipe')
      assert.equal(typeof options.stdio?.[0], 'number', 'stdin must be a file descriptor')
      assert.deepEqual(options.stdio.slice(1), ['pipe', 'pipe'])
      assert.equal(options.timeout, 120000)
      assert.equal(options.maxBuffer, 64 * 1024 * 1024)
      const fd = options.stdio[0]
      descriptors.push(fd)
      assert.equal(fs.fstatSync(fd).isFile(), true)
      if (process.platform !== 'win32') assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600)
      assert.equal(fs.readFileSync(fd, 'utf8'), yaml)
      if (outcome === 'throw') throw new Error('DIAGNOSTIC_SPAWN_THROW')
      if (outcome === 'timeout') return { error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null }
      if (outcome === 'missing-yaml') return { status: 3, stderr: 'PYYAML_MISSING: unavailable', stdout: '' }
      if (outcome === 'invalid-json') return { status: 0, stdout: '{', stderr: '' }
      return { status: 0, stdout: '{"jobs":{}}', stderr: '' }
    }
    syncBuiltinESMExports()
    const { parseYamlDocument } = await import(${JSON.stringify(bridgeUrl)})
    try {
      for (let i = 0; i < 2; i++) {
        if (outcome === 'success') assert.deepEqual(parseYamlDocument(yaml), { jobs: {} })
        else {
          const expected = {
            throw: /DIAGNOSTIC_SPAWN_THROW/,
            timeout: /failing CLOSED.*ETIMEDOUT/,
            'missing-yaml': /exited 3: PYYAML_MISSING/,
            'invalid-json': /emitted unparseable JSON/,
            'write-error': /DIAGNOSTIC_WRITE_FAILED/,
          }[outcome]
          assert.throws(() => parseYamlDocument(yaml), expected)
        }
        for (const dir of directories) assert.equal(fs.existsSync(dir), false, 'temporary YAML directory must be removed')
        for (const fd of descriptors) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' })
      }
      assert.equal(calls, outcome === 'write-error' ? 0 : outcome === 'success' ? 1 : 2, 'only successful parses may be cached; interpreter failures must not fall back')
      assert.equal(directories.length, outcome === 'success' ? 1 : 2)
      console.log(JSON.stringify({ calls, directoriesRemoved: true, descriptorsClosed: true }))
    } finally {
      for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true })
      for (const fd of descriptors) {
        try { fs.fstatSync(fd) } catch { continue }
        fs.closeSync(fd)
      }
    }
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), {
    calls: outcome === 'write-error' ? 0 : outcome === 'success' ? 1 : 2,
    directoriesRemoved: true,
    descriptorsClosed: true,
  })
}

for (const outcome of ['success', 'throw', 'timeout', 'missing-yaml', 'invalid-json', 'write-error']) {
  test(`YAML file input preserves bytes and cleans up after ${outcome}`, () => {
    checkInputAndCleanup(outcome)
  })
}

test('real YAML bridge parses a large UTF-8 workflow with Chinese and emoji values', () => {
  const yaml = 'name: 中文😀\njobs:\n  test:\n    steps:\n      - name: 验证\n        run: echo ok\n# ' + 'padding'.repeat(24000) + '\n'
  assert.deepEqual(parseYamlDocument(yaml), {
    name: '中文😀',
    jobs: { test: { steps: [{ name: '验证', run: 'echo ok' }] } },
  })
})

test('real YAML bridge rejects malformed YAML', () => {
  assert.throws(() => parseYamlDocument('jobs: [\n'), /exited 4: YAML_PARSE_ERROR:/)
})
