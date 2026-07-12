// mount-behind-flow — shared mock-client mount harness for multitable "behind-flow" manager
// components (UI-P2-1c T4, docs/development/multitable-ui-p2-1c-tail-resolution-designlock-20260707.md
// §2-T4, RATIFIED by owner directive 2026-07-11).
//
// "Behind-flow" managers — TrashModal, MetaFormShareManager, MetaRecordPermissionManager,
// MetaSheetPermissionManager, MetaCommentsDrawer, MetaImportModal, MetaAiBulkFillDialog,
// MetaConfigHistoryModal, ... — render their generic action buttons only AFTER an API-driven load.
// A plain `createApp().mount()` shows a loading/empty state, not the buttons a migration spec needs
// to click. Several existing manager specs already hand-roll the same three pieces to get past that
// load (a DOM mount helper, a microtask-flush loop, and a `MultitableApiClient` wired to a stub
// `fetchFn` — see `apps/web/tests/multitable-form-share-manager.spec.ts`); this module factors those
// three pieces out into one reusable, typed helper so a `*-migration.spec.ts` doesn't need to
// re-derive the plumbing per component.
//
// Two mock-injection shapes exist, matching how a given manager actually gets its data:
//   (a) `client` PROP managers (MetaFormShareManager, MetaRecordPermissionManager,
//       MetaSheetPermissionManager, ...) — build a `MultitableApiClient` via
//       `createRoutedApiClient()` and pass it through the component's own `client` prop.
//   (b) SINGLETON composable managers (TrashModal → `useTrash()`, which falls back to the shared
//       `multitableClient` export when no client argument is given at all — there is no prop to
//       inject through) — `patchMultitableClient()` monkey-patches specific methods on that shared
//       singleton for the test's duration and returns a `restore()`.
//
// Scope discipline (T4 red line, design-lock §2-T4): this harness is a stub for the NETWORK
// boundary only, so a mount test can reach the phase where a manager's presentational controls
// exist in the DOM. It has no opinion on, and must never be used to alter, permission/deletion/
// AI-approval business logic — every route/override a spec configures is caller-supplied test data,
// nothing here embeds or bypasses real authorization behavior.
import { vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'
import { MultitableApiClient, multitableClient } from '../../src/multitable/api/client'

// ---------------------------------------------------------------------------------------------
// DOM mount + cleanup
// ---------------------------------------------------------------------------------------------

/** A tracked DOM mount, returned by {@link mountBehindFlow}. */
export interface BehindFlowMount {
  app: VueApp
  container: HTMLDivElement
  /** Unmounts the app and removes its container from `document.body`. Idempotent. */
  unmount: () => void
}

const liveMounts = new Set<BehindFlowMount>()

/**
 * Mounts `component` with `props` into a real `document.body` div via `createApp` + `h()` — never
 * a shallow mount — matching the established convention across this repo's `*-migration.spec.ts`
 * files, so `@click`/emit assertions exercise real DOM events and real Vue reactivity, not a mock
 * render tree.
 *
 * The mount is tracked so a single {@link cleanupBehindFlowMounts} call can tear down everything a
 * test created, mirroring the `mounts` array + `afterEach` pattern already duplicated in every
 * existing migration spec (e.g. `meta-linked-record-popover-migration.spec.ts`).
 */
export function mountBehindFlow(component: Component, props: Record<string, unknown> = {}): BehindFlowMount {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(component, props) })
  app.mount(container)
  const entry: BehindFlowMount = {
    app,
    container,
    unmount: () => {
      if (!liveMounts.has(entry)) return
      app.unmount()
      container.remove()
      liveMounts.delete(entry)
    },
  }
  liveMounts.add(entry)
  return entry
}

/**
 * Tears down every mount created via {@link mountBehindFlow} that hasn't already been unmounted
 * individually. Call this from the spec file's own `afterEach` — the harness does not register any
 * global vitest hooks itself, so it composes cleanly with whatever else a spec's `afterEach` needs
 * to do (e.g. resetting the locale, calling {@link patchMultitableClient}'s `restore()`).
 */
export function cleanupBehindFlowMounts(): void {
  for (const entry of [...liveMounts]) entry.unmount()
}

// ---------------------------------------------------------------------------------------------
// Async-load flush
// ---------------------------------------------------------------------------------------------

