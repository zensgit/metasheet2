import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => vi.fn())
vi.mock('../../src/db/pg', () => ({ query: mock }))
import { queryAdminAuditFeed } from '../../src/admin/authorization-operation-audit-feed'

describe('audit relation fallback', () => {
  it('only retries the specifically missing operation tables', async () => {
    mock.mockReset()
    mock.mockRejectedValueOnce({ code: '42P01', message: 'relation "authorization_operation_audit" does not exist' }).mockResolvedValueOnce({ rows: [{ c: 1 }] })
    expect((await queryAdminAuditFeed('SELECT COUNT(*) AS c FROM $AUDIT_FEED', [])).rows).toEqual([{ c: 1 }])
    expect(mock).toHaveBeenCalledTimes(2)
    expect(String(mock.mock.calls[1][0])).not.toContain('authorization_operation_audit')
    mock.mockReset()
    const unrelated = { code: '42P01', message: 'relation "audit_logs" does not exist' }
    mock.mockRejectedValueOnce(unrelated)
    await expect(queryAdminAuditFeed('SELECT * FROM $AUDIT_FEED', [])).rejects.toBe(unrelated)
    expect(mock).toHaveBeenCalledTimes(1)
    mock.mockReset()
    const other = { code: '42501', message: 'permission denied for table authorization_operation_audit' }
    mock.mockRejectedValueOnce(other)
    await expect(queryAdminAuditFeed('SELECT * FROM $AUDIT_FEED', [])).rejects.toBe(other)
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it('mutation probe detects broadening the missing-relation guard', async () => {
    const source = readFileSync(new URL('../../src/admin/authorization-operation-audit-feed.ts', import.meta.url), 'utf8')
    const guard = "if (!missingEvidenceRelation(error)) throw error"
    expect(source).toContain(guard)
    const js = ts.transpileModule(source.replace(guard, 'if (false) throw error'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports: Record<string, unknown> = {}
    const run = vi.fn().mockRejectedValueOnce({ code: '42P01', message: 'relation "audit_logs" does not exist' }).mockResolvedValueOnce({ rows: [] })
    new Function('require', 'exports', js)(() => ({ query: run }), exports)
    const mutant = exports.queryAdminAuditFeed as typeof queryAdminAuditFeed
    await mutant('SELECT * FROM $AUDIT_FEED', [])
    expect(run).toHaveBeenCalledTimes(2)
    console.log('MUTATION CAUGHT: unrelated missing relation is retried')
  })
})
