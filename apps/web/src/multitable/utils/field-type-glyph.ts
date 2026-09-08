/**
 * Quiet type glyphs for field headers. Unknown types render nothing — never 「?」.
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
