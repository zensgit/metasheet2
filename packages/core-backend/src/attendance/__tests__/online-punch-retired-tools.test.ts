import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const tools = [
  'scripts/attendance/import-punch-events.cjs',
  'scripts/ops/staging-attendance-inout-merge-s2-3-smoke.mjs',
]

describe('retired live timestamp tools', () => {
  it('refuses before business file, HTTP or PostgreSQL IO, with working controls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attendance-retired-tools-'))
    const file = join(dir, 'punch.json')
    const preload = join(dir, 'census.cjs')
    let httpCalls = 0
    let tcpCalls = 0
    const http = createHttpServer((_req, res) => { httpCalls += 1; res.writeHead(403); res.end() })
    const tcp = createTcpServer((socket) => { tcpCalls += 1; socket.end() })
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
    await new Promise<void>((done) => tcp.listen(0, '127.0.0.1', done))
    const httpAddress = http.address()
    const tcpAddress = tcp.address()
    if (!httpAddress || typeof httpAddress === 'string' || !tcpAddress || typeof tcpAddress === 'string') throw new Error('Owned listener missing')
    const api = `http://127.0.0.1:${httpAddress.port}`
    const env = {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      NODE_OPTIONS: `--require=${preload}`,
      CENSUS_FILE: file,
      METASHEET_API_URL: api,
      BASE_URL: api,
      METASHEET_TOKEN: 'synthetic-only',
      ATTENDANCE_IMPORT_FILE: file,
      DATABASE_URL: `postgresql://synthetic@127.0.0.1:${tcpAddress.port}/synthetic`,
      PROBE_API: api,
      PROBE_PORT: String(tcpAddress.port),
    }
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string; reads: number | undefined }>((done, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let stdout = ''
      let stderr = ''
      let reads: number | undefined
      child.stdout.on('data', (data) => { stdout += data })
      child.stderr.on('data', (data) => { stderr += data })
      child.on('message', (message) => { reads = (message as { reads: number }).reads })
      child.on('error', reject)
      child.on('close', (code) => done({ code, stdout, stderr, reads }))
    })
    try {
      await writeFile(file, JSON.stringify([{ userId: 'synthetic', eventType: 'check_in', occurredAt: '2026-04-15T09:00:00Z' }]))
      await writeFile(preload, `
const fs = require('node:fs')
const path = require('node:path')
const target = path.resolve(process.env.CENSUS_FILE)
let reads = 0
const count = value => { if (typeof value === 'string' && path.resolve(value) === target) reads += 1 }
for (const key of ['readFileSync', 'readFile', 'openSync', 'open']) {
  const original = fs[key]
  fs[key] = function(value, ...args) { count(value); return original.call(this, value, ...args) }
}
for (const key of ['readFile', 'open']) {
  const original = fs.promises[key]
  fs.promises[key] = function(value, ...args) { count(value); return original.call(this, value, ...args) }
}
require('node:module').syncBuiltinESMExports()
process.channel?.unref()
process.once('beforeExit', () => process.send?.({ reads }))
`)
      const control = await run(['-e', `
require('node:fs').readFileSync(process.env.CENSUS_FILE)
Promise.all([
  fetch(process.env.PROBE_API, { method: 'POST' }),
  new Promise((done, fail) => {
    const socket = require('node:net').connect(Number(process.env.PROBE_PORT), '127.0.0.1', () => socket.end())
    socket.on('error', fail); socket.on('close', done)
  }),
]).catch(() => { process.exitCode = 1 })
`])
      expect(control.code).toBe(0)
      expect(control.reads).toBeGreaterThan(0)
      expect(httpCalls).toBe(1)
      expect(tcpCalls).toBe(1)
      for (const tool of tools) {
        const result = await run([resolve(root, tool), '--file', file, '--api', api, '--token', 'synthetic-only'])
        expect(result).toEqual({ code: 2, stdout: '', stderr: 'ATTENDANCE_LIVE_TIMESTAMP_TOOL_RETIRED\n', reads: 0 })
        expect(httpCalls).toBe(1)
        expect(tcpCalls).toBe(1)
      }
    } finally {
      await Promise.all([
        new Promise<void>((done, reject) => http.close((error) => error ? reject(error) : done())),
        new Promise<void>((done, reject) => tcp.close((error) => error ? reject(error) : done())),
      ])
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
