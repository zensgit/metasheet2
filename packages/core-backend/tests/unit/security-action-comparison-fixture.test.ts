import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertSeamDatabaseOwner, validateSeamBaseDatabaseUrl, validateSeamDatabaseUrl } from '../fixtures/security-action-comparison-seam/database-owner.mjs'

const schema = 'sa_wpc_admit_0123456789abcdef'
const options = `-c search_path=${schema} -c application_name=sa_wpc_seam_smoke`
const localUrl = () => {
  const url = new URL('postgresql://fixture@127.0.0.1:5432/fixture')
  url.searchParams.set('options', options)
  return url
}
const owner = { nonce: 'a'.repeat(64), databaseOid: '11', schemaOid: '22', ownerOid: '33' }
const ownedRow = { database_oid: '11', schema_oid: '22', owner_oid: '33', nonce: owner.nonce, owned: true }

describe('comparison fixture database boundary', () => {
  it('accepts loopback TCP and a current-user canonical Unix directory without a host-specific prefix', () => {
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      const url = localUrl()
      url.hostname = hostname
      expect(validateSeamDatabaseUrl(url.toString(), schema, 'smoke').hostname).toBe(hostname === 'localhost' ? '127.0.0.1' : hostname)
    }
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'sa-seam-owner-'))
    try {
      const url = localUrl()
      url.searchParams.set('host', directory)
      expect(validateSeamDatabaseUrl(url.toString(), schema, 'smoke').searchParams.get('host')).toBe(directory)
      chmodSync(directory, 0o755)
      expect(() => validateSeamDatabaseUrl(url.toString(), schema, 'smoke')).toThrow('SEAM_DATABASE_REFUSED')
      chmodSync(directory, 0o700)
      const link = `${directory}-link`
      symlinkSync(directory, link)
      try {
        url.searchParams.set('host', link)
        expect(() => validateSeamDatabaseUrl(url.toString(), schema, 'smoke')).toThrow('SEAM_DATABASE_REFUSED')
      } finally {
        rmSync(link)
      }
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  it('rejects external transports, duplicate/redirecting connection parameters and unowned search paths', () => {
    const changes: Array<(url: URL) => void> = [
      (url) => { url.hostname = 'example.invalid' },
      (url) => { url.hostname = '192.0.2.1' },
      (url) => { url.searchParams.set('host', '127.0.0.1') },
      (url) => { url.searchParams.append('host', '/tmp'); url.searchParams.append('host', '/tmp') },
      (url) => { url.searchParams.set('hostaddr', '192.0.2.1') },
      (url) => { url.searchParams.set('service', 'external') },
      (url) => { url.searchParams.append('options', options) },
      (url) => { url.searchParams.set('options', '-c search_path=public') },
      (url) => { url.port = '' },
      (url) => { url.hash = 'fragment' },
    ]
    for (const change of changes) {
      const url = localUrl()
      change(url)
      expect(() => validateSeamDatabaseUrl(url.toString(), schema, 'smoke')).toThrow('SEAM_DATABASE_REFUSED')
    }
  })

  it('normalizes the parent connection and refuses caller-supplied PostgreSQL options', () => {
    const url = localUrl()
    url.hostname = 'localhost'
    expect(() => validateSeamBaseDatabaseUrl(url.toString())).toThrow('SEAM_DATABASE_REFUSED')
    url.searchParams.delete('options')
    expect(validateSeamBaseDatabaseUrl(url.toString()).hostname).toBe('127.0.0.1')
  })

  it('requires one exact current database/schema/role/nonce match from the catalog read', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [ownedRow] })
    await assertSeamDatabaseOwner(query, schema, owner)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual([schema])
    expect(query.mock.calls[0][0]).toContain('pg_catalog.obj_description')
    for (const rows of [[], [ownedRow, ownedRow], ...[
      { database_oid: '12' }, { schema_oid: '23' }, { owner_oid: '34' },
      { nonce: 'b'.repeat(64) }, { owned: false },
    ].map((changed) => [{ ...ownedRow, ...changed }])]) {
      await expect(assertSeamDatabaseOwner(vi.fn().mockResolvedValue({ rows }), schema, owner)).rejects.toThrow('SEAM_DATABASE_REFUSED')
    }
    query.mockClear()
    await expect(assertSeamDatabaseOwner(query, schema, { ...owner, extra: true })).rejects.toThrow('SEAM_DATABASE_REFUSED')
    expect(query).not.toHaveBeenCalled()
  })
})
