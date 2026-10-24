const PREVIEW_LINE_WEIGHT_DEFAULT = 0.18;
const PREVIEW_LINE_WEIGHT_MIN = 0.05;
const PREVIEW_LINE_WEIGHT_MAX = 2.0;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePositiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback;
}

function normalizeColor(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : '';
}

function normalizeLineType(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().toUpperCase();
  return trimmed || fallback;
}

function normalizeLineTypeScaleSource(value) {
  const normalized = normalizeLineType(value);
  return normalized === 'EXPLICIT' || normalized === 'DEFAULT' ? normalized : '';
}

function normalizeLineWeightSource(value) {
  const normalized = normalizeLineType(value);
  return normalized === 'EXPLICIT' || normalized === 'BYLAYER' ? normalized : '';
}

export function resolveEntityStyleSources(entity) {
  const colorSource = normalizeLineType(entity?.colorSource, 'TRUECOLOR') || 'TRUECOLOR';
  const rawLineType = normalizeLineType(entity?.lineType, 'CONTINUOUS');
  const lineTypeSource = rawLineType === 'BYLAYER'
    ? 'BYLAYER'
    : (rawLineType === 'BYBLOCK' ? 'BYBLOCK' : 'EXPLICIT');
  const lineWeight = Number.isFinite(entity?.lineWeight) ? Number(entity.lineWeight) : 0;
  const lineWeightSource = normalizeLineWeightSource(entity?.lineWeightSource)
    || (lineWeight > 0 ? 'EXPLICIT' : 'BYLAYER');
  const lineTypeScaleSource = normalizeLineTypeScaleSource(entity?.lineTypeScaleSource)
    || ((Number.isFinite(entity?.lineTypeScale) && Number(entity.lineTypeScale) !== 1) ? 'EXPLICIT' : 'DEFAULT');
  return {
    colorSource,
    lineTypeSource,
    lineWeightSource,
    lineTypeScaleSource,
  };
}

export function resolveEffectiveEntityColor(entity, layer = null) {
  const source = normalizeLineType(entity?.colorSource);
  const layerColor = normalizeColor(layer?.color);
  const entityColor = normalizeColor(entity?.color);
  if (source === 'BYLAYER' && layerColor) {
    return layerColor;
  }
  return entityColor || layerColor || '#1f2937';
}

export function resolveEffectiveEntityStyle(entity, layer = null) {
  const rawLineType = normalizeLineType(entity?.lineType, 'CONTINUOUS');
  const layerLineType = normalizeLineType(layer?.lineType, 'CONTINUOUS');
  const lineType = rawLineType === 'BYLAYER' ? layerLineType : rawLineType;
  const styleSources = resolveEntityStyleSources(entity);
  const lineWeight = styleSources.lineWeightSource === 'EXPLICIT'
    ? (Number.isFinite(entity?.lineWeight) ? Math.max(0, Number(entity.lineWeight)) : 0)
    : (Number.isFinite(layer?.lineWeight) && Number(layer.lineWeight) > 0 ? Number(layer.lineWeight) : 0);
  const lineTypeScale = Number.isFinite(entity?.lineTypeScale) && Number(entity.lineTypeScale) > 0
    ? Number(entity.lineTypeScale)
    : 1;
  return {
    color: resolveEffectiveEntityColor(entity, layer),
    lineType: lineType || 'CONTINUOUS',
    lineWeight,
    lineTypeScale,
  };
}

export function resolveLinePattern(lineType, scale = 1) {
  if (!lineType) return null;
  const key = String(lineType).trim().toLowerCase();
  if (!key || key.includes('continuous') || key.includes('bylayer') || key.includes('byblock')) {
    return null;
  }
  const normalizedScale = normalizePositiveNumber(scale, 1);
  const scaled = (value) => Math.max(0.001, value * normalizedScale);
  if (key.includes('center')) {
    return { dash: scaled(18), gap: scaled(6) };
  }
  if (key.includes('hidden')) {
    return { dash: scaled(6), gap: scaled(4) };
  }
  if (key.includes('phantom')) {
    return { dash: scaled(12), gap: scaled(4) };
  }
  if (key.includes('dot')) {
    return { dash: scaled(2), gap: scaled(4) };
  }
  if (key.includes('dash')) {
    return { dash: scaled(10), gap: scaled(6) };
  }
  return { dash: scaled(8), gap: scaled(4) };
}

export function resolveScaledLineWidth(lineWeight, {
  defaultWeight = PREVIEW_LINE_WEIGHT_DEFAULT,
  scale = 3,
  min = PREVIEW_LINE_WEIGHT_MIN,
  max = PREVIEW_LINE_WEIGHT_MAX,
} = {}) {
  const normalizedDefault = normalizePositiveNumber(defaultWeight, PREVIEW_LINE_WEIGHT_DEFAULT);
  const weight = Number.isFinite(lineWeight) && Number(lineWeight) > 0
    ? Number(lineWeight)
    : normalizedDefault;
  const scaled = weight * normalizePositiveNumber(scale, 1);
  return clamp(scaled, min, max);
}

export function resolveCanvasLineDash(lineType, lineTypeScale = 1, zoom = 1) {
  const pattern = resolveLinePattern(lineType, lineTypeScale);
  if (!pattern) return [];
  const screenScale = normalizePositiveNumber(zoom, 1);
  return [
    clamp(pattern.dash * screenScale, 2, 144),
    clamp(pattern.gap * screenScale, 2, 96),
  ];
}

export function resolveCanvasStrokeStyle(entity, zoom, { selected = false, layer = null } = {}) {
  const effective = resolveEffectiveEntityStyle(entity, layer);
  const baseWidth = resolveScaledLineWidth(effective.lineWeight, {
    defaultWeight: PREVIEW_LINE_WEIGHT_DEFAULT,
    scale: 4,
    min: 1.2,
    max: 4.8,
  });
  return {
    lineWidth: selected ? Math.max(2.4, baseWidth + 0.9) : baseWidth,
    lineDash: selected ? [] : resolveCanvasLineDash(effective.lineType, effective.lineTypeScale, zoom),
  };
}
