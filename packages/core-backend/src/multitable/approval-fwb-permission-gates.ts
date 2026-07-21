/**
 * FWB-1 slice ② — the §11 Q6 permission gates (owner-ruled "allow explicit declassification" model).
 *
 * The lock's ruling (#4203 §144): FWB deliberately does NOT try to compute reader-set comparisons ("no
 * amplification" was withdrawn as unprovable). Instead a fixed, enforceable gate set:
 *   G1 configurer authority — the rule's creator/enabler must be admin OR hold canManageSheetAccess on the
 *      TARGET sheet (they are the ones authorized to widen visibility);
 *   G2 source readable — the configurer can read the source template/form;
 *   G3 target writable — the configurer can write the target sheet;
 *   G4 explicit confirmation recorded at save (template + target + mapping), audited by IDENTIFIERS ONLY.
 *
 * EXECUTE-time contract: the gates are RE-CHECKED when the action runs; any gate that no longer holds →
 * **REJECT the action as a PERMANENT failure** (fail-closed — an approval completing must never become a
 * privilege-escalation vehicle for a configurer whose rights were since revoked). Checks are injected so the
 * module is testable and the real ACL wiring is one seam. All-or-nothing; check failures (thrown errors)
 * are NOT treated as passes (fail-closed on error).
 */
export interface FwbGateChecks {
  isAdmin(userId: string): Promise<boolean>
  canManageSheetAccess(userId: string, sheetId: string): Promise<boolean>
  canReadTemplate(userId: string, templateId: string): Promise<boolean>
  canWriteSheet(userId: string, sheetId: string): Promise<boolean>
  canWriteTargetFields(userId: string, ruleId: string, sheetId: string): Promise<boolean>
  /** G4: the saved rule carries a recorded explicit confirmation (identifiers only). */
  hasRecordedConfirmation(ruleId: string): Promise<boolean>
}

export interface FwbGateSubject {
  /** the rule's configurer (creator/last enabler) — the authority the gates bind to. */
  configurerUserId: string
  ruleId: string
  sourceTemplateId: string
  targetSheetId: string
}

export type FwbGateId =
  | 'configurer_authority'
  | 'source_readable'
  | 'target_writable'
  | 'target_fields_writable'
  | 'confirmation_recorded'

export type FwbGateResult = { ok: true } | { ok: false; failed: FwbGateId[] }

/** Run all four gates; collect every failure (values-free gate ids only). Errors count as failures. */
export async function recheckFwbPermissionGates(checks: FwbGateChecks, s: FwbGateSubject): Promise<FwbGateResult> {
  const failed: FwbGateId[] = []
  const safe = async (p: Promise<boolean>): Promise<boolean> => {
    try {
      return await p
    } catch {
      return false // fail-closed: an errored check is a failed check
    }
  }
  const [admin, manage, readSrc, writeTgt, writeFields, confirmed] = await Promise.all([
    safe(checks.isAdmin(s.configurerUserId)),
    safe(checks.canManageSheetAccess(s.configurerUserId, s.targetSheetId)),
    safe(checks.canReadTemplate(s.configurerUserId, s.sourceTemplateId)),
    safe(checks.canWriteSheet(s.configurerUserId, s.targetSheetId)),
    safe(checks.canWriteTargetFields(s.configurerUserId, s.ruleId, s.targetSheetId)),
    safe(checks.hasRecordedConfirmation(s.ruleId)),
  ])
  if (!admin && !manage) failed.push('configurer_authority')
  if (!readSrc) failed.push('source_readable')
  if (!writeTgt) failed.push('target_writable')
  if (!writeFields) failed.push('target_fields_writable')
  if (!confirmed) failed.push('confirmation_recorded')
  return failed.length > 0 ? { ok: false, failed } : { ok: true }
}
