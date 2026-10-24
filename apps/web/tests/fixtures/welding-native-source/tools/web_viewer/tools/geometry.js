export const EPSILON = 1e-6;

export function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distance(a, b) {
  return Math.sqrt(distanceSq(a, b));
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

export function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

export function length(v) {
  return Math.hypot(v.x, v.y);
}

export function normalizeAngle(angle) {
  let value = angle;
  while (value < 0) value += Math.PI * 2;
  while (value >= Math.PI * 2) value -= Math.PI * 2;
  return value;
}

export function angleFrom(center, point) {
  return Math.atan2(point.y - center.y, point.x - center.x);
}

export function angleDelta(start, end) {
  let delta = end - start;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export function pointOnSegmentDistance(point, start, end) {
  const seg = subtract(end, start);
  const lenSq = dot(seg, seg);
  if (lenSq <= EPSILON) {
    return distance(point, start);
  }
  const t = Math.max(0, Math.min(1, dot(subtract(point, start), seg) / lenSq));
  const projected = {
    x: start.x + seg.x * t,
    y: start.y + seg.y * t,
  };
  return distance(point, projected);
}

export function pointInRect(point, rect) {
  const minX = Math.min(rect.x0, rect.x1);
  const maxX = Math.max(rect.x0, rect.x1);
  const minY = Math.min(rect.y0, rect.y1);
  const maxY = Math.max(rect.y0, rect.y1);
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
}

export function lineLineIntersection(a0, a1, b0, b1, asSegment = true, bsSegment = true) {
  const s1x = a1.x - a0.x;
  const s1y = a1.y - a0.y;
  const s2x = b1.x - b0.x;
  const s2y = b1.y - b0.y;
  const den = -s2x * s1y + s1x * s2y;
  if (Math.abs(den) <= EPSILON) {
    return null;
  }

  const s = (-s1y * (a0.x - b0.x) + s1x * (a0.y - b0.y)) / den;
  const t = (s2x * (a0.y - b0.y) - s2y * (a0.x - b0.x)) / den;

  if (asSegment && (t < -EPSILON || t > 1 + EPSILON)) return null;
  if (bsSegment && (s < -EPSILON || s > 1 + EPSILON)) return null;

  return {
    x: a0.x + (t * s1x),
    y: a0.y + (t * s1y),
    t,
    s,
  };
}

export function lineArcIntersection(p1, p2, cx, cy, r) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const fx = p1.x - cx;
  const fy = p1.y - cy;
  const a = dx * dx + dy * dy;
  if (a <= EPSILON) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < -EPSILON) return [];
  const sqrtDisc = Math.sqrt(Math.max(0, disc));
  const results = [];
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  for (const t of [t1, t2]) {
    if (t >= -EPSILON && t <= 1 + EPSILON) {
      results.push({
        x: p1.x + t * dx,
        y: p1.y + t * dy,
        t: Math.max(0, Math.min(1, t)),
      });
    }
  }
  return results;
}

export function applyDelta(point, delta) {
  return {
    x: point.x + delta.x,
    y: point.y + delta.y,
  };
}

function moveTextMetadata(next, delta) {
  if (isFinitePoint(next.sourceTextPos)) {
    next.sourceTextPos = applyDelta(next.sourceTextPos, delta);
  }
  if (isFinitePoint(next.sourceAnchor)) {
    next.sourceAnchor = applyDelta(next.sourceAnchor, delta);
  }
  if (isFinitePoint(next.leaderLanding)) {
    next.leaderLanding = applyDelta(next.leaderLanding, delta);
  }
  if (isFinitePoint(next.leaderElbow)) {
    next.leaderElbow = applyDelta(next.leaderElbow, delta);
  }
  if (isFinitePoint(next.dimTextPos)) {
    next.dimTextPos = applyDelta(next.dimTextPos, delta);
  }
}

export function rotatePoint(point, center, angleRad) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

export function scalePoint(point, center, factor) {
  return {
    x: center.x + (point.x - center.x) * factor,
    y: center.y + (point.y - center.y) * factor,
  };
}

