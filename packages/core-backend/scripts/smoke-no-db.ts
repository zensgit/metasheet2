import axios from 'axios'

const ORIGIN = process.env.API_ORIGIN || 'http://127.0.0.1:8900'

async function main() {
  const out: Record<string, any> = {}

  const get = async (path: string, headers?: Record<string, string>) => {
    try {
      const res = await axios.get(ORIGIN + path, { headers, validateStatus: () => true, timeout: 3000 })
      return { status: res.status, body: res.data }
    } catch (e: any) {
      return { error: e?.message || String(e) }
    }
  }

  // Open endpoints
  out.health = await get('/health')
  out.metrics = await get('/metrics')
  out.metricsProm = await get('/metrics/prom')
  out.metricsConfig = await get('/metrics/config')
  out.permsHealth = await get('/api/permissions/health')

  // Dev token minting
  const dev = await get('/api/auth/dev-token')
  out.devToken = dev
  const token = (dev && dev.body && (dev.body.token as string)) || ''
  const auth = token ? { Authorization: `Bearer ${token}` } : undefined

  // Protected endpoints
  out.pluginsNoAuth = await get('/api/plugins')
  out.pluginsAuth = await get('/api/plugins', auth)
  out.adminDb = await get('/api/admin/db/health', auth)
  out.adminKv = await get('/api/admin/plugin-kv?plugin=demo', auth)
  out.viewConfig404 = await get('/api/views/abc/config', auth)

  // Prefer safe config if available
  const cfgSafe = await get('/api/admin/config/safe', auth)
  out.adminConfigSafe = cfgSafe
  if (!cfgSafe || cfgSafe.status !== 200) {
    out.adminConfig = await get('/api/admin/config', auth)
  }

  console.log(JSON.stringify(out, null, 2))

  // Assertions
  const failures: string[] = []
  const expect = (name: string, cond: boolean) => { if (!cond) failures.push(name) }
  expect('health==200', out.health?.status === 200)
  expect('metrics==200', out.metrics?.status === 200)
  expect('devToken==200', out.devToken?.status === 200)
  expect('permsHealth==200', out.permsHealth?.status === 200)
  expect('metricsConfig in {200,503}', [200,503].includes(out.metricsConfig?.status))
  expect('pluginsNoAuth==401', out.pluginsNoAuth?.status === 401)
  expect('pluginsAuth==200', out.pluginsAuth?.status === 200)
  expect('adminDb==503', out.adminDb?.status === 503)
  expect('adminKv==503', out.adminKv?.status === 503)
  expect('viewConfig404==404', out.viewConfig404?.status === 404)
  const cfgOk = (out.adminConfigSafe && [200, 401, 404, 500].includes(out.adminConfigSafe.status)) ||
                (out.adminConfig && [200, 401, 404, 500].includes(out.adminConfig.status))
  expect('config in {200,401,404,500}', !!cfgOk)

  if (failures.length) {
    console.error('SMOKE_NO_DB_FAILED', { failures })
    process.exit(1)
  }
  console.log('SMOKE_NO_DB_PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
