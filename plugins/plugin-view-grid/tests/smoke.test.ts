import { describe, it, expect, vi } from 'vitest'
import GridRuntimePlugin from '../src/runtime'

describe('plugin-view-grid runtime smoke', () => {
  it('registers component metadata and formula service through core events', () => {
    const emit = vi.fn()
    const context = {
      core: {
        events: {
          emit,
        },
      },
    } as any

    GridRuntimePlugin.activate(context)

    expect(emit).toHaveBeenNthCalledWith(
      1,
      'plugin:component:register',
      expect.objectContaining({
        name: 'grid-view',
        component: 'GridView',
        bundle: {
          js: 'dist/index.js.mjs',
          css: 'dist/style.css',
        },
      }),
    )
    expect(emit).toHaveBeenNthCalledWith(
      2,
      'plugin:service:register',
      expect.objectContaining({
        name: 'formula-engine',
        version: '1.0.0',
      }),
    )

    expect(() => GridRuntimePlugin.deactivate()).not.toThrow()
  })
})
