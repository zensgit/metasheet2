'use strict'

// 通知下一步 —— the DURABLE half. One row per (tenant, workspace, projectNo) holding a single
// integer: how far along the configured chain this project has got.
//
// WHY A COMPANION ROW AND NOT A FIELD ON THE PREP ROWS. The turn is a PROJECT-level fact — "whose
// turn is it on project P" — not a row-level one. A project's prep sheet holds hundreds of
// plm_stock_preparation_main rows and every one of them would carry the same answer, so putting the
// cursor on the rows would mean:
//
//   * N writes for one logical fact, none of them atomic with the others. A handoff that patched 400
//     rows and died at row 300 would leave the project with two different opinions about whose turn
//     it is, and nothing could say which was right.
//   * No place to enforce "advance exactly once". The idempotency the route promises is a
//     compare-and-set on ONE cursor; spread across 400 rows there is no cursor to compare and set,
//     and two people clicking at the same moment would each move a different subset.
//   * A refresh from PLM rewrites those rows. The turn would be silently reset by an unrelated sync.
//
// It also must not go on the two existing department columns (`procurementReply` 采购回复 /
// `warehouseConfirmation` 仓库确认): those are `human_preserved` free text that people type into,
// they carry no actor and no date, and overloading them would destroy what was typed while still
// being unable to express an ordered cursor.
//
// So: one row, one integer, a unique index that arbitrates the race — the same shape and the same
// reasoning as integration_stock_prep_source_binding (migration 079), which is the nearest precedent
// in this package for a small, tenant-scoped, values-free pointer.
//
// VALUES-FREE. Every column is a handle, an integer or a server clock: two scope ids, the business
// project number (the same navigation handle the audit trail already carries in `project_id`), two
// small integers, an actor id, two timestamps. No material name, spec, drawing number or quantity
// can reach this table — there is no column that could hold one.

const crypto = require('node:crypto')

const HANDOFF_TABLE = 'integration_stock_prep_handoff'

// The unique index from migration 084 — (tenant_id, COALESCE(workspace_id,''), project_no).
const SCOPE_CONSTRAINT = 'uniq_integration_stock_prep_handoff_scope'
const MAX_ADVANCE_ATTEMPTS = 3

