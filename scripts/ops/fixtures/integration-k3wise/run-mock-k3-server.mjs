#!/usr/bin/env node
// Standalone runner for the mock K3 WISE WebAPI server — the far end of the STAGING WINDOW
// REHEARSAL (owner authorization 2026-08-05: 「授权 staging 部署」, ephemeral-CI substrate per
// the reserved discretion). Seeds the LIST catalogue with a bounded synthetic source set; the
// Save/GetDetail store starts EMPTY so the rehearsal's dry-run classifies every source row as
// `add` deterministically. VALUES-FREE stdout: the base URL line and counts only.
//
// Env: MOCK_K3_PORT (optional; default ephemeral). Prints `MOCK_K3_BASE_URL=<url>` when ready.

import { createMockK3WebApiServer } from './mock-k3-webapi-server.mjs'

const seedListRows = [
  { FItemID: 61001, FNumber: 'MAT-RH-001', FName: 'Rehearsal material A', FModel: 'SPEC-RH-A', FUnitID: 'PCS' },
  { FItemID: 61002, FNumber: 'MAT-RH-002', FName: 'Rehearsal material B', FModel: 'SPEC-RH-B', FUnitID: 'PCS' },
]

const server = createMockK3WebApiServer({ seedListRows })
const port = Number(process.env.MOCK_K3_PORT) > 0 ? Number(process.env.MOCK_K3_PORT) : 0
const baseUrl = await server.start(port)
console.log(`MOCK_K3_BASE_URL=${baseUrl}`)
console.log(`seedListRows=${seedListRows.length}`)

process.on('SIGTERM', async () => { await server.stop?.(); process.exit(0) })
process.on('SIGINT', async () => { await server.stop?.(); process.exit(0) })
