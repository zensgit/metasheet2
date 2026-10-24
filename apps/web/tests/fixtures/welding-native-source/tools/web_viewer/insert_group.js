import { matchesSpaceLayout } from './space_layout.js';

export function normalizeSourceType(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizeLabel(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isFinitePoint(point) {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function toPoint(point) {
  return isFinitePoint(point)
    ? { x: Number(point.x), y: Number(point.y) }
    : null;
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
  };
}

function subtract(a, b) {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
  };
}

function distanceSq(a, b) {
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}

function pointsNearlyEqual(a, b, epsilon = 1e-6) {
  return isFinitePoint(a) && isFinitePoint(b)
    && Math.abs(Number(a.x) - Number(b.x)) <= epsilon
    && Math.abs(Number(a.y) - Number(b.y)) <= epsilon;
}

function formatAnchorDriverLabel(driverType, driverKind) {
  const type = normalizeType(driverType);
  const kind = normalizeLabel(driverKind);
  if (!type) return kind;
  if (!kind) return type;
  return `${type} ${kind}`;
}

function idsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function isReadOnlyInsertMember(entity) {
  return !!entity && (entity.readOnly === true || entity.type === 'unsupported' || entity.editMode === 'proxy');
}

export function isSourceGroupEntity(entity) {
  return Number.isFinite(entity?.groupId) && normalizeSourceType(entity?.sourceType) !== '';
}

export function isDirectEditableSourceTextEntity(entity) {
  const sourceType = normalizeSourceType(entity?.sourceType);
  return normalizeType(entity?.type) === 'text'
    && normalizeLabel(entity?.editMode) === 'proxy'
    && (sourceType === 'DIMENSION' || sourceType === 'LEADER' || sourceType === 'TABLE');
}

export function isInsertTextProxyEntity(entity) {
  return normalizeType(entity?.type) === 'text'
    && normalizeLabel(entity?.editMode) === 'proxy'
    && normalizeSourceType(entity?.sourceType) === 'INSERT'
    && normalizeType(entity?.proxyKind) === 'text';
}

export function isDirectEditableInsertTextProxyEntity(entity) {
  return isInsertTextProxyEntity(entity)
    && entity?.attributeConstant !== true;
}

export function resolveReleasedInsertArchive(entity) {
  const archive = entity?.releasedInsertArchive ?? entity?.released_insert_archive;
  return archive && typeof archive === 'object' ? archive : null;
}

export function isInsertGroupEntity(entity) {
  return isSourceGroupEntity(entity) && normalizeSourceType(entity?.sourceType) === 'INSERT';
}

function isSameInsertPeerIdentity(entity, target) {
  if (!entity || !target || !isInsertGroupEntity(entity) || !isInsertGroupEntity(target)) return false;
  if (Math.trunc(Number(entity.groupId)) !== Math.trunc(Number(target.groupId))) return false;
  const targetBlockName = normalizeLabel(target.blockName);
  if (!targetBlockName) return true;
  return normalizeLabel(entity.blockName) === targetBlockName;
}

export function listSourceGroupMembers(entities, target) {
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  const groupId = Number.isFinite(target?.groupId) ? Math.trunc(Number(target.groupId)) : null;
  const sourceBundleId = Number.isFinite(target?.sourceBundleId) ? Math.trunc(Number(target.sourceBundleId)) : null;
  const sourceType = normalizeSourceType(target?.sourceType);
  if (groupId === null || !sourceType) {
    return [];
  }
  const bundled = sourceBundleId !== null && sourceType !== 'INSERT'
    ? list
      .filter((entity) => (
        entity
        && Number.isFinite(entity.sourceBundleId)
        && Math.trunc(Number(entity.sourceBundleId)) === sourceBundleId
        && normalizeSourceType(entity.sourceType) === sourceType
        && matchesSpaceLayout(entity, target)
      ))
      .sort((a, b) => a.id - b.id)
    : [];
  if (bundled.length > 0) {
    return bundled;
  }
  return list
    .filter((entity) => (
      entity
      && Number.isFinite(entity.groupId)
      && Math.trunc(Number(entity.groupId)) === groupId
      && normalizeSourceType(entity.sourceType) === sourceType
      && matchesSpaceLayout(entity, target)
    ))
    .sort((a, b) => a.id - b.id);
}

export function listSourceGroupTextMembers(entities, target) {
  return listSourceGroupMembers(entities, target)
    .filter((entity) => normalizeType(entity?.type) === 'text');
}

export function listInsertGroupMembers(entities, target) {
  if (!isInsertGroupEntity(target)) {
    return [];
  }
  return listSourceGroupMembers(entities, target);
}

export function listInsertGroupTextMembers(entities, target) {
  if (!isInsertGroupEntity(target)) {
    return [];
  }
  return listSourceGroupTextMembers(entities, target);
}

export function listEditableInsertTextMembers(entities, target) {
  return listInsertGroupTextMembers(entities, target)
    .filter((entity) => isDirectEditableInsertTextProxyEntity(entity));
}

export function summarizeSourceGroupMembers(entities, target, { isReadOnly = isReadOnlyInsertMember } = {}) {
  const members = listSourceGroupMembers(entities, target);
  if (members.length === 0) {
    return null;
  }
  const editable = [];
  const readOnly = [];
  for (const entity of members) {
    if (isReadOnly(entity)) {
      readOnly.push(entity);
    } else {
      editable.push(entity);
    }
  }
  return {
    groupId: Math.trunc(Number(target.groupId)),
    sourceType: normalizeSourceType(target?.sourceType),
    proxyKind: normalizeLabel(target?.proxyKind),
    blockName: typeof target?.blockName === 'string' ? target.blockName.trim() : '',
    members,
    memberIds: members.map((entity) => entity.id),
    editableMembers: editable,
    editableIds: editable.map((entity) => entity.id),
    readOnlyMembers: readOnly,
    readOnlyIds: readOnly.map((entity) => entity.id),
  };
}

export function summarizeInsertGroupMembers(entities, target, { isReadOnly = isReadOnlyInsertMember } = {}) {
  if (!isInsertGroupEntity(target)) {
    return null;
  }
  return summarizeSourceGroupMembers(entities, target, { isReadOnly });
}

export function summarizeReleasedInsertGroupMembers(entities, target, { isReadOnly = isReadOnlyInsertMember } = {}) {
  const archive = resolveReleasedInsertArchive(target);
  if (!archive || normalizeSourceType(archive?.sourceType) !== 'INSERT') {
    return null;
  }
  const groupId = Number.isFinite(archive?.groupId) ? Math.trunc(Number(archive.groupId)) : null;
  if (groupId === null) {
    return null;
  }
  const blockName = normalizeLabel(archive?.blockName);
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  const members = list
    .filter((entity) => (
      entity
      && isInsertGroupEntity(entity)
      && Number.isFinite(entity.groupId)
      && Math.trunc(Number(entity.groupId)) === groupId
      && matchesSpaceLayout(entity, target)
      && (!blockName || normalizeLabel(entity.blockName) === blockName)
    ))
    .sort((a, b) => a.id - b.id);
  if (members.length === 0) {
    return null;
  }
  const editable = [];
  const readOnly = [];
  for (const entity of members) {
    if (isReadOnly(entity)) {
      readOnly.push(entity);
    } else {
      editable.push(entity);
    }
  }
  return {
    groupId,
    sourceType: 'INSERT',
    proxyKind: normalizeLabel(members[0]?.proxyKind),
    blockName: blockName || normalizeLabel(members[0]?.blockName),
    members,
    memberIds: members.map((entity) => entity.id),
    editableMembers: editable,
    editableIds: editable.map((entity) => entity.id),
    readOnlyMembers: readOnly,
    readOnlyIds: readOnly.map((entity) => entity.id),
  };
}

function isSameReleasedInsertPeerIdentity(entity, archive) {
  if (!entity || !archive || !isInsertGroupEntity(entity)) return false;
  const groupId = Number.isFinite(archive?.groupId) ? Math.trunc(Number(archive.groupId)) : null;
  if (groupId === null) return false;
  if (Math.trunc(Number(entity.groupId)) !== groupId) return false;
  const archiveBlockName = normalizeLabel(archive?.blockName);
  if (!archiveBlockName) return true;
  return normalizeLabel(entity.blockName) === archiveBlockName;
}

export function summarizeReleasedInsertPeerInstances(entities, target, { isReadOnly = isReadOnlyInsertMember } = {}) {
  const archive = resolveReleasedInsertArchive(target);
  if (!archive || normalizeSourceType(archive?.sourceType) !== 'INSERT') return null;
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  const byContext = new Map();
  for (const entity of list) {
    if (!isSameReleasedInsertPeerIdentity(entity, archive)) continue;
    const space = Number.isFinite(entity?.space) ? Math.trunc(Number(entity.space)) : 0;
    const layout = normalizeLabel(entity?.layout) || (space === 0 ? 'Model' : '');
    const key = `${space}::${layout}`;
    if (!byContext.has(key)) {
      byContext.set(key, {
        key,
        space,
        layout,
        members: [],
      });
    }
    byContext.get(key).members.push(entity);
  }
  const peers = [...byContext.values()]
    .map((peer) => {
      const summary = summarizeInsertGroupMembers(peer.members, peer.members[0], { isReadOnly });
      if (!summary) return null;
      return {
        ...summary,
        key: peer.key,
        space: peer.space,
        layout: peer.layout,
        bounds: computeEntitiesBounds(summary.members),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.space !== right.space) return left.space - right.space;
      return String(left.layout || '').localeCompare(String(right.layout || ''));
    });
  if (peers.length === 0) return null;
  const targetSpace = Number.isFinite(target?.space) ? Math.trunc(Number(target.space)) : 0;
  const targetLayout = normalizeLabel(target?.layout) || (targetSpace === 0 ? 'Model' : '');
  const currentKey = `${targetSpace}::${targetLayout}`;
  const currentIndex = peers.findIndex((peer) => peer.key === currentKey);
  return {
    peers,
    peerCount: peers.length,
    currentIndex,
    otherPeerCount: Math.max(0, peers.length - 1),
    groupId: Number.isFinite(archive?.groupId) ? Math.trunc(Number(archive.groupId)) : null,
    blockName: normalizeLabel(archive?.blockName),
  };
}

function includeBounds(bounds, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
}

export function computeEntityBounds(entity) {
  if (!entity) return null;
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };

  if (entity.type === 'line') {
    includeBounds(bounds, entity.start?.x, entity.start?.y);
    includeBounds(bounds, entity.end?.x, entity.end?.y);
  } else if (entity.type === 'polyline' && Array.isArray(entity.points)) {
    for (const point of entity.points) {
      includeBounds(bounds, point?.x, point?.y);
    }
  } else if (entity.type === 'circle' || entity.type === 'arc') {
    const center = entity.center;
    const radius = Math.max(0.001, Number(entity.radius || 0));
    includeBounds(bounds, center?.x - radius, center?.y - radius);
    includeBounds(bounds, center?.x + radius, center?.y + radius);
  } else if (entity.type === 'text') {
    includeBounds(bounds, entity.position?.x, entity.position?.y);
  } else if (entity.type === 'unsupported' && entity.display_proxy) {
    const proxy = entity.display_proxy;
    if (proxy.kind === 'point') {
      includeBounds(bounds, proxy.point?.x, proxy.point?.y);
    } else if (proxy.kind === 'polyline' && Array.isArray(proxy.points)) {
      for (const point of proxy.points) {
        includeBounds(bounds, point?.x, point?.y);
      }
    } else if (proxy.kind === 'ellipse' && proxy.center) {
      const rx = Math.max(0.001, Number(proxy.rx || 0));
      const ry = Math.max(0.001, Number(proxy.ry || 0));
      includeBounds(bounds, proxy.center.x - rx, proxy.center.y - ry);
      includeBounds(bounds, proxy.center.x + rx, proxy.center.y + ry);
    }
  }

  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)) {
    return null;
  }

  return {
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    center: {
      x: (bounds.minX + bounds.maxX) * 0.5,
      y: (bounds.minY + bounds.maxY) * 0.5,
    },
    anchor: {
      x: bounds.minX,
      y: bounds.minY,
    },
  };
}

