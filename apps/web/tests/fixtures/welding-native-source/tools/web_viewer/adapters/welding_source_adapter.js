import { importCadgfDocument, isCadgfDocument } from './cadgf_document_adapter.js';
import { createReadOnlyUnderlay, validateWeldingOverlay } from './welding_overlay_adapter.js';

export const SOURCE_ADAPTER_SCHEMA = 'vemcad-weld-source/1';

const MAX_ID = 2147483647;
function fail(message) { throw new Error(`WELD_SOURCE_INVALID: ${message}`); }
function finite(value, minimum = -Infinity) { if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) fail('Invalid number'); }
function id(value) { if (!Number.isInteger(value) || value < 0 || value >= MAX_ID) fail('Unsafe source ID'); }
function point(value) { if (!Array.isArray(value) || value.length !== 2) fail('Expected exact 2D coordinates'); value.forEach(v => finite(v)); }
function flag(value) { if (![true, false, 0, 1].includes(value)) fail('Invalid boolean'); }
function style(value) {
  for (const key of ['visible', 'locked', 'printable', 'frozen', 'construction']) if (Object.hasOwn(value, key)) flag(value[key]);
  if (value.color !== undefined && (!Number.isInteger(value.color) || value.color < 0 || value.color > 0xffffff)) fail('Invalid source color');
  if (value.line_weight !== undefined) finite(value.line_weight, 0);
  if (value.line_type_scale !== undefined) { finite(value.line_type_scale); if (value.line_type_scale <= 0) fail('Invalid source line scale'); }
}
function finiteJson(value, depth = 0) {
  if (depth > 64) fail('Source exceeds nesting limit');
  if (typeof value === 'number') finite(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(child => finiteJson(child, depth + 1));
}
function sourceUnit(document) {
  if (document.settings.unit_scale !== 1) fail('Unit scale 1 required');
  const declared = document.metadata.unit_name, prefix = 'dxf.source_semantics_v1.';
  const evidence = Object.entries(document.metadata.meta || {}).filter(([key]) => key.startsWith(prefix));
  if (!evidence.length) {
    if (!['mm', 'in'].includes(declared)) fail('Explicit mm/in required without unit diagnostics');
    return declared;
  }
  const fields = ['schema', 'insunits_status', 'insunits', 'insunits_code'];
  const diagnostic = Object.fromEntries(evidence.map(([key, value]) => [key.slice(prefix.length), value]));
  if (evidence.length !== fields.length || !fields.every(key => Object.hasOwn(diagnostic, key)) || diagnostic.schema !== 'vemcad.dxf_source_semantics/v1' || diagnostic.insunits_status !== 'supported') fail('Invalid unit diagnostics');
  const unit = diagnostic.insunits;
  if (!(unit === 'mm' && diagnostic.insunits_code === '4' || unit === 'in' && diagnostic.insunits_code === '1')) fail('Unsupported unit diagnostics');
  if (declared !== '' && (declared === 'inch' ? 'in' : declared) !== unit) fail('Source unit conflicts with diagnostics');
  return unit;
}
function sourceGeometry(entity) {
  if (entity.space !== undefined && ![0, 'model', 'Model'].includes(entity.space) || ['layout', 'layout_name'].some(key => entity[key] !== undefined && entity[key] !== 'Model')) fail('Source must use model space');
  const geometryKeys = ['polyline', 'point', 'line', 'arc', 'circle', 'ellipse', 'spline', 'text'];
  if (geometryKeys.some((key, type) => type !== entity.type && Object.hasOwn(entity, key))) fail('Conflicting source geometry');
  for (const key of Object.keys(entity)) if (/^(elevation|extrusion)$/i.test(key) || entity.type === 0 && /bulge|width/i.test(key)) fail(`Unsupported source geometry field: ${key}`);
  switch (entity.type) {
    case 0: {
      if (!Array.isArray(entity.polyline) || entity.polyline.length < 2 || entity.polyline.length > 1000) fail('Invalid straight polyline');
      entity.polyline.forEach(point);
      for (let i = 1; i < entity.polyline.length; i += 1) if (entity.polyline[i][0] === entity.polyline[i - 1][0] && entity.polyline[i][1] === entity.polyline[i - 1][1]) fail('Degenerate polyline');
      const first = entity.polyline[0], last = entity.polyline.at(-1), closed = first[0] === last[0] && first[1] === last[1];
      if (!closed && entity.polyline.length >= 3 && Math.abs(first[0] - last[0]) <= 1e-9 && Math.abs(first[1] - last[1]) <= 1e-9) fail('Importer would approximate polyline closure');
      if (entity.closed !== undefined) { flag(entity.closed); if (Boolean(entity.closed) !== closed) fail('Unsupported polyline closure representation'); }
      if (closed && entity.polyline.length < 4) fail('Invalid closed polyline');
      break;
    }
    case 1: point(entity.point); break;
    case 2: if (!Array.isArray(entity.line) || entity.line.length !== 2) fail('Invalid line'); entity.line.forEach(point); break;
    case 3: {
      if (!entity.arc) fail('Missing arc'); point(entity.arc.c); finite(entity.arc.r, 0.001); finite(entity.arc.a0); finite(entity.arc.a1); flag(entity.arc.cw);
      break;
    }
    case 4: if (!entity.circle) fail('Missing circle'); point(entity.circle.c); finite(entity.circle.r, 0.001); break;
    case 5: {
      if (!entity.ellipse) fail('Missing ellipse'); const e = entity.ellipse; point(e.c); finite(e.rx, 0.001); finite(e.ry, 0.001); finite(e.rot); finite(e.a0); finite(e.a1);
      const delta = e.a1 - e.a0; if (!Number.isFinite(delta) || delta === 0) fail('Invalid ellipse sweep');
      break;
    }
    case 7: if (!entity.text) fail('Missing text'); point(entity.text.pos); finite(entity.text.h, 0.1); finite(entity.text.rot); if (typeof entity.text.value !== 'string') fail('Invalid text'); break;
    default: fail('Unsupported source entity; spline control polygon is not its curve');
  }
}

// Validate raw geometry before the ordinary importer can coerce, clamp or repair it.
// No source-byte/provenance authority is granted by this display adapter.
export function deriveWeldingBaseSnapshot(cadgfDocument, { buildSpatialIndex = true } = {}) {
  if (!isCadgfDocument(cadgfDocument) || cadgfDocument.schema_version !== 1) fail('Expected CADGF Document v1');
  finiteJson(cadgfDocument);
  const unit = sourceUnit(cadgfDocument);
  if (!cadgfDocument.layers.length || cadgfDocument.layers.length > 100 || cadgfDocument.entities.length > 10000) fail('Source count exceeds limit');
  const layerIds = new Set(), entityIds = new Set();
  for (const layer of cadgfDocument.layers) { id(layer?.id); style(layer); if (layerIds.has(layer.id)) fail('Duplicate layer ID'); layerIds.add(layer.id); }
  for (const entity of cadgfDocument.entities) {
    id(entity?.id); id(entity?.layer_id); if (entityIds.has(entity.id) || !layerIds.has(entity.layer_id)) fail('Duplicate entity or missing layer'); entityIds.add(entity.id);
    style(entity); sourceGeometry(entity);
  }
  const imported = importCadgfDocument(cadgfDocument);
  const proxyWarnings = new Set(cadgfDocument.entities.filter(e => [1, 5].includes(e.type)).map(e => `entity:${e.id} unsupported cadgf type=${e.type}`));
  if (imported.warnings.some(warning => !proxyWarnings.has(warning))) fail('Source import reported unsupported or invalid geometry');
  const snapshot = imported.docSnapshot;
  if (snapshot.entities.some(entity => entity.space !== undefined && entity.space !== 0 || entity.layout !== undefined && entity.layout !== 'Model')) fail('Imported source must use model space');
  // The normal importer adds layer 0 for its editable workspace; a fixed source
  // retains only real source layers because every reference was checked above.
  snapshot.layers = snapshot.layers.filter(layer => layerIds.has(layer.id));
  snapshot.nextLayerId = Math.max(...layerIds) + 1;
  snapshot.nextConstraintId = 1; snapshot.constraints = [];
  snapshot.meta.currentSpace = 0; snapshot.meta.currentLayout = 'Model';
  snapshot.meta.unit = unit; snapshot.meta.unitDeclared = true;
  try { return createReadOnlyUnderlay(snapshot, unit, { buildSpatialIndex }).snapshot(); }
  catch (error) { fail(error.message); }
}

export function prepareWeldingContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'cadgf_document,context_key,overlay') fail('Expected exact CADGF welding context');
  if (typeof input.context_key !== 'string' || !input.context_key || Array.from(input.context_key).length > 256 || input.context_key !== input.context_key.trim() || input.context_key.includes('\0')) fail('Invalid context key');
  const base_snapshot = deriveWeldingBaseSnapshot(input.cadgf_document);
  try { validateWeldingOverlay(input.overlay); } catch (error) { fail(error.message); }
  if (base_snapshot.meta.unit !== input.overlay.snapshot.meta.unit) fail('Base/overlay units differ');
  return structuredClone({ context_key: input.context_key, base_snapshot, overlay: input.overlay });
}
