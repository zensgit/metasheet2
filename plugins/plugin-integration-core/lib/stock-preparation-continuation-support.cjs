'use strict'

// 备料分批拉取第一期 step 3 PR B — THE BUILD MARKER the pilot readiness check `continuation_support_version`
// reads (stock-preparation-pilot-readiness.cjs). It states what THIS plugin build can do with the
// persisted 沿用关系 (continuations) of step 4:
//
//   0  this build has no continuation-aware lane: no governance consult, no planner projection, no
//      whole-pull suspension. A pilot project on such a build would be refreshed by the old planner
//      (ADD a copy, INACTIVE the old rows) — exactly what the pilot exists to prevent — so readiness
//      refuses every enable while this is 0 (step-4 design D-22).
//   1  the build carries EVERY piece D-22 requires before a pilot may be enabled: the governance consult on
//      every lane with the planner projection and whole-pull suspension (step 4 PR-3a / PR-3b, landed), the
//      confirm / end routes (PR-4), the formal-export gate (PR-5), the generic-writer refusal (PR-6), change
//      plans (PR-8) and recovery (step 6). The LAST of those PRs flips this literal to 1, never ahead; PR-3a
//      and PR-3b deliberately leave it 0 (T-layer TD-1).
//
// Deliberately a plain (unfrozen) export read at EVALUATION time: the readiness suite proves the
// positive leg by setting it to 1 in memory for one test and restoring it — no service, config or env
// value can flip it on a deployment. It is not an env flag and must not become one.
module.exports = {
  CONTINUATION_SUPPORT_VERSION: 0,
}
