/**
 * 备料按部门列写权限 — the stock-preparation (备料) WRITE-SCOPE port into the platform's REAL,
 * server-enforced per-column permission model (`field_permissions`).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS (and why it is not `PluginRbacProvisioningService.applyRoleMatrix`)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * The grid's write gate reads exactly ONE table: `field_permissions`, via
 * `loadFieldPermissionScopeMap` (multitable/permission-service.ts) → `deriveFieldPermissions` →
 * `isFieldWriteForbidden` (multitable/permission-derivation.ts), enforced at
 * `POST /api/multitable/patch`, `PATCH /records/:recordId`, and the Yjs bridge write-input builder.
 * Before this port, the ONLY writers of that table were two inline SQL statements inside
 * `routes/univer-meta.ts` (the operator-facing authoring PUT and the de-escalation restore path) —
 * there was NO in-process, callable writer at all.
 *
 * `PluginRbacProvisioningService.applyRoleMatrix`'s `fieldPolicies` writes a DIFFERENT table
 * (`plugin_field_policy_registry`) which the grid NEVER reads. Declaring a 备料 column policy there
 * would produce a policy row that enforces nothing — a paper guarantee. This port therefore writes
 * the table the enforcement chain actually consults, and nothing else.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LOAD-BEARING PROPERTY — THIS PORT SCOPES **WRITE** ONLY, AND CAN NEVER RESTRICT **READ**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `field_permissions` carries TWO independent dimensions: `visible` (read) and `read_only` (write).
 * This port sets `read_only` and pins `visible` to the hardcoded literal `true`. `visible` is NOT a
 * parameter of `applyRoleWriteScopes`, is NOT bound to a placeholder, and appears nowhere in this
 * file as anything other than that literal — so this capability is STRUCTURALLY incapable of
 * emitting a read restriction. It is not a convention a caller can forget or violate; there is no
 * input, no flag and no overload by which a hidden column can come out of this file.
 *
 * That is a business requirement, not a stylistic one. In the 备料 flow the PRODUCTION band
 * (材料类型 / 毛胚类型 / 需求日期 / 提前周期 …) is precisely what tells 采购 WHAT to buy and BY
 * WHEN, and tells 仓库 what to prepare and when it is due; 采购 and 仓库 must also keep SEEING each
 * other's response columns to coordinate. Hiding those columns from a department would break the
 * actual business flow and be strictly WORSE than the status quo (today every column is writable by
 * everyone, which is at least workable). The failure mode this port removes is a department
 * OVERWRITING another department's column — not a department READING it.
 *
 * Anything that genuinely needs read scoping must go through the existing operator-facing route
 * `PUT /api/multitable/sheets/:sheetId/field-permissions` (routes/univer-meta.ts), which is the
 * full-authority, audited surface (it records a config revision and takes the same meta_sheets row
 * lock). It is deliberately NOT reachable from here.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE INVARIANT — WHAT A RECONCILE MAY CHANGE, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `applyRoleWriteScopes` is the ONLY MUTATING method. Without a `reconcile` region it only ever
 * INSERTs / UPSERTs and emits NO delete at all.
 *
 * With a region — the (columns × roles) RECTANGLE the caller re-declares in full — exactly ONE
 * invariant governs every row inside it, and it is enforced by ONE classification (`classifyRows`)
 * over ONE snapshot, used by the rehearsal and by the write alike:
 *
 *   INSIDE THIS PACK'S RECTANGLE, A RECONCILE MAY CHANGE (delete or upsert) ONLY ROWS THAT ARE
 *   PROVABLY THIS PACK'S:
 *     (a) rows carrying THIS pack's marker `<base>#<packId>`;
 *     (b) pairs THIS pack re-declares — upserted and stamped with this pack's marker — but ONLY
 *         when the existing row is (a), is legacy-adoptable per (c), or is ABSENT;
 *     (c) LEGACY pack-less rows (the bare `<base>` marker) ONLY when the caller passes
 *         `legacyAdoptable: true`, which the installer derives from the pack-install LEDGER and
 *         which means "this pack is the only pack ever installed on this sheet". Such a row is then
 *         adopted (re-stamped) or retired. Otherwise it is UNATTRIBUTED.
 *
 *   EVERY OTHER ROW IN THE RECTANGLE IS FOREIGN AND IS NEVER CHANGED:
 *     · another pack's marker `<base>#<other>`;
 *     · an OPERATOR row — `created_by` starting `operator:`, `created_by` NULL (the shape the
 *       authoring route wrote before it started stamping; see routes/univer-meta.ts), or any other
 *       non-plugin value;
 *     · an UNATTRIBUTED legacy row.
 *
 * The outcome for each foreign kind is decided HERE, not by a caller's diligence:
 *   · another pack's marker on a pair this call DECLARES  → throws `PACK_CONFLICT` (the installer
 *     maps it to a coded 422) BEFORE any row is written;
 *   · an unattributed legacy row ANYWHERE in the rectangle → throws `LEGACY_UNATTRIBUTED`, likewise
 *     before any write. A human runs the backfill (migration 083) or clears the rows.
 *   · an OPERATOR row on a pair this call declares → THE UPSERT IS SKIPPED FOR THAT PAIR. The row is
 *     not deleted, its `visible` and `read_only` are NOT rewritten, and the pair comes back in
 *     `operatorHeld` so the caller names it. Operator decisions win and are reported, never
 *     overwritten. This is why there is no `visible`/`read_only` CASE in the UPSERT: the pairs that
 *     would have needed one never reach the statement.
 *   · another pack's row inside the rectangle but on NO declared pair → left alone and returned in
 *     `governedByOtherPacks`. It is not stale, and it is not the operator's to clear.
 *
 * THE DELETE is the invariant's only destructive arm, and it fires only on a row satisfying ALL of:
 *   0. `sheet_id = <the target sheet>` — `field_permissions` carries NO tenant and NO project
 *      column, so this single clause is the entire project/tenant bound of the statement. It is
 *      listed first because it is the one whose absence would be widest, and it is pinned by the
 *      source guard and by a positional-decoding model, not merely present.
 *   1. `created_by = ANY($2)` where `$2` is `[<this pack's marker>]` — plus the bare LEGACY marker
 *      **only when `legacyAdoptable` is true**. That conditional is the whole of finding-1's fix:
 *      before it, every row every pack had ever written carried the bare marker (the pack id landed
 *      in `created_by` only in this change), so an unconditional legacy arm let pack B retire pack
 *      A's rows. An OPERATOR row and another pack's row are invisible to this statement either way.
 *   2. `read_only = true` — only an actual write denial. A row this port wrote and an operator later
 *      relaxed is no longer a denial and is left exactly as the operator left it.
 *   3. `field_id = ANY(<governed columns>) AND subject_id = ANY(<governed roles>)` — the caller's
 *      declared region, which `normalizeInput` REQUIRES to be a superset of the entries being
 *      written. The delete can therefore never reach a column or a role the same call is not
 *      simultaneously authoritative about.
 *   4. `NOT EXISTS (... desired.field_id = field_permissions.field_id AND
 *      desired.subject_id = field_permissions.subject_id)` — the row is not in the desired set this
 *      very call just wrote. The CORRELATION is the load-bearing half and is pinned by name in the
 *      source guard, because cross-wiring it (`desired.field_id = field_permissions.subject_id`)
 *      turns the reconcile into a statement that deletes the rows it just wrote.
 *
 * AND THE STATEMENT IS CHECKED AGAINST THE CLASSIFICATION. `classifyRows` independently computes
 * `willRetire` from the same in-transaction snapshot; the DELETE's `RETURNING` set must equal it
 * exactly or the call throws `RECONCILE_DIVERGED` and the transaction rolls back. So the five
 * narrowings are not merely present in the text — a mutation to any of them that changes the row
 * set is a runtime abort, not a silent widening.
 *
 * The removals are RETURNED (`removed`), so the caller can report exactly which restrictions were
 * dropped instead of dropping them silently.
 *
 * A RECONCILE REQUIRES A `packId`. A delete bounded by a provenance marker that identifies no pack
 * cannot be attributed at all, so `normalizeInput` refuses it (`ENTRIES_INVALID`). Additive calls —
 * the whole of what existed before #5455 — are unaffected: they pass no region and emit no DELETE.
 *
 * PROVENANCE: every row this port writes carries
 * `created_by = 'plugin:plugin-integration-core/stock-preparation#<packId>'` (or the pack-less base
 * marker when the caller names no pack and therefore cannot reconcile). `SELECT ... WHERE created_by
 * LIKE '<base>%'` is an exact, operator-runnable census of what this plugin ever wrote, AND it
 * attributes each row to the pack that wrote it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE READ METHODS — WHY A REVOKE-FREE PORT STILL NEEDS TO BE READABLE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `classifyRoleWriteScopeRegion`, `listRoleWriteScopes`, `findMissingRoleIds` and
 * `findMissingFieldIds` are READ-ONLY (`SELECT` only; a source guard in the unit suite asserts this
 * file contains exactly one INSERT and exactly one — scoped — DELETE, and that no read method emits
 * either).
 *
 *   - `classifyRoleWriteScopeRegion` is THE REHEARSAL of the invariant above: it runs the SAME
 *     `classifyRows` over the SAME query, outside a transaction, so a dry-run's verdict and an
 *     install's verdict are one function's output rather than two models that can disagree.
 *   - `listRoleWriteScopes` runs the plugin-wide provenance census (every role-scoped denial on the
 *     sheet, attributed). It is the operator-facing read and the realdb suite's oracle.
 *   - `findMissingRoleIds` / `findMissingFieldIds` let a caller ask "does this role / this column
 *     exist" BEFORE it starts writing schema. `applyRoleWriteScopes` already refuses both, but it is
 *     called LAST, after every column has been created and stamped; the pre-flight turns that into a
 *     refusal over an untouched sheet.
 *
 * None can hide a column, none can drop a restriction, and none takes a `visible` argument — the
 * load-bearing property above is unaffected by their existence.
 */

