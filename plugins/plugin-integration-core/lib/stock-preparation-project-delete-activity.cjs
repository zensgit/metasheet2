'use strict'

// A shared xact lock spans even the interval a pull spends waiting on its source. A transaction
// that deletes takes its exclusive counterpart. JSON tuple encoding prevents tenant/project aliases,
// and the two-int advisory namespace is disjoint from the existing single-bigint overview lock.
const PROJECT_ACTIVITY_NAMESPACE = 6991

function projectBusy() {
  return Object.assign(new Error('The project is in use.'), { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
}

async function lockProjectActivity(tx, { tenantId, projectNo }, shared) {
  const sql = shared
    ? 'SELECT pg_try_advisory_xact_lock_shared($1::int, hashtext($2)) AS locked'
    : 'SELECT pg_try_advisory_xact_lock($1::int, hashtext($2)) AS locked'
  if (!tenantId || (!projectNo && !(shared && projectNo === null))) throw projectBusy()
  // Some legacy jobs have only an internal project id. Their shared tenant fallback key conflicts
  // with each deletion in that tenant. Number-addressed jobs need only their exact project key.
  for (const project of shared ? [projectNo] : [null, projectNo]) {
    const result = await tx.query(sql, [PROJECT_ACTIVITY_NAMESPACE, JSON.stringify([tenantId, project])])
    const rows = Array.isArray(result) ? result : result.rows
    if (rows[0]?.locked !== true) throw projectBusy()
  }
}

async function withProjectDeleteActivity(database, scope, operation) {
  return database.transaction(async (tx) => {
    await lockProjectActivity(tx, scope, true)
    return operation()
  })
}

module.exports = { lockProjectActivity, projectBusy, withProjectDeleteActivity }
