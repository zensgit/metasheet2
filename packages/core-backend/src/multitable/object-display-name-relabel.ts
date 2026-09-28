/**
 * RELABEL A PROVISIONED OBJECT'S DISPLAY NAMES — compare-and-set, audited, one transaction.
 *
 * WHY THIS EXISTS. A plugin-managed table gets its human names exactly once, when `ensureObject`
 * creates it (the stock-preparation templates pick English or Chinese at that moment). An object
 * that already exists is never re-described: `ensureFields` refuses a destructive reconcile by
 * default, and the plugin's own ensure paths return "already ready" before any write. So a
 * deployment whose managed tables were created in English has had exactly two ways to get Chinese
 * headers: an operator renaming them one by one in the grid, or someone running SQL against the
 * database. The first deployment did the second, for 66 headers and 4 sheet names — which is
 * precisely the unaudited write this module exists to make unnecessary.
 *
 * WHAT IT IS. A narrow sibling of the HTTP rename paths (`PATCH /fields/:fieldId` and
 * `PATCH /sheets/:sheetId` in routes/univer-meta.ts), for a caller that has no HTTP request:
 *
 *   - the SAME writer fence first (`fenceWriterEntry`), so a relabel cannot interleave with a
 *     recovery that is hashing or applying one schema generation;
 *   - the SAME display-name hygiene gate (`checkDisplayNameHygiene`), checked for every requested
 *     name BEFORE any write, so a malformed target costs nothing and lands nowhere;
 *   - the SAME history row per change (`recordConfigRevision`, diffed with `fieldUpdateDiff` /
 *     `configUpdateDiff`), written with the mutation's own transaction `query`, so every rename
 *     shows up in the sheet's config history.
 *
 * REVERTIBILITY — STATED EXACTLY, because "it is in the config history" is not the same claim as
 * "it can be undone from there" (config-restore.ts `classifyRevert`):
 *   - a FIELD rename writes an `entity_type: 'field'` revision whose only changed key is `name`,
 *     which is in the v1 SAFE revert subset — it CAN be reverted from the config history;
 *   - a SHEET rename writes an `entity_type: 'sheet_config'` revision, and every sheet_config revert
 *     except the Tier-1 read-rule keys is GATED (422 RESTORE_NOT_SUPPORTED) — it is RECORDED but
 *     CANNOT be reverted from there. The way back is renaming the sheet by hand.
 *
 * DEFAULT OFF. The WRITE leg runs only when `MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED` is exactly
 * the string 'true' (no trim, no case folding — the charter's exact-literal rule). Renaming the
 * customer's production managed tables is an owner-level action, so the switch lives with the
 * operator, and it is enforced HERE, at the one place that writes, not only in the route that calls
 * it. The dry run is not gated: it writes nothing and is how the owner sees what enabling would do.
 *
 * PREVIEW == APPLY. A dry run answers a `planDigest` over exactly the renames it would perform. The
 * write leg REQUIRES the caller's `expectedPlanDigest` and recomputes the plan inside its own locked
 * transaction; if the two differ it refuses (MULTITABLE_RELABEL_PLAN_CHANGED) before any write. So
 * nothing is ever written that the admin did not see in the preview.
 *
 * WHAT IT DELIBERATELY IS NOT. It changes `name` and nothing else. A rename-only PATCH re-normalises
 * and re-writes the field's `property`; this does not touch `property`, `type`, `order` or any
 * `field_permissions` row, so the field's id, configuration and permissions are byte-identical
 * afterwards. Automation conditions, views and plugin code address fields by id, never by name.
 *
 * THE COMPARE-AND-SET RULE — what makes it safe to run against a table a human has already edited:
 *
 *   current name === target name     -> already_target        (nothing to do; this is idempotency)
 *   current name !== expected name   -> skipped_name_changed  (a person renamed it; never overwrite)
 *   target name held by another      -> skipped_name_taken    (`meta_fields` has no unique
 *     field on this sheet, or asked                           (sheet_id, name) index, so this is
 *     for by another entry                                    the only thing preventing duplicates)
 *   no such field                    -> missing
 *   otherwise                        -> would_rename (dry run) / renamed (apply)
 *
 * For the SHEET name, "held by another" means a live sibling sheet in the same base, OR a name in
 * `takenSheetNames` — the names OTHER tables in the same caller plan are about to take. Without the
 * second half, two tables with the same template name (two sandboxes created with the default
 * 'PLM Stock Preparation Sandbox') would both preview as `would_rename` to one target, and the apply
 * would silently skip the second — a preview that lied.
 *
 * The UPDATE repeats the expected name in its WHERE clause, so a concurrent rename between the read
 * and the write is reported as `skipped_name_changed` rather than overwritten.
 *
 * LOCKING — AND ITS SIDE EFFECT, stated rather than discovered. The write leg locks the sheet row and
 * then every field row of that sheet `FOR UPDATE` (fields in `id` order) before it reads names:
 *   - it serialises the relabel against a concurrent rename of the sheet or of any existing column;
 *   - because `meta_fields.sheet_id` and `meta_records.sheet_id` REFERENCE `meta_sheets(id)`, a
 *     concurrent INSERT of a new column or of a new RECORD into this sheet takes FOR KEY SHARE on the
 *     sheet row and therefore WAITS until the relabel commits. That closes the "a new column with the
 *     same Chinese name is created mid-apply" race, at the cost of record inserts to this one sheet
 *     blocking for the duration of the apply (one transaction of at most a few dozen single-row
 *     updates — a sub-second window in practice, but a real one).
 *   - DEADLOCK: `PATCH /fields/:id` with a reorder locks the shifted field rows in scan order, which
 *     is not this `id` order. If both interleave, PostgreSQL aborts one of them (40P01). If it is the
 *     relabel, its transaction rolls back with NOTHING written for that table and the caller reports
 *     a retryable conflict; re-running is safe (compare-and-set). This ordering is PostgreSQL
 *     semantics, argued here — it is NOT yet proven by a real-database test in this repository.
 *
 * TENANCY. The sheet id is DERIVED from (projectId, objectId) and the call is refused unless
 * `plugin_multitable_object_registry` records exactly that (sheet, project, object) triple — the one
 * place a sheet's owning project is recorded. The plugin-scope wrapper in front of this adds the
 * project-namespace check and the plugin-ownership check (plugin-scope.ts). A caller can therefore
 * only ever relabel an object its own project provisioned.
 *
 * VALUES-FREE RESULT. The result carries logical field ids, status codes and a digest. It never echoes
 * a field's CURRENT name, because a name a person typed is customer content.
 */

