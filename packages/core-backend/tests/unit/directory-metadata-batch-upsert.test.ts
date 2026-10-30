import { describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_ACCOUNT_UPSERT_SQL,
  upsertDirectoryAccountMetadataRows,
  upsertDirectoryDepartmentMetadataRows,
} from '../../src/directory/directory-metadata-batch-upsert'

// Frozen verbatim scalar statements from directory-sync.ts at bcd879f1.
// Independent literals pin all columns, raw casts and the security-critical openId CASE.
const ORIGINAL_DEPARTMENT_SQL = `INSERT INTO directory_departments (
             integration_id, provider, external_department_id, external_parent_department_id, name,
             full_path, order_index, is_active, raw, last_seen_at, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb, $9, NOW(), NOW())
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
           RETURNING (xmax = 0) AS created`

const ORIGINAL_ACCOUNT_SQL = `INSERT INTO directory_accounts (
     integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key,
     name, nick, email, mobile, job_number, title, avatar_url, is_active, raw, last_seen_at, created_at, updated_at
   )
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15::jsonb, $16, NOW(), NOW())
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
   RETURNING (xmax = 0) AS created`

const cases = [
  {
    name: 'department',
    upsert: upsertDirectoryDepartmentMetadataRows,
    scalar: ORIGINAL_DEPARTMENT_SQL,
    width: 9,
    first: '($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb, $9, NOW(), NOW())',
    second: '($10, $11, $12, $13, $14, $15, $16, true, $17::jsonb, $18, NOW(), NOW())',
    last: '($4492, $4493, $4494, $4495, $4496, $4497, $4498, true, $4499::jsonb, $4500, NOW(), NOW())',
    row: (index: number): readonly unknown[] => [
      'integration-synthetic', 'dingtalk', `dept-${index}`, null, `Department ${index}`,
      '/Synthetic', index, '{"literal":"$1, $8000, NOW()"}', '2026-10-26T00:00:00.000Z',
    ],
  },
  {
    name: 'account',
    upsert: upsertDirectoryAccountMetadataRows,
    scalar: ORIGINAL_ACCOUNT_SQL,
    width: 16,
    first: '($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15::jsonb, $16, NOW(), NOW())',
    second: '($17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, true, $31::jsonb, $32, NOW(), NOW())',
    last: '($7985, $7986, $7987, $7988, $7989, $7990, $7991, $7992, $7993, $7994, $7995, $7996, $7997, $7998, true, $7999::jsonb, $8000, NOW(), NOW())',
    row: (index: number): readonly unknown[] => [
      'integration-synthetic', 'dingtalk', 'corp-synthetic', `user-${index}`, `union-${index}`,
      null, `union-${index}`, `Member ${index}`, null, null, null, null, null, null,
      '{"literal":"$1, $8000, NOW()"}', '2026-10-26T00:00:00.000Z',
    ],
  },
]

it('exports exactly the original scalar account SQL for the existing internals probe', () => {
  expect(DIRECTORY_ACCOUNT_UPSERT_SQL).toBe(ORIGINAL_ACCOUNT_SQL)
})

for (const entry of cases) {
  describe(`${entry.name} metadata batching`, () => {
    it('issues no SQL for empty input', async () => {
      const query = vi.fn(async () => ({ rows: [] }))
      expect(await entry.upsert(query, [])).toEqual({ createdCount: 0, updatedCount: 0 })
      expect(query).not.toHaveBeenCalled()
    })

    it('executes exactly the old scalar statement for one row, without normalizing binds', async () => {
      const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ created: true }] }))
      const row = Object.freeze(entry.row(0))
      expect(await entry.upsert(query, Object.freeze([row]))).toEqual({ createdCount: 1, updatedCount: 0 })
      expect(query.mock.calls).toEqual([[entry.scalar, [...row]]])
      if (entry.name === 'account') expect(query.mock.calls[0][0]).toBe(DIRECTORY_ACCOUNT_UPSERT_SQL)
    })

    it.each([500, 501])('keeps %i rows ordered with at most 500 rows and 8000 binds per statement', async (size) => {
      const rows = Object.freeze(Array.from({ length: size }, (_, index) => Object.freeze(entry.row(index))))
      const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }))
      expect(await entry.upsert(query, rows)).toEqual({ createdCount: 0, updatedCount: size })
      expect(query).toHaveBeenCalledTimes(size === 500 ? 1 : 2)
      const [sql, params] = query.mock.calls[0]
      expect(params).toEqual(rows.slice(0, 500).flat())
      expect(params).toHaveLength(500 * entry.width)
      const [prefix, tail] = entry.scalar.split(entry.first)
      expect(sql.startsWith(prefix + entry.first + ', ' + entry.second + ', ')).toBe(true)
      expect(sql.endsWith(', ' + entry.last + tail)).toBe(true)
      // Every marker must appear once, in order, without gaps or resets inside a chunk.
      expect(Array.from(sql.matchAll(/\$(\d+)/g), (match) => Number(match[1])))
        .toEqual(Array.from({ length: 500 * entry.width }, (_, index) => index + 1))
      expect(sql.split('NOW(), NOW())')).toHaveLength(501)
      if (size === 501) expect(query.mock.calls[1]).toEqual([entry.scalar, [...rows[500]]])
    })

    it('reports all cold inserts and all conflict updates with exact count shapes', async () => {
      const rows = [entry.row(0), entry.row(1)]
      const query = vi.fn(async () => ({ rows: [{ created: true }, { created: true }] }))
      expect(await entry.upsert(query, rows)).toEqual({ createdCount: 2, updatedCount: 0 })
      query.mockResolvedValueOnce({ rows: [{ created: false }, { created: false }] })
      expect(await entry.upsert(query, rows)).toEqual({ createdCount: 0, updatedCount: 2 })
    })

    it('counts only literal true and treats missing fake result rows as updates across chunks', async () => {
      const rows = Array.from({ length: 501 }, (_, index) => entry.row(index))
      const query = vi.fn(async () => ({
        rows: [{ created: true }, { created: false }, { created: 'true' }, { created: 1 }, {}, { created: null }],
      }))
      query.mockResolvedValueOnce({ rows: [{ created: true }] }).mockResolvedValueOnce({ rows: [] })
      expect(await entry.upsert(query, rows)).toEqual({ createdCount: 1, updatedCount: 500 })
      expect(await entry.upsert(query, rows.slice(0, 6))).toEqual({ createdCount: 1, updatedCount: 5 })
    })

    it('propagates a later chunk failure unchanged and issues no retries or transaction SQL', async () => {
      const failure = new Error('synthetic-query-failure')
      const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ created: true }] }))
      query.mockResolvedValueOnce({ rows: [{ created: true }] }).mockRejectedValueOnce(failure)
      await expect(entry.upsert(query, Array.from({ length: 1001 }, (_, index) => entry.row(index))))
        .rejects.toBe(failure)
      expect(query).toHaveBeenCalledTimes(2)
      expect(query.mock.calls[1][0]).toBe(query.mock.calls[0][0])
      expect(query.mock.calls.every(([sql]) => sql.startsWith(`INSERT INTO directory_${entry.name === 'account' ? 'accounts' : 'departments'} (`))).toBe(true)
    })
  })
}
