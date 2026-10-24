import { commandResult } from './command_bus.js';
import {
  angleDelta,
  angleFrom,
  cloneValue,
  computeOffsetEntity,
  distance,
  distanceSq,
  EPSILON,
  lineArcIntersection,
  normalizeAngle,
  pointOnSegmentDistance,
  extractLineSegments,
  lineLineIntersection,
  rotateEntity,
  scaleEntity,
  subtract,
  normalizeVector,
  perpendicular,
  scale,
  add,
  dot,
  transformEntityByDelta,
} from '../tools/geometry.js';
import {
  isDirectEditableInsertTextProxyEntity,
  isDirectEditableSourceTextEntity,
  isInsertGroupEntity,
  isSourceGroupEntity,
  listEditableInsertTextMembers,
  listInsertGroupTextMembers,
  listSourceGroupTextMembers,
  summarizeReleasedInsertGroupMembers,
  resolveSourceTextGuide,
  summarizeInsertGroupMembers,
  summarizeSourceGroupMembers,
} from '../insert_group.js';
import { suggestFilletRadius, suggestChamferDistance } from '../tools/two_target_pick_tool_helpers.js';
import { resolveEffectiveEntityColor } from '../line_style.js';
import {
  nowMs,
  emitPerfProfile,
  captureState,
  restoreState,
  withSnapshot,
} from './shared/snapshot.js';
import {
  hasSelection,
  selectedEntities,
  isReadOnlyEntity,
  hasSameEntityIds,
} from './shared/selection.js';
import { runApplyGeometry, buildSolverProject } from './solver/bridge.js';

function isTransformSafeSourceGroupProxy(entity) {
  if (!entity || !isSourceGroupEntity(entity)) return false;
  return entity.type === 'line'
    || entity.type === 'polyline'
    || entity.type === 'circle'
    || entity.type === 'arc'
    || entity.type === 'text';
}

function resolveWholeSourceGroupTransformSelection(ctx, selectionIds) {
  if (!Array.isArray(selectionIds) || selectionIds.length === 0) return null;
  const primaryId = Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null;
  const primary = ctx.document.getEntity(primaryId) || ctx.document.getEntity(selectionIds[0]);
  if (!isSourceGroupEntity(primary)) return null;
  const summary = summarizeSourceGroupMembers(ctx.document.listEntities(), primary, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.readOnlyIds.length === 0) return null;
  if (summary.memberIds.length <= 1) return null;
  if (!hasSameEntityIds(selectionIds, summary.memberIds)) return null;
  return {
    ...summary,
    groupKind: isInsertGroupEntity(primary) ? 'insert' : 'source',
    memberIdSet: new Set(summary.memberIds),
  };
}

function canTransformSelectedEntity(entity, wholeSourceGroupSelection) {
  if (!entity) return false;
  if (!isReadOnlyEntity(entity)) return true;
  return !!wholeSourceGroupSelection
    && wholeSourceGroupSelection.memberIdSet.has(entity.id)
    && isTransformSafeSourceGroupProxy(entity);
}

function formatWholeSourceGroupTransformMessage(verb, entityCount, wholeSourceGroupSelection) {
  if (!wholeSourceGroupSelection) return '';
  if (wholeSourceGroupSelection.groupKind === 'insert') {
    return `${verb} insert group (${entityCount} entities, including ${wholeSourceGroupSelection.readOnlyIds.length} proxy)`;
  }
  return `${verb} source group (${entityCount} entities, including ${wholeSourceGroupSelection.readOnlyIds.length} read-only)`;
}

function stripImportedProvenanceForCreatedEntity(entity) {
  if (!entity || typeof entity !== 'object') return entity;
  const next = { ...entity };
  delete next.groupId;
  delete next.colorSource;
  delete next.colorAci;
  delete next.sourceType;
  delete next.editMode;
  delete next.proxyKind;
  delete next.blockName;
  delete next.hatchId;
  delete next.hatchPattern;
  delete next.sourceBundleId;
  delete next.dimType;
  delete next.dimStyle;
  delete next.sourceTextPos;
  delete next.sourceTextRotation;
  delete next.sourceAnchor;
  delete next.leaderLanding;
  delete next.leaderElbow;
  delete next.sourceAnchorDriverId;
  delete next.sourceAnchorDriverType;
  delete next.sourceAnchorDriverKind;
  delete next.dimTextPos;
  delete next.dimTextRotation;
  return next;
}

function isReleasableInsertEntity(entity) {
  return !!entity
    && (entity.type === 'line'
      || entity.type === 'polyline'
      || entity.type === 'circle'
      || entity.type === 'arc'
      || entity.type === 'text');
}

function buildReleasedInsertEntity(entity, layer = null) {
  if (!entity || typeof entity !== 'object') return entity;
  const next = { ...cloneValue(entity) };
  const archive = entity.type === 'text' && String(entity?.sourceType || '').trim().toUpperCase() === 'INSERT'
    ? {
      sourceType: typeof entity?.sourceType === 'string' ? entity.sourceType.trim() : '',
      editMode: typeof entity?.editMode === 'string' ? entity.editMode.trim() : '',
      proxyKind: typeof entity?.proxyKind === 'string' ? entity.proxyKind.trim() : '',
      name: typeof entity?.name === 'string' ? entity.name.trim() : '',
      groupId: Number.isFinite(entity?.groupId) ? Math.trunc(Number(entity.groupId)) : undefined,
      blockName: typeof entity?.blockName === 'string' ? entity.blockName.trim() : '',
      textKind: typeof entity?.textKind === 'string' ? entity.textKind.trim() : '',
      attributeTag: typeof entity?.attributeTag === 'string' ? entity.attributeTag.trim() : '',
      attributeDefault: typeof entity?.attributeDefault === 'string' ? entity.attributeDefault : undefined,
      attributePrompt: typeof entity?.attributePrompt === 'string' ? entity.attributePrompt : undefined,
      attributeFlags: Number.isFinite(entity?.attributeFlags) ? Math.trunc(entity.attributeFlags) : undefined,
      attributeInvisible: typeof entity?.attributeInvisible === 'boolean' ? entity.attributeInvisible : undefined,
      attributeConstant: typeof entity?.attributeConstant === 'boolean' ? entity.attributeConstant : undefined,
      attributeVerify: typeof entity?.attributeVerify === 'boolean' ? entity.attributeVerify : undefined,
      attributePreset: typeof entity?.attributePreset === 'boolean' ? entity.attributePreset : undefined,
      attributeLockPosition: typeof entity?.attributeLockPosition === 'boolean' ? entity.attributeLockPosition : undefined,
    }
    : null;
  next.groupId = undefined;
  next.sourceType = undefined;
  next.editMode = undefined;
  next.proxyKind = undefined;
  next.blockName = undefined;
  next.sourceAnchor = undefined;
  next.leaderLanding = undefined;
  next.leaderElbow = undefined;
  next.sourceAnchorDriverId = undefined;
  next.sourceAnchorDriverType = undefined;
  next.sourceAnchorDriverKind = undefined;
  next.textKind = undefined;
  next.attributeTag = undefined;
  next.attributeDefault = undefined;
  next.attributePrompt = undefined;
  next.attributeFlags = undefined;
  next.attributeInvisible = undefined;
  next.attributeConstant = undefined;
  next.attributeVerify = undefined;
  next.attributePreset = undefined;
  next.attributeLockPosition = undefined;
  next.sourceTextPos = undefined;
  next.sourceTextRotation = undefined;
  next.readOnly = false;
  next.releasedInsertArchive = archive;
  if (String(next.colorSource || '').trim().toUpperCase() === 'BYBLOCK') {
    next.color = resolveEffectiveEntityColor(entity, layer);
    next.colorSource = 'TRUECOLOR';
    next.colorAci = null;
  }
  if (String(next.lineType || '').trim().toUpperCase() === 'BYBLOCK') {
    next.lineType = 'CONTINUOUS';
  }
  return next;
}

function isReleasableSourceEntity(entity) {
  return !!entity
    && (entity.type === 'line'
      || entity.type === 'polyline'
      || entity.type === 'circle'
      || entity.type === 'arc'
      || entity.type === 'text');
}

function buildReleasedSourceEntity(entity, layer = null) {
  if (!entity || typeof entity !== 'object') return entity;
  const next = { ...cloneValue(entity) };
  next.groupId = undefined;
  next.sourceType = undefined;
  next.editMode = undefined;
  next.proxyKind = undefined;
  next.blockName = undefined;
  next.hatchId = undefined;
  next.hatchPattern = undefined;
  next.sourceBundleId = undefined;
  next.dimType = undefined;
  next.dimStyle = undefined;
  next.sourceTextPos = undefined;
  next.sourceTextRotation = undefined;
  next.sourceAnchor = undefined;
  next.leaderLanding = undefined;
  next.leaderElbow = undefined;
  next.sourceAnchorDriverId = undefined;
  next.sourceAnchorDriverType = undefined;
  next.sourceAnchorDriverKind = undefined;
  next.dimTextPos = undefined;
  next.dimTextRotation = undefined;
  next.readOnly = false;
  if (String(next.colorSource || '').trim().toUpperCase() === 'BYBLOCK') {
    next.color = resolveEffectiveEntityColor(entity, layer);
    next.colorSource = 'TRUECOLOR';
    next.colorAci = null;
  }
  if (String(next.lineType || '').trim().toUpperCase() === 'BYBLOCK') {
    next.lineType = 'CONTINUOUS';
  }
  return next;
}

function runDeleteSelection(ctx) {
  const ids = [...ctx.selection.entityIds];
  if (ids.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to delete' };
  }
  const wholeSourceGroupSelection = resolveWholeSourceGroupTransformSelection(ctx, ids);
  if (wholeSourceGroupSelection && wholeSourceGroupSelection.groupKind === 'insert') {
    const removed = ctx.document.removeEntities(ids);
    ctx.selection.clear();
    return {
      ok: true,
      changed: removed.length > 0,
      message: `Deleted insert group (${ids.length} entities, including ${wholeSourceGroupSelection.readOnlyIds.length} proxy)`,
    };
  }
  if (wholeSourceGroupSelection && wholeSourceGroupSelection.groupKind === 'source') {
    const removed = ctx.document.removeEntities(ids);
    ctx.selection.clear();
    return {
      ok: true,
      changed: removed.length > 0,
      message: `Deleted source group (${ids.length} entities, including ${wholeSourceGroupSelection.readOnlyIds.length} read-only)`,
    };
  }
  const editableIds = [];
  const readOnlyIds = [];
  for (const id of ids) {
    const entity = ctx.document.getEntity(id);
    if (!entity) continue;
    if (isReadOnlyEntity(entity)) {
      readOnlyIds.push(id);
      continue;
    }
    editableIds.push(id);
  }
  if (editableIds.length === 0 && readOnlyIds.length > 0) {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED_READ_ONLY', message: 'Selected entities are read-only proxies' };
  }
  const removed = ctx.document.removeEntities(editableIds);
  if (readOnlyIds.length > 0) {
    ctx.selection.setSelection(readOnlyIds, readOnlyIds[0]);
  } else {
    ctx.selection.clear();
  }
  if (readOnlyIds.length > 0) {
    return {
      ok: true,
      changed: removed.length > 0,
      message: `Deleted ${removed.length} entities (skipped ${readOnlyIds.length} read-only)`,
    };
  }
  return {
    ok: true,
    changed: removed.length > 0,
    message: `Deleted ${removed.length} entities`,
  };
}

function runSelectInsertGroup(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to expand into an insert group' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Insert group target not found' };
  }
  if (!isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_INSERT_GROUP', message: 'Selected entity is not part of an INSERT group' };
  }
  const summary = summarizeInsertGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No INSERT group members found in the current space/layout' };
  }
  const ids = summary.memberIds;
  const primaryId = ids.includes(targetId) ? targetId : ids[0];
  const currentIds = Array.isArray(ctx.selection.entityIds) ? ctx.selection.entityIds : [];
  const unchanged = currentIds.length === ids.length
    && currentIds.every((id, index) => id === ids[index])
    && ctx.selection.primaryId === primaryId;
  if (unchanged) {
    return { ok: true, changed: false, message: `Insert group already selected (${ids.length} entities)` };
  }
  ctx.selection.setSelection(ids, primaryId);
  return {
    ok: true,
    changed: true,
    message: `Selected insert group (${ids.length} entities)`,
  };
}

function runSelectReleasedInsertGroup(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No released insert text selected' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Released insert text target not found' };
  }
  const summary = summarizeReleasedInsertGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'RELEASED_INSERT_GROUP_MISSING', message: 'Released insert text has no surviving imported insert group in the current space/layout' };
  }
  const ids = summary.memberIds;
  const primaryId = ids[0];
  const currentIds = Array.isArray(ctx.selection.entityIds) ? ctx.selection.entityIds : [];
  const unchanged = currentIds.length === ids.length
    && currentIds.every((id, index) => id === ids[index])
    && ctx.selection.primaryId === primaryId;
  if (unchanged) {
    return { ok: true, changed: false, message: `Released insert group already selected (${ids.length} entities)` };
  }
  ctx.selection.setSelection(ids, primaryId);
  return {
    ok: true,
    changed: true,
    message: `Selected released insert group (${ids.length} entities)`,
  };
}

function runSelectSourceGroup(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to expand into a source group' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Source group target not found' };
  }
  if (!isSourceGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_SOURCE_GROUP', message: 'Selected entity is not part of a source group' };
  }
  const summary = summarizeSourceGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No source-group members found in the current space/layout' };
  }
  const ids = summary.memberIds;
  const primaryId = ids.includes(targetId) ? targetId : ids[0];
  const currentIds = Array.isArray(ctx.selection.entityIds) ? ctx.selection.entityIds : [];
  const unchanged = currentIds.length === ids.length
    && currentIds.every((id, index) => id === ids[index])
    && ctx.selection.primaryId === primaryId;
  if (unchanged) {
    return { ok: true, changed: false, message: `Source group already selected (${ids.length} entities)` };
  }
  ctx.selection.setSelection(ids, primaryId);
  return {
    ok: true,
    changed: true,
    message: `Selected source group (${ids.length} entities)`,
  };
}

function runSelectEditableInsertGroup(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to narrow to editable insert members' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Insert group target not found' };
  }
  if (!isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_INSERT_GROUP', message: 'Selected entity is not part of an INSERT group' };
  }
  const summary = summarizeInsertGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No INSERT group members found in the current space/layout' };
  }
  if (summary.editableIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_NOT_EDITABLE', message: 'Selected INSERT group has no editable members' };
  }
  const ids = summary.editableIds;
  const primaryId = ids.includes(targetId) ? targetId : ids[0];
  const currentIds = Array.isArray(ctx.selection.entityIds) ? ctx.selection.entityIds : [];
  const unchanged = currentIds.length === ids.length
    && currentIds.every((id, index) => id === ids[index])
    && ctx.selection.primaryId === primaryId;
  if (unchanged) {
    return {
      ok: true,
      changed: false,
      message: `Editable insert members already selected (${ids.length} of ${summary.memberIds.length})`,
    };
  }
  ctx.selection.setSelection(ids, primaryId);
  return {
    ok: true,
    changed: true,
    message: `Selected editable insert members (${ids.length} of ${summary.memberIds.length})`,
  };
}

function runSelectInsertGroupText(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to narrow to insert text' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Insert text target not found' };
  }
  if (!isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_INSERT_GROUP', message: 'Selected entity is not part of an INSERT group with text' };
  }
  const summary = summarizeInsertGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No INSERT group members found in the current space/layout' };
  }
  const textMembers = listInsertGroupTextMembers(summary.members, target);
  if (textMembers.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_HAS_NO_TEXT', message: 'Selected INSERT group has no text members to select' };
  }
  const textIds = textMembers.map((entity) => entity.id);
  const primaryId = textIds.includes(targetId) ? targetId : textIds[0];
  const currentIds = Array.isArray(ctx.selection.entityIds) ? ctx.selection.entityIds : [];
  const unchanged = currentIds.length === textIds.length
    && currentIds.every((id, index) => id === textIds[index])
    && ctx.selection.primaryId === primaryId;
  if (unchanged) {
    return {
      ok: true,
      changed: false,
      message: `Insert text already selected (${textIds.length} of ${summary.memberIds.length} entities)`,
    };
  }
  ctx.selection.setSelection(textIds, primaryId);
  return {
    ok: true,
    changed: true,
    message: `Selected insert text (${textIds.length} of ${summary.memberIds.length} entities)`,
  };
}

function runSelectEditableInsertGroupText(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to narrow to editable insert text' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Editable insert text target not found' };
  }
  if (!isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_INSERT_GROUP', message: 'Selected entity is not part of an INSERT group with editable text' };
  }
  const summary = summarizeInsertGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No INSERT group members found in the current space/layout' };
  }
  const editableTextMembers = listEditableInsertTextMembers(summary.members, target);
  if (editableTextMembers.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_HAS_NO_EDITABLE_TEXT', message: 'Selected INSERT group has no editable text members to select' };
  }
  const editableTextIds = editableTextMembers.map((entity) => entity.id);
  const primaryId = editableTextIds.includes(targetId) ? targetId : editableTextIds[0];
  const currentIds = Array.isArray(ctx.selection.entityIds) ? ctx.selection.entityIds : [];
  const unchanged = currentIds.length === editableTextIds.length
    && currentIds.every((id, index) => id === editableTextIds[index])
    && ctx.selection.primaryId === primaryId;
  if (unchanged) {
    return {
      ok: true,
      changed: false,
      message: `Editable insert text already selected (${editableTextIds.length} of ${summary.memberIds.length} entities)`,
    };
  }
  ctx.selection.setSelection(editableTextIds, primaryId);
  return {
    ok: true,
    changed: true,
    message: `Selected editable insert text (${editableTextIds.length} of ${summary.memberIds.length} entities)`,
  };
}

function runReleaseInsertGroup(ctx, payload) {
  const resolved = resolveReleasableInsertGroup(ctx, payload);
  if (!resolved.ok) {
    return resolved;
  }
  const { summary, targetId } = resolved;
  let changed = false;
  for (const entity of summary.members) {
    const layer = ctx.document.getLayer(entity.layerId);
    const next = buildReleasedInsertEntity(entity, layer);
    changed = ctx.document.updateEntity(entity.id, next) || changed;
  }
  const ids = summary.memberIds;
  const primaryId = ids.includes(targetId) ? targetId : ids[0];
  ctx.selection.setSelection(ids, primaryId);
  return {
    ok: true,
    changed,
    message: `Released insert group to editable geometry (${ids.length} entities)`,
  };
}

function resolveReleasableInsertGroup(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to release from imported insert group' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Insert group target not found' };
  }
  if (!isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_INSERT_GROUP', message: 'Selected entity is not part of an INSERT group' };
  }
  const summary = summarizeInsertGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No INSERT group members found in the current space/layout' };
  }
  const unreleasable = summary.members.filter((entity) => !isReleasableInsertEntity(entity));
  if (unreleasable.length > 0) {
    return {
      ok: false,
      changed: false,
      error_code: 'UNSUPPORTED_INSERT_MEMBER',
      message: `Insert group contains ${unreleasable.length} unsupported member(s)`,
    };
  }
  const locked = summary.members.find((entity) => ctx.document.getLayer(entity.layerId)?.locked === true);
  if (locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Insert group contains entities on locked layers' };
  }
  return { ok: true, changed: false, targetId, target, summary };
}

function runEditInsertText(ctx, payload) {
  const resolved = resolveReleasableInsertGroup(ctx, payload);
  if (!resolved.ok) {
    return resolved;
  }
  const { summary, target, targetId } = resolved;
  const textMembers = listInsertGroupTextMembers(summary.members, target);
  if (textMembers.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_HAS_NO_TEXT', message: 'Selected INSERT group has no text members to edit' };
  }
  let changed = false;
  for (const entity of textMembers) {
    const layer = ctx.document.getLayer(entity.layerId);
    const next = buildReleasedInsertEntity(entity, layer);
    changed = ctx.document.updateEntity(entity.id, next) || changed;
  }
  const textIds = textMembers.map((entity) => entity.id);
  const primaryId = textIds.includes(targetId) ? targetId : textIds[0];
  ctx.selection.setSelection(textIds, primaryId);
  return {
    ok: true,
    changed,
    message: `Released insert text to editable geometry (${textIds.length} of ${summary.memberIds.length} entities)`,
  };
}

function resolveReleasableSourceGroup(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to release from imported source group' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Source group target not found' };
  }
  if (!isSourceGroupEntity(target) || isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_SOURCE_GROUP', message: 'Selected entity is not part of a releasable source group' };
  }
  const summary = summarizeSourceGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No source-group members found in the current space/layout' };
  }
  const unreleasable = summary.members.filter((entity) => !isReleasableSourceEntity(entity));
  if (unreleasable.length > 0) {
    return {
      ok: false,
      changed: false,
      error_code: 'UNSUPPORTED_SOURCE_MEMBER',
      message: `Source group contains ${unreleasable.length} unsupported member(s)`,
    };
  }
  const locked = summary.members.find((entity) => ctx.document.getLayer(entity.layerId)?.locked === true);
  if (locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Source group contains entities on locked layers' };
  }
  return { ok: true, changed: false, targetId, target, summary };
}

function applyReleasedSourceGroup(ctx, summary) {
  let changed = false;
  for (const entity of summary.members) {
    const layer = ctx.document.getLayer(entity.layerId);
    const next = buildReleasedSourceEntity(entity, layer);
    changed = ctx.document.updateEntity(entity.id, next) || changed;
  }
  return changed;
}

function runReleaseSourceGroup(ctx, payload) {
  const resolved = resolveReleasableSourceGroup(ctx, payload);
  if (!resolved.ok) {
    return resolved;
  }
  const { summary, targetId } = resolved;
  const changed = applyReleasedSourceGroup(ctx, summary);
  const ids = summary.memberIds;
  const primaryId = ids.includes(targetId) ? targetId : ids[0];
  ctx.selection.setSelection(ids, primaryId);
  return {
    ok: true,
    changed,
    message: `Released source group to editable geometry (${ids.length} entities)`,
  };
}

function runEditSourceGroupText(ctx, payload) {
  const resolved = resolveReleasableSourceGroup(ctx, payload);
  if (!resolved.ok) {
    return resolved;
  }
  const { summary, target, targetId } = resolved;
  const textMembers = listSourceGroupTextMembers(summary.members, target);
  if (textMembers.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_HAS_NO_TEXT', message: 'Selected source group has no text members to edit' };
  }
  const changed = applyReleasedSourceGroup(ctx, summary);
  const textIds = textMembers.map((entity) => entity.id);
  const primaryId = textIds.includes(targetId) ? targetId : textIds[0];
  ctx.selection.setSelection(textIds, primaryId);
  return {
    ok: true,
    changed,
    message: `Released source group and selected source text (${textIds.length} of ${summary.memberIds.length} entities)`,
  };
}

function runSelectSourceGroupText(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to narrow to source text' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Source text target not found' };
  }
  if (!isSourceGroupEntity(target) || isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_SOURCE_GROUP', message: 'Selected entity is not part of a source group with text' };
  }
  const summary = summarizeSourceGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No source-group members found in the current space/layout' };
  }
  const textMembers = listSourceGroupTextMembers(summary.members, target);
  if (textMembers.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_HAS_NO_TEXT', message: 'Selected source group has no text members to select' };
  }
  const textIds = textMembers.map((entity) => entity.id);
  const primaryId = textIds.includes(targetId) ? targetId : textIds[0];
  const currentIds = Array.isArray(ctx.selection.entityIds) ? ctx.selection.entityIds : [];
  const unchanged = currentIds.length === textIds.length
    && currentIds.every((id, index) => id === textIds[index])
    && ctx.selection.primaryId === primaryId;
  if (unchanged) {
    return {
      ok: true,
      changed: false,
      message: `Source text already selected (${textIds.length} of ${summary.memberIds.length} entities)`,
    };
  }
  ctx.selection.setSelection(textIds, primaryId);
  return {
    ok: true,
    changed: true,
    message: `Selected source text (${textIds.length} of ${summary.memberIds.length} entities)`,
  };
}

function runSelectSourceAnchorDriver(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to resolve source anchor driver' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Source anchor target not found' };
  }
  if (!isSourceGroupEntity(target) || isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_SOURCE_GROUP', message: 'Selected entity is not part of a source group with anchor guide' };
  }
  const guide = resolveSourceTextGuide(ctx.document.listEntities(), target);
  if (!guide?.anchor || !Number.isFinite(guide.anchorDriverId)) {
    return { ok: false, changed: false, error_code: 'GROUP_HAS_NO_ANCHOR_DRIVER', message: 'Selected source group has no selectable anchor driver' };
  }
  const driver = ctx.document.getEntity(guide.anchorDriverId);
  if (!driver) {
    return { ok: false, changed: false, error_code: 'ANCHOR_DRIVER_MISSING', message: 'Source anchor driver not found' };
  }
  const nextIds = [guide.anchorDriverId];
  const currentIds = Array.isArray(ctx.selection.entityIds) ? ctx.selection.entityIds : [];
  const unchanged = currentIds.length === 1
    && currentIds[0] === guide.anchorDriverId
    && ctx.selection.primaryId === guide.anchorDriverId;
  if (unchanged) {
    return { ok: true, changed: false, message: `Source anchor driver already selected (${guide.anchorDriverLabel || driver.type})` };
  }
  ctx.selection.setSelection(nextIds, guide.anchorDriverId);
  return {
    ok: true,
    changed: true,
    message: `Selected source anchor driver (${guide.anchorDriverLabel || driver.type})`,
  };
}

