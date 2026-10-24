import { deriveWeldingBaseSnapshot, prepareWeldingContext } from '../adapters/welding_source_adapter.js';
import { DocumentState } from '../state/documentState.js';

export const BRIDGE_SCHEMA = 'vemcad-weld-bridge/5';
const MAX = 2147483647, PACKET_LIMIT = 12 * 1024 * 1024;
const COMMON = ['schema', 'type', 'frame_nonce', 'nonce', 'epoch', 'request_id', 'context_id'];
function invalid() { throw new Error('WELD_BRIDGE_INVALID'); }
function keys(value, expected) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid(); }
function id(value, nullable = false) { if (nullable && value === null) return; if (typeof value !== 'string' || !value || value.length > 64 || /[\s\0]/u.test(value)) invalid(); }
function integer(value) { if (!Number.isInteger(value) || value < 0 || value > MAX) invalid(); }
function ticket(value) { keys(value, ['context_key', 'edit_revision']); id(value.context_key, true); integer(value.edit_revision); }
function currentTicket(workspace) { const current = workspace.getWeldingContext(); return { context_key: current.context_key, edit_revision: current.edit_revision }; }
const equal = (a, b) => a?.context_key === b?.context_key && a?.edit_revision === b?.edit_revision;

// The entry binds its actual same-origin parent before accepting any native operation.
export function installWeldingMessageBridge({ window, workspace, setBlocked }) {
  const parent = window.parent, origin = window.location.origin, selection = workspace.state.selection;
  if (parent === window || origin === 'null') throw new Error('WELD_BRIDGE_PARENT_REQUIRED');
  const frameNonce = window.crypto.randomUUID(), requests = new Set();
  let nonce = null, epoch = 0, contextId = null, eventSeq = 0, localSeq = 0, acceptedTicket = currentTicket(workspace);
  let historyTimer = null, selectionHandler = null, destroyed = false, quietSelection = false, pending = null, deferredSnapshot = null, lastAccepted = null;
  setBlocked(true);
  function post(type, requestId, data, responseContext = contextId) {
    if (destroyed) return;
    const packet = { schema: BRIDGE_SCHEMA, type, frame_nonce: frameNonce, nonce, epoch, request_id: requestId, context_id: responseContext, data };
    if (new TextEncoder().encode(JSON.stringify(packet)).length > PACKET_LIMIT) invalid();
    parent.postMessage(packet, origin);
  }
  function errorResponse(error, requestId) {
    const codes = ['WELD_OVERLAY_STALE_CONTEXT', 'WELD_BRIDGE_STALE', 'WELD_HOST_ACTION_PENDING', 'WELD_HOST_ACK_TIMEOUT'];
    const code = codes.includes(error.message) ? error.message : error.message.startsWith('WELD_SOURCE_INVALID') ? 'WELD_SOURCE_INVALID' : 'WELD_BRIDGE_INVALID';
    post('error', requestId, { error_code: code });
  }
  function snapshotData() { return { snapshot: workspace.getOverlaySnapshot(), native_ticket: currentTicket(workspace), local_seq: localSeq }; }
  function checkTicket(expected, allowPendingBefore = false) {
    ticket(expected);
    if (!equal(expected, currentTicket(workspace)) && !(allowPendingBefore && pending && equal(expected, acceptedTicket))) throw new Error('WELD_OVERLAY_STALE_CONTEXT');
  }
  function detachSelection() { if (selectionHandler) selection.removeEventListener('change', selectionHandler); selectionHandler = null; }
  function attachSelection() {
    detachSelection();
    selectionHandler = () => {
      if (contextId === null || quietSelection || workspace.isWeldingMutationInProgress()) return;
      if (eventSeq >= MAX) invalid(); eventSeq += 1;
      const ids = new Set(workspace.getOverlaySnapshot().snapshot.entities.map(entity => entity.id));
      const entityIds = selection.entityIds.filter(entityId => ids.has(entityId));
      post('selectionChanged', window.crypto.randomUUID(), { event_seq: eventSeq, edit_revision: currentTicket(workspace).edit_revision,
        entity_ids: entityIds, primary_id: entityIds.includes(selection.primaryId) ? selection.primaryId : null });
    };
    selection.addEventListener('change', selectionHandler);
  }
  function retryAction() {
    if (!pending || destroyed) return;
    if (pending.attempts >= 6) { setBlocked(true); errorResponse(new Error('WELD_HOST_ACK_TIMEOUT'), pending.id); return; }
    pending.attempts += 1;
    try { post('action', pending.id, pending.data); pending.timer = setTimeout(retryAction, 2000); }
    catch (error) { setBlocked(true); errorResponse(error, pending.id); }
  }
  workspace.configureWeldingHost({
    onAction(action) {
      if (pending || contextId === null) throw new Error('WELD_HOST_ACTION_PENDING');
      const actionId = window.crypto.randomUUID();
      pending = { id: actionId, data: structuredClone({ action_id: actionId, command_id: action.command_id, base_local_seq: localSeq,
        before: action.before, after: action.after, native_ticket: action.native_ticket, business_intent_id: action.business_intent_id }), attempts: 0, timer: null, bindRequest: null, copyRequest: null, annotationRequest: null };
      setBlocked(true); retryAction();
    },
    onIntentCancelled(intentId) { if (contextId !== null) post('intentCancelled', window.crypto.randomUUID(), { intent_id: intentId, native_ticket: currentTicket(workspace) }); },
    onHistoryRequest(direction) {
      if (contextId === null || pending) return;
      workspace.cancelWeldingGesture?.(); setBlocked(true);
      const requestId = window.crypto.randomUUID();
      post('historyRequest', requestId, { direction, base_local_seq: localSeq, native_ticket: currentTicket(workspace) });
      clearTimeout(historyTimer); historyTimer = setTimeout(() => errorResponse(new Error('WELD_HOST_ACK_TIMEOUT'), requestId), 10000);
    },
  });
  function completeSnapshot(message) {
    clearTimeout(historyTimer); setBlocked(true); workspace.cancelWeldingGesture?.();
    workspace.snapshotWeldingOverlay(); localSeq = Math.max(localSeq, message.data.local_seq);
    post('snapshotResult', message.request_id, snapshotData()); setBlocked(false);
  }
  function onMessage(event) {
    if (destroyed || event.origin !== origin || event.source !== parent) return;
    const message = event.data;
    if (!message || message.schema !== BRIDGE_SCHEMA || message.frame_nonce !== frameNonce) return;
    if (message.type !== 'hello' && message.nonce !== nonce) return;
    try {
      const withData = ['load', 'bind', 'select', 'snapshot', 'restore', 'actionAccepted', 'armDraw', 'copyWeld', 'annotateWeld', 'representation'].includes(message.type);
      keys(message, withData ? [...COMMON, 'data'] : COMMON);
      id(message.nonce); id(message.request_id); id(message.context_id, true); integer(message.epoch);
      if (new TextEncoder().encode(JSON.stringify(message)).length > PACKET_LIMIT) invalid();
      if (message.type === 'hello') {
        if (nonce !== null || message.context_id !== null) invalid();
        nonce = message.nonce; epoch = message.epoch; requests.add(message.request_id);
        post('helloAck', message.request_id, { native_ticket: currentTicket(workspace) }); return;
      }
      if (nonce === null || (message.type !== 'actionAccepted' && requests.has(message.request_id))) invalid();
      if (['reset', 'restore'].includes(message.type) ? message.epoch <= epoch : message.epoch !== epoch) throw new Error('WELD_BRIDGE_STALE');
      if (message.type === 'actionAccepted') {
        if (message.context_id !== contextId) throw new Error('WELD_BRIDGE_STALE');
        keys(message.data, ['action_id', 'local_seq', 'native_ticket']); id(message.data.action_id); integer(message.data.local_seq); ticket(message.data.native_ticket);
        if (message.request_id !== message.data.action_id) invalid();
        if (!pending) {
          if (lastAccepted?.id === message.data.action_id && lastAccepted.seq === message.data.local_seq && equal(lastAccepted.ticket, message.data.native_ticket)) return;
          throw new Error('WELD_BRIDGE_STALE');
        }
        if (pending.id !== message.data.action_id || message.data.local_seq <= localSeq || !equal(message.data.native_ticket, pending.data.native_ticket)) throw new Error('WELD_BRIDGE_STALE');
        workspace.acceptWeldingAction(message.data.native_ticket); clearTimeout(pending.timer);
        localSeq = message.data.local_seq; acceptedTicket = structuredClone(message.data.native_ticket);
        lastAccepted = { id: pending.id, seq: localSeq, ticket: acceptedTicket };
        const bindRequest = pending.bindRequest, copyRequest = pending.copyRequest, annotationRequest = pending.annotationRequest; pending = null;
        if (annotationRequest) post(annotationRequest.type || 'annotated', annotationRequest.request_id, { intent_id: annotationRequest.intent_id, ...snapshotData(), changed: true });
        if (copyRequest) post('copied', copyRequest.request_id, { intent_id: copyRequest.intent_id, ...snapshotData() });
        if (bindRequest) post('bound', bindRequest, snapshotData());
        if (deferredSnapshot) { const next = deferredSnapshot; deferredSnapshot = null; completeSnapshot(next); }
        else setBlocked(false);
        return;
      }
      requests.add(message.request_id); if (requests.size > 64) requests.delete(requests.values().next().value);
      if (message.type === 'reset') {
        if (pending || message.context_id !== null && message.context_id !== contextId) throw new Error('WELD_BRIDGE_STALE');
        clearTimeout(historyTimer); workspace.cancelWeldingGesture?.(); detachSelection(); epoch = message.epoch; contextId = null; eventSeq = 0; deferredSnapshot = null; setBlocked(true);
        post('resetAck', message.request_id, { native_ticket: currentTicket(workspace) }); return;
      }
      if (message.context_id === null) invalid();
      if (message.type === 'load') {
        keys(message.data, ['cadgf_document', 'overlay', 'expected_ticket', 'local_seq']); integer(message.data.local_seq); checkTicket(message.data.expected_ticket);
        if (pending) throw new Error('WELD_HOST_ACTION_PENDING');
        let overlay = message.data.overlay;
        if (overlay === null) {
          const base = deriveWeldingBaseSnapshot(message.data.cadgf_document), document = new DocumentState(); document.confirmPhysicalUnit(base.meta.unit);
          overlay = { schema: 'vemcad-weld-overlay/1', snapshot: document.snapshot(), bindings: [] };
        }
        const prepared = prepareWeldingContext({ context_key: message.context_id, cadgf_document: message.data.cadgf_document, overlay });
        clearTimeout(historyTimer); quietSelection = true;
        try { workspace.cancelWeldingGesture?.(); workspace.loadWeldingContext(prepared, { expected_context_key: message.data.expected_ticket.context_key, expected_edit_revision: message.data.expected_ticket.edit_revision }); }
        finally { quietSelection = false; }
        contextId = message.context_id; localSeq = message.data.local_seq; acceptedTicket = currentTicket(workspace); attachSelection(); setBlocked(false);
        post('loaded', message.request_id, snapshotData()); return;
      }
      if (message.context_id !== contextId) throw new Error('WELD_BRIDGE_STALE');
      if (message.type === 'select') {
        keys(message.data, ['entity_ids', 'primary_id', 'expected_ticket']); checkTicket(message.data.expected_ticket);
        quietSelection = true;
        try { workspace.selectWeldingEntities(message.data.entity_ids, message.data.primary_id); } finally { quietSelection = false; }
        const selected = workspace.state.selection;
        post('selected', message.request_id, { entity_ids: [...selected.entityIds], primary_id: selected.primaryId, native_ticket: currentTicket(workspace), local_seq: localSeq }); return;
      }
      if (message.type === 'snapshot') {
        keys(message.data, ['expected_ticket', 'local_seq']); integer(message.data.local_seq); checkTicket(message.data.expected_ticket, true);
        if (!pending && message.data.local_seq < localSeq) throw new Error('WELD_BRIDGE_STALE');
        if (pending) { if (deferredSnapshot) throw new Error('WELD_HOST_ACTION_PENDING'); deferredSnapshot = structuredClone(message); }
        else completeSnapshot(message);
        return;
      }
      if (message.type === 'restore') {
        keys(message.data, ['overlay', 'expected_ticket', 'local_seq']); integer(message.data.local_seq); checkTicket(message.data.expected_ticket);
        if (pending || message.data.local_seq <= localSeq) throw new Error('WELD_BRIDGE_STALE');
        clearTimeout(historyTimer); setBlocked(true); quietSelection = true;
        try { workspace.restoreWeldingOverlay(message.data.overlay, { expected_context_key: message.data.expected_ticket.context_key, expected_edit_revision: message.data.expected_ticket.edit_revision }); }
        finally { quietSelection = false; }
        epoch = message.epoch; eventSeq = 0; localSeq = message.data.local_seq; acceptedTicket = currentTicket(workspace); lastAccepted = null;
        post('restored', message.request_id, snapshotData()); setBlocked(false); return;
      }
      if (message.type === 'representation') {
        keys(message.data, ['intent_id', 'operation', 'expected_ticket', 'local_seq']);
        id(message.data.intent_id); integer(message.data.local_seq); checkTicket(message.data.expected_ticket);
        if (message.data.operation?.intent_id !== message.data.intent_id) invalid();
        if (pending || message.data.local_seq < localSeq) throw new Error('WELD_BRIDGE_STALE');
        const previousSeq = localSeq; localSeq = message.data.local_seq;
        try {
          const result = workspace.changeWeldingRepresentation(structuredClone(message.data.operation));
          if (!result.ok || result.changed !== Boolean(pending)) invalid();
          if (pending) pending.annotationRequest = { request_id: message.request_id, intent_id: message.data.intent_id, type: 'represented' };
          else post('represented', message.request_id, { intent_id: message.data.intent_id, ...snapshotData(), changed: false });
        } catch (error) { if (!pending) localSeq = previousSeq; throw error; }
        return;
      }
      if (['armDraw', 'copyWeld', 'annotateWeld'].includes(message.type)) {
        const copy = message.type === 'copyWeld', annotation = message.type === 'annotateWeld';
        const represented = workspace.getOverlaySnapshot().schema === 'vemcad-weld-overlay/3';
        const fields = copy ? ['intent_id', 'source_weld_id', 'weld_id', 'display_no', 'delta'] : ['intent_id', 'weld_id', 'display_no', annotation ? 'mode' : 'tool'];
        if (represented) fields.push(...(copy ? ['representations'] : annotation ? ['representation_id'] : ['representation_id', 'view_name']));
        keys(message.data, [...fields, 'expected_ticket', 'local_seq']);
        const input = Object.fromEntries(fields.map(key => [key, message.data[key]]));
        id(message.data.intent_id); integer(message.data.local_seq); checkTicket(message.data.expected_ticket);
        if (pending || message.data.local_seq < localSeq) throw new Error('WELD_BRIDGE_STALE');
        const previousSeq = localSeq; localSeq = message.data.local_seq;
        try {
          if (annotation) {
            const result = workspace.annotateWeldingBinding(input);
            if (!result.ok || result.changed !== Boolean(pending)) invalid();
            if (pending) pending.annotationRequest = { request_id: message.request_id, intent_id: message.data.intent_id };
            else post('annotated', message.request_id, { intent_id: message.data.intent_id, ...snapshotData(), changed: false });
          } else if (copy) {
            const result = workspace.copyWeldingBinding(input);
            if (!result.ok || !pending) invalid();
            pending.copyRequest = { request_id: message.request_id, intent_id: message.data.intent_id };
          } else {
            workspace.armWeldingDraw(input);
            post('drawArmed', message.request_id, { intent_id: message.data.intent_id, native_ticket: currentTicket(workspace), local_seq: localSeq });
          }
        } catch (error) { if (!pending) localSeq = previousSeq; throw error; }
        return;
      }
      if (message.type === 'bind') {
        keys(message.data, ['bindings', 'expected_ticket', 'local_seq']); integer(message.data.local_seq); checkTicket(message.data.expected_ticket);
        if (pending || message.data.local_seq < localSeq) throw new Error('WELD_BRIDGE_STALE');
        const previousSeq = localSeq; localSeq = message.data.local_seq; workspace.cancelWeldingGesture?.();
        const result = workspace.setWeldBindings(structuredClone(message.data.bindings)); if (!result.ok) { localSeq = previousSeq; invalid(); }
        if (pending) pending.bindRequest = message.request_id; else post('bound', message.request_id, snapshotData());
        return;
      }
      invalid();
    } catch (error) {
      if (nonce !== null && message.nonce === nonce && typeof message.request_id === 'string' && message.request_id.length > 0 && message.request_id.length <= 64 && !/[\s\0]/u.test(message.request_id)) errorResponse(error, message.request_id);
    }
  }
  window.addEventListener('message', onMessage);
  parent.postMessage({ schema: BRIDGE_SCHEMA, type: 'ready', frame_nonce: frameNonce }, origin);
  return { destroy() { destroyed = true; clearTimeout(historyTimer); if (pending) clearTimeout(pending.timer); detachSelection(); window.removeEventListener('message', onMessage); setBlocked(true); } };
}
