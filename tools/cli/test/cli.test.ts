import { describe, it, expect } from 'vitest'

describe('MetaSheet CLI', () => {
  it('should have basic configuration', () => {
    expect(process.env.NODE_ENV).toBeDefined()
  })

  it('should be able to run tests', () => {
    expect(1 + 1).toBe(2)
  })

  it('should support TypeScript', () => {
    const testFunction = (a: number, b: number): number => a + b
    expect(testFunction(2, 3)).toBe(5)
  })
})