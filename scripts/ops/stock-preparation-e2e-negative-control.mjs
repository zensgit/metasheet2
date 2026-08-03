#!/usr/bin/env node
'use strict'

// Stock-preparation E2E functional smoke — NEGATIVE CONTROL.
//
// This is deliberately a FAILING run. It reuses the SAME startServer/stopServer/getDevToken/
// s6aRunProbe/must functions the main harness (stock-preparation-e2e-functional-smoke.mjs) uses — not a
// re-implementation — and asserts the WRONG expectation on purpose: that the flag-OFF S6-A route
// returns 200 instead of the real 404 STOCK_PREPARATION_SQLSERVER_SEALED_SNAPSHOT_DISABLED. Because the
// route genuinely 404s when the flag is absent, this assertion genuinely fails and the process exits
// non-zero, so the CI job it runs in genuinely goes RED.
//
// Purpose: prove the harness's real assertion machinery (the same `must()` used everywhere else in this
// lane) is load-bearing — a harness that can only ever report PASS proves nothing (repo standing
// instruction: "a check that did not happen is indistinguishable from a check that came back clean").
// This script's own RED conclusion is the deliverable, not a bug to fix.

import { getDevToken, must, s6aRunProbe, startServer, stopServer } from './stock-preparation-e2e-functional-smoke.mjs'

async function main() {
  await startServer({}, 'negative-control')
  try {
    const token = await getDevToken()
    const probe = await s6aRunProbe(token, `negative-control-${Date.now()}`)
    // INTENTIONALLY WRONG expectation — the route is flag-OFF here, so this MUST be false, and this
    // script MUST therefore fail. Do not "fix" this by changing the expectation to 404; that would
    // remove the one deliberately-red arm this lane is required to carry.
    const deliberatelyWrong = probe.status === 200
    must('NEGATIVE CONTROL (expected to fail): flag-OFF S6-A route returns 200', deliberatelyWrong,
      `http=${probe.status} (real behavior is 404 DISABLED; this arm asserts the wrong thing on purpose)`)
  } finally {
    await stopServer()
  }
  process.stdout.write('STOCK_PREPARATION_E2E_NEGATIVE_CONTROL\nexpectedConclusion=RED\n')
  // Always non-zero: this script exists to prove the job can fail, never to pass.
  process.exitCode = 1
}

main().catch(async (error) => {
  process.stderr.write(`[negative-control] fatal: ${error && error.stack ? error.stack : error}\n`)
  await stopServer().catch(() => {})
  process.exitCode = 1
})
