/**
 * 人工补充行的父组件 — the two READS behind the parent picker (ADR adr-stock-prep-manual-rows-20261030 §12.6 and
 * §12.7 ①, slice P1). This module is the pure half: the two FIXED statements, their parameter lists, the query-string
 * parser and the row mappers. The gates, the actor's read sets and the response live in routes/univer-meta.ts.
 *
 * CANDIDATES — GET /api/multitable/sheets/:sheetId/manual-rows/parent-options?q=&limit=
 *   What a manual row may be hung under, read from the sheet itself:
 *     kind 'parent'     a 父组件图号 that already appears on some row — ONE entry per 图号, with `childCount` = how many
 *                       rows carry it. The same 图号 can be stored with different 父组件名称 (PLM renamed the parent
 *                       between pulls, a person typed another name): the entry's name is the one MOST of those rows
 *                       use (a tie goes to the byte-smallest; rows without a name do not vote, and the name is null
 *                       only when none of them has one), so a parent is never listed twice with its children split;
 *     kind 'component'  a row's own 图号 + 名称 (PLM rows and manual rows alike), unless that 图号 is already listed as a
 *                       'parent' — then only the 'parent' entry is listed, with ITS name. A PLM child stores its parent's
 *                       UNSPLIT 「名称及规格」 while the parent's own row stores the split first segment; listing the
 *                       'parent' text keeps a manual child's 父组件名称 equal to its PLM siblings'.
 *   A blank 图号 is never listed. Values are returned exactly as stored (never trimmed): the fill view groups by the
 *   raw text, so the picked value must equal the PLM text byte for byte.
 *
 * THE SEARCH (`q`) is a substring match on an entry's 图号 or 名称, and BOTH sides are folded by the database:
 * `strpos(LOWER(column), LOWER($9))`, with `q` passed as typed. The application never lower-cases it. JavaScript
 * and the database do not fold the same way: a database whose LC_CTYPE is "C" (this repository provisions such
 * ones) folds ASCII letters only, and a libc locale folds each character on its own, where JavaScript writes a
 * word-final capital sigma as ς. A needle folded by one and a column folded by the other therefore miss each other
 * on text such as 「Φ20」 even when it is typed exactly as stored. Folded by one engine, a needle typed as stored
 * always matches; how far the match ignores case is the database's own rule (ASCII only on a "C" database).
 *
 * DEPENDENTS — GET /api/multitable/records/:recordId/manual-parent-dependents
 *   How many OTHER manual rows name this manual row's own 图号 as their 父组件图号. The web asks before it changes a
 *   manual row's 图号 or deletes the row, and shows 「有 N 行人工补充行以它为父组件」 — the children are not rewritten
 *   (rule P6: the parent is a display attribute of each child row, not a reference). The route is addressed by the
 *   RECORD, not by a 图号: the server reads the row's own stored 图号, so no business value travels in a URL and the
 *   count cannot be pointed at an arbitrary text.
 *
 * WHAT A STATEMENT MAY SEE (the anti-oracle rule, precedent routes/univer-meta.ts loadDashboardSourceRows).
 *   - ROWS: only rows the actor may read. The route passes the actor's record-level deny set (`loadDeniedRecordIds`,
 *     when the sheet's row-level read flag is on and the actor is not an admin) and the statement excludes those ids
 *     BEFORE it groups, counts or caps — so `childCount`, the de-duplication, the cap and `truncated` are all over
 *     readable rows only.
 *   - COLUMNS: each column id is a PARAMETER, and the route passes NULL for a column outside the actor's layer-2 ∧
 *     layer-3 read set (`maskStoredRecordFieldIds`). `data -> NULL` is NULL, so such a column is neither projected nor
 *     matched by `q` nor counted: for this actor it does not exist. The same holds for 有效 — an actor who cannot read
 *     it gets NO active filter (exactly as a saved view filter on a column the actor cannot read is dropped), never a
 *     list whose membership depends on a value they may not see.
 *   - No field id is ever interpolated into the SQL text; both statements are literals.
 *
 * COST. One pass over the sheet's rows, four `jsonb` key reads per row (`picked` is MATERIALIZED so each key is read
 * once), no whole-row transfer to the application. Deliberately NOT the export's row ceiling: the export refuses a
 * sheet over its limit, a picker must simply answer.
 *
 * VALUES-FREE: this module logs nothing and its errors carry no value.
 */
import { MANUAL_ROW_KEY_V1_PREFIX } from './stock-preparation-manual-rows'

export const MANUAL_ROW_PARENT_OPTIONS_DEFAULT_LIMIT = 20
export const MANUAL_ROW_PARENT_OPTIONS_MAX_LIMIT = 50
export const MANUAL_ROW_PARENT_OPTIONS_MAX_QUERY_LENGTH = 200

