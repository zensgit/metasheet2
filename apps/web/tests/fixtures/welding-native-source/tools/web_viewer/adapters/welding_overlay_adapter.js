import { DocumentState } from '../state/documentState.js';
import { captureState, restoreState } from '../commands/shared/snapshot.js';
import { commandResult } from '../commands/command_bus.js';
import { transformEntityByDelta } from '../tools/geometry.js';
import { computeEntityAabb } from '../state/spatialIndex.js';

export const OVERLAY_SCHEMA = 'vemcad-weld-overlay/1';
export const ANNOTATED_OVERLAY_SCHEMA = 'vemcad-weld-overlay/2';
export const REPRESENTED_OVERLAY_SCHEMA = 'vemcad-weld-overlay/3';
const annotatedFormat = format => [ANNOTATED_OVERLAY_SCHEMA, REPRESENTED_OVERLAY_SCHEMA].includes(format);
const MAX_ID = 2147483647;
// Match the existing Python ReferenceId boundary; ECMAScript trim differs at U+0085/U+FEFF.
const PYTHON_SPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const COMMON = ['id', 'type', 'layerId', 'visible', 'color', 'name', 'lineType', 'lineWeight', 'lineWeightSource', 'lineTypeScale', 'lineTypeScaleSource'];
const OPTIONAL = ['colorSource', 'space', 'layout'];
const GEOMETRY = { line: ['start', 'end'], arc: ['center', 'radius', 'startAngle', 'endAngle', 'cw'], polyline: ['points', 'closed'] };
const ENTITIES2 = { ...GEOMETRY, text: ['position', 'value', 'height', 'rotation'] };
const LAYER = ['id', 'name', 'visible', 'locked', 'printable', 'frozen', 'construction', 'color', 'lineType', 'lineWeight'];
const META = ['schema', 'unit', 'unitDeclared', 'unitScale', 'label', 'author', 'comment', 'currentSpace', 'currentLayout'];
const SNAPSHOT = ['nextEntityId', 'nextLayerId', 'nextConstraintId', 'layers', 'entities', 'constraints', 'meta'];
const clone = value => structuredClone(value);
function fail(message) { throw new Error(`WELD_OVERLAY_INVALID: ${message}`); }
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Expected a plain object'); }
function keys(value, required, optional = []) { object(value); if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail('Unknown or missing fields'); }
function integer(value, min = 0) { if (!Number.isInteger(value) || value < min || value > MAX_ID) fail('Unsafe ID/counter'); }
function finite(value, min = -Infinity) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail('Non-finite or invalid number'); }
function text(value, limit, required = false) {
  if (typeof value !== 'string' || Array.from(value).length > limit || value.includes('\0') || required && (!value || value !== value.trim())) fail('Invalid text');
  for (let i = 0; i < value.length; i += 1) { const c = value.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) { const n = value.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) fail('Invalid Unicode'); } else if (c >= 0xdc00 && c <= 0xdfff) fail('Invalid Unicode'); }
}
function bool(value) { if (typeof value !== 'boolean') fail('Expected boolean'); }
function color(value) { if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/.test(value)) fail('Expected lowercase #rrggbb'); }
function lineType(value) { text(value, 64, true); if (value !== value.toUpperCase()) fail('Expected uppercase line type'); }
function point(value) { keys(value, ['x', 'y']); finite(value.x); finite(value.y); }
function geometry(entity, annotated = false) {
  if (annotated && entity.type === 'text') { point(entity.position); weldId(entity.value); finite(entity.height, 0.1); if (typeof entity.rotation !== 'number' || entity.rotation !== 0) fail('Invalid label rotation'); return; }
  if (!GEOMETRY[entity.type]) fail('Only line, arc and straight polyline are supported');
  if (entity.type === 'line') {
    point(entity.start); point(entity.end);
    if (entity.start.x === entity.end.x && entity.start.y === entity.end.y) fail('Degenerate line');
  } else if (entity.type === 'arc') {
    point(entity.center); finite(entity.radius, 0.001); finite(entity.startAngle); finite(entity.endAngle); bool(entity.cw);
    const delta = entity.endAngle - entity.startAngle, sweep = Math.abs(delta % (2 * Math.PI));
    if (!Number.isFinite(delta) || !Number.isFinite(sweep) || Math.min(sweep, 2 * Math.PI - sweep) <= 1e-12) fail('Invalid arc sweep');
  } else {
    bool(entity.closed);
    if (!Array.isArray(entity.points) || entity.points.length < (entity.closed ? 3 : 2) || entity.points.length > 1000) fail('Invalid polyline point count');
    entity.points.forEach(point);
    for (let i = 1; i < entity.points.length; i += 1) if (entity.points[i].x === entity.points[i - 1].x && entity.points[i].y === entity.points[i - 1].y) fail('Degenerate polyline segment');
  }
}
function entityStyle(entity, partial = false) {
  const check = (key, validator) => { if (!partial || Object.hasOwn(entity, key)) validator(entity[key]); };
  check('id', integer); check('layerId', integer); check('visible', bool); check('color', color); check('name', v => text(v, 256)); check('lineType', lineType); check('lineWeight', v => finite(v, 0));
  check('lineTypeScale', v => { finite(v); if (v <= 0) fail('Invalid line type scale'); });
  check('lineWeightSource', v => { if (!['EXPLICIT', 'BYLAYER'].includes(v)) fail('Invalid line weight source'); });
  check('lineTypeScaleSource', v => { if (!['EXPLICIT', 'DEFAULT'].includes(v)) fail('Invalid line type scale source'); });
  if (Object.hasOwn(entity, 'colorSource') && !['BYLAYER', 'TRUECOLOR'].includes(entity.colorSource)) fail('Invalid color source');
  if (Object.hasOwn(entity, 'space') && entity.space !== 0 || Object.hasOwn(entity, 'layout') && entity.layout !== 'Model') fail('Overlay must use model space');
}
function layer(value) { keys(value, LAYER); integer(value.id); text(value.name, 256); if (!value.name) fail('Layer name must not be empty'); color(value.color); lineType(value.lineType); finite(value.lineWeight, 0); for (const key of ['visible', 'locked', 'printable', 'frozen', 'construction']) bool(value[key]); }
function meta(value) {
  keys(value, META); text(value.label, 256); text(value.author, 256); text(value.comment, 4000);
  if (value.schema !== 'vemcad-web-2d-v1' || !['mm', 'in'].includes(value.unit) || value.unitDeclared !== true || value.unitScale !== 1 || value.currentSpace !== 0 || value.currentLayout !== 'Model') fail('Unknown unit, coordinate scale or space');
}
function indexSafe(entity, cellSize = 50) {
  const bounds = computeEntityAabb({ ...entity, visible: true });
  const cells = bounds && Object.values(bounds).map(value => Math.floor(value / cellSize));
  if (!cells || cells.some(value => !Number.isSafeInteger(value))) fail('Geometry exceeds the native spatial index');
  if (entity.type === 'text' && (cells[2] - cells[0] + 1) * (cells[3] - cells[1] + 1) > 4096) fail('Text exceeds 4096 native spatial cells');
}
export function validateOverlaySnapshot(snapshot, format = OVERLAY_SCHEMA) {
  keys(snapshot, SNAPSHOT); meta(snapshot.meta);
  for (const key of ['nextEntityId', 'nextLayerId', 'nextConstraintId']) integer(snapshot[key], 1);
  if (!Array.isArray(snapshot.layers) || snapshot.layers.length < 1 || snapshot.layers.length > 100 || !Array.isArray(snapshot.entities) || snapshot.entities.length > 2000 || !Array.isArray(snapshot.constraints) || snapshot.constraints.length) fail('Invalid layers/entities; constraints are not supported in F05');
  const layerIds = new Set(); snapshot.layers.forEach(value => { layer(value); if (layerIds.has(value.id)) fail('Duplicate layer ID'); layerIds.add(value.id); });
  const ids = new Set();
  snapshot.entities.forEach(entity => {
    const fields = (annotatedFormat(format) ? ENTITIES2 : GEOMETRY)[entity?.type];
    if (!fields) fail('Unsupported overlay entity'); keys(entity, [...COMMON, ...fields], OPTIONAL); entityStyle(entity); geometry(entity, annotatedFormat(format));
    if (annotatedFormat(format)) indexSafe(entity);
    if (ids.has(entity.id) || !layerIds.has(entity.layerId)) fail('Duplicate entity or missing layer'); ids.add(entity.id);
  });
  if (snapshot.nextEntityId <= Math.max(-1, ...ids) || snapshot.nextLayerId <= Math.max(...layerIds)) fail('Counter may reuse an existing ID');
  return snapshot;
}
function weldId(value) {
  text(value, 64); const chars = Array.from(value);
  if (!chars.length || PYTHON_SPACE.test(chars[0]) || PYTHON_SPACE.test(chars.at(-1))) fail('Invalid weld identifier whitespace');
  if (/[\r\n]/.test(value)) fail('Invalid weld binding');
}
export { weldId as validateWeldId };
function intentId(value) { if (typeof value !== 'string' || !value || value.length > 64 || /[\s\0]/u.test(value)) fail('Invalid business intent'); }
function roleRecords(records) { return records.flatMap(binding => binding.representations || [binding]); }
function allRoleIds(binding) { return binding.representations ? binding.representations.flatMap(allRoleIds) : [...binding.entity_ids, ...[binding.label_id, binding.leader_id].filter(id => id != null)]; }
function bindings(value, entities, format = OVERLAY_SCHEMA) {
  if (!Array.isArray(value) || value.length > 500) fail('Invalid binding count');
  const annotated = annotatedFormat(format), represented = format === REPRESENTED_OVERLAY_SCHEMA;
  const welds = new Set(), bound = new Set(), labels = new Set(), representations = new Set();
  value.forEach(binding => {
    keys(binding, represented ? ['weld_id', 'primary_representation_id', 'representations'] : annotated ? ['weld_id', 'entity_ids', 'label_id', 'leader_id'] : ['weld_id', 'entity_ids']); weldId(binding.weld_id);
    if (welds.has(binding.weld_id)) fail('Duplicate weld binding'); welds.add(binding.weld_id);
    if (represented) {
      weldId(binding.primary_representation_id);
      if (!Array.isArray(binding.representations) || !binding.representations.length || binding.representations.length > 2000) fail('Invalid representations');
      if (!binding.representations.some(rep => rep?.representation_id === binding.primary_representation_id)) fail('Primary must belong to its weld');
    }
    for (const role of represented ? binding.representations : [binding]) {
    if (represented) {
      keys(role, ['representation_id', 'view_name', 'entity_ids', 'label_id', 'leader_id']); weldId(role.representation_id); text(role.view_name, 256, true);
      if (representations.has(role.representation_id)) fail('Duplicate representation identity'); representations.add(role.representation_id);
    }
    if (!Array.isArray(role.entity_ids) || role.entity_ids.length < 1 || role.entity_ids.length > 2000) fail('Invalid weld geometry');
    const ids = annotated ? allRoleIds(role) : role.entity_ids;
    ids.forEach(id => { integer(id); if (!entities.has(id) || bound.has(id)) fail('Dangling or multiply bound overlay entity'); bound.add(id); });
    if (annotated) {
      if (role.entity_ids.some(id => !GEOMETRY[entities.get(id)?.type])) fail('Invalid geometry role');
      if (role.label_id !== null) { integer(role.label_id); if (entities.get(role.label_id)?.type !== 'text') fail('Invalid label role'); labels.add(role.label_id); }
      if (role.leader_id !== null) {
        integer(role.leader_id); const entity = entities.get(role.leader_id);
        if (role.label_id === null || !(entity?.type === 'line' || entity?.type === 'polyline' && entity.closed === false)) fail('Invalid leader role');
      }
    }
    }
  });
  if (annotated && [...entities.values()].some(entity => entity.type === 'text' && !labels.has(entity.id))) fail('Text must belong to one label');
}
export function validateWeldingOverlay(value) {
  keys(value, ['schema', 'snapshot', 'bindings']); if (![OVERLAY_SCHEMA, ANNOTATED_OVERLAY_SCHEMA, REPRESENTED_OVERLAY_SCHEMA].includes(value.schema)) fail('Unknown overlay schema'); validateOverlaySnapshot(value.snapshot, value.schema);
  bindings(value.bindings, new Map(value.snapshot.entities.map(entity => [entity.id, entity])), value.schema);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 5 * 1024 * 1024) fail('Overlay exceeds 5 MiB');
  return value;
}

