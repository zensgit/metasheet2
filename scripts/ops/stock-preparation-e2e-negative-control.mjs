#!/usr/bin/env node
'use strict'

// Stock-preparation E2E functional smoke — NEGATIVE CONTROL.
//
// This is deliberately a FAILING run. It reuses the SAME startServer/stopServer/getDevToken/
// s6aRunProbe/must functions the main harness (stock-preparation-e2e-functional-smoke.mjs) uses — not a
// re-implementation — and asserts the WRONG expectation on purpose: that the flag-OFF S6-A route
// returns 200 instead of the real 404 (the route is not registered at all when the flag is off — see the
// block comment above runFlagArm() in stock-preparation-e2e-functional-smoke.mjs; it is a generic
// unmatched-route 404, not the STOCK_PREPARATION_SQLSERVER_SEALED_SNAPSHOT_DISABLED JSON error, which is
// unreachable dead code under current wiring). Because the route genuinely 404s when the flag is absent,
// this assertion genuinely fails and the process exits non-zero, so the CI job it runs in genuinely goes
// RED.
//
// Purpose: prove the harness's real assertion machinery (the same `must()` used everywhere else in this
// lane) is load-bearing — a harness that can only ever report PASS proves nothing (repo standing
// instruction: "a check that did not happen is indistinguishable from a check that came back clean").
// This script's own RED conclusion is the deliverable, not a bug to fix.
//
// Attribution matters: a RED job here could ALSO mean the harness crashed before reaching the
// assertion, or (worst case) that the S6-A gate is actually broken and returned 200 for real. Those are
// bugs, not the deliverable. The `negativeControlRedBecause` field distinguishes them so a RED
// conclusion is never read as proof-of-concept by itself.

import { getDevToken, must, s6aRunProbe, startServer, stopServer } from './stock-preparation-e2e-functional-smoke.mjs'

async function main() {
  const result = { probeHttp: -1, reachedAssertion: false, redBecause: 'HARNESS_ERROR' }
  await startServer({}, 'negative-control')
  try {
    const token = await getDevToken()
    const probe = await s6aRunProbe(token, `negative-control-${Date.now()}`)
    result.probeHttp = probe.status
    result.reachedAssertion = true
    // INTENTIONALLY WRONG expectation — the route is flag-OFF here, so this MUST be false, and this
    // script MUST therefore fail. Do not "fix" this by changing the expectation to 404; that would
    // remove the one deliberately-red arm this lane is required to carry.
    const deliberatelyWrong = probe.status === 200
    must('NEGATIVE CONTROL (expected to fail): flag-OFF S6-A route returns 200', deliberatelyWrong,
      `http=${probe.status} (real behavior is 404, route not registered; this arm asserts the wrong thing on purpose)`)
    // If the probe genuinely came back 200, the S6-A gate is broken for real — that is NOT the intended
    // negative-control signal, it is a live product bug, and must be reported as such, not folded into
    // "the harness can fail" story.
    result.redBecause = probe.status === 200 ? 'GATE_BROKEN_PROBE_RETURNED_200' : 'ASSERTION_FAILED_AS_INTENDED'
  } finally {
    await stopServer()
  }
  process.stdout.write('STOCK_PREPARATION_E2E_NEGATIVE_CONTROL\n')
  process.stdout.write(`negativeControlProbeHttp=${result.probeHttp}\n`)
  process.stdout.write(`negativeControlReachedAssertion=${result.reachedAssertion}\n`)
  process.stdout.write(`negativeControlRedBecause=${result.redBecause}\n`)
  process.stdout.write('expectedConclusion=RED\n')
  // Always non-zero: this script exists to prove the job can fail, never to pass.
  process.exitCode = 1
}

main().catch(async (error) => {
  process.stderr.write(`[negative-control] fatal: ${error && error.stack ? error.stack : error}\n`)
  process.stdout.write('STOCK_PREPARATION_E2E_NEGATIVE_CONTROL\n')
  process.stdout.write('negativeControlProbeHttp=-1\n')
  process.stdout.write('negativeControlReachedAssertion=false\n')
  process.stdout.write('negativeControlRedBecause=HARNESS_ERROR\n')
  process.stdout.write('expectedConclusion=RED\n')
  await stopServer().catch(() => {})
  process.exitCode = 1
})
