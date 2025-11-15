import { describe, it, expect } from 'vitest'

// Lightweight render checks for dynamic views aggregation logic
import { getViewLoader } from '../src/view-registry'

describe('Dynamic Views - Registry and Fallbacks', () => {
  it('returns loader for known component', () => {
    const loader = getViewLoader('KanbanView')
    expect(typeof loader).toBe('function')
  })

  it('returns undefined for unknown component', () => {
    const loader = getViewLoader('NonExistView')
    expect(loader).toBeUndefined()
  })
})

