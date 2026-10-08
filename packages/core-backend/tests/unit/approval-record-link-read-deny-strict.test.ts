/**
 * FWB-0 Layer 2 — strict row-level-read flag resolver for record-link submit.
 *
 * The generic loadRowLevelReadDenyEnabled swallows ALL errors to false (inert for
 * multitable surfaces). Submit no-oracle requires the opposite on unexpected DB
 * failures: fail closed. These goldens lock the strict service-level resolvers.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  isRecordReadDeniedForUserStrict,
  loadRowLevelReadDenyEnabledStrict,
} from '../../src/multitable/permission-service'

describe('record-link strict row-level-read resolvers', () => {
  it('loadRowLevelReadDenyEnabledStrict returns flag value on success', async () => {
    const query = vi.fn(async () => ({
      rows: [{ enabled: true, base_id: 'base-x' }],
    }))
    await expect(loadRowLevelReadDenyEnabledStrict(query, 'sheet-1')).resolves.toBe(true)
    expect(query).toHaveBeenCalledWith(
      'SELECT row_level_read_permissions_enabled AS enabled, base_id FROM meta_sheets WHERE id = $1',
      ['sheet-1'],
    )
  })

  it('loadRowLevelReadDenyEnabledStrict rethrows unexpected DB errors (does not swallow to false)', async () => {
    const query = vi.fn(async () => {
      throw Object.assign(new Error('connection reset'), { code: '57P01' })
    })
    await expect(loadRowLevelReadDenyEnabledStrict(query, 'sheet-1')).rejects.toThrow(/connection reset/)
  })

  it('loadRowLevelReadDenyEnabledStrict treats missing column/table as flag-off (pre-feature inert)', async () => {
    const missingCol = vi.fn(async () => {
      throw Object.assign(new Error('column "row_level_read_permissions_enabled" does not exist'), {
        code: '42703',
      })
    })
    await expect(loadRowLevelReadDenyEnabledStrict(missingCol, 'sheet-1')).resolves.toBe(false)

    const missingTable = vi.fn(async () => {
      throw Object.assign(new Error('relation "meta_sheets" does not exist'), { code: '42P01' })
    })
    await expect(loadRowLevelReadDenyEnabledStrict(missingTable, 'sheet-1')).resolves.toBe(false)
  })

  it('isRecordReadDeniedForUserStrict propagates flag-lookup DB errors (caller fail-closes)', async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes('row_level_read_permissions_enabled')) {
        throw Object.assign(new Error('backend down'), { code: '08006' })
      }
      return { rows: [] }
    })
    await expect(
      isRecordReadDeniedForUserStrict(query, 'sheet-1', 'rec-1', 'user-1'),
    ).rejects.toThrow(/backend down/)
  })

  it('isRecordReadDeniedForUserStrict denies when flag is on and record is in denied set', async () => {
    const query = vi.fn(async (sql: string) => {
      const s = String(sql)
      if (s.includes('row_level_read_permissions_enabled')) {
        return { rows: [{ enabled: true, base_id: 'base-x' }] }
      }
      // loadDeniedRecordIds grant-deny branch
      if (s.includes('record_permissions') && s.includes("access_level = 'none'")) {
        return { rows: [{ record_id: 'rec-denied' }] }
      }
      // other deny loaders (rules / projection) — empty
      return { rows: [] }
    })
    await expect(
      isRecordReadDeniedForUserStrict(query, 'sheet-1', 'rec-denied', 'user-1'),
    ).resolves.toBe(true)
    await expect(
      isRecordReadDeniedForUserStrict(query, 'sheet-1', 'rec-ok', 'user-1'),
    ).resolves.toBe(false)
  })
})
