import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { spawn } from 'node:child_process'

test('synthetic transports and output are values-free', () => {
  const result = spawnSync(process.execPath, ['scripts/ops/multitable-onprem-network-selfcheck.mjs', '--selftest'], {
    encoding: 'utf8', env: { ...process.env, MULTITABLE_NETWORK_ORIGIN: 'invalid-private-target', MULTITABLE_NETWORK_TOKEN: 'private-token' },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.length, 37)
  assert.equal(lines.at(-1), 'SUMMARY PASS=34 FAIL=0 SKIP=0')
  for (const label of ['POST-json-script', 'POST-json-sql']) {
    for (const scenario of ['json', 'html', 'nul', 'reset', '404', '401', 'no-token']) {
      assert.ok(lines.some((line) => line.startsWith(`PASS selftest-${scenario}-${label} `)))
    }
  }
  for (const line of lines.slice(0, 34)) assert.match(line, /^PASS selftest-[a-zA-Z0-9-]+ httpStatus=(0|200|401|404) time=[0-9TZ:.\-]+ elapsedMs=\d+ requestId=[0-9a-f-]{36}$/)
  assert.ok(lines.some((line) => line.startsWith('PASS selftest-json-GET-json404 httpStatus=404 ')))
  assert.ok(lines[34].startsWith('HINT '))
  assert.ok(lines[35].startsWith('HINT '))
})

test('invalid configuration is redacted and refused before network', () => {
  const result = spawnSync(process.execPath, ['scripts/ops/multitable-onprem-network-selfcheck.mjs'], {
    encoding: 'utf8', env: { ...process.env, MULTITABLE_NETWORK_ORIGIN: 'not-a-url-private', MULTITABLE_NETWORK_TOKEN: 'private-token' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /^FAIL configuration-or-runtime /)
  assert.ok(result.stdout.includes('httpStatus=0'))
  assert.ok(result.stdout.endsWith('SUMMARY PASS=0 FAIL=1 SKIP=0\n'))
  assert.doesNotMatch(result.stdout + result.stderr, /private|not-a-url/)
})

test('real CLI summary counts PASS, FAIL and missing-token SKIP on loopback only', async () => {
  let seen = 0
  const server = http.createServer((request, response) => {
    seen += 1
    response.setHeader('Content-Type', 'application/json')
    response.end('{"ok":true,"status":"ok"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const token of ['', 'synthetic']) {
      const child = spawn(process.execPath, ['scripts/ops/multitable-onprem-network-selfcheck.mjs'], {
        env: { ...process.env, MULTITABLE_NETWORK_ORIGIN: `http://127.0.0.1:${server.address().port}`, MULTITABLE_NETWORK_TOKEN: token },
      })
      let output = ''
      let errors = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { errors += chunk })
      const code = await new Promise((resolve) => child.on('close', resolve))
      assert.equal(errors, '')
      assert.equal(code, token ? 1 : 0)
      assert.ok(output.endsWith(token ? 'SUMMARY PASS=1 FAIL=4 SKIP=0\n' : 'SUMMARY PASS=1 FAIL=0 SKIP=4\n'))
      assert.doesNotMatch(output, /127\.0\.0\.1|synthetic|"ok"/)
    }
    assert.equal(seen, 6)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('release whitelist and delivery bundle include all companion files', () => {
  for (const file of ['scripts/ops/multitable-onprem-package-build.sh', 'scripts/ops/multitable-onprem-delivery-bundle.mjs']) {
    const source = readFileSync(file, 'utf8')
    for (const extension of ['sh', 'ps1', 'mjs']) assert.ok(source.includes(`multitable-onprem-network-selfcheck.${extension}`))
  }
})