import { poolManager } from '../integration/db/connection-pool'

/**
 * BASE provenance marker — the plugin-family prefix, and the exact value written by a caller that
 * names no pack. See PROVENANCE above.
 *
 * A row stamped with exactly this value is a LEGACY row: written before the marker carried a pack
 * id, so there is no pack it can be attributed to. Such a row is adoptable by whichever pack
 * re-declares it (there is no other owner to protect it for) — that is the ONLY marker other than
 * its own that a pack's reconcile may touch, and it is stated here rather than left to inference.
 */
export const STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY =
  'plugin:plugin-integration-core/stock-preparation'

/**
 * The PER-PACK provenance marker: the base above plus `#<packId>`.
 *
 * Two customer packs can legitimately land on the same canonical sheet, and the platform row carries
 * no pack column — so without this the only "whose row is it" predicate available to the DELETE was
 * a single plugin-wide constant, and pack B's reconcile could retire a denial pack A still declares.
 * The pack id lives inside `created_by` because that is the one column the enforcement table already
 * has, and it stays PARSEABLE (single `#`, pack ids never contain one) so a census can attribute
 * every row without a schema change.
 */
export function stockPreparationFieldPermissionCreatedBy(packId?: string | null): string {
  if (typeof packId !== 'string' || packId.trim().length === 0) {
    return STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY
  }
  return `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${packId.trim()}`
}

/**
 * The OPERATOR provenance prefix. Written by the operator-facing authoring route and the
 * de-escalation restore path in `routes/univer-meta.ts`, so a row a human decided on is
 * ATTRIBUTABLE going forward rather than indistinguishable from an unwritten one.
 *
 * Rows written before this existed carry `created_by = NULL`, which is why the classification below
 * treats NULL as an operator row: on every host in the field today that is the ONLY shape an
 * operator decision has. A fixture that seeds a nice `operator:` string and nothing else is
 * rehearsing a shape production does not yet produce.
 */
export const FIELD_PERMISSION_OPERATOR_CREATED_BY_PREFIX = 'operator:'

/** The fallback marker when no actor id is available (a service-authored de-escalation, say). */
export const FIELD_PERMISSION_OPERATOR_ROUTE_CREATED_BY = 'operator:univer-meta-authoring-route'

/**
 * `operator:<actorId>` — or the route marker when there is no usable actor id.
 *
 * The actor id must stay a single clean segment so `created_by` remains parseable in both
 * directions: no whitespace and no `#` (which is the plugin marker's pack separator). Anything else
 * degrades to the route marker rather than producing an unparseable value.
 */