/**
 * The characters both statements treat as surrounding whitespace when they decide "blank" or compare two 图号: space,
 * tab, LF, CR, VT, FF, the no-break space (U+00A0) and the ideographic space (U+3000). Passed as a PARAMETER to BTRIM,
 * so the SQL text holds no escape sequence; spelled as code points here, so this source holds no invisible character.
 * (JS `trim()` knows a few more exotic code points; they do not occur in these columns.)
 */
export const MANUAL_ROW_PARENT_SQL_TRIM_CHARS = String.fromCharCode(0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c, 0xa0, 0x3000)

export type ManualRowParentOptionsQuery = Readonly<{ q: string; limit: number }>

/**
 * `q`: optional text, trimmed; longer than 200 characters is a 400. `limit`: optional integer, default 20, clamped to
 * 1 – 50; anything that is not an integer falls back to the default (the list routes' convention).
 */
export function parseManualRowParentOptionsQuery(query: { q?: unknown; limit?: unknown } | null | undefined):
  | Readonly<{ kind: 'ok'; value: ManualRowParentOptionsQuery }>
  | Readonly<{ kind: 'invalid'; message: string }> {
  const rawQ = query?.q
  if (rawQ !== undefined && typeof rawQ !== 'string') return { kind: 'invalid', message: 'q must be a single text value' }
  const q = typeof rawQ === 'string' ? rawQ.trim() : ''
  if (q.length > MANUAL_ROW_PARENT_OPTIONS_MAX_QUERY_LENGTH) {
    return { kind: 'invalid', message: `q must be at most ${MANUAL_ROW_PARENT_OPTIONS_MAX_QUERY_LENGTH} characters` }
  }
  const rawLimit = typeof query?.limit === 'string' ? query.limit.trim() : ''
  const limit = /^[0-9]+$/.test(rawLimit)
    ? Math.min(Math.max(Number(rawLimit), 1), MANUAL_ROW_PARENT_OPTIONS_MAX_LIMIT)
    : MANUAL_ROW_PARENT_OPTIONS_DEFAULT_LIMIT
  return { kind: 'ok', value: { q, limit } }
}

/**
 * The physical column ids the candidate statement may read FOR THIS ACTOR — null for a column the actor may not read
 * (or that the sheet does not have). `active` null = no active filter.
 */
export type ManualRowParentOptionColumns = Readonly<{
  code: string | null
  name: string | null
  parentCode: string | null
  parentName: string | null
  active: string | null
}>

/**
 * The candidate statement. Parameters:
 *   $1 sheet id · $2 图号 · $3 名称 · $4 父组件图号 · $5 父组件名称 (column ids, NULL = not readable) · $6 有效 (column id,
 *   NULL = no active filter) · $7 record ids the actor may not read · $8 the trim characters · $9 the search text AS
 *   TYPED ('' = no search; the statement folds it with the same LOWER it folds the columns with) · $10 the row cap
 *   (the route asks for limit + 1 to learn `truncated`).
 * Only JSON strings count as a 图号 / 名称 (a number or object in the cell is not a candidate).
 * `parent_names` counts the rows per (父组件图号, 父组件名称); `parents` folds them into one row per 图号: the name with
 * the most rows (then the byte-smallest; a NULL name never wins over a name), and the sum of the rows as the child
 * count. Ordering is fixed and locale-independent: 'parent' entries first, then by 图号, then by 名称 (COLLATE "C");
 * every row of the result is a distinct (kind, 图号, 名称), so the order is total.
 */
export const MANUAL_ROW_PARENT_OPTIONS_SQL = `
WITH picked AS MATERIALIZED (
  SELECT data -> $2::text AS code_json,
         data -> $3::text AS name_json,
         data -> $4::text AS parent_code_json,
         data -> $5::text AS parent_name_json
    FROM meta_records
   WHERE sheet_id = $1
     AND ($6::text IS NULL OR data ->> $6::text = 'true')
     AND NOT (id = ANY($7::text[]))
),
texts AS (
  SELECT CASE WHEN jsonb_typeof(code_json) = 'string' THEN code_json #>> '{}' END AS code,
         CASE WHEN jsonb_typeof(name_json) = 'string' THEN name_json #>> '{}' END AS name,
         CASE WHEN jsonb_typeof(parent_code_json) = 'string' THEN parent_code_json #>> '{}' END AS parent_code,
         CASE WHEN jsonb_typeof(parent_name_json) = 'string' THEN parent_name_json #>> '{}' END AS parent_name
    FROM picked
),
parent_names AS (
  SELECT parent_code AS code,
         CASE WHEN BTRIM(parent_name, $8::text) <> '' THEN parent_name END AS name,
         COUNT(*)::int AS uses
    FROM texts
   WHERE BTRIM(parent_code, $8::text) <> ''
   GROUP BY 1, 2
),
parents AS (
  SELECT code,
         (ARRAY_AGG(name ORDER BY uses DESC, name COLLATE "C") FILTER (WHERE name IS NOT NULL))[1] AS name,
         SUM(uses)::int AS child_count
    FROM parent_names
   GROUP BY code
),
components AS (
  SELECT DISTINCT code,
         CASE WHEN BTRIM(name, $8::text) <> '' THEN name END AS name
    FROM texts
   WHERE BTRIM(code, $8::text) <> ''
     AND NOT EXISTS (SELECT 1 FROM parents WHERE parents.code = texts.code)
),
items AS (
  SELECT code, name, 'parent'::text AS kind, child_count FROM parents
  UNION ALL
  SELECT code, name, 'component'::text AS kind, NULL::int AS child_count FROM components
)
SELECT code, name, kind, child_count
  FROM items
 WHERE $9::text = ''
    OR strpos(LOWER(code), LOWER($9::text)) > 0
    OR strpos(LOWER(COALESCE(name, '')), LOWER($9::text)) > 0
 ORDER BY CASE WHEN kind = 'parent' THEN 0 ELSE 1 END, code COLLATE "C", name COLLATE "C" NULLS FIRST
 LIMIT $10::int`.trim()