export function computeEntitiesBounds(entities) {
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const entity of list) {
    const bounds = computeEntityBounds(entity);
    if (!bounds) continue;
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    center: {
      x: (minX + maxX) * 0.5,
      y: (minY + maxY) * 0.5,
    },
    anchor: {
      x: minX,
      y: minY,
    },
  };
}

export function computeSourceGroupBounds(entities, target) {
  const members = listSourceGroupMembers(entities, target);
  if (members.length === 0) return null;
  return computeEntitiesBounds(members);
}

function collectLeaderAnchorCandidates(entity) {
  if (!entity) return [];
  if (normalizeType(entity.type) === 'line' && isFinitePoint(entity.start) && isFinitePoint(entity.end)) {
    return [
      {
        point: toPoint(entity.start),
        elbowPoint: toPoint(entity.end),
        driverId: Number.isFinite(entity.id) ? Math.trunc(Number(entity.id)) : null,
        driverType: normalizeType(entity.type),
        driverKind: 'endpoint',
      },
      {
        point: toPoint(entity.end),
        elbowPoint: toPoint(entity.start),
        driverId: Number.isFinite(entity.id) ? Math.trunc(Number(entity.id)) : null,
        driverType: normalizeType(entity.type),
        driverKind: 'endpoint',
      },
    ];
  }
  if (normalizeType(entity.type) === 'polyline' && Array.isArray(entity.points) && entity.points.length >= 2) {
    const first = toPoint(entity.points[0]);
    const second = toPoint(entity.points[1]);
    const penultimate = toPoint(entity.points[entity.points.length - 2]);
    const last = toPoint(entity.points[entity.points.length - 1]);
    return [
      first
        ? {
            point: first,
            elbowPoint: second,
            driverId: Number.isFinite(entity.id) ? Math.trunc(Number(entity.id)) : null,
            driverType: normalizeType(entity.type),
            driverKind: 'endpoint',
          }
        : null,
      last
        ? {
            point: last,
            elbowPoint: penultimate,
            driverId: Number.isFinite(entity.id) ? Math.trunc(Number(entity.id)) : null,
            driverType: normalizeType(entity.type),
            driverKind: 'endpoint',
          }
        : null,
    ].filter(Boolean);
  }
  return [];
}