export function operatorFieldPermissionCreatedBy(actorId?: unknown): string {
  if (typeof actorId !== 'string') return FIELD_PERMISSION_OPERATOR_ROUTE_CREATED_BY
  const trimmed = actorId.trim()
  if (trimmed.length === 0 || trimmed.length > 200) return FIELD_PERMISSION_OPERATOR_ROUTE_CREATED_BY
  if (/[\s#]/.test(trimmed)) return FIELD_PERMISSION_OPERATOR_ROUTE_CREATED_BY
  return `${FIELD_PERMISSION_OPERATOR_CREATED_BY_PREFIX}${trimmed}`
}

/**
 * Read a `created_by` value back. `isPluginRow` false means the row belongs to somebody else — an
 * operator, another subsystem, or nobody (NULL) — and nothing in this file may delete it.
 */
export function parseStockPreparationFieldPermissionCreatedBy(
  createdBy: unknown,
): { isPluginRow: boolean; packId: string | null } {
  if (typeof createdBy !== 'string') return { isPluginRow: false, packId: null }
  if (createdBy === STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY) {
    return { isPluginRow: true, packId: null }
  }
  const prefix = `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#`
  if (createdBy.startsWith(prefix) && createdBy.length > prefix.length) {
    return { isPluginRow: true, packId: createdBy.slice(prefix.length) }
  }
  return { isPluginRow: false, packId: null }
}

/** Hard cap on entries per call — a foot-gun guard, not a business limit. */
export const STOCK_PREPARATION_FIELD_PERMISSION_MAX_ENTRIES = 500

/**
 * Closed failure vocabulary. Every rejection is one of these seven; there is no generic/unknown
 * member, so a caller can exhaustively switch on it.
 * - `ENTRIES_INVALID`      — input SHAPE is wrong (bad sheetId, non-string/empty id, over the cap,
 *                            or a `reconcile` region with no `packId` to attribute it to).
 * - `SHEET_NOT_FOUND`      — `sheetId` is not a row in `meta_sheets`.
 * - `FIELD_NOT_ON_SHEET`   — a `fieldId` is not a `meta_fields` row FOR THAT sheet.
 * - `ROLE_NOT_FOUND`       — a `roleId` is not a row in `roles`.
 * - `PACK_CONFLICT`        — another pack's marker holds a (column, role) pair this call declares.
 * - `LEGACY_UNATTRIBUTED`  — an unattributable pack-less row sits inside the rectangle.
 * - `RECONCILE_DIVERGED`   — the DELETE's row set did not equal the classification's `willRetire`.
 *                            An internal invariant breach (a narrowing was widened or cross-wired),
 *                            surfaced as an abort rather than as a silent extra/missing delete.
 */
export type StockPreparationFieldPermissionsErrorReason =
  | 'ENTRIES_INVALID'
  | 'SHEET_NOT_FOUND'
  | 'FIELD_NOT_ON_SHEET'
  | 'ROLE_NOT_FOUND'
  | 'PACK_CONFLICT'
  | 'LEGACY_UNATTRIBUTED'
  | 'RECONCILE_DIVERGED'

/** Named, typed failure. Fail-closed: thrown BEFORE any row is written (see applyRoleWriteScopes). */
export class StockPreparationFieldPermissionsError extends Error {
  readonly reason: StockPreparationFieldPermissionsErrorReason
  /** The offending ids, when the reason is about specific ids. Never contains values, only ids. */
  readonly offending: readonly string[]
  /**
   * The offending (column, role) PAIRS, when the reason is about pairs rather than single ids
   * (`PACK_CONFLICT`, `LEGACY_UNATTRIBUTED`, `RECONCILE_DIVERGED`). Ids only — never a value, never
   * a label — so a caller can name every pair in a 422 body without sanitizing anything.
   */
  readonly pairs: readonly RoleWriteScopeOwnedPair[]

  constructor(
    reason: StockPreparationFieldPermissionsErrorReason,
    message: string,
    offending: readonly string[] = [],
    pairs: readonly RoleWriteScopeOwnedPair[] = [],
  ) {
    super(message)
    this.name = 'StockPreparationFieldPermissionsError'
    this.reason = reason
    this.offending = offending
    this.pairs = pairs
  }
}

/** One "this ROLE may NOT WRITE this column" declaration. */
export interface StockPreparationRoleWriteScopeEntry {
  fieldId: string
  roleId: string
}

/** A (column, role) pair plus the pack that holds it, when one does. Ids only. */
export interface RoleWriteScopeOwnedPair extends StockPreparationRoleWriteScopeEntry {
  packId?: string | null
}

/**
 * WHOSE ROW IS THIS — the whole of the invariant's ownership vocabulary, five members, closed.
 *
 * `this_pack` and `legacy_adoptable` are the ONLY two a reconcile may change. The other three are
 * FOREIGN: `other_pack` and `legacy_unattributed` refuse the call, `operator` is skipped and named.
 */
export type RoleWriteScopeOwner =
  | 'this_pack'
  | 'legacy_adoptable'
  | 'legacy_unattributed'
  | 'other_pack'
  | 'operator'

/**
 * The (columns × roles) region a caller declares itself AUTHORITATIVE over for this call — the
 * bound on the reconcile DELETE, and the only thing that makes it a reconcile rather than a revoke.
 *
 * Both lists are REQUIRED and must be non-empty, and every `entries` pair must fall inside them
 * (`normalizeInput` enforces that, `ENTRIES_INVALID` otherwise). A caller therefore cannot delete
 * in a region it is not simultaneously re-declaring in full.
 */
export interface RoleWriteScopeReconcileRegion {
  /** Columns this call re-declares in full. Rows on any other column are untouchable. */
  fieldIds: readonly string[]
  /** Roles this call re-declares in full. Rows for any other role are untouchable. */
  roleIds: readonly string[]
}

export interface ApplyRoleWriteScopesInput {
  sheetId: string
  entries: Array<StockPreparationRoleWriteScopeEntry>
  /**
   * OPTIONAL pack identity. Present → every row written carries `<base>#<packId>`, and it is the
   * reconcile DELETE's owner predicate. Absent → the pack-less base marker is written, and a
   * `reconcile` region is REFUSED (`ENTRIES_INVALID`): a delete that cannot name its owner cannot
   * satisfy the invariant.
   */
  packId?: string
  /**
   * OPTIONAL. Absent (or `null` / `false` — every falsy value means "not asked for") → purely
   * additive: no DELETE statement is executed at all and `removed` is empty, which is byte-for-byte
   * the behaviour every caller had before this option existed.
   * Present → the same transaction also removes this pack's OWN, still-denying rows inside the
   * region that are not in `entries`. See the file header's invariant.
   */
  reconcile?: RoleWriteScopeReconcileRegion | null | false
  /**
   * MAY THIS PACK ADOPT THE PACK-LESS LEGACY ROWS IN ITS RECTANGLE?
   *
   * `true` ONLY when the caller can PROVE this pack is the only pack ever installed on this sheet —
   * the installer derives it from the pack-install ledger (`listInstalledPackIds`). It is a
   * deliberate parameter rather than a lookup here because `field_permissions` has no pack column
   * and this port has no access to the plugin's ledger; the proof lives with the caller who owns it.
   *
   * Default `false` = "cannot prove it", which makes such rows UNATTRIBUTED and refuses the call.
   * That is the fail-closed direction: before migration 083's backfill, EVERY row every pack ever
   * wrote carries the bare marker, so a permissive default is exactly finding-1's silent cross-pack
   * delete.
   */
  legacyAdoptable?: boolean
}

export interface ApplyRoleWriteScopesResult {
  /**
   * Rows actually WRITTEN — `entries.length` MINUS the declared pairs an operator holds (those are
   * skipped, never overwritten; see `operatorHeld`). Equals `entries.length` on the ordinary path.
   */
  applied: number
  /** The canonical (de-duplicated, order-preserving) entries actually written. */
  entries: Array<StockPreparationRoleWriteScopeEntry>
  /**
   * The denials this call REMOVED — always `[]` without a `reconcile` region. Returned rather than
   * merely dropped so a caller can name every restriction it retired.
   */
  removed: Array<StockPreparationRoleWriteScopeEntry>
  /**
   * Declared pairs an OPERATOR holds: the upsert was SKIPPED for each, so the operator's `visible`
   * and `read_only` stand untouched. `[]` without a region (an additive call classifies nothing and
   * writes every entry). Named so the install can report a decision it deferred to rather than a
   * decision it silently made.
   */
  operatorHeld: Array<RoleWriteScopeOwnedPair>
  /**
   * Rows inside the rectangle carrying ANOTHER pack's marker on pairs this call does NOT declare.
   * Left standing, reported. `[]` without a region.
   */
  governedByOtherPacks: Array<RoleWriteScopeOwnedPair>
}

/** One row of the provenance census: a (column, role) pair THIS port previously denied. */
export interface ListRoleWriteScopesInput {
  sheetId: string
}

/** A census row this plugin wrote, attributed to the pack that wrote it (null = legacy, pack-less). */
export interface RoleWriteScopeCensusEntry extends StockPreparationRoleWriteScopeEntry {
  createdBy: string
  packId: string | null
}

/** A denial on this sheet that this plugin did NOT write. Reported, never claimed, never deleted. */
export interface RoleWriteScopeForeignEntry extends StockPreparationRoleWriteScopeEntry {
  createdBy: string | null
}

export interface ListRoleWriteScopesResult {
  sheetId: string
  /**
   * Every role-scoped write denial on this sheet stamped with a marker of THIS PLUGIN's family,
   * each attributed to the pack that wrote it. A caller diffs its own pack's rows against its plan;
   * another pack's rows are visible here precisely so they can be reported rather than clobbered.
   */
  entries: Array<RoleWriteScopeCensusEntry>
  /**
   * The same query's other half: role-scoped write denials this plugin did NOT write (an operator's
   * own rows, or anything else that ever writes this table). Separated rather than dropped because
   * a caller must be able to say "a human holds this (column, role)" without ever treating it as
   * installer debris — and must never claim or delete it.
   */
  foreignEntries: Array<RoleWriteScopeForeignEntry>
}

export interface FindMissingRoleIdsInput {
  roleIds: readonly string[]
}

export interface FindMissingRoleIdsResult {
  /** The subset of `roleIds` that is NOT a row in `roles`. Sorted; empty means all exist. */
  missing: string[]
}

export interface FindMissingFieldIdsInput {
  sheetId: string
  fieldIds: readonly string[]
}

export interface FindMissingFieldIdsResult {
  /** The subset of `fieldIds` that is NOT a `meta_fields` row FOR THAT sheet. Sorted. */
  missing: string[]
}

/** One classified row inside (or, for `operatorMustClear`, outside) the rectangle. Ids only. */
export interface RoleWriteScopeClassifiedRow extends StockPreparationRoleWriteScopeEntry {
  createdBy: string | null
  /** The pack whose marker the row carries; `null` for a bare legacy marker and for foreign rows. */
  packId: string | null
  owner: RoleWriteScopeOwner
  /** Is this pair in the caller's `entries` (the set this call re-declares)? */
  declared: boolean
  visible: boolean
  readOnly: boolean
}

export interface ClassifyRoleWriteScopeRegionInput {
  sheetId: string
  /** The pairs the caller re-declares. May be empty — "this rectangle should hold no denial". */
  entries: Array<StockPreparationRoleWriteScopeEntry>
  /** REQUIRED: a classification with no pack identity cannot attribute a single row. */
  packId: string
  reconcile: RoleWriteScopeReconcileRegion
  /** See `ApplyRoleWriteScopesInput.legacyAdoptable`. Default `false` (cannot prove). */
  legacyAdoptable?: boolean
}

/**
 * THE ONE CLASSIFICATION. Every projection below is derived from ONE snapshot by ONE function, so a
 * dry-run's answer and an install's answer are the same computation over different moments — never
 * two models of the same rule.
 */
export interface RoleWriteScopeClassification {
  sheetId: string
  packId: string
  legacyAdoptable: boolean
  /** Every role-scoped row inside the rectangle, classified. The raw evidence for everything below. */
  regionRows: RoleWriteScopeClassifiedRow[]
  /** (a)+(c) rows, in-rectangle, still denying, NOT re-declared → exactly what the DELETE removes. */
  willRetire: StockPreparationRoleWriteScopeEntry[]
  /** Declared pairs another pack's marker holds → the `PACK_CONFLICT` refusal. */
  packConflicts: Array<RoleWriteScopeOwnedPair & { packId: string }>
  /** In-rectangle bare-marker rows when `legacyAdoptable` is false → the `LEGACY_UNATTRIBUTED` refusal. */
  legacyUnattributed: StockPreparationRoleWriteScopeEntry[]
  /**
   * In-rectangle OPERATOR rows (marker or NULL). Never changed, never deleted; the upsert is skipped
   * for the `declared: true` ones. `visible`/`readOnly` are carried so a rehearsal can say WHAT the
   * operator decided, not merely that they decided something.
   */
  operatorHeldInRegion: Array<RoleWriteScopeClassifiedRow>
  /** In-rectangle other-pack rows on NO declared pair. Reported; never stale, never deleted. */
  governedByOtherPacks: Array<RoleWriteScopeOwnedPair & { packId: string }>
  /**
   * This pack's OWN (or adoptable legacy) denials OUTSIDE the rectangle that it no longer declares —
   * debris a wider earlier revision left where this call has no authority. Only an operator can
   * clear these, and they are the ONLY thing that belongs on an operator's to-do list.
   */
  operatorMustClear: Array<RoleWriteScopeOwnedPair>
}

/** Minimal query seam — same shape as `multitable/permission-service.ts`'s `QueryFn`. */
export type StockPreparationFieldPermissionsQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** Minimal transaction seam — the one primitive this port needs from the pool. */
export interface StockPreparationFieldPermissionsPool {
  transaction<T>(
    handler: (client: { query: StockPreparationFieldPermissionsQueryFn }) => Promise<T>,
  ): Promise<T>
}

export interface StockPreparationFieldPermissionsServiceDeps {
  /**
   * Optional pool override. Same posture as `GovernedAiService`'s injected client: production
   * constructs the service with NO arguments and the pool is resolved LAZILY per call via
   * `poolManager.get()` (matching every other `poolManager.get().transaction(...)` call site in
   * index.ts, so construction order never matters); tests inject a fake.
   */
  pool?: StockPreparationFieldPermissionsPool
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Shape validation + de-duplication. Throws ENTRIES_INVALID; never touches the database.
 *
 * Deliberately a MODULE-LEVEL function, not a private method: the class prototype carries exactly
 * the port's PUBLIC surface — one mutating method (`applyRoleWriteScopes`) and four read-only ones
 * (`classifyRoleWriteScopeRegion`, `listRoleWriteScopes`, `findMissingRoleIds`,
 * `findMissingFieldIds`) — and a unit witness enumerates it, because TypeScript's `private` is
 * erased at runtime and would leave extra callable members behind.
 */
function normalizeInput(input: ApplyRoleWriteScopesInput): {
  sheetId: string
  entries: StockPreparationRoleWriteScopeEntry[]
  packId: string | null
  reconcile: { fieldIds: string[]; roleIds: string[] } | null
  legacyAdoptable: boolean
} {
  if (!input || typeof input !== 'object') {
    throw new StockPreparationFieldPermissionsError('ENTRIES_INVALID', 'Input must be an object')
  }
  if (!isNonEmptyString(input.sheetId)) {
    throw new StockPreparationFieldPermissionsError(
      'ENTRIES_INVALID',
      'sheetId must be a non-empty string',
    )
  }
  if (!Array.isArray(input.entries)) {
    throw new StockPreparationFieldPermissionsError('ENTRIES_INVALID', 'entries must be an array')
  }
  if (input.entries.length > STOCK_PREPARATION_FIELD_PERMISSION_MAX_ENTRIES) {
    throw new StockPreparationFieldPermissionsError(
      'ENTRIES_INVALID',
      `entries exceeds the cap of ${STOCK_PREPARATION_FIELD_PERMISSION_MAX_ENTRIES} (got ${input.entries.length})`,
    )
  }

  const seen = new Set<string>()
  const entries: StockPreparationRoleWriteScopeEntry[] = []
  for (const [index, raw] of input.entries.entries()) {
    if (!raw || typeof raw !== 'object') {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entries[${index}] must be an object`,
      )
    }
    const { fieldId, roleId } = raw as { fieldId?: unknown; roleId?: unknown }
    if (!isNonEmptyString(fieldId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entries[${index}].fieldId must be a non-empty string`,
      )
    }
    if (!isNonEmptyString(roleId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entries[${index}].roleId must be a non-empty string`,
      )
    }
    const key = `${fieldId} ${roleId}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ fieldId, roleId })
  }
  // The pack id is a provenance token, not an addressable key: it must be a clean single segment so
  // `<base>#<packId>` stays parseable in both directions.
  let packId: string | null = null
  if (input.packId !== undefined && input.packId !== null) {
    if (!isNonEmptyString(input.packId) || input.packId.includes('#')) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'packId must be a non-empty string containing no "#"',
      )
    }
    packId = input.packId.trim()
  }
  const reconcile = normalizeReconcile(input.reconcile, entries)
  // A RECONCILE WITHOUT A PACK IDENTITY IS UNATTRIBUTABLE, so it is refused rather than run under
  // the bare marker. Before this, `packId` absent meant the DELETE's owner predicate collapsed to
  // the single plugin-wide legacy marker — the exact predicate under which one pack retires
  // another's rows. There is no legitimate caller: the installer always names its pack, and an
  // additive call (no region) is untouched by this rule.
  if (reconcile && packId === null) {
    throw new StockPreparationFieldPermissionsError(
      'ENTRIES_INVALID',
      'reconcile requires a packId: a scoped delete must be attributable to the pack issuing it',
    )
  }
  return {
    sheetId: input.sheetId,
    entries,
    packId,
    reconcile,
    legacyAdoptable: input.legacyAdoptable === true,
  }
}

