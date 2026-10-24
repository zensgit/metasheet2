import { validateWeldingOverlay } from '../adapters/welding_overlay_adapter.js';

const TAU = 2 * Math.PI;
const point = value => ({ x: value.x, y: value.y });
function compareIds(a, b) {
  const left = Array.from(a, char => char.codePointAt(0)), right = Array.from(b, char => char.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
export function weldingArcSweep(entity) {
  if (entity?.type !== 'arc' || typeof entity.cw !== 'boolean' || !Number.isFinite(entity.startAngle) || !Number.isFinite(entity.endAngle)) throw new Error('WELD_MEASUREMENT_INVALID: Invalid arc');
  const delta = entity.cw ? entity.endAngle - entity.startAngle : entity.startAngle - entity.endAngle;
  if (!Number.isFinite(delta)) throw new Error('WELD_MEASUREMENT_INVALID: Arc subtraction overflow');
  return delta >= TAU ? TAU : ((delta % TAU) + TAU) % TAU;
}
export function weldingArcAngles(entity) {
  const startAngle = ((entity.startAngle % TAU) + TAU) % TAU;
  return { startAngle, endAngle: startAngle + (entity.cw ? 1 : -1) * weldingArcSweep(entity) };
}
export function weldingArcContainsAngle(entity, angle) {
  const { startAngle } = weldingArcAngles(entity);
  const delta = entity.cw ? angle - startAngle : startAngle - angle;
  return ((delta % TAU) + TAU) % TAU <= weldingArcSweep(entity) + 1e-6;
}
export function geometryBasis(overlay) {
  if (overlay === null) return { source_unit: null, bindings: [], entities: [] };
  validateWeldingOverlay(overlay);
  const bindings = overlay.bindings.map(binding => {
    if (overlay.schema === 'vemcad-weld-overlay/3') {
      const primary = binding.representations.find(rep => rep.representation_id === binding.primary_representation_id);
      return { weld_id: binding.weld_id, representation_id: primary.representation_id, entity_ids: [...primary.entity_ids].sort((a, b) => a - b) };
    }
    return { weld_id: binding.weld_id, entity_ids: [...binding.entity_ids].sort((a, b) => a - b) };
  }).sort((a, b) => compareIds(a.weld_id, b.weld_id));
  const ids = new Set(bindings.flatMap(binding => binding.entity_ids));
  const entities = overlay.snapshot.entities.filter(entity => ids.has(entity.id)).sort((a, b) => a.id - b.id).map(entity => {
    const common = { id: entity.id, type: entity.type };
    if (entity.type === 'line') return { ...common, start: point(entity.start), end: point(entity.end) };
    if (entity.type === 'arc') return { ...common, center: point(entity.center), radius: entity.radius, startAngle: entity.startAngle, endAngle: entity.endAngle, cw: entity.cw };
    return { ...common, points: entity.points.map(point), closed: entity.closed };
  });
  return { source_unit: overlay.snapshot.meta.unit, bindings, entities };
}
function entityLength(entity) {
  const segment = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  if (entity.type === 'line') return segment(entity.start, entity.end);
  if (entity.type === 'arc') return entity.radius * weldingArcSweep(entity);
  let length = 0;
  for (let i = 1; i < entity.points.length; i += 1) length += segment(entity.points[i - 1], entity.points[i]);
  if (entity.closed) length += segment(entity.points.at(-1), entity.points[0]);
  return length;
}
export function measureWeldingOverlay(overlay) {
  const basis = geometryBasis(overlay), entities = new Map(basis.entities.map(entity => [entity.id, entity]));
  const factor = basis.source_unit === 'in' ? 25.4 : 1;
  const rows = basis.bindings.map(binding => {
    let length = 0;
    for (const id of binding.entity_ids) length += entityLength(entities.get(id));
    length *= factor;
    const measured = Number.isFinite(length);
    return { weld_id: binding.weld_id, status: measured ? 'measured' : 'unmeasurable', length_mm: measured ? length : null, reason: measured ? null : 'length_overflow' };
  });
  return { schema: 'vemcad-weld-measurement/1', algorithm: 'vemcad-weld-length/1', source_unit: basis.source_unit, rows };
}
