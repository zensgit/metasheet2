import {
  deriveLegacyAttdefDefault,
  normalizeColorAci,
  normalizeColorSource,
  normalizeOptionalBool,
} from './import_normalization.js';

function firstMatchingValue(raw, keys, predicate) {
  if (!raw || typeof raw !== 'object') return null;
  for (const key of keys) {
    const value = raw[key];
    if (predicate(value)) return value;
  }
  return null;
}

function hasOwnAny(raw, keys) {
  if (!raw || typeof raw !== 'object') return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(raw, key));
}

function normalizeSourceValue(rawValue, explicitValue, fallbackValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return fallbackValue;
  }
  return rawValue.trim().toUpperCase() === explicitValue ? explicitValue : fallbackValue;
}

function firstTrimmedString(raw, keys) {
  return firstMatchingValue(raw, keys, (value) => typeof value === 'string' && value.trim());
}

function firstFiniteNumber(raw, keys) {
  return firstMatchingValue(raw, keys, Number.isFinite);
}

function normalizeFinitePoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: Number(point.x), y: Number(point.y) };
}

function normalizeFiniteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function firstNamedPoint(candidates, names) {
  for (const name of names) {
    const point = normalizeFinitePoint(candidates?.[name]);
    if (point) return point;
  }
  return null;
}

function firstNamedNumber(candidates, names) {
  for (const name of names) {
    const value = normalizeFiniteNumber(candidates?.[name]);
    if (value !== null) return value;
  }
  return null;
}

export function applyAttributeFlagFallbacks(meta) {
  if (!meta || !Number.isFinite(meta.attributeFlags)) return meta;
  if (typeof meta.attributeInvisible !== 'boolean') meta.attributeInvisible = (meta.attributeFlags & 1) !== 0;
  if (typeof meta.attributeConstant !== 'boolean') meta.attributeConstant = (meta.attributeFlags & 2) !== 0;
  if (typeof meta.attributeVerify !== 'boolean') meta.attributeVerify = (meta.attributeFlags & 4) !== 0;
  if (typeof meta.attributePreset !== 'boolean') meta.attributePreset = (meta.attributeFlags & 8) !== 0;
  if (typeof meta.attributeLockPosition !== 'boolean') meta.attributeLockPosition = (meta.attributeFlags & 16) !== 0;
  return meta;
}

export function normalizeImportedEntityStyle(raw, {
  lineTypeKeys = ['lineType', 'line_type'],
  lineWeightKeys = ['lineWeight', 'line_weight'],
  lineWeightSourceKeys = ['lineWeightSource', 'line_weight_source'],
  honorLineWeightSourceKeys = true,
  lineTypeScaleKeys = ['lineTypeScale', 'line_type_scale'],
  lineTypeScaleSourceKeys = ['lineTypeScaleSource', 'line_type_scale_source'],
  honorLineTypeScaleSourceKeys = true,
} = {}) {
  const lineTypeValue = firstTrimmedString(raw, lineTypeKeys);
  const lineWeightValue = firstFiniteNumber(raw, lineWeightKeys);
  const lineWeightSourceValue = honorLineWeightSourceKeys
    ? firstTrimmedString(raw, lineWeightSourceKeys)
    : null;
  const lineTypeScaleValue = firstFiniteNumber(raw, lineTypeScaleKeys);
  const lineTypeScaleSourceValue = honorLineTypeScaleSourceKeys
    ? firstTrimmedString(raw, lineTypeScaleSourceKeys)
    : null;

  return {
    lineType: typeof lineTypeValue === 'string' ? lineTypeValue.trim().toUpperCase() : 'CONTINUOUS',
    lineWeight: Number.isFinite(lineWeightValue) ? Math.max(0, Number(lineWeightValue)) : 0,
    lineWeightSource: lineWeightSourceValue
      ? normalizeSourceValue(lineWeightSourceValue, 'EXPLICIT', 'BYLAYER')
      : (hasOwnAny(raw, lineWeightKeys) ? 'EXPLICIT' : 'BYLAYER'),
    lineTypeScale: Number.isFinite(lineTypeScaleValue) ? Math.max(0, Number(lineTypeScaleValue)) : 1,
    lineTypeScaleSource: lineTypeScaleSourceValue
      ? normalizeSourceValue(lineTypeScaleSourceValue, 'EXPLICIT', 'DEFAULT')
      : (hasOwnAny(raw, lineTypeScaleKeys) ? 'EXPLICIT' : 'DEFAULT'),
  };
}

