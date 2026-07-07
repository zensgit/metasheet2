// CSV download encoding (import-section-ux design-lock §6 addendum): Excel
// guesses ANSI/GBK for BOM-less .csv files and renders UTF-8 Chinese as 乱码
// (WPS auto-detects and is fine). Every attendance CSV *download* exit
// prepends the UTF-8 BOM; import/upload payloads stay untouched — the parser
// side already strips BOM (normalizeCsvHeaderValue / parseCsvHeaderFromText).
export const CSV_BOM = '\ufeff'

export function withCsvBom(text: string): string {
  return text.startsWith(CSV_BOM) ? text : `${CSV_BOM}${text}`
}
