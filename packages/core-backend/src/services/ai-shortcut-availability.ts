/**
 * A11 (customer feedback 2026-09-24 #7c) — "would a multitable AI shortcut
 * request get past the provider gates right now?", answered WITHOUT a request.
 *
 * The web client asks this (through GET /api/multitable/ai/availability) to hide
 * AI surfaces that could only ever answer AI_BLOCKED on this deployment. The
 * answer is ONE values-free boolean.
 *
 * It runs the SAME two gates, in the SAME order, with the SAME data class that
 * `runShortcutCore` (ai-bulk-shared.ts) runs before it reserves quota:
 *   1. `aiClient.preflight(env)` — readiness `ready` (enable flag, provider,
 *      model, and for the local lane a provably-local base URL) AND
 *      MULTITABLE_AI_CONFIRM_LIVE_REQUESTS === '1' AND a priced model;
 *   2. `authorizeAiRoute(provider, AI_SHORTCUT_DATA_CLASS, env)` — business-class
 *      prompts only go to a provably-local endpoint.
 * `true` therefore means those gates would pass. It does NOT promise that a
 * request succeeds: quota, rate limits, record permissions and the provider
 * itself are still checked per request, and the per-request gates stay the
 * authority — this is a UI hint, never an unlock.
 *
 * Kept OUT of ai-bulk-shared.ts on purpose: the provider call-site census
 * (tests/unit/ai-provider-call-site-census.test.ts) pins that file's FIRST
 * `authorizeAiRoute(` to come before its provider call. A second call placed
 * above `runShortcutCore` would satisfy that check on its own and weaken it.
 *
 * No provider call, no DB, no ledger row. Fails closed: anything unexpected is
 * `false`.
 */

import type { AiProviderClient } from './ai-provider-client'
import { AI_SHORTCUT_DATA_CLASS } from './ai-bulk-shared'
import { authorizeAiRoute } from './ai-routing-policy'

export function resolveShortcutAvailability(
  aiClient: Pick<AiProviderClient, 'preflight'>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const pre = aiClient.preflight(env)
  // `in`-guard (not `!pre.ok`): non-strict tsconfig, no boolean-discriminant narrowing.
  if ('message' in pre) return false
  // Exactly one routing decision, fail-closed: only an explicit allow counts.
  return authorizeAiRoute(pre.provider, AI_SHORTCUT_DATA_CLASS, env).allowed === true
}