export function normalizeImportedAttributeMetadata(raw, {
  textKindKeys = ['textKind', 'text_kind'],
  attributeTagKeys = ['attributeTag', 'attribute_tag'],
  attributeDefaultKeys = ['attributeDefault', 'attribute_default'],
  attributePromptKeys = ['attributePrompt', 'attribute_prompt'],
  attributeFlagsKeys = ['attributeFlags', 'attribute_flags'],
  attributeInvisibleKeys = ['attributeInvisible', 'attribute_invisible'],
  attributeConstantKeys = ['attributeConstant', 'attribute_constant'],
  attributeVerifyKeys = ['attributeVerify', 'attribute_verify'],
  attributePresetKeys = ['attributePreset', 'attribute_preset'],
  attributeLockPositionKeys = ['attributeLockPosition', 'attribute_lock_position'],
} = {}) {
  const meta = {};

  const textKind = firstTrimmedString(raw, textKindKeys);
  if (typeof textKind === 'string') meta.textKind = textKind;

  const attributeTag = firstTrimmedString(raw, attributeTagKeys);
  if (typeof attributeTag === 'string') meta.attributeTag = attributeTag;

  const attributeDefault = firstMatchingValue(raw, attributeDefaultKeys, (value) => typeof value === 'string');
  if (typeof attributeDefault === 'string') meta.attributeDefault = attributeDefault;

  const attributePrompt = firstMatchingValue(raw, attributePromptKeys, (value) => typeof value === 'string');
  if (typeof attributePrompt === 'string') meta.attributePrompt = attributePrompt;

  const legacyAttdefDefault = deriveLegacyAttdefDefault(raw, meta);
  if (typeof meta.attributeDefault !== 'string' && typeof legacyAttdefDefault === 'string') {
    meta.attributeDefault = legacyAttdefDefault;
  }

  const attributeFlags = firstFiniteNumber(raw, attributeFlagsKeys);
  if (Number.isFinite(attributeFlags)) meta.attributeFlags = Math.trunc(attributeFlags);

  const attributeInvisible = normalizeOptionalBool(firstMatchingValue(raw, attributeInvisibleKeys, () => true));
  const attributeConstant = normalizeOptionalBool(firstMatchingValue(raw, attributeConstantKeys, () => true));
  const attributeVerify = normalizeOptionalBool(firstMatchingValue(raw, attributeVerifyKeys, () => true));
  const attributePreset = normalizeOptionalBool(firstMatchingValue(raw, attributePresetKeys, () => true));
  const attributeLockPosition = normalizeOptionalBool(firstMatchingValue(raw, attributeLockPositionKeys, () => true));

  if (attributeInvisible !== null) meta.attributeInvisible = attributeInvisible;
  if (attributeConstant !== null) meta.attributeConstant = attributeConstant;
  if (attributeVerify !== null) meta.attributeVerify = attributeVerify;
  if (attributePreset !== null) meta.attributePreset = attributePreset;
  if (attributeLockPosition !== null) meta.attributeLockPosition = attributeLockPosition;

  return applyAttributeFlagFallbacks(meta);
}

export function normalizeImportedEntityMetadataBase(raw, {
  groupIdKeys = ['groupId'],
  spaceKeys = ['space'],
  requireOwnSpaceKeys = false,
  layoutKeys = ['layout'],
  colorSourceKeys = ['colorSource', 'color_source'],
  colorAciKeys = ['colorAci', 'color_aci'],
  sourceTypeKeys = ['sourceType', 'source_type'],
  editModeKeys = ['editMode', 'edit_mode'],
  proxyKindKeys = ['proxyKind', 'proxy_kind'],
  blockNameKeys = ['blockName', 'block_name'],
  hatchPatternKeys = ['hatchPattern', 'hatch_pattern'],
  hatchIdKeys = ['hatchId', 'hatch_id'],
  sourceBundleIdKeys = ['sourceBundleId', 'source_bundle_id'],
} = {}) {
  const meta = {};

  const groupId = firstFiniteNumber(raw, groupIdKeys);
  if (Number.isFinite(groupId)) meta.groupId = Math.trunc(groupId);

  if (!requireOwnSpaceKeys || hasOwnAny(raw, spaceKeys)) {
    const space = firstFiniteNumber(raw, spaceKeys);
    if (Number.isFinite(space)) meta.space = Math.trunc(space);
  }

  const layout = firstTrimmedString(raw, layoutKeys);
  if (typeof layout === 'string') meta.layout = layout;

  const colorSource = normalizeColorSource(firstMatchingValue(raw, colorSourceKeys, () => true));
  if (colorSource) meta.colorSource = colorSource;

  const colorAci = normalizeColorAci(firstFiniteNumber(raw, colorAciKeys));
  if (colorAci !== null) meta.colorAci = colorAci;

  const sourceType = firstTrimmedString(raw, sourceTypeKeys);
  if (typeof sourceType === 'string') meta.sourceType = sourceType;

  const editMode = firstTrimmedString(raw, editModeKeys);
  if (typeof editMode === 'string') meta.editMode = editMode;

  const proxyKind = firstTrimmedString(raw, proxyKindKeys);
  if (typeof proxyKind === 'string') meta.proxyKind = proxyKind;

  const blockName = firstTrimmedString(raw, blockNameKeys);
  if (typeof blockName === 'string') meta.blockName = blockName;

  const hatchPattern = firstTrimmedString(raw, hatchPatternKeys);
  if (typeof hatchPattern === 'string') meta.hatchPattern = hatchPattern;

  const hatchId = firstFiniteNumber(raw, hatchIdKeys);
  if (Number.isFinite(hatchId)) meta.hatchId = Math.trunc(hatchId);

  const sourceBundleId = firstFiniteNumber(raw, sourceBundleIdKeys);
  if (Number.isFinite(sourceBundleId)) meta.sourceBundleId = Math.trunc(sourceBundleId);

  return meta;
}

