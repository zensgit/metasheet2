function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

export function normalizeSpaceValue(value, fallback = null) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const space = Math.trunc(numeric);
    if (space === 0 || space === 1) return space;
  }
  return fallback;
}

export function normalizeLayoutName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function formatSpaceLabel(value) {
  if (!Number.isFinite(value)) return '';
  if (Number(value) === 0) return 'Model';
  if (Number(value) === 1) return 'Paper';
  return String(Math.trunc(value));
}

export function canonicalLayoutForSpace(space, layout = '') {
  const normalizedSpace = normalizeSpaceValue(space, 0);
  if (normalizedSpace === 0) return 'Model';
  return normalizeLayoutName(layout);
}

export function resolveEntitySpace(entity) {
  return normalizeSpaceValue(entity?.space, 0) ?? 0;
}

export function resolveEntityLayout(entity) {
  return canonicalLayoutForSpace(resolveEntitySpace(entity), entity?.layout);
}

export function normalizeSpaceLayoutContext(raw = null, fallback = { space: 0, layout: 'Model' }) {
  const fallbackSpace = normalizeSpaceValue(fallback?.space, 0) ?? 0;
  const fallbackLayout = canonicalLayoutForSpace(fallbackSpace, fallback?.layout);
  const hasRawSpace = hasOwn(raw, 'space');
  const space = normalizeSpaceValue(hasRawSpace ? raw?.space : fallbackSpace, fallbackSpace) ?? fallbackSpace;
  const rawLayout = hasOwn(raw, 'layout')
    ? raw?.layout
    : fallbackLayout;
  const layout = canonicalLayoutForSpace(space, rawLayout);
  return { space, layout };
}

export function matchesSpaceLayout(entity, context = null) {
  const current = normalizeSpaceLayoutContext(context);
  const entitySpace = resolveEntitySpace(entity);
  if (entitySpace !== current.space) return false;
  if (current.space !== 1) return true;
  const currentLayout = normalizeLayoutName(current.layout);
  if (!currentLayout) return true;
  return normalizeLayoutName(entity?.layout) === currentLayout;
}

export function listPaperLayoutsFromEntities(entities) {
  const layouts = new Set();
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!entity || resolveEntitySpace(entity) !== 1) continue;
    const layout = normalizeLayoutName(entity.layout);
    if (layout) layouts.add(layout);
  }
  return [...layouts.values()].sort((a, b) => a.localeCompare(b));
}

export function resolveCurrentSpaceLayoutContext(entities, preferred = null) {
  const list = Array.isArray(entities) ? entities.filter(Boolean) : [];
  const paperLayouts = listPaperLayoutsFromEntities(list);
  const hasPaper = list.some((entity) => resolveEntitySpace(entity) === 1);
  const hasModel = list.length === 0 || list.some((entity) => resolveEntitySpace(entity) !== 1);
  const preferredContext = normalizeSpaceLayoutContext(preferred);

  if (preferredContext.space === 0 && hasModel) {
    return { space: 0, layout: 'Model' };
  }
  if (preferredContext.space === 1) {
    const preferredLayout = normalizeLayoutName(preferredContext.layout);
    if (preferredLayout && paperLayouts.includes(preferredLayout)) {
      return { space: 1, layout: preferredLayout };
    }
    if (!preferredLayout && hasPaper) {
      return paperLayouts.length > 0
        ? { space: 1, layout: paperLayouts[0] }
        : { space: 1, layout: '' };
    }
  }

  if (hasModel) {
    return { space: 0, layout: 'Model' };
  }
  if (paperLayouts.length > 0) {
    return { space: 1, layout: paperLayouts[0] };
  }
  if (hasPaper) {
    return { space: 1, layout: '' };
  }
  return { space: 0, layout: 'Model' };
}

export function formatSpaceLayoutLabel(context = null) {
  const current = normalizeSpaceLayoutContext(context);
  if (current.space === 0) return 'Model';
  if (current.space === 1) {
    return current.layout ? `Paper / ${current.layout}` : 'Paper';
  }
  const label = formatSpaceLabel(current.space);
  return current.layout ? `${label} / ${current.layout}` : label;
}
