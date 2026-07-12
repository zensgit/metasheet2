import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Post-closeout P3 defense-in-depth (2026-07-11): the attendance import upload path builder now applies
// output-side containment (resolveImportUploadWithinBase) behind the existing isUuidLike/org-sanitizer
// input gates. These tests exercise the REAL production getImportUploadPaths via the plugin's test seam
// (not a reimplementation) — an interpolated key that resolves outside the base must throw, never escape.
const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const { getImportUploadPaths, resolveImportUploadWithinBase, sanitizeImportUploadOrgId } =
  attendancePlugin.__attendanceImportPathForTests

const VALID_UUID = '11111111-1111-4111-8111-111111111111'

describe('attendance import upload path containment (output-side backstop)', () => {
  describe('resolveImportUploadWithinBase (the containment primitive)', () => {
    it('rejects traversal / absolute / empty keys', () => {
      expect(() => resolveImportUploadWithinBase('/srv/base', '../evil.csv')).toThrow(/outside the base/)
      expect(() => resolveImportUploadWithinBase('/srv/base', '../../etc/passwd')).toThrow(/outside the base/)
      expect(() => resolveImportUploadWithinBase('/srv/base', '/etc/passwd')).toThrow(/outside the base/)
      // resolves to the base itself → rejected (never operate on the base dir as if it were a file)
      expect(() => resolveImportUploadWithinBase('/srv/base', '')).toThrow(/outside the base/)
    })

    it('allows keys contained within the base', () => {
      expect(resolveImportUploadWithinBase('/srv/base', 'file.csv')).toBe(path.resolve('/srv/base', 'file.csv'))
      expect(resolveImportUploadWithinBase('/srv/base', 'sub/file.csv')).toBe(path.resolve('/srv/base', 'sub/file.csv'))
    })
  })

  describe('getImportUploadPaths (the real production path builder)', () => {
    it('throws on a traversal fileId — backstop if a future caller skips the uuid gate', () => {
      expect(() => getImportUploadPaths({ orgId: 'org1', fileId: '../../../../etc/passwd' })).toThrow(
        /outside the base/,
      )
      expect(() => getImportUploadPaths({ orgId: 'org1', fileId: '../secret' })).toThrow(/outside the base/)
    })

    it('sanitizes a traversal orgId so the path cannot escape', () => {
      const { csvPath, dir } = getImportUploadPaths({ orgId: '../../evil', fileId: VALID_UUID })
      expect(csvPath).not.toContain('..')
      expect(dir).not.toContain('..')
      // org sanitizer collapses non-[A-Za-z0-9_-] to '_', so the traversal becomes a plain child dir name
      expect(csvPath.startsWith(dir + path.sep)).toBe(true)
    })

    it('builds the expected contained path for a valid uuid (no regression)', () => {
      const { csvPath, metaPath, dir } = getImportUploadPaths({ orgId: 'org1', fileId: VALID_UUID })
      expect(csvPath).toBe(path.join(dir, `${VALID_UUID}.csv`))
      expect(metaPath).toBe(path.join(dir, `${VALID_UUID}.json`))
      expect(csvPath.startsWith(dir + path.sep)).toBe(true)
    })
  })

  describe('sanitizeImportUploadOrgId', () => {
    it('collapses traversal / separators and falls back to default', () => {
      expect(sanitizeImportUploadOrgId('../../evil')).not.toContain('.')
      expect(sanitizeImportUploadOrgId('a/b')).toBe('a_b')
      expect(sanitizeImportUploadOrgId('')).toBe('default')
      expect(sanitizeImportUploadOrgId(null)).toBe('default')
    })
  })
})
