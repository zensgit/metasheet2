/**
 * Approval attachment AV scan seam (§6 / G4).
 *
 * v1 ships WITHOUT a real AV engine: `defaultPassThroughScanHook` is a no-op that leaves the row
 * bindable/downloadable. A future ClamAV (or similar) sidecar plugs in via the same `ScanHook`
 * type. `scan_state = 'infected'` is NEVER bindable and NEVER downloadable — enforced at bind
 * and download regardless of which hook wrote the state.
 */
export type AttachmentScanState = 'unscanned' | 'clean' | 'infected'

export interface ScanHookInput {
  mimeType: string
  sizeBytes: number
  /** raw bytes when available — a real AV engine would inspect them; pass-through ignores them. */
  content: Buffer
  fileName: string
}

/**
 * Scan hook contract. Must never throw secrets / filenames into logs (callers map failures to
 * values-free codes). A throw is treated as fail-closed → 'infected' by the upload path so a
 * broken scanner cannot pass malware through as 'clean'.
 */
export type ScanHook = (input: ScanHookInput) => Promise<AttachmentScanState> | AttachmentScanState

/**
 * Default v1 pass-through: no AV engine. Leaves state as `unscanned` so bind/download still allow
 * the file (only `infected` is refused). A real engine returns `clean` or `infected`.
 */
export const defaultPassThroughScanHook: ScanHook = async (): Promise<AttachmentScanState> => 'unscanned'

/** True when the row may be bound into a create-instance snapshot (§4.4 / G4). */
export function isScanStateBindable(state: AttachmentScanState | string | null | undefined): boolean {
  return state !== 'infected'
}

/** True when the row may serve bytes to an authorized viewer. */
export function isScanStateDownloadable(state: AttachmentScanState | string | null | undefined): boolean {
  return state !== 'infected'
}

/**
 * Run the hook; on throw, fail-closed to `infected` so a misbehaving scanner cannot open a pass
 * path. Never rethrows the raw error (values-free boundary).
 */
export async function runScanHook(
  hook: ScanHook,
  input: ScanHookInput,
): Promise<AttachmentScanState> {
  try {
    const result = await hook(input)
    if (result === 'unscanned' || result === 'clean' || result === 'infected') return result
    return 'infected' // unknown return → fail-closed
  } catch {
    return 'infected'
  }
}