function collectDimensionAnchorCandidates(entity) {
  if (!entity) return [];
  if (normalizeType(entity.type) === 'line' && isFinitePoint(entity.start) && isFinitePoint(entity.end)) {
    return [{
      point: midpoint(entity.start, entity.end),
      lengthSq: distanceSq(entity.start, entity.end),
      driverId: Number.isFinite(entity.id) ? Math.trunc(Number(entity.id)) : null,
      driverType: normalizeType(entity.type),
      driverKind: 'midpoint',
    }];
  }
  if (normalizeType(entity.type) === 'polyline' && Array.isArray(entity.points) && entity.points.length >= 2) {
    let best = null;
    for (let index = 0; index < entity.points.length - 1; index += 1) {
      const a = entity.points[index];
      const b = entity.points[index + 1];
      if (!isFinitePoint(a) || !isFinitePoint(b)) continue;
      const lengthSq = distanceSq(a, b);
      if (!best || lengthSq > best.lengthSq) {
        best = {
          point: midpoint(a, b),
          lengthSq,
          driverId: Number.isFinite(entity.id) ? Math.trunc(Number(entity.id)) : null,
          driverType: normalizeType(entity.type),
          driverKind: 'midpoint',
        };
      }
    }
    return best ? [best] : [];
  }
  return [];
}