/**
 * Validate the reconcile region. Absent → `null`, and no DELETE is executed.
 *
 * The containment check is the load-bearing half: every entry being written must lie inside the
 * region, so the region can never be a set of columns/roles the same call is not re-declaring. A
 * caller that wants to write outside the region must widen the region — which is exactly the
 * statement "I am authoritative here" made explicit rather than assumed.
 */
function normalizeReconcile(
  reconcile: RoleWriteScopeReconcileRegion | null | false | undefined,
  entries: readonly StockPreparationRoleWriteScopeEntry[],
): { fieldIds: string[]; roleIds: string[] } | null {
  // EVERY falsy value means "no region asked for" — `undefined`, `null` and `false` alike. A caller
  // expressing "additive only" as a boolean must land on the additive path, not on a 422 over a
  // sheet whose columns were already created.
  if (!reconcile) return null
  if (typeof reconcile !== 'object') {
    throw new StockPreparationFieldPermissionsError('ENTRIES_INVALID', 'reconcile must be an object')
  }
  const readIds = (raw: unknown, name: string): string[] => {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `reconcile.${name} must be a non-empty array`,
      )
    }
    for (const value of raw) {
      if (!isNonEmptyString(value)) {
        throw new StockPreparationFieldPermissionsError(
          'ENTRIES_INVALID',
          `every reconcile.${name} entry must be a non-empty string`,
        )
      }
    }
    return [...new Set(raw as string[])]
  }
  const fieldIds = readIds(reconcile.fieldIds, 'fieldIds')
  const roleIds = readIds(reconcile.roleIds, 'roleIds')

  const fieldSet = new Set(fieldIds)
  const roleSet = new Set(roleIds)
  for (const entry of entries) {
    if (!fieldSet.has(entry.fieldId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entry field ${entry.fieldId} is outside the declared reconcile region`,
        [entry.fieldId],
      )
    }
    if (!roleSet.has(entry.roleId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entry role ${entry.roleId} is outside the declared reconcile region`,
        [entry.roleId],
      )
    }
  }
  return { fieldIds, roleIds }
}