class StockPreparationHandoffStoreError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationHandoffStoreError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// Postgres unique-violation routing, same idiom as stock-preparation-source-binding-store.cjs.
function isUniqueViolation(error, constraint) {
  return Boolean(error) && error.code === '23505' && error.constraint === constraint
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StockPreparationHandoffStoreError(422, 'STOCK_PREPARATION_HANDOFF_SCOPE_INVALID', `${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredIndex(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new StockPreparationHandoffStoreError(422, 'STOCK_PREPARATION_HANDOFF_SCOPE_INVALID', `${field} must be a non-negative integer`, { field })
  }
  return value
}

function scopeWhere({ tenantId, workspaceId, projectNo }) {
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId ?? null,
    project_no: projectNo,
  }
}

function rowToPublicHandoff(row) {
  if (!row) return null
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    projectNo: row.project_no,
    stepIndex: Number(row.step_index),
    notifiedStepIndex: row.notified_step_index === null || row.notified_step_index === undefined
      ? null
      : Number(row.notified_step_index),
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function firstRow(result) {
  if (Array.isArray(result)) return result[0] || null
  if (result && Array.isArray(result.rows)) return result.rows[0] || null
  return null
}

function createStockPreparationHandoffStore({ db, idGenerator = crypto.randomUUID } = {}) {
  if (
    !db ||
    typeof db.selectOne !== 'function' ||
    typeof db.selectOneForUpdate !== 'function' ||
    typeof db.insertOne !== 'function' ||
    typeof db.updateRow !== 'function' ||
    typeof db.transaction !== 'function'
  ) {
    // `transaction` is REQUIRED, not nice-to-have, for the same reason the source-binding store
    // requires it: this is a read-then-write on one row and the read decides whether the write is
    // allowed at all. Doing the compare in one statement and the set in another would let two people
    // clicking 通知下一步 at the same instant both pass the compare.
    //
    // `selectOneForUpdate` is required for the SAME reason and is checked HERE rather than being
    // probed at call time: a db binding without it would degrade the compare-and-set below into a
    // plain read under READ COMMITTED, which is exactly the double-notify bug this store exists to
    // prevent. A missing lock seam must fail at wiring time, loudly, not silently at 2am.
    throw new Error('createStockPreparationHandoffStore: scoped db helper (incl. transaction + selectOneForUpdate) is required')
  }

  function normalizeScope(input = {}) {
    return {
      tenantId: requiredString(input.tenantId, 'tenantId'),
      workspaceId: optionalString(input.workspaceId),
      projectNo: requiredString(input.projectNo, 'projectNo'),
    }
  }

  /**
   * This project's cursor, or `null` when nobody has ever handed off on it.
   *
   * `null` is NOT an error and must not be turned into one: a project whose first person has not yet
   * finished has no row, and the route reads that as "the chain is at step 0", which is the truth.
   * Writing a row eagerly at project creation would mean the table grew a row for every project
   * anyone ever looked at.
   */
  async function get(input = {}) {
    const scope = normalizeScope(input)
    return rowToPublicHandoff(await db.selectOne(HANDOFF_TABLE, scopeWhere(scope)))
  }

  /**
   * Move the cursor from `expectedStepIndex` to `toStepIndex`, and CLAIM the notification for the
   * step being completed — both inside one transaction.
   *
   * Returns `{ handoff, changed, notifyClaimed }`.
   *
   * THE COMPARE-AND-SET IS THE WHOLE POINT, AND IT TAKES BOTH HALVES BELOW. The caller has already
   * planned the advance against a cursor it read a moment ago (planStockPreparationHandoffAdvance);
   * that read is stale by the time it gets here. Re-reading the cursor inside the transaction is
   * NOT on its own enough — under READ COMMITTED (the host's default, and this store does not set
   * an isolation level) two transactions can both run their SELECT before either runs its UPDATE,
   * both see the same cursor, both pass the compare and both commit. That is not a hypothetical:
   * it is the exact shape of two people clicking 通知下一步 at the same moment, and it produced two
   * DingTalk pings — including two copies of the terminal 仓库+采购 fan-out.
   *
   * So the compare is enforced TWICE, and either half alone would be sufficient at the database:
   *
   *   1. THE ROW LOCK. The in-transaction read is `selectOneForUpdate` (SELECT … FOR UPDATE), so a
   *      second advance on the same (tenant, workspace, project) BLOCKS until the first commits and
   *      then reads the cursor the first one wrote. Serialization, not hope.
   *   2. THE WRITE PREDICATE. The UPDATE carries `step_index = <the cursor we compared against>`
   *      (and, when a notification is being claimed, the `notified_step_index` we compared against)
   *      in its WHERE, and ZERO updated rows is a REFUSAL, never a success. So even on a binding
   *      whose lock does not do what this store expects, a lost race fails closed instead of
   *      clobbering somebody else's advance and re-claiming their notification.
   *
   * The route's "you cannot advance a step that is not current" promise is therefore enforced at the
   * database rather than in a window between two statements.
   *
   * `changed: false` means the cursor was ALREADY at `toStepIndex` — an idempotent replay (the same
   * person's second click, or a retried request). No row is touched, so `updated_at` does not move
   * and the trail does not gain a second "someone handed off" moment for one handoff.
   *
   * NOTIFY IS CLAIMED HERE, DELIBERATELY, AND AT MOST ONCE. `notified_step_index` records the
   * highest step whose completion has had a notification DISPATCHED, and it is stamped in the SAME
   * transaction as the cursor move — before the send is attempted, not after. So:
   *
   *   * the notification is sent AFTER this transaction commits (state first, notify second). A send
   *     failure therefore does NOT roll back the turn: 张三 really did finish, and a DingTalk outage
   *     must not silently un-finish it. The route reports `notifyOutcome: 'failed'` and the UI tells
   *     the operator to pass the word on themselves.
   *   * a failed send is NOT retried by clicking again, because the claim already landed and the
   *     second click is a replay. That is at-most-once, chosen over at-least-once on purpose: a
   *     flaky webhook turning one handoff into a stream of duplicate pings is worse, for the people
   *     receiving it, than one missed ping that the operator has been told about.
   *
   * WHY A RETRY LOOP. Under READ COMMITTED two concurrent FIRST advances on the same project both
   * see "no row" and both try to INSERT; the unique index arbitrates and the loser gets 23505. The
   * loser re-enters with a FRESH transaction (a 23505 aborts the one it was in), where it now sees
   * the winner's row and its compare-and-set correctly refuses. Bounded, because an unbounded retry
   * on a violation we may have misdiagnosed is a spin.
   */
  async function advance(input = {}) {
    const scope = normalizeScope(input)
    const expectedStepIndex = requiredIndex(input.expectedStepIndex, 'expectedStepIndex')
    const toStepIndex = requiredIndex(input.toStepIndex, 'toStepIndex')
    const notifyForStepIndex = input.notifyForStepIndex === null || input.notifyForStepIndex === undefined
      ? null
      : requiredIndex(input.notifyForStepIndex, 'notifyForStepIndex')
    const actor = optionalString(input.actor)
    const where = scopeWhere(scope)

    for (let attempt = 1; attempt <= MAX_ADVANCE_ATTEMPTS; attempt += 1) {
      try {
        return await db.transaction(async (trx) => {
          // FOR UPDATE, not a plain read — see the "compare is enforced TWICE" note above. A
          // concurrent advance on the same project waits here instead of racing past.
          const existing = await trx.selectOneForUpdate(HANDOFF_TABLE, where)
          // No row yet == the chain has never moved == it is at step 0. Absence and "0" are the same
          // state here, unlike the source binding where "unset" and "bound" resolve differently.
          const cursor = existing ? Number(existing.step_index) : 0
          const priorNotified = existing && existing.notified_step_index !== null && existing.notified_step_index !== undefined
            ? Number(existing.notified_step_index)
            : null

          if (cursor === toStepIndex) {
            // Already there. Report the replay WITHOUT writing, so a double click cannot move
            // updated_at or re-claim a notification.
            return {
              handoff: rowToPublicHandoff(existing) || {
                tenantId: scope.tenantId,
                workspaceId: scope.workspaceId,
                projectNo: scope.projectNo,
                stepIndex: cursor,
                notifiedStepIndex: priorNotified,
                updatedBy: null,
                createdAt: null,
                updatedAt: null,
              },
              changed: false,
              notifyClaimed: false,
            }
          }
          if (cursor !== expectedStepIndex) {
            throw new StockPreparationHandoffStoreError(
              409,
              'STOCK_PREPARATION_HANDOFF_STEP_MISMATCH',
              'the handoff chain moved before this advance could be applied',
              { field: 'fromStepKey' },
            )
          }

          // Claim the notification only if this step's completion has never had one dispatched.
          const notifyClaimed = notifyForStepIndex !== null
            && (priorNotified === null || priorNotified < notifyForStepIndex)
          const nextNotified = notifyClaimed ? notifyForStepIndex : priorNotified

          // THE WRITE PREDICATE. The scope alone is not a compare-and-set: it identifies the row,
          // it does not assert what the row still says. Both columns this advance decided against
          // ride into the WHERE, so an UPDATE that no longer describes reality matches zero rows.
          const casWhere = {
            ...where,
            step_index: cursor,
            notified_step_index: priorNotified,
          }
          const row = existing
            ? firstRow(await trx.updateRow(
                HANDOFF_TABLE,
                {
                  step_index: toStepIndex,
                  notified_step_index: nextNotified,
                  updated_by: actor,
                  updated_at: new Date(),
                },
                casWhere,
              ))
            : firstRow(await trx.insertOne(HANDOFF_TABLE, {
                id: idGenerator(),
                tenant_id: scope.tenantId,
                workspace_id: scope.workspaceId,
                project_no: scope.projectNo,
                step_index: toStepIndex,
                notified_step_index: nextNotified,
                updated_by: actor,
              }))
          if (!row) {
            // ZERO ROWS UPDATED == THE PREDICATE NO LONGER HELD == somebody else advanced this
            // project between our read and our write. Fail CLOSED rather than reporting an advance
            // we cannot prove landed: telling someone "the next person has been notified" when the
            // cursor did not move is the worst outcome this surface has — they will stop chasing it.
            // This is a REFUSAL, and it is the reason the route may not audit the handoff before
            // this call returns.
            throw new StockPreparationHandoffStoreError(
              409,
              'STOCK_PREPARATION_HANDOFF_WRITE_CONFLICT',
              'handoff advance did not land',
              { field: 'projectNo' },
            )
          }
          return { handoff: rowToPublicHandoff(row), changed: true, notifyClaimed }
        })
      } catch (error) {
        if (isUniqueViolation(error, SCOPE_CONSTRAINT) && attempt < MAX_ADVANCE_ATTEMPTS) continue
        throw error
      }
    }
    throw new StockPreparationHandoffStoreError(
      409,
      'STOCK_PREPARATION_HANDOFF_WRITE_CONFLICT',
      'handoff advance conflicted',
      { field: 'projectNo' },
    )
  }

  return { get, advance }
}

module.exports = {
  HANDOFF_TABLE,
  StockPreparationHandoffStoreError,
  createStockPreparationHandoffStore,
  __internals: {
    rowToPublicHandoff,
    scopeWhere,
  },
}