export function manualRowParentOptionsParams(input: {
  sheetId: string
  columns: ManualRowParentOptionColumns
  deniedRecordIds: readonly string[]
  q: string
  limit: number
}): unknown[] {
  const { columns } = input
  return [
    input.sheetId,
    columns.code,
    columns.name,
    columns.parentCode,
    columns.parentName,
    columns.active,
    [...input.deniedRecordIds],
    MANUAL_ROW_PARENT_SQL_TRIM_CHARS,
    // As typed — never folded here: the statement applies LOWER to this text and to the columns alike (see the header).
    input.q,
    input.limit + 1,
  ]
}

export type ManualRowParentOptionKind = 'parent' | 'component'

/** One row of the candidate statement, as the driver returns it. */
export type ManualRowParentOptionRow = { code?: unknown; name?: unknown; kind?: unknown; child_count?: unknown }

/** What the route answers per candidate. `name` null = the parent has no name, or the actor may not read the name column. */
export type ManualRowParentOption = {
  code: string
  name: string | null
  kind: ManualRowParentOptionKind
  /** Only for kind 'parent': the readable rows that carry this parent. */
  childCount?: number
}

/** The first `limit` rows of the statement's `limit + 1`, and whether there were more. */
export function manualRowParentOptionsPage<T>(rows: readonly T[], limit: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit }
}

export function manualRowParentOptionKindOf(row: ManualRowParentOptionRow): ManualRowParentOptionKind {
  return row.kind === 'parent' ? 'parent' : 'component'
}

/**
 * The response entry for one statement row, from the values that came back through the route's field mask (`code` /
 * `name` are what `filterRecordDataByFieldIds` kept). A row whose 图号 did not survive the mask, or is blank, yields
 * no entry.
 */
export function manualRowParentOptionOf(row: ManualRowParentOptionRow, code: unknown, name: unknown): ManualRowParentOption | null {
  if (typeof code !== 'string' || code.trim() === '') return null
  const kind = manualRowParentOptionKindOf(row)
  const option: ManualRowParentOption = { code, name: typeof name === 'string' && name.trim() !== '' ? name : null, kind }
  if (kind === 'parent') {
    const count = Number(row.child_count)
    option.childCount = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
  }
  return option
}

/**
 * The dependents statement. Parameters:
 *   $1 sheet id · $2 this record's id (not counted) · $3 父组件图号 (column id) · $4 this row's own 图号 · $5 the key
 *   column id · $6 the manual key prefix (`manual:v1:`) · $7 the trim characters · $8 record ids the actor may not read.
 * Counts rows that are manual rows as SQL can state M's row half — the key equals `manual:v1:<own id>` and the
 * creator is non-blank — whose 父组件图号 equals the given 图号, surrounding whitespace ignored on both sides (the P5
 * comparison). A number, never a row.
 */
export const MANUAL_ROW_PARENT_DEPENDENTS_SQL = `
SELECT COUNT(*)::int AS dependents
  FROM meta_records
 WHERE sheet_id = $1
   AND id <> $2
   AND BTRIM(data ->> $3::text, $7::text) = BTRIM($4::text, $7::text)
   AND data ->> $5::text = $6::text || id
   AND created_by IS NOT NULL
   AND BTRIM(created_by, $7::text) <> ''
   AND NOT (id = ANY($8::text[]))`.trim()

export function manualRowParentDependentsParams(input: {
  sheetId: string
  recordId: string
  parentCodeFieldId: string
  ownCode: string
  keyFieldId: string
  deniedRecordIds: readonly string[]
}): unknown[] {
  return [
    input.sheetId,
    input.recordId,
    input.parentCodeFieldId,
    input.ownCode,
    input.keyFieldId,
    MANUAL_ROW_KEY_V1_PREFIX,
    MANUAL_ROW_PARENT_SQL_TRIM_CHARS,
    [...input.deniedRecordIds],
  ]
}

/** The count out of the statement's single row; anything unexpected is 0. */
export function manualRowParentDependentsCountOf(rows: ReadonlyArray<{ dependents?: unknown }> | null | undefined): number {
  const count = Number(rows?.[0]?.dependents)
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
}
