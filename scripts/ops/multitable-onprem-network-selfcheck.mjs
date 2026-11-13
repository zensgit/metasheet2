import http from 'node:http'
import { randomUUID } from 'node:crypto'

const checks = [
  { label: 'GET', method: 'GET' },
  { label: 'GET-json404', method: 'GET', missing: true },
  { label: 'DELETE', method: 'DELETE' },
  { label: 'POST-json-script', method: 'POST', body: JSON.stringify({ value: '<script>alert(1)</script>' }) },
  { label: 'POST-json-sql', method: 'POST', body: JSON.stringify({ value: "' OR 1=1 --" }) },
]

const counts = { PASS: 0, FAIL: 0, SKIP: 0 }

function report(status, check, requestId, started, httpStatus = 0) {
  counts[status] += 1
  const safeStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : 0
  console.log(`${status} ${check} httpStatus=${safeStatus} time=${new Date().toISOString()} elapsedMs=${Date.now() - started} requestId=${requestId}`)
}

async function probe(origin, token, check) {
  const { method } = check
  const requestId = randomUUID()
  const started = Date.now()
  let httpStatus = 0
  if ((method !== 'GET' || check.missing) && !token) return { status: 'SKIP', requestId, started, httpStatus }
  try {
    const headers = { Accept: 'application/json', 'X-Request-Id': requestId }
    if (token) headers.Authorization = `Bearer ${token}`
    if (method === 'POST') {
      headers['X-HTTP-Method-Override'] = 'DELETE'
      headers['Content-Type'] = 'application/json'
    }
    const path = check.missing ? `/api/__multitable_network_selfcheck_reserved__/${randomUUID()}`
      : method === 'GET' ? '/api/health' : '/api/method-probe'
    const response = await fetch(`${origin}${path}`, {
      method, headers, body: check.body, redirect: 'manual', signal: AbortSignal.timeout(5000),
    })
    httpStatus = response.status
    if (response.status !== (check.missing ? 404 : 200) || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel()
      throw new Error()
    }
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 65536 || chunk.includes(0)) throw new Error()
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const valid = check.missing
      ? body?.error?.code === 'NOT_FOUND'
      : method === 'GET'
      ? body?.ok === true && body?.status === 'ok'
      : body?.ok === true && body?.method === 'DELETE' && body?.overridden === (method === 'POST')
        && (method !== 'POST' || response.headers.get('x-method-overridden') === 'DELETE')
    if (!valid) throw new Error()
    return { status: 'PASS', requestId, started, httpStatus }
  } catch {
    return { status: 'FAIL', requestId, started, httpStatus }
  }
}

async function selftest() {
  const expectedBodies = {
    'POST-json-script': '{"value":"<script>alert(1)</script>"}',
    'POST-json-sql': '{"value":"\' OR 1=1 --"}',
  }
  let scenario = 'json'
  let expectedCheck
  let receivedExact = false
  let receivedCount = 0
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    receivedCount += 1
    receivedExact = request.method === expectedCheck.method
      && (expectedCheck.missing
        ? /^\/api\/__multitable_network_selfcheck_reserved__\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.url)
        : request.url === (expectedCheck.method === 'GET' ? '/api/health' : '/api/method-probe'))
      && request.headers.authorization === 'Bearer synthetic'
      && request.headers.accept === 'application/json'
      && /^[0-9a-f-]{36}$/.test(request.headers['x-request-id'] || '')
      && Buffer.concat(chunks).toString('utf8') === (expectedBodies[expectedCheck.label] ?? '')
      && (expectedCheck.method !== 'POST' || (
        request.headers['content-type'] === 'application/json'
        && request.headers['x-http-method-override'] === 'DELETE'
      ))
    if (scenario === 'reset') return request.socket.destroy()
    if (scenario === 'html') {
      response.setHeader('Content-Type', 'text/html')
      return response.end('<html>synthetic</html>')
    }
    response.setHeader('Content-Type', 'application/json')
    if (scenario === '401') {
      response.statusCode = 401
      return response.end('{"error":{"code":"UNAUTHENTICATED"}}')
    }
    if (scenario === 'nul') return response.end('{"ok":true}\u0000')
    if (scenario === '404') {
      response.statusCode = 404
      return response.end('{"error":"NOT_FOUND"}')
    }
    if (expectedCheck.missing) {
      response.statusCode = 404
      return response.end('{"error":{"code":"NOT_FOUND"}}')
    }
    const overridden = request.headers['x-http-method-override'] === 'DELETE'
    if (overridden) response.setHeader('X-Method-Overridden', 'DELETE')
    response.end(JSON.stringify(request.url === '/api/health'
      ? { ok: true, status: 'ok' }
      : { ok: true, method: 'DELETE', overridden }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let failed = false
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    for (scenario of ['json', 'html', 'nul', 'reset', '404', '401']) {
      for (const check of checks) {
        expectedCheck = check
        receivedExact = false
        const result = await probe(origin, 'synthetic', check)
        const expectedStatus = scenario === 'reset' ? 0 : scenario === '401' ? 401
          : scenario === '404' || (scenario === 'json' && check.missing) ? 404 : 200
        const passed = receivedExact && result.httpStatus === expectedStatus
          && result.status === (scenario === 'json' ? 'PASS' : 'FAIL')
        report(passed ? 'PASS' : 'FAIL', `selftest-${scenario}-${check.label}`, result.requestId, result.started, result.httpStatus)
        failed ||= !passed
      }
    }
    for (const check of checks.filter((item) => item.method !== 'GET' || item.missing)) {
      const countBefore = receivedCount
      const result = await probe(origin, '', check)
      const passed = result.status === 'SKIP' && result.httpStatus === 0 && receivedCount === countBefore
      report(passed ? 'PASS' : 'FAIL', `selftest-no-token-${check.label}`, result.requestId, result.started, result.httpStatus)
      failed ||= !passed
    }
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  return failed ? 1 : 0
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--selftest') return selftest()
  if (process.argv.length !== 2) throw new Error()
  const origin = new URL(process.env.MULTITABLE_NETWORK_ORIGIN || '')
  const token = process.env.MULTITABLE_NETWORK_TOKEN || ''
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || /[\r\n\x00]/.test(token)) throw new Error()
  let failed = false
  for (const check of checks) {
    const result = await probe(origin.origin, token, check)
    report(result.status, check.label, result.requestId, result.started, result.httpStatus)
    failed ||= result.status === 'FAIL'
  }
  return failed ? 1 : 0
}

try {
  process.exitCode = await main()
} catch {
  report('FAIL', 'configuration-or-runtime', randomUUID(), Date.now())
  process.exitCode = 1
}
console.log('HINT Privately correlate time and request ID with authorized application and gateway logs; a failed probe may reflect the application baseline.')
console.log('HINT Request customer-security approval for narrow route/method/content policy review; do not disable blanket WAF rules, bypass encoding, or change business data.')
console.log(`SUMMARY PASS=${counts.PASS} FAIL=${counts.FAIL} SKIP=${counts.SKIP}`)