export function normalizeImportedAnnotationMetadata(candidates, {
  proxyTextFallbackEnabled = false,
  sourceTextFallbackOrder = ['explicit'],
  sourceTextRotationFallbackOrder = sourceTextFallbackOrder,
} = {}) {
  const meta = {};

  const explicitSourceTextPos = normalizeFinitePoint(candidates?.explicitSourceTextPos);
  if (explicitSourceTextPos) meta.sourceTextPos = explicitSourceTextPos;

  const explicitSourceTextRotation = normalizeFiniteNumber(candidates?.explicitSourceTextRotation);
  if (explicitSourceTextRotation !== null) meta.sourceTextRotation = explicitSourceTextRotation;

  const dimTextPos = normalizeFinitePoint(candidates?.dimTextPos);
  if (dimTextPos) meta.dimTextPos = dimTextPos;

  const dimTextRotation = normalizeFiniteNumber(candidates?.dimTextRotation);
  if (dimTextRotation !== null) meta.dimTextRotation = dimTextRotation;

  const sourceAnchor = normalizeFinitePoint(candidates?.sourceAnchor);
  if (sourceAnchor) meta.sourceAnchor = sourceAnchor;

  const leaderLanding = normalizeFinitePoint(candidates?.leaderLanding);
  if (leaderLanding) meta.leaderLanding = leaderLanding;

  const leaderElbow = normalizeFinitePoint(candidates?.leaderElbow);
  if (leaderElbow) meta.leaderElbow = leaderElbow;

  const sourceAnchorDriverId = normalizeFiniteNumber(candidates?.sourceAnchorDriverId);
  if (sourceAnchorDriverId !== null) meta.sourceAnchorDriverId = Math.trunc(sourceAnchorDriverId);

  const sourceAnchorDriverType = typeof candidates?.sourceAnchorDriverType === 'string'
    ? candidates.sourceAnchorDriverType.trim()
    : '';
  if (sourceAnchorDriverType) meta.sourceAnchorDriverType = sourceAnchorDriverType;

  const sourceAnchorDriverKind = typeof candidates?.sourceAnchorDriverKind === 'string'
    ? candidates.sourceAnchorDriverKind.trim()
    : '';
  if (sourceAnchorDriverKind) meta.sourceAnchorDriverKind = sourceAnchorDriverKind;

  if (!proxyTextFallbackEnabled) {
    return meta;
  }

  if (!meta.sourceTextPos) {
    const fallbackSourceTextPos = firstNamedPoint(candidates, sourceTextFallbackOrder.map((name) => {
      if (name === 'explicit') return 'explicitSourceTextPos';
      if (name === 'text') return 'textPos';
      if (name === 'dimension') return 'dimTextPos';
      return name;
    }));
    if (fallbackSourceTextPos) meta.sourceTextPos = fallbackSourceTextPos;
  }

  if (!Number.isFinite(meta.sourceTextRotation)) {
    const fallbackSourceTextRotation = firstNamedNumber(candidates, sourceTextRotationFallbackOrder.map((name) => {
      if (name === 'explicit') return 'explicitSourceTextRotation';
      if (name === 'text') return 'textRotation';
      if (name === 'dimension') return 'dimTextRotation';
      return name;
    }));
    if (fallbackSourceTextRotation !== null) meta.sourceTextRotation = fallbackSourceTextRotation;
  }

  return meta;
}

export function resolveImportedTextValuePolicy({
  legacyAttributeDefault = null,
  explicitValue = null,
  textValue = null,
} = {}, {
  fallback = 'TEXT',
  valueOrder = ['explicit', 'text'],
} = {}) {
  if (typeof legacyAttributeDefault === 'string') return legacyAttributeDefault;
  for (const candidate of valueOrder) {
    if (candidate === 'explicit' && typeof explicitValue === 'string') return explicitValue;
    if (candidate === 'text' && typeof textValue === 'string') return textValue;
  }
  return fallback;
}

export function resolveImportedEntityVisibilityPolicy({
  hasExplicitVisible = false,
  explicitVisible = undefined,
  isInsertTextProxy = false,
  attributeInvisible = null,
  fallback = true,
} = {}, {
  explicitVisibleMode = 'strict-boolean',
} = {}) {
  if (hasExplicitVisible) {
    if (explicitVisibleMode === 'bool-int') {
      if (typeof explicitVisible === 'boolean') return explicitVisible;
      if (explicitVisible === 1) return true;
      if (explicitVisible === 0) return false;
      return fallback;
    }
    return explicitVisible !== false;
  }
  if (isInsertTextProxy && attributeInvisible === true) {
    return false;
  }
  return fallback;
}
