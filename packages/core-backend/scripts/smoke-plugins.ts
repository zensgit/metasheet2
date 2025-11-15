#!/usr/bin/env tsx
/**
 * Smoke test for plugin communication and storage persistence
 *
 * Preconditions:
 *  - Core backend running (pnpm -F @metasheet/core-backend dev:core)
 *  - DATABASE_URL configured and migrations applied
 *
 * Usage:
 *  API_ORIGIN=http://localhost:8900 tsx scripts/smoke-plugins.ts
 */

const ORIGIN = process.env.API_ORIGIN || 'http://localhost:8900'

async function httpGetJson(url: string): Promise<any> {
  // Prefer global fetch (Node >=18)
  const g: any = globalThis as any
  if (typeof g.fetch === 'function') {
    const res = await g.fetch(url, { method: 'GET' })
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text, status: res.status }
    }
  }

  // Fallback to http/https
  const { request } = await import(url.startsWith('https') ? 'https' : 'http')
  return await new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, (res: any) => {
      const chunks: any[] = []
      res.on('data', (c: any) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve(JSON.parse(text)) } catch { resolve({ raw: text, status: res.statusCode }) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function main() {
  const url = `${ORIGIN}/api/test/plugins/ping`
  process.stdout.write(`GET ${url}\n`)
  try {
    const data = await httpGetJson(url)
    // Expect shape: { ok: true, pong: 'pong', stored: {...} }
    const ok = data && data.ok === true && data.pong === 'pong' && data.stored && typeof data.stored === 'object'
    if (!ok) {
      console.error('Unexpected response:', data)
      process.exit(1)
    }
    console.log('OK:', data)

    // Trigger denial route to validate metrics exposure path
    const denyUrl = `${ORIGIN}/api/test/plugins/deny`
    process.stdout.write(`GET ${denyUrl}\n`)
    const denyResp = await httpGetJson(denyUrl)
    if (!denyResp || denyResp.ok !== false || !denyResp.denied) {
      console.error('Denial route did not behave as expected', denyResp)
      process.exit(1)
    }

    // Fetch metrics in prom format to ensure counter is present (non-fatal if missing)
    try {
      const g: any = globalThis as any
      const res = await g.fetch?.(`${ORIGIN}/metrics/prom`)
      const text = res ? await res.text() : ''
      if (text && text.includes('plugin_permission_denied_total')) {
        console.log('Metrics counter present')
      } else {
        console.warn('Metrics counter not found in /metrics/prom output')
      }
    } catch (e) {
      console.warn('Failed to query /metrics/prom:', e)
    }
    process.exit(0)
  } catch (e) {
    console.error('Request failed:', e)
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
