/**
 * P0-S S4 — plugin sheet-scope enforcement mode (migration groundwork).
 *
 * Security context (rebaselined @ c5a4a94f7, 2026-08-20):
 *   `assertPluginOwnsSheet` returns `false` for a sheet with NO registry row (a
 *   deliberate, test-pinned legacy tolerance — `tests/unit/multitable-plugin-scope.test.ts`),
 *   and throws only when a DIFFERENT plugin owns it. The host `assertSheetScope` hook
 *   (`index.ts`) currently `await`s it but IGNORES the boolean, so a plugin can reach the
 *   plugin-scope records API for ANY unregistered sheet — i.e. every user-created sheet.
 *   The UoW path (`index.ts`, `runStockPreparationPersistUnitOfWork`) DOES check and throws
 *   `unclaimed` — an existing asymmetry. Flipping the hook to hard-throw would break every
 *   legacy plugin relying on the tolerance and redden the pinned test, so this is a migration.
 *
 * This module only supplies the MODE. Default `'observe'` = today's behavior PLUS a
 * structured warning + metric on unregistered/cross-owner access (zero functional change,
 * pure visibility). `'enforce'` throws on an unregistered sheet (post-inventory/backfill,
 * flipped per-deployment once registry backfill is done). Cross-owner access already throws
 * in `assertPluginOwnsSheet` regardless of mode.
 */

export const PLUGIN_SHEET_SCOPE_MODE_ENV = 'MULTITABLE_PLUGIN_SHEET_SCOPE_MODE'

export type PluginSheetScopeMode = 'observe' | 'enforce'

type Env = Readonly<Record<string, string | undefined>>

/**
 * Fail-safe resolution: default `'observe'` (non-breaking). Only the exact string
 * `'enforce'` hardens; anything else (unset/empty/typo) => observe.
 */
export function resolvePluginSheetScopeMode(env: Env = process.env): PluginSheetScopeMode {
  return env[PLUGIN_SHEET_SCOPE_MODE_ENV] === 'enforce' ? 'enforce' : 'observe'
}