/**
 * Flushes pending microtasks + a macrotask tick + a Vue `nextTick` for `ticks` rounds (default 5)
 * — enough for a manager's `watch(() => props.visible, async () => { await client.xxx() })` load
 * chain to settle before assertions run. Same shape as the ad hoc `flushPromises` already
 * duplicated in several manager specs; factored out so a spec doesn't need to re-justify "why 5
 * ticks" on its own.
 */
export async function flushBehindFlow(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

// ---------------------------------------------------------------------------------------------
// (a) client-PROP managers — a real MultitableApiClient wired to a stub fetchFn
// ---------------------------------------------------------------------------------------------

/**
 * A request router for {@link createRoutedApiClient}: given the HTTP method + URL (+ raw
 * `RequestInit`) of a request the client under test issued, return the response BODY (the
 * client's real `{ data: ... }` envelope is added automatically by the harness — callers return
 * just the unwrapped payload, same shape `MultitableApiClient`'s own methods resolve to). Return
 * `undefined` to fall through to `opts.defaultResponse`. Throw an `Error` to simulate a network-
 * level failure (the real client's `parseJson` error path handles that identically to a non-2xx
 * response, so a manager's existing `catch (err) { error.value = err.message }` code runs as-is).
 */
export type ApiRouter = (method: string, url: string, init?: RequestInit) => unknown

/**
 * Builds a REAL `MultitableApiClient` (not a hand-rolled partial-object mock) wired to a stub
 * `fetchFn` that dispatches every call through `router`. Using the real client class means any
 * manager that takes a `client: MultitableApiClient` prop gets a fully contract-accurate mock —
 * every method not touched by `router` still exists and behaves like the real client would for an
 * unmatched route (default 200 `{}, unless `opts.defaultResponse` is set) — instead of a partial
 * object cast through `as unknown as MultitableApiClient`, which silently drifts from the real
 * class's shape as new methods are added.
 *
 * This is the exact technique `multitable-form-share-manager.spec.ts` already uses ad hoc (a
 * `MultitableApiClient` constructed with a stub `fetchFn`); factored out here so other `client`-
 * prop managers (MetaRecordPermissionManager, MetaSheetPermissionManager, ...) can reuse it too.
 *
 * Returns `fetchFn` as well (a `vi.fn`) so a spec can assert on which requests actually fired —
 * the same `fetchFn.mock.calls.filter(...)` convention already used in that spec file.
 */
export function createRoutedApiClient(
  router: ApiRouter,
  opts: { defaultResponse?: unknown } = {},
): { client: MultitableApiClient; fetchFn: ReturnType<typeof vi.fn> } {
  const defaultResponse = opts.defaultResponse ?? {}
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = router(method, url, init) ?? defaultResponse
    return new Response(JSON.stringify({ data: body }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return { client: new MultitableApiClient({ fetchFn }), fetchFn }
}

// ---------------------------------------------------------------------------------------------
// (b) SINGLETON composable managers — monkey-patch the shared multitableClient instance
// ---------------------------------------------------------------------------------------------

/**
 * For SINGLETON composable managers — e.g. TrashModal, whose `useTrash()` call takes no `client`
 * argument at all and falls back to the shared `multitableClient` export
 * (`useTrash.ts`: `const api = client ?? multitableClient`). There is no prop to inject a mock
 * through, so this monkey-patches the given methods directly on the LIVE singleton instance for
 * the duration of a test.
 *
 * Returns `restore()`, which MUST be called (e.g. from the spec's own `afterEach`, alongside
 * {@link cleanupBehindFlowMounts}) so a mock never leaks into a later spec file that imports the
 * same singleton module (vitest does not reset module-level singletons between files by default
 * within a worker).
 */
export function patchMultitableClient<K extends keyof MultitableApiClient>(
  overrides: Partial<Record<K, MultitableApiClient[K]>>,
): { restore: () => void } {
  const originals = new Map<K, MultitableApiClient[K]>()
  for (const key of Object.keys(overrides) as K[]) {
    originals.set(key, multitableClient[key])
    const override = overrides[key]
    if (override !== undefined) {
      ;(multitableClient[key] as MultitableApiClient[K]) = override
    }
  }
  return {
    restore: () => {
      for (const [key, original] of originals) {
        ;(multitableClient[key] as MultitableApiClient[K]) = original
      }
    },
  }
}
