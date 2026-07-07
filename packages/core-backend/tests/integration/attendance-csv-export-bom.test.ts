import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'

// CSV download BOM — backend liveness lock (import-section-ux lock §6 addendum,
// review #3776 P2-2): the template.csv endpoint has a direct-link consumer
// (csvTemplateUrl in the template payload), so the BOM must be present in the
// RAW response bytes. Response.text()-style decodes strip the BOM, so this
// test collects raw Buffers.

function requestRaw(url: string, headers: Record<string, string>): Promise<{ status: number; bytes: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      { method: 'GET', hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          bytes: Buffer.concat(chunks),
          contentType: String(res.headers['content-type'] ?? ''),
        }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function requestJson(url: string): Promise<{ status: number; body?: unknown }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      { method: 'GET', hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}` },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          let body: unknown
          try { body = data ? JSON.parse(data) : undefined } catch { body = undefined }
          resolve({ status: res.statusCode || 0, body })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('attendance CSV export BOM (real server, raw bytes)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let token = ''

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('csv-export-bom integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=bom-admin&roles=admin&perms=${encodeURIComponent('attendance:import,attendance:admin')}`)
    token = (res.body as { token?: string } | undefined)?.token ?? ''
  })

  afterAll(async () => {
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) await (server as unknown as { stop: () => Promise<void> }).stop()
  })

  it('template.csv raw bytes start with EF BB BF (Excel BOM)', async () => {
    const res = await requestRaw(`${baseUrl}/api/attendance/import/template.csv`, { Authorization: `Bearer ${token}` })
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/csv')
    expect([res.bytes[0], res.bytes[1], res.bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
    expect(res.bytes.length).toBeGreaterThan(10)
  })

  it('template?format=csv variant carries the BOM too', async () => {
    const res = await requestRaw(`${baseUrl}/api/attendance/import/template?format=csv`, { Authorization: `Bearer ${token}` })
    expect(res.status).toBe(200)
    expect([res.bytes[0], res.bytes[1], res.bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
  })
})
