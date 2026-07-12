// Self-test for the UI-P2-1c T4 harness (mount-behind-flow.ts) — proves each of its four pieces
// actually does what its doc comment claims:
//   1. mountBehindFlow / cleanupBehindFlowMounts — real DOM mount + tracked teardown.
//   2. createRoutedApiClient — a real MultitableApiClient wired to a router fn, with a working
//      default-fallback and a working thrown-error path (both are load-bearing: a manager's
//      migration spec relies on driving BOTH the success phase and the error phase).
//   3. patchMultitableClient — monkey-patches + restores a method on the shared singleton, proving
//      a SINGLETON composable (like TrashModal's useTrash()) can be driven to its loaded phase with
//      no client prop at all.
//   4. End-to-end: a tiny stand-in "behind-flow" component (async client call gated by a `visible`
//      watch, matching the real managers' shape) is mounted in a loading state, then flushed to its
//      post-load, button-bearing phase, and its button is clicked for a real emit assertion — the
//      exact sequence a `*-migration.spec.ts` for TrashModal / MetaFormShareManager performs.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, watch } from 'vue'
import {
  cleanupBehindFlowMounts,
  createRoutedApiClient,
  flushBehindFlow,
  mountBehindFlow,
  patchMultitableClient,
} from './mount-behind-flow'
import { multitableClient } from '../../src/multitable/api/client'

afterEach(() => {
  cleanupBehindFlowMounts()
})

describe('mountBehindFlow / cleanupBehindFlowMounts', () => {
  const Trivial = defineComponent({
    props: { label: { type: String, default: 'hi' } },
    emits: ['ping'],
    setup(props, { emit }) {
      return () => h('button', { class: 'trivial-btn', onClick: () => emit('ping') }, props.label)
    },
  })

  it('mounts a component into a real document.body div and it is queryable', () => {
    const { container } = mountBehindFlow(Trivial, { label: 'hello' })
    expect(document.body.contains(container)).toBe(true)
    expect(container.querySelector('.trivial-btn')?.textContent).toBe('hello')
  })

  it('real DOM click fires a real emit', () => {
    const onPing = vi.fn()
    const { container } = mountBehindFlow(Trivial, { onPing })
    ;(container.querySelector('.trivial-btn') as HTMLButtonElement).click()
    expect(onPing).toHaveBeenCalledTimes(1)
  })

  it('cleanupBehindFlowMounts removes every tracked mount from the DOM', () => {
    const a = mountBehindFlow(Trivial, {})
    const b = mountBehindFlow(Trivial, {})
    expect(document.body.contains(a.container)).toBe(true)
    expect(document.body.contains(b.container)).toBe(true)
    cleanupBehindFlowMounts()
    expect(document.body.contains(a.container)).toBe(false)
    expect(document.body.contains(b.container)).toBe(false)
  })

  it('an individually-unmounted mount is a no-op on the later cleanup sweep (idempotent)', () => {
    const a = mountBehindFlow(Trivial, {})
    a.unmount()
    expect(document.body.contains(a.container)).toBe(false)
    // Must not throw when the sweep encounters an already-unmounted entry.
    expect(() => cleanupBehindFlowMounts()).not.toThrow()
  })
})