import { createHash, randomUUID } from 'crypto'

import { fenceWriterEntry } from './canonical-sheet-fence'
import { configUpdateDiff, fieldUpdateDiff, recordConfigRevision } from './config-revision-recorder'
import { checkDisplayNameHygiene } from './display-name-hygiene'
import {
  getObjectFieldId,
  getObjectSheetId,
  type MultitableProvisioningQueryFn,
} from './provisioning'

export type RelabelDisplayNameStatus =
  | 'renamed'
  | 'would_rename'
  | 'already_target'
  | 'skipped_name_changed'
  | 'skipped_name_taken'
  | 'missing'

export type RelabelDisplayNameRequest = {
  /** The name the entity must CURRENTLY carry for the rename to happen (compare-and-set). */
  expectedName: string
  /** The name it gets. */
  nextName: string
}

export type RelabelFieldDisplayNameRequest = RelabelDisplayNameRequest & {
  /** The LOGICAL field id, as the plugin provisioned it — never a physical `fld_…` id. */
  fieldId: string
}

export type RelabelObjectDisplayNamesArgs = {
  projectId: string
  objectId: string
  sheetName?: RelabelDisplayNameRequest | null
  fields: RelabelFieldDisplayNameRequest[]
  /**
   * Sheet names OTHER tables of the same caller plan are about to take. The sheet rename is
   * `skipped_name_taken` when its target is in this list, exactly as if a sibling already held it.
   */
  takenSheetNames?: string[] | null
  /** Exactly `true` writes. Anything else is a dry run that writes nothing at all. */
  apply?: boolean
  /** REQUIRED on the write leg: the `planDigest` the dry run answered for this same object. */
  expectedPlanDigest?: string | null
  /** Attribution for the config-history rows. */
  actorId?: string | null
}