function rotateTextMetadata(next, center, angleRad) {
  if (isFinitePoint(next.sourceTextPos)) {
    next.sourceTextPos = rotatePoint(next.sourceTextPos, center, angleRad);
  }
  if (isFinitePoint(next.sourceAnchor)) {
    next.sourceAnchor = rotatePoint(next.sourceAnchor, center, angleRad);
  }
  if (isFinitePoint(next.leaderLanding)) {
    next.leaderLanding = rotatePoint(next.leaderLanding, center, angleRad);
  }
  if (isFinitePoint(next.leaderElbow)) {
    next.leaderElbow = rotatePoint(next.leaderElbow, center, angleRad);
  }
  if (Number.isFinite(next.sourceTextRotation)) {
    next.sourceTextRotation = Number(next.sourceTextRotation) + angleRad;
  }
  if (isFinitePoint(next.dimTextPos)) {
    next.dimTextPos = rotatePoint(next.dimTextPos, center, angleRad);
  }
  if (Number.isFinite(next.dimTextRotation)) {
    next.dimTextRotation = Number(next.dimTextRotation) + angleRad;
  }
}

function scaleTextMetadata(next, center, factor) {
  if (isFinitePoint(next.sourceTextPos)) {
    next.sourceTextPos = scalePoint(next.sourceTextPos, center, factor);
  }
  if (isFinitePoint(next.sourceAnchor)) {
    next.sourceAnchor = scalePoint(next.sourceAnchor, center, factor);
  }
  if (isFinitePoint(next.leaderLanding)) {
    next.leaderLanding = scalePoint(next.leaderLanding, center, factor);
  }
  if (isFinitePoint(next.leaderElbow)) {
    next.leaderElbow = scalePoint(next.leaderElbow, center, factor);
  }
  if (isFinitePoint(next.dimTextPos)) {
    next.dimTextPos = scalePoint(next.dimTextPos, center, factor);
  }
}

export function transformEntityByDelta(entity, delta) {
  const next = cloneValue(entity);
  if (next.type === 'line') {
    next.start = applyDelta(next.start, delta);
    next.end = applyDelta(next.end, delta);
    return next;
  }
  if (next.type === 'polyline') {
    next.points = next.points.map((point) => applyDelta(point, delta));
    return next;
  }
  if (next.type === 'circle' || next.type === 'arc') {
    next.center = applyDelta(next.center, delta);
    return next;
  }
  if (next.type === 'text') {
    next.position = applyDelta(next.position, delta);
    moveTextMetadata(next, delta);
    return next;
  }
  return next;
}

export function rotateEntity(entity, center, angleRad) {
  const next = cloneValue(entity);
  if (next.type === 'line') {
    next.start = rotatePoint(next.start, center, angleRad);
    next.end = rotatePoint(next.end, center, angleRad);
    return next;
  }
  if (next.type === 'polyline') {
    next.points = next.points.map((point) => rotatePoint(point, center, angleRad));
    return next;
  }
  if (next.type === 'circle' || next.type === 'arc') {
    next.center = rotatePoint(next.center, center, angleRad);
    if (next.type === 'arc') {
      next.startAngle = normalizeAngle(next.startAngle + angleRad);
      next.endAngle = normalizeAngle(next.endAngle + angleRad);
    }
    return next;
  }
  if (next.type === 'text') {
    next.position = rotatePoint(next.position, center, angleRad);
    next.rotation = Number(next.rotation || 0) + angleRad;
    rotateTextMetadata(next, center, angleRad);
    return next;
  }
  return next;
}

export function scaleEntity(entity, center, factor) {
  const next = cloneValue(entity);
  if (next.type === 'line') {
    next.start = scalePoint(next.start, center, factor);
    next.end = scalePoint(next.end, center, factor);
    return next;
  }
  if (next.type === 'polyline') {
    next.points = next.points.map((point) => scalePoint(point, center, factor));
    return next;
  }
  if (next.type === 'circle' || next.type === 'arc') {
    next.center = scalePoint(next.center, center, factor);
    next.radius = Math.max(0.001, Number(next.radius || 0) * factor);
    return next;
  }
  if (next.type === 'text') {
    next.position = scalePoint(next.position, center, factor);
    next.height = Math.max(0.1, Number(next.height || 0) * factor);
    scaleTextMetadata(next, center, factor);
    return next;
  }
  return next;
}

export function extractLineSegments(entity) {
  if (!entity) return [];
  if (entity.type === 'line') {
    return [{ start: entity.start, end: entity.end, entityId: entity.id, type: 'line' }];
  }
  if (entity.type === 'polyline' && Array.isArray(entity.points) && entity.points.length >= 2) {
    const out = [];
    for (let i = 0; i < entity.points.length - 1; i += 1) {
      out.push({
        start: entity.points[i],
        end: entity.points[i + 1],
        entityId: entity.id,
        type: 'polyline',
        index: i,
      });
    }
    if (entity.closed) {
      out.push({
        start: entity.points[entity.points.length - 1],
        end: entity.points[0],
        entityId: entity.id,
        type: 'polyline',
        index: entity.points.length - 1,
      });
    }
    return out;
  }
  return [];
}