describe('createRoutedApiClient', () => {
  it('dispatches through the router and unwraps the { data } envelope like the real client', async () => {
    const { client, fetchFn } = createRoutedApiClient((method, url) => {
      if (method === 'GET' && url.includes('/bases')) return { bases: [{ id: 'b1', name: 'Base 1' }] }
      return undefined
    })
    const result = await client.listBases()
    expect(result.bases).toEqual([{ id: 'b1', name: 'Base 1' }])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('falls back to defaultResponse when the router returns undefined', async () => {
    const { client } = createRoutedApiClient(() => undefined, { defaultResponse: { bases: [] } })
    const result = await client.listBases()
    expect(result.bases).toEqual([])
  })

  it('falls back to {} when neither the router nor defaultResponse match (matches real-client shape)', async () => {
    const { client } = createRoutedApiClient(() => undefined)
    const result = await client.listBases()
    // MultitableApiClient#listBases does `{ bases: Array.isArray(...) ? ... : [] }`-style guarding
    // in most list endpoints, but listBases just returns the parsed body directly — an empty body
    // still round-trips through the client without throwing, proving the envelope wiring works.
    expect(result).toEqual({})
  })

  it('a thrown router error surfaces as a rejected client call (simulates a network failure)', async () => {
    const { client } = createRoutedApiClient(() => {
      throw new Error('boom: simulated network failure')
    })
    await expect(client.listBases()).rejects.toThrow('boom: simulated network failure')
  })
})

describe('patchMultitableClient', () => {
  it('monkey-patches a method on the shared singleton and restore() puts the original back', async () => {
    const original = multitableClient.listBases
    const { restore } = patchMultitableClient({
      listBases: async () => ({ bases: [{ id: 'patched', name: 'Patched Base' }] }),
    })
    expect(multitableClient.listBases).not.toBe(original)
    const result = await multitableClient.listBases()
    expect(result.bases[0].id).toBe('patched')

    restore()
    expect(multitableClient.listBases).toBe(original)
  })
})

// End-to-end: a stand-in component shaped exactly like the real "behind-flow" managers — it starts
// in a loading state and only renders its action button once an API call (gated by a `visible`
// watch, same as MetaFormShareManager's own `watch(() => props.visible, loadConfig)`) resolves.
describe('end-to-end: driving a behind-flow-shaped component to its button-bearing phase', () => {
  const BehindFlowStandIn = defineComponent({
    props: {
      visible: { type: Boolean, default: false },
      client: { type: Object, required: true },
    },
    emits: ['loaded-name'],
    setup(props, { emit }) {
      const loading = ref(false)
      const name = ref<string | null>(null)
      watch(
        () => props.visible,
        async (visible) => {
          if (!visible) return
          loading.value = true
          const res = await props.client.listBases()
          name.value = res.bases?.[0]?.name ?? null
          loading.value = false
        },
        { immediate: true },
      )
      return () => {
        if (loading.value || name.value === null) return h('div', { class: 'sfi-loading' }, 'loading…')
        return h(
          'button',
          { class: 'sfi-action', onClick: () => emit('loaded-name', name.value) },
          `Action for ${name.value}`,
        )
      }
    },
  })

  it('renders only the loading state before the client call resolves', () => {
    const { client } = createRoutedApiClient(() => ({ bases: [{ id: 'b1', name: 'Base 1' }] }))
    const { container } = mountBehindFlow(BehindFlowStandIn, { visible: true, client })
    expect(container.querySelector('.sfi-loading')).toBeTruthy()
    expect(container.querySelector('.sfi-action')).toBeNull()
  })

  it('flushBehindFlow drives it past the load into the button-bearing phase, and the button click emits real data', async () => {
    const { client } = createRoutedApiClient((method, url) => {
      if (method === 'GET' && url.includes('/bases')) return { bases: [{ id: 'b1', name: 'Base 1' }] }
      return undefined
    })
    const onLoadedName = vi.fn()
    const { container } = mountBehindFlow(BehindFlowStandIn, { visible: true, client, onLoadedName })
    await flushBehindFlow()

    const btn = container.querySelector('.sfi-action') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toBe('Action for Base 1')

    btn.click()
    expect(onLoadedName).toHaveBeenCalledWith('Base 1')
  })

  it('SINGLETON-shape: patchMultitableClient can drive the same stand-in without any client prop wiring', async () => {
    const { restore } = patchMultitableClient({
      listBases: async () => ({ bases: [{ id: 'b2', name: 'Singleton Base' }] }),
    })
    try {
      // No `client` prop passed at all — the component reaches for the shared singleton directly,
      // exactly like TrashModal's useTrash() falling back to `multitableClient`.
      const SingletonStandIn = defineComponent({
        props: { visible: { type: Boolean, default: false } },
        setup(props) {
          const loading = ref(false)
          const name = ref<string | null>(null)
          watch(
            () => props.visible,
            async (visible) => {
              if (!visible) return
              loading.value = true
              const res = await multitableClient.listBases()
              name.value = res.bases?.[0]?.name ?? null
              loading.value = false
            },
            { immediate: true },
          )
          return () => (name.value === null ? h('div', { class: 'sfi-loading' }, 'loading…') : h('button', { class: 'sfi-action' }, `Action for ${name.value}`))
        },
      })
      const { container } = mountBehindFlow(SingletonStandIn, { visible: true })
      await flushBehindFlow()
      expect(container.querySelector('.sfi-action')?.textContent).toBe('Action for Singleton Base')
    } finally {
      restore()
    }
  })
})
