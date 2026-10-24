import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, effectScope, nextTick } from 'vue'
import { createRequire } from 'node:module'
import { nativeOracleRoot } from './utils/weldingNativeOracle'
import Panel from '../src/views/welding/WeldingCadPanel.vue'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { useWeldingCadSession } from '../src/views/welding/useWeldingCadSession'
import { useWeldingWorkflowSession } from '../src/views/welding/useWeldingWorkflowSession'
import { useWeldingGenerationSession } from '../src/views/welding/useWeldingGenerationSession'
import { clone, equal, type PlanRecoveryRecord, type PlanRecoveryStore } from '../src/services/welding/planRecovery'
import { WELDING_CAD_PIN, type WeldingPlanClient } from '../src/services/welding/planClient'
import type { CadWire } from '../src/services/welding/cadBridge'
import type { CommandRecoveryStore } from '../src/services/welding/commandRecovery'

// Resolve the original module at its pinned runtime URL; do not substitute measurement logic.
vi.mock('/welding-cad/b05b3684664f215ced015f09f23d300fcccf8ba49ea4e8826e1a373070083bb8/helpers/welding_measurement.js', async () => {
  const { createRequire } = await import('node:module')
  const { nativeOracleRoot } = await import('./utils/weldingNativeOracle')
  return createRequire(import.meta.url)(`${nativeOracleRoot()}/tools/web_viewer/helpers/welding_measurement.js`)
})
const owner = { tenant_id: 't', org_id: 'o', auth_user_id: 7, rbac_user_id: 19 }, hash = 'a'.repeat(64)
const cleanups: Array<() => void> = []
const inertDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert')
let inertShimInstalled = false
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); void promise.catch(() => {})
  return { promise, resolve, reject }
}
async function setup() {
  const require = createRequire(import.meta.url), cadRoot = nativeOracleRoot()
  const { workspace, context } = require(`${cadRoot}/tools/web_viewer/tests/helpers/welding_entry_harness.js`)
  const { installWeldingMessageBridge } = require(`${cadRoot}/tools/web_viewer/bridge/welding_message_bridge.js`)
  const input = context(), payload = { schema_version: 1, product: { item_id: 'p', version_id: 'pv' }, drawing: { item_id: 'd', version_id: 'dv', file_id: 'f', file_role: 'drawing', expected_checksum: hash }, welds: [{ weld_id: 'weld-1', display_no: 'W1' }], overlay: input.overlay }
  const plan = { plan_id: 'p', item_version_id: 'v', draft_seq: 1, content_hash: hash, state: 'Draft', name: 'P', number: '1', payload, sources: {}, version_label: 'A' }
  const contextRecord = { context_id: 'ctx', plan_id: 'p', item_version_id: 'v', draft_seq: 1, expires_at: new Date(Date.now() + 60000).toISOString(), unit: 'mm', cadgf_document: input.cadgf_document, input_sha256: hash, document_sha256: 'b'.repeat(64), source: {}, editor_url: `/welding-cad/${WELDING_CAD_PIN}/welding-frame.html`, origin: { schema: 'yuantus.welding_plan_cad_origin/1', context_id: 'ctx', owner_auth_user_id: 7, rbac_user_id: 19, bundle_sha256: WELDING_CAD_PIN, unit: 'mm', basis: { product: payload.product, drawing: payload.drawing }, input: { sha256: hash }, document: { sha256: 'b'.repeat(64) }, source: {} } }
  const client = { recoveryOwner: vi.fn(async () => clone(owner)), authority: vi.fn(async () => clone(owner)), read: vi.fn(async () => clone(plan)), list: vi.fn(async () => ({ items: [], total: 0, offset: 0 })), recover: vi.fn(async (_purpose, record) => ({ owner: clone(owner), record_id: record.recovery_id, current: clone(plan), can_write: true, conflict: false })), createCadContext: vi.fn(async () => clone(contextRecord)), cadTicket: vi.fn(async () => ({ asset_url: contextRecord.editor_url })), readReviewState: vi.fn(async () => ({ state: 'Draft', draft_seq: 1, content_hash: hash, is_current: true })) } as unknown as WeldingPlanClient
  let stored: PlanRecoveryRecord | null = null
  const db: PlanRecoveryStore = { list: async () => [], get: async () => clone(stored), claim: vi.fn(async value => { stored = clone(value); return true }), compareReplace: vi.fn(async (before, after) => { if (!equal(before, stored)) return false; stored = clone(after); return true }), close() {} }
  const commands = { get: vi.fn(async () => null), getWorkflow: vi.fn(async () => null), claim: vi.fn(async () => false), clear: vi.fn(async () => false), claimWorkflow: vi.fn(async () => false), clearWorkflow: vi.fn(async () => false), close() {} } satisfies CommandRecoveryStore
  const scope = effectScope(), session = scope.run(() => useWeldingPlanSession({ client, openStore: async () => db, writable: () => true }))!
  await session.initialize(); await session.open('p', 'v')
  const generation = scope.run(() => { useWeldingWorkflowSession({ session, active: () => true, writable: () => true, openStore: async () => commands }); return useWeldingGenerationSession({ session, active: () => true, writable: () => true, openStore: async () => commands }) })
  const root = document.createElement('div'); document.body.append(root)
  const app = createApp(Panel, { session }), vm = app.mount(root)
  const cad = vm.$.setupState.cad as ReturnType<typeof useWeldingCadSession>, frame = root.querySelector('iframe')!, peer = frame.contentWindow!
  const held: CadWire[] = [], sent: CadWire[] = []
  let holdArmed = false, ws: CadWire, native: { destroy(): void } | null = null
  const emit = (message: CadWire) => window.dispatchEvent(new MessageEvent('message', { source: peer, origin: window.location.origin, data: message }))
  // Only the browser transport is replaced. Both bridge consumers and native commands are original.
  vi.spyOn(frame, 'src', 'set').mockImplementation(() => {
    native?.destroy(); ws = workspace(); ws.state = { selection: ws.selection }
    const nativeWindow = new EventTarget() as EventTarget & CadWire
    nativeWindow.location = { origin: window.location.origin }; nativeWindow.crypto = crypto
    nativeWindow.parent = { postMessage(message: CadWire) { if (holdArmed && message.type === 'drawArmed') held.push(clone(message)); else emit(message) } }
    vi.spyOn(peer, 'postMessage').mockImplementation(message => {
      sent.push(clone(message)); const event = new Event('message')
      Object.defineProperties(event, { data: { value: message }, source: { value: nativeWindow.parent }, origin: { value: window.location.origin } }); nativeWindow.dispatchEvent(event)
    })
    native = installWeldingMessageBridge({ window: nativeWindow, workspace: ws, setBlocked() {} })
  })
  cleanups.push(() => { app.unmount(); scope.stop(); native?.destroy(); root.remove() })
  await cad.open(frame); await nextTick(); expect(cad.state.ready).toBe(true); expect(frame.hasAttribute('inert')).toBe(false)
  const draw = () => { const job = cad.draw('line', ''); void job.catch(() => {}); return job }
  return { session, cad, client, db, commands, generation, frame, held, sent, draw, hold: () => { holdArmed = true }, release: (message: CadWire) => emit(message), stored: () => clone(stored), createLine: () => ws.commands.execute('entity.create', { entity: { type: 'line', layerId: 0, start: { x: 10, y: 10 }, end: { x: 20, y: 10 } } }) }
}
beforeEach(() => {
  // jsdom27 lacks this browser DOM property; mirror boolean reflection only, not input isolation.
  if (!('inert' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'inert', { configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('inert') },
      set(this: HTMLElement, value: boolean) { this.toggleAttribute('inert', Boolean(value)) },
    })
    inertShimInstalled = true
  }
  localStorage.setItem('auth_token', 'synthetic-native-A')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, action: () => Promise<unknown>) => action() } })
})
afterEach(() => {
  try { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); delete (navigator as unknown as { locks?: unknown }).locks; localStorage.clear() }
  finally {
    if (inertShimInstalled) {
      if (inertDescriptor) Object.defineProperty(HTMLElement.prototype, 'inert', inertDescriptor)
      else delete (HTMLElement.prototype as unknown as { inert?: boolean }).inert
      inertShimInstalled = false
    }
  }
})

