import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

async function upgrade({ delayed = false, badPlugins = false, unavailable = false, skip = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-upgrade-readiness-'))
  const ops = path.join(root, 'scripts/ops')
  fs.mkdirSync(ops, { recursive: true })
  fs.copyFileSync(process.env.UPGRADE_SCRIPT_UNDER_TEST || path.join(repo, 'scripts/ops/attendance-onprem-package-upgrade.sh'), path.join(ops, 'attendance-onprem-package-upgrade.sh'))
  fs.copyFileSync(path.join(repo, 'scripts/ops/attendance-onprem-healthcheck.sh'), path.join(ops, 'attendance-onprem-healthcheck.sh'))
  fs.chmodSync(path.join(ops, 'attendance-onprem-healthcheck.sh'), 0o700)
  fs.writeFileSync(path.join(ops, 'attendance-onprem-update.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o700 })
  fs.writeFileSync(path.join(root, 'app.env'), '', { mode: 0o600 })
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    res.writeHead(unavailable || (badPlugins && req.url === '/api/plugins') ? 503 : 200)
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  let timer
  const marker = path.join(root, 'first-curl')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  if (delayed) {
    await new Promise(resolve => server.close(resolve))
    // Observe the real curl invocation, then delay binding. This avoids relying
    // on process-manager discovery timing; the wrapper never changes HTTP I/O.
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf started > "$CURL_OBSERVATION"\nexec /usr/bin/curl "$@"\n', { mode: 0o700 })
    fs.watchFile(marker, { interval: 20 }, () => {
      if (fs.existsSync(marker) && !timer) timer = setTimeout(() => server.listen(port, '127.0.0.1'), 1400)
    })
  }
  const started = Date.now()
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', [path.join(ops, 'attendance-onprem-package-upgrade.sh')], {
        cwd: root,
        env: { PATH: delayed ? `${bin}:/usr/bin:/bin` : '/usr/bin:/bin', CURL_OBSERVATION: marker, HOME: root, ENV_FILE: path.join(root, 'app.env'),
          INSTALL_DEPS: '0', BUILD_BACKEND: '0', BUILD_WEB: '0', RUN_MIGRATIONS: '0',
          RESTART_SERVICE: '1', RELOAD_NGINX: '0', SERVICE_MANAGER: 'none', CHECK_NGINX: '0',
          RUN_HEALTHCHECK: skip ? '0' : '1', BASE_URL: `http://127.0.0.1:${port}`,
          API_BASE: `http://127.0.0.1:${port}/api`, BACKEND_HEALTH_URL: `http://127.0.0.1:${port}/health` },
      })
      let text = ''
      child.stdout.on('data', data => { text += data })
      child.stderr.on('data', data => { text += data })
      child.on('error', reject)
      child.on('close', code => resolve({ code, text }))
    })
    return { ...output, requests, elapsed: Date.now() - started }
  } finally {
    fs.unwatchFile(marker)
    clearTimeout(timer)
    if (server.listening) await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('delayed API socket becomes ready before the unchanged full healthcheck', async () => {
  const result = await upgrade({ delayed: true })
  assert.equal(result.code, 0, result.text)
  assert.ok(result.elapsed >= 1400)
  assert.ok(result.text.includes('Package upgrade complete'))
})

test('backend readiness cannot bypass the final plugins health gate', async () => {
  const result = await upgrade({ badPlugins: true })
  assert.notEqual(result.code, 0)
  assert.ok(result.text.includes('api plugins unreachable'), result.text)
})

test('explicit healthcheck disable preserves the existing no-probe behavior', async () => {
  const result = await upgrade({ skip: true })
  assert.equal(result.code, 0, result.text)
  assert.equal(result.requests, 0)
})

test('permanently unhealthy backend remains a bounded failed upgrade', { timeout: 80000 }, async () => {
  const result = await upgrade({ unavailable: true })
  assert.notEqual(result.code, 0)
  assert.ok(result.text.includes('Backend did not become ready after upgrade'), result.text)
  assert.ok(result.elapsed >= 25000 && result.elapsed < 75000, String(result.elapsed))
})