// Ordinary CAD retains DocumentState behavior. The welding policy is active only in its own context.
export class WeldingOverlayDocumentState extends DocumentState {
  validateRawEntity(raw) {
    object(raw); geometry(raw, annotatedFormat(this.weldingFormat));
    if (annotatedFormat(this.weldingFormat)) indexSafe(raw);
    if (Object.keys(raw).some(key => ![...COMMON, ...(annotatedFormat(this.weldingFormat) ? ENTITIES2 : GEOMETRY)[raw.type], ...OPTIONAL].includes(key))) fail('Unknown entity field');
    entityStyle(raw, true);
    const id = raw.id ?? this.nextEntityId; integer(id); if (id >= MAX_ID || this.entities.has(id)) fail('Unsafe or duplicate entity ID');
    const layerId = raw.layerId ?? 0; if (!this.layers.has(layerId)) fail('Missing overlay layer');
    if (this.entities.size >= 2000) fail('Too many overlay entities');
  }
  addEntity(raw) { if (this.weldingUnit) this.validateRawEntity(raw); return super.addEntity(raw); }
  addEntities(values) {
    if (this.weldingUnit) {
      const ids = new Set(); let next = this.nextEntityId;
      for (const value of values) { this.validateRawEntity(value); const id = value.id ?? next++; if (ids.has(id) || id >= MAX_ID) fail('Duplicate/unsafe entity IDs'); ids.add(id); }
      if (this.entities.size + values.length > 2000) fail('Too many overlay entities');
    }
    return super.addEntities(values);
  }
  updateEntity(id, patch) {
    if (this.weldingUnit && this.entities.has(id)) {
      const merged = { ...this.entities.get(id), ...patch, id };
      const fields = (annotatedFormat(this.weldingFormat) ? ENTITIES2 : GEOMETRY)[merged.type];
      if (!fields) fail('Unsupported overlay entity'); keys(merged, [...COMMON, ...fields], OPTIONAL); entityStyle(merged); geometry(merged, annotatedFormat(this.weldingFormat));
      if (annotatedFormat(this.weldingFormat)) indexSafe(merged);
      if (!this.layers.has(merged.layerId)) fail('Missing overlay layer');
    }
    return super.updateEntity(id, patch);
  }
  restore(value, options) { if (this.weldingUnit) { validateOverlaySnapshot(value, this.weldingFormat); if (value.meta.unit !== this.weldingUnit) fail('Overlay unit cannot change within a context'); } return super.restore(value, options); }
  ensureLayer(id) { if (this.weldingUnit && !this.layers.has(id)) fail('Missing overlay layer'); return super.ensureLayer(id); }
  addLayer(name, layerColor) { if (this.weldingUnit) { if (this.layers.size >= 100 || this.nextLayerId >= MAX_ID) fail('Unsafe layer counter'); if (name != null) text(name, 256); if (layerColor != null) color(layerColor); } return super.addLayer(name, layerColor); }
  updateLayer(id, patch) { if (this.weldingUnit && this.layers.has(id)) layer({ ...this.layers.get(id), ...patch }); return super.updateLayer(id, patch); }
  addConstraint(raw) { if (this.weldingUnit) fail('Constraints are not supported in F05'); return super.addConstraint(raw); }
  confirmPhysicalUnit(unit) { if (this.weldingUnit && unit !== this.weldingUnit) fail('Overlay unit cannot change within a context'); return super.confirmPhysicalUnit(unit); }
  setCurrentSpaceContext(context, options) { if (this.weldingUnit && context && (context.space !== 0 || context.layout !== 'Model')) fail('Overlay must use model space'); return super.setCurrentSpaceContext(context, options); }
}

