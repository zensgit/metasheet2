import { clone, equal, exact, isObject, need, jsonBytes } from './planRecovery'

// Native CAD is a closed, runtime-validated JSON protocol. Geometry bodies remain
// opaque here; the business consumer checks role ownership and complete payloads.
export type CadWire = Record<string, any>
interface NativeTicket { context_key: string | null; edit_revision: number }
interface Command { type: string; context: string | null; data: CadWire | undefined; unit?: string; epoch: number; resolve(value: CadWire): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const schema = 'vemcad-weld-bridge/5'
const integer = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64 && !/[\s\0]/u.test(v)
const keys = (v: unknown, names: string[]) => { exact(v, names); return v }
function ticket(value: unknown): asserts value is NativeTicket { keys(value, ['context_key', 'edit_revision']); need(isObject(value) && (value.context_key === null || id(value.context_key)) && integer(value.edit_revision)) }
function overlay(value: unknown): asserts value is CadWire { keys(value, ['schema', 'snapshot', 'bindings']); need(isObject(value) && ['vemcad-weld-overlay/1', 'vemcad-weld-overlay/2', 'vemcad-weld-overlay/3'].includes(String(value.schema)) && Array.isArray(value.bindings) && isObject(value.snapshot) && Array.isArray(value.snapshot.entities)) }
function selection(value: CadWire) { need(Array.isArray(value.entity_ids) && value.entity_ids.length <= 10000 && value.entity_ids.every(integer) && new Set(value.entity_ids).size === value.entity_ids.length && (value.primary_id === null || value.entity_ids.includes(value.primary_id))) }
export function createCadBridge(options: {
  window: Window; frame: HTMLIFrameElement; getLocalSeq(): number
  onAction(action: CadWire): Promise<number>; accepts(): boolean
  onSelection?(value: CadWire): void; onHistoryRequest?(direction: 'undo' | 'redo'): void
  onIntentCancelled?(id: string): void; onError?(error: Error): void
}) {
  const { window, frame } = options, peer = frame.contentWindow!, origin = window.location.origin, nonce = crypto.randomUUID()
  const pending = new Map<string, Command>(), history = new Set<string>()
  let frameNonce: string | null = null, nativeTicket: NativeTicket | null = null, contextId: string | null = null
  let epoch = 0, eventSeq = 0, revision = 0, mirror: CadWire | null = null, closed = false
  let business: { id: string; kind: string } | null = null, last: { id: string; signature: string; intent: string | null; ack: CadWire } | null = null
  let readyResolve!: () => void, readyReject!: (error: Error) => void, queue = Promise.resolve()
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject }); void ready.catch(() => {})
  const readyTimer = setTimeout(() => fail(new Error('图纸编辑器启动超时')), 15000)
  function destroy(error = new Error('图纸编辑器已关闭；本地修改保留')) {
    if (closed) return
    closed = true; clearTimeout(readyTimer); readyReject(error); window.removeEventListener('message', receive)
    for (const command of pending.values()) { clearTimeout(command.timer); command.reject(error) } pending.clear()
    frame.removeAttribute('src')
  }
  function fail(cause: unknown) { const error = cause instanceof Error ? cause : new Error('图纸协议无法确认'); destroy(error); options.onError?.(error) }
  function current() { need(!closed && options.accepts() && frame.contentWindow === peer, '旧图纸会话已拒绝') }
  function seq() { const value = options.getLocalSeq(); need(integer(value)); return value }
  function post(type: string, requestId: string, context: string | null, data?: CadWire) {
    current(); const message = { schema, type, frame_nonce: frameNonce, nonce, epoch, request_id: requestId, context_id: context, ...(data === undefined ? {} : { data: clone(data) }) }
    peer.postMessage(message, origin); return message
  }
  function send(type: string, context: string | null, data?: CadWire, unit?: string): Promise<CadWire> {
    current(); const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('图纸回应超时；本地修改保留')), 10000)
      pending.set(requestId, { type, context, data: data && clone(data), unit, epoch, resolve, reject, timer }); post(type, requestId, context, data)
    })
  }
  function acceptTicket(value: unknown, context: string | null) { ticket(value); need(value.context_key === context && (!nativeTicket || value.edit_revision >= nativeTicket.edit_revision)) }
  function receive(event: MessageEvent) {
    if (closed || frame.contentWindow !== peer || event.source !== peer || event.origin !== origin) return
    // Serial processing prevents a retried native action from overtaking durable commit.
    queue = queue.then(() => process(event.data)).catch(fail)
  }
  async function process(message: CadWire) {
    current()
    if (!message || message.schema !== schema || !id(message.frame_nonce)) return
    if (message.type === 'ready') {
      keys(message, ['schema', 'type', 'frame_nonce'])
      if (frameNonce !== null) { need(message.frame_nonce === frameNonce, '图纸页面已重载'); return }
      frameNonce = message.frame_nonce
      void send('hello', null).then(() => { clearTimeout(readyTimer); readyResolve() }, fail); return
    }
    if (message.frame_nonce !== frameNonce || message.nonce !== nonce || message.epoch !== epoch || !id(message.request_id)) return
    keys(message, ['schema', 'type', 'frame_nonce', 'nonce', 'epoch', 'request_id', 'context_id', 'data'])
    need(new TextEncoder().encode(jsonBytes(message)).length <= 12 * 1024 * 1024)
    const data: CadWire = message.data
    if (['action', 'selectionChanged', 'historyRequest', 'intentCancelled'].includes(message.type)) {
      if (contextId === null || message.context_id !== contextId) return
      if (message.type === 'intentCancelled') {
        keys(data, ['intent_id', 'native_ticket']); need(id(data.intent_id))
        if (business?.id !== data.intent_id) return
        need(business.kind === 'armDraw'); acceptTicket(data.native_ticket, contextId)
        business = null; options.onIntentCancelled?.(data.intent_id); return
      }
      if (message.type === 'action') {
        keys(data, ['action_id', 'command_id', 'business_intent_id', 'base_local_seq', 'before', 'after', 'native_ticket'])
        need(data.action_id === message.request_id && id(data.command_id) && integer(data.base_local_seq) && (data.business_intent_id === null || id(data.business_intent_id)))
        const signature = jsonBytes(data)
        if (last && last.id === data.action_id) { need(last.signature === signature); peer.postMessage(clone(last.ack), origin); return }
        ticket(data.native_ticket); need(data.native_ticket.context_key === contextId)
        if (data.native_ticket.edit_revision <= revision) return
        const commands: Record<string, string> = { armDraw: 'entity.create', copyWeld: 'selection.copy', annotateWeld: 'welding.annotation.set', representation: 'welding.representation.set' }
        need(data.business_intent_id !== null ? business?.id === data.business_intent_id && data.command_id === commands[business!.kind] : business === null && ['entity.create', 'entity.createMany', 'selection.move', 'selection.copy', 'selection.delete', 'selection.propertyPatch', 'selection.box', 'welding.bindings.set'].includes(data.command_id))
        const before = seq(); overlay(data.before); overlay(data.after)
        need(data.base_local_seq <= before && equal(data.before, mirror) && !equal(data.before, data.after))
        const next = await options.onAction(clone(data)); current()
        need(integer(next) && next > before && next === seq())
        if (data.business_intent_id !== null) business = null
        mirror = clone(data.after); revision = data.native_ticket.edit_revision; nativeTicket = clone(data.native_ticket)
        const ack = post('actionAccepted', data.action_id, contextId, { action_id: data.action_id, local_seq: next, native_ticket: nativeTicket })
        last = { id: data.action_id, signature, intent: data.business_intent_id, ack }; return
      }
      if (message.type === 'selectionChanged') {
        keys(data, ['event_seq', 'edit_revision', 'entity_ids', 'primary_id']); selection(data)
        need(integer(data.event_seq) && integer(data.edit_revision) && nativeTicket)
        if (data.event_seq <= eventSeq || data.edit_revision < nativeTicket.edit_revision) return
        eventSeq = data.event_seq; nativeTicket = { context_key: contextId, edit_revision: data.edit_revision }; options.onSelection?.(clone(data)); return
      }
      keys(data, ['direction', 'base_local_seq', 'native_ticket']); need(['undo', 'redo'].includes(data.direction) && integer(data.base_local_seq) && data.base_local_seq <= seq()); acceptTicket(data.native_ticket, contextId)
      if (history.has(message.request_id)) return
      history.add(message.request_id); if (history.size > 64) history.delete(history.values().next().value!)
      options.onHistoryRequest?.(data.direction); return
    }
    const command = pending.get(message.request_id)
    if (!command && message.type === 'error' && message.context_id === contextId) throw new Error('图纸拒绝动作')
    if (!command || command.epoch !== message.epoch) return
    if (message.type === 'error') throw new Error('图纸请求未通过校验；原稿保留')
    const responses: Record<string, string> = { hello: 'helloAck', load: 'loaded', bind: 'bound', select: 'selected', snapshot: 'snapshotResult', restore: 'restored', armDraw: 'drawArmed', copyWeld: 'copied', annotateWeld: 'annotated', representation: 'represented' }
    need(message.context_id === command.context && message.type === responses[command.type]); acceptTicket(data?.native_ticket, command.context)
    const input = command.data!
    if (command.type === 'hello') keys(data, ['native_ticket'])
    else if (command.type === 'armDraw') {
      keys(data, ['intent_id', 'native_ticket', 'local_seq']); need(data.intent_id === input.intent_id && equal(data.native_ticket, input.expected_ticket) && data.local_seq === input.local_seq && data.local_seq <= seq())
    } else {
      const selected = command.type === 'select', optionalChange = ['annotateWeld', 'representation'].includes(command.type)
      keys(data, selected ? ['entity_ids', 'primary_id', 'native_ticket', 'local_seq'] : optionalChange ? ['intent_id', 'snapshot', 'native_ticket', 'local_seq', 'changed'] : command.type === 'copyWeld' ? ['intent_id', 'snapshot', 'native_ticket', 'local_seq'] : ['snapshot', 'native_ticket', 'local_seq']); need(integer(data.local_seq))
      if (optionalChange) need(typeof data.changed === 'boolean' && data.intent_id === input.intent_id)
      if (command.type === 'copyWeld' || optionalChange && data.changed) need(data.intent_id === input.intent_id && last?.intent === data.intent_id && equal(data.native_ticket, last!.ack.data.native_ticket))
      if (optionalChange && !data.changed) need(business?.id === data.intent_id && last?.intent !== data.intent_id && equal(data.native_ticket, input.expected_ticket) && data.local_seq === input.local_seq)
      if (selected) { selection(data); need(equal(data.entity_ids, input.entity_ids) && data.primary_id === input.primary_id && data.local_seq <= seq()) }
      else {
        overlay(data.snapshot)
        if (command.type === 'load') need(data.snapshot.snapshot.meta?.unit === command.unit && (input.overlay !== null ? equal(data.snapshot, input.overlay) : data.snapshot.schema === 'vemcad-weld-overlay/1' && !data.snapshot.snapshot.entities.length && !data.snapshot.bindings.length))
        else if (command.type === 'restore') need(data.local_seq === input.local_seq && (input.overlay === null ? data.snapshot.schema === 'vemcad-weld-overlay/1' && !data.snapshot.snapshot.entities.length && !data.snapshot.bindings.length && data.snapshot.snapshot.meta?.unit === mirror?.snapshot.meta?.unit : equal(data.snapshot, input.overlay)))
        else need(equal(data.snapshot, mirror))
        if (command.type !== 'restore') need(command.type === 'bind' ? data.local_seq >= input.local_seq && data.local_seq <= seq() : data.local_seq === seq())
        mirror = clone(data.snapshot); revision = data.native_ticket.edit_revision
      }
    }
    clearTimeout(command.timer); pending.delete(message.request_id)
    if (['annotateWeld', 'representation'].includes(command.type) && !data.changed) business = null
    if (command.type === 'snapshot' && business?.kind === 'armDraw') { const cancelled = business.id; business = null; options.onIntentCancelled?.(cancelled) }
    nativeTicket = clone(data.native_ticket); contextId = command.context; command.resolve(clone(data))
  }
  window.addEventListener('message', receive)
  async function active() { await ready; current(); need(contextId, '请先打开图纸') }
  async function intent(type: string, value: CadWire) { await active(); need(!business && !pending.size && id(value.intent_id), '请先完成或取消图纸操作'); business = { id: value.intent_id, kind: type }; return send(type, contextId, { ...clone(value), expected_ticket: nativeTicket, local_seq: seq() }) }
  return {
    async load(context: CadWire, value: CadWire | null) { await ready; need(['mm', 'in'].includes(context.unit)); return send('load', context.context_id, { cadgf_document: context.cadgf_document, overlay: value, expected_ticket: nativeTicket, local_seq: seq() }, context.unit) },
    async bind(bindings: CadWire[]) { await active(); return send('bind', contextId, { bindings, expected_ticket: nativeTicket, local_seq: seq() }) },
    async select(entityIds: number[], primaryId: number | null = null) { await active(); const value = { entity_ids: entityIds, primary_id: primaryId ?? entityIds[0] ?? null }; selection(value); return send('select', contextId, { ...value, expected_ticket: nativeTicket }) },
    async snapshot() { await active(); return send('snapshot', contextId, { expected_ticket: nativeTicket, local_seq: seq() }) },
    armDraw: (value: CadWire) => intent('armDraw', value), copyWeld: (value: CadWire) => intent('copyWeld', value), annotateWeld: (value: CadWire) => intent('annotateWeld', value),
    representation: (operation: CadWire) => intent('representation', { intent_id: operation.intent_id, operation: clone(operation) }),
    async restore(value: CadWire | null, next: number) { await active(); need(!pending.size && !business && integer(next) && next === seq() + 1 && epoch < 2147483647); epoch++; eventSeq = 0; last = null; history.clear(); return send('restore', contextId, { overlay: value, expected_ticket: nativeTicket, local_seq: next }) },
    destroy,
  }
}

