/**
 * Attendance Windows-native QA v2 — machine-evidence contract.
 *
 * Draft/HOLD. Synthetic data only. Pinned product SOURCE_SHA 0dc3596dd (unchanged by QA tooling).
 *
 * Shared by the harnesses that PRODUCE machine evidence (see qa-runtime.buildMachineEvidence) and by
 * the runner that VALIDATES it for a PASS. Kept as a tiny, dependency-free module so the standalone
 * runner can import it without pulling in `pg`/product code.
 *
 * WHY THIS EXISTS (owner P1). The runner used to accept a PASS on the LENGTH of a free-text
 * reason/evidence string alone — ten long meaningless strings + residue=0 forged a 10/10 PASS. A JSON
 * file is always copyable, so nothing here makes evidence perfectly unforgeable. What it DOES do is
 * raise the bar from "any long string an operator can hand-type" to "a STRUCTURED record a harness
 * emits": a typed envelope carrying machine facts (asserted row counts, entity UUIDs), the harness's
 * OWN determination, the producing harness module, and the QA tooling SHA the harness ran as. The
 * runner requires this shape for PASS and binds the tooling SHA to the package QA_TOOLING_SHA. The
 * ACCURATE property is therefore: "PASS requires a structured, tooling-SHA-bound machine-evidence
 * record produced by a harness" — NOT "forgery-proof".
 */
export const MACHINE_EVIDENCE_SCHEMA = 'windows-qa/machine-evidence@1'
export const MACHINE_EVIDENCE_PRODUCER = 'windows-qa-harness'

const SHA40 = /^[0-9a-f]{40}$/

/**
 * Validate the STRUCTURED machine-evidence envelope required for a PASS case. Returns
 * `{ ok: true }` or `{ ok: false, error }`. When `expectedQaToolingSha` is supplied, the envelope's
 * `qaToolingSha` must equal it — the package<->evidence tooling binding (owner P2).
 */
export function validateMachineEvidence(machineEvidence, { expectedQaToolingSha } = {}) {
  const me = machineEvidence
  if (!me || typeof me !== 'object' || Array.isArray(me)) {
    return {
      ok: false,
      error:
        'PASS requires a structured machineEvidence object produced by a harness (a long free-text ' +
        'reason/evidence string is no longer accepted as proof of a PASS).',
    }
  }
  if (me.schema !== MACHINE_EVIDENCE_SCHEMA) {
    return { ok: false, error: `machineEvidence.schema must be "${MACHINE_EVIDENCE_SCHEMA}"; got: ${me.schema ?? 'undefined'}.` }
  }
  if (me.producedBy !== MACHINE_EVIDENCE_PRODUCER) {
    return {
      ok: false,
      error: `machineEvidence.producedBy must be "${MACHINE_EVIDENCE_PRODUCER}" (a harness-emitted record); got: ${me.producedBy ?? 'undefined'}.`,
    }
  }
  if (typeof me.harnessModule !== 'string' || me.harnessModule.trim() === '') {
    return { ok: false, error: 'machineEvidence.harnessModule must name the producing harness module.' }
  }
  if (me.determination !== 'PASS') {
    return {
      ok: false,
      error: `machineEvidence.determination must be "PASS" for a PASS case (the harness's own verdict); got: ${me.determination ?? 'undefined'}.`,
    }
  }
  if (typeof me.qaToolingSha !== 'string' || !SHA40.test(me.qaToolingSha)) {
    return { ok: false, error: 'machineEvidence.qaToolingSha must be a 40-char lowercase git SHA.' }
  }
  if (expectedQaToolingSha && me.qaToolingSha !== expectedQaToolingSha) {
    return {
      ok: false,
      error: `machineEvidence.qaToolingSha ${me.qaToolingSha} does not match the package QA_TOOLING_SHA ${expectedQaToolingSha}.`,
    }
  }
  if (!me.facts || typeof me.facts !== 'object' || Array.isArray(me.facts) || Object.keys(me.facts).length === 0) {
    return {
      ok: false,
      error: 'machineEvidence.facts must be a non-empty object of machine facts (asserted row counts / entity UUIDs).',
    }
  }
  return { ok: true }
}