// The paint input has no entity, layer, import or history mutator and returns detached data.
export function createReadOnlyUnderlay(snapshot, unit, { buildSpatialIndex = true } = {}) {
  object(snapshot); object(snapshot.meta);
  meta(Object.fromEntries(META.map(key => [key, snapshot.meta[key]])));
  if (snapshot.meta.unit !== unit) fail('Base/overlay units differ');
  for (const key of ['nextEntityId', 'nextLayerId', 'nextConstraintId']) integer(snapshot[key], 1);
  if (!Array.isArray(snapshot.layers) || !snapshot.layers.length || !Array.isArray(snapshot.entities) || snapshot.entities.length > 10000 || !Array.isArray(snapshot.constraints)) fail('Invalid base snapshot');
  const layerIds = new Set(), entityIds = new Set();
  snapshot.layers.forEach(value => { layer(value); if (layerIds.has(value.id)) fail('Duplicate base layer'); layerIds.add(value.id); });
  function finiteJson(value, depth = 0) { if (depth > 64) fail('Base depth exceeds 64'); if (typeof value === 'number') finite(value); else if (typeof value === 'string') text(value, 1024 * 1024); else if (value && typeof value === 'object') Object.values(value).forEach(child => finiteJson(child, depth + 1)); }
  finiteJson(snapshot);
  snapshot.entities.forEach(entity => {
    integer(entity.id); integer(entity.layerId); if (entityIds.has(entity.id) || !layerIds.has(entity.layerId)) fail('Duplicate base entity or missing layer'); entityIds.add(entity.id);
    if (GEOMETRY[entity.type]) geometry(entity);
    else if (entity.type === 'circle') { point(entity.center); finite(entity.radius, 0.001); }
    else if (entity.type === 'text') { point(entity.position); finite(entity.height, 0.1); finite(entity.rotation); text(entity.value, 4000); }
    else if (entity.type !== 'unsupported') fail('Unknown base geometry');
  });
  if (snapshot.nextEntityId <= Math.max(-1, ...entityIds) || snapshot.nextLayerId <= Math.max(...layerIds)) fail('Unsafe base counter');
  const fixedSnapshot = clone(snapshot);
  const document = new DocumentState(); document.restore(clone(fixedSnapshot), { fresh: true, silent: true, buildSpatialIndex });
  return Object.freeze({
    listLayers: () => clone(document.listLayers()), listEntities: () => clone(document.listEntities()),
    listDisplayProxyEntities: () => clone(document.listDisplayProxyEntities()), listVisibleEntities: () => clone(document.listVisibleEntities()),
    isEntityRenderable: entity => document.isEntityRenderable(entity), snapshot: () => clone(fixedSnapshot),
  });
}