function runMoveSelection(ctx, payload) {
  const ids = [...ctx.selection.entityIds];
  if (ids.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to move' };
  }
  if (!payload?.delta || !Number.isFinite(payload.delta.x) || !Number.isFinite(payload.delta.y)) {
    return { ok: false, changed: false, error_code: 'INVALID_DELTA', message: 'Missing move delta' };
  }
  const wholeSourceGroupSelection = resolveWholeSourceGroupTransformSelection(ctx, ids);
  let changed = false;
  let attempted = 0;
  let readOnlySkipped = 0;
  for (const id of ids) {
    const entity = ctx.document.getEntity(id);
    if (!entity) continue;
    attempted += 1;
    if (!canTransformSelectedEntity(entity, wholeSourceGroupSelection)) {
      readOnlySkipped += 1;
      continue;
    }
    const next = transformEntityByDelta(entity, payload.delta);
    changed = ctx.document.updateEntity(id, next) || changed;
  }
  if (!changed && attempted > 0 && readOnlySkipped === attempted) {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED_READ_ONLY', message: 'Selected entities are read-only proxies' };
  }
  if (readOnlySkipped > 0) {
    return {
      ok: true,
      changed,
      message: `Moved ${Math.max(0, attempted - readOnlySkipped)}/${attempted} entities (skipped ${readOnlySkipped} read-only)`,
    };
  }
  if (wholeSourceGroupSelection && wholeSourceGroupSelection.readOnlyIds.length > 0) {
    return {
      ok: true,
      changed,
      message: formatWholeSourceGroupTransformMessage('Moved', ids.length, wholeSourceGroupSelection),
    };
  }
  return { ok: true, changed, message: `Moved ${ids.length} entities` };
}

function runCopySelection(ctx, payload) {
  const ids = [...ctx.selection.entityIds];
  if (ids.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to copy' };
  }
  if (!payload?.delta || !Number.isFinite(payload.delta.x) || !Number.isFinite(payload.delta.y)) {
    return { ok: false, changed: false, error_code: 'INVALID_DELTA', message: 'Missing copy delta' };
  }
  const wholeSourceGroupSelection = resolveWholeSourceGroupTransformSelection(ctx, ids);
  if (wholeSourceGroupSelection && wholeSourceGroupSelection.groupKind === 'insert') {
    const unreleasable = wholeSourceGroupSelection.members.filter((entity) => !isReleasableInsertEntity(entity));
    if (unreleasable.length > 0) {
      return {
        ok: false,
        changed: false,
        error_code: 'UNSUPPORTED_INSERT_MEMBER',
        message: `Insert group contains ${unreleasable.length} unsupported member(s)`,
      };
    }
    const copied = [];
    for (const id of ids) {
      const entity = ctx.document.getEntity(id);
      if (!entity) continue;
      const detached = buildReleasedInsertEntity(entity, ctx.document.getLayer(entity.layerId));
      const next = transformEntityByDelta(detached, payload.delta);
      delete next.id;
      const created = ctx.document.addEntity(next);
      if (created) copied.push(created.id);
    }
    if (copied.length > 0) {
      ctx.selection.setSelection(copied, copied[0]);
    }
    return {
      ok: true,
      changed: copied.length > 0,
      message: `Copied insert group as detached geometry (${copied.length} entities)`,
    };
  }
  if (wholeSourceGroupSelection && wholeSourceGroupSelection.groupKind === 'source') {
    const unreleasable = wholeSourceGroupSelection.members.filter((entity) => !isReleasableSourceEntity(entity));
    if (unreleasable.length > 0) {
      return {
        ok: false,
        changed: false,
        error_code: 'UNSUPPORTED_SOURCE_MEMBER',
        message: `Source group contains ${unreleasable.length} unsupported member(s)`,
      };
    }
    const copied = [];
    for (const id of ids) {
      const entity = ctx.document.getEntity(id);
      if (!entity) continue;
      const detached = buildReleasedSourceEntity(entity, ctx.document.getLayer(entity.layerId));
      const next = transformEntityByDelta(detached, payload.delta);
      delete next.id;
      const created = ctx.document.addEntity(next);
      if (created) copied.push(created.id);
    }
    if (copied.length > 0) {
      ctx.selection.setSelection(copied, copied[0]);
    }
    return {
      ok: true,
      changed: copied.length > 0,
      message: `Copied source group as detached geometry (${copied.length} entities)`,
    };
  }
  const copied = [];
  let attempted = 0;
  let readOnlySkipped = 0;
  for (const id of ids) {
    const entity = ctx.document.getEntity(id);
    if (!entity) continue;
    attempted += 1;
    if (isReadOnlyEntity(entity)) {
      readOnlySkipped += 1;
      continue;
    }
    const next = stripImportedProvenanceForCreatedEntity(transformEntityByDelta(entity, payload.delta));
    delete next.id;
    const created = ctx.document.addEntity(next);
    if (created) copied.push(created.id);
  }
  if (copied.length === 0 && attempted > 0 && readOnlySkipped === attempted) {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED_READ_ONLY', message: 'Selected entities are read-only proxies' };
  }
  if (copied.length > 0) {
    ctx.selection.setSelection(copied, copied[0]);
  }
  if (readOnlySkipped > 0) {
    return {
      ok: true,
      changed: copied.length > 0,
      message: `Copied ${copied.length}/${attempted} entities (skipped ${readOnlySkipped} read-only)`,
    };
  }
  return { ok: true, changed: copied.length > 0, message: `Copied ${copied.length} entities` };
}

function runOffsetSelection(ctx, payload) {
  const ids = [...ctx.selection.entityIds];
  if (ids.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to offset' };
  }
  const distance = payload?.distance;
  const sidePoint = payload?.sidePoint;
  if (!Number.isFinite(distance) || Math.abs(distance) <= 1e-9) {
    return { ok: false, changed: false, error_code: 'INVALID_DISTANCE', message: 'Missing offset distance' };
  }
  if (!sidePoint || !Number.isFinite(sidePoint.x) || !Number.isFinite(sidePoint.y)) {
    return { ok: false, changed: false, error_code: 'INVALID_SIDE', message: 'Missing offset side point' };
  }

  const createdPayloads = [];
  let skipped = 0;
  let attempted = 0;
  let readOnlySkipped = 0;
  const reasons = {};
  for (const id of ids) {
    const entity = ctx.document.getEntity(id);
    if (!entity) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    if (isReadOnlyEntity(entity)) {
      skipped += 1;
      readOnlySkipped += 1;
      continue;
    }
    const diag = {};
    const next = computeOffsetEntity(entity, sidePoint, distance, diag);
    if (!next) {
      skipped += 1;
      const code = String(diag.error_code || 'UNSUPPORTED');
      reasons[code] = (reasons[code] || 0) + 1;
      continue;
    }
    const detached = stripImportedProvenanceForCreatedEntity(next);
    delete detached.id;
    createdPayloads.push(detached);
  }

  if (createdPayloads.length === 0) {
    if (attempted > 0 && readOnlySkipped === attempted) {
      return { ok: false, changed: false, error_code: 'UNSUPPORTED_READ_ONLY', message: 'Selected entities are read-only proxies' };
    }
    // Prefer specific reasons when available.
    const pickReason = () => {
      if (reasons.SELF_INTERSECT) return 'SELF_INTERSECT';
      if (reasons.INVALID_GEOMETRY) return 'INVALID_GEOMETRY';
      if (reasons.INVALID_INPUT) return 'INVALID_INPUT';
      const keys = Object.keys(reasons);
      if (keys.length === 1) return keys[0];
      return 'UNSUPPORTED';
    };
    const error_code = pickReason();
    const detail = Object.keys(reasons).length > 0
      ? ` (${Object.entries(reasons).map(([k, v]) => `${k}:${v}`).join(', ')})`
      : '';
    return { ok: false, changed: false, error_code, message: `Offset failed${detail}` };
  }
  const created = ctx.document.addEntities(createdPayloads);
  if (created.length > 0) {
    ctx.selection.setSelection(created.map((entity) => entity.id), created[0].id);
  }
  let message = `Offset created ${created.length} entities`;
  if (skipped > 0) {
    if (readOnlySkipped > 0 && skipped === readOnlySkipped && attempted > 0) {
      message = `Offset created ${created.length}/${attempted} entities (skipped ${readOnlySkipped} read-only)`;
    } else if (readOnlySkipped > 0) {
      message = `Offset created ${created.length} entities (skipped ${skipped}, read-only ${readOnlySkipped})`;
    } else {
      message = `Offset created ${created.length} entities (skipped ${skipped})`;
    }
  }
  return {
    ok: true,
    changed: created.length > 0,
    message,
  };
}

function projectPointToSegment(point, start, end) {
  const sx = Number(start?.x);
  const sy = Number(start?.y);
  const ex = Number(end?.x);
  const ey = Number(end?.y);
  const px = Number(point?.x);
  const py = Number(point?.y);
  if (![sx, sy, ex, ey, px, py].every(Number.isFinite)) {
    return { point: { x: sx || 0, y: sy || 0 }, t: 0, distSq: Infinity };
  }
  const vx = ex - sx;
  const vy = ey - sy;
  const lenSq = vx * vx + vy * vy;
  if (!Number.isFinite(lenSq) || lenSq <= 1e-12) {
    const dx = px - sx;
    const dy = py - sy;
    return { point: { x: sx, y: sy }, t: 0, distSq: dx * dx + dy * dy };
  }
  const t = Math.max(0, Math.min(1, ((px - sx) * vx + (py - sy) * vy) / lenSq));
  const qx = sx + vx * t;
  const qy = sy + vy * t;
  const dx = px - qx;
  const dy = py - qy;
  return { point: { x: qx, y: qy }, t, distSq: dx * dx + dy * dy };
}

function runBreakSelection(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Number(payload.targetId)
    : (Number.isFinite(ctx.selection.primaryId) ? Number(ctx.selection.primaryId) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'Break: no target selected' };
  }
  const pick = payload?.pick;
  if (!pick || !Number.isFinite(pick.x) || !Number.isFinite(pick.y)) {
    return { ok: false, changed: false, error_code: 'INVALID_PICK', message: 'Break: missing pick point' };
  }
  const pick2 = payload?.pick2;
  const hasPick2 = !!pick2 && Number.isFinite(pick2.x) && Number.isFinite(pick2.y);
  const entity = ctx.document.getEntity(targetId);
  if (!entity) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Break: target not found' };
  }
  const layer = ctx.document.getLayer(entity.layerId);
  if (layer?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Break: layer is locked' };
  }
  if (entity.type === 'line') {
    const projected = projectPointToSegment(pick, entity.start, entity.end);
    if (!Number.isFinite(projected.t)) {
      return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: invalid line projection' };
    }
    const before = cloneValue(entity);
    if (hasPick2) {
      const projected2 = projectPointToSegment(pick2, entity.start, entity.end);
      if (!projected2 || !Number.isFinite(projected2.t)) {
        return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: invalid second projection' };
      }
      const t0 = Math.min(projected.t, projected2.t);
      const t1 = Math.max(projected.t, projected2.t);
      if (t0 <= 1e-6 || t1 >= 1 - 1e-6 || t1 - t0 <= 1e-6) {
        return { ok: false, changed: false, error_code: 'BREAK_AT_ENDPOINT', message: 'Break: invalid two-point range' };
      }
      const p0 = projected.t <= projected2.t ? projected.point : projected2.point;
      const p1 = projected.t <= projected2.t ? projected2.point : projected.point;
      const createdTwo = ctx.document.addEntities([
        {
          type: 'line',
          layerId: before.layerId,
          color: before.color,
          visible: before.visible,
          name: before.name ? `${before.name}_A` : '',
          start: before.start,
          end: p0,
        },
        {
          type: 'line',
          layerId: before.layerId,
          color: before.color,
          visible: before.visible,
          name: before.name ? `${before.name}_B` : '',
          start: p1,
          end: before.end,
        },
      ]);
      if (createdTwo.length === 0) {
        return { ok: false, changed: false, error_code: 'BREAK_FAILED', message: 'Break: failed two-point split' };
      }
      ctx.document.removeEntity(entity.id);
      ctx.selection.setSelection(createdTwo.map((e) => e.id), createdTwo[0]?.id ?? null);
      return { ok: true, changed: true, message: `Break(two-point) created ${createdTwo.length} entities` };
    }
    if (projected.t <= 1e-6 || projected.t >= 1 - 1e-6) {
      return { ok: false, changed: false, error_code: 'BREAK_AT_ENDPOINT', message: 'Break: pick away from endpoints' };
    }
    const created = ctx.document.addEntities([
      {
        type: 'line',
        layerId: before.layerId,
        color: before.color,
        visible: before.visible,
        name: before.name ? `${before.name}_A` : '',
        start: before.start,
        end: projected.point,
      },
      {
        type: 'line',
        layerId: before.layerId,
        color: before.color,
        visible: before.visible,
        name: before.name ? `${before.name}_B` : '',
        start: projected.point,
        end: before.end,
      },
    ]);
    if (created.length === 0) {
      return { ok: false, changed: false, error_code: 'BREAK_FAILED', message: 'Break: failed to create segments' };
    }
    ctx.document.removeEntity(entity.id);
    ctx.selection.setSelection(created.map((e) => e.id), created[0]?.id ?? null);
    return { ok: true, changed: true, message: `Break created ${created.length} entities` };
  }

  if (entity.type === 'polyline' && Array.isArray(entity.points)) {
    const closed = entity.closed === true;
    const points = entity.points.map((p) => ({ ...p }));
    if (points.length < (closed ? 3 : 2)) {
      return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: polyline too short' };
    }
    const segCount = closed ? points.length : (points.length - 1);
    let best = null; // { index, projected }
    for (let i = 0; i < segCount; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const projected = projectPointToSegment(pick, a, b);
      if (!best || projected.distSq < best.projected.distSq) {
        best = { index: i, projected };
      }
    }
    if (!best) {
      return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: no segments found' };
    }
    const i = best.index;
    const p = best.projected.point;
    const tolSq = 1e-12;
    let breakIndex;
    const nextPoints = points.map((q) => ({ ...q }));
    const nextI = (i + 1) % nextPoints.length;
    if (distanceSq(p, nextPoints[i]) <= tolSq) {
      breakIndex = i;
    } else if (distanceSq(p, nextPoints[nextI]) <= tolSq) {
      breakIndex = nextI;
    } else {
      const insertIndex = i + 1;
      nextPoints.splice(insertIndex, 0, p);
      breakIndex = insertIndex;
    }

    if (closed) {
      if (hasPick2) {
        let best2 = null; // { index, projected }
        const segCount2 = nextPoints.length;
        for (let i2scan = 0; i2scan < segCount2; i2scan += 1) {
          const a2 = nextPoints[i2scan];
          const b2 = nextPoints[(i2scan + 1) % nextPoints.length];
          const projected2 = projectPointToSegment(pick2, a2, b2);
          if (!best2 || projected2.distSq < best2.projected.distSq) {
            best2 = { index: i2scan, projected: projected2 };
          }
        }
        if (!best2) {
          return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: no second segment found' };
        }
        const i2 = best2.index;
        const p2 = best2.projected.point;
        let breakIndex2;
        const tolSq2 = 1e-12;
        const nextI2 = (i2 + 1) % nextPoints.length;
        if (distanceSq(p2, nextPoints[i2]) <= tolSq2) {
          breakIndex2 = i2;
        } else if (distanceSq(p2, nextPoints[nextI2]) <= tolSq2) {
          breakIndex2 = nextI2;
        } else {
          const insertIndex2 = i2 + 1;
          nextPoints.splice(insertIndex2, 0, p2);
          breakIndex2 = insertIndex2;
          if (insertIndex2 <= breakIndex) {
            breakIndex += 1;
          }
        }

        if (breakIndex2 === breakIndex) {
          return { ok: false, changed: false, error_code: 'BREAK_AT_ENDPOINT', message: 'Break: invalid two-point range' };
        }

        const before = cloneValue(entity);
        const n = nextPoints.length;

        const walkForward = (start, end) => {
          const out = [start];
          let cursor = start;
          while (cursor !== end) {
            cursor = (cursor + 1) % n;
            out.push(cursor);
            if (out.length > n + 1) break;
          }
          return out;
        };

        const pathLength = (pts) => {
          let sum = 0;
          for (let iLen = 0; iLen + 1 < pts.length; iLen += 1) {
            const a = pts[iLen];
            const b = pts[iLen + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            sum += Math.hypot(dx, dy);
          }
          return sum;
        };

        // Two possible open polylines between pick1 and pick2 on a closed polyline:
        // - forward: walk from pick1 -> pick2 following vertex order
        // - complement: the remaining path (preserves legacy behavior)
        const forwardIdx = walkForward(breakIndex, breakIndex2);
        const complementIdx = walkForward(breakIndex2, breakIndex).reverse();
        if (forwardIdx.length < 2 || complementIdx.length < 2 || forwardIdx.length > n + 1 || complementIdx.length > n + 1) {
          return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: invalid closed two-point result' };
        }
        const forwardPts = forwardIdx.map((idx) => ({ ...nextPoints[idx] }));
        const complementPts = complementIdx.map((idx) => ({ ...nextPoints[idx] }));

        // Default behavior stays deterministic/backward-compatible: keep complement (remove pick1->pick2 along vertex order).
        let opened = complementPts;
        const keep = payload?.keep;
        if (keep === 'short' || keep === 'long') {
          const lenA = pathLength(forwardPts);
          const lenB = pathLength(complementPts);
          if (Number.isFinite(lenA) && Number.isFinite(lenB) && Math.abs(lenA - lenB) > 1e-9) {
            const chooseA = keep === 'short' ? (lenA < lenB) : (lenA > lenB);
            opened = chooseA ? forwardPts : complementPts;
          }
        }

        const created = ctx.document.addEntity({
          type: 'polyline',
          layerId: before.layerId,
          color: before.color,
          visible: before.visible,
          name: before.name ? `${before.name}_BRK` : '',
          closed: false,
          points: opened,
        });
        if (!created) {
          return { ok: false, changed: false, error_code: 'BREAK_FAILED', message: 'Break: failed closed two-point split' };
        }
        ctx.document.removeEntity(entity.id);
        ctx.selection.setSelection([created.id], created.id);
        return { ok: true, changed: true, message: 'Break(two-point) split closed polyline' };
      }
      const before = cloneValue(entity);
      const n = nextPoints.length;
      if (n < 3) {
        return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: closed polyline too short' };
      }
      const opened = [];
      opened.push({ ...nextPoints[breakIndex] });
      let cursor = (breakIndex + 1) % n;
      while (cursor !== breakIndex) {
        opened.push({ ...nextPoints[cursor] });
        cursor = (cursor + 1) % n;
      }
      // Open curve keeps both ends at break point after split.
      opened.push({ ...nextPoints[breakIndex] });
      if (opened.length < 3) {
        return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: degenerate closed break result' };
      }

      const created = ctx.document.addEntity({
        type: 'polyline',
        layerId: before.layerId,
        color: before.color,
        visible: before.visible,
        name: before.name ? `${before.name}_BRK` : '',
        closed: false,
        points: opened,
      });
      if (!created) {
        return { ok: false, changed: false, error_code: 'BREAK_FAILED', message: 'Break: failed to open closed polyline' };
      }
      ctx.document.removeEntity(entity.id);
      ctx.selection.setSelection([created.id], created.id);
      return { ok: true, changed: true, message: 'Break opened closed polyline' };
    }

    if (breakIndex <= 0 || breakIndex >= nextPoints.length - 1) {
      return { ok: false, changed: false, error_code: 'BREAK_AT_ENDPOINT', message: 'Break: pick away from endpoints' };
    }

    if (hasPick2) {
      let best2 = null;
      for (let i2scan = 0; i2scan < nextPoints.length - 1; i2scan += 1) {
        const a2 = nextPoints[i2scan];
        const b2 = nextPoints[i2scan + 1];
        const projected2 = projectPointToSegment(pick2, a2, b2);
        if (!best2 || projected2.distSq < best2.projected.distSq) {
          best2 = { index: i2scan, projected: projected2 };
        }
      }
      if (!best2) {
        return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: no second segment found' };
      }
      const i2 = best2.index;
      const p2 = best2.projected.point;
      let breakIndex2;
      const tolSq2 = 1e-12;
      if (distanceSq(p2, nextPoints[i2]) <= tolSq2) {
        breakIndex2 = i2;
      } else if (distanceSq(p2, nextPoints[(i2 + 1) % nextPoints.length]) <= tolSq2) {
        breakIndex2 = (i2 + 1) % nextPoints.length;
      } else {
        const insertIndex2 = i2 + 1;
        nextPoints.splice(insertIndex2, 0, p2);
        breakIndex2 = insertIndex2;
        if (insertIndex2 <= breakIndex) {
          breakIndex += 1;
        }
      }
      const left = Math.min(breakIndex, breakIndex2);
      const right = Math.max(breakIndex, breakIndex2);
      if (left <= 0 || right >= nextPoints.length - 1 || right - left <= 0) {
        return { ok: false, changed: false, error_code: 'BREAK_AT_ENDPOINT', message: 'Break: invalid two-point range' };
      }
      const aPoints2 = nextPoints.slice(0, left + 1);
      const bPoints2 = nextPoints.slice(right);
      if (aPoints2.length < 2 || bPoints2.length < 2) {
        return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: invalid two-point result' };
      }
      const before = cloneValue(entity);
      const createdTwo = ctx.document.addEntities([
        {
          type: 'polyline',
          layerId: before.layerId,
          color: before.color,
          visible: before.visible,
          name: before.name ? `${before.name}_A` : '',
          closed: false,
          points: aPoints2,
        },
        {
          type: 'polyline',
          layerId: before.layerId,
          color: before.color,
          visible: before.visible,
          name: before.name ? `${before.name}_B` : '',
          closed: false,
          points: bPoints2,
        },
      ]);
      if (createdTwo.length === 0) {
        return { ok: false, changed: false, error_code: 'BREAK_FAILED', message: 'Break: failed two-point split' };
      }
      ctx.document.removeEntity(entity.id);
      ctx.selection.setSelection(createdTwo.map((e) => e.id), createdTwo[0]?.id ?? null);
      return { ok: true, changed: true, message: `Break(two-point) created ${createdTwo.length} entities` };
    }

    const aPoints = nextPoints.slice(0, breakIndex + 1);
    const bPoints = nextPoints.slice(breakIndex);
    if (aPoints.length < 2 || bPoints.length < 2) {
      return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Break: degenerate result' };
    }

    const before = cloneValue(entity);
    const created = ctx.document.addEntities([
      {
        type: 'polyline',
        layerId: before.layerId,
        color: before.color,
        visible: before.visible,
        name: before.name ? `${before.name}_A` : '',
        closed: false,
        points: aPoints,
      },
      {
        type: 'polyline',
        layerId: before.layerId,
        color: before.color,
        visible: before.visible,
        name: before.name ? `${before.name}_B` : '',
        closed: false,
        points: bPoints,
      },
    ]);
    if (created.length === 0) {
      return { ok: false, changed: false, error_code: 'BREAK_FAILED', message: 'Break: failed to create polylines' };
    }
    ctx.document.removeEntity(entity.id);
    ctx.selection.setSelection(created.map((e) => e.id), created[0]?.id ?? null);
    return { ok: true, changed: true, message: `Break created ${created.length} entities` };
  }

  return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: `Break: unsupported type ${entity.type}` };
}

function endpointsForJoin(entity) {
  if (!entity) return null;
  if (entity.type === 'line') {
    return { kind: 'line', start: entity.start, end: entity.end, points: [entity.start, entity.end] };
  }
  if (entity.type === 'polyline' && Array.isArray(entity.points) && entity.points.length >= 2 && entity.closed !== true) {
    return { kind: 'polyline', start: entity.points[0], end: entity.points[entity.points.length - 1], points: entity.points };
  }
  return null;
}

function reversePoints(points) {
  return [...points].map((p) => ({ ...p })).reverse();
}

function normalizeVectorSafe(v) {
  const len = Math.hypot(Number(v?.x), Number(v?.y));
  if (!Number.isFinite(len) || len <= 1e-9) return null;
  return { x: v.x / len, y: v.y / len };
}

function pickLineNearFarEndpoints(line, intersection) {
  const a = line.start;
  const b = line.end;
  const da = distanceSq(a, intersection);
  const db = distanceSq(b, intersection);
  if (da <= db) {
    return { nearKey: 'start', near: a, far: b };
  }
  return { nearKey: 'end', near: b, far: a };
}

function pickLineKeepTrimEndpointsByPick(line, intersection, pick) {
  const I = intersection;
  const projected = projectPointToSegment(pick, line.start, line.end).point;
  const dir = normalizeVectorSafe({ x: projected.x - I.x, y: projected.y - I.y });
  const ds = distanceSq(line.start, I);
  const de = distanceSq(line.end, I);

  let keepKey = null;
  if (!dir) {
    // If pick is at the intersection, fall back to the farther endpoint from the intersection.
    keepKey = ds >= de ? 'start' : 'end';
  } else {
    const sVec = { x: line.start.x - I.x, y: line.start.y - I.y };
    const eVec = { x: line.end.x - I.x, y: line.end.y - I.y };
    const scoreS = sVec.x * dir.x + sVec.y * dir.y;
    const scoreE = eVec.x * dir.x + eVec.y * dir.y;
    keepKey = scoreS >= scoreE ? 'start' : 'end';
  }

  const keep = keepKey === 'start' ? line.start : line.end;
  const trimKey = keepKey === 'start' ? 'end' : 'start';
  const v = normalizeVectorSafe({ x: keep.x - I.x, y: keep.y - I.y });
  if (!v) {
    return null;
  }
  const lenKeep = keepKey === 'start' ? Math.sqrt(ds) : Math.sqrt(de);
  if (!Number.isFinite(lenKeep) || lenKeep <= 1e-9) {
    return null;
  }
  return { keepKey, trimKey, v, lenKeep };
}

