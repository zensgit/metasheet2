/**
 * SHEET-LIVENESS answer for mock-pool integration fixtures.
 *
 * ── The class of defect this exists for ───────────────────────────────────────
 * `DELETE /sheets/:sheetId` became a SOFT delete, so `resolveSheetCapabilities` now reads
 * `meta_sheets.deleted_at` before any sheet-addressed work (src/multitable/sheet-liveness.ts). Every
 * mock-pool fixture written before that predates the query.
 *
 * They fail in TWO different ways, which is why grepping for an error could never find them all:
 *   - a fixture that THROWS on unhandled SQL surfaces a loud `Unhandled SQL in test: SELECT
 *     deleted_at ...` and 500s;
 *   - a fixture that returns `{ rows: [] }` for unknown SQL says, silently, "that sheet does not
 *     exist" — and the route correctly 404s. No error, no log, just a wrong status.
 * The second kind is the dangerous one: it means the fixture was describing a database in which its
 * own sheets had no `meta_sheets` row, and nothing ever noticed because the routes never asked.
 *
 * ── Why TRANSLATE rather than enumerate ──────────────────────────────────────
 * The obvious fix — hand each wrapper a list of live sheet ids — makes the fixture's substrate a
 * second, separate declaration that can drift from what its own handler says. Instead this asks the
 * handler the question it ALREADY answers ("does this sheet exist?") and derives liveness from that.
 * Consequences that matter:
 *   - a test that deliberately declares a sheet ABSENT keeps getting its 404;
 *   - a test that declares the sheet present keeps its original outcome;
 *   - a fixture cannot drift, because there is only ever one declaration.
 *
 * A handler that answers NEITHER existence form is treated as live. That is exactly the pre-change
 * behaviour — the routes did not ask — so such a test keeps its original intent too, rather than
 * being silently flipped to 404 by a question its author never had to answer.
 */

export type MockQueryResult = { rows: any[]; rowCount?: number }
export type MockQueryHandler = (sql: string, params?: unknown[]) => MockQueryResult | Promise<MockQueryResult>

/** The exact read `loadSheetLiveness` issues. */
export const SHEET_LIVENESS_SQL = 'SELECT deleted_at FROM meta_sheets WHERE id = $1'

export function isSheetLivenessQuery(sql: string): boolean {
  return sql.includes(SHEET_LIVENESS_SQL)
}

/**
 * S3 (ADR adr-stock-prep-project-sheets-20261008 §5) — every capability resolver now also asks whether
 * the sheet is the stock-preparation project overview (`loadStockPreparationOverviewSheetIds`,
 * src/multitable/stock-preparation-overview-contract.ts). No mock-pool fixture declares an overview, and
 * before S3 nothing asked, so the faithful answer is "no sheet is the overview" — `{ rows: [] }`. Left to
 * the fixtures, the question fails BOTH ways this file's header describes: a throwing handler 500s, and a
 * catch-all `FROM meta_sheets WHERE id` branch answers an id and silently clamps every write to 403.
 */
export const STOCK_PREP_OVERVIEW_KIND_SQL =
  "SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2"

export function isStockPrepOverviewKindQuery(sql: string): boolean {
  return sql.includes(STOCK_PREP_OVERVIEW_KIND_SQL)
}

/** "None of these sheets is the stock-preparation overview" — the pre-S3 answer. */
export function answerNotStockPrepOverview(): MockQueryResult {
  return { rows: [], rowCount: 0 }
}

/**
 * The existence forms fixtures actually answer, in the order they are tried:
 * `loadSheetRow`'s projection first (the commonest), then the bare id probe.
 */
const EXISTENCE_PROBES = [
  'SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
  'SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
] as const

/** `{ rows: [{ deleted_at: null }] }` when the handler says the sheet exists, `{ rows: [] }` when not. */
export async function answerSheetLiveness(
  queryHandler: MockQueryHandler,
  params?: unknown[],
): Promise<MockQueryResult> {
  for (const probe of EXISTENCE_PROBES) {
    try {
      const existing = await queryHandler(probe, params)
      const found = (existing?.rows ?? []).length > 0
      return { rows: found ? [{ deleted_at: null }] : [], rowCount: found ? 1 : 0 }
    } catch {
      // This handler does not know this form — try the next.
    }
  }
  // Neither form known ⇒ live, i.e. the pre-change behaviour.
  return { rows: [{ deleted_at: null }], rowCount: 1 }
}
