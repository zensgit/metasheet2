import { describe, expect, it } from 'vitest'
import { readErrorMessage } from '../../src/utils/error'

describe('readErrorMessage', () => {
  it('returns top-level error when it is a string', () => {
    expect(
      readErrorMessage({ error: 'top error' }, 'fallback'),
    ).toBe('top error')
  })

  it('returns message field when top-level error is an object', () => {
    expect(
      readErrorMessage({ error: { message: 'object error' } }, 'fallback'),
    ).toBe('object error')
  })

  it('returns nested data.error when top-level is not available', () => {
    expect(
      readErrorMessage({ data: { error: 'nested error' } }, 'fallback'),
    ).toBe('nested error')
  })

  it('returns record message as fallback before default fallback text', () => {
    expect(
      readErrorMessage({ message: 'payload message' }, 'fallback'),
    ).toBe('payload message')
  })

  it('returns fallback when no message is extractable', () => {
    expect(readErrorMessage({}, 'fallback')).toBe('fallback')
    expect(readErrorMessage('invalid', 'fallback')).toBe('fallback')
  })
})
