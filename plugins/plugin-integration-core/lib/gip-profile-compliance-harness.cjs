'use strict'

// GIP-D0 profile compliance harness — a LATENT contract (not wired to any runtime).
//
// RATIFY SCOPE (owner 2026-07-23, GIP-D0 @ d58ec38f4): item (2) of the three unlocked
// pieces — the certification battery every CertifiedReadActionProfile candidate must
// pass BEFORE its own (still-gated) certification door can even be considered. The
// harness itself certifies nothing: it returns a values-free battery report. Running
// it green is NECESSARY, never SUFFICIENT — each concrete profile still passes its
// own independent gate.
//
// Battery shape (scale-D0 §8 instantiated at the schema level): every check is a
// MUTANT probe — the harness derives an illegal variant from the candidate and
// asserts the frozen schema REJECTS it (fail-closed). A schema that accepts any
// mutant fails the battery. This is the "guard must be load-bearing" discipline
// executed mechanically, per candidate, in CI-runnable form.

const {
  GipProfileContractError,
  normalizeCertifiedReadActionProfile,
  deriveRecoveryStrategy,
  validateConsistencyEvidence,
  validateCompletenessEvidence,
  GIP_RECOVERY_STRATEGIES,
} = require('./gip-profile-certification-contracts.cjs')

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// A check passes when the mutated candidate is REJECTED with the expected frozen
// reason. Accepting the mutant — or rejecting it with an undeclared/unexpected
// reason — fails the check. Values-free: the report carries check ids, ok flags and
// reason codes only, never candidate content.
function expectRejection(checkId, expectedReasons, run) {
  try {
    run()
    return { checkId, ok: false, observed: 'accepted_mutant' }
  } catch (error) {
    if (error instanceof GipProfileContractError && expectedReasons.includes(error.reason)) {
      return { checkId, ok: true, observed: error.reason }
    }
    return {
      checkId,
      ok: false,
      observed: error instanceof GipProfileContractError ? error.reason : 'non_contract_error',
    }
  }
}

