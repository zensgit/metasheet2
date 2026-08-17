import type { UnifiedApprovalDTO } from '../types/approval'

/**
 * UI-7 (approval-parity-master-design-lock-20260817.md §4 UI-7) — race-guard for the approval
 * center's desktop master-detail pane.
 *
 * Mirrors `routePreviewController.ts`'s generation-counter idiom (RP-2/RP-3): the pane stays open
 * while a selection's detail fetch is in flight, and the operator can reselect a different row (or
 * close the pane) before that fetch settles. A monotonic generation counter enforces that only the
 * STILL-CURRENT selection's response may commit — `select()` and `clear()` both bump it, and a
 * resolved (or rejected) fetch commits its state only if its generation is still current. Extracted
 * as a pure module (no Vue import) so the race semantics are unit-testable without a mount, exactly
 * like `approval-route-preview-controller.test.ts` tests its sibling.
 *
 * Deliberately calls the api-layer `getApproval` directly rather than `store.loadDetail` — the
 * store's `loading`/`error`/`activeApproval` are shared, single-instance state that
 * `ApprovalCenterTable`'s own `v-loading` and other views already bind to; routing the pane's fetch
 * through the store would flash the list's loading spinner on every row selection and clobber
 * `ApprovalDetailView`'s `activeApproval` out from under it. This controller owns its own state.
 */
export interface DetailPaneState {
  approval: UnifiedApprovalDTO | null
  loading: boolean
  error: string
}

export interface DetailPaneController {
  /** Fire a detail fetch for `id`; only its own (still-current) resolution may commit. */
  select(id: string): Promise<void>
  /** Invalidate any in-flight fetch and clear the rendered state (call on close/deselect). */
  clear(): void
}

export function createDetailPaneController(
  fetcher: (id: string) => Promise<UnifiedApprovalDTO>,
  onState: (patch: Partial<DetailPaneState>) => void,
): DetailPaneController {
  let gen = 0
  return {
    clear() {
      gen++
      onState({ approval: null, error: '', loading: false })
    },
    async select(id: string) {
      const g = ++gen
      onState({ approval: null, loading: true, error: '' })
      try {
        const result = await fetcher(id)
        if (g !== gen) return
        onState({ approval: result, loading: false })
      } catch (error) {
        if (g !== gen) return
        onState({ approval: null, error: error instanceof Error ? error.message : '加载详情失败', loading: false })
      }
    },
  }
}
