/**
 * 一个项目一张备料表 — S3 项目总览表, THE HOST HALF (ADR adr-stock-prep-project-sheets-20261008 §5
 * 「只读（Q5）」; owner ruling Q5 2026-10-08: 宿主级只读 + O1 + O2(a)).
 *
 * WHAT THE HOST GUARANTEES. The overview is ONE plugin-maintained sheet that summarizes every project
 * sheet of a tenant. People must be able to SEE it (it stays listed and readable for whoever the sheet
 * grants already let read it) and EXPORT it, but nobody — administrators included — may change its
 * DATA through the ordinary multitable surface. Only the plugin's own records path writes it. Parts:
 *
 *   1. A server-owned `meta_sheets.system_kind` stamp (`stock_prep_overview`, `system-sheet-predicate.ts`).
 *      Stamped by host provisioning at INSERT and only there (never an UPDATE of an existing row: the P1-a
 *      no-laundering rule), and only when the plugin-scope wrapper admitted the EXACT triple
 *      (plugin `plugin-integration-core`, this kind, the overview object id). Every other caller that
 *      names a `systemKind` is refused with `StockPreparationOverviewSystemKindError` before any IO.
 *      Provisioning also refuses the stamp for any sheet id outside the derived-id namespace (see 3) and
 *      refuses to ADOPT an existing sheet whose kind differs (fix round 1, R8c: the check runs inside the
 *      provisioning transaction, so nothing is written onto an unstamped twin).
 *      Being a recognized system kind also makes the sheet undeletable (`sheet-delete-guard.ts`) and
 *      refuses it as a copy source / retype target (`isSystemManagedSheet`), with no extra code.
 *   2. A capability clamp, `restrictStockPreparationOverviewCapabilities`, applied by EVERY host resolver
 *      that derives sheet capabilities for a person (REST `resolveSheetCapabilitiesForAccess`, the
 *      Yjs/collab/api-token `resolveSheetCapabilitiesForUser`, the transaction-bound
 *      `resolveSheetCapabilitiesForUserOnQuery`, and the `/context` composition). It keeps `canRead`,
 *      `canExport` and `canManageSheetAccess` EXACTLY as the grants resolved them and forces every other
 *      `can*` capability — records, fields, views, comments, automations, notifications, approval,
 *      delete, copy, retype — to false. It takes no admin parameter on purpose: the ADR says
 *      「对所有人生效，含管理员」, so a caller cannot skip admins.
 *      WHY ACCESS MANAGEMENT IS KEPT (fix round 1, R1): the overview must be grantable for READ (G2 by an
 *      admin; G1 by the plugin port below), and the two grant routes require `canManageSheetAccess`. A
 *      principal who may manage access on an ordinary sheet may therefore manage it here — but every grant
 *      on an overview is READ-ONLY IN EFFECT twice over: the grant routes refuse any level above read
 *      (`STOCK_PREP_OVERVIEW_READ_ONLY`, `isStockPreparationOverviewGrantableAccessLevel`), and a write /
 *      admin row that exists anyway (written before, or by hand) is ignored because the clamp forces every
 *      write capability false whatever the grants say.
 *   3. `loadStockPreparationOverviewSheetIds`, the one lookup the resolvers use to decide (1) applies.
 *      Column-tolerant (`to_jsonb(meta_sheets) ->> 'system_kind'`), so a database without the column
 *      answers "not an overview" instead of 42703. ID-PREFILTERED (fix round 1, R12): the overview's sheet
 *      id is ALWAYS the host-derived `getObjectSheetId(project, object)` = `sheet_` + 24 lowercase hex
 *      (provisioning.ts `stableMetaId`), provisioning refuses the stamp on any other id, and `POST /sheets`
 *      / `GET /view?seed=true` refuse to MINT an id of that shape (`isStockPreparationOverviewSheetIdCandidate`,
 *      the e-learning projection-id precedent). So an id outside the pattern cannot be an overview, and the
 *      lookup issues NO statement for it — a capability check on an ordinary sheet costs exactly what it
 *      cost before S3.
 *   4. The G1 READ port's literal (`STOCK_PREPARATION_OVERVIEW_GRANT_PERM_CODE = 'spreadsheet:read'`), the
 *      only level the plugin's overview grant port can write (services/stock-preparation-overview-grants.ts).
 *
 * WHAT IT DOES NOT DO. It does not hide the sheet and does not narrow who may READ it. Automations are
 * refused separately, before any write (`automation-executor.ts`, `STOCK_PREP_OVERVIEW_READ_ONLY`).
 *
 * THE PLUGIN RECORDS PATH (fix round 2, F3). Plugin writes do not go through a person's capabilities, so the
 * clamp above never sees them. The GENERIC plugin record writes (`createPluginScopedMultitableApi` →
 * `records.createRecord` / `patchRecord` / `deleteRecord` and the persist unit of work) therefore REFUSE a
 * stamped overview for every plugin — that is the surface a pipeline / the multitable target adapter reaches
 * with a sheet id taken from external-system config. The overview is written only through
 * `records.stockPreparationOverview`, a port exposed to `plugin-integration-core` alone that takes a PROJECT id,
 * derives the overview's sheet id itself and re-checks ownership and the stamp before each write
 * (`StockPreparationOverviewRecordsWriteError`).
 *
 * No heavy imports: this module must be requirable from the scope wrapper, provisioning, the capability
 * resolvers and the automation executor without a load cycle.
 */