function ellipsePoint(center, rx, ry, rotation, angle) {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  return {
    x: center.x + (rx * cosA * cosR - ry * sinA * sinR),
    y: center.y + (rx * cosA * sinR + ry * sinA * cosR),
  };
}

function ellipseSweepForRender(startRaw, endRaw) {
  const start = normalizeAngle(startRaw);
  const end = normalizeAngle(endRaw);
  if (Math.abs(start - end) <= 1e-6) return Math.PI * 2;
  let sweep = end - start;
  if (sweep <= 0) sweep += Math.PI * 2;
  return sweep;
}

function hitTestUnsupportedProxy(proxy, worldPoint, tolerance) {
  if (!proxy || !Number.isFinite(worldPoint?.x) || !Number.isFinite(worldPoint?.y)) return false;

  if (proxy.kind === 'point' && proxy.point) {
    return distance(worldPoint, proxy.point) <= tolerance * 2.0;
  }

  if (proxy.kind === 'polyline' && Array.isArray(proxy.points) && proxy.points.length >= 2) {
    for (let i = 0; i < proxy.points.length - 1; i += 1) {
      if (pointOnSegmentDistance(worldPoint, proxy.points[i], proxy.points[i + 1]) <= tolerance) {
        return true;
      }
    }
    return false;
  }

  if (proxy.kind === 'ellipse' && proxy.center) {
    const center = proxy.center;
    const rx = Math.max(0.001, Number(proxy.rx || 0));
    const ry = Math.max(0.001, Number(proxy.ry || 0));
    const rotation = Number.isFinite(proxy.rotation) ? proxy.rotation : 0;
    const start = Number.isFinite(proxy.startAngle) ? proxy.startAngle : 0;
    const end = Number.isFinite(proxy.endAngle) ? proxy.endAngle : (Math.PI * 2);
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return false;

    const sweep = ellipseSweepForRender(start, end);
    const segments = Math.max(24, Math.min(144, Math.ceil((sweep / (Math.PI * 2)) * 120)));
    let prev = ellipsePoint(center, rx, ry, rotation, start);
    for (let i = 1; i <= segments; i += 1) {
      const t = i / segments;
      const angle = start + sweep * t;
      const next = ellipsePoint(center, rx, ry, rotation, angle);
      if (pointOnSegmentDistance(worldPoint, prev, next) <= tolerance) {
        return true;
      }
      prev = next;
    }
    return false;
  }

  return false;
}

export function hitTestEntity(entity, worldPoint, toleranceWorld, arcContains = null) {
  if (!entity || entity.visible === false) return false;
  const tolerance = Math.max(toleranceWorld, 0.001);

  if (entity.type === 'line') {
    return pointOnSegmentDistance(worldPoint, entity.start, entity.end) <= tolerance;
  }

  if (entity.type === 'polyline') {
    const segments = extractLineSegments(entity);
    return segments.some((segment) => pointOnSegmentDistance(worldPoint, segment.start, segment.end) <= tolerance);
  }

  if (entity.type === 'circle') {
    const radius = Math.max(0, Number(entity.radius || 0));
    const d = distance(worldPoint, entity.center);
    return Math.abs(d - radius) <= tolerance;
  }

  if (entity.type === 'arc') {
    const radius = Math.max(0, Number(entity.radius || 0));
    const d = distance(worldPoint, entity.center);
    if (Math.abs(d - radius) > tolerance) return false;
    if (arcContains) return arcContains(entity, angleFrom(entity.center, worldPoint));
    const angle = normalizeAngle(angleFrom(entity.center, worldPoint));
    const start = normalizeAngle(entity.startAngle || 0);
    const end = normalizeAngle(entity.endAngle || 0);
    const clockwise = entity.cw === true;
    // With our y-down coordinate system, increasing angle is clockwise.
    const sweepStart = clockwise ? start : end;
    const sweepEnd = clockwise ? end : start;
    if (sweepStart <= sweepEnd) {
      return angle >= sweepStart - EPSILON && angle <= sweepEnd + EPSILON;
    }
    return angle >= sweepStart - EPSILON || angle <= sweepEnd + EPSILON;
  }

  if (entity.type === 'text') {
    const pos = entity.position || { x: 0, y: 0 };
    return distance(worldPoint, pos) <= tolerance * 2.2;
  }

  if (entity.type === 'unsupported') {
    return hitTestUnsupportedProxy(entity.display_proxy, worldPoint, tolerance);
  }

  return false;
}