function collectSourceAnchorCandidates(entity, sourceType) {
  if (sourceType === 'LEADER') return collectLeaderAnchorCandidates(entity);
  if (sourceType === 'DIMENSION') return collectDimensionAnchorCandidates(entity);
  return [];
}

function resolveExplicitSourceTextAnchor(members, targetText) {
  const sourceType = normalizeSourceType(targetText?.sourceType);
  const anchorPoint = toPoint(targetText?.sourceAnchor);
  if (!anchorPoint) return null;
  const landingPoint = toPoint(targetText?.leaderLanding) || (sourceType === 'LEADER' ? { ...anchorPoint } : null);
  const explicitElbowPoint = toPoint(targetText?.leaderElbow);
  const driverIdHint = Number.isFinite(targetText?.sourceAnchorDriverId)
    ? Math.trunc(Number(targetText.sourceAnchorDriverId))
    : null;
  const driverTypeHint = normalizeType(targetText?.sourceAnchorDriverType);
  const driverKindHint = normalizeLabel(targetText?.sourceAnchorDriverKind);
  const nonTextMembers = (Array.isArray(members) ? members : []).filter((entity) => entity?.id !== targetText?.id);
  if (Number.isFinite(driverIdHint)) {
    const explicitDriver = nonTextMembers.find((entity) => Math.trunc(Number(entity?.id)) === driverIdHint);
    if (explicitDriver) {
      let explicitBest = null;
      for (const candidate of collectSourceAnchorCandidates(explicitDriver, sourceType)) {
        if (!candidate?.point || !pointsNearlyEqual(candidate.point, anchorPoint)) continue;
        const typePenalty = driverTypeHint && normalizeType(candidate.driverType) !== driverTypeHint ? 1 : 0;
        const kindPenalty = driverKindHint && normalizeLabel(candidate.driverKind) !== driverKindHint ? 1 : 0;
        const score = typePenalty + kindPenalty;
        if (!explicitBest || score < explicitBest.score) {
          explicitBest = {
            ...candidate,
            score,
          };
        }
      }
      if (explicitBest) {
        return {
          point: { ...anchorPoint },
          landingPoint,
          elbowPoint: explicitElbowPoint || toPoint(explicitBest?.elbowPoint),
          driverId: Math.trunc(Number(explicitDriver.id)),
          driverType: normalizeType(explicitBest?.driverType) || driverTypeHint || normalizeType(explicitDriver.type),
          driverKind: normalizeLabel(explicitBest?.driverKind) || driverKindHint,
        };
      }
    }
  }
  let best = null;
  for (const entity of nonTextMembers) {
    for (const candidate of collectSourceAnchorCandidates(entity, sourceType)) {
      if (!candidate?.point || !pointsNearlyEqual(candidate.point, anchorPoint)) continue;
      const typePenalty = driverTypeHint && normalizeType(candidate.driverType) !== driverTypeHint ? 1 : 0;
      const kindPenalty = driverKindHint && normalizeLabel(candidate.driverKind) !== driverKindHint ? 1 : 0;
      const score = typePenalty + kindPenalty;
      if (!best || score < best.score) {
        best = {
          ...candidate,
          score,
        };
      }
    }
  }
  return {
    point: { ...anchorPoint },
    landingPoint,
    elbowPoint: explicitElbowPoint || toPoint(best?.elbowPoint),
    driverId: Number.isFinite(best?.driverId) ? Math.trunc(Number(best.driverId)) : null,
    driverType: normalizeType(best?.driverType) || driverTypeHint,
    driverKind: normalizeLabel(best?.driverKind) || driverKindHint,
  };
}

