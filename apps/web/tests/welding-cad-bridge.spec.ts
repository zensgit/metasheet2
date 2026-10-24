import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createCadBridge, loadReadOnlyCad, type CadWire } from '../src/services/welding/cadBridge'
const schema = 'vemcad-weld-bridge/5'
const overlay = () => ({ schema: 'vemcad-weld-overlay/1', snapshot: { meta: { unit: 'mm' }, entities: [] }, bindings: [] })
const cleanups: Array<() => void> = []
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture(source = '') {
  const frame = document.createElement('iframe'); if (source) frame.src = source; document.body.appendChild(frame); const peer = frame.contentWindow!, sent: CadWire[] = []
  vi.spyOn(peer, 'postMessage').mockImplementation(message => { sent.push(message) })
  let seq = 0, current = true
  const action = vi.fn(async () => ++seq), error = vi.fn(), cancelled = vi.fn()
  const bridge = createCadBridge({ window, frame, getLocalSeq: () => seq, accepts: () => current, onAction: action, onError: error, onIntentCancelled: cancelled })
  const emit = (message: CadWire, origin = window.location.origin, source: MessageEventSource = peer) => window.dispatchEvent(new MessageEvent('message', { data: message, origin, source }))
  const reply = (command: CadWire, type: string, data: CadWire) => emit({ ...command, type, data })
  async function opened() {
    const job = bridge.load({ context_id: 'context', unit: 'mm', cadgf_document: {} }, null)
    emit({ schema, type: 'ready', frame_nonce: 'frame' }); await settle()
    reply(sent.at(-1)!, 'helloAck', { native_ticket: { context_key: null, edit_revision: 0 } }); await settle()
    reply(sent.at(-1)!, 'loaded', { snapshot: overlay(), native_ticket: { context_key: 'context', edit_revision: 1 }, local_seq: 0 }); await job
  }
  function nativeAction(overrides: CadWire = {}) { const command = sent.find(m => m.type === 'load')!; return { ...command, type: 'action', request_id: 'action1', data: { action_id: 'action1', command_id: 'entity.create', business_intent_id: null, base_local_seq: 0, before: overlay(), after: { ...overlay(), snapshot: { meta: { unit: 'mm' }, entities: [{ id: 1 }] } }, native_ticket: { context_key: 'context', edit_revision: 2 }, ...overrides } } }
  cleanups.push(() => { bridge.destroy(); frame.remove() })
  return { frame, peer, bridge, emit, reply, sent, opened, nativeAction, action, error, cancelled, setSeq: (value: number) => { seq = value }, invalidate: () => { current = false } }
}
async function nativeFixture(changeReply = (message: CadWire) => message, firstId = 101) {
  const require = createRequire(import.meta.url), root = process.env.WELDING_CAD_TEST_ROOT ?? '/Users/chouhua/.codex/worktrees/welding-f18c-representations/CADGameFusion'
  const { workspace, context } = require(`${root}/tools/web_viewer/tests/helpers/welding_entry_harness.js`)
  const { installWeldingMessageBridge } = require(`${root}/tools/web_viewer/bridge/welding_message_bridge.js`)
  const f = fixture(), ws = workspace(), nativeWindow = new EventTarget() as EventTarget & CadWire, source = context()
  source.overlay.snapshot.entities[0].id = firstId; source.overlay.bindings[0].entity_ids = [firstId]
  ws.state = { selection: ws.selection }; nativeWindow.location = { origin: window.location.origin }; nativeWindow.crypto = crypto
  nativeWindow.parent = { postMessage: (message: CadWire) => f.emit(changeReply(message)) }
  vi.mocked(f.peer.postMessage).mockImplementation(message => {
    f.sent.push(message); const event = new Event('message')
    Object.defineProperties(event, { data: { value: message }, origin: { value: window.location.origin }, source: { value: nativeWindow.parent } }); nativeWindow.dispatchEvent(event)
  })
  const native = installWeldingMessageBridge({ window: nativeWindow, workspace: ws, setBlocked() {} }); cleanups.push(native.destroy)
  await f.bridge.load({ context_id: 'context', unit: 'mm', cadgf_document: source.cadgf_document }, source.overlay)
  return { ...f, ws }
}
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })
describe('actual parent bridge/5 consumer', () => {
  it.each([101, 0])('selects the first native entity %i by default and clears selection', async firstId => {
    const f = await nativeFixture(undefined, firstId)
    const selected = await f.bridge.select([firstId, 102])
    expect(selected.entity_ids).toEqual([firstId, 102]); expect(selected.primary_id).toBe(firstId)
    expect(f.ws.selection.primaryId).toBe(firstId); expect(f.error).not.toHaveBeenCalled()
    const cleared = await f.bridge.select([])
    expect(cleared.entity_ids).toEqual([]); expect(cleared.primary_id).toBeNull(); expect(f.error).not.toHaveBeenCalled()
  })
  it('keeps an explicit native primary and refuses one outside the selection before dispatch', async () => {
    const f = await nativeFixture()
    expect((await f.bridge.select([101, 102], 102)).primary_id).toBe(102)
    const count = f.sent.length
    await expect(f.bridge.select([101, 102], 103)).rejects.toThrow()
    expect(f.sent).toHaveLength(count); expect(f.ws.selection.primaryId).toBe(102); expect(f.error).not.toHaveBeenCalled()
  })
  it.each(['primary', 'entities'])('still rejects a mismatched native selection ACK %s', async field => {
    const f = await nativeFixture(message => message.type === 'selected' ? { ...message, data: { ...message.data, ...(field === 'primary' ? { primary_id: 102 } : { entity_ids: [101] }) } } : message)
    await expect(f.bridge.select([101, 102])).rejects.toThrow()
    expect(f.ws.selection.entityIds).toEqual([101, 102]); expect(f.error).toHaveBeenCalledOnce()
  })
  it('unloads the editor on ready timeout and rejects pending load', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture('/old-editor.html'), job = f.bridge.load({ context_id: 'context', unit: 'mm', cadgf_document: {} }, null)
      const rejected = expect(job).rejects.toThrow('图纸编辑器启动超时')
      f.frame.contentDocument!.open(); f.frame.contentDocument!.write('<html><body>OLD EDITOR</body></html>'); f.frame.contentDocument!.close()
      await vi.advanceTimersByTimeAsync(15000); await rejected
      expect(f.frame.getAttribute('src')).toBeNull(); expect(f.frame.contentDocument?.body?.textContent).not.toContain('OLD EDITOR')
      expect(f.error).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('unloads on close but late completion and repeated old destroy preserve a new bridge document', async () => {
    const f = fixture('/old-editor.html'); await f.opened(); let complete!: () => void
    f.action.mockImplementationOnce(() => new Promise(resolve => { complete = () => { f.setSeq(1); resolve(1) } }))
    f.emit(f.nativeAction()); await settle(); expect(f.action).toHaveBeenCalledOnce()
    f.frame.contentDocument!.open(); f.frame.contentDocument!.write('<html><body>OLD EDITOR</body></html>'); f.frame.contentDocument!.close(); f.bridge.destroy()
    expect(f.frame.getAttribute('src')).toBeNull(); expect(f.frame.contentDocument?.body?.textContent).not.toContain('OLD EDITOR')
    f.frame.src = '/new-editor.html'
    const next = createCadBridge({ window, frame: f.frame, getLocalSeq: () => 1, accepts: () => true, onAction: async () => 2 })
    cleanups.push(next.destroy)
    f.bridge.destroy(); complete(); await settle()
    expect(f.frame.getAttribute('src')).toBe('/new-editor.html'); expect(f.sent.some(m => m.type === 'actionAccepted')).toBe(false)
    next.destroy(); expect(f.frame.getAttribute('src')).toBeNull()
  })
  it('waits for durable action completion before ACK and retries only identical last action', async () => {
    const f = fixture(); await f.opened(); let complete!: () => void
    f.action.mockImplementationOnce(() => new Promise(resolve => { complete = () => { f.setSeq(1); resolve(1) } }))
    const native = f.nativeAction(); f.emit(native); await settle(); expect(f.action).toHaveBeenCalledOnce(); expect(f.sent.some(m => m.type === 'actionAccepted')).toBe(false)
    f.emit(native); complete(); await settle()
    expect(f.action).toHaveBeenCalledOnce(); expect(f.sent.filter(m => m.type === 'actionAccepted')).toHaveLength(2)
    expect(f.sent.at(-1)!.data.local_seq).toBe(1)
  })
  it.each(['wrong source', 'wrong origin', 'wrong nonce', 'wrong epoch'])('ignores %s before action dispatch', async reason => {
    const f = fixture(); await f.opened(); const message = f.nativeAction()
    if (reason === 'wrong nonce') message.nonce = 'wrong'
    if (reason === 'wrong epoch') message.epoch++
    f.emit(message, reason === 'wrong origin' ? 'https://other.test' : window.location.origin, reason === 'wrong source' ? window : f.peer)
    await settle(); expect(f.action).not.toHaveBeenCalled(); expect(f.sent.some(m => m.type === 'actionAccepted')).toBe(false)
  })
  it.each([{ native_ticket: { context_key: 'other', edit_revision: 2 } }, { base_local_seq: 1 }, { before: { ...overlay(), bindings: [{}] } }, { business_intent_id: 'unsolicited' }, { command_id: 'unapproved.command' }])('refuses ticket/sequence/before/intent mismatch %j', async invalid => {
    const f = fixture(); await f.opened(); f.emit(f.nativeAction(invalid)); await settle(); expect(f.action).not.toHaveBeenCalled(); expect(f.error).toHaveBeenCalledOnce()
  })
  it('does not ACK quota failure or owner change during durable commit', async () => {
    for (const changed of [false, true]) {
      const f = fixture(); await f.opened(); f.action.mockImplementationOnce(async () => { if (!changed) throw new Error('quota'); f.setSeq(1); f.invalidate(); return 1 })
      f.emit(f.nativeAction()); await settle(); expect(f.sent.some(m => m.type === 'actionAccepted')).toBe(false); expect(f.error).toHaveBeenCalledOnce()
    }
  })
  it('arms an intent with exact ticket and explicitly cancels using snapshot acknowledgement', async () => {
    const f = fixture(); await f.opened(); const job = f.bridge.armDraw({ intent_id: 'intent', weld_id: 'w1', display_no: '1', tool: 'line' }); await settle()
    const command = f.sent.at(-1)!; f.reply(command, 'drawArmed', { intent_id: 'intent', native_ticket: command.data.expected_ticket, local_seq: 0 }); await job
    const cancel = f.bridge.snapshot(); await settle(); f.reply(f.sent.at(-1)!, 'snapshotResult', { snapshot: overlay(), native_ticket: { context_key: 'context', edit_revision: 1 }, local_seq: 0 }); await cancel
    expect(f.cancelled).toHaveBeenCalledWith('intent'); expect(f.action).not.toHaveBeenCalled()
  })
  it('rejects a business completion before its atomic action ACK', async () => {
    const f = fixture(); await f.opened(); const job = f.bridge.copyWeld({ intent_id: 'copy', source_weld_id: 'w1', weld_id: 'w2', display_no: '2', delta: { x: 1, y: 1 } }); void job.catch(() => {}); await settle()
    f.reply(f.sent.at(-1)!, 'copied', { intent_id: 'copy', snapshot: overlay(), native_ticket: { context_key: 'context', edit_revision: 2 }, local_seq: 0 })
    await expect(job).rejects.toThrow(); expect(f.action).not.toHaveBeenCalled()
  })
  it('matches restore payload and next local sequence without manufacturing a business action', async () => {
    const f = fixture(); await f.opened(); const job = f.bridge.restore(null, 1); await settle(); f.reply(f.sent.at(-1)!, 'restored', { snapshot: overlay(), native_ticket: { context_key: 'context', edit_revision: 2 }, local_seq: 1 }); await job
    expect(f.action).not.toHaveBeenCalled(); expect(f.sent.at(-1)!.epoch).toBe(1)
  })
  it('waits for exact readonly loaded acknowledgement and rejects the wrong unit', async () => {
    for (const unit of ['mm', 'in']) {
      const f = fixture(), doc = { cadgf_document: {}, payload: {}, origin: { unit: 'mm' } }
      let source = ''; vi.spyOn(f.frame, 'src', 'set').mockImplementation(value => { source = value })
      const view = loadReadOnlyCad(f.frame, '/fixed-history.html', doc, () => true); cleanups.push(view.destroy); void view.loaded.catch(() => {})
      const nonce = source.split('#nonce=')[1], receive = (type: string, request_id: string | null, data: unknown) => f.emit({ schema: 'vemcad-weld-readonly/1', type, nonce, frame_nonce: 'readonly', request_id, data })
      receive('ready', null, null); const command = f.sent.at(-1)!; expect(command.type).toBe('load'); expect(command.data.overlay).toBeNull()
      receive('loaded', command.request_id, { unit })
      if (unit === 'mm') await expect(view.loaded).resolves.toBeUndefined(); else await expect(view.loaded).rejects.toThrow()
    }
  })
})