/**
 * THE ONE SNAPSHOT the classification reads: EVERY role-scoped row on the sheet, both dimensions.
 *
 * `read_only = true` is deliberately NOT in this predicate, though it IS in `listRoleWriteScopes`'s.
 * An operator row that HIDES a column (read denied, write allowed) is not a write denial, but it is
 * very much an operator decision on a (column, role) pair — and the upsert used to raise its read
 * dimension back to the shared default without the rehearsal ever mentioning it. A classification that cannot
 * see the row cannot skip the pair, so the filter belongs in the classifier, per projection, not in
 * the query.
 */
const ROLE_WRITE_SCOPE_SNAPSHOT_SQL =
  `SELECT field_id, subject_id, created_by, visible, read_only FROM field_permissions
    WHERE sheet_id = $1 AND subject_type = 'role'
    ORDER BY field_id, subject_id`

/** One raw snapshot row, decoded. */
export interface RoleWriteScopeSnapshotRow {
  fieldId: string
  roleId: string
  createdBy: string | null
  visible: boolean
  readOnly: boolean
}

function decodeSnapshotRows(rows: readonly unknown[]): RoleWriteScopeSnapshotRow[] {
  return (rows as Array<Record<string, unknown>>).map((raw) => ({
    fieldId: String(raw.field_id),
    roleId: String(raw.subject_id),
    createdBy: typeof raw.created_by === 'string' ? raw.created_by : null,
    visible: raw.visible !== false,
    readOnly: raw.read_only === true,
  }))
}

function byPair(
  left: StockPreparationRoleWriteScopeEntry,
  right: StockPreparationRoleWriteScopeEntry,
): number {
  return left.fieldId === right.fieldId
    ? left.roleId.localeCompare(right.roleId)
    : left.fieldId.localeCompare(right.fieldId)
}

const pairKey = (entry: StockPreparationRoleWriteScopeEntry): string =>
  `${entry.fieldId} ${entry.roleId}`

/**
 * ═══ THE INVARIANT, AS CODE. ═══
 *
 * PURE: no database, no clock, no I/O. It takes the snapshot and answers every question the write
 * path and the rehearsal path both ask, so those two paths cannot hold different beliefs about the
 * same sheet. `applyRoleWriteScopes` calls it INSIDE its transaction (after the `meta_sheets`
 * FOR UPDATE, so the snapshot is stable against the operator route); `classifyRoleWriteScopeRegion`
 * calls it outside one. Same function, same rules, one place to change them.
 *
 * Read the file header's invariant before touching the `owner` ladder below — it is the whole of
 * the ownership decision, and every projection is a filter over it.
 */
export function classifyRoleWriteScopeRows(input: {
  sheetId: string
  packId: string
  entries: readonly StockPreparationRoleWriteScopeEntry[]
  region: { fieldIds: readonly string[]; roleIds: readonly string[] }
  legacyAdoptable: boolean
  rows: readonly RoleWriteScopeSnapshotRow[]
}): RoleWriteScopeClassification {
  const fieldSet = new Set(input.region.fieldIds)
  const roleSet = new Set(input.region.roleIds)
  const declaredKeys = new Set(input.entries.map(pairKey))

  const regionRows: RoleWriteScopeClassifiedRow[] = []
  const willRetire: StockPreparationRoleWriteScopeEntry[] = []
  const packConflicts: Array<RoleWriteScopeOwnedPair & { packId: string }> = []
  const legacyUnattributed: StockPreparationRoleWriteScopeEntry[] = []
  const operatorHeldInRegion: RoleWriteScopeClassifiedRow[] = []
  const governedByOtherPacks: Array<RoleWriteScopeOwnedPair & { packId: string }> = []
  const operatorMustClear: RoleWriteScopeOwnedPair[] = []

  for (const row of input.rows) {
    const parsed = parseStockPreparationFieldPermissionCreatedBy(row.createdBy)
    // THE OWNER LADDER — five members, closed, in the order the header states them. `operator` is
    // FIRST because it is the catch-all: NULL (the only shape the authoring route wrote before it
    // started stamping), the `operator:` marker, and anything else no plugin marker matches.
    let owner: RoleWriteScopeOwner
    if (!parsed.isPluginRow) owner = 'operator'
    else if (parsed.packId === null) owner = input.legacyAdoptable ? 'legacy_adoptable' : 'legacy_unattributed'
    else if (parsed.packId === input.packId) owner = 'this_pack'
    else owner = 'other_pack'

    const declared = declaredKeys.has(pairKey(row))
    const inRegion = fieldSet.has(row.fieldId) && roleSet.has(row.roleId)

    if (!inRegion) {
      // OUTSIDE THE RECTANGLE this call has no authority at all, so exactly one question matters:
      // is this THIS pack's own debris? A row of anybody else's — another pack's, an operator's, or
      // an unattributable legacy row — is none of this pack's business and is not reported as
      // stale, because nothing in this declaration establishes that it is wrong.
      // (`declared` is false here by construction: `normalizeReconcile` requires entries ⊆ region.)
      if ((owner === 'this_pack' || owner === 'legacy_adoptable') && row.readOnly && !declared) {
        operatorMustClear.push({ fieldId: row.fieldId, roleId: row.roleId, packId: parsed.packId })
      }
      continue
    }

    const classified: RoleWriteScopeClassifiedRow = {
      fieldId: row.fieldId,
      roleId: row.roleId,
      createdBy: row.createdBy,
      packId: parsed.packId,
      owner,
      declared,
      visible: row.visible,
      readOnly: row.readOnly,
    }
    regionRows.push(classified)

    if (owner === 'operator') {
      // NEVER changed, NEVER deleted, upsert skipped when declared. Reported either way.
      operatorHeldInRegion.push(classified)
    } else if (owner === 'legacy_unattributed') {
      // Cannot be proven to belong to this pack OR to another one. Refused, not guessed.
      legacyUnattributed.push({ fieldId: row.fieldId, roleId: row.roleId })
    } else if (owner === 'other_pack') {
      const other = parsed.packId as string
      if (declared) packConflicts.push({ fieldId: row.fieldId, roleId: row.roleId, packId: other })
      else governedByOtherPacks.push({ fieldId: row.fieldId, roleId: row.roleId, packId: other })
    } else if (!declared && row.readOnly) {
      // (a)/(c) + in-rectangle + still denying + no longer declared = the DELETE's whole row set.
      willRetire.push({ fieldId: row.fieldId, roleId: row.roleId })
    }
  }

  regionRows.sort(byPair)
  willRetire.sort(byPair)
  packConflicts.sort(byPair)
  legacyUnattributed.sort(byPair)
  operatorHeldInRegion.sort(byPair)
  governedByOtherPacks.sort(byPair)
  operatorMustClear.sort(byPair)

  return {
    sheetId: input.sheetId,
    packId: input.packId,
    legacyAdoptable: input.legacyAdoptable,
    regionRows,
    willRetire,
    packConflicts,
    legacyUnattributed,
    operatorHeldInRegion,
    governedByOtherPacks,
    operatorMustClear,
  }
}

