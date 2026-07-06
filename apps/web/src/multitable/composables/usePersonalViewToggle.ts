import { ref } from 'vue'
import type { MultitableApiClient } from '../api/client'
import type { PersonalViewConfigOverlay } from '../types'

/**
 * Slice 3 — per-view "My view / 个人视图" toggle state + write-target routing.
 *
 * Ratified design: docs/development/multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md
 * Parent lock: docs/development/multitable-personal-views-design-lock-20260705.md
 *
 * §1-A (LOAD-BEARING): this composable never attaches a user id to a request — it only decides WHICH
 * endpoint an edit calls (shared `updateView` vs actor-scoped `personal-config`); the server resolves the
 * target user from the JWT actor alone (client.putPersonalViewConfig / deletePersonalViewConfig).
 *
 * §1-E: the personal overlay is applied SERVER-SIDE on `GET /views` already (when the session capability is
 * on and the actor has a personal row) — this composable does not compute any client-side overlay merge.
 * Its job is (i) deciding write-target routing (G-FE-2) and (ii) orchestrating reset-to-shared (G-FE-3):
 * DELETE the actor's own personal row, then let the caller re-fetch so the server returns the now-effective
 * (shared) config.
 *
 * The toggle is per-view, in-memory, session-local UI state — NOT synced from any "does a personal row
 * exist" server signal. Turning it ON routes subsequent in-place config edits (filter/sort/group/hidden/
 * order) to the personal-config endpoint; turning it OFF (or a flag-off session) routes them back to the
 * shared `updateView` path (§3 P2 proposed default). `enabled()` mirrors the session capability
 * (`MetaCapabilities.personalViewsEnabled`, flag-derived, set by `/context` — see §7 Q1) so a flag-off
 * session can never latch a view into personal mode (G-FE-4: byte-identical, inert when off).
 */
export function usePersonalViewToggle(opts: {
  client: Pick<MultitableApiClient, 'putPersonalViewConfig' | 'deletePersonalViewConfig'>
  /** Session capability signal — MUST reflect `MetaCapabilities.personalViewsEnabled`, never a hardcoded const. */
  enabled: () => boolean
}) {
  const personalModeByViewId = ref<Record<string, boolean>>({})

  function isPersonalMode(viewId: string): boolean {
    if (!viewId || !opts.enabled()) return false
    return personalModeByViewId.value[viewId] === true
  }

  function setPersonalMode(viewId: string, on: boolean): void {
    if (!viewId) return
    // Flag-off is inert: never latch personal mode on when the session capability is off (G-FE-4) — even if
    // a caller (e.g. a stale click handler) tries to turn it on after the capability flips off mid-session.
    if (on && !opts.enabled()) return
    if (isPersonalMode(viewId) === on && viewId in personalModeByViewId.value) return
    personalModeByViewId.value = { ...personalModeByViewId.value, [viewId]: on }
  }

  function togglePersonalMode(viewId: string): void {
    setPersonalMode(viewId, !isPersonalMode(viewId))
  }

  /**
   * G-FE-3 — reset to shared: delete the actor's own personal row for this view, drop local personal mode,
   * then run the caller-supplied refetch (e.g. `workbench.loadSheetMeta(sheetId, { viewId })`) so the
   * rendered config becomes whatever the server now resolves — the shared config, since the override row is
   * gone. Never mutates the shared view itself.
   */
  async function resetToShared(viewId: string, refetch: () => Promise<unknown>): Promise<void> {
    if (!viewId) return
    await opts.client.deletePersonalViewConfig(viewId)
    setPersonalMode(viewId, false)
    await refetch()
  }

  /**
   * G-FE-2 — single toggle-driven write-routing switch: every in-place config edit (filter/sort/group/
   * hidden/order) funnels through here instead of branching per call site. ON → PUT personal-config; OFF (or
   * flag-off) → the caller's shared-write path (`updateView`), unchanged from today.
   */
  async function persistViewEdit(
    viewId: string,
    input: PersonalViewConfigOverlay,
    updateShared: (viewId: string, input: PersonalViewConfigOverlay) => Promise<unknown>,
  ): Promise<void> {
    if (isPersonalMode(viewId)) {
      await opts.client.putPersonalViewConfig(viewId, input)
    } else {
      await updateShared(viewId, input)
    }
  }

  return {
    personalModeByViewId,
    isPersonalMode,
    setPersonalMode,
    togglePersonalMode,
    resetToShared,
    persistViewEdit,
  }
}

export type UsePersonalViewToggleReturn = ReturnType<typeof usePersonalViewToggle>