function resolvePickSegmentRef(entity, pick) {
  if (!entity) return null;
  if (entity.type === 'line') {
    return {
      kind: 'line',
      entity,
      layerId: entity.layerId,
      segStart: entity.start,
      segEnd: entity.end,
      segIndex: null,
      startIndex: null,
      endIndex: null,
      closed: false,
    };
  }
  if (entity.type === 'polyline' && Array.isArray(entity.points) && entity.points.length >= 2) {
    const segs = extractLineSegments(entity);
    let best = null;
    for (const seg of segs) {
      const projected = projectPointToSegment(pick, seg.start, seg.end);
      if (!best || projected.distSq < best.projected.distSq) {
        best = { seg, projected };
      }
    }
    if (!best) return null;
    const n = entity.points.length;
    const segIndex = Number(best.seg.index);
    if (!Number.isFinite(segIndex) || segIndex < 0) return null;
    const closed = entity.closed === true;
    const startIndex = segIndex;
    const endIndex = closed ? ((segIndex + 1) % n) : (segIndex + 1);
    if (!Number.isFinite(endIndex) || endIndex < 0 || endIndex >= n) return null;
    return {
      kind: 'polyline',
      entity,
      layerId: entity.layerId,
      segStart: best.seg.start,
      segEnd: best.seg.end,
      segIndex,
      startIndex,
      endIndex,
      closed,
    };
  }
  if (entity.type === 'arc') {
    const cx = entity.center?.x;
    const cy = entity.center?.y;
    const r = Number(entity.radius || 0);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || r <= EPSILON) return null;
    return {
      kind: 'arc',
      entity,
      layerId: entity.layerId,
      cx,
      cy,
      r,
      startAngle: Number(entity.startAngle || 0),
      endAngle: Number(entity.endAngle || 0),
      cw: entity.cw === true,
    };
  }
  if (entity.type === 'circle') {
    const cx = entity.center?.x;
    const cy = entity.center?.y;
    const r = Number(entity.radius || 0);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || r <= EPSILON) return null;
    return {
      kind: 'circle',
      entity,
      layerId: entity.layerId,
      cx,
      cy,
      r,
      pickAngle: angleFrom({ x: cx, y: cy }, pick),
    };
  }
  return null;
}

function makePolylineSegmentRef(baseTarget, points, segIndex, closed) {
  if (!baseTarget || baseTarget.kind !== 'polyline') return null;
  if (!Array.isArray(points) || points.length < 2) return null;
  if (!Number.isFinite(segIndex) || segIndex < 0) return null;
  const n = points.length;
  if (segIndex >= n) return null;
  const startIndex = segIndex;
  const endIndex = closed ? ((segIndex + 1) % n) : (segIndex + 1);
  if (!Number.isFinite(endIndex) || endIndex < 0 || endIndex >= n) return null;
  return {
    kind: 'polyline',
    entity: baseTarget.entity,
    layerId: baseTarget.layerId,
    segStart: points[startIndex],
    segEnd: points[endIndex],
    segIndex,
    startIndex,
    endIndex,
    closed,
  };
}

function isOpenPolylineEndpointIndex(entity, index) {
  if (!entity || entity.type !== 'polyline' || entity.closed === true) return false;
  if (!Array.isArray(entity.points) || entity.points.length < 2) return false;
  return index === 0 || index === entity.points.length - 1;
}

function trimOpenPolylineBySegmentKeepKey(entity, startIndex, endIndex, keepKey, point) {
  if (!entity || entity.type !== 'polyline' || entity.closed === true) return null;
  if (!Array.isArray(entity.points) || entity.points.length < 2) return null;
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return null;
  const points = entity.points.map((p) => ({ ...p }));
  if (startIndex < 0 || startIndex >= points.length || endIndex < 0 || endIndex >= points.length) return null;

  if (keepKey === 'start') {
    const out = points.slice(0, startIndex + 1);
    out.push({ ...point });
    return out.length >= 2 ? out : null;
  }
  if (keepKey === 'end') {
    const out = [{ ...point }, ...points.slice(endIndex)];
    return out.length >= 2 ? out : null;
  }
  return null;
}

function trimClosedPolylineBySegmentInsertPoint(entity, startIndex, endIndex, point) {
  if (!entity || entity.type !== 'polyline' || entity.closed !== true) return null;
  if (!Array.isArray(entity.points) || entity.points.length < 3) return null;
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return null;
  const points = entity.points.map((p) => ({ ...p }));
  if (startIndex < 0 || startIndex >= points.length || endIndex < 0 || endIndex >= points.length) return null;
  if (endIndex !== ((startIndex + 1) % points.length)) return null;
  const insertPoint = { ...point };
  if (startIndex === points.length - 1 && endIndex === 0) {
    points.push(insertPoint);
    return points;
  }
  points.splice(endIndex, 0, insertPoint);
  return points;
}

function normalizeRad(angle) {
  let value = Number(angle || 0);
  while (value < 0) value += Math.PI * 2;
  while (value >= Math.PI * 2) value -= Math.PI * 2;
  return value;
}

function resolveArcDirection(startAngle, endAngle) {
  const a0 = normalizeRad(startAngle);
  const a1 = normalizeRad(endAngle);
  const sweepCw = (a1 - a0 + Math.PI * 2) % (Math.PI * 2);
  const sweepCcw = (a0 - a1 + Math.PI * 2) % (Math.PI * 2);
  return sweepCw <= sweepCcw;
}

function trimArcToPoint(arcEntity, trimAngle, keepSide) {
  // keepSide: 'start' keeps from startAngle to trimAngle, 'end' keeps from trimAngle to endAngle
  const next = cloneValue(arcEntity);
  if (keepSide === 'start') {
    next.endAngle = trimAngle;
  } else {
    next.startAngle = trimAngle;
  }
  return next;
}

function isAngleInSweep(startAngle, endAngle, cw, angle) {
  const normalized = normalizeAngle(angle);
  const sweepStart = cw ? normalizeAngle(startAngle) : normalizeAngle(endAngle);
  const sweepEnd = cw ? normalizeAngle(endAngle) : normalizeAngle(startAngle);
  if (sweepStart <= sweepEnd) {
    return normalized >= sweepStart - EPSILON && normalized <= sweepEnd + EPSILON;
  }
  return normalized >= sweepStart - EPSILON || normalized <= sweepEnd + EPSILON;
}

function trimCircleToArc(circleEntity, tangentAngle, pickAngle) {
  const next = cloneValue(circleEntity);
  const gap = 1e-3;
  const candidateA = {
    ...next,
    type: 'arc',
    startAngle: normalizeAngle(tangentAngle + gap),
    endAngle: normalizeAngle(tangentAngle - gap),
    cw: true,
  };
  const candidateB = {
    ...next,
    type: 'arc',
    startAngle: normalizeAngle(tangentAngle - gap),
    endAngle: normalizeAngle(tangentAngle + gap),
    cw: false,
  };
  const pick = normalizeAngle(pickAngle);
  const pickInA = isAngleInSweep(candidateA.startAngle, candidateA.endAngle, candidateA.cw, pick);
  const pickInB = isAngleInSweep(candidateB.startAngle, candidateB.endAngle, candidateB.cw, pick);
  if (pickInA && !pickInB) return candidateA;
  if (pickInB && !pickInA) return candidateB;
  return candidateA;
}

/**
 * P2.3: Transfer constraints from trimmed entity endpoints to fillet arc tangent points.
 * When a fillet trims two entities at their intersection and inserts an arc,
 * constraints referencing the old intersection vertex should be remapped to the
 * arc's start/end points (the tangent points).
 *
 * @param {object} ctx - command context with document
 * @param {number} entity1Id - first trimmed entity id
 * @param {number} entity2Id - second trimmed entity id
 * @param {{x:number,y:number}} oldVertex - the original intersection point
 * @param {number} arcId - the new fillet arc entity id
 * @param {{x:number,y:number}} arcStart - arc tangent point on entity1
 * @param {{x:number,y:number}} arcEnd - arc tangent point on entity2
 */
function transferFilletConstraints(ctx, entity1Id, entity2Id, oldVertex, arcId, arcStart, arcEnd) {
  if (!ctx.document?.listConstraints) return;
  const constraints = ctx.document.listConstraints();
  if (!constraints || constraints.length === 0) return;
  const tol = 1e-6;
  const near = (a, b) => a && b && Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol;

  for (const c of constraints) {
    if (!Array.isArray(c.refs) || c.refs.length < 2) continue;
    // Check if any ref pair (x,y) references oldVertex on entity1 or entity2
    for (let i = 0; i + 1 < c.refs.length; i += 2) {
      const refX = c.refs[i];
      const refY = c.refs[i + 1];
      if (typeof refX !== 'string' || typeof refY !== 'string') continue;
      // Parse "entityId.param" pattern
      const matchX = refX.match(/^(\d+)\.(x|start_x|end_x|cx)$/);
      const matchY = refY.match(/^(\d+)\.(y|start_y|end_y|cy)$/);
      if (!matchX || !matchY) continue;
      const refEntityId = Number(matchX[1]);
      if (refEntityId !== entity1Id && refEntityId !== entity2Id) continue;
      // Get the referenced point value
      const ent = ctx.document.getEntity(refEntityId);
      if (!ent) continue;
      let refPoint = null;
      if (ent.type === 'line') {
        if (matchX[2] === 'start_x' || matchX[2] === 'x') refPoint = ent.start;
        if (matchX[2] === 'end_x') refPoint = ent.end;
      }
      if (!refPoint || !near(refPoint, oldVertex)) continue;
      // Remap: point on entity1 → arcStart, point on entity2 → arcEnd
      const newPoint = (refEntityId === entity1Id) ? arcStart : arcEnd;
      if (!newPoint) continue;
      // Update the constraint refs to point to the arc entity
      const newRefX = `${arcId}.${refEntityId === entity1Id ? 'start_x' : 'end_x'}`;
      const newRefY = `${arcId}.${refEntityId === entity1Id ? 'start_y' : 'end_y'}`;
      c.refs[i] = newRefX;
      c.refs[i + 1] = newRefY;
      // Persist the updated constraint
      if (ctx.document.removeConstraint && ctx.document.addConstraint) {
        ctx.document.removeConstraint(c.id);
        ctx.document.addConstraint(c);
      }
      break; // only remap one vertex per constraint
    }
  }
}

function runFilletLineArc(ctx, lineTgt, arcTgt, linePick, radius) {
  const lineEnt = lineTgt.entity;
  const arcEnt = arcTgt.entity;
  const cx = arcTgt.cx;
  const cy = arcTgt.cy;
  const arcR = arcTgt.r;

  // Find closest point on line to arc center
  const lineDir = subtract(lineEnt.end, lineEnt.start);
  const lineUnit = normalizeVector(lineDir);
  if (!lineUnit) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: degenerate line' };
  }
  const lineNorm = perpendicular(lineUnit);

  // Signed distance from arc center to line
  const toCenter = subtract({ x: cx, y: cy }, lineEnt.start);
  const signedDist = dot(toCenter, lineNorm);
  const absDist = Math.abs(signedDist);

  // Determine fillet center: offset line by ±radius, offset arc by ±radius, find intersection
  // The fillet center lies at distance `radius` from the line and `arcR ± radius` from arc center
  const lineSign = signedDist >= 0 ? 1 : -1;

  // Two possible arc offsets: inside (arcR - radius) and outside (arcR + radius)
  const candidates = [];
  for (const arcSign of [-1, 1]) {
    const offsetR = arcR + arcSign * radius;
    if (offsetR < EPSILON) continue;

    // Fillet center: distance `radius` from line on the arc-center side, distance `offsetR` from arc center
    // Line offset: move line by lineSign*radius in normal direction
    const offsetLineOrigin = add(lineEnt.start, scale(lineNorm, lineSign * radius));

    // Find intersections of offset line with circle of radius offsetR around arc center
    const offsetLineEnd = add(lineEnt.end, scale(lineNorm, lineSign * radius));
    const hits = lineArcIntersection(offsetLineOrigin, offsetLineEnd, cx, cy, offsetR);

    for (const hit of hits) {
      const fc = { x: hit.x, y: hit.y };

      // Tangent point on line: project fillet center onto original line
      const toFc = subtract(fc, lineEnt.start);
      const tLine = dot(toFc, lineUnit);
      const tangentOnLine = add(lineEnt.start, scale(lineUnit, tLine));

      // Tangent point on arc: point on arc at distance arcR from arc center, in direction of fillet center
      const fcToArcCenter = subtract({ x: cx, y: cy }, fc);
      const fcToArcCenterUnit = normalizeVector(fcToArcCenter);
      if (!fcToArcCenterUnit) continue;
      const tangentOnArc = arcSign > 0
        ? add(fc, scale(fcToArcCenterUnit, radius))
        : subtract(fc, scale(fcToArcCenterUnit, radius));

      // Verify tangent point on arc is within arc sweep
      const tangentAngle = normalizeAngle(angleFrom({ x: cx, y: cy }, tangentOnArc));
      const arcStart = normalizeAngle(arcTgt.startAngle);
      const arcEnd = normalizeAngle(arcTgt.endAngle);
      const arcCw = arcTgt.cw;
      const sweepStart = arcCw ? arcStart : arcEnd;
      const sweepEnd = arcCw ? arcEnd : arcStart;
      let inSweep;
      if (sweepStart <= sweepEnd) {
        inSweep = tangentAngle >= sweepStart - EPSILON && tangentAngle <= sweepEnd + EPSILON;
      } else {
        inSweep = tangentAngle >= sweepStart - EPSILON || tangentAngle <= sweepEnd + EPSILON;
      }
      if (!inSweep) continue;

      // Verify tangent point on line is within segment
      if (tLine < -EPSILON || tLine > Math.sqrt(dot(lineDir, lineDir)) + EPSILON) continue;

      // Pick closest candidate to linePick
      const score = distanceSq(linePick, tangentOnLine);
      candidates.push({ fc, tangentOnLine, tangentOnArc, tangentAngle, tLine, score, arcSign });
    }
  }

  if (candidates.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: no valid fillet geometry for line+arc' };
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  const layer1 = ctx.document.getLayer(lineTgt.layerId);
  if (layer1?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }
  const layer2 = ctx.document.getLayer(arcTgt.layerId);
  if (layer2?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }

  // Trim line: keep the side closest to linePick
  const dToStart = distanceSq(linePick, lineEnt.start);
  const dToEnd = distanceSq(linePick, lineEnt.end);
  const lineKeepStart = dToStart < dToEnd;
  const linePatch = lineKeepStart
    ? { end: { ...best.tangentOnLine } }
    : { start: { ...best.tangentOnLine } };
  const ok1 = ctx.document.updateEntity(lineEnt.id, { ...lineEnt, ...linePatch });

  // Trim arc: keep the side farther from the tangent point
  const tangentAngleVal = best.tangentAngle;
  const arcStartAngle = arcTgt.startAngle;
  const arcEndAngle = arcTgt.endAngle;
  const dToArcStart = Math.abs(angleDelta(tangentAngleVal, arcStartAngle));
  const dToArcEnd = Math.abs(angleDelta(tangentAngleVal, arcEndAngle));
  const trimmedArc = dToArcStart < dToArcEnd
    ? trimArcToPoint(arcEnt, tangentAngleVal, 'end')
    : trimArcToPoint(arcEnt, tangentAngleVal, 'start');
  const ok2 = ctx.document.updateEntity(arcEnt.id, trimmedArc);

  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to trim entities' };
  }

  // Create fillet arc
  const filletStartAngle = angleFrom(best.fc, best.tangentOnLine);
  const filletEndAngle = angleFrom(best.fc, best.tangentOnArc);
  const filletCw = resolveArcDirection(filletStartAngle, filletEndAngle);
  const filletArc = ctx.document.addEntity({
    type: 'arc',
    layerId: lineEnt.layerId,
    color: lineEnt.color,
    visible: lineEnt.visible,
    center: best.fc,
    radius,
    startAngle: filletStartAngle,
    endAngle: filletEndAngle,
    cw: filletCw,
  });
  if (!filletArc) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create fillet arc' };
  }

  ctx.selection.setSelection([lineEnt.id, arcEnt.id, filletArc.id], filletArc.id);
  return { ok: true, changed: true, message: 'Fillet applied (line+arc)' };
}

function runFilletArcArc(ctx, arc1Tgt, arc2Tgt, pick1, pick2, radius) {
  const c1x = arc1Tgt.cx, c1y = arc1Tgt.cy, r1 = arc1Tgt.r;
  const c2x = arc2Tgt.cx, c2y = arc2Tgt.cy, r2 = arc2Tgt.r;
  const arc1Ent = arc1Tgt.entity;
  const arc2Ent = arc2Tgt.entity;

  const dx = c2x - c1x;
  const dy = c2y - c1y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < EPSILON) {
    return { ok: false, changed: false, error_code: 'CONCENTRIC', message: 'Fillet: concentric arcs' };
  }

  const candidates = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      const R1 = r1 + s1 * radius;
      const R2 = r2 + s2 * radius;
      if (R1 < EPSILON || R2 < EPSILON) continue;

      // Circle-circle intersection: offset arc1 with R1, offset arc2 with R2
      if (d > R1 + R2 + EPSILON || d < Math.abs(R1 - R2) - EPSILON) continue;
      const a = (R1 * R1 - R2 * R2 + d * d) / (2 * d);
      const h2 = R1 * R1 - a * a;
      if (h2 < -EPSILON) continue;
      const h = Math.sqrt(Math.max(0, h2));

      const ux = dx / d;
      const uy = dy / d;
      const mx = c1x + a * ux;
      const my = c1y + a * uy;
      const px = -uy;
      const py = ux;

      const points = h < EPSILON
        ? [{ x: mx, y: my }]
        : [{ x: mx + h * px, y: my + h * py }, { x: mx - h * px, y: my - h * py }];

      for (const fc of points) {
        // Tangent point on arc1
        const dir1 = { x: c1x - fc.x, y: c1y - fc.y };
        const len1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y);
        if (len1 < EPSILON) continue;
        const u1 = { x: dir1.x / len1, y: dir1.y / len1 };
        const tangent1 = s1 > 0
          ? { x: fc.x + radius * u1.x, y: fc.y + radius * u1.y }
          : { x: fc.x - radius * u1.x, y: fc.y - radius * u1.y };

        // Tangent point on arc2
        const dir2 = { x: c2x - fc.x, y: c2y - fc.y };
        const len2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y);
        if (len2 < EPSILON) continue;
        const u2 = { x: dir2.x / len2, y: dir2.y / len2 };
        const tangent2 = s2 > 0
          ? { x: fc.x + radius * u2.x, y: fc.y + radius * u2.y }
          : { x: fc.x - radius * u2.x, y: fc.y - radius * u2.y };

        // Verify tangent points are within arc sweeps
        const angle1 = normalizeAngle(Math.atan2(tangent1.y - c1y, tangent1.x - c1x));
        const sw1s = arc1Tgt.cw ? normalizeAngle(arc1Tgt.startAngle) : normalizeAngle(arc1Tgt.endAngle);
        const sw1e = arc1Tgt.cw ? normalizeAngle(arc1Tgt.endAngle) : normalizeAngle(arc1Tgt.startAngle);
        const in1 = sw1s <= sw1e
          ? angle1 >= sw1s - EPSILON && angle1 <= sw1e + EPSILON
          : angle1 >= sw1s - EPSILON || angle1 <= sw1e + EPSILON;
        if (!in1) continue;

        const angle2 = normalizeAngle(Math.atan2(tangent2.y - c2y, tangent2.x - c2x));
        const sw2s = arc2Tgt.cw ? normalizeAngle(arc2Tgt.startAngle) : normalizeAngle(arc2Tgt.endAngle);
        const sw2e = arc2Tgt.cw ? normalizeAngle(arc2Tgt.endAngle) : normalizeAngle(arc2Tgt.startAngle);
        const in2 = sw2s <= sw2e
          ? angle2 >= sw2s - EPSILON && angle2 <= sw2e + EPSILON
          : angle2 >= sw2s - EPSILON || angle2 <= sw2e + EPSILON;
        if (!in2) continue;

        const score = distanceSq(pick1, tangent1) + distanceSq(pick2, tangent2);
        candidates.push({ fc, tangent1, tangent2, angle1, angle2, score });
      }
    }
  }

  if (candidates.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: no valid fillet geometry for arc+arc' };
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  const layer1 = ctx.document.getLayer(arc1Tgt.layerId);
  if (layer1?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }
  const layer2 = ctx.document.getLayer(arc2Tgt.layerId);
  if (layer2?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }

  // Trim arc1
  const d1s = Math.abs(angleDelta(best.angle1, arc1Tgt.startAngle));
  const d1e = Math.abs(angleDelta(best.angle1, arc1Tgt.endAngle));
  const trimmed1 = d1s < d1e
    ? trimArcToPoint(arc1Ent, best.angle1, 'end')
    : trimArcToPoint(arc1Ent, best.angle1, 'start');
  const ok1 = ctx.document.updateEntity(arc1Ent.id, trimmed1);

  // Trim arc2
  const d2s = Math.abs(angleDelta(best.angle2, arc2Tgt.startAngle));
  const d2e = Math.abs(angleDelta(best.angle2, arc2Tgt.endAngle));
  const trimmed2 = d2s < d2e
    ? trimArcToPoint(arc2Ent, best.angle2, 'end')
    : trimArcToPoint(arc2Ent, best.angle2, 'start');
  const ok2 = ctx.document.updateEntity(arc2Ent.id, trimmed2);

  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to trim arcs' };
  }

  const filletStartAngle = angleFrom(best.fc, best.tangent1);
  const filletEndAngle = angleFrom(best.fc, best.tangent2);
  const filletCw = resolveArcDirection(filletStartAngle, filletEndAngle);
  const filletArc = ctx.document.addEntity({
    type: 'arc',
    layerId: arc1Ent.layerId,
    color: arc1Ent.color,
    visible: arc1Ent.visible,
    center: best.fc,
    radius,
    startAngle: filletStartAngle,
    endAngle: filletEndAngle,
    cw: filletCw,
  });
  if (!filletArc) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create fillet arc' };
  }

  ctx.selection.setSelection([arc1Ent.id, arc2Ent.id, filletArc.id], filletArc.id);
  return { ok: true, changed: true, message: 'Fillet applied (arc+arc)' };
}

function runFilletLineCircle(ctx, lineTgt, circleTgt, linePick, circlePick, radius) {
  const lineEnt = lineTgt.entity;
  const circleEnt = circleTgt.entity;
  const cx = circleTgt.cx;
  const cy = circleTgt.cy;
  const circleR = circleTgt.r;

  const lineDir = subtract(lineEnt.end, lineEnt.start);
  const lineUnit = normalizeVector(lineDir);
  if (!lineUnit) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: degenerate line' };
  }
  const lineNorm = perpendicular(lineUnit);

  const toCenter = subtract({ x: cx, y: cy }, lineEnt.start);
  const signedDist = dot(toCenter, lineNorm);
  const lineSign = signedDist >= 0 ? 1 : -1;

  const candidates = [];
  for (const circleSign of [-1, 1]) {
    const offsetR = circleR + circleSign * radius;
    if (offsetR < EPSILON) continue;

    const offsetLineOrigin = add(lineEnt.start, scale(lineNorm, lineSign * radius));
    const offsetLineEnd = add(lineEnt.end, scale(lineNorm, lineSign * radius));
    const hits = lineArcIntersection(offsetLineOrigin, offsetLineEnd, cx, cy, offsetR);

    for (const hit of hits) {
      const fc = { x: hit.x, y: hit.y };

      const toFc = subtract(fc, lineEnt.start);
      const tLine = dot(toFc, lineUnit);
      const tangentOnLine = add(lineEnt.start, scale(lineUnit, tLine));

      const fcToCenter = subtract({ x: cx, y: cy }, fc);
      const fcToCenterUnit = normalizeVector(fcToCenter);
      if (!fcToCenterUnit) continue;
      const tangentOnCircle = circleSign > 0
        ? add(fc, scale(fcToCenterUnit, radius))
        : subtract(fc, scale(fcToCenterUnit, radius));

      // No inSweep check — every angle on a circle is valid

      if (tLine < -EPSILON || tLine > Math.sqrt(dot(lineDir, lineDir)) + EPSILON) continue;

      const tangentAngle = normalizeAngle(angleFrom({ x: cx, y: cy }, tangentOnCircle));
      const score = distanceSq(linePick, tangentOnLine) + distanceSq(circlePick, tangentOnCircle);
      candidates.push({ fc, tangentOnLine, tangentOnCircle, tangentAngle, tLine, score, circleSign });
    }
  }

  if (candidates.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: no valid fillet geometry for line+circle' };
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  const layer1 = ctx.document.getLayer(lineTgt.layerId);
  if (layer1?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }
  const layer2 = ctx.document.getLayer(circleTgt.layerId);
  if (layer2?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }

  // Trim line
  const dToStart = distanceSq(linePick, lineEnt.start);
  const dToEnd = distanceSq(linePick, lineEnt.end);
  const lineKeepStart = dToStart < dToEnd;
  const linePatch = lineKeepStart
    ? { end: { ...best.tangentOnLine } }
    : { start: { ...best.tangentOnLine } };
  const ok1 = ctx.document.updateEntity(lineEnt.id, { ...lineEnt, ...linePatch });

  // Trim circle → arc
  const trimmedCircle = trimCircleToArc(circleEnt, best.tangentAngle, circleTgt.pickAngle);
  const ok2 = ctx.document.updateEntity(circleEnt.id, trimmedCircle);

  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to trim entities' };
  }

  const filletStartAngle = angleFrom(best.fc, best.tangentOnLine);
  const filletEndAngle = angleFrom(best.fc, best.tangentOnCircle);
  const filletCw = resolveArcDirection(filletStartAngle, filletEndAngle);
  const filletArc = ctx.document.addEntity({
    type: 'arc',
    layerId: lineEnt.layerId,
    color: lineEnt.color,
    visible: lineEnt.visible,
    center: best.fc,
    radius,
    startAngle: filletStartAngle,
    endAngle: filletEndAngle,
    cw: filletCw,
  });
  if (!filletArc) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create fillet arc' };
  }

  ctx.selection.setSelection([lineEnt.id, circleEnt.id, filletArc.id], filletArc.id);
  return { ok: true, changed: true, message: 'Fillet applied (line+circle)' };
}

