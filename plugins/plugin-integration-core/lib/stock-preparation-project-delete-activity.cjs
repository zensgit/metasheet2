'use strict'

// A shared session lock spans even the interval a pull spends waiting on its source. A transaction
// that deletes takes its exclusive counterpart. JSON tuple encoding prevents tenant/project aliases,
// and the two-int advisory namespace is disjoint from the existing single-bigint overview lock.
const PROJECT_ACTIVITY_NAMESPACE = 6991

function projectBusy() {
  return Object.assign(new Error('The project is in use.'), { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' })
}

async function lockProjectActivity(tx, { tenantId, projectNo }) {
  if (!tenantId || !projectNo) throw projectBusy()
  // Unnumbered jobs hold the tenant fallback key. Number-addressed jobs hold only their project key.
  for (const project of [null, projectNo]) {
    const result = await tx.query('SELECT pg_try_advisory_xact_lock($1::int, hashtext($2)) AS locked',
      [PROJECT_ACTIVITY_NAMESPACE, JSON.stringify([tenantId, project])])
    const rows = Array.isArray(result) ? result : result.rows
    if (rows[0]?.locked !== true) throw projectBusy()
  }
}

// The host gives writers their own connection pool. Never fall back to the business pool:
// holding its last client while operation() waits for a second client prevents progress.
async function withProjectDeleteActivity(activity, scope, operation) {
  if (typeof activity?.withConnection !== 'function') {
    throw Object.assign(new Error('Project writer coordination is unavailable.'), { status: 503, code: 'STOCK_PREPARATION_PROJECT_DELETE_UNAVAILABLE' })
  }
  const { tenantId, projectNo } = scope
  if (!tenantId || (!projectNo && projectNo !== null)) throw projectBusy()
  const key = [PROJECT_ACTIVITY_NAMESPACE, JSON.stringify([tenantId, projectNo])]
  return activity.withConnection(async session => {
    const [lock] = await session.query('SELECT pg_try_advisory_lock_shared($1::int, hashtext($2)) AS locked', key)
    if (lock?.locked !== true) throw projectBusy()
    try {
      return await operation()
    } finally {
      const [release] = await session.query('SELECT pg_advisory_unlock_shared($1::int, hashtext($2)) AS released', key)
      if (release?.released !== true) throw projectBusy()
    }
  })
}

module.exports = { lockProjectActivity, projectBusy, withProjectDeleteActivity }
