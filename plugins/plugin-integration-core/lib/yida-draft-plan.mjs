// Persisted draft path entries. compileYidaDraft (v2 only) is what initialization and target
// registration use (R-71 ⑦.3 decision E1). compileYidaSendDraft (v2 or v3) is what the draft
// store, the send authority and the owner send port use (R-71 ⑦.3). The shared compiler lives in
// yida-draft-compiler.mjs; its never-persisted local recompute (compileYidaLocalDraft) is
// deliberately not re-exported here.
// yidaDraftPlanErrorKind is the compiler's own WeakMap reader of its fixed error kinds (slice YE: the send authority
// tells the four deterministic SOURCE_* refusals apart from every other compile failure through it).
export { YidaDraftPlanError, compileYidaDraft, compileYidaSendDraft, yidaDraftPlanErrorKind } from './yida-draft-compiler.mjs'