function resolveSourceTextGuideEntity(entities, target) {
  if (isDirectEditableSourceTextEntity(target)) {
    return target;
  }
  if (!isSourceGroupEntity(target) || isInsertGroupEntity(target)) {
    return null;
  }
  const textMembers = listSourceGroupTextMembers(entities, target).filter((entity) => isDirectEditableSourceTextEntity(entity));
  if (textMembers.length === 0) return null;
  return textMembers[0];
}

function resolveSourceTextAnchor(members, targetText) {
  const sourceType = normalizeSourceType(targetText?.sourceType);
  const sourcePoint = toPoint(targetText?.sourceTextPos) || toPoint(targetText?.position);
  const explicitGuide = resolveExplicitSourceTextAnchor(members, targetText);
  if (explicitGuide?.point) return explicitGuide;
  const nonTextMembers = (Array.isArray(members) ? members : []).filter((entity) => entity?.id !== targetText?.id);
  if (sourceType === 'LEADER' && sourcePoint) {
    let best = null;
    for (const entity of nonTextMembers) {
      for (const candidate of collectLeaderAnchorCandidates(entity)) {
        if (!candidate?.point) continue;
        const score = distanceSq(candidate.point, sourcePoint);
        if (!best || score < best.score) {
          best = {
            ...candidate,
            score,
          };
        }
      }
    }
    if (best?.point) return best;
  }
  if (sourceType === 'DIMENSION') {
    let best = null;
    for (const entity of nonTextMembers) {
      for (const candidate of collectDimensionAnchorCandidates(entity)) {
        if (!candidate?.point) continue;
        if (!best || candidate.lengthSq > best.lengthSq) {
          best = candidate;
        }
      }
    }
    if (best?.point) return best;
  }
  const bounds = computeEntitiesBounds(members);
  if (bounds?.center) {
    return {
      point: { ...bounds.center },
      driverId: null,
      driverType: '',
      driverKind: 'group-center',
    };
  }
  return sourcePoint
    ? {
        point: sourcePoint,
        driverId: null,
        driverType: '',
        driverKind: 'text-point',
      }
    : null;
}

