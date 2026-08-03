#!/usr/bin/env node
'use strict'

// Stock-preparation E2E functional smoke — NEGATIVE CONTROL.
//
// This is deliberately a FAILING run. It reuses the SAME startServer/stopServer/getDevToken/
// s6aRunProbe/must functions the main harness (stock-preparation-e2e-functional-smoke.mjs) uses — not a
// re-implementation — and asserts the WRONG expectation on purpose: that the flag-OFF S6-A route
// returns 200 instead of the real 404 (the route is not registered at all when the flag is off — see the
// block comment above runFlagArm() in stock-preparation-e2e-functional-smoke.mjs; it is a generic
// unmatched-route 404, not the STOCK_PREPARATION_SQLSERVER_SEALED_SNAPSHOT_DISABLED JSON error. That
// branch is unreachable when the flag is off — the route is only registered when the runtime is truthy
// (http-routes.cjs ~5003-5006), while the DISABLED branch fires when it is falsy — but it is NOT
// unreachable dead code in general: the same branch also fires when `typeof runtime.run !== 'function'`,
// which route registration does not check, so it stays reachable for a truthy-but-malformed runtime. This
// arm just never constructs that runtime shape). Because the route genuinely 404s when the flag is
// absent, this assertion genuinely fails, `must()` genuinely records it as a failed check, and the exit
// code below is derived from that CHECKS entry — never hardcoded — so the CI job it runs in genuinely
// goes RED.
//
// Purpose: prove the harness's real assertion machinery (the same `must()` used everywhere else in this
// lane, AND the same CHECKS-derived exit-code formula the main harness uses) is load-bearing — a harness
// that can only ever report PASS proves nothing (repo standing instruction: "a check that did not happen
// is indistinguishable from a check that came back clean"). This script's own RED conclusion is the
// deliverable, not a bug to fix. Concretely: swap in a neutered `must()` that always records `ok: true`
// regardless of its `ok` argument, and this script's exit code must flip to 0 — if it does not, the exit
// code is not actually derived from the assertion and this lane proves nothing.
//
// Attribution matters: a RED job here could ALSO mean the harness crashed before reaching the
// assertion, or (worst case) that the S6-A gate is actually broken and returned 200 for real. Those are
// bugs, not the deliverable. The `negativeControlRedBecause` field distinguishes them so a RED
// conclusion is never read as proof-of-concept by itself.

import { CHECKS, getDevToken, must, s6aRunProbe, startServer, stopServer } from './stock-preparation-e2e-functional-smoke.mjs'

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
  // Derived from CHECKS the SAME way the main harness derives its own exit code
  // (stock-preparation-e2e-functional-smoke.mjs main(): `anyFail = CHECKS.some((c) => !c.ok)`) — NOT
  // hardcoded. This is load-bearing, not cosmetic: a neutered `must()` that always records `ok: true`
  // makes `anyFail` false here too, so the exit code flips to 0. In the intended real run the single
  // `must()` call above is designed to fail (the flag-OFF route genuinely 404s, so `deliberatelyWrong` is
  // false), so `anyFail` is expected to be true and this exits non-zero — but that RED conclusion is now
  // earned by the assertion actually failing, not asserted unconditionally regardless of it.
  const anyFail = CHECKS.some((c) => !c.ok)
  process.exitCode = anyFail ? 1 : 0
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
