import { inflateRawSync } from 'node:zlib'
import { TextDecoder } from 'node:util'

import {
  ELEARNING_ASSESSMENT_IMPORT_MAX,
  ElearningAssessmentCatalogError,
  type ElearningAssessmentQuestionInput,
} from './elearning-assessment-catalog'
import {
  parseXlsxBuffer,
  type XlsxModule,
} from '../multitable/xlsx-service'

export const ELEARNING_ASSESSMENT_XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const ELEARNING_ASSESSMENT_XLSX_MAX_BYTES = 1024 * 1024
export const ELEARNING_ASSESSMENT_XLSX_MAX_EXPANDED_BYTES = 64 * 1024 * 1024

const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50
const ZIP_END_SIGNATURE = 0x06054b50
const ZIP_END_MIN_BYTES = 22
const ZIP_MAX_COMMENT_BYTES = 0xffff
const ZIP_MAX_ENTRIES = 128

const OPTION_HEADERS = Array.from(
  { length: 20 },
  (_value, index) => `option_${String.fromCharCode(97 + index)}`,
)
const REQUIRED_HEADERS = [
  'question_type',
  'prompt',
  'option_a',
  'option_b',
  'correct_options',
  'points',
] as const
const ALLOWED_HEADERS = new Set([
  ...REQUIRED_HEADERS,
  ...OPTION_HEADERS,
  'explanation',
])
const XML_NAME_RE = /^[A-Z_][A-Z0-9_.:-]*$/i
const WORKSHEET_CELL_REF_RE = /^\$?([A-Z]+)\$?(\d+)$/i
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function fail(code: 'invalid_input' | 'unavailable'): never {
  throw new ElearningAssessmentCatalogError(code)
}

function isXlsxZip(buffer: Buffer): boolean {
  return (
    buffer.length >= 4
    && buffer.readUInt32LE(0) === ZIP_LOCAL_FILE_SIGNATURE
  )
}

function findZipEnd(buffer: Buffer): number {
  if (buffer.length < ZIP_END_MIN_BYTES) return -1
  const firstCandidate = buffer.length - ZIP_END_MIN_BYTES
  const lastCandidate = Math.max(
    0,
    firstCandidate - ZIP_MAX_COMMENT_BYTES,
  )
  for (let offset = firstCandidate; offset >= lastCandidate; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + ZIP_END_MIN_BYTES + commentLength === buffer.length) return offset
  }
  return -1
}

function worksheetColumnNumber(letters: string): number {
  let column = 0
  for (const letter of letters.toUpperCase()) {
    column = column * 26 + letter.charCodeAt(0) - 64
    if (!Number.isSafeInteger(column)) fail('invalid_input')
  }
  return column
}

function isXmlWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n'
}

function parseXmlStartTag(
  xml: string,
  start: number,
): { name: string; attributes: Map<string, string>; next: number } {
  let cursor = start + 1
  const nameStart = cursor
  while (
    cursor < xml.length
    && !isXmlWhitespace(xml[cursor])
    && xml[cursor] !== '/'
    && xml[cursor] !== '>'
  ) {
    cursor += 1
  }
  const name = xml.slice(nameStart, cursor)
  if (!XML_NAME_RE.test(name)) fail('invalid_input')

  const attributes = new Map<string, string>()
  while (cursor < xml.length) {
    while (cursor < xml.length && isXmlWhitespace(xml[cursor])) cursor += 1
    if (xml[cursor] === '>') {
      return { name, attributes, next: cursor + 1 }
    }
    if (xml[cursor] === '/' && xml[cursor + 1] === '>') {
      return { name, attributes, next: cursor + 2 }
    }

    const attributeStart = cursor
    while (
      cursor < xml.length
      && !isXmlWhitespace(xml[cursor])
      && xml[cursor] !== '='
      && xml[cursor] !== '/'
      && xml[cursor] !== '>'
    ) {
      cursor += 1
    }
    const attribute = xml.slice(attributeStart, cursor)
    if (!XML_NAME_RE.test(attribute) || attributes.has(attribute)) fail('invalid_input')
    while (cursor < xml.length && isXmlWhitespace(xml[cursor])) cursor += 1
    if (xml[cursor] !== '=') fail('invalid_input')
    cursor += 1
    while (cursor < xml.length && isXmlWhitespace(xml[cursor])) cursor += 1
    const quote = xml[cursor]
    if (quote !== '"' && quote !== "'") fail('invalid_input')
    const valueStart = cursor + 1
    const valueEnd = xml.indexOf(quote, valueStart)
    if (valueEnd < 0) fail('invalid_input')
    attributes.set(attribute, xml.slice(valueStart, valueEnd))
    cursor = valueEnd + 1
  }
  fail('invalid_input')
}

