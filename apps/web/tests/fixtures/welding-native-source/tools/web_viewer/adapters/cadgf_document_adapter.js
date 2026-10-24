import {
  deriveLegacyAttdefDefault,
  isInsertTextProxyMetadata,
  normalizeColorAci,
  normalizeColorSource,
  normalizeTextKind,
} from '../import_normalization.js';
import {
  normalizeImportedAttributeMetadata,
  normalizeImportedAnnotationMetadata,
  resolveImportedEntityVisibilityPolicy,
  resolveImportedTextValuePolicy,
  normalizeImportedEntityMetadataBase,
  normalizeImportedEntityStyle,
} from '../entity_import_normalization.js';

const CADGF_ENTITY_TYPES = {
  POLYLINE: 0,
  POINT: 1,
  LINE: 2,
  ARC: 3,
  CIRCLE: 4,
  ELLIPSE: 5,
  SPLINE: 6,
  TEXT: 7,
};

function cloneJson(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isCadgfDocument(payload) {
  if (!isObject(payload)) return false;
  if (typeof payload.cadgf_version !== 'string') return false;
  if (!Number.isFinite(payload.schema_version)) return false;
  if (!Array.isArray(payload.layers)) return false;
  if (!Array.isArray(payload.entities)) return false;
  if (!isObject(payload.metadata)) return false;
  if (!isObject(payload.settings)) return false;
  if (!isObject(payload.feature_flags)) return false;
  return true;
}

function normalizeBoolInt(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  return fallback;
}

function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function intToHexColor(colorInt, fallback = '#9ca3af') {
  if (!Number.isFinite(colorInt)) return fallback;
  const value = clampInt(colorInt, 0, 0xffffff);
  return `#${value.toString(16).padStart(6, '0')}`.toLowerCase();
}

function hexToIntColor(hex, fallback = 0x9ca3af) {
  if (typeof hex !== 'string') return fallback;
  const match = hex.trim().match(/^#([0-9a-fA-F]{6})$/);
  if (!match) return fallback;
  const value = Number.parseInt(match[1], 16);
  return clampInt(value, 0, 0xffffff);
}

function vec2ToPoint(vec) {
  if (!Array.isArray(vec) || vec.length < 2) return null;
  const x = Number(vec[0]);
  const y = Number(vec[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function pointToVec2(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
}

function getInferredSourceProxyMetadata(raw, meta) {
  if (Number(raw?.type) !== CADGF_ENTITY_TYPES.TEXT) return null;
  const textKind = normalizeTextKind(meta?.textKind);
  if (textKind === 'mleader' && (!meta?.sourceType || !meta?.editMode || !meta?.proxyKind)) {
    return {
      sourceType: 'LEADER',
      editMode: 'proxy',
      proxyKind: 'mleader',
    };
  }
  if (textKind === 'table' && (!meta?.sourceType || !meta?.editMode || !meta?.proxyKind)) {
    return {
      sourceType: 'TABLE',
      editMode: 'proxy',
      proxyKind: 'table',
    };
  }
  return null;
}

function getPromotedInsertTextProxyMetadata(raw, meta) {
  if (Number(raw?.type) !== CADGF_ENTITY_TYPES.TEXT) return null;
  const textKind = normalizeTextKind(meta?.textKind);
  if (textKind !== 'attrib' && textKind !== 'attdef') return null;
  const sourceType = String(meta?.sourceType || '').trim().toUpperCase();
  const editMode = String(meta?.editMode || '').trim().toLowerCase();
  const proxyKind = String(meta?.proxyKind || '').trim().toLowerCase();
  const blockName = typeof meta?.blockName === 'string' ? meta.blockName.trim() : '';
  if (sourceType !== 'INSERT' || editMode !== 'exploded' || proxyKind !== 'insert' || !blockName) {
    return null;
  }
  return {
    sourceType: 'INSERT',
    editMode: 'proxy',
    proxyKind: 'text',
  };
}

function isSyntheticSingleTextSourceProxyMetadata(raw, meta) {
  if (Number(raw?.type) !== CADGF_ENTITY_TYPES.TEXT) return false;
  const textKind = normalizeTextKind(meta?.textKind);
  const sourceType = String(meta?.sourceType || '').trim().toUpperCase();
  const editMode = String(meta?.editMode || '').trim().toLowerCase();
  if (editMode !== 'proxy') return false;
  return (
    (textKind === 'mleader' && sourceType === 'LEADER')
    || (textKind === 'table' && sourceType === 'TABLE')
  );
}

function extractEntityMetadata(raw) {
  const meta = {};
  Object.assign(meta, normalizeImportedEntityMetadataBase(raw, {
    groupIdKeys: ['group_id'],
    spaceKeys: ['space'],
    requireOwnSpaceKeys: true,
    layoutKeys: ['layout', 'layout_name'],
    colorSourceKeys: ['color_source'],
    colorAciKeys: ['color_aci'],
    sourceTypeKeys: ['source_type'],
    editModeKeys: ['edit_mode'],
    proxyKindKeys: ['proxy_kind'],
    blockNameKeys: ['block_name'],
    hatchPatternKeys: ['hatch_pattern'],
    hatchIdKeys: ['hatch_id'],
    sourceBundleIdKeys: ['source_bundle_id'],
  }));

  Object.assign(meta, normalizeImportedAttributeMetadata(raw, {
    textKindKeys: ['text_kind'],
    attributeTagKeys: ['attribute_tag'],
    attributeDefaultKeys: ['attribute_default'],
    attributePromptKeys: ['attribute_prompt'],
    attributeFlagsKeys: ['attribute_flags'],
    attributeInvisibleKeys: ['attribute_invisible'],
    attributeConstantKeys: ['attribute_constant'],
    attributeVerifyKeys: ['attribute_verify'],
    attributePresetKeys: ['attribute_preset'],
    attributeLockPositionKeys: ['attribute_lock_position'],
  }));
  if (typeof raw?.dim_style === 'string' && raw.dim_style.trim()) meta.dimStyle = raw.dim_style.trim();
  if (Number.isFinite(raw?.dim_type)) meta.dimType = Math.trunc(raw.dim_type);

  const inferredSourceProxy = getInferredSourceProxyMetadata(raw, meta);
  if (inferredSourceProxy) {
    if (!meta.sourceType) meta.sourceType = inferredSourceProxy.sourceType;
    if (!meta.editMode) meta.editMode = inferredSourceProxy.editMode;
    if (!meta.proxyKind) meta.proxyKind = inferredSourceProxy.proxyKind;
  }
  const promotedInsertTextProxy = getPromotedInsertTextProxyMetadata(raw, meta);
  if (promotedInsertTextProxy) {
    meta.sourceType = promotedInsertTextProxy.sourceType;
    meta.editMode = promotedInsertTextProxy.editMode;
    meta.proxyKind = promotedInsertTextProxy.proxyKind;
  }
  const sourceType = typeof meta.sourceType === 'string' ? meta.sourceType.trim().toUpperCase() : '';
  const editMode = typeof meta.editMode === 'string' ? meta.editMode.trim().toLowerCase() : '';
  Object.assign(meta, normalizeImportedAnnotationMetadata({
    explicitSourceTextPos: null,
    explicitSourceTextRotation: null,
    textPos: vec2ToPoint(raw?.text?.pos),
    textRotation: Number.isFinite(Number(raw?.text?.rot)) ? Number(raw.text.rot) : null,
    dimTextPos: vec2ToPoint(raw?.dim_text_pos),
    dimTextRotation: Number.isFinite(Number(raw?.dim_text_rotation)) ? Number(raw.dim_text_rotation) : null,
    sourceAnchor: vec2ToPoint(raw?.source_anchor),
    leaderLanding: vec2ToPoint(raw?.leader_landing),
    leaderElbow: vec2ToPoint(raw?.leader_elbow),
    sourceAnchorDriverId: Number.isFinite(Number(raw?.source_anchor_driver_id)) ? Number(raw.source_anchor_driver_id) : null,
    sourceAnchorDriverType: typeof raw?.source_anchor_driver_type === 'string' ? raw.source_anchor_driver_type : '',
    sourceAnchorDriverKind: typeof raw?.source_anchor_driver_kind === 'string' ? raw.source_anchor_driver_kind : '',
  }, {
    proxyTextFallbackEnabled: !!sourceType && editMode === 'proxy' && Number(raw?.type) === CADGF_ENTITY_TYPES.TEXT,
    sourceTextFallbackOrder: sourceType === 'DIMENSION'
      ? ['dimension', 'text']
      : ['text'],
    sourceTextRotationFallbackOrder: sourceType === 'DIMENSION'
      ? ['dimension', 'text']
      : ['text'],
  }));

  return meta;
}

function isAnonymousDimensionBlockName(value) {
  return typeof value === 'string' && /^\*d/i.test(value.trim());
}

function deriveMissingDimensionSourceBundleIds(entities) {
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  const bundleIds = new Map();

  for (const entity of list) {
    const sourceType = typeof entity?.sourceType === 'string' ? entity.sourceType.trim().toUpperCase() : '';
    const blockName = typeof entity?.blockName === 'string' ? entity.blockName.trim() : '';
    const groupId = Number.isFinite(entity?.groupId) ? Math.trunc(Number(entity.groupId)) : null;
    if (sourceType !== 'DIMENSION' || !isAnonymousDimensionBlockName(blockName) || groupId === null) {
      continue;
    }
    const space = Number.isFinite(entity?.space) ? Math.trunc(Number(entity.space)) : 0;
    const layout = typeof entity?.layout === 'string' ? entity.layout.trim() : '';
    const explicitBundleId = Number.isFinite(entity?.sourceBundleId)
      ? Math.trunc(Number(entity.sourceBundleId))
      : groupId;
    const key = `${space}|${layout}|${blockName}`;
    const existing = bundleIds.get(key);
    if (!Number.isFinite(existing) || explicitBundleId < existing) {
      bundleIds.set(key, explicitBundleId);
    }
  }

  for (const entity of list) {
    if (Number.isFinite(entity?.sourceBundleId)) continue;
    const sourceType = typeof entity?.sourceType === 'string' ? entity.sourceType.trim().toUpperCase() : '';
    const blockName = typeof entity?.blockName === 'string' ? entity.blockName.trim() : '';
    if (sourceType !== 'DIMENSION' || !isAnonymousDimensionBlockName(blockName)) {
      continue;
    }
    const space = Number.isFinite(entity?.space) ? Math.trunc(Number(entity.space)) : 0;
    const layout = typeof entity?.layout === 'string' ? entity.layout.trim() : '';
    const key = `${space}|${layout}|${blockName}`;
    const derivedBundleId = bundleIds.get(key);
    if (Number.isFinite(derivedBundleId)) {
      entity.sourceBundleId = derivedBundleId;
    }
  }
}

function applyEntityMetadataPatch(target, entity) {
  if (!target || !entity) return target;
  if (Number.isFinite(entity.groupId)) target.group_id = Math.trunc(entity.groupId);
  if (Number.isFinite(entity.space)) target.space = Math.trunc(entity.space);
  if (typeof entity.layout === 'string' && entity.layout.trim()) target.layout = entity.layout.trim();
  if (typeof entity.sourceType === 'string' && entity.sourceType.trim()) target.source_type = entity.sourceType.trim();
  if (typeof entity.editMode === 'string' && entity.editMode.trim()) target.edit_mode = entity.editMode.trim();
  if (typeof entity.proxyKind === 'string' && entity.proxyKind.trim()) target.proxy_kind = entity.proxyKind.trim();
  if (typeof entity.blockName === 'string' && entity.blockName.trim()) target.block_name = entity.blockName.trim();
  if (typeof entity.hatchPattern === 'string' && entity.hatchPattern.trim()) target.hatch_pattern = entity.hatchPattern.trim();
  if (Number.isFinite(entity.hatchId)) target.hatch_id = Math.trunc(entity.hatchId);
  if (Number.isFinite(entity.sourceBundleId)) target.source_bundle_id = Math.trunc(entity.sourceBundleId);
  else delete target.source_bundle_id;
  if (typeof entity.textKind === 'string' && entity.textKind.trim()) target.text_kind = entity.textKind.trim();
  else delete target.text_kind;
  if (typeof entity.attributeTag === 'string' && entity.attributeTag.trim()) target.attribute_tag = entity.attributeTag.trim();
  else delete target.attribute_tag;
  if (typeof entity.attributeDefault === 'string') target.attribute_default = entity.attributeDefault;
  else delete target.attribute_default;
  if (typeof entity.attributePrompt === 'string') target.attribute_prompt = entity.attributePrompt;
  else delete target.attribute_prompt;
  if (Number.isFinite(entity.attributeFlags)) target.attribute_flags = Math.trunc(entity.attributeFlags);
  else delete target.attribute_flags;
  if (typeof entity.attributeInvisible === 'boolean') target.attribute_invisible = entity.attributeInvisible;
  else delete target.attribute_invisible;
  if (typeof entity.attributeConstant === 'boolean') target.attribute_constant = entity.attributeConstant;
  else delete target.attribute_constant;
  if (typeof entity.attributeVerify === 'boolean') target.attribute_verify = entity.attributeVerify;
  else delete target.attribute_verify;
  if (typeof entity.attributePreset === 'boolean') target.attribute_preset = entity.attributePreset;
  else delete target.attribute_preset;
  if (typeof entity.attributeLockPosition === 'boolean') target.attribute_lock_position = entity.attributeLockPosition;
  else delete target.attribute_lock_position;
  if (typeof entity.dimStyle === 'string' && entity.dimStyle.trim()) target.dim_style = entity.dimStyle.trim();
  else delete target.dim_style;
  if (Number.isFinite(entity.dimType)) target.dim_type = Math.trunc(entity.dimType);
  if (entity.dimTextPos && Number.isFinite(entity.dimTextPos.x) && Number.isFinite(entity.dimTextPos.y)) {
    target.dim_text_pos = pointToVec2(entity.dimTextPos);
  }
  if (Number.isFinite(entity.dimTextRotation)) target.dim_text_rotation = Number(entity.dimTextRotation);
  if (entity.sourceAnchor && Number.isFinite(entity.sourceAnchor.x) && Number.isFinite(entity.sourceAnchor.y)) {
    target.source_anchor = pointToVec2(entity.sourceAnchor);
  } else {
    delete target.source_anchor;
  }
  if (entity.leaderLanding && Number.isFinite(entity.leaderLanding.x) && Number.isFinite(entity.leaderLanding.y)) {
    target.leader_landing = pointToVec2(entity.leaderLanding);
  } else {
    delete target.leader_landing;
  }
  if (entity.leaderElbow && Number.isFinite(entity.leaderElbow.x) && Number.isFinite(entity.leaderElbow.y)) {
    target.leader_elbow = pointToVec2(entity.leaderElbow);
  } else {
    delete target.leader_elbow;
  }
  if (Number.isFinite(entity.sourceAnchorDriverId)) {
    target.source_anchor_driver_id = Math.trunc(entity.sourceAnchorDriverId);
  } else {
    delete target.source_anchor_driver_id;
  }
  if (typeof entity.sourceAnchorDriverType === 'string' && entity.sourceAnchorDriverType.trim()) {
    target.source_anchor_driver_type = entity.sourceAnchorDriverType.trim();
  } else {
    delete target.source_anchor_driver_type;
  }
  if (typeof entity.sourceAnchorDriverKind === 'string' && entity.sourceAnchorDriverKind.trim()) {
    target.source_anchor_driver_kind = entity.sourceAnchorDriverKind.trim();
  } else {
    delete target.source_anchor_driver_kind;
  }
  return target;
}

function applyEntityColorPatch(target, entity, layer = null) {
  if (!target || !entity) return target;
  const colorSource = normalizeColorSource(entity.colorSource) || 'TRUECOLOR';
  const layerColorInt = layer ? hexToIntColor(layer.color, target.color ?? 0xffffff) : (target.color ?? 0xffffff);
  target.color_source = colorSource;
  target.color = colorSource === 'BYLAYER'
    ? layerColorInt
    : hexToIntColor(entity.color, target.color ?? layerColorInt);

  const colorAci = normalizeColorAci(entity.colorAci);
  if (colorAci !== null) {
    target.color_aci = colorAci;
  } else if (colorSource === 'TRUECOLOR') {
    target.color_aci = 0;
  } else {
    delete target.color_aci;
  }
  return target;
}

function applyEntityStylePatch(target, entity) {
  if (!target || !entity) return target;
  target.line_type = typeof entity.lineType === 'string' && entity.lineType.trim()
    ? entity.lineType.trim().toUpperCase()
    : 'CONTINUOUS';
  if (String(entity.lineWeightSource || '').trim().toUpperCase() === 'BYLAYER') {
    delete target.line_weight;
  } else {
    target.line_weight = Number.isFinite(entity.lineWeight)
      ? Math.max(0, Number(entity.lineWeight))
      : 0;
  }
  if (String(entity.lineTypeScaleSource || '').trim().toUpperCase() === 'DEFAULT') {
    delete target.line_type_scale;
  } else {
    target.line_type_scale = Number.isFinite(entity.lineTypeScale)
      ? Math.max(0, Number(entity.lineTypeScale))
      : 1;
  }
  return target;
}

function approxEqual(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

function approxEqualPoint(a, b, eps = 1e-9) {
  if (!a || !b) return false;
  return approxEqual(a.x, b.x, eps) && approxEqual(a.y, b.y, eps);
}

function coerceId(raw, fallback = 0) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.trunc(value);
}

function makeUnsupportedDisplayProxy(rawEntity) {
  if (!rawEntity || typeof rawEntity !== 'object') return null;
  const rawType = coerceId(rawEntity.type, -1);

  if (rawType === CADGF_ENTITY_TYPES.POINT) {
    const point = vec2ToPoint(rawEntity.point);
    if (!point) return null;
    return {
      kind: 'point',
      point,
    };
  }

  if (rawType === CADGF_ENTITY_TYPES.ELLIPSE) {
    const center = vec2ToPoint(rawEntity?.ellipse?.c);
    const rx = Number(rawEntity?.ellipse?.rx);
    const ry = Number(rawEntity?.ellipse?.ry);
    const rotation = Number(rawEntity?.ellipse?.rot);
    const startAngle = Number(rawEntity?.ellipse?.a0);
    const endAngle = Number(rawEntity?.ellipse?.a1);
    if (!center || !Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rotation)
      || !Number.isFinite(startAngle) || !Number.isFinite(endAngle)) {
      return null;
    }
    return {
      kind: 'ellipse',
      center,
      rx: Math.max(0.001, Math.abs(rx)),
      ry: Math.max(0.001, Math.abs(ry)),
      rotation,
      startAngle,
      endAngle,
    };
  }

  if (rawType === CADGF_ENTITY_TYPES.SPLINE) {
    const points = Array.isArray(rawEntity?.spline?.control)
      ? rawEntity.spline.control.map(vec2ToPoint).filter(Boolean)
      : [];
    if (points.length < 2) return null;
    return {
      kind: 'polyline',
      points,
    };
  }

  return null;
}

function makeUnsupportedEntity(rawEntity, { id, layerId, name, color, metadata = {}, style = {} }) {
  const displayProxy = makeUnsupportedDisplayProxy(rawEntity);
  return {
    id,
    type: 'unsupported',
    layerId,
    // Keep unsupported placeholders visible/selectable when we can synthesize a display proxy.
    visible: !!displayProxy,
    color,
    name,
    readOnly: true,
    display_proxy: displayProxy,
    cadgf: cloneJson(rawEntity),
    ...style,
    ...metadata,
  };
}

export function importCadgfDocument(cadgfJson) {
  if (!isCadgfDocument(cadgfJson)) {
    throw new Error('Not a CADGF Document JSON payload.');
  }

  const warnings = [];
  const baseCadgfJson = cloneJson(cadgfJson);

  const layers = [];
  const layerIndex = new Map();
  let maxLayerId = 0;

  for (const raw of cadgfJson.layers || []) {
    const id = coerceId(raw?.id, 0);
    maxLayerId = Math.max(maxLayerId, id);
    const layer = {
      id,
      name: typeof raw?.name === 'string' ? raw.name : `L${id}`,
      visible: normalizeBoolInt(raw?.visible, true),
      locked: normalizeBoolInt(raw?.locked, false),
      printable: normalizeBoolInt(raw?.printable, true),
      frozen: normalizeBoolInt(raw?.frozen, false),
      construction: normalizeBoolInt(raw?.construction, false),
      color: intToHexColor(raw?.color, '#9ca3af'),
      lineType: typeof raw?.line_type === 'string' && raw.line_type.trim()
        ? raw.line_type.trim().toUpperCase()
        : 'CONTINUOUS',
      lineWeight: Number.isFinite(raw?.line_weight) ? Math.max(0, Number(raw.line_weight)) : 0,
    };
    layers.push(layer);
    layerIndex.set(id, layer);
  }

  if (!layerIndex.has(0)) {
    const layer0 = {
      id: 0,
      name: '0',
      visible: true,
      locked: false,
      printable: true,
      frozen: false,
      construction: false,
      color: '#d0d7de',
      lineType: 'CONTINUOUS',
      lineWeight: 0,
    };
    layers.unshift(layer0);
    layerIndex.set(0, layer0);
    maxLayerId = Math.max(maxLayerId, 0);
  }

  const entities = [];
  let maxEntityId = 0;
  const maxExistingGroupId = (cadgfJson.entities || []).reduce((max, raw) => {
    const groupId = Number(raw?.group_id);
    return Number.isFinite(groupId) ? Math.max(max, Math.trunc(groupId)) : max;
  }, 0);
  let nextSyntheticGroupId = maxExistingGroupId + 1;

  for (const raw of cadgfJson.entities || []) {
    const id = coerceId(raw?.id, maxEntityId + 1);
    maxEntityId = Math.max(maxEntityId, id);

    const layerId = coerceId(raw?.layer_id, 0);
    const layer = layerIndex.get(layerId) || layerIndex.get(0) || null;
    const name = typeof raw?.name === 'string' ? raw.name : '';
    const metadata = extractEntityMetadata(raw);
    if (isSyntheticSingleTextSourceProxyMetadata(raw, metadata) && !Number.isFinite(metadata.groupId)) {
      metadata.groupId = nextSyntheticGroupId;
      nextSyntheticGroupId += 1;
    }
    const style = normalizeImportedEntityStyle(raw, {
      honorLineWeightSourceKeys: false,
      honorLineTypeScaleSourceKeys: false,
    });

    const colorSource = typeof raw?.color_source === 'string' ? raw.color_source : '';
    const byLayer = colorSource.toUpperCase() === 'BYLAYER';
    const fallbackColor = layer ? layer.color : '#1f2937';
    const color = byLayer
      ? fallbackColor
      : intToHexColor(raw?.color, fallbackColor);

    if (raw?.type === CADGF_ENTITY_TYPES.LINE) {
      const p0 = vec2ToPoint(raw?.line?.[0]);
      const p1 = vec2ToPoint(raw?.line?.[1]);
      if (!p0 || !p1) {
        warnings.push(`entity:${id} invalid line geometry`);
        entities.push(makeUnsupportedEntity(raw, { id, layerId, name, color, metadata, style }));
        continue;
      }
      entities.push({
        id,
        type: 'line',
        layerId,
        visible: resolveImportedEntityVisibilityPolicy({
          hasExplicitVisible: Object.prototype.hasOwnProperty.call(raw || {}, 'visible'),
          explicitVisible: raw?.visible,
          isInsertTextProxy: isInsertTextProxyMetadata(metadata),
          attributeInvisible: metadata?.attributeInvisible,
          fallback: true,
        }, {
          explicitVisibleMode: 'bool-int',
        }),
        color,
        name,
        start: p0,
        end: p1,
        ...style,
        ...metadata,
      });
      continue;
    }

    if (raw?.type === CADGF_ENTITY_TYPES.POLYLINE) {
      const rawPoints = Array.isArray(raw?.polyline) ? raw.polyline : [];
      const points = rawPoints.map(vec2ToPoint).filter(Boolean);
      if (points.length < 2) {
        warnings.push(`entity:${id} invalid polyline geometry`);
        entities.push(makeUnsupportedEntity(raw, { id, layerId, name, color, metadata, style }));
        continue;
      }
      const closed = points.length >= 3 && approxEqualPoint(points[0], points[points.length - 1]);
      const normalizedPoints = closed ? points.slice(0, -1) : points;
      entities.push({
        id,
        type: 'polyline',
        layerId,
        visible: resolveImportedEntityVisibilityPolicy({
          hasExplicitVisible: Object.prototype.hasOwnProperty.call(raw || {}, 'visible'),
          explicitVisible: raw?.visible,
          isInsertTextProxy: isInsertTextProxyMetadata(metadata),
          attributeInvisible: metadata?.attributeInvisible,
          fallback: true,
        }, {
          explicitVisibleMode: 'bool-int',
        }),
        color,
        name,
        closed,
        points: normalizedPoints,
        ...style,
        ...metadata,
      });
      continue;
    }

    if (raw?.type === CADGF_ENTITY_TYPES.CIRCLE) {
      const center = vec2ToPoint(raw?.circle?.c);
      const radius = Number(raw?.circle?.r);
      if (!center || !Number.isFinite(radius)) {
        warnings.push(`entity:${id} invalid circle geometry`);
        entities.push(makeUnsupportedEntity(raw, { id, layerId, name, color, metadata, style }));
        continue;
      }
      entities.push({
        id,
        type: 'circle',
        layerId,
        visible: resolveImportedEntityVisibilityPolicy({
          hasExplicitVisible: Object.prototype.hasOwnProperty.call(raw || {}, 'visible'),
          explicitVisible: raw?.visible,
          isInsertTextProxy: isInsertTextProxyMetadata(metadata),
          attributeInvisible: metadata?.attributeInvisible,
          fallback: true,
        }, {
          explicitVisibleMode: 'bool-int',
        }),
        color,
        name,
        center,
        radius: Math.max(0.001, radius),
        ...style,
        ...metadata,
      });
      continue;
    }

    if (raw?.type === CADGF_ENTITY_TYPES.ARC) {
      const center = vec2ToPoint(raw?.arc?.c);
      const radius = Number(raw?.arc?.r);
      const a0 = Number(raw?.arc?.a0);
      const a1 = Number(raw?.arc?.a1);
      const cw = normalizeBoolInt(raw?.arc?.cw, false);
      if (!center || !Number.isFinite(radius) || !Number.isFinite(a0) || !Number.isFinite(a1)) {
        warnings.push(`entity:${id} invalid arc geometry`);
        entities.push(makeUnsupportedEntity(raw, { id, layerId, name, color, metadata, style }));
        continue;
      }
      entities.push({
        id,
        type: 'arc',
        layerId,
        visible: resolveImportedEntityVisibilityPolicy({
          hasExplicitVisible: Object.prototype.hasOwnProperty.call(raw || {}, 'visible'),
          explicitVisible: raw?.visible,
          isInsertTextProxy: isInsertTextProxyMetadata(metadata),
          attributeInvisible: metadata?.attributeInvisible,
          fallback: true,
        }, {
          explicitVisibleMode: 'bool-int',
        }),
        color,
        name,
        center,
        radius: Math.max(0.001, radius),
        startAngle: a0,
        endAngle: a1,
        cw,
        ...style,
        ...metadata,
      });
      continue;
    }

    if (raw?.type === CADGF_ENTITY_TYPES.TEXT) {
      const pos = vec2ToPoint(raw?.text?.pos);
      const height = Number(raw?.text?.h);
      const rotation = Number(raw?.text?.rot);
      const value = resolveImportedTextValuePolicy({
        legacyAttributeDefault: deriveLegacyAttdefDefault(raw, metadata),
        explicitValue: null,
        textValue: typeof raw?.text?.value === 'string' ? raw.text.value : null,
      }, {
        fallback: '',
        valueOrder: ['text'],
      });
      if (!pos || !Number.isFinite(height) || !Number.isFinite(rotation)) {
        warnings.push(`entity:${id} invalid text geometry`);
        entities.push(makeUnsupportedEntity(raw, { id, layerId, name, color, metadata, style }));
        continue;
      }
      entities.push({
        id,
        type: 'text',
        layerId,
        visible: resolveImportedEntityVisibilityPolicy({
          hasExplicitVisible: Object.prototype.hasOwnProperty.call(raw || {}, 'visible'),
          explicitVisible: raw?.visible,
          isInsertTextProxy: isInsertTextProxyMetadata(metadata),
          attributeInvisible: metadata?.attributeInvisible,
          fallback: true,
        }, {
          explicitVisibleMode: 'bool-int',
        }),
        color,
        name,
        position: pos,
        value: value === '' ? '' : (value || 'TEXT'),
        height: Math.max(0.1, height),
        rotation,
        ...style,
        ...metadata,
      });
      continue;
    }

    warnings.push(`entity:${id} unsupported cadgf type=${raw?.type}`);
    entities.push(makeUnsupportedEntity(raw, { id, layerId, name, color, metadata, style }));
  }

  deriveMissingDimensionSourceBundleIds(entities);

  const meta = {
    label: typeof cadgfJson.metadata?.label === 'string' ? cadgfJson.metadata.label : '',
    author: typeof cadgfJson.metadata?.author === 'string' ? cadgfJson.metadata.author : '',
    comment: typeof cadgfJson.metadata?.comment === 'string' ? cadgfJson.metadata.comment : '',
    unit: typeof cadgfJson.metadata?.unit_name === 'string' ? cadgfJson.metadata.unit_name : 'mm',
    unitDeclared: typeof cadgfJson.metadata?.unit_name === 'string' && !!cadgfJson.metadata.unit_name.trim(),
    unitScale: Number.isFinite(cadgfJson.settings?.unit_scale) ? cadgfJson.settings.unit_scale : null,
    schema: 'vemcad-web-2d-v1',
  };

  return {
    warnings,
    baseCadgfJson,
    docSnapshot: {
      nextEntityId: maxEntityId + 1,
      nextLayerId: maxLayerId + 1,
      layers,
      entities,
      meta,
    },
  };
}

function ensureCadgfLayer(layer) {
  if (!layer || typeof layer !== 'object') {
    return {
      id: 0,
      name: '0',
      color: 0xffffff,
      visible: 1,
      locked: 0,
      printable: 1,
      frozen: 0,
      construction: 0,
      line_type: 'CONTINUOUS',
    };
  }
  const cloned = cloneJson(layer);
  const out = {
    ...cloned,
    id: coerceId(cloned.id, 0),
    name: typeof cloned.name === 'string' ? cloned.name : '0',
    color: clampInt(cloned.color, 0, 0xffffff),
    visible: normalizeBoolInt(cloned.visible, true) ? 1 : 0,
    locked: normalizeBoolInt(cloned.locked, false) ? 1 : 0,
    printable: normalizeBoolInt(cloned.printable, true) ? 1 : 0,
    frozen: normalizeBoolInt(cloned.frozen, false) ? 1 : 0,
    construction: normalizeBoolInt(cloned.construction, false) ? 1 : 0,
  };
  out.line_type = typeof cloned.line_type === 'string' && cloned.line_type.trim()
    ? cloned.line_type.trim().toUpperCase()
    : 'CONTINUOUS';
  if (Number.isFinite(cloned.line_weight) && Number(cloned.line_weight) > 0) {
    out.line_weight = Number(cloned.line_weight);
  } else {
    delete out.line_weight;
  }
  return out;
}

function ensureCadgfEntityBase(entity, id) {
  const cloned = cloneJson(entity || {});
  const layerId = coerceId(cloned.layer_id, 0);
  const out = {
    ...cloned,
    id,
    type: coerceId(cloned.type, CADGF_ENTITY_TYPES.LINE),
    layer_id: layerId,
    name: typeof cloned.name === 'string' ? cloned.name : '',
    line_type: typeof cloned.line_type === 'string' ? cloned.line_type : 'CONTINUOUS',
    color: Number.isFinite(cloned.color) ? clampInt(cloned.color, 0, 0xffffff) : 0,
    color_source: typeof cloned.color_source === 'string' ? cloned.color_source : 'BYLAYER',
    space: Object.prototype.hasOwnProperty.call(cloned, 'space') ? cloned.space : 0,
  };

  if (Object.prototype.hasOwnProperty.call(cloned, 'line_type_scale')) {
    if (Number.isFinite(cloned.line_type_scale)) {
      out.line_type_scale = Number(cloned.line_type_scale);
    } else {
      delete out.line_type_scale;
    }
  }

  if (Object.prototype.hasOwnProperty.call(cloned, 'color_aci')) {
    if (Number.isFinite(cloned.color_aci)) {
      out.color_aci = clampInt(cloned.color_aci, 0, 255);
    } else {
      delete out.color_aci;
    }
  }

  // Keep optional numeric fields only when valid; avoid emitting `null` which breaks schema validation.
  if (Object.prototype.hasOwnProperty.call(cloned, 'line_weight')) {
    if (Number.isFinite(cloned.line_weight)) {
      out.line_weight = Number(cloned.line_weight);
    } else {
      delete out.line_weight;
    }
  }

  return out;
}

function finalizeCadgfEntity(baseEntity, patch, entity, layer, id) {
  const target = {
    ...baseEntity,
    ...(patch || {}),
  };
  applyEntityMetadataPatch(target, entity);
  applyEntityStylePatch(target, entity);
  applyEntityColorPatch(target, entity, layer);
  return ensureCadgfEntityBase(target, id);
}

export function exportCadgfDocument(documentState, { baseCadgfJson = null } = {}) {
  const now = new Date().toISOString();
  const base = isCadgfDocument(baseCadgfJson)
    ? cloneJson(baseCadgfJson)
    : {
      document_id: `web-${Date.now()}`,
      cadgf_version: '1.0',
      schema_version: 1,
      feature_flags: { earcut: true, clipper2: true },
      metadata: {
        label: documentState?.meta?.label || '',
        author: documentState?.meta?.author || '',
        company: '',
        comment: documentState?.meta?.comment || '',
        created_at: now,
        modified_at: now,
        unit_name: documentState?.meta?.unit || 'mm',
        meta: {},
      },
      settings: { unit_scale: 1 },
      layers: [],
      entities: [],
    };

  if (base.metadata && typeof base.metadata === 'object') {
    base.metadata.modified_at = now;
    if (!base.metadata.created_at) base.metadata.created_at = now;
    base.metadata.label = documentState?.meta?.label || base.metadata.label || '';
    base.metadata.author = documentState?.meta?.author || base.metadata.author || '';
    base.metadata.comment = documentState?.meta?.comment || base.metadata.comment || '';
    base.metadata.unit_name = documentState?.meta?.unit || base.metadata.unit_name || 'mm';
  }

  const layers = Array.isArray(base.layers) ? base.layers : [];
  const layerById = new Map(layers.map((layer) => [coerceId(layer?.id, 0), layer]));

  const exportedLayers = [];
  for (const layer of documentState.listLayers()) {
    const existing = layerById.get(layer.id);
    const colorInt = hexToIntColor(layer.color, existing?.color ?? 0x9ca3af);
    const patch = {
      id: layer.id,
      name: layer.name,
      color: colorInt,
      visible: layer.visible ? 1 : 0,
      locked: layer.locked ? 1 : 0,
      printable: layer.printable !== false ? 1 : 0,
      frozen: layer.frozen === true ? 1 : 0,
      construction: layer.construction === true ? 1 : 0,
      line_type: typeof layer.lineType === 'string' && layer.lineType.trim()
        ? layer.lineType.trim().toUpperCase()
        : 'CONTINUOUS',
    };
    if (Number.isFinite(layer.lineWeight) && Number(layer.lineWeight) > 0) {
      patch.line_weight = Number(layer.lineWeight);
    }
    exportedLayers.push(ensureCadgfLayer({ ...(existing || {}), ...patch }));
    layerById.delete(layer.id);
  }
  for (const layer of layerById.values()) {
    exportedLayers.push(ensureCadgfLayer(layer));
  }
  exportedLayers.sort((a, b) => a.id - b.id);
  base.layers = exportedLayers;

  const baseEntities = Array.isArray(base.entities) ? base.entities : [];
  const baseEntityById = new Map(baseEntities.map((entity) => [coerceId(entity?.id, -1), entity]));

  const outEntities = [];
  for (const entity of documentState.listEntities().slice().sort((a, b) => a.id - b.id)) {
    const id = coerceId(entity?.id, 0);
    const prior = baseEntityById.get(id) || null;
    const entityLayer = documentState.getLayer(entity.layerId);

    if (entity.type === 'unsupported' && entity.cadgf) {
      outEntities.push(finalizeCadgfEntity(ensureCadgfEntityBase(entity.cadgf, id), {}, entity, entityLayer, id));
      continue;
    }

    if (entity.type === 'line') {
      const baseEntity = ensureCadgfEntityBase(prior, id);
      outEntities.push(finalizeCadgfEntity(baseEntity, {
        type: CADGF_ENTITY_TYPES.LINE,
        layer_id: coerceId(entity.layerId, baseEntity.layer_id),
        name: typeof entity.name === 'string' ? entity.name : baseEntity.name,
        line: [pointToVec2(entity.start), pointToVec2(entity.end)],
      }, entity, entityLayer, id));
      continue;
    }

    if (entity.type === 'polyline') {
      const baseEntity = ensureCadgfEntityBase(prior, id);
      const points = Array.isArray(entity.points) ? entity.points : [];
      const polyline = points.map(pointToVec2);
      if (entity.closed && points.length >= 2) {
        polyline.push(pointToVec2(points[0]));
      }
      outEntities.push(finalizeCadgfEntity(baseEntity, {
        type: CADGF_ENTITY_TYPES.POLYLINE,
        layer_id: coerceId(entity.layerId, baseEntity.layer_id),
        name: typeof entity.name === 'string' ? entity.name : baseEntity.name,
        polyline,
      }, entity, entityLayer, id));
      continue;
    }

    if (entity.type === 'circle') {
      const baseEntity = ensureCadgfEntityBase(prior, id);
      outEntities.push(finalizeCadgfEntity(baseEntity, {
        type: CADGF_ENTITY_TYPES.CIRCLE,
        layer_id: coerceId(entity.layerId, baseEntity.layer_id),
        name: typeof entity.name === 'string' ? entity.name : baseEntity.name,
        circle: { c: pointToVec2(entity.center), r: Number(entity.radius || 0) },
      }, entity, entityLayer, id));
      continue;
    }

    if (entity.type === 'arc') {
      const baseEntity = ensureCadgfEntityBase(prior, id);
      outEntities.push(finalizeCadgfEntity(baseEntity, {
        type: CADGF_ENTITY_TYPES.ARC,
        layer_id: coerceId(entity.layerId, baseEntity.layer_id),
        name: typeof entity.name === 'string' ? entity.name : baseEntity.name,
        arc: {
          c: pointToVec2(entity.center),
          r: Number(entity.radius || 0),
          a0: Number(entity.startAngle || 0),
          a1: Number(entity.endAngle || 0),
          cw: entity.cw ? 1 : 0,
        },
      }, entity, entityLayer, id));
      continue;
    }

    if (entity.type === 'text') {
      const baseEntity = ensureCadgfEntityBase(prior, id);
      outEntities.push(finalizeCadgfEntity(baseEntity, {
        type: CADGF_ENTITY_TYPES.TEXT,
        layer_id: coerceId(entity.layerId, baseEntity.layer_id),
        name: typeof entity.name === 'string' ? entity.name : baseEntity.name,
        text: {
          pos: pointToVec2(entity.position),
          h: Number(entity.height || 0),
          rot: Number(entity.rotation || 0),
          value: typeof entity.value === 'string' ? entity.value : '',
        },
      }, entity, entityLayer, id));
      continue;
    }

    // Unknown internal types: try passthrough if base exists.
    if (prior) {
      outEntities.push(ensureCadgfEntityBase(prior, id));
    }
  }

  // Ensure stable ordering.
  outEntities.sort((a, b) => a.id - b.id);
  base.entities = outEntities;

  return base;
}