function runFilletCircleArc(ctx, circleTgt, arcTgt, circlePick, arcPick, radius) {
  const c1x = circleTgt.cx, c1y = circleTgt.cy, r1 = circleTgt.r;
  const c2x = arcTgt.cx, c2y = arcTgt.cy, r2 = arcTgt.r;
  const circleEnt = circleTgt.entity;
  const arcEnt = arcTgt.entity;

  const dx = c2x - c1x;
  const dy = c2y - c1y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < EPSILON) {
    return { ok: false, changed: false, error_code: 'CONCENTRIC', message: 'Fillet: concentric circle and arc' };
  }

  const candidates = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      const R1 = r1 + s1 * radius;
      const R2 = r2 + s2 * radius;
      if (R1 < EPSILON || R2 < EPSILON) continue;

      if (d > R1 + R2 + EPSILON || d < Math.abs(R1 - R2) - EPSILON) continue;
      const a = (R1 * R1 - R2 * R2 + d * d) / (2 * d);
      const h2 = R1 * R1 - a * a;
      if (h2 < -EPSILON) continue;
      const h = Math.sqrt(Math.max(0, h2));

      const ux = dx / d;
      const uy = dy / d;
      const mx = c1x + a * ux;
      const my = c1y + a * uy;
      const px = -uy;
      const py = ux;

      const points = h < EPSILON
        ? [{ x: mx, y: my }]
        : [{ x: mx + h * px, y: my + h * py }, { x: mx - h * px, y: my - h * py }];

      for (const fc of points) {
        // Tangent on circle — no sweep check
        const dir1 = { x: c1x - fc.x, y: c1y - fc.y };
        const len1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y);
        if (len1 < EPSILON) continue;
        const u1 = { x: dir1.x / len1, y: dir1.y / len1 };
        const tangent1 = s1 > 0
          ? { x: fc.x + radius * u1.x, y: fc.y + radius * u1.y }
          : { x: fc.x - radius * u1.x, y: fc.y - radius * u1.y };

        // Tangent on arc — needs sweep check
        const dir2 = { x: c2x - fc.x, y: c2y - fc.y };
        const len2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y);
        if (len2 < EPSILON) continue;
        const u2 = { x: dir2.x / len2, y: dir2.y / len2 };
        const tangent2 = s2 > 0
          ? { x: fc.x + radius * u2.x, y: fc.y + radius * u2.y }
          : { x: fc.x - radius * u2.x, y: fc.y - radius * u2.y };

        const angle2 = normalizeAngle(Math.atan2(tangent2.y - c2y, tangent2.x - c2x));
        if (!isAngleInSweep(arcTgt.startAngle, arcTgt.endAngle, arcTgt.cw, angle2)) continue;

        const angle1 = normalizeAngle(Math.atan2(tangent1.y - c1y, tangent1.x - c1x));
        const score = distanceSq(circlePick, tangent1) + distanceSq(arcPick, tangent2);
        candidates.push({ fc, tangent1, tangent2, angle1, angle2, score });
      }
    }
  }

  if (candidates.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: no valid fillet geometry for circle+arc' };
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  const layer1 = ctx.document.getLayer(circleTgt.layerId);
  if (layer1?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }
  const layer2 = ctx.document.getLayer(arcTgt.layerId);
  if (layer2?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }

  // Trim circle → arc
  const trimmedCircle = trimCircleToArc(circleEnt, best.angle1, circleTgt.pickAngle);
  const ok1 = ctx.document.updateEntity(circleEnt.id, trimmedCircle);

  // Trim arc
  const d2s = Math.abs(angleDelta(best.angle2, arcTgt.startAngle));
  const d2e = Math.abs(angleDelta(best.angle2, arcTgt.endAngle));
  const trimmed2 = d2s < d2e
    ? trimArcToPoint(arcEnt, best.angle2, 'end')
    : trimArcToPoint(arcEnt, best.angle2, 'start');
  const ok2 = ctx.document.updateEntity(arcEnt.id, trimmed2);

  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to trim entities' };
  }

  const filletStartAngle = angleFrom(best.fc, best.tangent1);
  const filletEndAngle = angleFrom(best.fc, best.tangent2);
  const filletCw = resolveArcDirection(filletStartAngle, filletEndAngle);
  const filletArc = ctx.document.addEntity({
    type: 'arc',
    layerId: circleEnt.layerId,
    color: circleEnt.color,
    visible: circleEnt.visible,
    center: best.fc,
    radius,
    startAngle: filletStartAngle,
    endAngle: filletEndAngle,
    cw: filletCw,
  });
  if (!filletArc) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create fillet arc' };
  }

  ctx.selection.setSelection([circleEnt.id, arcEnt.id, filletArc.id], filletArc.id);
  return { ok: true, changed: true, message: 'Fillet applied (circle+arc)' };
}

function runFilletCircleCircle(ctx, circle1Tgt, circle2Tgt, pick1, pick2, radius) {
  const c1x = circle1Tgt.cx, c1y = circle1Tgt.cy, r1 = circle1Tgt.r;
  const c2x = circle2Tgt.cx, c2y = circle2Tgt.cy, r2 = circle2Tgt.r;
  const circle1Ent = circle1Tgt.entity;
  const circle2Ent = circle2Tgt.entity;

  const dx = c2x - c1x;
  const dy = c2y - c1y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < EPSILON) {
    return { ok: false, changed: false, error_code: 'CONCENTRIC', message: 'Fillet: concentric circles' };
  }

  const candidates = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      const R1 = r1 + s1 * radius;
      const R2 = r2 + s2 * radius;
      if (R1 < EPSILON || R2 < EPSILON) continue;

      if (d > R1 + R2 + EPSILON || d < Math.abs(R1 - R2) - EPSILON) continue;
      const a = (R1 * R1 - R2 * R2 + d * d) / (2 * d);
      const h2 = R1 * R1 - a * a;
      if (h2 < -EPSILON) continue;
      const h = Math.sqrt(Math.max(0, h2));

      const ux = dx / d;
      const uy = dy / d;
      const mx = c1x + a * ux;
      const my = c1y + a * uy;
      const px = -uy;
      const py = ux;

      const points = h < EPSILON
        ? [{ x: mx, y: my }]
        : [{ x: mx + h * px, y: my + h * py }, { x: mx - h * px, y: my - h * py }];

      for (const fc of points) {
        // Tangent on circle 1 — no sweep check
        const dir1 = { x: c1x - fc.x, y: c1y - fc.y };
        const len1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y);
        if (len1 < EPSILON) continue;
        const u1 = { x: dir1.x / len1, y: dir1.y / len1 };
        const tangent1 = s1 > 0
          ? { x: fc.x + radius * u1.x, y: fc.y + radius * u1.y }
          : { x: fc.x - radius * u1.x, y: fc.y - radius * u1.y };

        // Tangent on circle 2 — no sweep check
        const dir2 = { x: c2x - fc.x, y: c2y - fc.y };
        const len2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y);
        if (len2 < EPSILON) continue;
        const u2 = { x: dir2.x / len2, y: dir2.y / len2 };
        const tangent2 = s2 > 0
          ? { x: fc.x + radius * u2.x, y: fc.y + radius * u2.y }
          : { x: fc.x - radius * u2.x, y: fc.y - radius * u2.y };

        const angle1 = normalizeAngle(Math.atan2(tangent1.y - c1y, tangent1.x - c1x));
        const angle2 = normalizeAngle(Math.atan2(tangent2.y - c2y, tangent2.x - c2x));
        const score = distanceSq(pick1, tangent1) + distanceSq(pick2, tangent2);
        candidates.push({ fc, tangent1, tangent2, angle1, angle2, score });
      }
    }
  }

  if (candidates.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: no valid fillet geometry for circle+circle' };
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  const layer1 = ctx.document.getLayer(circle1Tgt.layerId);
  if (layer1?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }
  const layer2 = ctx.document.getLayer(circle2Tgt.layerId);
  if (layer2?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }

  // Trim both circles → arcs
  const trimmed1 = trimCircleToArc(circle1Ent, best.angle1, circle1Tgt.pickAngle);
  const ok1 = ctx.document.updateEntity(circle1Ent.id, trimmed1);

  const trimmed2 = trimCircleToArc(circle2Ent, best.angle2, circle2Tgt.pickAngle);
  const ok2 = ctx.document.updateEntity(circle2Ent.id, trimmed2);

  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to trim circles' };
  }

  const filletStartAngle = angleFrom(best.fc, best.tangent1);
  const filletEndAngle = angleFrom(best.fc, best.tangent2);
  const filletCw = resolveArcDirection(filletStartAngle, filletEndAngle);
  const filletArc = ctx.document.addEntity({
    type: 'arc',
    layerId: circle1Ent.layerId,
    color: circle1Ent.color,
    visible: circle1Ent.visible,
    center: best.fc,
    radius,
    startAngle: filletStartAngle,
    endAngle: filletEndAngle,
    cw: filletCw,
  });
  if (!filletArc) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create fillet arc' };
  }

  ctx.selection.setSelection([circle1Ent.id, circle2Ent.id, filletArc.id], filletArc.id);
  return { ok: true, changed: true, message: 'Fillet applied (circle+circle)' };
}

function runFilletPolylineArc(ctx, polyTgt, arcTgt, polyPick, radius) {
  const polyEnt = polyTgt.entity;
  const arcEnt = arcTgt.entity;
  const cx = arcTgt.cx;
  const cy = arcTgt.cy;
  const arcR = arcTgt.r;
  const lineStart = polyTgt.segStart;
  const lineEnd = polyTgt.segEnd;

  const lineDir = subtract(lineEnd, lineStart);
  const lineUnit = normalizeVector(lineDir);
  if (!lineUnit) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: degenerate polyline segment' };
  }
  const lineNorm = perpendicular(lineUnit);
  const toCenter = subtract({ x: cx, y: cy }, lineStart);
  const signedDist = dot(toCenter, lineNorm);
  const lineSign = signedDist >= 0 ? 1 : -1;

  const candidates = [];
  for (const arcSign of [-1, 1]) {
    const offsetR = arcR + arcSign * radius;
    if (offsetR < EPSILON) continue;

    const offsetLineOrigin = add(lineStart, scale(lineNorm, lineSign * radius));
    const offsetLineEnd = add(lineEnd, scale(lineNorm, lineSign * radius));
    const hits = lineArcIntersection(offsetLineOrigin, offsetLineEnd, cx, cy, offsetR);

    for (const hit of hits) {
      const fc = { x: hit.x, y: hit.y };
      const toFc = subtract(fc, lineStart);
      const tLine = dot(toFc, lineUnit);
      const tangentOnLine = add(lineStart, scale(lineUnit, tLine));

      const fcToArcCenter = subtract({ x: cx, y: cy }, fc);
      const fcToArcCenterUnit = normalizeVector(fcToArcCenter);
      if (!fcToArcCenterUnit) continue;
      const tangentOnArc = arcSign > 0
        ? add(fc, scale(fcToArcCenterUnit, radius))
        : subtract(fc, scale(fcToArcCenterUnit, radius));
      const tangentAngle = normalizeAngle(angleFrom({ x: cx, y: cy }, tangentOnArc));
      if (!isAngleInSweep(arcTgt.startAngle, arcTgt.endAngle, arcTgt.cw, tangentAngle)) continue;

      if (tLine < -EPSILON || tLine > Math.sqrt(dot(lineDir, lineDir)) + EPSILON) continue;
      const score = distanceSq(polyPick, tangentOnLine);
      candidates.push({ fc, tangentOnLine, tangentOnArc, tangentAngle, score });
    }
  }

  if (candidates.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: no valid fillet geometry for polyline+arc' };
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  const layer1 = ctx.document.getLayer(polyTgt.layerId);
  if (layer1?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }
  const layer2 = ctx.document.getLayer(arcTgt.layerId);
  if (layer2?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }

  const dToStart = distanceSq(polyPick, lineStart);
  const dToEnd = distanceSq(polyPick, lineEnd);
  const keepKey = dToStart < dToEnd ? 'start' : 'end';
  const isClosed = polyEnt.closed === true;
  const polyPoints = isClosed
    ? trimClosedPolylineBySegmentInsertPoint(polyEnt, polyTgt.startIndex, polyTgt.endIndex, best.tangentOnLine)
    : trimOpenPolylineBySegmentKeepKey(polyEnt, polyTgt.startIndex, polyTgt.endIndex, keepKey, best.tangentOnLine);
  if (!polyPoints) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: unsupported polyline trim' };
  }

  const ok1 = ctx.document.updateEntity(polyEnt.id, { ...polyEnt, closed: isClosed, points: polyPoints });
  const dToArcStart = Math.abs(angleDelta(best.tangentAngle, arcTgt.startAngle));
  const dToArcEnd = Math.abs(angleDelta(best.tangentAngle, arcTgt.endAngle));
  const trimmedArc = dToArcStart < dToArcEnd
    ? trimArcToPoint(arcEnt, best.tangentAngle, 'end')
    : trimArcToPoint(arcEnt, best.tangentAngle, 'start');
  const ok2 = ctx.document.updateEntity(arcEnt.id, trimmedArc);
  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to trim entities' };
  }

  const filletStartAngle = angleFrom(best.fc, best.tangentOnLine);
  const filletEndAngle = angleFrom(best.fc, best.tangentOnArc);
  const filletCw = resolveArcDirection(filletStartAngle, filletEndAngle);
  const filletArc = ctx.document.addEntity({
    type: 'arc',
    layerId: polyEnt.layerId,
    color: polyEnt.color,
    visible: polyEnt.visible,
    center: best.fc,
    radius,
    startAngle: filletStartAngle,
    endAngle: filletEndAngle,
    cw: filletCw,
  });
  if (!filletArc) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create fillet arc' };
  }

  ctx.selection.setSelection([polyEnt.id, arcEnt.id, filletArc.id], filletArc.id);
  return { ok: true, changed: true, message: 'Fillet applied (polyline+arc)' };
}

function runFilletPolylineCircle(ctx, polyTgt, circleTgt, polyPick, circlePick, radius) {
  const polyEnt = polyTgt.entity;
  const circleEnt = circleTgt.entity;
  const cx = circleTgt.cx;
  const cy = circleTgt.cy;
  const circleR = circleTgt.r;
  const lineStart = polyTgt.segStart;
  const lineEnd = polyTgt.segEnd;

  const lineDir = subtract(lineEnd, lineStart);
  const lineUnit = normalizeVector(lineDir);
  if (!lineUnit) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: degenerate polyline segment' };
  }
  const lineNorm = perpendicular(lineUnit);
  const toCenter = subtract({ x: cx, y: cy }, lineStart);
  const signedDist = dot(toCenter, lineNorm);
  const lineSign = signedDist >= 0 ? 1 : -1;

  const candidates = [];
  for (const circleSign of [-1, 1]) {
    const offsetR = circleR + circleSign * radius;
    if (offsetR < EPSILON) continue;

    const offsetLineOrigin = add(lineStart, scale(lineNorm, lineSign * radius));
    const offsetLineEnd = add(lineEnd, scale(lineNorm, lineSign * radius));
    const hits = lineArcIntersection(offsetLineOrigin, offsetLineEnd, cx, cy, offsetR);

    for (const hit of hits) {
      const fc = { x: hit.x, y: hit.y };
      const toFc = subtract(fc, lineStart);
      const tLine = dot(toFc, lineUnit);
      const tangentOnLine = add(lineStart, scale(lineUnit, tLine));

      const fcToCenter = subtract({ x: cx, y: cy }, fc);
      const fcToCenterUnit = normalizeVector(fcToCenter);
      if (!fcToCenterUnit) continue;
      const tangentOnCircle = circleSign > 0
        ? add(fc, scale(fcToCenterUnit, radius))
        : subtract(fc, scale(fcToCenterUnit, radius));

      // No sweep check — every angle on a circle is valid

      if (tLine < -EPSILON || tLine > Math.sqrt(dot(lineDir, lineDir)) + EPSILON) continue;

      const tangentAngle = normalizeAngle(angleFrom({ x: cx, y: cy }, tangentOnCircle));
      const score = distanceSq(polyPick, tangentOnLine) + distanceSq(circlePick, tangentOnCircle);
      candidates.push({ fc, tangentOnLine, tangentOnCircle, tangentAngle, score });
    }
  }

  if (candidates.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: no valid fillet geometry for polyline+circle' };
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  const layer1 = ctx.document.getLayer(polyTgt.layerId);
  if (layer1?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }
  const layer2 = ctx.document.getLayer(circleTgt.layerId);
  if (layer2?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Fillet: layer is locked' };
  }

  // Trim polyline
  const dToStart = distanceSq(polyPick, lineStart);
  const dToEnd = distanceSq(polyPick, lineEnd);
  const keepKey = dToStart < dToEnd ? 'start' : 'end';
  const isClosed = polyEnt.closed === true;
  const polyPoints = isClosed
    ? trimClosedPolylineBySegmentInsertPoint(polyEnt, polyTgt.startIndex, polyTgt.endIndex, best.tangentOnLine)
    : trimOpenPolylineBySegmentKeepKey(polyEnt, polyTgt.startIndex, polyTgt.endIndex, keepKey, best.tangentOnLine);
  if (!polyPoints) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: unsupported polyline trim' };
  }

  const ok1 = ctx.document.updateEntity(polyEnt.id, { ...polyEnt, closed: isClosed, points: polyPoints });

  // Trim circle → arc
  const trimmedCircle = trimCircleToArc(circleEnt, best.tangentAngle, circleTgt.pickAngle);
  const ok2 = ctx.document.updateEntity(circleEnt.id, trimmedCircle);

  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to trim entities' };
  }

  const filletStartAngle = angleFrom(best.fc, best.tangentOnLine);
  const filletEndAngle = angleFrom(best.fc, best.tangentOnCircle);
  const filletCw = resolveArcDirection(filletStartAngle, filletEndAngle);
  const filletArc = ctx.document.addEntity({
    type: 'arc',
    layerId: polyEnt.layerId,
    color: polyEnt.color,
    visible: polyEnt.visible,
    center: best.fc,
    radius,
    startAngle: filletStartAngle,
    endAngle: filletEndAngle,
    cw: filletCw,
  });
  if (!filletArc) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create fillet arc' };
  }

  ctx.selection.setSelection([polyEnt.id, circleEnt.id, filletArc.id], filletArc.id);
  return { ok: true, changed: true, message: 'Fillet applied (polyline+circle)' };
}

