'use strict'

// 备料分批拉取第一期 step 3 PR B — THE BUILD MARKER the pilot readiness check `continuation_support_version`
// reads (stock-preparation-pilot-readiness.cjs). It states what THIS plugin build can do with the
// persisted 沿用关系 (continuations) of step 4:
//
//   0  this build has no continuation-aware lane: no governance consult, no planner projection, no
//      whole-pull suspension. A pilot project on such a build would be refreshed by the old planner
//      (ADD a copy, INACTIVE the old rows) — exactly what the pilot exists to prevent — so readiness
//      refuses every enable while this is 0 (step-4 design D-22).
//   1  every lane consults governance before its source read and the planner applies the continuation
//      projection (step 4 PR-3). THAT PR flips this literal to 1 together with its lanes, never ahead.
//
// Deliberately a plain (unfrozen) export read at EVALUATION time: the readiness suite proves the
// positive leg by setting it to 1 in memory for one test and restoring it — no service, config or env
// value can flip it on a deployment. It is not an env flag and must not become one.
module.exports = {
  CONTINUATION_SUPPORT_VERSION: 0,
}
