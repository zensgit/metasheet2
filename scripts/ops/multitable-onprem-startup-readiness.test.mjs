import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(process.env.PLM_TEST_DEPLOY_SOURCE || path.join(here, 'multitable-onprem-deploy-easy.sh'))

for (const mode of ['immediate', 'delayed', 'unavailable', 'redirect', 'transport']) {
  test(`actual deploy script waits for API readiness: ${mode}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plm-readiness-'))
    let health = 0
    let admin = 0
    let ready = false
    const server = createServer((req, res) => {
      if (req.url === '/api/health') {
        health++
        ready = mode === 'immediate' || (mode === 'delayed' && health >= 4)
        res.statusCode = ready ? 200 : mode === 'redirect' ? 302 : 503
        res.end('{}')
      } else {
        admin++
        res.statusCode = ready ? 200 : 502
        res.end(ready ? JSON.stringify({ token: 'owned-readiness-session' }) : '{}')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/api`
    if (mode === 'transport') await new Promise(resolve => server.close(resolve))
    try {
      const ops = path.join(root, 'scripts/ops')
      mkdirSync(ops, { recursive: true })
      const write = (name, body) => writeFileSync(path.join(ops, name), body, { mode: 0o700 })
      write('multitable-onprem-deploy-easy.sh', source)
      write('attendance-onprem-bootstrap.sh', `#!/bin/sh
set -eu
if [ -n "\${MS_EFFECTIVE_SERVICE_RECEIPT-}" ]; then
  printf '%s\\000%s\\000%s\\000' "\${SERVICE_MANAGER:-pm2}" "\${PM2_APP_NAME:-metasheet-backend}" "\${SYSTEMD_SERVICE_NAME:-metasheet-backend.service}" > "$MS_EFFECTIVE_SERVICE_RECEIPT"
fi
exit 0
`)
      write('attendance-onprem-bootstrap-admin.sh', '#!/bin/sh\nprintf x >> "$ADMIN_ATTEMPTS"\ncode=$(curl -s -o /dev/null -w "%{http_code}" "$API_BASE/auth/login")\n[ "$code" = 200 ]\n')
      write('multitable-onprem-healthcheck.sh', '#!/bin/sh\nexit 0\n')
      // Only shorten retry intervals; curl and its actual HTTP/transport results remain real.
      write('sleep', '#!/bin/sh\nexit 0\n')
      for (const name of ['apps/web/dist/index.html', 'packages/core-backend/dist/src/db/migrate.js', 'env']) {
        const file = path.join(root, name)
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, 'owned fixture')
      }
      const child = spawn('/bin/bash', [path.join(ops, 'multitable-onprem-deploy-easy.sh')], {
        env: { ...process.env, PATH: ops + ':' + process.env.PATH, ENV_FILE: path.join(root, 'env'),
          ADMIN_ATTEMPTS: path.join(root, 'admin-attempts'), API_BASE: base, ADMIN_EMAIL: 'owned@example.invalid', ADMIN_PASSWORD: 'synthetic-only',
          BUILD_WEB: '0', BUILD_BACKEND: '0', CHECK_NGINX: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', bytes => { stderr += bytes })
      const timer = setTimeout(() => child.kill(), 10000)
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      clearTimeout(timer)
      if (mode === 'immediate' || mode === 'delayed') {
        assert.equal(code, 0)
        assert.equal(health, mode === 'delayed' ? 4 : 1)
        assert.equal(admin, 2)
        assert.equal(readFileSync(path.join(root, 'admin-attempts'), 'utf8'), 'x')
      } else {
        assert.notEqual(code, 0)
        assert.equal(existsSync(path.join(root, 'admin-attempts')), false, 'Admin command must not be invoked before readiness')
        assert.equal(admin, 0, 'Admin/bootstrap must not run before readiness')
        assert.equal(health, mode === 'transport' ? 0 : 30)
        if (mode === 'transport') {
          assert.equal(stderr.includes(
            '[multitable-onprem-deploy-easy] ERROR: API did not become ready after service startup; admin bootstrap was not attempted',
          ), true, 'Transport failure must reach the readiness retry limit')
        }
      }
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve))
      rmSync(root, { recursive: true, force: true })
    }
  })
}
