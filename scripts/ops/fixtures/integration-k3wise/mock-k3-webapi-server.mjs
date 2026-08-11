#!/usr/bin/env node
// Minimal in-process mock for K3 WISE WebAPI. NOT a full K3 simulator.
// Mirrors the contract the K3WiseWebApiAdapter expects:
//   POST /K3API/Login       → { success, sessionId }
//   GET  /K3API/Health      → 200
//   POST /K3API/Material/Save   → { success, externalId, billNo } | { success: false, message }
//   POST /K3API/Material/Submit → { success, submitted: <FNumber> }
//   POST /K3API/Material/Audit  → { success, audited: <FNumber> }
//   POST /K3API/BOM/{Save,Submit,Audit} mirrors Material with FNumber from BOM record
//
// Used by run-mock-poc-demo.mjs. Not exposed as a CLI server because customers
// must point at their real K3 WISE — there is no production use for this file.

import { createServer } from 'node:http'

const REDACTED_VALUE = '<redacted>'
const SENSITIVE_BODY_KEY_PATTERN = new RegExp([
  'password',
  'secret',
  'token',
  'session',
  'credential',
  'api[-_]?key',
  'authorization',
  'acctid',
  'account[-_]?id',
].join('|'), 'i')

function sanitizeMockBody(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMockBody(item))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      SENSITIVE_BODY_KEY_PATTERN.test(key) ? REDACTED_VALUE : sanitizeMockBody(nestedValue),
    ]),
  )
}

// Owner review (2026-08-05, staging-window-rehearsal point F): the mock previously accepted
// every call with no session check at all — a driver bug that dropped the auth header would
// still rehearse "clean". These are the SAME literal values the mock has always issued (Login's
// sessionId + the Set-Cookie value below); factored out so the requireSession gate checks
// against the exact values the mock itself hands out, not a re-typed copy that could drift.
const MOCK_SESSION_ID = 'mock-session-1'
const MOCK_SESSION_COOKIE_NAME = 'K3SESSION'
const MOCK_SESSION_COOKIE_VALUE = 'mock-cookie-1'
const MOCK_SESSION_HEADER = 'x-k3-session'

