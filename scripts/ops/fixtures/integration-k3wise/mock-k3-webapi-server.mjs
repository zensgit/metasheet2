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

export function createMockK3WebApiServer({ logger = () => {}, knownBadFNumbers = new Set(['BAD']) } = {}) {
  const calls = []

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => resolve(data ? JSON.parse(data) : null))
      req.on('error', reject)
    })
  }

  function jsonResponse(res, status, payload) {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Set-Cookie', 'K3SESSION=mock-cookie-1; Path=/; HttpOnly')
    res.end(JSON.stringify(payload))
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
    calls.push({ method: req.method, pathname, body })
    logger({ method: req.method, pathname, body })

    if (pathname === '/K3API/Login') {
      jsonResponse(res, 200, { success: true, sessionId: 'mock-session-1' })
      return
    }
    if (pathname === '/K3API/Health') {
      jsonResponse(res, 200, { ok: true })
      return
    }
    if (pathname === '/K3API/Material/Save') {
      const fNumber = body?.Model?.FNumber
      if (knownBadFNumbers.has(fNumber)) {
        jsonResponse(res, 200, { success: false, message: `mock K3 rejects ${fNumber}: invalid material code` })
        return
      }
      jsonResponse(res, 200, { success: true, externalId: `mock-${fNumber}`, billNo: fNumber })
      return
    }
    if (pathname === '/K3API/Material/Submit') {
      jsonResponse(res, 200, { success: true, submitted: body?.Number })
      return
    }
    if (pathname === '/K3API/Material/Audit') {
      jsonResponse(res, 200, { success: true, audited: body?.Number })
      return
    }
    if (pathname === '/K3API/BOM/Save') {
      const fNumber = body?.Model?.FNumber
      if (knownBadFNumbers.has(fNumber)) {
        jsonResponse(res, 200, { success: false, message: `mock K3 BOM rejects ${fNumber}` })
        return
      }
      jsonResponse(res, 200, { success: true, externalId: `mock-bom-${fNumber}`, billNo: fNumber })
      return
    }
    if (pathname === '/K3API/BOM/Submit') {
      jsonResponse(res, 200, { success: true, submitted: body?.Number })
      return
    }
    if (pathname === '/K3API/BOM/Audit') {
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