export function resolveSourceTextGuide(entities, target) {
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  const targetText = resolveSourceTextGuideEntity(list, target);
  if (!targetText) return null;
  const members = listSourceGroupMembers(list, targetText);
  if (members.length === 0) return null;
  const currentPoint = toPoint(targetText.position);
  const sourcePoint = toPoint(targetText.sourceTextPos) || currentPoint;
  const anchorGuide = resolveSourceTextAnchor(members, targetText);
  const anchor = anchorGuide?.point || null;
  const elbowPoint = toPoint(anchorGuide?.elbowPoint);
  if (!currentPoint || !sourcePoint || !anchor) return null;
  const sourceType = normalizeSourceType(targetText.sourceType);
  const landingPoint = sourceType === 'LEADER'
    ? (toPoint(anchorGuide?.landingPoint) || { ...anchor })
    : null;
  return {
    groupId: Number.isFinite(targetText.groupId) ? Math.trunc(Number(targetText.groupId)) : null,
    sourceType,
    proxyKind: normalizeLabel(targetText.proxyKind),
    textId: Number.isFinite(targetText.id) ? Math.trunc(Number(targetText.id)) : null,
    anchor,
    landingPoint,
    elbowPoint: sourceType === 'LEADER' ? elbowPoint : null,
    landingLength: sourceType === 'LEADER' && elbowPoint && landingPoint ? Math.sqrt(distanceSq(landingPoint, elbowPoint)) : null,
    anchorDriverId: Number.isFinite(anchorGuide?.driverId) ? Math.trunc(Number(anchorGuide.driverId)) : null,
    anchorDriverType: normalizeType(anchorGuide?.driverType),
    anchorDriverKind: normalizeLabel(anchorGuide?.driverKind),
    anchorDriverLabel: formatAnchorDriverLabel(anchorGuide?.driverType, anchorGuide?.driverKind),
    sourcePoint,
    currentPoint,
    sourceRotation: Number.isFinite(targetText.sourceTextRotation) ? Number(targetText.sourceTextRotation) : null,
    currentRotation: Number.isFinite(targetText.rotation) ? Number(targetText.rotation) : null,
    sourceOffset: subtract(sourcePoint, anchor),
    currentOffset: subtract(currentPoint, anchor),
  };
}

export function computeSourceTextGuideExtents(guide) {
  if (!guide?.anchor || !guide?.sourcePoint || !guide?.currentPoint) return null;
  const points = [guide.anchor, guide.landingPoint, guide.sourcePoint, guide.currentPoint, guide.elbowPoint].filter(Boolean);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!isFinitePoint(point)) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
  };
}

export function computeInsertGroupBounds(entities, target) {
  if (!isInsertGroupEntity(target)) return null;
  return computeSourceGroupBounds(entities, target);
}

export function summarizeInsertPeerInstances(entities, target, { isReadOnly = isReadOnlyInsertMember } = {}) {
  if (!isInsertGroupEntity(target)) return null;
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  const byContext = new Map();
  for (const entity of list) {
    if (!isSameInsertPeerIdentity(entity, target)) continue;
    const space = Number.isFinite(entity?.space) ? Math.trunc(Number(entity.space)) : 0;
    const layout = normalizeLabel(entity?.layout) || (space === 0 ? 'Model' : '');
    const key = `${space}::${layout}`;
    if (!byContext.has(key)) {
      byContext.set(key, {
        key,
        space,
        layout,
        members: [],
      });
    }
    byContext.get(key).members.push(entity);
  }
  const peers = [...byContext.values()]
    .map((peer) => {
      const summary = summarizeInsertGroupMembers(peer.members, peer.members[0], { isReadOnly });
      if (!summary) return null;
      return {
        ...summary,
        key: peer.key,
        space: peer.space,
        layout: peer.layout,
        bounds: computeEntitiesBounds(summary.members),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.space !== right.space) return left.space - right.space;
      return String(left.layout || '').localeCompare(String(right.layout || ''));
    });

  if (peers.length === 0) return null;
  const targetSpace = Number.isFinite(target?.space) ? Math.trunc(Number(target.space)) : 0;
  const targetLayout = normalizeLabel(target?.layout) || (targetSpace === 0 ? 'Model' : '');
  const currentKey = `${targetSpace}::${targetLayout}`;
  const currentIndex = peers.findIndex((peer) => peer.key === currentKey);
  return {
    peers,
    peerCount: peers.length,
    currentIndex,
    otherPeerCount: Math.max(0, peers.length - 1),
  };
}

export function classifyInsertSelectionScope(target, currentSelectionIds, currentSummary = null) {
  if (!isInsertGroupEntity(target)) return 'custom';
  const selectionIds = Array.isArray(currentSelectionIds)
    ? currentSelectionIds.filter((id) => Number.isFinite(id)).map((id) => Math.trunc(Number(id)))
    : [];
  if (selectionIds.length === 0) return 'custom';
  if (selectionIds.length === 1 && selectionIds[0] === Math.trunc(Number(target.id))) {
    return 'single';
  }
  const summary = currentSummary;
  if (!summary || !Array.isArray(summary.memberIds)) {
    return 'custom';
  }
  if (idsEqual(selectionIds, summary.memberIds)) {
    return 'full';
  }
  if (Array.isArray(summary.editableIds) && summary.editableIds.length > 0 && idsEqual(selectionIds, summary.editableIds)) {
    return 'editable';
  }
  const textIds = listInsertGroupTextMembers(summary.members, target).map((entity) => entity.id);
  if (textIds.length > 0 && idsEqual(selectionIds, textIds)) {
    return 'text';
  }
  const editableTextIds = listEditableInsertTextMembers(summary.members, target).map((entity) => entity.id);
  if (editableTextIds.length > 0 && idsEqual(selectionIds, editableTextIds)) {
    return 'editable-text';
  }
  return 'custom';
}

