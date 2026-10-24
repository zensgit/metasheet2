// Solver-facing command logic extracted from command_registry.js (P2 workbench
// split, S4). Behavior-preserving move of the solver command seam: the geometry
// patch applier behind `entity.applyGeometry` and the CADGF-PROJ project builder
// behind `solver.export-project`. Isolated as its own module because active
// product development runs through the solver/workbench path; this lets the seam
// evolve without the full registry. Bodies are unchanged — `solver.export-project`'s
// `commandResult` wrapping and no-constraints guard stay with the command
// registration in command_registry.js.

export function runApplyGeometry(ctx, payload) {
  const updates = Array.isArray(payload?.updates) ? payload.updates : [];
  if (updates.length === 0) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY_UPDATES', message: 'No geometry updates provided' };
  }
  let applied = 0;
  let skipped = 0;
  for (const update of updates) {
    if (!update || !Number.isFinite(update.id) || !update.patch || typeof update.patch !== 'object') {
      skipped += 1;
      continue;
    }
    if (ctx.document.updateEntity(update.id, update.patch)) applied += 1;
    else skipped += 1;
  }
  return {
    ok: true,
    changed: applied > 0,
    message: `Applied geometry to ${applied} ${applied === 1 ? 'entity' : 'entities'}${skipped ? ` (${skipped} skipped)` : ''}`,
  };
}

export function buildSolverProject(ctx) {
  const constraints = ctx.document.listConstraints();
  const entities = ctx.document.listEntities();
  const pointEntities = [];
  for (const entity of entities) {
    if (entity.type === 'line') {
      pointEntities.push(
        { id: `e${entity.id}_start`, type: 'point', params: { x: entity.start.x, y: entity.start.y } },
        { id: `e${entity.id}_end`, type: 'point', params: { x: entity.end.x, y: entity.end.y } },
      );
    } else if (entity.type === 'circle') {
      pointEntities.push(
        { id: `e${entity.id}_center`, type: 'point', params: { x: entity.center.x, y: entity.center.y } },
      );
    } else if (entity.type === 'arc') {
      pointEntities.push(
        { id: `e${entity.id}_center`, type: 'point', params: { x: entity.center.x, y: entity.center.y } },
      );
    }
  }
  return {
    header: { format: 'CADGF-PROJ', version: 1 },
    project: { id: ctx.document.meta.label || 'web-editor', units: ctx.document.meta.unit || 'mm' },
    scene: {
      entities: pointEntities,
      constraints: constraints.map((c) => {
        const spec = { id: c.id, type: c.type, refs: c.refs };
        if (c.value !== undefined) spec.value = c.value;
        return spec;
      }),
    },
    featureTree: { nodes: [], edges: [] },
    resources: {},
    meta: {},
  };
}
