export function isGridRangeFillEnabled(
  value: unknown = import.meta.env.VITE_MULTITABLE_RANGE_FILL_ENABLED,
): boolean {
  return value === 'true'
}
