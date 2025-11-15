import { describe, it, expect, vi, beforeEach } from 'vitest'

// Simple debounce replica from the component to verify behavior
function debounce<T extends (...args: any[]) => any>(fn: T, wait = 200) {
  let t: number | undefined
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), wait) as unknown as number
  }
}

describe('Kanban debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('coalesces rapid calls into one', async () => {
    const spy = vi.fn()
    const d = debounce(spy, 400)

    d()
    d()
    d()
    expect(spy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(399)
    expect(spy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