import { STOCK_PREP_OVERVIEW_SHEET_KIND } from './system-sheet-predicate'

/** The plugin's logical object id for the overview sheet (the sheet id is derived from it per project). */
export const STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID = 'plm_stock_preparation_project_overview'

/** The server-owned `meta_sheets.system_kind` the host stamps on the overview sheet. */
export const STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND = STOCK_PREP_OVERVIEW_SHEET_KIND

/** The ONE plugin whose scoped `ensureObject` may ask for the overview stamp (same posture as the G1 port). */
export const STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN = 'plugin-integration-core'

/**
 * The shape of EVERY host-derived sheet id (`stableMetaId('sheet', projectId, objectId)` in provisioning.ts:
 * `sheet_` + the first 24 hex of a sha1). The overview's id is one of them by construction; provisioning
 * refuses the overview stamp on any other id, and the two client paths that may mint a sheet id refuse
 * this shape. Pinned against `getObjectSheetId` by tests/unit/stock-preparation-overview-host.test.ts.
 */
export const STOCK_PREPARATION_OVERVIEW_SHEET_ID_PATTERN = /^sheet_[0-9a-f]{24}$/

/** True iff `sheetId` has the derived-id shape an overview sheet necessarily has. Pure, no IO. */
export function isStockPreparationOverviewSheetIdCandidate(sheetId: unknown): sheetId is string {
  return typeof sheetId === 'string' && STOCK_PREPARATION_OVERVIEW_SHEET_ID_PATTERN.test(sheetId)
}

/** The capabilities the clamp leaves exactly as resolved. Everything else that starts with `can` → false. */
const OVERVIEW_KEPT_CAPABILITY_KEYS: ReadonlySet<string> = new Set(['canRead', 'canExport', 'canManageSheetAccess'])

/**
 * Pure. On an overview sheet keep `canRead` / `canExport` / `canManageSheetAccess` as they are and force
 * EVERY other `can*` key of the object to false — keyed by prefix, not by a list, so a capability added to
 * `MultitableCapabilities` later is denied here by default instead of silently passing through. Off an
 * overview sheet the input is returned unchanged (same object).
 */
export function restrictStockPreparationOverviewCapabilities<T extends { canRead: boolean; canExport: boolean }>(
  caps: T,
  isOverviewSheet: boolean,
): T {
  if (!isOverviewSheet) return caps
  const restricted: Record<string, unknown> = { ...caps }
  for (const key of Object.keys(restricted)) {
    if (key.startsWith('can') && !OVERVIEW_KEPT_CAPABILITY_KEYS.has(key)) restricted[key] = false
  }
  return restricted as T
}

export type StockPreparationOverviewQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * Of the given sheet ids, which carry the overview stamp. Ids outside the derived-id shape are dropped
 * BEFORE the statement (they cannot be an overview, see the module docblock, part 3); no candidate left →
 * empty set, no query. No `deleted_at` filter on purpose (the approval-projection fence's posture): a
 * soft-deleted overview is still clamped, which can only refuse more.
 */
export async function loadStockPreparationOverviewSheetIds(
  query: StockPreparationOverviewQueryFn,
  sheetIds: readonly unknown[],
): Promise<Set<string>> {
  if (!Array.isArray(sheetIds) || sheetIds.length === 0) return new Set()
  const candidates = [...new Set(sheetIds.filter(isStockPreparationOverviewSheetIdCandidate))]
  if (candidates.length === 0) return new Set()
  const result = await query(
    `SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2`,
    [candidates, STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND],
  )
  const ids = new Set<string>()
  for (const row of result.rows as Array<{ id?: unknown }>) {
    if (typeof row?.id === 'string') ids.add(row.id)
  }
  return ids
}

/**
 * The scope wrapper's refusal when a plugin asks `ensureObject` for a `systemKind` it may not stamp.
 * Values-free details: only which of the three conditions failed.
 */
export class StockPreparationOverviewSystemKindError extends Error {
  readonly status = 403
  readonly code = 'MULTITABLE_SYSTEM_KIND_FORBIDDEN'
  readonly details: { reason: 'plugin' | 'kind' | 'object' }

  constructor(reason: 'plugin' | 'kind' | 'object') {
    super('This caller may not stamp a system kind on a provisioned sheet')
    this.name = 'StockPreparationOverviewSystemKindError'
    this.details = { reason }
  }
}

// ── Fix round 1: the read-only refusals (R1 / R4 / R11) and the host-owned stamp's adoption guard (R8c) ──

/** The ONE refusal code of every "this would change the overview" path a person or an automation can reach. */
export const STOCK_PREP_OVERVIEW_READ_ONLY_CODE = 'STOCK_PREP_OVERVIEW_READ_ONLY'

/**
 * The sheet-permission access levels a grant on an overview may carry: `read`, or `none` (a revoke —
 * removing a grant can only narrow). Anything higher would be a write grant the clamp ignores anyway; the
 * grant routes refuse it so a stored row never claims more than the sheet allows.
 */
const OVERVIEW_GRANTABLE_ACCESS_LEVELS: ReadonlySet<string> = new Set(['read', 'none'])

export function isStockPreparationOverviewGrantableAccessLevel(accessLevel: unknown): boolean {
  return typeof accessLevel === 'string' && OVERVIEW_GRANTABLE_ACCESS_LEVELS.has(accessLevel)
}

/** The ONE per-sheet permission code the legacy grant route may write on an overview. */
export const STOCK_PREPARATION_OVERVIEW_GRANT_PERM_CODE = 'spreadsheet:read' as const

/** Values-free refusal body for a grant above read on an overview (both grant routes). */
export const STOCK_PREP_OVERVIEW_GRANT_REFUSAL = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    code: STOCK_PREP_OVERVIEW_READ_ONLY_CODE,
    message: 'This sheet is the read-only stock-preparation project overview; it can only be shared for reading',
    details: Object.freeze({ reason: 'grant_level' as const }),
  }),
})