export function createWeldingOverlayController({ document, selection, commands, setUnderlay, onError = () => {}, cancelGesture = () => {} }) {
  let contextKey = null, editRevision = 0, suppress = false, underlay = null, records = [], observerError = null;
  const listeners = new Set();
  let host = null, hostPending = false, preview = false, drawIntent = null, format = OVERLAY_SCHEMA;
  const allowedHostCommands = new Set(['entity.create', 'entity.createMany', 'selection.move', 'selection.copy', 'selection.delete', 'selection.propertyPatch', 'selection.box', 'welding.bindings.set', 'welding.annotation.set', 'welding.representation.set']);
  const originals = new Map();
  const same = (a, b) => a === b || a !== null && b !== null && typeof a === 'object' && typeof b === 'object' &&
    Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
  const hosted = () => host !== null && contextKey !== null;
  function writable() { if (hostPending) throw new Error('WELD_HOST_ACTION_PENDING'); if (preview) throw new Error('WELD_HOST_GESTURE_ACTIVE'); }
  function cancelWeldingBusinessIntent() {
    if (hostPending) throw new Error('WELD_HOST_ACTION_PENDING');
    if (!drawIntent) return;
    const id = drawIntent.intent_id; drawIntent = null; host?.onIntentCancelled?.(id);
  }
  function cancelDraw() { if (drawIntent) { cancelWeldingBusinessIntent(); cancelGesture(); } }
  function newWeld(id) { weldId(id); if (activeBindings().some(binding => binding.weld_id === id)) fail('Target weld already has a binding'); }
  function finishHostAction(commandId, before, businessIntentId = null) {
    const after = getOverlaySnapshot();
    commands.undoStack = []; commands.redoStack = []; commands.emitHistory();
    if (same(before, after)) return;
    hostPending = true; changed();
    try { host.onAction({ command_id: commandId, business_intent_id: businessIntentId, before, after, native_ticket: { context_key: contextKey, edit_revision: editRevision } }); }
    catch (error) { observerError = error.message; onError(error); }
  }
  function runWeldingHostEdit(commandId, mutator) {
    if (!hosted() || suppress) return mutator();
    writable(); cancelDraw();
    const before = captureState(commands.context), previousRecords = clone(records), overlay = getOverlaySnapshot(), previousFormat = format;
    suppress = true;
    let result;
    try { result = mutator(); getOverlaySnapshot(); }
    catch (error) { format = previousFormat; document.weldingFormat = format; restoreState(commands.context, before); records = previousRecords; throw error; }
    finally { suppress = false; }
    finishHostAction(commandId, overlay); return result;
  }
  for (const method of ['addEntity', 'addEntities', 'updateEntity', 'updateEntities', 'removeEntity', 'removeEntities', 'addLayer', 'updateLayer', 'clearEntities', 'restore', 'importJSON', 'confirmPhysicalUnit', 'setCurrentSpaceContext', 'addConstraint', 'removeConstraint', 'clearConstraints']) {
    const original = document[method].bind(document); originals.set(method, document[method]);
    document[method] = (...args) => {
      if (!hosted() || suppress || preview && method === 'updateEntity') return original(...args);
      if (!['addLayer', 'updateLayer', 'setCurrentSpaceContext', 'confirmPhysicalUnit'].includes(method)) throw new Error('WELD_HOST_UNSUPPORTED_DIRECT_WRITE');
      return runWeldingHostEdit(`document.${method}`, () => original(...args));
    };
  }
  const activeBindings = () => annotatedFormat(format) ? clone(records) : records.map(b => ({ ...b, entity_ids: b.entity_ids.filter(id => document.getEntity(id)) })).filter(b => b.entity_ids.length);
  function getOverlaySnapshot() { if (contextKey === null) throw new Error('WELD_OVERLAY_CONTEXT_REQUIRED'); return clone(validateWeldingOverlay({ schema: format, snapshot: document.snapshot(), bindings: activeBindings() })); }
  function upgrade() {
    if (annotatedFormat(format)) return;
    records = activeBindings().map(binding => ({ ...binding, label_id: null, leader_id: null })); format = ANNOTATED_OVERLAY_SCHEMA; document.weldingFormat = format;
    validateOverlaySnapshot(document.snapshot(), format);
  }
  function geometryCenter(ids) {
    const bounds = ids.map(id => computeEntityAabb({ ...document.getEntity(id), visible: true }));
    if (!bounds.length || bounds.some(value => !value)) fail('Missing annotation geometry');
    return { x: Math.min(...bounds.map(b => b.minX)) / 2 + Math.max(...bounds.map(b => b.maxX)) / 2,
      y: Math.min(...bounds.map(b => b.minY)) / 2 + Math.max(...bounds.map(b => b.maxY)) / 2 };
  }
  function createLabel(ids, value) {
    const center = geometryCenter(ids), offset = document.weldingUnit === 'in' ? 10 / 25.4 : 10;
    const label = document.addEntity({ type: 'text', layerId: document.getEntity(ids[0]).layerId, position: { x: center.x + offset, y: center.y - offset }, value, height: document.weldingUnit === 'in' ? 0.1 : 2.5, rotation: 0 });
    if (!label) fail('Label layer is locked'); return label.id;
  }
  function changed() {
    if (suppress || contextKey === null || preview) return;
    editRevision += 1;
    try { const value = getOverlaySnapshot(); for (const listener of listeners) { const result = listener(value); if (result && typeof result.then === 'function') throw new Error('Overlay change handlers must be synchronous'); } observerError = null; }
    catch (error) { observerError = error.message; onError(error); }
  }
  document.addEventListener('change', changed);
  const execute = commands.execute.bind(commands);
  function executeCommand(id, payload, copyIntent = null, annotationIntent = null) {
    if (contextKey === null) return execute(id, payload);
    if (hosted()) {
      if (hostPending) return commandResult(false, false, { error_code: 'WELD_HOST_ACTION_PENDING', message: 'Wait for host acceptance' });
      if (id === 'history.undo' || id === 'history.redo') { host.onHistoryRequest(id === 'history.undo' ? 'undo' : 'redo'); return commandResult(true, false); }
      if (drawIntent && (id !== 'entity.create' || payload?.entity?.type !== drawIntent.tool)) cancelDraw();
      if (['welding.annotation.set', 'welding.representation.set'].includes(id) && !annotationIntent) return commandResult(false, false, { error_code: 'WELD_HOST_UNSUPPORTED_COMMAND', message: 'Use the annotation intent API' });
      if (preview || !allowedHostCommands.has(id)) return commandResult(false, false, { error_code: 'WELD_HOST_UNSUPPORTED_COMMAND', message: 'Command is not available in hosted welding mode' });
    }
    const business = copyIntent || annotationIntent || (hosted() && id === 'entity.create' ? drawIntent : null);
    if (business && !copyIntent && !annotationIntent) drawIntent = null;
    const overlayBefore = hosted() ? getOverlaySnapshot() : null;
    const before = captureState(commands.context), previousRecords = clone(records), previousFormat = format;
    const undo = [...commands.undoStack], redo = [...commands.redoStack];
    suppress = true;
    let result;
    try {
      const selected = payload?.entityIds || selection.entityIds;
      const roles = roleRecords(records);
      const labels = new Set(roles.map(b => b.label_id).filter(id => id != null)), leaders = new Set(roles.map(b => b.leader_id).filter(id => id != null));
      if (annotatedFormat(format) && !business) {
        if (id === 'selection.copy' && selected.some(id => labels.has(id) || leaders.has(id))) fail('Copy only geometry, or use business weld Copy');
        if (id === 'selection.delete' && (selected.some(id => roles.some(b => b.entity_ids.includes(id)) || labels.has(id)) || selected.some(id => leaders.has(id)) && selected.some(id => !leaders.has(id)))) fail('Use the business command to delete a complete weld; auxiliary Delete selects leaders only');
        if (id === 'selection.propertyPatch' && (selected.some(id => labels.has(id) && Object.hasOwn(payload.patch, 'value') && payload.patch.value !== document.getEntity(id).value) || Object.hasOwn(payload.patch, 'type') && selected.some(id => allRoleIds(records.find(b => allRoleIds(b).includes(id)) || { entity_ids: [] }).includes(id) && payload.patch.type !== document.getEntity(id).type))) fail('Business role or label number cannot be edited by CAD');
      }
      if (copyIntent) selection.setSelection(copyIntent.all_ids, copyIntent.all_ids[0]);
      result = execute(id, payload);
      if (result.ok && business && !annotationIntent) {
        newWeld(business.weld_id);
        const oldIds = new Set(overlayBefore.snapshot.entities.map(entity => entity.id)), added = document.listEntities().filter(entity => !oldIds.has(entity.id));
        if (added.length !== (copyIntent ? copyIntent.all_ids.length : 1) || !copyIntent && added[0]?.type !== business.tool ||
          !same(document.listEntities().filter(entity => oldIds.has(entity.id)), overlayBefore.snapshot.entities)) fail('Business geometry creation was incomplete');
        upgrade();
        let newBinding = { weld_id: business.weld_id, entity_ids: [], label_id: null, leader_id: null };
        if (copyIntent) {
          const mapped = new Map(copyIntent.all_ids.map((oldId, index) => [oldId, added[index].id]));
          if (format === REPRESENTED_OVERLAY_SCHEMA) {
            const names = new Map(copyIntent.representations.map(row => [row.source_representation_id, row.representation_id]));
            newBinding = { weld_id: business.weld_id, primary_representation_id: names.get(copyIntent.source.primary_representation_id),
              representations: copyIntent.source.representations.map(rep => ({ ...clone(rep), representation_id: names.get(rep.representation_id),
                entity_ids: rep.entity_ids.map(id => mapped.get(id)), label_id: rep.label_id === null ? null : mapped.get(rep.label_id),
                leader_id: rep.leader_id === null ? null : mapped.get(rep.leader_id) })) };
            for (const rep of newBinding.representations) if (rep.label_id !== null && !document.updateEntity(rep.label_id, { value: business.display_no })) fail('Label layer is locked');
          } else newBinding.entity_ids = copyIntent.source.entity_ids.map(id => mapped.get(id));
          if (format !== REPRESENTED_OVERLAY_SCHEMA && copyIntent.source.label_id != null) { newBinding.label_id = mapped.get(copyIntent.source.label_id); if (!document.updateEntity(newBinding.label_id, { value: business.display_no })) fail('Label layer is locked'); }
          if (format !== REPRESENTED_OVERLAY_SCHEMA && copyIntent.source.leader_id != null) newBinding.leader_id = mapped.get(copyIntent.source.leader_id);
        } else newBinding.entity_ids = added.map(entity => entity.id);
        if (!copyIntent && format === REPRESENTED_OVERLAY_SCHEMA) {
          newBinding = { weld_id: business.weld_id, primary_representation_id: business.representation_id,
            representations: [{ representation_id: business.representation_id, view_name: business.view_name,
              entity_ids: newBinding.entity_ids, label_id: createLabel(newBinding.entity_ids, business.display_no), leader_id: null }] };
        } else if (format !== REPRESENTED_OVERLAY_SCHEMA && newBinding.label_id === null) newBinding.label_id = createLabel(newBinding.entity_ids, business.display_no);
        records = [...records, newBinding];
      }
      if (result.ok && !business && id === 'selection.delete' && annotatedFormat(format)) {
        for (const binding of roleRecords(records)) if (binding.leader_id !== null && !document.getEntity(binding.leader_id)) binding.leader_id = null;
      }
      if (result.ok) getOverlaySnapshot();
      else { format = previousFormat; document.weldingFormat = format; restoreState(commands.context, before); records = previousRecords; commands.undoStack = undo; commands.redoStack = redo; commands.emitHistory(); }
    } catch (error) {
      format = previousFormat; document.weldingFormat = format; restoreState(commands.context, before); records = previousRecords;
      commands.undoStack = undo; commands.redoStack = redo; commands.emitHistory();
      result = commandResult(false, false, { error_code: 'WELD_OVERLAY_INVALID', message: error.message });
    } finally { suppress = false; }
    if (!result.ok && business && !copyIntent && !annotationIntent) host?.onIntentCancelled?.(business.intent_id);
    if (result.ok && hosted()) {
      finishHostAction(id, overlayBefore, business?.intent_id ?? null);
      if (!same(before.selection, selection.toJSON())) selection.emitChange('welding.action');
    }
    else if (result.ok && result.changed) changed();
    return result;
  }
  commands.execute = (id, payload) => executeCommand(id, payload);
  commands.register({ id: 'welding.bindings.set', label: 'Set weld bindings', canExecute: () => contextKey !== null,
    execute: (_ctx, payload) => {
      bindings(payload.bindings, new Map(document.listEntities().map(entity => [entity.id, entity])), format);
      if (format === REPRESENTED_OVERLAY_SCHEMA && !same(payload.bindings, records)) fail('Use an explicit representation action');
      if (format === ANNOTATED_OVERLAY_SCHEMA) {
        for (const next of payload.bindings) {
          const old = records.find(row => row.weld_id === next.weld_id);
          if (next.label_id !== (old?.label_id ?? null) || next.leader_id !== (old?.leader_id ?? null)) fail('Binding cannot transfer annotation roles');
        }
      }
      const before = clone(records), after = clone(payload.bindings);
      records = after; changed();
      return commandResult(true, true, { undo: () => { records = clone(before); changed(); }, redo: () => { records = clone(after); changed(); } });
    }
  });
  commands.register({ id: 'welding.annotation.set', label: 'Set weld annotation', canExecute: () => hosted(), execute: (_ctx, input) => {
    const before = getOverlaySnapshot(), owner = records.find(row => row.weld_id === input.weld_id);
    const binding = format === REPRESENTED_OVERLAY_SCHEMA ? owner?.representations.find(rep => rep.representation_id === input.representation_id) : owner;
    if (!binding) fail('Annotation weld has no geometry');
    if (input.mode === 'removeLeader' && binding.leader_id == null) return commandResult(true, false);
    if (input.mode === 'label' && binding.label_id != null && document.getEntity(binding.label_id).value === input.display_no) return commandResult(true, false);
    upgrade(); const targetOwner = records.find(row => row.weld_id === input.weld_id);
    const target = format === REPRESENTED_OVERLAY_SCHEMA ? targetOwner.representations.find(rep => rep.representation_id === input.representation_id) : targetOwner;
    if (input.mode === 'removeLeader') { if (document.getLayer(document.getEntity(target.leader_id).layerId)?.locked || !document.removeEntity(target.leader_id)) fail('Leader layer is locked'); target.leader_id = null; }
    else {
      if (target.label_id === null) target.label_id = createLabel(target.entity_ids, input.display_no);
      else if (document.getEntity(target.label_id).value !== input.display_no && !document.updateEntity(target.label_id, { value: input.display_no })) fail('Label layer is locked');
      if (input.mode === 'leader') {
        const start = geometryCenter(target.entity_ids), end = clone(document.getEntity(target.label_id).position);
        if (target.leader_id === null) { const entity = document.addEntity({ type: 'line', layerId: document.getEntity(target.entity_ids[0]).layerId, start, end }); if (!entity) fail('Leader layer is locked'); target.leader_id = entity.id; }
        else { const existing = document.getEntity(target.leader_id), patch = existing.type === 'line' ? { start, end } : { points: [start, end], closed: false };
          if (!same({ ...existing, ...patch }, existing) && !document.updateEntity(target.leader_id, patch)) fail('Leader layer is locked'); }
      }
    }
    return commandResult(true, !same(before, getOverlaySnapshot()));
  } });
  commands.register({ id: 'welding.representation.set', label: 'Edit weld representation', canExecute: () => hosted(), execute: (_ctx, input) => {
    const before = getOverlaySnapshot();
    if (input.mode === 'upgrade') {
      if (format === REPRESENTED_OVERLAY_SCHEMA || !Array.isArray(input.names) || input.names.length !== records.length) fail('Explicit upgrade names required');
      const names = new Map();
      for (const row of input.names) { keys(row, ['weld_id', 'representation_id', 'view_name']); weldId(row.weld_id); weldId(row.representation_id); text(row.view_name, 256, true); if (names.has(row.weld_id)) fail('Duplicate upgrade name'); names.set(row.weld_id, row); }
      records = activeBindings().map(binding => {
        const name = names.get(binding.weld_id); if (!name) fail('Missing human view name');
        return { weld_id: binding.weld_id, primary_representation_id: name.representation_id,
          representations: [{ representation_id: name.representation_id, view_name: name.view_name,
            entity_ids: [...binding.entity_ids], label_id: binding.label_id ?? null, leader_id: binding.leader_id ?? null }] };
      });
      format = REPRESENTED_OVERLAY_SCHEMA; document.weldingFormat = format;
    } else {
      if (format !== REPRESENTED_OVERLAY_SCHEMA) fail('Explicit representation upgrade required');
      weldId(input.weld_id); weldId(input.representation_id);
      const binding = records.find(row => row.weld_id === input.weld_id);
      const target = binding?.representations.find(rep => rep.representation_id === input.representation_id);
      if (input.mode === 'add' || input.mode === 'copy') {
        text(input.view_name, 256, true);
        if (roleRecords(records).some(rep => rep.representation_id === input.representation_id)) fail('Representation identity already exists');
        let rep;
        if (input.mode === 'copy') {
          weldId(input.source_representation_id); point(input.delta);
          const source = binding?.representations.find(row => row.representation_id === input.source_representation_id);
          if (!source) fail('Source representation missing');
          const ids = allRoleIds(source);
          if (ids.some(id => document.getLayer(document.getEntity(id).layerId)?.locked)) fail('Copy layer is locked');
          const added = ids.map(id => { const raw = transformEntityByDelta(document.getEntity(id), input.delta); delete raw.id; return document.addEntity(raw); });
          if (added.some(entity => !entity)) fail('Copy roles incomplete');
          const mapped = new Map(ids.map((id, i) => [id, added[i].id]));
          rep = { representation_id: input.representation_id, view_name: input.view_name,
            entity_ids: source.entity_ids.map(id => mapped.get(id)), label_id: source.label_id === null ? null : mapped.get(source.label_id),
            leader_id: source.leader_id === null ? null : mapped.get(source.leader_id) };
        } else {
          if (!Array.isArray(input.entity_ids) || !input.entity_ids.length || input.entity_ids.some(id => allRoleIds({ representations: roleRecords(records) }).includes(id))) fail('Geometry already belongs to a representation');
          rep = { representation_id: input.representation_id, view_name: input.view_name, entity_ids: [...input.entity_ids], label_id: null, leader_id: null };
        }
        if (binding) binding.representations.push(rep);
        else records.push({ weld_id: input.weld_id, primary_representation_id: rep.representation_id, representations: [rep] });
      } else {
        if (!target) fail('Representation missing');
        if (input.mode === 'rename') { text(input.view_name, 256, true); target.view_name = input.view_name; }
        if (input.mode === 'primary') binding.primary_representation_id = target.representation_id;
        if (input.mode === 'remove') {
          const remaining = binding.representations.filter(rep => rep !== target);
          if (remaining.length && binding.primary_representation_id === target.representation_id) {
            weldId(input.replacement_primary_id);
            if (!remaining.some(rep => rep.representation_id === input.replacement_primary_id)) fail('Explicit surviving primary required');
            binding.primary_representation_id = input.replacement_primary_id;
          } else if (input.replacement_primary_id !== null) fail('Unexpected primary replacement');
          const ids = allRoleIds(target);
          if (ids.some(id => document.getLayer(document.getEntity(id).layerId)?.locked)) fail('Remove layer is locked');
          if (ids.some(id => !document.removeEntity(id))) fail('Remove roles incomplete');
          if (remaining.length) binding.representations = remaining;
          else records = records.filter(row => row !== binding);
        }
      }
    }
    return commandResult(true, !same(before, getOverlaySnapshot()));
  } });
  return {
    isWeldingMutationInProgress: () => suppress,
    getWeldingLabelIds: () => roleRecords(records).map(binding => binding.label_id).filter(id => id != null),
    changeWeldingRepresentation(input) {
      if (!hosted()) throw new Error('WELD_HOST_REQUIRED'); writable(); cancelDraw();
      intentId(input?.intent_id);
      const fields = { upgrade: ['names'], add: ['weld_id', 'representation_id', 'view_name', 'entity_ids'],
        copy: ['weld_id', 'source_representation_id', 'representation_id', 'view_name', 'delta'],
        rename: ['weld_id', 'representation_id', 'view_name'], primary: ['weld_id', 'representation_id'],
        remove: ['weld_id', 'representation_id', 'replacement_primary_id'] }[input.mode];
      if (!fields) fail('Unknown representation action'); keys(input, ['intent_id', 'mode', ...fields]);
      return executeCommand('welding.representation.set', input, null, input);
    },
    annotateWeldingBinding(input) {
      if (!hosted()) throw new Error('WELD_HOST_REQUIRED'); writable();
      keys(input, ['intent_id', 'weld_id', 'display_no', 'mode', ...(format === REPRESENTED_OVERLAY_SCHEMA ? ['representation_id'] : [])]); if (format === REPRESENTED_OVERLAY_SCHEMA) weldId(input.representation_id); intentId(input.intent_id); weldId(input.weld_id); weldId(input.display_no);
      if (!['label', 'leader', 'removeLeader'].includes(input.mode)) fail('Invalid annotation mode'); cancelDraw();
      return executeCommand('welding.annotation.set', input, null, input);
    },
    configureWeldingHost(callbacks) {
      if (callbacks !== null && (typeof callbacks?.onAction !== 'function' || typeof callbacks?.onHistoryRequest !== 'function' || callbacks.onIntentCancelled !== undefined && typeof callbacks.onIntentCancelled !== 'function')) throw new Error('WELD_HOST_INVALID');
      if (hostPending) throw new Error('WELD_HOST_ACTION_PENDING');
      cancelDraw(); host = callbacks; preview = false;
      if (contextKey !== null && host) { commands.undoStack = []; commands.redoStack = []; commands.emitHistory(); }
    },
    isWeldingHost: hosted,
    cancelWeldingBusinessIntent,
    armWeldingDraw(input) {
      if (!hosted()) throw new Error('WELD_HOST_REQUIRED'); writable();
      keys(input, ['intent_id', 'weld_id', 'display_no', 'tool', ...(format === REPRESENTED_OVERLAY_SCHEMA ? ['representation_id', 'view_name'] : [])]); if (format === REPRESENTED_OVERLAY_SCHEMA) { weldId(input.representation_id); text(input.view_name, 256, true); } intentId(input.intent_id); weldId(input.display_no); newWeld(input.weld_id);
      if (!['line', 'arc', 'polyline'].includes(input.tool)) fail('Invalid draw tool');
      cancelDraw(); drawIntent = clone(input);
    },
    copyWeldingBinding(input) {
      if (!hosted()) throw new Error('WELD_HOST_REQUIRED'); writable();
      keys(input, ['intent_id', 'source_weld_id', 'weld_id', 'display_no', 'delta', ...(format === REPRESENTED_OVERLAY_SCHEMA ? ['representations'] : [])]); intentId(input.intent_id); weldId(input.display_no); weldId(input.source_weld_id); newWeld(input.weld_id); point(input.delta);
      const source = activeBindings().find(binding => binding.weld_id === input.source_weld_id);
      const allIds = source && allRoleIds(source);
      if (!source || !allIds.length || allIds.some(id => !document.getEntity(id) || document.getLayer(document.getEntity(id).layerId)?.locked)) fail('Source binding cannot be completely copied');
      if (format === REPRESENTED_OVERLAY_SCHEMA) {
        if (!Array.isArray(input.representations) || input.representations.length !== source.representations.length) fail('Fresh copied representation identities required');
        const old = new Set(), fresh = new Set();
        for (const row of input.representations) { keys(row, ['source_representation_id', 'representation_id']); weldId(row.source_representation_id); weldId(row.representation_id);
          if (!source.representations.some(rep => rep.representation_id === row.source_representation_id) || old.has(row.source_representation_id) || fresh.has(row.representation_id) || roleRecords(records).some(rep => rep.representation_id === row.representation_id)) fail('Copied representation identity invalid');
          old.add(row.source_representation_id); fresh.add(row.representation_id); }
      }
      for (const id of allIds) {
        const translated = transformEntityByDelta(document.getEntity(id), input.delta); geometry(translated, annotatedFormat(format));
        if (translated.type === 'text') indexSafe(translated, document.spatialIndex.cellSize);
        const bounds = computeEntityAabb({ ...translated, visible: true });
        if (!bounds || Object.values(bounds).some(value => !Number.isSafeInteger(Math.floor(value / document.spatialIndex.cellSize)))) fail('Copied geometry exceeds the native spatial index');
      }
      cancelDraw();
      return executeCommand('selection.copy', { delta: clone(input.delta) }, { ...clone(input), source: clone(source), all_ids: allIds });
    },
    runWeldingHostEdit,
    beginWeldingPreview() { if (hosted()) { writable(); cancelDraw(); preview = true; return true; } return false; },
    endWeldingPreview() { preview = false; },
    acceptWeldingAction(expected) {
      if (!hostPending || expected?.context_key !== contextKey || expected?.edit_revision !== editRevision) throw new Error('WELD_OVERLAY_STALE_CONTEXT');
      hostPending = false;
    },
    selectWeldingEntities(ids, primary) {
      if (contextKey === null || !Array.isArray(ids) || ids.length > 2000 || new Set(ids).size !== ids.length || ids.some(id => !Number.isInteger(id) || id < 0 || id > MAX_ID || !document.getEntity(id)) || primary !== null && !ids.includes(primary)) throw new Error('WELD_HOST_INVALID_SELECTION');
      selection.setSelection(ids, primary);
    },
    snapshotWeldingOverlay() { if (hostPending || preview) throw new Error('WELD_HOST_ACTION_PENDING'); cancelDraw(); return getOverlaySnapshot(); },
    restoreWeldingOverlay(value, options) {
      if (hostPending || preview) throw new Error('WELD_HOST_ACTION_PENDING');
      cancelDraw(); let overlay = value;
      if (overlay === null) { const empty = new DocumentState(); empty.confirmPhysicalUnit(document.weldingUnit); overlay = { schema: OVERLAY_SCHEMA, snapshot: empty.snapshot(), bindings: [] }; }
      return this.loadWeldingContext({ context_key: contextKey, base_snapshot: underlay.snapshot(), overlay }, options);
    },
    getWeldingContext: () => ({ context_key: contextKey, edit_revision: editRevision, observer_error: observerError }),
    loadWeldingContext(context, { expected_context_key, expected_edit_revision } = {}) {
      if (hostPending) throw new Error('WELD_HOST_ACTION_PENDING');
      if (expected_context_key !== contextKey || contextKey !== null && expected_edit_revision === undefined || expected_edit_revision !== undefined && expected_edit_revision !== editRevision) throw new Error('WELD_OVERLAY_STALE_CONTEXT');
      keys(context, ['context_key', 'base_snapshot', 'overlay']); text(context.context_key, 256, true);
      validateWeldingOverlay(context.overlay);
      const nextUnderlay = createReadOnlyUnderlay(context.base_snapshot, context.overlay.snapshot.meta.unit);
      cancelDraw();
      suppress = true;
      try {
        document.weldingUnit = null; format = context.overlay.schema; document.weldingFormat = format;
        document.restore(clone(context.overlay.snapshot), { fresh: true });
        document.weldingUnit = context.overlay.snapshot.meta.unit;
        records = clone(context.overlay.bindings); contextKey = context.context_key; underlay = nextUnderlay;
        selection.clear(); commands.undoStack = []; commands.redoStack = []; commands.emitHistory();
        editRevision += 1; observerError = null; hostPending = false; preview = false; setUnderlay(underlay);
      } finally { suppress = false; }
      return this.getWeldingContext();
    },
    getOverlaySnapshot,
    setWeldBindings: value => commands.execute('welding.bindings.set', { bindings: value }),
    onOverlayChanged(handler) { if (typeof handler !== 'function') throw new Error('Expected overlay change handler'); listeners.add(handler); return () => listeners.delete(handler); },
    getBaseSnapshot: () => underlay?.snapshot() ?? null,
    destroy() { document.removeEventListener('change', changed); commands.execute = execute; for (const [method, original] of originals) document[method] = original; listeners.clear(); }
  };
}
