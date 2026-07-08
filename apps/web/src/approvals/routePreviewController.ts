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

export interface RoutePreviewController<Req = CreateApprovalRequest> {
  /** Fire a preview request; only its own (still-current) resolution may commit. */
  run(req: Req): Promise<void>
  /** Invalidate any in-flight request and clear the rendered state (call on form edit). */
  invalidate(): void
}

/**
 * RP-3 (B3-06 authoring 试运行面板) reuses this same race-guard for a DIFFERENT request shape
 * (`{ sampleFormData, sampleRequesterId? }` against a template-scoped endpoint, vs RP-2's
 * `{ templateId, formData }` against the requester-scoped one) — the generic `Req` parameter
 * defaults to `CreateApprovalRequest` so RP-2's existing call sites (and this file's own tests)
 * are unaffected; RP-3's caller supplies its own fetcher and Req is inferred from it.
 */
export function createRoutePreviewController<Req = CreateApprovalRequest>(
  fetcher: (req: Req) => Promise<ApprovalRoutePreview>,
  onState: (patch: Partial<RoutePreviewState>) => void,
): RoutePreviewController<Req> {
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
