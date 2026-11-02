import { describe, expect, it, vi } from 'vitest'
import { archiveDerivedFailureCode } from '../utils/recovery-archive-derived-diagnostic'

describe('archive derived test IPC error admission', () => {
  it('retains a lock SQLSTATE without exposing processor values', () => {
    expect(archiveDerivedFailureCode({ code: '55P03', message: 'fixture-sensitive-value', detail: 'fixture-private-detail' }))
      .toBe('55P03')
    expect(archiveDerivedFailureCode(new Error('RECOVERY_DERIVED_AUTHORITY_UNAVAILABLE')))
      .toBe('RECOVERY_DERIVED_AUTHORITY_UNAVAILABLE')
  })

  it('does not expose unknown codes or message values', () => {
    expect(archiveDerivedFailureCode({ code: 'fixture-private-code', message: 'fixture-sensitive-value' })).toBe('other')
    expect(archiveDerivedFailureCode(new Error('fixture-sensitive-value'))).toBe('other')
    expect(archiveDerivedFailureCode('fixture-sensitive-value')).toBe('other')
  })

  it('never invokes accessors or inherited error fields', () => {
    const getter = vi.fn(() => { throw new Error('fixture-sensitive-value') })
    const error = Object.create({ code: '55P03' }) as object
    Object.defineProperty(error, 'message', { get: getter })
    expect(archiveDerivedFailureCode(error)).toBe('other')
    expect(getter).not.toHaveBeenCalled()
  })

  it('cannot mask the original failure when a thrown object rejects inspection', () => {
    const error = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('fixture-sensitive-value') } })
    expect(archiveDerivedFailureCode(error)).toBe('other')
    expect(archiveDerivedFailureCode(null)).toBe('other')
  })
})
