import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), enter: vi.fn() }))
vi.mock('../../src/admin/user-recycle', () => ({ isLastSignInPlatformAdmin: vi.fn() }))
vi.mock('../../src/rbac/service', () => ({ invalidateUserPerms: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: mocks.query, transaction: mocks.transaction, pool: null }))
vi.mock('../../src/rbac/authorization-input-lock', async (load) => ({
  ...await load<typeof import('../../src/rbac/authorization-input-lock')>(),
  withAuthorizationInputTransaction: mocks.enter,
}))
import { commitAuthorizationOperation } from '../../src/admin/authorization-operation-service'

const input = { targetUserId:'target', action:{kind:'role.assign' as const,roleId:'ordinary'}, admissionChanges:[], clientOperationId:'00000000-0000-4000-8000-000000000001', expectedVersion:`opaque-v1:${'a'.repeat(64)}` }
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done => {resolve=done}); return {promise,resolve} }
async function flush() { for (let i=0;i<6;i+=1) await Promise.resolve() }
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('authorization operation planning deadline', () => {
  it('returns unknown and never starts the roles read if receipt lookup exceeds the deadline', async () => {
    vi.useFakeTimers()
    const blocked=deferred<{rows: unknown[]}>(); mocks.query.mockReturnValueOnce(blocked.promise)
    const promise=commitAuthorizationOperation('actor',input,async()=>undefined)
    const outcome=expect(promise).rejects.toMatchObject({status:503,code:'AUTHORIZATION_OPERATION_OUTCOME_UNKNOWN'})
    await vi.advanceTimersByTimeAsync(5001); await outcome
    blocked.resolve({rows:[]}); await flush()
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.enter).not.toHaveBeenCalled()
  })
  it('returns unknown and never starts the write transaction if role planning exceeds the deadline', async () => {
    vi.useFakeTimers()
    const blocked=deferred<{rows: unknown[]}>(); mocks.query.mockResolvedValueOnce({rows:[]}).mockReturnValueOnce(blocked.promise)
    const promise=commitAuthorizationOperation('actor',input,async()=>undefined)
    const outcome=expect(promise).rejects.toMatchObject({status:503,code:'AUTHORIZATION_OPERATION_OUTCOME_UNKNOWN'})
    await vi.advanceTimersByTimeAsync(5001); await outcome
    blocked.resolve({rows:[]}); await flush()
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.enter).not.toHaveBeenCalled()
  })
})
