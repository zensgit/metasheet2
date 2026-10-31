async function consumePersistedAttendanceImportTokenV1(db, { token, orgId, userId }) {
  const rows = await db.query(
    `DELETE FROM attendance_import_tokens
     WHERE token = $1 AND org_id = $2 AND user_id = $3 AND expires_at > clock_timestamp()
     RETURNING token`,
    [token, orgId, userId],
  )
  return rows.length === 1
}

module.exports = { consumePersistedAttendanceImportTokenV1 }