/**
 * The two REFUSALS the invariant makes, raised from the classification in a fixed order so a
 * rehearsal and a write always name the same blocker first. Shared by the pre-flight rehearsal (via
 * the installer) and by the in-transaction re-check, which is what makes them the same refusal.
 */
export function assertRoleWriteScopeClassificationInstallable(
  classification: RoleWriteScopeClassification,
): void {
  if (classification.packConflicts.length > 0) {
    const others = [...new Set(classification.packConflicts.map((row) => row.packId))].sort()
    throw new StockPreparationFieldPermissionsError(
      'PACK_CONFLICT',
      `another customer pack governs ${classification.packConflicts.length} declared (column, role) `
        + `pair(s) inside this pack's region: ${others.join(', ')}`,
      others,
      classification.packConflicts,
    )
  }
  if (classification.legacyUnattributed.length > 0) {
    throw new StockPreparationFieldPermissionsError(
      'LEGACY_UNATTRIBUTED',
      `${classification.legacyUnattributed.length} pack-less write-scope row(s) inside this pack's `
        + 'region cannot be attributed to any pack; run the one-time backfill (migration 083) or '
        + 'clear them before installing',
      [],
      classification.legacyUnattributed,
    )
  }
}

/**
 * The 备料 host capability: declare, per ROLE, which columns that role may NOT WRITE.
 *
 * Read the file header before changing anything here — in particular the load-bearing
 * write-only property.
 */
export class StockPreparationFieldPermissionsService {
  /**
   * CAPABILITY MARKER, not a feature flag. A duck-typed consumer cannot otherwise tell a host that
   * HONOURS `reconcile` from one that silently ignores it — and the difference is a rehearsal that
   * promises removals from one that promises nothing. Absent on every older host, so a consumer that
   * checks it degrades explicitly instead of assuming.
   */
  readonly supportsWriteScopeReconcile = true as const

  private readonly injectedPool?: StockPreparationFieldPermissionsPool

  constructor(deps: StockPreparationFieldPermissionsServiceDeps = {}) {
    this.injectedPool = deps.pool
  }