export type RelabelObjectDisplayNamesInput = RelabelObjectDisplayNamesArgs & {
  query: MultitableProvisioningQueryFn
}

export type RelabelObjectDisplayNamesResult = {
  /** False when the object has no live sheet. Nothing else is evaluated then. */
  present: boolean
  applied: boolean
  sheetId: string
  sheetName: { status: RelabelDisplayNameStatus } | null
  fields: Array<{ fieldId: string; status: RelabelDisplayNameStatus }>
  /** Digest over exactly the renames this call would perform (dry run) / did plan (apply). */
  planDigest: string
  /** How many `meta_config_revisions` rows this call wrote (0 on a dry run). */
  revisionCount: number
  /** The config-history batch every revision of this call shares; null when nothing was written. */
  batchId: string | null
}

export const RELABEL_DISPLAY_NAME_MAX_LENGTH = 255
export const RELABEL_TAKEN_SHEET_NAMES_MAX = 64
export const RELABEL_PLAN_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

/** The operator switch for the WRITE leg. Default OFF; exactly 'true' turns it on. */
export const MANAGED_TABLE_RELABEL_ENABLED_ENV = 'MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED'

export function isManagedTableRelabelApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MANAGED_TABLE_RELABEL_ENABLED_ENV] === 'true'
}

export class MultitableRelabelInputError extends Error {
  code = 'MULTITABLE_RELABEL_INPUT_INVALID'
  status = 400

  constructor(message: string) {
    super(message)
    this.name = 'MultitableRelabelInputError'
  }
}

export class MultitableRelabelScopeError extends Error {
  code = 'MULTITABLE_RELABEL_SCOPE_FORBIDDEN'
  status = 403

  constructor() {
    // Values-free: which object was refused is the caller's own input, and echoing a derived
    // sheet id would only tell a probing caller what the id of somebody else's sheet is.
    super('the object is not registered to this project; its display names cannot be relabelled')
    this.name = 'MultitableRelabelScopeError'
  }
}

export class MultitableRelabelDisabledError extends Error {
  code = 'MULTITABLE_RELABEL_APPLY_DISABLED'
  status = 409

  constructor() {
    super('managed-table relabel writes are disabled on this deployment; the operator must enable them')
    this.name = 'MultitableRelabelDisabledError'
  }
}

export class MultitableRelabelPlanChangedError extends Error {
  code = 'MULTITABLE_RELABEL_PLAN_CHANGED'
  status = 409

  constructor() {
    super('the tables changed since the preview; preview again before applying')
    this.name = 'MultitableRelabelPlanChangedError'
  }
}