export function resolveOrtho(reference, point) {
  if (!reference) return point;
  const dx = Math.abs(point.x - reference.x);
  const dy = Math.abs(point.y - reference.y);
  if (dx >= dy) {
    return { x: point.x, y: reference.y };
  }
  return { x: reference.x, y: point.y };
}

export function collectSnapCandidates(entities, options = {}) {
  const points = [];
  const segments = [];
  const visible = Array.isArray(entities) ? entities : [];
  const quadrants = [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2];
  const kMaxIntersectionSegments = 2000;

  const queryPoint = options?.queryPoint;
  const hasQueryPoint = !!queryPoint && Number.isFinite(queryPoint.x) && Number.isFinite(queryPoint.y);
  const queryRadiusWorld = hasQueryPoint && Number.isFinite(options?.queryRadiusWorld)
    ? Number(options.queryRadiusWorld)
    : null;
  const useQuery = hasQueryPoint && queryRadiusWorld !== null;
  const queryLimitSq = useQuery ? (queryRadiusWorld * 1.25) ** 2 : null;
  const kMaxPolylineSnapSamples = 4096;

  function addPoint(point, kind) {
    if (!point) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    points.push({ x: point.x, y: point.y, kind });
  }

  function pointOnSegmentDistanceSqLocal(point, start, end) {
    const seg = subtract(end, start);
    const lenSq = dot(seg, seg);
    if (lenSq <= EPSILON) {
      return distanceSq(point, start);
    }
    const t = Math.max(0, Math.min(1, dot(subtract(point, start), seg) / lenSq));
    const projected = {
      x: start.x + seg.x * t,
      y: start.y + seg.y * t,
    };
    return distanceSq(point, projected);
  }

  function withinQuery(point) {
    if (!useQuery) return true;
    return distanceSq(queryPoint, point) <= queryLimitSq;
  }

  function nearestPolylineVertex(pointsArray) {
    if (!useQuery) return null;
    const n = Array.isArray(pointsArray) ? pointsArray.length : 0;
    if (n <= 0) return null;
    const stride = n <= kMaxPolylineSnapSamples ? 1 : Math.ceil(n / kMaxPolylineSnapSamples);
    let bestIndex = 0;
    let bestDistSq = Infinity;
    for (let i = 0; i < n; i += stride) {
      const p = pointsArray[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const dSq = distanceSq(queryPoint, p);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIndex = i;
      }
    }
    const refineStart = Math.max(0, bestIndex - stride * 2);
    const refineEnd = Math.min(n - 1, bestIndex + stride * 2);
    for (let i = refineStart; i <= refineEnd; i += 1) {
      const p = pointsArray[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const dSq = distanceSq(queryPoint, p);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIndex = i;
      }
    }
    return { index: bestIndex, point: pointsArray[bestIndex], distSq: bestDistSq };
  }

  function nearestPolylineSegment(pointsArray, closed) {
    if (!useQuery) return null;
    const n = Array.isArray(pointsArray) ? pointsArray.length : 0;
    if (n < 2) return null;
    const segCount = (n - 1) + (closed ? 1 : 0);
    const stride = segCount <= kMaxPolylineSnapSamples ? 1 : Math.ceil(segCount / kMaxPolylineSnapSamples);

    function segmentAt(segIndex) {
      if (segIndex < n - 1) {
        return { index: segIndex, start: pointsArray[segIndex], end: pointsArray[segIndex + 1] };
      }
      return { index: n - 1, start: pointsArray[n - 1], end: pointsArray[0] };
    }

    let best = segmentAt(0);
    let bestDistSq = pointOnSegmentDistanceSqLocal(queryPoint, best.start, best.end);

    for (let s = 0; s < segCount; s += stride) {
      const seg = segmentAt(s);
      if (!seg.start || !seg.end) continue;
      const dSq = pointOnSegmentDistanceSqLocal(queryPoint, seg.start, seg.end);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = seg;
      }
    }

    const refineStart = Math.max(0, best.index - stride * 2);
    const refineEnd = Math.min(segCount - 1, best.index + stride * 2);
    for (let s = refineStart; s <= refineEnd; s += 1) {
      const seg = segmentAt(s);
      if (!seg.start || !seg.end) continue;
      const dSq = pointOnSegmentDistanceSqLocal(queryPoint, seg.start, seg.end);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = seg;
      }
    }

    return { ...best, distSq: bestDistSq, segCount, pointCount: n };
  }

  function arcMidAngle(entity) {
    if (options.arcMidAngle) return options.arcMidAngle(entity);
    const start = normalizeAngle(Number.isFinite(entity?.startAngle) ? entity.startAngle : 0);
    const end = normalizeAngle(Number.isFinite(entity?.endAngle) ? entity.endAngle : 0);
    if (entity?.cw === true) {
      let delta = end - start;
      if (delta < 0) delta += Math.PI * 2;
      return normalizeAngle(start + delta * 0.5);
    }
    let delta = start - end;
    if (delta < 0) delta += Math.PI * 2;
    return normalizeAngle(start - delta * 0.5);
  }

  function arcContainsAngle(entity, angleRad) {
    if (options.arcContainsAngle) return options.arcContainsAngle(entity, angleRad);
    const start = normalizeAngle(Number.isFinite(entity?.startAngle) ? entity.startAngle : 0);
    const end = normalizeAngle(Number.isFinite(entity?.endAngle) ? entity.endAngle : 0);
    const angle = normalizeAngle(angleRad);
    const clockwise = entity?.cw === true;
    // With our y-down coordinate system, increasing angle is clockwise.
    const sweepStart = clockwise ? start : end;
    const sweepEnd = clockwise ? end : start;
    if (sweepStart <= sweepEnd) {
      return angle >= sweepStart - EPSILON && angle <= sweepEnd + EPSILON;
    }
    return angle >= sweepStart - EPSILON || angle <= sweepEnd + EPSILON;
  }

  for (const entity of visible) {
    if (!entity || entity.visible === false) continue;
    if (entity.type === 'line') {
      if (options.intersection && segments.length <= kMaxIntersectionSegments) {
        segments.push({ start: entity.start, end: entity.end, entityId: entity.id });
      }
      if (options.endpoint) {
        addPoint(entity.start, 'END');
        addPoint(entity.end, 'END');
      }
      if (options.midpoint) {
        const mid = midpoint(entity.start, entity.end);
        addPoint(mid, 'MID');
      }
      continue;
    }

    if (entity.type === 'polyline') {
      const pointsArray = Array.isArray(entity.points) ? entity.points : [];
      if (pointsArray.length < 2) continue;

      if (useQuery) {
        if (options.endpoint) {
          const nearestVertex = nearestPolylineVertex(pointsArray);
          if (nearestVertex && nearestVertex.point && withinQuery(nearestVertex.point)) {
            addPoint(nearestVertex.point, 'END');
          }
        }

        const needSeg = options.midpoint || options.intersection;
        if (needSeg) {
          const nearestSeg = nearestPolylineSegment(pointsArray, entity.closed === true);
          if (nearestSeg && nearestSeg.start && nearestSeg.end) {
            if (options.midpoint && withinQuery(midpoint(nearestSeg.start, nearestSeg.end))) {
              addPoint(midpoint(nearestSeg.start, nearestSeg.end), 'MID');
            }
            if (options.intersection && segments.length <= kMaxIntersectionSegments) {
              const indices = new Set([nearestSeg.index]);
              const isClosed = entity.closed === true;
              const lastSegIndex = isClosed ? pointsArray.length - 1 : pointsArray.length - 2;
              const prev = nearestSeg.index - 1;
              const next = nearestSeg.index + 1;
              if (prev >= 0) {
                indices.add(prev);
              } else if (isClosed) {
                indices.add(lastSegIndex);
              }
              if (next <= lastSegIndex) {
                indices.add(next);
              } else if (isClosed) {
                indices.add(0);
              }

              for (const idx of indices) {
                if (segments.length > kMaxIntersectionSegments) break;
                const start = pointsArray[idx];
                const end = (isClosed && idx === pointsArray.length - 1) ? pointsArray[0] : pointsArray[idx + 1];
                if (!start || !end) continue;
                segments.push({ start, end, entityId: entity.id });
              }
            }
          }
        }
      } else {
        if (options.endpoint) {
          for (const point of pointsArray) {
            addPoint(point, 'END');
          }
        }

        const needSeg = options.midpoint || options.intersection;
        if (needSeg) {
          for (let i = 0; i < pointsArray.length - 1; i += 1) {
            const start = pointsArray[i];
            const end = pointsArray[i + 1];
            if (options.intersection && segments.length <= kMaxIntersectionSegments) {
              segments.push({ start, end, entityId: entity.id });
            }
            if (options.midpoint) {
              addPoint(midpoint(start, end), 'MID');
            }
          }
          if (entity.closed) {
            const start = pointsArray[pointsArray.length - 1];
            const end = pointsArray[0];
            if (options.intersection && segments.length <= kMaxIntersectionSegments) {
              segments.push({ start, end, entityId: entity.id });
            }
            if (options.midpoint) {
              addPoint(midpoint(start, end), 'MID');
            }
          }
        }
      }
      continue;
    }

    if (entity.type === 'circle') {
      const center = entity.center;
      const radius = Math.max(0.001, Number(entity.radius || 0));
      if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) continue;
      if (options.center) {
        addPoint(center, 'CEN');
      }
      if (options.quadrant) {
        for (const angle of quadrants) {
          addPoint(
            { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) },
            'QUA',
          );
        }
      }
      continue;
    }

    if (entity.type === 'arc') {
      const center = entity.center;
      const radius = Math.max(0.001, Number(entity.radius || 0));
      const startAngle = Number.isFinite(entity.startAngle) ? entity.startAngle : 0;
      const endAngle = Number.isFinite(entity.endAngle) ? entity.endAngle : 0;
      if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) continue;

      if (options.center) {
        addPoint(center, 'CEN');
      }

      if (options.endpoint) {
        addPoint(
          { x: center.x + radius * Math.cos(startAngle), y: center.y + radius * Math.sin(startAngle) },
          'END',
        );
        addPoint(
          { x: center.x + radius * Math.cos(endAngle), y: center.y + radius * Math.sin(endAngle) },
          'END',
        );
      }

      if (options.midpoint) {
        const midAngle = arcMidAngle(entity);
        addPoint(
          { x: center.x + radius * Math.cos(midAngle), y: center.y + radius * Math.sin(midAngle) },
          'MID',
        );
      }

      if (options.quadrant) {
        for (const angle of quadrants) {
          if (!arcContainsAngle(entity, angle)) continue;
          addPoint(
            { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) },
            'QUA',
          );
        }
      }
      continue;
    }
  }

  if (options.intersection && segments.length > 1 && segments.length <= kMaxIntersectionSegments) {
    for (let i = 0; i < segments.length; i += 1) {
      for (let j = i + 1; j < segments.length; j += 1) {
        if (segments[i].entityId === segments[j].entityId) continue;
        const hit = lineLineIntersection(
          segments[i].start,
          segments[i].end,
          segments[j].start,
          segments[j].end,
          true,
          true,
        );
        if (hit) {
          points.push({ x: hit.x, y: hit.y, kind: 'INT' });
        }
      }
    }
  }

  return points;
}