function runFilletSelectionByPick(ctx, payload) {
  const firstId = Number(payload?.firstId);
  const secondId = Number(payload?.secondId);
  const pick1 = payload?.pick1;
  const pick2 = payload?.pick2;
  if (!Number.isFinite(firstId) || !Number.isFinite(secondId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'Fillet: missing target ids' };
  }
  if (!pick1 || !Number.isFinite(pick1.x) || !Number.isFinite(pick1.y) || !pick2 || !Number.isFinite(pick2.x) || !Number.isFinite(pick2.y)) {
    return { ok: false, changed: false, error_code: 'INVALID_PICK', message: 'Fillet: missing pick points' };
  }
  let radius = Number(payload?.radius);
  if (!Number.isFinite(radius) || radius <= 1e-9) {
    return { ok: false, changed: false, error_code: 'INVALID_RADIUS', message: 'Fillet: invalid radius' };
  }

  const ent1 = ctx.document.getEntity(firstId);
  const ent2 = ctx.document.getEntity(secondId);
  let target1 = resolvePickSegmentRef(ent1, pick1);
  let target2 = resolvePickSegmentRef(ent2, pick2);
  if (!target1 || !target2) {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Fillet: unsupported target type' };
  }
  if (firstId === secondId
      && target1.kind === 'polyline'
      && target2.kind === 'polyline'
      && target1.entity.closed !== true
      && Array.isArray(target1.entity.points)
      && target1.entity.points.length === 3
      && target1.segIndex === target2.segIndex) {
    const forcedSeg = Number(target1.segIndex) === 0 ? 1 : 0;
    const forcedRef = makePolylineSegmentRef(target1, target1.entity.points, forcedSeg, false);
    if (forcedRef) {
      target2 = forcedRef;
    }
  }
  const layer1 = ctx.document.getLayer(target1.layerId);
  if (layer1?.locked) {
    const name = layer1?.name || `L${target1.layerId}`;
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Fillet: layer ${name} is locked` };
  }
  if (target2.layerId !== target1.layerId) {
    const layer2 = ctx.document.getLayer(target2.layerId);
    if (layer2?.locked) {
      const name = layer2?.name || `L${target2.layerId}`;
      return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Fillet: layer ${name} is locked` };
    }
  }

  // --- Circle dispatch ---
  const hasCircle = target1.kind === 'circle' || target2.kind === 'circle';
  const hasLine = target1.kind === 'line' || target2.kind === 'line';
  const hasArc = target1.kind === 'arc' || target2.kind === 'arc';
  if (hasCircle) {
    if (hasLine) {
      const lineTgt = target1.kind === 'line' ? target1 : target2;
      const cirTgt = target1.kind === 'circle' ? target1 : target2;
      const lPick = lineTgt === target1 ? pick1 : pick2;
      const cPick = cirTgt === target1 ? pick1 : pick2;
      return runFilletLineCircle(ctx, lineTgt, cirTgt, lPick, cPick, radius);
    }
    if (hasArc) {
      const cirT = target1.kind === 'circle' ? target1 : target2;
      const arcT = target1.kind === 'arc' ? target1 : target2;
      const cPick = cirT === target1 ? pick1 : pick2;
      const aPick = arcT === target1 ? pick1 : pick2;
      return runFilletCircleArc(ctx, cirT, arcT, cPick, aPick, radius);
    }
    if (target1.kind === 'circle' && target2.kind === 'circle') {
      return runFilletCircleCircle(ctx, target1, target2, pick1, pick2, radius);
    }
    if (target1.kind === 'polyline' || target2.kind === 'polyline') {
      const polyTgt = target1.kind === 'polyline' ? target1 : target2;
      const cirT = target1.kind === 'circle' ? target1 : target2;
      const pPick = polyTgt === target1 ? pick1 : pick2;
      const cPick = cirT === target1 ? pick1 : pick2;
      return runFilletPolylineCircle(ctx, polyTgt, cirT, pPick, cPick, radius);
    }
    return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Fillet: unsupported entity combination' };
  }

  // --- Line + Arc fillet dispatch ---
  if (hasArc && hasLine) {
    const lineTgt = target1.kind === 'line' ? target1 : target2;
    const arcTgt = target1.kind === 'arc' ? target1 : target2;
    const linePick = lineTgt === target1 ? pick1 : pick2;
    return runFilletLineArc(ctx, lineTgt, arcTgt, linePick, radius);
  }
  if (hasArc) {
    if (target1.kind === 'arc' && target2.kind === 'arc') {
      return runFilletArcArc(ctx, target1, target2, pick1, pick2, radius);
    }
    if (target1.kind === 'polyline' || target2.kind === 'polyline') {
      const polyTgt = target1.kind === 'polyline' ? target1 : target2;
      const arcTgt = target1.kind === 'arc' ? target1 : target2;
      const polyPick = polyTgt === target1 ? pick1 : pick2;
      return runFilletPolylineArc(ctx, polyTgt, arcTgt, polyPick, radius);
    }
    return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Fillet: arc+polyline not supported' };
  }

  // Auto-suggest fillet radius when both targets are lines and radius is the tool default
  if (radius === 1.0 && (target1.kind === 'line' || target1.kind === 'polyline') && (target2.kind === 'line' || target2.kind === 'polyline')) {
    const suggested = suggestFilletRadius(target1.segStart, target1.segEnd, target2.segStart, target2.segEnd);
    if (suggested != null && suggested > 1e-9) {
      radius = suggested;
    }
  }

  const inter = lineLineIntersection(target1.segStart, target1.segEnd, target2.segStart, target2.segEnd, false, false);
  if (!inter) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: lines are parallel' };
  }
  const I = { x: inter.x, y: inter.y };

  // Special-case: fillet within one polyline corner (two adjacent segments).
  if (firstId === secondId) {
    if (target1.kind !== 'polyline' || target2.kind !== 'polyline') {
      return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Fillet: same-id requires polyline' };
    }
    if (target1.closed !== target2.closed || target1.entity.points.length !== target2.entity.points.length) {
      return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Fillet: inconsistent polyline state' };
    }
    const before = cloneValue(target1.entity);
    const points = before.points.map((p) => ({ ...p }));
    const n = points.length;
    const closed = before.closed === true;
    let segA = Number(target1.segIndex);
    let segB = Number(target2.segIndex);
    const canAutoPairTwoSegment = !closed && n === 3;
    const initiallyAdjacent = closed
      ? (((segA + 1) % n) === segB || ((segB + 1) % n) === segA)
      : (Math.abs(segA - segB) === 1);
    let usedAutoPair = false;
    if (canAutoPairTwoSegment && (segA === segB || !initiallyAdjacent)) {
      // Two-segment L polylines are common in editing. If both clicks land on one leg
      // (or resolve ambiguously), pair the only possible corner segments automatically.
      segA = 0;
      segB = 1;
      usedAutoPair = true;
    }
    if (segA === segB) {
      return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'Fillet: pick two different polyline segments' };
    }
    const adjacent = closed
      ? (((segA + 1) % n) === segB || ((segB + 1) % n) === segA)
      : (Math.abs(segA - segB) === 1);
    if (!adjacent) {
      return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Fillet: only adjacent polyline corners are supported' };
    }

    const corner = closed
      ? (((segA + 1) % n) === segB ? segB : segA)
      : (segA < segB ? segB : segA);
    const prevSeg = (corner - 1 + n) % n;
    const nextSeg = corner;

    const prevRef = usedAutoPair
      ? makePolylineSegmentRef(target1, points, prevSeg, closed)
      : (target1.segIndex === prevSeg ? target1 : target2);
    const nextRef = usedAutoPair
      ? makePolylineSegmentRef(target1, points, nextSeg, closed)
      : (target1.segIndex === nextSeg ? target1 : target2);
    if (!prevRef || !nextRef) {
      return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: failed to resolve corner segments' };
    }

    let prevPick = prevRef === target1 ? pick1 : pick2;
    let nextPick = nextRef === target1 ? pick1 : pick2;
    if (usedAutoPair) {
      const defaultScore = pointOnSegmentDistance(pick1, prevRef.segStart, prevRef.segEnd) + pointOnSegmentDistance(pick2, nextRef.segStart, nextRef.segEnd);
      const swappedScore = pointOnSegmentDistance(pick1, nextRef.segStart, nextRef.segEnd) + pointOnSegmentDistance(pick2, prevRef.segStart, prevRef.segEnd);
      if (swappedScore + 1e-9 < defaultScore) {
        prevPick = pick2;
        nextPick = pick1;
      } else {
        prevPick = pick1;
        nextPick = pick2;
      }
    }
    const ePrev = pickLineKeepTrimEndpointsByPick({ start: prevRef.segStart, end: prevRef.segEnd }, I, prevPick);
    const eNext = pickLineKeepTrimEndpointsByPick({ start: nextRef.segStart, end: nextRef.segEnd }, I, nextPick);
    if (!ePrev || !eNext) {
      return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: degenerate polyline segment' };
    }
    // For a corner at vertex `corner`, the previous segment trims its end, and the next trims its start.
    if (ePrev.trimKey !== 'end' || eNext.trimKey !== 'start') {
      return { ok: false, changed: false, error_code: 'PICK_SIDE_MISMATCH', message: 'Fillet: pick sides must target the corner vertex' };
    }

    const dotVal = Math.max(-1, Math.min(1, ePrev.v.x * eNext.v.x + ePrev.v.y * eNext.v.y));
    const theta = Math.acos(dotVal);
    if (!Number.isFinite(theta) || theta <= 1e-6 || theta >= Math.PI - 1e-6) {
      return { ok: false, changed: false, error_code: 'INVALID_ANGLE', message: 'Fillet: invalid segment angle' };
    }
    const trimDist = radius / Math.tan(theta / 2);
    if (!Number.isFinite(trimDist) || trimDist <= 1e-9 || trimDist >= ePrev.lenKeep - 1e-9 || trimDist >= eNext.lenKeep - 1e-9) {
      return { ok: false, changed: false, error_code: 'RADIUS_TOO_LARGE', message: 'Fillet: radius too large' };
    }
    const tPrev = { x: I.x + ePrev.v.x * trimDist, y: I.y + ePrev.v.y * trimDist };
    const tNext = { x: I.x + eNext.v.x * trimDist, y: I.y + eNext.v.y * trimDist };

    const bisector = normalizeVectorSafe({ x: ePrev.v.x + eNext.v.x, y: ePrev.v.y + eNext.v.y });
    if (!bisector) {
      return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: bisector is undefined' };
    }
    const h = radius / Math.sin(theta / 2);
    const center = { x: I.x + bisector.x * h, y: I.y + bisector.y * h };
    const startAngle = angleFrom(center, tPrev);
    const endAngle = angleFrom(center, tNext);
    const cw = resolveArcDirection(startAngle, endAngle);

    const createdEntities = [];
    if (closed) {
      // Keep the loop minus the corner as one open polyline, and close with a separate arc entity.
      const out = [{ ...tNext }];
      const stop = (corner - 1 + n) % n;
      let cursor = (corner + 1) % n;
      let guard = 0;
      while (cursor !== stop) {
        out.push({ ...points[cursor] });
        cursor = (cursor + 1) % n;
        guard += 1;
        if (guard > n + 2) break;
      }
      out.push({ ...points[stop] });
      out.push({ ...tPrev });
      if (out.length < 2) {
        return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: degenerate polyline output' };
      }
      const openPoly = ctx.document.addEntity({
        type: 'polyline',
        layerId: before.layerId,
        color: before.color,
        visible: before.visible,
        name: before.name ? `${before.name}_FILT` : '',
        closed: false,
        points: out,
      });
      if (!openPoly) {
        return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create polyline' };
      }
      createdEntities.push(openPoly);
    } else {
      const aPoints = points.slice(0, corner).map((p) => ({ ...p }));
      aPoints.push({ ...tPrev });
      const bPoints = [{ ...tNext }, ...points.slice(corner + 1).map((p) => ({ ...p }))];
      if (aPoints.length < 2 || bPoints.length < 2) {
        return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: degenerate polyline output' };
      }
      const created = ctx.document.addEntities([
        {
          type: 'polyline',
          layerId: before.layerId,
          color: before.color,
          visible: before.visible,
          name: before.name ? `${before.name}_A` : '',
          closed: false,
          points: aPoints,
        },
        {
          type: 'polyline',
          layerId: before.layerId,
          color: before.color,
          visible: before.visible,
          name: before.name ? `${before.name}_B` : '',
          closed: false,
          points: bPoints,
        },
      ]);
      if (created.length !== 2) {
        return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create polylines' };
      }
      createdEntities.push(...created);
    }

    const arc = ctx.document.addEntity({
      type: 'arc',
      layerId: before.layerId,
      color: before.color,
      visible: before.visible,
      center,
      radius,
      startAngle,
      endAngle,
      cw,
    });
    if (!arc) {
      return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create arc' };
    }

    ctx.document.removeEntity(before.id);
    const ids = [...createdEntities.map((e) => e.id), arc.id];
    ctx.selection.setSelection(ids, arc.id);
    return { ok: true, changed: true, message: 'Fillet applied' };
  }

  const segTol = 1e-6;
  for (const target of [target1, target2]) {
    if (target.kind !== 'polyline') continue;
    if (pointOnSegmentDistance(I, target.segStart, target.segEnd) > segTol) {
      return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: polyline segment requires intersection within the picked segment (no extend)' };
    }
  }

  const e1 = pickLineKeepTrimEndpointsByPick({ start: target1.segStart, end: target1.segEnd }, I, pick1);
  const e2 = pickLineKeepTrimEndpointsByPick({ start: target2.segStart, end: target2.segEnd }, I, pick2);
  if (!e1 || !e2) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: degenerate segment' };
  }

  const dotVal = Math.max(-1, Math.min(1, e1.v.x * e2.v.x + e1.v.y * e2.v.y));
  const theta = Math.acos(dotVal);
  if (!Number.isFinite(theta) || theta <= 1e-6 || theta >= Math.PI - 1e-6) {
    return { ok: false, changed: false, error_code: 'INVALID_ANGLE', message: 'Fillet: invalid line angle' };
  }
  const trimDist = radius / Math.tan(theta / 2);
  if (!Number.isFinite(trimDist) || trimDist <= 1e-9 || trimDist >= e1.lenKeep - 1e-9 || trimDist >= e2.lenKeep - 1e-9) {
    return { ok: false, changed: false, error_code: 'RADIUS_TOO_LARGE', message: 'Fillet: radius too large' };
  }
  const p1 = { x: I.x + e1.v.x * trimDist, y: I.y + e1.v.y * trimDist };
  const p2 = { x: I.x + e2.v.x * trimDist, y: I.y + e2.v.y * trimDist };

  const bisector = normalizeVectorSafe({ x: e1.v.x + e2.v.x, y: e1.v.y + e2.v.y });
  if (!bisector) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: bisector is undefined' };
  }
  const h = radius / Math.sin(theta / 2);
  const center = { x: I.x + bisector.x * h, y: I.y + bisector.y * h };
  const startAngle = angleFrom(center, p1);
  const endAngle = angleFrom(center, p2);
  const cw = resolveArcDirection(startAngle, endAngle);

  const applyTrim = (target, endpoints, point) => {
    if (target.kind === 'line') {
      const patch = endpoints.trimKey === 'start' ? { start: point } : { end: point };
      return ctx.document.updateEntity(target.entity.id, { ...target.entity, ...patch });
    }
    if (target.kind === 'polyline') {
      if (pointOnSegmentDistance(point, target.segStart, target.segEnd) > segTol) {
        return null;
      }
      const isClosed = target.entity.closed === true;
      const out = isClosed
        ? trimClosedPolylineBySegmentInsertPoint(target.entity, target.startIndex, target.endIndex, point)
        : trimOpenPolylineBySegmentKeepKey(target.entity, target.startIndex, target.endIndex, endpoints.keepKey, point);
      if (!out) {
        return null;
      }
      return ctx.document.updateEntity(target.entity.id, { ...target.entity, closed: isClosed, points: out });
    }
    return null;
  };

  const ok1 = applyTrim(target1, e1, p1);
  const ok2 = applyTrim(target2, e2, p2);
  if (ok1 == null || ok2 == null) {
    return {
      ok: false,
      changed: false,
      error_code: 'FILLET_FAILED',
      message: 'Fillet: unsupported polyline trim',
    };
  }
  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to trim entities' };
  }
  const arc = ctx.document.addEntity({
    type: 'arc',
    layerId: target1.layerId,
    color: target1.entity.color,
    visible: target1.entity.visible,
    center,
    radius,
    startAngle,
    endAngle,
    cw,
  });
  if (!arc) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create arc' };
  }
  ctx.selection.setSelection([target1.entity.id, target2.entity.id, arc.id], arc.id);
  return { ok: true, changed: true, message: 'Fillet applied' };
}

function runFilletSelection(ctx, payload) {
  const ids = [...ctx.selection.entityIds];
  if (ids.length !== 2) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'Fillet: select exactly 2 lines' };
  }
  const radius = Number(payload?.radius);
  if (!Number.isFinite(radius) || radius <= 1e-9) {
    return { ok: false, changed: false, error_code: 'INVALID_RADIUS', message: 'Fillet: invalid radius' };
  }
  const l1 = ctx.document.getEntity(ids[0]);
  const l2 = ctx.document.getEntity(ids[1]);
  if (!l1 || !l2 || l1.type !== 'line' || l2.type !== 'line') {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Fillet: only line-line is supported' };
  }
  const layer1 = ctx.document.getLayer(l1.layerId);
  if (layer1?.locked) {
    const name = layer1?.name || `L${l1.layerId}`;
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Fillet: layer ${name} is locked` };
  }
  if (l2.layerId !== l1.layerId) {
    const layer2 = ctx.document.getLayer(l2.layerId);
    if (layer2?.locked) {
      const name = layer2?.name || `L${l2.layerId}`;
      return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Fillet: layer ${name} is locked` };
    }
  }
  const inter = lineLineIntersection(l1.start, l1.end, l2.start, l2.end, false, false);
  if (!inter) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Fillet: lines are parallel' };
  }
  const I = { x: inter.x, y: inter.y };
  const e1 = pickLineNearFarEndpoints(l1, I);
  const e2 = pickLineNearFarEndpoints(l2, I);
  const v1 = normalizeVectorSafe({ x: e1.far.x - I.x, y: e1.far.y - I.y });
  const v2 = normalizeVectorSafe({ x: e2.far.x - I.x, y: e2.far.y - I.y });
  if (!v1 || !v2) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: degenerate line' };
  }
  const dotVal = Math.max(-1, Math.min(1, v1.x * v2.x + v1.y * v2.y));
  const theta = Math.acos(dotVal);
  if (!Number.isFinite(theta) || theta <= 1e-6 || theta >= Math.PI - 1e-6) {
    return { ok: false, changed: false, error_code: 'INVALID_ANGLE', message: 'Fillet: invalid line angle' };
  }
  const trimDist = radius / Math.tan(theta / 2);
  const len1 = Math.hypot(e1.far.x - I.x, e1.far.y - I.y);
  const len2 = Math.hypot(e2.far.x - I.x, e2.far.y - I.y);
  if (!Number.isFinite(trimDist) || trimDist <= 1e-9 || trimDist >= len1 - 1e-9 || trimDist >= len2 - 1e-9) {
    return { ok: false, changed: false, error_code: 'RADIUS_TOO_LARGE', message: 'Fillet: radius too large' };
  }
  const t1 = { x: I.x + v1.x * trimDist, y: I.y + v1.y * trimDist };
  const t2 = { x: I.x + v2.x * trimDist, y: I.y + v2.y * trimDist };
  const bisector = normalizeVectorSafe({ x: v1.x + v2.x, y: v1.y + v2.y });
  if (!bisector) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Fillet: bisector is undefined' };
  }
  const h = radius / Math.sin(theta / 2);
  const center = { x: I.x + bisector.x * h, y: I.y + bisector.y * h };
  const startAngle = angleFrom(center, t1);
  const endAngle = angleFrom(center, t2);
  const cw = resolveArcDirection(startAngle, endAngle);

  const patch1 = e1.nearKey === 'start' ? { start: t1 } : { end: t1 };
  const patch2 = e2.nearKey === 'start' ? { start: t2 } : { end: t2 };
  const ok1 = ctx.document.updateEntity(l1.id, { ...l1, ...patch1 });
  const ok2 = ctx.document.updateEntity(l2.id, { ...l2, ...patch2 });
  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to trim lines' };
  }
  const arc = ctx.document.addEntity({
    type: 'arc',
    layerId: l1.layerId,
    color: l1.color,
    visible: l1.visible,
    center,
    radius,
    startAngle,
    endAngle,
    cw,
  });
  if (!arc) {
    return { ok: false, changed: false, error_code: 'FILLET_FAILED', message: 'Fillet: failed to create arc' };
  }
  ctx.selection.setSelection([l1.id, l2.id, arc.id], arc.id);
  return { ok: true, changed: true, message: 'Fillet applied' };
}

// ---------------------------------------------------------------------------
// Arc / Circle chamfer helpers
// ---------------------------------------------------------------------------

/**
 * Find intersections of an extended line with an arc or circle.
 * The line is extended to infinity; results are filtered by arc sweep.
 */
function findLineCurveIntersections(lineTgt, curveTgt) {
  const { segStart, segEnd } = lineTgt;
  const { cx, cy, r } = curveTgt;
  const dx = segEnd.x - segStart.x;
  const dy = segEnd.y - segStart.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < EPSILON) return [];
  const ux = dx / len;
  const uy = dy / len;
  // Extend line far enough to guarantee any intersection with the circle is captured
  const reach = Math.sqrt(distanceSq(segStart, { x: cx, y: cy })) + r + len;
  const extStart = { x: segStart.x - ux * reach, y: segStart.y - uy * reach };
  const extEnd = { x: segEnd.x + ux * reach, y: segEnd.y + uy * reach };
  const hits = lineArcIntersection(extStart, extEnd, cx, cy, r);
  if (curveTgt.kind === 'arc') {
    return hits.filter((h) => {
      const a = normalizeAngle(Math.atan2(h.y - cy, h.x - cx));
      return isAngleInSweep(curveTgt.startAngle, curveTgt.endAngle, curveTgt.cw, a);
    });
  }
  return hits; // circle: every point on the circle is valid
}

/**
 * Determine which side of an arc to keep during chamfer, based on the pick point.
 * Returns { keepSide: 'start'|'end', arcLen: available arc-length from intersection }.
 */
function pickArcKeepSideByPick(arcTgt, iAngle, pick) {
  const { cx, cy, r, startAngle, endAngle, cw } = arcTgt;
  const ia = normalizeAngle(iAngle);
  const pa = normalizeAngle(angleFrom({ x: cx, y: cy }, pick));

  // Determine which sub-arc contains the pick
  const pickInStart = isAngleInSweep(startAngle, ia, cw, pa);
  const pickInEnd = isAngleInSweep(ia, endAngle, cw, pa);

  let keepSide;
  if (pickInStart && !pickInEnd) {
    keepSide = 'start';
  } else if (pickInEnd && !pickInStart) {
    keepSide = 'end';
  } else {
    const dStart = Math.abs(angleDelta(pa, normalizeAngle(startAngle)));
    const dEnd = Math.abs(angleDelta(pa, normalizeAngle(endAngle)));
    keepSide = dStart <= dEnd ? 'start' : 'end';
  }

  // Compute angular sweep from intersection to the kept endpoint
  const TWO_PI = Math.PI * 2;
  let sweep;
  if (keepSide === 'start') {
    // Sweep from startAngle to intersectionAngle following arc direction
    sweep = cw
      ? ((normalizeAngle(startAngle) - ia + TWO_PI) % TWO_PI)
      : ((ia - normalizeAngle(startAngle) + TWO_PI) % TWO_PI);
  } else {
    // Sweep from intersectionAngle to endAngle following arc direction
    sweep = cw
      ? ((ia - normalizeAngle(endAngle) + TWO_PI) % TWO_PI)
      : ((normalizeAngle(endAngle) - ia + TWO_PI) % TWO_PI);
  }
  if (sweep < EPSILON) sweep = TWO_PI;
  return { keepSide, arcLen: r * sweep };
}

/**
 * Compute the chamfer point on an arc/circle at arc-length d from the intersection.
 * For arcs: walkDir determined by keepSide and cw.
 * For circles: walkDir determined by pick angle.
 */
function arcChamferPoint(cx, cy, r, iAngle, d, keepSide, cw) {
  const dTheta = d / r;
  // keepSide='start' → walk against arc direction; 'end' → walk with arc direction
  const against = keepSide === 'start';
  // Against CW = CCW = +angle; against CCW = CW = -angle
  const sign = against ? (cw ? 1 : -1) : (cw ? -1 : 1);
  const chamferAngle = normalizeAngle(iAngle + sign * dTheta);
  return {
    angle: chamferAngle,
    point: { x: cx + r * Math.cos(chamferAngle), y: cy + r * Math.sin(chamferAngle) },
  };
}

/**
 * Chamfer between a line and an arc or circle.
 * d1 = distance along the line from intersection; d2 = arc-length along the curve.
 */
function runChamferLineCurve(ctx, lineTgt, curveTgt, linePick, curvePick, d1, d2) {
  const lineEnt = lineTgt.entity;
  const curveEnt = curveTgt.entity;

  // 1. Find intersection(s) of extended line with arc/circle
  const hits = findLineCurveIntersections(lineTgt, curveTgt);
  if (hits.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Chamfer: line and arc/circle do not intersect' };
  }

  // Pick intersection closest to pick points
  let bestHit = hits[0];
  let bestScore = Infinity;
  for (const h of hits) {
    const score = distanceSq(linePick, h) + distanceSq(curvePick, h);
    if (score < bestScore) {
      bestScore = score;
      bestHit = h;
    }
  }
  const I = { x: bestHit.x, y: bestHit.y };

  // 2. Line side: determine keep direction + available length
  const eLine = pickLineKeepTrimEndpointsByPick(
    { start: lineTgt.segStart, end: lineTgt.segEnd }, I, linePick,
  );
  if (!eLine) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Chamfer: degenerate line segment' };
  }
  if (d1 >= eLine.lenKeep - 1e-9) {
    return { ok: false, changed: false, error_code: 'DISTANCE_TOO_LARGE', message: 'Chamfer: distance too large for line' };
  }

  // 3. Arc/Circle side
  const iAngle = normalizeAngle(Math.atan2(I.y - curveTgt.cy, I.x - curveTgt.cx));
  let keepSide, availableArcLen, walkCw;

  if (curveTgt.kind === 'arc') {
    const arcKeep = pickArcKeepSideByPick(curveTgt, iAngle, curvePick);
    keepSide = arcKeep.keepSide;
    availableArcLen = arcKeep.arcLen;
    walkCw = curveTgt.cw;
  } else {
    // Circle: determine walk direction from pick angle
    const pa = normalizeAngle(angleFrom({ x: curveTgt.cx, y: curveTgt.cy }, curvePick));
    const ccwFromI = ((pa - iAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    // Walk toward the pick; model as keepSide='end' with cw/ccw matching walk direction
    if (ccwFromI <= Math.PI) {
      keepSide = 'end';
      walkCw = false; // walk CCW
    } else {
      keepSide = 'end';
      walkCw = true; // walk CW
    }
    availableArcLen = curveTgt.r * (Math.PI * 2 - 1e-3);
  }

  if (d2 >= availableArcLen - 1e-9) {
    return { ok: false, changed: false, error_code: 'DISTANCE_TOO_LARGE', message: 'Chamfer: distance too large for arc/circle' };
  }

  // 4. Compute chamfer points
  const linePoint = { x: I.x + eLine.v.x * d1, y: I.y + eLine.v.y * d1 };
  const { angle: chamferAngle, point: arcPoint } = arcChamferPoint(
    curveTgt.cx, curveTgt.cy, curveTgt.r,
    iAngle, d2, keepSide, walkCw,
  );

  // 5. Layer checks
  const layer1 = ctx.document.getLayer(lineTgt.layerId);
  if (layer1?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Chamfer: layer ${layer1?.name || ''} is locked` };
  }
  if (curveTgt.layerId !== lineTgt.layerId) {
    const layer2 = ctx.document.getLayer(curveTgt.layerId);
    if (layer2?.locked) {
      return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Chamfer: layer ${layer2?.name || ''} is locked` };
    }
  }

  // 6. Trim line
  const linePatch = eLine.trimKey === 'start' ? { start: linePoint } : { end: linePoint };
  let ok1;
  if (lineTgt.kind === 'line') {
    ok1 = ctx.document.updateEntity(lineEnt.id, { ...lineEnt, ...linePatch });
  } else if (lineTgt.kind === 'polyline') {
    const isClosed = lineEnt.closed === true;
    const out = isClosed
      ? trimClosedPolylineBySegmentInsertPoint(lineEnt, lineTgt.startIndex, lineTgt.endIndex, linePoint)
      : trimOpenPolylineBySegmentKeepKey(lineEnt, lineTgt.startIndex, lineTgt.endIndex, eLine.keepKey, linePoint);
    ok1 = out ? ctx.document.updateEntity(lineEnt.id, { ...lineEnt, closed: isClosed, points: out }) : false;
  } else {
    ok1 = false;
  }

  // 7. Trim arc/circle
  let ok2;
  if (curveTgt.kind === 'arc') {
    const trimmed = trimArcToPoint(curveEnt, chamferAngle, keepSide);
    ok2 = ctx.document.updateEntity(curveEnt.id, trimmed);
  } else {
    // Circle → arc conversion
    const pa = normalizeAngle(angleFrom({ x: curveTgt.cx, y: curveTgt.cy }, curvePick));
    const trimmed = trimCircleToArc(curveEnt, chamferAngle, pa);
    ok2 = ctx.document.updateEntity(curveEnt.id, trimmed);
  }

  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to trim entities' };
  }

  // 8. Create connector line
  const connector = ctx.document.addEntity({
    type: 'line',
    layerId: lineTgt.layerId,
    color: lineEnt.color,
    visible: lineEnt.visible,
    start: linePoint,
    end: arcPoint,
  });
  if (!connector) {
    return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to create connector' };
  }

  ctx.selection.setSelection([lineEnt.id, curveEnt.id, connector.id], connector.id);
  return { ok: true, changed: true, message: 'Chamfer applied (line+arc/circle)' };
}

/**
 * Find intersections between two arcs/circles using circle-circle intersection.
 * Returns array of { x, y, angle1, angle2 } where angle1/angle2 are the
 * angles from each center to the intersection point.
 */
function findCurveCurveIntersections(curve1, curve2) {
  const c1x = curve1.cx, c1y = curve1.cy, r1 = curve1.r;
  const c2x = curve2.cx, c2y = curve2.cy, r2 = curve2.r;
  const dx = c2x - c1x;
  const dy = c2y - c1y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < EPSILON) return []; // concentric
  if (d > r1 + r2 + EPSILON || d < Math.abs(r1 - r2) - EPSILON) return [];

  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  if (h2 < -EPSILON) return [];
  const h = Math.sqrt(Math.max(0, h2));

  const ux = dx / d;
  const uy = dy / d;
  const mx = c1x + a * ux;
  const my = c1y + a * uy;
  const px = -uy;
  const py = ux;

  const rawPoints = h < EPSILON
    ? [{ x: mx, y: my }]
    : [{ x: mx + h * px, y: my + h * py }, { x: mx - h * px, y: my - h * py }];

  const results = [];
  for (const pt of rawPoints) {
    const angle1 = normalizeAngle(Math.atan2(pt.y - c1y, pt.x - c1x));
    const angle2 = normalizeAngle(Math.atan2(pt.y - c2y, pt.x - c2x));

    // Filter by sweep for arcs (circles accept all)
    if (curve1.kind === 'arc') {
      if (!isAngleInSweep(curve1.startAngle, curve1.endAngle, curve1.cw, angle1)) continue;
    }
    if (curve2.kind === 'arc') {
      if (!isAngleInSweep(curve2.startAngle, curve2.endAngle, curve2.cw, angle2)) continue;
    }
    results.push({ x: pt.x, y: pt.y, angle1, angle2 });
  }
  return results;
}

/**
 * Chamfer between two arcs/circles.
 * d1 = arc-length along curve1; d2 = arc-length along curve2.
 */
