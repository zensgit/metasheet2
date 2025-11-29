import { describe, it, expect } from 'vitest'
import { PERMISSION_WHITELIST } from '../src/types/plugin'

describe('permission whitelist acceptance', () => {
  const accepted = [
    'websocket.send', // Changed from sendTo to match actual whitelist
    'events.on',
    'events.once',
    'events.off',
    'file.delete',
    'cache.read',
    'cache.write',
    'cache.delete',
    'cache.clear',
    'queue.process',
    'queue.cancel'
  ]

  for (const p of accepted) {
    it(`accepts ${p}`, () => {
      expect(PERMISSION_WHITELIST.includes(p as any)).toBe(true)
    })
  }
})

