// Read-source resolver composition — client vocabulary mirror (C-R4-2, #1709).
//
// The composition chain-evidence coarse codes are the SERVER's closed vocabulary
// (plugins/plugin-integration-core/lib/read-source-composition-planner.cjs
// READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES). They surface in the run route's values-free chain evidence
// (evidence.errorCode + per-step steps[].errorCode) that the C-R4-3 composition UI renders. This module
// mirrors them client-side so the UI can label/branch on a known enum instead of a raw string.
//
// Source of truth = the server. If the server ever extends the vocabulary and this mirror is not synced,
// the client silently drops the new value. The parity tripwire
// (apps/web/tests/composition-vocab-mirror.spec.ts) fails RED the moment the two diverge — sync this
// module (and any C-R4-3 UI/tests) whenever it does. Same discipline as the resolver mirror in
// readSourceConfigs.ts + multitable-resolver-vocab-mirror.spec.ts.

export const COMPOSITION_PLAN_ERROR_CODES = [
  'READ_SOURCE_COMPOSITION_PLAN_INVALID',
  'READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID',
  'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING',
  'READ_SOURCE_COMPOSITION_HANDOFF_TARGET_MISMATCH',
  'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID',
  'READ_SOURCE_COMPOSITION_STEP_FAILED',
  'READ_SOURCE_COMPOSITION_STEP_NOT_RUN',
  'READ_SOURCE_COMPOSITION_STEP_OUTPUT_NOT_SCALAR',
] as const

export type CompositionPlanErrorCode = typeof COMPOSITION_PLAN_ERROR_CODES[number]

const COMPOSITION_PLAN_ERROR_CODE_SET: ReadonlySet<string> = new Set(COMPOSITION_PLAN_ERROR_CODES)

// Narrow a raw evidence errorCode string to the mirrored closed vocabulary; null for an unknown code so a
// caller (the C-R4-3 UI) shows the raw code verbatim rather than mislabeling it as a known one.
export function asCompositionPlanErrorCode(value: unknown): CompositionPlanErrorCode | null {
  return typeof value === 'string' && COMPOSITION_PLAN_ERROR_CODE_SET.has(value)
    ? (value as CompositionPlanErrorCode)
    : null
}
