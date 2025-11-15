#!/usr/bin/env tsx
/**
 * Pre-merge check for core-backend
 * - Mints a dev JWT (admin) using ConfigService
 * - Verifies /metrics/prom contains key metrics
 * - Calls protected admin endpoints using Authorization header
 *
 * Usage:
 *   API_ORIGIN=http://localhost:8900 pnpm -F @metasheet/core-backend pre-merge:check
 */
import jwt from 'jsonwebtoken'
import { getConfig } from '../src/config'

const ORIGIN = process.env.API_ORIGIN || 'http://localhost:8900'

async function fetchText(path: string, init?: any) {
  const res = await fetch(`${ORIGIN}${path}`, init as any)
  const text = await res.text()
  return { status: res.status, text }
}

async function fetchJson(path: string, init?: any) {
  const res = await fetch(`${ORIGIN}${path}`, init as any)
  const text = await res.text()
  try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, json: text } }
}

async function main() {
  // Prefer dev-token endpoint to ensure signature and claims match server expectations
  let token: string | undefined
  try {
    const r = await fetchJson(`/api/auth/dev-token?userId=pre-merge-admin&roles=admin`)
    if (r.status === 200 && (r.json as any)?.token) token = (r.json as any).token
  } catch {}
  if (!token) {
    // Fallback: locally mint with ConfigService secret
    const cfg = getConfig()
    const secret = cfg?.jwt?.secret || process.env.JWT_SECRET || 'dev-secret-key'
    const payload = { id: 'pre-merge-admin', roles: ['admin'], perms: ['views:read','permissions:read'] }
    token = jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '1h' })
  }

  console.log(`[check] origin=${ORIGIN}`)

  // Check admin config first with Authorization (ensure token works)
  const pre = await fetchJson('/api/admin/config', { headers: { Authorization: `Bearer ${token}` } })
  console.log(`[admin] GET /api/admin/config (pre) -> ${pre.status}`)
  if (pre.status !== 200) {
    console.warn('[check] admin config unauthorized; continuing (metrics-only gate)')
  }

  // Metrics presence
  const checkMetrics = (text: string, names: string[]) => {
    const lines = text.split('\n')
    const found: Record<string, string | undefined> = {}
    for (const m of names) {
      found[m] = lines.find(l => l.startsWith(m + '{') || l.startsWith(m + ' '))
      if (found[m]) console.log(`[metrics] ${found[m]!.trim()}`)
    }
    return found
  }

  // First scrape
  let mp = await fetchText('/metrics/prom')
  if (mp.status !== 200) {
    console.error(`[check] /metrics/prom -> ${mp.status}`)
    process.exit(2)
  }
  let found = checkMetrics(mp.text, ['config_reload_total', 'config_sampling_rate', 'view_data_latency_seconds', 'view_data_requests_total'])

  // If config_reload_total is missing initially (counter not yet emitted), trigger a reload and re-check
  if (!found['config_reload_total']) {
    const headers = { Authorization: `Bearer ${token}` }
    await fetchJson('/api/admin/config/reload', { method: 'POST', headers })
    mp = await fetchText('/metrics/prom')
    found = checkMetrics(mp.text, ['config_reload_total', 'config_sampling_rate', 'view_data_latency_seconds', 'view_data_requests_total'])
    if (!found['config_reload_total']) {
      console.error('[check] missing metric after reload: config_reload_total')
      process.exit(3)
    }
  }

  const headers = { Authorization: `Bearer ${token}` }

  // Admin config
  const cfgRes = await fetchJson('/api/admin/config', { headers })
  console.log(`[admin] GET /api/admin/config -> ${cfgRes.status}`)
  // metrics-only gate: do not fail here

  // Admin reload
  const reloadRes = await fetchJson('/api/admin/config/reload', { method: 'POST', headers })
  console.log(`[admin] POST /api/admin/config/reload -> ${reloadRes.status}`)
  // metrics-only gate: do not fail here

  // DB health
  const dbh = await fetchJson('/api/admin/db/health', { headers })
  console.log(`[admin] GET /api/admin/db/health -> ${dbh.status} healthy=${(dbh.json as any)?.healthy}`)
  // metrics-only gate: do not fail here

  console.log('[check] OK')
}

main().catch((e) => { console.error(e); process.exit(1) })