function xmlLocalName(name: string): string {
  const separator = name.lastIndexOf(':')
  return separator < 0 ? name : name.slice(separator + 1)
}

function inspectWorksheetXml(buffer: Buffer): boolean {
  if (
    (buffer[0] === 0xff && buffer[1] === 0xfe)
    || (buffer[0] === 0xfe && buffer[1] === 0xff)
  ) {
    fail('invalid_input')
  }
  let byteCursor = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? 3
    : 0
  while (
    byteCursor < buffer.length
    && (buffer[byteCursor] === 0x20
      || buffer[byteCursor] === 0x09
      || buffer[byteCursor] === 0x0a
      || buffer[byteCursor] === 0x0d)
  ) {
    byteCursor += 1
  }
  if (buffer[byteCursor] !== 0x3c) return false

  let xml: string
  try {
    xml = UTF8_DECODER.decode(buffer)
  } catch {
    fail('invalid_input')
  }
  const perRow = new Uint16Array(ELEARNING_ASSESSMENT_IMPORT_MAX + 2)
  let cursor = xml.charCodeAt(0) === 0xfeff ? 1 : 0
  let cells = 0
  let isWorksheet = false
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor)
    if (start < 0) break
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4)
      if (end < 0) fail('invalid_input')
      cursor = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9)
      if (end < 0) fail('invalid_input')
      cursor = end + 3
      continue
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2)
      if (end < 0) fail('invalid_input')
      cursor = end + 2
      continue
    }
    if (xml.startsWith('<!', start)) fail('invalid_input')
    if (xml.startsWith('</', start)) {
      const end = xml.indexOf('>', start + 2)
      if (end < 0) fail('invalid_input')
      cursor = end + 1
      continue
    }

    const tag = parseXmlStartTag(xml, start)
    const localName = xmlLocalName(tag.name)
    if (!isWorksheet) {
      if (localName !== 'worksheet') return false
      isWorksheet = true
    }
    if (localName === 'c') {
      const rawRef = tag.attributes.get('r')
      const ref = rawRef ? WORKSHEET_CELL_REF_RE.exec(rawRef) : null
      if (!ref) fail('invalid_input')
      const column = worksheetColumnNumber(ref[1])
      const row = Number(ref[2])
      if (
        column < 1
        || column > ALLOWED_HEADERS.size
        || !Number.isSafeInteger(row)
        || row < 1
        || row > ELEARNING_ASSESSMENT_IMPORT_MAX + 1
      ) {
        fail('invalid_input')
      }
      cells += 1
      perRow[row] += 1
      if (
        cells > (ELEARNING_ASSESSMENT_IMPORT_MAX + 1) * ALLOWED_HEADERS.size
        || perRow[row] > ALLOWED_HEADERS.size
      ) {
        fail('invalid_input')
      }
    }
    cursor = tag.next
  }
  return isWorksheet
}

function validateXlsxArchive(buffer: Buffer): void {
  const endOffset = findZipEnd(buffer)
  if (endOffset < 0) fail('invalid_input')

  const diskNumber = buffer.readUInt16LE(endOffset + 4)
  const centralDisk = buffer.readUInt16LE(endOffset + 6)
  const diskEntries = buffer.readUInt16LE(endOffset + 8)
  const totalEntries = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  if (
    diskNumber !== 0
    || centralDisk !== 0
    || diskEntries !== totalEntries
    || totalEntries < 1
    || totalEntries > ZIP_MAX_ENTRIES
    || diskEntries === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || centralOffset + centralSize !== endOffset
  ) {
    fail('invalid_input')
  }

  let expandedBytes = 0
  let worksheetEntries = 0
  let offset = centralOffset
  for (let entry = 0; entry < totalEntries; entry += 1) {
    if (
      offset + 46 > endOffset
      || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_SIGNATURE
    ) {
      fail('invalid_input')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedBytes = buffer.readUInt32LE(offset + 20)
    const uncompressedBytes = buffer.readUInt32LE(offset + 24)
    const nameBytes = buffer.readUInt16LE(offset + 28)
    const extraBytes = buffer.readUInt16LE(offset + 30)
    const commentBytes = buffer.readUInt16LE(offset + 32)
    const diskStart = buffer.readUInt16LE(offset + 34)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nextOffset = offset + 46 + nameBytes + extraBytes + commentBytes
    if (
      (flags & 0x41) !== 0
      || (method !== 0 && method !== 8)
      || compressedBytes === 0xffffffff
      || uncompressedBytes === 0xffffffff
      || diskStart !== 0
      || localOffset === 0xffffffff
      || nextOffset > endOffset
    ) {
      fail('invalid_input')
    }
    expandedBytes += uncompressedBytes
    if (
      !Number.isSafeInteger(expandedBytes)
      || expandedBytes > ELEARNING_ASSESSMENT_XLSX_MAX_EXPANDED_BYTES
    ) {
      fail('invalid_input')
    }

    if (
      localOffset + 30 > centralOffset
      || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_SIGNATURE
    ) {
      fail('invalid_input')
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6)
    const localMethod = buffer.readUInt16LE(localOffset + 8)
    const localNameBytes = buffer.readUInt16LE(localOffset + 26)
    const localExtraBytes = buffer.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes
    const dataEnd = dataOffset + compressedBytes
    if (
      (localFlags & 0x41) !== 0
      || localMethod !== method
      || dataOffset > centralOffset
      || dataEnd > centralOffset
      || (method === 0 && compressedBytes !== uncompressedBytes)
    ) {
      fail('invalid_input')
    }
    let expanded: Buffer
    if (method === 0) {
      expanded = buffer.subarray(dataOffset, dataEnd)
    } else {
      try {
        expanded = inflateRawSync(buffer.subarray(dataOffset, dataEnd), {
          maxOutputLength: uncompressedBytes + 1,
        })
        if (expanded.length !== uncompressedBytes) fail('invalid_input')
      } catch (error) {
        if (error instanceof ElearningAssessmentCatalogError) throw error
        fail('invalid_input')
      }
    }
    if (inspectWorksheetXml(expanded)) {
      worksheetEntries += 1
      if (worksheetEntries > 1) fail('invalid_input')
    }
    offset = nextOffset
  }
  if (offset !== endOffset || worksheetEntries !== 1) fail('invalid_input')
}

function parsePositiveInteger(value: string): number {
  const trimmed = value.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) fail('invalid_input')
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) fail('invalid_input')
  return parsed
}

