function normalizePlmTeamFilterPresetStateValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizePlmTeamFilterPresetStateValue(entry))
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizePlmTeamFilterPresetStateValue((value as Record<string, unknown>)[key])
        return acc
      }, {})
  }

  return value
}

export function pickPlmTeamFilterPresetStateKeys(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const source = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}

  return keys.reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = source[key]
    return acc
  }, {})
}

export function pickPlmTeamFilterPresetRouteOwnerState(
  value: unknown,
): Record<string, unknown> {
  return pickPlmTeamFilterPresetStateKeys(value, ['field', 'value'])
}

export function matchPlmTeamFilterPresetStateSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizePlmTeamFilterPresetStateValue(left))
    === JSON.stringify(normalizePlmTeamFilterPresetStateValue(right))
}
