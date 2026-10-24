export function normalizeColorSource(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toUpperCase();
  return normalized === 'BYLAYER'
    || normalized === 'BYBLOCK'
    || normalized === 'INDEX'
    || normalized === 'TRUECOLOR'
    ? normalized
    : '';
}

export function normalizeColorAci(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(255, Math.max(0, Math.trunc(value)));
}

export function normalizeOptionalBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

export function normalizeTextKind(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function deriveLegacyAttdefDefault(raw, meta) {
  const textKind = normalizeTextKind(meta?.textKind ?? raw?.textKind ?? raw?.text_kind);
  if (textKind !== 'attdef') return null;
  if (typeof meta?.attributeDefault === 'string') return meta.attributeDefault;
  if (typeof raw?.attributeDefault === 'string') return raw.attributeDefault;
  if (typeof raw?.attribute_default === 'string') return raw.attribute_default;
  const prompt = typeof meta?.attributePrompt === 'string'
    ? meta.attributePrompt
    : (typeof raw?.attributePrompt === 'string'
        ? raw.attributePrompt
        : (typeof raw?.attribute_prompt === 'string' ? raw.attribute_prompt : ''));
  const rawValue = typeof raw?.value === 'string'
    ? raw.value
    : (typeof raw?.text?.value === 'string' ? raw.text.value : null);
  if (typeof rawValue !== 'string') return null;
  if (prompt) {
    const crlfSuffix = `\r\n${prompt}`;
    if (rawValue.endsWith(crlfSuffix)) {
      return rawValue.slice(0, -crlfSuffix.length);
    }
    const lfSuffix = `\n${prompt}`;
    if (rawValue.endsWith(lfSuffix)) {
      return rawValue.slice(0, -lfSuffix.length);
    }
  }
  return rawValue;
}

export function isInsertTextProxyMetadata(meta) {
  return String(meta?.sourceType || '').trim().toUpperCase() === 'INSERT'
    && String(meta?.editMode || '').trim().toLowerCase() === 'proxy'
    && String(meta?.proxyKind || '').trim().toLowerCase() === 'text'
    && normalizeTextKind(meta?.textKind) !== '';
}
