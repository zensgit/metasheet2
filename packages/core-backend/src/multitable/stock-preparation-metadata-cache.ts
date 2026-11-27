import type { MultitableLoaderQueryFn } from './loaders'

// Provisioning derives the same sheet/field/view IDs after a project is deleted and recreated.
// Keep the identity read BEFORE loading the metadata. If an old in-flight read later wins a map
// write, that value still carries its old identity; every worker compares it on the next hit.
const sheetIncarnations = new WeakMap<object, string>()

export async function currentSheetMetadataEntry<T extends object>(
  query: MultitableLoaderQueryFn,
  sheetId: string | undefined,
  cache: Map<string, T>,
  key: string,
) {
  const previous = cache.get(key)
  let incarnation: string | null = null
  let cached = previous
  // Other sheets have non-reusable UUIDs. On a view miss the sheet is learned by the caller's
  // query; the first hit for a provisioned sheet reloads once before reusing that value.
  if (sheetId && /^sheet_[0-9a-f]{24}$/.test(sheetId)) {
    const { rows } = await query(
      "SELECT xmin::text || ':' || COALESCE(created_at::text, '') AS incarnation FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL",
      [sheetId],
    )
    const row = rows[0] as { incarnation?: string } | undefined
    incarnation = row?.incarnation ?? null
    if (!previous || !incarnation || sheetIncarnations.get(previous) !== incarnation) cached = undefined
  }
  return {
    cached,
    store(value: T) {
      if (incarnation) sheetIncarnations.set(value, incarnation)
      cache.set(key, value)
    },
  }
}
