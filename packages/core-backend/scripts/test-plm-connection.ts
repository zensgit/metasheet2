const baseUrl = (process.env.PLM_BASE_URL || process.env.PLM_URL || 'http://127.0.0.1:7910').replace(/\/+$/, '')
const timeoutMs = Number(process.env.PLM_TIMEOUT_MS || 5000)
const healthPaths = String(process.env.PLM_HEALTH_URLS || '/api/v1/health,/health')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

function withTimeout(signal: AbortSignal | undefined, timeout: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer)
    },
  }
}

async function probe(url: string) {
  const { signal, clear } = withTimeout(undefined, timeoutMs)

  try {
    const response = await fetch(url, { method: 'GET', signal })
    const text = await response.text().catch(() => '')
    return {
      ok: response.ok,
      status: response.status,
      body: text.slice(0, 240),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clear()
  }
}

async function main() {
  const results = []

  for (const path of healthPaths) {
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const result = await probe(url)
    results.push({ path, ...result })

    if (result.ok) {
      console.log(`[plm] OK ${url} -> ${result.status}`)
      if (result.body) {
        console.log(result.body)
      }
      process.exit(0)
    }
  }

  console.error(`[plm] No health endpoint responded successfully for ${baseUrl}`)
  for (const result of results) {
    console.error(`- ${result.path}: ${result.status || 'ERR'} ${result.body}`)
  }
  process.exit(1)
}

main().catch((error) => {
  console.error('[plm] Unexpected failure', error)
  process.exit(1)
})