function runChamferCurveCurve(ctx, curve1Tgt, curve2Tgt, pick1, pick2, d1, d2) {
  const ent1 = curve1Tgt.entity;
  const ent2 = curve2Tgt.entity;

  // 1. Find intersection(s)
  const hits = findCurveCurveIntersections(curve1Tgt, curve2Tgt);
  if (hits.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Chamfer: arcs/circles do not intersect' };
  }

  // Pick closest intersection to picks
  let best = hits[0];
  let bestScore = Infinity;
  for (const h of hits) {
    const score = distanceSq(pick1, h) + distanceSq(pick2, h);
    if (score < bestScore) {
      bestScore = score;
      best = h;
    }
  }

  // 2. Curve1 side: keep direction + available arc-length
  let keepSide1, availableLen1, walkCw1;
  if (curve1Tgt.kind === 'arc') {
    const arcKeep = pickArcKeepSideByPick(curve1Tgt, best.angle1, pick1);
    keepSide1 = arcKeep.keepSide;
    availableLen1 = arcKeep.arcLen;
    walkCw1 = curve1Tgt.cw;
  } else {
    const pa = normalizeAngle(angleFrom({ x: curve1Tgt.cx, y: curve1Tgt.cy }, pick1));
    const ccwFromI = ((pa - best.angle1) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    keepSide1 = 'end';
    walkCw1 = ccwFromI > Math.PI;
    availableLen1 = curve1Tgt.r * (Math.PI * 2 - 1e-3);
  }

  // 3. Curve2 side: keep direction + available arc-length
  let keepSide2, availableLen2, walkCw2;
  if (curve2Tgt.kind === 'arc') {
    const arcKeep = pickArcKeepSideByPick(curve2Tgt, best.angle2, pick2);
    keepSide2 = arcKeep.keepSide;
    availableLen2 = arcKeep.arcLen;
    walkCw2 = curve2Tgt.cw;
  } else {
    const pa = normalizeAngle(angleFrom({ x: curve2Tgt.cx, y: curve2Tgt.cy }, pick2));
    const ccwFromI = ((pa - best.angle2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    keepSide2 = 'end';
    walkCw2 = ccwFromI > Math.PI;
    availableLen2 = curve2Tgt.r * (Math.PI * 2 - 1e-3);
  }

  if (d1 >= availableLen1 - 1e-9) {
    return { ok: false, changed: false, error_code: 'DISTANCE_TOO_LARGE', message: 'Chamfer: distance too large for first arc/circle' };
  }
  if (d2 >= availableLen2 - 1e-9) {
    return { ok: false, changed: false, error_code: 'DISTANCE_TOO_LARGE', message: 'Chamfer: distance too large for second arc/circle' };
  }

  // 4. Compute chamfer points
  const { angle: chamferAngle1, point: chamferPt1 } = arcChamferPoint(
    curve1Tgt.cx, curve1Tgt.cy, curve1Tgt.r,
    best.angle1, d1, keepSide1, walkCw1,
  );
  const { angle: chamferAngle2, point: chamferPt2 } = arcChamferPoint(
    curve2Tgt.cx, curve2Tgt.cy, curve2Tgt.r,
    best.angle2, d2, keepSide2, walkCw2,
  );

  // 5. Layer checks
  const layer1 = ctx.document.getLayer(curve1Tgt.layerId);
  if (layer1?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Chamfer: layer ${layer1?.name || ''} is locked` };
  }
  if (curve2Tgt.layerId !== curve1Tgt.layerId) {
    const layer2 = ctx.document.getLayer(curve2Tgt.layerId);
    if (layer2?.locked) {
      return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Chamfer: layer ${layer2?.name || ''} is locked` };
    }
  }

  // 6. Trim curve1
  let ok1;
  if (curve1Tgt.kind === 'arc') {
    const trimmed = trimArcToPoint(ent1, chamferAngle1, keepSide1);
    ok1 = ctx.document.updateEntity(ent1.id, trimmed);
  } else {
    const pa = normalizeAngle(angleFrom({ x: curve1Tgt.cx, y: curve1Tgt.cy }, pick1));
    const trimmed = trimCircleToArc(ent1, chamferAngle1, pa);
    ok1 = ctx.document.updateEntity(ent1.id, trimmed);
  }

  // 7. Trim curve2
  let ok2;
  if (curve2Tgt.kind === 'arc') {
    const trimmed = trimArcToPoint(ent2, chamferAngle2, keepSide2);
    ok2 = ctx.document.updateEntity(ent2.id, trimmed);
  } else {
    const pa = normalizeAngle(angleFrom({ x: curve2Tgt.cx, y: curve2Tgt.cy }, pick2));
    const trimmed = trimCircleToArc(ent2, chamferAngle2, pa);
    ok2 = ctx.document.updateEntity(ent2.id, trimmed);
  }

  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to trim entities' };
  }

  // 8. Create connector line
  const connector = ctx.document.addEntity({
    type: 'line',
    layerId: curve1Tgt.layerId,
    color: ent1.color,
    visible: ent1.visible,
    start: chamferPt1,
    end: chamferPt2,
  });
  if (!connector) {
    return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to create connector' };
  }

  ctx.selection.setSelection([ent1.id, ent2.id, connector.id], connector.id);
  return { ok: true, changed: true, message: 'Chamfer applied (arc/circle + arc/circle)' };
}

function runChamferSelectionByPick(ctx, payload) {
  const firstId = Number(payload?.firstId);
  const secondId = Number(payload?.secondId);
  const pick1 = payload?.pick1;
  const pick2 = payload?.pick2;
  if (!Number.isFinite(firstId) || !Number.isFinite(secondId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'Chamfer: missing target ids' };
  }
  if (!pick1 || !Number.isFinite(pick1.x) || !Number.isFinite(pick1.y) || !pick2 || !Number.isFinite(pick2.x) || !Number.isFinite(pick2.y)) {
    return { ok: false, changed: false, error_code: 'INVALID_PICK', message: 'Chamfer: missing pick points' };
  }

  let d1 = Number(payload?.d1);
  const d2Input = Number(payload?.d2);
  let d2 = Number.isFinite(d2Input) && d2Input > 1e-9 ? d2Input : d1;
  if (!Number.isFinite(d1) || d1 <= 1e-9 || !Number.isFinite(d2) || d2 <= 1e-9) {
    return { ok: false, changed: false, error_code: 'INVALID_DISTANCE', message: 'Chamfer: invalid distance' };
  }

  const ent1 = ctx.document.getEntity(firstId);
  const ent2 = ctx.document.getEntity(secondId);
  let target1 = resolvePickSegmentRef(ent1, pick1);
  let target2 = resolvePickSegmentRef(ent2, pick2);
  if (!target1 || !target2) {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Chamfer: unsupported target type' };
  }
  const hasCurve = target1.kind === 'arc' || target2.kind === 'arc' || target1.kind === 'circle' || target2.kind === 'circle';
  if (hasCurve) {
    const hasLine = target1.kind === 'line' || target2.kind === 'line'
      || target1.kind === 'polyline' || target2.kind === 'polyline';
    if (hasLine) {
      const lineTgt = (target1.kind === 'line' || target1.kind === 'polyline') ? target1 : target2;
      const curvTgt = (target1.kind === 'arc' || target1.kind === 'circle') ? target1 : target2;
      const lPick = lineTgt === target1 ? pick1 : pick2;
      const cPick = curvTgt === target1 ? pick1 : pick2;
      return runChamferLineCurve(ctx, lineTgt, curvTgt, lPick, cPick, d1, d2);
    }
    // Both sides are curves (arc/circle)
    return runChamferCurveCurve(ctx, target1, target2, pick1, pick2, d1, d2);
  }
  if (firstId === secondId
      && target1.kind === 'polyline'
      && target2.kind === 'polyline'
      && target1.entity.closed !== true
      && Array.isArray(target1.entity.points)
      && target1.entity.points.length === 3
      && target1.segIndex === target2.segIndex) {
    const forcedSeg = Number(target1.segIndex) === 0 ? 1 : 0;
    const forcedRef = makePolylineSegmentRef(target1, target1.entity.points, forcedSeg, false);
    if (forcedRef) {
      target2 = forcedRef;
    }
  }
  const layer1 = ctx.document.getLayer(target1.layerId);
  if (layer1?.locked) {
    const name = layer1?.name || `L${target1.layerId}`;
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Chamfer: layer ${name} is locked` };
  }
  if (target2.layerId !== target1.layerId) {
    const layer2 = ctx.document.getLayer(target2.layerId);
    if (layer2?.locked) {
      const name = layer2?.name || `L${target2.layerId}`;
      return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Chamfer: layer ${name} is locked` };
    }
  }
  // Auto-suggest chamfer distance when both targets are lines and distances are the tool default
  if (d1 === 1.0 && d2 === 1.0 && (target1.kind === 'line' || target1.kind === 'polyline') && (target2.kind === 'line' || target2.kind === 'polyline')) {
    const suggested = suggestChamferDistance(target1.segStart, target1.segEnd, target2.segStart, target2.segEnd);
    if (suggested != null && suggested > 1e-9) {
      d1 = suggested;
      d2 = suggested;
    }
  }

  const inter = lineLineIntersection(target1.segStart, target1.segEnd, target2.segStart, target2.segEnd, false, false);
  if (!inter) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Chamfer: lines are parallel' };
  }
  const I = { x: inter.x, y: inter.y };

  // Special-case: chamfer within one polyline corner (two adjacent segments).
  if (firstId === secondId) {
    if (target1.kind !== 'polyline' || target2.kind !== 'polyline') {
      return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Chamfer: same-id requires polyline' };
    }
    if (target1.closed !== target2.closed || target1.entity.points.length !== target2.entity.points.length) {
      return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Chamfer: inconsistent polyline state' };
    }
    const before = cloneValue(target1.entity);
    const points = before.points.map((p) => ({ ...p }));
    const n = points.length;
    const closed = before.closed === true;
    let segA = Number(target1.segIndex);
    let segB = Number(target2.segIndex);
    const canAutoPairTwoSegment = !closed && n === 3;
    const initiallyAdjacent = closed
      ? (((segA + 1) % n) === segB || ((segB + 1) % n) === segA)
      : (Math.abs(segA - segB) === 1);
    let usedAutoPair = false;
    if (canAutoPairTwoSegment && (segA === segB || !initiallyAdjacent)) {
      // Two-segment L polylines have one valid corner pair; auto-pair when picks are ambiguous.
      segA = 0;
      segB = 1;
      usedAutoPair = true;
    }
    if (segA === segB) {
      return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'Chamfer: pick two different polyline segments' };
    }
    const adjacent = closed
      ? (((segA + 1) % n) === segB || ((segB + 1) % n) === segA)
      : (Math.abs(segA - segB) === 1);
    if (!adjacent) {
      return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Chamfer: only adjacent polyline corners are supported' };
    }

    const corner = closed
      ? (((segA + 1) % n) === segB ? segB : segA)
      : (segA < segB ? segB : segA);
    const prevSeg = (corner - 1 + n) % n;
    const nextSeg = corner;

    const prevRef = usedAutoPair
      ? makePolylineSegmentRef(target1, points, prevSeg, closed)
      : (target1.segIndex === prevSeg ? target1 : target2);
    const nextRef = usedAutoPair
      ? makePolylineSegmentRef(target1, points, nextSeg, closed)
      : (target1.segIndex === nextSeg ? target1 : target2);
    if (!prevRef || !nextRef) {
      return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Chamfer: failed to resolve corner segments' };
    }

    let prevPick = prevRef === target1 ? pick1 : pick2;
    let nextPick = nextRef === target1 ? pick1 : pick2;
    if (usedAutoPair) {
      const defaultScore = pointOnSegmentDistance(pick1, prevRef.segStart, prevRef.segEnd) + pointOnSegmentDistance(pick2, nextRef.segStart, nextRef.segEnd);
      const swappedScore = pointOnSegmentDistance(pick1, nextRef.segStart, nextRef.segEnd) + pointOnSegmentDistance(pick2, prevRef.segStart, prevRef.segEnd);
      if (swappedScore + 1e-9 < defaultScore) {
        prevPick = pick2;
        nextPick = pick1;
      } else {
        prevPick = pick1;
        nextPick = pick2;
      }
    }
    const ePrev = pickLineKeepTrimEndpointsByPick({ start: prevRef.segStart, end: prevRef.segEnd }, I, prevPick);
    const eNext = pickLineKeepTrimEndpointsByPick({ start: nextRef.segStart, end: nextRef.segEnd }, I, nextPick);
    if (!ePrev || !eNext) {
      return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Chamfer: degenerate polyline segment' };
    }
    if (ePrev.trimKey !== 'end' || eNext.trimKey !== 'start') {
      return { ok: false, changed: false, error_code: 'PICK_SIDE_MISMATCH', message: 'Chamfer: pick sides must target the corner vertex' };
    }
    if (d1 >= ePrev.lenKeep - 1e-9 || d2 >= eNext.lenKeep - 1e-9) {
      return { ok: false, changed: false, error_code: 'DISTANCE_TOO_LARGE', message: 'Chamfer: distance too large' };
    }

    const tPrev = { x: I.x + ePrev.v.x * d1, y: I.y + ePrev.v.y * d1 };
    const tNext = { x: I.x + eNext.v.x * d2, y: I.y + eNext.v.y * d2 };

    const createdEntities = [];
    if (closed) {
      const out = [{ ...tNext }];
      const stop = (corner - 1 + n) % n;
      let cursor = (corner + 1) % n;
      let guard = 0;
      while (cursor !== stop) {
        out.push({ ...points[cursor] });
        cursor = (cursor + 1) % n;
        guard += 1;
        if (guard > n + 2) break;
      }
      out.push({ ...points[stop] });
      out.push({ ...tPrev });
      if (out.length < 2) {
        return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Chamfer: degenerate polyline output' };
      }
      const openPoly = ctx.document.addEntity({
        type: 'polyline',
        layerId: before.layerId,
        color: before.color,
        visible: before.visible,
        name: before.name ? `${before.name}_CHF` : '',
        closed: false,
        points: out,
      });
      if (!openPoly) {
        return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to create polyline' };
      }
      createdEntities.push(openPoly);
    } else {
      const aPoints = points.slice(0, corner).map((p) => ({ ...p }));
      aPoints.push({ ...tPrev });
      const bPoints = [{ ...tNext }, ...points.slice(corner + 1).map((p) => ({ ...p }))];
      if (aPoints.length < 2 || bPoints.length < 2) {
        return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Chamfer: degenerate polyline output' };
      }
      const created = ctx.document.addEntities([
        {
          type: 'polyline',
          layerId: before.layerId,
          color: before.color,
          visible: before.visible,
          name: before.name ? `${before.name}_A` : '',
          closed: false,
          points: aPoints,
        },
        {
          type: 'polyline',
          layerId: before.layerId,
          color: before.color,
          visible: before.visible,
          name: before.name ? `${before.name}_B` : '',
          closed: false,
          points: bPoints,
        },
      ]);
      if (created.length !== 2) {
        return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to create polylines' };
      }
      createdEntities.push(...created);
    }

    const connector = ctx.document.addEntity({
      type: 'line',
      layerId: before.layerId,
      color: before.color,
      visible: before.visible,
      start: tPrev,
      end: tNext,
    });
    if (!connector) {
      return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to create connector' };
    }

    ctx.document.removeEntity(before.id);
    const ids = [...createdEntities.map((e) => e.id), connector.id];
    ctx.selection.setSelection(ids, connector.id);
    return { ok: true, changed: true, message: 'Chamfer applied' };
  }

  const segTol = 1e-6;
  for (const target of [target1, target2]) {
    if (target.kind !== 'polyline') continue;
    if (pointOnSegmentDistance(I, target.segStart, target.segEnd) > segTol) {
      return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Chamfer: polyline segment requires intersection within the picked segment (no extend)' };
    }
  }

  const e1 = pickLineKeepTrimEndpointsByPick({ start: target1.segStart, end: target1.segEnd }, I, pick1);
  const e2 = pickLineKeepTrimEndpointsByPick({ start: target2.segStart, end: target2.segEnd }, I, pick2);
  if (!e1 || !e2) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Chamfer: degenerate segment' };
  }
  if (d1 >= e1.lenKeep - 1e-9 || d2 >= e2.lenKeep - 1e-9) {
    return { ok: false, changed: false, error_code: 'DISTANCE_TOO_LARGE', message: 'Chamfer: distance too large' };
  }

  const p1 = { x: I.x + e1.v.x * d1, y: I.y + e1.v.y * d1 };
  const p2 = { x: I.x + e2.v.x * d2, y: I.y + e2.v.y * d2 };

  const applyTrim = (target, endpoints, point) => {
    if (target.kind === 'line') {
      const patch = endpoints.trimKey === 'start' ? { start: point } : { end: point };
      return ctx.document.updateEntity(target.entity.id, { ...target.entity, ...patch });
    }
    if (target.kind === 'polyline') {
      if (pointOnSegmentDistance(point, target.segStart, target.segEnd) > segTol) {
        return null;
      }
      const isClosed = target.entity.closed === true;
      const out = isClosed
        ? trimClosedPolylineBySegmentInsertPoint(target.entity, target.startIndex, target.endIndex, point)
        : trimOpenPolylineBySegmentKeepKey(target.entity, target.startIndex, target.endIndex, endpoints.keepKey, point);
      if (!out) {
        return null;
      }
      return ctx.document.updateEntity(target.entity.id, { ...target.entity, closed: isClosed, points: out });
    }
    return null;
  };

  const ok1 = applyTrim(target1, e1, p1);
  const ok2 = applyTrim(target2, e2, p2);
  if (ok1 == null || ok2 == null) {
    return {
      ok: false,
      changed: false,
      error_code: 'CHAMFER_FAILED',
      message: 'Chamfer: unsupported polyline trim',
    };
  }
  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to trim entities' };
  }

  const connector = ctx.document.addEntity({
    type: 'line',
    layerId: target1.layerId,
    color: target1.entity.color,
    visible: target1.entity.visible,
    start: p1,
    end: p2,
  });
  if (!connector) {
    return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to create connector' };
  }
  ctx.selection.setSelection([target1.entity.id, target2.entity.id, connector.id], connector.id);
  return { ok: true, changed: true, message: 'Chamfer applied' };
}

function runChamferSelection(ctx, payload) {
  const ids = [...ctx.selection.entityIds];
  if (ids.length !== 2) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'Chamfer: select exactly 2 lines' };
  }
  const d1 = Number(payload?.d1);
  const d2Input = Number(payload?.d2);
  const d2 = Number.isFinite(d2Input) && d2Input > 1e-9 ? d2Input : d1;
  if (!Number.isFinite(d1) || d1 <= 1e-9 || !Number.isFinite(d2) || d2 <= 1e-9) {
    return { ok: false, changed: false, error_code: 'INVALID_DISTANCE', message: 'Chamfer: invalid distance' };
  }
  const l1 = ctx.document.getEntity(ids[0]);
  const l2 = ctx.document.getEntity(ids[1]);
  if (!l1 || !l2 || l1.type !== 'line' || l2.type !== 'line') {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Chamfer: only line-line is supported' };
  }
  const layer1 = ctx.document.getLayer(l1.layerId);
  if (layer1?.locked) {
    const name = layer1?.name || `L${l1.layerId}`;
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Chamfer: layer ${name} is locked` };
  }
  if (l2.layerId !== l1.layerId) {
    const layer2 = ctx.document.getLayer(l2.layerId);
    if (layer2?.locked) {
      const name = layer2?.name || `L${l2.layerId}`;
      return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Chamfer: layer ${name} is locked` };
    }
  }
  const inter = lineLineIntersection(l1.start, l1.end, l2.start, l2.end, false, false);
  if (!inter) {
    return { ok: false, changed: false, error_code: 'NO_INTERSECTION', message: 'Chamfer: lines are parallel' };
  }
  const I = { x: inter.x, y: inter.y };
  const e1 = pickLineNearFarEndpoints(l1, I);
  const e2 = pickLineNearFarEndpoints(l2, I);
  const v1 = normalizeVectorSafe({ x: e1.far.x - I.x, y: e1.far.y - I.y });
  const v2 = normalizeVectorSafe({ x: e2.far.x - I.x, y: e2.far.y - I.y });
  if (!v1 || !v2) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Chamfer: degenerate line' };
  }
  const len1 = Math.hypot(e1.far.x - I.x, e1.far.y - I.y);
  const len2 = Math.hypot(e2.far.x - I.x, e2.far.y - I.y);
  if (d1 >= len1 - 1e-9 || d2 >= len2 - 1e-9) {
    return { ok: false, changed: false, error_code: 'DISTANCE_TOO_LARGE', message: 'Chamfer: distance too large' };
  }
  const t1 = { x: I.x + v1.x * d1, y: I.y + v1.y * d1 };
  const t2 = { x: I.x + v2.x * d2, y: I.y + v2.y * d2 };

  const patch1 = e1.nearKey === 'start' ? { start: t1 } : { end: t1 };
  const patch2 = e2.nearKey === 'start' ? { start: t2 } : { end: t2 };
  const ok1 = ctx.document.updateEntity(l1.id, { ...l1, ...patch1 });
  const ok2 = ctx.document.updateEntity(l2.id, { ...l2, ...patch2 });
  if (!ok1 || !ok2) {
    return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to trim lines' };
  }
  const connector = ctx.document.addEntity({
    type: 'line',
    layerId: l1.layerId,
    color: l1.color,
    visible: l1.visible,
    start: t1,
    end: t2,
  });
  if (!connector) {
    return { ok: false, changed: false, error_code: 'CHAMFER_FAILED', message: 'Chamfer: failed to create connector' };
  }
  ctx.selection.setSelection([l1.id, l2.id, connector.id], connector.id);
  return { ok: true, changed: true, message: 'Chamfer applied' };
}

function runJoinSelection(ctx, payload) {
  const ids = [...new Set(ctx.selection.entityIds.filter((id) => Number.isFinite(id)).map((id) => Number(id)))];
  if (ids.length < 2) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'Join: select 2+ entities' };
  }
  const primaryId = Number.isFinite(ctx.selection.primaryId) && ids.includes(Number(ctx.selection.primaryId))
    ? Number(ctx.selection.primaryId)
    : ids[0];
  const primaryEntity = ctx.document.getEntity(primaryId);
  if (!primaryEntity) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Join: primary entity missing' };
  }
  const primary = endpointsForJoin(primaryEntity);
  if (!primary) {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: 'Join: unsupported primary type' };
  }
  const baseLayerId = primaryEntity.layerId;
  const layer = ctx.document.getLayer(baseLayerId);
  if (layer?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Join: layer is locked' };
  }

  const others = [];
  for (const id of ids) {
    if (id === primaryId) continue;
    const entity = ctx.document.getEntity(id);
    if (!entity) {
      return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: `Join: entity ${id} missing` };
    }
    if (entity.layerId !== baseLayerId) {
      return { ok: false, changed: false, error_code: 'LAYER_MISMATCH', message: 'Join: entities must be on same layer' };
    }
    const ep = endpointsForJoin(entity);
    if (!ep) {
      return { ok: false, changed: false, error_code: 'UNSUPPORTED', message: `Join: entity ${id} type unsupported` };
    }
    others.push({
      id,
      points: ep.points.map((p) => ({ ...p })),
      start: { ...ep.start },
      end: { ...ep.end },
    });
  }

  const tol = Number.isFinite(payload?.tolerance) ? Math.max(1e-6, Number(payload.tolerance)) : 1e-6;
  const tolSq = tol * tol;
  let chain = primary.points.map((p) => ({ ...p }));
  while (others.length > 0) {
    const chainStart = chain[0];
    const chainEnd = chain[chain.length - 1];
    let best = null;
    for (let i = 0; i < others.length; i += 1) {
      const candidate = others[i];
      const ops = [
        { mode: 'append', reverse: false, distSq: distanceSq(chainEnd, candidate.start) },
        { mode: 'append', reverse: true, distSq: distanceSq(chainEnd, candidate.end) },
        { mode: 'prepend', reverse: false, distSq: distanceSq(chainStart, candidate.end) },
        { mode: 'prepend', reverse: true, distSq: distanceSq(chainStart, candidate.start) },
      ];
      for (const op of ops) {
        if (!best || op.distSq < best.distSq) {
          best = { ...op, index: i };
        }
      }
    }
    if (!best || !Number.isFinite(best.distSq) || best.distSq > tolSq) {
      return {
        ok: false,
        changed: false,
        error_code: 'NO_MATCH',
        message: `Join: unresolved endpoint matches (${others.length} remaining)`,
      };
    }
    const candidate = others.splice(best.index, 1)[0];
    const oriented = best.reverse ? reversePoints(candidate.points) : candidate.points.map((p) => ({ ...p }));
    if (best.mode === 'append') {
      chain = [...chain, ...oriented.slice(1)];
    } else {
      chain = [...oriented.slice(0, -1), ...chain];
    }
  }

  if (chain.length < 2) {
    return { ok: false, changed: false, error_code: 'INVALID_GEOMETRY', message: 'Join: degenerate result' };
  }

  let closed = false;
  if (chain.length >= 3 && distanceSq(chain[0], chain[chain.length - 1]) <= tolSq) {
    closed = true;
    chain.pop();
  }

  const created = ctx.document.addEntity({
    type: 'polyline',
    layerId: primaryEntity.layerId,
    color: primaryEntity.color,
    visible: primaryEntity.visible,
    name: primaryEntity.name || '',
    closed,
    points: chain,
  });
  if (!created) {
    return { ok: false, changed: false, error_code: 'JOIN_FAILED', message: 'Join: failed to create polyline' };
  }
  ctx.document.removeEntities(ids);
  ctx.selection.setSelection([created.id], created.id);
  return { ok: true, changed: true, message: `Join merged ${ids.length} entities` };
}

