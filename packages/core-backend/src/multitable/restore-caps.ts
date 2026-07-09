/**
 * Shared restore-surface ceilings.
 *
 * `SHEET_REVERT_MAX_RECORDS` was a route-local `const` inside the T8 PIT block of `univer-meta.ts` (D3/PIT-6:
 * a whole-sheet revert/reset above this many records is REFUSED fail-closed, never truncated, never processed
 * async). The 4c-1 lossy retype revert (design-lock 2026-07-07 §2.4 / C4) reuses the SAME ceiling as its
 * write-symmetric cap — "the number of records preview can scan == the number execute can write" — so the
 * value must live in ONE place rather than being re-derived from the env var at a second call site.
 *
 * Read-at-call-time (not module-load-time) so a test / an operator flipping `MULTITABLE_SHEET_REVERT_MAX_RECORDS`
 * takes effect without a process restart. The T8 PIT block still resolves it ONCE at router construction — an
 * intentional, byte-for-byte preservation of its pre-extraction behavior; only the 4c-1 surface resolves per
 * request (its goldens flip the cap between cases).
 */
export const SHEET_REVERT_DEFAULT_MAX_RECORDS = 5000

export function resolveSheetRevertMaxRecords(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MULTITABLE_SHEET_REVERT_MAX_RECORDS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : SHEET_REVERT_DEFAULT_MAX_RECORDS
}
