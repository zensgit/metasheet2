import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_APP_PORTS, assertAppServiceStopped } from './reset-isolated-db.mjs'

// ---------------------------------------------------------------------------
// Owner 3rd review P2 — "service stopped" fail-open in reset-isolated-db.mjs.
// (a) pm2 present but output unparseable/garbage -> fail CLOSED (refuse, no drop).
// (b) QA_APP_PORT must SUPPLEMENT the defaults, never replace them: a default app port still
//     listening while QA_APP_PORT points at a free port must still refuse.
// assertAppServiceStopped THROWS to refuse; the "no DROP" guarantee is the ordering in
// dropAndRecreate (this helper runs before any DROP is issued) — proven structurally, not by DB here.
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => sock.end())
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

function writeStub(dir, body) {
  const file = path.join(dir, 'pm2-stub.sh')
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

// Snapshot + restore the env vars assertAppServiceStopped / DEFAULT_APP_PORTS read.
const ENV_KEYS = ['QA_PM2_BIN', 'QA_APP_PORT', 'PORT', 'WINDOWS_NATIVE_GATEWAY_PORT']
async function withEnv(overrides, fn) {
  const saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  Object.assign(process.env, overrides)
  try {
    return await fn()
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test('DEFAULT_APP_PORTS: QA_APP_PORT SUPPLEMENTS the defaults (does not replace)', async () => {
  await withEnv({ PORT: '8900', WINDOWS_NATIVE_GATEWAY_PORT: '8080', QA_APP_PORT: '9999' }, () => {
    const ports = DEFAULT_APP_PORTS()
    assert.ok(ports.includes(8900), 'default PORT retained')
    assert.ok(ports.includes(8080), 'default gateway port retained')
    assert.ok(ports.includes(9999), 'QA_APP_PORT added')
  })
})

test('(a) pm2 present but emitting garbage -> refuse (fail closed, no drop)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-pm2-'))
  try {
    const stub = writeStub(dir, "echo 'not-json{'") // exit 0, unparseable stdout
    const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()])
    await withEnv(
      { QA_PM2_BIN: stub, PORT: String(p1), WINDOWS_NATIVE_GATEWAY_PORT: String(p2), QA_APP_PORT: String(p3) },
      async () => {
        await assert.rejects(assertAppServiceStopped(), /unparseable output/)
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('(a2) pm2 present but non-array JSON -> refuse (fail closed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-pm2-'))
  try {
    const stub = writeStub(dir, "echo '{}'") // valid JSON, but not the expected array
    const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()])
    await withEnv(
      { QA_PM2_BIN: stub, PORT: String(p1), WINDOWS_NATIVE_GATEWAY_PORT: String(p2), QA_APP_PORT: String(p3) },
      async () => {
        await assert.rejects(assertAppServiceStopped(), /did not return a JSON array/)
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('(b) QA_APP_PORT free but a DEFAULT app port still listening -> refuse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-pm2-'))
  const listeningPort = await freePort()
  const server = await listenOn(listeningPort)
  try {
    const stub = writeStub(dir, "echo '[]'") // pm2 present, 0 online
    const qaPort = await freePort() // a free port nothing listens on
    const gwPort = await freePort()
    await withEnv(
      {
        QA_PM2_BIN: stub,
        PORT: String(listeningPort), // a DEFAULT source, currently listening
        WINDOWS_NATIVE_GATEWAY_PORT: String(gwPort),
        QA_APP_PORT: String(qaPort), // points elsewhere; must NOT mask the listening default
      },
      async () => {
        await assert.rejects(assertAppServiceStopped(), /still accepting connections/)
      },
    )
  } finally {
    await new Promise((r) => server.close(r))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('positive control: pm2 present with 0 online + no ports listening -> resolves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-pm2-'))
  try {
    const stub = writeStub(dir, "echo '[]'")
    const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()])
    await withEnv(
      { QA_PM2_BIN: stub, PORT: String(p1), WINDOWS_NATIVE_GATEWAY_PORT: String(p2), QA_APP_PORT: String(p3) },
      async () => {
        await assert.doesNotReject(assertAppServiceStopped())
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('positive control: pm2 NOT installed (ENOENT) + no ports listening -> resolves (falls back to port check)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-pm2-'))
  try {
    const missing = path.join(dir, 'definitely-not-pm2')
    const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()])
    await withEnv(
      { QA_PM2_BIN: missing, PORT: String(p1), WINDOWS_NATIVE_GATEWAY_PORT: String(p2), QA_APP_PORT: String(p3) },
      async () => {
        await assert.doesNotReject(assertAppServiceStopped())
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pm2 present with an ONLINE process -> refuse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-pm2-'))
  try {
    const stub = writeStub(dir, `echo '[{"name":"metasheet-app","pm2_env":{"status":"online"}}]'`)
    const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()])
    await withEnv(
      { QA_PM2_BIN: stub, PORT: String(p1), WINDOWS_NATIVE_GATEWAY_PORT: String(p2), QA_APP_PORT: String(p3) },
      async () => {
        await assert.rejects(assertAppServiceStopped(), /still online/)
      },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
