#!/usr/bin/env node
// Standalone runner for the mock K3 WISE WebAPI server — the far end of the STAGING WINDOW
// REHEARSAL (owner authorization 2026-08-05: 「授权 staging 部署」, ephemeral-CI substrate per
// the reserved discretion). Seeds the LIST catalogue with a bounded synthetic source set; the
// Save/GetDetail store starts EMPTY so the rehearsal's dry-run classifies every source row as
// `add` deterministically. VALUES-FREE stdout: the base URL line and counts only.
//
// Env: MOCK_K3_PORT (optional; default ephemeral). Prints `MOCK_K3_BASE_URL=<url>` when ready.
//
// Owner review (2026-08-05, points E/F): the mock now (a) REQUIRES the session the real
// K3WiseWebApiAdapter obtains via Login on every other endpoint — a rehearsal that dropped the
// auth wiring now fails loudly instead of rehearsing "clean" against a permissive mock — and
// (b) logs every call as a single `K3CALL <METHOD> <pathname>` stdout line (values-free: no
// body), captured into mock-k3.log by the workflow. Point E is a direct fix for an owner-observed
// bug: the workflow's "Save-only invariant seen from the WIRE" step greps mock-k3.log for
// Submit/Audit — but nothing was ever written to that stream, so an absence check against it
// passed vacuously regardless of what actually happened on the wire. See rehearsal-harness.test.mjs.

import { createMockK3WebApiServer } from './mock-k3-webapi-server.mjs'

const seedListRows = [
  { FItemID: 61001, FNumber: 'MAT-RH-001', FName: 'Rehearsal material A', FModel: 'SPEC-RH-A', FUnitID: 'PCS' },
  { FItemID: 61002, FNumber: 'MAT-RH-002', FName: 'Rehearsal material B', FModel: 'SPEC-RH-B', FUnitID: 'PCS' },
]

const server = createMockK3WebApiServer({
  seedListRows,
  requireSession: true,
  // Values-free: method + path only, never the (sanitized-but-still-present) body.
  logger: (call) => { console.log(`K3CALL ${call.method} ${call.pathname}`) },
})
const port = Number(process.env.MOCK_K3_PORT) > 0 ? Number(process.env.MOCK_K3_PORT) : 0
const baseUrl = await server.start(port)
console.log(`MOCK_K3_BASE_URL=${baseUrl}`)
console.log(`seedListRows=${seedListRows.length}`)

process.on('SIGTERM', async () => { await server.stop?.(); process.exit(0) })
process.on('SIGINT', async () => { await server.stop?.(); process.exit(0) })