function assertName(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new MultitableRelabelInputError(`${what} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed !== value) {
    throw new MultitableRelabelInputError(`${what} must be a non-empty, already-trimmed string`)
  }
  if (trimmed.length > RELABEL_DISPLAY_NAME_MAX_LENGTH) {
    throw new MultitableRelabelInputError(`${what} exceeds ${RELABEL_DISPLAY_NAME_MAX_LENGTH} characters`)
  }
  const refusal = checkDisplayNameHygiene(trimmed)
  if (refusal) {
    const error = new MultitableRelabelInputError(`${what}: ${refusal.message}`)
    error.code = refusal.code
    throw error
  }
  return trimmed
}

function normalizeRequest(request: RelabelDisplayNameRequest, what: string): RelabelDisplayNameRequest {
  const expectedName = assertName(request && request.expectedName, `${what}.expectedName`)
  const nextName = assertName(request && request.nextName, `${what}.nextName`)
  if (expectedName === nextName) {
    throw new MultitableRelabelInputError(`${what}: expectedName and nextName must differ`)
  }
  return { expectedName, nextName }
}

function normalizeArgs(input: RelabelObjectDisplayNamesArgs) {
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : ''
  const objectId = typeof input.objectId === 'string' ? input.objectId.trim() : ''
  if (!projectId || !objectId) throw new MultitableRelabelInputError('projectId and objectId are required')
  if (!Array.isArray(input.fields)) throw new MultitableRelabelInputError('fields must be an array')
  const seen = new Set<string>()
  const fields = input.fields.map((entry, index) => {
    const fieldId = typeof entry?.fieldId === 'string' ? entry.fieldId.trim() : ''
    if (!fieldId) throw new MultitableRelabelInputError(`fields[${index}].fieldId is required`)
    if (seen.has(fieldId)) throw new MultitableRelabelInputError(`fields[${index}].fieldId is duplicated`)
    seen.add(fieldId)
    return { fieldId, ...normalizeRequest(entry, `fields[${index}]`) }
  })
  const sheetName = input.sheetName ? normalizeRequest(input.sheetName, 'sheetName') : null
  const rawTaken = input.takenSheetNames ?? []
  if (!Array.isArray(rawTaken) || rawTaken.length > RELABEL_TAKEN_SHEET_NAMES_MAX) {
    throw new MultitableRelabelInputError(`takenSheetNames must be an array of at most ${RELABEL_TAKEN_SHEET_NAMES_MAX} names`)
  }
  const takenSheetNames = new Set(rawTaken.map((name, index) => assertName(name, `takenSheetNames[${index}]`)))
  const apply = input.apply === true
  let expectedPlanDigest: string | null = null
  if (apply) {
    if (typeof input.expectedPlanDigest !== 'string' || !RELABEL_PLAN_DIGEST_PATTERN.test(input.expectedPlanDigest)) {
      throw new MultitableRelabelInputError('the write leg requires the expectedPlanDigest a dry run answered')
    }
    expectedPlanDigest = input.expectedPlanDigest
  }
  return { projectId, objectId, fields, sheetName, takenSheetNames, apply, expectedPlanDigest }
}

type FieldRow = { id: string; name: string; type: string; property: unknown; order: number }

/**
 * Classify one request against the live state. Pure: every input is already read, so the dry run
 * and the apply leg cannot disagree about what they would do.
 */
function classify(
  current: string | null,
  request: RelabelDisplayNameRequest,
  takenByOther: boolean,
): RelabelDisplayNameStatus {
  if (current === null) return 'missing'
  if (current === request.nextName) return 'already_target'
  if (current !== request.expectedName) return 'skipped_name_changed'
  if (takenByOther) return 'skipped_name_taken'
  return 'would_rename'
}

/**
 * The plan digest: sha256 over the ORDERED list of exactly the renames this call would perform —
 * `[sheetId, entity, from, to]`, the sheet (if it renames) first, then fields in request order.
 * Entities that would NOT be renamed are deliberately absent: a change to them changes nothing that
 * would be written, and a change that turns one into a rename (or a rename into a skip) changes this
 * list, so the digest moves exactly when what the apply would WRITE moves.
 */
export function computeRelabelPlanDigest(
  sheetId: string,
  renames: Array<{ entity: string; from: string; to: string }>,
): string {
  const canonical = JSON.stringify([sheetId, renames.map((entry) => [entry.entity, entry.from, entry.to])])
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

export async function relabelObjectDisplayNames(
  input: RelabelObjectDisplayNamesInput,
): Promise<RelabelObjectDisplayNamesResult> {
  const { query } = input
  // Every refusal of the INPUT happens here, before a single statement — a bad request costs no
  // lock and no read.
  const args = normalizeArgs(input)
  // THE OPERATOR SWITCH, before any statement: a disabled deployment takes no fence and no lock.
  if (args.apply && !isManagedTableRelabelApplyEnabled()) throw new MultitableRelabelDisabledError()
  const sheetId = getObjectSheetId(args.projectId, args.objectId)
  const actorId = typeof input.actorId === 'string' && input.actorId.trim() ? input.actorId.trim() : null

  // Fence FIRST on the write leg, exactly like the HTTP rename paths (fence-before-check).
  if (args.apply) await fenceWriterEntry(query, sheetId)

  // THE REGISTRY BINDING. Both legs, so a dry run can never report a plan for a table the apply
  // leg would refuse.
  const registry = await query(
    `SELECT 1 FROM plugin_multitable_object_registry
     WHERE sheet_id = $1 AND project_id = $2 AND object_id = $3`,
    [sheetId, args.projectId, args.objectId],
  )
  if ((registry.rows as unknown[]).length === 0) throw new MultitableRelabelScopeError()

  // See LOCKING in the header: the write leg locks the sheet row, then the field rows, before it
  // reads a single name. The dry run takes no row lock at all.
  const lock = args.apply ? ' FOR UPDATE' : ''
  const sheetResult = await query(
    `SELECT id, base_id, name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL${lock}`,
    [sheetId],
  )
  const sheetRow = (sheetResult.rows as Array<{ id: unknown; base_id: unknown; name: unknown }>)[0]
  if (!sheetRow) {
    return {
      present: false,
      applied: args.apply,
      sheetId,
      sheetName: null,
      fields: [],
      planDigest: computeRelabelPlanDigest(sheetId, []),
      revisionCount: 0,
      batchId: null,
    }
  }

  // ALL of the sheet's fields, not just the requested ones: "is the target name taken" is a
  // question about every column on the sheet, including ones the caller knows nothing about.
  const fieldResult = await query(
    `SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY id${lock}`,
    [sheetId],
  )
  const fieldRows: FieldRow[] = (fieldResult.rows as any[]).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    type: String(row.type),
    property: row.property,
    order: Number(row.order ?? 0),
  }))
  const byId = new Map(fieldRows.map((row) => [row.id, row]))

  const targetCounts = new Map<string, number>()
  for (const entry of args.fields) targetCounts.set(entry.nextName, (targetCounts.get(entry.nextName) ?? 0) + 1)

  const planned = args.fields.map((entry) => {
    const physicalId = getObjectFieldId(args.projectId, args.objectId, entry.fieldId)
    const row = byId.get(physicalId) ?? null
    const takenByOther =
      fieldRows.some((other) => other.id !== physicalId && other.name === entry.nextName)
      || (targetCounts.get(entry.nextName) ?? 0) > 1
    return { entry, physicalId, row, status: classify(row ? row.name : null, entry, takenByOther) }
  })

  let sheetPlan: { status: RelabelDisplayNameStatus } | null = null
  if (args.sheetName) {
    // The same duplicate rule for the sheet: another live sheet in the SAME base already carrying
    // the target name, or another table of the caller's plan about to take it (takenSheetNames),
    // would make two tabs indistinguishable.
    const siblings = await query(
      `SELECT 1 FROM meta_sheets
       WHERE id <> $1 AND deleted_at IS NULL AND base_id IS NOT DISTINCT FROM $2 AND name = $3
       LIMIT 1`,
      [sheetId, sheetRow.base_id ?? null, args.sheetName.nextName],
    )
    const taken = (siblings.rows as unknown[]).length > 0 || args.takenSheetNames.has(args.sheetName.nextName)
    sheetPlan = { status: classify(String(sheetRow.name), args.sheetName, taken) }
  }

  const renames: Array<{ entity: string; from: string; to: string }> = []
  if (args.sheetName && sheetPlan && sheetPlan.status === 'would_rename') {
    renames.push({ entity: 'sheet', from: args.sheetName.expectedName, to: args.sheetName.nextName })
  }
  for (const item of planned) {
    if (item.status === 'would_rename') {
      renames.push({ entity: `field:${item.entry.fieldId}`, from: item.entry.expectedName, to: item.entry.nextName })
    }
  }
  const planDigest = computeRelabelPlanDigest(sheetId, renames)

  if (!args.apply) {
    return {
      present: true,
      applied: false,
      sheetId,
      sheetName: sheetPlan,
      fields: planned.map((item) => ({ fieldId: item.entry.fieldId, status: item.status })),
      planDigest,
      revisionCount: 0,
      batchId: null,
    }
  }

  // PREVIEW == APPLY: the plan recomputed under this transaction's locks must be the one the caller
  // previewed. Refused before any write; the transaction rolls back with nothing changed.
  if (planDigest !== args.expectedPlanDigest) throw new MultitableRelabelPlanChangedError()

  // THE WRITE LEG. One batch id for the whole call, so the config history reads it as one
  // logical operation (the same grouping a PATCH uses for a field and its shifted siblings).
  const batchId = randomUUID()
  let revisionCount = 0
  const fields: Array<{ fieldId: string; status: RelabelDisplayNameStatus }> = []
  for (const item of planned) {
    if (item.status !== 'would_rename' || !item.row) {
      fields.push({ fieldId: item.entry.fieldId, status: item.status })
      continue
    }
    const update = await query(
      `UPDATE meta_fields SET name = $3, updated_at = now()
       WHERE id = $1 AND sheet_id = $2 AND name = $4
       RETURNING id, name, type, property, "order"`,
      [item.physicalId, sheetId, item.entry.nextName, item.entry.expectedName],
    )
    const updated = (update.rows as any[])[0]
    if (!updated) {
      // Lost a race to a concurrent rename: the compare half of compare-and-set said no.
      fields.push({ fieldId: item.entry.fieldId, status: 'skipped_name_changed' })
      continue
    }
    const diff = fieldUpdateDiff(
      { name: item.row.name, type: item.row.type, property: item.row.property, order: item.row.order },
      {
        name: String(updated.name),
        type: String(updated.type),
        property: updated.property,
        order: Number(updated.order ?? 0),
      },
    )
    if (diff) {
      await recordConfigRevision(query, {
        sheetId,
        entityType: 'field',
        entityId: item.physicalId,
        action: 'update',
        before: diff.before,
        after: diff.after,
        changedKeys: diff.changedKeys,
        batchId,
        actorId,
      })
      revisionCount += 1
    }
    fields.push({ fieldId: item.entry.fieldId, status: 'renamed' })
  }

  let sheetName = sheetPlan
  if (args.sheetName && sheetPlan && sheetPlan.status === 'would_rename') {
    // `updated_at` moves with the name, exactly as the field UPDATE above (and PATCH /fields) does.
    // PATCH /sheets leaves it untouched today; nothing reads meta_sheets.updated_at, so stamping it
    // here only keeps this module's two renames consistent with each other.
    const update = await query(
      `UPDATE meta_sheets SET name = $2, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL AND name = $3
       RETURNING name`,
      [sheetId, args.sheetName.nextName, args.sheetName.expectedName],
    )
    if ((update.rows as unknown[]).length === 0) {
      sheetName = { status: 'skipped_name_changed' }
    } else {
      const diff = configUpdateDiff({ name: args.sheetName.expectedName }, { name: args.sheetName.nextName }, ['name'])
      if (diff) {
        // Recorded for the audit trail. NOT revertible from the config history (sheet_config reverts
        // are gated — see REVERTIBILITY in the header); the way back is a manual rename.
        await recordConfigRevision(query, {
          sheetId,
          entityType: 'sheet_config',
          entityId: sheetId,
          action: 'update',
          before: diff.before,
          after: diff.after,
          changedKeys: diff.changedKeys,
          batchId,
          actorId,
        })
        revisionCount += 1
      }
      sheetName = { status: 'renamed' }
    }
  }

  return {
    present: true,
    applied: true,
    sheetId,
    sheetName,
    fields,
    planDigest,
    revisionCount,
    batchId: revisionCount > 0 ? batchId : null,
  }
}

/**
 * The host GLUE, extracted so it is unit-testable without the MetaSheetServer bootstrap (the same
 * reason `runObjectFieldsRepairTransactionWith` exists). `withTxQuery` must run `run` exactly once
 * inside ONE transaction and roll back if it throws. `afterCommit` runs only once that transaction
 * has resolved and only when something was actually written — it is where index.ts drops the
 * univer-meta field/sheet caches, which otherwise keep serving the old names until a restart.
 */
export async function runRelabelObjectDisplayNamesWith(
  withTxQuery: <R>(run: (query: MultitableProvisioningQueryFn) => Promise<R>) => Promise<R>,
  args: RelabelObjectDisplayNamesArgs,
  afterCommit: (sheetId: string) => void,
): Promise<RelabelObjectDisplayNamesResult> {
  const result = await withTxQuery((query) => relabelObjectDisplayNames({ ...args, query }))
  if (result.applied && result.revisionCount > 0) afterCommit(result.sheetId)
  return result
}