export function findNearestPoint(source, points, maxDistanceWorld) {
  const limit = Number.isFinite(maxDistanceWorld) ? maxDistanceWorld : Infinity;
  const tieThreshold = Number.isFinite(limit) ? Math.max(0.000001, limit * 0.12) : 0;
  const tieThresholdSq = tieThreshold * tieThreshold;

  function rank(kind) {
    const k = String(kind || '').toUpperCase();
    if (k === 'END') return 0;
    if (k === 'INT') return 1;
    if (k === 'MID') return 2;
    if (k === 'TAN') return 3;
    if (k === 'QUA') return 4;
    if (k === 'CEN') return 5;
    if (k === 'NEA') return 6;
    if (k === 'GRID') return 7;
    return 99;
  }

  let best = null;
  let bestDistSq = limit * limit;
  let bestRank = 99;
  for (const point of points || []) {
    const dSq = distanceSq(source, point);
    if (dSq > limit * limit) continue;
    if (!best) {
      best = point;
      bestDistSq = dSq;
      bestRank = rank(point.kind);
      continue;
    }

    // Prefer nearer candidates; when within a small distance band, prefer higher-priority snap kinds.
    if (dSq + tieThresholdSq < bestDistSq) {
      best = point;
      bestDistSq = dSq;
      bestRank = rank(point.kind);
      continue;
    }

    const diffSq = Math.abs(dSq - bestDistSq);
    if (diffSq <= tieThresholdSq) {
      const r = rank(point.kind);
      if (r < bestRank) {
        best = point;
        bestDistSq = dSq;
        bestRank = r;
      } else if (r === bestRank && dSq < bestDistSq) {
        best = point;
        bestDistSq = dSq;
      }
      continue;
    }

    if (dSq < bestDistSq) {
      best = point;
      bestDistSq = dSq;
      bestRank = rank(point.kind);
    }
  }
  return best;
}

