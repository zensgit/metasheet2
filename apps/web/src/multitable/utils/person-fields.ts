import type { MetaField } from '../types'

// Native person (人员) single-vs-multi resolution. Mirrors the backend codec default: undefined
// `limitSingleRecord` defaults to TRUE (single person), matching the legacy person path so the
// single/multi behaviour never silently flips between a legacy link-backed person and a native one.
// This is display/picker convenience ONLY — the server re-validates the cap (no FE permission mirror).
export function isPersonSingleRecordField(field?: MetaField | null): boolean {
  return field?.property?.limitSingleRecord !== false
}
