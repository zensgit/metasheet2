function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function aabbFromPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!p) continue;
    const x = asNumber(p.x, NaN);
    const y = asNumber(p.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

export function computeEntityAabb(entity) {
  if (!entity || entity.visible === false) return null;
  if (entity.type === 'line') {
    return aabbFromPoints([entity.start, entity.end]);
  }
  if (entity.type === 'polyline') {
    return aabbFromPoints(entity.points);
  }
  if (entity.type === 'circle' || entity.type === 'arc') {
    const center = entity.center;
    const r = Math.max(0.001, asNumber(entity.radius, 0));
    const cx = asNumber(center?.x, NaN);
    const cy = asNumber(center?.y, NaN);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
  }
  if (entity.type === 'text') {
    const pos = entity.position;
    const h = Math.max(0.1, asNumber(entity.height, 2.5));
    const x = asNumber(pos?.x, NaN);
    const y = asNumber(pos?.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const len = typeof entity.value === 'string' ? clamp(entity.value.length, 1, 80) : 6;
    const halfW = (len * h * 0.35);
    const halfH = h * 0.6;
    return { minX: x - halfW, minY: y - halfH, maxX: x + halfW, maxY: y + halfH };
  }
  if (entity.type === 'unsupported' && entity.display_proxy) {
    const proxy = entity.display_proxy;
    if (proxy.kind === 'point') {
      return aabbFromPoints([proxy.point]);
    }
    if (proxy.kind === 'polyline') {
      return aabbFromPoints(proxy.points);
    }
    if (proxy.kind === 'ellipse') {
      const cx = asNumber(proxy.center?.x, NaN);
      const cy = asNumber(proxy.center?.y, NaN);
      const rx = Math.max(0.001, asNumber(proxy.rx, 0));
      const ry = Math.max(0.001, asNumber(proxy.ry, 0));
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
      // Conservative bounds regardless of rotation for robust spatial query coverage.
      const r = Math.max(rx, ry);
      return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
    }
  }
  return null;
}

export class SpatialIndex {
  constructor({ cellSize = 50 } = {}) {
    this.cellSize = Math.max(1, asNumber(cellSize, 50));
    this.cells = new Map(); // ix -> Map(iy -> Set(entityId))
    this.aabbById = new Map();
    this.keysById = new Map();
    this.querySeen = new Map();
    this.queryVersion = 0;
  }

  clear() {
    this.cells.clear();
    this.aabbById.clear();
    this.keysById.clear();
    this.querySeen.clear();
    this.queryVersion = 0;
  }

  rebuild(entities) {
    this.clear();
    const list = Array.isArray(entities) ? entities : [];
    for (const entity of list) {
      if (!entity || !Number.isFinite(entity.id)) continue;
      this.upsert(entity);
    }
  }

  remove(id) {
    if (!Number.isFinite(id)) return;
    this.aabbById.delete(id);
    this.querySeen.delete(id);
    const keys = this.keysById.get(id);
    if (keys) {
      for (const [ix, iy] of keys) {
        const col = this.cells.get(ix);
        if (!col) continue;
        const bucket = col.get(iy);
        if (!bucket) continue;
        bucket.delete(id);
        if (bucket.size === 0) {
          col.delete(iy);
          if (col.size === 0) {
            this.cells.delete(ix);
          }
        }
      }
    }
    this.keysById.delete(id);
  }

  upsert(entity) {
    if (!entity || !Number.isFinite(entity.id)) return;
    const id = entity.id;
    this.remove(id);
    const aabb = computeEntityAabb(entity);
    if (!aabb) return;
    this.aabbById.set(id, aabb);

    const minIx = Math.floor(aabb.minX / this.cellSize);
    const maxIx = Math.floor(aabb.maxX / this.cellSize);
    const minIy = Math.floor(aabb.minY / this.cellSize);
    const maxIy = Math.floor(aabb.maxY / this.cellSize);

    const keys = [];
    for (let ix = minIx; ix <= maxIx; ix += 1) {
      let col = this.cells.get(ix);
      if (!col) {
        col = new Map();
        this.cells.set(ix, col);
      }
      for (let iy = minIy; iy <= maxIy; iy += 1) {
        let bucket = col.get(iy);
        if (!bucket) {
          bucket = new Set();
          col.set(iy, bucket);
        }
        bucket.add(id);
        keys.push([ix, iy]);
      }
    }
    this.keysById.set(id, keys);
  }

  queryAabb(aabb) {
    if (!aabb) return [];
    const minIx = Math.floor(aabb.minX / this.cellSize);
    const maxIx = Math.floor(aabb.maxX / this.cellSize);
    const minIy = Math.floor(aabb.minY / this.cellSize);
    const maxIy = Math.floor(aabb.maxY / this.cellSize);
    let version = this.queryVersion + 1;
    if (version >= 2147483647) {
      // Reset dedupe generations occasionally to keep integers bounded.
      this.querySeen.clear();
      version = 1;
    }
    this.queryVersion = version;
    const out = [];

    for (let ix = minIx; ix <= maxIx; ix += 1) {
      const col = this.cells.get(ix);
      if (!col) continue;
      for (let iy = minIy; iy <= maxIy; iy += 1) {
        const bucket = col.get(iy);
        if (!bucket) continue;
        for (const id of bucket) {
          if (this.querySeen.get(id) === version) continue;
          this.querySeen.set(id, version);
          out.push(id);
        }
      }
    }

    return out;
  }
}