export function resolveInsertPeerMember(peer, target, currentSummary = null) {
  const members = Array.isArray(peer?.members) ? peer.members.filter(Boolean) : [];
  if (members.length === 0 || !target) {
    return null;
  }

  const targetName = normalizeLabel(target?.name);
  if (targetName) {
    const namedMatch = members.find((entity) => normalizeLabel(entity?.name) === targetName);
    if (namedMatch) {
      return namedMatch;
    }
  }

  const targetType = normalizeType(target?.type);
  const targetProxyKind = normalizeLabel(target?.proxyKind);
  const targetEditMode = normalizeLabel(target?.editMode);
  const shapeMatch = members.find((entity) => (
    normalizeType(entity?.type) === targetType
    && normalizeLabel(entity?.proxyKind) === targetProxyKind
    && normalizeLabel(entity?.editMode) === targetEditMode
  ));
  if (shapeMatch) {
    return shapeMatch;
  }

  const currentIndex = Array.isArray(currentSummary?.members)
    ? currentSummary.members.findIndex((entity) => entity?.id === target?.id)
    : -1;
  if (currentIndex >= 0 && currentIndex < members.length) {
    return members[currentIndex];
  }
  return members[0];
}

export function resolveInsertPeerSelection(peer, target, currentSelectionIds, currentSummary = null) {
  const matchedMember = resolveInsertPeerMember(peer, target, currentSummary);
  const primaryId = Number.isFinite(matchedMember?.id)
    ? Math.trunc(Number(matchedMember.id))
    : (Array.isArray(peer?.memberIds) && peer.memberIds.length > 0 ? Math.trunc(Number(peer.memberIds[0])) : null);
  const scope = classifyInsertSelectionScope(target, currentSelectionIds, currentSummary);
  if (scope === 'full' && Array.isArray(peer?.memberIds) && peer.memberIds.length > 0) {
    return {
      scope,
      primaryId,
      selectionIds: [...peer.memberIds],
    };
  }
  if (scope === 'editable' && Array.isArray(peer?.editableIds) && peer.editableIds.length > 0) {
    return {
      scope,
      primaryId,
      selectionIds: [...peer.editableIds],
    };
  }
  if (scope === 'text') {
    const textIds = listInsertGroupTextMembers(peer?.members, matchedMember || target).map((entity) => entity.id);
    if (textIds.length > 0) {
      return {
        scope,
        primaryId,
        selectionIds: textIds,
      };
    }
  }
  if (scope === 'editable-text') {
    const editableTextIds = listEditableInsertTextMembers(peer?.members, matchedMember || target).map((entity) => entity.id);
    if (editableTextIds.length > 0) {
      return {
        scope,
        primaryId,
        selectionIds: editableTextIds,
      };
    }
  }
  return {
    scope,
    primaryId,
    selectionIds: Number.isFinite(primaryId) ? [primaryId] : [],
  };
}

