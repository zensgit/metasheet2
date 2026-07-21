/**
 * Approval attachments — AV scan seam (#4195 §6, flag-gated default no-op).
 *
 * Ratified states only: `unscanned | clean | infected`. No extra lifecycle is invented here.
 *   - `APPROVAL_ATTACHMENT_SCAN_ENABLED` default OFF → pass-through (upload leaves `unscanned`;
 *     bind/download accept anything except `infected`).
 *   - Flag ON → `scanHook` runs at upload and persists `clean` | `infected`.
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

export function isApprovalAttachmentScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.APPROVAL_ATTACHMENT_SCAN_ENABLED ?? '').trim().toLowerCase() === 'true'
}

/**
 * Default no-op pass-through: always `clean`. Replaced only when a real engine is wired behind the
 * flag; the flag alone does not invent malware detection.
 */
export const defaultApprovalAttachmentScanHook: ApprovalAttachmentScanHook = async (): Promise<'clean'> => 'clean'

/**
 * Run the scan seam. When the flag is OFF, returns `unscanned` without invoking the hook (byte-level
 * no-op). When ON, invokes the hook and normalizes the result to the ratified clean|infected pair
 * (any other return is fail-closed to `infected` so a miswired engine cannot pass garbage through).
 */
export async function runApprovalAttachmentScan(
  input: ApprovalAttachmentScanInput,
  opts: {
    env?: NodeJS.ProcessEnv
    scanHook?: ApprovalAttachmentScanHook
  } = {},
): Promise<ApprovalAttachmentScanState> {
  if (!isApprovalAttachmentScanEnabled(opts.env ?? process.env)) return 'unscanned'
  const hook = opts.scanHook ?? defaultApprovalAttachmentScanHook
  let result: ApprovalAttachmentScanState
  try {
    result = await hook(input)
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