  /**
   * THE ONLY entry point. Each entry means "this ROLE may NOT WRITE this column".
   *
   * Fail-closed and all-or-nothing: sheet, every field and every role are validated INSIDE the
   * transaction BEFORE the first INSERT, and a single bad entry aborts the whole call with nothing
   * written. Idempotent: re-running with the same entries upserts the same rows.
   */
  async applyRoleWriteScopes(input: ApplyRoleWriteScopesInput): Promise<ApplyRoleWriteScopesResult> {
    const { sheetId, entries, packId, reconcile, legacyAdoptable } = normalizeInput(input)
    // NOTHING TO WRITE AND NO REGION is the one total no-op: no statement of any kind runs. It adds
    // no restriction and removes none, so it can never be the unsafe direction in either sense.
    //
    // NOTHING TO WRITE **WITH** A REGION IS NOT A NO-OP, and treating it as one was a real silent
    // failure: a pack revision that hands every governed column to every declared role derives ZERO
    // denials, so an entries-empty call is exactly how "this rectangle should now hold no denial at
    // all" is expressed. Short-circuiting it left the previous revision's rows in force and locked
    // those columns for every role the new revision names as their owner.
    if (entries.length === 0 && !reconcile) {
      return { applied: 0, entries: [], removed: [], operatorHeld: [], governedByOtherPacks: [] }
    }

    /** What this call stamps, and — with the legacy marker — the whole of what it may retire. */
    const createdBy = stockPreparationFieldPermissionCreatedBy(packId)

    const pool = this.injectedPool ?? (poolManager.get() as unknown as StockPreparationFieldPermissionsPool)

    // ONE transaction for validation + every write.
    return pool.transaction(async ({ query }) => {
      // Existence check AND the never-escalate-under-concurrency row lock in one statement — the
      // SAME `meta_sheets` lock the operator authoring route and the permission-revert path take, so
      // this write serializes against a concurrent revert instead of racing it.
      const sheetRes = await query('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE', [sheetId])
      if (sheetRes.rows.length === 0) {
        throw new StockPreparationFieldPermissionsError(
          'SHEET_NOT_FOUND',
          `Sheet not found: ${sheetId}`,
          [sheetId],
        )
      }

      const fieldIds = [...new Set(entries.map((entry) => entry.fieldId))]
      const fieldRes = await query(
        'SELECT id FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])',
        [sheetId, fieldIds],
      )
      const knownFieldIds = new Set(
        (fieldRes.rows as Array<{ id?: unknown }>).map((row) => String(row.id)),
      )
      const missingFieldIds = fieldIds.filter((fieldId) => !knownFieldIds.has(fieldId))
      if (missingFieldIds.length > 0) {
        throw new StockPreparationFieldPermissionsError(
          'FIELD_NOT_ON_SHEET',
          `Field(s) not on sheet ${sheetId}: ${missingFieldIds.join(', ')}`,
          missingFieldIds,
        )
      }

      const roleIds = [...new Set(entries.map((entry) => entry.roleId))]
      const roleRes = await query('SELECT id FROM roles WHERE id = ANY($1::text[])', [roleIds])
      const knownRoleIds = new Set(
        (roleRes.rows as Array<{ id?: unknown }>).map((row) => String(row.id)),
      )
      const missingRoleIds = roleIds.filter((roleId) => !knownRoleIds.has(roleId))
      if (missingRoleIds.length > 0) {
        throw new StockPreparationFieldPermissionsError(
          'ROLE_NOT_FOUND',
          `Role(s) not found: ${missingRoleIds.join(', ')}`,
          missingRoleIds,
        )
      }

      // ═══ THE CLASSIFICATION, INSIDE THE TRANSACTION AND AFTER THE ROW LOCK. ═══
      //
      // ATOMICITY IS THE POINT. The installer also runs this classification in its PRE-FLIGHT, over
      // an untouched sheet, so a conflict refuses before the first column is created. But that check
      // and this write used to sit in different transactions with every host DDL step in between —
      // so two concurrent installs each passed their own pre-flight and then coexisted, unrefused
      // (round-2 finding 18). Re-running it HERE, under the `meta_sheets FOR UPDATE` taken above
      // (the same lock the operator authoring route takes), makes the verdict and the write one
      // indivisible act: the loser of the race aborts and rolls back rather than merging.
      let classification: RoleWriteScopeClassification | null = null
      let writeEntries: StockPreparationRoleWriteScopeEntry[] = entries
      if (reconcile) {
        const snapshot = await query(ROLE_WRITE_SCOPE_SNAPSHOT_SQL, [sheetId])
        classification = classifyRoleWriteScopeRows({
          sheetId,
          packId: packId as string, // normalizeInput refuses a region without one
          entries,
          region: reconcile,
          legacyAdoptable,
          rows: decodeSnapshotRows(snapshot.rows),
        })
        // Both refusals are raised BEFORE the first INSERT of this call, so a refused install leaves
        // `field_permissions` exactly as it found it (and the surrounding transaction rolls back
        // anything the same call had done earlier — there is nothing).
        assertRoleWriteScopeClassificationInstallable(classification)
        // OPERATOR DECISIONS WIN. A declared pair a human holds is dropped from the write set
        // entirely rather than upserted with a guard: the pair never reaches the statement, so the
        // operator's `visible` and `read_only` are not merely preserved by a CASE — they are not
        // addressed at all. The caller gets the pairs back and names them.
        const operatorHeldKeys = new Set(
          classification.operatorHeldInRegion.filter((row) => row.declared).map(pairKey),
        )
        if (operatorHeldKeys.size > 0) {
          writeEntries = entries.filter((entry) => !operatorHeldKeys.has(pairKey(entry)))
        }
      }

      for (const entry of writeEntries) {
        // WRITE-ONLY SCOPE. `visible` is the hardcoded literal `true` in the VALUES list — it is not
        // a bind parameter and never can be a caller's choice. The five bind parameters are
        // (sheet_id, field_id, subject_id, created_by, legacy_marker); `subject_type`, `visible` and
        // `read_only` are literals. See the file header's load-bearing property before touching this
        // statement.
        //
        // NOTHING ABOUT A ROW THIS PORT DOES NOT OWN IS REWRITTEN — not its provenance, not its read
        // dimension, not its write dimension. All three DO UPDATE columns share ONE guard: the row's
        // current `created_by` must already be one of the two markers this port may also retire
        // (this pack's own, and the pack-less LEGACY marker). An unconditional
        // `created_by = EXCLUDED.created_by` laundered an OPERATOR's row into a plugin row the moment
        // a pack re-declared the same (column, role); an unconditional re-assertion of the read
        // dimension silently un-hid a column an operator had hidden; an unconditional
        // `read_only = true` created a denial on a foreign row that the reconcile could then never
        // retire. `created_by` NULL — the
        // only shape the authoring route wrote before it started stamping — fails `IN ($4, $5)` and
        // therefore takes the ELSE branch on all three columns.
        //
        // On the RECONCILE path the guard is provably a no-op: every pair still in `writeEntries` is
        // this pack's, adoptable legacy, or absent — the classification above removed the rest. The
        // guard is what protects the ADDITIVE path, which classifies nothing.
        await query(
          `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
           VALUES ($1, $2, 'role', $3, true, true, $4)
           ON CONFLICT (sheet_id, field_id, subject_type, subject_id)
           DO UPDATE SET
             visible = CASE WHEN field_permissions.created_by IN ($4, $5) THEN true ELSE field_permissions.visible END,
             read_only = CASE WHEN field_permissions.created_by IN ($4, $5) THEN true ELSE field_permissions.read_only END,
             created_by = CASE WHEN field_permissions.created_by IN ($4, $5) THEN $4 ELSE field_permissions.created_by END`,
          [
            sheetId,
            entry.fieldId,
            entry.roleId,
            createdBy,
            STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
          ],
        )
      }

      // THE SCOPED RECONCILE. Same transaction as the upserts above, so there is no instant at which
      // a denial has been dropped but its replacement not yet written. Read the file header's five
      // narrowings before touching this statement — each `AND` is one of them:
      //   sheet_id    → never another sheet (the ONLY project/tenant bound this table can carry);
      //   created_by  → never an operator's row, never another PACK's row, and never a pack-less
      //                 LEGACY row unless the caller PROVED this pack is the sheet's only pack;
      //   read_only   → never a row an operator relaxed;
      //   field_id/subject_id = ANY(region) → never outside what this call re-declares in full;
      //   NOT EXISTS(desired) → never a row this same call just wrote.
      // `visible` appears nowhere here either: removing a row can only widen access, never hide.
      const removed: StockPreparationRoleWriteScopeEntry[] = []
      if (reconcile && classification) {
        const removedRes = await query(
          `DELETE FROM field_permissions
            WHERE sheet_id = $1
              AND subject_type = 'role'
              AND created_by = ANY($2::text[])
              AND read_only = true
              AND field_id = ANY($3::text[])
              AND subject_id = ANY($4::text[])
              AND NOT EXISTS (
                SELECT 1 FROM unnest($5::text[], $6::text[]) AS desired(field_id, subject_id)
                 WHERE desired.field_id = field_permissions.field_id
                   AND desired.subject_id = field_permissions.subject_id
              )
            RETURNING field_id, subject_id`,
          [
            sheetId,
            // EXACTLY what this call is entitled to retire. Its own pack's marker ALWAYS; the
            // pack-less LEGACY marker ONLY when the caller proved this pack is the only pack ever
            // installed on this sheet (`legacyAdoptable`). Before that condition existed, every row
            // every pack had ever written carried the bare marker — the pack id lands in
            // `created_by` only as of this change — so an unconditional legacy arm was a licence for
            // pack B to retire pack A's live denials (round-2 finding 1). A sibling pack's rows
            // carry `<base>#<other>` and are unreachable in either case.
            legacyAdoptable
              ? [...new Set([createdBy, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY])]
              : [createdBy],
            reconcile.fieldIds,
            reconcile.roleIds,
            entries.map((entry) => entry.fieldId),
            entries.map((entry) => entry.roleId),
          ],
        )
        for (const row of removedRes.rows as Array<{ field_id?: unknown; subject_id?: unknown }>) {
          removed.push({ fieldId: String(row.field_id), roleId: String(row.subject_id) })
        }
        removed.sort(byPair)

        // ═══ THE STATEMENT IS CHECKED AGAINST THE INVARIANT, NOT MERELY WRITTEN TO MATCH IT. ═══
        //
        // `willRetire` was computed by the pure classifier from the SAME locked snapshot, so the two
        // must agree exactly. They disagree only if one of the five narrowings has been widened,
        // dropped or CROSS-WIRED — swapping the NOT EXISTS correlation to
        // `desired.field_id = field_permissions.subject_id` makes the delete reach the rows it just
        // wrote, which no non-realdb test could otherwise see (round-2 finding 4). A mismatch is an
        // internal breach, so it ABORTS the transaction rather than reporting a delete nobody asked
        // for: the sheet is left exactly as it was found.
        const expected = classification.willRetire
        const diverged = removed.length !== expected.length
          || removed.some((row, index) => row.fieldId !== expected[index].fieldId
            || row.roleId !== expected[index].roleId)
        if (diverged) {
          throw new StockPreparationFieldPermissionsError(
            'RECONCILE_DIVERGED',
            `reconcile deleted ${removed.length} row(s) where the classification authorised `
              + `${expected.length}; the scoped DELETE no longer matches the invariant`,
            [],
            removed,
          )
        }
      }

      return {
        applied: writeEntries.length,
        entries: writeEntries,
        removed,
        operatorHeld: classification
          ? classification.operatorHeldInRegion
            .filter((row) => row.declared)
            .map((row) => ({ fieldId: row.fieldId, roleId: row.roleId, packId: row.packId }))
          : [],
        governedByOtherPacks: classification
          ? classification.governedByOtherPacks.map((row) => ({ ...row }))
          : [],
      }
    })
  }