function runRotateSelection(ctx, payload) {
  const ids = [...ctx.selection.entityIds];
  if (ids.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to rotate' };
  }
  const center = payload?.center;
  const angle = payload?.angle;
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(angle)) {
    return { ok: false, changed: false, error_code: 'INVALID_ROTATE', message: 'Missing rotate center/angle' };
  }
  const wholeSourceGroupSelection = resolveWholeSourceGroupTransformSelection(ctx, ids);
  let changed = false;
  let attempted = 0;
  let readOnlySkipped = 0;
  for (const id of ids) {
    const entity = ctx.document.getEntity(id);
    if (!entity) continue;
    attempted += 1;
    if (!canTransformSelectedEntity(entity, wholeSourceGroupSelection)) {
      readOnlySkipped += 1;
      continue;
    }
    const next = rotateEntity(entity, center, angle);
    changed = ctx.document.updateEntity(id, next) || changed;
  }
  if (!changed && attempted > 0 && readOnlySkipped === attempted) {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED_READ_ONLY', message: 'Selected entities are read-only proxies' };
  }
  if (readOnlySkipped > 0) {
    return {
      ok: true,
      changed,
      message: `Rotated ${Math.max(0, attempted - readOnlySkipped)}/${attempted} entities (skipped ${readOnlySkipped} read-only)`,
    };
  }
  if (wholeSourceGroupSelection && wholeSourceGroupSelection.readOnlyIds.length > 0) {
    return {
      ok: true,
      changed,
      message: formatWholeSourceGroupTransformMessage('Rotated', ids.length, wholeSourceGroupSelection),
    };
  }
  return { ok: true, changed, message: `Rotated ${ids.length} entities` };
}

function runScaleSelection(ctx, payload) {
  const ids = [...ctx.selection.entityIds];
  if (ids.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to scale' };
  }
  const center = payload?.center;
  const factor = payload?.factor;
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(factor) || factor <= EPSILON) {
    return { ok: false, changed: false, error_code: 'INVALID_SCALE', message: 'Missing scale center/factor' };
  }
  const wholeSourceGroupSelection = resolveWholeSourceGroupTransformSelection(ctx, ids);
  let changed = false;
  let attempted = 0;
  let readOnlySkipped = 0;
  for (const id of ids) {
    const entity = ctx.document.getEntity(id);
    if (!entity) continue;
    attempted += 1;
    if (!canTransformSelectedEntity(entity, wholeSourceGroupSelection)) {
      readOnlySkipped += 1;
      continue;
    }
    const next = scaleEntity(entity, center, factor);
    changed = ctx.document.updateEntity(id, next) || changed;
  }
  if (!changed && attempted > 0 && readOnlySkipped === attempted) {
    return { ok: false, changed: false, error_code: 'UNSUPPORTED_READ_ONLY', message: 'Selected entities are read-only proxies' };
  }
  if (readOnlySkipped > 0) {
    return {
      ok: true,
      changed,
      message: `Scaled ${Math.max(0, attempted - readOnlySkipped)}/${attempted} entities (skipped ${readOnlySkipped} read-only)`,
    };
  }
  if (wholeSourceGroupSelection && wholeSourceGroupSelection.readOnlyIds.length > 0) {
    return {
      ok: true,
      changed,
      message: formatWholeSourceGroupTransformMessage('Scaled', ids.length, wholeSourceGroupSelection),
    };
  }
  return { ok: true, changed, message: `Scaled ${ids.length} entities` };
}

function hasSourceTextPlacement(entity) {
  return isDirectEditableSourceTextEntity(entity)
    && entity.sourceTextPos
    && Number.isFinite(entity.sourceTextPos.x)
    && Number.isFinite(entity.sourceTextPos.y)
    && Number.isFinite(entity.sourceTextRotation);
}

function isDimensionSourceTextEntity(entity) {
  return isDirectEditableSourceTextEntity(entity)
    && String(entity.sourceType || '').trim().toUpperCase() === 'DIMENSION';
}

function isLeaderSourceTextEntity(entity) {
  return isDirectEditableSourceTextEntity(entity)
    && String(entity.sourceType || '').trim().toUpperCase() === 'LEADER';
}

function hasSourceTextPlacementDrift(entity) {
  if (!hasSourceTextPlacement(entity)) return false;
  const currentX = Number(entity.position?.x);
  const currentY = Number(entity.position?.y);
  const currentRotation = Number(entity.rotation);
  return Math.abs(currentX - Number(entity.sourceTextPos.x)) > 1e-9
    || Math.abs(currentY - Number(entity.sourceTextPos.y)) > 1e-9
    || Math.abs(currentRotation - Number(entity.sourceTextRotation)) > 1e-9;
}

function buildSourceTextPlacementResetPatch(entity) {
  if (!hasSourceTextPlacement(entity)) return null;
  const next = {
    position: {
      x: Number(entity.sourceTextPos.x),
      y: Number(entity.sourceTextPos.y),
    },
    rotation: Number(entity.sourceTextRotation),
  };
  if (String(entity.sourceType || '').trim().toUpperCase() === 'DIMENSION') {
    next.dimTextPos = { ...next.position };
    next.dimTextRotation = next.rotation;
  }
  return next;
}

function buildDimensionOppositeTextSidePatch(entity, guide) {
  if (!isDimensionSourceTextEntity(entity) || !guide?.anchor || !guide?.sourceOffset) return null;
  const anchorX = Number(guide.anchor.x);
  const anchorY = Number(guide.anchor.y);
  const offsetX = Number(guide.sourceOffset.x);
  const offsetY = Number(guide.sourceOffset.y);
  const rotation = Number.isFinite(entity.sourceTextRotation)
    ? Number(entity.sourceTextRotation)
    : Number(entity.rotation);
  if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY) || !Number.isFinite(offsetX) || !Number.isFinite(offsetY) || !Number.isFinite(rotation)) {
    return null;
  }
  const position = {
    x: anchorX - offsetX,
    y: anchorY - offsetY,
  };
  return {
    position,
    rotation,
    dimTextPos: { ...position },
    dimTextRotation: rotation,
  };
}

function buildLeaderOppositeLandingSidePatch(entity, guide) {
  if (!isLeaderSourceTextEntity(entity) || !guide?.anchor || !guide?.sourceOffset || !guide?.elbowPoint) return null;
  const landingDirection = normalizeVector(subtract(guide.anchor, guide.elbowPoint));
  if (!landingDirection) return null;
  const normalDirection = perpendicular(landingDirection);
  const sourceOffset = {
    x: Number(guide.sourceOffset.x),
    y: Number(guide.sourceOffset.y),
  };
  if (!Number.isFinite(sourceOffset.x) || !Number.isFinite(sourceOffset.y)) return null;
  const parallel = dot(sourceOffset, landingDirection);
  const normal = dot(sourceOffset, normalDirection);
  if (!Number.isFinite(parallel) || !Number.isFinite(normal)) return null;
  const mirroredOffset = add(scale(landingDirection, parallel), scale(normalDirection, -normal));
  const position = add(guide.anchor, mirroredOffset);
  const rotation = Number.isFinite(entity.sourceTextRotation)
    ? Number(entity.sourceTextRotation)
    : Number(entity.rotation);
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(rotation)) {
    return null;
  }
  return {
    position,
    rotation,
  };
}

function buildDirectEditableSourceTextPatch(entity, patch) {
  if (!isDirectEditableSourceTextEntity(entity) || !patch || typeof patch !== 'object') return null;
  const allowedKeys = new Set(['value', 'position', 'height', 'rotation']);
  const patchKeys = Object.keys(patch);
  if (patchKeys.length === 0 || patchKeys.some((key) => !allowedKeys.has(key))) {
    return null;
  }

  const next = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'value')) {
    next.value = String(patch.value ?? entity.value ?? '');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'height')) {
    const height = Number(patch.height);
    if (!Number.isFinite(height)) return null;
    next.height = Math.max(0.1, height);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'rotation')) {
    const rotation = Number(patch.rotation);
    if (!Number.isFinite(rotation)) return null;
    next.rotation = rotation;
    if (String(entity.sourceType || '').trim().toUpperCase() === 'DIMENSION') {
      next.dimTextRotation = rotation;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'position')) {
    const position = patch.position;
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    next.position = { x, y };
    if (String(entity.sourceType || '').trim().toUpperCase() === 'DIMENSION') {
      next.dimTextPos = { x, y };
    }
  }

  return Object.keys(next).length > 0 ? next : null;
}

function buildDirectEditableInsertTextProxyPatch(entity, patch) {
  if (!isDirectEditableInsertTextProxyEntity(entity) || !patch || typeof patch !== 'object') return null;
  const patchKeys = Object.keys(patch);
  const positionUnlocked = typeof entity?.attributeLockPosition === 'boolean'
    && entity.attributeLockPosition !== true;
  const allowedKeys = new Set(positionUnlocked ? ['value', 'position'] : ['value']);
  if (patchKeys.length === 0 || patchKeys.some((key) => !allowedKeys.has(key))) {
    return null;
  }
  const nextPatch = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'value')) {
    const nextValue = String(patch.value ?? entity.value ?? '');
    nextPatch.value = nextValue;
    if (String(entity?.textKind || '').trim().toLowerCase() === 'attdef') {
      nextPatch.attributeDefault = nextValue;
    }
  }
  if (positionUnlocked && Object.prototype.hasOwnProperty.call(patch, 'position')) {
    const position = patch.position;
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    nextPatch.position = { x, y };
  }
  return Object.keys(nextPatch).length > 0 ? nextPatch : null;
}

function runResetSourceTextPlacement(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to reset source text placement' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'Source text target not found' };
  }
  if (!isSourceGroupEntity(target) || isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_SOURCE_GROUP', message: 'Selected entity is not part of a source group with text placement' };
  }
  const summary = summarizeSourceGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No source-group members found in the current space/layout' };
  }
  const textMembers = listSourceGroupTextMembers(summary.members, target);
  if (textMembers.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_HAS_NO_TEXT', message: 'Selected source group has no text members to reset' };
  }
  const resettable = textMembers.filter((entity) => hasSourceTextPlacement(entity));
  if (resettable.length === 0) {
    return { ok: false, changed: false, error_code: 'SOURCE_TEXT_PLACEMENT_UNAVAILABLE', message: 'Selected source text has no preserved source placement' };
  }
  const locked = resettable.find((entity) => ctx.document.getLayer(entity.layerId)?.locked === true);
  if (locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'Source text placement reset targets a locked layer' };
  }
  let changed = false;
  let changedCount = 0;
  for (const entity of resettable) {
    if (!hasSourceTextPlacementDrift(entity)) continue;
    const patch = buildSourceTextPlacementResetPatch(entity);
    if (!patch) continue;
    changed = ctx.document.updateEntity(entity.id, patch) || changed;
    changedCount += 1;
  }
  if (!changed) {
    return {
      ok: true,
      changed: false,
      message: `Source text placement already matches source (${resettable.length} of ${summary.memberIds.length} entities)`,
    };
  }
  return {
    ok: true,
    changed,
    message: `Reset source text placement (${changedCount} of ${summary.memberIds.length} entities)`,
  };
}

function runFlipDimensionTextSide(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to flip DIMENSION text side' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'DIMENSION text target not found' };
  }
  if (!isSourceGroupEntity(target) || isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_SOURCE_GROUP', message: 'Selected entity is not part of a DIMENSION source group' };
  }
  const summary = summarizeSourceGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No source-group members found in the current space/layout' };
  }
  const dimensionTextMembers = summary.members.filter((entity) => isDimensionSourceTextEntity(entity));
  if (dimensionTextMembers.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_HAS_NO_DIMENSION_TEXT', message: 'Selected source group has no DIMENSION text to flip' };
  }
  const locked = dimensionTextMembers.find((entity) => ctx.document.getLayer(entity.layerId)?.locked === true);
  if (locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'DIMENSION text side flip targets a locked layer' };
  }
  let changed = false;
  let changedCount = 0;
  for (const entity of dimensionTextMembers) {
    const guide = resolveSourceTextGuide(ctx.document.listEntities(), entity);
    const patch = buildDimensionOppositeTextSidePatch(entity, guide);
    if (!patch) continue;
    const nextX = Number(patch.position?.x);
    const nextY = Number(patch.position?.y);
    const nextRotation = Number(patch.rotation);
    const currentX = Number(entity.position?.x);
    const currentY = Number(entity.position?.y);
    const currentRotation = Number(entity.rotation);
    if (
      Math.abs(currentX - nextX) <= 1e-9
      && Math.abs(currentY - nextY) <= 1e-9
      && Math.abs(currentRotation - nextRotation) <= 1e-9
    ) {
      continue;
    }
    changed = ctx.document.updateEntity(entity.id, patch) || changed;
    changedCount += 1;
  }
  if (!changed) {
    return {
      ok: true,
      changed: false,
      message: `DIMENSION text already uses the opposite side (${dimensionTextMembers.length} of ${summary.memberIds.length} entities)`,
    };
  }
  return {
    ok: true,
    changed,
    message: `Applied opposite DIMENSION text side (${changedCount} of ${summary.memberIds.length} entities)`,
  };
}

function runFlipLeaderLandingSide(ctx, payload) {
  const targetId = Number.isFinite(payload?.targetId)
    ? Math.trunc(Number(payload.targetId))
    : (Number.isFinite(ctx.selection.primaryId) ? Math.trunc(Number(ctx.selection.primaryId)) : null);
  if (!Number.isFinite(targetId)) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No selection to flip LEADER landing side' };
  }
  const target = ctx.document.getEntity(targetId);
  if (!target) {
    return { ok: false, changed: false, error_code: 'INVALID_TARGET', message: 'LEADER text target not found' };
  }
  if (!isSourceGroupEntity(target) || isInsertGroupEntity(target)) {
    return { ok: false, changed: false, error_code: 'NOT_SOURCE_GROUP', message: 'Selected entity is not part of a LEADER source group' };
  }
  const summary = summarizeSourceGroupMembers(ctx.document.listEntities(), target, { isReadOnly: isReadOnlyEntity });
  if (!summary || summary.memberIds.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_EMPTY', message: 'No source-group members found in the current space/layout' };
  }
  const leaderTextMembers = summary.members.filter((entity) => isLeaderSourceTextEntity(entity));
  if (leaderTextMembers.length === 0) {
    return { ok: false, changed: false, error_code: 'GROUP_HAS_NO_LEADER_TEXT', message: 'Selected source group has no LEADER text to flip' };
  }
  const locked = leaderTextMembers.find((entity) => ctx.document.getLayer(entity.layerId)?.locked === true);
  if (locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'LEADER landing side flip targets a locked layer' };
  }
  let changed = false;
  let changedCount = 0;
  for (const entity of leaderTextMembers) {
    const guide = resolveSourceTextGuide(ctx.document.listEntities(), entity);
    const patch = buildLeaderOppositeLandingSidePatch(entity, guide);
    if (!patch) continue;
    const nextX = Number(patch.position?.x);
    const nextY = Number(patch.position?.y);
    const nextRotation = Number(patch.rotation);
    const currentX = Number(entity.position?.x);
    const currentY = Number(entity.position?.y);
    const currentRotation = Number(entity.rotation);
    if (
      Math.abs(currentX - nextX) <= 1e-9
      && Math.abs(currentY - nextY) <= 1e-9
      && Math.abs(currentRotation - nextRotation) <= 1e-9
    ) {
      continue;
    }
    changed = ctx.document.updateEntity(entity.id, patch) || changed;
    changedCount += 1;
  }
  if (!changed) {
    return {
      ok: true,
      changed: false,
      message: `LEADER text already uses the opposite landing side (${leaderTextMembers.length} of ${summary.memberIds.length} entities)`,
    };
  }
  return {
    ok: true,
    changed,
    message: `Applied opposite LEADER landing side (${changedCount} of ${summary.memberIds.length} entities)`,
  };
}

function resolveBoundarySegments(ctx, boundaryId) {
  const boundary = ctx.document.getEntity(boundaryId);
  if (!boundary) {
    return [];
  }
  return extractLineSegments(boundary);
}

function resolveBoundarySegmentsMulti(ctx, boundaryIds) {
  const ids = Array.isArray(boundaryIds) ? boundaryIds : [];
  const segments = [];
  for (const boundaryId of ids) {
    segments.push(...resolveBoundarySegments(ctx, boundaryId));
  }
  return segments;
}

function segmentProjectionParam(a, b, point) {
  const ax = a?.x;
  const ay = a?.y;
  const bx = b?.x;
  const by = b?.y;
  const px = point?.x;
  const py = point?.y;
  if (![ax, ay, bx, by, px, py].every(Number.isFinite)) return 0;
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-12) return 0;
  const t = ((px - ax) * vx + (py - ay) * vy) / lenSq;
  return Math.max(0, Math.min(1, t));
}

function approxEqualPoint(a, b, eps = 1e-6) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

function trimLineEntity(entity, pickPoint, boundaries) {
  if (!entity || entity.type !== 'line' || boundaries.length === 0) {
    return null;
  }

  let hit = null;
  for (const seg of boundaries) {
    const intersection = lineLineIntersection(entity.start, entity.end, seg.start, seg.end, true, true);
    if (!intersection) continue;
    if (!hit) {
      hit = intersection;
      continue;
    }
    if (distanceSq(intersection, pickPoint) < distanceSq(hit, pickPoint)) {
      hit = intersection;
    }
  }

  if (!hit) {
    return null;
  }

  const pick = pickPoint || entity.end;
  const distStart = distanceSq(pick, entity.start);
  const distEnd = distanceSq(pick, entity.end);
  const next = cloneValue(entity);
  if (distStart <= distEnd) {
    next.start = { x: hit.x, y: hit.y };
  } else {
    next.end = { x: hit.x, y: hit.y };
  }
  return next;
}

function resolvePolylineEndpointTarget(polyline, pickPoint) {
  if (!polyline || polyline.type !== 'polyline' || !Array.isArray(polyline.points)) return null;
  if (polyline.points.length < 2) return null;
  if (polyline.closed) return null;
  const points = polyline.points;
  const segment = resolvePolylineSegmentTarget(polyline, pickPoint);
  if (!segment) return null;

  const segLen = (a, b) => Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0));

  // Use path distance to projected pick instead of raw euclidean distance
  // so middle-segment picks choose the more intuitive extension side.
  let prefixLen = 0;
  for (let i = 0; i < segment.index0; i += 1) {
    prefixLen += segLen(points[i], points[i + 1]);
  }
  const currentLen = segLen(segment.a, segment.b);
  const tPick = segmentProjectionParam(segment.a, segment.b, pickPoint);
  const fromStart = prefixLen + currentLen * tPick;
  let totalLen = prefixLen + currentLen;
  for (let i = segment.index1; i < points.length - 1; i += 1) {
    totalLen += segLen(points[i], points[i + 1]);
  }
  const toEnd = totalLen - fromStart;
  const endpoint = fromStart <= toEnd ? 'start' : 'end';

  if (endpoint === 'start') {
    return {
      endpoint: 'start',
      a: points[0],
      b: points[1],
      index: 0,
    };
  }
  return {
    endpoint: 'end',
    a: points[points.length - 2],
    b: points[points.length - 1],
    index: points.length - 1,
  };
}

function resolvePolylineSegmentTarget(polyline, pickPoint) {
  if (!polyline || polyline.type !== 'polyline' || !Array.isArray(polyline.points)) return null;
  if (polyline.points.length < 2) return null;
  if (polyline.closed) return null;

  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < polyline.points.length - 1; i += 1) {
    const a = polyline.points[i];
    const b = polyline.points[i + 1];
    const d = pointOnSegmentDistance(pickPoint, a, b);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }

  return {
    index0: bestIndex,
    index1: bestIndex + 1,
    a: polyline.points[bestIndex],
    b: polyline.points[bestIndex + 1],
  };
}

function trimPolylineCadlike(polyline, pickPoint, boundaries) {
  if (!polyline || polyline.type !== 'polyline' || boundaries.length === 0) {
    return null;
  }
  if (!Array.isArray(polyline.points) || polyline.points.length < 2) {
    return null;
  }
  if (polyline.closed) {
    return null;
  }

  const segment = resolvePolylineSegmentTarget(polyline, pickPoint);
  if (!segment) return null;

  const hits = [];
  for (const seg of boundaries) {
    const intersection = lineLineIntersection(segment.a, segment.b, seg.start, seg.end, true, true);
    if (!intersection) continue;
    hits.push({ x: intersection.x, y: intersection.y, t: intersection.t });
  }
  if (hits.length === 0) return null;

  hits.sort((a, b) => a.t - b.t);
  const unique = [];
  for (const hit of hits) {
    const last = unique[unique.length - 1];
    if (!last || Math.abs(hit.t - last.t) > 1e-6) {
      unique.push(hit);
    }
  }

  const tPick = segmentProjectionParam(segment.a, segment.b, pickPoint);

  const clonePoint = (point) => ({ x: point.x, y: point.y });
  const points = polyline.points;

  const buildPrefix = (intersection) => {
    const prefix = points.slice(0, segment.index0 + 1).map(clonePoint);
    const ip = { x: intersection.x, y: intersection.y };
    if (prefix.length === 0 || !approxEqualPoint(prefix[prefix.length - 1], ip)) {
      prefix.push(ip);
    }
    return prefix;
  };

  const buildSuffix = (intersection) => {
    const suffix = [];
    const ip = { x: intersection.x, y: intersection.y };
    suffix.push(ip);
    for (let i = segment.index1; i < points.length; i += 1) {
      const p = points[i];
      if (i === segment.index1 && approxEqualPoint(p, ip)) continue;
      suffix.push(clonePoint(p));
    }
    return suffix;
  };

  // If pick lies strictly between two intersections on the clicked segment, remove the middle piece.
  if (unique.length >= 2) {
    for (let i = 0; i < unique.length - 1; i += 1) {
      const low = unique[i];
      const high = unique[i + 1];
      if (tPick > low.t + 1e-6 && tPick < high.t - 1e-6) {
        return {
          kind: 'split',
          left: buildPrefix(low),
          right: buildSuffix(high),
        };
      }
    }
  }

  // Otherwise trim to the closest intersection and delete the picked side.
  let closest = unique[0];
  let bestDist = Math.abs(tPick - closest.t);
  for (const hit of unique) {
    const dist = Math.abs(tPick - hit.t);
    if (dist < bestDist) {
      bestDist = dist;
      closest = hit;
    }
  }

  const keepPrefix = tPick > closest.t;
  return {
    kind: 'single',
    points: keepPrefix ? buildPrefix(closest) : buildSuffix(closest),
  };
}

function extendLineEntity(entity, pickPoint, boundaries) {
  if (!entity || entity.type !== 'line' || boundaries.length === 0) {
    return null;
  }

  const pick = pickPoint || entity.end;
  const distStart = distanceSq(pick, entity.start);
  const distEnd = distanceSq(pick, entity.end);
  const extendStart = distStart <= distEnd;

  let hit = null;
  for (const seg of boundaries) {
    const intersection = lineLineIntersection(entity.start, entity.end, seg.start, seg.end, false, true);
    if (!intersection) continue;
    if (extendStart && intersection.t > -1e-6) continue; // must be beyond start
    if (!extendStart && intersection.t < 1 + 1e-6) continue; // must be beyond end
    if (!hit) {
      hit = intersection;
      continue;
    }
    const anchor = extendStart ? entity.start : entity.end;
    if (distanceSq(intersection, anchor) < distanceSq(hit, anchor)) {
      hit = intersection;
    }
  }

  if (!hit) return null;

  const next = cloneValue(entity);
  if (extendStart) {
    next.start = { x: hit.x, y: hit.y };
  } else {
    next.end = { x: hit.x, y: hit.y };
  }
  return next;
}

function extendPolylineCadlike(polyline, pickPoint, boundaries) {
  if (!polyline || polyline.type !== 'polyline' || boundaries.length === 0) {
    return null;
  }
  if (!Array.isArray(polyline.points) || polyline.points.length < 2) {
    return null;
  }
  if (polyline.closed) {
    return null;
  }

  const target = resolvePolylineEndpointTarget(polyline, pickPoint);
  if (!target) return null;

  const endpoint = target.endpoint;
  const points = polyline.points;
  const anchor = endpoint === 'start' ? points[0] : points[points.length - 1];

  let hit = null;
  for (const seg of boundaries) {
    const intersection = lineLineIntersection(target.a, target.b, seg.start, seg.end, false, true);
    if (!intersection) continue;
    if (endpoint === 'start' && intersection.t > -1e-6) continue;
    if (endpoint === 'end' && intersection.t < 1 + 1e-6) continue;
    if (!hit || distanceSq(intersection, anchor) < distanceSq(hit, anchor)) hit = intersection;
  }

  if (!hit) return null;

  const next = cloneValue(polyline);
  next.points = [...polyline.points];
  if (endpoint === 'start') {
    next.points[0] = { x: hit.x, y: hit.y };
  } else {
    next.points[next.points.length - 1] = { x: hit.x, y: hit.y };
  }
  return next;
}

