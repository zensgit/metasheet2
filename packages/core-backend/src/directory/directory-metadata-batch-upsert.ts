// Trusted scalar SQL parts copied verbatim from directory-sync.ts at bcd879f1.
// Inputs are already normalized and deduplicated; the caller owns the transaction.
type MetadataRow = readonly unknown[]
type MetadataQuery = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: readonly { created?: unknown }[] }>

const DEPARTMENT_SQL = {
  prefix: `INSERT INTO directory_departments (
             integration_id, provider, external_department_id, external_parent_department_id, name,
             full_path, order_index, is_active, raw, last_seen_at, created_at, updated_at
           )
           VALUES `,
  row: `($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb, $9, NOW(), NOW())`,
  tail: `
           ON CONFLICT (integration_id, external_department_id)
           DO UPDATE SET
             external_parent_department_id = EXCLUDED.external_parent_department_id,
             name = EXCLUDED.name,
             full_path = EXCLUDED.full_path,
             order_index = EXCLUDED.order_index,
             is_active = true,
             raw = EXCLUDED.raw,
             last_seen_at = EXCLUDED.last_seen_at,
             updated_at = NOW()
           RETURNING (xmax = 0) AS created`,
}

const ACCOUNT_SQL = {
  prefix: `INSERT INTO directory_accounts (
     integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key,
     name, nick, email, mobile, job_number, title, avatar_url, is_active, raw, last_seen_at, created_at, updated_at
   )
   VALUES `,
  row: `($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15::jsonb, $16, NOW(), NOW())`,
  tail: `
   ON CONFLICT (integration_id, external_user_id)
   DO UPDATE SET
     corp_id = EXCLUDED.corp_id,
     union_id = EXCLUDED.union_id,
     -- 通讯录 user/get never returns openId, so EXCLUDED.open_id is normally NULL: keep
     -- the openId a DingTalk login backfilled, but ONLY while it still describes the same
     -- person in the same corp. A changed unionId (or corp) means the stored openId may
     -- belong to someone else, and a stale openId would let a grant key on the wrong
     -- person (DT-HARDEN-02) — so it is cleared and must be re-learned from a login.
     open_id = CASE
       WHEN COALESCE(EXCLUDED.open_id, '') <> '' THEN EXCLUDED.open_id
       -- plain = on purpose: a NULL unionId (either side) is NOT the same person, so the openId is cleared
       WHEN directory_accounts.union_id = EXCLUDED.union_id
         AND directory_accounts.corp_id IS NOT DISTINCT FROM EXCLUDED.corp_id
         THEN directory_accounts.open_id
       ELSE NULL
     END,
     external_key = EXCLUDED.external_key,
     name = EXCLUDED.name,
     nick = EXCLUDED.nick,
     email = EXCLUDED.email,
     mobile = EXCLUDED.mobile,
     job_number = EXCLUDED.job_number,
     title = EXCLUDED.title,
     avatar_url = EXCLUDED.avatar_url,
     is_active = true,
     raw = EXCLUDED.raw,
     last_seen_at = EXCLUDED.last_seen_at,
     updated_at = NOW()
   RETURNING (xmax = 0) AS created`,
}

export const DIRECTORY_ACCOUNT_UPSERT_SQL = ACCOUNT_SQL.prefix + ACCOUNT_SQL.row + ACCOUNT_SQL.tail

async function upsertMetadataRows(
  query: MetadataQuery,
  rows: readonly MetadataRow[],
  statement: typeof DEPARTMENT_SQL | typeof ACCOUNT_SQL,
  bindCount: number,
): Promise<{ createdCount: number; updatedCount: number }> {
  let createdCount = 0
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500)
    const values = chunk.map((_, index) => statement.row.replace(
      /\$(\d+)/g,
      (_marker, position: string) => `$${Number(position) + index * bindCount}`,
    ))
    const result = await query(statement.prefix + values.join(', ') + statement.tail, chunk.flat())
    createdCount += result.rows.filter((row) => row.created === true).length
  }
  return { createdCount, updatedCount: rows.length - createdCount }
}

/** Pre-normalized department rows: 9 positional binds in scalar SQL order. */
export function upsertDirectoryDepartmentMetadataRows(query: MetadataQuery, rows: readonly MetadataRow[]) {
  return upsertMetadataRows(query, rows, DEPARTMENT_SQL, 9)
}

/** Pre-normalized account rows: 16 positional binds in scalar SQL order (max 8000 per query). */
export function upsertDirectoryAccountMetadataRows(query: MetadataQuery, rows: readonly MetadataRow[]) {
  return upsertMetadataRows(query, rows, ACCOUNT_SQL, 16)
}
