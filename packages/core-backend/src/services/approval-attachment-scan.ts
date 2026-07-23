/**
 * Approval attachments — AV scan seam (#4195 §6, flag-gated).
 *
 * Ratified states only: `unscanned | clean | infected`. No extra lifecycle is invented here.
 *   - `APPROVAL_ATTACHMENT_SCAN_ENABLED` default OFF → pass-through (upload leaves `unscanned`;
 *     bind/download accept anything except `infected`). Byte-level dormant — no hook invocation.
 *   - Flag ON → a REAL injected `scanHook` must run at upload and persist `clean` | `infected`.
 *     There is NO safe default scanner: a missing hook fail-closes to `infected` so unscanned
 *     bytes can never be marked clean. Production boot also refuses to start when the flag is ON
 *     without an injected scanner (see `assertApprovalAttachmentScannerConfigured`).
 * A real AV engine is OUT OF SCOPE for v1; this is the wiring point for a later opt-in.
 */

export type ApprovalAttachmentScanState = 'unscanned' | 'clean' | 'infected'

export interface ApprovalAttachmentScanInput {
  fileName: string
  mimeType: string
  sizeBytes: number
  content: Buffer
}

export type ApprovalAttachmentScanHook = (
  input: ApprovalAttachmentScanInput,
) => ApprovalAttachmentScanState | Promise<ApprovalAttachmentScanState>

/** Values-free fixed message — never includes paths, filenames, credentials, or raw errors. */
export const APPROVAL_ATTACHMENT_SCANNER_MISSING_MESSAGE =
  'Approval attachment scan enabled but no scanner configured'

export function isApprovalAttachmentScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.APPROVAL_ATTACHMENT_SCAN_ENABLED ?? '').trim().toLowerCase() === 'true'
}

/**
 * Startup guard: when the scan flag is ON, a real scanner must be injected.
 * Flag OFF → no-op (scan seam stays dormant). Values-free throw on refusal.
 */
export function assertApprovalAttachmentScannerConfigured(
  env: NodeJS.ProcessEnv = process.env,
  scanHook?: ApprovalAttachmentScanHook | null,
): void {
  if (!isApprovalAttachmentScanEnabled(env)) return
  if (typeof scanHook !== 'function') {
    throw new Error(APPROVAL_ATTACHMENT_SCANNER_MISSING_MESSAGE)
  }
}

/**
 * Run the scan seam. When the flag is OFF, returns `unscanned` without invoking the hook (byte-level
 * no-op). When ON without an injected hook, fail-closes to `infected` (never `clean`). When ON with a
 * hook, invokes it and normalizes the result to the ratified clean|infected pair (any other return or
 * throw is fail-closed to `infected` so a miswired engine cannot pass garbage through).
 */
export async function runApprovalAttachmentScan(
  input: ApprovalAttachmentScanInput,
  opts: {
    env?: NodeJS.ProcessEnv
    scanHook?: ApprovalAttachmentScanHook
  } = {},
): Promise<ApprovalAttachmentScanState> {
  if (!isApprovalAttachmentScanEnabled(opts.env ?? process.env)) return 'unscanned'
  // Fail-closed: no default "clean" path. Unscanned bytes must never be marked clean by omission.
  if (typeof opts.scanHook !== 'function') return 'infected'
  let result: ApprovalAttachmentScanState
  try {
    result = await opts.scanHook(input)
  } catch {
    // Fail-closed: a scanner throw is treated as infected rather than silently accepted.
    return 'infected'
  }
  if (result === 'clean' || result === 'infected') return result
  return 'infected'
}

/** Bind + download refuse only the infected state; unscanned/clean remain acceptable (v1 default). */
export function isInfectedScanState(state: string | null | undefined): boolean {
  return state === 'infected'
}