  /**
   * THE REHEARSAL OF THE INVARIANT — the same `classifyRoleWriteScopeRows` over the same snapshot
   * query, outside a transaction. READ-ONLY: one `SELECT`, no lock, no write.
   *
   * This is what makes "rehearsal = reality" a property rather than a promise. A dry-run does not
   * model what the install will decide; it runs the install's decision function on the sheet as it
   * stands. The only difference between this answer and the write path's is the moment it was taken,
   * which is exactly why the write path re-runs it under the row lock.
   */
  async classifyRoleWriteScopeRegion(
    input: ClassifyRoleWriteScopeRegionInput,
  ): Promise<RoleWriteScopeClassification> {
    if (!input || !isNonEmptyString(input.sheetId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'sheetId must be a non-empty string',
      )
    }
    if (!isNonEmptyString(input.packId) || input.packId.includes('#')) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'packId must be a non-empty string containing no "#"',
      )
    }
    // The SAME shape validation the write path runs, including entries ⊆ region — a rehearsal of a
    // region the write path would reject is not a rehearsal.
    const normalized = normalizeInput({
      sheetId: input.sheetId,
      entries: Array.isArray(input.entries) ? input.entries : [],
      packId: input.packId,
      reconcile: input.reconcile,
      legacyAdoptable: input.legacyAdoptable,
    })
    if (!normalized.reconcile) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'reconcile region is required to classify a region',
      )
    }
    const region = normalized.reconcile
    const pool = this.injectedPool ?? (poolManager.get() as unknown as StockPreparationFieldPermissionsPool)
    return pool.transaction(async ({ query }) => {
      const snapshot = await query(ROLE_WRITE_SCOPE_SNAPSHOT_SQL, [input.sheetId])
      return classifyRoleWriteScopeRows({
        sheetId: normalized.sheetId,
        packId: normalized.packId as string,
        entries: normalized.entries,
        region,
        legacyAdoptable: normalized.legacyAdoptable,
        rows: decodeSnapshotRows(snapshot.rows),
      })
    })
  }

  /**
   * THE PROVENANCE CENSUS, in-process: every (column, role) pair THIS port has ever denied on this
   * sheet. READ-ONLY — one `SELECT`, no lock, no write.
   *
   * TWO PROJECTIONS, ONE SELECT. `entries` is what THIS PLUGIN wrote, each row attributed to the
   * pack whose marker it carries (`packId: null` = a legacy, pack-less row). `foreignEntries` is
   * every other role-scoped denial on the sheet — an operator's own rows above all. They are
   * separated rather than merged because a caller must be able to say "a human holds this
   * (column, role)" without ever treating a deliberate operator decision as installer debris, and
   * must never claim or delete it; and they are separated rather than dropped because a caller that
   * cannot see them cannot report them either.
   *
   * `read_only = true` is part of the predicate: a row this port wrote and an operator later
   * relaxed is no longer a write denial, so it is in neither list.
   */
  async listRoleWriteScopes(input: ListRoleWriteScopesInput): Promise<ListRoleWriteScopesResult> {
    if (!input || !isNonEmptyString(input.sheetId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'sheetId must be a non-empty string',
      )
    }
    const sheetId = input.sheetId
    const pool = this.injectedPool ?? (poolManager.get() as unknown as StockPreparationFieldPermissionsPool)
    return pool.transaction(async ({ query }) => {
      // ONE SELECT, two projections. Every role-scoped write denial on the sheet is read, then split
      // by provenance in JS rather than by a second query — so "what this plugin wrote" and "what
      // somebody else wrote" are answered from the SAME snapshot and cannot disagree.
      const res = await query(
        `SELECT field_id, subject_id, created_by FROM field_permissions
          WHERE sheet_id = $1 AND subject_type = 'role' AND read_only = true
          ORDER BY field_id, subject_id`,
        [sheetId],
      )
      const entries: RoleWriteScopeCensusEntry[] = []
      const foreignEntries: RoleWriteScopeForeignEntry[] = []
      for (const raw of res.rows as Array<{ field_id?: unknown; subject_id?: unknown; created_by?: unknown }>) {
        const fieldId = String(raw.field_id)
        const roleId = String(raw.subject_id)
        const { isPluginRow, packId } = parseStockPreparationFieldPermissionCreatedBy(raw.created_by)
        if (isPluginRow) {
          entries.push({ fieldId, roleId, createdBy: String(raw.created_by), packId })
        } else {
          foreignEntries.push({
            fieldId,
            roleId,
            createdBy: typeof raw.created_by === 'string' ? raw.created_by : null,
          })
        }
      }
      return { sheetId, entries, foreignEntries }
    })
  }

  /**
   * "Which of these role ids does this host NOT have?" READ-ONLY — one `SELECT`, no lock, no write.
   *
   * Same question `applyRoleWriteScopes` answers internally (ROLE_NOT_FOUND), exposed so a caller
   * can ask it BEFORE it starts creating columns rather than discovering it after. An empty input
   * is a no-op that returns no missing ids.
   */
  async findMissingRoleIds(input: FindMissingRoleIdsInput): Promise<FindMissingRoleIdsResult> {
    if (!input || !Array.isArray(input.roleIds)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'roleIds must be an array',
      )
    }
    const roleIds = [...new Set(input.roleIds)]
    for (const roleId of roleIds) {
      if (!isNonEmptyString(roleId)) {
        throw new StockPreparationFieldPermissionsError(
          'ENTRIES_INVALID',
          'every roleId must be a non-empty string',
        )
      }
    }
    if (roleIds.length === 0) return { missing: [] }

    const pool = this.injectedPool ?? (poolManager.get() as unknown as StockPreparationFieldPermissionsPool)
    return pool.transaction(async ({ query }) => {
      const res = await query('SELECT id FROM roles WHERE id = ANY($1::text[])', [roleIds])
      const known = new Set((res.rows as Array<{ id?: unknown }>).map((row) => String(row.id)))
      return { missing: roleIds.filter((roleId) => !known.has(roleId)).sort() }
    })
  }

  /**
   * "Which of these column ids is NOT on this sheet?" READ-ONLY — one `SELECT`, no lock, no write.
   *
   * The role twin of `findMissingRoleIds`, and it exists for exactly the same reason. The pre-flight
   * got a role check but no FIELD check, so a pack naming a column the sheet does not have still
   * reached `FIELD_NOT_ON_SHEET` from `applyRoleWriteScopes` — which runs LAST, after every host
   * column has been created, stamped and view-wired (round-2 finding 19). The caller asks this about
   * the half of its region it does NOT create itself (the frozen template band); the columns it is
   * about to create are its own business and cannot be pre-checked.
   */
  async findMissingFieldIds(input: FindMissingFieldIdsInput): Promise<FindMissingFieldIdsResult> {
    if (!input || !isNonEmptyString(input.sheetId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'sheetId must be a non-empty string',
      )
    }
    if (!Array.isArray(input.fieldIds)) {
      throw new StockPreparationFieldPermissionsError('ENTRIES_INVALID', 'fieldIds must be an array')
    }
    const fieldIds = [...new Set(input.fieldIds)]
    for (const fieldId of fieldIds) {
      if (!isNonEmptyString(fieldId)) {
        throw new StockPreparationFieldPermissionsError(
          'ENTRIES_INVALID',
          'every fieldId must be a non-empty string',
        )
      }
    }
    if (fieldIds.length === 0) return { missing: [] }

    const sheetId = input.sheetId
    const pool = this.injectedPool ?? (poolManager.get() as unknown as StockPreparationFieldPermissionsPool)
    return pool.transaction(async ({ query }) => {
      // The SAME statement applyRoleWriteScopes runs inside its transaction, so "the pre-flight said
      // yes" and "the write agreed" cannot come apart on the shape of the question.
      const res = await query(
        'SELECT id FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])',
        [sheetId, fieldIds],
      )
      const known = new Set((res.rows as Array<{ id?: unknown }>).map((row) => String(row.id)))
      return { missing: fieldIds.filter((fieldId) => !known.has(fieldId)).sort() }
    })
  }
}