describe('real CAD Panel arming input gate (transport/storage boundaries substituted)', () => {
  it('keeps the combined workflow/generation admission closed on storage failure and recovers after a fresh read', async () => {
    const f = await setup(), action = vi.fn(async () => {})
    f.commands.get.mockRejectedValueOnce(new Error('generation storage unavailable'))
    await expect(f.session.withTargetMutation(action)).rejects.toThrow('generation storage unavailable')
    expect(action).not.toHaveBeenCalled(); expect(f.generation!.state.storageBlocked).toBe(true)
    expect(f.session.state.commandPending).toBe(true); expect(f.session.canEdit.value).toBe(false)
    await f.session.withTargetMutation(action)
    expect(action).toHaveBeenCalledOnce(); expect(f.generation!.state.storageBlocked).toBe(false)
    expect(f.session.state.commandPending).toBe(false); expect(f.session.canEdit.value).toBe(true)
    expect(f.commands.clear).not.toHaveBeenCalled(); expect(f.commands.clearWorkflow).not.toHaveBeenCalled()
  })
  it('does not poison the reopened same target when an old generation read rejects after scope replacement', async () => {
    const f = await setup(), held = deferred<null>(), action = vi.fn(async () => {})
    f.commands.get.mockReturnValueOnce(held.promise)
    const job = f.session.withTargetMutation(action); void job.catch(() => {})
    await vi.waitFor(() => expect(f.commands.get.mock.results.some(result => result.value === held.promise)).toBe(true))
    try {
      f.session.resetEntry(); await f.session.open('p', 'v')
      await vi.waitFor(() => expect(f.session.canEdit.value).toBe(true))
    } finally { held.reject(new Error('old generation read failed')) }
    await expect(job).rejects.toThrow('old generation read failed')
    expect(action).not.toHaveBeenCalled(); expect(f.session.state.planId).toBe('p'); expect(f.session.state.versionId).toBe('v')
    expect(f.generation!.state.storageBlocked).toBe(false); expect(f.session.state.commandPending).toBe(false)
    expect(f.session.canEdit.value).toBe(true)
  })

  it('blocks the iframe from draw entry while actual workflow authority admission is pending', async () => {
    const f = await setup(), authority = deferred<typeof owner>(), entered = deferred<void>()
    vi.mocked(f.client.authority).mockImplementationOnce(() => { entered.resolve(); return authority.promise })
    const before = clone(f.session.state.payload), job = f.draw()
    try {
      await entered.promise; await nextTick()
      expect(f.session.state.commandPending).toBe(true); expect(f.sent.filter(row => row.type === 'armDraw')).toHaveLength(0)
      expect(f.frame.hasAttribute('inert')).toBe(true); expect(f.session.state.payload).toEqual(before); expect(f.db.claim).not.toHaveBeenCalled()
    } finally { authority.resolve(clone(owner)); await job.catch(() => {}) }
  })
  it('stays inert until the actual drawArmed reply, then accepts one native line into durable payload', async () => {
    const f = await setup(); f.hold(); const job = f.draw()
    try {
      await vi.waitFor(() => expect(f.held).toHaveLength(1)); await nextTick()
      expect(f.session.state.commandPending).toBe(false); expect(f.frame.hasAttribute('inert')).toBe(true)
      f.release(f.held[0]); await job; await nextTick(); expect(f.frame.hasAttribute('inert')).toBe(false)
      expect(f.createLine().ok).toBe(true)
      await vi.waitFor(() => expect(f.sent.filter(row => row.type === 'actionAccepted')).toHaveLength(1))
      expect(f.session.state.payload.welds).toHaveLength(2); expect(f.stored()?.draft.payload).toEqual(f.session.state.payload)
    } finally { f.release(f.held[0] ?? {}); await job.catch(() => {}) }
  })
  it('closes the old frame on a controlled native error packet without committing a weld', async () => {
    const f = await setup(); f.hold(); const before = clone(f.session.state.payload), job = f.draw()
    await vi.waitFor(() => expect(f.held).toHaveLength(1))
    f.release({ ...f.held[0], type: 'error', data: { error_code: 'WELD_BRIDGE_INVALID' } })
    await expect(job).rejects.toThrow(); await nextTick()
    expect(f.cad.state.ready).toBe(false); expect(f.cad.state.intent).toBe(''); expect(f.frame.style.display).toBe('none')
    expect(f.session.state.payload).toEqual(before); expect(f.db.claim).not.toHaveBeenCalled()
    await f.cad.open(f.frame); await nextTick(); expect(f.frame.hasAttribute('inert')).toBe(false)
  })
  it('a closed epoch admission failure cannot release the newer arm gate', async () => {
    const f = await setup(), authority = deferred<typeof owner>(), entered = deferred<void>()
    vi.mocked(f.client.authority).mockImplementationOnce(() => { entered.resolve(); return authority.promise })
    const old = f.draw(); await entered.promise; f.cad.close(); await f.cad.open(f.frame); f.hold(); const current = f.draw()
    try {
      await vi.waitFor(() => expect(f.held).toHaveLength(1)); authority.reject(new Error('SYNTHETIC_AUTHORITY_DENIED')); await expect(old).rejects.toThrow()
      await nextTick(); expect(f.cad.state.ready).toBe(true); expect(f.frame.hasAttribute('inert')).toBe(true)
      f.release(f.held[0]); await current; await nextTick(); expect(f.frame.hasAttribute('inert')).toBe(false)
    } finally { authority.resolve(clone(owner)); f.release(f.held[0] ?? {}); await Promise.allSettled([old, current]) }
  })
  it('a closed epoch late ACK cannot release or close a newly arming session', async () => {
    const f = await setup(); f.hold(); const old = f.draw()
    await vi.waitFor(() => expect(f.held).toHaveLength(1)); const late = f.held[0]
    f.cad.close(); await expect(old).rejects.toThrow(); await f.cad.open(f.frame); const current = f.draw()
    try {
      await vi.waitFor(() => expect(f.held).toHaveLength(2)); f.release(late); await nextTick()
      expect(f.cad.state.ready).toBe(true); expect(f.frame.hasAttribute('inert')).toBe(true)
      f.release(f.held[1]); await current; await nextTick(); expect(f.frame.hasAttribute('inert')).toBe(false)
    } finally { f.release(f.held[1] ?? {}); await current.catch(() => {}) }
  })
  it('a closed epoch late successful admission cannot arm the reopened CAD session', async () => {
    const f = await setup(), authority = deferred<typeof owner>(), entered = deferred<void>()
    vi.mocked(f.client.authority).mockImplementationOnce(() => { entered.resolve(); return authority.promise })
    const before = clone(f.session.state.payload), old = f.draw()
    try {
      await entered.promise; f.cad.close(); await f.cad.open(f.frame)
      expect(f.cad.state.ready).toBe(true); expect(f.cad.state.intent).toBe('')
      authority.resolve(clone(owner)); await expect(old).rejects.toThrow(); await nextTick()
      expect(f.sent.filter(row => row.type === 'armDraw')).toHaveLength(0)
      expect(f.cad.state.ready).toBe(true); expect(f.cad.state.intent).toBe(''); expect(f.frame.hasAttribute('inert')).toBe(false)
      expect(f.session.state.payload).toEqual(before); expect(f.stored()).toBeNull(); expect(f.db.claim).not.toHaveBeenCalled()
    } finally { authority.resolve(clone(owner)); await old.catch(() => {}) }
  })
})
