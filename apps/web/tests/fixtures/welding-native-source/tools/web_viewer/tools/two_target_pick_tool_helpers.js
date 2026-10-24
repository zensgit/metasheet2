export function suggestFilletRadius(s1, e1, s2, e2) {
  const ax = Number(s1?.x); const ay = Number(s1?.y);
  const bx = Number(e1?.x); const by = Number(e1?.y);
  const cx = Number(s2?.x); const cy = Number(s2?.y);
  const dx = Number(e2?.x); const dy = Number(e2?.y);
  if (![ax, ay, bx, by, cx, cy, dx, dy].every(Number.isFinite)) return null;
  // Find intersection of two infinite lines
  const d1x = bx - ax; const d1y = by - ay;
  const d2x = dx - cx; const d2y = dy - cy;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null; // parallel
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den;
  const ix = ax + t * d1x;
  const iy = ay + t * d1y;
  // Compute lengths from intersection to far endpoints
  const len1 = Math.sqrt((bx - ix) * (bx - ix) + (by - iy) * (by - iy));
  const len2 = Math.sqrt((dx - ix) * (dx - ix) + (dy - iy) * (dy - iy));
  if (len1 < 1e-12 || len2 < 1e-12) return null;
  // Compute angle between directions from intersection
  const v1x = (bx - ix) / len1; const v1y = (by - iy) / len1;
  const v2x = (dx - ix) / len2; const v2y = (dy - iy) / len2;
  const cosA = Math.max(-1, Math.min(1, v1x * v2x + v1y * v2y));
  const angle = Math.acos(cosA);
  if (angle < 1e-9 || angle > Math.PI - 1e-9) return null;
  // FreeCAD formula: min(len1, len2) * 0.2 * sin(angle / 2)
  const r = Math.min(len1, len2) * 0.2 * Math.sin(angle / 2);
  return r > 1e-9 ? r : null;
}

export function suggestChamferDistance(s1, e1, s2, e2) {
  const ax = Number(s1?.x); const ay = Number(s1?.y);
  const bx = Number(e1?.x); const by = Number(e1?.y);
  const cx = Number(s2?.x); const cy = Number(s2?.y);
  const dx = Number(e2?.x); const dy = Number(e2?.y);
  if (![ax, ay, bx, by, cx, cy, dx, dy].every(Number.isFinite)) return null;
  const d1x = bx - ax; const d1y = by - ay;
  const d2x = dx - cx; const d2y = dy - cy;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den;
  const ix = ax + t * d1x;
  const iy = ay + t * d1y;
  const len1 = Math.sqrt((bx - ix) * (bx - ix) + (by - iy) * (by - iy));
  const len2 = Math.sqrt((dx - ix) * (dx - ix) + (dy - iy) * (dy - iy));
  if (len1 < 1e-12 || len2 < 1e-12) return null;
  const d = Math.min(len1, len2) * 0.2;
  return d > 1e-9 ? d : null;
}

export function findEntitiesMeetingAtPoint(ctx, worldPoint, tolerance) {
  if (!ctx?.document || !worldPoint || !Number.isFinite(tolerance) || tolerance <= 0) return null;
  const tol2 = tolerance * tolerance;
  const px = Number(worldPoint.x);
  const py = Number(worldPoint.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;

  // Collect all endpoints from visible entities
  const endpoints = []; // { id, point, entity }
  const entityCount = ctx.document.getEntityCount?.() ?? 0;
  for (let i = 0; i < entityCount; i++) {
    const id = ctx.document.getEntityIdAt?.(i);
    if (!Number.isFinite(id)) continue;
    const entity = ctx.document.getEntity?.(id);
    if (!entity) continue;
    if (entity.type === 'line') {
      if (entity.start) endpoints.push({ id, point: entity.start, entity });
      if (entity.end) endpoints.push({ id, point: entity.end, entity });
    } else if (entity.type === 'polyline' && Array.isArray(entity.points)) {
      for (const pt of entity.points) {
        endpoints.push({ id, point: pt, entity });
      }
    } else if (entity.type === 'arc') {
      if (entity.center && Number.isFinite(entity.radius) && entity.radius > 0) {
        const r = entity.radius;
        const cx = Number(entity.center.x);
        const cy = Number(entity.center.y);
        const sa = Number(entity.startAngle) || 0;
        const ea = Number(entity.endAngle) || 0;
        endpoints.push({ id, point: { x: cx + r * Math.cos(sa), y: cy + r * Math.sin(sa) }, entity });
        endpoints.push({ id, point: { x: cx + r * Math.cos(ea), y: cy + r * Math.sin(ea) }, entity });
      }
    }
  }

  // Find an endpoint near the click
  let bestVertex = null;
  let bestDist2 = tol2;
  for (const ep of endpoints) {
    const ex = Number(ep.point?.x);
    const ey = Number(ep.point?.y);
    if (!Number.isFinite(ex) || !Number.isFinite(ey)) continue;
    const d2 = (ex - px) * (ex - px) + (ey - py) * (ey - py);
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestVertex = { x: ex, y: ey };
    }
  }
  if (!bestVertex) return null;

  // Find all entities sharing this vertex (within tolerance)
  const meetingIds = new Set();
  for (const ep of endpoints) {
    const ex = Number(ep.point?.x);
    const ey = Number(ep.point?.y);
    if (!Number.isFinite(ex) || !Number.isFinite(ey)) continue;
    const d2 = (ex - bestVertex.x) * (ex - bestVertex.x) + (ey - bestVertex.y) * (ey - bestVertex.y);
    if (d2 < tol2) {
      const ent = getTargetEntityById(ctx, ep.id);
      if (ent) meetingIds.add(ep.id);
    }
  }

  if (meetingIds.size !== 2) return null;
  const ids = Array.from(meetingIds);
  return { id1: ids[0], id2: ids[1], vertex: bestVertex };
}

