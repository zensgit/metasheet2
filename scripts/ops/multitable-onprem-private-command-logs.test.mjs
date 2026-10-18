import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(process.env.PLM_TEST_DEPLOY_SOURCE || path.join(here, 'multitable-onprem-deploy-easy.sh'))

for (const mode of ['success', 'admin-failure', 'health-failure']) {
  test(`operator logs exclude password/token while child gets exact values: ${mode}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plm-private-logs-'))
    const password = randomBytes(32).toString('hex') + '!'
    const token = randomBytes(48).toString('base64url')
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(req.url === '/api/health' ? '{}' : JSON.stringify({ token }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const ops = path.join(root, 'scripts/ops')
      mkdirSync(ops, { recursive: true })
      const write = (name, body) => writeFileSync(path.join(ops, name), body, { mode: 0o700 })
      write('multitable-onprem-deploy-easy.sh', source)
      write('attendance-onprem-bootstrap.sh', '#!/bin/sh\nexit 0\n')
      write('attendance-onprem-bootstrap-admin.sh', '#!/bin/sh\nprintf %s "$ADMIN_PASSWORD" > "$SEEN_PASSWORD"\nexit "$ADMIN_EXIT"\n')
      write('multitable-onprem-healthcheck.sh', '#!/bin/sh\nprintf %s "$AUTH_TOKEN" > "$SEEN_TOKEN"\nexit "$HEALTH_EXIT"\n')
      for (const name of ['apps/web/dist/index.html', 'packages/core-backend/dist/src/db/migrate.js', 'env']) {
        const file = path.join(root, name)
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, 'owned fixture')
      }
      const child = spawn('/bin/bash', [path.join(ops, 'multitable-onprem-deploy-easy.sh')], {
        env: { ...process.env, ENV_FILE: path.join(root, 'env'),
          API_BASE: `http://127.0.0.1:${server.address().port}/api`,
          ADMIN_EMAIL: 'owned@example.invalid', ADMIN_PASSWORD: password,
          SEEN_PASSWORD: path.join(root, 'seen-password'), SEEN_TOKEN: path.join(root, 'seen-token'),
          ADMIN_EXIT: mode === 'admin-failure' ? '13' : '0', HEALTH_EXIT: mode === 'health-failure' ? '9' : '0',
          BUILD_WEB: '0', BUILD_BACKEND: '0', CHECK_NGINX: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes })
      child.stderr.on('data', bytes => { output += bytes })
      const timer = setTimeout(() => child.kill(), 10000)
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      clearTimeout(timer)
      assert.equal(code, mode === 'admin-failure' ? 13 : mode === 'health-failure' ? 9 : 0)
      assert.ok(readFileSync(path.join(root, 'seen-password'), 'utf8') === password, 'Administrator must receive the unchanged password')
      if (mode === 'admin-failure') {
        assert.equal(existsSync(path.join(root, 'seen-token')), false)
      } else {
        assert.ok(readFileSync(path.join(root, 'seen-token'), 'utf8') === token, 'Health check must receive the unchanged token')
      }
      assert.deepEqual(
        { password: output.includes(password), token: output.includes(token) },
        { password: false, token: false },
        'Credentials appeared in an output channel',
      )
      assert.ok(output.includes('[multitable-onprem-deploy-easy] + env'), 'Command execution remains observable')
    } finally {
      await new Promise(resolve => server.close(resolve))
      rmSync(root, { recursive: true, force: true })
    }
  })
}