export function createMockK3WebApiServer({
  logger = () => {},
  seedListRows: seedListRowsOption = [],
  knownBadFNumbers = new Set(['BAD']),
  // Envelope-200-but-row-level-fail: K3 returns StatusCode 200 / "Successful" yet the
  // row did not save. Lets the live PoC demo exercise the M1 row-level diagnostic path
  // offline. Default empty → no behavior change for existing callers.
  rowFailFNumbers = new Set(),
  includeSessionCookie = true,
  includeSessionId = true,
  // F: default OFF so every existing caller (mock-k3-webapi-server.test.mjs, run-mock-poc-demo.mjs,
  // and any other fixture that never authenticates against this specific mock instance) is
  // unaffected. The staging-window-rehearsal runner turns this ON — the real K3WiseWebApiAdapter
  // always logs in first and carries the session header/cookie on every subsequent call, so an
  // honest rehearsal client sees no behavior change; a client that DROPPED the auth wiring would.
  requireSession = false,
} = {}) {
  const calls = []
  const savedMaterials = new Map()
  // Rehearsal support: rows the LIST read serves as the "source catalogue". Deliberately
  // SEPARATE from savedMaterials (Save/GetDetail's store) so a rehearsal's dry-run classifies
  // seeded source rows as `add` deterministically (GetDetail miss), then finds them via
  // GetDetail only AFTER the Save actually wrote them.
  const seedListRows = Array.isArray(seedListRowsOption) ? seedListRowsOption.map((r) => ({ ...r })) : []

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => resolve(data ? JSON.parse(data) : null))
      req.on('error', reject)
    })
  }

  function jsonResponse(res, status, payload, { setCookie = includeSessionCookie } = {}) {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    if (setCookie) res.setHeader('Set-Cookie', `${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_COOKIE_VALUE}; Path=/; HttpOnly`)
    res.end(JSON.stringify(payload))
  }

  // F: everything except /K3API/Login must carry the session the mock itself issued — either the
  // X-K3-Session header (what the real adapter sends when Login returns a sessionId) or the
  // equivalent cookie (what it sends when Login returns only a Set-Cookie). A substring check on
  // the incoming Cookie header because the real adapter forwards the ENTIRE raw Set-Cookie value
  // (including `; Path=/; HttpOnly`) back as its request Cookie header — not a re-parsed pair.
  function hasValidSession(req) {
    const headerValue = req.headers[MOCK_SESSION_HEADER]
    if (typeof headerValue === 'string' && headerValue === MOCK_SESSION_ID) return true
    const cookieHeader = req.headers.cookie
    if (typeof cookieHeader === 'string' && cookieHeader.includes(`${MOCK_SESSION_COOKIE_NAME}=${MOCK_SESSION_COOKIE_VALUE}`)) return true
    return false
  }

  function requireMethod(req, res, expectedMethod) {
    if (req.method === expectedMethod) return true
    res.statusCode = 405
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Allow', expectedMethod)
    res.end(JSON.stringify({
      success: false,
      message: `mock K3 method not allowed: ${req.method} ${req.url}`,
      expectedMethod,
    }))
    return false
  }

  const server = createServer(async (req, res) => {
    let body = null
    try {
      body = req.method === 'POST' ? await readBody(req) : null
    } catch (error) {
      jsonResponse(res, 400, { success: false, message: `mock K3 invalid JSON: ${error.message}` })
      return
    }
    const url = new URL(req.url, `http://${req.headers.host || 'mock-k3'}`)
    const pathname = url.pathname
    const safeCall = { method: req.method, pathname, body: sanitizeMockBody(body) }
    calls.push(safeCall)
    logger(safeCall)

    // F: the gate runs AFTER the call is logged (rejected calls stay visible for debugging, same
    // as the existing method-not-allowed path) and BEFORE any routing — Login is the one path
    // exempt (it is how a session is obtained in the first place).
    if (requireSession && pathname !== '/K3API/Login' && !hasValidSession(req)) {
      jsonResponse(res, 401, { success: false, message: 'session required' }, { setCookie: false })
      return
    }

    if (pathname === '/K3API/Login') {
      if (!requireMethod(req, res, 'POST')) return
      jsonResponse(res, 200, {
        success: true,
        ...(includeSessionId ? { sessionId: MOCK_SESSION_ID } : {}),
      })
      return
    }
    if (pathname === '/K3API/Health') {
      if (!requireMethod(req, res, 'GET')) return
      jsonResponse(res, 200, { ok: true })
      return
    }
    if (pathname === '/K3API/Material/Save') {
      if (!requireMethod(req, res, 'POST')) return
      const fNumber = (body?.Model || body?.Data)?.FNumber
      if (knownBadFNumbers.has(fNumber)) {
        jsonResponse(res, 200, { success: false, message: `mock K3 rejects ${fNumber}: invalid material code` })
        return
      }
      if (rowFailFNumbers.has(fNumber)) {
        jsonResponse(res, 200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: false, FItemID: 0, FMessage: `mock K3 row-level fail for ${fNumber}: required base-data object missing` }],
        })
        return
      }
      // Full-chain support: remember the saved material so GetDetail can serve the
      // post-save READ-BACK (the ruled chain's last link). Stateless before this, the mock
      // could prove Save happened but never that the write is READABLE afterwards.
      savedMaterials.set(fNumber, { ...(body?.Model || body?.Data), FItemID: savedMaterials.get(fNumber)?.FItemID ?? 9000 + savedMaterials.size + 1 })
      jsonResponse(res, 200, { success: true, externalId: `mock-${fNumber}`, billNo: fNumber })
      return
    }
    if (pathname === '/K3API/Material/GetList') {
      if (!requireMethod(req, res, 'POST')) return
      const data = body?.Data || {}
      const top = Number(data.Top) > 0 ? Number(data.Top) : 10
      const pageIndex = Number(data.PageIndex) > 0 ? Number(data.PageIndex) : 1
      const fields = typeof data.Fields === 'string' && data.Fields.trim()
        ? data.Fields.split(',').map((f) => f.trim())
        : null
      const start = (pageIndex - 1) * top
      const page = seedListRows.slice(start, start + top).map((row) => {
        if (!fields) return { ...row }
        return Object.fromEntries(fields.filter((f) => f in row).map((f) => [f, row[f]]))
      })
      jsonResponse(res, 200, {
        StatusCode: 200,
        Message: 'Successful',
        Data: { ROWCOUNT: seedListRows.length, PAGESIZE: top, PAGEINDEX: pageIndex, DATA: page },
      })
      return
    }
    if (pathname === '/K3API/Material/GetDetail') {
      if (!requireMethod(req, res, 'POST')) return
      const number = body?.Data?.FNumber ?? body?.Data?.Number
      const stored = savedMaterials.get(number)
      if (stored) {
        jsonResponse(res, 200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: true, FItemID: stored.FItemID, Data: { ...stored, FNumber: number } }],
        })
        return
      }
      // K3's real "not found" is a BUSINESS-level failure, not a 404 — same shape the
      // C6 lookup maps to "absent" and the read-back negative control asserts on.
      jsonResponse(res, 200, {
        StatusCode: 200,
        Message: 'Successful',
        Data: [{ FStatus: false, FItemID: 0, FMessage: `mock K3 row-level fail for ${number}: required base-data object missing` }],
      })
      return
    }
    if (pathname === '/K3API/Material/Submit') {
      if (!requireMethod(req, res, 'POST')) return
      jsonResponse(res, 200, { success: true, submitted: body?.Number })
      return
    }
    if (pathname === '/K3API/Material/Audit') {
      if (!requireMethod(req, res, 'POST')) return
      jsonResponse(res, 200, { success: true, audited: body?.Number })
      return
    }
    if (pathname === '/K3API/BOM/Save') {
      if (!requireMethod(req, res, 'POST')) return
      const fNumber = (body?.Model || body?.Data)?.FNumber
      if (knownBadFNumbers.has(fNumber)) {
        jsonResponse(res, 200, { success: false, message: `mock K3 BOM rejects ${fNumber}` })
        return
      }
      jsonResponse(res, 200, { success: true, externalId: `mock-bom-${fNumber}`, billNo: fNumber })
      return
    }
    if (pathname === '/K3API/BOM/Submit') {
      if (!requireMethod(req, res, 'POST')) return
      jsonResponse(res, 200, { success: true, submitted: body?.Number })
      return
    }
    if (pathname === '/K3API/BOM/Audit') {
      if (!requireMethod(req, res, 'POST')) return
      jsonResponse(res, 200, { success: true, audited: body?.Number })
      return
    }

    jsonResponse(res, 404, { success: false, message: `mock K3 unknown path: ${pathname}` })
  })

  return {
    server,
    calls,
    async start(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
      const address = server.address()
      return `http://127.0.0.1:${address.port}`
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