export function parseElearningQuestionWorkbookWithModule(
  xlsx: XlsxModule,
  buffer: Buffer,
): ElearningAssessmentQuestionInput[] {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length < 1
    || buffer.length > ELEARNING_ASSESSMENT_XLSX_MAX_BYTES
    || !isXlsxZip(buffer)
  ) {
    fail('invalid_input')
  }
  validateXlsxArchive(buffer)

  let parsed: ReturnType<typeof parseXlsxBuffer>
  try {
    parsed = parseXlsxBuffer(xlsx, buffer, {
      maxRows: ELEARNING_ASSESSMENT_IMPORT_MAX,
      maxColumns: ALLOWED_HEADERS.size,
    })
  } catch {
    fail('invalid_input')
  }
  if (
    parsed.sheetCount !== 1
    || parsed.hasFormula
    || parsed.hasUnheadedData
    || parsed.truncated
    || parsed.rows.length < 1
  ) {
    fail('invalid_input')
  }

  const headerIndexes = new Map<string, number>()
  for (let index = 0; index < parsed.headers.length; index += 1) {
    const header = parsed.headers[index]
    if (!header || !ALLOWED_HEADERS.has(header) || headerIndexes.has(header)) {
      fail('invalid_input')
    }
    headerIndexes.set(header, index)
  }
  for (const header of REQUIRED_HEADERS) {
    if (!headerIndexes.has(header)) fail('invalid_input')
  }

  const cell = (row: string[], header: string): string => {
    const index = headerIndexes.get(header)
    return index === undefined ? '' : (row[index] ?? '')
  }

  return parsed.rows.map((row) => {
    const questionType = cell(row, 'question_type').trim()
    if (
      questionType !== 'single_choice'
      && questionType !== 'multiple_choice'
      && questionType !== 'true_false'
    ) {
      fail('invalid_input')
    }
    const options = OPTION_HEADERS.flatMap((header) => {
      if (!headerIndexes.has(header)) return []
      const text = cell(row, header).trim()
      if (!text) return []
      return [{ id: header.slice(-1), text }]
    })
    const correctOptionIds = cell(row, 'correct_options')
      .split(',')
      .map((value) => value.trim().toLowerCase())
    if (correctOptionIds.some((value) => value === '')) fail('invalid_input')
    const explanation = headerIndexes.has('explanation')
      ? cell(row, 'explanation').trim() || null
      : null
    return {
      questionType,
      prompt: cell(row, 'prompt'),
      options,
      correctOptionIds,
      points: parsePositiveInteger(cell(row, 'points')),
      explanation,
    }
  })
}

export async function parseElearningQuestionWorkbook(
  buffer: Buffer,
): Promise<ElearningAssessmentQuestionInput[]> {
  let xlsx: XlsxModule
  try {
    xlsx = await import('xlsx') as unknown as XlsxModule
  } catch {
    fail('unavailable')
  }
  return parseElearningQuestionWorkbookWithModule(xlsx, buffer)
}