export function loadReadOnlyCad(frame: HTMLIFrameElement, url: string, document: CadWire, accepts: () => boolean): { loaded: Promise<void>; destroy(): void } {
  const peer = frame.contentWindow!, origin = window.location.origin, nonce = crypto.randomUUID(), requestId = crypto.randomUUID()
  let frameNonce: string | null = null, finished = false, rejectLoad!: (error: Error) => void
  const destroy = () => { if (!finished) rejectLoad(new Error('历史查阅已取消')); finished = true; clearTimeout(timer); window.removeEventListener('message', receive); frame.removeAttribute('src') }
  let resolveLoad!: () => void
  const loaded = new Promise<void>((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject })
  const timer = setTimeout(() => { rejectLoad(new Error('历史图纸加载超时')); destroy() }, 15000)
  function receive(event: MessageEvent) {
    if (finished || event.source !== peer || event.origin !== origin || frame.contentWindow !== peer) return
    try {
      need(accepts(), '历史查阅身份已变化'); const value = event.data
      if (!value || value.schema !== 'vemcad-weld-readonly/1' || value.nonce !== nonce) return
      exact(value, ['schema', 'type', 'nonce', 'frame_nonce', 'request_id', 'data']); need(id(value.frame_nonce))
      if (value.type === 'ready') { need(frameNonce === null && value.request_id === null && value.data === null); frameNonce = value.frame_nonce; peer.postMessage({ schema: value.schema, type: 'load', nonce, frame_nonce: frameNonce, request_id: requestId, data: { cadgf_document: clone(document.cadgf_document), overlay: clone(document.payload.overlay ?? null) } }, origin); return }
      need(value.frame_nonce === frameNonce && value.request_id === requestId && value.type === 'loaded'); exact(value.data, ['unit']); need(value.data.unit === document.origin.unit)
      finished = true; clearTimeout(timer); window.removeEventListener('message', receive); resolveLoad()
    } catch (error) { rejectLoad(error instanceof Error ? error : new Error('历史图文无法确认')); destroy() }
  }
  window.addEventListener('message', receive); frame.src = `${url}#nonce=${nonce}`
  return { loaded, destroy }
}