export function getTargetEntityById(ctx, id) {
  const entity = ctx.document?.getEntity?.(id);
  if (!entity) return null;
  if (entity.type === 'line') return entity;
  if (entity.type === 'polyline') return entity;
  if (entity.type === 'arc') return entity;
  if (entity.type === 'circle') return entity;
  return null;
}

export function getSelectedTargetIds(ctx, getTargetEntity = getTargetEntityById) {
  const ids = Array.isArray(ctx.selection?.entityIds)
    ? ctx.selection.entityIds.filter((id) => Number.isFinite(id)).map((id) => Number(id))
    : [];
  return ids.filter((id) => !!getTargetEntity(ctx, id));
}

export function getSingleSelectedTargetId(ctx, getTargetEntity = getTargetEntityById) {
  const ids = getSelectedTargetIds(ctx, getTargetEntity);
  if (ids.length !== 1) return null;
  return ids[0];
}

export function getSelectedTargetPair(ctx, getTargetEntity = getTargetEntityById) {
  const ids = getSelectedTargetIds(ctx, getTargetEntity);
  if (ids.length !== 2) return null;
  const primary = Number.isFinite(ctx.selection?.primaryId) ? Number(ctx.selection.primaryId) : null;
  let first = ids[0];
  if (Number.isFinite(primary) && ids.includes(primary)) {
    first = primary;
  }
  const second = ids.find((id) => id !== first);
  if (!Number.isFinite(second)) return null;
  return { firstId: first, secondId: second };
}

export function currentSelectionKey(ctx) {
  const ids = Array.isArray(ctx.selection?.entityIds)
    ? ctx.selection.entityIds.filter((id) => Number.isFinite(id)).map((id) => Number(id))
    : [];
  if (ids.length === 0) return '';
  return ids.join(',');
}

export function projectPointToSegment(point, a, b) {
  if (!a || !b) return null;
  const ax = Number(a.x);
  const ay = Number(a.y);
  const bx = Number(b.x);
  const by = Number(b.y);
  if (![ax, ay, bx, by].every(Number.isFinite)) return null;
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-12) return { x: ax, y: ay };
  const px = Number(point?.x);
  const py = Number(point?.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { x: (ax + bx) * 0.5, y: (ay + by) * 0.5 };
  }
  let t = ((px - ax) * vx + (py - ay) * vy) / len2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return { x: ax + vx * t, y: ay + vy * t };
}

export function resolveEntityPickPoint(entity, referencePoint) {
  if (!entity) return null;
  if (entity.type === 'line') {
    return projectPointToSegment(referencePoint, entity.start, entity.end)
      || projectPointToSegment(null, entity.start, entity.end)
      || { x: 0, y: 0 };
  }
  if (entity.type === 'polyline' && Array.isArray(entity.points) && entity.points.length >= 2) {
    let best = null;
    let bestDist2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < entity.points.length - 1; i += 1) {
      const projected = projectPointToSegment(referencePoint, entity.points[i], entity.points[i + 1]);
      if (!projected) continue;
      const dx = projected.x - Number(referencePoint?.x ?? projected.x);
      const dy = projected.y - Number(referencePoint?.y ?? projected.y);
      const dist2 = dx * dx + dy * dy;
      if (dist2 < bestDist2) {
        bestDist2 = dist2;
        best = projected;
      }
    }
    if (best) return best;
    return projectPointToSegment(null, entity.points[0], entity.points[1]) || { x: 0, y: 0 };
  }
  if (entity.type === 'arc' || entity.type === 'circle') {
    const cx = Number(entity.center?.x);
    const cy = Number(entity.center?.y);
    const r = Number(entity.radius);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || r <= 0) {
      return { x: Number(referencePoint?.x) || 0, y: Number(referencePoint?.y) || 0 };
    }
    const px = Number(referencePoint?.x);
    const py = Number(referencePoint?.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      const sa = Number(entity.startAngle) || 0;
      return { x: cx + r * Math.cos(sa), y: cy + r * Math.sin(sa) };
    }
    const dx = px - cx;
    const dy = py - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-12) {
      const sa = Number(entity.startAngle) || 0;
      return { x: cx + r * Math.cos(sa), y: cy + r * Math.sin(sa) };
    }
    return { x: cx + (dx / dist) * r, y: cy + (dy / dist) * r };
  }
  return { x: Number(referencePoint?.x) || 0, y: Number(referencePoint?.y) || 0 };
}

export function resolvePickTarget(ctx, worldPoint, pickTolerancePx, getSingleSelectedId, allowSelectionFallback) {
  const hit = ctx.pickEntityAt?.(worldPoint, pickTolerancePx) || ctx.pickEntityAt?.(worldPoint);
  if (hit && Number.isFinite(hit.id)) {
    return { id: Number(hit.id), fromSelection: false };
  }
  if (!allowSelectionFallback) return null;
  const selectedId = getSingleSelectedId(ctx);
  if (!Number.isFinite(selectedId)) return null;
  return { id: selectedId, fromSelection: true };
}

export function formatCommandStatus(result, okFallback, failFallback) {
  const base = result?.message || (result?.ok ? okFallback : failFallback);
  if (result?.ok || !result?.error_code) {
    return base;
  }
  return `${base} [${String(result.error_code)}]`;
}