export function resolveReleasedInsertPeerMember(peer, target, currentSummary = null) {
  const members = Array.isArray(peer?.members) ? peer.members.filter(Boolean) : [];
  if (members.length === 0 || !target) {
    return null;
  }
  const archive = resolveReleasedInsertArchive(target);
  const archivedName = normalizeLabel(archive?.name) || normalizeLabel(target?.name);
  if (archivedName) {
    const namedMatch = members.find((entity) => normalizeLabel(entity?.name) === archivedName);
    if (namedMatch) {
      return namedMatch;
    }
  }
  const targetType = normalizeType(target?.type);
  const archiveProxyKind = normalizeLabel(archive?.proxyKind) || normalizeLabel(target?.proxyKind);
  const archiveEditMode = normalizeLabel(archive?.editMode) || normalizeLabel(target?.editMode);
  const archiveTextKind = normalizeLabel(archive?.textKind);
  const archiveAttributeTag = normalizeLabel(archive?.attributeTag);
  const metadataMatch = members.find((entity) => (
    normalizeType(entity?.type) === targetType
    && (!archiveProxyKind || normalizeLabel(entity?.proxyKind) === archiveProxyKind)
    && (!archiveEditMode || normalizeLabel(entity?.editMode) === archiveEditMode)
    && (!archiveTextKind || normalizeLabel(entity?.textKind) === archiveTextKind)
    && (!archiveAttributeTag || normalizeLabel(entity?.attributeTag) === archiveAttributeTag)
  ));
  if (metadataMatch) {
    return metadataMatch;
  }
  const sameKindMembers = members.filter((entity) => (
    normalizeType(entity?.type) === targetType
    && (!archiveProxyKind || normalizeLabel(entity?.proxyKind) === archiveProxyKind)
  ));
  if (sameKindMembers.length === 1) {
    return sameKindMembers[0];
  }
  const currentIndex = Array.isArray(currentSummary?.members)
    ? currentSummary.members.findIndex((entity) => entity?.id === target?.id)
    : -1;
  if (currentIndex >= 0 && currentIndex < members.length) {
    return members[currentIndex];
  }
  return members[0];
}

function isReleasedInsertEntityForArchive(entity, archive) {
  const entityArchive = resolveReleasedInsertArchive(entity);
  if (!entityArchive || normalizeSourceType(entityArchive?.sourceType) !== 'INSERT') return false;
  const archiveGroupId = Number.isFinite(archive?.groupId) ? Math.trunc(Number(archive.groupId)) : null;
  const entityGroupId = Number.isFinite(entityArchive?.groupId) ? Math.trunc(Number(entityArchive.groupId)) : null;
  if (archiveGroupId === null || entityGroupId !== archiveGroupId) return false;
  const archiveBlockName = normalizeLabel(archive?.blockName);
  if (!archiveBlockName) return true;
  return normalizeLabel(entityArchive?.blockName) === archiveBlockName;
}

function listReleasedInsertSelectedMembers(entities, target, currentSelectionIds) {
  const archive = resolveReleasedInsertArchive(target);
  if (!archive) return [];
  const selectedIds = Array.isArray(currentSelectionIds)
    ? currentSelectionIds.filter((id) => Number.isFinite(id)).map((id) => Math.trunc(Number(id)))
    : [];
  if (selectedIds.length === 0) return [];
  const selectedSet = new Set(selectedIds);
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  return list.filter((entity) => (
    entity
    && selectedSet.has(Math.trunc(Number(entity.id)))
    && normalizeType(entity?.type) === 'text'
    && isReleasedInsertEntityForArchive(entity, archive)
    && matchesSpaceLayout(entity, target)
  ));
}

export function resolveReleasedInsertPeerSelection(peer, target, currentSelectionIds, entities = null, currentSummary = null) {
  const matchedMember = resolveReleasedInsertPeerMember(peer, target, currentSummary);
  const primaryId = Number.isFinite(matchedMember?.id)
    ? Math.trunc(Number(matchedMember.id))
    : (Array.isArray(peer?.memberIds) && peer.memberIds.length > 0 ? Math.trunc(Number(peer.memberIds[0])) : null);
  const selectedReleasedMembers = listReleasedInsertSelectedMembers(entities, target, currentSelectionIds);
  if (selectedReleasedMembers.length > 1) {
    const peerOrder = new Map(
      (Array.isArray(peer?.members) ? peer.members : [])
        .filter(Boolean)
        .map((entity, index) => [Math.trunc(Number(entity.id)), index])
    );
    const mappedIds = [];
    const seenIds = new Set();
    for (const releasedEntity of selectedReleasedMembers) {
      const mapped = resolveReleasedInsertPeerMember(peer, releasedEntity, currentSummary);
      if (!Number.isFinite(mapped?.id)) continue;
      const mappedId = Math.trunc(Number(mapped.id));
      if (seenIds.has(mappedId)) continue;
      seenIds.add(mappedId);
      mappedIds.push(mappedId);
    }
    if (mappedIds.length > 1) {
      mappedIds.sort((left, right) => (peerOrder.get(left) ?? 0) - (peerOrder.get(right) ?? 0));
      return {
        scope: 'released-text',
        primaryId,
        selectionIds: mappedIds,
      };
    }
  }
  return {
    scope: 'released-single',
    primaryId,
    selectionIds: Number.isFinite(primaryId) ? [primaryId] : [],
  };
}
