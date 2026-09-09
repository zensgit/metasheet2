/**
 * Field-type marks.
 * - Field manager still uses quiet unicode via `fieldTypeGlyph`.
 * - Grid headers use a 12px muted outline (or nothing). Unknown types stay blank — never 「?」.
 */

export const FIELD_TYPE_GLYPHS: Record<string, string> = {
  string: 'Aa',
  longText: '\u00B6',
  number: '#',
  boolean: '\u2611',
  date: '\u25A3',
  dateTime: '\u25F7',
  select: '\u25CF',
  multiSelect: '\u25C9',
  link: '\u21C4',
  person: '\u263A',
  lookup: '\u2197',
  rollup: '\u03A3',
  formula: 'fx',
  attachment: '\u2399',
  currency: '\u00A4',
  percent: '%',
  rating: '\u2605',
  duration: '\u23F1',
  url: '\u25E6',
  email: '@',
  phone: '\u2706',
  barcode: '\u25A5',
  qrcode: '\u25A6',
  location: '\u2316',
  autoNumber: '#+',
  createdTime: 'CT',
  modifiedTime: 'MT',
  createdBy: 'CB',
  modifiedBy: 'MB',
  button: '\u25A0',
}

export function fieldTypeGlyph(type: string): string {
  return FIELD_TYPE_GLYPHS[type] ?? ''
}

/** Existing sheet-chrome outline names used as 12px header marks. */
export type FieldTypeHeaderOutlineName =
  | 'fields'
  | 'calendar'
  | 'clock'
  | 'user'
  | 'files'
  | 'link'
  | 'check'
  | 'filter'

export type FieldTypeHeaderMark =
  | { kind: 'none' }
  | { kind: 'outline'; name: FieldTypeHeaderOutlineName }

const FIELD_TYPE_HEADER_OUTLINES: Record<string, FieldTypeHeaderOutlineName> = {
  string: 'fields',
  longText: 'fields',
  text: 'fields',
  formula: 'fields',
  date: 'calendar',
  dateTime: 'calendar',
  createdTime: 'clock',
  modifiedTime: 'clock',
  duration: 'clock',
  person: 'user',
  createdBy: 'user',
  modifiedBy: 'user',
  attachment: 'files',
  link: 'link',
  url: 'link',
  boolean: 'check',
  select: 'filter',
  multiSelect: 'filter',
}

/** Header mark only. Types without a quiet outline (number, leftover glyphs, unknown) stay blank. */
export function fieldTypeHeaderMark(type: string): FieldTypeHeaderMark {
  const name = FIELD_TYPE_HEADER_OUTLINES[type]
  return name ? { kind: 'outline', name } : { kind: 'none' }
}
