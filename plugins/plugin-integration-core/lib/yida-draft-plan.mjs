// Persisted draft path entry (draft store, initialization producer, send authority): v2 only.
// The shared compiler lives in yida-draft-compiler.mjs. Its v2+v3 local recompute
// (compileYidaLocalDraft) is deliberately not re-exported here, so nothing that persists,
// approves or sends a draft can reach v3 until an owner approves widening this path.
export { YidaDraftPlanError, compileYidaDraft } from './yida-draft-compiler.mjs'