/** Values-free refusal body for a comment write on an overview (comments.ts). */
export const STOCK_PREP_OVERVIEW_COMMENT_REFUSAL = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    code: STOCK_PREP_OVERVIEW_READ_ONLY_CODE,
    message: 'This sheet is the read-only stock-preparation project overview; comments cannot be added or changed here',
    details: Object.freeze({ reason: 'comment' as const }),
  }),
})

/** The automation step error for a record action that would write an overview (automation-executor.ts). */
export const STOCK_PREP_OVERVIEW_AUTOMATION_REFUSAL =
  `${STOCK_PREP_OVERVIEW_READ_ONLY_CODE}: automations cannot write the read-only stock-preparation project overview`

/**
 * S3 fix round 2 (F3; register R-37): the plugin-scope refusal of a RECORD write that would reach the overview
 * outside its dedicated port, or of a port write that cannot be proven to land on the overview. Values-free:
 * only which rule refused.
 *   - `generic_write`: a generic `createRecord` / `patchRecord` / `deleteRecord` / persist unit of work named a
 *     sheet the host stamped `stock_prep_overview` — the path a pipeline / adapter with a configured sheet id
 *     takes. Only the `records.stockPreparationOverview` port writes the overview;
 *   - `unverifiable`: the host wiring cannot say whether a derived-shape sheet is the overview (a missing hook);
 *     refused rather than guessed, the S1 G1 port's posture;
 *   - `not_overview`: the port's derived sheet is not (or not yet) the stamped overview — the port never writes
 *     an ordinary sheet.
 */
export class StockPreparationOverviewRecordsWriteError extends Error {
  readonly status = 403
  readonly code = STOCK_PREP_OVERVIEW_READ_ONLY_CODE
  readonly details: { reason: 'generic_write' | 'unverifiable' | 'not_overview' }

  constructor(reason: 'generic_write' | 'unverifiable' | 'not_overview') {
    super('Records of the read-only stock-preparation project overview are written only by its own plugin port')
    this.name = 'StockPreparationOverviewRecordsWriteError'
    this.details = { reason }
  }
}

/**
 * S3 follow-up E (register R-37): the plugin-scope refusal of a STRUCTURAL write — columns, field properties,
 * display names, views, or an unstamped ensure — that would reach the read-only overview outside the overview
 * module's own provisioning path. Values-free: only which rule refused.
 *   - `structure_write`: a field / view / relabel / unstamped-ensure write named the overview object, or an
 *     ensureView named the stamped overview without the overview module's `systemKind` marker;
 *   - `unverifiable`: the host wiring cannot say whether a derived-shape sheet is the overview (a missing hook) —
 *     refused rather than guessed, the records port's posture.
 */
export class StockPreparationOverviewStructureWriteError extends Error {
  readonly status = 403
  readonly code = STOCK_PREP_OVERVIEW_READ_ONLY_CODE
  readonly details: { reason: 'structure_write' | 'unverifiable' }

  constructor(reason: 'structure_write' | 'unverifiable') {
    super('The structure of the read-only stock-preparation project overview is changed only by its own provisioning')
    this.name = 'StockPreparationOverviewStructureWriteError'
    this.details = { reason }
  }
}

/**
 * Thrown by provisioning when a caller asks to stamp a sheet that ALREADY exists with a different kind
 * (most often: an unstamped sheet at the overview's derived id). Raised inside the provisioning
 * transaction, BEFORE any field or view is written, so the host never adopts an ordinary sheet as a
 * system sheet nor writes the overview's columns onto it. Values-free.
 */
export class SheetSystemKindConflictError extends Error {
  readonly status = 409
  readonly code = 'SHEET_SYSTEM_KIND_CONFLICT'
  readonly details: { reason: 'existing_sheet_kind_differs' }

  constructor() {
    super('A sheet already exists at this id without the requested system kind; it is not adopted')
    this.name = 'SheetSystemKindConflictError'
    this.details = { reason: 'existing_sheet_kind_differs' }
  }
}