export function scale(v, s) {
  return { x: v.x * s, y: v.y * s };
}

export function perpendicular(v) {
  return { x: -v.y, y: v.x };
}

export function normalizeVector(v) {
  const len = length(v);
  if (!Number.isFinite(len) || len <= EPSILON) return null;
  return { x: v.x / len, y: v.y / len };
}

function isFinitePoint(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function closestPointOnSegment(point, start, end) {
  const seg = subtract(end, start);
  const lenSq = dot(seg, seg);
  if (!Number.isFinite(lenSq) || lenSq <= EPSILON) return { point: { ...start }, t: 0 };
  const t = Math.max(0, Math.min(1, dot(subtract(point, start), seg) / lenSq));
  return {
    point: { x: start.x + seg.x * t, y: start.y + seg.y * t },
    t,
  };
}

function segmentsSelfIntersect(points, closed) {
  const count = Array.isArray(points) ? points.length : 0;
  if (count < 4) return false;

  const segCount = closed ? count : count - 1;
  if (segCount < 3) return false;

  // Keep worst-case bounded in interactive use.
  if (segCount > 200) return false;

  const seg = (index) => {
    const a = points[index];
    const b = points[(index + 1) % count];
    return { a, b };
  };

  const adjacent = (i, j) => {
    if (i === j) return true;
    if (!closed) {
      return Math.abs(i - j) <= 1;
    }
    const d = Math.abs(i - j);
    return d <= 1 || d >= segCount - 1;
  };

  const aabbOverlap = (a0, a1, b0, b1) => {
    const aMinX = Math.min(a0.x, a1.x);
    const aMaxX = Math.max(a0.x, a1.x);
    const aMinY = Math.min(a0.y, a1.y);
    const aMaxY = Math.max(a0.y, a1.y);
    const bMinX = Math.min(b0.x, b1.x);
    const bMaxX = Math.max(b0.x, b1.x);
    const bMinY = Math.min(b0.y, b1.y);
    const bMaxY = Math.max(b0.y, b1.y);
    return !(aMaxX < bMinX || bMaxX < aMinX || aMaxY < bMinY || bMaxY < aMinY);
  };

  for (let i = 0; i < segCount; i += 1) {
    const { a: a0, b: a1 } = seg(i);
    if (!isFinitePoint(a0) || !isFinitePoint(a1)) continue;
    for (let j = i + 1; j < segCount; j += 1) {
      if (adjacent(i, j)) continue;
      const { a: b0, b: b1 } = seg(j);
      if (!isFinitePoint(b0) || !isFinitePoint(b1)) continue;
      if (!aabbOverlap(a0, a1, b0, b1)) continue;
      const inter = lineLineIntersection(a0, a1, b0, b1, true, true);
      if (inter) return true;
    }
  }
  return false;
}

function setDiag(diag, code, message = '') {
  if (!diag || typeof diag !== 'object') return;
  diag.error_code = code;
  if (message) diag.message = message;
}

// Compute an offset clone of a supported entity type using a side point.
// Returns null when unsupported or when inputs are invalid.
export function computeOffsetEntity(entity, sidePoint, offsetDistance, diag = null) {
  if (!entity || entity.visible === false) {
    setDiag(diag, 'INVALID_INPUT', 'missing entity');
    return null;
  }
  if (!sidePoint || !Number.isFinite(sidePoint.x) || !Number.isFinite(sidePoint.y)) {
    setDiag(diag, 'INVALID_INPUT', 'missing side point');
    return null;
  }
  const d = Math.abs(Number(offsetDistance || 0));
  if (!Number.isFinite(d) || d <= EPSILON) {
    setDiag(diag, 'INVALID_INPUT', 'invalid offset distance');
    return null;
  }

  if (entity.type === 'polyline' && Array.isArray(entity.points)) {
    const raw = entity.points;
    const closed = entity.closed === true;
    const cleaned = [];
    const tolSq = EPSILON * EPSILON;
    for (const point of raw) {
      if (!isFinitePoint(point)) continue;
      if (cleaned.length === 0) {
        cleaned.push({ ...point });
        continue;
      }
      if (distanceSq(point, cleaned[cleaned.length - 1]) <= tolSq) continue;
      cleaned.push({ ...point });
    }
    if (closed && cleaned.length >= 3 && distanceSq(cleaned[0], cleaned[cleaned.length - 1]) <= tolSq) {
      cleaned.pop();
    }
    if (cleaned.length < 2 || (closed && cleaned.length < 3)) {
      setDiag(diag, 'INVALID_GEOMETRY', 'polyline too short');
      return null;
    }

    if (segmentsSelfIntersect(cleaned, closed)) {
      setDiag(diag, 'SELF_INTERSECT', 'input polyline self-intersects');
      return null;
    }

    const pointCount = cleaned.length;
    const segCount = closed ? pointCount : pointCount - 1;

    // Pick the closest segment to determine the side sign consistently for the whole polyline.
    let best = null; // { distSq, normal, closest }
    for (let i = 0; i < segCount; i += 1) {
      const a = cleaned[i];
      const b = cleaned[(i + 1) % pointCount];
      const dir = subtract(b, a);
      const unit = normalizeVector(dir);
      if (!unit) continue;
      const normal = perpendicular(unit);
      const cp = closestPointOnSegment(sidePoint, a, b).point;
      const dist = distanceSq(sidePoint, cp);
      if (!best || dist < best.distSq) {
        best = { distSq: dist, normal, closest: cp };
      }
    }
    if (!best) {
      setDiag(diag, 'INVALID_GEOMETRY', 'no valid polyline segments');
      return null;
    }
    const sign = dot(subtract(sidePoint, best.closest), best.normal) >= 0 ? 1 : -1;

    const offsetSegments = [];
    for (let i = 0; i < segCount; i += 1) {
      const a = cleaned[i];
      const b = cleaned[(i + 1) % pointCount];
      const dir = subtract(b, a);
      const unit = normalizeVector(dir);
      if (!unit) {
        setDiag(diag, 'INVALID_GEOMETRY', 'degenerate polyline segment');
        return null;
      }
      const normal = perpendicular(unit);
      const delta = scale(normal, d * sign);
      offsetSegments.push({
        start: add(a, delta),
        end: add(b, delta),
      });
    }

    const miterLimit = Math.max(d * 20, 0.01);
    const miterLimitSq = miterLimit * miterLimit;
    const joinPoint = (prev, curr) => {
      const inter = lineLineIntersection(prev.start, prev.end, curr.start, curr.end, false, false);
      if (!inter || !Number.isFinite(inter.x) || !Number.isFinite(inter.y)) {
        return { ...curr.start };
      }
      const p = { x: inter.x, y: inter.y };
      // Clamp extreme miters (near-parallel segments) to a bevel join.
      if (distanceSq(p, curr.start) > miterLimitSq && distanceSq(p, prev.end) > miterLimitSq) {
        return { ...curr.start };
      }
      return p;
    };

    const outPoints = [];
    if (closed) {
      for (let i = 0; i < segCount; i += 1) {
        const prev = offsetSegments[(i - 1 + segCount) % segCount];
        const curr = offsetSegments[i];
        outPoints.push(joinPoint(prev, curr));
      }
    } else {
      outPoints.push({ ...offsetSegments[0].start });
      for (let i = 1; i < segCount; i += 1) {
        const prev = offsetSegments[i - 1];
        const curr = offsetSegments[i];
        outPoints.push(joinPoint(prev, curr));
      }
      outPoints.push({ ...offsetSegments[segCount - 1].end });
    }

    if (outPoints.some((p) => !isFinitePoint(p))) return null;
    if (segmentsSelfIntersect(outPoints, closed)) {
      setDiag(diag, 'SELF_INTERSECT', 'offset polyline self-intersects');
      return null;
    }
    const next = cloneValue(entity);
    next.points = outPoints;
    next.closed = closed;
    return next;
  }

  if (entity.type === 'line') {
    const start = entity.start;
    const end = entity.end;
    if (!start || !end) return null;
    if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
    const dir = subtract(end, start);
    const unit = normalizeVector(dir);
    if (!unit) {
      setDiag(diag, 'INVALID_GEOMETRY', 'degenerate line');
      return null;
    }
    const normal = perpendicular(unit);
    const v = subtract(sidePoint, start);
    const sign = dot(v, normal) >= 0 ? 1 : -1;
    const delta = scale(normal, d * sign);
    const next = cloneValue(entity);
    next.start = add(start, delta);
    next.end = add(end, delta);
    return next;
  }

  if (entity.type === 'circle' || entity.type === 'arc') {
    const center = entity.center;
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;
    const radius = Math.max(0.001, Number(entity.radius || 0));
    const distToSide = distance(center, sidePoint);
    const outward = distToSide >= radius - 1e-6;
    const next = cloneValue(entity);
    next.radius = outward ? radius + d : Math.max(0.001, radius - d);
    return next;
  }

  setDiag(diag, 'UNSUPPORTED', `unsupported type=${String(entity.type || '')}`);
  return null;
}
