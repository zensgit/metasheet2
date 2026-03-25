function normalizePlmTeamViewStateValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizePlmTeamViewStateValue(entry))
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizePlmTeamViewStateValue((value as Record<string, unknown>)[key])
        return acc
      }, {})
  }

  return value
}

export function matchPlmTeamViewStateSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizePlmTeamViewStateValue(left)) === JSON.stringify(normalizePlmTeamViewStateValue(right))
}

export function mergePlmTeamViewBooleanMapDefaults(
  defaults: Record<string, boolean>,
  value: unknown,
): Record<string, boolean> {
  const normalized = value && typeof value === 'object'
    ? Object.entries(value as Record<string, unknown>).reduce<Record<string, boolean>>((acc, [key, entry]) => {
      acc[key] = Boolean(entry)
      return acc
    }, {})
    : {}

  return {
    ...defaults,
    ...normalized,
  }
}
