import type { ApprovalRoutePreview } from './api'
import type { CreateApprovalRequest } from '../types/approval'

/**
 * RP-2 (B3-05) — race-guard for the发起页 live route preview.
 *
 * The form stays editable while a preview request is in flight. The honesty contract
 * (design-lock: "any later form edit clears the result so a stale path never misleads") only
 * holds if an edit — or a re-click — during the await INVALIDATES the outstanding response.
 * A monotonic generation counter enforces this: `run()` and `invalidate()` both bump it, and a
 * resolved (or rejected) response commits its state only if its generation is still current.
 * Extracted from the component so the ordering semantics are unit-testable without a mount.
 */
export interface RoutePreviewState {
  preview: ApprovalRoutePreview | null
  loading: boolean
  error: string
}

export interface RoutePreviewController {
  /** Fire a preview request; only its own (still-current) resolution may commit. */
  run(req: CreateApprovalRequest): Promise<void>
  /** Invalidate any in-flight request and clear the rendered state (call on form edit). */
  invalidate(): void
}

export function createRoutePreviewController(
  fetcher: (req: CreateApprovalRequest) => Promise<ApprovalRoutePreview>,
  onState: (patch: Partial<RoutePreviewState>) => void,
): RoutePreviewController {
  let gen = 0
  return {
    invalidate() {
      gen++
      onState({ preview: null, error: '', loading: false })
    },
    async run(req: CreateApprovalRequest) {
      const g = ++gen
      onState({ loading: true, error: '' })
      try {
        const result = await fetcher(req)
        if (g !== gen) return
        onState({ preview: result, loading: false })
      } catch (error) {
        if (g !== gen) return
        onState({ preview: null, error: error instanceof Error ? error.message : '路径预览失败', loading: false })
      }
    },
  }
}