// Run the schema-level compliance battery for ONE candidate read-action profile.
// Returns { passed, checks[] } — values-free, deterministic, hermetic.
function runReadActionProfileComplianceBattery(candidate) {
  const checks = []

  // C1 — the candidate itself must normalize cleanly (schema-valid baseline).
  let normalized = null
  try {
    normalized = normalizeCertifiedReadActionProfile(candidate)
    checks.push({ checkId: 'C1_schema_valid', ok: true, observed: 'normalized' })
  } catch (error) {
    checks.push({
      checkId: 'C1_schema_valid',
      ok: false,
      observed: error instanceof GipProfileContractError ? error.reason : 'non_contract_error',
    })
    // Without a valid baseline no mutant probe is meaningful — report and stop.
    return Object.freeze({ passed: false, checks: Object.freeze(checks) })
  }

  const base = clone(candidate)

  // C2 — unknown acquisition mode must be rejected (closed vocabulary).
  {
    const mutant = clone(base)
    mutant.certificate.acquisitionMode = 'TELEPATHIC_READ'
    checks.push(expectRejection('C2_unknown_acquisition_rejected', ['ACQUISITION_MODE_INVALID'],
      () => normalizeCertifiedReadActionProfile(mutant)))
  }

  // C2b — duplicate entries in a closed set must be rejected (set semantics, not bag).
  {
    const mutant = clone(base)
    mutant.certificate.supportedCompletenessProofs = [...mutant.certificate.supportedCompletenessProofs]
    mutant.certificate.supportedCompletenessProofs.push(mutant.certificate.supportedCompletenessProofs[0])
    checks.push(expectRejection('C2b_duplicate_set_entry_rejected', ['COMPLETENESS_PROOFS_INVALID'],
      () => normalizeCertifiedReadActionProfile(mutant)))
  }

  // C3 — empty supportedCompletenessProofs must be rejected (successful-run invariant).
  {
    const mutant = clone(base)
    mutant.certificate.supportedCompletenessProofs = []
    checks.push(expectRejection('C3_empty_completeness_rejected', ['COMPLETENESS_PROOFS_EMPTY'],
      () => normalizeCertifiedReadActionProfile(mutant)))
  }

  // C4 — applyMode smuggled into a READ certificate must be rejected (P2 axis split).
  {
    const mutant = clone(base)
    mutant.certificate.applyMode = 'SYNCHRONOUS_UOW'
    checks.push(expectRejection('C4_applymode_smuggle_rejected', ['APPLY_MODE_FORBIDDEN_ON_READ_PROFILE'],
      () => normalizeCertifiedReadActionProfile(mutant)))
  }

  // C5 — a declared recovery strategy must be rejected (recovery is DERIVED).
  {
    const mutant = clone(base)
    mutant.certificate.recoveryStrategy = 'PAGE_RESUME'
    checks.push(expectRejection('C5_recovery_declaration_rejected', ['RECOVERY_DECLARATION_FORBIDDEN'],
      () => normalizeCertifiedReadActionProfile(mutant)))
  }

  // C6 — SEALED_EXPORT without SIGNED_MANIFEST must be rejected.
  {
    const mutant = clone(base)
    mutant.certificate.acquisitionMode = 'SEALED_EXPORT'
    mutant.certificate.supportedCompletenessProofs = ['SHORT_PAGE']
    delete mutant.certificate.completenessCombinationRules
    checks.push(expectRejection('C6_sealed_export_without_manifest_rejected', ['ILLEGAL_CAPABILITY_COMBINATION'],
      () => normalizeCertifiedReadActionProfile(mutant)))
  }

  // C7 — CHANGE_FEED without MONOTONIC_VERSION_PIN must be rejected.
  {
    const mutant = clone(base)
    mutant.certificate.acquisitionMode = 'CHANGE_FEED'
    mutant.certificate.supportedConsistencyProofs = []
    checks.push(expectRejection('C7_change_feed_without_pin_rejected', ['ILLEGAL_CAPABILITY_COMBINATION'],
      () => normalizeCertifiedReadActionProfile(mutant)))
  }

  // C8 — DURABLE_TOKEN without IMMUTABLE_SNAPSHOT_TOKEN must be rejected.
  {
    const mutant = clone(base)
    mutant.certificate.acquisitionMode = 'PAGED_READ'
    mutant.certificate.continuationLifetime = 'DURABLE_TOKEN'
    mutant.certificate.supportedConsistencyProofs = ['SOURCE_SNAPSHOT_TXN']
    checks.push(expectRejection('C8_durable_token_without_immutable_rejected', ['ILLEGAL_CAPABILITY_COMBINATION'],
      () => normalizeCertifiedReadActionProfile(mutant)))
  }

  // C9 — BOUNDED_READ with a non-SINGLE_REQUEST lifetime must be rejected.
  {
    const mutant = clone(base)
    mutant.certificate.acquisitionMode = 'BOUNDED_READ'
    mutant.certificate.continuationLifetime = 'CONNECTION_BOUND'
    checks.push(expectRejection('C9_bounded_read_lifetime_rejected', ['ILLEGAL_CAPABILITY_COMBINATION'],
      () => normalizeCertifiedReadActionProfile(mutant)))
  }

  // C10 — recovery derivation must land inside the frozen strategy vocabulary and be
  //        stable (same certificate ⇒ same strategy; derived, deterministic).
  {
    const first = deriveRecoveryStrategy(normalized.certificate)
    const second = deriveRecoveryStrategy(normalized.certificate)
    const ok = GIP_RECOVERY_STRATEGIES.includes(first) && first === second
    checks.push({ checkId: 'C10_recovery_derived_stable', ok, observed: ok ? first : 'unstable_or_unknown' })
  }

  // C11 — evidence-shape validators must be load-bearing against this certificate.
  {
    checks.push(expectRejection('C11a_required_empty_proofclasses_rejected', ['CONSISTENCY_EVIDENCE_INVALID'],
      () => validateConsistencyEvidence(normalized, {
        consistencyRequirementStatus: 'REQUIRED',
        proofClasses: [],
      })))
    checks.push(expectRejection('C11b_notrequired_nonempty_rejected', ['CONSISTENCY_EVIDENCE_INVALID'],
      () => validateConsistencyEvidence(normalized, {
        consistencyRequirementStatus: 'NOT_REQUIRED',
        proofClasses: ['SOURCE_SNAPSHOT_TXN'],
      })))
    checks.push(expectRejection('C11c_successful_empty_used_rejected', ['COMPLETENESS_EVIDENCE_INVALID'],
      () => validateCompletenessEvidence(normalized, {
        runOutcome: 'successful',
        usedCompletenessProofs: [],
      })))
    // A successful run claiming a proof the certificate does not support: pick a
    // proof outside the supported set (there is always one unless all three are
    // supported AND every combination is declared — then use an undeclared combo).
    const supported = normalized.certificate.supportedCompletenessProofs
    const outside = ['SHORT_PAGE', 'DECLARED_TOTAL', 'SIGNED_MANIFEST'].find((p) => !supported.includes(p))
    if (outside) {
      checks.push(expectRejection('C11d_unsupported_used_rejected', ['COMPLETENESS_EVIDENCE_INVALID'],
        () => validateCompletenessEvidence(normalized, {
          runOutcome: 'successful',
          usedCompletenessProofs: [outside],
        })))
    } else {
      const undeclaredCombo = ['SHORT_PAGE', 'DECLARED_TOTAL', 'SIGNED_MANIFEST']
      const declared = normalized.certificate.completenessCombinationRules.some(
        (combo) => [...combo].sort().join('+') === [...undeclaredCombo].sort().join('+'),
      )
      checks.push(declared
        ? { checkId: 'C11d_unsupported_used_rejected', ok: true, observed: 'not_applicable_all_combos_declared' }
        : expectRejection('C11d_unsupported_used_rejected', ['COMPLETENESS_EVIDENCE_INVALID'],
          () => validateCompletenessEvidence(normalized, {
            runOutcome: 'successful',
            usedCompletenessProofs: undeclaredCombo,
          })))
    }
  }

  // C11e — the combination-declared invariant must be load-bearing for TYPICAL
  //         candidates too (review: C11d's out-of-support pick let the combination
  //         check be deleted silently). Build an UNDECLARED combination from within
  //         the supported set when possible.
  {
    const supported = normalized.certificate.supportedCompletenessProofs
    const declaredKeys = new Set(
      normalized.certificate.completenessCombinationRules.map((combo) => [...combo].sort().join('+')),
    )
    let undeclared = null
    if (supported.length >= 2) {
      for (let i = 0; i < supported.length && !undeclared; i += 1) {
        for (let j = i + 1; j < supported.length && !undeclared; j += 1) {
          const pair = [supported[i], supported[j]]
          if (!declaredKeys.has([...pair].sort().join('+'))) undeclared = pair
        }
      }
    }
    checks.push(undeclared === null
      ? { checkId: 'C11e_undeclared_combination_rejected', ok: true, observed: 'not_applicable_no_undeclared_pair' }
      : expectRejection('C11e_undeclared_combination_rejected', ['COMPLETENESS_EVIDENCE_INVALID'],
        () => validateCompletenessEvidence(normalized, {
          runOutcome: 'successful',
          usedCompletenessProofs: undeclared,
        })))
  }

  const passed = checks.every((entry) => entry.ok === true)
  return Object.freeze({ passed, checks: Object.freeze(checks) })
}

// Values-free projection helper for evidence surfaces: ids + booleans + reason codes.
function summarizeBatteryForEvidence(report) {
  if (!isPlainObject(report) || !Array.isArray(report.checks)) {
    return { passed: false, checkCount: 0, failedCheckIds: ['REPORT_INVALID'] }
  }
  return {
    passed: report.passed === true,
    checkCount: report.checks.length,
    failedCheckIds: report.checks.filter((entry) => entry.ok !== true).map((entry) => entry.checkId),
  }
}

module.exports = {
  runReadActionProfileComplianceBattery,
  summarizeBatteryForEvidence,
  __internals: { expectRejection },
}