function extendPolylineSegmentCadlike(polyline, pickPoint, boundaries) {
  if (!polyline || polyline.type !== 'polyline' || boundaries.length === 0) {
    return null;
  }
  if (!Array.isArray(polyline.points) || polyline.points.length < 2) {
    return null;
  }
  if (polyline.closed) {
    return null;
  }

  const segment = resolvePolylineSegmentTarget(polyline, pickPoint);
  if (!segment) return null;

  const tPick = segmentProjectionParam(segment.a, segment.b, pickPoint);
  const endpointIndex = tPick <= 0.5 ? segment.index0 : segment.index1;
  const anchor = polyline.points[endpointIndex];

  let hit = null;
  for (const seg of boundaries) {
    const intersection = lineLineIntersection(segment.a, segment.b, seg.start, seg.end, false, true);
    if (!intersection) continue;

    // segment.a maps to t=0, segment.b maps to t=1.
    // Extend the chosen endpoint outwards from the picked segment.
    const outwards =
      (endpointIndex === segment.index0 && intersection.t < -1e-6)
      || (endpointIndex === segment.index1 && intersection.t > 1 + 1e-6);
    if (!outwards) continue;

    if (!hit || distanceSq(intersection, anchor) < distanceSq(hit, anchor)) {
      hit = intersection;
    }
  }
  if (!hit) return null;

  const next = cloneValue(polyline);
  next.points = [...polyline.points];
  next.points[endpointIndex] = { x: hit.x, y: hit.y };
  return next;
}

function runTrimSelection(ctx, payload) {
  const target = ctx.document.getEntity(payload?.targetId || ctx.selection.primaryId);
  if (!target || (target.type !== 'line' && target.type !== 'polyline')) {
    return { ok: false, changed: false, error_code: 'TRIM_TARGET', message: 'Trim target must be a line or polyline entity' };
  }
  const boundaryIds = Array.isArray(payload?.boundaryIds) && payload.boundaryIds.length > 0
    ? payload.boundaryIds
    : (Number.isFinite(payload?.boundaryId) ? [payload.boundaryId] : []);
  if (boundaryIds.length === 0) {
    return { ok: false, changed: false, error_code: 'TRIM_BOUNDARY', message: 'Trim boundary is missing' };
  }
  const segments = resolveBoundarySegmentsMulti(ctx, boundaryIds);
  if (segments.length === 0) {
    return { ok: false, changed: false, error_code: 'TRIM_BOUNDARY_EMPTY', message: 'Trim boundary has no segments' };
  }

  const pick = payload.pick && Number.isFinite(payload.pick.x) && Number.isFinite(payload.pick.y)
    ? payload.pick
    : (target.type === 'line' ? target.end : target.points?.[0] ?? { x: 0, y: 0 });

  const layer = ctx.document.getLayer(target.layerId);
  if (layer?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Layer ${layer.name} is locked` };
  }

  if (target.type === 'line') {
    const next = trimLineEntity(target, pick, segments);
    if (!next) {
      return { ok: false, changed: false, error_code: 'TRIM_NO_INTERSECTION', message: 'No trim intersection found' };
    }
    const changed = ctx.document.updateEntity(target.id, next);
    return { ok: true, changed, message: changed ? 'Trim applied' : 'Trim skipped' };
  }

  const trimmed = trimPolylineCadlike(target, pick, segments);
  if (!trimmed) {
    return { ok: false, changed: false, error_code: 'TRIM_NO_INTERSECTION', message: 'No trim intersection found' };
  }

  if (trimmed.kind === 'single') {
    const points = trimmed.points;
    if (points.length < 2) {
      ctx.document.removeEntity(target.id);
      ctx.selection.clear();
      return { ok: true, changed: true, message: 'Trim removed polyline' };
    }
    const changed = ctx.document.updateEntity(target.id, { ...target, points, closed: false });
    ctx.selection.setSelection([target.id], target.id);
    return { ok: true, changed, message: changed ? 'Trim applied' : 'Trim skipped' };
  }

  const leftPoints = trimmed.left;
  const rightPoints = trimmed.right;
  const leftValid = Array.isArray(leftPoints) && leftPoints.length >= 2;
  const rightValid = Array.isArray(rightPoints) && rightPoints.length >= 2;

  let created = null;
  let changed = false;

  if (leftValid && rightValid) {
    const raw = cloneValue(target);
    delete raw.id;
    raw.points = rightPoints;
    raw.closed = false;
    created = ctx.document.addEntity(raw);
    if (!created) {
      return { ok: false, changed: false, error_code: 'CREATE_BLOCKED', message: 'Trim split blocked by layer state' };
    }
    changed = true;
    if (!ctx.document.updateEntity(target.id, { ...target, points: leftPoints, closed: false })) {
      ctx.document.removeEntity(created.id);
      return { ok: false, changed: false, error_code: 'TRIM_APPLY_FAILED', message: 'Trim update failed' };
    }
    ctx.selection.setSelection([target.id, created.id], target.id);
    return { ok: true, changed: true, message: 'Trim split into 2 polylines' };
  }

  if (leftValid && !rightValid) {
    changed = ctx.document.updateEntity(target.id, { ...target, points: leftPoints, closed: false });
    ctx.selection.setSelection([target.id], target.id);
    return { ok: true, changed, message: changed ? 'Trim applied' : 'Trim skipped' };
  }

  if (!leftValid && rightValid) {
    changed = ctx.document.updateEntity(target.id, { ...target, points: rightPoints, closed: false });
    ctx.selection.setSelection([target.id], target.id);
    return { ok: true, changed, message: changed ? 'Trim applied' : 'Trim skipped' };
  }

  ctx.document.removeEntity(target.id);
  ctx.selection.clear();
  return { ok: true, changed: true, message: 'Trim removed polyline' };
}

function runExtendSelection(ctx, payload) {
  const target = ctx.document.getEntity(payload?.targetId || ctx.selection.primaryId);
  if (!target || (target.type !== 'line' && target.type !== 'polyline')) {
    return { ok: false, changed: false, error_code: 'EXTEND_TARGET', message: 'Extend target must be a line or polyline entity' };
  }
  const boundaryIds = Array.isArray(payload?.boundaryIds) && payload.boundaryIds.length > 0
    ? payload.boundaryIds
    : (Number.isFinite(payload?.boundaryId) ? [payload.boundaryId] : []);
  if (boundaryIds.length === 0) {
    return { ok: false, changed: false, error_code: 'EXTEND_BOUNDARY', message: 'Extend boundary is missing' };
  }
  const segments = resolveBoundarySegmentsMulti(ctx, boundaryIds);
  if (segments.length === 0) {
    return { ok: false, changed: false, error_code: 'EXTEND_BOUNDARY_EMPTY', message: 'Extend boundary has no segments' };
  }

  const pick = payload.pick && Number.isFinite(payload.pick.x) && Number.isFinite(payload.pick.y)
    ? payload.pick
    : (target.type === 'line' ? target.end : target.points?.[0] ?? { x: 0, y: 0 });

  const layer = ctx.document.getLayer(target.layerId);
  if (layer?.locked) {
    return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Layer ${layer.name} is locked` };
  }

  const next = target.type === 'line'
    ? extendLineEntity(target, pick, segments)
    : (extendPolylineSegmentCadlike(target, pick, segments) || extendPolylineCadlike(target, pick, segments));
  if (!next) {
    return { ok: false, changed: false, error_code: 'EXTEND_NO_INTERSECTION', message: 'No extend intersection found' };
  }

  const changed = ctx.document.updateEntity(target.id, next);
  return { ok: true, changed, message: changed ? 'Extend applied' : 'Extend skipped' };
}

function runPropertyPatch(ctx, payload) {
  const ids = resolvePropertyPatchIds(ctx, payload);
  const patch = payload?.patch;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, changed: false, error_code: 'NO_SELECTION', message: 'No entities to patch' };
  }
  if (!patch || typeof patch !== 'object') {
    return { ok: false, changed: false, error_code: 'INVALID_PATCH', message: 'Invalid property patch' };
  }
  let changed = false;
  let attempted = 0;
  let lockedSkipped = 0;
  let readOnlySkipped = 0;

  for (const id of ids) {
    const entity = ctx.document.getEntity(id);
    if (!entity) continue;
    attempted += 1;

    const currentLayer = ctx.document.getLayer(entity.layerId);
    const targetLayerId = Number.isFinite(patch?.layerId) ? Number(patch.layerId) : entity.layerId;
    const layer = ctx.document.getLayer(targetLayerId);
    if (currentLayer?.locked || layer?.locked) {
      lockedSkipped += 1;
      continue;
    }

    if (isReadOnlyEntity(entity)) {
      const directPatch = buildDirectEditableSourceTextPatch(entity, patch)
        || buildDirectEditableInsertTextProxyPatch(entity, patch);
      if (!directPatch) {
        readOnlySkipped += 1;
        continue;
      }
      changed = ctx.document.updateEntity(id, directPatch) || changed;
      continue;
    }

    changed = ctx.document.updateEntity(id, patch) || changed;
  }

  if (!changed) {
    if (attempted > 0 && readOnlySkipped === attempted) {
      return { ok: false, changed: false, error_code: 'UNSUPPORTED_READ_ONLY', message: 'Selected entities are read-only proxies' };
    }
    if (attempted > 0 && lockedSkipped === attempted) {
      if (attempted === 1) {
        const id = ids.find((entityId) => !!ctx.document.getEntity(entityId));
        const entity = id ? ctx.document.getEntity(id) : null;
        const currentLayer = Number.isFinite(entity?.layerId) ? ctx.document.getLayer(entity.layerId) : null;
        const layerId = Number.isFinite(patch?.layerId) ? Number(patch.layerId) : entity?.layerId;
        const layer = Number.isFinite(layerId) ? ctx.document.getLayer(layerId) : null;
        const lockedLayer = currentLayer?.locked ? currentLayer : layer;
        const name = lockedLayer?.name ?? String(lockedLayer?.id ?? layerId ?? '');
        return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: `Layer ${name} is locked` };
      }
      return { ok: false, changed: false, error_code: 'LAYER_LOCKED', message: 'All selected entities are on locked layers' };
    }
    if (attempted > 0 && (lockedSkipped + readOnlySkipped === attempted) && readOnlySkipped > 0) {
      return {
        ok: false,
        changed: false,
        error_code: 'UNSUPPORTED_READ_ONLY',
        message: 'All selected entities are read-only or locked',
      };
    }
    return { ok: true, changed: false, message: 'selection.propertyPatch: no changes' };
  }

  if (lockedSkipped > 0 || readOnlySkipped > 0) {
    const applied = Math.max(0, attempted - lockedSkipped - readOnlySkipped);
    const skippedParts = [];
    if (lockedSkipped > 0) skippedParts.push(`${lockedSkipped} locked`);
    if (readOnlySkipped > 0) skippedParts.push(`${readOnlySkipped} read-only`);
    return {
      ok: true,
      changed: true,
      message: `Patched ${applied}/${attempted} entities (skipped ${skippedParts.join(', ')})`,
    };
  }
  return { ok: true, changed: true, message: `Patched ${attempted} entities` };
}

function resolvePropertyPatchIds(ctx, payload) {
  const raw = payload?.entityIds?.length ? payload.entityIds : ctx.selection.entityIds;
  if (!Array.isArray(raw)) return [];
  const unique = new Set();
  for (const id of raw) {
    if (!Number.isFinite(id)) continue;
    unique.add(Number(id));
  }
  return [...unique];
}

function captureEntitySubset(ctx, ids) {
  const out = [];
  for (const id of ids) {
    const entity = ctx.document.getEntity(id);
    if (!entity) continue;
    out.push({ id, entity: cloneValue(entity) });
  }
  return out;
}

function restoreEntitySubset(ctx, snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return;
  const touched = [];
  for (const item of snapshot) {
    if (!item || !Number.isFinite(item.id) || !item.entity) continue;
    const id = Number(item.id);
    const entity = cloneValue(item.entity);
    ctx.document.ensureLayer(entity.layerId);
    // Intentionally bypass layer-lock checks so undo/redo stays deterministic.
    ctx.document.entities.set(id, entity);
    ctx.document.spatialIndex.upsert(entity);
    touched.push(id);
  }
  if (touched.length > 0) {
    ctx.document.emitChange('entity-batch-restore', { entityIds: touched, count: touched.length });
  }
}

function runPropertyPatchWithHistory(ctx, payload) {
  const ids = resolvePropertyPatchIds(ctx, payload);
  if (ids.length === 0) {
    return commandResult(false, false, {
      message: 'No entities to patch',
      error_code: 'NO_SELECTION',
    });
  }

  const tBefore = nowMs();
  const before = captureEntitySubset(ctx, ids);
  const beforeMs = nowMs() - tBefore;
  emitPerfProfile(ctx, { commandId: 'selection.propertyPatch', phase: 'before', ms: beforeMs });

  const tMutator = nowMs();
  const outcome = runPropertyPatch(ctx, payload);
  const mutatorMs = nowMs() - tMutator;
  emitPerfProfile(ctx, { commandId: 'selection.propertyPatch', phase: 'mutator', ms: mutatorMs });

  if (!outcome.ok) {
    return commandResult(false, false, {
      message: outcome.message,
      error_code: outcome.error_code || 'COMMAND_FAILED',
    });
  }
  if (!outcome.changed) {
    return commandResult(true, false, {
      message: outcome.message || 'selection.propertyPatch: no changes',
    });
  }

  const tAfter = nowMs();
  const after = captureEntitySubset(ctx, ids);
  const afterMs = nowMs() - tAfter;
  emitPerfProfile(ctx, { commandId: 'selection.propertyPatch', phase: 'after', ms: afterMs });

  return commandResult(true, true, {
    message: outcome.message || 'selection.propertyPatch: applied',
    undo: () => restoreEntitySubset(ctx, before),
    redo: () => restoreEntitySubset(ctx, after),
  });
}

function runCreateEntity(ctx, payload) {
  const entityPayload = payload?.entity;
  if (!entityPayload || typeof entityPayload !== 'object') {
    return { ok: false, changed: false, error_code: 'INVALID_ENTITY', message: 'Entity payload is missing' };
  }
  const created = ctx.document.addEntity(entityPayload);
  if (!created) {
    return { ok: false, changed: false, error_code: 'CREATE_BLOCKED', message: 'Entity create blocked by layer state' };
  }
  ctx.selection.setSelection([created.id], created.id);
  return { ok: true, changed: true, message: `Created ${created.type}` };
}

function runCreateEntities(ctx, payload) {
  const list = Array.isArray(payload?.entities) ? payload.entities : [];
  if (list.length === 0) {
    return { ok: false, changed: false, error_code: 'INVALID_ENTITY_LIST', message: 'Entity list is empty' };
  }
  const created = ctx.document.addEntities(list);
  if (created.length > 0) {
    ctx.selection.setSelection(created.map((entity) => entity.id), created[0].id);
  }
  return { ok: true, changed: created.length > 0, message: `Created ${created.length} entities` };
}

// Apply caller-provided geometry patches to existing entities, by id. Generic + format-
// agnostic (the patch is editor-native geometry, e.g. {start,end} for a line); used by the
// product layer to write solved sketch geometry back into the editor. Undo/redo come from the
// withSnapshot wrapper at the command site, so this is one native, Ctrl-Z-reversible step.
function runSelectByBox(ctx, payload) {
  const rect = payload?.rect;
  if (!rect) {
    return { ok: false, changed: false, error_code: 'INVALID_RECT', message: 'Selection box payload is missing' };
  }
  const crossing = payload?.crossing === true;
  const minX = Math.min(rect.x0, rect.x1);
  const maxX = Math.max(rect.x0, rect.x1);
  const minY = Math.min(rect.y0, rect.y1);
  const maxY = Math.max(rect.y0, rect.y1);
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
    return { ok: false, changed: false, error_code: 'INVALID_RECT', message: 'Selection box contains invalid values' };
  }
  const isInside = (point) => !!point
    && point.x >= minX
    && point.x <= maxX
    && point.y >= minY
    && point.y <= maxY;
  const ids = [];
  const candidateIds = typeof ctx.document.queryVisibleEntityIdsInRect === 'function'
    ? ctx.document.queryVisibleEntityIdsInRect(rect, { sortById: false })
    : ctx.document.listVisibleEntities().map((entity) => entity.id);
  for (const entityId of candidateIds) {
    const entity = ctx.document.getEntity(entityId);
    if (!entity || entity.visible === false) continue;
    if (entity.type === 'line') {
      let insideCount = 0;
      if (isInside(entity.start)) insideCount += 1;
      if (isInside(entity.end)) insideCount += 1;
      const hit = crossing ? insideCount > 0 : insideCount === 2;
      if (hit) ids.push(entity.id);
      continue;
    }
    if (entity.type === 'polyline' && Array.isArray(entity.points)) {
      let insideCount = 0;
      for (const point of entity.points) {
        if (!isInside(point)) continue;
        insideCount += 1;
        if (crossing) break;
      }
      const hit = crossing ? insideCount > 0 : insideCount === entity.points.length;
      if (hit) ids.push(entity.id);
      continue;
    }
    const anchor = entity.center || entity.position || entity.start || null;
    if (!anchor) continue;
    const hit = isInside(anchor);
    if (hit) ids.push(entity.id);
  }
  if (ids.length > 1) {
    ids.sort((a, b) => a - b);
  }
  ctx.selection.setSelection(ids, ids[0] ?? null);
  return {
    ok: true,
    changed: true,
    message: `Selected ${ids.length} entities`,
  };
}

function runUndo(ctx) {
  return ctx.commandBus.undo();
}

function runRedo(ctx) {
  return ctx.commandBus.redo();
}

export function registerCadCommands(commandBus, context) {
  const commands = [
    {
      id: 'entity.create',
      label: 'Create Entity',
      canExecute: () => true,
      execute: (ctx, payload) => withSnapshot(ctx, 'entity.create', () => runCreateEntity(ctx, payload)),
    },
    {
      id: 'entity.createMany',
      label: 'Create Entities',
      canExecute: () => true,
      execute: (ctx, payload) => withSnapshot(ctx, 'entity.createMany', () => runCreateEntities(ctx, payload)),
    },
    {
      id: 'entity.applyGeometry',
      label: 'Apply Geometry',
      canExecute: (ctx, payload) => Array.isArray(payload?.updates) && payload.updates.length > 0,
      execute: (ctx, payload) => withSnapshot(ctx, 'entity.applyGeometry', () => runApplyGeometry(ctx, payload)),
    },
    {
      id: 'selection.delete',
      label: 'Delete Selection',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx) => withSnapshot(ctx, 'selection.delete', () => runDeleteSelection(ctx)),
    },
    {
      id: 'selection.move',
      label: 'Move Selection',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.move', () => runMoveSelection(ctx, payload)),
    },
    {
      id: 'selection.copy',
      label: 'Copy Selection',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.copy', () => runCopySelection(ctx, payload)),
    },
    {
      id: 'selection.offset',
      label: 'Offset Selection',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.offset', () => runOffsetSelection(ctx, payload)),
    },
    {
      id: 'selection.break',
      label: 'Break',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.break', () => runBreakSelection(ctx, payload)),
    },
    {
      id: 'selection.join',
      label: 'Join',
      canExecute: (ctx) => Array.isArray(ctx.selection.entityIds) && ctx.selection.entityIds.length >= 2,
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.join', () => runJoinSelection(ctx, payload)),
    },
    {
      id: 'selection.fillet',
      label: 'Fillet',
      canExecute: (ctx) => Array.isArray(ctx.selection.entityIds) && ctx.selection.entityIds.length === 2,
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.fillet', () => runFilletSelection(ctx, payload)),
    },
    {
      id: 'selection.filletByPick',
      label: 'Fillet (By Pick)',
      canExecute: () => true,
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.filletByPick', () => runFilletSelectionByPick(ctx, payload)),
    },
    {
      id: 'selection.chamfer',
      label: 'Chamfer',
      canExecute: (ctx) => Array.isArray(ctx.selection.entityIds) && ctx.selection.entityIds.length === 2,
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.chamfer', () => runChamferSelection(ctx, payload)),
    },
    {
      id: 'selection.chamferByPick',
      label: 'Chamfer (By Pick)',
      canExecute: () => true,
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.chamferByPick', () => runChamferSelectionByPick(ctx, payload)),
    },
    {
      id: 'selection.rotate',
      label: 'Rotate Selection',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.rotate', () => runRotateSelection(ctx, payload)),
    },
    {
      id: 'selection.scale',
      label: 'Scale Selection',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.scale', () => runScaleSelection(ctx, payload)),
    },
    {
      id: 'selection.trim',
      label: 'Trim',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.trim', () => runTrimSelection(ctx, payload)),
    },
    {
      id: 'selection.extend',
      label: 'Extend',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.extend', () => runExtendSelection(ctx, payload)),
    },
    {
      id: 'selection.propertyPatch',
      label: 'Patch Properties',
      canExecute: (ctx) => selectedEntities(ctx).length > 0,
      execute: (ctx, payload) => runPropertyPatchWithHistory(ctx, payload),
    },
    {
      id: 'selection.insertGroup',
      label: 'Select Insert Group',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.insertGroup', () => runSelectInsertGroup(ctx, payload)),
    },
    {
      id: 'selection.releasedInsertGroup',
      label: 'Select Released Insert Group',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.releasedInsertGroup', () => runSelectReleasedInsertGroup(ctx, payload)),
    },
    {
      id: 'selection.sourceGroup',
      label: 'Select Source Group',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.sourceGroup', () => runSelectSourceGroup(ctx, payload)),
    },
    {
      id: 'selection.insertEditableGroup',
      label: 'Select Editable Insert Members',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.insertEditableGroup', () => runSelectEditableInsertGroup(ctx, payload)),
    },
    {
      id: 'selection.insertSelectText',
      label: 'Select Insert Text',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.insertSelectText', () => runSelectInsertGroupText(ctx, payload)),
    },
    {
      id: 'selection.insertSelectEditableText',
      label: 'Select Editable Insert Text',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.insertSelectEditableText', () => runSelectEditableInsertGroupText(ctx, payload)),
    },
    {
      id: 'selection.insertReleaseGroup',
      label: 'Release Insert Group',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.insertReleaseGroup', () => runReleaseInsertGroup(ctx, payload)),
    },
    {
      id: 'selection.insertEditText',
      label: 'Release And Edit Insert Text',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.insertEditText', () => runEditInsertText(ctx, payload)),
    },
    {
      id: 'selection.sourceReleaseGroup',
      label: 'Release Source Group',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.sourceReleaseGroup', () => runReleaseSourceGroup(ctx, payload)),
    },
    {
      id: 'selection.sourceEditGroupText',
      label: 'Release And Edit Source Text',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.sourceEditGroupText', () => runEditSourceGroupText(ctx, payload)),
    },
    {
      id: 'selection.sourceResetTextPlacement',
      label: 'Reset Source Text Placement',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.sourceResetTextPlacement', () => runResetSourceTextPlacement(ctx, payload)),
    },
    {
      id: 'selection.dimensionFlipTextSide',
      label: 'Use Opposite DIMENSION Text Side',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.dimensionFlipTextSide', () => runFlipDimensionTextSide(ctx, payload)),
    },
    {
      id: 'selection.leaderFlipLandingSide',
      label: 'Use Opposite LEADER Landing Side',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.leaderFlipLandingSide', () => runFlipLeaderLandingSide(ctx, payload)),
    },
    {
      id: 'selection.sourceSelectText',
      label: 'Select Source Text',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.sourceSelectText', () => runSelectSourceGroupText(ctx, payload)),
    },
    {
      id: 'selection.sourceSelectAnchorDriver',
      label: 'Select Source Anchor Driver',
      canExecute: (ctx) => hasSelection(ctx),
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.sourceSelectAnchorDriver', () => runSelectSourceAnchorDriver(ctx, payload)),
    },
    {
      id: 'selection.box',
      label: 'Box Select',
      canExecute: () => true,
      execute: (ctx, payload) => withSnapshot(ctx, 'selection.box', () => runSelectByBox(ctx, payload)),
    },
    {
      id: 'history.undo',
      label: 'Undo',
      canExecute: () => true,
      execute: (ctx) => runUndo(ctx),
    },
    {
      id: 'history.redo',
      label: 'Redo',
      canExecute: () => true,
      execute: (ctx) => runRedo(ctx),
    },
    // --- Solver bridge commands ---
    {
      id: 'solver.export-project',
      label: 'Export Solver Project',
      canExecute: (ctx) => ctx.document.listConstraints().length > 0,
      execute: (ctx) => {
        const constraints = ctx.document.listConstraints();
        if (constraints.length === 0) {
          return commandResult(false, false, { message: 'No constraints to export', error_code: 'NO_CONSTRAINTS' });
        }
        const project = buildSolverProject(ctx);
        return commandResult(true, false, { message: `Exported ${constraints.length} constraints`, project });
      },
    },
    {
      id: 'solver.import-diagnostics',
      label: 'Import Solver Diagnostics',
      canExecute: () => true,
      execute: (ctx, payload) => {
        if (!payload || typeof payload !== 'object') {
          return commandResult(false, false, { message: 'Invalid diagnostics payload', error_code: 'INVALID_PAYLOAD' });
        }
        const setSolverDiagnostics = ctx.setSolverDiagnostics;
        if (typeof setSolverDiagnostics === 'function') {
          setSolverDiagnostics(payload, 'Solver diagnostics imported via command');
        }
        return commandResult(true, false, { message: 'Solver diagnostics imported', diagnostics: payload });
      },
    },
  ];

  for (const command of commands) {
    commandBus.register(command);
  }

  context.commandBus = commandBus;

  return commands;
}

export function computeRotatePayload(center, referencePoint, targetPoint) {
  const start = angleFrom(center, referencePoint);
  const end = angleFrom(center, targetPoint);
  return {
    center,
    angle: angleDelta(start, end),
  };
}

export function computeScalePayload(center, referencePoint, targetPoint) {
  const baseDistance = distance(center, referencePoint);
  const targetDistance = distance(center, targetPoint);
  if (!Number.isFinite(baseDistance) || !Number.isFinite(targetDistance) || baseDistance <= EPSILON || targetDistance <= EPSILON) {
    return null;
  }
  return {
    center,
    factor: targetDistance / baseDistance,
  };
}
