// Read-only selection helpers extracted from command_registry.js (P2 workbench
// split, S3). Behavior-preserving move: pure predicates/accessors over the ctx
// selection + document that mutating commands consult before acting. No registry
// or source-group coupling, so they are safe shared infrastructure. Bodies are
// unchanged.

export function hasSelection(ctx) {
  return Array.isArray(ctx.selection.entityIds) && ctx.selection.entityIds.length > 0;
}

export function selectedEntities(ctx) {
  return ctx.selection.entityIds
    .map((id) => ctx.document.getEntity(id))
    .filter((entity) => !!entity);
}

export function isReadOnlyEntity(entity) {
  return !!entity && (entity.readOnly === true || entity.type === 'unsupported' || entity.editMode === 'proxy');
}

export function hasSameEntityIds(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const expected = new Set(right.map((id) => Math.trunc(Number(id))));
  for (const id of left) {
    const normalized = Math.trunc(Number(id));
    if (!expected.has(normalized)) {
      return false;
    }
  }
  return true;
}
